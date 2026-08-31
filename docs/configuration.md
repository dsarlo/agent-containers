# Configuration Reference

Arachne reads `.arachne.yml` from the current repository for `create`. Use `arachne validate` before creating workspaces. A different file can be checked with `arachne validate --config path`.

```yaml
version: 1
workspace:
  worktreeRoot: ../.arachne-worktrees
  baseBranch: main
environment:
  devcontainerPath: .devcontainer/devcontainer.json
commands:
  test: npm test
  lint: npm run lint
  start: npm run dev
```

## Fields

| Field | Required | Default | Description |
| --- | --- | --- | --- |
| `version` | No | `1` | Configuration schema version. Only version `1` is accepted. |
| `workspace.worktreeRoot` | No | `../.arachne-worktrees` | Parent directory for named worktrees. Relative paths resolve from the source Git root. |
| `workspace.baseBranch` | No | `main` | Branch or revision used by `arachne create` unless `--base` is supplied. |
| `environment.devcontainerPath` | No | `.devcontainer/devcontainer.json` | Dev Container configuration path, relative to each worktree unless absolute. |
| `commands` | No | `{}` | Optional map of named, non-empty command strings such as `test`, `lint`, and `start`. It is documentation for consumers, not executable Arachne configuration. |

Defaults are merged before validation. Supplying a field with an empty value or wrong type is an error; omitting it uses the listed default. The configuration root and supplied `workspace`, `environment`, and `commands` sections must be mappings, not lists, strings, or null.

## Paths

`worktreeRoot` is resolved relative to the Git root discovered by `create`. `devcontainerPath` is resolved relative to the selected worktree during `exec` and `run`. Absolute paths are accepted when an organization uses a named worktree root outside the source checkout.

## Examples

For a repository whose default branch is `develop` and whose configuration lives at `.devcontainer/devcontainer.json`:

```yaml
version: 1
workspace:
  worktreeRoot: ../team-worktrees
  baseBranch: develop
environment:
  devcontainerPath: .devcontainer/devcontainer.json
commands:
  test: pnpm test
  lint: pnpm lint
```

Create from a one-off base without changing the file:

```sh
arachne create release-check --base release/next
```
