/**
 * apply-migration.js
 * 
 * Applies the add_checkout_source migration manually using Prisma Client's
 * $executeRawUnsafe — works through pgbouncer/connection pooler, unlike
 * `prisma migrate dev` which needs a direct session-mode connection.
 *
 * Run: node apply-migration.js
 */

require('dotenv').config();
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

async function main() {
  console.log('Connecting to database...');

  // 1. Add the `source` column to checkouts if it doesn't already exist
  await prisma.$executeRawUnsafe(`
    ALTER TABLE checkouts
    ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'shopify';
  `);
  console.log('✅ Added `source` column to checkouts table (or already existed)');

  // 2. Create an index on the new column for fast filtering
  await prisma.$executeRawUnsafe(`
    CREATE INDEX IF NOT EXISTS checkouts_source_idx ON checkouts (source);
  `);
  console.log('✅ Index on checkouts.source ensured');

  // 3. Record the migration in Prisma's migration history table so
  //    future `prisma migrate deploy` runs don't try to re-apply it.
  //    This inserts a row matching what `migrate dev` would have created.
  await prisma.$executeRawUnsafe(`
    INSERT INTO "_prisma_migrations" (
      id,
      checksum,
      finished_at,
      migration_name,
      logs,
      rolled_back_at,
      started_at,
      applied_steps_count
    )
    VALUES (
      gen_random_uuid()::text,
      'manual',
      NOW(),
      '20260713_add_checkout_source',
      NULL,
      NULL,
      NOW(),
      1
    )
    ON CONFLICT DO NOTHING;
  `);
  console.log('✅ Migration recorded in _prisma_migrations');

  console.log('\n🎉 Migration complete: add_checkout_source');
}

main()
  .catch((err) => {
    console.error('Migration failed:', err.message);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
