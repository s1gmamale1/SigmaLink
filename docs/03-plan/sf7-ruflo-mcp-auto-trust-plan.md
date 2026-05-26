# SF-7 — Ruflo MCP auto-init + auto-trust + health surfacing — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development (2 worktree-isolated lanes + a mandatory security-review pass — this touches **MCP trust**, a security boundary). Every lane `isolation:"worktree"` on the Agent CALL. **Gate in MAIN; e2e = FULL `tests/e2e/` dir.** pnpm. Agents NEVER push/tag/bump/release. Steps use `- [ ]` checkboxes.

**Goal:** A freshly-cloned repo opened as a SigmaLink workspace gets Ruflo MCP connected **end-to-end** — the bundled `ruflo` server is pre-approved per provider (no manual `/mcp` accept), daemon health is visible in each pane's header, and a silent stdio-fallback now surfaces. Default-ON when Ruflo is wired, opt-out, fail-open.

**Architecture:** Three additive pieces on top of existing infra. (1) A new per-provider **auto-trust** strategy module mirroring the existing `mcp-autowrite` strategy table — it pre-approves **only the `ruflo` server by name** (claude `enabledMcpjsonServers:["ruflo"]` in `.claude/settings.local.json`; cursor best-effort `cursor-agent mcp enable ruflo`; codex/gemini/kimi/opencode are verified no-ops because their config-load == trust). (2) A **pane-header health dot** reusing the existing `ruflo.daemonStatus` RPC. (3) A **stdio-fallback notification** when the HTTP daemon can't spawn. Gated on a new `ruflo.autoTrustMcp` KV (default `'1'`), independent of `ruflo.autowriteMcp`.

**Tech Stack:** Electron 30 main (node fs, child_process) · better-sqlite3 KV · React/Radix (Settings toggle + pane dot) · vitest + Playwright. **No new npm deps.**

---

## Verified facts (exploration 2026-05-26)
| Area | Reality (file:line) |
|---|---|
| Auto-init entry | `workspaces/factory.ts:99` — `if (autowrite?.value !== '0')` spawns the per-ws HTTP daemon (`rufloHttpDaemonSupervisor.spawn`) then `writeWorkspaceMcpConfig`. Already DEFAULT-ON. |
| Daemon spawn fallback | `factory.ts:104-117` — `spawn()` returning `null` (binary missing / port collide) silently falls through to stdio MCP entries; only a `console.warn`. THIS is the "no status" gap. |
| Autowrite paths | `mcp-autowrite.ts:125-134` — claude `<root>/.mcp.json`; codex `~/.codex/config.toml`; gemini `~/.gemini/settings.json`; kimi `~/.kimi/mcp.json`; opencode `~/.config/opencode/opencode.json`; cursor `<root>/.cursor/mcp.json`. Server name = `ruflo`. |
| Autowrite KV | `mcp-autowrite.ts:5` `KV_RUFLO_AUTOWRITE_MCP = 'ruflo.autowriteMcp'`. Managed-entry guard `isManagedRufloEntry` (command==='npx'). |
| Daemon health | `http-daemon-supervisor.ts` — `DaemonStatus='starting'|'running'|'crashed'|'down'`, `status(id)`, `statusDetail(id)`, store→search health probe, `restarted` event. |
| Health RPC | `ruflo.daemonStatus(workspaceId?)` → `DaemonStatusRow[]` `{workspaceId, status, port?, connections?}` (`controller.ts:245`). Already filterable by workspaceId. Consumed by `RufloSettings.tsx:174`. |
| Trust pattern in repo | `runClaudeCliTurn.args.ts:82` launches claude with `--mcp-config <path> --strict-mcp-config` (bypasses prompt) — but REPLACES the whole MCP set, so NOT usable for operator panes. |
| Pane header | `PaneHeader.tsx` — single h-7 strip, already has a `[status dot]` + provider label + Radix tooltip (branch/dir/model). Takes an `AgentSession`. The Ruflo dot slots beside the existing status dot. |
| claude trust mechanism | `.claude/settings.local.json` → `{"enabledMcpjsonServers":["ruflo"]}` pre-approves ONLY ruflo; `.local.json` is gitignored by claude convention (won't dirty the clone). |

## Cross-lane contract (FIXED — lanes own disjoint files)
- **`ensureRufloTrusted(workspaceRoot: string, opts?: { homeDir?: string; logger?; detectCli?; runCli? }): RufloTrustResult`** — Lane A. `RufloTrustResult = { claude: 'written'|'already'|'skipped'|'error'; cursor: …; codex:'noop'; gemini:'noop'; kimi:'noop'; opencode:'noop'; }`. Pure-ish: inject `homeDir`, a `runCli(cmd,args,opts)` shim (for cursor), `detectCli`. Idempotent. Fail-open (never throws).
- **KV `ruflo.autoTrustMcp`** (`'1'` default ON; `'0'` opt-out) — exported const `KV_RUFLO_AUTOTRUST_MCP` in `mcp-autowrite.ts`.
- **factory.ts seam (LEAD-owned at merge):** after `writeWorkspaceMcpConfig`, when `autotrust !== '0'` call `ensureRufloTrusted(abs, …)` (best-effort). When daemon `spawn()` returned null, fire the stdio-fallback notification (deduped per workspace). Lane A delivers both as snippets; LEAD integrates `factory.ts`.
- **`useRufloDaemonHealth(workspaceId: string): { state: 'running'|'fallback'|'down'|'starting'|'unknown'; detail: string }`** — Lane B hook. Maps `daemonStatus` row → state: row.status==='running'→`running`; 'crashed'/'down'→`down`; 'starting'→`starting`; **no row for the workspace** → `fallback` (stdio); RPC error → `unknown`.

---

## Lane A — Auto-trust module + KV + Settings toggle + stdio-fallback notif (M) · **Opus** (security-sensitive)
Owns: NEW `app/src/main/core/workspaces/mcp-trust.ts` · MOD `app/src/main/core/workspaces/mcp-autowrite.ts` (KV const only) · MOD `app/src/renderer/features/settings/RufloSettings.tsx` (toggle) · NEW `app/src/main/core/workspaces/mcp-trust.test.ts` + a notif-helper test. **Delivers factory.ts wiring as a snippet — does NOT edit factory.ts** (LEAD integrates).

### Task A1: `KV_RUFLO_AUTOTRUST_MCP` constant
**Files:** Modify `app/src/main/core/workspaces/mcp-autowrite.ts`

- [ ] **Step 1:** Below `export const KV_RUFLO_AUTOWRITE_MCP = 'ruflo.autowriteMcp';` add:
```ts
/** SF-7 — gates per-provider auto-trust of the bundled `ruflo` MCP server in
 *  new workspaces. '1' (default) = auto-trust ON; '0' = opt-out. Independent of
 *  KV_RUFLO_AUTOWRITE_MCP (trust without autowrite is meaningless, but the
 *  operator may want autowrite without auto-approval). */
export const KV_RUFLO_AUTOTRUST_MCP = 'ruflo.autoTrustMcp';
```
- [ ] **Step 2:** `npx tsc -b` — clean.
- [ ] **Step 3:** Commit `feat(ruflo): add ruflo.autoTrustMcp KV const (SF-7)`.

### Task A2: `mcp-trust.ts` — claude pre-approval (the real work)
**Files:** Create `app/src/main/core/workspaces/mcp-trust.ts`, `app/src/main/core/workspaces/mcp-trust.test.ts`

- [ ] **Step 1 — failing test** (`mcp-trust.test.ts`, vitest, temp dir):
```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureRufloTrusted } from './mcp-trust';

let root: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'sf7-')); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

const settingsPath = (r: string) => path.join(r, '.claude', 'settings.local.json');
const read = (p: string) => JSON.parse(fs.readFileSync(p, 'utf8'));

describe('ensureRufloTrusted — claude', () => {
  it('writes enabledMcpjsonServers:["ruflo"] when no settings file exists', () => {
    const res = ensureRufloTrusted(root, { homeDir: root, runCli: () => {}, detectCli: () => false });
    expect(res.claude).toBe('written');
    expect(read(settingsPath(root)).enabledMcpjsonServers).toEqual(['ruflo']);
  });
  it('is idempotent — second call reports "already", array unchanged', () => {
    ensureRufloTrusted(root, { homeDir: root, runCli: () => {}, detectCli: () => false });
    const res = ensureRufloTrusted(root, { homeDir: root, runCli: () => {}, detectCli: () => false });
    expect(res.claude).toBe('already');
    expect(read(settingsPath(root)).enabledMcpjsonServers).toEqual(['ruflo']);
  });
  it('merges additively — preserves existing servers + other keys', () => {
    fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
    fs.writeFileSync(settingsPath(root), JSON.stringify({ enabledMcpjsonServers: ['other'], theme: 'dark' }));
    const res = ensureRufloTrusted(root, { homeDir: root, runCli: () => {}, detectCli: () => false });
    expect(res.claude).toBe('written');
    const s = read(settingsPath(root));
    expect(s.enabledMcpjsonServers.sort()).toEqual(['other', 'ruflo']);
    expect(s.theme).toBe('dark');
  });
  it('fail-open — unparseable settings file is left untouched, reports "skipped"', () => {
    fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
    fs.writeFileSync(settingsPath(root), '{ not valid json');
    const res = ensureRufloTrusted(root, { homeDir: root, runCli: () => {}, detectCli: () => false });
    expect(res.claude).toBe('skipped');
    expect(fs.readFileSync(settingsPath(root), 'utf8')).toBe('{ not valid json');
  });
});
```
- [ ] **Step 2:** Run → FAIL (module missing).
- [ ] **Step 3 — implement `mcp-trust.ts`:**
```ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const RUFLO_SERVER_NAME = 'ruflo';

export type TrustOutcome = 'written' | 'already' | 'skipped' | 'error' | 'noop';
export interface RufloTrustResult {
  claude: TrustOutcome; cursor: TrustOutcome;
  codex: TrustOutcome; gemini: TrustOutcome; kimi: TrustOutcome; opencode: TrustOutcome;
}
export interface EnsureTrustOpts {
  homeDir?: string;
  logger?: Pick<Console, 'warn'>;
  /** best-effort CLI runner for cursor (inject in tests). Default: spawnSync cursor-agent. */
  runCli?: (cmd: string, args: string[], cwd: string) => void;
  /** detect a CLI on PATH (inject in tests). */
  detectCli?: (name: string) => boolean;
}

/** Pre-approve ONLY the bundled `ruflo` MCP server per provider. Never throws. */
export function ensureRufloTrusted(workspaceRoot: string, opts: EnsureTrustOpts = {}): RufloTrustResult {
  const root = path.resolve(workspaceRoot);
  const logger = opts.logger ?? console;
  return {
    claude: trustClaude(root, logger),
    cursor: trustCursor(root, opts),
    // codex/gemini/kimi/opencode: their MCP config is loaded without a per-project
    // trust prompt — writing the server config in mcp-autowrite IS the trust.
    codex: 'noop', gemini: 'noop', kimi: 'noop', opencode: 'noop',
  };
}

function trustClaude(root: string, logger: Pick<Console, 'warn'>): TrustOutcome {
  const target = path.join(root, '.claude', 'settings.local.json');
  try {
    let obj: Record<string, unknown> = {};
    if (fs.existsSync(target)) {
      try { obj = JSON.parse(fs.readFileSync(target, 'utf8')) as Record<string, unknown>; }
      catch { logger.warn(`[ruflo-trust] ${target} is not valid JSON — left untouched`); return 'skipped'; }
      if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
        logger.warn(`[ruflo-trust] ${target} is not a JSON object — left untouched`); return 'skipped';
      }
    }
    const cur = Array.isArray(obj.enabledMcpjsonServers)
      ? (obj.enabledMcpjsonServers as unknown[]).filter((x): x is string => typeof x === 'string')
      : [];
    if (cur.includes(RUFLO_SERVER_NAME)) return 'already';
    obj.enabledMcpjsonServers = [...cur, RUFLO_SERVER_NAME];
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const tmp = `${target}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(obj, null, 2)}\n`);
    fs.renameSync(tmp, target);
    return 'written';
  } catch (err) {
    logger.warn(`[ruflo-trust] claude trust failed for ${target}: ${err instanceof Error ? err.message : String(err)}`);
    return 'error';
  }
}

function trustCursor(root: string, opts: EnsureTrustOpts): TrustOutcome {
  // Cursor reads <root>/.cursor/mcp.json (written by mcp-autowrite). Whether it
  // ALSO needs `cursor-agent mcp enable <name>` to trust a project server is
  // verified empirically in Task A4; if so this best-effort call performs it.
  const detect = opts.detectCli ?? defaultDetectCli;
  if (!detect('cursor-agent')) return 'noop';
  const run = opts.runCli ?? defaultRunCli;
  try { run('cursor-agent', ['mcp', 'enable', RUFLO_SERVER_NAME], root); return 'written'; }
  catch (err) { (opts.logger ?? console).warn(`[ruflo-trust] cursor enable failed: ${err instanceof Error ? err.message : String(err)}`); return 'error'; }
}

function defaultDetectCli(name: string): boolean {
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  return dirs.some((d) => { try { return fs.existsSync(path.join(d, name)) || fs.existsSync(path.join(d, `${name}.cmd`)); } catch { return false; } });
}
function defaultRunCli(cmd: string, args: string[], cwd: string): void {
  // lazy import to keep the module fs-pure for unit tests that inject runCli
  const { spawnSync } = require('node:child_process') as typeof import('node:child_process');
  const r = spawnSync(cmd, args, { cwd, timeout: 5_000, stdio: 'ignore' });
  if (r.error) throw r.error;
}
```
- [ ] **Step 4:** Run the A2 tests → PASS.
- [ ] **Step 5:** `npx eslint app/src/main/core/workspaces/mcp-trust.ts --max-warnings 0` (use `// eslint-disable-next-line @typescript-eslint/no-require-imports` on the lazy `require` if the config flags it — match the codebase convention; if `require` is disallowed entirely, convert `defaultRunCli` to a top-level `import { spawnSync }`).
- [ ] **Step 6:** Commit `feat(ruflo): mcp-trust — pre-approve only the ruflo server per provider (SF-7)`.

### Task A3: cursor trust test + no-op provider assertions
**Files:** Modify `app/src/main/core/workspaces/mcp-trust.test.ts`
- [ ] **Step 1 — tests:**
```ts
describe('ensureRufloTrusted — cursor + no-ops', () => {
  it('cursor: runs `cursor-agent mcp enable ruflo` when detected', () => {
    const calls: { cmd: string; args: string[]; cwd: string }[] = [];
    const res = ensureRufloTrusted(root, { homeDir: root, detectCli: (n) => n === 'cursor-agent', runCli: (cmd, args, cwd) => calls.push({ cmd, args, cwd }) });
    expect(res.cursor).toBe('written');
    expect(calls).toEqual([{ cmd: 'cursor-agent', args: ['mcp', 'enable', 'ruflo'], cwd: root }]);
  });
  it('cursor: no-op when cursor-agent not on PATH', () => {
    const res = ensureRufloTrusted(root, { homeDir: root, detectCli: () => false, runCli: () => { throw new Error('should not run'); } });
    expect(res.cursor).toBe('noop');
  });
  it('cursor: fail-open when enable throws', () => {
    const res = ensureRufloTrusted(root, { homeDir: root, detectCli: (n) => n === 'cursor-agent', runCli: () => { throw new Error('boom'); } });
    expect(res.cursor).toBe('error'); // never throws
  });
  it('codex/gemini/kimi/opencode are documented no-ops', () => {
    const res = ensureRufloTrusted(root, { homeDir: root, detectCli: () => false, runCli: () => {} });
    expect([res.codex, res.gemini, res.kimi, res.opencode]).toEqual(['noop', 'noop', 'noop', 'noop']);
  });
});
```
- [ ] **Step 2:** Run → PASS. **Step 3:** Commit `test(ruflo): cursor trust + no-op provider coverage (SF-7)`.

### Task A4: empirical cursor-contract check (research step — adjust A2/A3 if needed)
- [ ] **Step 1:** If `cursor-agent` is installed locally, run `cursor-agent mcp --help` + `cursor-agent mcp enable --help` to confirm the subcommand shape (`mcp enable <name>` vs `mcp add`/auto-trust). If project `.cursor/mcp.json` is auto-trusted without `enable`, change `trustCursor` to return `'noop'` and document it (delete the spawn). If the binary is absent, leave the best-effort call (it's gated on `detectCli` + fail-open) and note "contract unverified — best-effort" in the module comment.
- [ ] **Step 2:** Commit only if a change resulted: `fix(ruflo): align cursor trust with verified cursor-agent contract (SF-7)`.

### Task A5: Settings → Ruflo opt-out toggle
**Files:** Modify `app/src/renderer/features/settings/RufloSettings.tsx`
- [ ] **Step 1:** Add a toggle row "Auto-trust the bundled Ruflo MCP server in new workspaces" bound to KV `ruflo.autoTrustMcp` via the existing `rpc.kv.get/set` pattern already used in this file (read the file first; mirror an existing toggle). Default checked when the KV is unset or `'1'`. Sub-label: "Pre-approves only SigmaLink's own `ruflo` server by name — third-party MCP servers in a cloned repo still prompt."
- [ ] **Step 2:** If the file has a test, extend it (toggle renders, reflects KV, writes `'0'`/`'1'`). Else add a minimal jsdom render test.
- [ ] **Step 3:** `npx tsc -b` + eslint clean. **Step 4:** Commit `feat(settings): Ruflo auto-trust opt-out toggle (SF-7)`.

### Task A6: factory.ts wiring SNIPPET (deliver to LEAD — do NOT edit factory.ts)
- [ ] **Step 1:** In the lane report, provide the exact diff for `factory.ts` inside the `if (autowrite?.value !== '0')` block, AFTER `writeWorkspaceMcpConfig(...)`:
```ts
// SF-7 — auto-trust the bundled ruflo server (default-ON, opt-out, fail-open).
const autotrust = getRawDb().prepare('SELECT value FROM kv WHERE key = ?').get(KV_RUFLO_AUTOTRUST_MCP) as { value?: string } | undefined;
if (autotrust?.value !== '0') {
  try { ensureRufloTrusted(abs); }
  catch (err) { console.warn(`[ruflo-trust] ensureRufloTrusted threw for ${abs}: ${err instanceof Error ? err.message : String(err)}`); }
}
```
plus the stdio-fallback notification where `spawn()` returned null (see Task A7), and the imports (`ensureRufloTrusted`, `KV_RUFLO_AUTOTRUST_MCP`).

### Task A7: stdio-fallback notification helper
**Files:** Create `app/src/main/core/workspaces/ruflo-fallback-notice.ts` + test
- [ ] **Step 1 — failing test:** `maybeNotifyStdioFallback(deps, workspaceId, daemonSpawned)` — when `daemonSpawned === false` and not already notified for this workspaceId in-process, calls `deps.notifications.add({ severity: 'info', title: 'Ruflo MCP — stdio fallback', body: 'The HTTP daemon is unavailable; running in stdio mode. Install @claude-flow/cli for full features.' })` exactly once; second call for the same workspaceId is a no-op; `daemonSpawned === true` never notifies. Inject a mock `notifications` + an in-module `Set` for dedupe.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement (module-level `Set<string>` of notified workspaceIds; guard severity 'info' so it respects SF-5's now-audible info tone). **Step 4:** Run → PASS. Deliver the factory.ts call site (`maybeNotifyStdioFallback(deps, resultId, port !== undefined)`) in the lane report. **Step 5:** Commit `feat(ruflo): surface stdio-fallback as a one-time notification (SF-7)`.

## Lane B — Pane-header Ruflo health dot (S) · Sonnet
Owns: NEW `app/src/renderer/features/command-room/useRufloDaemonHealth.ts` + test · MOD `app/src/renderer/features/command-room/PaneHeader.tsx` (+ its test). Renderer-only; must NOT touch factory/mcp-trust/controller.

### Task B1: `useRufloDaemonHealth` hook
**Files:** Create `useRufloDaemonHealth.ts` + `useRufloDaemonHealth.test.ts`
- [ ] **Step 1 — failing test** (jsdom, mock `rpc.ruflo.daemonStatus`): `running` row → `{state:'running'}`; `crashed` → `down`; `starting` → `starting`; empty array (no row for ws) → `fallback`; rejected RPC → `unknown`. (renderHook + a mocked `rpc`.)
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3 — implement:** `useRufloDaemonHealth(workspaceId)` — `useEffect` polls `rpc.ruflo.daemonStatus(workspaceId)` every ~5s (and once on mount), maps the first matching row's `.status` per the contract (no row → `fallback`), stores `{state, detail}`; clears the interval on unmount; ignores results after unmount (alive flag). `detail` = human string for the tooltip (e.g. `running · port 53112` / `stdio fallback — HTTP daemon unavailable` / `crashed`).
- [ ] **Step 4:** Run → PASS. **Step 5:** Commit `feat(command-room): useRufloDaemonHealth hook (SF-7)`.

### Task B2: health dot in PaneHeader
**Files:** Modify `PaneHeader.tsx` + `PaneHeader.test.tsx`
- [ ] **Step 1:** Read `PaneHeader.tsx` fully. Confirm the pane's `workspaceId` is available (from the `AgentSession` prop or a context); if not present, thread it from the parent (`PaneShell`/pane-grid) as a prop — document the prop addition. (Do not invent a workspaceId; wire the real one.)
- [ ] **Step 2 — failing test** (`PaneHeader.test.tsx`, jsdom, mock the hook): renders a `data-testid="ruflo-health-dot"` whose class/aria reflects state — green for `running`, amber for `fallback`, red for `down`; tooltip content shows `detail`. Mock `useRufloDaemonHealth` to drive each state.
- [ ] **Step 3:** Run → FAIL.
- [ ] **Step 4 — implement:** add a small dot (reuse the existing status-dot styling idiom in this file) beside the provider label, colour-mapped (`running`→emerald, `fallback`→amber, `down`→red, `starting`→amber-pulse, `unknown`→slate). Wrap in the existing Radix `Tooltip` with `Ruflo MCP — {detail}`. Use `aria-label` for a11y (FE-4 standard).
- [ ] **Step 5:** Run → PASS. `npx tsc -b` + eslint clean. **Step 6:** Commit `feat(command-room): Ruflo health dot in pane header (SF-7)`.

---

## Security review pass (MANDATORY — after merge, before gate sign-off) · **Opus reviewer**
Dispatch a reviewer over merged `mcp-trust.ts` + the `factory.ts` integration. Checklist:
- Only `ruflo` is ever added to `enabledMcpjsonServers` — never `enableAllProjectMcpServers`, never `--dangerously-skip-permissions`, never a wildcard.
- claude settings merge is **additive** — never drops other servers or other keys; unparseable/foreign-shaped file → skipped, never clobbered.
- Fully **fail-open**: no path throws into `openWorkspace`; daemon/trust failures only `warn`.
- Default-ON gated on `ruflo.autoTrustMcp`; `'0'` disables it (verified by test).
- cursor `enable` only runs when the binary is detected; never blocks; no shell-injection (args array, no shell string).
- No secrets/tokens written or logged.
Lead folds any fixes.

## Gate (in MAIN, after merge + security review)
`npx tsc -b` · `npx eslint . --max-warnings 0` · `npx vitest run` · `npm run product:check` · **`npx playwright test tests/e2e/` (FULL dir)**. Extend `tests/e2e/ruflo-autowrite.spec.ts` (or a sibling) to assert: opening a workspace writes `<root>/.claude/settings.local.json` with `enabledMcpjsonServers` containing `"ruflo"`, and the pane header renders `ruflo-health-dot`. Confirm opt-out: with KV `ruflo.autoTrustMcp='0'`, no settings.local.json is written.

## Execution dispatch
2 lanes, ONE message, `run_in_background`, `isolation:"worktree"` — **A=Opus** (security-sensitive trust logic), **B=Sonnet** (renderer dot). Branch from current main. At merge: path-scoped `git checkout <branch> -- <lane files>`; **LEAD owns the `factory.ts` integration** (folds A's two snippets — trust call + fallback-notif call + imports). New files via `add -A`. Verify `git status` in main for unexpected leaks (the w3-tg lesson) — `diff -q` any file that shows up unexpectedly. Then security-review → FULL gate in main → ship **v1.30.0** per `sigmalink-release` on explicit operator go.

## Self-review
- **Coverage:** auto-trust per provider (A, ruflo-only) ✓ · KV gate + Settings opt-out (A) ✓ · stdio-fallback notification (A) ✓ · pane health dot reusing daemonStatus (B) ✓ · security review ✓ · e2e ✓. Matches the approved design's 3 components.
- **No cross-lane file overlap:** A=`core/workspaces/{mcp-trust,ruflo-fallback-notice}` + `mcp-autowrite.ts`(const) + `RufloSettings.tsx`; B=`command-room/{useRufloDaemonHealth,PaneHeader}`. `factory.ts` = LEAD-only seam.
- **Type consistency:** `RufloTrustResult`/`TrustOutcome` defined in A2 and used in A3/A6; `useRufloDaemonHealth` state union defined in the contract and reused in B1/B2.
- **YAGNI:** no binary auto-install; no third-party trust; no daemon-supervisor changes; codex/gemini/kimi/opencode are explicit no-ops, not fabricated work.
- **Secure-by-default:** narrowest possible trust (single named server), additive merge, fail-open, opt-out, no shell-string exec.

## Out of scope
Auto-installing `@claude-flow/cli` · auto-trusting third-party MCP servers · webhook/remote trust · changing daemon spawn/health internals · SF-8 (Yolo/Bypass launch mode — separate plan).
