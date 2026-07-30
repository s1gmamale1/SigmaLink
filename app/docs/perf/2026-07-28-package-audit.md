# Packaged Module Audit — 2026-07-28

## Scope

This audit identifies the modules that SigmaLink resolves from disk after
esbuild and Vite have bundled the application. It is the keep-list for the
`electron-builder.yml` pruning change; anything not proven safe to remove stays
on disk.

Evidence was collected from the installed v3.0.0 application and from fresh
local output produced by `pnpm run electron:compile` on
`perf/hardware-load-optimization`.

## Before sizes

| Surface | Size |
|---|---:|
| `/Applications/SigmaLink.app` | 380 MB |
| `Contents/Resources/app/node_modules` | 128 MB |

Largest packaged module trees:

| Module | Size |
|---|---:|
| `lucide-react` | 34 MB |
| `@sigmalink` | 21 MB |
| `drizzle-orm` | 14 MB |
| `better-sqlite3` | 12 MB |
| `@xterm` | 11 MB |
| `react-dom` | 7.1 MB |
| `zod` | 5.6 MB |
| `isomorphic-git` | 4.6 MB |
| `node-pty` | 2.8 MB |

## Bundle-resolution findings

`scripts/build-electron.cjs` uses one shared esbuild configuration for the main
process, preload, memory MCP server, Jorvis MCP host, and external-control MCP
server. Its only mandatory package externals are `better-sqlite3` and
`node-pty`; `electron` is supplied by Electron itself. The listed Drizzle
drivers are optional guards and no import or require for them appears in any
fresh bundle.

- `electron-dist/main.js` imports `better-sqlite3` and `node-pty` from disk.
- `electron-dist/mcp-memory-server.cjs` requires `better-sqlite3` from disk.
- `electron-dist/mcp-jorvis-host-server.cjs` resolves only Node built-ins. It
  does not resolve the database, Drizzle, launcher, or renderer dependencies.
- `electron-dist/mcp-sigma-control-server.cjs` likewise resolves only Node
  built-ins.
- Vite bundles renderer dependencies into `dist/assets`; renderer packages do
  not need a second on-disk copy under `node_modules`.

### Voice-whisper resolution

The fresh main bundle contains the literal dynamic candidate
`@sigmalink/voice-whisper`. `getWhisperEngine()` passes that candidate to a
runtime `createRequire`, so esbuild cannot inline the package even though it is
not in the static `external` array. The installed v3.0.0 app confirms the
package is present and contains
`bin/darwin-arm64-123/voice-whisper.node`.

`@sigmalink/voice-whisper/index.js` then calls `require('node-gyp-build')` to
locate its `.node` binary. A copy of the loader happens to be inlined elsewhere
in the main bundle, but that copy is not visible to Node resolution initiated
inside the separately loaded voice-whisper package. Both trees must therefore
remain on disk, and the voice-whisper tree must be unpacked from asar.

### Native transitive resolution

`better-sqlite3/lib/database.js` calls
`require('bindings')('better_sqlite3.node')`. `bindings` in turn requires
`file-uri-to-path`. These are runtime dependencies, not merely install-time
helpers, so both stay in the package. `prebuild-install` and `node-addon-api`
are build/install dependencies and are not required by the shipped JavaScript
paths.

`node-pty` loads its native binary directly from its own package tree and has
no additional non-built-in runtime require.

## Confirmed keep-list

Use this list verbatim in `electron-builder.yml`:

- `node_modules/better-sqlite3/**/*`
- `node_modules/bindings/**/*`
- `node_modules/file-uri-to-path/**/*`
- `node_modules/node-pty/**/*`
- `node_modules/@sigmalink/voice-whisper/**/*`
- `node_modules/node-gyp-build/**/*`

Native trees that require `asarUnpack`:

- `node_modules/better-sqlite3/**/*`
- `node_modules/node-pty/**/*`
- `node_modules/@sigmalink/voice-whisper/**/*`

## Confirmed prune-list

All other packaged `node_modules` trees are prunable. This includes the large
bundled copies of `lucide-react`, `@sigmalink/voice-core`, `drizzle-orm`, every
`@xterm` package, `react`, `react-dom`, `zod`, `isomorphic-git`, Radix, DnD,
`electron-updater`, `js-yaml`, and the unused optional Drizzle drivers.

The bundled js-yaml 3 compatibility path contains an optional dynamic
`require('esprima')`, but the call is caught when unavailable and is used only
for the JavaScript-function YAML type. SigmaLink's release manifests do not use
that type, so `esprima` does not belong in the runtime keep-list.

## Unresolved or uncertain

None among modules currently shipped by v3.0.0.

The inlined voice-core code also probes `@sigmalink/voice-mac`, but that package
is not a production dependency and is absent from the installed v3.0.0 app.
The existing fallback to renderer Web Speech is therefore unchanged by this
prune; adding native voice-mac packaging would be separate product work, not a
module removed by this change.

## After sizes

`pnpm run electron:pack:mac` completed successfully and produced both macOS
architectures.

| Surface | Before | After | Change |
|---|---:|---:|---:|
| Installed x64 `SigmaLink.app` / packaged x64 app | 380 MB | 274 MB | -106 MB (-28%) |
| Installed x64 `SigmaLink.app` / packaged arm64 app | 380 MB | 266 MB | -114 MB (-30%) |
| Packaged arm64 `app.asar` | n/a | 16 MB | n/a |
| Packaged arm64 `app.asar.unpacked` | n/a | 24 MB | n/a |

The arm64 comparison is directional rather than architecture-for-architecture:
the installed baseline is the x64-only v3.0.0 build. The new x64 package is the
direct comparison. The unpacked arm64 runtime trees are 22 MB of
`better-sqlite3`, 2.8 MB of `node-pty`, and 48 KB of
`@sigmalink/voice-whisper`; the small loader dependencies remain packed in
`app.asar`.

## Package verification

- `lipo -archs` reports `arm64` for the arm64 application's main executable.
- `codesign --verify --deep --strict` accepts the ad-hoc signed arm64 app.
- The unpacked module set is exactly `better-sqlite3`, `node-pty`, and
  `@sigmalink/voice-whisper`.
- The rebuilt `better_sqlite3.node` and active darwin-arm64 `node-pty` binaries
  are Mach-O arm64 bundles.

The local voice-whisper checkout has neither an initialized `whisper.cpp`
submodule nor a prebuilt native binary, so its install hook produced the
repository's supported JavaScript fallback. The package tree is present and
unpacked as required, but this local artifact cannot prove native whisper
loading. A release/CI builder with the prebuild must verify that surface.

## Packaged macOS smoke

The arm64 artifact was launched against the isolated
`/tmp/sigmalink-pack-smoke` profile. A second launch of the same artifact and
profile enabled a local DevTools protocol port solely to inspect the packaged
renderer without touching the operator's live profile.

- **PASS — launch:** the window reached `readyState: complete`; no diagnostic,
  database, or native-module startup error appeared.
- **PASS — database/sidebar:** a temporary plain-folder workspace was opened,
  persisted, and listed in the sidebar.
- **PASS — pane/input:** a real local pane spawned and rendered the shell round
  trip `SIGMALINK_PACK_SMOKE_OK`.
- **PASS — update request:** Settings → Check for updates reached the GitHub
  feed. The packaged RPC returned `{ ok: true, version: "3.0.0" }`, and
  electron-updater reported that 3.0.0 is already latest with no error.
- **PASS — shutdown:** the packaged main process exited with status 0 and left
  no isolated-profile helper or PTY process behind.

The Updates tab remained visually on `Checking for updates…` after the
successful same-version response. The backend returns the current version in
that case, while the renderer waits for an `update-available` broadcast that
electron-updater correctly does not emit. This is a state-handling defect, not
evidence of a pruned runtime module, and is outside the two Task 5-owned files.

Windows and Linux native resolution remains **unverified, and no CI job closes
that gap.** An earlier revision of this section claimed the two platforms "must
pass the `e2e-matrix.yml` packaging smoke before merge". There is no such
smoke. `e2e-matrix.yml` has exactly two jobs — `smoke` and `pane-reorder` — and
neither invokes `electron-builder`: both run
`pnpm run build && node scripts/build-electron.cjs` and launch the **unpacked**
tree under Playwright. Running from the unpacked tree resolves modules through
the developer `node_modules`, so it cannot exercise the `files:` keep-list, the
asar boundary, or `asarUnpack` at all — precisely the mechanisms this audit
changed.

`electron-builder` runs in exactly three places, all tag-triggered
(`on: push: tags: ['v*']`): `release-macos.yml`, `release-windows.yml`, and
`release-linux.yml`. The first Windows or Linux pack therefore only exists
*after* a release tag is pushed — there is nothing to gate on "before merge".

Packaged verification on Windows and Linux is still **owed**. It must be done
by hand from a local `electron-builder --win` / `--linux` pack, or against the
artifacts of a tagged release build, before those platforms are treated as
verified. Two build-time guardrails now fail the pack rather than letting a
broken one ship silently, but neither is a substitute for a real packaged
launch on each platform:

- `scripts/verify-packaged-deps.cjs` (`afterPack`, all platforms) throws if any
  `node_modules/<pkg>` keep-list entry is missing from the packed output.
- `scripts/adhoc-sign.cjs` (`afterSign`, macOS only) throws if the packed app
  ships no `spawn-helper` for it to restore `+x` on.
