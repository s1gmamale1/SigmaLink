// V3-W12-016 / V3-W12-018 — Drizzle Kit config.
//
// We hand-roll forward-only TypeScript migrations under
// `src/main/core/db/migrations/` (see `migrate.ts`). Drizzle Kit is wired up so
// `drizzle-kit studio` and future codegen runs find the schema; we do NOT run
// `drizzle-kit generate` for shipped migrations during W12 — the hand-rolled
// migration is the one that boots.

import type { Config } from 'drizzle-kit';

export default {
  schema: './src/main/core/db/schema.ts',
  out: './src/main/core/db/migrations',
  dialect: 'sqlite',
} satisfies Config;
