#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
compose_file="$script_dir/compose.yaml"
env_file="$script_dir/.env"
target_image=
public_url=${STAGING_PUBLIC_URL:-}

usage() {
  echo "usage: $0 --previous-image REPOSITORY@sha256:DIGEST [--env-file PATH] [--public-url https://HOST]" >&2
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --previous-image) [ "$#" -ge 2 ] || { usage; exit 2; }; target_image=$2; shift 2 ;;
    --env-file) [ "$#" -ge 2 ] || { usage; exit 2; }; env_file=$2; shift 2 ;;
    --public-url) [ "$#" -ge 2 ] || { usage; exit 2; }; public_url=$2; shift 2 ;;
    *) usage; exit 2 ;;
  esac
done

printf '%s' "$target_image" | grep -Eq '^[^[:space:]@]+@sha256:[0-9a-f]{64}$' \
  || { echo "PREVIOUS_WEB_IMAGE_IMMUTABLE_DIGEST_REQUIRED" >&2; exit 1; }
[ -r "$env_file" ] || { echo "STAGING_ENV_FILE_NOT_READABLE" >&2; exit 1; }

compose() {
  docker compose --env-file "$env_file" --file "$compose_file" "$@"
}
current_container=$(compose ps --quiet web)
[ -n "$current_container" ] || { echo "WEB_CONTAINER_NOT_FOUND" >&2; exit 1; }
current_image=$(docker inspect --format '{{.Config.Image}}' "$current_container")
[ "$current_image" != "$target_image" ] || { echo "WEB_ALREADY_USES_REQUESTED_IMAGE" >&2; exit 1; }

docker pull "$target_image" >/dev/null
restore_current() {
  echo "WEB_ROLLBACK_FAILED_RESTORING_CURRENT_IMAGE" >&2
  export ZAP_WEB_IMAGE=$current_image
  compose up --detach --no-deps --wait --wait-timeout 90 web >&2 || true
}
trap restore_current INT TERM HUP

export ZAP_WEB_IMAGE=$target_image
if ! compose up --detach --no-deps --wait --wait-timeout 90 web; then
  restore_current
  exit 1
fi

if [ -n "$public_url" ]; then
  verification_status=0
  sh "$script_dir/verify-web.sh" --env-file "$env_file" --public-url "$public_url" || verification_status=$?
else
  verification_status=0
  sh "$script_dir/verify-web.sh" --env-file "$env_file" || verification_status=$?
fi
if [ "$verification_status" -ne 0 ]; then
  restore_current
  exit 1
fi
trap - INT TERM HUP

echo "web_rollback=completed"
echo "web_previous_image=$current_image"
echo "web_active_image=$target_image"
echo "Persist the active digest in the external staging env file before the next Compose operation."
