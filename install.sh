#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo 'Usage: ./install.sh /absolute/path/to/Chatium-account' >&2
  exit 2
fi

source_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
account_root="$(cd "$1" && pwd -P)"
target="$account_root/.agents/skills/processes"

if [[ ! -f "$source_dir/SKILL.md" || ! -f "$account_root/.agents/skills/chatium-development/SKILL.md" ]]; then
  echo 'The source SKILL.md and the account chatium-development skill are required.' >&2
  exit 2
fi
if [[ -e "$target/.git" ]]; then
  echo 'The destination is a Git checkout; remove its nested .git before installation.' >&2
  exit 2
fi
if ! command -v rsync >/dev/null || ! command -v npm >/dev/null; then
  echo 'The installer requires rsync and npm.' >&2
  exit 2
fi

mkdir -p "$target"
rsync -a --delete --exclude='.git/' --exclude='node_modules/' --exclude='.DS_Store' "$source_dir/" "$target/"
(cd "$target" && npm ci --ignore-scripts)
echo "Installed processes in $target"
