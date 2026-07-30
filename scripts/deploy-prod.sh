#!/usr/bin/env bash
# Atomically deploy one exact public revision to the production VPS.
#
# The script may be streamed over SSH, so the production root is explicit.
# It prepares an immutable release before changing the live symlink, serializes
# deployments with flock, verifies internal and external readiness, rolls back
# automatically on failure, and writes a durable deployment receipt.
#
# Usage:
#   scripts/deploy-prod.sh --root /opt/xandrio --origin https://xandrio.xyz SHA
#   scripts/deploy-prod.sh --root /opt/xandrio --origin https://xandrio.xyz --dry-run SHA
set -euo pipefail

SERVICE="xandrio-web"
REPO_ROOT=""
ORIGIN=""
DRY_RUN=0
REVISION=""
KEEP_RELEASES=5

while [ $# -gt 0 ]; do
  case "$1" in
    --service) SERVICE="$2"; shift 2 ;;
    --root) REPO_ROOT="$2"; shift 2 ;;
    --origin) ORIGIN="$2"; shift 2 ;;
    --keep) KEEP_RELEASES="$2"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) sed -n '2,15p' "$0"; exit 0 ;;
    *) REVISION="$1"; shift ;;
  esac
done

if ! [[ "$REVISION" =~ ^[0-9a-f]{40}$ ]]; then
  echo "error: deployment requires one exact 40-character Git revision." >&2
  exit 1
fi
if ! [[ "$REPO_ROOT" =~ ^/[A-Za-z0-9_./-]+$ ]] || [[ "$REPO_ROOT" == *".."* ]]; then
  echo "error: --root must be a safe absolute path." >&2
  exit 1
fi
if ! [[ "$ORIGIN" =~ ^https://[A-Za-z0-9.-]+(:[0-9]+)?$ ]]; then
  echo "error: --origin must be a path-free HTTPS origin." >&2
  exit 1
fi
if ! [[ "$SERVICE" =~ ^[A-Za-z0-9_.@-]+$ ]]; then
  echo "error: invalid systemd service name." >&2
  exit 1
fi
if ! [[ "$KEEP_RELEASES" =~ ^[3-9]$|^[1-9][0-9]+$ ]]; then
  echo "error: --keep must retain at least three releases." >&2
  exit 1
fi
if [ ! -d "$REPO_ROOT/.git" ]; then
  echo "error: production Git checkout not found at $REPO_ROOT." >&2
  exit 1
fi

RELEASES_DIR="$REPO_ROOT/releases"
CURRENT_LINK="$REPO_ROOT/current"
DEPLOYMENTS_DIR="$REPO_ROOT/deployments"
RELEASE_DIR="$RELEASES_DIR/$REVISION"
LOCK_FILE="/run/lock/xandrio-deploy.lock"
PORT="$(grep -E '^PORT=' "$REPO_ROOT/.env" 2>/dev/null | tail -1 | cut -d= -f2 || true)"
PORT="${PORT:-8181}"

REPO_OWNER="$(stat -c '%U' "$REPO_ROOT" 2>/dev/null || stat -f '%Su' "$REPO_ROOT")"
REPO_GROUP="$(stat -c '%G' "$REPO_ROOT" 2>/dev/null || stat -f '%Sg' "$REPO_ROOT")"
REPO_RUN=()
CURRENT_USER="$(id -un)"
if [ "$CURRENT_USER" != "$REPO_OWNER" ]; then
  if [ "$(id -u)" -ne 0 ]; then
    echo "error: checkout is owned by $REPO_OWNER but deploy is running as $CURRENT_USER." >&2
    exit 1
  fi
  if ! command -v runuser >/dev/null 2>&1; then
    echo "error: runuser is required to deploy a checkout owned by $REPO_OWNER." >&2
    exit 1
  fi
  REPO_RUN=(runuser -u "$REPO_OWNER" --)
fi
repo() {
  "${REPO_RUN[@]}" "$@"
}

SUDO=""
[ "$(id -u)" -ne 0 ] && SUDO="sudo"

if [ "$DRY_RUN" -eq 1 ]; then
  cat <<PLAN
Production release plan:
  exact revision: $REVISION
  stage:          $RELEASE_DIR
  live symlink:   $CURRENT_LINK
  service:        $SERVICE
  readiness:      http://127.0.0.1:$PORT/ready and $ORIGIN/ready
  rollback:       automatic symlink restore and service restart
  retention:      $KEEP_RELEASES releases
PLAN
  exit 0
fi

exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  echo "error: another Xandrio production deployment is already running." >&2
  exit 1
fi

STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
STARTED_SECONDS="$(date +%s)"
mkdir -p "$RELEASES_DIR" "$DEPLOYMENTS_DIR"
chown "$REPO_OWNER:$REPO_GROUP" "$RELEASES_DIR"

repo git -C "$REPO_ROOT" fetch --tags origin main
if ! repo git -C "$REPO_ROOT" cat-file -e "$REVISION^{commit}"; then
  echo "error: revision $REVISION is not available from the public repository." >&2
  exit 1
fi
if ! repo git -C "$REPO_ROOT" merge-base --is-ancestor "$REVISION" origin/main; then
  echo "error: revision $REVISION is not on public origin/main." >&2
  exit 1
fi

if [ ! -f "$RELEASE_DIR/.xandrio-ready" ]; then
  if [ -e "$RELEASE_DIR" ]; then
    repo git -C "$REPO_ROOT" worktree remove --force "$RELEASE_DIR"
  fi
  echo "Preparing immutable release $REVISION..."
  repo git -C "$REPO_ROOT" worktree add --detach "$RELEASE_DIR" "$REVISION"
  repo ln -s "$REPO_ROOT/.env" "$RELEASE_DIR/.env"
  repo ln -s "$REPO_ROOT/data" "$RELEASE_DIR/data"
  repo ln -s "$REPO_ROOT/cache" "$RELEASE_DIR/cache"
  repo npm ci --omit=dev --prefix "$RELEASE_DIR"
  repo node --check "$RELEASE_DIR/server.js"
  printf '%s\n' "$REVISION" > "$RELEASE_DIR/.xandrio-revision"
  touch "$RELEASE_DIR/.xandrio-ready"
  chown "$REPO_OWNER:$REPO_GROUP" \
    "$RELEASE_DIR/.xandrio-revision" "$RELEASE_DIR/.xandrio-ready"
fi

PREVIOUS_TARGET=""
if [ -L "$CURRENT_LINK" ]; then
  PREVIOUS_TARGET="$(readlink -f "$CURRENT_LINK" 2>/dev/null || true)"
fi
if [ -z "$PREVIOUS_TARGET" ] || [ ! -d "$PREVIOUS_TARGET" ]; then
  PREVIOUS_TARGET="$REPO_ROOT"
fi
PREVIOUS_REVISION="legacy"
if [ -f "$PREVIOUS_TARGET/.xandrio-revision" ]; then
  PREVIOUS_REVISION="$(tr -d '\r\n' < "$PREVIOUS_TARGET/.xandrio-revision")"
elif repo git -C "$REPO_ROOT" rev-parse HEAD >/dev/null 2>&1; then
  PREVIOUS_REVISION="$(repo git -C "$REPO_ROOT" rev-parse HEAD)"
fi

install_systemd_release_directory() {
  local drop_in_dir="/etc/systemd/system/$SERVICE.service.d"
  local drop_in="$drop_in_dir/release-directory.conf"
  local expected
  expected=$'[Service]\nWorkingDirectory='"$CURRENT_LINK"$'\n'
  if [ ! -f "$drop_in" ] || [ "$(cat "$drop_in")"$'\n' != "$expected" ]; then
    $SUDO mkdir -p "$drop_in_dir"
    printf '%s' "$expected" | $SUDO tee "$drop_in" >/dev/null
    $SUDO systemctl daemon-reload
  fi
}

switch_current() {
  local target="$1"
  rm -f "$CURRENT_LINK.next"
  ln -s "$target" "$CURRENT_LINK.next"
  mv -Tf "$CURRENT_LINK.next" "$CURRENT_LINK"
}

wait_for_url() {
  local url="$1"
  local attempts="${2:-30}"
  for _attempt in $(seq 1 "$attempts"); do
    if curl --silent --fail --max-time 3 "$url" >/dev/null; then
      return 0
    fi
    sleep 2
  done
  return 1
}

write_receipt() {
  local status="$1"
  local rolled_back="$2"
  local finished_at duration receipt
  finished_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  duration="$(( $(date +%s) - STARTED_SECONDS ))"
  receipt="$(printf \
    '{"status":"%s","revision":"%s","previousRevision":"%s","rolledBack":%s,"startedAt":"%s","finishedAt":"%s","durationSeconds":%s,"origin":"%s"}' \
    "$status" "$REVISION" "$PREVIOUS_REVISION" "$rolled_back" \
    "$STARTED_AT" "$finished_at" "$duration" "$ORIGIN")"
  printf '%s\n' "$receipt" > "$DEPLOYMENTS_DIR/latest.json"
  printf '%s\n' "$receipt" >> "$DEPLOYMENTS_DIR/history.jsonl"
}

rollback() {
  echo "Deployment failed; restoring $PREVIOUS_TARGET..."
  switch_current "$PREVIOUS_TARGET"
  $SUDO systemctl restart "$SERVICE" || true
  if wait_for_url "http://127.0.0.1:$PORT/health" 30; then
    write_receipt "rolled-back" true
    echo "Rollback healthy at $PREVIOUS_REVISION."
  else
    write_receipt "rollback-failed" true
    echo "error: rollback did not restore service health." >&2
  fi
}

CURRENT_REVISION=""
if [ -f "$CURRENT_LINK/.xandrio-revision" ]; then
  CURRENT_REVISION="$(tr -d '\r\n' < "$CURRENT_LINK/.xandrio-revision")"
fi
if [ "$CURRENT_REVISION" = "$REVISION" ] &&
   $SUDO systemctl is-active --quiet "$SERVICE" &&
   wait_for_url "http://127.0.0.1:$PORT/ready" 1 &&
   wait_for_url "$ORIGIN/ready" 1; then
  write_receipt "deployed" false
  echo "Already deployed and ready: $REVISION."
  exit 0
fi

install_systemd_release_directory
switch_current "$RELEASE_DIR"

if ! $SUDO systemctl restart "$SERVICE"; then
  rollback
  exit 1
fi
if ! wait_for_url "http://127.0.0.1:$PORT/ready" 30; then
  echo "error: internal readiness failed for $REVISION." >&2
  rollback
  exit 1
fi
if ! wait_for_url "$ORIGIN/ready" 15; then
  echo "error: external readiness failed for $REVISION." >&2
  rollback
  exit 1
fi

write_receipt "deployed" false
echo "Healthy. Deployed exact revision $REVISION."

# Keep bounded rollback history. Never remove the active release or the
# immediately previous target.
mapfile -t RELEASE_PATHS < <(
  find "$RELEASES_DIR" -mindepth 1 -maxdepth 1 -type d \
    -name '[0-9a-f][0-9a-f]*' -printf '%T@ %p\n' |
    sort -nr |
    cut -d' ' -f2-
)
for ((index=KEEP_RELEASES; index<${#RELEASE_PATHS[@]}; index++)); do
  old_release="${RELEASE_PATHS[$index]}"
  if ! [[ "$(basename "$old_release")" =~ ^[0-9a-f]{40}$ ]]; then
    continue
  fi
  if [ "$old_release" = "$RELEASE_DIR" ] || [ "$old_release" = "$PREVIOUS_TARGET" ]; then
    continue
  fi
  repo git -C "$REPO_ROOT" worktree remove --force "$old_release" || true
done
