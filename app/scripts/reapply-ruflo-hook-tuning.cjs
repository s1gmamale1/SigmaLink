#!/usr/bin/env node
// Re-apply SigmaLink's Ruflo intelligence-hook tuning after `ruflo init`
// regenerates the vendored helper. Idempotent: safe to run repeatedly.
//
// What it does: rewrites the `MIN_THRESHOLD` constant in intelligence.cjs from
// the generated default (0.05) to the env-overridable 0.15 — cutting the
// pure-pageRank [INTELLIGENCE] suggestion noise (see
// docs/10-memory/ruflo-mcp-canonical-config.md).
//
// Usage: node app/scripts/reapply-ruflo-hook-tuning.cjs [path-to-intelligence.cjs ...]
// With no args, patches the repo-local copy at app/.claude/helpers/intelligence.cjs.

const fs = require('node:fs');
const path = require('node:path');

const GENERATED = '  const MIN_THRESHOLD = 0.05;\n';
const PATCHED =
  '  // v1.15.0 (SigmaLink): raised 0.05 -> 0.15 to cut pure-pageRank noise — the\n' +
  '  // 0.05-0.09 suggestions with ~zero trigram overlap that were never acted on.\n' +
  '  // Override via RUFLO_INTEL_MIN_THRESHOLD; restored after `ruflo init` re-gen by\n' +
  '  // scripts/reapply-ruflo-hook-tuning.cjs.\n' +
  '  const MIN_THRESHOLD = Number(process.env.RUFLO_INTEL_MIN_THRESHOLD) || 0.15;\n';

function patch(file) {
  if (!fs.existsSync(file)) {
    console.warn('[reapply] not found, skipping: ' + file);
    return;
  }
  const src = fs.readFileSync(file, 'utf8');
  if (src.includes('RUFLO_INTEL_MIN_THRESHOLD')) {
    console.log('[reapply] already patched: ' + file);
    return;
  }
  if (!src.includes(GENERATED)) {
    console.warn('[reapply] generated MIN_THRESHOLD line not found (format changed?): ' + file);
    return;
  }
  fs.writeFileSync(file, src.replace(GENERATED, PATCHED), 'utf8');
  console.log('[reapply] patched: ' + file);
}

const targets =
  process.argv.slice(2).length > 0
    ? process.argv.slice(2)
    : [path.join(__dirname, '..', '.claude', 'helpers', 'intelligence.cjs')];
targets.forEach(patch);
