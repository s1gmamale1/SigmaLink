// P3-S1 — guards against the "0002 was forgotten" bug. Reads the migrations
// directory and the source of `migrate.ts`, then asserts every `0NNN_*.ts`
// migration is registered in `ALL_MIGRATIONS`.
//
// This test parses source text (not runtime imports) on purpose: importing
// `migrate.ts` would transitively load `better-sqlite3` and Electron, which
// are not safe to evaluate from a unit-test context.
//
// Framework: node:test (built into Node v26, no new dep). Run with:
//   node --experimental-strip-types --test src/main/core/db/__tests__/migrate.spec.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dbDir = path.resolve(__dirname, '..');
const migrationsDir = path.join(dbDir, 'migrations');
const migrateSrcPath = path.join(dbDir, 'migrate.ts');

test('every 0NNN_*.ts migration file is registered in ALL_MIGRATIONS', () => {
  const files = fs
    .readdirSync(migrationsDir)
    .filter((f) => /^0\d{3}_.+\.ts$/.test(f))
    .sort();

  assert.ok(files.length > 0, 'expected at least one migration file');

  const migrateSrc = fs.readFileSync(migrateSrcPath, 'utf8');

  // Extract registered migration filenames from the import statements:
  //   import * as mig0002 from './migrations/0002_credentials';
  const importRe = /from\s+['"]\.\/migrations\/(0\d{3}_[A-Za-z0-9_]+)['"]/g;
  const imported = new Set<string>();
  for (const m of migrateSrc.matchAll(importRe)) {
    imported.add(`${m[1]}.ts`);
  }

  for (const file of files) {
    assert.ok(
      imported.has(file),
      `migration "${file}" exists on disk but is not imported by migrate.ts`,
    );
  }

  // Extract the ALL_MIGRATIONS array body and confirm each imported binding
  // is referenced inside it.
  const arrayMatch = migrateSrc.match(/ALL_MIGRATIONS:\s*Migration\[\]\s*=\s*\[([\s\S]*?)\]/);
  assert.ok(arrayMatch, 'ALL_MIGRATIONS array literal not found in migrate.ts');
  const arrayBody = arrayMatch[1];

  for (const file of files) {
    const base = file.replace(/\.ts$/, '');
    const num = base.slice(0, 4);
    const binding = `mig${num}`;
    assert.ok(
      new RegExp(`\\b${binding}\\b`).test(arrayBody),
      `binding "${binding}" (for ${file}) is not in ALL_MIGRATIONS`,
    );
  }
});

test('ALL_MIGRATIONS bindings are in lexical order', () => {
  const migrateSrc = fs.readFileSync(migrateSrcPath, 'utf8');
  const arrayMatch = migrateSrc.match(/ALL_MIGRATIONS:\s*Migration\[\]\s*=\s*\[([\s\S]*?)\]/);
  assert.ok(arrayMatch);
  const bindings = [...arrayMatch[1].matchAll(/\bmig(\d{4})\b/g)].map((m) => m[1]);
  const sorted = [...bindings].sort();
  assert.deepEqual(bindings, sorted, 'ALL_MIGRATIONS must be lexically sorted');
});

test('0010_provider_effective is registered (BUG-V1.1-02-PROV)', () => {
  // Schema-drift guard: the CHANGELOG promised this column in Phase 2 but
  // the migration was never authored. If anyone deletes 0010 or forgets to
  // wire it into ALL_MIGRATIONS, this test fails loudly.
  const migrateSrc = fs.readFileSync(migrateSrcPath, 'utf8');
  assert.match(
    migrateSrc,
    /from\s+['"]\.\/migrations\/0010_provider_effective['"]/,
    'migrate.ts must import 0010_provider_effective',
  );
  const arrayMatch = migrateSrc.match(/ALL_MIGRATIONS:\s*Migration\[\]\s*=\s*\[([\s\S]*?)\]/);
  assert.ok(arrayMatch, 'ALL_MIGRATIONS array literal not found');
  assert.match(
    arrayMatch[1],
    /\bmig0010\b/,
    'mig0010 must appear in ALL_MIGRATIONS',
  );
  // The migration file itself must exist on disk and export `name`.
  const migPath = path.join(migrationsDir, '0010_provider_effective.ts');
  assert.ok(fs.existsSync(migPath), '0010_provider_effective.ts must exist');
  const migSrc = fs.readFileSync(migPath, 'utf8');
  assert.match(
    migSrc,
    /export\s+const\s+name\s*=\s*['"]0010_provider_effective['"]/,
    '0010 must export name === "0010_provider_effective"',
  );
  assert.match(
    migSrc,
    /ALTER\s+TABLE\s+agent_sessions\s+ADD\s+COLUMN\s+provider_effective\s+TEXT/i,
    '0010 must ADD COLUMN provider_effective TEXT on agent_sessions',
  );
});

test('0013_conversations_claude_session_id is registered and idempotent', () => {
  const migrateSrc = fs.readFileSync(migrateSrcPath, 'utf8');
  assert.match(
    migrateSrc,
    /from\s+['"]\.\/migrations\/0013_conversations_claude_session_id['"]/,
    'migrate.ts must import 0013_conversations_claude_session_id',
  );
  const arrayMatch = migrateSrc.match(/ALL_MIGRATIONS:\s*Migration\[\]\s*=\s*\[([\s\S]*?)\]/);
  assert.ok(arrayMatch, 'ALL_MIGRATIONS array literal not found');
  assert.match(
    arrayMatch[1],
    /\bmig0013\b/,
    'mig0013 must appear in ALL_MIGRATIONS',
  );

  const migPath = path.join(migrationsDir, '0013_conversations_claude_session_id.ts');
  assert.ok(fs.existsSync(migPath), '0013_conversations_claude_session_id.ts must exist');
  const migSrc = fs.readFileSync(migPath, 'utf8');
  assert.match(
    migSrc,
    /export\s+const\s+name\s*=\s*['"]0013_conversations_claude_session_id['"]/,
    '0013 must export name === "0013_conversations_claude_session_id"',
  );
  assert.match(
    migSrc,
    /hasColumn\(db,\s*['"]conversations['"],\s*['"]claude_session_id['"]\)/,
    '0013 must guard ADD COLUMN with a conversations.claude_session_id check',
  );
  assert.match(
    migSrc,
    /ALTER\s+TABLE\s+conversations\s+ADD\s+COLUMN\s+claude_session_id\s+TEXT/i,
    '0013 must ADD COLUMN claude_session_id TEXT on conversations',
  );
});

test('every migration file exports `name` (not `id`)', () => {
  const files = fs
    .readdirSync(migrationsDir)
    .filter((f) => /^0\d{3}_.+\.ts$/.test(f));

  for (const f of files) {
    const src = fs.readFileSync(path.join(migrationsDir, f), 'utf8');
    assert.match(
      src,
      /export\s+const\s+name\s*=/,
      `${f}: must export \`name\` (the runner reads m.name)`,
    );
    assert.doesNotMatch(
      src,
      /export\s+const\s+id\s*=/,
      `${f}: must not export \`id\` — rename to \`name\``,
    );
  }
});
