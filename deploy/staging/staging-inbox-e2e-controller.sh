#!/bin/sh
set -eu
set -f
umask 077

COMPOSE_FILE=/srv/zap-pronto/app/deploy/staging/compose.yaml
ENV_FILE=/srv/zap-pronto/secrets/staging/compose.env
CONFIG_FILE=/srv/zap-pronto/secrets/staging/inbox-e2e.json
MIGRATION_SECRET_FILE=/srv/zap-pronto/secrets/staging/database-migration-url
RUNTIME_DIRECTORY=/run/zap-pronto-staging-inbox-e2e
temporary_migration_secret=

cleanup() {
  if [ -n "$temporary_migration_secret" ]; then
    rm -f -- "$temporary_migration_secret"
  fi
}
trap cleanup 0
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

fail() {
  echo STAGING_INBOX_E2E_CONTROLLER_FAILED >&2
  exit 1
}

if [ -n "${SSH_ORIGINAL_COMMAND:-}" ]; then
  [ "$#" -eq 0 ] || fail
  old_ifs=$IFS
  IFS=' '
  # Globbing is disabled and both resulting tokens are strictly allow-listed below.
  set -- $SSH_ORIGINAL_COMMAND
  IFS=$old_ifs
fi

[ "$#" -eq 2 ] || fail
action=$1
run_key=$2
case "$action" in prepare|verify|cleanup) ;; *) fail ;; esac
case "$run_key" in
  *[!0-9-]*|*-*-*|-*|*-) fail ;;
esac
run_id=${run_key%-*}
run_attempt=${run_key##*-}
case "$run_id" in ''|*[!0-9]*) fail ;; esac
case "$run_attempt" in ''|0|0*|*[!0-9]*) fail ;; esac
[ "${#run_id}" -le 20 ] && [ "${#run_attempt}" -le 6 ] || fail

[ "$(id -u)" -eq 0 ] || fail
for file in "$COMPOSE_FILE" "$ENV_FILE" "$CONFIG_FILE" "$MIGRATION_SECRET_FILE"; do
  [ -f "$file" ] && [ ! -L "$file" ] || fail
done
[ "$(stat -c '%u:%a' "$CONFIG_FILE")" = "0:400" ] || fail
[ "$(stat -c '%u:%g:%a' "$MIGRATION_SECRET_FILE")" = "1000:1000:400" ] || fail

[ ! -L "$RUNTIME_DIRECTORY" ] || fail
install -d -o root -g root -m 0700 "$RUNTIME_DIRECTORY"
[ "$(stat -c '%u:%g:%a' "$RUNTIME_DIRECTORY")" = "0:0:700" ] || fail
temporary_migration_secret=$(mktemp "$RUNTIME_DIRECTORY/database-migration-url.XXXXXX")
install -o root -g root -m 0400 "$MIGRATION_SECRET_FILE" "$temporary_migration_secret"
[ "$(stat -c '%u:%g:%a' "$temporary_migration_secret")" = "0:0:400" ] || fail

docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" run --rm --no-deps --user 0:0 \
  -e INBOX_E2E_CONFIG_FILE=/run/secrets/inbox_e2e_config \
  -v "$CONFIG_FILE:/run/secrets/inbox_e2e_config:ro" \
  -v "$temporary_migration_secret:/run/secrets/database_migration_url:ro" \
  migrate node scripts/staging-inbox-e2e-fixture.mjs "--$action" "$run_key"
