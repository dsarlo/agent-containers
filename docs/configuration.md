# Configuration reference

Agent Containers reads `.agent-containers.yml` from the current repository for `create`. Use `agent-containers validate` before creating workspaces; `agent-containers validate --config path` checks another file.

```yaml
version: 1
workspace:
  worktreeRoot: ../.agent-containers-worktrees
  baseBranch: main
environment:
  devcontainerPath: .devcontainer/devcontainer.json
commands:
  test: npm test
```

| Field | Required | Default | Description |
| --- | --- | --- | --- |
| `version` | No | `1` | Only version `1` is accepted. |
| `workspace.worktreeRoot` | No | `../.agent-containers-worktrees` | Parent for named worktrees; relative paths resolve from the Git root. |
| `workspace.baseBranch` | No | `main` | Base used by `agent-containers create` unless `--base` is supplied. |
| `environment.devcontainerPath` | No | `.devcontainer/devcontainer.json` | Safe repository-relative Dev Container **regular file**; Git symlinks are rejected and runtime refuses a resolved path outside the worktree. Both `validate` and `create` require it on `workspace.baseBranch`; `create --base` requires it on that effective local base too, all before any worktree side effect. |
| `commands` | No | `{}` | Optional named, non-empty strings for people and agents to discover; never executed by Agent Containers. |

Defaults are merged before validation. Supplied empty values, wrong types, unknown keys, or non-mapping root/section values are errors.

## v0.1 Dev Container compatibility

The referenced JSON/JSONC configuration must not define `dockerComposeFile`, `workspaceMount`, or `workspaceFolder`. These modes are intentionally unsupported in v0.1 because Agent Containers needs to control the worktree folder and mount for safe lifecycle cleanup. Comments and comment-like text inside JSON strings are accepted.

A `devcontainerPath` copied into a nested directory changes that configuration's relative base. In particular, `build.context` does not change how `build.dockerfile` resolves: point each field at the intended worktree-relative location, e.g. `"build": { "context": "..", "dockerfile": "../Dockerfile" }` for a configuration located one directory deeper than its Dockerfile.

Example one-off base:

```sh
ac create release-check --base release/next
```
