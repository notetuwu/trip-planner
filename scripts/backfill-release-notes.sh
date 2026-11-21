#!/usr/bin/env bash
# Rewrites the notes of releases that don't have a "What's new" section yet (or of the one tag given), from the commit
# messages. Needs gh with GH_TOKEN and GH_REPO, and the full git history (checkout with fetch-depth: 0).
set -euo pipefail
tags="${1:-}"
[ -n "$tags" ] || tags=$(gh release list --limit 200 --json tagName --jq '.[].tagName')
for tag in $tags; do
  if [ -z "${1:-}" ] && gh release view "$tag" --json body --jq .body | grep -q "^## What's new"; then continue; fi
  node scripts/release-notes.mjs "$tag" > "notes-$tag.md"
  gh release edit "$tag" --notes-file "notes-$tag.md"
  echo "Updated $tag"
done
