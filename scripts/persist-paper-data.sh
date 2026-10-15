#!/usr/bin/env bash
set -euo pipefail

MODE="${1:-}"
ROOT="$(git rev-parse --show-toplevel)"
BRANCH="paper-data"
MESSAGE=""

case "$MODE" in
  fast-5s)
    ITEMS=("data/fast-paper-state-5s.json" "data/fast-paper-latest-5s.json" "data/fast-reports/5s")
    MESSAGE="Update 5-second paper-trading reports"
    ;;
  fast-15s)
    ITEMS=("data/fast-paper-state-15s.json" "data/fast-paper-latest-15s.json" "data/fast-reports/15s")
    MESSAGE="Update 15-second paper-trading reports"
    ;;
  two-hour)
    ITEMS=("data/paper-state.json" "data/latest-report.json" "data/reports")
    MESSAGE="Update two-hour paper-trading reports"
    ;;
  *)
    echo "Usage: $0 fast-5s|fast-15s|two-hour" >&2
    exit 2
    ;;
esac

STAGE="$(mktemp -d)"
WORKTREE="$(mktemp -d)"
rmdir "$WORKTREE"

cleanup() {
  git -C "$ROOT" worktree remove --force "$WORKTREE" >/dev/null 2>&1 || true
  rm -rf "$STAGE" "$WORKTREE"
}
trap cleanup EXIT

# Snapshot this run's own files before refreshing the shared data branch.
for ITEM in "${ITEMS[@]}"; do
  if [[ -d "$ROOT/$ITEM" ]]; then
    mkdir -p "$STAGE/$ITEM"
    cp -a "$ROOT/$ITEM/." "$STAGE/$ITEM/"
  elif [[ -f "$ROOT/$ITEM" ]]; then
    mkdir -p "$STAGE/$(dirname "$ITEM")"
    cp "$ROOT/$ITEM" "$STAGE/$ITEM"
  else
    echo "Expected paper output was not created: $ITEM" >&2
    exit 1
  fi
done

git -C "$ROOT" fetch origin "+refs/heads/$BRANCH:refs/remotes/origin/$BRANCH"
git -C "$ROOT" worktree add --detach "$WORKTREE" "refs/remotes/origin/$BRANCH"

for ATTEMPT in 1 2 3 4 5; do
  # Reset onto the newest data-branch commit on every attempt. This allows
  # different strategy jobs to publish their separate files without losing updates.
  git -C "$ROOT" fetch origin "+refs/heads/$BRANCH:refs/remotes/origin/$BRANCH"
  git -C "$WORKTREE" reset --hard "refs/remotes/origin/$BRANCH"

  for ITEM in "${ITEMS[@]}"; do
    if [[ -d "$STAGE/$ITEM" ]]; then
      mkdir -p "$WORKTREE/$ITEM"
      cp -a "$STAGE/$ITEM/." "$WORKTREE/$ITEM/"
    else
      mkdir -p "$WORKTREE/$(dirname "$ITEM")"
      cp "$STAGE/$ITEM" "$WORKTREE/$ITEM"
    fi
  done

  git -C "$WORKTREE" add -- "${ITEMS[@]}"
  if git -C "$WORKTREE" diff --cached --quiet; then
    echo "Paper data is already up to date on $BRANCH."
    exit 0
  fi

  git -C "$WORKTREE" config user.name "github-actions[bot]"
  git -C "$WORKTREE" config user.email "41898282+github-actions[bot]@users.noreply.github.com"
  git -C "$WORKTREE" commit -m "$MESSAGE"

  if git -C "$WORKTREE" push origin "HEAD:$BRANCH"; then
    echo "Persisted $MODE output to $BRANCH."
    exit 0
  fi

  echo "Paper-data push attempt $ATTEMPT failed; refreshing branch and retrying." >&2
  sleep "$ATTEMPT"
done

echo "Could not persist $MODE output to $BRANCH after five attempts." >&2
exit 1
