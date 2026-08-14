# GitHub App installations are Sources, stored in their own table

Status: accepted

A Source is a connected GitHub App installation: the account it is installed on, its
installation id, which repositories it covers, and the permissions and events GitHub
granted. Sources are account-scoped (ADR-0007) — they have no box.

Sources live in a dedicated `sources` table rather than as rows in the polymorphic
`resources` table (ADR-0006).

## Why a dedicated table

**GitHub is the system of record, not the operator.** A resource's `configuration` is
operator intent that the daemon applies and the observe loop verifies. An installation is
none of that: it is created on github.com, its permissions and repository grant change on
github.com, and the plane merely mirrors what GitHub reports. Putting it in `resources`
would give it a configuration nobody can edit, a health nobody observes, and a release
history that can never have a release.

**Identity is GitHub's, not `(server, kind, name)`.** An installation is unique per
`(provider, installation_id)`. GitHub redelivers the setup callback for the same
installation when its grant changes, so the write path is an upsert keyed on GitHub's id
— a shape the resource identity index cannot express.

**No tokens at rest.** The table stores only the mirrored installation record. The app
private key is a Worker secret; app JWTs live for one request; installation access tokens
are minted on demand in a later slice and never persisted. The table has no column that
could hold a token.

## What stays the same

The `source` resource kind (docs/type-design.md §2.3) remains the account-scoped handle
other resources link to — an app's `source: { type: 'repo', ... }` and a `git_push`
deployment trigger's `source_id` will resolve through a source to its installation. The
`sources` table is the integration foundation those references stand on.

The plane does not create mocked local installations. The Sources connect flow requires a
configured GitHub App (`GITHUB_APP_ID`, `GITHUB_APP_SLUG`, and `GITHUB_APP_PRIVATE_KEY`) so
local development exercises the same browser-to-GitHub-to-callback path as production.
