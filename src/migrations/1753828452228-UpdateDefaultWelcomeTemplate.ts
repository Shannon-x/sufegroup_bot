import { MigrationInterface, QueryRunner } from "typeorm";

export class UpdateDefaultWelcomeTemplate1753828452228 implements MigrationInterface {

    public async up(queryRunner: QueryRunner): Promise<void> {
        // Update the default welcome template in the entity definition
        await queryRunner.query(`
            ALTER TABLE "group_settings" 
            ALTER COLUMN "welcomeTemplate" 
            SET DEFAULT '新成员【{user_name}】 你好！
小菲欢迎您加入{group_name}群
您当前需要完成验证才能解除限制，验证有效时间不超过{ttl} 秒。
过期会被踢出或封禁，请尽快。'
        `);

        // Update existing records that have the old default template
        await queryRunner.query(`
            UPDATE "group_settings" 
            SET "welcomeTemplate" = '新成员【{user_name}】 你好！
小菲欢迎您加入{group_name}群
您当前需要完成验证才能解除限制，验证有效时间不超过{ttl} 秒。
过期会被踢出或封禁，请尽快。'
            WHERE "welcomeTemplate" = '欢迎加入 {group_name}！请点击下方按钮完成验证。'
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        // Revert to the old default template
        await queryRunner.query(`
            ALTER TABLE "group_settings" 
            ALTER COLUMN "welcomeTemplate" 
            SET DEFAULT '欢迎加入 {group_name}！请点击下方按钮完成验证。'
        `);

        // Revert updated records back to old template
        await queryRunner.query(`
            UPDATE "group_settings" 
            SET "welcomeTemplate" = '欢迎加入 {group_name}！请点击下方按钮完成验证。'
            WHERE "welcomeTemplate" = '新成员【{user_name}】 你好！
小菲欢迎您加入{group_name}群
您当前需要完成验证才能解除限制，验证有效时间不超过{ttl} 秒。
过期会被踢出或封禁，请尽快。'
        `);
    }

}
