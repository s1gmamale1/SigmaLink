# 11 — NSIS welcome page (SmartScreen workaround docs)

**Severity**: P3 polish
**Effort**: S (~2-4hr)
**Cluster**: Windows / OpenCode / installer
**Suggested delegate**: Kimi via OpenCode
**Depends on**: nothing (pairs naturally with #01 which is Windows-targeted)

## Context

BACKLOG lines 366-371 — replace `nsis.license` line in `electron-builder.yml` with a custom NSIS welcome-page wrapper that shows the Mark-of-the-Web/SmartScreen workaround inline during installation. Currently the installer ships `README — First launch.txt` as an NSIS prelude file (per README.md line 49), which is fine but minimal.

The custom welcome page gives the user a friendlier first impression and reduces support load — same SmartScreen workaround docs the README has, but shown at install time.

## Strategy

`electron-builder` NSIS supports custom UI via `nsis.include` (a `.nsh` script).

Add `app/build/installer.nsh` with:
- Welcome page header: "Installing SigmaLink — please read"
- Two-paragraph SmartScreen / Mark-of-the-Web explanation
- Two workaround buttons rendered as labels: "Option A: More info → Run anyway" and "Option B: Right-click EXE → Properties → Unblock"
- Reference URL to the README for the full procedure

Then in `electron-builder.yml`:
```yaml
nsis:
  oneClick: false
  include: build/installer.nsh
  # remove: license: build/license.txt (or whatever's there)
```

## File:line targets

| File | Operation |
|---|---|
| `app/build/installer.nsh` (NEW) | NSIS welcome page script |
| `app/electron-builder.yml` | Wire `nsis.include`; remove `nsis.license` |
| `app/build/sigma-banner.bmp` (NEW, optional) | 164×314 px BMP for NSIS welcome banner |

## Verification

- `pnpm electron:pack:win` (or `pnpm electron:build` on Win) — build NSIS installer
- Run installer in Windows VM; confirm welcome page shows SmartScreen text
- Confirm install proceeds to completion
- Confirm uninstall path unchanged

## Reusable utilities

- electron-builder NSIS docs: https://www.electron.build/configuration/nsis
- README section "Windows: first launch" already has the SmartScreen workaround copy — reuse text verbatim

## Risks

- R-11-1: NSIS scripts are picky about quoting. Test in actual Win build, not just by inspecting the script.
- R-11-2: Custom NSIS UI sometimes interferes with electron-updater install. Verify auto-update path post-install (existing user upgrading to v1.4.2 should not see this welcome page).

## Pairs with

- #01 (Sigma Assistant Windows spawn) — both Windows-targeted, ship in same release window
