#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
compose_file="$script_dir/compose.yaml"
env_file="$script_dir/.env"
public_url=${STAGING_PUBLIC_URL:-}

usage() {
  echo "usage: $0 [--env-file PATH] [--public-url https://HOST]" >&2
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --env-file) [ "$#" -ge 2 ] || { usage; exit 2; }; env_file=$2; shift 2 ;;
    --public-url) [ "$#" -ge 2 ] || { usage; exit 2; }; public_url=$2; shift 2 ;;
    *) usage; exit 2 ;;
  esac
done

[ -r "$env_file" ] || { echo "STAGING_ENV_FILE_NOT_READABLE" >&2; exit 1; }
if [ -n "$public_url" ]; then
  case "$public_url" in https://*) ;; *) echo "STAGING_PUBLIC_URL_HTTPS_REQUIRED" >&2; exit 1;; esac
  public_url=${public_url%/}
  public_authority=${public_url#https://}
  case "$public_authority" in ''|*[@/?#]*) echo "STAGING_PUBLIC_URL_ORIGIN_REQUIRED" >&2; exit 1;; esac
fi
command -v docker >/dev/null 2>&1 || { echo "DOCKER_REQUIRED" >&2; exit 1; }
command -v curl >/dev/null 2>&1 || { echo "CURL_REQUIRED" >&2; exit 1; }

compose() {
  docker compose --env-file "$env_file" --file "$compose_file" "$@"
}
request() {
  curl --fail --silent --show-error --connect-timeout 3 --max-time 10 "$@"
}
assert_health() {
  base=$1
  request "$base/health/web" | grep -q '"status":"ok"' || { echo "WEB_HEALTH_INVALID:$base" >&2; exit 1; }
  request "$base/health/live" | grep -q '"status":"ok"' || { echo "API_LIVENESS_INVALID:$base" >&2; exit 1; }
  ready_status=$(curl --silent --output /dev/null --write-out '%{http_code}' --connect-timeout 3 --max-time 10 \
    "$base/health/ready")
  [ "$ready_status" = "404" ] || { echo "API_READINESS_PUBLICLY_EXPOSED:$base:$ready_status" >&2; exit 1; }
}
assert_public_headers() {
  base=$1
  request --dump-header "$tmp_dir/public.headers" --output /dev/null "$base/"
  grep -qi '^strict-transport-security:' "$tmp_dir/public.headers" || { echo "PUBLIC_HSTS_HEADER_MISSING" >&2; exit 1; }
  grep -qi '^content-security-policy:' "$tmp_dir/public.headers" || { echo "PUBLIC_CSP_HEADER_MISSING" >&2; exit 1; }
  grep -qi '^cache-control:.*no-store' "$tmp_dir/public.headers" || { echo "PUBLIC_ROOT_CACHE_POLICY_INVALID" >&2; exit 1; }
}

compose config --quiet
container_id=$(compose ps --quiet web)
[ -n "$container_id" ] || { echo "WEB_CONTAINER_NOT_FOUND" >&2; exit 1; }
running=$(docker inspect --format '{{.State.Running}}' "$container_id")
health=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}' "$container_id")
[ "$running" = "true" ] || { echo "WEB_CONTAINER_NOT_RUNNING" >&2; exit 1; }
[ "$health" = "healthy" ] || { echo "WEB_CONTAINER_NOT_HEALTHY:$health" >&2; exit 1; }

port=${STAGING_HTTP_PORT:-}
if [ -z "$port" ]; then
  port=$(compose port web 8080 | sed -n 's/.*://p' | tail -n 1)
fi
case "$port" in ''|*[!0-9]*) echo "STAGING_HTTP_PORT_INVALID" >&2; exit 1;; esac
loopback="http://127.0.0.1:$port"
assert_health "$loopback"

tmp_dir=$(mktemp -d)
trap 'rm -rf "$tmp_dir"' EXIT INT TERM
request --dump-header "$tmp_dir/root.headers" --output "$tmp_dir/root.html" "$loopback/"
grep -qi '^content-security-policy:' "$tmp_dir/root.headers" || { echo "WEB_CSP_HEADER_MISSING" >&2; exit 1; }
grep -qi '^cache-control:.*no-store' "$tmp_dir/root.headers" || { echo "WEB_ROOT_CACHE_POLICY_INVALID" >&2; exit 1; }
asset=$(grep -Eo '/assets/[^" ]+\.(js|css)' "$tmp_dir/root.html" | head -n 1 || true)
[ -n "$asset" ] || { echo "WEB_VERSIONED_ASSET_NOT_FOUND" >&2; exit 1; }
request --head "$loopback$asset" > "$tmp_dir/asset.headers"
grep -qi '^cache-control:.*immutable' "$tmp_dir/asset.headers" || { echo "WEB_ASSET_CACHE_POLICY_INVALID" >&2; exit 1; }

if [ -n "$public_url" ]; then
  assert_health "$public_url"
  assert_public_headers "$public_url"
  echo "public_https=verified"
else
  echo "public_https=skipped"
fi

restart_count=$(docker inspect --format '{{.RestartCount}}' "$container_id")
image_ref=$(docker inspect --format '{{.Config.Image}}' "$container_id")
printf '%s' "$image_ref" | grep -Eq '^[^[:space:]@]+@sha256:[0-9a-f]{64}$' \
  || { echo "WEB_ACTIVE_IMAGE_NOT_IMMUTABLE:$image_ref" >&2; exit 1; }
recent_logs=$(docker logs --since 5m "$container_id" 2>&1 || true)
http_5xx=$(printf '%s\n' "$recent_logs" | grep -Ec '" [5][0-9][0-9] [0-9]+ request_id=' || true)
nginx_errors=$(printf '%s\n' "$recent_logs" | grep -Eci '\[(emerg|alert|crit)\]' || true)
[ "$nginx_errors" = "0" ] || { echo "WEB_NGINX_CRITICAL_LOGS:$nginx_errors" >&2; exit 1; }

echo "web_container=$container_id"
echo "web_image=$image_ref"
echo "web_health=$health"
echo "web_restart_count=$restart_count"
echo "web_recent_http_5xx=$http_5xx"
echo "web_proxy_verification=passed"
