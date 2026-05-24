export interface PlanCapsule {
  goal: string;
  targetFiles: string[];
  successCriteria: string[];
  outOfScope: string[];
}

export function buildCapsuleText(capsule: PlanCapsule): string {
  const lines: string[] = ['## Plan handoff', '', `**Goal:** ${capsule.goal}`];

  if (capsule.targetFiles.length > 0) {
    lines.push('', '**Target files:**');
    for (const f of capsule.targetFiles) {
      lines.push(`- ${f}`);
    }
  }

  if (capsule.successCriteria.length > 0) {
    lines.push('', '**Success criteria:**');
    for (const c of capsule.successCriteria) {
      lines.push(`- ${c}`);
    }
  }

  if (capsule.outOfScope.length > 0) {
    lines.push('', '**Out of scope:**');
    for (const o of capsule.outOfScope) {
      lines.push(`- ${o}`);
    }
  }

  return lines.join('\n');
}
