// Release-asset selection for the auto-updater.
//
// Deliberately free of any `electron` import so it is unit-testable under the
// plain `node` vitest environment (vitest.config.ts includes electron/**).
//
// Why this module exists: `latest-mac.yml` lists BOTH architectures, and
// electron-builder writes the x64 assets first. The previous inline
// `info.files.find(f => f.url.endsWith('.dmg'))` therefore returned the x64
// DMG on every Mac, silently moving Apple Silicon users onto a
// Rosetta-translated build. Because `process.arch` reports 'x64' inside a
// translated process, that state was self-sealing — every subsequent update
// re-selected x64.

export type MacArch = 'arm64' | 'x64';

export interface ReleaseFile {
  url: string;
}

/** electron-builder names the arm64 artefact `<name>-arm64.<ext>` and leaves
 *  the x64 artefact unsuffixed. */
function isArm64Asset(file: ReleaseFile, ext: string): boolean {
  return file.url.endsWith(`-arm64${ext}`);
}

/**
 * The architecture the machine can actually run natively.
 *
 * `processArch` alone is not enough: an x64 build translated by Rosetta on an
 * Apple Silicon Mac reports 'x64'. `runningUnderARM64Translation` (Electron's
 * `app.runningUnderARM64Translation`) is what distinguishes a real Intel Mac
 * from a translated process on Apple Silicon.
 */
export function resolveMacArch(input: {
  processArch: string;
  runningUnderARM64Translation: boolean;
}): MacArch {
  if (input.processArch === 'arm64') return 'arm64';
  return input.runningUnderARM64Translation ? 'arm64' : 'x64';
}

/**
 * Select the `.dmg` matching `arch`.
 *
 * The fallback is intentionally ASYMMETRIC:
 *   • arm64 host → prefer arm64, but accept x64. Apple Silicon can execute the
 *     x64 build under Rosetta, so an older release that only shipped x64 stays
 *     updatable rather than dead-ending.
 *   • x64 host → arm64 ONLY, never. An Intel Mac cannot execute an arm64
 *     binary; handing it one would produce an unlaunchable install.
 */
export function pickMacDmg(files: readonly ReleaseFile[], arch: MacArch): ReleaseFile | null {
  const dmgs = files.filter((f) => f.url.endsWith('.dmg'));
  if (dmgs.length === 0) return null;
  if (arch === 'arm64') {
    return dmgs.find((f) => isArm64Asset(f, '.dmg')) ?? dmgs.find((f) => !isArm64Asset(f, '.dmg')) ?? null;
  }
  return dmgs.find((f) => !isArm64Asset(f, '.dmg')) ?? null;
}

/**
 * Select the `.AppImage` matching `arch`. Only x64 AppImages are published
 * today (electron-builder.yml `linux.target`), so this is currently a
 * no-op guard — but it removes the same latent first-match bug the mac path
 * had, ahead of any future arm64 Linux artefact.
 */
export function pickLinuxAppImage(files: readonly ReleaseFile[], arch: string): ReleaseFile | null {
  const images = files.filter((f) => f.url.endsWith('.AppImage'));
  if (images.length === 0) return null;
  if (arch === 'arm64') {
    return (
      images.find((f) => isArm64Asset(f, '.AppImage')) ??
      images.find((f) => !isArm64Asset(f, '.AppImage')) ??
      null
    );
  }
  return images.find((f) => !isArm64Asset(f, '.AppImage')) ?? null;
}
