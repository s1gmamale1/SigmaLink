# Packet 04 — opencode-Qwen silent-fail probe

> **Effort**: XS (~1hr). **Tier**: Info. **Delegate**: Sonnet (foreground probe).
> **Blocks**: nothing. **Blocked by**: nothing.

## Problem

During v1.4.5 cluster α dispatch, a first-attempt `opencode run -m qwen/qwen3-coder-plus` invocation via a background `Bash` tool produced:
- 0-byte stdout
- No commits
- No diff
- Exit code: unknown (background dispatch)

Sonnet was used as the fallback per orchestrator skill rules. The failure mode was never investigated.

Documented in WISHLIST.md "v1.4.6+ informational" tier and `~/.claude/skills/orchestrator/SKILL.md` "Maintenance notes".

## Hypotheses

| # | Hypothesis | How to test |
|---|---|---|
| H1 | **Auth issue** — opencode CLI requires interactive auth (`opencode auth login`) on first run; the dispatch happened before auth. | Run `opencode auth status` foreground; if "not authenticated", login once and retry. |
| H2 | **stdin / TTY requirement** — opencode reads from stdin or requires a TTY (`isatty(0)`). Background bash tool has no TTY. | Try `script -q /dev/null opencode run ...` or `unbuffer opencode run ...` to allocate a pseudo-TTY. |
| H3 | **Background-bash buffering** — Claude Code's `run_in_background: true` Bash tool buffers stdout differently; output may have appeared later but the dispatch had already moved on. | Re-dispatch the SAME task foreground (no `run_in_background`) and compare. |
| H4 | **Model availability** — `qwen/qwen3-coder-plus` requires an OpenCode subscription tier the user doesn't have. | Run `opencode models` foreground; check if `qwen/qwen3-coder-plus` is listed. |

## Investigation procedure

Foreground only. Each step is ≤5 minutes.

```bash
# Step 1 — Check auth
opencode auth status 2>&1
# Expected: "Authenticated as <user>" or "Not authenticated"

# Step 2 — Check model availability
opencode models 2>&1 | grep -i "qwen3-coder-plus" || echo "MODEL NOT AVAILABLE"

# Step 3 — Foreground dispatch with a trivial task
cd /tmp && mkdir -p opencode-probe && cd opencode-probe && \
  echo "Write a single-file hello.js that prints 'hello opencode probe'" > task.txt && \
  opencode run -m qwen/qwen3-coder-plus < task.txt 2>&1 | tee /tmp/opencode-probe-foreground.log
# Expected: real output OR a real error

# Step 4 — If Step 3 worked, repeat in background with the SAME task
cd /tmp/opencode-probe && \
  (opencode run -m qwen/qwen3-coder-plus < task.txt > /tmp/opencode-probe-bg.log 2>&1 &)
sleep 30
cat /tmp/opencode-probe-bg.log

# Step 5 — If foreground worked but background failed, try TTY allocation
cd /tmp/opencode-probe && \
  script -q /dev/null sh -c 'opencode run -m qwen/qwen3-coder-plus < task.txt' \
  > /tmp/opencode-probe-tty.log 2>&1 &
sleep 30
cat /tmp/opencode-probe-tty.log
```

## Decision tree

After running the procedure:

| Outcome | Action |
|---|---|
| Auth failed | Document the auth flow + add a pre-flight check to the orchestrator skill: "before opencode-Qwen dispatch, confirm `opencode auth status` is healthy". |
| Model unavailable | Document the limitation in orchestrator skill; suggest alternatives (`qwen3-coder` without the `-plus`, or `qwen2.5-coder-32b`). |
| Foreground works, background fails (TTY) | Document: opencode-Qwen needs `script -q /dev/null` wrapper. Update orchestrator skill's "External CLI invocation patterns" section. |
| All steps work | The original failure was transient / environmental. Document as resolved; no action needed beyond a note. |

## Files to touch

- `~/.claude/skills/orchestrator/SKILL.md` — update "Maintenance notes" with the resolution
- `docs/10-memory/master_memory.md` — append a brief Phase 33 note (the probe was done; document the outcome)

NO `app/src` changes expected.

## Verification

```bash
# Final smoke after fix/documentation:
echo "Write a file called fix-test.js with a single console.log('opencode-qwen probe fixed')" | \
  opencode run -m qwen/qwen3-coder-plus 2>&1 | head -10
# Expected: real LLM-generated output
```

## Reporting back

Open a PR (or commit directly to a docs branch) titled `docs(v1.4.7): opencode-Qwen silent-fail probe — resolved (or documented)`. Include the procedure output + the resolution.

This packet is INFORMATIONAL. If the probe surfaces no fix (e.g. the issue is in upstream opencode-CLI), the documented hypothesis-and-test results are themselves the deliverable. Do NOT block the v1.4.7 tag on this packet.
