import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-d1-sqlite'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.run(sql`ALTER TABLE \`pages\` ADD \`deleted_at\` text;`)
  await db.run(sql`CREATE INDEX \`pages_deleted_at_idx\` ON \`pages\` (\`deleted_at\`);`)
  await db.run(sql`ALTER TABLE \`_pages_v\` ADD \`version_deleted_at\` text;`)
  await db.run(sql`CREATE INDEX \`_pages_v_version_version_deleted_at_idx\` ON \`_pages_v\` (\`version_deleted_at\`);`)
  await db.run(sql`ALTER TABLE \`posts\` ADD \`deleted_at\` text;`)
  await db.run(sql`CREATE INDEX \`posts_deleted_at_idx\` ON \`posts\` (\`deleted_at\`);`)
  await db.run(sql`ALTER TABLE \`_posts_v\` ADD \`version_deleted_at\` text;`)
  await db.run(sql`CREATE INDEX \`_posts_v_version_version_deleted_at_idx\` ON \`_posts_v\` (\`version_deleted_at\`);`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.run(sql`DROP INDEX \`pages_deleted_at_idx\`;`)
  await db.run(sql`ALTER TABLE \`pages\` DROP COLUMN \`deleted_at\`;`)
  await db.run(sql`DROP INDEX \`_pages_v_version_version_deleted_at_idx\`;`)
  await db.run(sql`ALTER TABLE \`_pages_v\` DROP COLUMN \`version_deleted_at\`;`)
  await db.run(sql`DROP INDEX \`posts_deleted_at_idx\`;`)
  await db.run(sql`ALTER TABLE \`posts\` DROP COLUMN \`deleted_at\`;`)
  await db.run(sql`DROP INDEX \`_posts_v_version_version_deleted_at_idx\`;`)
  await db.run(sql`ALTER TABLE \`_posts_v\` DROP COLUMN \`version_deleted_at\`;`)
}
