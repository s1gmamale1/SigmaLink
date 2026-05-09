// Notes tab — free-form textarea persisted on blur.

import { useEffect, useState } from 'react';
import { rpc } from '@/renderer/lib/rpc';
import type { ReviewSession } from '@/shared/types';

interface Props {
  session: ReviewSession;
}

export function NotesTab({ session }: Props) {
  const [value, setValue] = useState(session.notes);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    setValue(session.notes);
  }, [session.sessionId, session.notes]);

  const save = async () => {
    if (value === session.notes) return;
    setSaving(true);
    setErr(null);
    try {
      await rpc.review.setNotes({ sessionId: session.sessionId, notes: value });
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-border bg-muted/20 px-3 py-2 text-xs">
        <span className="text-muted-foreground">
          Notes are saved on blur. Persist across restarts.
        </span>
        {saving ? <span className="text-muted-foreground">Saving…</span> : null}
        {err ? <span className="text-red-500">{err}</span> : null}
      </div>
      <textarea
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={save}
        placeholder="Review notes, follow-ups, regressions, etc."
        className="flex-1 resize-none border-0 bg-background p-3 font-mono text-[13px] outline-none"
      />
    </div>
  );
}
