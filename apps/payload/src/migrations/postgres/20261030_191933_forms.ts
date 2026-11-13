import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   CREATE TYPE "enum_pages_blocks_form_skin" AS ENUM('light', 'dark', 'accent');
  CREATE TYPE "enum_pages_blocks_form_width" AS ENUM('narrow', 'default', 'wide', 'full');
  CREATE TYPE "enum_pages_blocks_form_padding_top" AS ENUM('none', 'sm', 'md', 'lg');
  CREATE TYPE "enum_pages_blocks_form_padding_bottom" AS ENUM('none', 'sm', 'md', 'lg');
  CREATE TYPE "enum__pages_v_blocks_form_skin" AS ENUM('light', 'dark', 'accent');
  CREATE TYPE "enum__pages_v_blocks_form_width" AS ENUM('narrow', 'default', 'wide', 'full');
  CREATE TYPE "enum__pages_v_blocks_form_padding_top" AS ENUM('none', 'sm', 'md', 'lg');
  CREATE TYPE "enum__pages_v_blocks_form_padding_bottom" AS ENUM('none', 'sm', 'md', 'lg');
  CREATE TYPE "enum_forms_confirmation_type" AS ENUM('message', 'redirect');
  CREATE TYPE "enum_forms_redirect_type" AS ENUM('reference', 'custom');
  CREATE TYPE "enum__forms_v_version_confirmation_type" AS ENUM('message', 'redirect');
  CREATE TYPE "enum__forms_v_version_redirect_type" AS ENUM('reference', 'custom');
  CREATE TABLE "pages_blocks_form" (
  	"_order" integer NOT NULL,
  	"_parent_id" integer NOT NULL,
  	"_path" text NOT NULL,
  	"id" varchar PRIMARY KEY NOT NULL,
  	"heading" varchar,
  	"body" jsonb,
  	"form_id" integer,
  	"section_options_skin" "enum_pages_blocks_form_skin" DEFAULT 'light',
  	"section_options_width" "enum_pages_blocks_form_width" DEFAULT 'default',
  	"section_options_padding_top" "enum_pages_blocks_form_padding_top" DEFAULT 'md',
  	"section_options_padding_bottom" "enum_pages_blocks_form_padding_bottom" DEFAULT 'md',
  	"section_options_anchor" varchar,
  	"section_options_hidden" boolean DEFAULT false,
  	"block_name" varchar
  );
  
  CREATE TABLE "_pages_v_blocks_form" (
  	"_order" integer NOT NULL,
  	"_parent_id" integer NOT NULL,
  	"_path" text NOT NULL,
  	"id" serial PRIMARY KEY NOT NULL,
  	"heading" varchar,
  	"body" jsonb,
  	"form_id" integer,
  	"section_options_skin" "enum__pages_v_blocks_form_skin" DEFAULT 'light',
  	"section_options_width" "enum__pages_v_blocks_form_width" DEFAULT 'default',
  	"section_options_padding_top" "enum__pages_v_blocks_form_padding_top" DEFAULT 'md',
  	"section_options_padding_bottom" "enum__pages_v_blocks_form_padding_bottom" DEFAULT 'md',
  	"section_options_anchor" varchar,
  	"section_options_hidden" boolean DEFAULT false,
  	"_uuid" varchar,
  	"block_name" varchar
  );
  
  CREATE TABLE "forms_blocks_checkbox" (
  	"_order" integer NOT NULL,
  	"_parent_id" integer NOT NULL,
  	"_path" text NOT NULL,
  	"id" varchar PRIMARY KEY NOT NULL,
  	"name" varchar NOT NULL,
  	"label" varchar,
  	"width" numeric,
  	"required" boolean,
  	"default_value" boolean,
  	"block_name" varchar
  );
  
  CREATE TABLE "forms_blocks_email" (
  	"_order" integer NOT NULL,
  	"_parent_id" integer NOT NULL,
  	"_path" text NOT NULL,
  	"id" varchar PRIMARY KEY NOT NULL,
  	"name" varchar NOT NULL,
  	"label" varchar,
  	"width" numeric,
  	"required" boolean,
  	"block_name" varchar
  );
  
  CREATE TABLE "forms_blocks_message" (
  	"_order" integer NOT NULL,
  	"_parent_id" integer NOT NULL,
  	"_path" text NOT NULL,
  	"id" varchar PRIMARY KEY NOT NULL,
  	"message" jsonb,
  	"block_name" varchar
  );
  
  CREATE TABLE "forms_blocks_number" (
  	"_order" integer NOT NULL,
  	"_parent_id" integer NOT NULL,
  	"_path" text NOT NULL,
  	"id" varchar PRIMARY KEY NOT NULL,
  	"name" varchar NOT NULL,
  	"label" varchar,
  	"width" numeric,
  	"default_value" numeric,
  	"required" boolean,
  	"block_name" varchar
  );
  
  CREATE TABLE "forms_blocks_select_options" (
  	"_order" integer NOT NULL,
  	"_parent_id" varchar NOT NULL,
  	"id" varchar PRIMARY KEY NOT NULL,
  	"label" varchar NOT NULL,
  	"value" varchar NOT NULL
  );
  
  CREATE TABLE "forms_blocks_select" (
  	"_order" integer NOT NULL,
  	"_parent_id" integer NOT NULL,
  	"_path" text NOT NULL,
  	"id" varchar PRIMARY KEY NOT NULL,
  	"name" varchar NOT NULL,
  	"label" varchar,
  	"width" numeric,
  	"default_value" varchar,
  	"placeholder" varchar,
  	"required" boolean,
  	"block_name" varchar
  );
  
  CREATE TABLE "forms_blocks_text" (
  	"_order" integer NOT NULL,
  	"_parent_id" integer NOT NULL,
  	"_path" text NOT NULL,
  	"id" varchar PRIMARY KEY NOT NULL,
  	"name" varchar NOT NULL,
  	"label" varchar,
  	"width" numeric,
  	"default_value" varchar,
  	"required" boolean,
  	"block_name" varchar
  );
  
  CREATE TABLE "forms_blocks_textarea" (
  	"_order" integer NOT NULL,
  	"_parent_id" integer NOT NULL,
  	"_path" text NOT NULL,
  	"id" varchar PRIMARY KEY NOT NULL,
  	"name" varchar NOT NULL,
  	"label" varchar,
  	"width" numeric,
  	"default_value" varchar,
  	"required" boolean,
  	"block_name" varchar
  );
  
  CREATE TABLE "forms_emails" (
  	"_order" integer NOT NULL,
  	"_parent_id" integer NOT NULL,
  	"id" varchar PRIMARY KEY NOT NULL,
  	"email_to" varchar,
  	"cc" varchar,
  	"bcc" varchar,
  	"reply_to" varchar,
  	"email_from" varchar,
  	"subject" varchar DEFAULT 'You''ve received a new message.' NOT NULL,
  	"message" jsonb
  );
  
  CREATE TABLE "forms" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"title" varchar NOT NULL,
  	"submit_button_label" varchar,
  	"confirmation_type" "enum_forms_confirmation_type" DEFAULT 'message',
  	"confirmation_message" jsonb,
  	"redirect_type" "enum_forms_redirect_type" DEFAULT 'reference',
  	"redirect_url" varchar,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  CREATE TABLE "forms_rels" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"order" integer,
  	"parent_id" integer NOT NULL,
  	"path" varchar NOT NULL,
  	"pages_id" integer,
  	"users_id" integer
  );
  
  CREATE TABLE "_forms_v_blocks_checkbox" (
  	"_order" integer NOT NULL,
  	"_parent_id" integer NOT NULL,
  	"_path" text NOT NULL,
  	"id" serial PRIMARY KEY NOT NULL,
  	"name" varchar NOT NULL,
  	"label" varchar,
  	"width" numeric,
  	"required" boolean,
  	"default_value" boolean,
  	"_uuid" varchar,
  	"block_name" varchar
  );
  
  CREATE TABLE "_forms_v_blocks_email" (
  	"_order" integer NOT NULL,
  	"_parent_id" integer NOT NULL,
  	"_path" text NOT NULL,
  	"id" serial PRIMARY KEY NOT NULL,
  	"name" varchar NOT NULL,
  	"label" varchar,
  	"width" numeric,
  	"required" boolean,
  	"_uuid" varchar,
  	"block_name" varchar
  );
  
  CREATE TABLE "_forms_v_blocks_message" (
  	"_order" integer NOT NULL,
  	"_parent_id" integer NOT NULL,
  	"_path" text NOT NULL,
  	"id" serial PRIMARY KEY NOT NULL,
  	"message" jsonb,
  	"_uuid" varchar,
  	"block_name" varchar
  );
  
  CREATE TABLE "_forms_v_blocks_number" (
  	"_order" integer NOT NULL,
  	"_parent_id" integer NOT NULL,
  	"_path" text NOT NULL,
  	"id" serial PRIMARY KEY NOT NULL,
  	"name" varchar NOT NULL,
  	"label" varchar,
  	"width" numeric,
  	"default_value" numeric,
  	"required" boolean,
  	"_uuid" varchar,
  	"block_name" varchar
  );
  
  CREATE TABLE "_forms_v_blocks_select_options" (
  	"_order" integer NOT NULL,
  	"_parent_id" integer NOT NULL,
  	"id" serial PRIMARY KEY NOT NULL,
  	"label" varchar NOT NULL,
  	"value" varchar NOT NULL,
  	"_uuid" varchar
  );
  
  CREATE TABLE "_forms_v_blocks_select" (
  	"_order" integer NOT NULL,
  	"_parent_id" integer NOT NULL,
  	"_path" text NOT NULL,
  	"id" serial PRIMARY KEY NOT NULL,
  	"name" varchar NOT NULL,
  	"label" varchar,
  	"width" numeric,
  	"default_value" varchar,
  	"placeholder" varchar,
  	"required" boolean,
  	"_uuid" varchar,
  	"block_name" varchar
  );
  
  CREATE TABLE "_forms_v_blocks_text" (
  	"_order" integer NOT NULL,
  	"_parent_id" integer NOT NULL,
  	"_path" text NOT NULL,
  	"id" serial PRIMARY KEY NOT NULL,
  	"name" varchar NOT NULL,
  	"label" varchar,
  	"width" numeric,
  	"default_value" varchar,
  	"required" boolean,
  	"_uuid" varchar,
  	"block_name" varchar
  );
  
  CREATE TABLE "_forms_v_blocks_textarea" (
  	"_order" integer NOT NULL,
  	"_parent_id" integer NOT NULL,
  	"_path" text NOT NULL,
  	"id" serial PRIMARY KEY NOT NULL,
  	"name" varchar NOT NULL,
  	"label" varchar,
  	"width" numeric,
  	"default_value" varchar,
  	"required" boolean,
  	"_uuid" varchar,
  	"block_name" varchar
  );
  
  CREATE TABLE "_forms_v_version_emails" (
  	"_order" integer NOT NULL,
  	"_parent_id" integer NOT NULL,
  	"id" serial PRIMARY KEY NOT NULL,
  	"email_to" varchar,
  	"cc" varchar,
  	"bcc" varchar,
  	"reply_to" varchar,
  	"email_from" varchar,
  	"subject" varchar DEFAULT 'You''ve received a new message.' NOT NULL,
  	"message" jsonb,
  	"_uuid" varchar
  );
  
  CREATE TABLE "_forms_v" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"parent_id" integer,
  	"version_title" varchar NOT NULL,
  	"version_submit_button_label" varchar,
  	"version_confirmation_type" "enum__forms_v_version_confirmation_type" DEFAULT 'message',
  	"version_confirmation_message" jsonb,
  	"version_redirect_type" "enum__forms_v_version_redirect_type" DEFAULT 'reference',
  	"version_redirect_url" varchar,
  	"version_updated_at" timestamp(3) with time zone,
  	"version_created_at" timestamp(3) with time zone,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  CREATE TABLE "_forms_v_rels" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"order" integer,
  	"parent_id" integer NOT NULL,
  	"path" varchar NOT NULL,
  	"pages_id" integer,
  	"users_id" integer
  );
  
  CREATE TABLE "form_submissions_submission_data" (
  	"_order" integer NOT NULL,
  	"_parent_id" integer NOT NULL,
  	"id" varchar PRIMARY KEY NOT NULL,
  	"field" varchar NOT NULL,
  	"value" varchar NOT NULL
  );
  
  CREATE TABLE "form_submissions" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"form_id" integer NOT NULL,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  CREATE TABLE "form_submissions_rels" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"order" integer,
  	"parent_id" integer NOT NULL,
  	"path" varchar NOT NULL,
  	"users_id" integer
  );
  
  CREATE TABLE "_form_submissions_v_version_submission_data" (
  	"_order" integer NOT NULL,
  	"_parent_id" integer NOT NULL,
  	"id" serial PRIMARY KEY NOT NULL,
  	"field" varchar NOT NULL,
  	"value" varchar NOT NULL,
  	"_uuid" varchar
  );
  
  CREATE TABLE "_form_submissions_v" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"parent_id" integer,
  	"version_form_id" integer NOT NULL,
  	"version_updated_at" timestamp(3) with time zone,
  	"version_created_at" timestamp(3) with time zone,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  CREATE TABLE "_form_submissions_v_rels" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"order" integer,
  	"parent_id" integer NOT NULL,
  	"path" varchar NOT NULL,
  	"users_id" integer
  );
  
  ALTER TABLE "payload_locked_documents_rels" ADD COLUMN "forms_id" integer;
  ALTER TABLE "payload_locked_documents_rels" ADD COLUMN "form_submissions_id" integer;
  ALTER TABLE "pages_blocks_form" ADD CONSTRAINT "pages_blocks_form_form_id_forms_id_fk" FOREIGN KEY ("form_id") REFERENCES "forms"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "pages_blocks_form" ADD CONSTRAINT "pages_blocks_form_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "pages"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "_pages_v_blocks_form" ADD CONSTRAINT "_pages_v_blocks_form_form_id_forms_id_fk" FOREIGN KEY ("form_id") REFERENCES "forms"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "_pages_v_blocks_form" ADD CONSTRAINT "_pages_v_blocks_form_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "_pages_v"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "forms_blocks_checkbox" ADD CONSTRAINT "forms_blocks_checkbox_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "forms"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "forms_blocks_email" ADD CONSTRAINT "forms_blocks_email_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "forms"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "forms_blocks_message" ADD CONSTRAINT "forms_blocks_message_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "forms"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "forms_blocks_number" ADD CONSTRAINT "forms_blocks_number_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "forms"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "forms_blocks_select_options" ADD CONSTRAINT "forms_blocks_select_options_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "forms_blocks_select"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "forms_blocks_select" ADD CONSTRAINT "forms_blocks_select_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "forms"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "forms_blocks_text" ADD CONSTRAINT "forms_blocks_text_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "forms"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "forms_blocks_textarea" ADD CONSTRAINT "forms_blocks_textarea_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "forms"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "forms_emails" ADD CONSTRAINT "forms_emails_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "forms"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "forms_rels" ADD CONSTRAINT "forms_rels_parent_fk" FOREIGN KEY ("parent_id") REFERENCES "forms"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "forms_rels" ADD CONSTRAINT "forms_rels_pages_fk" FOREIGN KEY ("pages_id") REFERENCES "pages"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "forms_rels" ADD CONSTRAINT "forms_rels_users_fk" FOREIGN KEY ("users_id") REFERENCES "users"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "_forms_v_blocks_checkbox" ADD CONSTRAINT "_forms_v_blocks_checkbox_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "_forms_v"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "_forms_v_blocks_email" ADD CONSTRAINT "_forms_v_blocks_email_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "_forms_v"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "_forms_v_blocks_message" ADD CONSTRAINT "_forms_v_blocks_message_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "_forms_v"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "_forms_v_blocks_number" ADD CONSTRAINT "_forms_v_blocks_number_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "_forms_v"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "_forms_v_blocks_select_options" ADD CONSTRAINT "_forms_v_blocks_select_options_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "_forms_v_blocks_select"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "_forms_v_blocks_select" ADD CONSTRAINT "_forms_v_blocks_select_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "_forms_v"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "_forms_v_blocks_text" ADD CONSTRAINT "_forms_v_blocks_text_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "_forms_v"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "_forms_v_blocks_textarea" ADD CONSTRAINT "_forms_v_blocks_textarea_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "_forms_v"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "_forms_v_version_emails" ADD CONSTRAINT "_forms_v_version_emails_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "_forms_v"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "_forms_v" ADD CONSTRAINT "_forms_v_parent_id_forms_id_fk" FOREIGN KEY ("parent_id") REFERENCES "forms"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "_forms_v_rels" ADD CONSTRAINT "_forms_v_rels_parent_fk" FOREIGN KEY ("parent_id") REFERENCES "_forms_v"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "_forms_v_rels" ADD CONSTRAINT "_forms_v_rels_pages_fk" FOREIGN KEY ("pages_id") REFERENCES "pages"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "_forms_v_rels" ADD CONSTRAINT "_forms_v_rels_users_fk" FOREIGN KEY ("users_id") REFERENCES "users"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "form_submissions_submission_data" ADD CONSTRAINT "form_submissions_submission_data_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "form_submissions"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "form_submissions" ADD CONSTRAINT "form_submissions_form_id_forms_id_fk" FOREIGN KEY ("form_id") REFERENCES "forms"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "form_submissions_rels" ADD CONSTRAINT "form_submissions_rels_parent_fk" FOREIGN KEY ("parent_id") REFERENCES "form_submissions"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "form_submissions_rels" ADD CONSTRAINT "form_submissions_rels_users_fk" FOREIGN KEY ("users_id") REFERENCES "users"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "_form_submissions_v_version_submission_data" ADD CONSTRAINT "_form_submissions_v_version_submission_data_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "_form_submissions_v"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "_form_submissions_v" ADD CONSTRAINT "_form_submissions_v_parent_id_form_submissions_id_fk" FOREIGN KEY ("parent_id") REFERENCES "form_submissions"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "_form_submissions_v" ADD CONSTRAINT "_form_submissions_v_version_form_id_forms_id_fk" FOREIGN KEY ("version_form_id") REFERENCES "forms"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "_form_submissions_v_rels" ADD CONSTRAINT "_form_submissions_v_rels_parent_fk" FOREIGN KEY ("parent_id") REFERENCES "_form_submissions_v"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "_form_submissions_v_rels" ADD CONSTRAINT "_form_submissions_v_rels_users_fk" FOREIGN KEY ("users_id") REFERENCES "users"("id") ON DELETE cascade ON UPDATE no action;
  CREATE INDEX "pages_blocks_form_order_idx" ON "pages_blocks_form" USING btree ("_order");
  CREATE INDEX "pages_blocks_form_parent_id_idx" ON "pages_blocks_form" USING btree ("_parent_id");
  CREATE INDEX "pages_blocks_form_path_idx" ON "pages_blocks_form" USING btree ("_path");
  CREATE INDEX "pages_blocks_form_form_idx" ON "pages_blocks_form" USING btree ("form_id");
  CREATE INDEX "_pages_v_blocks_form_order_idx" ON "_pages_v_blocks_form" USING btree ("_order");
  CREATE INDEX "_pages_v_blocks_form_parent_id_idx" ON "_pages_v_blocks_form" USING btree ("_parent_id");
  CREATE INDEX "_pages_v_blocks_form_path_idx" ON "_pages_v_blocks_form" USING btree ("_path");
  CREATE INDEX "_pages_v_blocks_form_form_idx" ON "_pages_v_blocks_form" USING btree ("form_id");
  CREATE INDEX "forms_blocks_checkbox_order_idx" ON "forms_blocks_checkbox" USING btree ("_order");
  CREATE INDEX "forms_blocks_checkbox_parent_id_idx" ON "forms_blocks_checkbox" USING btree ("_parent_id");
  CREATE INDEX "forms_blocks_checkbox_path_idx" ON "forms_blocks_checkbox" USING btree ("_path");
  CREATE INDEX "forms_blocks_email_order_idx" ON "forms_blocks_email" USING btree ("_order");
  CREATE INDEX "forms_blocks_email_parent_id_idx" ON "forms_blocks_email" USING btree ("_parent_id");
  CREATE INDEX "forms_blocks_email_path_idx" ON "forms_blocks_email" USING btree ("_path");
  CREATE INDEX "forms_blocks_message_order_idx" ON "forms_blocks_message" USING btree ("_order");
  CREATE INDEX "forms_blocks_message_parent_id_idx" ON "forms_blocks_message" USING btree ("_parent_id");
  CREATE INDEX "forms_blocks_message_path_idx" ON "forms_blocks_message" USING btree ("_path");
  CREATE INDEX "forms_blocks_number_order_idx" ON "forms_blocks_number" USING btree ("_order");
  CREATE INDEX "forms_blocks_number_parent_id_idx" ON "forms_blocks_number" USING btree ("_parent_id");
  CREATE INDEX "forms_blocks_number_path_idx" ON "forms_blocks_number" USING btree ("_path");
  CREATE INDEX "forms_blocks_select_options_order_idx" ON "forms_blocks_select_options" USING btree ("_order");
  CREATE INDEX "forms_blocks_select_options_parent_id_idx" ON "forms_blocks_select_options" USING btree ("_parent_id");
  CREATE INDEX "forms_blocks_select_order_idx" ON "forms_blocks_select" USING btree ("_order");
  CREATE INDEX "forms_blocks_select_parent_id_idx" ON "forms_blocks_select" USING btree ("_parent_id");
  CREATE INDEX "forms_blocks_select_path_idx" ON "forms_blocks_select" USING btree ("_path");
  CREATE INDEX "forms_blocks_text_order_idx" ON "forms_blocks_text" USING btree ("_order");
  CREATE INDEX "forms_blocks_text_parent_id_idx" ON "forms_blocks_text" USING btree ("_parent_id");
  CREATE INDEX "forms_blocks_text_path_idx" ON "forms_blocks_text" USING btree ("_path");
  CREATE INDEX "forms_blocks_textarea_order_idx" ON "forms_blocks_textarea" USING btree ("_order");
  CREATE INDEX "forms_blocks_textarea_parent_id_idx" ON "forms_blocks_textarea" USING btree ("_parent_id");
  CREATE INDEX "forms_blocks_textarea_path_idx" ON "forms_blocks_textarea" USING btree ("_path");
  CREATE INDEX "forms_emails_order_idx" ON "forms_emails" USING btree ("_order");
  CREATE INDEX "forms_emails_parent_id_idx" ON "forms_emails" USING btree ("_parent_id");
  CREATE INDEX "forms_updated_at_idx" ON "forms" USING btree ("updated_at");
  CREATE INDEX "forms_created_at_idx" ON "forms" USING btree ("created_at");
  CREATE INDEX "forms_rels_order_idx" ON "forms_rels" USING btree ("order");
  CREATE INDEX "forms_rels_parent_idx" ON "forms_rels" USING btree ("parent_id");
  CREATE INDEX "forms_rels_path_idx" ON "forms_rels" USING btree ("path");
  CREATE INDEX "forms_rels_pages_id_idx" ON "forms_rels" USING btree ("pages_id");
  CREATE INDEX "forms_rels_users_id_idx" ON "forms_rels" USING btree ("users_id");
  CREATE INDEX "_forms_v_blocks_checkbox_order_idx" ON "_forms_v_blocks_checkbox" USING btree ("_order");
  CREATE INDEX "_forms_v_blocks_checkbox_parent_id_idx" ON "_forms_v_blocks_checkbox" USING btree ("_parent_id");
  CREATE INDEX "_forms_v_blocks_checkbox_path_idx" ON "_forms_v_blocks_checkbox" USING btree ("_path");
  CREATE INDEX "_forms_v_blocks_email_order_idx" ON "_forms_v_blocks_email" USING btree ("_order");
  CREATE INDEX "_forms_v_blocks_email_parent_id_idx" ON "_forms_v_blocks_email" USING btree ("_parent_id");
  CREATE INDEX "_forms_v_blocks_email_path_idx" ON "_forms_v_blocks_email" USING btree ("_path");
  CREATE INDEX "_forms_v_blocks_message_order_idx" ON "_forms_v_blocks_message" USING btree ("_order");
  CREATE INDEX "_forms_v_blocks_message_parent_id_idx" ON "_forms_v_blocks_message" USING btree ("_parent_id");
  CREATE INDEX "_forms_v_blocks_message_path_idx" ON "_forms_v_blocks_message" USING btree ("_path");
  CREATE INDEX "_forms_v_blocks_number_order_idx" ON "_forms_v_blocks_number" USING btree ("_order");
  CREATE INDEX "_forms_v_blocks_number_parent_id_idx" ON "_forms_v_blocks_number" USING btree ("_parent_id");
  CREATE INDEX "_forms_v_blocks_number_path_idx" ON "_forms_v_blocks_number" USING btree ("_path");
  CREATE INDEX "_forms_v_blocks_select_options_order_idx" ON "_forms_v_blocks_select_options" USING btree ("_order");
  CREATE INDEX "_forms_v_blocks_select_options_parent_id_idx" ON "_forms_v_blocks_select_options" USING btree ("_parent_id");
  CREATE INDEX "_forms_v_blocks_select_order_idx" ON "_forms_v_blocks_select" USING btree ("_order");
  CREATE INDEX "_forms_v_blocks_select_parent_id_idx" ON "_forms_v_blocks_select" USING btree ("_parent_id");
  CREATE INDEX "_forms_v_blocks_select_path_idx" ON "_forms_v_blocks_select" USING btree ("_path");
  CREATE INDEX "_forms_v_blocks_text_order_idx" ON "_forms_v_blocks_text" USING btree ("_order");
  CREATE INDEX "_forms_v_blocks_text_parent_id_idx" ON "_forms_v_blocks_text" USING btree ("_parent_id");
  CREATE INDEX "_forms_v_blocks_text_path_idx" ON "_forms_v_blocks_text" USING btree ("_path");
  CREATE INDEX "_forms_v_blocks_textarea_order_idx" ON "_forms_v_blocks_textarea" USING btree ("_order");
  CREATE INDEX "_forms_v_blocks_textarea_parent_id_idx" ON "_forms_v_blocks_textarea" USING btree ("_parent_id");
  CREATE INDEX "_forms_v_blocks_textarea_path_idx" ON "_forms_v_blocks_textarea" USING btree ("_path");
  CREATE INDEX "_forms_v_version_emails_order_idx" ON "_forms_v_version_emails" USING btree ("_order");
  CREATE INDEX "_forms_v_version_emails_parent_id_idx" ON "_forms_v_version_emails" USING btree ("_parent_id");
  CREATE INDEX "_forms_v_parent_idx" ON "_forms_v" USING btree ("parent_id");
  CREATE INDEX "_forms_v_version_version_updated_at_idx" ON "_forms_v" USING btree ("version_updated_at");
  CREATE INDEX "_forms_v_version_version_created_at_idx" ON "_forms_v" USING btree ("version_created_at");
  CREATE INDEX "_forms_v_created_at_idx" ON "_forms_v" USING btree ("created_at");
  CREATE INDEX "_forms_v_updated_at_idx" ON "_forms_v" USING btree ("updated_at");
  CREATE INDEX "_forms_v_rels_order_idx" ON "_forms_v_rels" USING btree ("order");
  CREATE INDEX "_forms_v_rels_parent_idx" ON "_forms_v_rels" USING btree ("parent_id");
  CREATE INDEX "_forms_v_rels_path_idx" ON "_forms_v_rels" USING btree ("path");
  CREATE INDEX "_forms_v_rels_pages_id_idx" ON "_forms_v_rels" USING btree ("pages_id");
  CREATE INDEX "_forms_v_rels_users_id_idx" ON "_forms_v_rels" USING btree ("users_id");
  CREATE INDEX "form_submissions_submission_data_order_idx" ON "form_submissions_submission_data" USING btree ("_order");
  CREATE INDEX "form_submissions_submission_data_parent_id_idx" ON "form_submissions_submission_data" USING btree ("_parent_id");
  CREATE INDEX "form_submissions_form_idx" ON "form_submissions" USING btree ("form_id");
  CREATE INDEX "form_submissions_updated_at_idx" ON "form_submissions" USING btree ("updated_at");
  CREATE INDEX "form_submissions_created_at_idx" ON "form_submissions" USING btree ("created_at");
  CREATE INDEX "form_submissions_rels_order_idx" ON "form_submissions_rels" USING btree ("order");
  CREATE INDEX "form_submissions_rels_parent_idx" ON "form_submissions_rels" USING btree ("parent_id");
  CREATE INDEX "form_submissions_rels_path_idx" ON "form_submissions_rels" USING btree ("path");
  CREATE INDEX "form_submissions_rels_users_id_idx" ON "form_submissions_rels" USING btree ("users_id");
  CREATE INDEX "_form_submissions_v_version_submission_data_order_idx" ON "_form_submissions_v_version_submission_data" USING btree ("_order");
  CREATE INDEX "_form_submissions_v_version_submission_data_parent_id_idx" ON "_form_submissions_v_version_submission_data" USING btree ("_parent_id");
  CREATE INDEX "_form_submissions_v_parent_idx" ON "_form_submissions_v" USING btree ("parent_id");
  CREATE INDEX "_form_submissions_v_version_version_form_idx" ON "_form_submissions_v" USING btree ("version_form_id");
  CREATE INDEX "_form_submissions_v_version_version_updated_at_idx" ON "_form_submissions_v" USING btree ("version_updated_at");
  CREATE INDEX "_form_submissions_v_version_version_created_at_idx" ON "_form_submissions_v" USING btree ("version_created_at");
  CREATE INDEX "_form_submissions_v_created_at_idx" ON "_form_submissions_v" USING btree ("created_at");
  CREATE INDEX "_form_submissions_v_updated_at_idx" ON "_form_submissions_v" USING btree ("updated_at");
  CREATE INDEX "_form_submissions_v_rels_order_idx" ON "_form_submissions_v_rels" USING btree ("order");
  CREATE INDEX "_form_submissions_v_rels_parent_idx" ON "_form_submissions_v_rels" USING btree ("parent_id");
  CREATE INDEX "_form_submissions_v_rels_path_idx" ON "_form_submissions_v_rels" USING btree ("path");
  CREATE INDEX "_form_submissions_v_rels_users_id_idx" ON "_form_submissions_v_rels" USING btree ("users_id");
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_forms_fk" FOREIGN KEY ("forms_id") REFERENCES "forms"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_form_submissions_fk" FOREIGN KEY ("form_submissions_id") REFERENCES "form_submissions"("id") ON DELETE cascade ON UPDATE no action;
  CREATE INDEX "payload_locked_documents_rels_forms_id_idx" ON "payload_locked_documents_rels" USING btree ("forms_id");
  CREATE INDEX "payload_locked_documents_rels_form_submissions_id_idx" ON "payload_locked_documents_rels" USING btree ("form_submissions_id");`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "pages_blocks_form" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "_pages_v_blocks_form" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "forms_blocks_checkbox" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "forms_blocks_email" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "forms_blocks_message" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "forms_blocks_number" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "forms_blocks_select_options" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "forms_blocks_select" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "forms_blocks_text" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "forms_blocks_textarea" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "forms_emails" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "forms" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "forms_rels" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "_forms_v_blocks_checkbox" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "_forms_v_blocks_email" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "_forms_v_blocks_message" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "_forms_v_blocks_number" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "_forms_v_blocks_select_options" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "_forms_v_blocks_select" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "_forms_v_blocks_text" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "_forms_v_blocks_textarea" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "_forms_v_version_emails" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "_forms_v" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "_forms_v_rels" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "form_submissions_submission_data" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "form_submissions" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "form_submissions_rels" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "_form_submissions_v_version_submission_data" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "_form_submissions_v" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "_form_submissions_v_rels" DISABLE ROW LEVEL SECURITY;
  DROP TABLE "pages_blocks_form" CASCADE;
  DROP TABLE "_pages_v_blocks_form" CASCADE;
  DROP TABLE "forms_blocks_checkbox" CASCADE;
  DROP TABLE "forms_blocks_email" CASCADE;
  DROP TABLE "forms_blocks_message" CASCADE;
  DROP TABLE "forms_blocks_number" CASCADE;
  DROP TABLE "forms_blocks_select_options" CASCADE;
  DROP TABLE "forms_blocks_select" CASCADE;
  DROP TABLE "forms_blocks_text" CASCADE;
  DROP TABLE "forms_blocks_textarea" CASCADE;
  DROP TABLE "forms_emails" CASCADE;
  DROP TABLE "forms" CASCADE;
  DROP TABLE "forms_rels" CASCADE;
  DROP TABLE "_forms_v_blocks_checkbox" CASCADE;
  DROP TABLE "_forms_v_blocks_email" CASCADE;
  DROP TABLE "_forms_v_blocks_message" CASCADE;
  DROP TABLE "_forms_v_blocks_number" CASCADE;
  DROP TABLE "_forms_v_blocks_select_options" CASCADE;
  DROP TABLE "_forms_v_blocks_select" CASCADE;
  DROP TABLE "_forms_v_blocks_text" CASCADE;
  DROP TABLE "_forms_v_blocks_textarea" CASCADE;
  DROP TABLE "_forms_v_version_emails" CASCADE;
  DROP TABLE "_forms_v" CASCADE;
  DROP TABLE "_forms_v_rels" CASCADE;
  DROP TABLE "form_submissions_submission_data" CASCADE;
  DROP TABLE "form_submissions" CASCADE;
  DROP TABLE "form_submissions_rels" CASCADE;
  DROP TABLE "_form_submissions_v_version_submission_data" CASCADE;
  DROP TABLE "_form_submissions_v" CASCADE;
  DROP TABLE "_form_submissions_v_rels" CASCADE;
  ALTER TABLE "payload_locked_documents_rels" DROP CONSTRAINT "payload_locked_documents_rels_forms_fk";
  
  ALTER TABLE "payload_locked_documents_rels" DROP CONSTRAINT "payload_locked_documents_rels_form_submissions_fk";
  
  DROP INDEX "payload_locked_documents_rels_forms_id_idx";
  DROP INDEX "payload_locked_documents_rels_form_submissions_id_idx";
  ALTER TABLE "payload_locked_documents_rels" DROP COLUMN "forms_id";
  ALTER TABLE "payload_locked_documents_rels" DROP COLUMN "form_submissions_id";
  DROP TYPE "enum_pages_blocks_form_skin";
  DROP TYPE "enum_pages_blocks_form_width";
  DROP TYPE "enum_pages_blocks_form_padding_top";
  DROP TYPE "enum_pages_blocks_form_padding_bottom";
  DROP TYPE "enum__pages_v_blocks_form_skin";
  DROP TYPE "enum__pages_v_blocks_form_width";
  DROP TYPE "enum__pages_v_blocks_form_padding_top";
  DROP TYPE "enum__pages_v_blocks_form_padding_bottom";
  DROP TYPE "enum_forms_confirmation_type";
  DROP TYPE "enum_forms_redirect_type";
  DROP TYPE "enum__forms_v_version_confirmation_type";
  DROP TYPE "enum__forms_v_version_redirect_type";`)
}
