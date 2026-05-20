// v1.5.5-A — Unit tests for the extended generateBranchName signature.
//
// Three cases:
//  1. With a sessionId — suffix must equal sessionId.replace(/-/g,'').slice(0,8).
//  2. Without a sessionId — random fallback, result is still a valid branch name.
//  3. sessionId with dashes — verify dash-stripping so output is purely hex.

import { describe, it, expect } from 'vitest';
import { generateBranchName } from './git-ops';

describe('generateBranchName — v1.5.5-A sessionId parameter', () => {
  it('derives suffix from sessionId when provided', () => {
    const sessionId = 'aabbccdd-1122-4334-8556-778899aabbcc';
    const branch = generateBranchName('claude', 'pane-0', sessionId);
    // Strip dashes, take first 8 chars: 'aabbccdd'
    expect(branch).toContain('aabbccdd');
    expect(branch.startsWith('sigmalink/')).toBe(true);
  });

  it('strips dashes from sessionId so suffix is pure hex', () => {
    // All-dash-separated UUID: stripping dashes yields all hex chars.
    const sessionId = '12345678-abcd-4ef0-9876-543210fedcba';
    const branch = generateBranchName('codex', 'pane-1', sessionId);
    // First 8 hex chars after dash-stripping: '12345678'
    expect(branch).toContain('12345678');
    // Branch should NOT contain dashes in the suffix segment (only in sigmalink/ prefix).
    const suffix = branch.split('-').pop();
    expect(suffix).toMatch(/^[0-9a-f]{8}$/);
  });

  it('falls back to random UUID suffix when sessionId is not provided', () => {
    const branch1 = generateBranchName('gemini', 'pane-2');
    const branch2 = generateBranchName('gemini', 'pane-2');
    // Both are valid branch names.
    expect(branch1.startsWith('sigmalink/')).toBe(true);
    expect(branch2.startsWith('sigmalink/')).toBe(true);
    // Random fallback produces different suffixes (astronomically unlikely to collide).
    expect(branch1).not.toBe(branch2);
  });
});
