# Geckou Kit

[`geckou/project-starter`](https://github.com/geckou/project-starter) から scaffold したプロジェクトで共有する、
プロダクト非依存のパッケージ群。テンプレートに同梱すると Template Sync で配布されない問題
（[project-starter#92](https://github.com/geckou/project-starter/issues/92) /
[#105](https://github.com/geckou/project-starter/issues/105)）への対応として、
npm パッケージとして切り出し、修正が Dependabot の bump PR として派生プロジェクトへ届くようにする。

UI コンポーネントは [`geckou/ui`](https://github.com/geckou/ui)（`@geckou/ui-react` 等）が担当。
このリポジトリはロジック側（決済・認証・共有ユーティリティ）を扱う。

## パッケージ

| パッケージ | 内容 | 状態 |
| --- | --- | --- |
| [`@geckou/billing`](packages/billing) | Stripe / RevenueCat のサブスク権利判定・Webhook 処理 | 公開済み |

## 設計方針

- **実行環境非依存**: Cloud Functions / Next.js Route Handler のどちらからも使える形にする。
  Webhook 処理は raw body + headers を受け取って結果を返し、`firebase-admin` のインスタンスや
  コレクション名の解決関数は利用側から注入する
- **`peerDependencies`**: `firebase` / `firebase-admin` / `react` / `next` 等は必ず peer にする。
  `dependencies` に入れると利用側と別インスタンスの Firebase App が生成され、
  認証状態が共有されない追いにくいバグになる
- **配線はテンプレート側のスキルが担当**: パッケージは配れてもプロジェクトへの配線
  （依存追加・`firebase.json`・env・CI）は配れない。`/add-billing` 等のスキルが
  project-starter 側に置かれる

## リリース

[`geckou/ui`](https://github.com/geckou/ui) と同じタグ駆動方式。

```bash
yarn release <パッケージのディレクトリ名> [patch|minor|major|<version>]
```

`<ディレクトリ名>@<バージョン>` 形式のタグを push すると `publish.yml` が npm へ公開する。
