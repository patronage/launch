// oxlint-disable vitest/prefer-importing-vitest-globals -- Uses the dependency-free Node test runner.
// Unit test for scripts/migrate-create.mjs. Run by `pnpm test`.
import assert from "node:assert/strict";
// oxlint-disable-next-line vitest/no-import-node-test
import { test } from "node:test";

import { stripPublic } from "./migrate-create.mjs";

test('"public". is removed from enum and foreign-key names only', () => {
  assert.equal(
    stripPublic(
      'CREATE TYPE "public"."enum_x" AS ENUM(\'a\');\nALTER TABLE "x" ADD CONSTRAINT "x_fk" FOREIGN KEY ("y_id") REFERENCES "public"."y"("id");\nDEFAULT \'public\''
    ),
    'CREATE TYPE "enum_x" AS ENUM(\'a\');\nALTER TABLE "x" ADD CONSTRAINT "x_fk" FOREIGN KEY ("y_id") REFERENCES "y"("id");\nDEFAULT \'public\''
  );
});
