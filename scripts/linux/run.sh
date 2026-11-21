#!/usr/bin/env bash
# Runs one command against the CURRENT working tree (tracked and untracked, not ignored files) inside the
# Ubuntu test image (WP-100 E8). The tree is copied into the container (never the Windows node_modules); the
# pnpm store lives in the volume `parallax-pnpm-store`, so repeated installs are fast.
#
#   scripts/linux/run.sh [--image parallax-linux:24.04] [--cpus 2] [--memory 6g] -- <command...>
#   scripts/linux/run.sh -- pnpm exec vitest run src/server/lib
#
# Resource rule (ADR-154): one heavy run at a time on the machine. Runs of this script wait for each other
# (lock folder in the temp directory, shared by every worktree and agent; a holder that died is cleared).
set -euo pipefail

image="parallax-linux:24.04"
cpus="2"
memory="6g"
while [ $# -gt 0 ]; do
  case "$1" in
    --image) image="$2"; shift 2 ;;
    --cpus) cpus="$2"; shift 2 ;;
    --memory) memory="$2"; shift 2 ;;
    --) shift; break ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done
if [ $# -eq 0 ]; then
  echo "usage: scripts/linux/run.sh [--image I] [--cpus N] [--memory M] -- <command...>" >&2
  exit 2
fi

root="$(git rev-parse --show-toplevel)"
cd "$root"

lock="${TMPDIR:-/tmp}/parallax-linux-run.lock"
waited=0
while ! mkdir "$lock" 2>/dev/null; do
  holder="$(cat "$lock/pid" 2>/dev/null || true)"
  if [ -n "$holder" ] && ! kill -0 "$holder" 2>/dev/null; then
    rm -rf "$lock"
    continue
  fi
  [ "$waited" -eq 0 ] && echo "waiting for another Linux run to finish (ADR-154)..." >&2
  sleep 5
  waited=$((waited + 5))
  if [ "$waited" -ge 5400 ]; then
    echo "gave up waiting for $lock" >&2
    exit 3
  fi
done
echo "$$" >"$lock/pid"
trap 'rm -rf "$lock"' EXIT

# The command as one shell-quoted string for `bash -lc` inside the container.
quoted=""
for arg in "$@"; do quoted+=" $(printf '%q' "$arg")"; done

inner='set -euo pipefail
mkdir -p "$HOME/work" && cd "$HOME/work"
tar -xf -
pnpm config set store-dir "$HOME/.pnpm-store" >/dev/null
pnpm install --frozen-lockfile --prefer-offline >/tmp/install.log 2>&1 || { tail -40 /tmp/install.log; exit 1; }
'"$quoted"

# Git Bash would rewrite POSIX paths in docker arguments. A new volume belongs to root: hand it to ubuntu.
MSYS_NO_PATHCONV=1 docker run --rm -u root -v parallax-pnpm-store:/home/ubuntu/.pnpm-store "$image" \
  chown ubuntu:ubuntu /home/ubuntu/.pnpm-store
git ls-files -z --cached --others --exclude-standard \
  | tar --null --ignore-failed-read -T - -cf - 2>/dev/null \
  | MSYS_NO_PATHCONV=1 docker run --rm -i --init \
      --cpus="$cpus" --memory="$memory" \
      -e CI=1 \
      -v parallax-pnpm-store:/home/ubuntu/.pnpm-store \
      "$image" bash -lc "$inner"
