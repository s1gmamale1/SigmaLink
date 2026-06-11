// The single rule for "this wheel event is a zoom gesture". Shared by the
// xterm custom-wheel handler and the Constellation canvas guard so both agree
// on the gesture and the rule is unit-tested in one place.

export type WheelMods = Pick<WheelEvent, 'ctrlKey' | 'metaKey'>;

/** True when Ctrl (Win/Linux) or Cmd (macOS) is held during a wheel. */
export function isZoomWheel(e: WheelMods): boolean {
  return e.ctrlKey || e.metaKey;
}

/**
 * xterm's `attachCustomWheelEventHandler` contract: return `false` to suppress
 * xterm's own scrollback handling for this event (it still bubbles to the
 * window-level zoom listener), `true` to let xterm scroll normally.
 */
export function ctrlWheelShouldBubble(e: WheelMods): boolean {
  return !isZoomWheel(e);
}
