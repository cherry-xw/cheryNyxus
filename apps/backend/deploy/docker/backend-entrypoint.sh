#!/bin/sh
set -eu

: "${CHERY_DIR:=/app/platform/qqbot}"
: "${CHERY_ENV_FILE:=$CHERY_DIR/.env}"
: "${DB_DIR:=$CHERY_DIR/.chery/data}"
: "${WEB_PORT:=8283}"
: "${QQBOT_ROLE:=backend}"
: "${QQBOT_CONNECTION_TOKEN_FILE:=$CHERY_DIR/.chery/qq-connection-token.json}"

export CHERY_DIR CHERY_ENV_FILE DB_DIR WEB_PORT

if [ "$QQBOT_ROLE" != backend ]; then
  echo "unsupported QQBOT_ROLE: $QQBOT_ROLE" >&2
  exit 64
fi

# Docker secrets are read only when explicitly mounted. They never become
# part of the image or compose file; the application receives them as env.
load_secret() {
  name=$1
  file=/run/secrets/$2
  eval "current=\${$name-}"
  if [ -z "$current" ] && [ -r "$file" ]; then
    value=$(cat "$file")
    export "$name=$value"
  fi
}

load_secret CHERY_AUTH_SESSION_SECRET chery_auth_session_secret
load_secret QQBOT_MODEL_KEY qqbot_model_key

if [ -r "$QQBOT_CONNECTION_TOKEN_FILE" ]; then
  connection_token=$(node -e "const fs=require('fs');const x=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));process.stdout.write(typeof x.token==='string'?x.token:'')" "$QQBOT_CONNECTION_TOKEN_FILE")
  if [ -n "$connection_token" ]; then
    QQBOT_PLATFORM_TOKEN=$connection_token
    export QQBOT_PLATFORM_TOKEN
  fi
fi
if [ -z "${QQBOT_PLATFORM_TOKEN:-}" ]; then
  load_secret QQBOT_PLATFORM_TOKEN qqbot_platform_token
fi

# The guardian forks the actual worker. Keep the transport credential in the
# worker environment as well; otherwise the listener starts without channel authentication.
if [ -n "${QQBOT_PLATFORM_TOKEN:-}" ]; then
  export QQBOT_PLATFORM_TOKEN
fi

# Deployment adapter: the runtime receives no QQ-specific authentication branch.
CHERY_CHANNEL_AUTH=$(node -e 'process.stdout.write(JSON.stringify({token:process.env.QQBOT_PLATFORM_TOKEN||"",credentialKind:"qq",header:"X-QQBot-Token",readyNotification:"qq.connection.ready"}))')
CHERY_PLUGIN_RUNTIME_OPTIONS=$(node -e 'process.stdout.write(JSON.stringify({QQ_INGRESS_PAUSED:process.env.QQ_INGRESS_PAUSED||"1",...(process.env.QQ_USER_FILES_ROOT?{QQ_USER_FILES_ROOT:process.env.QQ_USER_FILES_ROOT}:{})}))')
export CHERY_CHANNEL_AUTH CHERY_PLUGIN_RUNTIME_OPTIONS

mkdir -p "$CHERY_DIR/.chery" "$DB_DIR" "$CHERY_DIR/.chery/ingress" "$CHERY_DIR/data"
chmod 0700 "$CHERY_DIR/.chery" "$DB_DIR" "$CHERY_DIR/.chery/ingress" "$CHERY_DIR/data"

# Persist user-installed libraries and caches on the existing data mount.
if [ -n "${HOME:-}" ] && [ "$HOME" = "$CHERY_DIR/.chery/tool-home" ]; then
  mkdir -p "$HOME/cache/npm" "$HOME/npm"
  if [ ! -x "$HOME/venv/bin/python" ]; then python3 -m venv "$HOME/venv"; fi
  # Node browser libraries and binaries survive container recreation.
  : "${CHERY_PLAYWRIGHT_VERSION:=1.58.2}"
  : "${PLAYWRIGHT_BROWSERS_PATH:=$HOME/browsers}"
  export PLAYWRIGHT_BROWSERS_PATH
  mkdir -p "$HOME/browser-tools" "$PLAYWRIGHT_BROWSERS_PATH"
  installed=$(node -e 'try {process.stdout.write(require(process.argv[1]).version)} catch {}' "$HOME/browser-tools/node_modules/playwright/package.json")
  if [ "$installed" != "$CHERY_PLAYWRIGHT_VERSION" ]; then
    npm install --prefix "$HOME/browser-tools" --no-audit --no-fund --save-exact "playwright@$CHERY_PLAYWRIGHT_VERSION"
  fi
  node "$HOME/browser-tools/node_modules/playwright/cli.js" install chromium
fi

# Installation/enabling is explicit offline maintenance, never recreation.
if [ "$#" -gt 0 ]; then exec "$@"; fi
exec node /usr/local/bin/runtime-supervisor.mjs