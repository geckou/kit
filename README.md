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
- **`peerDependencies`**: **実行時に SDK を読むパッケージ**（`firebase` / `firebase-admin` /
  `react` / `next` 等）は必ず peer にする。`dependencies` に入れると利用側と別インスタンスの
  Firebase App が生成され、認証状態が共有されない追いにくいバグになる。
  `@geckou/billing` は Firestore / Auth のインスタンスを注入して使うため
  `firebase-admin` を必須 peer にしている
- **型だけを必要とするなら peer にしない**: 使用するメソッドだけを構造的に要求する型
  （`@geckou/firebase-server` の `TokenVerifierLike`、`@geckou/billing` の
  `StripeClientLike`）を定義する。peer の型を公開 API に置くと、メジャー間の型定義の差が
  そのまま利用側の型エラーになるため。`@geckou/firebase-server` が peer を持たないのは
  この方針による
- **配線はテンプレート側のスキルが担当**: パッケージは配れてもプロジェクトへの配線
  （依存追加・`firebase.json`・env・CI）は配れない。`/add-billing` 等のスキルが
  project-starter 側に置かれる

## リリース

**version を上げる PR を `production` へマージすれば、それだけで npm へ公開される。**
`publish.yml` が `production` への push で走り、`packages/*/package.json` の version が
npm に載っていないパッケージを全部公開する。手で叩くコマンドは無い。

### タグを打って公開する（通常は不要）

上の自動公開とは別に、タグ（`<ディレクトリ名>@<バージョン>`）を push しての公開も
引き続きできる。使うのは次の 2 つの場合だけで、**通常のリリースでこの手順は要らない**。

- リリースの区切りを git のタグとして残したいとき
- 自動公開が失敗した／検査に引っかかったので、打ち直したいとき

```bash
# version を上げる PR をマージしたあと（複数まとめて指定できる）
git checkout production && git pull --ff-only
yarn release billing firebase-client firebase-server
```

**どちらの経路でも公開されるのは「npm に未公開の version」だけ。** 公開済みのものは
対象から外れて publish ジョブごと skip されるので、自動公開の後からタグを打っても
二重に公開されることはない。

自動公開は、公開済みの型定義との差分検査（`check-api-diff.mjs`）に引っかかると止まる。
**互換の追加だと分かっていて通したい場合は `yarn release <パッケージ> --force` でタグを打つ。**
タグ起動の実行はこの検査を行わない（`release.sh` が打つ前に済ませているため）。

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
| Tag | `*@*` | タグを打っての公開（`yarn release`） |
| Branch | `production` | `production` への push による自動公開と `workflow_dispatch` |

**どちらか片方に限定すると、もう一方が Environment 側で弾かれる。**

公開されたパッケージには provenance（どのコミット・どのワークフローから公開されたかの証明）
が付く。
