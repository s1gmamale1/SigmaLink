// H-8 — IPC payload validation. The rpc-router's `invoke` dispatch calls
// `validateChannelInput(channel, args[0])` for every channel and forwards the
// returned value to the controller. This is the single seam where a malformed
// renderer payload is rejected (enforce mode) or merely flagged (warn mode)
// before it reaches a controller.
//
// Contract:
//   - Looks up the channel's schema via `getChannelSchema`.
//   - `'enforce'` + schema has `input`  → `schema.input.parse(input)`; returns
//     the parsed value. Throws `ZodError` on failure (the router surfaces it as
//     an `{ ok: false, error }` RPC envelope).
//   - `'warn'` + schema has `input`     → `safeParse`; on failure `console.warn`
//     once and return the ORIGINAL input untouched (soft-launch contract).
//   - No `input` on the schema (output-only entry) → pass through.
//   - No schema entry for the channel  → pass through. Unknown-channel handling
//     is a separate concern (`hasSchemaCoverage`); in `'warn'` mode we emit one
//     console.warn so the gap is visible in dev, but we never reject.
//
// `z.any()` inputs (the soft-launch `stub`) parse successfully against anything,
// so unhardened channels are unaffected even in enforce mode — only the
// concretely-tightened schemas gain rejection.
//
// Pure + dependency-light: imports only the schema registry + mode flag. No
// Electron, no native modules — safe to unit-test under plain Node/vitest.

import { getChannelSchema, VALIDATION_MODE } from './schemas';

/** Channels we've already warned about (warn-mode, missing schema) so the dev
 *  console isn't spammed once per IPC call. */
const warnedMissing = new Set<string>();

/**
 * Validate the first positional IPC arg for `channel`.
 *
 * @param channel `<namespace>.<method>` channel id.
 * @param input   The first positional argument the renderer passed.
 * @returns       In enforce mode with a concrete schema: the parsed value.
 *                Otherwise: the original `input`, unchanged.
 * @throws        `ZodError` in enforce mode when a concrete `input` schema fails.
 */
export function validateChannelInput(channel: string, input: unknown): unknown {
  const schema = getChannelSchema(channel);

  if (!schema) {
    // No registered schema for this channel. Pass through; unknown-channel
    // rejection is intentionally NOT this function's job.
    if (VALIDATION_MODE === 'warn' && !warnedMissing.has(channel)) {
      warnedMissing.add(channel);
      console.warn(`[rpc-validate] no schema entry for channel '${channel}'`);
    }
    return input;
  }

  if (!schema.input) {
    // Output-only entry (e.g. `app.tier` reads, design.shutdown). Nothing to
    // validate on the input side.
    return input;
  }

  if (VALIDATION_MODE === 'enforce') {
    // Throws ZodError on failure — the router turns it into an RPC error.
    return schema.input.parse(input);
  }

  // warn mode: never reject. safeParse + one-line warning, return original.
  const result = schema.input.safeParse(input);
  if (!result.success) {
    console.warn(
      `[rpc-validate] '${channel}' input failed validation (warn mode, not rejected): ${result.error.message}`,
    );
    return input;
  }
  return result.data;
}

/** Channels whose output already drifted from its schema (warn once). */
const warnedOutput = new Set<string>();

/**
 * ARCH-9 — validate a channel's OUTPUT (the controller's return value) against
 * its declared `output` schema. ALWAYS fail-open, in BOTH modes: the main
 * process is the trusted producer, so output validation is drift-DETECTION
 * (catch a controller whose returned shape diverged from its declared type),
 * never a reason to convert a working response into an error envelope. On a
 * mismatch we log once per channel and return the ORIGINAL output untouched.
 *
 * Channels without an `output` schema, and the `z.any()` passthroughs, are
 * no-ops here — only the concretely-typed outputs gain drift detection.
 */
export function validateChannelOutput(channel: string, output: unknown): unknown {
  const schema = getChannelSchema(channel);
  if (!schema || !schema.output) return output;
  const result = schema.output.safeParse(output);
  if (!result.success && !warnedOutput.has(channel)) {
    warnedOutput.add(channel);
    console.warn(
      `[rpc-validate] '${channel}' output drifted from its declared schema (not rejected): ${result.error.message}`,
    );
  }
  return output; // fail-open — always the original
}
