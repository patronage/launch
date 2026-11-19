import type { DocumentNode } from "graphql";
import { z } from "zod";

/**
 * What GraphQL Code Generator's client preset adds to a document when
 * `persistedDocuments` is on: the operation's SHA-256, as `sha256:<hex>`.
 */
const PersistedDocument = z.object({
  __meta__: z.object({
    hash: z
      .string()
      .transform((hash) => hash.replace(/^sha256:/u, ""))
      .pipe(z.string().regex(/^[\da-f]{64}$/u)),
  }),
});

/**
 * The persisted query ID of a codegen document. WPGraphQL Smart Cache runs a
 * registered query by that ID, so requests never carry query text. Throws
 * for a document without one.
 */
export const persistedQueryId = (document: DocumentNode): string => {
  const parsed = PersistedDocument.safeParse(document);

  if (!parsed.success) {
    throw new TypeError(
      "GraphQL document has no persisted query hash; run codegen with persistedDocuments."
    );
  }

  return parsed.data.__meta__.hash;
};

/**
 * The JSON body of a persisted query request. Variables are passed as
 * already-serialized JSON so a caller that keys a cache on them serializes
 * them once.
 */
export const persistedQueryBody = (id: string, variablesJson = "{}"): string =>
  `{"queryId":${JSON.stringify(id)},"variables":${variablesJson}}`;
