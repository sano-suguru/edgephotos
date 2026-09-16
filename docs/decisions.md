# 設計判断

この文書は、後から「なぜこの構成を選んだのか」を確認するための軽量な Decision Log です。

現在の構造そのものは [architecture.md](architecture.md)、開発時のルールは [development.md](development.md) と [AGENTS.md](../AGENTS.md) を正本とします。

## D-001: v1 は機能を絞り、主要な境界は暫定化しない

**状態:** 採用

初期版では機能数を限定します。一方、データ保全、認証、API、storage boundary を「後で本方式へ置き換えるための仮実装」にはしません。

実需要や測定結果に基づく architecture evolution は許容します。

## D-002: Web stack は Preact + Signals + Vite を採用する

**状態:** 採用

Web UI は Preact、client state は `@preact/signals`、build は Vite + Cloudflare Vite Plugin を使用します。Styling は Tailwind CSS v4、UI primitives は shadcn/ui + Base UI を採用します。

UI primitives は feature 実装前に Preact production build、keyboard、focus、touch を確認し、不成立の場合は feature code を積む前に再選定します。

## D-003: Cloudflare-native の 1 Worker 構成とする

**状態:** 採用

Worker、Static Assets、D1、private R2 を Cloudflare 上で構成し、private app と public share を別 Worker へ分けません。

デプロイ単位を増やす具体的な運用上の理由が出るまでは、1 Worker を維持します。

## D-004: API は Client-independent な HTTP/JSON + OpenAPI とする

**状態:** 採用

Worker API は Hono を使用し、`@hono/zod-openapi` の route schema を runtime validation と OpenAPI の正本とします。

Web UI の component tree や route 構造を API に露出させません。Hono RPC は外部 API の唯一の契約にせず、将来の Native client も同じ application API を利用できる構造にします。

## D-005: Cloudflare Access を認証入口とし、AppPrincipal へ正規化する

**状態:** 採用

Web 認証は Cloudflare Access を使用します。Access 固有 assertion は HTTP 層で検証し、application logic へは正規化した principal を渡します。

将来 Native client を追加する場合は Cloudflare Access Managed OAuth を第一選択とし、独自 auth server は初期構成へ導入しません。

## D-006: private R2 へ Client から直接転送し、original は immutable とする

**状態:** 採用

R2 bucket は public にしません。写真 binary は通常 Worker を経由させず、短命な presigned URL で Client と R2 の間を直接転送します。

Upload は `reserve -> PUT -> finalize` とし、original は byte-for-byte immutable に保持します。再生成可能な derivative は original と分離します。

## D-007: Public share は capability-based link とする

**状態:** 採用

共有リンクは次の形式を使用します。

```text
/share/{shareId}#{secret}
```

share secret は URL fragment に置き、D1 には hash のみ保存します。share API は request ごとに capability を検証し、original は共有しません。

## D-008: D1 は explicit SQL + migration で扱う

**状態:** [D-017](#d-017-drizzle-を-d1-の-schema型migration-生成に薄く使う) で更新

v1 の D1 access は prepared SQL と明示的な migration を使用します。現時点の data model 規模では ORM を必須にしません。

schema の正本は migration とし、ORM 導入の具体的な価値が生じた場合だけ再検討します。

## D-009: Client-specific BFF と background infrastructure を先回りして置かない

**状態:** 採用

v1 では別 Web BFF / Mobile BFF、Queues、Durable Objects、Cron、multi-cloud provider abstraction、monorepo 等を前提にしません。

現在の要求や実測から必要性が示された場合に追加判断します。

## D-010: アプリ本体は interactive SPA とし、SSR framework を採用しない

**状態:** 採用

EdgePhotos の主要画面は高い対話性を持つため、アプリ本体は Preact SPA + HTTP API とします。

SSR、RSC、Server Actions を中心要件にせず、vinext や Astro をアプリ本体へ導入しません。将来 landing page / docs site を別途作る場合の技術選定は、この判断とは分離します。

## D-011: build 済み静的ファイルは `/share/assets/*` に配置する

**状態:** 採用

共有ページは Access Bypass された `/share/*` 上で動くため、読み込む JS / CSS も Access 外に置く必要があります。Bypass を `/share/*` に限定したまま成立させるため、Vite の client build 出力先を `share/assets/` にしました。

これにより private app の JS bundle も認証なしで取得できます。bundle は公開ソースと同じコードで secret や写真データを含まないため許容します。一方 `index.html` と SPA 経路、`/api/*` は Access の保護下に残します。共有ページ本体（`/share/{shareId}`）は Worker が返し、share 用 header と CSP を必ず付与します。

## D-012: finalize の保存確認は「存在・サイズ・形式・派生画像 metadata」とする

**状態:** 採用（SHA-256 の扱いは [D-018](#d-018-original-の-sha-256-を-r2-に-upload-時に検証させる) で更新）

finalize では Worker が R2 binding で次を確認してから asset を `ready` にします。

- reserve した 3 object がすべて存在する
- 各 object の size が reserve 時の申告値と一致する
- original の先頭 byte が申告 content type（JPEG / PNG / WebP）と一致する
- thumbnail / preview が JPEG で、APP1（EXIF / XMP）・APP13（IPTC）segment を含まない

original の SHA-256 は Client が reserve 時に申告し、重複判定の索引として使います。Worker は finalize 時に original 全体を hash しません。Workers の CPU 上限内で大きな original を毎回 hash するのは現実的でないためです。保存済み original の SHA-256 は backup / restore / verify（`pnpm backup`）で R2 から再取得して検証します。

したがって `assets.sha256` は **client-asserted content identity** です。server が byte 列から計算し直した verified identity ではありません。v1 は 1 owner で、脅威は「owner が自分自身に嘘をつく」ことになるため、この区別を許容します。将来 multi-user や untrusted client を扱う場合は、この前提が崩れるため再検討が必要です。

## D-013: presigned PUT は `If-None-Match: *` と `Content-Type` を署名対象にする

**状態:** 採用（original は [D-018](#d-018-original-の-sha-256-を-r2-に-upload-時に検証させる) の checksum header も署名する）

object key は reserve ごとに新しい asset ID から作るため、別 asset の上書き経路はありません。加えて、有効期限内の PUT URL が finalize 後に再利用されて original が差し替わることを防ぐため、`If-None-Match: *` を署名 header に含めます。R2 の S3 API は PutObject の conditional header をサポートします。

Browser はこの 2 header を送るため、R2 CORS の AllowedHeaders に `content-type` と `if-none-match` が必要です。

## D-014: original の SHA-256 ごとに asset は 1 つとする

**状態:** 採用

`assets.sha256` は UNIQUE です（値の出所は client 申告であり、上記 [D-012](#d-012-finalize-の保存確認は存在サイズ形式派生画像-metadataとする) の区別が前提です）。reserve 時に同じ original が存在すれば `409 DUPLICATE_ASSET` を返します。reserve 後の競合で finalize 時に重複が判明した場合は、既存 asset を返し、その upload 専用の object を D1 記録後に削除します。ゴミ箱内の asset も重複として扱います。

## D-015: restore は公開 HTTP API 経由の再 upload とする

**状態:** 採用

特権的な import endpoint は作りません。backup CLI は export manifest と original / derivative を取得し、restore では空の環境へ通常の `reserve -> PUT -> finalize` で再 upload したうえで、favorite・trash・album 構成を API で再現します。

- asset ID は変わる。同一性は original の SHA-256 で判定する
- `createdAt` は restore 時刻になる。`takenAt` は保持する
- share は復元しない（operations.md の方針どおり）
- 対象 library が空でなければ restore を拒否する

Native client と同じ API 境界だけで backup / restore が成立することを優先しました。

## D-016: ローカル開発では Access と presigned URL を dev server 内で模擬する

**状態:** 採用

Miniflare の R2 には S3 endpoint がなく、ローカルに Access もありません。`vite dev` の間だけ次を有効にします。

- dev server が起動ごとに RS256 鍵を生成し、`Cf-Access-Jwt-Assertion` を付与する。Worker は本番と同じ検証コード（署名・issuer・audience・期限・owner）で検証する
- Worker が HMAC 署名付きの短命 URL（`/__local/blobs/*`）を発行し、local R2 binding へ読み書きする

どちらも `import.meta.env.DEV` の分岐と dynamic import に閉じ込めます。production build からは除去され、除去されていることを build 出力で確認します。test では同じ部品を明示的に注入します。

## D-017: Drizzle を D1 の schema・型・migration 生成に薄く使う

**状態:** 採用（D-008 を更新）

D1 の schema を `src/worker/db/schema.ts` に TypeScript で定義し、Drizzle ORM / Drizzle Kit を次の用途に限って使います。

- DB row / insert 型を schema から導出する（`$inferSelect` / `$inferInsert`）。手書きの row 型を持たない
- 単純な CRUD（1 table の select / insert / update / delete、単純な JOIN）は query builder で書く
- migration SQL を `drizzle-kit generate` で生成する

SQL の隠蔽は目的にしません。

- 相関 subquery、動的 filter、keyset pagination、集計などは、SQL の方が読みやすければ `sql` テンプレートで明示的な SQL のまま書く。値は bind parameter になる
- Repository / DAO / Active Record / relational query API（`drizzle(d1, { schema })`）は導入しない。service 関数から直接 `ctx.db` を使う
- schema の property 名は column 名（snake_case）と同じにし、ORM 側の値変換（`mode: 'boolean'` など）を使わない。明示的な SQL の結果（`SELECT a.* ...`）と `$inferSelect` を同じ型として扱えるようにするため
- API DTO / zod schema と DB row 型は統合しない。row から DTO への変換は service に置く

Migration:

- 適用される正本は、review して commit した `migrations/*.sql` のまま。適用は従来どおり `wrangler d1 migrations apply`
- 流れは `schema.ts` 変更 → `pnpm db:generate <name>` → 生成 SQL を review（必要なら手で直す）→ `.sql` と `migrations/meta/` を commit
- `drizzle-kit push` と `drizzle-kit migrate` は使わない。`drizzle.config.ts` に D1 credential を置かないため、そもそも実行できない
- `pnpm db:check` が schema と `migrations/meta/` の snapshot のずれを検出する。`tests/integration/migrations.test.ts` が、migration 適用後の D1 と `schema.ts` の一致を検証する

既存 migration の扱い（baseline）:

- `0001_initial.sql` は手書きのまま変更しない。production の `d1_migrations` は file 名で記録されているため、改名や再生成はしない
- `migrations/meta/0001_snapshot.json` は、同じ schema を drizzle-kit で生成したときの snapshot。journal の entry は `idx: 1` / `tag: 0001_initial` とした。drizzle-kit は次の番号を「最後の idx + 1」で決めるため、以後の生成 migration は `0002_*` から始まる。この journal を `idx: 0` へ「直さない」こと
- `0001_initial.sql` と snapshot の差は次の 2 点だけで、どちらも既存データに影響しない
  - SQL 側の TEXT PRIMARY KEY は `NOT NULL` を明示していない（SQLite の歴史的仕様で NULL を受け付ける）。snapshot は `NOT NULL` として扱う。app は常に id を指定する
  - `uploads.asset_id` の UNIQUE は SQL 側では column 制約（無名の autoindex）、snapshot では `uploads_asset_id_unique` という index
- この差が原因で生成 SQL が誤っていれば、CI で検出される。test の setup は本番と同じく空の D1 へ `0001` から順に全 migration を適用し、そのあと drift test が `schema.ts` と比較する。つまり生成 migration は毎回「0001 適用済みの DB に対する rehearsal」を通る
  - この rehearsal が保証するのは DDL として適用できることだけ。table は空なので、既存データの保存（table 作り直し時の列の対応、値の変換、NOT NULL や CHECK の強化）は検証しない。データを変換する migration を初めて書くときは、その migration 用の fixture を追加する
  - 確認済みの例: `asset_id` の `.unique()` を外して生成すると `DROP INDEX uploads_asset_id_unique;` になり、setup が `no such index` で失敗する。table を作り直す migration（`__new_uploads` を作ってコピーし、rename する）に手で直すと通る
- production DB の再作成は不要

`wrangler` と `readD1Migrations` は `.sql` だけを読むため、`migrations/meta/` は適用対象になりません。

## D-018: original の SHA-256 を R2 に upload 時に検証させる

**状態:** 採用（D-012 の「client-asserted content identity」を更新）

D-012 では `assets.sha256` は client の申告値で、R2 上の byte 列と一致する保証がありませんでした。重複判定・backup・restore はこの値を content identity として使うため、storage 側で一致を保証します。

- reserve は original の presigned PUT に `x-amz-checksum-sha256: base64(申告 SHA-256 の raw digest)` を署名 header として含める（SigV4 の `X-Amz-SignedHeaders` に入る）。Client が header を省略・変更すると署名が合わない
- R2 は PUT body の SHA-256 がこの値と一致しなければ PUT を `400 BadDigest` で拒否し、object を作らない（S3 PutObject の checksum。R2 は 2023-06-16 の release note で S3 PutObject の sha256 checksum に対応。remote-test で実測済み。operations.md 冒頭）
- finalize は R2 binding の `head()` が返す `checksums.sha256` を申告値と比較する。R2 は put 時に指定された checksum を object に記録し、S3 API で PUT した object でも binding から読める（remote-test で実測済み）。記録がない・値が違う original は `422 UPLOAD_OBJECT_INVALID`（`checksum_missing` / `checksum_mismatch`）とし、`ready` にしない。何らかの経路で checksum 検証を経ずに置かれた object に対しても fail-closed になる
- Worker は original を download も hash もしない。確認は HEAD 1 回で済む
- thumbnail / preview は再生成可能な derivative で、content identity に使わないため checksum を付けない

却下した案:

- finalize で Worker が original 全体を読んで hash する: 最大 100MB を毎回読むのは CPU・時間の面で避けたい。R2 が同じ検証を upload 時に行える
- `Content-MD5` を使う: R2 は対応するが、MD5 では SHA-256 との一致を保証できない
- 期待 SHA-256 を `X-Amz-Content-Sha256` に入れる: presigned URL では payload hash を `UNSIGNED-PAYLOAD` として扱うのが S3 の規約で、payload 検証を当てにできない

影響:

- Browser は `x-amz-checksum-sha256` を送るため、R2 CORS の AllowedHeaders に追加が必要（operations.md §6）
- この変更以前に reserve した upload の PUT URL は checksum を含まない。そのまま finalize すると `checksum_missing` になるため、再 upload が必要（URL の期限は 600 秒）
- この変更以前に `ready` になった asset の `sha256` は申告値のまま。`pnpm backup verify` が R2 から読み直して照合する
- local 開発と test では、local blob route が同じ header を検証し、R2 binding の `put(..., { sha256 })` で digest を検証する（Miniflare も不一致を拒否し、`head().checksums.sha256` を返す）

## D-019: v1 は HEIC / HEIF を受け付けず、iPhone は Safari の JPEG 変換に任せる

**状態:** 採用

v1 の original は JPEG / PNG / WebP のままとします。HEIC / HEIF は Client が明示的に拒否し、「HEIC は未対応です（JPEG で書き出してから選んでください）」と表示します。拡張子（`.heic` / `.heif` / `.hif`）でも判定します。desktop Browser は type を空で渡すことがあるためです。

前提になる事実（2026-09 時点）:

- iPhone の Safari では、`<input type=file>` の `accept` が HEIC を含まない場合、写真ピッカーの既定（「自動」）が HEIC を JPEG に変換して渡す（Apple Developer Forums の報告。実機では未確認）。これは Safari / iOS の実装上の挙動で、Web 標準の保証ではない。`accept` も選択候補の hint にすぎない。EdgePhotos が前提にするのは「HEIC が届いたら明示的なエラーにする」経路だけで、変換は利用しているだけである。変換の挙動が将来変わっても、黙って壊れることはなく、エラーとして表に出るEdgePhotos の `accept` は `image/jpeg,image/png,image/webp` なので、iPhone の通常操作では JPEG が届く。`accept` に `image/heic` を足すと、Safari 17 以降は HEIC のまま渡し、JPEG まで HEIC へ変換することがある（同フォーラムの報告）。そのため `image/heic` は足さない
- 変換後の JPEG は ImageIO が書き出すと推定している（iOS 上では未確認）。macOS の `sips`（同じ ImageIO）で iPhone の HEIC を変換すると、`DateTimeOriginal`・`OffsetTimeOriginal`・MakerNote は残った。EdgePhotos での取り込み結果も正しかった（width / height / takenAt）
- 手元の WebKit（Playwright WebKit 26.5）は `createImageBitmap` で HEIC を decode できる。Chromium はできない（`InvalidStateError`）
- Cloudflare Images は HEIC を入力にでき、Worker から binding で呼べる（入力は 20MB まで、変換は月 5,000 件まで無料、以降は 1,000 件あたり $0.50）

比較した案:

| 案 | 依存・bundle | memory | original の保持 | iPhone / Safari の UX | Cloudflare の費用・構成 |
| --- | --- | --- | --- | --- | --- |
| 1. 非対応を明示（採用） | なし | 変化なし | 保存するのは Browser から受け取った byte 列（iPhone では iOS が作った JPEG）。受け取った byte 列は改変しない | 通常操作では意識しない。「現在の形式」を選んだ場合と、Android の HEIF はエラーになり、書き出しが必要 | なし |
| 2. HEIC を original として保存し、derivative だけ別経路で作る | server に content type と magic（`ftyp` box）の追加。Safari なら現行の canvas 経路で derivative を作れる | Safari では JPEG と同程度（decode 後の bitmap が支配的） | カメラの HEIC byte 列をそのまま保てる | `accept` に HEIC を足す必要があり、上記の Safari の変換挙動に巻き込まれる。Chrome / Firefox では derivative を作れず、別経路が必要 | 別経路を 3 か 4 で作るなら、その費用がかかる |
| 3. Browser 側で変換（libheif の WASM など） | WASM 数 MB を bundle へ追加し、更新も追う | WASM heap に加えて decode 後の bitmap。mobile Safari で最も危うい | 変換結果を original にすると元の byte 列を失う。derivative 専用にすれば案 2 と同じ | Safari は native で decode できるので不要。恩恵を受けるのは desktop Chrome / Firefox だけ | なし |
| 4. Server / Cloudflare 側で変換（Images binding） | Worker に Images binding を追加。Worker 内の WASM decode は CPU とメモリの上限から不採用 | Client の負担は小さい | original は HEIC のまま保持できる | 最も透過的 | 1 枚あたり変換 2 回（thumbnail / preview）。finalize の中で呼べば遅延と失敗経路が増え、非同期化すれば Queues が要る（D-009） |

採用理由: personal photo appliance としては、iPhone の通常経路（Safari → JPEG）が追加コードなしで成立します。v1 で解くべき HEIC 固有の問題は「黙って失敗しないこと」だけです。案 2〜4 はどれも upload 形式か derivative 生成の経路を増やし、original の定義（どの byte 列を保存するか）も変わります。

影響と制約:

- iPhone の Safari 経由で保存される original は、iOS が変換した JPEG の byte 列です。カメラが記録した HEIC そのものではありません。「original は byte-for-byte immutable」は「Browser から受け取った byte 列を変えない」という意味で維持されます
- iOS の写真ピッカーの「オプション」で位置情報を外すと、GPS は original にも残りません（EdgePhotos の外の挙動）
- 再検討する条件: Native client を作るとき（OS の decoder で derivative を作りつつ HEIC original を送れる）、または「カメラの HEIC byte 列を残したい」という要求が出たとき。その場合は、まず案 2（Safari / Native に限って HEIC original を受け付ける）を検討する

## D-020: 取り込みの頑健性は Client 側の最小修正で担保する

**状態:** 採用

実機由来の公開サンプル写真と合成 fixture を使い、Chromium と WebKit で取り込みを検証しました（結果は operations.md 冒頭）。見つかった問題は、server の契約を変えずに Client 側で直しています。

- **WebKit の canvas JPEG には APP1 / APP13 が付く。** WebKit の `canvas.toBlob('image/jpeg')` は、APP1（Exif: ColorSpace と PixelX/YDimension）と APP13（空の Photoshop IRB）を書き出す。finalize はこれを `metadata_segment` として拒否するため、Safari からの upload が全件 `422 UPLOAD_OBJECT_INVALID` になっていた。Client が PUT 前に APP1 / APP13 を取り除く（`src/web/lib/jpeg-metadata.ts`）。finalize の検査は緩めない。撮影 metadata がないことは、引き続き server が保証する
- **PUT を再試行する。** 3 回の PUT のどれかが一時的に失敗すると、その写真全体が失敗していた。network error、408、429、5xx は、backoff を挟んで最大 4 回まで試す。`412` は保存済みとして扱う（`src/web/lib/storage-put.ts`）。key は reserve ごとに固有で、`If-None-Match: *` で署名しているため、`412` になるのは同じ upload の以前の試行が R2 に届き、応答だけが失われた場合に限られる。finalize は引き続き size と、original については R2 が検証した SHA-256 を確認する。実 R2 の `412` が CORS 越しに status として読めることは、remote-test で確認済み（operations.md 冒頭）。`400`（BadDigest）と `403`（期限切れ）は再試行しない
- **進行中の upload を一覧から落とさない。** 一覧は `slice(0, 200)` で切っていたため、201 枚目以降が進行中の件数に入らなかった。300 枚を選ぶと、100 件近くを残したまま完了表示になっていた。新しく選んだ項目と進行中の項目は常に残し、古い完了済みの項目だけを削る（`src/web/features/uploads/upload-list.ts`）
- **前処理の並列数は 2 のままにする。** 2 が最適だと示したわけではない。desktop の Browser では、変えるだけの根拠が得られなかった。 1 枚分の peak memory は、ほぼ decode 後の bitmap（幅 × 高さ × 4 byte）で決まる。ArrayBuffer を早く手放す案、canvas を 0×0 にして解放する案は、測定の揺れを超える差が出なかったため入れない。Chromium では並列数を 1 増やすごとに peak が bitmap 1 枚分増え、1 → 2 で時間が約 2 割縮んだ。WebKit では peak も時間もほぼ変わらなかった。bitmap は PUT の前に close されるため、転送中に保持するのは File と小さな derivative だけになる。Web Worker は導入しない。mobile では、1 → 2 の速度差（約 2 割）より peak の増分（48MP で bitmap 約 190MB）の方が重い可能性がある。iPhone の実機で 48MP を数枚続けて取り込み、Safari が落ちる場合は、まず並列数 1 を試す

## D-021: Browser 固有の経路だけを Playwright で自動化する

**状態:** 採用

workerd の test（`pnpm test`）は server の契約を検証しますが、Browser でしか起きない不具合は見えません。D-020 の WebKit の APP1 / APP13 と、期限切れの presigned URL で画像が壊れたまま残る不具合（下記）がその例です。`@playwright/test` を devDependency に加え、少数の spec（`e2e/`）だけを置きます。

- 対象: canvas での derivative 生成と finalize の成立、file input、共有ページ、Base UI の keyboard / focus、phone 幅の layout と tap
- 対象外: server の認可・検査・share の検証。integration test が正本で、Browser では再検査しない
- 実行環境: `vite dev`（D-016 の Access / presigned URL 模擬）を、使い捨ての local D1 / R2（`.wrangler/e2e`）で起動する。remote には触れない
- Browser: Chromium（desktop）と WebKit（iPhone 13 相当）。WebKit は iOS Safari の代わりにはならないが、D-020 の不具合は WebKit で再現した
- `pnpm check` には含めず、CI の別 job で実行する。bundle と Worker には影響しない

**期限切れの presigned URL（同時に修正）:** API が返す画像 URL は 600 秒（共有ページは最大 300 秒）で失効します。timeline は `loading="lazy"` なので、ページを開いたまま 10 分を過ぎてから scroll すると、まだ読み込んでいない thumbnail が `403` で壊れたまま残りました。viewer の preview も同じでした。Client は画像の読み込み失敗時に URL を取り直します。

- timeline / album / 共有ページ: 最初のページの取得から 60 秒以上経っていれば、読み込み済みの範囲を先頭から取り直す（1 分に 1 回まで）
- 取り直しても、表示済みの thumbnail の URL は差し替えない（差し替えると全件を再 download する）。ただし読み込みに失敗した thumbnail は表示済みの扱いから外し、新しい URL にする。一度表示できた画像が、後で再取得されて `403` になる場合があるため
- viewer: 開くたびに asset を取得して preview の URL を得る（[D-022](#d-022-一覧では-thumbnail-の-url-だけを署名する)）。それでも preview が失敗したら 1 回だけ取り直す
- 経過時間は `performance.now()` で測る。端末の時計のずれに左右されず、object が本当に欠けている場合も再取得は上の頻度で止まる
- URL の有効期限（security.md §6）と server の契約は変えない。URL を長くする案は、bearer capability を長く生かすことになるため採らない

## D-022: 一覧では thumbnail の URL だけを署名する

**状態:** 採用（API の一覧 response から `previewUrl` を除く）

一覧 API（`GET /api/v1/assets`、`GET /api/v1/albums/{albumId}/assets`）は、item ごとに thumbnail と preview の 2 つの URL を署名していました。60 件の timeline で 120 回です。preview は viewer を開くまで使いません。署名は Worker の CPU を使い、Workers Free の上限は 1 request 10 ms です（[benchmarks.md](benchmarks.md)）。

- 一覧の item は `AssetSummary`（`Asset` から `previewUrl` を除いた schema）とする
- `previewUrl` は、1 件の asset を返す response（`GET /api/v1/assets/{assetId}`、PATCH、trash / restore、finalize）にだけ含める
- Web の viewer は開いたときに asset を取得する。取得までは cache 済みの thumbnail を表示する。preview の URL は常に開いた時点のものになり、期限切れの心配がない
- backup CLI はもともと個別の asset から preview の URL を得ていたので、影響しない

却下した案: 一覧で preview の URL を返したまま、署名を速くする（署名鍵の cache など）。問題は回数そのもので、使わない URL を発行しないほうが単純です。

影響: 一覧 response の `previewUrl` を使う Client は、個別の asset を取得する必要があります。現時点の Client は Web と backup CLI だけで、どちらも対応済みです。
