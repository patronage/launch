# @launch/db-pull

Copies the content of a PlanetScale Postgres branch into a Postgres on your own machine, for local development. Users, sessions and form submissions stay in PlanetScale. An app runs it as `pnpm db:pull`; `apps/payload` is the reference.

The script is `pull-postgres.sh`. Its header lists every step, check and setting. In short, a run:

1. Refuses a target that is not on this machine, or a Docker daemon that is not local, and checks that Docker and this machine reach the same Postgres server.
2. Creates a PlanetScale role named `db-pull-<time>-<pid>-<random>` that inherits only `pg_read_all_data` and expires after 30 minutes, and checks that it cannot write.
3. Dumps the `public` schema's definitions, then the rows of the app's content tables only, over the direct port with `sslmode=verify-full` in a read-only session, then deletes the role. An exit trap deletes it too.
4. Restores into a scratch database, clears links to rows that were not copied, adds the indexes and foreign keys, and checks that every table outside the content list is empty. Only then is the scratch database swapped in for the local one.
5. Runs the app's after-script, if it has one.

`pg_dump`, `pg_restore` and `psql` run from the `postgres:<PG_MAJOR>` Docker image, so the Postgres installed on the machine doesn't matter.

## Adding it to an app

Depend on `@launch/db-pull` (and `pg`, which `server-id.mjs` uses) as dev dependencies, add `"db:pull": "launch-db-pull"` to the app's scripts, and put two files in the app's folder.

`db-pull.env`, read as `KEY=VALUE` lines and never evaluated:

| Setting |  |
| --- | --- |
| `PSCALE_ORG` | PlanetScale organization |
| `PSCALE_DATABASE` | PlanetScale database |
| `PSCALE_BRANCH` | Branch to copy by default (`main`); `--branch` picks another |
| `PG_MAJOR` | Postgres major version of the source and the local server (`17`) |
| `TARGET_URL` | Local database to replace; `PULL_DB_TARGET_URL` overrides it |
| `DELETE_COMMAND` | Optional: the command that deletes the default local database, named in the advice the run prints |
| `AFTER_SCRIPT` | Optional: a Node script in the app, run after the swap with the target in `PULL_DB_TARGET_URL` and `PULL_DB_MIGRATE=1` for `--migrate` |

`db-pull.tables`, one table per line: `content <table>` (rows copied) or `excluded <table>` (rows left in PlanetScale), with a `#` comment for the reason. A table that holds anything about a visitor or a user is excluded. Give the app a test that fails when its schema has a table the file doesn't classify, as `apps/payload/scripts/db-pull-tables.test.mjs` does.

## Requirements

- Docker on this machine (a `unix://` socket), as Docker Desktop or OrbStack provide it on a Mac. Native Docker Engine on Linux is not supported: there `host.docker.internal` is the bridge address, which a database published on `127.0.0.1` does not listen on.
- The `pscale` CLI, signed in as someone who may manage roles on the database.
- Node, with `pnpm install` done.

## Tests

`pnpm --filter @launch/db-pull test` runs the script against stand-ins for `pscale`, `docker`, `server-id.mjs` and the after-script (`test/fixtures/stub.mjs`), so nothing contacts PlanetScale, Docker or a database.

The script started as a port of a pull Patronage wrote for another Payload site on PlanetScale; this package makes the PlanetScale names, the table lists and the app-specific steps settings.
