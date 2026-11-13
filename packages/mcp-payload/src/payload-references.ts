import type {
  JsonObject,
  UpstreamClient,
  UpstreamTelemetry,
} from "@patronage/mcp-core";
import { z } from "zod";

import { payloadRest } from "./payload";
import type { CollectionEditing, EditingInfo } from "./payload-editing";

// Which documents point at one document through a relationship field, read
// as the editor. It is what an approval shows before a document goes to the
// trash, so the person sees what is left pointing at nothing.
//
// It finds only what Payload can be asked for in one query each: relationship
// and upload fields outside any row, in the collections Payload described to
// this editor. A link inside an array or blocks row, in rich text, or in a
// global is not found, so the answer is "at least these", never "only these".

// How many fields are asked about for one approval.
export const MAX_REFERENCE_QUERIES = 12;

// How many referencing documents one approval names.
export const MAX_NAMED_REFERENCES = 5;

const TITLE_LIMIT = 60;

export interface ReferenceTarget {
  collection: string;
  id: number | string;
}

export interface Reference {
  collection: string;
  id: number | string;
  title?: string;
}

export interface References {
  // The first few documents found.
  named: Reference[];
  // How many were found, named or not.
  total: number;
}

type RelationField = CollectionEditing["relationFields"][number];

interface Candidate {
  collection: CollectionEditing;
  field: RelationField;
}

// A field that names its collections as a list stores `{ relationTo, value }`
// and is asked for by `.value`; one that names a single collection stores
// the id itself. Asked the wrong way Payload answers with an error.
const isPolymorphic = (field: RelationField): boolean =>
  field.polymorphic ?? field.relationTo.length > 1;

const candidatesFor = (
  info: EditingInfo,
  target: ReferenceTarget
): Candidate[] =>
  info.collections
    .flatMap((collection) =>
      collection.relationFields
        .filter((field) => field.relationTo.includes(target.collection))
        .map((field) => ({ collection, field }))
    )
    .slice(0, MAX_REFERENCE_QUERIES);

const where = (candidate: Candidate, target: ReferenceTarget): string => {
  const path = encodeURIComponent(candidate.field.path);
  const id = encodeURIComponent(String(target.id));

  const points = isPolymorphic(candidate.field)
    ? `where[and][0][${path}.value][equals]=${id}&where[and][1][${path}.relationTo][equals]=${encodeURIComponent(target.collection)}`
    : `where[and][0][${path}][equals]=${id}`;

  // A document that points at itself is going to the trash with it.
  return candidate.collection.slug === target.collection
    ? `${points}&where[and][2][id][not_equals]=${id}`
    : points;
};

const idSchema = z.union([z.number(), z.string()]);

const foundSchema = z.object({
  docs: z.array(z.record(z.string(), z.json())),
  totalDocs: z.number().int().nonnegative(),
});

const titleOf = (
  record: JsonObject,
  titleField: string | undefined
): string | undefined => {
  if (titleField === undefined) {
    return undefined;
  }

  const title = z.string().min(1).safeParse(record[titleField]);

  return title.success ? title.data.slice(0, TITLE_LIMIT) : undefined;
};

const ask = async (
  context: { client: UpstreamClient; telemetry: UpstreamTelemetry },
  candidate: Candidate,
  target: ReferenceTarget
): Promise<References> => {
  const { slug, titleField } = candidate.collection;

  const select =
    titleField === undefined || titleField === "id"
      ? "select[id]=true"
      : `select[${encodeURIComponent(titleField)}]=true`;

  try {
    const result = await payloadRest(
      context.client,
      `/api/${encodeURIComponent(slug)}?depth=0&draft=true&limit=${MAX_NAMED_REFERENCES}&${select}&${where(candidate, target)}`,
      context.telemetry
    );

    const parsed = foundSchema.safeParse(result.json);

    if (result.status !== 200 || !parsed.success) {
      return { named: [], total: 0 };
    }

    return {
      named: parsed.data.docs.flatMap((record) => {
        const id = idSchema.safeParse(record.id);

        if (!id.success) {
          return [];
        }

        const reference: Reference = { collection: slug, id: id.data };
        const title = titleOf(record, titleField);

        if (title !== undefined) {
          reference.title = title;
        }

        return [reference];
      }),
      total: parsed.data.totalDocs,
    };
  } catch {
    // A list of what points here is a courtesy: a query that fails leaves
    // it shorter, and never stops the approval from being drawn.
    return { named: [], total: 0 };
  }
};

/**
 * The documents that point at `target` through a relationship field outside
 * any row. Never throws: what cannot be read is left out.
 */
export const findReferences = async (
  context: { client: UpstreamClient; telemetry: UpstreamTelemetry },
  info: EditingInfo,
  target: ReferenceTarget
): Promise<References> => {
  const answers = await Promise.all(
    candidatesFor(info, target).map((candidate) =>
      ask(context, candidate, target)
    )
  );

  const seen = new Set<string>();
  const named: Reference[] = [];
  let total = 0;

  for (const answer of answers) {
    total += answer.total;

    for (const reference of answer.named) {
      const key = `${reference.collection}/${reference.id}`;

      if (!seen.has(key) && named.length < MAX_NAMED_REFERENCES) {
        named.push(reference);
      }

      seen.add(key);
    }
  }

  return { named, total };
};

const describe = (reference: Reference): string =>
  reference.title === undefined
    ? `${reference.collection} ${reference.id}`
    : `${reference.collection} ${reference.id} “${reference.title}”`;

/** "redirects 3, pages 12 “About” and 2 more", or "" when nothing was found. */
export const referencesPhrase = (references: References): string => {
  const extra = references.total - references.named.length;
  const listed = references.named.map(describe).join(", ");

  return extra > 0 && listed ? `${listed} and ${extra} more` : listed;
};
