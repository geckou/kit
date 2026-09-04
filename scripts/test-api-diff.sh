#!/usr/bin/env bash
#
# **このファイルの正は geckou/project-starter/scripts/test-api-diff.sh。**
# geckou/kit・geckou/ui にも同じものがあるが、直すときはまずここを直してから配ること
# （3 リポジトリで中身が同じであることを install-release-command.sh が前提にしている）。
set -u

# scripts/check-api-diff.mjs の回帰テスト。
#
# 検証するもの:
#   1. 型定義に差分が無ければ通す
#   2. 型定義が変わっていれば止めて、差分を表示する
#   3. エクスポートの追加も差分として検出する（互換の追加かは人が判断する）
#   4. 型定義を持たないパッケージは止めず、内容が変わっていることを警告する
#   5. ビルドできない環境では止めない（検査できないだけ）
#   6. tarball を展開できないときは止めない
#   7. 存在しないパッケージ・引数なしはエラーになる
#   8. ブロック時も一時ディレクトリを消し、差分は stderr に出す
#   9. 比較対象に「同じ major.minor の公開済み最大 patch」を選ぶ
#
# 公開物の取得は --published-tarball で差し替える（ネットワークに依存させないため）。
# 比較対象の選択（npm view）だけは偽の npm を PATH の先頭に置いて検証する。
# curl 経由のダウンロードは、その性質上ここでは検証できない。

cd "$(dirname "$0")/.."
REPO_ROOT=$(pwd)
SCRIPT="$REPO_ROOT/scripts/check-api-diff.mjs"

passed=0
failed=0

pass() {
  passed=$((passed + 1))
  echo "  [ok] $1"
}

fail() {
  failed=$((failed + 1))
  echo "  [NG] $1"
  if [ -n "${2:-}" ]; then
    echo "$2" | sed 's/^/       /'
  fi
}

# 検査対象のワークスペースを作る。$1 に dist/index.d.ts の中身を渡す
make_package() {
  local dir=$1
  local types=$2
  local version=${3:-0.1.1}

  mkdir -p "$dir/packages/demo/dist"
  cat > "$dir/packages/demo/package.json" <<JSON
{
  "name": "@geckou/demo",
  "version": "$version",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "files": ["dist"]
}
JSON
  printf 'export const demo = 1\n' > "$dir/packages/demo/dist/index.js"

  if [ -n "$types" ]; then
    printf '%s\n' "$types" > "$dir/packages/demo/dist/index.d.ts"
  fi
}

# 公開済みの tarball を作る
pack_published() {
  local dir=$1
  local output
  local packed

  # ファイル名は npm の命名に任せる（version を変えても壊れないように）。
  # pack に失敗したまま進むと、後続の検証が意味を失うのでテストごと落とす
  if ! output=$(cd "$dir/packages/demo" && npm pack --silent --pack-destination "$dir" 2>&1); then
    echo "  [NG] npm pack に失敗しました" >&2
    echo "$output" | sed 's/^/       /' >&2
    exit 1
  fi

  packed=$(printf '%s' "$output" | tail -1)

  if [ -z "$packed" ] || [ ! -f "$dir/$packed" ]; then
    echo "  [NG] npm pack の出力からファイルを特定できませんでした: '$packed'" >&2
    exit 1
  fi

  echo "$dir/$packed"
}

check() {
  local workspace=$1
  local tarball=$2
  (cd "$workspace" && node "$SCRIPT" demo --published-tarball "$tarball" 2>&1)
}

echo "=== check-api-diff.mjs の回帰テスト ==="
echo ""

echo "[1] 型定義に差分が無い"
work=$(mktemp -d)
make_package "$work" 'export declare const demo: number'
published=$(pack_published "$work")
output=$(check "$work" "$published")
status=$?

if [ "$status" -eq 0 ] && printf '%s' "$output" | grep -q '差分はありません'; then
  pass "差分が無ければ通す"
else
  fail "差分が無いのに止めた（status=$status）" "$output"
fi

rm -rf "$work"
echo ""

echo "[2] 型定義が変わっている"
work=$(mktemp -d)
make_package "$work" 'export declare const demo: string[]'
published=$(pack_published "$work")
# 公開後に props の型を変えた状況（今回の CheckBoxes と同じ形）
printf 'export declare const demo: (string | number)[]\n' > "$work/packages/demo/dist/index.d.ts"
output=$(check "$work" "$published")
status=$?

if [ "$status" -ne 0 ]; then
  pass "型が変わっていれば止める"
else
  fail "型が変わったのに通した" "$output"
fi

if printf '%s' "$output" | grep -q 'dist/index.d.ts'; then
  pass "変わったファイル名を出す"
else
  fail "ファイル名が出ない" "$output"
fi

if printf '%s' "$output" | grep -q 'string | number'; then
  pass "差分の中身を出す"
else
  fail "差分の中身が出ない" "$output"
fi

if printf '%s' "$output" | grep -q 'minor 以上'; then
  pass "どうすればよいかを出す"
else
  fail "対処方法が出ない" "$output"
fi

rm -rf "$work"
echo ""

echo "[3] エクスポートの追加"
work=$(mktemp -d)
make_package "$work" 'export declare const demo: number'
published=$(pack_published "$work")
printf 'export declare const demo: number\nexport declare const added: string\n' \
  > "$work/packages/demo/dist/index.d.ts"
output=$(check "$work" "$published")
status=$?

if [ "$status" -ne 0 ]; then
  pass "追加も差分として止める（互換かは人が判断する）"
else
  fail "追加を見逃した" "$output"
fi

rm -rf "$work"
echo ""

echo "[4] 型定義を持たないパッケージ"
work=$(mktemp -d)
make_package "$work" ''
published=$(pack_published "$work")
printf 'export const demo = 2\n' > "$work/packages/demo/dist/index.js"
output=$(check "$work" "$published")
status=$?

if [ "$status" -eq 0 ]; then
  pass "型定義が無ければ止めない"
else
  fail "型定義が無いのに止めた" "$output"
fi

if printf '%s' "$output" | grep -q 'warn'; then
  pass "内容が変わっていることは警告する"
else
  fail "警告が出ない" "$output"
fi

rm -rf "$work"
echo ""

echo "[5] ビルドできないとき"
work=$(mktemp -d)
make_package "$work" 'export declare const demo: number'
published=$(pack_published "$work")
# build が失敗する状況（依存が入っていない等）
node -e "
const fs=require('fs');const p='$work/packages/demo/package.json';
const j=JSON.parse(fs.readFileSync(p,'utf8'));
j.scripts={build:'exit 1'};
fs.writeFileSync(p, JSON.stringify(j,null,2));
"
printf 'export declare const demo: string\n' > "$work/packages/demo/dist/index.d.ts"
output=$(check "$work" "$published")
status=$?

if [ "$status" -eq 0 ]; then
  pass "ビルドできなければ止めない（検査できないだけ）"
else
  fail "ビルド失敗で止めた" "$output"
fi

if printf '%s' "$output" | grep -q 'skip'; then
  pass "検査しなかったことを出す"
else
  fail "skip の理由が出ない" "$output"
fi

rm -rf "$work"
echo ""

echo "[6] tarball が壊れているとき"
work=$(mktemp -d)
make_package "$work" 'export declare const demo: number'
printf 'これは tarball ではない\n' > "$work/broken.tgz"
output=$(check "$work" "$work/broken.tgz")
status=$?

if [ "$status" -eq 0 ]; then
  pass "展開できなければ止めない（検査できないだけ）"
else
  fail "壊れた tarball で止めた" "$output"
fi

if printf '%s' "$output" | grep -q 'skip'; then
  pass "展開できなかったことを出す"
else
  fail "skip の理由が出ない" "$output"
fi

rm -rf "$work"
echo ""

echo "[7] 引数の検査"
work=$(mktemp -d)
make_package "$work" 'export declare const demo: number'
published=$(pack_published "$work")

if (cd "$work" && node "$SCRIPT" nope --published-tarball "$published") > /dev/null 2>&1; then
  fail "存在しないパッケージがエラーにならない"
else
  pass "存在しないパッケージはエラーになる"
fi

if (cd "$work" && node "$SCRIPT") > /dev/null 2>&1; then
  fail "引数なしがエラーにならない"
else
  pass "引数なしはエラーになる"
fi

output=$(cd "$work" && node "$SCRIPT" demo --published-tarball 2>&1)

if printf '%s' "$output" | grep -q 'パスを指定'; then
  pass "--published-tarball の値が無ければ、その旨のエラーになる"
else
  fail "値なしのエラーが分かりにくい" "$output"
fi

output=$(cd "$work" && node "$SCRIPT" demo --published-tarball /nope.tgz 2>&1)

if printf '%s' "$output" | grep -q 'ファイルがありません'; then
  pass "--published-tarball のファイルが無ければ、その旨のエラーになる"
else
  fail "存在しないファイルのエラーが分かりにくい" "$output"
fi

output=$(cd "$work" && node "$SCRIPT" demo --published-tarball "$work" 2>&1)

if printf '%s' "$output" | grep -q 'ファイルを指定'; then
  pass "ディレクトリを渡したら、その旨のエラーになる"
else
  fail "ディレクトリのエラーが分かりにくい" "$output"
fi

# `-` 始まりのファイル名は正当。オプションと誤認しない
cp "$published" "$work/-fixture.tgz"
output=$(cd "$work" && node "$SCRIPT" demo --published-tarball ./-fixture.tgz 2>&1)
status=$?

if [ "$status" -eq 0 ] && printf '%s' "$output" | grep -q '差分はありません'; then
  pass "- 始まりのファイル名も受け付ける"
else
  fail "- 始まりのファイル名を弾いた" "$output"
fi

rm -rf "$work"
echo ""

echo "[8] ブロックしたときの後片付けと出力先"
work=$(mktemp -d)
tmp=$(mktemp -d)
make_package "$work" 'export declare const demo: string[]'
published=$(pack_published "$work")
printf 'export declare const demo: (string | number)[]\n' > "$work/packages/demo/dist/index.d.ts"

output=$(cd "$work" && TMPDIR="$tmp" node "$SCRIPT" demo --published-tarball "$published" 2>&1)
status=$?

if [ "$status" -ne 0 ]; then
  pass "型が変わっていれば止める（後片付けの前提）"
else
  fail "止まらなかったので後片付けを検証できない" "$output"
fi

# process.exit で抜けると finally が走らず、展開物が tmpdir に溜まっていた
leftovers=$(find "$tmp" -maxdepth 1 -name 'api-diff-*' 2>/dev/null)

if [ -z "$leftovers" ]; then
  pass "ブロック時も一時ディレクトリを消す"
else
  fail "一時ディレクトリが残った" "$leftovers"
fi

# 見出しと差分の出力先が割れていると、2>/dev/null したときに差分だけが文脈なしで残る。
# stdout に無いことだけを見ると、何も出力されなくなる退行を見逃すので stderr 側も見る
out_only=$(cd "$work" && node "$SCRIPT" demo --published-tarball "$published" 2> /dev/null)
err_only=$(cd "$work" && node "$SCRIPT" demo --published-tarball "$published" 2>&1 > /dev/null)

if printf '%s' "$err_only" | grep -q 'dist/index.d.ts'; then
  pass "差分を stderr に出す（見出しと同じ側）"
else
  fail "stderr に差分が出ていない" "$err_only"
fi

if ! printf '%s' "$out_only" | grep -q 'dist/index.d.ts'; then
  pass "差分は stdout には出さない"
else
  fail "差分が stdout に出ている" "$out_only"
fi

rm -rf "$work" "$tmp"
echo ""

echo "[9] 比較対象の選び方（npm view）"

# --published-tarball を渡さない経路を検証する。偽の npm を PATH の先頭に置き、
# `npm view <name> versions --json` の出力を差し替える。
# 実際のダウンロード（curl）まで進むと止まるので、判定に使うのは
# 「どのバージョンと比較しようとしたか」を示すメッセージだけにする。
# どのバージョンと比較しようとしたかは、続く `npm view <name>@<version> dist.tarball`
# の引数に現れる。偽の npm に呼び出しを記録させて、そこを直接見る
# （tarball の取得は curl 経由なのでここでは進めない）
LAST_OUTPUT=''
LAST_CALLS=''

# check_versions <公開済みバージョンの JSON> <これから出す version>
check_versions() {
  local versions=$1
  local next=$2
  local dir

  dir=$(mktemp -d)
  make_package "$dir" 'export declare const demo: number' "$next"

  mkdir -p "$dir/bin"
  cat > "$dir/bin/npm" <<FAKE
#!/bin/sh
printf '%s\n' "\$*" >> "$dir/npm-calls.log"
# view <name> versions --json だけ答える。それ以外は「取得できない」を返す
if [ "\$1" = view ] && [ "\$3" = versions ]; then
  printf '%s\n' '$versions'
  exit 0
fi
exit 1
FAKE
  chmod +x "$dir/bin/npm"

  LAST_OUTPUT=$(cd "$dir" && PATH="$dir/bin:$PATH" node "$SCRIPT" demo 2>&1)
  LAST_CALLS=$(cat "$dir/npm-calls.log" 2>/dev/null || true)

  rm -rf "$dir"
}

# 0.3.0 が公開済みでも、0.2.x のバックポートは 0.2 系の最大 patch と比べる。
# latest とだけ比べる作りだと「minor が違う」として素通りしていた
check_versions '["0.1.0","0.2.4","0.2.10","0.2.9","0.3.0"]' '0.2.5'

if printf '%s' "$LAST_CALLS" | grep -q 'view @geckou/demo@0\.2\.10 dist\.tarball'; then
  pass "同じ major.minor の最大 patch を選ぶ（patch は数値で比べる）"
else
  fail "バックポート時の比較対象が違う" "$LAST_CALLS"
fi

if ! printf '%s' "$LAST_OUTPUT" | grep -q '検査しません'; then
  pass "バックポートを「検査不要」と判定しない"
else
  fail "バックポートが素通りしている" "$LAST_OUTPUT"
fi

# 公開が 1 件だけのとき npm は配列ではなく文字列を返す
check_versions '"0.2.1"' '0.2.2'

if printf '%s' "$LAST_CALLS" | grep -q 'view @geckou/demo@0\.2\.1 dist\.tarball'; then
  pass "単一文字列の応答も扱える"
else
  fail "単一文字列の応答を扱えていない" "$LAST_CALLS"
fi

# prerelease は比較対象にしない
check_versions '["0.2.1","0.2.2-rc1"]' '0.2.3'

if printf '%s' "$LAST_CALLS" | grep -q 'view @geckou/demo@0\.2\.1 dist\.tarball'; then
  pass "prerelease は比較対象から外す"
else
  fail "prerelease を比較対象にしている" "$LAST_CALLS"
fi

# 同じ系列に公開済みが無ければ（新しい minor）検査しない
check_versions '["0.2.1","0.2.2"]' '0.3.0'

if printf '%s' "$LAST_OUTPUT" | grep -q '検査しません'; then
  pass "同じ major.minor が無ければ検査しない"
else
  fail "新しい minor で検査しようとした" "$LAST_OUTPUT"
fi

# npm を参照できないときは素通しする（事故を防ぐ安全網であって、公開を守る仕組みではない）
broken=$(mktemp -d)
make_package "$broken" 'export declare const demo: number' '0.2.5'
mkdir -p "$broken/bin"
printf '#!/bin/sh\nexit 1\n' > "$broken/bin/npm"
chmod +x "$broken/bin/npm"
output=$(cd "$broken" && PATH="$broken/bin:$PATH" node "$SCRIPT" demo 2>&1)
status=$?

if [ "$status" -eq 0 ] && printf '%s' "$output" | grep -q '未公開か'; then
  pass "npm を参照できないときは素通しする"
else
  fail "npm 参照失敗の扱いが違う（status=$status）" "$output"
fi

rm -rf "$broken"

echo ""
echo "=== 結果: ${passed} 件成功 / ${failed} 件失敗 ==="

if [ "$failed" -gt 0 ]; then
  exit 1
fi
