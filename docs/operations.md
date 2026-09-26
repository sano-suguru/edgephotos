# 運用・デプロイ・復元

EdgePhotos v1 のセットアップ、更新、backup / restore、アンインストールの手順をまとめます。

どの環境で何を確認済みかは [verification.md](verification.md) にあります。この文書には書きません。

## 1. セットアップの方針

安全性を下げて完全ワンクリックを目指しません。利用者が自分の Cloudflare account に必要な設定を明示的に確認できる構成にします。

```text
1. Create D1 / R2 and apply migrations
2. Configure Cloudflare Access
3. Create R2 signing credentials
4. Deploy the Worker with secrets, then configure R2 CORS
5. Open EdgePhotos and verify setup
```

Worker の hostname（`APP_ORIGIN`）は deploy 前から決まっています。workers.dev なら `https://<worker 名>.<account の subdomain>.workers.dev` です。subdomain は Dashboard の Workers & Pages に表示されます。

Deploy to Cloudflare ボタンは Release polish の範囲です（[roadmap.md](roadmap.md)）。

Cloudflare の plan は、試用・評価なら Workers Free、継続して使うなら Workers Paid（月 $5 から）を推奨します。

Free の CPU 上限は 1 request 10 ms です。現在の測定では、EdgePhotos がこの上限に安定して収まることを確認できていません（[plan に依存する注意](benchmarks.md#plan-に依存する注意)）。Paid の上限は既定で 30 秒です。D1 の time travel も、Free の 7 日に対して Paid は 30 日です。

### R2 の保存容量と料金

R2 Standard は 10 GB-month / 月まで無料で、超えた分は $0.015 / GB-month です。インターネットへの egress は無料、Class A operation は月 100 万回、Class B operation は月 1000 万回まで無料です（2026-09 時点）。

保存量は GB-month で計算します。日ごとの保存量を請求期間で平均した値です。

R2 の保存量は写真本体だけでなく derivative も含みます。写真の枚数あたりの容量は測定していないため、枚数からの見積もりは出していません。

Workers の plan 料金を足した目安の表は [README](../README.md#費用) にあります。

最新の料金は [R2](https://developers.cloudflare.com/r2/pricing/) と [Workers](https://developers.cloudflare.com/workers/platform/pricing/) の料金ページを確認してください。

## 2. リソース作成とデプロイ

環境ごとに D1・R2・Access application・R2 credential を分けます。以下は `remote-test` の例です。production は `--env` を外し、`wrangler.jsonc` の top-level 設定を使います。

```bash
pnpm wrangler d1 create edgephotos-remote-test
pnpm wrangler r2 bucket create edgephotos-remote-test

pnpm wrangler d1 migrations apply edgephotos-remote-test --env remote-test --remote
CLOUDFLARE_ENV=remote-test pnpm build
pnpm wrangler deploy --config dist/edgephotos/wrangler.json --secrets-file <secrets.env>   # 初回のみ --secrets-file
```

初回の deploy には 7 つの secret の値が要ります（[初回の deploy で secret を渡す](#初回の-deploy-で-secret-を渡す)）。そのため、deploy の前に [Cloudflare Access](#4-cloudflare-access) の application と R2 API token を作っておきます。

`wrangler.jsonc` に `database_id` を書かなくても deploy できます。wrangler が `database_name` で既存 D1 を解決します。

R2 bucket は public access（r2.dev / custom domain）を有効にしません。

初回の deploy は、deploy の成功で終わりにしません。[セットアップの確認](#7-セットアップの確認) の `pnpm diagnose` と、Browser での写真 1 枚の upload までを一続きの作業として行います。

migration は forward-only です。通常の test command から remote migration は実行しません。適用は `wrangler d1 migrations apply` だけで行い、`drizzle-kit push` / `migrate` は使いません。`migrations/meta/` は drizzle-kit 用の snapshot で、wrangler は `.sql` だけを適用します。

## 3. 利用者が設定する値

環境固有の値はすべて Worker secret です。`wrangler.jsonc` へ値を書きません。

repository は public なので、秘密情報かどうかに関わらず、個人のメールアドレスや Cloudflare 固有の識別値を commit しません。

Secrets（`wrangler secret put <NAME> --env <ENV>`）:

| 名前 | 例 | 用途 |
| --- | --- | --- |
| `HOUSEHOLD_EMAILS` | `you@example.com,partner@example.com` | private API を許可する Access identity。email の comma 区切り（1 つ以上） |
| `APP_ORIGIN` | `https://photos.example.com` | 共有 URL 生成、Origin check |
| `ACCESS_TEAM_DOMAIN` | `yourteam.cloudflareaccess.com` | JWT issuer / JWKS（host のみ。URL 不可） |
| `ACCESS_AUD` | private Access application の AUD tag | JWT audience |
| `R2_ACCOUNT_ID` | 32 桁 hex | presigned URL の S3 endpoint |
| `R2_ACCESS_KEY_ID` | R2 API token の Access Key ID | presigned URL の署名 |
| `R2_SECRET_ACCESS_KEY` | R2 API token の Secret Access Key | presigned URL の署名 |

Vars（`wrangler.jsonc` の `vars`、値が公開されても害がないもののみ）:

| 名前 | 例 | 用途 |
| --- | --- | --- |
| `R2_BUCKET_NAME` | `edgephotos` | presigned URL の bucket |

`wrangler.jsonc` は必要な secret 名を `secrets.required` で宣言します（production の top-level と `remote-test` の両方）。未設定のまま deploy すると、不足している名前を挙げて失敗します。

```text
✘ [ERROR] The following required secrets have not been set: R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY
```

### secret を `vars` に書かない

上の 7 つを `vars` に書かないでください。`vars` は deploy のたびに同名の plain text binding として送られます。

secret と同じ名前の binding が 2 つになるため、deploy が拒否されるか、空文字の var が secret を隠します。どちらの場合も private API は `503` のままです。

以前の top-level 設定は空文字の `vars` を持っていたため、production を手順どおりに作るとこの状態になりました（2026-09-17 に `remote-test` と同じ形へ修正。実際の production deploy では未確認）。`pnpm diagnose --offline` がこの状態を検出します。

secret 未設定の binding は `undefined` になるため、`readAppConfig()` は `null` を返します。private API と share API は `503 SERVER_MISCONFIGURED` で fail-closed のままです。`secrets.required` は deploy を止めるための仕組みであり、fail-closed の根拠ではありません。

### household を設定する

`HOUSEHOLD_EMAILS` は email の comma 区切りです。空白は無視し、大文字小文字は区別しません。1 人だけでも同じ形式です。

```bash
pnpm wrangler secret put HOUSEHOLD_EMAILS [--env <env>]
# 入力例: you@example.com,partner@example.com
```

読み取れない entry（余分な comma、打ち間違い、email でない値）が 1 つでもあれば設定全体が無効になり、private API は全員に対して `503` を返します。設定後は `pnpm diagnose` の `private API` が PASS になることを確認してください。

### household を変更する

member の追加・削除は、**Access policy と `HOUSEHOLD_EMAILS` の両方**を更新します。片方だけだと、Access で止まる（追加漏れ）か Worker が `403` にする（設定漏れ）かのどちらかになります。削除では両方から消さないと、消したつもりの identity が残ります。

順序は `HOUSEHOLD_EMAILS` を基準に決めます。Worker のこの設定が最終的な判断だからです。権限を広げるときは最後に、狭めるときは最初に動かします。

| 操作 | 順序 |
| --- | --- |
| 追加 | Access policy → `HOUSEHOLD_EMAILS` |
| 削除 | `HOUSEHOLD_EMAILS` → Access policy |

削除でこの順にするのは、Access policy から外しても、発行済みの assertion や session がいつ切れるかは Access の設定次第だからです。`HOUSEHOLD_EMAILS` から先に消せば、まだ有効な token を持つ相手も次の request から `403` になります。

急いで締め出す場合も同じです。`HOUSEHOLD_EMAILS` の更新だけで Worker 側は塞がります。Access policy の削除はそのあとで構いません。

member を削除しても、その人が upload した写真は library に残ります。asset に記録した upload した人（[D-034](decisions.md)）は表示のためだけの値で、所有者ではないためです（[D-028](decisions.md)）。viewer には削除した member の email がそのまま表示されます。

### `OWNER_EMAIL` から移行する

`OWNER_EMAIL` を設定した Worker を更新する場合は、deploy の前に新しい secret を入れます。`secrets.required` に `HOUSEHOLD_EMAILS` があるため、設定しないまま deploy すると失敗します（データは変わりません）。Worker がすでにある更新なので、下の「初回の deploy で secret を渡す」は当たりません。

```bash
pnpm wrangler secret put HOUSEHOLD_EMAILS [--env <env>]   # 旧 OWNER_EMAIL の値を含める
# deploy（「更新（release と migration）」の手順）
pnpm wrangler secret delete OWNER_EMAIL [--env <env>]     # deploy と diagnose が通ってから
```

D1 の migration はありません。library は元から 1 つで、asset に所有者の列を持たないためです。

### 初回の deploy で secret を渡す

Worker がまだ無い初回は、`wrangler deploy --secrets-file <file>` で 7 つの secret を deploy と同時に渡します。file は `.env` 形式（`NAME=value` を 1 行ずつ）で、repository の外に置き、deploy が終わったら削除します。

`--secrets-file` の無い初回 deploy は `secrets.required` で失敗します。2 回目以降の deploy では `--secrets-file` を付けません。secret は前回の deploy から引き継がれます（[verification.md](verification.md#初回-deploy-の-secret-の渡し方2026-09-24)）。

`wrangler secret put` で先に Worker を作る方法は使いません。そのあとで `wrangler deploy` すると、deploy 前に入れた secret は残りませんでした（2026-09-18 に `restore-test` で確認）。Worker ができたあとの値の変更は `wrangler secret put` で構いません。

また、標準入力が端末でない環境（CI、エディタ内のシェル）では、`wrangler secret put` が値の入力を求めないまま空の secret を「Success」として保存します。値が入ったかどうかは `pnpm diagnose` で確認してください。

R2 credential は、対象 bucket だけの Object Read & Write 権限を持つ R2 API token から作成します。Cloudflare account 全体を管理できる token を EdgePhotos へ設定しません。個人に結び付かない Account API Token で作ります。

## 4. Cloudflare Access

同じ hostname に 2 つの self-hosted application を作ります。path の指定はいずれも wildcard を付けません。

destination（宛先）の種類は **public DNS（パブリック DNS）** を選び、hostname と path で指定します。self-hosted application は Worker そのものを宛先にもできますが、それだと Worker 全体が Access の対象になり、`/share` だけを Bypass にできません。

1. `photos.example.com`: Allow policy（`HOUSEHOLD_EMAILS` と同じ identity のみ）
2. `photos.example.com/share`: Bypass policy（Everyone）

より specific な path の application が優先するため、2 が `/share` 配下を先に処理します。

wildcard を使わないのは、`/alpha/*` が親の `/alpha` 自体を含まないからです。`/share` と書けば `/share` と配下の両方が Bypass になります（remote-test で `/share`、`/share/{shareId}`、`/share/api/v1/*`、`/share/assets/*` を実測確認）。

1 の AUD tag を `ACCESS_AUD` に設定します。Access を通過しても `HOUSEHOLD_EMAILS` のどれとも一致しない identity は Worker が `403` にします。

`/share/assets/*`（build 済み JS / CSS）と share API（`/share/api/v1/*`）はどちらも `/share` 配下なので、Bypass 1 つで公開面が揃います（[D-011](decisions.md)）。

### login 方法

member の login には One-time PIN（OTP）を使います。登録した email に届くコードを入力する方式で、member は Cloudflare のアカウントを必要としません。

新しい Zero Trust organization の既定の login 方法は、Cloudflare アカウントでのログインです。「account の member に限る」設定のままだと、Cloudflare アカウントを持たない member は login できません。OTP は自動では追加されないため、identity provider として追加します。

1 の application では、login 方法を明示します。

- `allowed_idps` に OTP だけを指定する。空のままだと account のすべての identity provider が対象になり、あとで別の用途に追加した identity provider も login 画面に出てしまう
- `auto_redirect_to_identity` を有効にする。login 方法が 1 つなので、選択画面を飛ばして email の入力へ直接進む

2 の application（Bypass）は変更しません。

OTP の挙動で、確認や問い合わせのときに知っておくこと:

- 登録していない email を入力しても、画面には「コードを送った」と表示されます。実際にはメールは送られません。拒否の確認は、コードが届かず login を完了できないことで行います
- 送信元は `noreply@notify.cloudflare.com` です。コードは 10 分で失効します
- メールのセキュリティ製品がリンクを先読みすると、コードが使用済みになることがあります。その場合はコードを再送します

### MFA を足す（推奨）

OTP だけの login では、member の email アカウントを乗っ取られると library 全体を取られます。家族の写真を入れる前に、Access の independent MFA を足すことを勧めます（[D-038](decisions.md)）。EdgePhotos の Worker はこれを検証しません。Access の設定だけで効きます。

1. Zero Trust の **Access controls > Access settings** の **Allow multi-factor authentication (MFA)** で、許可する方式を選ぶ。Authenticator application（TOTP）と、端末の passkey（Biometrics）または Security key を選ぶ。**Authentication duration** は application の session duration（24 時間）と揃える
2. 1 の private application の **Authentication > MFA** を **Custom MFA settings** にし、同じ方式を指定する。2 の application（Bypass）は変更しない
3. 各 member に App Launcher（`<team-name>.cloudflareaccess.com`、登録は `/AddMfaDevice`）で authenticator を登録してもらう。App Launcher の Access policy が household の email を含んでいることを確かめる。紛失に備えて 2 つ登録する（TOTP は 1 人 1 つまでなので、もう 1 つは passkey か security key）
4. 全員の登録が済んだら、管理者が dashboard で各 member の authenticator が本人の登録したものだけであることを確かめる

最初の authenticator の登録には MFA が要りません。有効にしてから登録するまでの間に email を乗っ取られていると、攻撃者が先に登録できます。有効にしたら、全員がすぐに登録します。

authenticator を失くした member は、管理者が dashboard でその member の authenticator を削除し、本人が次の login で登録し直します。削除から再登録までは OTP だけで登録できる状態なので、本人と連絡を取りながら行います。

確認と合格の条件は [verification.md](verification.md#access-の-independent-mfa) にあります。

### preview URL を無効にする

Worker の preview URL は無効にします（`wrangler.jsonc` の `"preview_urls": false`）。

有効だと `<version>-<worker>.<subdomain>.workers.dev` という別 hostname ができ、hostname 単位の Access application の対象外になります。その場合 private API を守るのは Worker 自身の JWT 検証だけになり、「private path は必ず Access が前段にいる」と言えなくなります。

Bypass policy は identity selector を使えず、request log も残りません。`/share/*` の監査は EdgePhotos 側でのみ取得できます。

Access application と identity provider は API でも作成できます。必要な token 権限（account scope）は、application が `Access: Apps and Policies Edit`、identity provider が `Access: Organizations, Identity Providers, and Groups Write` です。作業後は token を revoke します。

## 5. APP_ORIGIN

`APP_ORIGIN` は明示設定します。受信した `Host` header から正規 origin を自己決定しません。

Custom domain は v1 の必須条件ではありません。custom domain を追加した場合は、Access application、`APP_ORIGIN`、R2 CORS の整合性を更新します。

## 6. R2 CORS

Browser は presigned URL に対して次を送ります。

- `PUT`（upload）: `Content-Type` と `If-None-Match` header 付き（[D-013](decisions.md)）。original はさらに `x-amz-checksum-sha256` 付き（[D-018](decisions.md)）
- `PUT`（使えない derivative の置き換え）: `If-None-Match` の代わりに `If-Match` header 付き（[D-026](decisions.md)）
- `GET`: `<img>` による表示。original のダウンロードと derivative の作り直しは、original を `fetch()` で読む

`AllowedMethods` に `GET` が無くても、写真の表示（`<img>`）と upload は動きます。失敗するのは derivative の作り直しと original のダウンロードです。どちらも `fetch()` で読み、応答を読むには `Access-Control-Allow-Origin` が要るためです（[D-026](decisions.md)、[D-036](decisions.md)）。`pnpm diagnose` の `r2: CORS` が `GET` と `PUT` の両方を検査します。

wrangler の `--file` は Dashboard 表示とは別形式です。`rules` 配列でくるみ、フィールドは camelCase にします。PascalCase の配列を渡すと `must contain a 'rules' array` で失敗します。

```json
{
  "rules": [
    {
      "allowed": {
        "origins": ["https://photos.example.com"],
        "methods": ["GET", "PUT"],
        "headers": ["content-type", "if-none-match", "if-match", "x-amz-checksum-sha256"]
      },
      "maxAgeSeconds": 600
    }
  ]
}
```

```bash
pnpm wrangler r2 bucket cors set edgephotos-remote-test --file cors.json
pnpm wrangler r2 bucket cors list edgephotos-remote-test
```

`*` は使いません。

`exposeHeaders` は設定しません。`If-None-Match: *`、`If-Match`、`x-amz-checksum-sha256` は署名に含める request header であり（[D-013](decisions.md)、[D-018](decisions.md)、[D-026](decisions.md)）、client は PUT 応答の `ETag` や checksum を読みません。client が応答 header を読む必要が生じた時点で追加します。

D-018 より前に CORS を設定した bucket は、`x-amz-checksum-sha256` を追加して `cors set` し直してください。追加しないと Browser の preflight で original の PUT が失敗します（CLI の `pnpm backup restore` は CORS の影響を受けません）。

`if-match` の無い CORS を設定済みの bucket も、追加して `cors set` し直してください。upload と表示はそのまま動き、使えない derivative の置き換えだけが preflight で失敗します。欠けた derivative の作成は `If-None-Match` なので影響を受けません。`pnpm diagnose` の `r2: CORS` は `if-match` の有無も検査します。

## 7. セットアップの確認

設定ミスは、まず read-only の `pnpm diagnose` で確認します。Cloudflare account への書き込みは一切しません。値そのもの（secret、token、presigned URL）は表示しません。

```bash
pnpm diagnose --offline                       # wrangler.jsonc だけ（login 不要）
pnpm diagnose --env remote-test               # + Worker secret 名、remote D1 migration、R2 の公開設定（wrangler login）
EDGEPHOTOS_URL=https://photos.example.com \
EDGEPHOTOS_ACCESS_TOKEN="$(cloudflared access token -app=https://photos.example.com)" \
pnpm diagnose                                 # + Access、Worker の設定値、D1 schema、R2 CORS と署名
```

production は `--env` を付けません。確認する内容と、失敗時に疑う設定:

| check | 失敗時に疑うもの |
| --- | --- |
| `config: *` | `secrets.required` の不足、secret 名の `vars` 宣言、`R2_BUCKET_NAME` と `BUCKET` binding の不一致、`preview_urls`、`assets` の `run_worker_first` / `not_found_handling`（[D-037](decisions.md)） |
| `worker: secrets` | `wrangler secret put` の漏れ（名前だけ確認。値の形式は下の probe で分かる） |
| `d1: migrations` | `wrangler d1 migrations apply --remote` の実行漏れ |
| `r2: r2.dev URL` / `custom domains` | bucket の公開設定（どちらも無効が正） |
| `r2: CORS` | bucket の CORS 規則。AllowedOrigins が `EDGEPHOTOS_URL` の origin と一致しない、AllowedHeaders または `GET` が足りない |
| `access: private path` | 匿名 request が Access login へ redirect されない（Access application の hostname） |
| `access: share bypass + worker config` | `/share` の Bypass application。`503` なら secret の欠落か形式違い（`ACCESS_TEAM_DOMAIN` は host のみ、`R2_ACCOUNT_ID` は 32 桁 hex） |
| `private API` | `401`: token 期限切れ、または `ACCESS_AUD` / `ACCESS_TEAM_DOMAIN` の不一致。`403`: `HOUSEHOLD_EMAILS` |
| `share: asset miss` | `/share/assets/` の無いファイルに private app の HTML が返る。`assets.not_found_handling` が `"none"` でない（[D-037](decisions.md)） |
| `private app: CSP` | HTML に CSP が無い（CSP を付ける前の build が deploy されている）、または `img-src` / `connect-src` に、wrangler で login している account の R2 endpoint が無い（`R2_ACCOUNT_ID` が別の account を指す）。WARN は account を決められなかった（`CLOUDFLARE_ACCOUNT_ID` を設定する）（[D-037](decisions.md)） |
| `worker: APP_ORIGIN` | `APP_ORIGIN` が `EDGEPHOTOS_URL` の origin と一致しない（scheme、host、custom domain 追加後の更新漏れ） |
| `worker: D1 schema` | Worker が見ている D1 の最新 migration と checkout の不一致（別 DB を bind している、migration 未適用） |
| `r2: presigned GET` | Worker が署名した URL を R2 が拒否（`R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` / `R2_ACCOUNT_ID`）。library が空なら SKIP |
| `library: interrupted uploads`（WARN） | finalize されないまま期限（600 秒）を過ぎた upload がある。設定の誤りではない。1 日たったら `pnpm storage cleanup --apply`（またはライブラリ画面の「ストレージの点検」）で片付ける（[監視と点検](#12-監視と点検)） |
| `library: unfinished deletes`（WARN） | 完全削除が途中で止まった写真がある。ライブラリ画面の「削除を再開」で完了させる |

`worker: APP_ORIGIN` が不一致だと、Browser からの書き込みが `403 ORIGIN_NOT_ALLOWED` になり、共有リンクも別の origin を指します。`EDGEPHOTOS_URL` の origin に合わせてください。

Worker が `503 SERVER_MISCONFIGURED` を返すときは、Workers Logs に欠落・不正な設定の**名前**が `{"problem":"misconfigured","settings":[...]}` として出ます（値は出しません）。

`pnpm diagnose` が通ったあと、Browser で次を確認します。

- 写真を 1 枚 upload して timeline に表示される（`pnpm diagnose` は PUT を実行しないため、upload の成立はここで確かめる）
- 共有リンクを作成し、private window で表示でき、revoke 後は表示できない
- 上の 2 つの間、開発者ツールの console に `Content Security Policy` の違反が出ない（[verification.md](verification.md#private-app-の-csp-を-production-で確かめる)）
- 家族の写真を入れる前に、Workers Logs に credential が生で残っていないことを確かめる（[確認手順](verification.md#確認手順再実行用)）

`pnpm diagnose` では見えない Access の設定は、Cloudflare dashboard と Browser で確認します。production の初回 deploy と、member を増減したあとに行います。

- Access application の Allow policy と `HOUSEHOLD_EMAILS` が同じ identity の集合になっている（[D-028](decisions.md)。diagnose は食い違いを検出できない）
- household に含めていない account でログインすると、Access で拒否される（Access だけを通過した identity に Worker が `403` を返すことは integration test で確認している）
- Access application の session duration を決め、その値を [verification.md](verification.md) の結果と一緒に記録する
- `/share` の Bypass application の path に wildcard を付けていない（[Cloudflare Access](#4-cloudflare-access)）。preview URL が `404` を返す

設定不足時に写真機能を匿名公開する fallback はありません。設定が欠けていれば `503 SERVER_MISCONFIGURED` です。

remote-test に対する実行結果は [verification.md](verification.md) にあります。

## 8. 更新（release と migration）

migration は forward-only です。Worker code の rollback と D1 の rollback は別の操作です。

release の手順は、migration の有無と種類で変えます（production は `--env` なし）。

| release | 手順 |
| --- | --- |
| migration なし | check → deploy → diagnose → smoke |
| 追加だけの migration（列・table・index の追加） | check → bookmark を控える → migration → deploy → diagnose → smoke |
| 破壊的な migration、またはデータを変換する migration | 上に加えて、**先に full backup**（`pnpm backup export`） |

```bash
git pull && pnpm install && pnpm check                          # check
pnpm wrangler d1 time-travel info <database> [--env <env>]       # bookmark を控える（migration がある場合）
pnpm wrangler d1 migrations apply <database> [--env <env>] --remote
[CLOUDFLARE_ENV=<env>] pnpm build                                # deploy
pnpm wrangler deploy --config dist/<worker>/wrangler.json
EDGEPHOTOS_URL=... EDGEPHOTOS_ACCESS_TOKEN=... pnpm diagnose [--env <env>]
```

smoke は、Browser で timeline を開き、写真を 1 枚 upload するだけです。

### full backup を毎回は取らない

release のたびに full backup は取りません。original は R2 上で変更されず、通常の migration は写真の byte に触れません。D1 は time travel で戻せます。

10,000 枚の full backup は remote で 1 時間以上かかり、original が 1 枚 3 MB なら 30 GB になります（[benchmarks.md](benchmarks.md)）。full backup は定期的に、または破壊的な変更の前に取ります。

### 順序は migration → deploy

migration は旧 Worker でも動く形（列・table の追加）で書きます。

列の削除や改名のように旧 Worker を壊す変更は、それを使わない Worker を先に deploy し、次の release で migration します。

### 戻す

**Worker だけ戻す**（migration なしの release、または migration が旧 Worker と互換）: `pnpm wrangler rollback [<version-id>] [--env <env>]`。直近 100 version まで戻せます。

**migration が原因で壊れた**: 控えておいた bookmark に `pnpm wrangler d1 time-travel restore <database> --bookmark=<bookmark>` で戻し、Worker も rollback します。

- restore は D1 をその場で上書きする破壊的な操作です
- 戻せるのは直近 30 日以内（Workers Free では 7 日）です
- bookmark 以降の D1 の書き込み（upload の登録、album 操作）は失われます
- その間に upload された R2 object は D1 から参照されないまま残ります。自動では消しません（[削除](security.md#10-削除) の方針どおり）
- 失った登録は、直近の backup と比較して upload し直します

time travel の期限を過ぎた、または D1 / R2 自体を失った場合は、[Restore](#10-restore)（新しい空環境へ）で戻します。

### 依存関係の更新

自動 upstream 更新は v1 の要件にしません。

依存関係の更新は Dependabot の PR（週 1 回、group 単位）で受け、CI（`pnpm check` と Browser E2E）が通ったものだけ merge します。drizzle の更新は単独の PR になるので、`pnpm db:check` と試しの `pnpm db:generate` を行ってから merge します。

## 9. Backup と export

EdgePhotos が唯一のバックアップであるとは説明しません。

- ライブラリ画面の「写真とアルバムの情報を書き出す」: manifest（asset metadata、album / album_assets、object manifest、期待 SHA-256）。写真のファイルは含まない（`GET /api/v1/export/*` をページごとに取得して組み立てる）
- `pnpm backup export <dir>`: manifest に加え、original と derivative を presigned URL 経由で取得し、各 original の SHA-256 を検証して保存する
- `pnpm backup check <dir>`: backup ディレクトリだけを読み、manifest のすべての original の SHA-256 と derivative の有無を確かめる（network 不要）

`manifest.json` は format v3 に従います（[Export と restore](architecture.md#9-export-と-restore)、[D-025](decisions.md)、[D-035](decisions.md)）。HEIC / HEIF の original と、各写真の upload した人（`uploadedBy`）を持ちます。

alpha の間、CLI が読むのは v3 の manifest だけです。以前の alpha release が書いた v1 / v2 の backup は、`check` / `restore` / `verify` が `formatVersion` を名指しして拒否します。v1 / v2 の backup しか持っていない場合は、元のライブラリが残っていれば、現在の CLI で `pnpm backup export` をやり直します。元のライブラリが無い場合、v1 / v2 の backup を読む手段はありません。v1 release 以降は、新しい CLI が以前の release の backup を読み続けます。古い CLI が新しい backup を読めることは約束しません。

`check` / `restore` / `verify` は読み込み時に検証します。JSON として壊れている・contract に合わない・整合しない manifest は、ライブラリへ最初の request を送る前に、不正な field とその理由を並べて拒否します。

```bash
EDGEPHOTOS_URL=https://photos.example.com \
EDGEPHOTOS_ACCESS_TOKEN="$(cloudflared access token -app=https://photos.example.com)" \
pnpm backup export ./edgephotos-backup
pnpm backup check ./edgephotos-backup
```

### 2 回目以降は差分

同じディレクトリへの 2 回目以降は差分です（[D-024](decisions.md)）。ファイル名は original の SHA-256 で、original の size が合い derivative が揃っている写真は取り直しません。ライブラリから削除した写真のファイルもディレクトリに残ります。

ファイルは一時ファイルから rename で置くので、途中で止まっても壊れたファイルは残りません。止まった場合は同じコマンドを再実行します。`manifest.json` は最後に書くため、途中で止まった間は前回の manifest が有効です。

size が同じまま中身が壊れたファイル（ディスクの劣化など）は、差分の判定では分かりません。`pnpm backup check` を定期的に実行し、挙がったファイルを削除してから `export` を再実行します。backup を別のディスクへ複製したときも同じです。

`export` の成功は、ディレクトリにあったファイルの中身まで確かめたという意味ではありません。取り直さなかったファイルは size しか見ていないため、CLI はその件数を表示し、`check` の実行を促します。

### export 中の注意

manifest はページごとに順に読むので、ある一瞬の完全な写しではありません。export の最中に favorite・trash・album を変更すると、変更前と変更後が混ざることがあります（知らない写真を指す membership は捨てます）。backup の間は、まとまった整理操作をしないでください。

保存されている original が壊れている、または無い写真があると、`export` はその写真を名前で挙げて残りを続け、最後に失敗（exit 1）で終わります。原因は `pnpm storage audit --deep` で確認します（[監視と点検](#12-監視と点検)）。

含めないもの: R2 credential、JWT、share secret、presigned URL。Access token は API request の header にだけ使い、R2 へは送らず、保存もしません。

household member 以外の identity（service token 等）では API を利用できないため、CLI も member の Access token を使います。

## 10. Restore

backup から別の環境へライブラリを戻します。

### 前提

- 対象 library が空であること。空でなければ restore は拒否します
- backup ディレクトリが書き込み可能であること。進行状況を `restore-state.json` に書きます
- 対象環境の Access token

### 実行

```bash
EDGEPHOTOS_URL=https://restore-test.example.com \
EDGEPHOTOS_ACCESS_TOKEN="$(cloudflared access token -app=https://restore-test.example.com)" \
pnpm backup restore ./edgephotos-backup           # restore 後に verify も実行する
pnpm backup restore ./edgephotos-backup --resume  # 止まった restore の続き
pnpm backup verify ./edgephotos-backup            # 任意の時点で再検証（original を全件 download）
pnpm backup verify ./edgephotos-backup --quick    # original を download せずに検証
```

restore は通常の upload API で再登録します（[D-015](decisions.md)）。

### 確認

verify が確認する項目:

- asset count と、backup に無い写真が無いこと
- original SHA-256。既定は R2 から再取得して計算する
- album membership（original SHA-256 基準）
- taken_at・favorite・trash 状態・filename・size・`createdAt` 等の主要 metadata
- storage audit。original / derivative の欠落と size の違いを問題として数え、中断した upload・止まった削除・どの行も指さない object を `notes` に出す

`--quick` は download しません。R2 が upload 時に検証・記録した SHA-256 が D1 の値と一致することを、storage audit（deep）で確かめます。記録の無い古い original（D-018 より前）は `--quick` でも download します。

### 失敗したとき

restore が再試行でも回復せず途中で止まった場合（Access token の期限切れ、長い通信断など）は、原因を直してから同じコマンドに `--resume` を付けて再実行します。

それまでに restore した写真はそのまま残り、SHA-256 で飛ばされます。`--resume` は、対象ライブラリの写真がすべて backup にあり、album がすべて `restore-state.json` に記録済みのときだけ続けます。

album の作成の応答が失われた場合は、記録に無い album の名前を挙げて止まります。その album をアプリで削除してから再実行します。restore 中に reserve の応答が失われると、中断した upload が 1 件残ります（`pnpm storage cleanup` で片付く）。

### 復元後に変わるもの

- 過去の share は再有効化しません（share は export に含めません）
- asset ID と trash に入れた日時は変わります。`createdAt` は保持します（[D-024](decisions.md)）

### 所要時間と再試行

- `pnpm backup` は、通信エラー・`408`・`429`・`5xx` を backoff 付きで最大 4 回まで再試行します。作成系の request である upload の予約と album の作成は、重複を避けるため再試行しません
- 10,000 件の backup / restore は、remote で 1 時間以上かかる見積もりです（[benchmarks.md](benchmarks.md)）

## 11. アンインストール

アプリ削除とデータ削除を連動させません。

推奨手順:

```text
1. export / backup
2. restore 可能性を確認
3. share を revoke
4. Worker / Access 設定を削除
5. 不要なら D1 を削除
6. R2 は写真を本当に消したい場合だけ削除
```

Worker を削除しただけで R2 bucket を自動削除しません。

## 12. 監視と点検

中央 telemetry server は置きません。

利用者自身の Cloudflare Dashboard（Workers Logs）と、アプリ内の非機密 diagnostics（`GET /api/v1/diagnostics`、ライブラリ画面）を使います。

- asset / trash / album 件数
- 未完了 upload（`pending`）件数と、そのうち期限切れ（`expires_at` を過ぎた = 中断した）件数
- 削除処理中（`purging`）件数と、その asset ID（ライブラリ画面の「削除を再開」で完了できる）
- 最終 backup export 日時（画面では「バックアップ処理の完了日時」）

適用済み migration は画面に出しません。`pnpm diagnose` の `worker: D1 schema` で確認します。

### 「バックアップ処理の完了日時」（最終 backup export）の意味

`pnpm backup export` が失敗なく `manifest.json` を書き終えた時刻です。CLI が最後に `POST /api/v1/backup/complete` を送って記録します（[D-033](decisions.md)）。

取得できなかった写真がある run（CLI が exit 1 で終わる run）は記録しません。ライブラリ画面の「写真とアルバムの情報をダウンロード」と、`pnpm backup` の verify / restore も記録しません。どれも backup ではないためです。

server は backup ディレクトリを見られないので、この日時は CLI が「終わった」と送った記録です。backup の中身が揃っていることは示しません。backup export は差分で、既にあるファイルは size だけを見て再利用します。揃っているかは `pnpm backup check` で確認してください。

D-033 より前の版から更新した直後は「記録なし」と表示されます。以前の記録（`last_export_at`）は verify などでも書かれていたため、読み継ぎません。

Worker のエラーログは request ID・route・例外名だけを出し、header・token・URL・body を出しません。

### D1 と R2 の突合（storage audit / cleanup）

D1 の記録と R2 の object が食い違っていないかは、読み取り専用の storage audit で確認します（[D-023](decisions.md)）。ライブラリ画面の「ストレージの点検」、または CLI から実行します。

```bash
EDGEPHOTOS_URL=... EDGEPHOTOS_ACCESS_TOKEN=... pnpm storage audit          # 読み取りのみ
EDGEPHOTOS_URL=... EDGEPHOTOS_ACCESS_TOKEN=... pnpm storage audit --deep   # + R2 が記録した SHA-256 と照合（original ごとに HEAD 1 回）
EDGEPHOTOS_URL=... EDGEPHOTOS_ACCESS_TOKEN=... pnpm storage cleanup        # dry run
EDGEPHOTOS_URL=... EDGEPHOTOS_ACCESS_TOKEN=... pnpm storage cleanup --apply
```

年に数回と、D1 の time travel や R2 credential の漏洩のあとに実行します。分類と対応:

| 分類 | 意味 | 対応 |
| --- | --- | --- |
| `missing_original` / `original_size_mismatch` / `original_checksum_mismatch` | 写真の original が無い、または upload されたものと違う（データの破損） | backup の original で戻す。現在の手順は、その写真を完全削除し、backup の original を upload し直す（album と favorite は付け直す）。`audit` は exit 1 |
| `missing_derivative` | original は無事で、thumbnail / preview が無い | ライブラリ画面の「サムネイルを作り直す」。original から作り直すだけで、original・album・favorite・trash・日時は変わらない（[D-026](decisions.md)）。`audit` は exit 1 |
| `original_checksum_unrecorded`（`--deep`） | D-018 より前の original で、R2 に SHA-256 の記録が無い | `pnpm backup verify` が download して照合する |
| `unfinished_delete` | 完全削除が途中で止まった | ライブラリ画面の「削除を再開」 |
| `expired_upload` | finalize されずに期限を過ぎた upload（写真ではない） | 1 日たったら `cleanup --apply`。3 object が揃っていれば写真として登録され、それ以外は object と行を削除する |
| `duplicate_leftover` | 重複と判定された upload の残り object | `cleanup --apply` が削除する |
| `unreferenced_objects` | どの D1 行も指さない object | 自動では削除しない。D1 を time travel で戻したあとなら、その期間に upload した写真の object の可能性がある。`originals/{id}` を R2 の Dashboard から取り出して upload し直すか、不要と判断できたら Dashboard で削除する |
| `unexpected_key` | EdgePhotos の layout 外の key | EdgePhotos は触れない。書き込んだものを調べる |
| `audit_incomplete` | 1 つの ID の下に layout 外の key が数千個あり、その ID の thumbnail / preview を確認しきれなかった | 問題なしとは扱わない（`audit` は exit 1、verify も失敗）。layout 外の key を取り除いてから再実行する |

cleanup が触れないもの: 写真（`assets` 行のある ID の object）、止まった削除、どの行も指さない object、期限から 1 日以内の upload。

期限切れの件数が増え続ける場合は、取り込み中の画面ロックや回線断が多いことを疑います（[roadmap.md](roadmap.md) の Post-merge verification）。

## 13. R2 credential の更新と漏洩対応

R2 API token（`R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY`）は presigned URL の署名にだけ使います。対象 bucket だけの Object Read & Write に限定します（[利用者が設定する値](#3-利用者が設定する値)）。

定期更新、または漏洩の疑いがある場合:

1. Dashboard の R2 → Manage API tokens で、同じ権限（対象 bucket のみ、Object Read & Write）の新しい token を作る
2. 漏洩の疑いがある場合は、**先に古い token を削除する**。R2 は署名を token の key で検証するため、削除後は古い key で署名した URL（未使用の upload URL、表示中の画像 URL）も通らなくなる見込みです。ただし Cloudflare の文書に明記はなく、EdgePhotos でも確かめていません。発行済み URL の期限は最大 600 秒なので、定期更新なら 3 → 4 の後に削除してよい
3. `pnpm wrangler secret put R2_ACCESS_KEY_ID [--env <env>]`、同じく `R2_SECRET_ACCESS_KEY`
4. `pnpm diagnose` で `r2: presigned GET` が PASS になることを確認する（library が空なら写真を 1 枚 upload）

切り替えの間に upload 中だった写真は、PUT が `403` で失敗します。その写真を選び直せば upload されます。途中まで PUT された object は finalize されず、未完了の upload として残ります（[監視と点検](#12-監視と点検) の cleanup で片付く）。

漏洩時に確認すること:

- R2 の古い token で何ができたか: 対象 bucket の読み書き。original を含むすべての写真を読めた可能性があります。上書きは reserve ごとの key と `If-None-Match` に守られません（token を持つ者は条件なしで PUT できる）
- original の改ざんを疑う場合は `pnpm backup verify <直近の backup>` を実行します。R2 から original を取り直し、SHA-256 を照合します
- Access の service token や Cloudflare account の API token が漏れた場合は、この節ではなく Cloudflare 側で revoke します。EdgePhotos は household member の email を持たない identity を受け付けません（[private API の認証と認可](security.md#3-private-api-の認証と認可)）

share secret が漏れた場合は、その share を revoke するか再発行します（`/api/v1/shares/{id}/revoke`、`/regenerate`）。

## 14. 復旧 drill

年に 1 回程度、または大きな変更の前に、restore できることを確かめます。

手順は [リソース作成とデプロイ](#2-リソース作成とデプロイ) から [Cloudflare Access](#4-cloudflare-access) までで空の環境（例: `restore-test`）を作り、[Restore](#10-restore) を実行するだけです。2026-09-16 の drill の記録は [verification.md](verification.md) にあります。

drill で見るもの:

- 事前に `pnpm backup check` が `ok: true` で終わる
- `pnpm backup restore` が `ok: true` で終わる。途中で一度止め（Ctrl-C）、`--resume` で最後まで進むことも確かめる
- restore 先で `pnpm storage audit --deep` の破損が 0 件
- restore 先の timeline と album が開き、共有リンクを新しく作れる
- 所要時間（[benchmarks.md](benchmarks.md) の見積もりと比べる）

`pnpm diagnose` は bucket を `wrangler.jsonc` から読みます。drill 用の環境を `wrangler.jsonc` に足していなければ、`r2: CORS` は production の bucket を見て FAIL になります。drill の bucket の CORS は `pnpm wrangler r2 bucket cors list <bucket>` で確かめます。

終わったら drill 用の Worker、D1、R2 bucket、R2 API token を削除します。R2 API token は鍵なので必ず消します。作成画面の既定は「すべてのバケット」なので、対象を drill 用の bucket に絞れていたかも確認します。

Access application は残しても構いません。秘密情報もデータも持たず、hostname に紐づくだけなので、次の drill で同じ hostname を使えば AUD ごと再利用できます。Worker が無い間は、その hostname に誰も到達しません。
