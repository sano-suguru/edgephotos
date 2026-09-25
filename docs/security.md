# セキュリティ

## 1. セキュリティ契約

EdgePhotos は写真と metadata を扱うため、次を security invariant とします。

- private R2 を維持する。
- private API は fail-closed とする。
- Access を通過しただけでは household member とみなさない。
- share は明示した album の derivative だけを公開する。
- original を share しない。
- share secret、JWT、presigned URL、R2 credential をログへ出さない。
- D1 / R2 の片側障害を成功扱いしない。

## 2. 保護対象

- original
- thumbnail / preview
- 撮影日時・位置情報等の metadata
- album 関係
- household member identity
- share secret
- R2 signing credential
- Access configuration

### 信頼するもの・しないもの

EdgePhotos が信頼するもの（これが侵害されると写真を守れません）:

- Cloudflare。Worker の実行、D1 / R2 の保管、Access の認証を任せています。EdgePhotos は Cloudflare からも内容を隠す E2EE を持ちません。自分の Cloudflare アカウントに置くことは、Cloudflare が読めないことを意味しません
- Cloudflare アカウントの管理者
- household member 全員と、その端末（[member 間の信頼](#member-間の信頼)）
- backup ディレクトリを置く場所（下の「backup ディレクトリ」）

EdgePhotos が信頼しないもの:

- 認証されていないインターネット上の利用者。到達できるのは `/share/*` だけで、それ以外は Access で止まります
- 共有リンクを持たない第三者
- 共有リンクの受け取り手。渡すのは、その album の表示用画像だけです（[公開共有（share）](#4-公開共有share)）
- client から届く値。object key は受け取らず、ファイルの中身と metadata は untrusted input として検査します

Cloudflare アカウントの完全侵害と、利用端末の完全侵害は v1 の保証範囲外です。

### backup ディレクトリ

`pnpm backup export` が書くディレクトリには、original（EXIF の位置情報を含みうる）、derivative、`manifest.json`（元のファイル名・撮影日時・album 名・upload した member の email）が平文で入ります。EdgePhotos は backup を暗号化しません。

置き場所のアクセス制御と暗号化（ディスクの暗号化など）は利用者が行います。`manifest.json` に credential、JWT、share secret、presigned URL は入りません（`tests/integration/export-restore.test.ts` で検査しています）。

### 大量の request

`/share/*` は認証なしで到達できます。share secret は 256 bit なので、総当たりで写真を取り出すことは現実的ではありません。

一方、無効な share ID への request を大量に送れば、Worker の request と D1 の読み取りを消費させられます。Workers Paid では利用料が増え、Workers Free では 1 日の上限に達したあと、正当な利用者も使えなくなります。

v1 は rate limiting を持たず、この種の可用性・費用への攻撃は保証範囲外です。Cloudflare の利用状況で `/share/api` への想定外の request が観測された場合に、Cloudflare の WAF / rate limiting rules を候補にして検討します（[将来要件を先回りしない](../AGENTS.md#6-将来要件を先回りしない)）。

## 3. private API の認証と認可

private API は二段階で認証・認可します。

1. Cloudflare Access が入口を保護する。
2. Worker が Access assertion を検証し、設定された household の identity と照合する。

JWT は存在するだけで信用しません。署名、issuer、audience、期限を固定設定に対して検証します。

認証設定、JWKS 取得、issuer / audience が不正な場合は拒否します。

実装上の規則:

- `Cf-Access-Jwt-Assertion` header だけを検証対象にします（Cookie は読みません）。
- RS256 署名・issuer（`https://{ACCESS_TEAM_DOMAIN}`）・audience（`ACCESS_AUD`）・`exp` を検証します。
- `email` が `HOUSEHOLD_EMAILS` のいずれかと一致する principal だけを member とします（大文字小文字は区別しません）。email を持たない service token は member になりません。
- `HOUSEHOLD_EMAILS` は email の comma 区切りです。読み取れない entry が 1 つでもあれば設定全体を無効とし、`503` にします。打ち間違えた設定で「一部だけ通る」状態にしないためです。
- `HOUSEHOLD_EMAILS` / `ACCESS_TEAM_DOMAIN` / `ACCESS_AUD` / `APP_ORIGIN` / R2 署名設定のいずれかが欠けていれば、token が正しくても `503 SERVER_MISCONFIGURED` を返し、データを返しません。

### member 間の信頼

member は互いに対等で、library 全体に同じ権限を持ちます。写真をどの member が upload したかは記録しますが（[D-034](decisions.md)）、表示のためだけの値です。認可・絞り込みには使いません。通常の upload では reserve した member を記録し、client は値を指定できません。restore の endpoint は backup の値を申告として受け付けるので、どの member も任意の値を書けます。member の email は private API の asset と backup の `manifest.json` に入ります。共有ページの response には入りません。

したがって次は設計上の前提です（[D-028](decisions.md)）。

- どの member も、他の member が upload した写真を trash・完全削除・export できます。
- どの member も、他の member が作った share を revoke・再発行できます。
- member 1 人のアカウントや端末が侵害されれば、library 全体が侵害されます。login は email に届く One-time PIN なので、ここでいうアカウントには member の email アカウントが含まれます。Access の independent MFA を足すと、authenticator の登録後は email だけでは入れなくなります。Worker はこれを検証できないため、EdgePhotos の必須設定にはしていません（[D-038](decisions.md)、[MFA を足す](operations.md#mfa-を足す推奨)）。member の削除は Access policy と `HOUSEHOLD_EMAILS` の両方から行います。

member 間で権限を分けたい場合、この設計では解決できません。

## 4. 公開共有（share）

公開面は `/share/*` だけです。

```text
/share/{shareId}#{secret}
```

secret は 32 random bytes の CSPRNG を base64url 表現したものを基準とします。D1 へは hash のみ保存します。

secret と share ID が不一致・期限切れ・revoke 済み・album 削除済みのいずれでも、一律に `404 SHARE_UNAVAILABLE` を返します。secret hash の比較は定数時間で行います。

share API は object key を client から受け取りません。`assetId + variant` を受け取り、Server 側で R2 key を解決します。

許可 variant:

- thumbnail
- preview

禁止:

- original
- 他 album の asset
- trash / deleted asset
- 任意 object key

## 5. 共有失効（revoke）の意味

revoke 後は新しい画像 URL を発行しません。

revoke 済みの share は再発行（`/regenerate`）もできません。再発行は「古い share がまだ有効である」ことを条件にした INSERT で行います。そのため、revoke を読み取った後に届いた再発行要求も `409 SHARE_UNAVAILABLE` になります。

別 tab や再送によって、閉じたはずの album に有効な link が戻ることはありません。期限切れの share も同じく再発行できません。

ただし、すでに発行済みの presigned URL（share では最大 300 秒有効。[presigned URL](#6-presigned-url)）、取得済みファイル、browser cache、screenshot を回収できるとは説明しません。

共有失効は「以後の新規アクセスを止める」機能であり、DRM ではありません。

## 6. presigned URL

Presigned URL は bearer capability です。URL を持つ人は誰でも、期限まで、署名された 1 つの操作を 1 つの object に実行できます（[R2 の Presigned URLs](https://developers.cloudflare.com/r2/api/s3/presigned-urls/)）。R2 の S3 endpoint（`<ACCOUNT_ID>.r2.cloudflarestorage.com`）は Access の外にあり、request は Worker も通りません。認可は、Worker が URL を発行する時点で済んでいます。

漏れても安全な URL ではありません。漏れたときに何ができるかを、次の制約で狭めています。

- 操作を PUT または GET に限定する（method は署名に含まれる）。
- object key を 1 つに限定する。key は Server が決める。
- 有効期限を短くする（下表）。
- PUT は条件と checksum を署名に含める（下表）。
- Access Cookie / JWT を R2 へ送らない。

presigned URL を 1 つずつ失効させる仕組みはありません。share の revoke、trash、`HOUSEHOLD_EMAILS` から member を外すことのどれも、発行済みの URL を無効にしません。完全削除は object を消すので、その後の GET は失敗します。発行済みの URL をまとめて止められる見込みがあるのは、R2 API token の削除だけです（未確認。[R2 credential の更新と漏洩対応](operations.md#13-r2-credential-の更新と漏洩対応)）。

R2 CORS は `APP_ORIGIN` だけを許可しますが、access control ではありません。止めるのは、別の origin の page の script が response を読むことと、preflight の要る PUT を送ることだけです。URL を持っていれば、curl や別のサイトの `<img>` からは CORS と関係なく GET できます（設定は [R2 CORS](operations.md#6-r2-cors)）。

URL を client の外へ出さないために:

- URL を返す API の response は `Cache-Control: private, no-store` にする。
- Worker のログと backup の manifest に URL を書かない（[ログ](#9-ログ)）。
- original を保存するときは、URL を tab で開かず、Blob として読んでから保存する（[D-036](decisions.md)）。

client の中には残ります。画像の context menu（画像のアドレスをコピー、新しい tab で開く）は `<img>` の URL をそのまま渡します。browser の開発者ツールは、読み込みに失敗した画像の URL を表示します。browser の HTTP cache には、表示した thumbnail / preview の bytes が残ります（original のダウンロードは cache に残さない）。

| 操作 | TTL | 署名に含めるもの | 保証 |
| --- | --- | --- | --- |
| upload PUT | 600 秒 | `Content-Type`、`If-None-Match: *`、original は `x-amz-checksum-sha256` | 期限内に URL を再利用しても、保存済み object を上書きできない。original の body が申告 SHA-256 と違えば R2 が拒否する |
| member GET | 600 秒 | — | 発行時に household member であることを確認する。発行後は URL を持つ誰でも GET できる |
| repair PUT（欠落） | 300 秒 | `Content-Type: image/jpeg`、`If-None-Match: *` | derivative key に限る。original の key は署名しない。空の key しか埋められない（[D-026](decisions.md)） |
| repair PUT（置き換え） | 300 秒 | `Content-Type: image/jpeg`、`If-Match: <検査した ETag>` | 検査した「使えない object」だけを置き換える。別の repair が先に直していれば `412`。妥当な derivative は上書きできない（[D-026](decisions.md)） |
| share GET | 最大 300 秒 | — | share の残り期限を超えて発行しない |

finalize は、R2 が記録した SHA-256 と申告値の一致を確認するまで asset を `ready` にしません（[D-018](decisions.md)）。したがって `assets.sha256` は、R2 が検証した original の SHA-256 です。

例外として、D-018 より前に `ready` になった asset の `sha256` は client の申告値のままです。`pnpm backup verify` で照合するまで、この保証はありません。

## 7. metadata の漏れ防止

original には GPS を含む可能性があります。

share へ返す metadata は allowlist 方式とし、次を返しません。

- original EXIF JSON
- GPS
- original filename
- checksum
- R2 object key
- household member information

thumbnail / preview は metadata をコピーせず生成します。HEIC / HEIF の original でも同じです。derivative は decode した bitmap から canvas で描き直した JPEG で、original の EXIF は写りません。

finalize は、derivative の最初の scan（SOS）までの header segment を allowlist で検査します。

- 受け付ける segment: SOF、DHT、DQT、DRI、APP0（thumbnail を持たない 16 byte の JFIF だけ）、APP14（14 byte の Adobe だけ）
- 上記以外の segment（APP1 の EXIF / XMP、APP13 の IPTC、COM、APP2 の ICC profile と MPF、APP11 の JUMBF など）を含む derivative は `422` で拒否する
- SOS の前に SOF が無い bytes と、SOS の前に fill byte（`FF FF`）・RSTn・TEM・EOI を置いた bytes も拒否する

検査するのは segment の種類と、APP0 / APP14 の形だけです。SOF / DHT / DQT / DRI の中身、最初の scan より後ろ、EOI の後ろは検査しません（[limitations.md](limitations.md#8-derivative-の検査は-header-segment-の種類まで)）。Client は PUT 前に、同じ判定関数（`src/contracts/jpeg-segments.ts`）で許可されない segment を取り除きます。

### 画像を解析する箇所

Worker は画像を decode しません。Worker が読むのは、形式判定のための先頭 1024 byte までと、derivative の JPEG segment だけです。

EdgePhotos が足した parser は ISO BMFF の box header を読む 1 つです。untrusted input として扱い、宣言された size を検査してから進みます（不正な size、手元の bytes を超える size、4 byte 単位でない compatible brands、1024 byte を超える `ftyp`、印字可能でない box type はすべて拒否）。box の中身は読みません。詳細は [D-030](decisions.md) にあります。

metadata の読み取り（`exifr`）は、untrusted なファイルに対して最も無防備な処理です。壊れた HEIC で返ってこなくなる例を実測したため、decode に成功したファイルだけに渡します（[verification.md](verification.md)）。

HEIC の decode は browser / OS の decoder に任せ、Worker では decode しません。そのため HEIC decoder 固有の攻撃面を server 側に足しません。browser / OS の decoder 自体の脆弱性は、EdgePhotos からは制御できません。

## 8. HTTP / Browser

共有ページと share API では以下を基本とします。

```http
Cache-Control: private, no-store
Referrer-Policy: no-referrer
X-Content-Type-Options: nosniff
X-Robots-Tag: noindex, nofollow, noarchive
```

CSP は `self` を基準にし、third-party analytics、外部 font、不要な script を share page へ追加しません。

private API は GET で状態を変えません。例外はありません（最終 backup の記録も `POST` です。[D-033](decisions.md)）。

Origin は明示した `APP_ORIGIN` と比較し、受信 Host をそのまま信用しません。

- `Origin` がある書き込み request は、`APP_ORIGIN` と完全一致しなければ `403 ORIGIN_NOT_ALLOWED` とします。
- `Origin` がなく `Sec-Fetch-Site` が `same-origin` / `none` 以外の場合も拒否します。
- どちらの header もない request（Native client、CLI）は Access assertion の検証だけで判定します。

CLI（`pnpm backup` / `storage` / `diagnose`）は Access token を header で送るため、`EDGEPHOTOS_URL` に `https://` の origin（path、query、fragment、認証情報なし）を要求します。`http://` は loopback（`localhost`、`127.0.0.1`、`[::1]`）だけ受け付けます。

共有ページの CSP は `default-src 'self'` を基準にし、`img-src` だけ R2 の S3 endpoint を追加で許可します。

### private app の CSP

private app（Access の内側の SPA）で script を実行されると、その member ができること（library 全体の削除・export、presigned URL の取得）をすべてできます。一次の対策は、利用者の入力（album 名、ファイル名、upload した member の email）を JSX の text として描画し、`innerHTML` / `dangerouslySetInnerHTML` を使わないことです。外部の script・analytics・font も読み込みません。

CSP はその次の層です。private app のすべての HTML（未知の path に SPA fallback が返すものを含む）を Worker が返し、次の policy を付けます（[D-037](decisions.md)）。

```text
default-src 'self'; script-src 'self'; style-src 'self';
img-src 'self' https://<R2_ACCOUNT_ID>.r2.cloudflarestorage.com;
connect-src 'self' https://<R2_ACCOUNT_ID>.r2.cloudflarestorage.com;
font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'
```

`Referrer-Policy: no-referrer` と `X-Content-Type-Options: nosniff` も付けます。`'unsafe-inline'`、`'unsafe-eval'`、`data:`、`blob:`、wildcard は許可しません。

防ぐもの:

- 注入された markup の inline `<script>`、`onerror=` などの inline event handler、`eval()`、外部の script
- 別の origin（R2 の他の account を含む）への `<img>` / `fetch()` による持ち出し
- 別のサイトの frame に private app を埋め込むこと（clickjacking）
- `<base>` の差し替え、`<form>` の送信先の差し替え、plugin

防がないもの:

- 同じ origin の script として動いてしまった攻撃（依存 package の侵害など）。そうした script は private API を member として呼べる
- 自分の account の R2 への書き込み・読み出し。攻撃者の script は presigned URL を発行させて、その URL を画面や `'self'` 経由で扱える
- `'self'` への送信。private API に書き込んだ値（album 名など）は、household の他の member にも見える
- CSS による情報の読み出しのうち、同じ origin の stylesheet で完結するもの
- browser の拡張機能と、member の端末の侵害

`vite dev` は Vite が挿入する tag にだけ nonce を付け、同じ policy で動きます。Browser E2E は CSP 違反が 1 件でもあれば失敗します（`e2e/fixtures.ts`）。

## 9. ログ

ログへ残してよいもの:

- route template
- request ID
- status
- 処理時間
- 件数
- 非機密の内部エラーコード
- `503 SERVER_MISCONFIGURED` の原因になった設定の**名前**（値は出さない）

残してはいけないもの:

- Authorization header
- Cookie
- JWT
- share secret
- presigned URL 全文
- R2 credential
- EXIF 全文
- original filename を含む機密情報

例外オブジェクトの自動 dump や debug log も対象です。

上の規則は EdgePhotos が書くログの規則です。Cloudflare の Workers Logs（`wrangler.jsonc` の `observability`）は、これとは別に、Worker への各 request の URL・header を invocation log として Cloudflare account に保存します（[Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/)、[request metadata と header を記録する旨の changelog](https://developers.cloudflare.com/changelog/post/2025-04-07-increase-trace-events-limit/)）。share API の `Authorization`（share secret）、`Cf-Access-Jwt-Assertion`、CLI が送る `cf-access-token`（Access token）もこの header に含まれます。

Tail Worker に渡る request では、名前に `auth` / `jwt` などを含む header の値が既定で伏せられます（[Tail Handler](https://developers.cloudflare.com/workers/runtime-apis/handlers/tail/)）。Workers Logs に同じ処理が適用されるかは Cloudflare の文書に書かれていないため、production で確かめました。2026-09-25 の production では、observability API から読める `Authorization`・`Cf-Access-Jwt-Assertion`・`Cookie`・`cf-access-token` の値は伏せられていました（[verification.md](verification.md#workers-logs-が-credential-の-header-を伏せるか2026-09-25)）。Cloudflare の挙動が変わっても気付けるよう、家族の写真を入れる前と、その後も定期的に同じ手順で確かめます。伏せ方は Cloudflare の推定ルールによるもので、EdgePhotos が制御するものではありません。Workers Logs は Cloudflare account の中にあり、account の管理者は [信頼するもの](#信頼するものしないもの) に含まれます。presigned URL は Worker の response body にだけ入り、Worker への request には現れません。

## 10. 削除

通常の削除はまず論理削除 / trash とし、すぐに original を消しません。

物理削除は再実行可能な処理にし、途中失敗から再開できるようにします。

D1 に参照がない R2 object を、即座に「ゴミ」と判定しません。D1 restore によって索引だけ過去状態になっている可能性があるためです。storage audit はこれを `unreferenced_objects` として報告するだけで、削除しません。

storage cleanup（[D-023](decisions.md)）が削除するのは、`uploads` 行が指す key のうち、asset にならずに終わった upload のものだけです。

key は Server が `uploads.asset_id` から作り、client や R2 の list から受け取った文字列を削除に使いません。同じ ID の `assets` 行がある場合は削除しません。cleanup は member の API で、Access と Origin の検査は他の書き込みと同じです。

完全削除は、asset が trash 内にあることを D1 の条件付き更新で確かめてから始めます。

## 11. 必須回帰テスト

以下は UI テストより優先します。

- 未認証 private API が拒否される。
- Access user でも household 外の email は拒否される。
- 設定した 2 人の member がどちらも同じ library を読み書きできる。
- 2 人の member が upload した写真は、それぞれの upload した人を区別して記録する。別の member や storage cleanup が finalize しても、reserve した member が残る。backup から restore しても残り、restore を実行した member にならない。通常の upload で client が送った値は記録しない。記録の無い写真も読み書きでき、upload した人を補わない（[D-034](decisions.md)）。
- Access 設定異常時に private data を返さない。
- share secret 不正 / expired / revoked を拒否する。
- 別 album の asset を share から取得できない。
- 共有ページで album 名が markup として解釈されない（`e2e/share.spec.ts`）。
- private app の HTML（未知の path を含む）は CSP 付きで返り、`/api`・`/share`・`/__local` 配下の route の無い path は app にならない（`tests/integration/app-shell.test.ts`、`e2e/csp.spec.ts`）。Browser E2E は CSP 違反 1 件で失敗する。
- `/share/assets/*` に無いファイルが private app にならない。`wrangler.jsonc` の `run_worker_first` と `not_found_handling` を `pnpm diagnose --offline`（`pnpm check` に含む）が検査する。
- share から original を取得できない。
- preview / thumbnail から GPS が除去される。
- upload finalize 再送で重複 asset が生じない。
- 申告 SHA-256 と一致しない original を保存しない・`ready` にしない。
- D1 障害時に upload を成功扱いしない。
- 完全削除が途中で止まった asset を、同じ写真の再 upload で「重複」と扱わない（reserve で登録済みと報告しない、finalize で新しい object を消さない）。
- 完全削除と同時に trash から復元された写真を削除しない。
- finalize の UNIQUE 競合の処理が、自分の作った asset の object を重複として消さない。
- storage cleanup が、写真・止まった削除・どの行も指さない object・進行中の upload の object を消さない。cleanup が片付けた upload から、後の finalize で asset が作られない。
- storage audit が何も書き込まない。
- derivative の作り直しが original を削除・変更しない。作り直しの前後で original の SHA-256、asset ID、album membership、favorite、trash、`createdAt` / `takenAt` が変わらない（[D-026](decisions.md)）。
- 作り直しの対象 object key を client が指定できない（request は asset ID だけ）。
- 作り直した derivative も、allowlist 外の header segment を含むものは受け付けない（upload と同じ検査）。
- original が壊れている写真へ作り直しの URL を発行しない。
- 作り直しが object を削除しない。古い repair の target が、新しい repair の直した derivative を上書き・削除できない（`If-Match` で `412`）。

上記は `tests/integration/*.test.ts` と `tests/e2e/vertical.test.ts` で自動化しています。

ただし「preview / thumbnail から GPS が除去される」は二段構えです。canvas による再エンコードは Chromium と WebKit で確認しています。WebKit の encoder が付ける APP1 / APP13（撮影 metadata は含まない）など allowlist 外の segment は、Client が PUT 前に取り除きます。

自動テストの対象は、その除去処理と Worker の finalize 検査（allowlist 外の segment を含む derivative の拒否）です。Server 側の保証は変わりません（[D-020](decisions.md)）。

## 12. ローカル開発用の模擬機構

`vite dev` の間だけ、Access assertion の付与と local blob URL を dev server で模擬します（[D-016](decisions.md)）。

本番 build には含まれません。`vite preview`（production build）では、設定がない限り `503` で fail-closed になることを確認しています。

## 13. credential の流出経路

アプリが制御できる既知の経路と、その扱いです。「漏れない」ことの証明ではありません。

- 防止: アプリの実装で閉じており、test か code で確かめられる
- 許容: 設計上残し、理由を書いている
- 要確認: Cloudflare の挙動に依存し、実環境で確かめる

対象の credential: presigned URL（PUT / GET）、share secret、Access の JWT（`Cf-Access-Jwt-Assertion`、`CF_Authorization` Cookie、CLI の `cf-access-token`）、R2 の API token。

| 経路 | 扱い | 根拠 |
| --- | --- | --- |
| Worker が書くログ（`console.*`） | 防止 | 設定の**名前**、request ID、route、例外の `name` だけを書く（`src/worker/app.ts` の `onError` と `misconfigured`）。例外の message は書かない |
| 例外・error response | 防止 | 500 は `INTERNAL` とだけ返す。client の error は status と code から作り、URL を含めない（`src/web/lib/storage-transfer.ts`、`src/web/lib/api/client.ts`） |
| Browser の console | 防止（アプリが書く分） | `console.warn(err)` の err は URL を持たない。ただし browser 自身が、読み込みに失敗した画像や fetch の URL を開発者ツールに出す（許容。member の端末の中） |
| CLI の出力 | 防止 | `pnpm diagnose` / `backup` / `storage` は token と presigned URL を出力しない（`tests/unit/diagnose.test.ts` が R2 の host を含まないことを確かめる） |
| analytics / telemetry | 防止 | 送信先を持たない。CSP の `connect-src` / `img-src` が `'self'` と自分の R2 以外を拒否する |
| Workers Logs の request header | 要確認 → 2026-09-25 は伏せられていた | Cloudflare の推定ルールで伏せられる（[ログ](#9-ログ)）。手順は [verification.md](verification.md#workers-logs-が-credential-の-header-を伏せるか2026-09-25) |
| Workers Logs の request URL | 許容 | URL は伏せられない。share ID と private API の path / query（cursor、年月）が残る。share secret は fragment、presigned URL は response body にあり、Worker への request URL には現れない |
| response の記録 | 防止（EdgePhotos）/ 要確認 → 2026-09-25 は記録されていなかった | EdgePhotos は response を書かない。presigned URL を返した production の invocation log に、署名（`X-Amz-Signature`）は現れなかった（[verification.md](verification.md#workers-logs-が-credential-の-header-を伏せるか2026-09-25)） |
| browser の履歴・address bar | 防止（private app）/ 許容（share） | private app は path と `?m=YYYY-MM` だけを履歴に入れ、presigned URL で navigation しない（[D-036](decisions.md)）。共有リンクの secret は fragment にあり、受け取り手の履歴に残る。link を持つことが閲覧の権限なので許容する |
| Referer | 防止 | private app と共有ページの HTML・API に `Referrer-Policy: no-referrer`（header と `<meta>`）。original の fetch は `referrerPolicy: 'no-referrer'` |
| HTTP cache | 防止（URL を返す response）/ 許容（画像の bytes） | presigned URL と share の response は `Cache-Control: private, no-store`。thumbnail / preview の bytes は browser の cache に残る。original のダウンロードは `cache: 'no-store'` |
| localStorage / sessionStorage / IndexedDB / Cache Storage / Service Worker | 防止 | どれも使わない（`src/` に呼び出しが無い） |
| アプリの state（memory） | 許容 | presigned URL は画面の state と `<img src>` に期限（最大 600 秒）まで残る。同じ origin の script は読める（[CSP](#private-app-の-csp) が防がないもの） |
| backup manifest | 防止 | URL・token・secret を持たない（`tests/integration/export-restore.test.ts`） |
| clipboard | 許容 | 共有リンク（secret を含む）は利用者が copy して渡すもの |
| Playwright の trace（CI の artifact） | 対象外 | `vite dev` の local URL と test 用の鍵だけで、実 R2 の URL や Access token を含まない |

