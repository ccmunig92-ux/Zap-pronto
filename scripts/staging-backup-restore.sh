#!/bin/sh
set -eu

[ "${ALLOW_STAGING_RESTORE:-}" = yes ] || { echo "ALLOW_STAGING_RESTORE_REQUIRED" >&2; exit 1; }
[ "$#" -eq 1 ] || { echo "USAGE: staging-backup-restore.sh BUNDLE" >&2; exit 1; }
bundle=$1
[ -d "$bundle" ] && [ ! -L "$bundle" ] || { echo "RESTORE_BUNDLE_INVALID" >&2; exit 1; }
bundle=$(CDPATH= cd -- "$bundle" && pwd)
archive="$bundle/data.dump"
[ -f "$archive" ] && [ ! -L "$archive" ] || { echo "RESTORE_ARCHIVE_INVALID" >&2; exit 1; }
[ -f "$bundle/data.dump.sha256" ] || { echo "RESTORE_CHECKSUM_MISSING" >&2; exit 1; }
(cd "$bundle" && sha256sum --check --strict data.dump.sha256)

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
compose_file=${STAGING_COMPOSE_FILE:-$repo_root/deploy/staging/compose.yaml}
env_file=${STAGING_ENV_FILE:-$repo_root/deploy/staging/.env.example}
project=${STAGING_COMPOSE_PROJECT:-zap-pronto-staging}
[ "${STAGING_RESTORE_CONFIRM:-}" = "$project" ] || { echo "STAGING_RESTORE_CONFIRM_MISMATCH" >&2; exit 1; }
compose() { docker compose --project-name "$project" --env-file "$env_file" --file "$compose_file" "$@"; }

compose stop web api >/dev/null 2>&1 || true
compose up --detach --wait postgres
compose run --rm --no-deps migrate

compose exec -T postgres psql --username "${POSTGRES_USER:-zap_pronto_owner}" \
  --dbname "${POSTGRES_DB:-zap_pronto}" --set ON_ERROR_STOP=1 <<'SQL'
DO $empty_check$
DECLARE target record; row_found boolean;
BEGIN
  FOR target IN SELECT schemaname, tablename FROM pg_tables
    WHERE schemaname = 'public'
      AND tablename NOT IN ('schema_migrations', 'app_roles', 'app_permissions', 'app_role_permissions')
  LOOP
    EXECUTE format('SELECT EXISTS (SELECT 1 FROM %I.%I LIMIT 1)', target.schemaname, target.tablename)
      INTO row_found;
    IF row_found THEN RAISE EXCEPTION 'RESTORE_TARGET_NOT_EMPTY: %.%', target.schemaname, target.tablename; END IF;
  END LOOP;
END
$empty_check$;
SQL

compose exec -T postgres pg_restore --username "${POSTGRES_USER:-zap_pronto_owner}" \
  --dbname "${POSTGRES_DB:-zap_pronto}" --data-only --disable-triggers --exit-on-error < "$archive"
compose run --rm --no-deps provision-runtime
if [ "${STAGING_RESTORE_START_APPLICATION:-yes}" = yes ]; then
  compose up --detach --wait api web
fi
printf 'staging restore completed\n'
