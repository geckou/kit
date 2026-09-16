#!/usr/bin/env bash
#
# **このファイルの正は geckou/project-starter/scripts/test-module-formats.sh。**
# geckou/kit にも同じものがある。直すときはまずそちらを直してから配ること
# （2 リポジトリで中身が同じであることを前提にしている）。
#
# scripts/check-module-formats.mjs の回帰テスト。
#
#   bash scripts/test-module-formats.sh
#
# 一時ディレクトリに偽の packages/<名前> を組み立てて、チェッカーが落ちる形・
# 通る形をそれぞれ確かめる。本物のリポジトリも node_modules も触らない。
#
# **なぜ回帰テストが要るか**: このチェッカーが見逃すと、geckou/project-starter#377（firebase SDK の
# 二重インスタンスで Firestore へ一切通信できない）が CI 緑のまま再発する。
# 「落ちるはず」の形が本当に落ちることは、実際に走らせないと分からない。
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CHECKER="$REPO/scripts/check-module-formats.mjs"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

PASSED=0
FAILED=0

pass() {
  PASSED=$((PASSED + 1))
  echo "  [ok] $1"
}

fail() {
  FAILED=$((FAILED + 1))
  echo "  [NG] $1"
  echo "       ---- 出力 ----"
  echo "$LAST_OUT" | sed 's/^/       /'
}

# 検査対象のツリーを作り直す。$1 = パッケージ名
reset_tree() {
  rm -rf "$WORK/repo"
  mkdir -p "$WORK/repo/scripts" "$WORK/repo/packages/$1"
  cp "$CHECKER" "$WORK/repo/scripts/check-module-formats.mjs"
}

# set -e の下で失敗を捕まえるため、実行の間だけ切る
run_checker() {
  set +e
  LAST_OUT="$(cd "$WORK/repo" && node scripts/check-module-formats.mjs 2>&1)"
  LAST_STATUS=$?
  set -e
}

# 正常な二本立てのパッケージを 1 つ置く
write_dual_package() {
  local dir="$WORK/repo/packages/sample"

  mkdir -p "$dir/dist/esm" "$dir/src"
  printf '%s\n' 'export const a = 1' > "$dir/src/index.ts"
  printf '%s\n' 'exports.a = 1' > "$dir/dist/index.js"
  printf '%s\n' 'export const a = 1' > "$dir/dist/esm/index.js"
  printf '%s\n' '{ "type": "module" }' > "$dir/dist/esm/package.json"

  cat > "$dir/package.json" <<'JSON'
{
  "name": "@test/sample",
  "exports": {
    ".": {
      "types": "./src/index.ts",
      "import": "./dist/esm/index.js",
      "default": "./dist/index.js"
    },
    "./package.json": "./package.json"
  }
}
JSON
}

echo '=== check-module-formats: 公開物の ESM / CJS の検査 ==='

# ---- 1. 正常系 ----
reset_tree sample
write_dual_package
run_checker

if [ "$LAST_STATUS" -eq 0 ]; then
  pass "二本立てが揃っていれば通る"
else
  fail "二本立てが揃っていれば通る"
fi

# ---- 2. import 条件の中身が CJS ----
reset_tree sample
write_dual_package
printf '%s\n' 'exports.a = 1' > "$WORK/repo/packages/sample/dist/esm/index.js"
run_checker

if [ "$LAST_STATUS" -ne 0 ] && echo "$LAST_OUT" | grep -q 'ESM ではありません'; then
  pass "import 条件が ESM でなければ落ちる"
else
  fail "import 条件が ESM でなければ落ちる"
fi

# ---- 3. dist/esm に "type": "module" が無い ----
reset_tree sample
write_dual_package
rm "$WORK/repo/packages/sample/dist/esm/package.json"
run_checker

if [ "$LAST_STATUS" -ne 0 ] && echo "$LAST_OUT" | grep -q '"type": "module" の配下にありません'; then
  pass '"type": "module" が無ければ落ちる'
else
  fail '"type": "module" が無ければ落ちる'
fi

# ---- 4. require 側（import と並ぶ default）が ESM ----
reset_tree sample
write_dual_package
printf '%s\n' 'export const a = 1' > "$WORK/repo/packages/sample/dist/index.js"
run_checker

if [ "$LAST_STATUS" -ne 0 ] && echo "$LAST_OUT" | grep -q 'CJS ではありません'; then
  pass "import と並ぶ default が ESM なら落ちる"
else
  fail "import と並ぶ default が ESM なら落ちる"
fi

# ---- 5. 条件が指すファイルが無い ----
reset_tree sample
write_dual_package
rm "$WORK/repo/packages/sample/dist/esm/index.js"
run_checker

if [ "$LAST_STATUS" -ne 0 ] && echo "$LAST_OUT" | grep -q 'ファイルがありません'; then
  pass "条件が指すファイルが無ければ落ちる"
else
  fail "条件が指すファイルが無ければ落ちる"
fi

# ---- 6. 二本立てなのに import 条件を持たないサブパスがある（geckou/project-starter#377 の再発の形）----
reset_tree sample
write_dual_package
printf '%s\n' 'export const b = 2' > "$WORK/repo/packages/sample/src/extra.ts"
printf '%s\n' 'exports.b = 2' > "$WORK/repo/packages/sample/dist/extra.js"
node -e "
const fs = require('fs')
const path = '$WORK/repo/packages/sample/package.json'
const manifest = JSON.parse(fs.readFileSync(path, 'utf8'))

manifest.exports['./extra'] = {
  types: './src/extra.ts',
  default: './dist/extra.js',
}

fs.writeFileSync(path, JSON.stringify(manifest, null, 2))
"
run_checker

if [ "$LAST_STATUS" -ne 0 ] && echo "$LAST_OUT" | grep -q 'import 条件がありません'; then
  pass "二本立てで import 条件を取りこぼしたサブパスがあれば落ちる"
else
  fail "二本立てで import 条件を取りこぼしたサブパスがあれば落ちる"
fi

# ---- 7. CJS だけのパッケージは落とさない（未手当ての派生を赤くしない）----
reset_tree sample
mkdir -p "$WORK/repo/packages/sample/dist" "$WORK/repo/packages/sample/src"
printf '%s\n' 'export const a = 1' > "$WORK/repo/packages/sample/src/index.ts"
printf '%s\n' 'exports.a = 1' > "$WORK/repo/packages/sample/dist/index.js"
cat > "$WORK/repo/packages/sample/package.json" <<'JSON'
{
  "name": "@test/sample",
  "exports": {
    ".": { "types": "./src/index.ts", "default": "./dist/index.js" }
  }
}
JSON
run_checker

if [ "$LAST_STATUS" -eq 0 ]; then
  pass "CJS だけのパッケージは通る"
else
  fail "CJS だけのパッケージは通る"
fi

# ---- 8. 丸ごと ESM のパッケージ（文字列サブパス）は落とさない ----
reset_tree sample
printf '%s\n' 'export const a = 1' > "$WORK/repo/packages/sample/index.js"
cat > "$WORK/repo/packages/sample/package.json" <<'JSON'
{
  "name": "@test/sample",
  "type": "module",
  "exports": { ".": "./index.js", "./package.json": "./package.json" }
}
JSON
run_checker

if [ "$LAST_STATUS" -eq 0 ]; then
  pass "丸ごと ESM のパッケージは通る（条件なしのサブパス）"
else
  fail "丸ごと ESM のパッケージは通る（条件なしのサブパス）"
fi

# ---- 9. ワイルドカードのサブパスを存在しないファイル扱いにしない ----
reset_tree sample
write_dual_package
node -e "
const fs = require('fs')
const path = '$WORK/repo/packages/sample/package.json'
const manifest = JSON.parse(fs.readFileSync(path, 'utf8'))

manifest.exports['./*'] = {
  types: './dist/*.d.ts',
  import: './dist/esm/*.js',
  default: './dist/*.js',
}

fs.writeFileSync(path, JSON.stringify(manifest, null, 2))
"
run_checker

if [ "$LAST_STATUS" -eq 0 ]; then
  pass "ワイルドカードのサブパスは存在検査の対象外"
else
  fail "ワイルドカードのサブパスは存在検査の対象外"
fi

# ---- 10. 入れ子の条件（{ browser: { import, default } }）を取りこぼし扱いしない ----
reset_tree sample
write_dual_package
printf '%s\n' 'export const b = 2' > "$WORK/repo/packages/sample/src/extra.ts"
printf '%s\n' 'exports.b = 2' > "$WORK/repo/packages/sample/dist/extra.js"
printf '%s\n' 'export const b = 2' > "$WORK/repo/packages/sample/dist/esm/extra.js"
node -e "
const fs = require('fs')
const path = '$WORK/repo/packages/sample/package.json'
const manifest = JSON.parse(fs.readFileSync(path, 'utf8'))

manifest.exports['./extra'] = {
  types: './src/extra.ts',
  browser: {
    import: './dist/esm/extra.js',
    default: './dist/extra.js',
  },
}

fs.writeFileSync(path, JSON.stringify(manifest, null, 2))
"
run_checker

if [ "$LAST_STATUS" -eq 0 ]; then
  pass "入れ子の条件の中の import 条件を見つける"
else
  fail "入れ子の条件の中の import 条件を見つける"
fi

# ---- 11. packages/ が無い構成では落とさない ----
rm -rf "$WORK/repo"
mkdir -p "$WORK/repo/scripts"
cp "$CHECKER" "$WORK/repo/scripts/check-module-formats.mjs"
run_checker

if [ "$LAST_STATUS" -eq 0 ] && echo "$LAST_OUT" | grep -q '\[skip\]'; then
  pass "packages/ が無ければスキップする"
else
  fail "packages/ が無ければスキップする"
fi

echo
echo "=== 結果: ${PASSED} 件成功 / ${FAILED} 件失敗 ==="

[ "$FAILED" -eq 0 ]
