import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Splits the expired-session terminal state into a claim (`removal_pending`)
 * and a confirmed outcome (`removed`), and records whether the Telegram
 * restriction call actually succeeded.
 *
 * Without this the scheduler could only say "this session is over" — it had no
 * way to distinguish "user was removed" from "the kick failed and nobody will
 * ever retry", which is what let unverified accounts stay in groups.
 */
export class HardenJoinSessionStateMachine1770000000000 implements MigrationInterface {
  name = 'HardenJoinSessionStateMachine1770000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Databases created before InitialSchema was corrected may still carry a
    // uuid_generate_v4() default that only resolves if uuid-ossp happens to be
    // installed. Normalise them onto pgcrypto so inserts can't fail at runtime.
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "pgcrypto"`);
    await queryRunner.query(`
      ALTER TABLE "join_sessions" ALTER COLUMN "id" SET DEFAULT gen_random_uuid()
    `);

    // Postgres enums can only gain values via ALTER TYPE, and ADD VALUE cannot
    // run inside a transaction block on PG < 12. IF NOT EXISTS keeps this
    // idempotent for environments where a partial run already added one.
    const enumType = await queryRunner.query(`
      SELECT t.typname
      FROM pg_type t
      JOIN pg_enum e ON e.enumtypid = t.oid
      JOIN pg_attribute a ON a.atttypid = t.oid
      JOIN pg_class c ON c.oid = a.attrelid
      WHERE c.relname = 'join_sessions' AND a.attname = 'status'
      LIMIT 1
    `);

    if (enumType && enumType.length > 0) {
      const typeName = enumType[0].typname;
      await queryRunner.query(`ALTER TYPE "${typeName}" ADD VALUE IF NOT EXISTS 'removal_pending'`);
      await queryRunner.query(`ALTER TYPE "${typeName}" ADD VALUE IF NOT EXISTS 'removed'`);
    }

    await queryRunner.query(`
      ALTER TABLE "join_sessions"
      ADD COLUMN IF NOT EXISTS "removalAttempts" integer NOT NULL DEFAULT 0
    `);
    await queryRunner.query(`
      ALTER TABLE "join_sessions"
      ADD COLUMN IF NOT EXISTS "lastError" character varying(500)
    `);
    await queryRunner.query(`
      ALTER TABLE "join_sessions"
      ADD COLUMN IF NOT EXISTS "restrictionApplied" boolean NOT NULL DEFAULT false
    `);

    // Existing rows predate the flag. They were created under the old code path
    // that assumed restriction success, so backfill the assumption rather than
    // marking historical sessions as unrestricted.
    await queryRunner.query(`
      UPDATE "join_sessions"
      SET "restrictionApplied" = true
      WHERE "status" IN ('verified', 'expired', 'cancelled')
    `);

    // The scheduler claims work with a conditional UPDATE filtered on status and
    // expiresAt; this index keeps that claim cheap as the table grows.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_join_sessions_status_expires"
      ON "join_sessions" ("status", "expiresAt")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_join_sessions_status_expires"`);
    await queryRunner.query(`ALTER TABLE "join_sessions" DROP COLUMN IF EXISTS "restrictionApplied"`);
    await queryRunner.query(`ALTER TABLE "join_sessions" DROP COLUMN IF EXISTS "lastError"`);
    await queryRunner.query(`ALTER TABLE "join_sessions" DROP COLUMN IF EXISTS "removalAttempts"`);

    // Enum values are intentionally left in place: Postgres cannot drop a value
    // from an enum type, and rows may still reference them.
  }
}
