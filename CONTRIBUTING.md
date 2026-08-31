# Contributing

## Development Setup

Use Node 20 or newer and install dependencies with `npm ci`. Run the full check set before opening a pull request:

```sh
npm run lint
npm run typecheck
npm test
npm run build
```

## Guidelines

- Keep the dependency set small and justify new runtime dependencies.
- Add a failing test before implementing a behavior. Unit tests must inject process seams rather than run Docker or mutate a real repository.
- Preserve argument-array process execution. Do not add shell interpolation for agent command text.
- Keep documentation and the changelog current for user-facing changes.

Please follow the [Code of Conduct](CODE_OF_CONDUCT.md). Report vulnerabilities according to [SECURITY.md](SECURITY.md), not in public issues.
