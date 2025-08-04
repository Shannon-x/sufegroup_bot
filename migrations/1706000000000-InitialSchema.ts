import { MigrationInterface, QueryRunner } from "typeorm";

export class InitialSchema1706000000000 implements MigrationInterface {
    name = 'InitialSchema1706000000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        // Create users table
        await queryRunner.query(`
            CREATE TABLE "users" (
                "id" bigint NOT NULL,
                "username" character varying(255),
                "firstName" character varying(255) NOT NULL,
                "lastName" character varying(255),
                "isBot" boolean NOT NULL DEFAULT false,
                "languageCode" character varying(10),
                "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
                "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
                CONSTRAINT "PK_users" PRIMARY KEY ("id")
            )
        `);

        // Create groups table
        await queryRunner.query(`
            CREATE TABLE "groups" (
                "id" bigint NOT NULL,
                "title" character varying(255) NOT NULL,
                "username" character varying(255),
                "type" character varying(50) NOT NULL,
                "isActive" boolean NOT NULL DEFAULT true,
                "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
                "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
                CONSTRAINT "PK_groups" PRIMARY KEY ("id")
            )
        `);

        // Create group_settings table
        await queryRunner.query(`
            CREATE TYPE "public"."group_settings_autoaction_enum" AS ENUM('mute', 'kick')
        `);
        await queryRunner.query(`
            CREATE TABLE "group_settings" (
                "id" SERIAL NOT NULL,
                "groupId" bigint NOT NULL,
                "verificationEnabled" boolean NOT NULL DEFAULT true,
                "ttlMinutes" integer NOT NULL DEFAULT 10,
                "autoAction" "public"."group_settings_autoaction_enum" NOT NULL DEFAULT 'mute',
                "welcomeTemplate" text NOT NULL DEFAULT '欢迎加入 {group_name}！请点击下方按钮完成验证。',
                "deleteJoinMessage" boolean NOT NULL DEFAULT true,
                "deleteWelcomeMessage" boolean NOT NULL DEFAULT true,
                "deleteWelcomeMessageAfter" integer NOT NULL DEFAULT 300,
                "rateLimitPerMinute" integer NOT NULL DEFAULT 10,
                "adminBypassVerification" boolean NOT NULL DEFAULT false,
                "customSettings" jsonb,
                "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
                "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
                CONSTRAINT "PK_group_settings" PRIMARY KEY ("id"),
                CONSTRAINT "UQ_group_settings_groupId" UNIQUE ("groupId"),
                CONSTRAINT "FK_group_settings_group" FOREIGN KEY ("groupId") REFERENCES "groups"("id") ON DELETE CASCADE ON UPDATE NO ACTION
            )
        `);

        // Create join_sessions table
        await queryRunner.query(`
            CREATE TYPE "public"."join_sessions_status_enum" AS ENUM('pending', 'verified', 'expired', 'failed')
        `);
        await queryRunner.query(`
            CREATE TABLE "join_sessions" (
                "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "userId" bigint NOT NULL,
                "groupId" bigint NOT NULL,
                "status" "public"."join_sessions_status_enum" NOT NULL DEFAULT 'pending',
                "messageId" integer NOT NULL,
                "expiresAt" TIMESTAMP NOT NULL,
                "verifiedAt" TIMESTAMP,
                "userIp" character varying(45),
                "userAgent" character varying(255),
                "attemptCount" integer NOT NULL DEFAULT 0,
                "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
                "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
                CONSTRAINT "PK_join_sessions" PRIMARY KEY ("id"),
                CONSTRAINT "FK_join_sessions_user" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
                CONSTRAINT "FK_join_sessions_group" FOREIGN KEY ("groupId") REFERENCES "groups"("id") ON DELETE CASCADE ON UPDATE NO ACTION
            )
        `);
        await queryRunner.query(`
            CREATE INDEX "IDX_join_sessions_group_user_status" ON "join_sessions" ("groupId", "userId", "status")
        `);
        await queryRunner.query(`
            CREATE INDEX "IDX_join_sessions_expiresAt" ON "join_sessions" ("expiresAt")
        `);

        // Create audit_logs table
        await queryRunner.query(`
            CREATE TABLE "audit_logs" (
                "id" SERIAL NOT NULL,
                "groupId" bigint NOT NULL,
                "userId" bigint,
                "performedBy" bigint,
                "action" character varying(50) NOT NULL,
                "details" text,
                "metadata" jsonb,
                "ip" character varying(45),
                "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
                CONSTRAINT "PK_audit_logs" PRIMARY KEY ("id"),
                CONSTRAINT "FK_audit_logs_user" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION,
                CONSTRAINT "FK_audit_logs_group" FOREIGN KEY ("groupId") REFERENCES "groups"("id") ON DELETE CASCADE ON UPDATE NO ACTION
            )
        `);
        await queryRunner.query(`
            CREATE INDEX "IDX_audit_logs_group_created" ON "audit_logs" ("groupId", "createdAt")
        `);
        await queryRunner.query(`
            CREATE INDEX "IDX_audit_logs_user_created" ON "audit_logs" ("userId", "createdAt")
        `);
        await queryRunner.query(`
            CREATE INDEX "IDX_audit_logs_action_created" ON "audit_logs" ("action", "createdAt")
        `);

        // Create whitelists table
        await queryRunner.query(`
            CREATE TABLE "whitelists" (
                "id" SERIAL NOT NULL,
                "groupId" bigint NOT NULL,
                "userId" bigint NOT NULL,
                "addedBy" bigint NOT NULL,
                "reason" text,
                "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
                CONSTRAINT "PK_whitelists" PRIMARY KEY ("id"),
                CONSTRAINT "UQ_whitelists_group_user" UNIQUE ("groupId", "userId"),
                CONSTRAINT "FK_whitelists_user" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
                CONSTRAINT "FK_whitelists_group" FOREIGN KEY ("groupId") REFERENCES "groups"("id") ON DELETE CASCADE ON UPDATE NO ACTION
            )
        `);

        // Create blacklists table
        await queryRunner.query(`
            CREATE TABLE "blacklists" (
                "id" SERIAL NOT NULL,
                "groupId" bigint NOT NULL,
                "userId" bigint NOT NULL,
                "addedBy" bigint NOT NULL,
                "reason" text,
                "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
                CONSTRAINT "PK_blacklists" PRIMARY KEY ("id"),
                CONSTRAINT "UQ_blacklists_group_user" UNIQUE ("groupId", "userId"),
                CONSTRAINT "FK_blacklists_user" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
                CONSTRAINT "FK_blacklists_group" FOREIGN KEY ("groupId") REFERENCES "groups"("id") ON DELETE CASCADE ON UPDATE NO ACTION
            )
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TABLE "blacklists"`);
        await queryRunner.query(`DROP TABLE "whitelists"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_audit_logs_action_created"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_audit_logs_user_created"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_audit_logs_group_created"`);
        await queryRunner.query(`DROP TABLE "audit_logs"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_join_sessions_expiresAt"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_join_sessions_group_user_status"`);
        await queryRunner.query(`DROP TABLE "join_sessions"`);
        await queryRunner.query(`DROP TYPE "public"."join_sessions_status_enum"`);
        await queryRunner.query(`DROP TABLE "group_settings"`);
        await queryRunner.query(`DROP TYPE "public"."group_settings_autoaction_enum"`);
        await queryRunner.query(`DROP TABLE "groups"`);
        await queryRunner.query(`DROP TABLE "users"`);
    }
}