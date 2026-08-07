#!/bin/sh
set -eu

[ "${ALLOW_STAGING_RESTORE:-}" = yes ] || { echo "ALLOW_STAGING_RESTORE_REQUIRED" >&2; exit 1; }
[ "$#" -eq 1 ] || { echo "USAGE: staging-backup-restore.sh BUNDLE" >&2; exit 1; }
bundle=$1
[ -d "$bundle" ] && [ ! -L "$bundle" ] || { echo "RESTORE_BUNDLE_INVALID" >&2; exit 1; }
bundle=$(CDPATH= cd -- "$bundle" && pwd)
archive="$bundle/data.dump"
[ -f "$archive" ] && [ ! -L "$archive" ] || { echo "RESTORE_ARCHIVE_INVALID" >&2; exit 1; }
[ -f "$bundle/toc.list" ] && [ ! -L "$bundle/toc.list" ] || { echo "RESTORE_TOC_INVALID" >&2; exit 1; }
[ -f "$bundle/manifest.txt" ] && [ ! -L "$bundle/manifest.txt" ] || { echo "RESTORE_MANIFEST_INVALID" >&2; exit 1; }
[ -f "$bundle/bundle.sha256" ] && [ ! -L "$bundle/bundle.sha256" ] || { echo "RESTORE_CHECKSUM_MISSING" >&2; exit 1; }
(cd "$bundle" && sha256sum --check --strict bundle.sha256)

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
compose_file=${STAGING_COMPOSE_FILE:-$repo_root/deploy/staging/compose.yaml}
env_file=${STAGING_ENV_FILE:-$repo_root/deploy/staging/.env.example}
project=${STAGING_COMPOSE_PROJECT:-zap-pronto-staging}
[ "${STAGING_RESTORE_CONFIRM:-}" = "$project" ] || { echo "STAGING_RESTORE_CONFIRM_MISMATCH" >&2; exit 1; }
compose() { docker compose --project-name "$project" --env-file "$env_file" --file "$compose_file" "$@"; }

expected_migrations=$(mktemp)
actual_migrations=$(mktemp)
cleanup_validation() { rm -f -- "$expected_migrations" "$actual_migrations"; }
trap cleanup_validation EXIT INT TERM
for migration in "$repo_root"/database/migrations/*.sql; do
  [ -f "$migration" ] || { echo "RESTORE_MIGRATIONS_MISSING" >&2; exit 1; }
  checksum=$(sha256sum "$migration" | awk '{print $1}')
  printf 'migration=%s|%s\n' "$(basename "$migration")" "$checksum" >> "$expected_migrations"
done
grep '^migration=' "$bundle/manifest.txt" > "$actual_migrations" || true
grep -Eq '^created_at_utc=[0-9]{8}T[0-9]{6}Z$' "$bundle/manifest.txt" || { echo "RESTORE_MANIFEST_INVALID" >&2; exit 1; }
grep -Eq '^compose_project=[A-Za-z0-9][A-Za-z0-9_.-]*$' "$bundle/manifest.txt" || { echo "RESTORE_MANIFEST_INVALID" >&2; exit 1; }
grep -Eq '^database=[A-Za-z_][A-Za-z0-9_]*$' "$bundle/manifest.txt" || { echo "RESTORE_MANIFEST_INVALID" >&2; exit 1; }
[ "$(wc -l < "$bundle/manifest.txt")" -eq "$((3 + $(wc -l < "$actual_migrations")))" ] \
  || { echo "RESTORE_MANIFEST_UNKNOWN_FIELDS" >&2; exit 1; }
cmp -s "$expected_migrations" "$actual_migrations" || { echo "RESTORE_MIGRATION_CHECKSUM_MISMATCH" >&2; exit 1; }
grep -Eq ' (TABLE DATA|SEQUENCE SET) public (schema_migrations|app_roles|app_permissions|app_role_permissions) ' \
  "$bundle/toc.list" && { echo "RESTORE_TOC_FORBIDDEN_SEED" >&2; exit 1; }
invalid_toc=$(grep -Ev '^(;.*|$|[0-9]+; [0-9]+ [0-9]+ (TABLE DATA|SEQUENCE SET) public [A-Za-z_][A-Za-z0-9_]* .+)$' \
  "$bundle/toc.list" || true)
if [ -n "$invalid_toc" ]; then
  printf '%s\n' "$invalid_toc" | head -n 1 >&2
  echo "RESTORE_TOC_ENTRY_NOT_ALLOWED" >&2
  exit 1
fi
cleanup_validation
trap - EXIT INT TERM

compose stop web api
for service in web api; do
  container=$(compose ps --all --quiet "$service")
  if [ -n "$container" ] && [ "$(docker inspect --format '{{.State.Running}}' "$container")" != false ]; then
    echo "RESTORE_APPLICATION_STILL_RUNNING:$service" >&2
    exit 1
  fi
done
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
