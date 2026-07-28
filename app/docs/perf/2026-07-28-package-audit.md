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
