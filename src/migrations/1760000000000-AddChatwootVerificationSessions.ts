import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddChatwootVerificationSessions1760000000000 implements MigrationInterface {
  name = 'AddChatwootVerificationSessions1760000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "pgcrypto"`);

    await queryRunner.query(`
      CREATE TABLE "chatwoot_verification_sessions" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "inboxId" character varying(128) NOT NULL,
        "userId" bigint NOT NULL,
        "username" character varying(255),
        "firstName" character varying(255),
        "lastName" character varying(255),
        "status" character varying(20) NOT NULL DEFAULT 'pending',
        "expiresAt" TIMESTAMP NOT NULL,
        "verifiedAt" TIMESTAMP,
        "verifiedUntil" TIMESTAMP,
        "lastPromptAt" TIMESTAMP,
        "userIp" character varying(45),
        "userAgent" character varying(255),
        "attemptCount" integer NOT NULL DEFAULT 0,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_chatwoot_verification_sessions" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(`
      CREATE INDEX "IDX_cw_verify_inbox_user_status"
      ON "chatwoot_verification_sessions" ("inboxId", "userId", "status")
    `);

    await queryRunner.query(`
      CREATE INDEX "IDX_cw_verify_inbox_user_verified_until"
      ON "chatwoot_verification_sessions" ("inboxId", "userId", "verifiedUntil")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_cw_verify_inbox_user_verified_until"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_cw_verify_inbox_user_status"`);
    await queryRunner.query(`DROP TABLE "chatwoot_verification_sessions"`);
  }
}
