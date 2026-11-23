#!/usr/bin/env bash
# Publishes a GitHub release for the version in package.json, with BOTH assets:
#   tmux-session-keeper-<version>.vsix   (versioned, for pinning)
#   tmux-session-keeper.vsix             (fixed name, so .../releases/latest/download/tmux-session-keeper.vsix always works)
# Usage: scripts/release.sh   (from the repo root, on a clean, pushed main, logged in with `gh`)
set -euo pipefail
cd "$(dirname "$0")/.."
version=$(node -p "require('./package.json').version")
tag="v$version"
[ -z "$(git status --porcelain)" ] || { echo "release: the working tree is not clean" >&2; exit 1; }
git fetch -q origin main
[ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] || { echo "release: HEAD is not pushed to origin/main" >&2; exit 1; }
gh release view "$tag" >/dev/null 2>&1 && { echo "release: $tag already exists" >&2; exit 1; }
npm run package
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
cp "tmux-session-keeper-$version.vsix" "$tmp/tmux-session-keeper.vsix"
sha=$(sha256sum "tmux-session-keeper-$version.vsix" | cut -d' ' -f1)
{ echo "Release $tag."; echo; echo "See CHANGELOG.md for what changed."; echo; echo "SHA-256: \`$sha\`"; } > "$tmp/notes.md"
gh release create "$tag" "tmux-session-keeper-$version.vsix" "$tmp/tmux-session-keeper.vsix" \
  --title "tmux Session Keeper $version" --notes-file "$tmp/notes.md" --target main
echo "Published $tag"
