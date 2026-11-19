/** Why a WPGraphQL read failed. HTTP errors carry the status. */
export type WordPressQueryErrorCode = "empty" | "graphql" | "http";

/**
 * A failed WPGraphQL read. Thrown for an HTTP error, a response with GraphQL
 * errors, or one without data, so a caller that caches reads never caches a
 * failure. The message names the status or the GraphQL error messages, never
 * the query, its variables or credentials.
 */
export class WordPressQueryError extends Error {
  readonly code: WordPressQueryErrorCode;
  readonly status: number | undefined;

  constructor(code: WordPressQueryErrorCode, message: string, status?: number) {
    super(message);
    this.name = "WordPressQueryError";
    this.code = code;
    this.status = status;
  }
}

interface GraphQLResponse<Result> {
  data?: Result | null;
  errors?: { message?: string }[];
}

/**
 * Reads a WPGraphQL response's `data`, or throws a WordPressQueryError for an
 * HTTP error, GraphQL errors or a missing `data`.
 */
export const readGraphQLData = async <Result>(
  response: Response
): Promise<Result> => {
  if (!response.ok) {
    await response.body?.cancel();

    throw new WordPressQueryError(
      "http",
      `WPGraphQL answered ${response.status} ${response.statusText}`.trim(),
      response.status
    );
  }

  // SAFETY: WPGraphQL always answers {data, errors}; the caller's typed
  // document says what data holds.
  const body = (await response.json()) as GraphQLResponse<Result>;

  if (body.errors?.length) {
    throw new WordPressQueryError(
      "graphql",
      `WPGraphQL: ${body.errors.map((error) => error.message ?? "error").join("; ")}`
    );
  }

  if (body.data === undefined || body.data === null) {
    throw new WordPressQueryError("empty", "WPGraphQL returned no data");
  }

  return body.data;
};
