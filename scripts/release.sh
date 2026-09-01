#!/usr/bin/env bash
# パッケージを npm へ公開する。タグ（<ディレクトリ名>@<バージョン>）を打つだけで、
# 公開そのものは .github/workflows/publish.yml が行う。
#
#   yarn release <パッケージのディレクトリ名>...
#   yarn release core react vue        # 複数まとめて打てる
#
# **バージョンを上げるのはこのスクリプトではない。** production への直接 push は
# 禁止されているため、version の変更は通常の PR で入れる。マージ後にここでタグを打つ、
# という2段構えにしている。
#
#   1. packages/<パッケージ>/package.json の version を上げる PR を出してマージする
#   2. production を pull して yarn release <パッケージ>...
#
# **HEAD が origin/production と一致していることを確認してから打つ。** 手元が古いまま
# タグを打つと、GitHub は「タグが指すコミットのワークフローファイル」で実行するため、
# 古い publish.yml が動いて意図しない中身が公開されうる（実際に踏んだ事故）。
#
# タグは 1 本ずつ push する。まとめて push すると GitHub がワークフローを起動しない
# ことがある。
set -euo pipefail

if [ "$#" -eq 0 ]; then
  echo "パッケージを指定してください: yarn release <パッケージのディレクトリ名>..." >&2
  exit 1
fi

PACKAGES=("$@")

if [ -n "$(git status --porcelain)" ]; then
  echo "コミットされていない変更があります。先にコミットしてください。" >&2
  exit 1
fi

BRANCH="$(git rev-parse --abbrev-ref HEAD)"

if [ "$BRANCH" != "production" ]; then
  echo "production ブランチで実行してください（現在: $BRANCH）" >&2
  exit 1
fi

git fetch --quiet origin production

if [ "$(git rev-parse HEAD)" != "$(git rev-parse FETCH_HEAD)" ]; then
  echo "HEAD が origin/production と一致していません。git pull --ff-only origin production を実行してください。" >&2
  echo "  HEAD             : $(git rev-parse --short HEAD) $(git log -1 --format=%s HEAD)" >&2
  echo "  origin/production: $(git rev-parse --short FETCH_HEAD) $(git log -1 --format=%s FETCH_HEAD)" >&2
  exit 1
fi

# 打つ前に全部検査する。途中で失敗して一部だけタグが付いた状態を作らないため
TAGS=()

for PACKAGE in "${PACKAGES[@]}"; do
  PACKAGE_DIR="packages/$PACKAGE"

  if [ ! -f "$PACKAGE_DIR/package.json" ]; then
    echo "$PACKAGE_DIR が存在しません。" >&2
    exit 1
  fi

  if [ "$(node -p "require('./$PACKAGE_DIR/package.json').private === true")" = "true" ]; then
    echo "$PACKAGE_DIR は private です（公開対象ではありません）。" >&2
    exit 1
  fi

  VERSION="$(node -p "require('./$PACKAGE_DIR/package.json').version")"
  TAG="$PACKAGE@$VERSION"

  if git rev-parse -q --verify "refs/tags/$TAG" > /dev/null; then
    echo "タグ $TAG は既にローカルに存在します。version を上げてください。" >&2
    exit 1
  fi

  if [ -n "$(git ls-remote --tags origin "refs/tags/$TAG")" ]; then
    echo "タグ $TAG は既に origin に存在します。version を上げてください。" >&2
    exit 1
  fi

  TAGS+=("$TAG")
done

for TAG in "${TAGS[@]}"; do
  git tag "$TAG"
  git push origin "$TAG"
  echo "[done] $TAG を push しました。"
done

echo ""
echo "publish ワークフローが npm へ公開します。既に公開済みのバージョンならスキップされます。"
