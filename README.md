# Geckou Kit

[`geckou/project-starter`](https://github.com/geckou/project-starter) から scaffold したプロジェクトで共有する、
プロダクト非依存のパッケージ群。テンプレートに同梱すると Template Sync で配布されない問題
（[project-starter#92](https://github.com/geckou/project-starter/issues/92) /
[#105](https://github.com/geckou/project-starter/issues/105)）への対応として、
npm パッケージとして切り出し、修正が Renovate の更新 PR として派生プロジェクトへ届くようにする。

UI コンポーネントは [`geckou/ui`](https://github.com/geckou/ui)（`@geckou/ui-react` 等）が担当。
このリポジトリはロジック側（決済・認証・共有ユーティリティ）を扱う。

## パッケージ

| パッケージ | 内容 | 状態 |
| --- | --- | --- |
| [`@geckou/billing`](packages/billing) | Stripe / RevenueCat のサブスク権利判定・Webhook 処理 | 公開済み |
| [`@geckou/firebase-client`](packages/firebase-client) | Firebase クライアント SDK のラッパー（初期化 / Firestore / Storage） | 公開済み |
| [`@geckou/firebase-server`](packages/firebase-server) | サーバーサイドの Firebase ヘルパー（認証ミドルウェア / FCM 送信） | 公開済み |

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
# 1. packages/<パッケージ>/package.json の version を上げる PR を出してマージする
# 2. production でタグを打つ（複数まとめて指定できる）
git checkout production && git pull --ff-only
yarn release billing firebase-client firebase-server
```

`<ディレクトリ名>@<バージョン>` 形式のタグを push すると `publish.yml` が npm へ公開する。

コミットメッセージは commitlint が検証し、**規約違反はコミットをブロックする**
（`.husky/commit-msg`）。派生プロジェクト向けのテンプレート（geckou/project-starter）は
警告のみだが、このリポジトリはリリース単位が `git log` の可読性に直結するため止める。

#### どこからでも実行する

`yarn release` はこのリポジトリの中でしか動かない（yarn がスクリプトを引けないため）。
一度だけ次を実行すると、`geckou-release` がどのディレクトリからでも使える。

```bash
bash scripts/install-release-command.sh
```

リポジトリの絶対パスを `~/.config/geckou/release-repos` へ登録し、
`scripts/geckou-release` を `~/.local/bin` へ置くだけ
（場所は `XDG_CONFIG_HOME` / `XDG_BIN_HOME` に従う）。

```bash
geckou-release billing firebase-client
```

パッケージ名から、それを持つリポジトリを引いて `scripts/release.sh` に渡す。
検査もタグ打ちも `release.sh` が行うので、動きは `yarn release` と変わらない。
geckou の他のリポジトリでも同じように実行しておけば、1 つのコマンドで使い分けられる。

**`yarn release` はタグを打つだけで、version は上げない。** `production` への直接 push は
禁止しているため、version の変更は通常の PR で入れる。また **HEAD が `origin/production` と
一致していなければ止まる** — 手元が古いままタグを打つと、GitHub は「タグが指すコミットの
ワークフローファイル」で実行するため、古い `publish.yml` が動いて意図しない中身が
公開されうるため。

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
