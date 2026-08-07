#!/bin/sh
set -eu

case "${API_UPSTREAM:-}" in
  http://*|https://*) ;;
  *) echo "API_UPSTREAM_HTTP_OR_HTTPS_ORIGIN_REQUIRED" >&2; exit 1 ;;
esac

if ! printf '%s' "$API_UPSTREAM" | grep -Eq '^https?://[A-Za-z0-9][A-Za-z0-9.-]*(:[0-9]{1,5})?$'; then
  echo "API_UPSTREAM_VALID_ORIGIN_REQUIRED" >&2
  exit 1
fi

if ! printf '%s' "${OIDC_AUTHORITY_ORIGIN:-}" | grep -Eq '^https://[A-Za-z0-9][A-Za-z0-9.-]*(:[0-9]{1,5})?$'; then
  echo "OIDC_AUTHORITY_ORIGIN_VALID_HTTPS_ORIGIN_REQUIRED" >&2
  exit 1
fi

if [ "$(cat /etc/zap-pronto/oidc-authority-origin)" != "$OIDC_AUTHORITY_ORIGIN" ]; then
  echo "OIDC_AUTHORITY_ORIGIN_BUILD_RUNTIME_MISMATCH" >&2
  exit 1
fi
