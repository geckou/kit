#!/usr/bin/env bash
# 指定パッケージのバージョンを上げてタグを push し、publish ワークフローを起動する。
#   yarn release <パッケージのディレクトリ名> [patch|minor|major|<version>]
#
# タグは <パッケージのディレクトリ名>@<バージョン> 形式（例: billing@0.1.0）。
# publish ワークフローはこのタグから対象パッケージを判別する。
set -euo pipefail

PACKAGE="${1:-}"
BUMP="${2:-patch}"

if [ -z "$PACKAGE" ]; then
  echo "パッケージを指定してください: yarn release <パッケージ名> [patch|minor|major|<version>]" >&2
  exit 1
fi

PACKAGE_DIR="packages/$PACKAGE"

if [ ! -f "$PACKAGE_DIR/package.json" ]; then
  echo "$PACKAGE_DIR が存在しません。" >&2
  exit 1
fi

if [ -n "$(git status --porcelain)" ]; then
  echo "コミットされていない変更があります。先にコミットしてください。" >&2
  exit 1
fi

BRANCH="$(git rev-parse --abbrev-ref HEAD)"
if [ "$BRANCH" != "main" ]; then
  echo "main ブランチで実行してください（現在: $BRANCH）" >&2
  exit 1
fi

git pull --rebase origin main

case "$BUMP" in
  patch|minor|major) (cd "$PACKAGE_DIR" && yarn version "--$BUMP" --no-git-tag-version) ;;
  *)                 (cd "$PACKAGE_DIR" && yarn version --new-version "$BUMP" --no-git-tag-version) ;;
esac

VERSION="$(node -p "require('./$PACKAGE_DIR/package.json').version")"
TAG="$PACKAGE@$VERSION"

git add "$PACKAGE_DIR/package.json"
git commit -m "chore: $TAG"
git tag "$TAG"
git push origin main "$TAG"

echo "[done] $TAG を push しました。publish ワークフローが npm へ公開します。"
