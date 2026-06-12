// DOM terminal presenter P2 — pure SGR (1006) mouse report encoding + the
// per-tracking-mode report policy. The DOM presenter owns what the attached
// xterm's CoreMouseService did invisibly. X10/UTF8 legacy ENCODINGS are not
// supported (we only report when DECSET 1006 is active — modern TUIs all
// request it); the x10 tracking MODE is honored (press-only).

export type MouseReportKind = 'press' | 'release' | 'motion';
export type MouseTrackingMode = 'none' | 'x10' | 'vt200' | 'drag' | 'any';

export interface MouseMods {
  shift: boolean;
  alt: boolean;
  ctrl: boolean;
}

/** SGR: ESC [ < code ; col ; row M|m — code = button + mods + motion bit;
 *  release uses final 'm' (the button id is preserved, unlike legacy X10). */
export function encodeSgrMouse(
  kind: MouseReportKind,
  button: number,
  col: number,
  row: number,
  mods: MouseMods,
): string {
  let code = button;
  if (mods.shift) code += 4;
  if (mods.alt) code += 8;
  if (mods.ctrl) code += 16;
  if (kind === 'motion') code += 32;
  return `\x1b[<${code};${col};${row}${kind === 'release' ? 'm' : 'M'}`;
}

export function shouldReportMouse(
  mode: MouseTrackingMode,
  kind: MouseReportKind,
  buttonHeld: boolean,
): boolean {
  switch (mode) {
    case 'none':
      return false;
    case 'x10':
      return kind === 'press';
    case 'vt200':
      return kind !== 'motion';
    case 'drag':
      return kind !== 'motion' || buttonHeld;
    case 'any':
      return true;
  }
}
