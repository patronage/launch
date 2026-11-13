#!/usr/bin/env bash
#
# Copy a PlanetScale Postgres database's content into a local Postgres, for
# local development. Shared by the Launch apps that run on Hyperdrive in front
# of PlanetScale; each app keeps only its settings and table lists.
#
# Usage, from the app's folder (its package.json runs this as `pnpm db:pull`):
#
#   pnpm db:pull                   replace the local database with a copy of
#                                  the PlanetScale branch's content
#   pnpm db:pull --migrate         then run this checkout's pending migrations
#                                  on the local copy (passed to the app's
#                                  after-script)
#   pnpm db:pull --branch <name>   copy another PlanetScale branch than the
#                                  default
#   pnpm db:pull --dry-run         print the plan and contact nothing
#   pnpm db:pull --list-tables     print how each table is classified
#
# Stop the app's dev or preview server first: the run replaces the database
# that server has open, and cannot move it aside while the server keeps
# connecting to it.
#
# The app's folder holds two files:
#
#   db-pull.env     Settings, as KEY=VALUE lines (read, never evaluated):
#                     PSCALE_ORG          PlanetScale organization
#                     PSCALE_DATABASE     PlanetScale database
#                     PSCALE_BRANCH       default branch to copy (main)
#                     PG_MAJOR            Postgres major version of the source
#                                         and the local server (17)
#                     TARGET_URL          default local database to replace;
#                                         PULL_DB_TARGET_URL in the environment
#                                         overrides it
#                     DELETE_COMMAND      optional: the command that deletes the
#                                         default local database (e.g. pnpm
#                                         db:recreate), named in the advice
#                     AFTER_SCRIPT        optional: a Node script, relative to
#                                         the app, run after the swap with the
#                                         target in PULL_DB_TARGET_URL (and
#                                         PULL_DB_MIGRATE=1 with --migrate). An
#                                         app uses it for migrations and the
#                                         local admin.
#   db-pull.tables  How each table is treated, one per line: "content <table>"
#                   (rows copied) or "excluded <table>" (rows left in
#                   PlanetScale), with a # comment saying why where it helps.
#
# The copy holds site content only. The content lines are the allowlist of
# tables whose rows are copied. The rows of every other table stay in
# PlanetScale: the dump of rows names the content tables and no others, so
# users with their password hashes, API keys and sessions, form submissions
# and jobs are never in a dump. A table the lists do not name is left out too,
# whenever it appears.
#
# What a run does, in order:
#
#   1. Refuses unless the target is on this machine (host localhost, 127.0.0.1
#      or ::1), runs Postgres PG_MAJOR, and the docker command talks to a
#      local unix:// socket. Every later docker command is pinned to that
#      socket. It also checks that Docker (as host.docker.internal) and this
#      machine (as localhost) reach the same Postgres server, with
#      server-id.mjs.
#   2. Creates a PlanetScale role named db-pull-<time>-<pid>-<random> on the
#      branch. It inherits only pg_read_all_data and expires after 30 minutes
#      even if nothing deletes it.
#   3. Lists the source's tables, to say how many are left out and to warn
#      about one that is in neither list. Lists the foreign keys from a
#      copied table to a left-out one (in Payload: the users_id column of the
#      *_rels tables, which holds createdBy and lastModifiedBy), and stops
#      unless each is ON DELETE CASCADE or SET NULL.
#   4. Dumps the source twice with pg_dump (custom format, --no-owner
#      --no-privileges), over the direct port 5432, not PgBouncer on 6432,
#      with the TLS certificate verified (sslmode=verify-full) and the
#      session set read-only:
#        - the definitions of the `public` schema, with no rows
#          (--schema-only), so the copy has every table the application
#          expects;
#        - the rows (--data-only) of the tables named with --table, one per
#          content table, with the position of each table's id sequence.
#          What pg_dump may read is fixed by the list, not by what step 3
#          found, so a table that appears between the two steps cannot be
#          dumped.
#      PlanetScale's own schema and extensions stay behind; Payload keeps
#      everything in `public`.
#   5. Deletes the role as soon as the dump ends. An exit trap deletes it too
#      when the run fails or is interrupted.
#   6. Restores into the scratch database <name>__pull_new, in steps: the
#      tables; their rows; then the links from step 3 are removed, because
#      the rows they point at were not copied (the link rows are deleted, or
#      the column is set to null, as the foreign key says); then the indexes
#      and foreign keys.
#   7. Checks that the scratch database holds as many tables as the source,
#      and that every table outside the content list is empty. Only then
#      renames the local database to <name>__pull_old, renames the scratch
#      one into its place, and drops the old one. A restore or a check that
#      fails leaves the local database as it was. A run that stops part-way
#      says which of the three databases exist.
#   8. Runs the app's AFTER_SCRIPT, if it has one.
#
# The only thing a run changes on PlanetScale is that role. It never writes to
# the PlanetScale database.
#
# Handling the copy: it holds site content only, drafts and unpublished
# versions included, and no user, password hash, API key, session or form
# submission. Do not seed other environments from it.
#
# Requirements:
#
#   - Docker, on this machine. pg_dump, pg_restore and psql run from the
#     postgres:PG_MAJOR image, so the Postgres version Homebrew installed does
#     not matter. The script refuses a remote daemon (DOCKER_HOST or a context
#     that is not a unix:// socket): the dump and both passwords pass through
#     the daemon.
#   - The pscale CLI, logged in (`pscale auth login`) as someone who may manage
#     roles on the database.
#   - Node, with `pnpm install` done (server-id.mjs uses the pg package).
#
# Environment:
#
#   PULL_DB_TARGET_URL    Database to replace, instead of TARGET_URL. The host
#                         must be this machine, and the URL must have no query
#                         string or fragment. The port must be reachable from
#                         a container as host.docker.internal, which a port
#                         published by docker compose is.
#   SSL_CERT_FILE         CA bundle that verifies PlanetScale's certificate.
#                         Default: /etc/ssl/cert.pem (macOS), then
#                         /etc/ssl/certs/ca-certificates.crt (Linux).
#
# Secrets: the role's password lives in this process's memory and in the
# environment of the client containers that connect to PlanetScale. While
# pg_dump runs, anyone who can use this machine's Docker daemon can read it
# there as PGPASSWORD (`docker inspect`); the role is deleted when the dump
# ends. The script never prints the password and never writes it to disk. The
# dump file sits in a mode-700 temporary directory that the exit trap removes.
# The CA bundle, which is public, sits alone in a separate mode-755 directory,
# because the client in the container must read it.
#
# Not copied: media files. They stay in the app's bucket.
#
# The localhost check reads the host name only. A tunnel or proxy listening on
# localhost and forwarding elsewhere would pass it; do not aim this script at
# one.
#
# Exit codes: 0 done; 1 refused or failed, or the after-script failed; 2 wrong
# usage.
#
# Adapted from a pull script Patronage wrote for a Payload site on PlanetScale.

set -euo pipefail

# PlanetScale serves Postgres directly on 5432 and through PgBouncer on 6432.
# pg_dump needs the direct port.
readonly SOURCE_DIRECT_PORT="5432"
readonly SOURCE_DBNAME="postgres"
# Identifies a Postgres server: its system identifier and start time. Keep in
# step with SERVER_ID_SQL in server-id.mjs.
readonly SERVER_ID_SQL="select (select system_identifier::text from pg_control_system()) || ' ' || extract(epoch from pg_postmaster_start_time())::text as id"
readonly ROLE_PREFIX="db-pull"
readonly ROLE_INHERITS="pg_read_all_data"
readonly ROLE_TTL="30m"
readonly ROLE_READY_ATTEMPTS="${PULL_DB_ROLE_READY_ATTEMPTS:-20}"
readonly CONTAINER_LOCALHOST="host.docker.internal"
readonly COPY_NOTE="The copy holds site content only, drafts included. Users, password hashes, API keys, sessions, form submissions and jobs were left out of the dump. Do not seed other environments from it."
readonly STOP_DEV_NOTE="Stop the app's dev or preview server first: this run replaces the database that server has open, and cannot move it aside while the server keeps connecting to it."

KIT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly KIT_DIR
APP_DIR="$(pwd)"
readonly APP_DIR
readonly CONFIG_FILE="${APP_DIR}/db-pull.env"
readonly TABLES_FILE="${APP_DIR}/db-pull.tables"

# Settings from db-pull.env.
PSCALE_ORG=""
PSCALE_DATABASE=""
PSCALE_BRANCH="main"
PG_MAJOR="17"
CONFIG_TARGET_URL=""
DELETE_COMMAND=""
AFTER_SCRIPT=""
PG_IMAGE=""
# Table lists from db-pull.tables, one name per line.
CONTENT_TABLES=""
EXCLUDED_TABLES=""

TARGET_URL=""
DRY_RUN=0
MIGRATE=0
BRANCH_OPTION=""

# Filled in as the run goes; the exit trap reads them.
WORK_DIR=""
CA_DIR=""
LOCK_DIR=""
TAKEOVER_DIR=""
# "" while the local server holds nothing of this run; "scratch" while the
# scratch database is being filled and the target is untouched; "swap" while
# the databases are being renamed; "installed" from then until the run has
# printed its last line, so a run stopped in a later step still says that the
# target is a copy.
DATA_STATE=""
SCRATCH_DB=""
OLD_DB=""
ROLE_NAME=""
ROLE_ID=""
ROLE_USERNAME=""
ROLE_PASSWORD=""
ROLE_DELETED=0
SOURCE_HOST=""
SOURCE_PORT=""
SOURCE_TABLES=""
TARGET_HOST=""
TARGET_PORT=""
TARGET_USER=""
# The target URL with its password masked, and its host:port, for messages.
TARGET_MASKED_URL=""
TARGET_SERVER=""
TARGET_PASSWORD=""
TARGET_DB=""
# How many tables this run leaves out of the dump.
LEFT_OUT_COUNT=0

say() { printf '%s\n' "$*"; }
warn() { printf 'Warning: %s\n' "$*" >&2; }
die() {
  printf 'db-pull: %s\n' "$*" >&2
  exit 1
}

usage() {
  cat <<'USAGE'
Usage: pnpm db:pull [--migrate] [--branch <name>] [--dry-run] [--list-tables]

Replaces the app's local Postgres database with a copy of a PlanetScale
branch's content. The app's db-pull.env names the database; db-pull.tables
lists the tables whose rows are copied. Read the header of
packages/db-pull/pull-postgres.sh for what it does and needs.

Stop the dev or preview server first: the run replaces the database it has
open.

  --migrate        After the restore, have the app's after-script run the
                   migrations this checkout has and the copy has not, on the
                   local copy only.
  --branch <name>  Copy this PlanetScale branch instead of PSCALE_BRANCH.
  --dry-run        Print the plan. Contacts neither PlanetScale nor Docker.
  --list-tables    Print each table the app lists as "content <table>" (rows
                   copied) or "excluded <table>" (rows left in PlanetScale).
                   Contacts nothing.
  -h, --help       Show this text.

The copy holds site content only. The rows of every table that is not on the
content list stay in PlanetScale: users with their password hashes, API keys
and sessions, form submissions and jobs.

The copy includes drafts. Do not seed other environments from it.

Environment: PULL_DB_TARGET_URL (database to replace; must be on localhost),
SSL_CERT_FILE (CA bundle for PlanetScale's certificate).
USAGE
}

# Reads db-pull.env: KEY=VALUE lines, never evaluated. Unknown keys stop the
# run, so a typo cannot quietly fall back to a default.
load_config() {
  local line key value
  [ -f "$CONFIG_FILE" ] ||
    die "no db-pull.env in ${APP_DIR}. Run this from an app that has one (pnpm db:pull)."
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line%$'\r'}"
    case "$line" in '' | '#'*) continue ;; esac
    key="${line%%=*}"
    [ "$key" != "$line" ] || die "db-pull.env: '${line}' is not a KEY=VALUE line."
    value="${line#*=}"
    if [[ "$value" =~ ^\"(.*)\"$ ]] || [[ "$value" =~ ^\'(.*)\'$ ]]; then
      value="${BASH_REMATCH[1]}"
    fi
    case "$key" in
      PSCALE_ORG) PSCALE_ORG="$value" ;;
      PSCALE_DATABASE) PSCALE_DATABASE="$value" ;;
      PSCALE_BRANCH) PSCALE_BRANCH="$value" ;;
      PG_MAJOR) PG_MAJOR="$value" ;;
      TARGET_URL) CONFIG_TARGET_URL="$value" ;;
      DELETE_COMMAND) DELETE_COMMAND="$value" ;;
      AFTER_SCRIPT) AFTER_SCRIPT="$value" ;;
      *) die "db-pull.env: unknown setting '${key}'." ;;
    esac
  done <"$CONFIG_FILE"

  if [ -n "$BRANCH_OPTION" ]; then
    PSCALE_BRANCH="$BRANCH_OPTION"
  fi
  local name
  for name in PSCALE_ORG PSCALE_DATABASE PSCALE_BRANCH; do
    case "${!name}" in
      "" | -* | *[!A-Za-z0-9_-]*)
        die "${name} must be letters, digits, '_' or '-' (got '${!name}')."
        ;;
      *) ;;
    esac
  done
  case "$PG_MAJOR" in
    "" | *[!0-9]*) die "PG_MAJOR must be a number (got '${PG_MAJOR}')." ;;
    *) ;;
  esac
  [ -n "$CONFIG_TARGET_URL" ] || die "db-pull.env has no TARGET_URL."
  if [ -n "$AFTER_SCRIPT" ]; then
    case "$AFTER_SCRIPT" in
      /* | *..*) die "AFTER_SCRIPT must be a path inside the app (got '${AFTER_SCRIPT}')." ;;
      *) ;;
    esac
    [ -f "${APP_DIR}/${AFTER_SCRIPT}" ] || die "AFTER_SCRIPT '${AFTER_SCRIPT}' does not exist."
  fi
  PG_IMAGE="postgres:${PG_MAJOR}"
  TARGET_URL="${PULL_DB_TARGET_URL:-$CONFIG_TARGET_URL}"
}

# Reads db-pull.tables into CONTENT_TABLES and EXCLUDED_TABLES.
load_tables() {
  local line kind name rest
  [ -f "$TABLES_FILE" ] || die "no db-pull.tables in ${APP_DIR}."
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line%%#*}"
    line="${line%$'\r'}"
    read -r kind name rest <<<"$line" || true
    [ -n "${kind:-}" ] || continue
    [ -z "${rest:-}" ] || die "db-pull.tables: '${line}' has more than a kind and a table."
    case "${name:-}" in
      "" | *[!a-z0-9_]*) die "db-pull.tables: '${name:-}' is not a table name this script can use." ;;
      *) ;;
    esac
    case "$kind" in
      content) CONTENT_TABLES="${CONTENT_TABLES}${name}"$'\n' ;;
      excluded) EXCLUDED_TABLES="${EXCLUDED_TABLES}${name}"$'\n' ;;
      *) die "db-pull.tables: '${kind}' must be 'content' or 'excluded'." ;;
    esac
  done <"$TABLES_FILE"
  [ -n "$CONTENT_TABLES" ] || die "db-pull.tables lists no content table."
  local both
  both="$(LC_ALL=C comm -12 <(table_list "$CONTENT_TABLES") <(table_list "$EXCLUDED_TABLES"))"
  [ -z "$both" ] || die "db-pull.tables lists these as both content and excluded: $(printf '%s' "$both" | tr '\n' ' ')"
}

# Prints one top-level string field of the JSON document on stdin. Prints
# nothing and fails when the field is missing. It must never echo its input:
# that input can hold the role's password.
json_field() {
  node -e '
    let text = "";
    process.stdin.on("data", (chunk) => (text += chunk));
    process.stdin.on("end", () => {
      let value;
      try {
        value = JSON.parse(text)[process.argv[1]];
      } catch {
        process.exit(1);
      }
      if (typeof value !== "string" || value === "") process.exit(1);
      process.stdout.write(value);
    });
  ' "$1"
}

# Prints the id of the role on stdin's `pscale role list` JSON whose name is
# exactly $1, or nothing.
role_id_named() {
  node -e '
    let text = "";
    process.stdin.on("data", (chunk) => (text += chunk));
    process.stdin.on("end", () => {
      let roles;
      try {
        roles = JSON.parse(text);
      } catch {
        process.exit(1);
      }
      const role = Array.isArray(roles)
        ? roles.find((entry) => entry.name === process.argv[1])
        : undefined;
      if (role) process.stdout.write(String(role.id));
    });
  ' "$1"
}

# Splits TARGET_URL into TARGET_* and refuses a target that is not local.
read_target() {
  local parsed
  # node-postgres lets ?host=, ?port=, ?user= and ?password= override the
  # address in front of them, so a URL that passes the localhost check could
  # still send the after-script somewhere else.
  case "$TARGET_URL" in
    *\?* | *\#*)
      die "The target URL must not have a query string or a fragment: settings there (host, port, user, password) would override the local address."
      ;;
    *) ;;
  esac

  # The URL holds the local password. It goes to node in the environment, not
  # as an argument, so it does not show in `ps`.
  parsed="$(
    PULL_DB_PARSE_URL="$TARGET_URL" node -e '
      let url;
      try {
        url = new URL(process.env.PULL_DB_PARSE_URL ?? "");
      } catch {
        process.exit(1);
      }
      if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") process.exit(1);
      const database = decodeURIComponent(url.pathname.replace(/^\//, ""));
      const fields = [
        url.hostname.replace(/^\[|\]$/g, ""),
        url.port || "5432",
        decodeURIComponent(url.username),
        decodeURIComponent(url.password),
        database,
      ];
      // For messages: the URL as given, with the password masked. The URL
      // serializer keeps the brackets of an IPv6 host and the encoding of
      // the user name, which putting the fields back together would lose.
      const masked = new URL(url.href);
      masked.password = "***";
      fields.push(masked.href, url.port ? url.host : url.host + ":5432");
      if (fields.some((field) => field.includes("\n"))) process.exit(1);
      process.stdout.write(fields.join("\n") + "\n");
    '
  )" || die "The target URL is not a postgres:// URL."

  {
    IFS= read -r TARGET_HOST
    IFS= read -r TARGET_PORT
    IFS= read -r TARGET_USER
    IFS= read -r TARGET_PASSWORD
    IFS= read -r TARGET_DB
    IFS= read -r TARGET_MASKED_URL
    IFS= read -r TARGET_SERVER
  } <<<"$parsed"

  case "$TARGET_HOST" in
    localhost | 127.0.0.1 | ::1) ;;
    *)
      die "refusing to restore into host '${TARGET_HOST}'. The target must be on this machine: localhost, 127.0.0.1 or ::1."
      ;;
  esac
  [ -n "$TARGET_USER" ] || die "The target URL names no user."
  case "$TARGET_DB" in
    "" | *[!A-Za-z0-9_-]*)
      die "the target database name '${TARGET_DB}' must be letters, digits, '_' or '-'."
      ;;
  esac
  if [ "$TARGET_DB" = "postgres" ]; then
    die "the target database cannot be 'postgres': the script connects to it to replace the target."
  fi
  case "$TARGET_PORT" in
    "" | *[!0-9]*) die "The target URL has an unexpected port." ;;
  esac
  SCRATCH_DB="${TARGET_DB}__pull_new"
  OLD_DB="${TARGET_DB}__pull_old"
}

# Prints a table list (CONTENT_TABLES or EXCLUDED_TABLES), one name per line,
# in the order `comm` needs.
table_list() {
  printf '%s\n' "$1" | sed '/^$/d' | LC_ALL=C sort
}

# --list-tables: how the script classifies each table it knows.
list_tables() {
  table_list "$CONTENT_TABLES" | sed 's/^/content /'
  table_list "$EXCLUDED_TABLES" | sed 's/^/excluded /'
}

# Stops unless every line of the file $1 is a name that can go into an
# argument and into SQL as it is. $2 says where the names came from.
check_table_names() {
  local name
  while IFS= read -r name; do
    case "$name" in
      "" | *[!a-z0-9_]*)
        die "${2} has a table or column named '${name}', which this script cannot name safely. The local database is unchanged."
        ;;
      *) ;;
    esac
  done <"$1"
}

masked_target_url() {
  say "$TARGET_MASKED_URL"
}

print_plan() {
  cat <<EOF
Plan (dry run: nothing was contacted or changed)

  ${STOP_DEV_NOTE}

  Source   PlanetScale ${PSCALE_ORG}/${PSCALE_DATABASE}, branch ${PSCALE_BRANCH},
           database ${SOURCE_DBNAME}, direct port ${SOURCE_DIRECT_PORT}, sslmode=verify-full
  Target   $(masked_target_url)
  Clients  pg_dump, pg_restore and psql from the Docker image ${PG_IMAGE}

  1. Check that docker talks to a local unix:// socket, and that the target
     answers and runs Postgres ${PG_MAJOR}.
  2. pscale role create ${PSCALE_DATABASE} ${PSCALE_BRANCH} ${ROLE_PREFIX}-<time>-<pid>-<random>
       --inherited-roles ${ROLE_INHERITS} --ttl ${ROLE_TTL}
  3. List the source's tables. Leave out the rows of every table that is not
     on the content list ($(table_list "$EXCLUDED_TABLES" | wc -l | tr -d ' ') listed as excluded, such as users,
     sessions, form submissions and jobs; see --list-tables), and of any
     table db-pull.tables does not name.
  4. pg_dump --format=custom --no-owner --no-privileges, twice, in a
     read-only session: --schema-only --schema=public (definitions, no
     rows), then --data-only --table=public.<each allowlisted table>.
  5. pscale role delete, also from the exit trap on failure or Ctrl-C.
  6. pg_restore --no-owner --no-privileges --exit-on-error into
     "${SCRATCH_DB}": tables, then rows, then
     remove the links to rows that were not copied (in Payload, createdBy
     and lastModifiedBy name a user), then indexes and foreign keys.
  7. Check that it holds as many tables as the source and that every
     left-out table is empty. Rename "${TARGET_DB}" to
     "${OLD_DB}", rename the new database into its
     place, then drop the old one.
  8. $(if [ -n "$AFTER_SCRIPT" ]; then say "node ${AFTER_SCRIPT}$(if [ "$MIGRATE" -eq 1 ]; then say " with PULL_DB_MIGRATE=1"; fi), pinned to the target above."; else say "Nothing else: this app has no AFTER_SCRIPT."; fi)

  ${COPY_NOTE}
  $(how_to_delete "$TARGET_DB")
EOF
}

pscale_role() {
  local subcommand="$1"
  shift
  pscale role "$subcommand" "$PSCALE_DATABASE" "$PSCALE_BRANCH" "$@" \
    --org "$PSCALE_ORG"
}

# Runs a Postgres client against PlanetScale as the throwaway role. The
# connection settings travel as environment variables named on the docker
# command line without their values, so the password is in no argument list.
source_pg() {
  PGHOST="$SOURCE_HOST" PGPORT="$SOURCE_PORT" PGUSER="$ROLE_USERNAME" \
    PGPASSWORD="$ROLE_PASSWORD" PGDATABASE="$SOURCE_DBNAME" \
    PGSSLMODE="verify-full" PGSSLROOTCERT="/db-pull-tls/ca.pem" \
    PGOPTIONS="-c default_transaction_read_only=on" \
    PGCONNECT_TIMEOUT="15" PGAPPNAME="db-pull" \
    docker run --rm \
    -e PGHOST -e PGPORT -e PGUSER -e PGPASSWORD -e PGDATABASE \
    -e PGSSLMODE -e PGSSLROOTCERT -e PGOPTIONS -e PGCONNECT_TIMEOUT -e PGAPPNAME \
    -v "${CA_DIR}:/db-pull-tls:ro" \
    "$PG_IMAGE" "$@" </dev/null
}

# Runs a Postgres client against the local target. $1 is the database; stdin
# passes through, for pg_restore.
target_pg() {
  local database="$1"
  shift
  PGHOST="$CONTAINER_LOCALHOST" PGPORT="$TARGET_PORT" PGUSER="$TARGET_USER" \
    PGPASSWORD="$TARGET_PASSWORD" PGDATABASE="$database" \
    PGOPTIONS="-c client_min_messages=warning" \
    PGCONNECT_TIMEOUT="15" PGAPPNAME="db-pull" \
    docker run --rm -i \
    --add-host "${CONTAINER_LOCALHOST}:host-gateway" \
    -e PGHOST -e PGPORT -e PGUSER -e PGPASSWORD -e PGDATABASE \
    -e PGOPTIONS -e PGCONNECT_TIMEOUT -e PGAPPNAME \
    "$PG_IMAGE" "$@"
}

# Says how to delete the copied data in the databases named as arguments, and
# only those: after a failed swap the developer's own data is in one of the
# other databases. For the app's default target, DELETE_COMMAND (when set)
# removes the local server's data. For any other target, the script cannot
# tell which server answers on the port, so the sentence names the databases
# to drop there.
# shellcheck disable=SC2317,SC2329 # Also runs from the EXIT trap.
how_to_delete() {
  local names="\"${1}\"" noun="database"
  if [ "$#" -gt 1 ]; then
    names="${names} and \"${2}\""
    noun="databases"
  fi
  if [ -n "$DELETE_COMMAND" ] && [ "$TARGET_URL" = "$CONFIG_TARGET_URL" ]; then
    say "To delete the copied data, run: ${DELETE_COMMAND} (it removes every database on the app's local server)."
  else
    say "To delete the copied data, drop the ${noun} ${names} on the server at ${TARGET_SERVER}."
  fi
}

target_sql() {
  local database="$1"
  shift
  target_pg "$database" psql --no-psqlrc --quiet --tuples-only --no-align \
    --set ON_ERROR_STOP=1 "$@" </dev/null
}

# Deletes the throwaway role. Safe to call twice. When `pscale role create`
# was interrupted before it reported an id, finds the role by its name.
delete_role() {
  [ -n "$ROLE_NAME" ] || return 0
  [ "$ROLE_DELETED" -eq 0 ] || return 0

  local id="$ROLE_ID" attempt
  if [ -z "$id" ]; then
    # Lists every role and picks by name here: `pscale role list --name` only
    # exists in recent pscale builds.
    id="$(pscale_role list --format json 2>/dev/null | role_id_named "$ROLE_NAME")" || id=""
    if [ -z "$id" ]; then
      # Either the role was never created, or the lookup failed.
      if pscale_role list --format json >/dev/null 2>&1; then
        ROLE_DELETED=1
        return 0
      fi
      warn "could not check whether PlanetScale role '${ROLE_NAME}' exists."
      warn "Check with: pscale role list ${PSCALE_DATABASE} ${PSCALE_BRANCH} --org ${PSCALE_ORG}"
      return 1
    fi
  fi

  for attempt in 1 2 3; do
    if pscale_role delete "$id" --force >/dev/null; then
      ROLE_DELETED=1
      ROLE_PASSWORD=""
      say "Deleted PlanetScale role ${ROLE_NAME} (${id})."
      return 0
    fi
    [ "$attempt" -eq 3 ] || sleep 2
  done

  warn "could not delete PlanetScale role '${ROLE_NAME}' (${id}). It expires ${ROLE_TTL} after creation."
  warn "Delete it now with: pscale role delete ${PSCALE_DATABASE} ${PSCALE_BRANCH} ${id} --org ${PSCALE_ORG} --force"
  return 1
}

# shellcheck disable=SC2317,SC2329 # Runs from the EXIT trap.
cleanup() {
  local status=$?
  trap - EXIT
  # A second Ctrl-C must not stop the role deletion below. Ignored signals
  # stay ignored in the commands this function runs.
  trap '' INT TERM HUP
  set +e
  # A signal can arrive while output is redirected into the dump file. Write
  # to the terminal again, so the messages below are seen.
  exec 1>&3 2>&4
  if ! delete_role && [ "$status" -eq 0 ]; then
    status=1
  fi
  if [ "$status" -ne 0 ]; then
    report_local_data
  fi
  local dir
  for dir in "$WORK_DIR" "$CA_DIR" "$LOCK_DIR" "$TAKEOVER_DIR"; do
    if [ -n "$dir" ]; then
      rm -rf "$dir"
    fi
  done
  exit "$status"
}

# After a run that failed or was interrupted while the local server held part
# of it: drops an unfinished scratch database, then says which databases
# exist, so nobody has to guess where the data is.
# shellcheck disable=SC2317,SC2329 # Runs from the EXIT trap.
report_local_data() {
  [ -n "$DATA_STATE" ] || return 0
  local found has_target=0 has_scratch=0 has_old=0 copy_installed=0 name

  if [ "$DATA_STATE" = "scratch" ]; then
    target_sql postgres --command "drop database if exists \"${SCRATCH_DB}\" with (force)" >/dev/null 2>&1
  fi
  if ! found="$(target_sql postgres --command "select datname from pg_database where datname in ('${TARGET_DB}', '${SCRATCH_DB}', '${OLD_DB}')" 2>/dev/null)"; then
    warn "could not check the local server. A copy of the source may be in \"${SCRATCH_DB}\" or \"${TARGET_DB}\", and your previous local database in \"${OLD_DB}\"."
    warn "Run 'pnpm db:pull' again to finish; it says which database holds what."
    return 0
  fi
  while IFS= read -r name; do
    case "$name" in
      "$TARGET_DB") has_target=1 ;;
      "$SCRATCH_DB") has_scratch=1 ;;
      "$OLD_DB") has_old=1 ;;
      *) ;;
    esac
  done <<<"$found"

  say "Where the local data is now:"
  if [ "$has_target" -eq 0 ]; then
    say "  \"${TARGET_DB}\" does not exist."
  elif [ "$DATA_STATE" = "scratch" ] || [ "$has_scratch" -eq 1 ]; then
    say "  \"${TARGET_DB}\" is your local database, unchanged."
  else
    # Decided by what the server holds, not by DATA_STATE alone: a signal can
    # arrive between the rename and the line that records it.
    copy_installed=1
    say "  \"${TARGET_DB}\" is the copy of the source."
  fi
  if [ "$has_scratch" -eq 1 ]; then
    say "  \"${SCRATCH_DB}\" holds copied data that was not swapped in."
  fi
  if [ "$has_old" -eq 1 ]; then
    say "  \"${OLD_DB}\" is your previous local database."
  fi
  # The script cannot tell where the other databases came from. One that an
  # earlier pull filled is a copy as well, so the advice says so
  # without telling anyone to drop what may be their own data.
  local earlier=""
  if [ "$has_old" -eq 1 ] || { [ "$has_scratch" -eq 1 ] && [ "$has_target" -eq 1 ]; }; then
    earlier=" A database listed above that an earlier 'pnpm db:pull' filled holds copied data too: delete it the same way."
  fi
  if [ "$copy_installed" -eq 1 ]; then
    say "The run stopped before it finished, so the app's after-script (its local admin, for one) did not run. Run 'pnpm db:pull' again."
    say "${COPY_NOTE} $(how_to_delete "$TARGET_DB")${earlier}"
  elif [ "$has_scratch" -eq 1 ]; then
    # Only the scratch database holds copied data. The others are the
    # developer's own, so the advice must not name them.
    say "Run 'pnpm db:pull' again to finish. $(how_to_delete "$SCRATCH_DB")${earlier}"
  elif [ "$has_old" -eq 1 ] || [ "$has_target" -eq 0 ]; then
    say "Run 'pnpm db:pull' again to finish.${earlier}"
  fi
}

check_tools() {
  local tool
  for tool in docker pscale node; do
    command -v "$tool" >/dev/null 2>&1 || die "'${tool}' is not installed or not on PATH."
  done
  check_docker_endpoint
  docker info >/dev/null 2>&1 || die "Docker is not running. Start it, and the app's local database, then try again."
}

# The dump, the role's password and the local password all pass through the
# Docker daemon, and a remote daemon's "localhost" is another machine.
check_docker_endpoint() {
  local endpoint
  endpoint="$(docker context inspect --format '{{.Endpoints.docker.Host}}' 2>/dev/null)" || endpoint=""
  case "$endpoint" in
    unix://*) ;;
    "")
      die "cannot tell which Docker daemon the docker command talks to ('docker context inspect' failed). Unset DOCKER_HOST and DOCKER_CONTEXT, or choose a local context with 'docker context use'."
      ;;
    *)
      die "refusing to run: the docker command talks to '${endpoint}', and this script needs a Docker daemon on this machine (a unix:// socket). Unset DOCKER_HOST and DOCKER_CONTEXT, or choose a local context with 'docker context use'."
      ;;
  esac
  # Every later docker command uses the socket just checked. Without this, a
  # 'docker context use <remote>' in another terminal during the run would
  # send the containers, and the passwords in their environment, elsewhere.
  export DOCKER_HOST="$endpoint"
  unset DOCKER_CONTEXT
}

# One run at a time per target: two runs would share the scratch database.
# The lock is a directory holding the owner's process id; mkdir makes taking
# it atomic. It sits under the home directory, not TMPDIR, so that two runs
# with different TMPDIR values still meet at the same lock.
#
# A lock whose owner is gone is taken over. Only its owner (on exit) and the
# run that holds the takeover directory may remove a lock. Without that
# second directory, two runs that both saw the dead owner could each remove
# "the stale lock", the second one removing the lock the first had just taken.
take_lock() {
  local locks="${HOME}/.cache/launch-db-pull" lock holder takeover
  mkdir -p "$locks" || die "could not create ${locks} for the lock."
  lock="${locks}/${TARGET_PORT}-${TARGET_DB}.lock"
  takeover="${lock}.takeover"
  if mkdir "$lock" 2>/dev/null; then
    LOCK_DIR="$lock"
    say "$$" >"${lock}/pid"
    return 0
  fi

  holder="$(lock_holder "$lock")"
  [ -n "$holder" ] ||
    die "another 'pnpm db:pull' seems to be starting on this database (${lock}). If none is running, remove that directory and try again."
  if kill -0 "$holder" 2>/dev/null; then
    die "another 'pnpm db:pull' (process ${holder}) is replacing this database. Wait for it to finish."
  fi

  mkdir "$takeover" 2>/dev/null ||
    die "another 'pnpm db:pull' is taking over the lock a dead run left (${takeover}). Try again; if none is running, remove that directory first."
  TAKEOVER_DIR="$takeover"
  # Read the owner again now that no other run can remove the lock: the one
  # read above may have been replaced since.
  if [ "$(lock_holder "$lock")" != "$holder" ]; then
    die "another 'pnpm db:pull' took the lock first. Wait for it to finish."
  fi
  rm -rf "$lock"
  mkdir "$lock" 2>/dev/null ||
    die "another 'pnpm db:pull' took the lock first. Wait for it to finish."
  LOCK_DIR="$lock"
  say "$$" >"${lock}/pid"
  rmdir "$takeover"
  TAKEOVER_DIR=""
}

# Prints the process id a lock directory names, or nothing when it names none
# (the owner has made the directory and not yet written the id).
lock_holder() {
  local holder
  holder="$(cat "${1}/pid" 2>/dev/null)" || holder=""
  case "$holder" in
    "" | *[!0-9]*) ;;
    *) say "$holder" ;;
  esac
}

find_ca_bundle() {
  local candidate
  for candidate in "${SSL_CERT_FILE:-}" /etc/ssl/cert.pem /etc/ssl/certs/ca-certificates.crt; do
    if [ -n "$candidate" ] && [ -r "$candidate" ]; then
      say "$candidate"
      return 0
    fi
  done
  return 1
}

check_target() {
  local major
  major="$(target_sql postgres --command "select current_setting('server_version_num')::int / 10000")" ||
    die "cannot connect to $(masked_target_url). Start the app's local database first."
  if [ "$major" != "$PG_MAJOR" ]; then
    die "the local server runs Postgres ${major}, and a dump of the source (Postgres ${PG_MAJOR}) needs Postgres ${PG_MAJOR}. Start a postgres:${PG_MAJOR} local database (the app's docker compose file), then try again."
  fi
  check_same_server
  say "Target $(masked_target_url) runs Postgres ${major}."
}

# The restore reaches the target through Docker, as host.docker.internal, and
# the app's after-script reaches it from this machine, as TARGET_HOST. Those can be
# two servers: host.docker.internal is the host's gateway address, not its
# loopback. Both ways must name the same server before anything is changed,
# or the copy would go to one and the migrations and admin to the other.
check_same_server() {
  local through_docker from_here
  through_docker="$(target_sql postgres --command "$SERVER_ID_SQL")" ||
    die "could not ask the server at $(masked_target_url) for its identity."
  from_here="$(cd "$APP_DIR" && PULL_DB_SERVER_URL="$TARGET_URL" node "${KIT_DIR}/server-id.mjs")" ||
    die "could not reach $(masked_target_url) from this machine to check that it is the server Docker restores into. If dependencies are missing, run 'pnpm install'."
  if [ -z "$through_docker" ] || [ "$through_docker" != "$from_here" ]; then
    die "refusing to run: Docker reaches a different Postgres server at ${CONTAINER_LOCALHOST}:${TARGET_PORT} than this machine reaches at ${TARGET_SERVER}. The restore would go to one and the app's after-script to the other."
  fi
}

check_pscale() {
  local roles leftovers
  roles="$(pscale_role list --format json)" ||
    die "pscale cannot list roles on ${PSCALE_DATABASE}/${PSCALE_BRANCH}. Run 'pscale auth login', and check your access to the ${PSCALE_ORG} organization."
  leftovers="$(
    # shellcheck disable=SC2016 # JavaScript template literal, not shell.
    printf '%s' "$roles" | node -e '
      let text = "";
      process.stdin.on("data", (chunk) => (text += chunk));
      process.stdin.on("end", () => {
        try {
          const roles = JSON.parse(text);
          if (!Array.isArray(roles)) return;
          process.stdout.write(
            roles
              .filter((role) => String(role.name).startsWith(process.argv[1]))
              .map((role) => `${role.name} (${role.id})`)
              .join(", ")
          );
        } catch {}
      });
    ' "${ROLE_PREFIX}-"
  )" || leftovers=""
  if [ -n "$leftovers" ]; then
    warn "PlanetScale already has ${ROLE_PREFIX} roles: ${leftovers}."
    warn "Each is another run in progress or a run that could not clean up. A leftover expires ${ROLE_TTL} after creation; delete it with 'pscale role delete ${PSCALE_DATABASE} ${PSCALE_BRANCH} <id> --org ${PSCALE_ORG} --force'."
  fi
}

create_role() {
  local role_json access_host
  # Set before the call: if the call is interrupted, the trap looks the role
  # up by this name.
  # Random characters too: time and process id can repeat on another
  # machine, and cleanup finds a role by this name when it has no id.
  local random
  random="$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n')"
  [ "${#random}" -eq 8 ] || die "could not read /dev/urandom for the role name."
  ROLE_NAME="${ROLE_PREFIX}-$(date -u +%Y%m%d%H%M%S)-$$-${random}"
  say "Creating PlanetScale role ${ROLE_NAME} (${ROLE_INHERITS}, expires in ${ROLE_TTL})..."
  role_json="$(pscale_role create "$ROLE_NAME" --inherited-roles "$ROLE_INHERITS" --ttl "$ROLE_TTL" --format json)" ||
    die "pscale could not create the role."

  ROLE_ID="$(printf '%s' "$role_json" | json_field id)" || ROLE_ID=""
  ROLE_USERNAME="$(printf '%s' "$role_json" | json_field username)" || ROLE_USERNAME=""
  ROLE_PASSWORD="$(printf '%s' "$role_json" | json_field password)" || ROLE_PASSWORD=""
  access_host="$(printf '%s' "$role_json" | json_field access_host_url)" || access_host=""
  role_json=""

  if [ -z "$ROLE_ID" ] || [ -z "$ROLE_USERNAME" ] || [ -z "$ROLE_PASSWORD" ] || [ -z "$access_host" ]; then
    die "pscale created the role but its answer lacks an id, username, password or host."
  fi

  case "$access_host" in
    *:*)
      SOURCE_HOST="${access_host%%:*}"
      SOURCE_PORT="${access_host##*:}"
      ;;
    *)
      SOURCE_HOST="$access_host"
      SOURCE_PORT="$SOURCE_DIRECT_PORT"
      ;;
  esac
  case "$SOURCE_HOST" in
    "" | *[!A-Za-z0-9.-]*) die "pscale reported an unexpected host for the role." ;;
  esac
  case "$SOURCE_PORT" in
    "" | *[!0-9]*) die "pscale reported an unexpected port for the role." ;;
  esac
}

# Waits until the new role can log in, then checks what it is connected to.
check_source() {
  local attempt answer="" major can_write rest
  for attempt in $(seq 1 "$ROLE_READY_ATTEMPTS"); do
    if answer="$(
      source_pg psql --no-psqlrc --quiet --tuples-only --no-align --field-separator ' ' \
        --set ON_ERROR_STOP=1 --command "
          select current_setting('server_version_num')::int / 10000,
                 (select rolsuper from pg_roles where rolname = current_user)
                 or coalesce((select bool_or(pg_has_role(current_user, oid, 'MEMBER'))
                              from pg_roles where rolname in ('pg_write_all_data', 'postgres')), false),
                 (select count(*) from pg_tables where schemaname = 'public')
        " 2>"${WORK_DIR}/source-error.txt"
    )"; then
      break
    fi
    answer=""
    [ "$attempt" -eq "$ROLE_READY_ATTEMPTS" ] || sleep 3
  done
  if [ -z "$answer" ]; then
    cat "${WORK_DIR}/source-error.txt" >&2
    die "the new role could not connect to ${SOURCE_HOST}:${SOURCE_PORT}."
  fi

  major="${answer%% *}"
  rest="${answer#* }"
  can_write="${rest%% *}"
  SOURCE_TABLES="${rest##* }"
  if [ "$can_write" != "f" ]; then
    die "the role is not read-only on PlanetScale. Stopping before the dump."
  fi
  if [ "$major" != "$PG_MAJOR" ]; then
    die "the source runs Postgres ${major}, and this run's clients are Postgres ${PG_MAJOR}. Update PG_MAJOR in db-pull.env and the local database to match."
  fi
  say "Connected to ${SOURCE_HOST}:${SOURCE_PORT} (Postgres ${major}) as a read-only role; ${SOURCE_TABLES} tables in public."
}

# Decides which tables' rows stay in PlanetScale: every table that is not in
# CONTENT_TABLES. Writes their names to left-out.txt, and to links.txt the
# foreign keys from a copied table to a left-out one, as lines of
# "<table> <column> <c or n>". Stops, before anything is dumped, when such a
# foreign key would not let the link be removed.
choose_tables() {
  local source_tables="${WORK_DIR}/source-tables.txt"
  local left_out="${WORK_DIR}/left-out.txt"
  local links="${WORK_DIR}/links.txt"
  local unclassified names table column action columns referenced

  table_list "$CONTENT_TABLES" >"${WORK_DIR}/content-tables.txt"
  source_pg psql --no-psqlrc --quiet --tuples-only --no-align --set ON_ERROR_STOP=1 \
    --command "select tablename from pg_tables where schemaname = 'public'" |
    LC_ALL=C sort >"$source_tables" ||
    die "could not list the source's tables. The local database is unchanged."
  [ -s "$source_tables" ] || die "the source has no tables in public. The local database is unchanged."
  check_table_names "$source_tables" "the source"

  LC_ALL=C comm -23 "$source_tables" "${WORK_DIR}/content-tables.txt" >"$left_out"
  LEFT_OUT_COUNT="$(wc -l <"$left_out" | tr -d ' ')"
  unclassified="$(table_list "$EXCLUDED_TABLES" | LC_ALL=C comm -23 "$left_out" -)"
  if [ -n "$unclassified" ]; then
    warn "the source has tables this script does not classify. Their rows are not copied:"
    printf '%s\n' "$unclassified" | sed 's/^/  /' >&2
    warn "Add each to db-pull.tables as content or excluded."
  fi

  : >"$links"
  if [ "$LEFT_OUT_COUNT" -eq 0 ]; then
    say "Every table of the source is on the content allowlist; nothing is left out."
    return 0
  fi
  names="$(paste -sd, "$left_out")"
  # One line per foreign key from a copied table to a left-out one: table,
  # column, ON DELETE action, number of columns in the key, and how many
  # foreign keys point at the table that holds it.
  source_pg psql --no-psqlrc --quiet --tuples-only --no-align --field-separator ' ' \
    --set ON_ERROR_STOP=1 --command "
      select r.relname, a.attname, c.confdeltype, array_length(c.conkey, 1),
             (select count(*) from pg_constraint p
              where p.contype = 'f' and p.confrelid = c.conrelid)
      from pg_constraint c
      join pg_class r on r.oid = c.conrelid
      join pg_class f on f.oid = c.confrelid
      join pg_namespace n on n.oid = r.relnamespace
      join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
      where c.contype = 'f' and n.nspname = 'public'
        and f.relname = any('{${names}}') and r.relname <> all('{${names}}')
      order by 1, 2
    " >"${WORK_DIR}/links-found.txt" ||
    die "could not list the source's foreign keys. The local database is unchanged."

  while read -r table column action columns referenced; do
    [ -n "$table" ] || continue
    printf '%s\n%s\n' "$table" "$column" >"${WORK_DIR}/link-names.txt"
    check_table_names "${WORK_DIR}/link-names.txt" "the source"
    if [ "$columns" != "1" ]; then
      die "cannot leave the excluded tables out: ${table} points at a left-out table with a foreign key of ${columns} columns, which this script cannot clear. The local database is unchanged."
    fi
    case "$action" in
      n) ;;
      c)
        if [ "$referenced" != "0" ]; then
          die "cannot leave the excluded tables out: the rows of ${table} that point at a left-out table (${column}) would have to be deleted, and other tables point at ${table}. Mark ${table} excluded in db-pull.tables, or change the foreign key. The local database is unchanged."
        fi
        ;;
      *)
        die "cannot leave the excluded tables out: ${table}.${column} points at a left-out table and is not ON DELETE CASCADE or SET NULL. The local database is unchanged."
        ;;
    esac
    say "$table $column $action" >>"$links"
  done <"${WORK_DIR}/links-found.txt"
  say "Leaving the rows of ${LEFT_OUT_COUNT} tables in PlanetScale."
}

dump_source() {
  say "Dumping ${PSCALE_DATABASE}/${PSCALE_BRANCH}..."
  # Payload keeps every table, type and sequence in `public`. PlanetScale adds
  # its own schema and extensions (pscale_extensions, hypopg) that a stock
  # Postgres cannot create, so the dump is limited to `public`.
  #
  # Definitions only: no rows of any table.
  source_pg pg_dump --format=custom --no-owner --no-privileges --schema=public \
    --schema-only >"${WORK_DIR}/schema.dump" ||
    die "pg_dump failed. The local database is unchanged."
  [ -s "${WORK_DIR}/schema.dump" ] || die "pg_dump wrote an empty dump. The local database is unchanged."

  # Rows, of the tables on the allowlist and no others. The list of tables
  # pg_dump may read comes from CONTENT_TABLES alone, never from what
  # the source holds at this moment: a supporter-data table created a second
  # ago is not named here, so its rows cannot be in the dump. A name that
  # the source does not have (a table of a migration it has not run) matches
  # nothing and is skipped. pg_dump adds the position of the id sequence each
  # named table owns.
  local tables=() name
  while IFS= read -r name; do
    tables+=("--table=public.${name}")
  done <"${WORK_DIR}/content-tables.txt"
  [ "${#tables[@]}" -gt 0 ] || die "db-pull.tables lists no content table. The local database is unchanged."
  source_pg pg_dump --format=custom --no-owner --no-privileges --data-only \
    "${tables[@]}" >"${WORK_DIR}/content.dump" ||
    die "pg_dump failed. The local database is unchanged."
  [ -s "${WORK_DIR}/content.dump" ] || die "pg_dump wrote an empty dump. The local database is unchanged."
  say "Dump complete ($(cat "${WORK_DIR}/schema.dump" "${WORK_DIR}/content.dump" | wc -c | tr -d ' ') bytes)."
}

restore_target() {
  local restored
  say "Restoring into \"${SCRATCH_DB}\"..."
  # From here until the swap is done, the exit trap reports where the data is
  # and drops an unfinished scratch database.
  DATA_STATE="scratch"
  target_sql postgres \
    --command "drop database if exists \"${SCRATCH_DB}\" with (force)" \
    --command "create database \"${SCRATCH_DB}\"" ||
    die "could not create the scratch database. The local database is unchanged."
  # A dump of one schema starts with CREATE SCHEMA, and a new database
  # already has an empty `public`.
  target_sql "$SCRATCH_DB" --command "drop schema public" ||
    die "could not empty the scratch database. The local database is unchanged."
  # Tables first, then rows, without foreign keys: some rows link to rows that
  # were not copied. Those links go, and then the foreign keys can be made.
  target_pg "$SCRATCH_DB" pg_restore --no-owner --no-privileges --exit-on-error \
    --section=pre-data \
    --dbname="$SCRATCH_DB" <"${WORK_DIR}/schema.dump" ||
    die "pg_restore failed. The local database is unchanged."
  target_pg "$SCRATCH_DB" pg_restore --no-owner --no-privileges --exit-on-error \
    --data-only \
    --dbname="$SCRATCH_DB" <"${WORK_DIR}/content.dump" ||
    die "pg_restore failed. The local database is unchanged."
  remove_links_to_left_out_rows
  target_pg "$SCRATCH_DB" pg_restore --no-owner --no-privileges --exit-on-error \
    --section=post-data \
    --dbname="$SCRATCH_DB" <"${WORK_DIR}/schema.dump" ||
    die "pg_restore could not add the indexes and foreign keys. The local database is unchanged."

  restored="$(target_sql "$SCRATCH_DB" --command "select count(*) from pg_tables where schemaname = 'public'")" || restored=""
  if [ "$restored" != "$SOURCE_TABLES" ]; then
    die "restored ${restored:-no} tables, but the source has ${SOURCE_TABLES}. The local database is unchanged."
  fi
  say "Restored ${restored} tables."
}

# In the scratch database, between the rows and the foreign keys: removes
# every link from a copied table to a left-out one (links.txt). The left-out
# table is empty, so every such link points at nothing. An ON DELETE CASCADE
# key means the linking row goes, as it would if the row it names were
# deleted; SET NULL means the column is emptied.
remove_links_to_left_out_rows() {
  local commands=() table column action
  while read -r table column action; do
    if [ "$action" = "c" ]; then
      commands+=(--command "delete from \"${table}\" where \"${column}\" is not null")
    else
      commands+=(--command "update \"${table}\" set \"${column}\" = null where \"${column}\" is not null")
    fi
  done <"${WORK_DIR}/links.txt"
  [ "${#commands[@]}" -gt 0 ] || return 0
  target_sql "$SCRATCH_DB" --single-transaction "${commands[@]}" ||
    die "could not remove the links to rows that were not copied. The local database is unchanged."
}

# The last check before the swap: every table of the scratch database that is
# not in CONTENT_TABLES must be empty. It reads the scratch database itself,
# so it also catches a dump that held rows it should not have.
check_only_content() {
  local restored_tables="${WORK_DIR}/restored-tables.txt"
  local name sql="" holding
  target_sql "$SCRATCH_DB" --command "select tablename from pg_tables where schemaname = 'public'" |
    LC_ALL=C sort >"$restored_tables" ||
    die "could not list the tables of the copy. The local database is unchanged."
  check_table_names "$restored_tables" "the copy"
  while IFS= read -r name; do
    sql="${sql:+${sql} union all }select '${name}' where exists (select 1 from \"${name}\")"
  done < <(LC_ALL=C comm -23 "$restored_tables" "${WORK_DIR}/content-tables.txt")
  if [ -z "$sql" ]; then
    return 0
  fi
  holding="$(target_sql "$SCRATCH_DB" --command "$sql")" ||
    die "could not check that the left-out tables are empty in the copy. The local database is unchanged."
  if [ -n "$holding" ]; then
    die "the copy holds rows in tables that must be empty: $(printf '%s' "$holding" | tr '\n' ' '). The local database is unchanged."
  fi
  say "Checked: the copy holds rows in content tables only."
}

# Puts the scratch database in the target's place without a moment where the
# only copy of either is gone: the target is renamed aside, the scratch one
# renamed in, and only then is the old one dropped. Returns 1 when the swap
# worked but the old database could not be dropped.
swap_target() {
  local target_exists
  say "Replacing \"${TARGET_DB}\"..."
  target_exists="$(target_sql postgres --command "select count(*) from pg_database where datname = '${TARGET_DB}'")" ||
    die "could not look up \"${TARGET_DB}\". The local database is unchanged."

  DATA_STATE="swap"
  if [ "$target_exists" != "0" ]; then
    # An old database beside a target is one an earlier run could not drop
    # after its swap: the target has replaced it. With no target, the old
    # database is the developer's own, left by a run that stopped between the
    # two renames, so it stays until the copy has the target's name.
    target_sql postgres --command "drop database if exists \"${OLD_DB}\" with (force)" ||
      die "could not drop \"${OLD_DB}\", left by an earlier run. The local database is unchanged."
    # A database with a session open cannot be renamed.
    target_sql postgres \
      --command "select pg_terminate_backend(pid) from pg_stat_activity where datname = '${TARGET_DB}' and pid <> pg_backend_pid()" \
      --command "alter database \"${TARGET_DB}\" rename to \"${OLD_DB}\"" >/dev/null ||
      die "could not move \"${TARGET_DB}\" aside. Stop whatever is connected to it ('pnpm dev'), then run again."
  fi
  if ! target_sql postgres --command "alter database \"${SCRATCH_DB}\" rename to \"${TARGET_DB}\""; then
    if [ "$target_exists" != "0" ]; then
      target_sql postgres --command "alter database \"${OLD_DB}\" rename to \"${TARGET_DB}\"" || true
    fi
    die "could not move the restored database into place."
  fi
  DATA_STATE="installed"
  if ! target_sql postgres --command "drop database if exists \"${OLD_DB}\" with (force)"; then
    warn "\"${TARGET_DB}\" is now the copy of the source, but your previous local database could not be dropped. It is in \"${OLD_DB}\". If an earlier 'pnpm db:pull' filled it, it holds copied data too: drop it yourself, or run 'pnpm db:pull' again, which drops it first."
    return 1
  fi
  say "\"${TARGET_DB}\" is now the copy of the source."
}

# Runs the app's after-script against the new copy. It gets the target in
# PULL_DB_TARGET_URL (in the environment, never as an argument: the URL holds
# the local password) and PULL_DB_MIGRATE=1 for --migrate.
run_after_script() {
  [ -n "$AFTER_SCRIPT" ] || return 0
  say ""
  say "Running ${AFTER_SCRIPT} against $(masked_target_url)..."
  (
    cd "$APP_DIR" &&
      PULL_DB_TARGET_URL="$TARGET_URL" PULL_DB_MIGRATE="$MIGRATE" \
        node "$AFTER_SCRIPT" </dev/null
  )
}

main() {
  local list=0
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --dry-run) DRY_RUN=1 ;;
      --migrate) MIGRATE=1 ;;
      --list-tables) list=1 ;;
      --branch)
        [ "$#" -gt 1 ] || {
          usage >&2
          exit 2
        }
        BRANCH_OPTION="$2"
        shift
        ;;
      -h | --help)
        usage
        exit 0
        ;;
      *)
        usage >&2
        exit 2
        ;;
    esac
    shift
  done

  load_config
  load_tables
  if [ "$list" -eq 1 ]; then
    list_tables
    exit 0
  fi

  command -v node >/dev/null 2>&1 || die "'node' is not installed or not on PATH."
  read_target

  if [ "$DRY_RUN" -eq 1 ]; then
    print_plan
    exit 0
  fi

  say "$STOP_DEV_NOTE"
  check_tools
  local ca_bundle
  ca_bundle="$(find_ca_bundle)" ||
    die "no CA bundle found to verify PlanetScale's certificate. Set SSL_CERT_FILE to one."

  # Copies of stdout and stderr for the exit trap.
  exec 3>&1 4>&2
  trap cleanup EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  trap 'exit 129' HUP
  umask 077
  take_lock
  local tmp="${TMPDIR:-/tmp}"
  # The dump goes here: only this user may enter it.
  WORK_DIR="$(mktemp -d "${tmp%/}/db-pull.XXXXXX")"
  # The CA bundle is public and the client in the container, which runs as
  # another user, must read it. It gets a directory of its own so the one
  # above can stay closed.
  CA_DIR="$(mktemp -d "${tmp%/}/db-pull-ca.XXXXXX")"
  cp "$ca_bundle" "${CA_DIR}/ca.pem"
  chmod 755 "$CA_DIR"
  chmod 644 "${CA_DIR}/ca.pem"

  check_target
  check_pscale
  create_role
  check_source
  choose_tables
  dump_source
  delete_role || die "the dump is done but the role is still there. The local database is unchanged."
  restore_target
  check_only_content
  local status=0
  swap_target || status=1

  if ! run_after_script; then
    warn "${AFTER_SCRIPT} failed; see the output above. The copy is in place, but the app's local steps (such as its local admin) may not have run."
    status=1
  fi

  say ""
  if [ "$status" -eq 0 ]; then
    say "Done. \"${TARGET_DB}\" is a copy of ${PSCALE_DATABASE}/${PSCALE_BRANCH}'s content."
  else
    say "The data is restored, but see the warnings above."
  fi
  say "${COPY_NOTE} $(how_to_delete "$TARGET_DB")"
  # The run has said all of it; the exit trap need not repeat where the data is.
  DATA_STATE=""
  exit "$status"
}

main "$@"
