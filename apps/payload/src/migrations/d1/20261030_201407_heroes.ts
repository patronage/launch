import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-d1-sqlite'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.run(sql`CREATE TABLE \`pages_hero_links\` (
  	\`_order\` integer NOT NULL,
  	\`_parent_id\` integer NOT NULL,
  	\`id\` text PRIMARY KEY NOT NULL,
  	\`link_type\` text DEFAULT 'reference',
  	\`link_new_tab\` integer,
  	\`link_label\` text,
  	\`link_variant\` text DEFAULT 'primary',
  	\`link_url\` text,
  	FOREIGN KEY (\`_parent_id\`) REFERENCES \`pages\`(\`id\`) ON UPDATE no action ON DELETE cascade
  );
  `)
  await db.run(sql`CREATE INDEX \`pages_hero_links_order_idx\` ON \`pages_hero_links\` (\`_order\`);`)
  await db.run(sql`CREATE INDEX \`pages_hero_links_parent_id_idx\` ON \`pages_hero_links\` (\`_parent_id\`);`)
  await db.run(sql`CREATE TABLE \`_pages_v_version_hero_links\` (
  	\`_order\` integer NOT NULL,
  	\`_parent_id\` integer NOT NULL,
  	\`id\` integer PRIMARY KEY NOT NULL,
  	\`link_type\` text DEFAULT 'reference',
  	\`link_new_tab\` integer,
  	\`link_label\` text,
  	\`link_variant\` text DEFAULT 'primary',
  	\`link_url\` text,
  	\`_uuid\` text,
  	FOREIGN KEY (\`_parent_id\`) REFERENCES \`_pages_v\`(\`id\`) ON UPDATE no action ON DELETE cascade
  );
  `)
  await db.run(sql`CREATE INDEX \`_pages_v_version_hero_links_order_idx\` ON \`_pages_v_version_hero_links\` (\`_order\`);`)
  await db.run(sql`CREATE INDEX \`_pages_v_version_hero_links_parent_id_idx\` ON \`_pages_v_version_hero_links\` (\`_parent_id\`);`)
  // Columns are added and the image column renamed in place, rather than
  // rebuilding the tables as the generator does: the rebuild selected the new
  // columns from the old table, and dropping `pages` cascades to its blocks.
  await db.run(sql`ALTER TABLE \`pages\` ADD \`hero_variant\` text;`)
  await db.run(sql`ALTER TABLE \`pages\` ADD \`hero_title\` text;`)
  await db.run(sql`ALTER TABLE \`pages\` ADD \`hero_eyebrow\` text;`)
  await db.run(sql`ALTER TABLE \`pages\` ADD \`hero_skin\` text DEFAULT 'light';`)
  await db.run(sql`ALTER TABLE \`pages\` ADD \`hero_align\` text DEFAULT 'start';`)
  await db.run(sql`ALTER TABLE \`pages\` ADD \`hero_subhead\` text;`)
  await db.run(sql`ALTER TABLE \`pages\` ADD \`hero_body\` text;`)
  await db.run(sql`ALTER TABLE \`pages\` RENAME COLUMN \`hero_id\` TO \`hero_image_id\`;`)
  await db.run(sql`DROP INDEX \`pages_hero_idx\`;`)
  await db.run(sql`CREATE INDEX \`pages_hero_hero_image_idx\` ON \`pages\` (\`hero_image_id\`);`)
  await db.run(sql`ALTER TABLE \`_pages_v\` ADD \`version_hero_variant\` text;`)
  await db.run(sql`ALTER TABLE \`_pages_v\` ADD \`version_hero_title\` text;`)
  await db.run(sql`ALTER TABLE \`_pages_v\` ADD \`version_hero_eyebrow\` text;`)
  await db.run(sql`ALTER TABLE \`_pages_v\` ADD \`version_hero_skin\` text DEFAULT 'light';`)
  await db.run(sql`ALTER TABLE \`_pages_v\` ADD \`version_hero_align\` text DEFAULT 'start';`)
  await db.run(sql`ALTER TABLE \`_pages_v\` ADD \`version_hero_subhead\` text;`)
  await db.run(sql`ALTER TABLE \`_pages_v\` ADD \`version_hero_body\` text;`)
  await db.run(sql`ALTER TABLE \`_pages_v\` RENAME COLUMN \`version_hero_id\` TO \`version_hero_image_id\`;`)
  await db.run(sql`DROP INDEX \`_pages_v_version_version_hero_idx\`;`)
  await db.run(sql`CREATE INDEX \`_pages_v_version_hero_version_hero_image_idx\` ON \`_pages_v\` (\`version_hero_image_id\`);`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.run(sql`DROP TABLE \`pages_hero_links\`;`)
  await db.run(sql`DROP TABLE \`_pages_v_version_hero_links\`;`)
  await db.run(sql`DROP INDEX \`pages_hero_hero_image_idx\`;`)
  await db.run(sql`ALTER TABLE \`pages\` RENAME COLUMN \`hero_image_id\` TO \`hero_id\`;`)
  await db.run(sql`CREATE INDEX \`pages_hero_idx\` ON \`pages\` (\`hero_id\`);`)
  await db.run(sql`ALTER TABLE \`pages\` DROP COLUMN \`hero_variant\`;`)
  await db.run(sql`ALTER TABLE \`pages\` DROP COLUMN \`hero_title\`;`)
  await db.run(sql`ALTER TABLE \`pages\` DROP COLUMN \`hero_eyebrow\`;`)
  await db.run(sql`ALTER TABLE \`pages\` DROP COLUMN \`hero_skin\`;`)
  await db.run(sql`ALTER TABLE \`pages\` DROP COLUMN \`hero_align\`;`)
  await db.run(sql`ALTER TABLE \`pages\` DROP COLUMN \`hero_subhead\`;`)
  await db.run(sql`ALTER TABLE \`pages\` DROP COLUMN \`hero_body\`;`)
  await db.run(sql`DROP INDEX \`_pages_v_version_hero_version_hero_image_idx\`;`)
  await db.run(sql`ALTER TABLE \`_pages_v\` RENAME COLUMN \`version_hero_image_id\` TO \`version_hero_id\`;`)
  await db.run(sql`CREATE INDEX \`_pages_v_version_version_hero_idx\` ON \`_pages_v\` (\`version_hero_id\`);`)
  await db.run(sql`ALTER TABLE \`_pages_v\` DROP COLUMN \`version_hero_variant\`;`)
  await db.run(sql`ALTER TABLE \`_pages_v\` DROP COLUMN \`version_hero_title\`;`)
  await db.run(sql`ALTER TABLE \`_pages_v\` DROP COLUMN \`version_hero_eyebrow\`;`)
  await db.run(sql`ALTER TABLE \`_pages_v\` DROP COLUMN \`version_hero_skin\`;`)
  await db.run(sql`ALTER TABLE \`_pages_v\` DROP COLUMN \`version_hero_align\`;`)
  await db.run(sql`ALTER TABLE \`_pages_v\` DROP COLUMN \`version_hero_subhead\`;`)
  await db.run(sql`ALTER TABLE \`_pages_v\` DROP COLUMN \`version_hero_body\`;`)
}
