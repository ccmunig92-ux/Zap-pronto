#!/bin/sh
set -eu

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
compose_file="$repo_root/deploy/staging/compose.yaml"
env_file="$repo_root/deploy/staging/.env.example"
secret_dir=$(mktemp -d)
project_name="zap-pronto-smoke-$$"

cleanup() {
  status=$?
  if [ "$status" -ne 0 ]; then
    docker compose --project-name "$project_name" --env-file "$env_file" \
      --file "$compose_file" ps --all >&2 || true
    docker compose --project-name "$project_name" --env-file "$env_file" \
      --file "$compose_file" logs --no-color >&2 || true
  fi
  docker compose --project-name "$project_name" --env-file "$env_file" \
    --file "$compose_file" down --volumes --remove-orphans >/dev/null 2>&1 || true
  rm -rf "$secret_dir"
  trap - EXIT
  exit "$status"
}
trap cleanup EXIT INT TERM

chmod 700 "$secret_dir"
printf '%s' 'owner-smoke-password' > "$secret_dir/postgres-password"
printf '%s' 'postgresql://zap_pronto_owner:owner-smoke-password@postgres:5432/zap_pronto' \
  > "$secret_dir/database-migration-url"
printf '%s' 'postgresql://zap_pronto_runtime:runtime-smoke-password@postgres:5432/zap_pronto' \
  > "$secret_dir/database-runtime-url"
chmod 600 "$secret_dir"/*

export ZAP_API_IMAGE=${ZAP_API_IMAGE:-zap-pronto-api:ci}
export ZAP_WEB_IMAGE=${ZAP_WEB_IMAGE:-zap-pronto-web:ci}
export POSTGRES_PASSWORD_FILE="$secret_dir/postgres-password"
export DATABASE_MIGRATION_URL_FILE="$secret_dir/database-migration-url"
export DATABASE_RUNTIME_URL_FILE="$secret_dir/database-runtime-url"
export STAGING_HTTP_PORT=${STAGING_HTTP_PORT:-18080}

compose() {
  docker compose --project-name "$project_name" --env-file "$env_file" --file "$compose_file" "$@"
}

compose up --detach --wait --wait-timeout 180
curl --fail --silent --show-error "http://127.0.0.1:$STAGING_HTTP_PORT/health/web" | grep -q '"status":"ok"'
curl --fail --silent --show-error "http://127.0.0.1:$STAGING_HTTP_PORT/health/live" | grep -q '"status":"ok"'

compose exec -T postgres psql --username zap_pronto_owner --dbname zap_pronto \
  --set ON_ERROR_STOP=1 --tuples-only --no-align --command \
  "SELECT admin_option::int || ':' || inherit_option::int || ':' || set_option::int
     FROM pg_auth_members m
     JOIN pg_roles parent ON parent.oid = m.roleid
     JOIN pg_roles member ON member.oid = m.member
    WHERE parent.rolname = 'zap_pronto_api' AND member.rolname = 'zap_pronto_runtime';" \
  | grep -qx '0:0:1'

compose exec -T --env PGPASSWORD=runtime-smoke-password postgres \
  psql --host postgres --username zap_pronto_runtime --dbname zap_pronto \
  --set ON_ERROR_STOP=1 --tuples-only --no-align \
  --command "SET ROLE zap_pronto_api; SELECT current_user;" | grep -qx 'zap_pronto_api'

compose exec -T postgres psql --username zap_pronto_owner --dbname zap_pronto \
  --set ON_ERROR_STOP=1 --command \
  "CREATE TABLE staging_smoke_persistence (value integer PRIMARY KEY); INSERT INTO staging_smoke_persistence VALUES (1);"
compose restart postgres
for attempt in $(seq 1 60); do
  if compose exec -T postgres pg_isready --username zap_pronto_owner --dbname zap_pronto >/dev/null 2>&1; then
    break
  fi
  if [ "$attempt" -eq 60 ]; then
    echo "POSTGRES_DID_NOT_RECOVER" >&2
    exit 1
  fi
  sleep 1
done
for attempt in $(seq 1 60); do
  if compose exec -T api node -e \
    "fetch('http://127.0.0.1:3000/health/ready').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"; then
    break
  fi
  if [ "$attempt" -eq 60 ]; then
    echo "API_READINESS_DID_NOT_RECOVER" >&2
    exit 1
  fi
  sleep 1
done
compose exec -T postgres psql --username zap_pronto_owner --dbname zap_pronto \
  --set ON_ERROR_STOP=1 --tuples-only --no-align \
  --command "SELECT count(*) FROM staging_smoke_persistence;" | grep -qx '1'

echo "integrated staging smoke passed"
