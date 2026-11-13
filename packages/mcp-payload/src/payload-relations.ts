import { previewValue } from "@patronage/mcp-core";
import type {
  JsonValue,
  UpstreamClient,
  UpstreamTelemetry,
} from "@patronage/mcp-core";
import { z } from "zod";

import { payloadRest } from "./payload";
import type { EditingInfo } from "./payload-editing";

// A relationship or upload field stores ids, and an id tells an approver
// nothing. The preview names each related document by its title (a media
// file by its filename), read as the approver, so it shows nothing they could
// not open themselves.

// How many documents one value names by title; the rest keep their ids.
const MAX_NAMED = 8;

// How many titles one approval preview reads in all. Past it, values keep
// their ids, so a large batch cannot turn into hundreds of requests.
export const MAX_TITLE_LOOKUPS = 40;

const TITLE_LIMIT = 60;
const FIELD_NAME = /^[A-Za-z][A-Za-z0-9_]*$/u;

interface RelationField {
  path: string;
  relationTo: string[];
}

interface RelationRef {
  collection: string;
  id: number | string;
}

export type TitleLookup = (ref: RelationRef) => Promise<string | undefined>;

const idSchema = z.union([z.number(), z.string().min(1).max(64)]);
const recordSchema = z.record(z.string(), z.json());

// A field that takes more than one collection stores `{ relationTo, value }`.
const polymorphicSchema = z.object({ relationTo: z.string(), value: idSchema });

const readTitle = async (
  client: UpstreamClient,
  ref: RelationRef,
  titleField: string,
  telemetry: UpstreamTelemetry
): Promise<string | undefined> => {
  try {
    const result = await payloadRest(
      client,
      `/api/${encodeURIComponent(ref.collection)}/${encodeURIComponent(String(ref.id))}?draft=true&depth=0&select[${titleField}]=true`,
      telemetry
    );

    const record = recordSchema.safeParse(result.json);

    if (result.status !== 200 || !record.success) {
      return undefined;
    }

    const title = z.string().min(1).safeParse(record.data[titleField]);

    return title.success ? title.data.slice(0, TITLE_LIMIT) : undefined;
  } catch {
    // A title is a courtesy: without one the preview shows the id.
    return undefined;
  }
};

/**
 * Reads titles for one approval preview: each document once, only from
 * collections Payload described to this editor, and never more than
 * `MAX_TITLE_LOOKUPS` of them.
 */
export const createTitleLookup = (
  client: UpstreamClient,
  info: EditingInfo,
  telemetry: UpstreamTelemetry
): TitleLookup => {
  const titles = new Map<string, Promise<string | undefined>>();

  return (ref) => {
    const key = `${ref.collection}/${ref.id}`;
    const known = titles.get(key);

    if (known) {
      return known;
    }

    const titleField = info.collections.find(
      (entry) => entry.slug === ref.collection
    )?.titleField;

    if (
      titleField === undefined ||
      titleField === "id" ||
      !FIELD_NAME.test(titleField) ||
      titles.size >= MAX_TITLE_LOOKUPS
    ) {
      return Promise.resolve(undefined);
    }

    const title = readTitle(client, ref, titleField, telemetry);

    titles.set(key, title);

    return title;
  };
};

const toRef = (
  field: RelationField,
  value: JsonValue
): RelationRef | undefined => {
  const id = idSchema.safeParse(value);
  const [only] = field.relationTo;

  if (id.success) {
    return field.relationTo.length === 1 && only !== undefined
      ? { collection: only, id: id.data }
      : undefined;
  }

  const polymorphic = polymorphicSchema.safeParse(value);

  return polymorphic.success &&
    field.relationTo.includes(polymorphic.data.relationTo)
    ? { collection: polymorphic.data.relationTo, id: polymorphic.data.value }
    : undefined;
};

const named = async (
  lookup: TitleLookup,
  ref: RelationRef,
  index: number
): Promise<string> => {
  const plain = `${ref.collection} ${ref.id}`;
  const title = index < MAX_NAMED ? await lookup(ref) : undefined;

  return title === undefined ? plain : `${title} (${plain})`;
};

/**
 * A relationship or upload value as an approver reads it: `About us (pages
 * 3)`, or a list of those. A value in a shape this does not know is shown
 * as stored.
 */
export const relationPreview = async (
  lookup: TitleLookup,
  field: RelationField,
  value: JsonValue | undefined
): Promise<string> => {
  if (value === undefined || value === null) {
    return previewValue(value);
  }

  const refs = (Array.isArray(value) ? value : [value]).map((entry) =>
    toRef(field, entry)
  );

  const known = refs.filter((ref) => ref !== undefined);

  if (known.length === 0 || known.length !== refs.length) {
    return previewValue(value);
  }

  const names = await Promise.all(
    known.map((ref, index) => named(lookup, ref, index))
  );

  return previewValue(names.join(", "));
};
