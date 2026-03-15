#!/bin/zsh
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

CURRENT_VERSION=$(grep '"version"' package.json | head -1 | sed 's/.*"\([0-9]*\.[0-9]*\.[0-9]*\)".*/\1/')

echo "Current version: $CURRENT_VERSION"
echo ""

if [[ $# -eq 1 ]]; then
  NEW_VERSION="${1#v}"
else
  IFS='.' read -r MAJOR MINOR PATCH <<< "$CURRENT_VERSION"
  echo "Bump options:"
  echo "  1) patch → $MAJOR.$MINOR.$((PATCH + 1))"
  echo "  2) minor → $MAJOR.$((MINOR + 1)).0"
  echo "  3) major → $((MAJOR + 1)).0.0"
  echo "  4) enter custom version"
  echo ""
  printf "Choice [1]: "
  read -r CHOICE
  CHOICE="${CHOICE:-1}"

  case "$CHOICE" in
    1) NEW_VERSION="$MAJOR.$MINOR.$((PATCH + 1))" ;;
    2) NEW_VERSION="$MAJOR.$((MINOR + 1)).0" ;;
    3) NEW_VERSION="$((MAJOR + 1)).0.0" ;;
    4)
      printf "Enter version: "
      read -r NEW_VERSION
      ;;
    *) echo "Invalid choice"; exit 1 ;;
  esac
fi

if ! [[ "$NEW_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "Error: invalid semver format '$NEW_VERSION'"
  exit 1
fi

TAG="app-v$NEW_VERSION"

if git rev-parse "$TAG" >/dev/null 2>&1; then
  echo "Error: tag $TAG already exists"
  exit 1
fi

echo ""
echo "Bumping $CURRENT_VERSION → $NEW_VERSION"
echo ""

# Update all three version files
sed -i '' "s/\"version\": \"$CURRENT_VERSION\"/\"version\": \"$NEW_VERSION\"/" package.json
sed -i '' "s/\"version\": \"$CURRENT_VERSION\"/\"version\": \"$NEW_VERSION\"/" src-tauri/tauri.conf.json
sed -i '' "s/^version = \"$CURRENT_VERSION\"/version = \"$NEW_VERSION\"/" src-tauri/Cargo.toml

# Update lockfile
npm install --package-lock-only --silent 2>/dev/null

echo "Updated:"
echo "  package.json         → $NEW_VERSION"
echo "  src-tauri/tauri.conf.json → $NEW_VERSION"
echo "  src-tauri/Cargo.toml      → $NEW_VERSION"
echo ""

# Show diff for confirmation
git diff --stat
echo ""
printf "Commit, tag ($TAG), and push? [Y/n]: "
read -r CONFIRM
CONFIRM="${CONFIRM:-Y}"

if [[ "$CONFIRM" =~ ^[Yy]$ ]]; then
  git add package.json package-lock.json src-tauri/tauri.conf.json src-tauri/Cargo.toml
  git commit -m "Bump version to $NEW_VERSION"
  git tag "$TAG"
  git push origin master --tags
  echo ""
  echo "Done! Release workflow triggered for $TAG"
  echo "Check progress: https://github.com/brklyn8900/doberman/actions"
else
  echo "Aborted. Version files were updated but not committed."
  echo "Run 'git checkout -- .' to revert."
fi
