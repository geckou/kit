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
| [`@geckou/firebase-client`](packages/firebase-client) | Firebase クライアント SDK のラッパー（初期化 / Firestore / Storage） | 公開済み |
| [`@geckou/firebase-server`](packages/firebase-server) | サーバーサイドの Firebase ヘルパー（認証ミドルウェア / FCM 送信） | 未公開 |

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

**公開できるのはデフォルトブランチに入っているコミットだけ。** タグも手動実行も任意の ref から
起動できるので、そのままだとレビューを通っていないコードを npm へ出せてしまう
（publish の前に `yarn install` / `yarn build` が走るため、その ref の任意のコードが
公開権限を持つジョブ内で実行される）。ワークフローは起動元のコミットがデフォルトブランチに
含まれること・タグのバージョンが `package.json` の version と一致することを確認してから公開する。

### 認証（Trusted Publishing）

公開の認証は npm の **Trusted Publishing**（GitHub Actions の OIDC）で行う。
`NPM_TOKEN` のような長期シークレットは持たない。実行のたびに短命なトークンが
発行されるので、盗まれて後から悪用される秘密が存在しない。

そのかわり、**npm 側でパッケージごとに Trusted Publisher の登録が要る**。
npmjs.com のパッケージ設定（Settings → Trusted Publisher）で以下を登録する。

| 項目 | 値 |
| --- | --- |
| Provider | GitHub Actions |
| Organization / Repository | `geckou` / `kit` |
| Workflow filename | `publish.yml` |
| Environment | `npm-publish` |

`Workflow filename` は**ファイル名だけ**（`.github/workflows/` のパスは付けない）。
Organization / Repository / Workflow filename は**大文字小文字まで一致**する必要がある。
新しいパッケージを足したときは、この登録も 1 回だけ行う。

移行が動くことを確認できたら、パッケージ設定の
**「Require two-factor authentication and disallow tokens」を有効にする**。
以後そのパッケージはトークンでは公開できなくなる。**順番を逆にすると公開できなくなる**ので、
必ず 1 回公開が通ってから有効にする。

npm 側の紐付けは「リポジトリ + ワークフロー」単位なので、どの ref から起動されたかまでは
npm 側では縛れない。そこは上の `production` 包含チェックと、`npm-publish` Environment の
「Deployment branches and tags」で担保している。**許可するのは 2 つ**:

| ref type | パターン | 用途 |
| --- | --- | --- |
| Tag | `*@*` | 通常のリリース（`yarn release`） |
| Branch | `production` | `workflow_dispatch` での公開（初回リリース等） |

**タグだけに限定すると `workflow_dispatch` が Environment 側で弾かれる。**

公開されたパッケージには provenance（どのコミット・どのワークフローから公開されたかの証明）
が付く。
