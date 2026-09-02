#!/usr/bin/env bash
# 任意（optional）の peerDependency の型が、公開する .d.ts に漏れていないか検査する。
#
# @geckou/billing の stripe は peerDependenciesMeta.optional = true。
# 公開 API の型が stripe の型を参照していると、RevenueCat だけを使う
# （stripe を入れていない）派生で `import { isSubscriptionActive }` しただけで
# TS2307: Cannot find module 'stripe' になる。
# 型チェックにもテストにも引っかからないので、ここで機械的に落とす。
set -euo pipefail

cd "$(dirname "$0")/.."

status=0

if [ -d packages/billing/dist ]; then
  if hits=$(grep -rnE "from ['\"]stripe['\"]|import\(['\"]stripe['\"]\)" \
    packages/billing/dist --include='*.d.ts' 2>/dev/null); then
    echo "❌ packages/billing/dist の型定義が任意 peer の stripe を参照しています:"
    echo "$hits"
    status=1
  fi
else
  echo "⚠️ packages/billing/dist がありません（先に yarn build を実行してください）"
  status=1
fi

if [ "$status" -eq 0 ]; then
  echo "✅ 公開する型定義に任意 peer への参照はありません"
fi

exit "$status"
