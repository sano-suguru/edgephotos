# 運用・デプロイ・復元

この文書は、EdgePhotos v1 のセットアップ、更新、backup / restore、uninstall の運用契約を定義します。

> **検証状況（2026-09-16〜17。各項目の日付が優先）:**
> - local（Miniflare / `vite dev` / `vite preview`）: migration 適用、fail-closed、upload → timeline → album → share → revoke、export / restore / verify を確認済み。
> - remote-test 環境: D1・R2 の作成、remote D1 migration、`CLOUDFLARE_ENV=remote-test` での build と deploy、未設定 Worker が private / share API を `503` で拒否すること、共有ページの header / CSP、`/share/assets/*` の配信を確認済み。
> - Access 境界: private path（`/`、`/api/v1/*`）が Access login へ 302、`/share`・`/share/{shareId}`・`/share/api/v1/*`・`/share/assets/*` が Access を通過して Worker に到達することを確認済み。
> - secret 運用: 7 件を Worker secret 化し、`secrets.required` 未充足時に deploy が不足名を挙げて失敗すること、充足後に fail-closed が解けて share API が `503` から `404 SHARE_UNAVAILABLE` になることを確認済み。
> - R2 CORS: bucket 限定の rule を適用し、読み戻しを確認済み。`x-amz-checksum-sha256` を AllowedHeaders に加えた rule（[D-018](decisions.md)）も適用・読み戻し済み。
> - original の checksum（[D-018](decisions.md)）: remote-test で Browser から、canvas で生成した合成 JPEG を使って確認済み（2026-09-16）。reserve が返す original の PUT header に `x-amz-checksum-sha256` が入る。同じ size で 1 byte だけ違う body の PUT は R2 が `400 BadDigest` で拒否し、その時点の finalize は `409 UPLOAD_OBJECT_MISSING`（`original`）。同じ URL へ正しい bytes を PUT し直すと `200`、finalize は `200 created`（S3 API で PUT した object の `checksums.sha256` を binding の `head()` から読めることの実証）。owner 用 GET で読み戻した original の SHA-256 は `assets.sha256` と一致した。確認に使った asset は trash へ移動済み。
> - upload 経路: owner が Access login を通したうえで、private API の成功応答、`reserve -> PUT -> finalize` が remote-test で通ることを確認済み。PUT の宛先が `*.r2.cloudflarestorage.com` であること（Worker が本体を中継しないこと）を DevTools で確認。`ACCESS_AUD` と `ACCESS_TEAM_DOMAIN` の正しさもこれで確定。
> - duplicate handling と完全削除: 同一 original の再 upload が `409 DUPLICATE_ASSET` になること、完全削除後は同じ original を再登録できることを確認済み。
> - share 経路: album 作成 -> asset 追加 -> share 発行 -> 正しい secret で `200` -> revoke -> 同じ secret で `404` までを確認済み。secret 不正・secret 無しはいずれも `404`。`url` は `/share/{id}#{secret}` の形。share から `original` を要求すると `400`（variant は `thumbnail` / `preview` のみ）。derivative は `*.r2.cloudflarestorage.com` から直接取得。
> - CSRF 境界: 他 origin からの `POST /api/v1/albums` が `403 ORIGIN_NOT_ALLOWED`。
> - presigned URL の失効: share の derivative URL が発行 300 秒後に R2 で `403 ExpiredRequest` になることを確認済み。revoke 済み share の既発行 URL が残り TTL の間だけ有効なのは [security.md](security.md) §5 の契約どおり。
> - backup: remote-test に対する `pnpm backup export` と `verify` が通り、original の SHA-256 照合が一致（`ok: true`）。
> - restore: 空の `edgephotos-restore-test`（D1 / R2 / Access / CORS / secret を別に用意）へ `pnpm backup restore` を実行し、`ok: true` を確認済み。restore 先から export し直して manifest を突き合わせ、asset 数・original の SHA-256・album 構成と membership・主要 metadata（size / content type / filename / width / height / takenAt / isFavorite）が一致することを確認。変わるのは `id` と `createdAt` だけで、[D-015](decisions.md) のとおり。空でない library への restore が拒否されることも確認済み。
> - 画像形式と orientation: EXIF orientation 1〜8、GPS タグ付き、JPEG / PNG / WebP、160×120 から 6000×4000、1:4 と 40:9 の比率を含む合成 19 枚を upload。orientation 8 種はすべて同じ向き・同じ寸法として登録され、client が EXIF を適用していることを確認。derivative は全件 EXIF・GPS を持たず、thumbnail 512 / preview 2048 の上限を守り、上限より小さい original を拡大しない。
> - original の byte 保持: export した original を再 hash し、ローカル原本の SHA-256 と全件一致することを確認。trash へ移動して復元した asset も SHA-256 が変わらない。
> - 20 件規模の restore: restore-test を空にしてから 20 asset・1 album を restore し、restore 先の export と突き合わせて asset 数・SHA-256 集合・album membership・metadata 7 項目が一致、original 20 件の再 hash もズレなしを確認。
> - 実機由来の画像: 共有経由で保存し直した iPhone の JPEG を 1 枚 upload。`DateTimeOriginal` も GPS も持たない最小限の EXIF でしたが、`takenAt` が `null` になるだけで upload・derivative 生成・SHA-256 保持はいずれも正常でした。
> - 取り込みの検証（2026-09-17、local の `vite dev`、Playwright の Chromium 151 と WebKit 26.5、macOS）: 公開されている実機サンプル（[metadata-extractor-images](https://github.com/drewnoakes/metadata-extractor-images) と [exif-samples](https://github.com/ianare/exif-samples)。iPhone 4S〜6 Plus、Pixel 2、Galaxy S4〜S8 / Note 8、OnePlus 8、LG G3、Xperia Z3、Moto G、Oppo R7 Plus、Nokia 8.3 ほか）と、Pillow で作った合成 fixture を使った。どちらも repository には入れていない。
>   - metadata: EXIF orientation 1〜8（実機の縦位置 orientation 6 を含む）は、両 engine とも thumbnail の向きが一致した。MakerNote（最大約 60KB）、`OffsetTimeOriginal` あり・なし、`CreateDate` が偽の値（`2002:12:08`）で `DateTimeOriginal` が正しい機種、空白や範囲外の日付、orientation 0 / 9、IFD offset の破損は、いずれも upload が成功した。日付が読めない場合だけ `takenAt` が `null` になる。200 件を upload し、width / height / takenAt を Pillow で求めた期待値と照合して、両 engine とも不一致 0 件。iPhone の HEIC を `sips` で JPEG に変換した画像は、`-04:00` の offset 付きで取り込めた。
>   - 拒否されるもの: 空ファイル、画像でない中身、APP1 の長さが壊れた JPEG、HEIC（専用の文言を表示。[D-019](decisions.md)）。途中で切れた JPEG は、Chromium では decode 失敗として拒否され、WebKit では下半分が灰色のまま成功する。
>   - **見つかって直した問題（[D-020](decisions.md)）:** WebKit の canvas JPEG に APP1 / APP13 が付き、finalize が全件 `422` にしていた（WebKit で 200 件中 200 件が失敗）。PUT が 1 回失敗すると、その写真全体が失敗していた（通信断、応答の喪失、`503` を route で再現）。300 枚を選ぶと、97 件を残して完了表示になっていた。修正後は、WebKit と Chromium で 200 件が全件成功、失敗を注入した 3 件は再試行で成功（応答を失った PUT は `412` を経て成功）、300 件の選択は 300 件とも登録された。
>   - memory（Browser のプロセスツリーの RSS。50ms ごとに採取し、1 枚処理中の増分を記録）: 12MP で約 45〜110MB、48MP / 50MP で約 190〜340MB、108MP で約 440〜840MB、200MP で約 0.9〜1.1GB。decode 後の bitmap（幅 × 高さ × 4 byte）が支配的で、original の ArrayBuffer（最大 23MB）は小さい。200 件の連続 upload（計 920MB、48MP / 50MP を 6 件含む）で RSS は単調増加せず、peak は Chromium 約 1.1GB、WebKit 約 0.9GB（WebContent 単体では約 0.6GB）だった。前処理の並列数 1 / 2 / 3 で 48MP を 6 件処理すると、Chromium の増分は 420 / 682 / 975MB、所要時間は 2.0 / 1.6 / 1.5 秒。WebKit は 527 / 481 / 522MB、所要時間はいずれも約 2.3 秒だった。
>   - Browser の制約で試せなかったこと: WebKit では Playwright で横取りした PUT の Blob 本文が失われるため、再試行の再現は Chromium だけで行った（再試行のコードは engine に依存しない）。
> - 実 R2 の `412`（2026-09-17、remote-test、Browser の `fetch()` から CORS 越し、canvas で作った合成 JPEG）: 同じ presigned PUT URL へ 2 回目の PUT を送ると、original・thumbnail とも `412` が返り、`res.status` として読めた（network error にはならない）。そのあとの finalize は `200 created` で、再試行で `412` を受けた upload がそのまま ready になれることを確認した。確認に使った asset は trash へ移動済み。
> - 2026-09-17 の continuous-use 修正（完全削除が止まった写真の再 upload、止まった削除の再開、期限切れ upload の件数、取り込みの並列数、100MB 超の事前拒否、`APP_ORIGIN` の診断）: local だけで確認した。server 側は workerd の自動テスト、並列数は unit test。ライブラリ画面の表示と「削除を再開」、100MB 超の拒否は、Playwright の Chromium で一度だけ確認した（spec は commit していない）。`worker: APP_ORIGIN` は local の `vite dev` に対して CLI を実行し、`localhost` で PASS、`127.0.0.1` で FAIL になることを確認した。remote-test には未 deploy で、`pnpm diagnose` の新しい 3 項目（`worker: APP_ORIGIN`、`library: interrupted uploads`、`library: unfinished deletes`）は remote では未実行。
> - **未検証:** iPhone / Android 実機での取り込み。具体的には、iOS Safari の memory 上限（jetsam）と 48MP 以上の decode、iOS 写真ピッカーの HEIC → JPEG 変換と位置情報の扱い、画面ロックやアプリ切り替えで中断した PUT の再開、presigned URL の期限（600 秒）を越える中断。
>
> restore の検証に使った `edgephotos-restore-test` は drill 用の一時環境で、検証後に Worker・D1・R2 bucket・Access application・R2 API token をすべて削除しました。`wrangler.jsonc` には今後維持する環境だけを残します。再度 drill を行う場合は §2 と §4 の手順で作り直します。
>
> preview URL は `wrangler.jsonc` で無効にしてあります（`"preview_urls": false`）。有効だと `<version>-<worker>.<subdomain>.workers.dev` という別 hostname が生え、hostname 単位の Access application の対象外になります。実際、無効化前は preview URL 上の private API が Access のリダイレクトを受けず、Worker 自身の JWT 検証だけが `401 UNAUTHENTICATED` で拒否していました。漏洩はありませんでしたが、「private path は必ず Access が前段にいる」と言えなくなるため閉じました。無効化後は preview URL が `404` になることを確認済みです。
>
> owner 以外の identity を Worker が `403` にする経路は、Access policy が owner のみ Allow である限り Worker まで到達しないため、remote-test では実測できません。この検査は多層防御であり、回帰は unit test 側で担保します。

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

R2 credential は対象 bucket だけの Object Read & Write 権限を持つ R2 API token から作成します。Cloudflare account 全体を管理できる token を EdgePhotos へ設定しません。

## 4. Cloudflare Access

同じ hostname に 2 つの self-hosted application を作ります。path の指定はいずれも wildcard を付けません。

1. `photos.example.com`: Allow policy（owner の identity のみ）
2. `photos.example.com/share`: Bypass policy（Everyone）

より specific な path の application が優先するため、2 が `/share` 配下を先に処理します。wildcard を使わないのは、`/alpha/*` が親の `/alpha` 自体を含まないからです。`/share` と書けば `/share` と配下の両方が Bypass になります（remote-test で `/share`、`/share/{shareId}`、`/share/api/v1/*`、`/share/assets/*` を実測確認）。

1 の AUD tag を `ACCESS_AUD` に設定します。Access を通過しても `OWNER_EMAIL` と一致しない identity は Worker が `403` にします。

`/share/assets/*`（build 済み JS / CSS）と share API（`/share/api/v1/*`）はどちらも `/share` 配下なので、Bypass 1 つで公開面が揃います（[D-011](decisions.md)）。

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
| `library: interrupted uploads`（WARN） | finalize されないまま期限（600 秒）を過ぎた upload がある。設定の誤りではない。写真が timeline に無ければ選び直す。R2 object は自動では消えない（roadmap の既知の制約） |
| `library: unfinished deletes`（WARN） | 完全削除が途中で止まった写真がある。ライブラリ画面の「削除を再開」で完了させる |

Worker が `503 SERVER_MISCONFIGURED` を返すときは、Workers Logs に欠落・不正な設定の**名前**が `{"problem":"misconfigured","settings":[...]}` として出ます（値は出しません）。

`pnpm diagnose` が通ったあと、Browser で次を確認します。

- 写真を 1 枚 upload して timeline に表示される（`pnpm diagnose` は PUT を実行しないため、upload の成立はここで確かめる）
- 共有リンクを作成し、private window で表示でき、revoke 後は表示できない

設定不足時に写真機能を匿名公開する fallback はありません。設定が欠けていれば `503 SERVER_MISCONFIGURED` です。

remote-test に対する実行結果（2026-09-17）: owner token ありで 15 項目すべて PASS（`worker: APP_ORIGIN` と `library: *` を足す前の check 構成）。`EDGEPHOTOS_URL` を別の origin にすると `r2: CORS for upload` が FAIL になることも確認した。

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

- `GET /api/v1/export`（ライブラリ画面の「manifest をダウンロード」）: asset metadata、album / album_assets、object manifest、期待 SHA-256
- `pnpm backup export <dir>`: manifest に加え、original と derivative を presigned URL 経由で取得し、各 original の SHA-256 を検証して保存します

```bash
EDGEPHOTOS_URL=https://photos.example.com \
EDGEPHOTOS_ACCESS_TOKEN="$(cloudflared access token -app=https://photos.example.com)" \
pnpm backup export ./edgephotos-backup
```

含めないもの: R2 credential、JWT、share secret、presigned URL。Access token は API request の header にだけ使い、R2 へは送らず、保存もしません。

owner 以外の identity（service token 等）では API を利用できないため、CLI も owner の Access token を使います。

## 10. Restore

外部公開前に、別の空環境へ restore できることを実測します。

```bash
EDGEPHOTOS_URL=https://restore-test.example.com \
EDGEPHOTOS_ACCESS_TOKEN="$(cloudflared access token -app=https://restore-test.example.com)" \
pnpm backup restore ./edgephotos-backup     # restore 後に verify も実行する
pnpm backup verify ./edgephotos-backup      # 任意の時点で再検証
```

restore は通常の upload API で再登録します（[D-015](decisions.md)）。対象 library が空でなければ拒否します。

verify が確認する項目:

- asset count
- original SHA-256（R2 から再取得して計算）
- album membership（original SHA-256 基準）
- taken_at・favorite・trash 状態・filename・size 等の主要 metadata

restore した環境では過去の share を再有効化しません（share は export に含めません）。asset ID と `createdAt` は変わります。

`pnpm backup` は、通信エラー・`408`・`429`・`5xx` を backoff 付きで最大 4 回まで再試行します（作成系の request である upload の予約と album の作成は、重複を避けるため再試行しません）。10,000 件の backup / restore は、remote で 1 時間以上かかる見積もりです（[benchmarks.md](benchmarks.md)）。

restore が再試行でも回復せず途中で止まった場合は、空の環境を作り直して再実行してください（再開機能は未実装）。

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
- 最終 export 日時
- 適用済み migration

Worker のエラーログは request ID・route・例外名だけを出し、header・token・URL・body を出しません。

未完了 upload の R2 object は自動削除しません（Cron を置かない方針）。件数は diagnostics で確認できます。期限切れの件数が増え続ける場合は、取り込み中の画面ロックや回線断が多いことを疑います（roadmap の Post-merge verification）。

## 13. R2 credential の更新と漏洩対応

R2 API token（`R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY`）は presigned URL の署名にだけ使います。対象 bucket だけの Object Read & Write に限定します（§3）。

定期更新、または漏洩の疑いがある場合:

1. Dashboard の R2 → Manage API tokens で、同じ権限（対象 bucket のみ、Object Read & Write）の新しい token を作る
2. 漏洩の疑いがある場合は、**先に古い token を削除する**。削除した時点で、古い key で署名した URL（未使用の upload URL、表示中の画像 URL）はすべて無効になる。発行済み URL の期限は最大 600 秒なので、定期更新なら 3 → 4 の後に削除してよい
3. `pnpm wrangler secret put R2_ACCESS_KEY_ID [--env <env>]`、同じく `R2_SECRET_ACCESS_KEY`
4. `pnpm diagnose` で `r2: presigned GET` が PASS になることを確認する（library が空なら写真を 1 枚 upload）

切り替えの間に upload 中だった写真は PUT が `403` で失敗します。その写真を選び直せば upload されます。途中まで PUT された object は finalize されず、未完了の upload として残ります（roadmap の既知の制約）。

漏洩時に確認すること:

- R2 の古い token で何ができたか: 対象 bucket の読み書き。original を含むすべての写真を読めた可能性があります。上書きは reserve ごとの key と `If-None-Match` に守られません（token を持つ者は条件なしで PUT できる）
- original の改ざんを疑う場合は `pnpm backup verify <直近の backup>` を実行します。R2 から original を取り直し、SHA-256 を照合します
- Access の service token や Cloudflare account の API token が漏れた場合は、この節ではなく Cloudflare 側で revoke します。EdgePhotos は owner の email を持たない identity を受け付けません（[security.md](security.md) §3）

share secret が漏れた場合は、その share を revoke するか再発行します（`/api/v1/shares/{id}/revoke`、`/regenerate`）。

## 14. 復旧 drill

年に 1 回程度、または大きな変更の前に、restore できることを確かめます。手順は §2〜§4 で空の環境（例: `restore-test`）を作り、§10 の restore を実行するだけです。2026-09-16 の drill の記録は冒頭にあります。

drill で見るもの:

- `pnpm backup restore` が `ok: true` で終わる
- restore 先の timeline と album が開き、共有リンクを新しく作れる
- 所要時間（[benchmarks.md](benchmarks.md) の見積もりと比べる）

終わったら drill 用の Worker、D1、R2 bucket、Access application、R2 API token を削除します。
