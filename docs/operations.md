# 運用・デプロイ・復元

この文書は、EdgePhotos v1 のセットアップ、更新、backup / restore、uninstall の運用契約を定義します。

どの環境で何を確認済みかは、この文書ではなく [verification.md](verification.md) に記録します。

## 1. セットアップ目標

安全性を下げて完全ワンクリックを目指すのではなく、利用者が自分の Cloudflare account に必要な設定を明示的に確認できる構成にします。

```text
1. Create D1 / R2 and deploy the Worker
2. Configure Cloudflare Access
3. Configure R2 signing credentials and CORS
4. Open EdgePhotos and verify setup
```

Deploy to Cloudflare ボタンは Release polish の範囲です（roadmap）。

Cloudflare の plan は、試用・評価なら Workers Free、継続して使うなら Workers Paid（月 $5 から）を推奨します。Free の CPU 上限は 1 request 10 ms で、数千枚以上の library では timeline や export が上限に近づきます（[benchmarks.md](benchmarks.md)）。Paid の上限は既定で 30 秒です。D1 の time travel も、Free の 7 日に対して Paid は 30 日です。

## 2. リソース作成とデプロイ

環境ごとに D1・R2・Access application・R2 credential を分けます。以下は `remote-test` の例です。production は `--env` を外し、`wrangler.jsonc` の top-level 設定を使います。

```bash
pnpm wrangler d1 create edgephotos-remote-test
pnpm wrangler r2 bucket create edgephotos-remote-test
# database_id を書かなくても、wrangler は database_name で既存 D1 を解決した（wrangler 4.131 で確認）

pnpm wrangler d1 migrations apply edgephotos-remote-test --env remote-test --remote
CLOUDFLARE_ENV=remote-test pnpm build
pnpm wrangler deploy --config dist/edgephotos/wrangler.json
```

R2 bucket は public access（r2.dev / custom domain）を有効にしません。

初回の deploy は、deploy の成功で終わりにしません。§7 の `pnpm diagnose` と、Browser での写真 1 枚の upload までを一続きの作業として行います。

migration は forward-only です。通常の test command から remote migration は実行しません。適用は `wrangler d1 migrations apply` だけで行い、`drizzle-kit push` / `migrate` は使いません。`migrations/meta/` は drizzle-kit 用の snapshot で、wrangler は `.sql` だけを適用します。

## 3. 利用者が明示設定するもの

環境固有の値はすべて Worker secret です。`wrangler.jsonc` へ値を書きません。repository は public なので、秘密情報かどうかに関わらず、個人のメールアドレスや Cloudflare 固有の識別値を commit しません。

Secrets（`wrangler secret put <NAME> --env <ENV>`）:

| 名前 | 例 | 用途 |
| --- | --- | --- |
| `OWNER_EMAIL` | `you@example.com` | owner として許可する Access identity |
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

上の 7 つを `vars` に書かないでください。`vars` は deploy のたびに同名の plain text binding として送られます。secret と同じ名前の binding が 2 つになるため、deploy が拒否されるか、空文字の var が secret を隠します。どちらの場合も private API は `503` のままです。以前の top-level 設定は空文字の `vars` を持っていたため、production を手順どおりに作るとこの状態になりました（2026-09-17 に `remote-test` と同じ形へ修正。実際の production deploy では未確認）。`pnpm diagnose --offline` がこの状態を検出します。

```text
✘ [ERROR] The following required secrets have not been set: R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY
```

secret 未設定の binding は `undefined` になるため、`readAppConfig()` は `null` を返し、private API と share API は `503 SERVER_MISCONFIGURED` で fail-closed のままです。`secrets.required` は deploy を止めるための仕組みであり、fail-closed の根拠ではありません。

secret は **deploy のあとに設定します**。`wrangler secret put` は Worker が無ければ作りますが、そのあとで `wrangler deploy` すると、deploy 前に入れた secret は残りませんでした（2026-09-18 に `restore-test` で確認）。また、標準入力が端末でない環境（CI、エディタ内のシェル）では、値の入力を求められないまま空の secret が「Success」として保存されます。値が入ったかどうかは `pnpm diagnose` で確認してください。

R2 credential は対象 bucket だけの Object Read & Write 権限を持つ R2 API token から作成します。Cloudflare account 全体を管理できる token を EdgePhotos へ設定しません。

## 4. Cloudflare Access

同じ hostname に 2 つの self-hosted application を作ります。path の指定はいずれも wildcard を付けません。

destination（宛先）の種類は **public DNS（パブリック DNS）** を選び、hostname と path で指定します。self-hosted application は Worker そのものを宛先にもできますが、それだと Worker 全体が Access の対象になり、`/share` だけを Bypass にできません。

1. `photos.example.com`: Allow policy（owner の identity のみ）
2. `photos.example.com/share`: Bypass policy（Everyone）

より specific な path の application が優先するため、2 が `/share` 配下を先に処理します。wildcard を使わないのは、`/alpha/*` が親の `/alpha` 自体を含まないからです。`/share` と書けば `/share` と配下の両方が Bypass になります（remote-test で `/share`、`/share/{shareId}`、`/share/api/v1/*`、`/share/assets/*` を実測確認）。

1 の AUD tag を `ACCESS_AUD` に設定します。Access を通過しても `OWNER_EMAIL` と一致しない identity は Worker が `403` にします。

`/share/assets/*`（build 済み JS / CSS）と share API（`/share/api/v1/*`）はどちらも `/share` 配下なので、Bypass 1 つで公開面が揃います（[D-011](decisions.md)）。

Worker の preview URL は無効にします（`wrangler.jsonc` の `"preview_urls": false`）。有効だと `<version>-<worker>.<subdomain>.workers.dev` という別 hostname ができ、hostname 単位の Access application の対象外になります。その場合 private API を守るのは Worker 自身の JWT 検証だけになり、「private path は必ず Access が前段にいる」と言えなくなります。

Bypass policy は identity selector を使えず、request log も残りません。`/share/*` の監査は EdgePhotos 側でのみ取得できます。

Access application は API でも作成できます。必要な token 権限は `Access: Apps and Policies Edit`（account scope）だけです。作業後は token を revoke します。

## 5. APP_ORIGIN

`APP_ORIGIN` は明示設定します。受信した `Host` header から正規 origin を自己決定しません。

Custom domain は v1 の必須条件ではありません。custom domain を追加した場合は Access application、`APP_ORIGIN`、R2 CORS の整合性を更新します。

## 6. R2 CORS

Browser は presigned URL に対して次を送ります。

- `PUT`（upload）: `Content-Type` と `If-None-Match` header 付き（[D-013](decisions.md)）。original はさらに `x-amz-checksum-sha256` 付き（[D-018](decisions.md)）
- `GET`（`<img>` による表示、original の取得）

wrangler の `--file` は Dashboard 表示とは別形式です。`rules` 配列でくるみ、フィールドは camelCase にします。PascalCase の配列を渡すと `must contain a 'rules' array` で失敗します。

```json
{
  "rules": [
    {
      "allowed": {
        "origins": ["https://photos.example.com"],
        "methods": ["GET", "PUT"],
        "headers": ["content-type", "if-none-match", "x-amz-checksum-sha256"]
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

`exposeHeaders` は設定しません。`If-None-Match: *` と `x-amz-checksum-sha256` は署名に含める request header であり（[D-013](decisions.md)、[D-018](decisions.md)）、client は PUT 応答の `ETag` や checksum を読みません。

D-018 より前に CORS を設定した bucket は、`x-amz-checksum-sha256` を追加して `cors set` し直してください。追加しないと Browser の preflight で original の PUT が失敗します（CLI の `pnpm backup restore` は CORS の影響を受けません）。client が応答 header を読む必要が生じた時点で追加します。

## 7. Setup verification

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
| `config: *` | `secrets.required` の不足、secret 名の `vars` 宣言、`R2_BUCKET_NAME` と `BUCKET` binding の不一致、`preview_urls` |
| `worker: secrets` | `wrangler secret put` の漏れ（名前だけ確認。値の形式は下の probe で分かる） |
| `d1: migrations` | `wrangler d1 migrations apply --remote` の実行漏れ |
| `r2: r2.dev URL` / `custom domains` | bucket の公開設定（どちらも無効が正） |
| `r2: CORS for upload` | Browser と同じ preflight（`PUT` + 3 header）を `EDGEPHOTOS_URL` の origin で送る。AllowedOrigins / AllowedHeaders |
| `access: private path` | 匿名 request が Access login へ redirect されない（Access application の hostname） |
| `access: share bypass + worker config` | `/share` の Bypass application。`503` なら secret の欠落か形式違い（`ACCESS_TEAM_DOMAIN` は host のみ、`R2_ACCOUNT_ID` は 32 桁 hex） |
| `owner API` | `401`: token 期限切れ、または `ACCESS_AUD` / `ACCESS_TEAM_DOMAIN` の不一致。`403`: `OWNER_EMAIL` |
| `worker: APP_ORIGIN` | `APP_ORIGIN` が `EDGEPHOTOS_URL` の origin と一致しない（scheme、host、custom domain 追加後の更新漏れ）。不一致だと Browser からの書き込みが `403 ORIGIN_NOT_ALLOWED` になり、共有リンクも別の origin を指す。確認には中身が空の album 作成を送る。Worker は body を検証する前に Origin を検査するため、どちらの場合も何も作られない |
| `worker: D1 schema` | Worker が見ている D1 の最新 migration と checkout の不一致（別 DB を bind している、migration 未適用） |
| `r2: presigned GET` | Worker が署名した URL を R2 が拒否（`R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` / `R2_ACCOUNT_ID`）。library が空なら SKIP |
| `library: interrupted uploads`（WARN） | finalize されないまま期限（600 秒）を過ぎた upload がある。設定の誤りではない。1 日たったら `pnpm storage cleanup --apply`（またはライブラリ画面の「ストレージの点検」）で片付ける（§12） |
| `library: unfinished deletes`（WARN） | 完全削除が途中で止まった写真がある。ライブラリ画面の「削除を再開」で完了させる |

Worker が `503 SERVER_MISCONFIGURED` を返すときは、Workers Logs に欠落・不正な設定の**名前**が `{"problem":"misconfigured","settings":[...]}` として出ます（値は出しません）。

`pnpm diagnose` が通ったあと、Browser で次を確認します。

- 写真を 1 枚 upload して timeline に表示される（`pnpm diagnose` は PUT を実行しないため、upload の成立はここで確かめる）
- 共有リンクを作成し、private window で表示でき、revoke 後は表示できない

設定不足時に写真機能を匿名公開する fallback はありません。設定が欠けていれば `503 SERVER_MISCONFIGURED` です。

remote-test に対する実行結果（2026-09-17）: owner token ありで 15 項目すべて PASS（`worker: APP_ORIGIN` と `library: *` を足す前の check 構成）。追加後の構成でも FAIL なし（`worker: APP_ORIGIN` は PASS、`library: interrupted uploads` は既存の期限切れ 2 件で WARN）。`EDGEPHOTOS_URL` を別の origin にすると `r2: CORS for upload` が FAIL になることも確認した。

## 8. Update（release と migration）

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

release のたびに full backup は取りません。original は R2 上で変更されず、通常の migration は写真の byte に触れません。D1 は time travel で戻せます。10,000 枚の full backup は remote で 1 時間以上かかり、original が 1 枚 3 MB なら 30 GB になります（[benchmarks.md](benchmarks.md)）。full backup は定期的に、または破壊的な変更の前に取ります。

順序は「migration → deploy」です。migration は旧 Worker でも動く形（列・table の追加）で書きます。列の削除や改名のように旧 Worker を壊す変更は、それを使わない Worker を先に deploy し、次の release で migration します。

### 戻す

- **Worker だけ戻す**（migration なしの release、または migration が旧 Worker と互換）: `pnpm wrangler rollback [<version-id>] [--env <env>]`。直近 100 version まで戻せます。
- **migration が原因で壊れた**: 控えておいた bookmark に `pnpm wrangler d1 time-travel restore <database> --bookmark=<bookmark>` で戻し、Worker も rollback します。restore は D1 をその場で上書きする破壊的な操作です。戻せるのは直近 30 日以内（Workers Free では 7 日）で、bookmark 以降の D1 の書き込み（upload の登録、album 操作）は失われます。その間に upload された R2 object は D1 から参照されないまま残ります（[security.md](security.md) §10 の方針どおり、自動では消しません）。失った登録は、直近の backup と比較して upload し直します。
- time travel の期限を過ぎた、または D1 / R2 自体を失った場合は §10 の restore（新しい空環境へ）で戻します。

自動 upstream 更新は v1 の要件にしません。依存関係の更新は Dependabot の PR（週 1 回、group 単位）で受け、CI（`pnpm check` と Browser E2E）が通ったものだけ merge します。drizzle の更新は単独の PR になるので、`pnpm db:check` と試しの `pnpm db:generate` を行ってから merge します。

## 9. Export / Backup

EdgePhotos が唯一のバックアップであるとは説明しません。

- ライブラリ画面の「manifest をダウンロード」（`GET /api/v1/export/*` をページごとに取得して組み立てる）: asset metadata、album / album_assets、object manifest、期待 SHA-256。写真のファイルは含まない
- `pnpm backup export <dir>`: manifest に加え、original と derivative を presigned URL 経由で取得し、各 original の SHA-256 を検証して保存します
- `pnpm backup check <dir>`: backup ディレクトリだけを読み、manifest のすべての original の SHA-256 と derivative の有無を確かめます（network 不要）

```bash
EDGEPHOTOS_URL=https://photos.example.com \
EDGEPHOTOS_ACCESS_TOKEN="$(cloudflared access token -app=https://photos.example.com)" \
pnpm backup export ./edgephotos-backup
pnpm backup check ./edgephotos-backup
```

同じディレクトリへの 2 回目以降は差分です（[D-024](decisions.md)）。ファイル名は original の SHA-256 で、original の size が合い derivative が揃っている写真は取り直しません。ライブラリから削除した写真のファイルもディレクトリに残ります。ファイルは一時ファイルから rename で置くので、途中で止まっても壊れたファイルは残りません。止まった場合は同じコマンドを再実行します。`manifest.json` は最後に書くため、途中で止まった間は前回の manifest が有効です。

size が同じまま中身が壊れたファイル（ディスクの劣化など）は、差分の判定では分かりません。`pnpm backup check` を定期的に（backup を別のディスクへ複製したときも）実行し、挙がったファイルを削除してから `export` を再実行します。

`export` の成功は、ディレクトリにあったファイルの中身まで確かめたという意味ではありません。取り直さなかったファイルは size しか見ていないため、CLI はその件数を表示し、`check` の実行を促します。

manifest はページごとに順に読むので、ある一瞬の完全な写しではありません。export の最中に favorite・trash・album を変更すると、変更前と変更後が混ざることがあります（知らない写真を指す membership は捨てます）。backup の間は、まとまった整理操作をしないでください。

保存されている original が壊れている、または無い写真があると、`export` はその写真を名前で挙げて残りを続け、最後に失敗（exit 1）で終わります。原因は `pnpm storage audit --deep` で確認します（§12）。

含めないもの: R2 credential、JWT、share secret、presigned URL。Access token は API request の header にだけ使い、R2 へは送らず、保存もしません。

owner 以外の identity（service token 等）では API を利用できないため、CLI も owner の Access token を使います。

## 10. Restore

外部公開前に、別の空環境へ restore できることを実測します。

```bash
EDGEPHOTOS_URL=https://restore-test.example.com \
EDGEPHOTOS_ACCESS_TOKEN="$(cloudflared access token -app=https://restore-test.example.com)" \
pnpm backup restore ./edgephotos-backup           # restore 後に verify も実行する
pnpm backup restore ./edgephotos-backup --resume  # 止まった restore の続き
pnpm backup verify ./edgephotos-backup            # 任意の時点で再検証（original を全件 download）
pnpm backup verify ./edgephotos-backup --quick    # original を download せずに検証
```

restore は通常の upload API で再登録します（[D-015](decisions.md)）。対象 library が空でなければ拒否します。進行状況を backup ディレクトリの `restore-state.json` に書くため、ディレクトリは書き込み可能にしておきます。

verify が確認する項目:

- asset count と、backup に無い写真が無いこと
- original SHA-256: 既定は R2 から再取得して計算する。`--quick` は、R2 が upload 時に検証・記録した SHA-256 が D1 の値と一致することを storage audit（deep）で確かめ、download しない。記録の無い古い original（D-018 より前）は `--quick` でも download する
- album membership（original SHA-256 基準）
- taken_at・favorite・trash 状態・filename・size・`createdAt` 等の主要 metadata
- storage audit: original / derivative の欠落と size の違い（問題として数える）、中断した upload・止まった削除・どの行も指さない object（`notes` に出す）

restore した環境では過去の share を再有効化しません（share は export に含めません）。asset ID と trash に入れた日時は変わります。`createdAt` は保持します（[D-024](decisions.md)）。

`pnpm backup` は、通信エラー・`408`・`429`・`5xx` を backoff 付きで最大 4 回まで再試行します（作成系の request である upload の予約と album の作成は、重複を避けるため再試行しません）。10,000 件の backup / restore は、remote で 1 時間以上かかる見積もりです（[benchmarks.md](benchmarks.md)）。

restore が再試行でも回復せず途中で止まった場合（Access token の期限切れ、長い通信断など）は、原因を直してから同じコマンドに `--resume` を付けて再実行します。それまでに restore した写真はそのまま残り、SHA-256 で飛ばされます。`--resume` は、対象ライブラリの写真がすべて backup にあり、album がすべて `restore-state.json` に記録済みのときだけ続けます。album の作成の応答が失われた場合は、記録に無い album の名前を挙げて止まるので、その album をアプリで削除してから再実行します。restore 中に reserve の応答が失われると、中断した upload が 1 件残ります（`pnpm storage cleanup` で片付く）。

## 11. Uninstall

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

## 12. Observability

中央 telemetry server は置きません。

利用者自身の Cloudflare Dashboard（Workers Logs）と、アプリ内の非機密 diagnostics（`GET /api/v1/diagnostics`、ライブラリ画面）を使います。

- asset / trash / album 件数
- 未完了 upload（`pending`）件数と、そのうち期限切れ（`expires_at` を過ぎた = 中断した）件数
- 削除処理中（`purging`）件数と、その asset ID（ライブラリ画面の「削除を再開」で完了できる）
- 最終 export 日時（manifest を最後まで組み立てた時刻。ライブラリ画面のダウンロードと `pnpm backup` の export / verify / restore を含む）
- 適用済み migration

Worker のエラーログは request ID・route・例外名だけを出し、header・token・URL・body を出しません。

### D1 と R2 の突合（storage audit / cleanup）

D1 の記録と R2 の object が食い違っていないかは、読み取り専用の storage audit で確認します（[D-023](decisions.md)）。ライブラリ画面の「ストレージの点検」、または CLI:

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
| `missing_derivative` | original は無事で、thumbnail / preview が無い | 上と同じ手順で作り直す |
| `original_checksum_unrecorded`（`--deep`） | D-018 より前の original で、R2 に SHA-256 の記録が無い | `pnpm backup verify` が download して照合する |
| `unfinished_delete` | 完全削除が途中で止まった | ライブラリ画面の「削除を再開」 |
| `expired_upload` | finalize されずに期限を過ぎた upload（写真ではない） | 1 日たったら `cleanup --apply`。3 object が揃っていれば写真として登録され、それ以外は object と行を削除する |
| `duplicate_leftover` | 重複と判定された upload の残り object | `cleanup --apply` が削除する |
| `unreferenced_objects` | どの D1 行も指さない object | 自動では削除しない。D1 を time travel で戻したあとなら、その期間に upload した写真の object の可能性がある。`originals/{id}` を R2 の Dashboard から取り出して upload し直すか、不要と判断できたら Dashboard で削除する |
| `unexpected_key` | EdgePhotos の layout 外の key | EdgePhotos は触れない。書き込んだものを調べる |
| `audit_incomplete` | 1 つの ID の下に layout 外の key が数千個あり、その ID の thumbnail / preview を確認しきれなかった | 問題なしとは扱わない（`audit` は exit 1、verify も失敗）。layout 外の key を取り除いてから再実行する |

cleanup は、写真（`assets` 行のある ID の object）、止まった削除、どの行も指さない object、期限から 1 日以内の upload には触れません。期限切れの件数が増え続ける場合は、取り込み中の画面ロックや回線断が多いことを疑います（roadmap の Post-merge verification）。

## 13. R2 credential の更新と漏洩対応

R2 API token（`R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY`）は presigned URL の署名にだけ使います。対象 bucket だけの Object Read & Write に限定します（§3）。

定期更新、または漏洩の疑いがある場合:

1. Dashboard の R2 → Manage API tokens で、同じ権限（対象 bucket のみ、Object Read & Write）の新しい token を作る
2. 漏洩の疑いがある場合は、**先に古い token を削除する**。削除した時点で、古い key で署名した URL（未使用の upload URL、表示中の画像 URL）はすべて無効になる。発行済み URL の期限は最大 600 秒なので、定期更新なら 3 → 4 の後に削除してよい
3. `pnpm wrangler secret put R2_ACCESS_KEY_ID [--env <env>]`、同じく `R2_SECRET_ACCESS_KEY`
4. `pnpm diagnose` で `r2: presigned GET` が PASS になることを確認する（library が空なら写真を 1 枚 upload）

切り替えの間に upload 中だった写真は PUT が `403` で失敗します。その写真を選び直せば upload されます。途中まで PUT された object は finalize されず、未完了の upload として残ります（§12 の cleanup で片付く）。

漏洩時に確認すること:

- R2 の古い token で何ができたか: 対象 bucket の読み書き。original を含むすべての写真を読めた可能性があります。上書きは reserve ごとの key と `If-None-Match` に守られません（token を持つ者は条件なしで PUT できる）
- original の改ざんを疑う場合は `pnpm backup verify <直近の backup>` を実行します。R2 から original を取り直し、SHA-256 を照合します
- Access の service token や Cloudflare account の API token が漏れた場合は、この節ではなく Cloudflare 側で revoke します。EdgePhotos は owner の email を持たない identity を受け付けません（[security.md](security.md) §3）

share secret が漏れた場合は、その share を revoke するか再発行します（`/api/v1/shares/{id}/revoke`、`/regenerate`）。

## 14. 復旧 drill

年に 1 回程度、または大きな変更の前に、restore できることを確かめます。手順は §2〜§4 で空の環境（例: `restore-test`）を作り、§10 の restore を実行するだけです。2026-09-16 の drill の記録は [verification.md](verification.md) にあります。

drill で見るもの:

- 事前に `pnpm backup check` が `ok: true` で終わる
- `pnpm backup restore` が `ok: true` で終わる。途中で一度止め（Ctrl-C）、`--resume` で最後まで進むことも確かめる
- restore 先で `pnpm storage audit --deep` の破損が 0 件
- restore 先の timeline と album が開き、共有リンクを新しく作れる
- 所要時間（[benchmarks.md](benchmarks.md) の見積もりと比べる）

終わったら drill 用の Worker、D1、R2 bucket、Access application、R2 API token を削除します。
