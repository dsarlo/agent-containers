# Contributing to Agent Containers

## Development setup

Use Node.js 20.19 or newer and install dependencies with `npm ci`. Run the required local checks before opening a pull request:

```sh
npm run lint
npm run typecheck
npm test
npm run build
```

The dedicated live integration check additionally needs Docker, the Dev Containers CLI, and Git support for `git worktree add --relative-paths` (or `--[no-]relative-paths`):

```sh
npm run test:integration
```

It skips when those local prerequisites are absent; the CI live-devcontainer job makes them mandatory.

## Guidelines

- Add a failing test before implementing a behavior. Unit tests inject process seams rather than run Docker or mutate a real repository.
- Preserve argument-array process execution and `shell: false`; do not add shell interpolation for agent command text.
- Keep the public `ac` / `agent-containers` identity, `.agent-containers.yml`, and `agent-containers/<name>` branch namespace consistent across code, tests, docs, packages, and CI.
- Keep v0.1 Dev Container limitations (`dockerComposeFile`, `workspaceMount`, and `workspaceFolder` are rejected) and recovery guidance current in public documentation.
- Keep documentation and the changelog current for user-facing changes.

Please follow the [Code of Conduct](CODE_OF_CONDUCT.md). Report vulnerabilities according to [SECURITY.md](SECURITY.md), not in public issues.
