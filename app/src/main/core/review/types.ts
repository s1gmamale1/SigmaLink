// Review-Room domain types. These are main-process only — for cross-process
// shapes (renderer ↔ main) see `app/src/shared/types.ts` (`ReviewSession`,
// `ReviewDiff`, `ReviewConflict`, `ReviewState`). Keeping a separate file
// here mirrors the layout used by every other Phase-N feature so the backend
// never needs to depend on renderer-only fields.

import type {
  ReviewSession,
  ReviewDiff,
  ReviewConflict,
  ReviewState,
  DiffFileSummary,
} from '../../../shared/types';

export type {
  ReviewSession,
  ReviewDiff,
  ReviewConflict,
  ReviewState,
  DiffFileSummary,
};
