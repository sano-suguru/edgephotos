# アーキテクチャ

EdgePhotos v1 の構造と、どの層が何を担当するかをまとめます。

技術選定の理由や却下した案は [decisions.md](decisions.md) にあります。

## 1. 全体構成

```text
                    Web
             Preact + Signals
                    |
                    | HTTP/JSON
                    v
             Cloudflare Access
                    |
                    v
+---------------------------------------------+
|           Cloudflare Worker                 |
|                                             |
| Hono + @hono/zod-openapi                    |
|                                             |
| auth -> AppPrincipal                        |
| uploads / assets / albums / shares / export |
+------------------+--------------------------+
                   |            |
                   v            v
                  D1        private R2
               metadata      originals
                             derivatives

Binary data path:
Web / Future Native <---- presigned PUT/GET ----> R2
```

デプロイ単位は 1 Worker です。Web の静的ファイルは Workers Static Assets として同じデプロイに含めます。

## 2. 各層の責務

### Client

Web は Preact + Signals で構築します。

Client の責務:

- ファイル選択
- 画像形式・画素数等の事前確認
- EXIF から必要な metadata を抽出
- original の SHA-256 計算
- thumbnail / preview 生成
- presigned URL を使った R2 直接 PUT / GET
- UI state と upload progress の管理

Client が担当しないもの:

- 最終認可
- asset の保存確定
- object key の決定
- share 対象 asset の最終判定

将来 Native client を追加する場合も分担は同じです。画像の前処理は Client で行い、保存の可否と認可は Server が判断します。

### Worker / Hono

Worker が担当するのは次の範囲です。

- Access assertion の検証
- `AppPrincipal` への正規化
- household member かどうかの確認
- リクエストの検証
- D1 への状態保存
- R2 object の存在・属性確認
- presigned URL 発行
- share capability の検証
- export / operational endpoints

画像の decode / resize / 動画変換は通常処理として Worker に載せません。

### D1

D1 は状態と索引を保持します。

主なデータ:

- assets
- uploads
- albums
- album_assets
- shares
- settings

写真 binary、R2 credential、Access token、share secret 平文は保存しません。

正確な schema は migration が定義します。`src/worker/db/schema.ts`（Drizzle）は、それと一致することを test で確認した型・query 用の定義です（[D-017](decisions.md)）。

### private R2

R2 は binary data を保持します。

```text
originals/{assetId}
derivatives/v1/{assetId}/thumbnail.jpg
derivatives/v1/{assetId}/preview.jpg
```

original と再生成可能な derivative を物理的にも分離します。

## 3. 認証境界

Web と将来 Native で認証方式が変わっても、認証後の処理へ渡す利用者情報は同じ形にします。

Cloudflare Access 固有の token・assertion・Cookie は HTTP 層で検証します。検証した結果は `AppPrincipal` という 1 つの型にまとめます。

認証後の処理は `AppPrincipal` だけを受け取り、Access の claim 形式には依存しません。認証方式を変えても、その後の処理は変えずに済みます。

`AppPrincipal` の定義は [`src/worker/auth/access.ts`](../src/worker/auth/access.ts) を正とします。

EdgePhotos が想定する利用者は 1 つの household です。Access を通過しただけでは member とみなしません。`HOUSEHOLD_EMAILS` に設定した email と一致する principal だけが private API を使えます（[D-028](decisions.md)）。

member は互いに対等で、1 つの library を共同利用します。`AppPrincipal` は role を持たず、asset・album・share のどの行にも「誰が作ったか」を記録しません。したがって認可の判断は「member かどうか」だけです。

将来 Native client を追加する場合は Cloudflare Access Managed OAuth を第一選択とします。Native 固有の token を Worker の中で直接解釈しない形は変えません。

## 4. API 境界

API は Web の画面構造ではなく、写真ライブラリの操作を表現します。

```text
/api/v1/*        private application API
/share/api/v1/*  public share capability API
```

HTTP/JSON を使います。request / response / error は `@hono/zod-openapi` の route schema で定義し、そこから実行時の検証と OpenAPI を生成します。

Web も将来の Native client も、同じ API を使います。

エラー形式は以下を基本とします。

```json
{
  "error": {
    "code": "UPLOAD_NOT_READY",
    "message": "Upload is not ready to finalize.",
    "requestId": "..."
  }
}
```

`code` は機械可読とし、UI 文言のローカライズは Client 側で行います。

主な resource（詳細は `/api/v1/openapi.json`）:

```text
GET    /api/v1/me
POST   /api/v1/uploads                          reserve
POST   /api/v1/uploads/{uploadId}/finalize      idempotent
GET    /api/v1/assets?cursor&limit&favorite&trashed
GET    /api/v1/assets/{assetId}
PATCH  /api/v1/assets/{assetId}                 { isFavorite }
GET    /api/v1/assets/{assetId}/original        short-lived URL (household member only)
POST   /api/v1/assets/{assetId}/derivatives/repair      rebuild missing thumbnail/preview (D-026)
POST   /api/v1/assets/{assetId}/trash | /restore
DELETE /api/v1/assets/{assetId}                 permanent delete (trashed only, resumable)
GET    /api/v1/albums?covers      POST /api/v1/albums
GET|PATCH|DELETE /api/v1/albums/{albumId}
GET    /api/v1/albums/{albumId}/assets
PUT|DELETE /api/v1/albums/{albumId}/assets/{assetId}   idempotent
GET|POST /api/v1/albums/{albumId}/shares
POST   /api/v1/shares/{shareId}/revoke | /regenerate   regenerate は有効な share のみ
GET    /api/v1/export/assets | /albums | /album-assets   manifest pages (after, limit)
GET    /api/v1/diagnostics                      non-sensitive counts, unfinished purge ids
GET    /api/v1/storage/audit?after&limit&deep   D1 / R2 comparison (read-only)
POST   /api/v1/storage/cleanup                  resolve interrupted uploads (D-023)
GET    /share/api/v1/shares/{shareId}           Authorization: Bearer <secret>
GET    /share/api/v1/shares/{shareId}/assets/{assetId}/{thumbnail|preview}
```

画像 URL は短命な presigned GET を JSON で返します。Worker が画像 byte を中継することはありません。

一覧（`GET /api/v1/assets`、album の assets）は thumbnail の URL だけを返します。preview の URL は個別の asset（`GET /api/v1/assets/{assetId}` など）で返します（[D-022](decisions.md)）。

album 一覧は `covers=true` のときだけ、各 album の最新の写真の thumbnail URL を返します。album ごとの request を 1 回にまとめるためです。

## 5. Upload の手順

```text
1. Client preprocess
2. POST /api/v1/uploads
3. Worker creates reservation and object keys
4. Worker returns short-lived presigned PUT URLs
5. Client PUTs original / thumbnail / preview directly to R2
6. POST /api/v1/uploads/{id}/finalize
7. Worker verifies reserved R2 objects
8. D1 transaction creates/commits asset
9. asset becomes ready
```

finalize での確認内容（[D-012](decisions.md)）:

- 3 object の存在。欠けている間、upload は `pending` のまま再試行できる
- original の SHA-256 が reserve 時の申告と一致すること。R2 が upload 時に記録した値（binding の `head().checksums.sha256`）を使います（[D-018](decisions.md)）
- size が reserve 時の申告と一致すること
- original の magic bytes が申告 content type と一致すること
- thumbnail / preview が EXIF / XMP / IPTC segment を含まない JPEG であること

検査に通らない upload は `ready` になりません。どの検査がどの status になるかは、route schema が定義します。

D1 への asset 作成と upload 状態更新は、1 つの D1 batch（transaction）で行います。asset は upload 行がまだ `pending` の場合だけ作ります（`INSERT ... SELECT ... WHERE status = 'pending'`。[D-023](decisions.md)）。

asset ID は reserve 時に確定しているため、再送や同時実行でも同じ asset へ収束します。同じ SHA-256 の asset が既にあれば `result: "duplicate"` として既存 asset を返します（[D-014](decisions.md)）。ただし完全削除が途中で止まった asset（`purging`）は重複とみなさず、reserve と finalize がその削除を完了させてから進みます。

presigned PUT は `Content-Type` と `If-None-Match: *` を署名し、保存済み object の上書きを R2 側で拒否させます（[D-013](decisions.md)）。

original の PUT は、さらに申告 SHA-256 を `x-amz-checksum-sha256`（raw digest の base64）として署名します。R2 は body の digest が一致しない PUT を拒否し、object を作りません。Client はこの header を省略も変更もできません（[D-018](decisions.md)）。

finalize は upload の期限を見ません。期限内に PUT が済んでいれば、background に回した tab が期限後に復帰しても finalize できます。PUT が済んでいない upload は、presigned URL が失効しているため完了できず、`pending` のまま残ります。

中断した upload は、member が実行する storage cleanup が片付けます。3 object が揃って検査を通るものは finalize して写真にし、それ以外は終端状態にしてから、その upload の key の object だけを消します。実行の条件と閾値は [D-023](decisions.md) にあります。

reserve の `metadata.createdAt`（任意、未来は不可）は asset の `createdAt` になり、撮影日時の無い写真の並び順にも使います。restore が backup の値を送ります（[D-024](decisions.md)）。

失敗した upload をどこからやり直すかは Client が決めます。Server 側の契約は、finalize が冪等であることと、presigned URL が期限内に限り再利用できることです（[D-020](decisions.md)）。

不変条件:

- original は byte-for-byte immutable
- 保存済み original を上書きしない
- R2 確認前に `ready` にしない
- finalize 再送で同じ asset へ収束する
- D1 障害時に R2 object を即削除しない
- asset 行が使っている ID の key は、cleanup でも重複処理でも削除しない（削除するのは完全削除だけ）
- D1 と R2 を 1 transaction として扱わない

## 6. 保存する画像の契約

### original

- 元 byte 列をそのまま保持
- 再エンコードしない
- EXIF / GPS を改変しない
- SHA-256 を metadata として保持
- household member のみ取得可能
- share では配信しない

SHA-256 の出どころは 2 通りです。D-018 以降に finalize された asset では、R2 が upload 時に検証した値です。それより前の asset は申告値で、`pnpm backup verify` で照合します（[D-018](decisions.md)）。

Browser の JPEG encoder が付ける APP1 / APP13 は、Client が PUT 前に取り除きます。WebKit は Exif の色空間・画素数と空の IPTC を書き出します。finalize は引き続き APP1 / APP13 を含む derivative を拒否します（[D-020](decisions.md)）。

original の形式は JPEG / PNG / WebP / HEIC / HEIF です。判定は Client と Worker が共有する 1 つの sniff が bytes から行います。HEIC / HEIF では `ftyp` box の major brand と compatible brands の両方を読み、still image の brand だけを受け入れます。image sequence と AVIF は拒否します（[D-030](decisions.md)）。

`<input accept>` は選択 UI への hint です。どの形式を保存するかの根拠にはしません。filename と `File.type` も使いません。Client はファイルの先頭 1024 byte を読んで形式を決め、そのあとで全体を読みます。

HEIC / HEIF では、top-level box を歩いて、ファイル自身が宣言する box の長さと受け取った byte 数が整合するかも確認します。decoder は後半が失われた HEIC からでも画像を返すため、「表示できた」を原本が揃っている証拠にしません。Client と Worker の両方で確認し、整合しないものと判定しきれなかったものは asset にしません（[D-030](decisions.md)）。

HEIC は decode できる環境でのみ受け付けます。判定は UA ではなく、埋め込んだ小さな HEIC を `createImageBitmap` に通す capability probe です。decode できない環境では、reserve と R2 PUT の前に拒否します。`image/heif` は HEVC 以外の codec を含められるため、この probe の対象にせず、そのファイル自身の decode 結果で判断します。

Web 版が保存する original は「Browser から受け取った byte 列」です。写真ピッカーが選択時に別の形式へ変換した場合、保存されるのは変換後の byte 列で、その形式を sniff の結果として記録します。EdgePhotos が受け取っていない byte 列を保存したとは表示しません。

### 撮影日時（takenAt）

- Client は EXIF の `DateTimeOriginal`（なければ `CreateDate`）を読みます。offset は `OffsetTimeOriginal`（`CreateDate` には `OffsetTime`）があるときだけ付けます
- offset が無い日時は、offset を補わずにそのまま保存します（例: `2024-05-01T10:20:30`）。Browser の timezone も付けません。撮影地の時刻として書かれた値を、別の timezone の値に変えないためです
- timeline の並び順（`sort_at`）だけは、offset の無い日時を UTC とみなして計算します。そのため、日本時間で動く offset を書かないカメラの写真は、同じ瞬間に offset 付きで撮った写真より 9 時間新しいものとして並びます
- EXIF は original に残っているため、将来 GPS や端末の設定から offset を推定する場合も、保存済みの original から計算し直せます
- `takenAt` は backup / restore でも文字列のまま保持されます

### thumbnail

- JPEG
- 長辺 512px 以下
- upscale しない
- EXIF / GPS を含めない
- timeline / grid 用

### preview

- JPEG
- 長辺 2048px 以下
- upscale しない
- EXIF / GPS を含めない
- detail / share 用

JPEG quality は実機測定で調整できる tuning parameter とします。

### derivative の作り直し（repair）

original が無事で thumbnail / preview だけが欠けた写真は、original に触れずに作り直せます（[D-026](decisions.md)）。

```text
1. POST /api/v1/assets/{assetId}/derivatives/repair
2. Worker checks the asset is ready and the original is the one finalize verified
3. Worker validates any derivative object found at its key (never deleting one)
4. Worker returns a short-lived GET for the original + conditional PUTs for the keys that need one
5. Client downloads the original, checks its SHA-256, renders the missing derivatives
6. Client PUTs them, then calls the same endpoint again
7. status: 'ok' when both derivatives are present and pass the checks
```

この endpoint は state を持たず、冪等です。呼び出しが「何が足りないか」と「作り直したものが妥当か」を兼ねます。そのため、再送・応答の消失・tab を閉じた・同時実行は、すべてもう一度呼べば収束します。

`status: 'ok'` だけが完了です。PUT の成功は完了を意味しません。

derivative の生成は upload と同じ Browser の pipeline（`renderDerivatives`）です。長辺・quality・metadata の除去は upload と同一で、Worker は画像を decode しません。検査も finalize と同じで（[D-012](decisions.md)）、これに size 上限を足します。

不変条件:

- original は読むだけ。repair が署名するのは derivative key の PUT と original の GET だけ
- object key は asset ID から Server が決める。client から key を受け取らない
- object を 1 つも削除しない。使えない derivative は削除せず置き換える
- PUT は必ず条件付き。key が空なら `If-None-Match: *`、使えない object があるなら検査時点の ETag への `If-Match`。妥当な derivative は上書きできず、古い target は 412 になる
- D1 へ書かない。asset ID・album・favorite・trash・createdAt / takenAt は変わらない
- 失敗しても「original は無事、derivative は直っていない」より悪くならない。新しい repair の結果を古い repair が取り消すこともない

## 7. 共有の仕組み

共有リンクは次の形式を採用します。

```text
/share/{shareId}#{secret}
```

`secret` は URL fragment に置き、最初の HTTP request には含めません。Browser は fragment を読み、share API へ Authorization header として送ります。

D1 には secret の hash のみ保存します。

共有 API は各 request で次を検証します。

- secret hash
- share の存在
- expires_at
- revoked_at
- album の存在
- asset がその album に所属すること
- asset が ready かつ非削除であること
- variant が thumbnail / preview であること

share session / share Cookie は v1 では作りません。

検証に失敗した場合は、理由を区別せず一律に `404 SHARE_UNAVAILABLE` を返します。share ID の存在確認に使われることを防ぐためです。

share から発行する URL の期限は 300 秒以下で、share の残り期限も超えません。album を削除すると、その album の share は revoke されます。

## 8. 削除と復元

- `trash` は論理削除です。timeline・album・share から見えなくなりますが、original は残ります
- `restore` で元に戻せます。album 所属も復帰します
- 完全削除は trash 内の asset に対してのみ実行できます。`purging` に遷移して全画面から隠したあと、R2 object を削除し、最後に D1 row を削除します。途中で失敗した場合も、同じ `DELETE` を再実行すれば再開できます
- 止まった削除の asset ID は `GET /api/v1/diagnostics` の `purgingAssetIds`（古い順に最大 100 件）で分かります。ライブラリ画面の「削除を再開」がそれぞれに `DELETE` を送ります。同じ写真を upload し直した場合も、reserve / finalize が削除を完了させます（[D-014](decisions.md)）
- 完全削除は、asset が `ready` かつ trash 内である場合だけ `purging` にします。別の tab からの復元が間に入った場合は `409 ASSET_NOT_TRASHED` で、何も削除しません

削除するのはこの asset を作った upload 行だけです。この asset の重複として決着した upload 行は、`duplicate_of` を `NULL` にして残します。

その行は「自分が予約した key はどの asset のものでもない」という唯一の記録です。best-effort だった object 削除が届いていなければ、storage cleanup がこの行から後始末します（[D-027](decisions.md)）。

## 9. Export と restore

export は 3 つの paged endpoint（`/api/v1/export/assets`・`/albums`・`/album-assets`）です。

Client は `src/contracts/export-manifest.ts` で manifest に組み立てます。asset metadata・album 構成・object manifest・期待 SHA-256 を持つ format 1 の manifest です。1 response にまとめないのは、10 万枚で Worker の memory 上限に近づくためです（[D-024](decisions.md)）。

original 本体を含む backup（差分）、backup ディレクトリの検査、空環境への restore（再開可能）、整合性検証は、`pnpm backup` CLI が公開 API 経由で行います（[D-015](decisions.md)、[D-024](decisions.md)）。

### backup manifest v2

`manifest.json`（backup ディレクトリ）と、ライブラリ画面からダウンロードする JSON は同じ contract です。shape は `ExportManifestSchema`（`src/contracts/schemas.ts`）、整合性の規則は `manifestIntegrityIssues`（`src/contracts/export-manifest.ts`）が定義します（[D-025](decisions.md)）。

```jsonc
{
  "format": "edgephotos-export",
  "formatVersion": 2,
  "exportedAt": "2026-09-18T04:05:06.789Z",
  "assets": [ /* ... */ ],
  "albums": [ /* ... */ ]
}
```

`assets[]`（`trashed` を含む `ready` の写真のみ。`pending` / `purging` は出ません）:

| field | 型 | null | 意味 |
| --- | --- | --- | --- |
| `id` | UUID v4 の書式 | | export 元での asset ID。restore 先では別の ID になります |
| `sha256` | 小文字 hex 64 桁 | | original の SHA-256。写真の同一性はこれだけで決まります |
| `originalSize` | 整数 1〜100 MiB | | original の byte 数 |
| `contentType` | `image/jpeg` \| `image/png` \| `image/webp` | | original の形式 |
| `filename` | 1〜255 文字 | ✓ | upload 時のファイル名。object key には使いません |
| `width` / `height` | 正の整数 | ✓ | pixel |
| `takenAt` | ISO 8601 date-time（offset 任意） | ✓ | EXIF の撮影日時。**instant ではなく壁時計**で、offset の無い値をそのまま保ちます |
| `isFavorite` | boolean | | |
| `trashedAt` | instant | ✓ | 非 null なら trash 内。restore 先でも trash に入ります |
| `createdAt` | instant | | ライブラリに入った時刻。restore が送り直すので保たれます |
| `objects` | `{ original, thumbnail, preview }` | | export 時点の R2 key。R2 の生 dump から手で戻すための記述で、CLI は読みません |

`albums[]` の field は 4 つです。`id`（UUID v4 の書式）、`title`（1〜200 文字、保存されている綴りのまま = 前後の空白なし）、`createdAt`（instant）、`assetIds`（この manifest の `assets` にある ID。順序に意味はありません）。

instant は `new Date().toISOString()` がそのまま入ります（UTC・ミリ秒・`Z`）。`verify` は文字列として比較するので、同じ時刻の別の綴り（`+00:00`、ミリ秒なし）は v1 では不正です。

綴りに加えて、実在する日時であることも確かめます。`2024-02-30T00:00:00.000Z` は綴りだけなら通りますが、3 月 1 日に繰り上がるため拒否します。

shape とは別に、次を満たさない manifest は拒否します。

- `id` の重複、`sha256` の重複（1 つの original に 2 つの asset）、album `id` の重複
- 1 つの album が同じ写真を 2 回挙げること
- `assets` に無い写真への membership

versioning:

- reader は知らない `formatVersion` を部分的に読まずに拒否します
- reader は知らない key を無視します。したがって既存の version に足してよいのは、**その field を完全に無視する reader でも、data・意味・検証結果を失わずに restore できる optional field だけ**です。10 年後に古い CLI がこの backup を読む可能性を前提にします
- 上の条件を満たさない追加、および既存 field の意味・書式・必須性の変更では `formatVersion` を上げます
- 現在の reader は v1 と v2 を読みます。新規 export は v2 です。version ごとの契約の違いは、v2 が HEIC / HEIF の original を持てることだけです（[D-030](decisions.md)）
- 未公開の旧形式への fallback は持ちません

paged export は、ライブラリが変化しうる間に 1 ページずつ読みます。asset ページに無い写真への membership は組み立て時に落とすので、manifest が知らない写真を指すことはありません。

落として直せないのは、1 つの original が 2 つの asset として現れる場合です。ページとページの間に完全削除と再 upload が起きたときに生じます。写真の同一性は SHA-256 だけで決まるため、この manifest を restore すると 2 件が黙って 1 件に潰れます。

`collectExportManifest` はこれを返さずに拒否します。ライブラリは無傷で、何も書かれていないので、export をやり直せば正しい manifest が得られます（[D-027](decisions.md)）。したがって Web のダウンロードも CLI も、`check` / `restore` / `verify` が拒否する manifest を手にすることはありません。

`pnpm backup` の `check` / `restore` / `verify` はすべて `readManifest` を通ります。JSON として壊れている、contract に合わない、整合しない manifest は、対象ライブラリへ最初の request を送る前に、どの field がなぜ不正かを並べて拒否します。

restore の再開に使う `restore-state.json` も同様に検証します（こちらは backup の contract ではなく実行状態のファイルです）。

## 10. D1 / R2 の突合

`GET /api/v1/storage/audit` は、asset ID の範囲ごとに R2 の list と D1 の `assets` / `uploads` を突き合わせる読み取り専用の API です。

返すもの: original・derivative の欠落、size の違い、（`deep`）R2 が記録した SHA-256 との違い、止まった削除、中断した upload、重複の残り、どの行も指さない object、layout 外の key。何も修復しません。

書き込みは 2 つに限ります。`POST /api/v1/storage/cleanup` は中断した upload とその object だけを扱います（[D-023](decisions.md)）。`POST /api/v1/assets/{assetId}/derivatives/repair` は欠けた derivative だけを作り直します（[保存する画像の契約](#6-保存する画像の契約)、[D-026](decisions.md)）。どちらも original を削除・変更しません。

`missing_original` などの破損は自動では直さず、backup から戻します（[監視と点検](operations.md#12-監視と点検)）。

## 11. Access の経路分け

同一 Worker の private area と public share area を分けます。

```text
/*       Access required
/share/* Access Bypass + Hono share authorization
```

Bypass 対象は `/share/*` に限定し、公開部分の認可責任は Worker が持ちます。

Workers Static Assets 利用時の `ctx.access` だけには依存せず、Access assertion を Worker 側で検証します。

静的 JS / CSS は `/share/assets/*` に出力し、共有ページも読み込めるようにします（[D-011](decisions.md)）。Worker は `/api/*`、`/share/*`（`/share/assets/*` を除く）を static assets より先に処理します。

## 12. Native client への拡張境界

v1 では Web と API の間に client-specific BFF を置きません。

```text
Preact Web -----+
                +---- HTTP/JSON API ---- Hono
Future Native --+
```

将来、Client ごとに具体的な集約・性能要求が生じた場合だけ、adapter / BFF の追加を判断します。

Native 対応のために現在保証すること:

- API が Web component 構造に依存しない
- API error が機械可読
- 認証後 identity が `AppPrincipal` に正規化される
- upload protocol が Browser API 固有ではない
- OpenAPI を外部 Client 実装の契約として利用できる

## 参考資料

- Cloudflare Vite Plugin: https://developers.cloudflare.com/workers/vite-plugin/
- Workers Static Assets: https://developers.cloudflare.com/workers/static-assets/
- Access application paths: https://developers.cloudflare.com/cloudflare-one/access-controls/policies/app-paths/
- Workers + Access: https://developers.cloudflare.com/workers/configuration/cloudflare-access/
- Managed OAuth: https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/
- R2 presigned URLs: https://developers.cloudflare.com/r2/api/s3/presigned-urls/
- Hono Zod OpenAPI: https://hono.dev/examples/zod-openapi
