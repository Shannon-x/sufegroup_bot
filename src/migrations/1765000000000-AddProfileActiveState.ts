import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds activity tracking to user_group_profiles (isActive/leftAt) so members
 * who leave/are kicked drop out of leaderboards, and cleans up ghost profiles
 * created for the anonymous-admin account (GroupAnonymousBot, id 1087968824)
 * that previously accrued XP and got announced as "Group" levelling up.
 */
export class AddProfileActiveState1765000000000 implements MigrationInterface {
  name = 'AddProfileActiveState1765000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "user_group_profiles"
      ADD COLUMN IF NOT EXISTS "isActive" boolean NOT NULL DEFAULT true
    `);
    await queryRunner.query(`
      ALTER TABLE "user_group_profiles"
      ADD COLUMN IF NOT EXISTS "leftAt" TIMESTAMP NULL
    `);

    // Partial index to keep leaderboard ORDER BY xp/coins fast for active rows.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_ugp_group_active_xp"
      ON "user_group_profiles" ("groupId", "isActive", "xp")
    `);

    // Clean up ghost profiles for the anonymous-admin bot account.
    await queryRunner.query(`
      DELETE FROM "user_group_profiles" WHERE "userId" = '1087968824'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_ugp_group_active_xp"`);
    await queryRunner.query(`ALTER TABLE "user_group_profiles" DROP COLUMN IF EXISTS "leftAt"`);
    await queryRunner.query(`ALTER TABLE "user_group_profiles" DROP COLUMN IF EXISTS "isActive"`);
  }
}
