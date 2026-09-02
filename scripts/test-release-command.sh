#!/usr/bin/env bash
#
# **このファイルの正は geckou/project-starter/scripts/test-release-command.sh。**
# geckou/kit・geckou/ui にも同じものがあるが、直すときはまずここを直してから配ること
# （3 リポジトリで中身が同じであることを install-release-command.sh が前提にしている）。
set -u

# scripts/geckou-release と scripts/install-release-command.sh の回帰テスト。
#
# 検証するもの:
#   1. インストールでレジストリに登録され、コマンドが置かれる
#   2. 二重にインストールしても登録は重複しない
#   3. パッケージ名からリポジトリを引いて release.sh に渡す
#   4. オプションと複数パッケージがそのまま渡る
#   5. 未登録のパッケージ名は止める
#   6. 複数のリポジトリに同名のパッケージがあれば止める
#   7. 別々のリポジトリのパッケージをまとめて指定したら止める
#   8. 消えたリポジトリの登録は無視する。worktree（.git がファイル）は無視しない。
#      末尾に改行が無い最終行も読む
#   9. レジストリが無い / パッケージ未指定 / 不正な形式の名前は止める
#
# 実際のタグ打ちは行わない。release.sh は引数を書き出すだけのものに差し替える。

cd "$(dirname "$0")/.."
REPO_ROOT=$(pwd)

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

# release.sh を「引数を args.txt に書くだけ」に差し替えた偽リポジトリを作る
make_repo() {
  local dir=$1
  shift

  mkdir -p "$dir/.git" "$dir/scripts"
  cp "$REPO_ROOT/scripts/geckou-release" "$dir/scripts/geckou-release"
  cp "$REPO_ROOT/scripts/install-release-command.sh" "$dir/scripts/install-release-command.sh"

  cat > "$dir/scripts/release.sh" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$@" > "$(cd "$(dirname "$0")/.." && pwd)/args.txt"
echo "release.sh を実行した"
STUB

  for package in "$@"; do
    mkdir -p "$dir/packages/$package"
    printf '{ "name": "@geckou/%s", "version": "0.1.0" }\n' "$package" > "$dir/packages/$package/package.json"
  done
}

# 失敗して $WORK が空になると、以降の mkdir -p "$dir/..." が / 直下を触る
WORK=$(mktemp -d) || exit 1

if [ -z "$WORK" ] || [ ! -d "$WORK" ]; then
  echo "作業ディレクトリを作れませんでした。" >&2
  exit 1
fi

trap 'rm -rf "$WORK"' EXIT

export GECKOU_RELEASE_REGISTRY="$WORK/config/release-repos"
export GECKOU_RELEASE_BIN_DIR="$WORK/bin"

make_repo "$WORK/starter" eslint-config prettier-config
make_repo "$WORK/kit" billing
make_repo "$WORK/ui" core vue

COMMAND="$GECKOU_RELEASE_BIN_DIR/geckou-release"

echo "1. インストールで登録され、コマンドが置かれる"

output=$(bash "$WORK/starter/scripts/install-release-command.sh" 2>&1)

if [ -x "$COMMAND" ] && grep -qxF "$WORK/starter" "$GECKOU_RELEASE_REGISTRY"; then
  pass "登録とコマンドの設置"
else
  fail "登録とコマンドの設置" "$output"
fi

echo "2. 二重インストールで登録が重複しない"

bash "$WORK/starter/scripts/install-release-command.sh" > /dev/null 2>&1
count=$(grep -cxF "$WORK/starter" "$GECKOU_RELEASE_REGISTRY")

if [ "$count" -eq 1 ]; then
  pass "登録は 1 行のまま"
else
  fail "登録は 1 行のまま" "$count 行ある"
fi

bash "$WORK/kit/scripts/install-release-command.sh" > /dev/null 2>&1
bash "$WORK/ui/scripts/install-release-command.sh" > /dev/null 2>&1

echo "3. パッケージ名からリポジトリを引く"

output=$(cd "$WORK" && "$COMMAND" billing 2>&1)

if [ -f "$WORK/kit/args.txt" ] && [ ! -f "$WORK/starter/args.txt" ]; then
  pass "kit の release.sh が動いた"
else
  fail "kit の release.sh が動いた" "$output"
fi

echo "4. オプションと複数パッケージがそのまま渡る"

output=$(cd / && "$COMMAND" core vue --force 2>&1)
args=$(cat "$WORK/ui/args.txt" 2>/dev/null | tr '\n' ' ')

if [ "$args" = "core vue --force " ]; then
  pass "引数が素通しされる"
else
  fail "引数が素通しされる" "受け取った: [$args] / 出力: $output"
fi

echo "5. 未登録のパッケージ名は止める"

output=$(cd / && "$COMMAND" unknown-package 2>&1)
status=$?

if [ "$status" -ne 0 ] && echo "$output" | grep -q "登録されていません"; then
  pass "未登録なら止まる"
else
  fail "未登録なら止まる" "$output"
fi

echo "6. 同名のパッケージが複数のリポジトリにある"

mkdir -p "$WORK/kit/packages/core"
printf '{ "name": "@geckou/core", "version": "0.1.0" }\n' > "$WORK/kit/packages/core/package.json"

output=$(cd / && "$COMMAND" core 2>&1)
status=$?

if [ "$status" -ne 0 ] && echo "$output" | grep -q "複数のリポジトリ"; then
  pass "曖昧なら止まる"
else
  fail "曖昧なら止まる" "$output"
fi

rm -rf "$WORK/kit/packages/core"

echo "7. 別々のリポジトリのパッケージをまとめて指定"

output=$(cd / && "$COMMAND" billing core 2>&1)
status=$?

if [ "$status" -ne 0 ] && echo "$output" | grep -q "またがっています"; then
  pass "またがる指定は止まる"
else
  fail "またがる指定は止まる" "$output"
fi

echo "8. 消えたリポジトリの登録は無視する"

printf '%s\n' "$WORK/deleted-repo" >> "$GECKOU_RELEASE_REGISTRY"
rm -f "$WORK/kit/args.txt"
output=$(cd / && "$COMMAND" billing 2>&1)

if [ -f "$WORK/kit/args.txt" ]; then
  pass "存在しない登録があっても動く"
else
  fail "存在しない登録があっても動く" "$output"
fi

# git worktree / submodule では .git がディレクトリではなくファイルになる。
# .git のディレクトリ判定で実在チェックをすると、ここで見落とす
make_repo "$WORK/worktree-style" wt-package
rm -rf "$WORK/worktree-style/.git"
printf 'gitdir: /somewhere/.git/worktrees/x\n' > "$WORK/worktree-style/.git"
printf '%s\n' "$WORK/worktree-style" >> "$GECKOU_RELEASE_REGISTRY"

output=$(cd / && "$COMMAND" wt-package 2>&1)

if [ -f "$WORK/worktree-style/args.txt" ]; then
  pass "worktree（.git がファイル）でも解決できる"
else
  fail "worktree（.git がファイル）でも解決できる" "$output"
fi

# 手で編集されたレジストリは最終行に改行が無いことがある。
# while read はそのとき偽を返すので、素朴に書くとその行を取りこぼす
printf '%s' "$WORK/kit" > "$GECKOU_RELEASE_REGISTRY"
rm -f "$WORK/kit/args.txt"

output=$(cd / && "$COMMAND" billing 2>&1)

if [ -f "$WORK/kit/args.txt" ]; then
  pass "末尾に改行が無い最終行も読む"
else
  fail "末尾に改行が無い最終行も読む" "$output"
fi

# 後続のテストのためにレジストリを戻す
printf '%s\n%s\n%s\n' "$WORK/starter" "$WORK/kit" "$WORK/ui" > "$GECKOU_RELEASE_REGISTRY"

echo "9. レジストリが無い / パッケージ未指定"

output=$(cd / && GECKOU_RELEASE_REGISTRY="$WORK/missing" "$COMMAND" billing 2>&1)
status=$?

if [ "$status" -ne 0 ] && echo "$output" | grep -q "1 つも登録されていません"; then
  pass "レジストリが無ければ止まる"
else
  fail "レジストリが無ければ止まる" "$output"
fi

output=$(cd / && "$COMMAND" --force 2>&1)
status=$?

if [ "$status" -ne 0 ] && echo "$output" | grep -q "パッケージを指定してください"; then
  pass "パッケージ未指定なら止まる"
else
  fail "パッケージ未指定なら止まる" "$output"
fi

# パッケージ名はそのまま packages/<名前> のパスになる。release.sh と同じ検査を
# 手前でも行う（「リポジトリが無い」ではなく形式の誤りとして返す）
for invalid in '../../etc' 'Foo' 'a_b' ''; do
  output=$(cd / && "$COMMAND" "$invalid" 2>&1)
  status=$?

  if [ "$status" -ne 0 ] && echo "$output" | grep -Eq "形式が不正|パッケージを指定してください"; then
    pass "不正な名前は止まる: [$invalid]"
  else
    fail "不正な名前は止まる: [$invalid]" "$output"
  fi
done

echo ""
echo "成功 $passed / 失敗 $failed"

[ "$failed" -eq 0 ]
