import type { PageQueryResult } from "../src/types";
import home from "./home.json" with { type: "json" };

// SAFETY: home.json is a response to query.graphql, which is the shape
// `PageQueryResult` describes, plus one layout the adapter does not know
// (to test that it is skipped). JSON imports widen each `__typename` to
// string, so TypeScript cannot check this itself.
export const wordpressHomeFixture = home as PageQueryResult;
