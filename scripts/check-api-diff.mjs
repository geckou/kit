#!/usr/bin/env node
// 公開済みのパッケージと、これから公開するものの「型定義の差分」を見る。
//
//   node scripts/check-api-diff.mjs <パッケージのディレクトリ名>
//   node scripts/check-api-diff.mjs <パッケージ> --published-tarball <path>   # テスト用
//
// **なぜ必要か**: 破壊的変更が patch リリースに載る事故を実際に踏んだ
// （geckou/project-starter#155）。原因のコミットは `fix:` で入っており、
// Conventional Commits からも「同じ PR で version を上げる」運用からも検知できなかった。
// 申告ではなく成果物を比べる。
//
// やること:
//   1. 公開済みの最新版 tarball を取り、.d.ts を取り出す
//   2. ビルドして npm pack し、これから公開する .d.ts を取り出す
//   3. patch 上げなのに差分があれば、差分を出して止める
//
// 型定義を持たないパッケージ（素の JS の設定パッケージ等）は API の判定ができないので、
// 内容が変わっていることを警告として出すだけで止めない。
//
// 判定できない場合（未公開・ネットワーク不通など）は素通しする。これは事故を防ぐ
// 安全網であって、公開を守る仕組みではない（そちらは publish.yml の production 検査）。

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const EXIT_BLOCKED = 1

function parseArguments(argv) {
  const options = { package: null, publishedTarball: null }

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]

    if (argument === '--published-tarball') {
      index += 1

      const value = argv[index]

      // 値の省略だけを弾く。`-` 始まりのファイル名は正当なので、長いオプション
      // （--force 等）が続いた場合だけ「値が無い」と判断する
      if (value === undefined || value.startsWith('--')) {
        throw new Error(
          '--published-tarball にはファイルのパスを指定してください'
        )
      }

      // 絶対パスにする。`-fixture.tgz` のような名前をそのまま tar へ渡すと
      // オプションと解釈されるため
      const resolved = path.resolve(value)

      if (!fs.existsSync(resolved)) {
        throw new Error(`--published-tarball のファイルがありません: ${value}`)
      }

      if (!fs.statSync(resolved).isFile()) {
        throw new Error(
          `--published-tarball にはファイルを指定してください: ${value}`
        )
      }

      options.publishedTarball = resolved
    } else if (options.package === null) {
      options.package = argument
    } else {
      throw new Error(`不明な引数です: ${argument}`)
    }
  }

  if (!options.package) {
    throw new Error(
      '使い方: node scripts/check-api-diff.mjs <パッケージのディレクトリ名>'
    )
  }

  return options
}

function run(command, args, cwd) {
  return execFileSync(command, args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}

// 失敗しても止めない（判定できないだけ）
function tryRun(command, args, cwd) {
  try {
    return run(command, args, cwd)
  } catch {
    return null
  }
}

function readManifest(packageDir) {
  const file = path.join(packageDir, 'package.json')

  if (!fs.existsSync(file)) {
    throw new Error(`${packageDir} が存在しません。`)
  }

  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

// メジャー / マイナーが上がっていれば、破壊的変更を出してよい版として扱う
function isPatchOnly(published, next) {
  const [publishedMajor, publishedMinor] = published.split('.').map(Number)
  const [nextMajor, nextMinor] = next.split('.').map(Number)

  return publishedMajor === nextMajor && publishedMinor === nextMinor
}

// 展開できないときは null を返す（壊れたダウンロード等で誤ってブロックしないため）
function extractTarball(tarball, destination) {
  fs.mkdirSync(destination, { recursive: true })

  if (tryRun('tar', ['xzf', tarball, '-C', destination]) === null) return null

  const root = path.join(destination, 'package')

  return fs.existsSync(root) ? root : null
}

// package.json は version が必ず変わるので比べない
function collectFiles(root, extension) {
  const files = []

  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name)

      if (entry.isDirectory()) {
        walk(full)
      } else if (entry.name !== 'package.json') {
        if (extension === null || entry.name.endsWith(extension)) {
          files.push(path.relative(root, full))
        }
      }
    }
  }

  walk(root)

  return files.sort()
}

function diffTrees(before, after, extension) {
  const beforeFiles = collectFiles(before, extension)
  const afterFiles = collectFiles(after, extension)
  const all = [...new Set([...beforeFiles, ...afterFiles])].sort()
  const changed = []

  for (const file of all) {
    const beforePath = path.join(before, file)
    const afterPath = path.join(after, file)
    const beforeContent = fs.existsSync(beforePath)
      ? fs.readFileSync(beforePath, 'utf8')
      : null
    const afterContent = fs.existsSync(afterPath)
      ? fs.readFileSync(afterPath, 'utf8')
      : null

    if (beforeContent === afterContent) continue

    changed.push({
      file,
      status:
        beforeContent === null
          ? '追加'
          : afterContent === null
            ? '削除'
            : '変更',
    })
  }

  return { changed, hadTypes: beforeFiles.length > 0 || afterFiles.length > 0 }
}

function printDiff(before, after, changed) {
  for (const { file, status } of changed.slice(0, 5)) {
    console.log(`    ${status} ${file}`)

    if (status !== '変更') continue

    // diff は差分があると終了コード 1 を返すので、出力は例外から拾う
    const lines = diffLines(before, after, file)
      .split('\n')
      .filter((line) => /^[+-]/.test(line) && !/^[+-]{3}/.test(line))
      .slice(0, 8)

    for (const line of lines) console.log(`      ${line}`)
  }

  if (changed.length > 5) {
    console.log(`    ...ほか ${changed.length - 5} ファイル`)
  }
}

function diffLines(before, after, file) {
  try {
    execFileSync('diff', [
      '-u',
      path.join(before, file),
      path.join(after, file),
    ])

    return ''
  } catch (error) {
    return error.stdout?.toString() ?? ''
  }
}

function main() {
  const options = parseArguments(process.argv.slice(2))
  const packageDir = path.resolve('packages', options.package)
  const manifest = readManifest(packageDir)
  const name = manifest.name
  const version = manifest.version

  const publishedVersion =
    options.publishedTarball !== null
      ? null
      : tryRun('npm', ['view', name, 'version'])

  if (options.publishedTarball === null) {
    if (publishedVersion === null) {
      console.log(`[skip] ${name} は未公開か、npm を参照できませんでした`)
      return
    }

    if (!isPatchOnly(publishedVersion, version)) {
      console.log(
        `[ok] ${name} ${publishedVersion} → ${version}（patch ではないので API 差分は検査しません）`
      )
      return
    }
  }

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'api-diff-'))

  try {
    let publishedTarball = options.publishedTarball

    if (publishedTarball === null) {
      const url = tryRun('npm', [
        'view',
        `${name}@${publishedVersion}`,
        'dist.tarball',
      ])

      if (url === null) {
        console.log(`[skip] ${name} の公開物を取得できませんでした`)
        return
      }

      publishedTarball = path.join(work, 'published.tgz')

      if (tryRun('curl', ['-sSL', '-o', publishedTarball, url]) === null) {
        console.log(`[skip] ${name} の公開物をダウンロードできませんでした`)
        return
      }
    }

    // prepublishOnly は npm pack では走らないので、build があれば先に実行する。
    // ここで失敗しても止めない（依存が入っていない等、検査できないだけ。
    // 公開そのものは CI がビルドし直す）
    if (manifest.scripts?.build) {
      if (tryRun('yarn', ['--cwd', packageDir, 'build']) === null) {
        console.log(`[skip] ${name} をビルドできなかったため検査しません`)
        return
      }
    }

    const packed = tryRun(
      'npm',
      ['pack', '--silent', '--pack-destination', work],
      packageDir
    )

    if (packed === null) {
      console.log(`[skip] ${name} を pack できなかったため検査しません`)
      return
    }

    const nextTarball = path.join(work, packed.split('\n').pop())

    const before = extractTarball(publishedTarball, path.join(work, 'before'))
    const after = extractTarball(nextTarball, path.join(work, 'after'))

    if (before === null || after === null) {
      console.log(
        `[skip] ${name} の tarball を展開できなかったため検査しません`
      )
      return
    }

    const types = diffTrees(before, after, '.d.ts')

    if (!types.hadTypes) {
      const all = diffTrees(before, after, null)

      if (all.changed.length > 0) {
        console.log(
          `[warn] ${name} は型定義を持たないため API の判定ができません。公開物の内容は変わっています（${all.changed.length} ファイル）`
        )
      }

      return
    }

    if (types.changed.length === 0) {
      console.log(`[ok] ${name} の型定義に差分はありません`)
      return
    }

    console.error('')
    console.error(
      `[error] ${name} の型定義が変わっているのに patch 上げになっています（${publishedVersion ?? '公開済み'} → ${version}）`
    )
    printDiff(before, after, types.changed)
    console.error('')
    console.error(
      '  破壊的変更なら minor 以上に上げてください。互換性のある追加なら --force で続行できます。'
    )

    process.exit(EXIT_BLOCKED)
  } finally {
    fs.rmSync(work, { recursive: true, force: true })
  }
}

try {
  main()
} catch (error) {
  console.error(`[error] ${error.message}`)
  process.exit(1)
}
