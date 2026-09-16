#!/usr/bin/env node
//
// **このファイルの正は geckou/project-starter/scripts/check-module-formats.mjs。**
// geckou/kit にも同じものがあるが、直すときはまずここを直してから配ること
// （2 リポジトリで中身が同じであることを前提にしている）。
//
// packages/* の公開物が package.json の exports の条件どおりの形式（ESM / CJS）に
// なっているかを検査する。
//
//   node scripts/check-module-formats.mjs        # 先に yarn build が要る
//
// **なぜ必要か**: `import` 条件を持たない CJS のみのパッケージを ESM のアプリ
// （Next.js / Expo）から使うと、パッケージが require した firebase SDK とアプリが
// import した firebase SDK が別インスタンスになる。firebase は db / auth を
// instanceof で検査するため、Firestore への通信が一切できなくなる（geckou/project-starter#377）。
// exports に条件を足しても、出力が実際に ESM になっていなければ同じことが起きる。
// 型チェックにもテストにも引っかからないので、ここで機械的に落とす。
//
// 見るのは 4 つ。
//   1. exports が指すファイルが実在するか
//   2. import 条件の JS が本当に ESM か（"type": "module" の配下にあるか込み）
//   3. その裏（require 条件と、import と並ぶ default）が本当に CJS か
//   4. **二本立てのパッケージで、import 条件を持たないサブパスが無いか**
//      （1 つ取りこぼすとそのサブパスだけ geckou/project-starter#377 の状態に戻る）
//
// 条件を持たないサブパス（"./index.js" のような文字列だけ）は、パッケージ全体の
// "type" がその形式を決めているので存在検査だけにする。@geckou/eslint-config の
// ように丸ごと ESM のパッケージを落とさないため。
//
// 4 は「そのパッケージが既に import 条件を 1 つでも持っている」ときだけ見る。
// CJS だけを出しているパッケージ（まだ手当てしていない派生の packages/shared 等）を
// 同期が届いた瞬間に赤くしないため。二本立てにすると決めた時点から一貫性を強制する。
//
// ここで検査できないこと: **shared が依存する npm パッケージが ESM を出しているか。**
// 依存側に import 条件が無ければ、shared を ESM にしても連鎖の先で CJS に落ちる
// （geckou/project-starter#377 はこれも原因だった）。パッケージを足すときは人が見る（→ architecture.md）。

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PACKAGES_DIRECTORY = path.join(ROOT, 'packages')

const problems = []

// exports は入れ子（条件の中に条件）になるので、葉（文字列）まで降りて
// 「どの条件の下にあるか」と一緒に集める
function collectTargets(node, conditions, targets) {
  if (typeof node === 'string') {
    targets.push({ target: node, conditions })

    return
  }

  if (node === null || typeof node !== 'object') return

  // import と並ぶ default は require 側のフォールバック。同じ扱いで検査する
  const hasImportSibling = Object.hasOwn(node, 'import')

  for (const [key, value] of Object.entries(node)) {
    // サブパス（"." や "./firestore"）は条件ではないので積まない
    if (key.startsWith('.')) {
      collectTargets(value, conditions, targets)
      continue
    }

    const condition = key === 'default' && hasImportSibling ? 'require' : key

    collectTargets(value, [...conditions, condition], targets)
  }
}

function isEsmSource(source) {
  return /^\s*(import|export)\s/m.test(source)
}

// Node は最も近い package.json の "type" で .js を解釈する。
// ESM の出力を .js のまま置く場合、その階層に "type": "module" が要る
function nearestTypeField(filePath, packageDirectory) {
  let directory = path.dirname(filePath)

  while (directory.startsWith(packageDirectory)) {
    const manifest = path.join(directory, 'package.json')

    if (fs.existsSync(manifest)) {
      return JSON.parse(fs.readFileSync(manifest, 'utf8')).type ?? 'commonjs'
    }

    directory = path.dirname(directory)
  }

  return 'commonjs'
}

// 二本立て（import 条件を持つ）パッケージで、import 条件を持たないサブパスを
// 見つける。オブジェクトで条件を書き分けているサブパスだけが対象で、文字列だけの
// サブパス（パッケージ全体の "type" が形式を決める）は見ない
function checkDualBuildCoverage(name, exportsField, targets) {
  const isDualBuild = targets.some(({ conditions }) =>
    conditions.includes('import')
  )

  if (!isDualBuild) return

  for (const [subpath, value] of Object.entries(exportsField)) {
    if (!subpath.startsWith('.')) continue
    if (typeof value !== 'object' || value === null) continue

    const jsTargets = []

    collectTargets(value, [], jsTargets)

    const servesJs = jsTargets.some(({ target }) => target.endsWith('.js'))
    // import はサブパスの直下とは限らない（{ browser: { import, default } } のように
    // 入れ子になりうる）。葉まで降りた条件列で見る
    const hasImport = jsTargets.some(({ conditions }) =>
      conditions.includes('import')
    )

    if (servesJs && !hasImport) {
      problems.push(
        `${name}: ${subpath} に import 条件がありません（このパッケージの他のサブパスは持っています）`
      )
    }
  }
}

function checkPackage(packageDirectory) {
  const manifestPath = path.join(packageDirectory, 'package.json')
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  const name = manifest.name ?? path.basename(packageDirectory)

  if (!manifest.exports) return

  const targets = []

  collectTargets(manifest.exports, [], targets)

  checkDualBuildCoverage(name, manifest.exports, targets)

  for (const { target, conditions } of targets) {
    if (!target.startsWith('./')) continue

    // ワイルドカード（"./*" 等）は展開しないと実ファイルに落ちない。存在検査の
    // 対象から外す（パターンのまま存在しないファイルとして報告しないため）
    if (target.includes('*')) continue

    const filePath = path.join(packageDirectory, target)

    if (!fs.existsSync(filePath)) {
      problems.push(
        `${name}: exports が指すファイルがありません: ${target}（yarn build 済みですか）`
      )
      continue
    }

    // 型定義（src の .ts を指す types 条件）は形式の検査対象外
    if (!filePath.endsWith('.js')) continue

    const type = nearestTypeField(filePath, packageDirectory)

    if (conditions.includes('import')) {
      if (!isEsmSource(source(filePath))) {
        problems.push(`${name}: import 条件の ${target} が ESM ではありません`)
      }

      if (type !== 'module') {
        problems.push(
          `${name}: import 条件の ${target} が "type": "module" の配下にありません（出力先に package.json が要ります）`
        )
      }
    }

    if (conditions.includes('require')) {
      if (isEsmSource(source(filePath))) {
        problems.push(`${name}: require 条件の ${target} が CJS ではありません`)
      }

      if (type === 'module') {
        problems.push(
          `${name}: require 条件の ${target} が "type": "module" の配下にあります`
        )
      }
    }
  }
}

function source(filePath) {
  return fs.readFileSync(filePath, 'utf8')
}

// packages/ を持たない構成（層を潰した派生プロジェクト等）では検査するものが無い。
// check-layers.mjs と同じく、落とさずに抜ける
if (!fs.existsSync(PACKAGES_DIRECTORY)) {
  console.log('[skip] packages/ が無いため公開物の形式の検査をスキップします')
  process.exit(0)
}

const packageDirectories = fs
  .readdirSync(PACKAGES_DIRECTORY, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => path.join(PACKAGES_DIRECTORY, entry.name))
  .filter((directory) => fs.existsSync(path.join(directory, 'package.json')))

for (const packageDirectory of packageDirectories) {
  checkPackage(packageDirectory)
}

if (problems.length > 0) {
  console.error('❌ 公開物の形式が exports の条件と合っていません:')

  for (const problem of problems) {
    console.error(`  - ${problem}`)
  }

  process.exit(1)
}

console.log('✅ exports の条件と公開物の形式（ESM / CJS）が一致しています')
