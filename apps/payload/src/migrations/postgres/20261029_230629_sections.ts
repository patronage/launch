import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   CREATE TYPE "enum_pages_blocks_content_links_link_type" AS ENUM('reference', 'custom');
  CREATE TYPE "enum_pages_blocks_content_links_link_variant" AS ENUM('primary', 'secondary', 'text');
  CREATE TYPE "enum_pages_blocks_content_align" AS ENUM('start', 'center');
  CREATE TYPE "enum_pages_blocks_content_skin" AS ENUM('light', 'dark', 'accent');
  CREATE TYPE "enum_pages_blocks_content_width" AS ENUM('narrow', 'default', 'wide', 'full');
  CREATE TYPE "enum_pages_blocks_content_padding_top" AS ENUM('none', 'sm', 'md', 'lg');
  CREATE TYPE "enum_pages_blocks_content_padding_bottom" AS ENUM('none', 'sm', 'md', 'lg');
  CREATE TYPE "enum_pages_blocks_content_media_links_link_type" AS ENUM('reference', 'custom');
  CREATE TYPE "enum_pages_blocks_content_media_links_link_variant" AS ENUM('primary', 'secondary', 'text');
  CREATE TYPE "enum_pages_blocks_content_media_media_position" AS ENUM('start', 'end');
  CREATE TYPE "enum_pages_blocks_content_media_skin" AS ENUM('light', 'dark', 'accent');
  CREATE TYPE "enum_pages_blocks_content_media_width" AS ENUM('narrow', 'default', 'wide', 'full');
  CREATE TYPE "enum_pages_blocks_content_media_padding_top" AS ENUM('none', 'sm', 'md', 'lg');
  CREATE TYPE "enum_pages_blocks_content_media_padding_bottom" AS ENUM('none', 'sm', 'md', 'lg');
  CREATE TYPE "enum_pages_blocks_media_skin" AS ENUM('light', 'dark', 'accent');
  CREATE TYPE "enum_pages_blocks_media_width" AS ENUM('narrow', 'default', 'wide', 'full');
  CREATE TYPE "enum_pages_blocks_media_padding_top" AS ENUM('none', 'sm', 'md', 'lg');
  CREATE TYPE "enum_pages_blocks_media_padding_bottom" AS ENUM('none', 'sm', 'md', 'lg');
  CREATE TYPE "enum_pages_blocks_card_grid_cards_link_type" AS ENUM('reference', 'custom');
  CREATE TYPE "enum_pages_blocks_card_grid_columns" AS ENUM('2', '3', '4');
  CREATE TYPE "enum_pages_blocks_card_grid_skin" AS ENUM('light', 'dark', 'accent');
  CREATE TYPE "enum_pages_blocks_card_grid_width" AS ENUM('narrow', 'default', 'wide', 'full');
  CREATE TYPE "enum_pages_blocks_card_grid_padding_top" AS ENUM('none', 'sm', 'md', 'lg');
  CREATE TYPE "enum_pages_blocks_card_grid_padding_bottom" AS ENUM('none', 'sm', 'md', 'lg');
  CREATE TYPE "enum_pages_blocks_blockquote_skin" AS ENUM('light', 'dark', 'accent');
  CREATE TYPE "enum_pages_blocks_blockquote_width" AS ENUM('narrow', 'default', 'wide', 'full');
  CREATE TYPE "enum_pages_blocks_blockquote_padding_top" AS ENUM('none', 'sm', 'md', 'lg');
  CREATE TYPE "enum_pages_blocks_blockquote_padding_bottom" AS ENUM('none', 'sm', 'md', 'lg');
  CREATE TYPE "enum_pages_blocks_call_to_action_links_link_type" AS ENUM('reference', 'custom');
  CREATE TYPE "enum_pages_blocks_call_to_action_links_link_variant" AS ENUM('primary', 'secondary', 'text');
  CREATE TYPE "enum_pages_blocks_call_to_action_skin" AS ENUM('light', 'dark', 'accent');
  CREATE TYPE "enum_pages_blocks_call_to_action_width" AS ENUM('narrow', 'default', 'wide', 'full');
  CREATE TYPE "enum_pages_blocks_call_to_action_padding_top" AS ENUM('none', 'sm', 'md', 'lg');
  CREATE TYPE "enum_pages_blocks_call_to_action_padding_bottom" AS ENUM('none', 'sm', 'md', 'lg');
  CREATE TYPE "enum__pages_v_blocks_content_links_link_type" AS ENUM('reference', 'custom');
  CREATE TYPE "enum__pages_v_blocks_content_links_link_variant" AS ENUM('primary', 'secondary', 'text');
  CREATE TYPE "enum__pages_v_blocks_content_align" AS ENUM('start', 'center');
  CREATE TYPE "enum__pages_v_blocks_content_skin" AS ENUM('light', 'dark', 'accent');
  CREATE TYPE "enum__pages_v_blocks_content_width" AS ENUM('narrow', 'default', 'wide', 'full');
  CREATE TYPE "enum__pages_v_blocks_content_padding_top" AS ENUM('none', 'sm', 'md', 'lg');
  CREATE TYPE "enum__pages_v_blocks_content_padding_bottom" AS ENUM('none', 'sm', 'md', 'lg');
  CREATE TYPE "enum__pages_v_blocks_content_media_links_link_type" AS ENUM('reference', 'custom');
  CREATE TYPE "enum__pages_v_blocks_content_media_links_link_variant" AS ENUM('primary', 'secondary', 'text');
  CREATE TYPE "enum__pages_v_blocks_content_media_media_position" AS ENUM('start', 'end');
  CREATE TYPE "enum__pages_v_blocks_content_media_skin" AS ENUM('light', 'dark', 'accent');
  CREATE TYPE "enum__pages_v_blocks_content_media_width" AS ENUM('narrow', 'default', 'wide', 'full');
  CREATE TYPE "enum__pages_v_blocks_content_media_padding_top" AS ENUM('none', 'sm', 'md', 'lg');
  CREATE TYPE "enum__pages_v_blocks_content_media_padding_bottom" AS ENUM('none', 'sm', 'md', 'lg');
  CREATE TYPE "enum__pages_v_blocks_media_skin" AS ENUM('light', 'dark', 'accent');
  CREATE TYPE "enum__pages_v_blocks_media_width" AS ENUM('narrow', 'default', 'wide', 'full');
  CREATE TYPE "enum__pages_v_blocks_media_padding_top" AS ENUM('none', 'sm', 'md', 'lg');
  CREATE TYPE "enum__pages_v_blocks_media_padding_bottom" AS ENUM('none', 'sm', 'md', 'lg');
  CREATE TYPE "enum__pages_v_blocks_card_grid_cards_link_type" AS ENUM('reference', 'custom');
  CREATE TYPE "enum__pages_v_blocks_card_grid_columns" AS ENUM('2', '3', '4');
  CREATE TYPE "enum__pages_v_blocks_card_grid_skin" AS ENUM('light', 'dark', 'accent');
  CREATE TYPE "enum__pages_v_blocks_card_grid_width" AS ENUM('narrow', 'default', 'wide', 'full');
  CREATE TYPE "enum__pages_v_blocks_card_grid_padding_top" AS ENUM('none', 'sm', 'md', 'lg');
  CREATE TYPE "enum__pages_v_blocks_card_grid_padding_bottom" AS ENUM('none', 'sm', 'md', 'lg');
  CREATE TYPE "enum__pages_v_blocks_blockquote_skin" AS ENUM('light', 'dark', 'accent');
  CREATE TYPE "enum__pages_v_blocks_blockquote_width" AS ENUM('narrow', 'default', 'wide', 'full');
  CREATE TYPE "enum__pages_v_blocks_blockquote_padding_top" AS ENUM('none', 'sm', 'md', 'lg');
  CREATE TYPE "enum__pages_v_blocks_blockquote_padding_bottom" AS ENUM('none', 'sm', 'md', 'lg');
  CREATE TYPE "enum__pages_v_blocks_call_to_action_links_link_type" AS ENUM('reference', 'custom');
  CREATE TYPE "enum__pages_v_blocks_call_to_action_links_link_variant" AS ENUM('primary', 'secondary', 'text');
  CREATE TYPE "enum__pages_v_blocks_call_to_action_skin" AS ENUM('light', 'dark', 'accent');
  CREATE TYPE "enum__pages_v_blocks_call_to_action_width" AS ENUM('narrow', 'default', 'wide', 'full');
  CREATE TYPE "enum__pages_v_blocks_call_to_action_padding_top" AS ENUM('none', 'sm', 'md', 'lg');
  CREATE TYPE "enum__pages_v_blocks_call_to_action_padding_bottom" AS ENUM('none', 'sm', 'md', 'lg');
  CREATE TABLE "pages_blocks_content_links" (
  	"_order" integer NOT NULL,
  	"_parent_id" varchar NOT NULL,
  	"id" varchar PRIMARY KEY NOT NULL,
  	"link_type" "enum_pages_blocks_content_links_link_type" DEFAULT 'reference',
  	"link_new_tab" boolean,
  	"link_label" varchar,
  	"link_variant" "enum_pages_blocks_content_links_link_variant" DEFAULT 'primary',
  	"link_url" varchar
  );
  
  CREATE TABLE "pages_blocks_content" (
  	"_order" integer NOT NULL,
  	"_parent_id" integer NOT NULL,
  	"_path" text NOT NULL,
  	"id" varchar PRIMARY KEY NOT NULL,
  	"eyebrow" varchar,
  	"heading" varchar,
  	"body" jsonb,
  	"align" "enum_pages_blocks_content_align" DEFAULT 'start',
  	"section_options_skin" "enum_pages_blocks_content_skin" DEFAULT 'light',
  	"section_options_width" "enum_pages_blocks_content_width" DEFAULT 'default',
  	"section_options_padding_top" "enum_pages_blocks_content_padding_top" DEFAULT 'md',
  	"section_options_padding_bottom" "enum_pages_blocks_content_padding_bottom" DEFAULT 'md',
  	"section_options_anchor" varchar,
  	"section_options_hidden" boolean DEFAULT false,
  	"block_name" varchar
  );
  
  CREATE TABLE "pages_blocks_content_media_links" (
  	"_order" integer NOT NULL,
  	"_parent_id" varchar NOT NULL,
  	"id" varchar PRIMARY KEY NOT NULL,
  	"link_type" "enum_pages_blocks_content_media_links_link_type" DEFAULT 'reference',
  	"link_new_tab" boolean,
  	"link_label" varchar,
  	"link_variant" "enum_pages_blocks_content_media_links_link_variant" DEFAULT 'primary',
  	"link_url" varchar
  );
  
  CREATE TABLE "pages_blocks_content_media" (
  	"_order" integer NOT NULL,
  	"_parent_id" integer NOT NULL,
  	"_path" text NOT NULL,
  	"id" varchar PRIMARY KEY NOT NULL,
  	"eyebrow" varchar,
  	"heading" varchar,
  	"body" jsonb,
  	"media_id" integer,
  	"media_position" "enum_pages_blocks_content_media_media_position" DEFAULT 'end',
  	"section_options_skin" "enum_pages_blocks_content_media_skin" DEFAULT 'light',
  	"section_options_width" "enum_pages_blocks_content_media_width" DEFAULT 'default',
  	"section_options_padding_top" "enum_pages_blocks_content_media_padding_top" DEFAULT 'md',
  	"section_options_padding_bottom" "enum_pages_blocks_content_media_padding_bottom" DEFAULT 'md',
  	"section_options_anchor" varchar,
  	"section_options_hidden" boolean DEFAULT false,
  	"block_name" varchar
  );
  
  CREATE TABLE "pages_blocks_media" (
  	"_order" integer NOT NULL,
  	"_parent_id" integer NOT NULL,
  	"_path" text NOT NULL,
  	"id" varchar PRIMARY KEY NOT NULL,
  	"media_id" integer,
  	"section_options_skin" "enum_pages_blocks_media_skin" DEFAULT 'light',
  	"section_options_width" "enum_pages_blocks_media_width" DEFAULT 'default',
  	"section_options_padding_top" "enum_pages_blocks_media_padding_top" DEFAULT 'md',
  	"section_options_padding_bottom" "enum_pages_blocks_media_padding_bottom" DEFAULT 'md',
  	"section_options_anchor" varchar,
  	"section_options_hidden" boolean DEFAULT false,
  	"block_name" varchar
  );
  
  CREATE TABLE "pages_blocks_card_grid_cards" (
  	"_order" integer NOT NULL,
  	"_parent_id" varchar NOT NULL,
  	"id" varchar PRIMARY KEY NOT NULL,
  	"title" varchar,
  	"text" varchar,
  	"image_id" integer,
  	"link_type" "enum_pages_blocks_card_grid_cards_link_type" DEFAULT 'reference',
  	"link_new_tab" boolean,
  	"link_label" varchar,
  	"link_url" varchar
  );
  
  CREATE TABLE "pages_blocks_card_grid" (
  	"_order" integer NOT NULL,
  	"_parent_id" integer NOT NULL,
  	"_path" text NOT NULL,
  	"id" varchar PRIMARY KEY NOT NULL,
  	"heading" varchar,
  	"columns" "enum_pages_blocks_card_grid_columns" DEFAULT '3',
  	"section_options_skin" "enum_pages_blocks_card_grid_skin" DEFAULT 'light',
  	"section_options_width" "enum_pages_blocks_card_grid_width" DEFAULT 'default',
  	"section_options_padding_top" "enum_pages_blocks_card_grid_padding_top" DEFAULT 'md',
  	"section_options_padding_bottom" "enum_pages_blocks_card_grid_padding_bottom" DEFAULT 'md',
  	"section_options_anchor" varchar,
  	"section_options_hidden" boolean DEFAULT false,
  	"block_name" varchar
  );
  
  CREATE TABLE "pages_blocks_blockquote" (
  	"_order" integer NOT NULL,
  	"_parent_id" integer NOT NULL,
  	"_path" text NOT NULL,
  	"id" varchar PRIMARY KEY NOT NULL,
  	"quote" varchar,
  	"attribution" varchar,
  	"role" varchar,
  	"image_id" integer,
  	"section_options_skin" "enum_pages_blocks_blockquote_skin" DEFAULT 'light',
  	"section_options_width" "enum_pages_blocks_blockquote_width" DEFAULT 'default',
  	"section_options_padding_top" "enum_pages_blocks_blockquote_padding_top" DEFAULT 'md',
  	"section_options_padding_bottom" "enum_pages_blocks_blockquote_padding_bottom" DEFAULT 'md',
  	"section_options_anchor" varchar,
  	"section_options_hidden" boolean DEFAULT false,
  	"block_name" varchar
  );
  
  CREATE TABLE "pages_blocks_call_to_action_links" (
  	"_order" integer NOT NULL,
  	"_parent_id" varchar NOT NULL,
  	"id" varchar PRIMARY KEY NOT NULL,
  	"link_type" "enum_pages_blocks_call_to_action_links_link_type" DEFAULT 'reference',
  	"link_new_tab" boolean,
  	"link_label" varchar,
  	"link_variant" "enum_pages_blocks_call_to_action_links_link_variant" DEFAULT 'primary',
  	"link_url" varchar
  );
  
  CREATE TABLE "pages_blocks_call_to_action" (
  	"_order" integer NOT NULL,
  	"_parent_id" integer NOT NULL,
  	"_path" text NOT NULL,
  	"id" varchar PRIMARY KEY NOT NULL,
  	"heading" varchar,
  	"body" jsonb,
  	"section_options_skin" "enum_pages_blocks_call_to_action_skin" DEFAULT 'light',
  	"section_options_width" "enum_pages_blocks_call_to_action_width" DEFAULT 'default',
  	"section_options_padding_top" "enum_pages_blocks_call_to_action_padding_top" DEFAULT 'md',
  	"section_options_padding_bottom" "enum_pages_blocks_call_to_action_padding_bottom" DEFAULT 'md',
  	"section_options_anchor" varchar,
  	"section_options_hidden" boolean DEFAULT false,
  	"block_name" varchar
  );
  
  CREATE TABLE "pages_breadcrumbs" (
  	"_order" integer NOT NULL,
  	"_parent_id" integer NOT NULL,
  	"id" varchar PRIMARY KEY NOT NULL,
  	"doc_id" integer,
  	"url" varchar,
  	"label" varchar
  );
  
  CREATE TABLE "_pages_v_blocks_content_links" (
  	"_order" integer NOT NULL,
  	"_parent_id" integer NOT NULL,
  	"id" serial PRIMARY KEY NOT NULL,
  	"link_type" "enum__pages_v_blocks_content_links_link_type" DEFAULT 'reference',
  	"link_new_tab" boolean,
  	"link_label" varchar,
  	"link_variant" "enum__pages_v_blocks_content_links_link_variant" DEFAULT 'primary',
  	"link_url" varchar,
  	"_uuid" varchar
  );
  
  CREATE TABLE "_pages_v_blocks_content" (
  	"_order" integer NOT NULL,
  	"_parent_id" integer NOT NULL,
  	"_path" text NOT NULL,
  	"id" serial PRIMARY KEY NOT NULL,
  	"eyebrow" varchar,
  	"heading" varchar,
  	"body" jsonb,
  	"align" "enum__pages_v_blocks_content_align" DEFAULT 'start',
  	"section_options_skin" "enum__pages_v_blocks_content_skin" DEFAULT 'light',
  	"section_options_width" "enum__pages_v_blocks_content_width" DEFAULT 'default',
  	"section_options_padding_top" "enum__pages_v_blocks_content_padding_top" DEFAULT 'md',
  	"section_options_padding_bottom" "enum__pages_v_blocks_content_padding_bottom" DEFAULT 'md',
  	"section_options_anchor" varchar,
  	"section_options_hidden" boolean DEFAULT false,
  	"_uuid" varchar,
  	"block_name" varchar
  );
  
  CREATE TABLE "_pages_v_blocks_content_media_links" (
  	"_order" integer NOT NULL,
  	"_parent_id" integer NOT NULL,
  	"id" serial PRIMARY KEY NOT NULL,
  	"link_type" "enum__pages_v_blocks_content_media_links_link_type" DEFAULT 'reference',
  	"link_new_tab" boolean,
  	"link_label" varchar,
  	"link_variant" "enum__pages_v_blocks_content_media_links_link_variant" DEFAULT 'primary',
  	"link_url" varchar,
  	"_uuid" varchar
  );
  
  CREATE TABLE "_pages_v_blocks_content_media" (
  	"_order" integer NOT NULL,
  	"_parent_id" integer NOT NULL,
  	"_path" text NOT NULL,
  	"id" serial PRIMARY KEY NOT NULL,
  	"eyebrow" varchar,
  	"heading" varchar,
  	"body" jsonb,
  	"media_id" integer,
  	"media_position" "enum__pages_v_blocks_content_media_media_position" DEFAULT 'end',
  	"section_options_skin" "enum__pages_v_blocks_content_media_skin" DEFAULT 'light',
  	"section_options_width" "enum__pages_v_blocks_content_media_width" DEFAULT 'default',
  	"section_options_padding_top" "enum__pages_v_blocks_content_media_padding_top" DEFAULT 'md',
  	"section_options_padding_bottom" "enum__pages_v_blocks_content_media_padding_bottom" DEFAULT 'md',
  	"section_options_anchor" varchar,
  	"section_options_hidden" boolean DEFAULT false,
  	"_uuid" varchar,
  	"block_name" varchar
  );
  
  CREATE TABLE "_pages_v_blocks_media" (
  	"_order" integer NOT NULL,
  	"_parent_id" integer NOT NULL,
  	"_path" text NOT NULL,
  	"id" serial PRIMARY KEY NOT NULL,
  	"media_id" integer,
  	"section_options_skin" "enum__pages_v_blocks_media_skin" DEFAULT 'light',
  	"section_options_width" "enum__pages_v_blocks_media_width" DEFAULT 'default',
  	"section_options_padding_top" "enum__pages_v_blocks_media_padding_top" DEFAULT 'md',
  	"section_options_padding_bottom" "enum__pages_v_blocks_media_padding_bottom" DEFAULT 'md',
  	"section_options_anchor" varchar,
  	"section_options_hidden" boolean DEFAULT false,
  	"_uuid" varchar,
  	"block_name" varchar
  );
  
  CREATE TABLE "_pages_v_blocks_card_grid_cards" (
  	"_order" integer NOT NULL,
  	"_parent_id" integer NOT NULL,
  	"id" serial PRIMARY KEY NOT NULL,
  	"title" varchar,
  	"text" varchar,
  	"image_id" integer,
  	"link_type" "enum__pages_v_blocks_card_grid_cards_link_type" DEFAULT 'reference',
  	"link_new_tab" boolean,
  	"link_label" varchar,
  	"link_url" varchar,
  	"_uuid" varchar
  );
  
  CREATE TABLE "_pages_v_blocks_card_grid" (
  	"_order" integer NOT NULL,
  	"_parent_id" integer NOT NULL,
  	"_path" text NOT NULL,
  	"id" serial PRIMARY KEY NOT NULL,
  	"heading" varchar,
  	"columns" "enum__pages_v_blocks_card_grid_columns" DEFAULT '3',
  	"section_options_skin" "enum__pages_v_blocks_card_grid_skin" DEFAULT 'light',
  	"section_options_width" "enum__pages_v_blocks_card_grid_width" DEFAULT 'default',
  	"section_options_padding_top" "enum__pages_v_blocks_card_grid_padding_top" DEFAULT 'md',
  	"section_options_padding_bottom" "enum__pages_v_blocks_card_grid_padding_bottom" DEFAULT 'md',
  	"section_options_anchor" varchar,
  	"section_options_hidden" boolean DEFAULT false,
  	"_uuid" varchar,
  	"block_name" varchar
  );
  
  CREATE TABLE "_pages_v_blocks_blockquote" (
  	"_order" integer NOT NULL,
  	"_parent_id" integer NOT NULL,
  	"_path" text NOT NULL,
  	"id" serial PRIMARY KEY NOT NULL,
  	"quote" varchar,
  	"attribution" varchar,
  	"role" varchar,
  	"image_id" integer,
  	"section_options_skin" "enum__pages_v_blocks_blockquote_skin" DEFAULT 'light',
  	"section_options_width" "enum__pages_v_blocks_blockquote_width" DEFAULT 'default',
  	"section_options_padding_top" "enum__pages_v_blocks_blockquote_padding_top" DEFAULT 'md',
  	"section_options_padding_bottom" "enum__pages_v_blocks_blockquote_padding_bottom" DEFAULT 'md',
  	"section_options_anchor" varchar,
  	"section_options_hidden" boolean DEFAULT false,
  	"_uuid" varchar,
  	"block_name" varchar
  );
  
  CREATE TABLE "_pages_v_blocks_call_to_action_links" (
  	"_order" integer NOT NULL,
  	"_parent_id" integer NOT NULL,
  	"id" serial PRIMARY KEY NOT NULL,
  	"link_type" "enum__pages_v_blocks_call_to_action_links_link_type" DEFAULT 'reference',
  	"link_new_tab" boolean,
  	"link_label" varchar,
  	"link_variant" "enum__pages_v_blocks_call_to_action_links_link_variant" DEFAULT 'primary',
  	"link_url" varchar,
  	"_uuid" varchar
  );
  
  CREATE TABLE "_pages_v_blocks_call_to_action" (
  	"_order" integer NOT NULL,
  	"_parent_id" integer NOT NULL,
  	"_path" text NOT NULL,
  	"id" serial PRIMARY KEY NOT NULL,
  	"heading" varchar,
  	"body" jsonb,
  	"section_options_skin" "enum__pages_v_blocks_call_to_action_skin" DEFAULT 'light',
  	"section_options_width" "enum__pages_v_blocks_call_to_action_width" DEFAULT 'default',
  	"section_options_padding_top" "enum__pages_v_blocks_call_to_action_padding_top" DEFAULT 'md',
  	"section_options_padding_bottom" "enum__pages_v_blocks_call_to_action_padding_bottom" DEFAULT 'md',
  	"section_options_anchor" varchar,
  	"section_options_hidden" boolean DEFAULT false,
  	"_uuid" varchar,
  	"block_name" varchar
  );
  
  CREATE TABLE "_pages_v_version_breadcrumbs" (
  	"_order" integer NOT NULL,
  	"_parent_id" integer NOT NULL,
  	"id" serial PRIMARY KEY NOT NULL,
  	"doc_id" integer,
  	"url" varchar,
  	"label" varchar,
  	"_uuid" varchar
  );
  
  ALTER TABLE "pages" ADD COLUMN "parent_id" integer;
  ALTER TABLE "pages_rels" ADD COLUMN "pages_id" integer;
  ALTER TABLE "_pages_v" ADD COLUMN "version_parent_id" integer;
  ALTER TABLE "_pages_v_rels" ADD COLUMN "pages_id" integer;
  ALTER TABLE "media" ADD COLUMN "caption" varchar;
  ALTER TABLE "_media_v" ADD COLUMN "version_caption" varchar;
  ALTER TABLE "pages_blocks_content_links" ADD CONSTRAINT "pages_blocks_content_links_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "pages_blocks_content"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "pages_blocks_content" ADD CONSTRAINT "pages_blocks_content_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "pages"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "pages_blocks_content_media_links" ADD CONSTRAINT "pages_blocks_content_media_links_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "pages_blocks_content_media"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "pages_blocks_content_media" ADD CONSTRAINT "pages_blocks_content_media_media_id_media_id_fk" FOREIGN KEY ("media_id") REFERENCES "media"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "pages_blocks_content_media" ADD CONSTRAINT "pages_blocks_content_media_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "pages"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "pages_blocks_media" ADD CONSTRAINT "pages_blocks_media_media_id_media_id_fk" FOREIGN KEY ("media_id") REFERENCES "media"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "pages_blocks_media" ADD CONSTRAINT "pages_blocks_media_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "pages"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "pages_blocks_card_grid_cards" ADD CONSTRAINT "pages_blocks_card_grid_cards_image_id_media_id_fk" FOREIGN KEY ("image_id") REFERENCES "media"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "pages_blocks_card_grid_cards" ADD CONSTRAINT "pages_blocks_card_grid_cards_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "pages_blocks_card_grid"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "pages_blocks_card_grid" ADD CONSTRAINT "pages_blocks_card_grid_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "pages"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "pages_blocks_blockquote" ADD CONSTRAINT "pages_blocks_blockquote_image_id_media_id_fk" FOREIGN KEY ("image_id") REFERENCES "media"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "pages_blocks_blockquote" ADD CONSTRAINT "pages_blocks_blockquote_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "pages"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "pages_blocks_call_to_action_links" ADD CONSTRAINT "pages_blocks_call_to_action_links_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "pages_blocks_call_to_action"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "pages_blocks_call_to_action" ADD CONSTRAINT "pages_blocks_call_to_action_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "pages"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "pages_breadcrumbs" ADD CONSTRAINT "pages_breadcrumbs_doc_id_pages_id_fk" FOREIGN KEY ("doc_id") REFERENCES "pages"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "pages_breadcrumbs" ADD CONSTRAINT "pages_breadcrumbs_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "pages"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "_pages_v_blocks_content_links" ADD CONSTRAINT "_pages_v_blocks_content_links_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "_pages_v_blocks_content"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "_pages_v_blocks_content" ADD CONSTRAINT "_pages_v_blocks_content_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "_pages_v"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "_pages_v_blocks_content_media_links" ADD CONSTRAINT "_pages_v_blocks_content_media_links_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "_pages_v_blocks_content_media"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "_pages_v_blocks_content_media" ADD CONSTRAINT "_pages_v_blocks_content_media_media_id_media_id_fk" FOREIGN KEY ("media_id") REFERENCES "media"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "_pages_v_blocks_content_media" ADD CONSTRAINT "_pages_v_blocks_content_media_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "_pages_v"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "_pages_v_blocks_media" ADD CONSTRAINT "_pages_v_blocks_media_media_id_media_id_fk" FOREIGN KEY ("media_id") REFERENCES "media"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "_pages_v_blocks_media" ADD CONSTRAINT "_pages_v_blocks_media_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "_pages_v"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "_pages_v_blocks_card_grid_cards" ADD CONSTRAINT "_pages_v_blocks_card_grid_cards_image_id_media_id_fk" FOREIGN KEY ("image_id") REFERENCES "media"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "_pages_v_blocks_card_grid_cards" ADD CONSTRAINT "_pages_v_blocks_card_grid_cards_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "_pages_v_blocks_card_grid"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "_pages_v_blocks_card_grid" ADD CONSTRAINT "_pages_v_blocks_card_grid_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "_pages_v"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "_pages_v_blocks_blockquote" ADD CONSTRAINT "_pages_v_blocks_blockquote_image_id_media_id_fk" FOREIGN KEY ("image_id") REFERENCES "media"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "_pages_v_blocks_blockquote" ADD CONSTRAINT "_pages_v_blocks_blockquote_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "_pages_v"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "_pages_v_blocks_call_to_action_links" ADD CONSTRAINT "_pages_v_blocks_call_to_action_links_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "_pages_v_blocks_call_to_action"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "_pages_v_blocks_call_to_action" ADD CONSTRAINT "_pages_v_blocks_call_to_action_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "_pages_v"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "_pages_v_version_breadcrumbs" ADD CONSTRAINT "_pages_v_version_breadcrumbs_doc_id_pages_id_fk" FOREIGN KEY ("doc_id") REFERENCES "pages"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "_pages_v_version_breadcrumbs" ADD CONSTRAINT "_pages_v_version_breadcrumbs_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "_pages_v"("id") ON DELETE cascade ON UPDATE no action;
  CREATE INDEX "pages_blocks_content_links_order_idx" ON "pages_blocks_content_links" USING btree ("_order");
  CREATE INDEX "pages_blocks_content_links_parent_id_idx" ON "pages_blocks_content_links" USING btree ("_parent_id");
  CREATE INDEX "pages_blocks_content_order_idx" ON "pages_blocks_content" USING btree ("_order");
  CREATE INDEX "pages_blocks_content_parent_id_idx" ON "pages_blocks_content" USING btree ("_parent_id");
  CREATE INDEX "pages_blocks_content_path_idx" ON "pages_blocks_content" USING btree ("_path");
  CREATE INDEX "pages_blocks_content_media_links_order_idx" ON "pages_blocks_content_media_links" USING btree ("_order");
  CREATE INDEX "pages_blocks_content_media_links_parent_id_idx" ON "pages_blocks_content_media_links" USING btree ("_parent_id");
  CREATE INDEX "pages_blocks_content_media_order_idx" ON "pages_blocks_content_media" USING btree ("_order");
  CREATE INDEX "pages_blocks_content_media_parent_id_idx" ON "pages_blocks_content_media" USING btree ("_parent_id");
  CREATE INDEX "pages_blocks_content_media_path_idx" ON "pages_blocks_content_media" USING btree ("_path");
  CREATE INDEX "pages_blocks_content_media_media_idx" ON "pages_blocks_content_media" USING btree ("media_id");
  CREATE INDEX "pages_blocks_media_order_idx" ON "pages_blocks_media" USING btree ("_order");
  CREATE INDEX "pages_blocks_media_parent_id_idx" ON "pages_blocks_media" USING btree ("_parent_id");
  CREATE INDEX "pages_blocks_media_path_idx" ON "pages_blocks_media" USING btree ("_path");
  CREATE INDEX "pages_blocks_media_media_idx" ON "pages_blocks_media" USING btree ("media_id");
  CREATE INDEX "pages_blocks_card_grid_cards_order_idx" ON "pages_blocks_card_grid_cards" USING btree ("_order");
  CREATE INDEX "pages_blocks_card_grid_cards_parent_id_idx" ON "pages_blocks_card_grid_cards" USING btree ("_parent_id");
  CREATE INDEX "pages_blocks_card_grid_cards_image_idx" ON "pages_blocks_card_grid_cards" USING btree ("image_id");
  CREATE INDEX "pages_blocks_card_grid_order_idx" ON "pages_blocks_card_grid" USING btree ("_order");
  CREATE INDEX "pages_blocks_card_grid_parent_id_idx" ON "pages_blocks_card_grid" USING btree ("_parent_id");
  CREATE INDEX "pages_blocks_card_grid_path_idx" ON "pages_blocks_card_grid" USING btree ("_path");
  CREATE INDEX "pages_blocks_blockquote_order_idx" ON "pages_blocks_blockquote" USING btree ("_order");
  CREATE INDEX "pages_blocks_blockquote_parent_id_idx" ON "pages_blocks_blockquote" USING btree ("_parent_id");
  CREATE INDEX "pages_blocks_blockquote_path_idx" ON "pages_blocks_blockquote" USING btree ("_path");
  CREATE INDEX "pages_blocks_blockquote_image_idx" ON "pages_blocks_blockquote" USING btree ("image_id");
  CREATE INDEX "pages_blocks_call_to_action_links_order_idx" ON "pages_blocks_call_to_action_links" USING btree ("_order");
  CREATE INDEX "pages_blocks_call_to_action_links_parent_id_idx" ON "pages_blocks_call_to_action_links" USING btree ("_parent_id");
  CREATE INDEX "pages_blocks_call_to_action_order_idx" ON "pages_blocks_call_to_action" USING btree ("_order");
  CREATE INDEX "pages_blocks_call_to_action_parent_id_idx" ON "pages_blocks_call_to_action" USING btree ("_parent_id");
  CREATE INDEX "pages_blocks_call_to_action_path_idx" ON "pages_blocks_call_to_action" USING btree ("_path");
  CREATE INDEX "pages_breadcrumbs_order_idx" ON "pages_breadcrumbs" USING btree ("_order");
  CREATE INDEX "pages_breadcrumbs_parent_id_idx" ON "pages_breadcrumbs" USING btree ("_parent_id");
  CREATE INDEX "pages_breadcrumbs_doc_idx" ON "pages_breadcrumbs" USING btree ("doc_id");
  CREATE INDEX "_pages_v_blocks_content_links_order_idx" ON "_pages_v_blocks_content_links" USING btree ("_order");
  CREATE INDEX "_pages_v_blocks_content_links_parent_id_idx" ON "_pages_v_blocks_content_links" USING btree ("_parent_id");
  CREATE INDEX "_pages_v_blocks_content_order_idx" ON "_pages_v_blocks_content" USING btree ("_order");
  CREATE INDEX "_pages_v_blocks_content_parent_id_idx" ON "_pages_v_blocks_content" USING btree ("_parent_id");
  CREATE INDEX "_pages_v_blocks_content_path_idx" ON "_pages_v_blocks_content" USING btree ("_path");
  CREATE INDEX "_pages_v_blocks_content_media_links_order_idx" ON "_pages_v_blocks_content_media_links" USING btree ("_order");
  CREATE INDEX "_pages_v_blocks_content_media_links_parent_id_idx" ON "_pages_v_blocks_content_media_links" USING btree ("_parent_id");
  CREATE INDEX "_pages_v_blocks_content_media_order_idx" ON "_pages_v_blocks_content_media" USING btree ("_order");
  CREATE INDEX "_pages_v_blocks_content_media_parent_id_idx" ON "_pages_v_blocks_content_media" USING btree ("_parent_id");
  CREATE INDEX "_pages_v_blocks_content_media_path_idx" ON "_pages_v_blocks_content_media" USING btree ("_path");
  CREATE INDEX "_pages_v_blocks_content_media_media_idx" ON "_pages_v_blocks_content_media" USING btree ("media_id");
  CREATE INDEX "_pages_v_blocks_media_order_idx" ON "_pages_v_blocks_media" USING btree ("_order");
  CREATE INDEX "_pages_v_blocks_media_parent_id_idx" ON "_pages_v_blocks_media" USING btree ("_parent_id");
  CREATE INDEX "_pages_v_blocks_media_path_idx" ON "_pages_v_blocks_media" USING btree ("_path");
  CREATE INDEX "_pages_v_blocks_media_media_idx" ON "_pages_v_blocks_media" USING btree ("media_id");
  CREATE INDEX "_pages_v_blocks_card_grid_cards_order_idx" ON "_pages_v_blocks_card_grid_cards" USING btree ("_order");
  CREATE INDEX "_pages_v_blocks_card_grid_cards_parent_id_idx" ON "_pages_v_blocks_card_grid_cards" USING btree ("_parent_id");
  CREATE INDEX "_pages_v_blocks_card_grid_cards_image_idx" ON "_pages_v_blocks_card_grid_cards" USING btree ("image_id");
  CREATE INDEX "_pages_v_blocks_card_grid_order_idx" ON "_pages_v_blocks_card_grid" USING btree ("_order");
  CREATE INDEX "_pages_v_blocks_card_grid_parent_id_idx" ON "_pages_v_blocks_card_grid" USING btree ("_parent_id");
  CREATE INDEX "_pages_v_blocks_card_grid_path_idx" ON "_pages_v_blocks_card_grid" USING btree ("_path");
  CREATE INDEX "_pages_v_blocks_blockquote_order_idx" ON "_pages_v_blocks_blockquote" USING btree ("_order");
  CREATE INDEX "_pages_v_blocks_blockquote_parent_id_idx" ON "_pages_v_blocks_blockquote" USING btree ("_parent_id");
  CREATE INDEX "_pages_v_blocks_blockquote_path_idx" ON "_pages_v_blocks_blockquote" USING btree ("_path");
  CREATE INDEX "_pages_v_blocks_blockquote_image_idx" ON "_pages_v_blocks_blockquote" USING btree ("image_id");
  CREATE INDEX "_pages_v_blocks_call_to_action_links_order_idx" ON "_pages_v_blocks_call_to_action_links" USING btree ("_order");
  CREATE INDEX "_pages_v_blocks_call_to_action_links_parent_id_idx" ON "_pages_v_blocks_call_to_action_links" USING btree ("_parent_id");
  CREATE INDEX "_pages_v_blocks_call_to_action_order_idx" ON "_pages_v_blocks_call_to_action" USING btree ("_order");
  CREATE INDEX "_pages_v_blocks_call_to_action_parent_id_idx" ON "_pages_v_blocks_call_to_action" USING btree ("_parent_id");
  CREATE INDEX "_pages_v_blocks_call_to_action_path_idx" ON "_pages_v_blocks_call_to_action" USING btree ("_path");
  CREATE INDEX "_pages_v_version_breadcrumbs_order_idx" ON "_pages_v_version_breadcrumbs" USING btree ("_order");
  CREATE INDEX "_pages_v_version_breadcrumbs_parent_id_idx" ON "_pages_v_version_breadcrumbs" USING btree ("_parent_id");
  CREATE INDEX "_pages_v_version_breadcrumbs_doc_idx" ON "_pages_v_version_breadcrumbs" USING btree ("doc_id");
  ALTER TABLE "pages" ADD CONSTRAINT "pages_parent_id_pages_id_fk" FOREIGN KEY ("parent_id") REFERENCES "pages"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "pages_rels" ADD CONSTRAINT "pages_rels_pages_fk" FOREIGN KEY ("pages_id") REFERENCES "pages"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "_pages_v" ADD CONSTRAINT "_pages_v_version_parent_id_pages_id_fk" FOREIGN KEY ("version_parent_id") REFERENCES "pages"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "_pages_v_rels" ADD CONSTRAINT "_pages_v_rels_pages_fk" FOREIGN KEY ("pages_id") REFERENCES "pages"("id") ON DELETE cascade ON UPDATE no action;
  CREATE INDEX "pages_parent_idx" ON "pages" USING btree ("parent_id");
  CREATE INDEX "pages_rels_pages_id_idx" ON "pages_rels" USING btree ("pages_id");
  CREATE INDEX "_pages_v_version_version_parent_idx" ON "_pages_v" USING btree ("version_parent_id");
  CREATE INDEX "_pages_v_rels_pages_id_idx" ON "_pages_v_rels" USING btree ("pages_id");`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "pages_blocks_content_links" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "pages_blocks_content" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "pages_blocks_content_media_links" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "pages_blocks_content_media" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "pages_blocks_media" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "pages_blocks_card_grid_cards" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "pages_blocks_card_grid" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "pages_blocks_blockquote" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "pages_blocks_call_to_action_links" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "pages_blocks_call_to_action" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "pages_breadcrumbs" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "_pages_v_blocks_content_links" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "_pages_v_blocks_content" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "_pages_v_blocks_content_media_links" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "_pages_v_blocks_content_media" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "_pages_v_blocks_media" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "_pages_v_blocks_card_grid_cards" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "_pages_v_blocks_card_grid" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "_pages_v_blocks_blockquote" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "_pages_v_blocks_call_to_action_links" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "_pages_v_blocks_call_to_action" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "_pages_v_version_breadcrumbs" DISABLE ROW LEVEL SECURITY;
  DROP TABLE "pages_blocks_content_links" CASCADE;
  DROP TABLE "pages_blocks_content" CASCADE;
  DROP TABLE "pages_blocks_content_media_links" CASCADE;
  DROP TABLE "pages_blocks_content_media" CASCADE;
  DROP TABLE "pages_blocks_media" CASCADE;
  DROP TABLE "pages_blocks_card_grid_cards" CASCADE;
  DROP TABLE "pages_blocks_card_grid" CASCADE;
  DROP TABLE "pages_blocks_blockquote" CASCADE;
  DROP TABLE "pages_blocks_call_to_action_links" CASCADE;
  DROP TABLE "pages_blocks_call_to_action" CASCADE;
  DROP TABLE "pages_breadcrumbs" CASCADE;
  DROP TABLE "_pages_v_blocks_content_links" CASCADE;
  DROP TABLE "_pages_v_blocks_content" CASCADE;
  DROP TABLE "_pages_v_blocks_content_media_links" CASCADE;
  DROP TABLE "_pages_v_blocks_content_media" CASCADE;
  DROP TABLE "_pages_v_blocks_media" CASCADE;
  DROP TABLE "_pages_v_blocks_card_grid_cards" CASCADE;
  DROP TABLE "_pages_v_blocks_card_grid" CASCADE;
  DROP TABLE "_pages_v_blocks_blockquote" CASCADE;
  DROP TABLE "_pages_v_blocks_call_to_action_links" CASCADE;
  DROP TABLE "_pages_v_blocks_call_to_action" CASCADE;
  DROP TABLE "_pages_v_version_breadcrumbs" CASCADE;
  ALTER TABLE "pages" DROP CONSTRAINT "pages_parent_id_pages_id_fk";
  
  ALTER TABLE "pages_rels" DROP CONSTRAINT "pages_rels_pages_fk";
  
  ALTER TABLE "_pages_v" DROP CONSTRAINT "_pages_v_version_parent_id_pages_id_fk";
  
  ALTER TABLE "_pages_v_rels" DROP CONSTRAINT "_pages_v_rels_pages_fk";
  
  DROP INDEX "pages_parent_idx";
  DROP INDEX "pages_rels_pages_id_idx";
  DROP INDEX "_pages_v_version_version_parent_idx";
  DROP INDEX "_pages_v_rels_pages_id_idx";
  ALTER TABLE "pages" DROP COLUMN "parent_id";
  ALTER TABLE "pages_rels" DROP COLUMN "pages_id";
  ALTER TABLE "_pages_v" DROP COLUMN "version_parent_id";
  ALTER TABLE "_pages_v_rels" DROP COLUMN "pages_id";
  ALTER TABLE "media" DROP COLUMN "caption";
  ALTER TABLE "_media_v" DROP COLUMN "version_caption";
  DROP TYPE "enum_pages_blocks_content_links_link_type";
  DROP TYPE "enum_pages_blocks_content_links_link_variant";
  DROP TYPE "enum_pages_blocks_content_align";
  DROP TYPE "enum_pages_blocks_content_skin";
  DROP TYPE "enum_pages_blocks_content_width";
  DROP TYPE "enum_pages_blocks_content_padding_top";
  DROP TYPE "enum_pages_blocks_content_padding_bottom";
  DROP TYPE "enum_pages_blocks_content_media_links_link_type";
  DROP TYPE "enum_pages_blocks_content_media_links_link_variant";
  DROP TYPE "enum_pages_blocks_content_media_media_position";
  DROP TYPE "enum_pages_blocks_content_media_skin";
  DROP TYPE "enum_pages_blocks_content_media_width";
  DROP TYPE "enum_pages_blocks_content_media_padding_top";
  DROP TYPE "enum_pages_blocks_content_media_padding_bottom";
  DROP TYPE "enum_pages_blocks_media_skin";
  DROP TYPE "enum_pages_blocks_media_width";
  DROP TYPE "enum_pages_blocks_media_padding_top";
  DROP TYPE "enum_pages_blocks_media_padding_bottom";
  DROP TYPE "enum_pages_blocks_card_grid_cards_link_type";
  DROP TYPE "enum_pages_blocks_card_grid_columns";
  DROP TYPE "enum_pages_blocks_card_grid_skin";
  DROP TYPE "enum_pages_blocks_card_grid_width";
  DROP TYPE "enum_pages_blocks_card_grid_padding_top";
  DROP TYPE "enum_pages_blocks_card_grid_padding_bottom";
  DROP TYPE "enum_pages_blocks_blockquote_skin";
  DROP TYPE "enum_pages_blocks_blockquote_width";
  DROP TYPE "enum_pages_blocks_blockquote_padding_top";
  DROP TYPE "enum_pages_blocks_blockquote_padding_bottom";
  DROP TYPE "enum_pages_blocks_call_to_action_links_link_type";
  DROP TYPE "enum_pages_blocks_call_to_action_links_link_variant";
  DROP TYPE "enum_pages_blocks_call_to_action_skin";
  DROP TYPE "enum_pages_blocks_call_to_action_width";
  DROP TYPE "enum_pages_blocks_call_to_action_padding_top";
  DROP TYPE "enum_pages_blocks_call_to_action_padding_bottom";
  DROP TYPE "enum__pages_v_blocks_content_links_link_type";
  DROP TYPE "enum__pages_v_blocks_content_links_link_variant";
  DROP TYPE "enum__pages_v_blocks_content_align";
  DROP TYPE "enum__pages_v_blocks_content_skin";
  DROP TYPE "enum__pages_v_blocks_content_width";
  DROP TYPE "enum__pages_v_blocks_content_padding_top";
  DROP TYPE "enum__pages_v_blocks_content_padding_bottom";
  DROP TYPE "enum__pages_v_blocks_content_media_links_link_type";
  DROP TYPE "enum__pages_v_blocks_content_media_links_link_variant";
  DROP TYPE "enum__pages_v_blocks_content_media_media_position";
  DROP TYPE "enum__pages_v_blocks_content_media_skin";
  DROP TYPE "enum__pages_v_blocks_content_media_width";
  DROP TYPE "enum__pages_v_blocks_content_media_padding_top";
  DROP TYPE "enum__pages_v_blocks_content_media_padding_bottom";
  DROP TYPE "enum__pages_v_blocks_media_skin";
  DROP TYPE "enum__pages_v_blocks_media_width";
  DROP TYPE "enum__pages_v_blocks_media_padding_top";
  DROP TYPE "enum__pages_v_blocks_media_padding_bottom";
  DROP TYPE "enum__pages_v_blocks_card_grid_cards_link_type";
  DROP TYPE "enum__pages_v_blocks_card_grid_columns";
  DROP TYPE "enum__pages_v_blocks_card_grid_skin";
  DROP TYPE "enum__pages_v_blocks_card_grid_width";
  DROP TYPE "enum__pages_v_blocks_card_grid_padding_top";
  DROP TYPE "enum__pages_v_blocks_card_grid_padding_bottom";
  DROP TYPE "enum__pages_v_blocks_blockquote_skin";
  DROP TYPE "enum__pages_v_blocks_blockquote_width";
  DROP TYPE "enum__pages_v_blocks_blockquote_padding_top";
  DROP TYPE "enum__pages_v_blocks_blockquote_padding_bottom";
  DROP TYPE "enum__pages_v_blocks_call_to_action_links_link_type";
  DROP TYPE "enum__pages_v_blocks_call_to_action_links_link_variant";
  DROP TYPE "enum__pages_v_blocks_call_to_action_skin";
  DROP TYPE "enum__pages_v_blocks_call_to_action_width";
  DROP TYPE "enum__pages_v_blocks_call_to_action_padding_top";
  DROP TYPE "enum__pages_v_blocks_call_to_action_padding_bottom";`)
}
