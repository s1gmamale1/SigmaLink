// app/src/main/core/pty/bell-scanner.ts
const ESC = '\x1b';
const BEL = '\x07';

/**
 * Counts REAL terminal bells (BEL, 0x07) in a PTY byte stream, ignoring any BEL
 * that terminates an OSC string (e.g. `ESC ] 0 ; title BEL` sets the window
 * title — that BEL is a String Terminator, not a bell). One instance per
 * session; state persists across chunks (an OSC string can split a chunk).
 */
export class BellScanner {
  private inOsc = false; // inside an `ESC ]` … string
  private prevEsc = false; // previous char was a bare ESC

  /** Feed one chunk; returns the number of real bells it contained. */
  feed(chunk: string): number {
    let bells = 0;
    for (let i = 0; i < chunk.length; i++) {
      const ch = chunk[i];
      if (this.prevEsc) {
        this.prevEsc = false;
        if (ch === ']') {
          this.inOsc = true;
          continue;
        }
        if (ch === '\\') {
          this.inOsc = false; // ST (ESC \) ends an OSC/string
          continue;
        }
        // any other ESC-x: not an OSC introducer — fall through
      }
      if (ch === ESC) {
        this.prevEsc = true;
        continue;
      }
      if (ch === BEL) {
        if (this.inOsc) this.inOsc = false; // BEL terminates the OSC string
        else bells++; // standalone BEL = real bell
        continue;
      }
    }
    return bells;
  }
}
