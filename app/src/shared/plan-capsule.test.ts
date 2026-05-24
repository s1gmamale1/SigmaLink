import { it, expect } from 'vitest';
import { buildCapsuleText, type PlanCapsule } from './plan-capsule';
it('renders a fenced capsule with the 4 sections', () => {
  const c: PlanCapsule = { goal:'Add login', targetFiles:['src/auth.ts'], successCriteria:['tests pass'], outOfScope:['src/billing/**'] };
  const t = buildCapsuleText(c);
  expect(t).toContain('Goal'); expect(t).toContain('Add login');
  expect(t).toContain('src/auth.ts'); expect(t).toContain('tests pass'); expect(t).toContain('src/billing/**');
});
it('omits empty sections', () => {
  expect(buildCapsuleText({ goal:'g', targetFiles:[], successCriteria:[], outOfScope:[] })).not.toContain('Target files');
});
