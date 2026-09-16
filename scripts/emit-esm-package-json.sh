#!/usr/bin/env bash
#
# **このファイルの正は geckou/project-starter/scripts/emit-esm-package-json.sh。**
# geckou/kit にも同じものがあるが、直すときはまずここを直してから配ること
# （2 リポジトリで中身が同じであることを前提にしている）。
#
# ESM ビルドの出力先に {"type": "module"} だけの package.json を置く。
#
# パッケージ本体は CJS（"type" 無し = commonjs）のまま保つ。apps/functions の
# ような require 側の利用者が exports の default 条件で dist を読むため。
# ESM の出力を .js のまま同じツリーに置くと Node もバンドラも CJS として
# 解釈するので、出力先にだけ type を上書きする package.json を置いて知らせる。
#
# ビルド前（watch の開始時）にも呼べるよう、出力先が無ければ作る。この 1 ファイルが
# 欠けると .js が CJS として解釈され、import 条件が黙って CJS に落ちる。
#
#   bash scripts/emit-esm-package-json.sh <出力先ディレクトリ>
set -euo pipefail

DIRECTORY="${1:?出力先ディレクトリを指定してください}"

mkdir -p "$DIRECTORY"

printf '%s\n' '{ "type": "module" }' > "$DIRECTORY/package.json"
