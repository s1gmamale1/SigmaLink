# SigmaLink Agent Orchestrator

SigmaLink is an Electron desktop workspace for running multiple CLI coding agents in parallel. It launches real PTY-backed terminals, isolates agent work in Git worktrees, and gives you a review room for live diffs, test commands, and commit/merge approval.

## What is working now

- Real Electron + React desktop app
- Real terminal sessions powered by `node-pty` and `@xterm/xterm`
- Provider registry for Claude Code, Codex, Gemini CLI, Kimi CLI, Continue, and Custom CLI
- Workspace folder picker
- Git repo detection
- Per-agent isolated Git worktrees under Electron user data
- Swarm task delegation that launches real agent sessions and sends structured prompts
- Review Room with real `git status`, `git diff`, untracked file listing, command runner, pass/fail marking, and commit/merge action
- Safer command execution for Git operations via argument arrays, not string-interpolated shell commands

## Requirements

- Node.js 20+
- Git
- At least one CLI agent installed, for example:

Install the CLI agents you want to use, then make sure their commands are available in your terminal PATH. Provider commands and install hints can be edited in `src/lib/providers.ts`.

## Development

```bash
npm install
npm run electron:dev
```

## Build check

```bash
npm run product:check
```

## Package desktop app

```bash
npm run electron:build
```

## Workflow

1. Open SigmaLink.
2. Select a repo/folder in the sidebar.
3. Launch an agent manually from Command Room, or create a task in Swarm Room.
4. Run orchestrator to launch agent worktrees and send prompts.
5. Review real diffs and run commands in Review Room.
6. Mark subtasks passed/failed.
7. Use **Commit & Merge** to commit approved worktree changes and merge them into the selected repo.

## Important notes

- If the selected folder is not a Git repo, SigmaLink falls back to direct-folder mode. Terminals still run, but worktree/diff/merge features are disabled.
- Commit & Merge requires Git user config to be set:

```bash
git config --global user.name "Your Name"
git config --global user.email "you@example.com"
```

- This is a working MVP, not a hosted SaaS. It executes local commands, so only run it against repos and agents you trust.
