import { describe, expect, it } from "vitest";

import { readGraphQLData, WordPressQueryError } from "./response.ts";

describe(readGraphQLData, () => {
  it("returns the data of a successful response", async () => {
    await expect(
      readGraphQLData(Response.json({ data: { title: "Home" } }))
    ).resolves.toStrictEqual({ title: "Home" });
  });

  it("throws an http error with the status", async () => {
    const read = readGraphQLData(
      new Response("down", { status: 503, statusText: "Service Unavailable" })
    );

    await expect(read).rejects.toBeInstanceOf(WordPressQueryError);
    await expect(read).rejects.toMatchObject({ code: "http", status: 503 });
  });

  it("throws a graphql error naming the messages", async () => {
    await expect(
      readGraphQLData(
        Response.json({ data: null, errors: [{ message: "Bad field" }] })
      )
    ).rejects.toMatchObject({
      code: "graphql",
      message: "WPGraphQL: Bad field",
    });
  });

  it.each([undefined, null])("throws when data is %s", async (data) => {
    await expect(
      readGraphQLData(Response.json({ data }))
    ).rejects.toMatchObject({
      code: "empty",
    });
  });
});
