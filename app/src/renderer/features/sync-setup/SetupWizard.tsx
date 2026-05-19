// v1.5.0 packet 09 — Setup wizard (5-step flow).
//
// Steps:
//   1. Welcome — explains what sync is, what the user needs (private git repo).
//   2. Repo URL + credentials — user enters remote URL + optional auth.
//   3. Generate mnemonic + display — key generated, phrase shown ONCE.
//   4. Typed-back mnemonic confirm (MnemonicConfirm component).
//   5. Irrecoverability acknowledgement → Done.
//
// SECURITY:
//   - Password/token are submitted directly to sync.enable() and never stored
//     in component state beyond the form fields.
//   - The mnemonic is displayed once, then discarded from component state
//     after confirmation.

import { useState, useCallback } from 'react';
import { rpc } from '@/renderer/lib/rpc';
import { MnemonicConfirm } from './MnemonicConfirm';
import { GitBranch, Key, CheckCircle2, AlertTriangle, ChevronRight } from 'lucide-react';

type Step = 'welcome' | 'repo' | 'mnemonic-display' | 'mnemonic-confirm' | 'done';

interface SetupWizardProps {
  onComplete: () => void;
  onCancel: () => void;
}

interface RepoCredentials {
  remoteUrl: string;
  username: string;
  password: string;
}

export function SetupWizard({ onComplete, onCancel }: SetupWizardProps) {
  const [step, setStep] = useState<Step>('welcome');
  const [creds, setCreds] = useState<RepoCredentials>({ remoteUrl: '', username: '', password: '' });
  const [mnemonic, setMnemonic] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleRepoSubmit = useCallback(async () => {
    if (!creds.remoteUrl.trim()) {
      setError('Repository URL is required');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      // Enable sync — the main process generates the key, stores it, and
      // returns the mnemonic via a separate exportMnemonic call.
      await rpc.sync.enable({
        remoteUrl: creds.remoteUrl.trim(),
        username: creds.username || undefined,
        password: creds.password || undefined,
      });
      const m = await rpc.sync.exportMnemonic();
      if (!m || typeof m !== 'string') {
        throw new Error('Key generation failed — try again');
      }
      setMnemonic(m);
      setStep('mnemonic-display');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [creds]);

  const handleMnemonicConfirmed = useCallback(() => {
    setStep('done');
    // Clear mnemonic from memory after confirmed.
    setMnemonic('');
  }, []);

  if (step === 'welcome') {
    return (
      <div className="space-y-6 max-w-lg">
        <StepHeader step={1} total={5} title="Welcome to sync setup" />
        <div className="space-y-3 text-sm text-muted-foreground">
          <p>
            Cross-machine sync lets you access your sessions, conversations, and memories
            on multiple devices.
          </p>
          <p>
            Your data is encrypted before leaving your device. You need a private git
            repository — GitHub, GitLab, Gitea, or any self-hosted git server works.
          </p>
          <ul className="list-disc list-inside space-y-1 text-xs">
            <li>Your git host only sees encrypted blobs — not your data.</li>
            <li>A 24-word recovery phrase protects your key.</li>
            <li>Losing the phrase and all devices means unrecoverable data.</li>
          </ul>
        </div>
        <div className="flex gap-2">
          <button type="button" className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-muted" onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            data-testid="wizard-next-welcome"
            className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90"
            onClick={() => setStep('repo')}
          >
            Get started <ChevronRight className="ml-1 inline h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    );
  }

  if (step === 'repo') {
    return (
      <div className="space-y-6 max-w-lg">
        <StepHeader step={2} total={5} title="Connect your repository" />
        <div className="space-y-4">
          <div className="space-y-1">
            <label className="text-xs font-medium" htmlFor="repo-url">
              Repository URL
            </label>
            <input
              id="repo-url"
              data-testid="repo-url-input"
              type="url"
              className="w-full rounded-md border border-border bg-background px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
              placeholder="https://github.com/you/sigma-sync.git"
              value={creds.remoteUrl}
              onChange={(e) => setCreds((p) => ({ ...p, remoteUrl: e.target.value }))}
              autoComplete="off"
            />
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium" htmlFor="git-username">
              Username (optional for HTTPS)
            </label>
            <input
              id="git-username"
              data-testid="git-username-input"
              type="text"
              className="w-full rounded-md border border-border bg-background px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
              placeholder="your-github-username"
              value={creds.username}
              onChange={(e) => setCreds((p) => ({ ...p, username: e.target.value }))}
              autoComplete="username"
            />
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium" htmlFor="git-token">
              Personal access token (optional for HTTPS)
            </label>
            <input
              id="git-token"
              data-testid="git-token-input"
              type="password"
              className="w-full rounded-md border border-border bg-background px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
              placeholder="ghp_xxxxxxxxxxxxxxxxxxxx"
              value={creds.password}
              onChange={(e) => setCreds((p) => ({ ...p, password: e.target.value }))}
              autoComplete="current-password"
            />
          </div>
          {error && (
            <div className="flex items-center gap-2 rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              <AlertTriangle className="h-4 w-4 shrink-0" />
              {error}
            </div>
          )}
        </div>
        <div className="flex gap-2">
          <button type="button" className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-muted" onClick={() => { setStep('welcome'); setError(null); }}>
            Back
          </button>
          <button
            type="button"
            data-testid="wizard-next-repo"
            className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50 disabled:pointer-events-none"
            disabled={loading || !creds.remoteUrl.trim()}
            onClick={() => void handleRepoSubmit()}
          >
            {loading ? 'Connecting…' : 'Continue'}
            {!loading && <ChevronRight className="ml-1 inline h-3.5 w-3.5" />}
          </button>
        </div>
      </div>
    );
  }

  if (step === 'mnemonic-display') {
    const words = mnemonic.split(' ');
    return (
      <div className="space-y-6 max-w-lg">
        <StepHeader step={3} total={5} title="Your recovery phrase" />
        <div className="rounded-md border border-amber-500/50 bg-amber-500/10 p-3">
          <div className="flex items-start gap-2">
            <Key className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
            <p className="text-xs font-medium">
              Write these 24 words on paper and store them somewhere safe. You will need
              them to set up sync on another device. This phrase is shown only once.
            </p>
          </div>
        </div>
        <div className="grid grid-cols-3 gap-2">
          {words.map((word, i) => (
            <div key={i} className="flex items-center gap-1.5 rounded-md bg-muted/30 px-2 py-1.5">
              <span className="text-xs text-muted-foreground w-5 text-right">{i + 1}.</span>
              <span className="text-xs font-mono font-medium">{word}</span>
            </div>
          ))}
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            data-testid="mnemonic-written-down-btn"
            className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90"
            onClick={() => setStep('mnemonic-confirm')}
          >
            I have written it down
            <ChevronRight className="ml-1 inline h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    );
  }

  if (step === 'mnemonic-confirm') {
    return (
      <div className="max-w-lg">
        <StepHeader step={4} total={5} title="Confirm your phrase" />
        <div className="mt-6">
          <MnemonicConfirm
            mnemonic={mnemonic}
            onConfirmed={handleMnemonicConfirmed}
            onBack={() => setStep('mnemonic-display')}
          />
        </div>
      </div>
    );
  }

  // Step 5: Done
  return (
    <div className="space-y-6 max-w-lg">
      <StepHeader step={5} total={5} title="Sync is enabled" />
      <div className="flex items-center gap-2 text-sm">
        <CheckCircle2 className="h-5 w-5 text-green-500 shrink-0" />
        <span>Sync is active. Your sessions and memories will sync in the background.</span>
      </div>
      <div className="rounded-md bg-muted/30 p-3 text-xs text-muted-foreground space-y-1">
        <p className="font-medium text-foreground">Remember</p>
        <p>
          Your recovery phrase is the only way to set up sync on another device.
          If you lose it and all your devices, your synced data cannot be recovered.
        </p>
      </div>
      <button
        type="button"
        data-testid="wizard-done-btn"
        className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90"
        onClick={onComplete}
      >
        <GitBranch className="mr-1.5 inline h-3.5 w-3.5" />
        Go to sync settings
      </button>
    </div>
  );
}

interface StepHeaderProps {
  step: number;
  total: number;
  title: string;
}

function StepHeader({ step, total, title }: StepHeaderProps) {
  return (
    <div className="space-y-1">
      <p className="text-xs text-muted-foreground">Step {step} of {total}</p>
      <h3 className="text-sm font-semibold">{title}</h3>
      <div className="flex gap-1 mt-2">
        {Array.from({ length: total }, (_, i) => (
          <div
            key={i}
            className={`h-1 flex-1 rounded-full ${i < step ? 'bg-primary' : 'bg-muted'}`}
          />
        ))}
      </div>
    </div>
  );
}
