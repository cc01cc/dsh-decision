# DSH Decision

A local-first decision management plugin for DeepSeek Harness (DSH).

## Purpose

Keep decisions searchable and traceable across projects, including their status, time horizon, and source references. The first version is intended for one local user and starts with a fresh database; importing existing historical records is out of scope.

## Initial scope

- Create one or many decisions.
- Search decisions by keyword; show active decisions by default, with an option to include other statuses.
- Edit decision metadata and content while retaining a traceable change history.
- Support deletion; whether this means withdrawal or permanent erasure remains to be decided.

## Initial data concepts

- **Project**: stable project key and display name.
- **Decision**: project, title, decision text, rationale, time horizon, lifecycle status, decision date, source references, and timestamps.
- **Time horizon**: long-term or temporary; temporary decisions may have a review/expiry date.
- **Status**: active, superseded, withdrawn, or closed. Status is independent from time horizon.
- **Source reference**: optional file path, decision ID, harness/session ID, or URL that supports the decision.

This is a starting proposal, not a frozen schema. Keep the first release small and preserve source traceability. Treat `active` as the default search filter; model `superseded`, `withdrawn`, and `closed` separately because they describe different outcomes. Whether edits keep prior text revisions is still open. For delete, withdrawal preserves the decision and its links; permanent deletion removes the record and its links, which may be appropriate for test mistakes or sensitive data but breaks traceability.

## Persistence evaluation

SQLite suits a local, single-user plugin. The installed DSH runtime (`0.2.2-rc.1`) includes `storageDomain` and the JSON backend, but its runtime package manifest does not include `@deepseek-ai/dsh-storage-sqlite`. The matching DSH source contains that first-party backend (`0.2.2-rc.1`): it uses `node:sqlite`, stores each KV record as a JSON document in one row, and routes through `storageDomain`. Its API does not expose arbitrary SQL, indexes, or FTS5. Source snapshot: <https://github.com/deepseek-ai/deepseek-harness/tree/e8f7b93a344964de3dca1ace9e72b6e4d6de87cb/packages/storage>.

For this first version, evaluate bundling the official SQLite backend with `storageDomain`; if that proves incompatible with the installed Host, a plugin-owned SQLite schema is the alternative and carries more schema, transaction, and lifecycle code. Since the app starts with an empty database and one local user, scanning a small set of records for keyword matches may be enough; FTS5 can wait until measurements show a need. The KV interface writes each record separately, so batch insertion may partially complete if interrupted; define it as retryable per-record results unless all-or-nothing import is required.

## Repository

- Upstream: <https://github.com/cc01cc/dsh-decision>

## Adapter boundary

DSH is the primary form of this plugin. A thin CLI is a **second adapter on the same injection seam** (`DecisionToolDeps`), not a new permission boundary: adding it does not buy any access control, and its attribution degrades to OS-account level.

Scope, the minimal call surface, what this project deliberately does **not** do, and how CLI and the DSH plugin divide work are frozen in [`docs/adapter-boundary.md`](docs/adapter-boundary.md). Read it before proposing any caller-identity, token, or permission-model work.

## Development status

Repository initialized from the upstream LICENSE-only commit. Plugin UI and tool extension points are available in the installed Host; the SQLite backend packaging path and deletion/revision policy remain to be confirmed before implementation. No plugin has been installed into a DSH profile.
