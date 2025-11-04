# Database Auto-Migration Fix

## Problem
Previously, when deploying the bot with Docker, the database migrations were not automatically executed, leading to an empty database and bot failure with errors like:
```
QueryFailedError: relation "join_sessions" does not exist
```

## Solution
The following fixes have been applied:

### 1. Automatic Migration on Startup
Modified `src/main.ts` to automatically run database migrations when the application starts:
```typescript
// Run migrations automatically on startup
logger.info('Running database migrations...');
try {
  await AppDataSource.runMigrations();
  logger.info('Database migrations completed successfully');
} catch (migrationError) {
  logger.error('Migration error', migrationError);
  logger.warn('Continuing with startup despite migration error');
}
```

### 2. Fixed Dockerfile
- Removed the obsolete `migrations` folder reference
- All migrations are now in `src/migrations/` and will be compiled to `dist/migrations/`

### 3. Migration Files Consolidated
- All migration files moved to `src/migrations/`:
  - `1706000000000-InitialSchema.ts` - Creates all database tables
  - `1753828452228-UpdateDefaultWelcomeTemplate.ts` - Updates welcome message template

### 4. Fixed Enum Type
Updated the `join_sessions_status_enum` to include all possible statuses:
- `pending`
- `verified`
- `expired`
- `failed`
- `cancelled`

## How It Works Now

1. **First Deployment (Empty Database)**:
   - Container starts
   - Application connects to database
   - Automatically runs all pending migrations
   - Creates all required tables
   - Bot starts successfully

2. **Subsequent Deployments**:
   - Container starts
   - Application connects to database
   - Checks for pending migrations
   - Only runs new migrations if any
   - Bot starts successfully

## Manual Migration (Optional)

If you need to run migrations manually:

```bash
# Inside the container
docker exec telegram-group-bot npm run migration:run

# Or using docker compose
docker compose exec bot npm run migration:run
```

## Verification

After deployment, verify that all tables exist:

```bash
docker exec 1Panel-postgresql-GKlm psql -U telegram_group_bot -d telegram_group_bot -c "\dt"
```

Expected output:
```
                  List of relations
 Schema |      Name      | Type  |       Owner
--------+----------------+-------+--------------------
 public | audit_logs     | table | telegram_group_bot
 public | blacklists     | table | telegram_group_bot
 public | group_settings | table | telegram_group_bot
 public | groups         | table | telegram_group_bot
 public | join_sessions  | table | telegram_group_bot
 public | migrations     | table | telegram_group_bot
 public | users          | table | telegram_group_bot
 public | whitelists     | table | telegram_group_bot
```

## Troubleshooting

If you still see migration errors after deployment:

1. Check the logs:
   ```bash
   docker compose logs bot --tail=50
   ```

2. Verify database connection in `.env`:
   ```
   DB_HOST=1Panel-postgresql-GKlm
   DB_PORT=5432
   DB_USERNAME=telegram_group_bot
   DB_PASSWORD=<your-password>
   DB_DATABASE=telegram_group_bot
   ```

3. Manually check migration status:
   ```bash
   docker exec 1Panel-postgresql-GKlm psql -U telegram_group_bot -d telegram_group_bot -c "SELECT * FROM migrations;"
   ```

## Clean Database Reset (Use with Caution)

If you need to completely reset the database:

```bash
# Drop all tables
docker exec 1Panel-postgresql-GKlm psql -U telegram_group_bot -d telegram_group_bot -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;"

# Restart the bot container (migrations will run automatically)
docker compose restart bot
```

**Warning**: This will delete all data including user records, verification sessions, and audit logs!
