# Contributing

## Set up

You need Node 24 and git. Claude Code or Codex CLI is needed only to try chord with a real agent.

```
git clone https://github.com/Cedr1cSun/chord-cli && cd chord-cli
npm install
npm link            # puts `chord` on your PATH, pointing at this checkout
npm test            # unit tests, against real git repositories in temporary folders
npm run typecheck
```

Node runs the TypeScript in `src/` directly, so there is no build step.

## Layout

- `src/cli.ts`: the commands
- `src/launch.ts` and `src/pty.ts`: starting an agent in its worktree and watching its terminal
- `src/hooks.ts` and `src/tools.ts`: what the agent sees, as hooks and as MCP tools
- `src/db.ts`: the shared SQLite board
- `test/`: unit tests, one file per module

## Commits

Commit messages look like `fix(hooks): refuse a write on an unclaimed file`: a type (`feat`, `fix`, `docs`, `test`, `refactor`, `chore`, `ci`), the module or area in brackets, and a short summary. If the why is not obvious, say it in the body. Keep unrelated changes in separate commits.

## Pull requests

Keep a pull request to one topic. Add or adjust a test when behaviour changes, and update the README if the user would notice. `npm test` and `npm run typecheck` run in CI on every push.

The end-to-end scenarios with real agents live outside this repository. If you tried the change with a real agent, say so in the pull request.
