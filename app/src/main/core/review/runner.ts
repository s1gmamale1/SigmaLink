// Streaming test runner used by the Review Room "Tests" tab. Spawns a shell
// command inside a worktree, pipes stdout/stderr line-by-line back to the
// renderer through `review:run-output`, and persists the exit code on the
// `session_review` row when the process closes.

import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { eq } from 'drizzle-orm';
import { tokenizeShellLine } from '../git/git-ops';
import { resolveWindowsCommand } from '../pty/local-pty';
import { getDb } from '../db/client';
import { sessionReview } from '../db/schema';

export type RunOutputStream = 'stdout' | 'stderr' | 'system';

export interface RunOutputEvent {
  sessionId: string;
  runId: string;
  stream: RunOutputStream;
  data: string;
  /** Set on the final event for a run. */
  exitCode?: number | null;
  done?: boolean;
}

export type RunEmitter = (event: RunOutputEvent) => void;

interface ActiveRun {
  child: ChildProcess;
  runId: string;
  command: string;
  sessionId: string;
}

export class ReviewRunner {
  private readonly emit: RunEmitter;
  private readonly active = new Map<string, ActiveRun>(); // sessionId -> run

  constructor(emit: RunEmitter) {
    this.emit = emit;
  }

  /** Returns true if the session currently has a process running. */
  isRunning(sessionId: string): boolean {
    return this.active.has(sessionId);
  }

  /**
   * Start a command inside `cwd`, streaming stdout/stderr to the renderer.
   * If a previous run for this session is still active it's terminated first.
   * Returns the new run id immediately; the caller does not await completion.
   */
  start(input: { sessionId: string; cwd: string; command: string }): string {
    this.kill(input.sessionId);

    const tokens = tokenizeShellLine(input.command);
    if (tokens.length === 0) {
      const runId = crypto.randomUUID();
      this.emit({
        sessionId: input.sessionId,
        runId,
        stream: 'system',
        data: 'empty command\n',
        exitCode: -1,
        done: true,
      });
      return runId;
    }

    let [cmd, ...args] = tokens;
    if (process.platform === 'win32') {
      const resolved = resolveWindowsCommand(cmd) ?? cmd;
      const ext = path.extname(resolved).toLowerCase();
      if (ext === '.cmd' || ext === '.bat') {
        args = ['/d', '/s', '/c', resolved, ...args];
        cmd = 'cmd.exe';
      } else if (ext === '.ps1') {
        args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', resolved, ...args];
        cmd = 'powershell.exe';
      } else {
        cmd = resolved;
      }
    }

    const runId = crypto.randomUUID();
    const child = spawn(cmd, args, {
      cwd: input.cwd,
      env: process.env,
      shell: false,
      windowsHide: true,
    });
    this.active.set(input.sessionId, {
      child,
      runId,
      command: input.command,
      sessionId: input.sessionId,
    });

    this.emit({
      sessionId: input.sessionId,
      runId,
      stream: 'system',
      data: `$ ${input.command}\n`,
    });

    const onData = (stream: 'stdout' | 'stderr') => (chunk: Buffer) => {
      this.emit({
        sessionId: input.sessionId,
        runId,
        stream,
        data: chunk.toString('utf8'),
      });
    };
    child.stdout?.on('data', onData('stdout'));
    child.stderr?.on('data', onData('stderr'));

    child.on('error', (err) => {
      this.emit({
        sessionId: input.sessionId,
        runId,
        stream: 'system',
        data: `error: ${err instanceof Error ? err.message : String(err)}\n`,
      });
    });
    child.on('close', (code) => {
      this.active.delete(input.sessionId);
      this.emit({
        sessionId: input.sessionId,
        runId,
        stream: 'system',
        data: `\n[exit ${code ?? -1}]\n`,
        exitCode: code ?? -1,
        done: true,
      });
      // Persist last command + exit so the renderer can show it on revisit.
      try {
        const db = getDb();
        const now = Date.now();
        const existing = db
          .select()
          .from(sessionReview)
          .where(eq(sessionReview.sessionId, input.sessionId))
          .all();
        if (existing.length === 0) {
          db.insert(sessionReview)
            .values({
              sessionId: input.sessionId,
              notes: '',
              lastTestCommand: input.command,
              lastTestExitCode: code ?? -1,
              updatedAt: now,
            })
            .run();
        } else {
          db.update(sessionReview)
            .set({
              lastTestCommand: input.command,
              lastTestExitCode: code ?? -1,
              updatedAt: now,
            })
            .where(eq(sessionReview.sessionId, input.sessionId))
            .run();
        }
      } catch {
        /* best-effort */
      }
    });

    return runId;
  }

  /** Kill an in-flight run for the given session, if any. */
  kill(sessionId: string): void {
    const run = this.active.get(sessionId);
    if (!run) return;
    try {
      run.child.kill('SIGTERM');
    } catch {
      /* ignore */
    }
    this.active.delete(sessionId);
  }

  /** Kill everything (used on shutdown). */
  killAll(): void {
    for (const sessionId of Array.from(this.active.keys())) {
      this.kill(sessionId);
    }
  }
}
