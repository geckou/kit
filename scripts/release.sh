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

# --no-tags: ここではコミットの比較だけが目的。既定設定ではタグも追従フェッチされ、
# 下のローカルタグ検査を無関係な理由で踏むことがある
git fetch --quiet --no-tags origin production

if [ "$(git rev-parse HEAD)" != "$(git rev-parse FETCH_HEAD)" ]; then
  echo "HEAD が origin/production と一致していません。git pull --ff-only origin production を実行してください。" >&2
  echo "  HEAD             : $(git rev-parse --short HEAD) $(git log -1 --format=%s HEAD)" >&2
  echo "  origin/production: $(git rev-parse --short FETCH_HEAD) $(git log -1 --format=%s FETCH_HEAD)" >&2
  exit 1
fi

# タグを打つ前に、指定された全パッケージを検査する。入力の不備（存在しない・private・
# 重複・タグが既にある）で「一部だけ打った」状態になるのを防ぐため。
# push そのものが途中で失敗した場合（ネットワーク等）は、それまでのタグが残る
TAGS=()

for PACKAGE in "${PACKAGES[@]}"; do
  # パッケージ名はそのままパスの一部になり、タグ名にもなる。先に形式を検査して、
  # ../ によるパストラバーサルと、node へ渡す式への注入の余地を消す
  # （publish.yml の Resolve target package と同じ検査）
  if [[ ! "$PACKAGE" =~ ^[a-z0-9]+(-[a-z0-9]+)*$ ]]; then
    echo "パッケージ名の形式が不正です（ケバブケースのディレクトリ名のみ）: $PACKAGE" >&2
    exit 1
  fi

  PACKAGE_DIR="packages/$PACKAGE"
  PACKAGE_JSON="$PWD/$PACKAGE_DIR/package.json"

  if [ ! -f "$PACKAGE_JSON" ]; then
    echo "$PACKAGE_DIR が存在しません。" >&2
    exit 1
  fi

  # パスは環境変数で渡す（node の式に文字列として展開しない）
  if [ "$(PACKAGE_JSON="$PACKAGE_JSON" node -p 'require(process.env.PACKAGE_JSON).private === true')" = "true" ]; then
    echo "$PACKAGE_DIR は private です（公開対象ではありません）。" >&2
    exit 1
  fi

  VERSION="$(PACKAGE_JSON="$PACKAGE_JSON" node -p 'require(process.env.PACKAGE_JSON).version')"
  TAG="$PACKAGE@$VERSION"

  # 同じパッケージを 2 回指定されると、1 本目を push した後に 2 本目の git tag が
  # 失敗して「一部だけタグが付いた」状態になる
  for EXISTING in ${TAGS[@]+"${TAGS[@]}"}; do
    if [ "$EXISTING" = "$TAG" ]; then
      echo "同じパッケージが重複して指定されています: $PACKAGE" >&2
      exit 1
    fi
  done

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
