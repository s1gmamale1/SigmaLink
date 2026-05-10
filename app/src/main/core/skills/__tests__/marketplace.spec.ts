// Phase 4 Step 5 — marketplace installer unit tests.
//
// Framework: node:test (mirrors the voice + ruflo specs in this repo).
// Run via:
//   node --import tsx --test src/main/core/skills/__tests__/marketplace.spec.ts
//
// We mock both the HTTP client and the `extractTarball` helper so the tests
// are pure and never hit the network. The "ingest" step uses a fake
// SkillsManager that records its calls, so we can verify the installer hands
// off to the real ingestion pipeline without spinning up SQLite.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  parseRepoRef,
  findRepoRoot,
  locateSkillFolder,
  installFromUrl,
  type HttpClient,
  type InstallProgressEvent,
} from '../marketplace.ts';
import type { Skill } from '../types.ts';

// ── helpers ─────────────────────────────────────────────────────────────────

function tempRoot(label: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `sigma-marketplace-${label}-`));
}

function writeSkillFolder(folder: string, frontmatter: string, body = '# body'): void {
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, 'SKILL.md'), `---\n${frontmatter}\n---\n${body}\n`);
}

interface FakeManagerCall {
  src: string;
  force: boolean;
}

function makeFakeManager(): {
  manager: {
    ingestFolder: (src: string, opts?: { force?: boolean }) => Promise<Skill>;
    list: () => { skills: Skill[]; states: Array<{ skillId: string; providerId: 'claude' | 'codex' | 'gemini'; enabled: boolean; lastFanoutAt?: number; lastError?: string }> };
  };
  calls: FakeManagerCall[];
  ingestThrows: { value: Error | null };
  installedSkill: Skill | null;
} {
  const calls: FakeManagerCall[] = [];
  const ingestThrows: { value: Error | null } = { value: null };
  let installed: Skill | null = null;
  return {
    manager: {
      async ingestFolder(src: string, opts?: { force?: boolean }) {
        calls.push({ src, force: !!opts?.force });
        if (ingestThrows.value) throw ingestThrows.value;
        // Mirror the real manager — read SKILL.md frontmatter and use
        // `name` as the id so tests can assert on the frontmatter shape
        // rather than the on-disk wrapper folder.
        const text = fs.readFileSync(path.join(src, 'SKILL.md'), 'utf8');
        const nameMatch = /^name:\s*(\S+)/m.exec(text);
        const id = nameMatch?.[1] ?? path.basename(src);
        const stat = fs.statSync(path.join(src, 'SKILL.md'));
        installed = {
          id,
          name: id,
          description: 'fake',
          contentHash: 'deadbeef',
          managedPath: src,
          installedAt: stat.mtimeMs,
        };
        return installed;
      },
      list() {
        if (!installed) return { skills: [], states: [] };
        return {
          skills: [installed],
          states: [
            { skillId: installed.id, providerId: 'claude', enabled: true },
            { skillId: installed.id, providerId: 'codex', enabled: false },
            { skillId: installed.id, providerId: 'gemini', enabled: false, lastError: 'no fanout' },
          ],
        };
      },
    },
    calls,
    ingestThrows,
    get installedSkill() {
      return installed;
    },
  } as ReturnType<typeof makeFakeManager>;
}

/** A scripted HTTP client. The tarball download step invokes a callback that
 *  populates the destination file with whatever bytes the test queues up. */
function makeFakeClient(opts: {
  defaultBranch?: string;
  metadataFails?: boolean;
  downloadFails?: boolean;
  /** Called with the downloaded destination path so the test can drop a
   *  pre-built fake tarball on disk instead of a real GitHub blob. */
  writeFakePayload?: (destPath: string) => void;
}): HttpClient & { calls: { url: string; kind: 'json' | 'download' }[] } {
  const calls: { url: string; kind: 'json' | 'download' }[] = [];
  return {
    calls,
    async getJson(url: string) {
      calls.push({ url, kind: 'json' });
      if (opts.metadataFails) throw new Error('boom');
      return { default_branch: opts.defaultBranch ?? 'main' };
    },
    async download(url, destPath, onChunk) {
      calls.push({ url, kind: 'download' });
      if (opts.downloadFails) throw new Error('download exploded');
      // Drop a tarball-shaped placeholder on disk. We emit a single fake
      // progress chunk so callers can verify the progress callback fires.
      opts.writeFakePayload?.(destPath);
      onChunk(123, 1234);
      return { bytes: 123 };
    },
  };
}

// ── parseRepoRef ────────────────────────────────────────────────────────────

test('parseRepoRef: shorthand owner/repo', () => {
  const out = parseRepoRef('anthropics/skills');
  assert.deepEqual(out, { owner: 'anthropics', repo: 'skills' });
});

test('parseRepoRef: full https URL', () => {
  const out = parseRepoRef('https://github.com/anthropics/skills');
  assert.deepEqual(out, { owner: 'anthropics', repo: 'skills' });
});

test('parseRepoRef: https URL with .git suffix', () => {
  const out = parseRepoRef('https://github.com/anthropics/skills.git');
  assert.deepEqual(out, { owner: 'anthropics', repo: 'skills' });
});

test('parseRepoRef: SSH form', () => {
  const out = parseRepoRef('git@github.com:anthropics/skills.git');
  assert.deepEqual(out, { owner: 'anthropics', repo: 'skills' });
});

test('parseRepoRef: rejects non-github hosts', () => {
  assert.equal(parseRepoRef('https://gitlab.com/foo/bar'), null);
});

test('parseRepoRef: rejects garbage input', () => {
  assert.equal(parseRepoRef(''), null);
  assert.equal(parseRepoRef('not a url'), null);
  assert.equal(parseRepoRef('owner/'), null);
  assert.equal(parseRepoRef('//owner/repo'), null);
});

// ── locateSkillFolder ──────────────────────────────────────────────────────

test('locateSkillFolder: finds SKILL.md at root', () => {
  const root = tempRoot('locate-root');
  writeSkillFolder(root, 'name: foo\ndescription: bar');
  assert.equal(locateSkillFolder(root), root);
  fs.rmSync(root, { recursive: true, force: true });
});

test('locateSkillFolder: honours subPath', () => {
  const root = tempRoot('locate-sub');
  const sub = path.join(root, 'nested', 'skill');
  writeSkillFolder(sub, 'name: nested\ndescription: bar');
  assert.equal(locateSkillFolder(root, 'nested/skill'), sub);
  assert.equal(locateSkillFolder(root, 'nope'), null);
  fs.rmSync(root, { recursive: true, force: true });
});

test('locateSkillFolder: descends into a single skills/<child>/ entry', () => {
  const root = tempRoot('locate-skills-child');
  const sub = path.join(root, 'skills', 'only-one');
  writeSkillFolder(sub, 'name: only-one\ndescription: solo');
  assert.equal(locateSkillFolder(root), sub);
  fs.rmSync(root, { recursive: true, force: true });
});

test('locateSkillFolder: refuses to guess between multiple skills/<child>/ entries', () => {
  const root = tempRoot('locate-skills-multi');
  writeSkillFolder(path.join(root, 'skills', 'a'), 'name: a\ndescription: A');
  writeSkillFolder(path.join(root, 'skills', 'b'), 'name: b\ndescription: B');
  assert.equal(locateSkillFolder(root), null);
  fs.rmSync(root, { recursive: true, force: true });
});

// ── findRepoRoot ────────────────────────────────────────────────────────────

test('findRepoRoot: descends through the GitHub tarball wrapper', () => {
  const root = tempRoot('repo-root');
  const wrapped = path.join(root, 'anthropics-skills-abc1234');
  fs.mkdirSync(wrapped, { recursive: true });
  fs.writeFileSync(path.join(wrapped, 'README.md'), '# hi');
  assert.equal(findRepoRoot(root), wrapped);
  fs.rmSync(root, { recursive: true, force: true });
});

test('findRepoRoot: returns the extract dir when no wrapper exists', () => {
  const root = tempRoot('repo-root-flat');
  fs.writeFileSync(path.join(root, 'SKILL.md'), '---\nname: x\ndescription: y\n---\n');
  assert.equal(findRepoRoot(root), root);
  fs.rmSync(root, { recursive: true, force: true });
});

// ── installFromUrl: success path ────────────────────────────────────────────

test('installFromUrl: full happy path with default branch resolution', async () => {
  const tempDir = tempRoot('install-happy');
  const fake = makeFakeManager();

  // Fake "tarball" gets unpacked by our fake `extractTarball` into a
  // wrapper directory containing SKILL.md.
  const client = makeFakeClient({ defaultBranch: 'main' });
  const result = await installFromUrl(
    {
      manager: fake.manager as never,
      tempDir,
      httpClient: client,
      extractTarball: async (_tar, dest) => {
        const wrapper = path.join(dest, 'anthropics-skills-deadbee');
        writeSkillFolder(wrapper, 'name: my-skill\ndescription: a real skill');
      },
    },
    { ownerRepo: 'anthropics/skills' },
  );
  assert.equal(result.ok, true);
  assert.equal(result.skill?.id, 'my-skill');
  assert.equal(fake.calls.length, 1);
  // The installer hands the manager the folder where it located SKILL.md.
  // For a tarball-wrapped repo with SKILL.md at the wrapper root, that's
  // the wrapper directory under the per-job staging dir. The folder itself
  // is cleaned up after the install completes, so we only check the path
  // shape — not the fs presence — at this layer.
  assert.match(fake.calls[0]!.src, /anthropics-skills-deadbee$/);
  assert.equal(fake.calls[0]!.force, false);
  // Default-branch resolution should have hit the metadata endpoint exactly once.
  assert.equal(client.calls.filter((c) => c.kind === 'json').length, 1);
  // Tarball download should have hit `tarball/main`.
  assert.ok(
    client.calls.some(
      (c) => c.kind === 'download' && c.url.includes('/tarball/main'),
    ),
  );
  // Provider fanout snapshot is forwarded back to the renderer.
  assert.equal(result.fanoutResults?.length, 3);
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('installFromUrl: explicit ref bypasses default-branch lookup', async () => {
  const tempDir = tempRoot('install-ref');
  const fake = makeFakeManager();
  const client = makeFakeClient({});
  await installFromUrl(
    {
      manager: fake.manager as never,
      tempDir,
      httpClient: client,
      extractTarball: async (_tar, dest) => {
        const wrapper = path.join(dest, 'wrapper');
        writeSkillFolder(wrapper, 'name: pinned\ndescription: pinned skill');
      },
    },
    { ownerRepo: 'foo/bar', ref: 'v1.2.3' },
  );
  assert.equal(client.calls.filter((c) => c.kind === 'json').length, 0);
  assert.ok(client.calls.some((c) => c.url.includes('/tarball/v1.2.3')));
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('installFromUrl: invalid url short-circuits before any HTTP', async () => {
  const tempDir = tempRoot('install-bad-url');
  const fake = makeFakeManager();
  const client = makeFakeClient({});
  const result = await installFromUrl(
    {
      manager: fake.manager as never,
      tempDir,
      httpClient: client,
      extractTarball: async () => {
        /* unused */
      },
    },
    { ownerRepo: '' },
  );
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, 'invalid-url');
  assert.equal(client.calls.length, 0);
  assert.equal(fake.calls.length, 0);
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('installFromUrl: missing SKILL.md surfaces a no-skill-md error', async () => {
  const tempDir = tempRoot('install-no-md');
  const fake = makeFakeManager();
  const client = makeFakeClient({ defaultBranch: 'main' });
  const result = await installFromUrl(
    {
      manager: fake.manager as never,
      tempDir,
      httpClient: client,
      extractTarball: async (_tar, dest) => {
        // Wrapper exists but contains no SKILL.md.
        const wrapper = path.join(dest, 'wrapper');
        fs.mkdirSync(wrapper, { recursive: true });
        fs.writeFileSync(path.join(wrapper, 'README.md'), 'nothing to see');
      },
    },
    { ownerRepo: 'foo/bar' },
  );
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, 'no-skill-md');
  assert.equal(fake.calls.length, 0);
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('installFromUrl: invalid frontmatter rejected before ingest', async () => {
  const tempDir = tempRoot('install-bad-fm');
  const fake = makeFakeManager();
  const client = makeFakeClient({ defaultBranch: 'main' });
  const result = await installFromUrl(
    {
      manager: fake.manager as never,
      tempDir,
      httpClient: client,
      extractTarball: async (_tar, dest) => {
        const wrapper = path.join(dest, 'wrapper');
        // Description missing → frontmatter validator must reject.
        writeSkillFolder(wrapper, 'name: bad-skill');
      },
    },
    { ownerRepo: 'foo/bar' },
  );
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, 'invalid-skill');
  assert.equal(fake.calls.length, 0);
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('installFromUrl: ingest UPDATE_REQUIRED rolls up to update-required', async () => {
  const tempDir = tempRoot('install-upd-req');
  const fake = makeFakeManager();
  fake.ingestThrows.value = new Error('UPDATE_REQUIRED:my-skill:abc123');
  const client = makeFakeClient({ defaultBranch: 'main' });
  const result = await installFromUrl(
    {
      manager: fake.manager as never,
      tempDir,
      httpClient: client,
      extractTarball: async (_tar, dest) => {
        const wrapper = path.join(dest, 'wrapper');
        writeSkillFolder(wrapper, 'name: my-skill\ndescription: needs update');
      },
    },
    { ownerRepo: 'foo/bar' },
  );
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, 'update-required');
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('installFromUrl: download failure cleans up the job dir', async () => {
  const tempDir = tempRoot('install-dl-fail');
  const fake = makeFakeManager();
  const client = makeFakeClient({ defaultBranch: 'main', downloadFails: true });
  const result = await installFromUrl(
    {
      manager: fake.manager as never,
      tempDir,
      httpClient: client,
      extractTarball: async () => {
        /* never reached */
      },
    },
    { ownerRepo: 'foo/bar' },
  );
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, 'download-failed');
  // The installer's job subdirectory should have been wiped.
  const remnants = fs
    .readdirSync(tempDir)
    .filter((n) => n.startsWith('marketplace-'));
  assert.equal(remnants.length, 0);
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('installFromUrl: emits resolve → fetch → extract → validate → ingest → fanout → done', async () => {
  const tempDir = tempRoot('install-progress');
  const fake = makeFakeManager();
  const client = makeFakeClient({ defaultBranch: 'main' });
  const phases: InstallProgressEvent['phase'][] = [];
  await installFromUrl(
    {
      manager: fake.manager as never,
      tempDir,
      httpClient: client,
      extractTarball: async (_tar, dest) => {
        const wrapper = path.join(dest, 'wrapper');
        writeSkillFolder(wrapper, 'name: stages\ndescription: emits all stages');
      },
    },
    {
      ownerRepo: 'foo/bar',
      onProgress: (evt) => {
        phases.push(evt.phase);
      },
    },
  );
  // We expect the happy-path phase chain in order. Some phases (fetch) may
  // emit twice (start + chunk), but the sequence should at least include each
  // milestone in the right relative order.
  const milestones = ['resolve', 'fetch', 'extract', 'validate', 'ingest', 'fanout', 'done'] as const;
  let cursor = 0;
  for (const phase of phases) {
    if (phase === milestones[cursor]) cursor += 1;
  }
  assert.equal(cursor, milestones.length, `phases observed: ${phases.join(', ')}`);
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('installFromUrl: metadata failure surfaces metadata-failed', async () => {
  const tempDir = tempRoot('install-meta-fail');
  const fake = makeFakeManager();
  const client = makeFakeClient({ metadataFails: true });
  const result = await installFromUrl(
    {
      manager: fake.manager as never,
      tempDir,
      httpClient: client,
      extractTarball: async () => {
        /* never reached */
      },
    },
    { ownerRepo: 'foo/bar' },
  );
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, 'metadata-failed');
  assert.equal(fake.calls.length, 0);
  fs.rmSync(tempDir, { recursive: true, force: true });
});
