#!/bin/sh
set -eu
umask 077

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
repo_root=$(CDPATH= cd -- "$repo_root" && pwd -P)
compose_file=${STAGING_COMPOSE_FILE:-$repo_root/deploy/staging/compose.yaml}
env_file=${STAGING_ENV_FILE:-$repo_root/deploy/staging/.env.example}
project=${STAGING_COMPOSE_PROJECT:-zap-pronto-staging}
backup_root=${STAGING_BACKUP_DIR:?STAGING_BACKUP_DIR absolute path required}
retention=${STAGING_BACKUP_RETENTION_DAYS:-14}

case "$backup_root" in /*) ;; *) echo "STAGING_BACKUP_DIR_ABSOLUTE_REQUIRED" >&2; exit 1;; esac
case "$retention" in ''|*[!0-9]*) echo "STAGING_BACKUP_RETENTION_DAYS_INVALID" >&2; exit 1;; esac
[ "$retention" -ge 1 ] || { echo "STAGING_BACKUP_RETENTION_DAYS_INVALID" >&2; exit 1; }
assert_no_symlink_path() {
  candidate=$1
  current=/
  old_ifs=$IFS
  IFS=/
  set -f
  # shellcheck disable=SC2086 -- divisão intencional apenas por '/'.
  set -- $candidate
  set +f
  IFS=$old_ifs
  for component do
    [ -n "$component" ] || continue
    current=${current%/}/$component
    [ ! -L "$current" ] || { echo "STAGING_BACKUP_DIR_SYMLINK_REJECTED" >&2; exit 1; }
  done
}
assert_no_symlink_path "$backup_root"
case "$backup_root/" in "$repo_root/"*) echo "STAGING_BACKUP_DIR_INSIDE_REPOSITORY" >&2; exit 1;; esac
case "$repo_root/" in "$backup_root/"*) echo "STAGING_BACKUP_DIR_REPOSITORY_ANCESTOR" >&2; exit 1;; esac
mkdir -p "$backup_root"
backup_root=$(CDPATH= cd -- "$backup_root" && pwd -P)
case "$backup_root" in /) echo "STAGING_BACKUP_DIR_UNSAFE" >&2; exit 1;; esac
case "$backup_root/" in "$repo_root/"*) echo "STAGING_BACKUP_DIR_INSIDE_REPOSITORY" >&2; exit 1;; esac
case "$repo_root/" in "$backup_root/"*) echo "STAGING_BACKUP_DIR_REPOSITORY_ANCESTOR" >&2; exit 1;; esac
chmod 700 "$backup_root"

stamp=$(date -u +%Y%m%dT%H%M%SZ)
bundle="$backup_root/zap-pronto-$stamp"
temporary="$backup_root/.zap-pronto-$stamp.tmp-$$"
[ ! -e "$bundle" ] || { echo "BACKUP_BUNDLE_ALREADY_EXISTS" >&2; exit 1; }
mkdir -m 700 "$temporary"
temporary=$(CDPATH= cd -- "$temporary" && pwd -P)
case "$temporary" in "$backup_root"/.zap-pronto-*.tmp-*) ;; *) echo "BACKUP_TEMPORARY_PATH_UNSAFE" >&2; exit 1;; esac
cleanup() {
  case "$temporary" in "$backup_root"/.zap-pronto-*.tmp-*)
    [ ! -L "$temporary" ] && rm -rf -- "$temporary" ;;
  esac
}
trap cleanup EXIT INT TERM

compose() { docker compose --project-name "$project" --env-file "$env_file" --file "$compose_file" "$@"; }
compose exec -T postgres pg_dump --username "${POSTGRES_USER:-zap_pronto_owner}" \
  --dbname "${POSTGRES_DB:-zap_pronto}" --format=custom --compress=9 --data-only \
  --exclude-table-data=public.schema_migrations \
  --exclude-table-data=public.app_roles \
  --exclude-table-data=public.app_permissions \
  --exclude-table-data=public.app_role_permissions > "$temporary/data.dump"
[ -s "$temporary/data.dump" ] || { echo "BACKUP_ARCHIVE_EMPTY" >&2; exit 1; }
compose exec -T postgres pg_restore --list < "$temporary/data.dump" >/dev/null
(cd "$temporary" && sha256sum data.dump > data.dump.sha256)
{
  printf 'created_at_utc=%s\n' "$stamp"
  printf 'compose_project=%s\n' "$project"
  printf 'database=%s\n' "${POSTGRES_DB:-zap_pronto}"
  compose exec -T postgres psql --username "${POSTGRES_USER:-zap_pronto_owner}" \
    --dbname "${POSTGRES_DB:-zap_pronto}" --tuples-only --no-align --field-separator='|' \
    --command "SELECT 'migration=' || filename || '|' || checksum_sha256 FROM schema_migrations ORDER BY filename;"
} > "$temporary/manifest.txt"
chmod 600 "$temporary"/*
mv -- "$temporary" "$bundle"
bundle=$(CDPATH= cd -- "$bundle" && pwd -P)
case "$bundle" in "$backup_root"/zap-pronto-*) ;; *) echo "BACKUP_BUNDLE_PATH_UNSAFE" >&2; exit 1;; esac
trap - EXIT INT TERM

# Executado somente após promoção atômica; o padrão não alcança diretórios temporários.
find "$backup_root" -mindepth 1 -maxdepth 1 -type d -name 'zap-pronto-[0-9]*T[0-9]*Z' \
  -mtime "+$retention" -exec rm -rf -- {} +
printf '%s\n' "$bundle"
