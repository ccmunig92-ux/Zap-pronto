#!/bin/sh
set -eu

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
compose_file="$repo_root/deploy/staging/compose.yaml"
env_file="$repo_root/deploy/staging/.env.example"
work_dir=$(mktemp -d)
secret_dir="$work_dir/secrets"
backup_dir="$work_dir/backups"
project="zap-pronto-backup-smoke-$$"

cleanup() {
  status=$?
  if [ "$status" -ne 0 ]; then
    docker compose --project-name "$project" --env-file "$env_file" --file "$compose_file" ps --all >&2 || true
    docker compose --project-name "$project" --env-file "$env_file" --file "$compose_file" logs --no-color >&2 || true
  fi
  docker compose --project-name "$project" --env-file "$env_file" --file "$compose_file" \
    down --volumes --remove-orphans >/dev/null 2>&1 || true
  rm -rf -- "$work_dir"
  trap - EXIT
  exit "$status"
}
trap cleanup EXIT INT TERM
mkdir -m 700 "$secret_dir" "$backup_dir"
printf '%s' owner-backup-smoke > "$secret_dir/postgres-password"
printf '%s' 'postgresql://zap_pronto_owner:owner-backup-smoke@postgres:5432/zap_pronto' \
  > "$secret_dir/database-migration-url"
printf '%s' 'postgresql://zap_pronto_runtime:runtime-backup-smoke@postgres:5432/zap_pronto' \
  > "$secret_dir/database-runtime-url"
printf '%s' 'postgresql://zap_pronto_worker_runtime:worker-backup-smoke@postgres:5432/zap_pronto' \
  > "$secret_dir/database-worker-url"
chmod 644 "$secret_dir"/*

export ZAP_API_IMAGE=${ZAP_API_IMAGE:-zap-pronto-api:ci}
export ZAP_WEB_IMAGE=${ZAP_WEB_IMAGE:-zap-pronto-web:ci}
export POSTGRES_PASSWORD_FILE="$secret_dir/postgres-password"
export DATABASE_MIGRATION_URL_FILE="$secret_dir/database-migration-url"
export DATABASE_RUNTIME_URL_FILE="$secret_dir/database-runtime-url"
export DATABASE_WORKER_URL_FILE="$secret_dir/database-worker-url"
export STAGING_HTTP_PORT=${STAGING_HTTP_PORT:-18081}
export STAGING_COMPOSE_PROJECT="$project"
export STAGING_COMPOSE_FILE="$compose_file"
export STAGING_ENV_FILE="$env_file"
export STAGING_BACKUP_DIR="$backup_dir"
export STAGING_BACKUP_RETENTION_DAYS=1

compose() { docker compose --project-name "$project" --env-file "$env_file" --file "$compose_file" "$@"; }
compose up --detach --wait --wait-timeout 180 api
compose exec -T postgres psql --username zap_pronto_owner --dbname zap_pronto --set ON_ERROR_STOP=1 \
  --command "INSERT INTO tenants(id,name) VALUES ('71000000-0000-4000-8000-000000000001','backup-smoke-marker');"

bundle=$(sh "$repo_root/scripts/staging-backup.sh")
[ -s "$bundle/data.dump" ]
(cd "$bundle" && sha256sum --check --strict bundle.sha256)

assert_marker() {
  compose exec -T postgres psql --username zap_pronto_owner --dbname zap_pronto \
    --tuples-only --no-align --command \
    "SELECT name FROM tenants WHERE id='71000000-0000-4000-8000-000000000001';" \
    | grep -qx backup-smoke-marker
}
assert_api_running() {
  container=$(compose ps --quiet api)
  [ -n "$container" ] && [ "$(docker inspect --format '{{.State.Running}}' "$container")" = true ]
}

# Todas estas falhas acontecem antes do stop e devem deixar aplicação/dados intocados.
export ALLOW_STAGING_RESTORE=yes
export STAGING_RESTORE_CONFIRM=wrong-project
! sh "$repo_root/scripts/staging-backup-restore.sh" "$bundle" >/dev/null 2>&1
assert_api_running; assert_marker

checksum_bundle="$work_dir/checksum-invalid"
cp -R "$bundle" "$checksum_bundle"
printf 'tamper' >> "$checksum_bundle/data.dump"
export STAGING_RESTORE_CONFIRM="$project"
! sh "$repo_root/scripts/staging-backup-restore.sh" "$checksum_bundle" >/dev/null 2>&1
assert_api_running; assert_marker

toc_bundle="$work_dir/toc-invalid"
cp -R "$bundle" "$toc_bundle"
printf '%s\n' '99999; 0 0 TABLE DATA public schema_migrations zap_pronto_owner' >> "$toc_bundle/toc.list"
(cd "$toc_bundle" && sha256sum data.dump toc.list manifest.txt > bundle.sha256)
! sh "$repo_root/scripts/staging-backup-restore.sh" "$toc_bundle" >/dev/null 2>&1
assert_api_running; assert_marker

# Bundle válido contra alvo ocupado deve parar a app, rejeitar antes do pg_restore e preservar os dados.
! sh "$repo_root/scripts/staging-backup-restore.sh" "$bundle" >/dev/null 2>&1
assert_marker
compose up --detach --wait api

compose down --volumes --remove-orphans
export STAGING_RESTORE_START_APPLICATION=no
sh "$repo_root/scripts/staging-backup-restore.sh" "$bundle"
compose up --detach --wait api

compose exec -T postgres psql --username zap_pronto_owner --dbname zap_pronto \
  --tuples-only --no-align --command \
  "SELECT name FROM tenants WHERE id='71000000-0000-4000-8000-000000000001';" \
  | grep -qx backup-smoke-marker
compose exec -T api node -e \
  "fetch('http://127.0.0.1:3000/health/ready').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
printf 'staging backup restore smoke passed\n'
