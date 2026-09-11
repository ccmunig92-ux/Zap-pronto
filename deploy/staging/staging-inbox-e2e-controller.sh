#!/bin/sh
set -eu
set -f
umask 077

COMPOSE_FILE=/srv/zap-pronto/app/deploy/staging/compose.yaml
ENV_FILE=/srv/zap-pronto/secrets/staging/compose.env
CONFIG_FILE=/srv/zap-pronto/secrets/staging/inbox-e2e.json

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
for file in "$COMPOSE_FILE" "$ENV_FILE" "$CONFIG_FILE"; do
  [ -f "$file" ] && [ ! -L "$file" ] || fail
done
[ "$(stat -c '%u:%a' "$CONFIG_FILE")" = "0:400" ] || fail

exec docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" run --rm --no-deps --user 0:0 \
  -e INBOX_E2E_CONFIG_FILE=/run/secrets/inbox_e2e_config \
  -v "$CONFIG_FILE:/run/secrets/inbox_e2e_config:ro" \
  migrate node scripts/staging-inbox-e2e-fixture.mjs "--$action" "$run_key"
