# 08 — state.tsx LOC split (553 → <500)

**Severity**: P3 hygiene
**Effort**: S (~3hr)
**Cluster**: State / routing
**Suggested delegate**: Sonnet
**Depends on**: nothing

## Context

`app/src/renderer/app/state.tsx` is 553 LOC, over the project's 500-LOC budget. v1.1.8 partial ship-claim said "v1.1.9 closes the gap" (BACKLOG line 437) — it didn't. v1.4.2 closes it.

This is a pure file-organization refactor. NO behavior change.

## Strategy

Reducer logic is already extracted to `state.reducer.ts` (separate file). What remains in `state.tsx` is the Provider component, hooks (`useAppState`, `useDispatch`, etc.), and assorted helpers.

Split:
- Keep in `state.tsx`: Provider component + module-level `Context` + `useAppState`/`useDispatch` hooks (~250 LOC target)
- Extract to NEW `app/src/renderer/app/state.selectors.ts`: pure selector functions (`selectActiveWorkspace`, `selectRoom`, etc.) — usually ~100-150 LOC
- Extract to NEW `app/src/renderer/app/state.persistence.ts`: localStorage hydrate/persist helpers — usually ~50-100 LOC

## Step-by-step

1. `wc -l app/src/renderer/app/state.tsx` — confirm 553.
2. Identify selector blocks (any function taking `AppState` and returning a derived value).
3. `git mv` them into `state.selectors.ts`; add `import { selectFoo } from './state.selectors'` re-exports in `state.tsx` for backward compatibility.
4. Identify persistence blocks (localStorage / sessionStorage I/O).
5. Extract to `state.persistence.ts`; same re-export pattern.
6. Update import paths in consumers if direct imports referenced them.
7. Verify `wc -l app/src/renderer/app/state.tsx` < 500.

## File:line targets

| File | Operation |
|---|---|
| `app/src/renderer/app/state.tsx` | Trim to <500 LOC; keep Provider + Context + hooks |
| `app/src/renderer/app/state.selectors.ts` | NEW — pure selector functions |
| `app/src/renderer/app/state.persistence.ts` | NEW — localStorage / sessionStorage I/O |
| All consumers grep'd via `git grep -l 'selectActive\|selectRoom\|selectWorkspaces'` | Update imports OR rely on re-export |

## Verification

```bash
cd /Users/aisigma/projects/SigmaLink/app
wc -l src/renderer/app/state.tsx        # must be <500
pnpm exec tsc -b --pretty false         # clean
pnpm exec vitest run                     # 368 baseline + 0 (refactor only)
pnpm exec eslint .                       # 0 errors
pnpm run build                            # clean
```

## Reusable utilities

None — pure refactor.

## Risks

- R-08-1: Hidden circular imports if selectors import back into state.tsx. Use type-only imports if needed.
- R-08-2: Hot-reload breakage if Vite's HMR boundaries shift. Spot-check `electron:dev` after.

## Closes ship-claims

- v1.1.8 "state.tsx > 500 LOC" partial (BACKLOG line 437)
- WISHLIST line 67

## Doc source

New file — no prior doc.
