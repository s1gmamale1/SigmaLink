# v1.4.2 — Worktree Location Design Observation

Status: **DESIGN OBSERVATION** — no decision made. Captures the dogfood feedback,
the as-built behavior, and the four candidate options with tradeoffs. The
recommendation at the end is one engineer's opinion only — the call belongs to
the product owner.

## 1. Dogfood observation (v1.4.1)

User screenshots — the per-pane "Working in:" line shows worktrees living
**outside** the opened repo, under the OS-specific Electron `userData` dir:

- macOS: `/Users/aisigma/Library/Application Support/SigmaLink/worktrees/373b48ed20cd/claude-pane-0-40b5d180`
- Windows: `C:\Users\DaddysHere\AppData\Roaming\SigmaLink\worktrees\1fc5961c9528\claude-pane-0-099d48c7`

User quote:

> "I do not understand where the panes opening root worktrees, it says somewhere
> in Roaming in win and Application Support. I thought it literally creates new
> worktree within the root repo or maybe something I don understand."

The behavior is **intentional and as-designed** (Electron OS-conventional app
data storage), but the user's mental model — "git worktrees live next to my
repo" — does not match. **That mismatch is itself the bug.** Either the
location is wrong, or the location is fine but the UX surfaces no explanation
and offers no easy way to navigate there.

## 2. Confirmed current behavior

### Code chain

1. `app/src/main/rpc-router.ts:136-144` — on boot:

   ```ts
   const userData = app.getPath('userData');
   initializeDatabase(userData);
   // ...
   const worktreePool = new WorktreePool({ baseDir: path.join(userData, 'worktrees') });
   ```

2. `app/src/main/core/git/worktree.ts:29-36` — per-repo, per-branch path
   construction:

   ```ts
   poolPathForRepo(repoRoot: string): string {
     return path.join(this.opts.baseDir, repoHash(repoRoot));
   }
   pathForBranch(repoRoot: string, branch: string): string {
     const seg = sanitizeBranchSegment(branch.split('/').slice(1).join('-') || branch);
     return path.join(this.poolPathForRepo(repoRoot), seg);
   }
   ```

3. `app/src/main/core/workspaces/launcher.ts:118-127` — every pane spawn:

   ```ts
   if (wsRow.repoMode === 'git' && wsRow.repoRoot) {
     const r = await deps.worktreePool.create({
       repoRoot: wsRow.repoRoot,
       role: provider.id,
       hint: `pane-${pane.paneIndex}`,
       base: plan.baseRef,
     });
     worktreePath = r.worktreePath;
     branch = r.branch;
   }
   ```

Resolved layout (matches screenshots):

- macOS: `<userData>/worktrees/<repoHash[0:12]>/<branchSeg>/`
- Windows: `<%AppData%>/SigmaLink/worktrees/<repoHash[0:12]>/<branchSeg>/`

Electron resolves `userData` to `Application Support` on macOS and `Roaming` on
Windows — both standard OS conventions for app data.

### Where it was decided

The location was baked in at the **initial commit** `486183e` ("Initial commit:
SigmaLink Phase 1 + research/plan/critique waves"). It is not the result of a
later migration. The only architectural doc that mentions it is
`docs/01-investigation/03-architecture-notes.md:29`:

> WorktreePool ... hashes the repo root into a stable per-repo directory under
> `userData/worktrees/<sha1[0:12]>` and gives each session a per-branch
> subdirectory.

No explicit rationale was captured for *why* userData was chosen over a
repo-local path. The reasonable inferred rationale:

- Electron convention — keeps app state out of user data.
- Supports **non-git workspaces** (`repoMode === 'folder'`) without polluting
  arbitrary folders the user opens.
- Cross-platform path safety — no permission issues writing to arbitrary repo
  parents.
- The repo-hash prefix lets one userData dir hold worktrees for many repos
  without collision.

### Prior related work

- `v1.3.4` shipped a cwd-bridging fix (`docs/03-plan/WISHLIST.md:22, 49`) where
  the assumption "worktree root may differ from workspace root" was already
  embedded — that fix presumed the userData location and only fixed cwd
  identity inside the worktree.
- No prior bug-backlog or wishlist entry mentions worktree **location** as a
  concern.

## 3. Option matrix

### Option A — Keep `<userData>/worktrees/`, change nothing

- **Pro**: Zero code change. Doesn't pollute user's repo. Works uniformly for
  git repos and folder-mode workspaces. Resilient to repo permission quirks.
  Cross-platform safe.
- **Con**: Invisible to the user. Hard to `cd` to from a normal terminal.
  Violates the mental model of any user familiar with `git worktree add`.
  Backup tools may or may not include it (macOS Time Machine excludes
  `~/Library` by default? — actually it does back up Application Support, but
  users are conditioned to think otherwise).

### Option B — Move to `<repo-root>/.sigmalink/worktrees/` (gitignored)

- **Pro**: Visible. Matches user mental model. Easy to `cd`. Co-located with
  the repo it belongs to — natural for git users. Auto-cleanup on repo
  deletion.
- **Con**: Pollutes the user's repo with a hidden dir (needs explicit
  `.gitignore` write or `.git/info/exclude` write, which mutates the user's
  repo). **Breaks folder-mode workspaces** (non-git workspaces have no
  `repo-root`). Permission issues if repo is in a read-only or
  network-mounted location. Repo-hash deduplication is lost when the same
  branch is built from two clones. `git worktree add` cannot create a
  worktree inside the repo's own working tree without `--force` — must live
  outside the actual working tree but inside `.git/`, OR be a sibling
  directory.

### Option C — Configurable `worktreeBase` per-workspace or global

- **Pro**: Power-user friendly. Lets ops teams put worktrees on a fast SSD or
  a RAM disk. Migration-friendly (default to current, allow override).
- **Con**: New surface area in Settings. Need migration logic. UX
  complexity (where do existing worktrees go when the base changes? — they
  can't move without breaking active panes). Two paths in the codebase.

### Option D — Keep current location, fix discoverability in UI

- **Pro**: No data migration. Zero risk of regressing existing sessions.
  Addresses the actual user complaint ("I don't understand where they are")
  rather than the underlying location. Cheap to ship.
- **Con**: Some users will still want them co-located. Doesn't solve the
  `cd` ergonomics from an external terminal.
- **Concrete affordances**:
  - Per-pane right-click → "Reveal worktree in Finder/Explorer" (Electron
    `shell.showItemInFolder`).
  - Per-pane tooltip on the truncated cwd display showing the full absolute
    path.
  - Per-pane "Open shell here" action that opens the user's terminal pinned
    to the worktree dir.
  - First-launch info banner: "Pane worktrees live in `<userData>/worktrees`
    — click to reveal."
  - Settings → Storage panel showing total worktree disk usage with a
    "Reveal in Finder" button.

## 4. Tradeoff summary

| Option | User mental model fix | Code change | Risk | Effort |
|--------|------------------------|-------------|------|--------|
| A — status quo | None | None | None | None |
| B — repo-local | Strong | Medium-large | High (folder mode, perms, migration) | Medium |
| C — configurable | Strong (opt-in) | Large | Medium (migration logic) | Large |
| D — UX-only | Moderate (educates rather than relocates) | Small | Low | Small |

## 5. Recommendation (one engineer's opinion — flag for PO review)

**Option D first, then revisit.** The current location is defensible (Electron
convention, folder-mode safety, repo-hash dedup) and the user's frustration is
primarily *discoverability*, not the location itself. Shipping "Reveal in
Finder/Explorer" + a tooltip + a one-time info banner in v1.4.2 is small,
low-risk, and likely resolves the complaint. If post-ship dogfood still pushes
back on the location, escalate to **Option C** (configurable) so users who
prefer repo-local can opt in without forcing folder-mode users to break.

**Option B is the riskiest** — it sounds intuitive but ties us to a
git-only model and forces us to write into the user's repo. The current
codebase has folder-mode workspaces (`wsRow.repoMode === 'folder'` in
`launcher.ts:118`) that would have no analogous location.

This recommendation is intentionally conservative because the dogfood signal
is N=1 and the cost of relocating worktrees is high (active panes hold open
file handles into those paths; sessions persist worktreePath in
`agent_sessions.worktree_path` which would all need migration).

## 6. Open questions for PO

- Should v1.4.2 ship just the discoverability UX (Option D) and defer the
  location question?
- If we ever do Option C, where do existing worktrees go when the base
  changes — migrate, leave behind, or block the change while panes are
  active?
- Is there a backup/portability concern? Do users expect that copying their
  repo elsewhere also copies the agent worktrees? (Today: no, it does not.)

## 7. References

- Code: `app/src/main/rpc-router.ts:136-144`
- Code: `app/src/main/core/git/worktree.ts:1-99`
- Code: `app/src/main/core/workspaces/launcher.ts:115-127`
- Architecture note: `docs/01-investigation/03-architecture-notes.md:29`
- Prior cwd fix: `docs/03-plan/WISHLIST.md:22, 49` (v1.3.4)
- Initial commit: `486183e`
