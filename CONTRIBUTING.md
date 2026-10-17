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

Commit messages follow Conventional Commits with a scope: `type(scope): subject`.

- types: `feat`, `fix`, `docs`, `test`, `refactor`, `chore`, `ci`
- scope: the module or area, such as `hooks`, `tools`, `pty`, `launch`, `db`, `cli`, `readme`
- subject: imperative, lower case, no full stop, at most 50 characters
- body: why the change is needed, wrapped at 72 characters

One change per commit, written in British English.

## Pull requests

One change per pull request, with the tests it needs. `npm test` and `npm run typecheck` run on every push. A change in what the user sees goes into the README in the same pull request.

The end-to-end scenarios with real agents live outside this repository. Say in the pull request what you tried with a real agent, if anything.
