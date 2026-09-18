# 設計判断

この文書は、後から「なぜこの構成を選んだのか」を確認するための軽量な Decision Log です。

現在の構造そのものは [architecture.md](architecture.md)、開発時のルールは [development.md](development.md) と [AGENTS.md](../AGENTS.md) を正本とします。

## D-001: v1 は機能を絞り、主要な境界は暫定化しない

**状態:** 採用

初期版では機能数を限定します。一方、データ保全、認証、API、storage boundary を「後で本方式へ置き換えるための仮実装」にはしません。

実需要や測定結果に基づく構成変更は許容します。

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

これらを避けること自体は目的ではありません（2026-09-17 追記）。複雑さには運用・障害・保守のコストがあるため、必要性が観測されてから導入します。現在の構成では解決できない要求・障害・運用負荷・性能問題・測定結果が出た場合は、候補から外さずに評価します。判断の根拠は、現在の構成で足りないもの、導入で具体的に良くなること、増えるコストの 3 つです。

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

`assets.sha256` を client-asserted content identity とする判断は、[D-018](#d-018-original-の-sha-256-を-r2-に-upload-時に検証させる) で置き換えられており、現在の契約ではありません。現在の SHA-256 の契約は D-018 を正本とします。finalize の確認項目と、Worker が original 全体を hash しない方針は現在も有効です。

finalize では Worker が R2 binding で次を確認してから asset を `ready` にします。

- reserve した 3 object がすべて存在する
- 各 object の size が reserve 時の申告値と一致する
- original の先頭 byte が申告 content type（JPEG / PNG / WebP）と一致する
- thumbnail / preview が JPEG で、APP1（EXIF / XMP）・APP13（IPTC）segment を含まない

original の SHA-256 は Client が reserve 時に申告し、重複判定の索引として使います。Worker は finalize 時に original 全体を hash しません。Workers の CPU 上限内で大きな original を毎回 hash するのは現実的でないためです。保存済み original の SHA-256 は backup / restore / verify（`pnpm backup`）で R2 から再取得して検証します。

当時は、`assets.sha256` を **client-asserted content identity** として扱いました。server が byte 列から計算し直した verified identity ではありません。v1 は 1 owner で、脅威は「owner が自分自身に嘘をつく」ことになるため、この区別を許容しました。この前提は D-018 で見直し、R2 が upload 時に申告値との一致を検証するようにしました。

## D-013: presigned PUT は `If-None-Match: *` と `Content-Type` を署名対象にする

**状態:** 採用（original は [D-018](#d-018-original-の-sha-256-を-r2-に-upload-時に検証させる) の checksum header も署名する）

object key は reserve ごとに新しい asset ID から作るため、別 asset の上書き経路はありません。加えて、有効期限内の PUT URL が finalize 後に再利用されて original が差し替わることを防ぐため、`If-None-Match: *` を署名 header に含めます。R2 の S3 API は PutObject の conditional header をサポートします。

Browser はこの 2 header を送るため、R2 CORS の AllowedHeaders に `content-type` と `if-none-match` が必要です。

## D-014: original の SHA-256 ごとに asset は 1 つとする

**状態:** 採用

`assets.sha256` は UNIQUE です。値は client が reserve 時に申告し、D-018 以降の upload では R2 が original の byte 列と照合します（[D-018](#d-018-original-の-sha-256-を-r2-に-upload-時に検証させる)）。reserve 時に同じ original が存在すれば `409 DUPLICATE_ASSET` を返します。reserve 後の競合で finalize 時に重複が判明した場合は、既存 asset を返し、その upload 専用の object を D1 記録後に削除します。ゴミ箱内の asset も重複として扱います。

完全削除が途中で止まった asset（`purging`）は重複として扱いません（2026-09-17 追記）。reserve と finalize は、その asset の完全削除を最後まで実行してから先へ進みます。R2 がまだ削除に失敗する場合は `500` を返し、upload は `pending` のまま再試行できます。

- 理由: `purging` の行は全画面から隠れていますが、`assets.sha256` の UNIQUE を持ったままです。以前は、同じ写真を選び直すと reserve が `409 DUPLICATE_ASSET` を返し、画面には「登録済み」と表示されていました。実際にはライブラリに無い写真です。削除前に reserve した upload を finalize すると、新しく PUT した object を「重複」として消し、`410` を返していました
- 削除は owner がすでに確定した操作で、再実行しても安全です（architecture.md §7.1）。新しい upload の object key は別の asset ID なので、削除の対象になりません
- 止まった削除は、ライブラリ画面の「削除を再開」からも完了できます。`GET /api/v1/diagnostics` が対象の asset ID を返します

## D-015: restore は公開 HTTP API 経由の再 upload とする

**状態:** 採用（`createdAt` の保持と再開は [D-024](#d-024-export-をページに分けbackup--restore-を差分再開できるようにする) で更新）

特権的な import endpoint は作りません。backup CLI は export manifest と original / derivative を取得し、restore では空の環境へ通常の `reserve -> PUT -> finalize` で再 upload したうえで、favorite・trash・album 構成を API で再現します。

- asset ID は変わる。同一性は original の SHA-256 で判定する
- ~~`createdAt` は restore 時刻になる~~ D-024 で保持するように変更。`takenAt` は保持する
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

既存の `0001_initial.sql` は手書きのまま baseline として扱い、drizzle-kit の snapshot と journal を後から合わせました。production DB の再作成は不要です。baseline の具体的な扱い（journal の `idx: 1`、SQL と snapshot の差、CI の rehearsal が保証する範囲）は [development.md](development.md) §6 を正本とします。

## D-018: original の SHA-256 を R2 に upload 時に検証させる

**状態:** 採用（D-012 の「client-asserted content identity」を更新）

D-012 では `assets.sha256` は client の申告値で、R2 上の byte 列と一致する保証がありませんでした。重複判定・backup・restore はこの値を content identity として使うため、storage 側で一致を保証します。

- reserve は original の presigned PUT に `x-amz-checksum-sha256: base64(申告 SHA-256 の raw digest)` を署名 header として含める（SigV4 の `X-Amz-SignedHeaders` に入る）。Client が header を省略・変更すると署名が合わない
- R2 は PUT body の SHA-256 がこの値と一致しなければ PUT を `400 BadDigest` で拒否し、object を作らない（S3 PutObject の checksum。R2 は 2023-06-16 の release note で S3 PutObject の sha256 checksum に対応。remote-test で実測済み。[verification.md](verification.md)）
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

- iPhone の Safari では、`<input type=file>` の `accept` が HEIC を含まない場合、写真ピッカーの既定（「自動」）が HEIC を JPEG に変換して渡す（Apple Developer Forums の報告。実機では未確認）。これは Safari / iOS の実装上の挙動で、Web 標準の保証ではない
- `accept` に `image/heic` を足すと、Safari 17 以降は HEIC のまま渡し、JPEG まで HEIC へ変換することがある（同フォーラムの報告）。そのため EdgePhotos の `accept` は `image/jpeg,image/png,image/webp` のままにする
- `accept` は選択候補の hint にすぎない。EdgePhotos が前提にするのは「HEIC が届いたら明示的なエラーにする」経路だけで、変換は利用しているだけである。変換の挙動が将来変わっても、黙って壊れずにエラーとして表に出る
- 変換後の JPEG の metadata と取り込み結果は、macOS の `sips` で代わりに確認した。iOS 上の変換結果そのものは未確認（[verification.md](verification.md)）
- 確認した WebKit では `createImageBitmap` で HEIC を decode でき、Chromium ではできなかった（[verification.md](verification.md)）
- Cloudflare Images は HEIC を入力にでき、Worker から binding で呼べる（費用と構成への影響は下表の案 4）

比較した案:

| 案 | 依存・bundle | memory | original の保持 | iPhone / Safari の UX | Cloudflare の費用・構成 |
| --- | --- | --- | --- | --- | --- |
| 1. 非対応を明示（採用） | なし | 変化なし | 保存するのは Browser から受け取った byte 列（iPhone では iOS が作った JPEG）。受け取った byte 列は改変しない | 通常操作では意識しない。「現在の形式」を選んだ場合と、Android の HEIF はエラーになり、書き出しが必要 | なし |
| 2. HEIC を original として保存し、derivative だけ別経路で作る | server に content type と magic（`ftyp` box）の追加。Safari なら現行の canvas 経路で derivative を作れる | Safari では JPEG と同程度（decode 後の bitmap が支配的） | カメラの HEIC byte 列をそのまま保てる | `accept` に HEIC を足す必要があり、上記の Safari の変換挙動に巻き込まれる。Chrome / Firefox では derivative を作れず、別経路が必要 | 別経路を 3 か 4 で作るなら、その費用がかかる |
| 3. Browser 側で変換（libheif の WASM など） | WASM 数 MB を bundle へ追加し、更新も追う | WASM heap に加えて decode 後の bitmap。mobile Safari で最も危うい | 変換結果を original にすると元の byte 列を失う。derivative 専用にすれば案 2 と同じ | Safari は native で decode できるので不要。恩恵を受けるのは desktop Chrome / Firefox だけ | なし |
| 4. Server / Cloudflare 側で変換（Images binding） | Worker に Images binding を追加。Worker 内の WASM decode は CPU とメモリの上限から不採用 | Client の負担は小さい | original は HEIC のまま保持できる | 最も透過的 | 1 枚あたり変換 2 回（thumbnail / preview）。finalize の中で呼べば遅延と失敗経路が増え、非同期化すれば Queues が要る（D-009） |

採用理由: 個人の写真置き場としては、iPhone の通常経路（Safari → JPEG）が追加コードなしで成立します。v1 で解くべき HEIC 固有の問題は「黙って失敗しないこと」だけです。案 2〜4 はどれも upload 形式か derivative 生成の経路を増やし、original の定義（どの byte 列を保存するか）も変わります。

影響と制約:

- iPhone の Safari 経由で保存される original は、iOS が変換した JPEG の byte 列です。カメラが記録した HEIC そのものではありません。「original は byte-for-byte immutable」は「Browser から受け取った byte 列を変えない」という意味で維持されます
- iOS の写真ピッカーの「オプション」で位置情報を外すと、GPS は original にも残りません（EdgePhotos の外の挙動）
- 再検討する条件: Native client を作るとき（OS の decoder で derivative を作りつつ HEIC original を送れる）、または「カメラの HEIC byte 列を残したい」という要求が出たとき。その場合は、まず案 2（Safari / Native に限って HEIC original を受け付ける）を検討する

## D-020: 取り込みの頑健性は Client 側の最小修正で担保する

**状態:** 採用

実機由来の公開サンプル写真と合成 fixture を使い、Chromium と WebKit で取り込みを検証しました（経過は [verification.md](verification.md)、memory の数値は [benchmarks.md](benchmarks.md)）。見つかった問題は、server の契約を変えずに Client 側で直します。

- **WebKit の canvas JPEG には APP1 / APP13 が付く。** WebKit の `canvas.toBlob('image/jpeg')` は、APP1（Exif: ColorSpace と PixelX/YDimension）と APP13（空の Photoshop IRB）を書き出す。finalize はこれを `metadata_segment` として拒否するため、Safari からの upload が `422 UPLOAD_OBJECT_INVALID` で失敗していた。Client が PUT 前に APP1 / APP13 を取り除く（`src/web/lib/jpeg-metadata.ts`）。finalize の検査は緩めない。撮影 metadata がないことは、引き続き server が保証する
- **PUT を再試行する。** 3 回の PUT のどれかが一時的に失敗すると、その写真全体が失敗していた。network error、408、429、5xx は、backoff を挟んで最大 4 回まで試す。`412` は保存済みとして扱う（`src/web/lib/storage-put.ts`）。key は reserve ごとに固有で、`If-None-Match: *` で署名しているため、`412` になるのは同じ upload の以前の試行が R2 に届き、応答だけが失われた場合に限られる。finalize は引き続き size と、original については R2 が検証した SHA-256 を確認する。実 R2 の `412` が CORS 越しに status として読めることは、remote-test で確認済み（[verification.md](verification.md)）。`400`（BadDigest）と `403`（期限切れ）は再試行しない
- **進行中の upload を一覧から落とさない。** 一覧は `slice(0, 200)` で切っていたため、201 枚目以降が進行中の件数に入らず、未完了のまま完了表示になっていた。新しく選んだ項目と進行中の項目は常に残し、古い完了済みの項目だけを削る（`src/web/features/uploads/upload-list.ts`）
- **前処理の並列数は 2 のままにする。** 2 が最適だと示したわけではなく、desktop の Browser の測定では、変えるだけの根拠が得られなかった。memory は decode 後の bitmap が支配的で、並列数を増やすと Chromium では peak が増えた。bitmap は PUT の前に close されるため、転送中に保持するのは File と小さな derivative だけになる。測定値は [benchmarks.md](benchmarks.md)
  - 入れなかったもの: ArrayBuffer を早く手放す案と、canvas を 0×0 にして解放する案（測定の揺れを超える差が出なかった）。Web Worker
  - 再検討の条件: mobile では、並列化で得る速度より peak memory の増加の方が重い可能性がある。iPhone の実機で大きな写真を続けて取り込み、Safari が memory 不足で落ちる場合は、まず並列数 1 を試す
  - 2 は選択の回数によらず、画面全体での上限とする。上の判断は同時に 2 枚までを前提にしている。後から選んだ写真は先の写真の後ろに並ぶ（`src/web/lib/task-limit.ts`）

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

## D-023: D1 と R2 の突合は owner が実行し、自動で消すのは中断した upload の残りだけにする

**状態:** 採用（2026-09-17。roadmap の「未完了 upload の cleanup は未実装」を置き換える）

D1 と R2 は 1 transaction にできません（architecture.md §5）。以前は、期限切れの `uploads` 行を数えるだけで、R2 側から見た不整合（行の無い object、object の無い asset）を調べる手段がありませんでした。5 年使ったライブラリで original が 1 枚欠けても、backup を取るまで気付けません。

- `GET /api/v1/storage/audit`（読み取りのみ）: R2 の key と D1 の id はどちらも asset ID 順に並ぶので、1 ページ = 1 つの ID 範囲として、`originals/` と `derivatives/v1/` の list、`assets`、`uploads` を突き合わせる。どの source も `limit` 件で止め、ページの終わりは最も手前で止まった ID にする。これで「object の無い asset」と「行の無い object」の両方が見つかる。`deep=true` では、そのページの original を `head()` し、R2 が upload 時に記録した SHA-256 と `assets.sha256` を比べる
- 分類: `missing_original`・`original_size_mismatch`・`original_checksum_mismatch`・`missing_derivative`（写真の破損）、`unfinished_delete`、`expired_upload`、`duplicate_leftover`、`unreferenced_objects`、`unexpected_key`、`original_checksum_unrecorded`（D-018 より前の original）、`audit_incomplete`（1 つの ID の下に layout 外の key が多すぎて、決めた list 回数で確認しきれなかった。「問題なし」と区別するため）
- `POST /api/v1/storage/cleanup`: 期限（600 秒）から **さらに 1 日** 過ぎた `pending` の upload だけを扱う。3 object が揃い finalize の検査を通るものは、通常の finalize で写真にする（owner が選んで転送まで終えた写真だから）。object が欠けている・検査に通らないものは、行を先に終端状態（`status = 'duplicate'`、`duplicate_of = NULL`）にし、その upload の key の object を消してから行を消す。`duplicate` の行も 1 日たったら、残った object と行を消す
- 手動で実行する。ライブラリ画面の「ストレージの点検」と `pnpm storage audit|cleanup`（`--apply` を付けるまで dry run）

守ること:

- 消す key は `uploads.asset_id` から作るものだけ。その ID の `assets` 行（`ready` でも `purging` でも）があれば消さない
- finalize は、upload 行がまだ `pending` のときだけ、同じ D1 batch の中で asset を作る（`INSERT ... SELECT ... WHERE status = 'pending'`）。cleanup は行を先に終端状態にするので、検査を終えた finalize が後から asset を作って、消した object を指すことはない
- `unreferenced_objects`（どの行も指さない object）は消さない。D1 を time travel で戻すと、写真の object が行を失った状態で残る（security.md §10）。original を誤って消す可能性のある自動修復は入れない
- `missing_original` などの破損も自動では直さない。backup から戻す（operations.md §12）

却下した案:

- Cron で定期実行する: 件数を観測できるようになり、手動の実行で足りる。中断した upload は写真の整合性を壊さず、急いで消す理由がない。定期実行が要るのは、owner が実行しないまま R2 の料金や件数が問題になった場合（AGENTS.md §6）
- `uploads.status` に `abandoned` を足す: `uploads` の CHECK を変えるには table の作り直しが要り、baseline の無名 UNIQUE の扱いが難しい（development.md §6）。`duplicate` + `duplicate_of = NULL` で「asset を作らずに終わった upload」を表す（`src/worker/db/schema.ts` に注記）
- R2 lifecycle rule で `originals/` を期限切れにする: 写真の original まで消える

影響: 中断した upload を後から finalize すると、cleanup の前なら従来どおり完了し、cleanup の後なら `410`（片付け途中）または `404`（行が消えた）になります。Web の再試行は、どちらでも新しい reservation からやり直します。

## D-024: Export をページに分け、backup / restore を差分・再開できるようにする

**状態:** 採用（2026-09-17。D-015 を更新）

10 万枚の合成ライブラリで測ると（benchmarks.md）、`GET /api/v1/export` は 1 response で 55 MiB の JSON を Worker の memory 内で組み立て、local でも 1 秒かかりました。Worker の memory 上限は 128 MB で、行 object と JSON 文字列を同時に持つと上限を超える見込みです。backup・verify・restore はすべてこの response に依存していました。また、backup は毎回全 original を download し、restore は途中で止まると空の環境からやり直すしかありませんでした。10 万枚の restore は remote で 10 時間を超える見積もりで、その間に Access token が期限切れになるだけで最初からになります。

- export は `GET /api/v1/export/assets`（ID 順、1,000 件ずつ）、`/export/albums`、`/export/album-assets`（`(album_id, asset_id)` 順）に分ける。Web と CLI は同じ関数（`src/contracts/export-manifest.ts`）で format 1 の manifest を組み立てる。ページの間に削除・追加された写真の membership は落とし、manifest が知らない asset を指さないようにする。`settings.last_export_at` は assets の最後のページで記録する。単一 response の `GET /api/v1/export` は削除した（client は Web と backup CLI だけで、どちらも対応済み）
- `pnpm backup export` は差分にする。backup のファイルは original の SHA-256 で名前が決まるので、original の size が合い、derivative が揃っていれば取り直さない。書き込みは一時ファイルからの rename。original が壊れている・無い写真は名前を挙げて続行し、最後に失敗で終わる（1 枚の破損で backup が永久に取れなくなるのを避ける）
- `pnpm backup check <dir>` を足す。manifest のすべての original を読み直して SHA-256 を照合する（オフライン）
- reserve に任意の `metadata.createdAt` を足す。restore は backup の値を送り、`createdAt` と、撮影日時の無い写真の timeline の並びを保つ（以前は restore 時刻になり、撮影日時の無い写真がすべて先頭に、逆順で並んだ）。未来の値は `400`
- restore は進行状況を backup ディレクトリの `restore-state.json` に書く（作った album の ID 対応と段階）。`--resume` は、対象ライブラリの写真がすべて backup にあり、album がすべて記録済みのときだけ続きから実行する。写真は SHA-256 で、album の membership は対象の export で済んだものを飛ばす
- `pnpm backup verify` は `createdAt` も比べ、storage audit を実行し、`--quick` では original を download せず、R2 が upload 時に検証・記録した SHA-256 を使う（deep audit）。記録の無い original（D-018 より前）は `--quick` でも download する

却下した案:

- export を stream で返す: Worker は D1 の結果を一度に受け取るので、D1 側もページに分ける必要がある。client が組み立てる方が単純
- restore の進行を対象ライブラリに書く: 特権的な import 経路（D-015 で避けた）か、album の title に印を付けることになる
- backup / restore の並列化: 変わらず見送る（benchmarks.md）。再開できるようになったので、止まっても失うのは待ち時間だけ

影響: 以前の CLI は `GET /api/v1/export` を使うため、この Worker には使えません。以前の restore で作ったライブラリは `createdAt` が restore 時刻なので、新しい `verify` では `createdAt differs` になります。


## D-025: backup manifest を v1 として確定し、読み込み時に検証する

**状態:** 採用（2026-09-18。D-024 の manifest 形式を確定する）

`readManifest` は `JSON.parse` の結果を TypeScript の型として扱い、`format` と `formatVersion` しか見ていませんでした。`check` / `restore` / `verify` はすべてこの値から始まるため、壊れた manifest が remote の、しかも書き込みを伴う操作に入れました。ライブラリの正式公開前が、数年維持する contract を決める最後の安いタイミングです。

- manifest の shape は `ExportManifestSchema` を正本にし、runtime で検証する。整合性の規則（ID の重複、1 つの original に 2 つの asset、album ID の重複、album 内の重複、存在しない asset への membership）は zod を使わない `manifestIntegrityIssues` に分ける。「値が正しいか」と「全体が整合しているか」は別の問いで、巨大な schema にまとめない
- 各 field を `UploadReserveSchema` と同じかそれ以上に厳しくする。restore は写真ごとに `POST /uploads` へ送り直すので、緩いままだと「schema は通るが 5,000 枚 upload した後で 400 になる」manifest を許してしまう。`originalSize` は 1〜100 MiB、`width` / `height` は正、`filename` は 1〜255 文字、`takenAt` は ISO 8601、album の `title` は 1〜200 文字かつ保存されている綴りのまま
- `createdAt` / `trashedAt` / `exportedAt` / album の `createdAt` は instant（`new Date().toISOString()` そのまま: UTC・ミリ秒・`Z`）に固定する。`verify` はこれらを文字列として比較するので、同じ時刻の別の綴りを認めると「restore はできたが verify が永久に `createdAt differs` を出す」状態になる。綴りだけでなく実在する日時かも見る（正規表現は `2024-99-99T99:99:99.999Z` を通し、`2024-02-30` は 3 月 1 日に繰り上がる）。`takenAt` は EXIF 由来の壁時計なので対象外（offset 任意のまま）
- 未知の key は無視する。ただし backup は 10 年後に古い CLI が読む可能性があるので、v1 に足してよいのは「その field を完全に無視する reader でも、data・意味・検証結果を失わずに restore できる optional field」だけと決める。条件を満たすか判断できない追加は `formatVersion` を上げる側に倒す。知らない `formatVersion` は部分的に読まずに拒否する
- `restore-state.json` も同じ方法で検証する。`--resume` は「対象ライブラリが空」の guard を飛ばすので、信用できない album ID 対応で稼働中のライブラリを触らせない
- 検証は `readManifest` の 1 か所に置き、`check` / `restore` / `verify` が同じ結果を共有する。`restore` は manifest と `restore-state.json` を読み終えてから最初の request を送る
- error は「どこが・なぜ」を 1 行ずつ、最大 10 件と残件数で出す。最初の 1 件で止めると、壊れたファイルを直すのに何度も実行することになる

却下した案:

- 未公開の旧形式への fallback を残す: 公開前なので維持する相手がいない（AGENTS.md §6）
- `.strict()` で未知の key を拒否する: 任意 field の追加がすべて v2 になる
- schema を 1 つにまとめて整合性まで表現する: 読めなくなり、error も「どの規則に違反したか」を失う
- manifest から `objects` を落とす: asset ID から導けるが、R2 の生 dump から手で戻すときの唯一の手掛かり（operations.md §10）。CLI が読まないので古くなる危険もない

影響: `pnpm backup export` が書く manifest の内容は変わりません。手で編集した manifest や、他所で生成した JSON は、これまで通らなかった点で拒否されるようになります。`restore-state.json` に `formatVersion` が入るため、この変更の前に始めて中断した restore は `--resume` できません（対象ライブラリを空にしてやり直します）。

## D-026: derivative は original に触れずに作り直し、その経路は state を持たない 1 つの冪等な呼び出しにする

**状態:** 採用（2026-09-18。roadmap の Future から「derivative の作り直し」を引き上げる）

storage audit は `missing_derivative`（original は無事だが thumbnail / preview が無い）を見つけられますが、直す手段がありませんでした。残っていた手順は「その写真を完全削除して upload し直す」で、作り直せる派生画像のために、作り直せない original を削除する操作を owner に求めていました。R2 の object が 1 つ消えただけで、写真そのものを危険に晒すことになります。

- `POST /api/v1/assets/{assetId}/derivatives/repair` を足す。request は asset ID だけで、object key はすべて server が `src/worker/storage/keys.ts` で決める。client が key を渡す経路は作らない
- この 1 呼び出しが「何が足りないか」と「作り直したものが妥当か」を兼ねる。client は **repair → 足りないものを PUT → repair** と回し、`status: 'ok'` だけを完了とみなす。PUT が成功しても完了の証拠にはしない（`412` は保存済み扱いなので、別の tab が先に書いた bytes を自分のものと取り違える）
- server が持つ state は無い。D1 に行を足さず、migration も要らない。再送・応答の消失・tab を閉じた・同時実行は、すべて「もう一度呼ぶ」に収束する
- derivative の生成は Browser の既存 pipeline をそのまま使う（`renderDerivatives`。upload と同じ renderer・同じ長辺・同じ metadata 除去）。Worker に画像処理は入れない
- `assets` 行が `ready` で、original が finalize の確認したものと同一（size と、R2 が記録した SHA-256。[D-018](decisions.md)）のときだけ URL を発行する。original が壊れている写真に必要なのは新しい thumbnail ではなく backup（operations.md §12）なので `409 REPAIR_SOURCE_UNUSABLE` で断る
- key にある derivative は finalize と同じ検査（[D-012](decisions.md)）に size 上限を足して見る。通らない object は**削除せず、置き換える**
- PUT の条件を 2 つに分ける。key が空なら `If-None-Match: *`（[D-013](decisions.md)）、使えない object があるなら検査した時点の ETag への `If-Match`。どちらも署名対象なので client は外せない。妥当な derivative はどちらの条件でも触れず、古い target は 412 になるだけで無害
- **この endpoint は object を 1 つも削除しない**
- repair の PUT URL は 300 秒（upload の 600 秒より短い）。client は PUT の時点で original を持っているので長い期限は要らず、URL 発行後に始まった完全削除より PUT が長生きする窓を狭くする

守ること:

- original を削除・再 upload・変更しない。repair が署名するのは derivative key の PUT と original の GET だけ
- asset ID・album・favorite・trash・createdAt / takenAt は変えない。この経路は D1 に一切書かない
- 失敗したときの着地点は「original は無事、derivative は直っていない」。ここから先へ悪化させない
- 新しい repair が直したものを、古い repair が取り消せない

却下した案:

- upload と同じ `reserve -> PUT -> finalize` を derivative 用に作る: `uploads` に似た行と状態遷移が増え、期限切れの後始末も要る。作り直せるものにその重さは要らない
- 写真を削除して upload し直す（現状の手順）: 派生画像の欠損を直すために original を消す。直そうとした事故で写真を失う
- Worker で画像を再生成する（Queue / 別 Worker / 外部 service / `sharp`）: Worker が画像を decode しない方針（architecture.md §2）を崩し、Browser に同じ pipeline が既にある（AGENTS.md §6）
- 使えない derivative を削除してから、空の key へ `If-None-Match: *` で PUT させる（当初の実装）: 削除と PUT の間に隙間ができる。同じ壊れた object を見た 2 つの repair があると、一方が直したあとに、もう一方が「壊れた object を消す」つもりで**直ったばかりの derivative を消せる**。R2 の DeleteObject には条件を付けられない（PutObject には `If-Match` がある）ため、削除の直前に head し直しても隙間は閉じない。置き換えなら隙間そのものが無い。代わりに、client が使えない bytes を PUT したまま戻ってこないと、その object は残る（「残るリスク」）
- repair 中に完全削除された場合、残った derivative object を server が消す: `unreferenced_objects` を自動削除しない[D-023](decisions.md) の約束に手を入れることになる。残るのは derivative だけで、audit が既に分類できる（「残るリスク」参照）
- CLI に `pnpm storage repair` を足す: Node に canvas が無く、画像 encoder を依存に加えることになる。API は client 非依存なので、後から別 client が同じ endpoint を使える

影響: `missing_derivative` の対応が「削除して upload し直す」から、ライブラリ画面の「サムネイルを作り直す」になります。R2 CORS の `AllowedMethods` に `GET` が要ります（repair は original を `<img>` ではなく `fetch()` で読むため）。docs/operations.md §6 の rule は元から `GET` を含みますが、`pnpm diagnose` の `r2: CORS` が `GET` も検査するようになります。presigned PUT に `If-Match` を使うのはこの経路が初めてです（upload は `If-None-Match: *` だけ）。

残るリスク:

- repair の URL 発行後に完全削除が走り、そのあとに PUT が届くと、derivative の key だけがどの行も指さない object として残ります（original は残りません）。presigned PUT は D1 を参照できないため、この窓は原理的に閉じられません。audit が `unreferenced_objects` として報告し、[D-023](decisions.md) のとおり自動では消しません
- client が検査を通らない bytes を PUT したまま戻ってこないと、その object は key に残ります。audit は object の有無しか見ないため、この写真は `missing_derivative` として挙がりません（表示は崩れたまま）。次にその写真を repair すれば `If-Match` で置き換わりますが、audit からは見つけられません。削除する設計に戻せばこの状態は避けられる一方、上の「直ったばかりの derivative を消せる」を招きます。**直せていない**より**壊す**方が重いので、置き換えを採ります

## D-027: 古い操作は、新しい正しい状態を取り消せないようにする

**状態:** 採用（2026-09-18。既存機能の adversarial integrity review の結果）

request は直列には届きません。別 tab、再送、応答が消えた後の再試行は、**読んだ時点では正しかった判断**を、状態が変わった後に書き込みます。upload / finalize / 完全削除はすでにこれを条件付き書き込みで扱っています（[D-014](decisions.md)、[D-023](decisions.md)、[D-026](decisions.md)）。同じ規則を、まだ「読んでから書く」ままだった 3 箇所へ広げます。

- **share の再発行は、古い share がまだ有効なときだけ成立する。** `INSERT INTO shares SELECT ... FROM shares WHERE id = ? AND revoked_at IS NULL AND expires_at > ?` を、この呼び出し自身の revoke より**前**に同じ batch で実行し、行ができていなければ `409 SHARE_UNAVAILABLE` を返します。判断しているのは書き込みそのものなので、revoke を読んだ後に届いた再発行も、revoke と同時に走った再発行も、閉じた album に有効な link を戻せません。期限切れも同じ条件で断ります（以前は期限だけを JS で見ており、revoke 済みの share を再発行できました）
- **完全削除は、その asset の重複として決着した upload 行を消さない。** `duplicate_of` を `NULL` にして行を残します。重複の object 削除は best-effort なので（[D-014](decisions.md)）、届いていない場合の後始末は storage cleanup がこの行を見て行います。行ごと消すと、自己回復する `duplicate_leftover` が、誰も消さない `unreferenced_objects` に変わります
- **paged export は、組み立てた snapshot が manifest contract を満たさなければ返さない。** 落として直せるもの（manifest に無い写真への membership）は従来どおり落とし、直せないもの（1 つの original が 2 つの asset として現れる）は `ExportSnapshotError` で拒否します。写真の同一性は SHA-256 だけなので（[D-025](decisions.md)）、この manifest を restore すると 2 件が黙って 1 件になります

守ること:

- 「race が起きない」ではなく「race が起きても、古い actor が正しい状態を壊せない」を条件にする。条件は書き込み側に置き、読んだ値の JS 判定を最終的な保証にしない
- 拒否したときの着地点は、呼び出しの**前**の正しい状態のまま。share が 2 つできる、manifest が 1 件欠けるといった「黙って進む」選択肢は採らない

却下した案:

- 再発行の前に revoked を JS で確認するだけにする: 読みと書きの間が開いたままで、UI が revoke 済みの share に再発行を出さないのと同じ強さしかない
- torn な export を、後に現れた asset を採って重複解消する: asset ID は UUID v4 なので「後のページ = 新しい写真」ではない。生きている asset の方を黙って落としうる
- export の一貫した snapshot を作る（版管理・スナップショット表・長い transaction）: ライブラリの変化中に完全な snapshot を要求しない方針（AGENTS.md §6）に反し、得られるのは「やり直せば済む」ものの自動化だけ

影響: `POST /api/v1/shares/{shareId}/regenerate` は revoke 済み share に対して `409 SHARE_UNAVAILABLE` を返します（Web UI は元から有効な share にしか再発行を出していないため、画面の操作は変わりません）。完全削除の後、重複 upload 行は cleanup の grace（24 時間）を過ぎるまで `uploads` に残ります。export 中にライブラリが変化して整合しない snapshot になった場合、ダウンロード / `pnpm backup export` はやり直しを促して止まります。

残るリスク:

- revoke / 完全削除の**直前**に発行済みの presigned URL は、残り TTL の間だけ有効です（share は最大 300 秒。[security.md](security.md) §5・§6）。これは設計上の既知 risk で、この決定は変えません
- 同じ share に対する再発行が 2 つ同時に成立すると、有効な share が 2 つできます（どちらも古い share を revoke するため、古い link は確実に死にます）。owner の share 一覧に両方出るので隠れた link にはなりません
- export のやり直しは owner の操作です。自動では再試行しません
