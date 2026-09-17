# アーキテクチャ

この文書は、EdgePhotos v1 で採用するシステム構造、責務分担、外部との境界を定義します。技術選定の理由や却下した案は [設計判断](decisions.md) を参照してください。

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

将来 Native client を追加する場合も、「Client が前処理し、Server が保存契約と認可を検証する」という境界を維持します。

### Worker / Hono

Worker は control plane を担当します。

- Access assertion の検証
- `AppPrincipal` への正規化
- owner authorization
- API request validation
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

写真 binary、R2 credential、Access token、share secret 平文は保存しません。正確な schema は migration を正本とし、`src/worker/db/schema.ts`（Drizzle）はそれと一致することを test で確認した型・query 用の定義です（[D-017](decisions.md)）。

### private R2

R2 は binary data を保持します。

```text
originals/{assetId}
derivatives/v1/{assetId}/thumbnail.jpg
derivatives/v1/{assetId}/preview.jpg
```

original と再生成可能な derivative を物理的にも分離します。

## 3. Identity boundary

Web と将来 Native で認証の入口が変わっても、application logic へ渡す identity は統一します。

Cloudflare Access 固有の token・assertion・Cookie は HTTP 層で検証します。検証した identity は、application-level の `AppPrincipal` に正規化します。application logic は `AppPrincipal` だけを受け取り、Access の具体的な claim structure に依存しません。こうすることで、認証の入口の変更を application logic から分離できます。

`AppPrincipal` のフィールドは [`src/worker/auth/access.ts`](../src/worker/auth/access.ts) の型定義を正本とします。

v1 は 1 owner です。Access を通過した全ユーザーを owner とみなさず、設定された owner identity と一致する principal だけが private API を利用できます。

将来 Native client を追加する場合は Cloudflare Access Managed OAuth を第一選択とし、application service が Native 固有 token を直接解釈しない構造を維持します。

## 4. API boundary

API は Web の画面構造ではなく、写真ライブラリの操作を表現します。

```text
/api/v1/*        private application API
/share/api/v1/*  public share capability API
```

HTTP/JSON を使用し、request / response / error schema は `@hono/zod-openapi` の route schema を正本とします。そこから runtime validation と OpenAPI を生成します。

Web も将来の Native client も、同じ application API の consumer とします。

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
GET    /api/v1/assets/{assetId}/original        short-lived URL (owner only)
POST   /api/v1/assets/{assetId}/trash | /restore
DELETE /api/v1/assets/{assetId}                 permanent delete (trashed only, resumable)
GET    /api/v1/albums                  POST /api/v1/albums
GET|PATCH|DELETE /api/v1/albums/{albumId}
GET    /api/v1/albums/{albumId}/assets
PUT|DELETE /api/v1/albums/{albumId}/assets/{assetId}   idempotent
GET|POST /api/v1/albums/{albumId}/shares
POST   /api/v1/shares/{shareId}/revoke | /regenerate
GET    /api/v1/export                           metadata manifest
GET    /api/v1/diagnostics                      non-sensitive counts, unfinished purge ids
GET    /share/api/v1/shares/{shareId}           Authorization: Bearer <secret>
GET    /share/api/v1/shares/{shareId}/assets/{assetId}/{thumbnail|preview}
```

画像 URL は短命な presigned GET を JSON で返します。Worker が画像 byte を中継することはありません。一覧（`GET /api/v1/assets`、album の assets）は thumbnail の URL だけを返し、preview の URL は個別の asset（`GET /api/v1/assets/{assetId}` など）で返します（[D-022](decisions.md)）。

## 5. Upload protocol

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

- 3 object の存在（欠けていれば `409 UPLOAD_OBJECT_MISSING`、upload は `pending` のまま再試行可能）
- original について、R2 が記録した SHA-256（binding の `head().checksums.sha256`）が reserve 時の申告と一致（記録がなければ `checksum_missing`、不一致なら `checksum_mismatch`。どちらも `422 UPLOAD_OBJECT_INVALID`）。[D-018](decisions.md)
- size が reserve 時の申告と一致
- original の magic bytes が申告 content type と一致
- thumbnail / preview が EXIF / XMP / IPTC segment を含まない JPEG（違反は `422 UPLOAD_OBJECT_INVALID`）

D1 への asset 作成と upload 状態更新は 1 つの D1 batch（transaction）で行います。asset ID は reserve 時に確定しているため、再送や同時実行でも同じ asset へ収束します。同じ SHA-256 の asset が既にあれば `result: "duplicate"` として既存 asset を返します（[D-014](decisions.md)）。ただし完全削除が途中で止まった asset（`purging`）は重複とみなさず、reserve と finalize がその削除を完了させてから進みます。

presigned PUT は `Content-Type` と `If-None-Match: *` を署名し、保存済み object の上書きを R2 側で拒否させます（[D-013](decisions.md)）。original の PUT は、さらに申告 SHA-256 を `x-amz-checksum-sha256`（raw digest の base64）として署名します。R2 は body の digest が一致しない PUT を拒否し、object を作りません。Client はこの header を省略も変更もできません（[D-018](decisions.md)）。

Client は一時的な PUT の失敗（network error、408、429、5xx）を backoff 付きで再試行し、`412` は保存済みとして扱います。`If-None-Match: *` と reserve ごとに固有の key により、`412` になるのは同じ upload の以前の試行が届いていた場合だけです。いずれにしても finalize が size と checksum を確認します（[D-020](decisions.md)）。

digest 不一致の PUT は R2 が `400` で拒否します。original が存在しないため finalize は `409 UPLOAD_OBJECT_MISSING` を返し、upload は `pending` のままです。URL の期限内なら、正しい bytes を同じ URL へ PUT し直して finalize を再試行できます。

finalize は upload の期限を見ません。期限内に PUT が済んでいれば、background に回した tab が期限後に復帰しても finalize できます。PUT が済んでいない upload は、presigned URL が失効しているため完了できず、`pending` のまま残ります（[roadmap.md](roadmap.md) の既知の制約）。

不変条件:

- original は byte-for-byte immutable
- 保存済み original を上書きしない
- R2 確認前に `ready` にしない
- finalize 再送で同じ asset へ収束する
- D1 障害時に R2 object を即削除しない
- D1 と R2 を 1 transaction として扱わない

## 6. Derivative contract

### original

- 元 byte 列をそのまま保持
- 再エンコードしない
- EXIF / GPS を改変しない
- SHA-256 を metadata として保持（D-018 以降に finalize された asset では R2 が upload 時に検証した値。それより前の asset は申告値で、`pnpm backup verify` で照合する。[D-018](decisions.md)）
- owner のみ取得可能
- share では配信しない

Browser の JPEG encoder が付ける APP1 / APP13（WebKit は Exif の色空間・画素数と空の IPTC を書き出す）は、Client が PUT 前に取り除きます。finalize は引き続き APP1 / APP13 を含む derivative を拒否します（[D-020](decisions.md)）。

original の形式は JPEG / PNG / WebP です。HEIC / HEIF は Client が明示的に拒否します。iPhone の通常経路では、Safari の写真ピッカーが HEIC を JPEG に変換して渡す、現在報告されている挙動に任せます。この挙動は Web 標準の保証ではありません。HEIC がそのまま渡された場合は、明示的なエラーになります（[D-019](decisions.md)）。

Web 版が保存する original は「Browser から受け取った byte 列」です。iOS が選択時に JPEG へ変換した場合、カメラロールの HEIC そのものは保存されません。

### 撮影日時（takenAt）

- Client は EXIF の `DateTimeOriginal`（なければ `CreateDate`）を読みます。offset は `OffsetTimeOriginal`（`CreateDate` には `OffsetTime`）があるときだけ付けます
- offset が無い日時は、offset を補わずにそのまま保存します（例: `2024-05-01T10:20:30`）。Browser の timezone も付けません。撮影地の時刻として書かれた値を、別の timezone の値に変えないためです
- timeline の並び順（`sort_at`）だけは、offset の無い日時を UTC とみなして計算します。そのため、日本時間で動く offset を書かないカメラの写真は、同じ瞬間に offset 付きで撮った写真より 9 時間新しいものとして並びます
- EXIF は original に残っているため、将来 GPS や端末の設定から offset を推定する場合も、保存済みの original から計算し直せます。`takenAt` は backup / restore でも文字列のまま保持されます

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

## 7. Share architecture

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

検証に失敗した場合は、理由を区別せず一律に `404 SHARE_UNAVAILABLE` を返します。share ID の存在確認に使われることを防ぐためです。share から発行する URL の期限は 300 秒以下で、share の残り期限も超えません。album を削除すると、その album の share は revoke されます。

## 7.1 削除と復元

- `trash` は論理削除です。timeline・album・share から見えなくなりますが、original は残ります。
- `restore` で元に戻せます。album 所属も復帰します。
- 完全削除は trash 内の asset に対してのみ実行できます。`purging` に遷移して全画面から隠したあと、R2 object を削除し、最後に D1 row を削除します。途中で失敗した場合も、同じ `DELETE` を再実行すれば再開できます。
- 止まった削除の asset ID は `GET /api/v1/diagnostics` の `purgingAssetIds`（古い順に最大 100 件）で分かります。ライブラリ画面の「削除を再開」がそれぞれに `DELETE` を送ります。同じ写真を upload し直した場合も、reserve / finalize が削除を完了させます（[D-014](decisions.md)）。

## 7.2 Export / Restore

`GET /api/v1/export` は asset metadata・album 構成・object manifest・期待 SHA-256 を返します。original 本体を含む backup と空環境への restore・整合性検証は `pnpm backup` CLI が公開 API 経由で行います（[D-015](decisions.md)）。

## 8. Access routing

同一 Worker の private area と public share area を分けます。

```text
/*       Access required
/share/* Access Bypass + Hono share authorization
```

Bypass 対象は `/share/*` に限定し、公開部分の認可責任は Worker が持ちます。

Workers Static Assets 利用時の `ctx.access` だけには依存せず、Access assertion を Worker 側で検証します。

静的 JS / CSS は `/share/assets/*` に出力し、共有ページも読み込めるようにします（[D-011](decisions.md)）。Worker は `/api/*`、`/share/*`（`/share/assets/*` を除く）を static assets より先に処理します。

## 9. Native client への拡張境界

v1 では Web と API の間に client-specific BFF を置きません。

```text
Preact Web -----+
                +---- HTTP/JSON API ---- Hono
Future Native --+
```

将来、Client ごとに具体的な集約・性能要求が生じた場合だけ adapter / BFF の追加を判断します。

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
