import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "users_sessions" ADD COLUMN "refresh_count" numeric;
  ALTER TABLE "users_sessions" ADD COLUMN "refreshed_at" timestamp(3) with time zone;
  ALTER TABLE "media" ADD COLUMN "_stored" boolean;
  ALTER TABLE "media" ADD COLUMN "_transforms" jsonb;
  ALTER TABLE "media" ADD COLUMN "original__stored" boolean;
  ALTER TABLE "_media_v" ADD COLUMN "version__stored" boolean;
  ALTER TABLE "_media_v" ADD COLUMN "version__transforms" jsonb;
  ALTER TABLE "_media_v" ADD COLUMN "version_original__stored" boolean;`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "users_sessions" DROP COLUMN "refresh_count";
  ALTER TABLE "users_sessions" DROP COLUMN "refreshed_at";
  ALTER TABLE "media" DROP COLUMN "_stored";
  ALTER TABLE "media" DROP COLUMN "_transforms";
  ALTER TABLE "media" DROP COLUMN "original__stored";
  ALTER TABLE "_media_v" DROP COLUMN "version__stored";
  ALTER TABLE "_media_v" DROP COLUMN "version__transforms";
  ALTER TABLE "_media_v" DROP COLUMN "version_original__stored";`)
}
