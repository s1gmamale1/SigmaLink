// v1.5.0 packet 09 — Mnemonic confirmation component.
//
// Forces the user to TYPE BACK the mnemonic (not just click through).
// This is a hard requirement from S8: the user must acknowledge that losing
// the mnemonic AND all devices means unrecoverable data.
//
// The submit button is disabled until the typed mnemonic exactly matches
// the displayed mnemonic (word-by-word comparison, case-insensitive).

import { useState } from 'react';
import { CheckCircle2, AlertTriangle } from 'lucide-react';

interface MnemonicConfirmProps {
  /** The 24-word mnemonic to confirm. */
  mnemonic: string;
  /** Called when the user has successfully typed back the mnemonic. */
  onConfirmed: () => void;
  /** Called when the user clicks "Back". */
  onBack: () => void;
}

export function MnemonicConfirm({ mnemonic, onConfirmed, onBack }: MnemonicConfirmProps) {
  const [typed, setTyped] = useState('');
  const [acknowledged, setAcknowledged] = useState(false);

  const words = mnemonic.trim().split(/\s+/);
  const typedWords = typed.trim().toLowerCase().split(/\s+/).filter(Boolean);

  // Check word-by-word match (case-insensitive).
  const isMatch =
    typedWords.length === words.length &&
    typedWords.every((w, i) => w === words[i]?.toLowerCase());

  function handleSubmit() {
    if (isMatch && acknowledged) {
      onConfirmed();
    }
  }

  const wordProgress = typedWords.filter((w, i) => w === words[i]?.toLowerCase()).length;

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-sm font-semibold">Confirm your recovery phrase</h3>
        <p className="mt-1 text-xs text-muted-foreground">
          Type all 24 words exactly as shown on the previous screen.
          This step cannot be skipped.
        </p>
      </div>

      {/* Progress indicator */}
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <div className="h-1.5 flex-1 rounded-full bg-muted overflow-hidden">
          <div
            className="h-full bg-primary transition-all duration-200"
            style={{ width: `${(wordProgress / 24) * 100}%` }}
          />
        </div>
        <span>{wordProgress}/24 words</span>
      </div>

      {/* Text area for typing the mnemonic */}
      <div className="space-y-2">
        <label className="text-xs font-medium" htmlFor="mnemonic-input">
          Type your 24-word recovery phrase
        </label>
        <textarea
          id="mnemonic-input"
          data-testid="mnemonic-input"
          className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm font-mono leading-relaxed resize-none focus:outline-none focus:ring-2 focus:ring-primary/50"
          rows={5}
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          // v1.5.1-A caveat 8: block paste so users must type the phrase manually.
          onPaste={(e) => e.preventDefault()}
          placeholder="word1 word2 word3 … (24 words, space-separated)"
          spellCheck={false}
          autoCorrect="off"
          autoCapitalize="none"
        />
        {typed.length > 0 && (
          <p
            data-testid="match-status"
            className={`text-xs ${isMatch ? 'text-green-500' : 'text-muted-foreground'}`}
          >
            {isMatch ? (
              <span className="flex items-center gap-1">
                <CheckCircle2 className="h-3 w-3" />
                Phrase matches
              </span>
            ) : (
              <span>
                {wordProgress} of 24 words correct
                {typedWords.length > wordProgress && ` — word ${wordProgress + 1} does not match`}
              </span>
            )}
          </p>
        )}
      </div>

      {/* Irrecoverability acknowledgement */}
      <div className="rounded-md border border-amber-500/50 bg-amber-500/10 p-3 space-y-2">
        <div className="flex items-start gap-2">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
          <p className="text-xs font-medium">
            If you lose this recovery phrase AND all your SigmaLink devices, your synced
            data is permanently unrecoverable. SigmaLink cannot help you recover it.
          </p>
        </div>
        <label className="flex items-start gap-2 cursor-pointer">
          <input
            data-testid="ack-checkbox"
            type="checkbox"
            className="mt-0.5 shrink-0"
            checked={acknowledged}
            onChange={(e) => setAcknowledged(e.target.checked)}
          />
          <span className="text-xs">
            I understand that my synced data is unrecoverable if I lose this phrase and
            all my devices. I have written it down or stored it securely.
          </span>
        </label>
      </div>

      <div className="flex gap-2">
        <button
          type="button"
          className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-muted"
          onClick={onBack}
        >
          Back
        </button>
        <button
          type="button"
          data-testid="confirm-btn"
          className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50 disabled:pointer-events-none"
          disabled={!isMatch || !acknowledged}
          onClick={handleSubmit}
        >
          Confirm phrase
        </button>
      </div>
    </div>
  );
}
