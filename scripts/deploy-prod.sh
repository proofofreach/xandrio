#!/usr/bin/env bash
# Deploy Xandrio on the production web host.
#
# Runs from the production checkout of the public repository (nginx ->
# xandrio-web systemd unit; see docs/DEPLOYMENT_TOPOLOGY.md). Fetches the
# requested ref (a signed release tag or origin/main), installs production
# dependencies, restarts the service, and verifies /health — printing exact
# rollback commands if the health check fails.
#
# Usage:
#   scripts/deploy-prod.sh [ref]            deploy ref (default: origin/main)
#   scripts/deploy-prod.sh --rollback REF   redeploy a previous ref
#   scripts/deploy-prod.sh --dry-run [ref]  print the plan without changing anything
#
# Options:
#   --service NAME   systemd unit to restart (default: xandrio-web)
set -euo pipefail

SERVICE="xandrio-web"
DRY_RUN=0
ROLLBACK_REF=""
REF="origin/main"

while [ $# -gt 0 ]; do
  case "$1" in
    --service) SERVICE="$2"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    --rollback) ROLLBACK_REF="$2"; shift 2 ;;
    -h|--help) sed -n '2,17p' "$0"; exit 0 ;;
    *) REF="$1"; shift ;;
  esac
done

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

# The service runs as root only in containers; on the host we need sudo for
# systemctl unless already root.
SUDO=""
[ "$(id -u)" -ne 0 ] && SUDO="sudo"

# Health endpoint port comes from the same .env the service reads.
PORT="$(grep -E '^PORT=' .env 2>/dev/null | tail -1 | cut -d= -f2 || true)"
PORT="${PORT:-8181}"

if [ -n "$ROLLBACK_REF" ]; then
  REF="$ROLLBACK_REF"
fi

PREV_REF="$(git rev-parse HEAD)"
echo "Current revision (rollback point): $PREV_REF"
echo "Deploying: $REF  (service: $SERVICE, health port: $PORT)"

if [ "$DRY_RUN" -eq 1 ]; then
  cat <<PLAN
Would run:
  git fetch --tags origin
  git checkout --detach $REF
  npm ci --omit=dev
  $SUDO systemctl restart $SERVICE
  curl --fail http://127.0.0.1:$PORT/health   (retried up to 60s)
On health failure, rollback with:
  scripts/deploy-prod.sh --rollback $PREV_REF
PLAN
  exit 0
fi

# Server-local edits are forbidden (they are lost on deploy anyway); refuse
# to clobber them silently.
if [ -n "$(git status --porcelain)" ]; then
  echo "error: working tree has local changes; production must not be hot-edited." >&2
  echo "Inspect with 'git status', then discard them before deploying." >&2
  exit 1
fi

git fetch --tags origin
git checkout --detach "$REF"
npm ci --omit=dev
$SUDO systemctl restart "$SERVICE"

echo "Waiting for /health on port $PORT..."
for attempt in $(seq 1 30); do
  if curl --silent --fail --max-time 2 "http://127.0.0.1:$PORT/health" > /dev/null; then
    echo "Healthy. Deployed $(git rev-parse HEAD) ($REF)."
    exit 0
  fi
  sleep 2
done

cat >&2 <<FAIL
error: service did not become healthy after deploying $REF.
Inspect: $SUDO journalctl -u $SERVICE -n 100
Roll back with:
  scripts/deploy-prod.sh --rollback $PREV_REF
(equivalent to: git checkout --detach $PREV_REF && npm ci --omit=dev && $SUDO systemctl restart $SERVICE)
FAIL
exit 1
