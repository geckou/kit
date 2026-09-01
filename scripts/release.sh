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
if [ "$BRANCH" != "production" ]; then
  echo "production ブランチで実行してください（現在: $BRANCH）" >&2
  exit 1
fi

git pull --rebase origin production

case "$BUMP" in
  patch|minor|major) (cd "$PACKAGE_DIR" && yarn version "--$BUMP" --no-git-tag-version) ;;
  *)                 (cd "$PACKAGE_DIR" && yarn version --new-version "$BUMP" --no-git-tag-version) ;;
esac

VERSION="$(node -p "require('./$PACKAGE_DIR/package.json').version")"
TAG="$PACKAGE@$VERSION"

if git rev-parse -q --verify "refs/tags/$TAG" >/dev/null; then
  echo "タグ $TAG は既にローカルに存在します。" >&2
  exit 1
fi

if [ -n "$(git ls-remote --tags origin "refs/tags/$TAG")" ]; then
  echo "タグ $TAG は既に origin に存在します。" >&2
  exit 1
fi

# 新規パッケージの初回リリースでは、package.json が既に目的のバージョンで
# 差分が出ない。その場合コミットは作らず、現在の HEAD にタグだけ打つ
git add "$PACKAGE_DIR/package.json"

if git diff --cached --quiet; then
  echo "[skip] $PACKAGE_DIR/package.json は既に $VERSION のため、コミットは作成しません"
else
  git commit -m "chore: $TAG"
fi

git tag "$TAG"
git push origin production "$TAG"

echo "[done] $TAG を push しました。publish ワークフローが npm へ公開します。"
echo "       既に公開済みのバージョンなら publish はスキップされます。"
