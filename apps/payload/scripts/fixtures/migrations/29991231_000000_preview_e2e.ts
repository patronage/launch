// A stand-in for a branch's own migration in the preview-schema e2e test
// (scripts/preview-schema-e2e.test.mjs), added through PREVIEW_MIGRATIONS_EXTRA.
// Its date sorts after every committed migration, as a branch's would.
import { sql } from "@payloadcms/db-postgres";
import type { MigrateDownArgs, MigrateUpArgs } from "@payloadcms/db-postgres";

export async function up({ db }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
  CREATE TYPE "enum_preview_e2e_notes_mood" AS ENUM('calm', 'busy');
  CREATE TABLE "preview_e2e_notes" (
    "id" serial PRIMARY KEY NOT NULL,
    "mood" "enum_preview_e2e_notes_mood" DEFAULT 'calm',
    "page_id" integer
  );
  ALTER TABLE "preview_e2e_notes" ADD CONSTRAINT "preview_e2e_notes_page_id_fk" FOREIGN KEY ("page_id") REFERENCES "pages"("id") ON DELETE set null;
  INSERT INTO "preview_e2e_notes" ("page_id") SELECT "id" FROM "pages";`);
}

export async function down({ db }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
  DROP TABLE "preview_e2e_notes";
  DROP TYPE "enum_preview_e2e_notes_mood";`);
}
