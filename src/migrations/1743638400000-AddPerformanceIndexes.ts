import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddPerformanceIndexes1743638400000 implements MigrationInterface {
  name = 'AddPerformanceIndexes1743638400000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Composite index for audit_logs queries: getVerificationStats, getUserJoinCount
    // Covers WHERE groupId = ? AND action = ? AND createdAt >= ?
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_audit_logs_group_action_created"
      ON "audit_logs" ("groupId", "action", "createdAt")
    `);

    // Index for lotteries: getActiveLotteries, processExpiredLotteries
    // Covers WHERE groupId = ? AND status = ? and WHERE status = ? AND endsAt < ?
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_lotteries_group_status"
      ON "lotteries" ("groupId", "status")
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_lotteries_status_endsAt"
      ON "lotteries" ("status", "endsAt")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_audit_logs_group_action_created"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_lotteries_group_status"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_lotteries_status_endsAt"`);
  }
}
