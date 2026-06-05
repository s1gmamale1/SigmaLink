import { describe, expect, it } from 'vitest';
import { canonicalPathKey, pathKeyIsWithin } from './path-key';

describe('canonicalPathKey', () => {
  it('folds Windows drive-letter case and separators for identity comparisons', () => {
    expect(canonicalPathKey('C:/Users/Me/AppData/Roaming/SigmaLink/worktrees/ABC/pane', 'win32')).toBe(
      'c:\\users\\me\\appdata\\roaming\\sigmalink\\worktrees\\abc\\pane',
    );
    expect(canonicalPathKey('c:\\users\\me\\appdata\\roaming\\sigmalink\\worktrees\\abc\\pane', 'win32')).toBe(
      'c:\\users\\me\\appdata\\roaming\\sigmalink\\worktrees\\abc\\pane',
    );
  });
});

describe('pathKeyIsWithin', () => {
  it('treats mixed-case Windows paths under the same repo dir as contained', () => {
    expect(
      pathKeyIsWithin(
        'c:/Users/Me/AppData/Roaming/SigmaLink/worktrees/abc123def456/pane-0',
        'C:\\Users\\Me\\AppData\\Roaming\\SigmaLink\\worktrees\\ABC123DEF456',
        'win32',
      ),
    ).toBe(true);
  });

  it('does not match sibling prefixes', () => {
    expect(pathKeyIsWithin('/tmp/worktrees/abc123def4567/pane', '/tmp/worktrees/abc123def456')).toBe(false);
  });
});
