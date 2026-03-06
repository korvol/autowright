#!/usr/bin/env bash
set -euo pipefail

# Usage: ./scripts/publish.sh <package-dir>
# Example: ./scripts/publish.sh packages/resilience
#
# Run this from the repo root AFTER merging the version bump PR into main.
# The script builds, verifies, publishes to npm, and creates a git tag.

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BOLD='\033[1m'
NC='\033[0m'

die() { echo -e "${RED}error:${NC} $1" >&2; exit 1; }
info() { echo -e "${GREEN}>>>${NC} $1"; }
warn() { echo -e "${YELLOW}>>>${NC} $1"; }

# --- Validate arguments ---

PACKAGE_DIR="${1:-}"
[ -z "$PACKAGE_DIR" ] && die "usage: ./scripts/publish.sh <package-dir>\n  example: ./scripts/publish.sh packages/resilience"
[ -d "$PACKAGE_DIR" ] || die "directory not found: $PACKAGE_DIR"
[ -f "$PACKAGE_DIR/package.json" ] || die "no package.json in $PACKAGE_DIR"

# --- Validate git state ---

BRANCH=$(git branch --show-current)
[ "$BRANCH" = "main" ] || die "must be on main (currently on $BRANCH)"

git fetch origin main --quiet
LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse origin/main)
[ "$LOCAL" = "$REMOTE" ] || die "main is not up to date with origin. run: git pull"

[ -z "$(git status --porcelain)" ] || die "working tree is dirty. commit or stash changes first"

# --- Read package info ---

PACKAGE_NAME=$(node -p "require('./$PACKAGE_DIR/package.json').name")
PACKAGE_VERSION=$(node -p "require('./$PACKAGE_DIR/package.json').version")
TAG_NAME="${PACKAGE_NAME}@${PACKAGE_VERSION}"

info "package: ${BOLD}$PACKAGE_NAME${NC}"
info "version: ${BOLD}$PACKAGE_VERSION${NC}"
info "tag:     ${BOLD}$TAG_NAME${NC}"

# --- Check if version already published ---

PUBLISHED=$(npm view "$PACKAGE_NAME" versions --json 2>/dev/null || echo "[]")
if echo "$PUBLISHED" | node -e "
  const versions = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
  const arr = Array.isArray(versions) ? versions : [versions];
  process.exit(arr.includes('$PACKAGE_VERSION') ? 0 : 1);
" 2>/dev/null; then
  die "$PACKAGE_NAME@$PACKAGE_VERSION is already published on npm"
fi

# --- Check if tag exists ---

if git tag -l "$TAG_NAME" | grep -q .; then
  die "git tag $TAG_NAME already exists"
fi

# --- Run checks ---

info "running tests..."
turbo test:ci --filter="$PACKAGE_NAME" --output-logs=errors-only

info "running type check..."
turbo check:types --filter="$PACKAGE_NAME" --output-logs=errors-only

info "running lint..."
turbo check --filter="$PACKAGE_NAME" --output-logs=errors-only

# --- Build ---

info "building..."
(cd "$PACKAGE_DIR" && rm -rf dist tsconfig.tsbuildinfo && npx tsc -p tsconfig.json)

# --- Dry run ---

echo ""
info "dry run:"
(cd "$PACKAGE_DIR" && npm pack --dry-run 2>&1)
echo ""

# --- Confirm ---

warn "about to publish ${BOLD}$PACKAGE_NAME@$PACKAGE_VERSION${NC} to npm and tag ${BOLD}$TAG_NAME${NC}"
read -rp "proceed? (y/N) " CONFIRM
[ "$CONFIRM" = "y" ] || [ "$CONFIRM" = "Y" ] || die "aborted"

# --- Publish ---

info "publishing to npm..."
(cd "$PACKAGE_DIR" && npm publish --ignore-scripts)

# --- Tag ---

info "creating git tag $TAG_NAME..."
git tag -a "$TAG_NAME" -m "Release $TAG_NAME"
git push origin "$TAG_NAME"

echo ""
info "${BOLD}done!${NC} $PACKAGE_NAME@$PACKAGE_VERSION published and tagged."
