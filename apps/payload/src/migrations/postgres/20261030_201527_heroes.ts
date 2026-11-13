import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   CREATE TYPE "enum_pages_hero_links_link_type" AS ENUM('reference', 'custom');
  CREATE TYPE "enum_pages_hero_links_link_variant" AS ENUM('primary', 'secondary', 'text');
  CREATE TYPE "enum_pages_hero_variant" AS ENUM('home', 'split', 'media', 'simple', 'freeform');
  CREATE TYPE "enum_pages_hero_skin" AS ENUM('light', 'dark', 'accent');
  CREATE TYPE "enum_pages_hero_align" AS ENUM('start', 'center');
  CREATE TYPE "enum__pages_v_version_hero_links_link_type" AS ENUM('reference', 'custom');
  CREATE TYPE "enum__pages_v_version_hero_links_link_variant" AS ENUM('primary', 'secondary', 'text');
  CREATE TYPE "enum__pages_v_version_hero_variant" AS ENUM('home', 'split', 'media', 'simple', 'freeform');
  CREATE TYPE "enum__pages_v_version_hero_skin" AS ENUM('light', 'dark', 'accent');
  CREATE TYPE "enum__pages_v_version_hero_align" AS ENUM('start', 'center');
  CREATE TABLE "pages_hero_links" (
  	"_order" integer NOT NULL,
  	"_parent_id" integer NOT NULL,
  	"id" varchar PRIMARY KEY NOT NULL,
  	"link_type" "enum_pages_hero_links_link_type" DEFAULT 'reference',
  	"link_new_tab" boolean,
  	"link_label" varchar,
  	"link_variant" "enum_pages_hero_links_link_variant" DEFAULT 'primary',
  	"link_url" varchar
  );
  
  CREATE TABLE "_pages_v_version_hero_links" (
  	"_order" integer NOT NULL,
  	"_parent_id" integer NOT NULL,
  	"id" serial PRIMARY KEY NOT NULL,
  	"link_type" "enum__pages_v_version_hero_links_link_type" DEFAULT 'reference',
  	"link_new_tab" boolean,
  	"link_label" varchar,
  	"link_variant" "enum__pages_v_version_hero_links_link_variant" DEFAULT 'primary',
  	"link_url" varchar,
  	"_uuid" varchar
  );
  
  ALTER TABLE "pages" RENAME COLUMN "hero_id" TO "hero_image_id";
  ALTER TABLE "_pages_v" RENAME COLUMN "version_hero_id" TO "version_hero_image_id";
  ALTER TABLE "pages" DROP CONSTRAINT "pages_hero_id_media_id_fk";
  
  ALTER TABLE "_pages_v" DROP CONSTRAINT "_pages_v_version_hero_id_media_id_fk";
  
  DROP INDEX "pages_hero_idx";
  DROP INDEX "_pages_v_version_version_hero_idx";
  ALTER TABLE "pages" ADD COLUMN "hero_variant" "enum_pages_hero_variant";
  ALTER TABLE "pages" ADD COLUMN "hero_title" varchar;
  ALTER TABLE "pages" ADD COLUMN "hero_eyebrow" varchar;
  ALTER TABLE "pages" ADD COLUMN "hero_skin" "enum_pages_hero_skin" DEFAULT 'light';
  ALTER TABLE "pages" ADD COLUMN "hero_align" "enum_pages_hero_align" DEFAULT 'start';
  ALTER TABLE "pages" ADD COLUMN "hero_subhead" varchar;
  ALTER TABLE "pages" ADD COLUMN "hero_body" jsonb;
  ALTER TABLE "_pages_v" ADD COLUMN "version_hero_variant" "enum__pages_v_version_hero_variant";
  ALTER TABLE "_pages_v" ADD COLUMN "version_hero_title" varchar;
  ALTER TABLE "_pages_v" ADD COLUMN "version_hero_eyebrow" varchar;
  ALTER TABLE "_pages_v" ADD COLUMN "version_hero_skin" "enum__pages_v_version_hero_skin" DEFAULT 'light';
  ALTER TABLE "_pages_v" ADD COLUMN "version_hero_align" "enum__pages_v_version_hero_align" DEFAULT 'start';
  ALTER TABLE "_pages_v" ADD COLUMN "version_hero_subhead" varchar;
  ALTER TABLE "_pages_v" ADD COLUMN "version_hero_body" jsonb;
  ALTER TABLE "pages_hero_links" ADD CONSTRAINT "pages_hero_links_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "pages"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "_pages_v_version_hero_links" ADD CONSTRAINT "_pages_v_version_hero_links_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "_pages_v"("id") ON DELETE cascade ON UPDATE no action;
  CREATE INDEX "pages_hero_links_order_idx" ON "pages_hero_links" USING btree ("_order");
  CREATE INDEX "pages_hero_links_parent_id_idx" ON "pages_hero_links" USING btree ("_parent_id");
  CREATE INDEX "_pages_v_version_hero_links_order_idx" ON "_pages_v_version_hero_links" USING btree ("_order");
  CREATE INDEX "_pages_v_version_hero_links_parent_id_idx" ON "_pages_v_version_hero_links" USING btree ("_parent_id");
  ALTER TABLE "pages" ADD CONSTRAINT "pages_hero_image_id_media_id_fk" FOREIGN KEY ("hero_image_id") REFERENCES "media"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "_pages_v" ADD CONSTRAINT "_pages_v_version_hero_image_id_media_id_fk" FOREIGN KEY ("version_hero_image_id") REFERENCES "media"("id") ON DELETE set null ON UPDATE no action;
  CREATE INDEX "pages_hero_hero_image_idx" ON "pages" USING btree ("hero_image_id");
  CREATE INDEX "_pages_v_version_hero_version_hero_image_idx" ON "_pages_v" USING btree ("version_hero_image_id");`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   DROP TABLE "pages_hero_links" CASCADE;
  DROP TABLE "_pages_v_version_hero_links" CASCADE;
  ALTER TABLE "pages" DROP CONSTRAINT "pages_hero_image_id_media_id_fk";
  ALTER TABLE "_pages_v" DROP CONSTRAINT "_pages_v_version_hero_image_id_media_id_fk";
  DROP INDEX "pages_hero_hero_image_idx";
  DROP INDEX "_pages_v_version_hero_version_hero_image_idx";
  ALTER TABLE "pages" RENAME COLUMN "hero_image_id" TO "hero_id";
  ALTER TABLE "_pages_v" RENAME COLUMN "version_hero_image_id" TO "version_hero_id";
  ALTER TABLE "pages" ADD CONSTRAINT "pages_hero_id_media_id_fk" FOREIGN KEY ("hero_id") REFERENCES "media"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "_pages_v" ADD CONSTRAINT "_pages_v_version_hero_id_media_id_fk" FOREIGN KEY ("version_hero_id") REFERENCES "media"("id") ON DELETE set null ON UPDATE no action;
  CREATE INDEX "pages_hero_idx" ON "pages" USING btree ("hero_id");
  CREATE INDEX "_pages_v_version_version_hero_idx" ON "_pages_v" USING btree ("version_hero_id");
  ALTER TABLE "pages" DROP COLUMN "hero_variant";
  ALTER TABLE "pages" DROP COLUMN "hero_title";
  ALTER TABLE "pages" DROP COLUMN "hero_eyebrow";
  ALTER TABLE "pages" DROP COLUMN "hero_skin";
  ALTER TABLE "pages" DROP COLUMN "hero_align";
  ALTER TABLE "pages" DROP COLUMN "hero_subhead";
  ALTER TABLE "pages" DROP COLUMN "hero_body";
  ALTER TABLE "_pages_v" DROP COLUMN "version_hero_variant";
  ALTER TABLE "_pages_v" DROP COLUMN "version_hero_title";
  ALTER TABLE "_pages_v" DROP COLUMN "version_hero_eyebrow";
  ALTER TABLE "_pages_v" DROP COLUMN "version_hero_skin";
  ALTER TABLE "_pages_v" DROP COLUMN "version_hero_align";
  ALTER TABLE "_pages_v" DROP COLUMN "version_hero_subhead";
  ALTER TABLE "_pages_v" DROP COLUMN "version_hero_body";
  DROP TYPE "enum_pages_hero_links_link_type";
  DROP TYPE "enum_pages_hero_links_link_variant";
  DROP TYPE "enum_pages_hero_variant";
  DROP TYPE "enum_pages_hero_skin";
  DROP TYPE "enum_pages_hero_align";
  DROP TYPE "enum__pages_v_version_hero_links_link_type";
  DROP TYPE "enum__pages_v_version_hero_links_link_variant";
  DROP TYPE "enum__pages_v_version_hero_variant";
  DROP TYPE "enum__pages_v_version_hero_skin";
  DROP TYPE "enum__pages_v_version_hero_align";`)
}
