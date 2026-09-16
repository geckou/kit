#!/usr/bin/env node
//
// 公開する dist が exports の条件どおりの形式になっているかを検査する。
//
//   node scripts/check-module-formats.mjs        # 全パッケージ（先に yarn build）
//
// **なぜ必要か**: `import` 条件が無い CJS のみのパッケージを ESM のアプリから使うと、
// パッケージが require した firebase SDK とアプリが import した firebase SDK が
// 別インスタンスになり、instanceof の検査で弾かれて Firestore への通信が一切できない
// （geckou/kit#66）。exports に条件を足しても、出力が実際に ESM になっていなければ
// 同じことが起きる。型チェックにもテストにも引っかからないので、ここで機械的に落とす。
//
// 見るのは 3 つ。
//   1. import 条件の JS が本当に ESM か（dist/esm/package.json の "type": "module" 込み）
//   2. require 条件の JS が本当に CJS か
//   3. 条件が指すファイル（JS・型定義）が実在するか

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PACKAGES_DIRECTORY = path.join(ROOT, 'packages')

const problems = []

function report(message) {
  problems.push(message)
}

// exports は入れ子（条件の中に条件）になるので、葉（文字列）まで降りて
// 「どの条件の下にあるか」と一緒に集める
function collectTargets(node, conditions, targets) {
  if (typeof node === 'string') {
    targets.push({ target: node, conditions })

    return
  }

  if (node === null || typeof node !== 'object') return

  for (const [key, value] of Object.entries(node)) {
    // サブパス（"." や "./firestore"）は条件ではないので積まない
    const nextConditions = key.startsWith('.')
      ? conditions
      : [...conditions, key]

    collectTargets(value, nextConditions, targets)
  }
}

function isEsmSource(source) {
  return /^\s*(import|export)\s/m.test(source)
}

function isCjsSource(source) {
  return /\brequire\(|\bexports\./.test(source) && !/^\s*import\s/m.test(source)
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

function checkPackage(packageDirectory) {
  const manifestPath = path.join(packageDirectory, 'package.json')
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  const name = manifest.name ?? path.basename(packageDirectory)

  if (!manifest.exports) return

  const targets = []

  collectTargets(manifest.exports, [], targets)

  for (const { target, conditions } of targets) {
    if (!target.startsWith('./')) continue

    const filePath = path.join(packageDirectory, target)

    if (!fs.existsSync(filePath)) {
      report(`${name}: exports が指すファイルがありません: ${target}`)
      continue
    }

    if (!filePath.endsWith('.js')) continue

    const source = fs.readFileSync(filePath, 'utf8')

    if (conditions.includes('import')) {
      if (!isEsmSource(source)) {
        report(`${name}: import 条件の ${target} が ESM ではありません`)
      }

      if (nearestTypeField(filePath, packageDirectory) !== 'module') {
        report(
          `${name}: ${target} は "type": "module" の配下にありません（出力先に package.json が要ります）`
        )
      }
    }

    if (conditions.includes('require') && !isCjsSource(source)) {
      report(`${name}: require 条件の ${target} が CJS ではありません`)
    }
  }
}

const packageDirectories = fs
  .readdirSync(PACKAGES_DIRECTORY, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => path.join(PACKAGES_DIRECTORY, entry.name))
  .filter((directory) => fs.existsSync(path.join(directory, 'package.json')))

for (const packageDirectory of packageDirectories) {
  if (!fs.existsSync(path.join(packageDirectory, 'dist'))) {
    report(
      `${path.basename(packageDirectory)}: dist がありません（先に yarn build を実行してください）`
    )
    continue
  }

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
