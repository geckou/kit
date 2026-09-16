#!/usr/bin/env bash
# ESM ビルドの出力先に {"type": "module"} だけの package.json を置く。
#
# パッケージ本体は "type": "commonjs"（既存の利用側が require できる形を保つ）。
# ESM の出力を .js のまま同じツリーに置くと Node もバンドラも CJS として読むため、
# 出力先にだけ type を上書きする package.json を置いて ESM だと知らせる。
#
#   bash scripts/emit-esm-package-json.sh <出力先ディレクトリ>
set -euo pipefail

DIRECTORY="${1:?出力先ディレクトリを指定してください}"

if [ ! -d "$DIRECTORY" ]; then
  echo "ディレクトリがありません（先に ESM ビルドを実行してください）: $DIRECTORY" >&2
  exit 1
fi

printf '%s\n' '{ "type": "module" }' > "$DIRECTORY/package.json"
