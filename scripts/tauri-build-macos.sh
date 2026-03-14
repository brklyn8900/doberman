#!/bin/zsh

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

resolve_signing_identity() {
  if [[ -n "${DOBERMAN_APPLE_SIGNING_IDENTITY:-}" ]]; then
    printf '%s\n' "$DOBERMAN_APPLE_SIGNING_IDENTITY"
    return 0
  fi

  if [[ -n "${APPLE_CERTIFICATE:-}" ]]; then
    return 1
  fi

  local first_identity
  first_identity="$(
    security find-identity -v -p codesigning 2>/dev/null \
      | sed -n 's/^[[:space:]]*[0-9][[:space:]]*)[[:space:]]*[^"]*"\(Apple Development:[^"]*\)".*/\1/p' \
      | head -n 1
  )"

  if [[ -n "$first_identity" ]]; then
    printf '%s\n' "$first_identity"
    return 0
  fi

  return 1
}

SIGNING_IDENTITY=""
if SIGNING_IDENTITY="$(resolve_signing_identity)"; then
  echo "Using macOS signing identity: $SIGNING_IDENTITY"
elif [[ -n "${APPLE_CERTIFICATE:-}" ]]; then
  echo "Using APPLE_CERTIFICATE-based signing configuration"
else
  echo "No Apple Development signing identity found." >&2
  echo "Set DOBERMAN_APPLE_SIGNING_IDENTITY or import an Apple Development certificate before building." >&2
  exit 1
fi

TMP_CONFIG="$(mktemp -t doberman-tauri-macos-config.XXXXXX.json)"
cleanup() {
  rm -f "$TMP_CONFIG"
}
trap cleanup EXIT

if [[ -n "$SIGNING_IDENTITY" ]]; then
  cat >"$TMP_CONFIG" <<EOF
{
  "bundle": {
    "macOS": {
      "signingIdentity": "$SIGNING_IDENTITY"
    }
  }
}
EOF
else
  cat >"$TMP_CONFIG" <<'EOF'
{}
EOF
fi

npx tauri build --config "$TMP_CONFIG" "$@"
