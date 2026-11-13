import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-d1-sqlite'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.run(sql`ALTER TABLE \`users_sessions\` ADD \`refresh_count\` numeric;`)
  await db.run(sql`ALTER TABLE \`users_sessions\` ADD \`refreshed_at\` text;`)
  await db.run(sql`ALTER TABLE \`media\` ADD \`_stored\` integer;`)
  await db.run(sql`ALTER TABLE \`media\` ADD \`_transforms\` text;`)
  await db.run(sql`ALTER TABLE \`media\` ADD \`original__stored\` integer;`)
  await db.run(sql`ALTER TABLE \`_media_v\` ADD \`version__stored\` integer;`)
  await db.run(sql`ALTER TABLE \`_media_v\` ADD \`version__transforms\` text;`)
  await db.run(sql`ALTER TABLE \`_media_v\` ADD \`version_original__stored\` integer;`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.run(sql`ALTER TABLE \`users_sessions\` DROP COLUMN \`refresh_count\`;`)
  await db.run(sql`ALTER TABLE \`users_sessions\` DROP COLUMN \`refreshed_at\`;`)
  await db.run(sql`ALTER TABLE \`media\` DROP COLUMN \`_stored\`;`)
  await db.run(sql`ALTER TABLE \`media\` DROP COLUMN \`_transforms\`;`)
  await db.run(sql`ALTER TABLE \`media\` DROP COLUMN \`original__stored\`;`)
  await db.run(sql`ALTER TABLE \`_media_v\` DROP COLUMN \`version__stored\`;`)
  await db.run(sql`ALTER TABLE \`_media_v\` DROP COLUMN \`version__transforms\`;`)
  await db.run(sql`ALTER TABLE \`_media_v\` DROP COLUMN \`version_original__stored\`;`)
}
