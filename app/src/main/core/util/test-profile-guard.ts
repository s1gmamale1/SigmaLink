export interface TestProfileGuardInput {
  nodeEnv: string | undefined;
  isolatedMarker: string | undefined;
  argv: readonly string[];
}

export function assertIsolatedTestProfile(input: TestProfileGuardInput): void {
  if (input.nodeEnv !== 'test') return;
  if (input.isolatedMarker !== '1') {
    throw new Error(
      'Refusing Electron test boot without an explicit isolated test profile.',
    );
  }
  const hasUserDataDir = input.argv.some((arg, index) =>
    (arg.startsWith('--user-data-dir=') && arg.length > '--user-data-dir='.length)
      || (arg === '--user-data-dir' && Boolean(input.argv[index + 1])),
  );
  if (!hasUserDataDir) {
    throw new Error('Refusing Electron test boot without --user-data-dir.');
  }
}
