#!/usr/bin/env bash
# geckou-release をどこからでも実行できるようにする。
#
#   bash scripts/install-release-command.sh
#
# やること:
#   1. このリポジトリの絶対パスをレジストリへ登録する
#   2. scripts/geckou-release を PATH の通ったディレクトリへ置く
#
# 各リポジトリで一度ずつ実行する。リポジトリを移動したら実行し直す。
# 何度実行しても同じ結果になる（登録は重複しない。コマンドは上書きする）。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

REGISTRY="${GECKOU_RELEASE_REGISTRY:-${XDG_CONFIG_HOME:-$HOME/.config}/geckou/release-repos}"
BIN_DIR="${GECKOU_RELEASE_BIN_DIR:-${XDG_BIN_HOME:-$HOME/.local/bin}}"

if [ ! -f "$SCRIPT_DIR/geckou-release" ]; then
  echo "scripts/geckou-release が見つかりません。" >&2
  exit 1
fi

mkdir -p "$(dirname "$REGISTRY")" "$BIN_DIR"
touch "$REGISTRY"

# 同じリポジトリを二重に登録しない。パスの前方一致ではなく行全体で比較する
if grep -qxF "$REPO_ROOT" "$REGISTRY"; then
  echo "[skip] 登録済み: $REPO_ROOT"
else
  printf '%s\n' "$REPO_ROOT" >> "$REGISTRY"
  echo "[ok] 登録した: $REPO_ROOT"
fi

# コピーではなくその都度上書きする。3 リポジトリのどれから実行しても
# 中身は同じなので、最後に実行したものが残ればよい
cp "$SCRIPT_DIR/geckou-release" "$BIN_DIR/geckou-release"
chmod +x "$BIN_DIR/geckou-release"
echo "[ok] 置いた: $BIN_DIR/geckou-release"

case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *)
    echo ""
    echo "$BIN_DIR が PATH に入っていません。シェルの設定に次を足してください:"
    echo "  export PATH=\"$BIN_DIR:\$PATH\""
    ;;
esac

echo ""
echo "以降はどこからでも実行できます:"
echo "  geckou-release <パッケージのディレクトリ名>... [--force]"
