import { MigrationInterface, QueryRunner } from "typeorm";

export class AddProfileAndLottery1741400000000 implements MigrationInterface {
    name = 'AddProfileAndLottery1741400000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            CREATE TABLE "user_group_profiles" (
                "id" SERIAL NOT NULL,
                "userId" bigint NOT NULL,
                "groupId" bigint NOT NULL,
                "xp" integer NOT NULL DEFAULT 0,
                "level" integer NOT NULL DEFAULT 1,
                "totalMessages" integer NOT NULL DEFAULT 0,
                "coins" integer NOT NULL DEFAULT 0,
                "checkinStreak" integer NOT NULL DEFAULT 0,
                "lastCheckinDate" character varying(20),
                "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
                "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
                CONSTRAINT "UQ_user_group_profiles" UNIQUE ("userId", "groupId"),
                CONSTRAINT "PK_user_group_profiles" PRIMARY KEY ("id")
            )
        `);
        await queryRunner.query(`
            CREATE INDEX "IDX_ugp_group_xp" ON "user_group_profiles" ("groupId", "xp")
        `);

        await queryRunner.query(`
            CREATE TABLE "lotteries" (
                "id" SERIAL NOT NULL,
                "groupId" bigint NOT NULL,
                "createdBy" bigint NOT NULL,
                "prize" character varying(500) NOT NULL,
                "winnerCount" integer NOT NULL DEFAULT 1,
                "minLevel" integer NOT NULL DEFAULT 0,
                "costCoins" integer NOT NULL DEFAULT 0,
                "participants" jsonb NOT NULL DEFAULT '[]',
                "winners" jsonb,
                "status" character varying(20) NOT NULL DEFAULT 'active',
                "endsAt" TIMESTAMP NOT NULL,
                "messageId" integer,
                "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
                CONSTRAINT "PK_lotteries" PRIMARY KEY ("id")
            )
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TABLE "lotteries"`);
        await queryRunner.query(`DROP INDEX "IDX_ugp_group_xp"`);
        await queryRunner.query(`DROP TABLE "user_group_profiles"`);
    }
}
