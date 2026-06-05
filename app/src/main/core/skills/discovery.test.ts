import { describe, it, expect } from 'vitest';
import { discoverInstalledSkills } from './discovery';

// A tiny in-memory fs fake matching the Pick<typeof fs, ...> the module injects.
function makeFs(tree: Record<string, string>) {
  const files = new Set(Object.keys(tree));
  const dirs = new Set<string>();
  for (const f of files) {
    const parts = f.split('/');
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
  }
  return {
    existsSync: (p: string) => files.has(p) || dirs.has(p),
    readFileSync: (p: string) => {
      if (!files.has(p)) throw new Error('ENOENT ' + p);
      return tree[p];
    },
    readdirSync: (p: string) =>
      [...new Set(
        [...files, ...dirs]
          .filter((x) => x.startsWith(p + '/') && x.slice(p.length + 1).indexOf('/') === -1)
          .map((x) => x.slice(p.length + 1)),
      )],
  } as const;
}

const SKILL = (name: string) => `---\nname: ${name}\ndescription: ${name} desc\n---\nbody`;

describe('discoverInstalledSkills (SMK-3)', () => {
  const HOME = '/home/u';
  it('scans ruflo through the version dir (3-level), not 2-level', () => {
    const fs = makeFs({
      [`${HOME}/.claude/plugins/installed_plugins.json`]: JSON.stringify({
        plugins: { 'ruflo-core': [{ installPath: `${HOME}/.claude/plugins/cache/ruflo/ruflo-core/0.2.0` }] },
      }),
      [`${HOME}/.claude/plugins/cache/ruflo/ruflo-core/0.2.0/skills/ruflo-doctor/SKILL.md`]: SKILL('ruflo-doctor'),
    });
    const out = discoverInstalledSkills({ homeDir: HOME, fs });
    expect(out.find((s) => s.name === 'ruflo-doctor')?.source).toBe('ruflo');
  });

  it('tags superpowers/ruflo by the un-namespaced manifest key (<name>@<marketplace>)', () => {
    const fs = makeFs({
      [`${HOME}/.claude/plugins/installed_plugins.json`]: JSON.stringify({
        plugins: {
          'superpowers@claude-plugins-official': [{ installPath: `${HOME}/.claude/plugins/cache/claude-plugins-official/superpowers/5.1.0` }],
          'ruflo-core@ruflo': [{ installPath: `${HOME}/.claude/plugins/cache/ruflo/ruflo-core/0.2.0` }],
        },
      }),
      [`${HOME}/.claude/plugins/cache/claude-plugins-official/superpowers/5.1.0/skills/brainstorming/SKILL.md`]: SKILL('brainstorming'),
      [`${HOME}/.claude/plugins/cache/ruflo/ruflo-core/0.2.0/skills/ruflo-doctor/SKILL.md`]: SKILL('ruflo-doctor'),
    });
    const out = discoverInstalledSkills({ homeDir: HOME, fs });
    expect(out.find((s) => s.name === 'brainstorming')?.source).toBe('superpowers');
    expect(out.find((s) => s.name === 'ruflo-doctor')?.source).toBe('ruflo');
  });

  it('scans codex skills and marks them with the $ prefix', () => {
    const fs = makeFs({
      [`${HOME}/.codex/skills/agent-x/SKILL.md`]: SKILL('agent-x'),
    });
    const out = discoverInstalledSkills({ homeDir: HOME, fs });
    const codex = out.find((s) => s.name === 'agent-x');
    expect(codex?.source).toBe('codex');
    expect(codex?.prefix).toBe('$');
  });

  it('scans claude user skills + gemini skills with the / prefix', () => {
    const fs = makeFs({
      [`${HOME}/.claude/skills/cl-skill/SKILL.md`]: SKILL('cl-skill'),
      [`${HOME}/.agents/skills/gm-skill/SKILL.md`]: SKILL('gm-skill'),
    });
    const out = discoverInstalledSkills({ homeDir: HOME, fs });
    expect(out.find((s) => s.name === 'cl-skill')?.prefix).toBe('/');
    expect(out.find((s) => s.name === 'gm-skill')?.source).toBe('gemini');
  });

  it('returns [] (never throws) when nothing is installed', () => {
    expect(discoverInstalledSkills({ homeDir: HOME, fs: makeFs({}) })).toEqual([]);
  });
});
