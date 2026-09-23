# 設計判断

後から「なぜこの構成を選んだのか」を確認するための Decision Log です。

書くのは、判断と、その理由と、見直す条件です。却下した案・残るリスク・実装者が破ってはいけない境界は、後から判断を理解するのに要る場合だけ足します。過去の判断は書き直しません。

現在の構造は [architecture.md](architecture.md)、開発時のルールは [development.md](development.md) と [AGENTS.md](../AGENTS.md) にあります。

## D-001: v1 は機能を絞り、主要な境界は暫定化しない

**状態:** 採用

初期版では機能数を限定します。一方、データ保全、認証、API、storage boundary を「後で本方式へ置き換えるための仮実装」にはしません。

実需要や測定結果に基づく構成変更は許容します。

## D-002: Web stack は Preact + Signals + Vite を採用する

**状態:** 採用

Web UI は Preact、client state は `@preact/signals`、build は Vite + Cloudflare Vite Plugin を使用します。Styling は Tailwind CSS v4、UI primitives は shadcn/ui + Base UI を採用します。

UI primitives は feature 実装前に Preact production build、keyboard、focus、touch を確認します。不成立の場合は、feature code を積む前に再選定します。

## D-003: Cloudflare-native の 1 Worker 構成とする

**状態:** 採用

Worker、Static Assets、D1、private R2 を Cloudflare 上で構成し、private app と public share を別 Worker へ分けません。

デプロイ単位を増やす具体的な運用上の理由が出るまでは、1 Worker を維持します。

## D-004: API は Client-independent な HTTP/JSON + OpenAPI とする

**状態:** 採用

Worker API は Hono を使用し、`@hono/zod-openapi` の route schema を runtime validation と OpenAPI の定義元とします。

Web UI の component tree や route 構造を API に露出させません。Hono RPC は外部 API の唯一の契約にせず、将来の Native client も同じ application API を利用できる構造にします。

## D-005: Cloudflare Access を認証入口とし、AppPrincipal へ正規化する

**状態:** 採用

Web 認証は Cloudflare Access を使います。Access 固有の assertion は HTTP 層で検証し、認証後の処理へは正規化した principal だけを渡します。

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

schema の定義元は migration とし、ORM 導入の具体的な価値が生じた場合だけ再検討します。

## D-009: Client-specific BFF と background infrastructure を先回りして置かない

**状態:** 採用（2026-09-17 に導入条件を明文化）

v1 では別 Web BFF / Mobile BFF、Queues、Durable Objects、Cron、multi-cloud provider abstraction、monorepo 等を前提にしません。

現在の要求や実測から必要性が示された場合に追加判断します。

これらを避けること自体は目的ではありません。複雑さには運用・障害・保守のコストがあるため、必要性が観測されてから導入します。現在の構成では解決できない要求・障害・運用負荷・性能問題・測定結果が出た場合は、候補から外さずに評価します。

判断の根拠は 3 つです。現在の構成で足りないもの、導入で具体的に良くなること、増えるコスト。

## D-010: アプリ本体は interactive SPA とし、SSR framework を採用しない

**状態:** 採用

EdgePhotos の主要画面は高い対話性を持つため、アプリ本体は Preact SPA + HTTP API とします。

SSR、RSC、Server Actions を中心要件にせず、vinext や Astro をアプリ本体へ導入しません。将来 landing page / docs site を別途作る場合の技術選定は、この判断とは分離します。

## D-011: build 済み静的ファイルは `/share/assets/*` に配置する

**状態:** 採用

共有ページは Access Bypass された `/share/*` 上で動くため、読み込む JS / CSS も Access 外に置く必要があります。Bypass を `/share/*` に限定したまま成立させるため、Vite の client build 出力先を `share/assets/` にしました。

これにより private app の JS bundle も認証なしで取得できます。bundle は公開ソースと同じコードで、secret や写真データを含まないため許容します。

一方 `index.html` と SPA 経路、`/api/*` は Access の保護下に残します。共有ページ本体（`/share/{shareId}`）は Worker が返し、share 用 header と CSP を必ず付与します。

## D-012: finalize の保存確認は「存在・サイズ・形式・派生画像 metadata」とする

**状態:** 採用（SHA-256 の扱いは [D-018](#d-018-original-の-sha-256-を-r2-に-upload-時に検証させる) で更新）

`assets.sha256` を client-asserted content identity とする判断は、現在の契約ではありません。[D-018](#d-018-original-の-sha-256-を-r2-に-upload-時に検証させる) で置き換えられています。現在の SHA-256 の契約は D-018 が定めます。

finalize の確認項目と、Worker が original 全体を hash しない方針は現在も有効です。

finalize では Worker が R2 binding で次を確認してから asset を `ready` にします。

- reserve した 3 object がすべて存在する
- 各 object の size が reserve 時の申告値と一致する
- original の先頭 byte が申告 content type と一致する（HEIC / HEIF は `ftyp` の brand まで見る。[D-030](#d-030-heic--heif-の-original-を受け付けderivative-を作れる環境かは-probe-で決める)）
- thumbnail / preview が JPEG で、APP1（EXIF / XMP）・APP13（IPTC）segment を含まない

original の SHA-256 は Client が reserve 時に申告し、重複判定の索引として使います。Worker は finalize 時に original 全体を hash しません。Workers の CPU 上限内で大きな original を毎回 hash するのは現実的でないためです。

保存済み original の SHA-256 は、backup / restore / verify（`pnpm backup`）で R2 から再取得して検証します。

当時は、`assets.sha256` を **client-asserted content identity** として扱いました。Server が byte 列から計算し直した verified identity ではありません。v1 は 1 owner で、脅威は「owner が自分自身に嘘をつく」ことになるため、この区別を許容しました。この前提は D-018 で見直し、R2 が upload 時に申告値との一致を検証するようにしました。

## D-013: presigned PUT は `If-None-Match: *` と `Content-Type` を署名対象にする

**状態:** 採用（original は [D-018](#d-018-original-の-sha-256-を-r2-に-upload-時に検証させる) の checksum header も署名する）

object key は reserve ごとに新しい asset ID から作るため、別 asset の上書き経路はありません。

加えて、有効期限内の PUT URL が finalize 後に再利用されて original が差し替わることを防ぐため、`If-None-Match: *` を署名 header に含めます。R2 の S3 API は PutObject の conditional header をサポートします。

Browser はこの 2 header を送るため、R2 CORS の AllowedHeaders に `content-type` と `if-none-match` が必要です。

## D-014: original の SHA-256 ごとに asset は 1 つとする

**状態:** 採用（2026-09-17 に `purging` の扱いを追加）

`assets.sha256` は UNIQUE です。値は client が reserve 時に申告し、D-018 以降の upload では R2 が original の byte 列と照合します（[D-018](#d-018-original-の-sha-256-を-r2-に-upload-時に検証させる)）。

reserve 時に同じ original が存在すれば `409 DUPLICATE_ASSET` を返します。reserve 後の競合で finalize 時に重複が判明した場合は、既存 asset を返し、その upload 専用の object を D1 記録後に削除します。ゴミ箱内の asset も重複として扱います。

### 完全削除が途中で止まった asset は重複として扱わない

reserve と finalize は、その asset の完全削除を最後まで実行してから先へ進みます。R2 がまだ削除に失敗する場合は `500` を返し、upload は `pending` のまま再試行できます。

理由は、`purging` の行が全画面から隠れていながら、`assets.sha256` の UNIQUE を持ったままだからです。以前は、同じ写真を選び直すと reserve が `409 DUPLICATE_ASSET` を返し、画面には「登録済み」と表示されていました。実際にはライブラリに無い写真です。削除前に reserve した upload を finalize すると、新しく PUT した object を「重複」として消し、`410` を返していました。

この扱いが安全な理由は 2 つです。削除は owner がすでに確定した操作で、再実行しても安全です。新しい upload の object key は別の asset ID なので、削除の対象になりません。

止まった削除は、ライブラリ画面の「削除を再開」からも完了できます。対象の asset ID は `GET /api/v1/diagnostics` が返します。

## D-015: restore は公開 HTTP API 経由の再 upload とする

**状態:** 採用（`createdAt` の保持と再開は [D-024](#d-024-export-をページに分けbackup--restore-を差分再開できるようにする) で更新）

特権的な import endpoint は作りません。

backup CLI は export manifest と original / derivative を取得します。restore では、空の環境へ通常の `reserve -> PUT -> finalize` で再 upload したうえで、favorite・trash・album 構成を API で再現します。

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
- schema の property 名は column 名（snake_case）と同じにし、ORM 側の値変換（`mode: 'boolean'` など）を使わない
- API DTO / zod schema と DB row 型は統合しない。row から DTO への変換は service に置く

property 名を column 名と揃えるのは、明示的な SQL の結果（`SELECT a.* ...`）と `$inferSelect` を同じ型として扱えるようにするためです。

Migration:

- 適用される定義元は、review して commit した `migrations/*.sql` のまま。適用は従来どおり `wrangler d1 migrations apply`
- 流れは `schema.ts` 変更 → `pnpm db:generate <name>` → 生成 SQL を review（必要なら手で直す）→ `.sql` と `migrations/meta/` を commit
- `drizzle-kit push` と `drizzle-kit migrate` は使わない。`drizzle.config.ts` に D1 credential を置かないため、そもそも実行できない
- `pnpm db:check` が schema と `migrations/meta/` の snapshot のずれを検出する
- `tests/integration/migrations.test.ts` が、migration 適用後の D1 と `schema.ts` の一致を検証する

既存の `0001_initial.sql` は手書きのまま baseline として扱い、drizzle-kit の snapshot と journal を後から合わせました。production DB の再作成は不要です。

baseline の具体的な扱い（journal の `idx: 1`、SQL と snapshot の差、CI の rehearsal が保証する範囲）は開発ガイドの [D1 / migration](development.md#7-d1--migration) にあります。

## D-018: original の SHA-256 を R2 に upload 時に検証させる

**状態:** 採用（D-012 の「client-asserted content identity」を更新）

D-012 では `assets.sha256` は client の申告値で、R2 上の byte 列と一致する保証がありませんでした。重複判定・backup・restore はこの値を content identity として使うため、storage 側で一致を保証します。

- reserve は original の presigned PUT に `x-amz-checksum-sha256: base64(申告 SHA-256 の raw digest)` を署名 header として含める（SigV4 の `X-Amz-SignedHeaders` に入る）
- そのため、Client が header を省略・変更すると署名が合わない
- R2 は PUT body の SHA-256 がこの値と一致しなければ、PUT を `400 BadDigest` で拒否し、object を作らない
- finalize は R2 binding の `head()` が返す `checksums.sha256` を申告値と比較する
- Worker は original を download も hash もしない。確認は HEAD 1 回で済む
- thumbnail / preview は再生成可能な derivative で、content identity に使わないため checksum を付けない

R2 の PUT 側の根拠は、S3 PutObject の checksum です。R2 は 2023-06-16 の release note で S3 PutObject の sha256 checksum に対応しており、remote-test で実測済みです（[verification.md](verification.md)）。

finalize 側の根拠は、R2 が put 時に指定された checksum を object に記録することです。S3 API で PUT した object でも binding から読めます（remote-test で実測済み）。記録がない・値が違う original は `422 UPLOAD_OBJECT_INVALID`（`checksum_missing` / `checksum_mismatch`）とし、`ready` にしません。何らかの経路で checksum 検証を経ずに置かれた object に対しても fail-closed になります。

却下した案:

- finalize で Worker が original 全体を読んで hash する: 最大 100MB を毎回読むのは CPU・時間の面で避けたい。R2 が同じ検証を upload 時に行える
- `Content-MD5` を使う: R2 は対応するが、MD5 では SHA-256 との一致を保証できない
- 期待 SHA-256 を `X-Amz-Content-Sha256` に入れる: presigned URL では payload hash を `UNSIGNED-PAYLOAD` として扱うのが S3 の規約で、payload 検証を当てにできない

影響:

- Browser は `x-amz-checksum-sha256` を送るため、R2 CORS の AllowedHeaders に追加が必要（[R2 CORS](operations.md#6-r2-cors)）
- この変更以前に reserve した upload の PUT URL は checksum を含まない。そのまま finalize すると `checksum_missing` になるため、再 upload が必要（URL の期限は 600 秒）
- この変更以前に `ready` になった asset の `sha256` は申告値のまま。`pnpm backup verify` が R2 から読み直して照合する
- local 開発と test では、local blob route が同じ header を検証し、R2 binding の `put(..., { sha256 })` で digest を検証する。Miniflare も不一致を拒否し、`head().checksums.sha256` を返す

## D-019: v1 は HEIC / HEIF を受け付けず、iPhone は Safari の JPEG 変換に任せる

**状態:** [D-030](#d-030-heic--heif-の-original-を受け付けderivative-を作れる環境かは-probe-で決める) で置き換え（2026-09-22）

v1 の original は JPEG / PNG / WebP のままとします。HEIC / HEIF は Client が明示的に拒否し、「HEIC は未対応です（JPEG で書き出してから選んでください）」と表示します。

拡張子（`.heic` / `.heif` / `.hif`）でも判定します。desktop Browser は type を空で渡すことがあるためです。

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
| 2. HEIC を original として保存し、derivative だけ別経路で作る | Server に content type と magic（`ftyp` box）の追加。Safari なら現行の canvas 経路で derivative を作れる | Safari では JPEG と同程度（decode 後の bitmap が支配的） | カメラの HEIC byte 列をそのまま保てる | `accept` に HEIC を足す必要があり、上記の Safari の変換挙動に巻き込まれる。Chrome / Firefox では derivative を作れず、別経路が必要 | 別経路を 3 か 4 で作るなら、その費用がかかる |
| 3. Browser 側で変換（libheif の WASM など） | WASM 数 MB を bundle へ追加し、更新も追う | WASM heap に加えて decode 後の bitmap。mobile Safari で最も危うい | 変換結果を original にすると元の byte 列を失う。derivative 専用にすれば案 2 と同じ | Safari は native で decode できるので不要。恩恵を受けるのは desktop Chrome / Firefox だけ | なし |
| 4. Server / Cloudflare 側で変換（Images binding） | Worker に Images binding を追加。Worker 内の WASM decode は CPU とメモリの上限から不採用 | Client の負担は小さい | original は HEIC のまま保持できる | 最も透過的 | 1 枚あたり変換 2 回（thumbnail / preview）。finalize の中で呼べば遅延と失敗経路が増え、非同期化すれば Queues が要る（D-009） |

採用理由: 個人の写真置き場としては、iPhone の通常経路（Safari → JPEG）が追加コードなしで成立します。v1 で解くべき HEIC 固有の問題は「黙って失敗しないこと」だけです。

案 2〜4 はどれも upload 形式か derivative 生成の経路を増やします。original の定義（どの byte 列を保存するか）も変わります。

影響と制約:

- iPhone の Safari 経由で保存される original は、iOS が変換した JPEG の byte 列です。カメラが記録した HEIC そのものではありません
- 「original は byte-for-byte immutable」は「Browser から受け取った byte 列を変えない」という意味で維持されます
- iOS の写真ピッカーの「オプション」で位置情報を外すと、GPS は original にも残りません（EdgePhotos の外の挙動）

再検討する条件は 2 つです。Native client を作るとき（OS の decoder で derivative を作りつつ HEIC original を送れる）、または「カメラの HEIC byte 列を残したい」という要求が出たときです。その場合は、まず案 2（Safari / Native に限って HEIC original を受け付ける）を検討します。

## D-020: 取り込みの頑健性は Client 側の最小修正で担保する

**状態:** 採用

実機由来の公開サンプル写真と合成 fixture を使い、Chromium と WebKit で取り込みを検証しました。経過は [verification.md](verification.md)、memory の数値は [benchmarks.md](benchmarks.md) にあります。

見つかった問題は、Server の契約を変えずに Client 側で直します。

**WebKit の canvas JPEG には APP1 / APP13 が付く。** WebKit の `canvas.toBlob('image/jpeg')` は、APP1（Exif: ColorSpace と PixelX/YDimension）と APP13（空の Photoshop IRB）を書き出します。finalize はこれを `metadata_segment` として拒否するため、Safari からの upload が `422 UPLOAD_OBJECT_INVALID` で失敗していました。

Client が PUT 前に APP1 / APP13 を取り除きます（`src/web/lib/jpeg-metadata.ts`）。finalize の検査は緩めません。撮影 metadata がないことは、引き続き Server が保証します。

**PUT を再試行する。** 3 回の PUT のどれかが一時的に失敗すると、その写真全体が失敗していました。network error、408、429、5xx は、backoff を挟んで最大 4 回まで試します（`src/web/lib/storage-put.ts`）。`400`（BadDigest）と `403`（期限切れ）は再試行しません。

`412` は保存済みとして扱います。key は reserve ごとに固有で、`If-None-Match: *` で署名しているため、`412` になるのは同じ upload の以前の試行が R2 に届き、応答だけが失われた場合に限られます。finalize は引き続き size と、original については R2 が検証した SHA-256 を確認します。実 R2 の `412` が CORS 越しに status として読めることは、remote-test で確認済みです（[verification.md](verification.md)）。

**Web の再試行をどこから始めるか決める。** 前の試行の reservation の finalize から始めます。`409 UPLOAD_OBJECT_MISSING` で presigned URL が期限内なら、欠けた object だけを PUT し直します。期限切れ・`404`・`410`・`422` なら新しい reservation から始めます（`src/web/features/uploads/transfer.ts`）。`410` と `404` は storage cleanup が片付けたあとの upload です（[D-023](#d-023-d1-と-r2-の突合は-owner-が実行し自動で消すのは中断した-upload-の残りだけにする)）。

再試行は、file に触れる前に server へ聞きます。前の試行の reservation があるなら、まず finalize を送ります。ここで ready か duplicate が返れば、file の読み取り・SHA-256・decode・metadata 読み取り・derivative 生成はどれも行いません。bytes を送ると決まってから前処理します（`src/web/features/uploads/batch.ts`）。

順番が逆だと、転送も finalize も server 側では成功していて応答だけ失った写真が、再試行の前処理で失敗したときに失敗として表示されます。実際には library に入っているので、「保存されたか分からない」を作ってしまいます。前処理の結果を保持し続ける案は採りません。memory を使い、1 枚あたりの derivative を抱えたまま待つことになるためです。

期限内かどうかは、server が返した `expiresAt` をこの端末の時計と比べて決めています。時計が遅れている端末では、残り時間を実際より長く見積もるため、失効した URL をいつまでも期限内と読みます。そのため、欠けた object の PUT を storage が拒否した場合も、その reservation は終わったものとして新しい reservation から始めます。届かなかっただけ（network）のときは、reservation を保持したままにします。残った object は storage cleanup が片付けます（[D-023](#d-023-d1-と-r2-の突合は-owner-が実行し自動で消すのは中断した-upload-の残りだけにする)）。

**同じ file では変わらない失敗に再試行を出さない。** 転送の失敗（network、5xx、期限切れ）と、file そのものへの拒否は別に扱います。finalize が `422 UPLOAD_OBJECT_INVALID` で original について `incomplete_file` / `structure_unverified` / `content_type_mismatch` だけを報告した場合と、reserve が `400 VALIDATION_FAILED` を返した場合は、同じ file を送り直しても同じ答えになるため、その行を再試行の対象から外して理由を出します（`src/web/features/uploads/batch.ts`）。size や checksum、derivative についての拒否は転送の問題なので、これまでどおり再試行できます。

file ではなく画面そのものへの拒否（`403 FORBIDDEN`、`403 ORIGIN_NOT_ALLOWED`、`503 SERVER_MISCONFIGURED`）も対象から外します。答えは file に依らず、deployment を変えない限り変わりません。`401 UNAUTHENTICATED` だけは再試行を残します。この code には JWKS の取得失敗のような一時的な原因も含まれ（`src/worker/auth/access.ts`）、同じ request が次に通ることがあるためです。文面は「ページを再読み込みしてください」をやめます。再読み込みすると選んだ file を失い、選び直しになるためです。代わりに、別のタブでログインしてから再試行する手順を出します。Access の session が切れたときに 401 として届くかは実環境で確認していません。

**進行中の upload を一覧から落とさない。** 一覧は `slice(0, 200)` で切っていたため、201 枚目以降が進行中の件数に入らず、未完了のまま完了表示になっていました。新しく選んだ項目と進行中の項目は常に残し、古い完了済みの項目だけを削ります（`src/web/features/uploads/upload-list.ts`）。

**前処理の並列数は 2 のままにする。** 2 が最適だと示したわけではありません。desktop の Browser の測定では、変えるだけの根拠が得られませんでした。

memory は decode 後の bitmap が支配的で、並列数を増やすと Chromium では peak が増えました。bitmap は PUT の前に close されるため、転送中に保持するのは File と小さな derivative だけになります。測定値は [benchmarks.md](benchmarks.md) にあります。

- 入れなかったもの: ArrayBuffer を早く手放す案と、canvas を 0×0 にして解放する案（測定の揺れを超える差が出なかった）。Web Worker
- 再検討の条件: mobile では、並列化で得る速度より peak memory の増加の方が重い可能性がある。iPhone の実機で大きな写真を続けて取り込み、Safari が memory 不足で落ちる場合は、まず並列数 1 を試す
- 2 は選択の回数によらず、画面全体での上限とする。後から選んだ写真は先の写真の後ろに並ぶ（`src/web/lib/task-limit.ts`）

## D-021: Browser 固有の経路だけを Playwright で自動化する

**状態:** 採用

workerd の test（`pnpm test`）は Server の契約を検証しますが、Browser でしか起きない不具合は見えません。D-020 の WebKit の APP1 / APP13 と、期限切れの presigned URL で画像が壊れたまま残る不具合（下記）がその例です。

`@playwright/test` を devDependency に加え、少数の spec（`e2e/`）だけを置きます。

- 対象: canvas での derivative 生成と finalize の成立、file input、共有ページ、Base UI の keyboard / focus、phone 幅の layout と tap
- 対象外: Server の認可・検査・share の検証。これらは integration test が固定し、Browser では再検査しない
- 実行環境: `vite dev`（D-016 の Access / presigned URL 模擬）を、使い捨ての local D1 / R2（`.wrangler/e2e`）で起動する。remote には触れない
- Browser: Chromium（desktop）と WebKit（iPhone 13 相当）。WebKit は iOS Safari の代わりにはならないが、D-020 の不具合は WebKit で再現した
- `pnpm check` には含めず、CI の別 job で実行する。bundle と Worker には影響しない

**期限切れの presigned URL（同時に修正）:** API が返す画像 URL は 600 秒（共有ページは最大 300 秒）で失効します。timeline は `loading="lazy"` なので、ページを開いたまま 10 分を過ぎてから scroll すると、まだ読み込んでいない thumbnail が `403` で壊れたまま残りました。viewer の preview も同じでした。Client は画像の読み込み失敗時に URL を取り直します。

- timeline / album / 共有ページ: 最初のページの取得から 60 秒以上経っていれば、読み込み済みの範囲を先頭から取り直す（1 分に 1 回まで）
- 取り直しても、表示済みの thumbnail の URL は差し替えない。差し替えると全件を再 download するため
- ただし読み込みに失敗した thumbnail は表示済みの扱いから外し、新しい URL にする。一度表示できた画像が、後で再取得されて `403` になる場合があるため
- viewer: 開くたびに asset を取得して preview の URL を得る（[D-022](#d-022-一覧では-thumbnail-の-url-だけを署名する)）。それでも preview が失敗したら 1 回だけ取り直す
- 経過時間は `performance.now()` で測る。端末の時計のずれに左右されず、object が本当に欠けている場合も再取得は上の頻度で止まる
- URL の有効期限と Server の契約は変えない。URL を長くする案は、bearer capability を長く生かすことになるため採らない

## D-022: 一覧では thumbnail の URL だけを署名する

**状態:** 採用（API の一覧 response から `previewUrl` を除く）

一覧 API（`GET /api/v1/assets`、`GET /api/v1/albums/{albumId}/assets`）は、item ごとに thumbnail と preview の 2 つの URL を署名していました。60 件の timeline で 120 回です。

preview は viewer を開くまで使いません。署名は Worker の CPU を使い、Workers Free の上限は 1 request 10 ms です（[benchmarks.md](benchmarks.md)）。

- 一覧の item は `AssetSummary`（`Asset` から `previewUrl` を除いた schema）とする
- `previewUrl` は、1 件の asset を返す response（`GET /api/v1/assets/{assetId}`、PATCH、trash / restore、finalize）にだけ含める
- Web の viewer は開いたときに asset を取得する。取得までは cache 済みの thumbnail を表示する
- backup CLI はもともと個別の asset から preview の URL を得ていたので、影響しない

preview の URL は常に viewer を開いた時点のものになり、期限切れの心配がありません。

却下した案: 一覧で preview の URL を返したまま、署名を速くする（署名鍵の cache など）。問題は回数そのもので、使わない URL を発行しないほうが単純です。

影響: 一覧 response の `previewUrl` を使う Client は、個別の asset を取得する必要があります。現時点の Client は Web と backup CLI だけで、どちらも対応済みです。

## D-023: D1 と R2 の突合は owner が実行し、自動で消すのは中断した upload の残りだけにする

**状態:** 採用（2026-09-17。roadmap の「未完了 upload の cleanup は未実装」を置き換える）

D1 と R2 は 1 transaction にできません。以前は、期限切れの `uploads` 行を数えるだけで、R2 側から見た不整合（行の無い object、object の無い asset）を調べる手段がありませんでした。5 年使ったライブラリで original が 1 枚欠けても、backup を取るまで気付けません。

**`GET /api/v1/storage/audit`（読み取りのみ）:** R2 の key と D1 の id は、どちらも asset ID 順に並びます。そこで 1 ページ = 1 つの ID 範囲として、`originals/` と `derivatives/v1/` の list、`assets`、`uploads` を突き合わせます。

どの source も `limit` 件で止め、ページの終わりは最も手前で止まった ID にします。これで「object の無い asset」と「行の無い object」の両方が見つかります。`deep=true` では、そのページの original を `head()` し、R2 が upload 時に記録した SHA-256 と `assets.sha256` を比べます。

分類は 3 系統です。

- 写真の破損: `missing_original`・`original_size_mismatch`・`original_checksum_mismatch`・`missing_derivative`
- 片付け待ち: `unfinished_delete`・`expired_upload`・`duplicate_leftover`・`unreferenced_objects`
- その他: `unexpected_key`、`original_checksum_unrecorded`（D-018 より前の original）、`audit_incomplete`

`audit_incomplete` は、1 つの ID の下に layout 外の key が多すぎて、決めた list 回数で確認しきれなかったことを表します。「問題なし」と区別するために分けています。

**`POST /api/v1/storage/cleanup`:** 期限（600 秒）から **さらに 1 日** 過ぎた `pending` の upload だけを扱います。

3 object が揃い finalize の検査を通るものは、通常の finalize で写真にします。owner が選んで転送まで終えた写真だからです。object が欠けている・検査に通らないものは、行を先に終端状態にします（`status = 'duplicate'`、`duplicate_of = NULL`）。そのあと、その upload の key の object を消してから行を消します。`duplicate` の行も 1 日たったら、残った object と行を消します。

実行は手動です。ライブラリ画面の「ストレージの点検」と `pnpm storage audit|cleanup`（`--apply` を付けるまで dry run）から行います。

守ること:

- 消す key は `uploads.asset_id` から作るものだけ。その ID の `assets` 行（`ready` でも `purging` でも）があれば消さない
- finalize は、upload 行がまだ `pending` のときだけ、同じ D1 batch の中で asset を作る（`INSERT ... SELECT ... WHERE status = 'pending'`）。cleanup は行を先に終端状態にするので、検査を終えた finalize が後から asset を作って、消した object を指すことはない
- `unreferenced_objects`（どの行も指さない object）は消さない。D1 を time travel で戻すと、写真の object が行を失った状態で残る。original を誤って消す可能性のある自動修復は入れない
- `missing_original` などの破損も自動では直さない。backup から戻す（[監視と点検](operations.md#12-監視と点検)）

却下した案:

- Cron で定期実行する: 件数を観測できるようになり、手動の実行で足りる。中断した upload は写真の整合性を壊さず、急いで消す理由がない。定期実行が要るのは、owner が実行しないまま R2 の料金や件数が問題になった場合
- `uploads.status` に `abandoned` を足す: `uploads` の CHECK を変えるには table の作り直しが要り、baseline の無名 UNIQUE の扱いが難しい（[D1 / migration](development.md#7-d1--migration)）。`duplicate` + `duplicate_of = NULL` で「asset を作らずに終わった upload」を表す（`src/worker/db/schema.ts` に注記）
- R2 lifecycle rule で `originals/` を期限切れにする: 写真の original まで消える

影響: 中断した upload を後から finalize すると、cleanup の前なら従来どおり完了し、cleanup の後なら `410`（片付け途中）または `404`（行が消えた）になります。Web の再試行は、どちらでも新しい reservation からやり直します（[D-020](#d-020-取り込みの頑健性は-client-側の最小修正で担保する)）。

## D-024: Export をページに分け、backup / restore を差分・再開できるようにする

**状態:** 採用（2026-09-17。D-015 を更新）

10 万枚の合成ライブラリで測ると、`GET /api/v1/export` は 1 response で 55 MiB の JSON を Worker の memory 内で組み立てました。local でも 1 秒かかりました（[benchmarks.md](benchmarks.md)）。Worker の memory 上限は 128 MB で、行 object と JSON 文字列を同時に持つと上限を超える見込みです。backup・verify・restore はすべてこの response に依存していました。

また、backup は毎回全 original を download し、restore は途中で止まると空の環境からやり直すしかありませんでした。10 万枚の restore は remote で 10 時間を超える見積もりで、その間に Access token が期限切れになるだけで最初からになります。

**export をページに分ける。** `GET /api/v1/export/assets`（ID 順、1,000 件ずつ）、`/export/albums`、`/export/album-assets`（`(album_id, asset_id)` 順）の 3 つにします。Web と CLI は同じ関数（`src/contracts/export-manifest.ts`）で format 1 の manifest を組み立てます。

ページの間に削除・追加された写真の membership は落とし、manifest が知らない asset を指さないようにします。`settings.last_export_at` は assets の最後のページで記録します。単一 response の `GET /api/v1/export` は削除しました（client は Web と backup CLI だけで、どちらも対応済み）。

**backup を差分にする。** backup のファイルは original の SHA-256 で名前が決まるので、original の size が合い、derivative が揃っていれば取り直しません。書き込みは一時ファイルからの rename です。

original が壊れている・無い写真は名前を挙げて続行し、最後に失敗で終わります。1 枚の破損で backup が永久に取れなくなるのを避けるためです。

**`pnpm backup check <dir>` を足す。** manifest のすべての original を読み直して SHA-256 を照合します（オフライン）。

**reserve に任意の `metadata.createdAt` を足す。** restore は backup の値を送り、`createdAt` と、撮影日時の無い写真の timeline の並びを保ちます。以前は restore 時刻になり、撮影日時の無い写真がすべて先頭に、逆順で並んでいました。未来の値は `400` です。

**restore を再開できるようにする。** 進行状況を backup ディレクトリの `restore-state.json` に書きます（作った album の ID 対応と段階）。`--resume` は、対象ライブラリの写真がすべて backup にあり、album がすべて記録済みのときだけ続きから実行します。写真は SHA-256 で、album の membership は対象の export で済んだものを飛ばします。

**`pnpm backup verify` を拡張する。** `createdAt` も比べ、storage audit を実行します。`--quick` では original を download せず、R2 が upload 時に検証・記録した SHA-256 を使います（deep audit）。記録の無い original（D-018 より前）は `--quick` でも download します。

却下した案:

- export を stream で返す: Worker は D1 の結果を一度に受け取るので、D1 側もページに分ける必要がある。client が組み立てる方が単純
- restore の進行を対象ライブラリに書く: 特権的な import 経路（D-015 で避けた）か、album の title に印を付けることになる
- backup / restore の並列化: 変わらず見送る（benchmarks.md）。再開できるようになったので、止まっても失うのは待ち時間だけ

影響: 以前の CLI は `GET /api/v1/export` を使うため、この Worker には使えません。以前の restore で作ったライブラリは `createdAt` が restore 時刻なので、新しい `verify` では `createdAt differs` になります。

## D-025: backup manifest を v1 として確定し、読み込み時に検証する

**状態:** 採用（2026-09-18。D-024 の manifest 形式を確定する）

`readManifest` は `JSON.parse` の結果を TypeScript の型として扱い、`format` と `formatVersion` しか見ていませんでした。`check` / `restore` / `verify` はすべてこの値から始まるため、壊れた manifest が remote の、しかも書き込みを伴う操作に入れました。ライブラリの正式公開前が、数年維持する contract を決める最後の安いタイミングです。

**shape は `ExportManifestSchema` を定義元にし、runtime で検証する。** 整合性の規則は、zod を使わない `manifestIntegrityIssues` に分けます。対象は、ID の重複、1 つの original に 2 つの asset、album ID の重複、album 内の重複、存在しない asset への membership です。

「値が正しいか」と「全体が整合しているか」は別の問いで、巨大な schema にまとめません。

**各 field を `UploadReserveSchema` と同じかそれ以上に厳しくする。** restore は写真ごとに `POST /uploads` へ送り直すので、緩いままだと「schema は通るが 5,000 枚 upload した後で 400 になる」manifest を許してしまいます。各 field の条件は次のとおりです。`originalSize` は 1〜100 MiB、`width` / `height` は正、`filename` は 1〜255 文字、`takenAt` は ISO 8601、album の `title` は 1〜200 文字かつ保存されている綴りのままとします。

**instant の綴りを固定する。** `createdAt` / `trashedAt` / `exportedAt` / album の `createdAt` は `new Date().toISOString()` そのまま（UTC・ミリ秒・`Z`）に固定します。`verify` はこれらを文字列として比較するので、同じ時刻の別の綴りを認めると「restore はできたが verify が永久に `createdAt differs` を出す」状態になります。

綴りだけでなく、実在する日時かも見ます。正規表現は `2024-99-99T99:99:99.999Z` を通し、`2024-02-30` は 3 月 1 日に繰り上がるためです。`takenAt` は EXIF 由来の壁時計なので対象外です（offset 任意のまま）。

**未知の key は無視する。** ただし backup は 10 年後に古い CLI が読む可能性があります。v1 に足してよいのは「その field を完全に無視する reader でも、data・意味・検証結果を失わずに restore できる optional field」だけと決めます。条件を満たすか判断できない追加は `formatVersion` を上げる側に倒します。知らない `formatVersion` は部分的に読まずに拒否します。

**`restore-state.json` も同じ方法で検証する。** `--resume` は「対象ライブラリが空」の guard を飛ばすので、信用できない album ID 対応で稼働中のライブラリを触らせません。

**検証は `readManifest` の 1 か所に置く。** `check` / `restore` / `verify` が同じ結果を共有します。`restore` は manifest と `restore-state.json` を読み終えてから最初の request を送ります。

**error は「どこが・なぜ」を 1 行ずつ、最大 10 件と残件数で出す。** 最初の 1 件で止めると、壊れたファイルを直すのに何度も実行することになります。

却下した案:

- 未公開の旧形式への fallback を残す: 公開前なので維持する相手がいない
- `.strict()` で未知の key を拒否する: 任意 field の追加がすべて v2 になる
- schema を 1 つにまとめて整合性まで表現する: 読めなくなり、error も「どの規則に違反したか」を失う
- manifest から `objects` を落とす: asset ID から導けるが、R2 の生 dump から手で戻すときの唯一の手掛かり（[Restore](operations.md#10-restore)）。CLI が読まないので古くなる危険もない

影響: `pnpm backup export` が書く manifest の内容は変わりません。手で編集した manifest や、他所で生成した JSON は、これまで通らなかった点で拒否されるようになります。`restore-state.json` に `formatVersion` が入るため、この変更の前に始めて中断した restore は `--resume` できません（対象ライブラリを空にしてやり直します）。

## D-026: derivative は original に触れずに作り直し、その経路は state を持たない 1 つの冪等な呼び出しにする

**状態:** 採用（2026-09-18。roadmap の Future から「derivative の作り直し」を引き上げる）

storage audit は `missing_derivative`（original は無事だが thumbnail / preview が無い）を見つけられますが、直す手段がありませんでした。

残っていた手順は「その写真を完全削除して upload し直す」です。作り直せる派生画像のために、作り直せない original を削除する操作を owner に求めていました。R2 の object が 1 つ消えただけで、写真そのものを危険に晒すことになります。

**`POST /api/v1/assets/{assetId}/derivatives/repair` を足す。** request は asset ID だけで、object key はすべて Server が `src/worker/storage/keys.ts` で決めます。client が key を渡す経路は作りません。

**1 呼び出しが「何が足りないか」と「作り直したものが妥当か」を兼ねる。** client は repair → 足りないものを PUT → repair と回し、`status: 'ok'` だけを完了とみなします。PUT が成功しても完了の証拠にはしません。`412` は保存済み扱いなので、別の tab が先に書いた bytes を自分のものと取り違えるためです。

**Server が持つ state は無い。** D1 に行を足さず、migration も要りません。再送・応答の消失・tab を閉じた・同時実行は、すべて「もう一度呼ぶ」に収束します。

**derivative の生成は Browser の既存 pipeline をそのまま使う。** `renderDerivatives` で、upload と同じ renderer・同じ長辺・同じ metadata 除去です。Worker に画像処理は入れません。

**URL を発行する条件。** `assets` 行が `ready` で、original が finalize の確認したものと同一（size と、R2 が記録した SHA-256。[D-018](#d-018-original-の-sha-256-を-r2-に-upload-時に検証させる)）のときだけ発行します。original が壊れている写真に必要なのは新しい thumbnail ではなく backup なので、`409 REPAIR_SOURCE_UNUSABLE` で断ります（[監視と点検](operations.md#12-監視と点検)）。

**key にある derivative は finalize と同じ検査に size 上限を足して見る（[D-012](decisions.md)）。** 通らない object は削除せず、置き換えます。

**PUT の条件を 2 つに分ける。** key が空なら `If-None-Match: *`（[D-013](decisions.md)）、使えない object があるなら検査した時点の ETag への `If-Match` です。どちらも署名対象なので client は外せません。妥当な derivative はどちらの条件でも触れず、古い target は 412 になるだけで無害です。

**この endpoint は object を 1 つも削除しません。**

**repair の PUT URL は 300 秒**（upload の 600 秒より短い）です。client は PUT の時点で original を持っているので長い期限は要りません。URL 発行後に始まった完全削除より PUT が長生きする窓を、狭くする意味もあります。

守ること:

- original を削除・再 upload・変更しない。repair が署名するのは derivative key の PUT と original の GET だけ
- asset ID・album・favorite・trash・createdAt / takenAt は変えない。この経路は D1 に一切書かない
- 失敗したときの着地点は「original は無事、derivative は直っていない」。ここから先へ悪化させない
- 新しい repair が直したものを、古い repair が取り消せない

却下した案:

- upload と同じ `reserve -> PUT -> finalize` を derivative 用に作る: `uploads` に似た行と状態遷移が増え、期限切れの後始末も要る。作り直せるものにその重さは要らない
- 写真を削除して upload し直す（現状の手順）: 派生画像の欠損を直すために original を消す。直そうとした事故で写真を失う
- Worker で画像を再生成する（Queue / 別 Worker / 外部 service / `sharp`）: Worker が画像を decode しない方針を崩す。Browser に同じ pipeline が既にある
- CLI に `pnpm storage repair` を足す: Node に canvas が無く、画像 encoder を依存に加えることになる。API は client 非依存なので、後から別 client が同じ endpoint を使える

**使えない derivative を削除してから、空の key へ `If-None-Match: *` で PUT させる案**（当初の実装）も却下しました。削除と PUT の間に隙間ができるためです。

同じ壊れた object を見た 2 つの repair があると、一方が直したあとに、もう一方が「壊れた object を消す」つもりで**直ったばかりの derivative を消せます**。R2 の DeleteObject には条件を付けられない（PutObject には `If-Match` がある）ため、削除の直前に head し直しても隙間は閉じません。置き換えなら隙間そのものがありません。代わりに、client が使えない bytes を PUT したまま戻ってこないと、その object は残ります（下の「残るリスク」）。

**repair 中に完全削除された場合、残った derivative object を Server が消す案**も却下しました。`unreferenced_objects` を自動削除しないという約束（[D-023](decisions.md)）に手を入れることになるためです。残るのは derivative だけで、audit が既に分類できます。

影響: `missing_derivative` の対応が「削除して upload し直す」から、ライブラリ画面の「サムネイルを作り直す」になります。

- R2 CORS の `AllowedMethods` に `GET` が要ります。repair は original を `<img>` ではなく `fetch()` で読むためです。運用の [R2 CORS](operations.md#6-r2-cors) の規則は元から `GET` を含みますが、`pnpm diagnose` の `r2: CORS` が `GET` も検査するようになります
- presigned PUT に `If-Match` を使うのはこの経路が初めてです（upload は `If-None-Match: *` だけ）
- R2 CORS の `AllowedHeaders` に `if-match` も要ります。Browser が署名済みの `If-Match` を送るので preflight に載るためです。当初この項目が漏れており、運用の CORS 例と `pnpm diagnose` にも無かったため、2026-09-23 に追加しました（[R2 CORS](operations.md#6-r2-cors)）

残るリスク:

- repair の URL 発行後に完全削除が走り、そのあとに PUT が届くと、derivative の key だけがどの行も指さない object として残ります（original は残りません）。presigned PUT は D1 を参照できないため、この窓は原理的に閉じられません。audit が `unreferenced_objects` として報告し、自動では消しません（[D-023](decisions.md)）
- client が検査を通らない bytes を PUT したまま戻ってこないと、その object は key に残ります。audit は object の有無しか見ないため、この写真は `missing_derivative` として挙がりません（表示は崩れたまま）。次にその写真を repair すれば `If-Match` で置き換わりますが、audit からは見つけられません

後者は、削除する設計に戻せば避けられます。一方で、上の「直ったばかりの derivative を消せる」を招きます。**直せていない**より**壊す**方が重いので、置き換えを採ります。

## D-027: 古い操作は、新しい正しい状態を取り消せないようにする

**状態:** 採用（2026-09-18。既存機能の adversarial integrity review の結果）

request は直列には届きません。別 tab、再送、応答が消えた後の再試行は、**読んだ時点では正しかった判断**を、状態が変わった後に書き込みます。

upload / finalize / 完全削除はすでにこれを条件付き書き込みで扱っています（[D-014](decisions.md)、[D-023](decisions.md)、[D-026](decisions.md)）。同じ規則を、まだ「読んでから書く」ままだった 3 箇所へ広げます。

**share の再発行は、古い share がまだ有効なときだけ成立する。** 次の INSERT を、この呼び出し自身の revoke より**前**に同じ batch で実行します。行ができていなければ `409 SHARE_UNAVAILABLE` を返します。

```sql
INSERT INTO shares SELECT ... FROM shares WHERE id = ? AND revoked_at IS NULL AND expires_at > ?
```

判断しているのは書き込みそのものです。そのため、revoke を読んだ後に届いた再発行も、revoke と同時に走った再発行も、閉じた album に有効な link を戻せません。期限切れも同じ条件で断ります。以前は期限だけを JS で見ており、revoke 済みの share を再発行できました。

**完全削除は、その asset の重複として決着した upload 行を消さない。** `duplicate_of` を `NULL` にして行を残します。重複の object 削除は best-effort なので（[D-014](decisions.md)）、届いていない場合の後始末は storage cleanup がこの行を見て行います。行ごと消すと、自己回復する `duplicate_leftover` が、誰も消さない `unreferenced_objects` に変わります。

**paged export は、組み立てた snapshot が manifest contract を満たさなければ返さない。** 落として直せるもの（manifest に無い写真への membership）は従来どおり落とし、直せないもの（1 つの original が 2 つの asset として現れる）は `ExportSnapshotError` で拒否します。写真の同一性は SHA-256 だけなので、この manifest を restore すると 2 件が黙って 1 件になります（[D-025](decisions.md)）。

守ること:

- 「race が起きない」ではなく「race が起きても、古い actor が正しい状態を壊せない」を条件にする
- 条件は書き込み側に置き、読んだ値の JS 判定を最終的な保証にしない
- 拒否したときの着地点は、呼び出しの**前**の正しい状態のまま。share が 2 つできる、manifest が 1 件欠けるといった「黙って進む」選択肢は採らない

却下した案:

- 再発行の前に revoked を JS で確認するだけにする: 読みと書きの間が開いたままで、UI が revoke 済みの share に再発行を出さないのと同じ強さしかない
- torn な export を、後に現れた asset を採って重複解消する: asset ID は UUID v4 なので「後のページ = 新しい写真」ではない。生きている asset の方を黙って落としうる
- export の一貫した snapshot を作る（版管理・スナップショット表・長い transaction）: ライブラリの変化中に完全な snapshot を要求しない方針に反し、得られるのは「やり直せば済む」ものの自動化だけ

影響:

- `POST /api/v1/shares/{shareId}/regenerate` は、revoke 済み share に対して `409 SHARE_UNAVAILABLE` を返します。Web UI は元から有効な share にしか再発行を出していないため、画面の操作は変わりません
- 完全削除の後、重複 upload 行は cleanup の grace（24 時間）を過ぎるまで `uploads` に残ります
- export 中にライブラリが変化して整合しない snapshot になった場合、ダウンロード / `pnpm backup export` はやり直しを促して止まります

残るリスク:

- revoke / 完全削除の**直前**に発行済みの presigned URL は、残り TTL の間だけ有効です（share は最大 300 秒）。これは設計上の既知 risk で、この決定は変えません
- 同じ share に対する再発行が 2 つ同時に成立すると、有効な share が 2 つできます。どちらも古い share を revoke するため、古い link は確実に死にます。owner の share 一覧に両方出るので、隠れた link にはなりません
- export のやり直しは owner の操作です。自動では再試行しません

## D-028: 許可した複数の email が 1 つの library を対等に共同利用する

**状態:** 採用（2026-09-21。夫婦 2 人での共同利用が必要になったため）

private API を使えるのは `OWNER_EMAIL` に一致する 1 identity だけでした。これを `HOUSEHOLD_EMAILS`（email の comma 区切り）に置き換え、そこに並ぶ identity をすべて **household member** として受け入れます。

member は互いに対等です。1 つの library を共同利用し、upload・timeline・favorite・album・share・trash・restore・export に同じ権限を持ちます。

favorite・album・trash は library の状態で、member ごとには分かれません。片方が付けた favorite は両方の favorite で、片方が trash した写真は両方から消えます。member ごとの state が要ると分かった時点で、その時の要求で設計します。

**user ごとの library も、asset ごとの所有者も作りません。** D1 の `assets` / `albums` / `shares` には元から「誰が作ったか」の列がありません。この決定で足しもしません。したがって schema の migration はなく、認可の判断は「member かどうか」だけです。既存の duplicate 処理（SHA-256 の UNIQUE）も、どの member が upload したかに影響されません。

**読み取れない設定は、部分的に使わずに無効にします。** 余分な comma、打ち間違い、email でない値が 1 つでもあれば設定全体を `null` にし、private API は全員に `503` を返します。「B の行だけ壊れていたので A だけ通る」という状態を作らないためです。

守ること:

- Access を通過しただけでは member ではない。Worker が `HOUSEHOLD_EMAILS` と照合する
- email を持たない identity（service token）は member にならない
- member の追加・削除は Access policy と `HOUSEHOLD_EMAILS` の両方で行う（[operations.md](operations.md#4-cloudflare-access)）

却下した案:

- `OWNER_EMAIL` を残して `HOUSEHOLD_EMAILS` の fallback にする: 移行のためだけに残る経路で、認証設定が 2 か所に分かれる。`secrets.required` が未設定の deploy を止めるので、移行は「deploy の前に新しい secret を入れる」だけで足りる（[operations.md](operations.md#3-利用者が設定する値)）
- asset に `created_by` を持たせる: 現在の要求（2 人が同じ写真を見る）では誰も読まない列になる。member ごとの表示や権限を実際に必要としたときに、その時点の要求で設計する
- role / 招待 / tenant を入れる: 解く問題は「明示的に設定した少人数が同じ library を使う」であり、これらは要求の先回りになる（[AGENTS.md](../AGENTS.md#6-将来要件を先回りしない)）

残るリスク:

- member はライブラリ全体を削除・export できます。member 1 人の端末やアカウントが侵害されれば、library 全体が侵害されます。member を分離したい場合、この設計では解決できません（[security.md](security.md#3-private-api-の認証と認可)）
- Access policy と `HOUSEHOLD_EMAILS` は別々に更新します。片方だけを消すと、消したつもりの identity が残ります。`pnpm diagnose` は現在の token が通るかどうかしか見ないため、この食い違いは検出しません
- `HOUSEHOLD_EMAILS` は Access identity の email です。Access 側で email が変わったら、この設定も更新しないと締め出されます

D-023 など、これより前の決定に出てくる「owner」は household member と読み替えます。過去の判断は書き直しません。

## D-029: test の時間制限は hang を打ち切るためだけに使い、config で一括して決める

**状態:** 採用（2026-09-21。CI が code の欠陥ではない理由で赤くなったため）

vitest の既定の 5 秒をそのまま使っていました。これを `vitest.config.ts` の `testTimeout` / `hookTimeout` = 120 秒に置き換え、test ごとの上書きをなくします。

**時間制限は hang を打ち切るためのものです。** 速さの assert には使いません。速さを見るのは `pnpm bench` と [benchmarks.md](benchmarks.md) で、そちらは合成データの規模を決めて測ります。test の wall clock は、同じコードでも CI runner の混み具合で決まります。

GitHub Actions の同一 commit・同一コードで、最も重い test は 8.9 秒から 28.9 秒まで 3.2 倍ぶれました。run 全体の test 時間も 20.4 秒から 77.9 秒まで動きます。5 秒の制限は、通常 2 秒で終わる test に 2.5 倍の余裕しか与えません。観測したぶれの方が大きいので、遅い run に当たった test から順に落ちます。測定は [verification.md](verification.md#ci-の時間制限2026-09-21) にあります。

120 秒は、CI で観測した最遅の test（28.9 秒）の約 4 倍です。hang したときに CI が 2 分で止まる長さでもあります。

守ること:

- 時間制限は `vitest.config.ts` だけに書く。`it(..., 60_000)` のような test ごとの上書きを足さない
- test が制限に掛かったら、上げる前にどの処理で何ミリ秒かかるかを測る
- 遅い test を速くしたいときは、制限ではなく test の作り方を変える

却下した案:

- 落ちた test だけ個別に延ばす: 同じ原因で落ちうる test が他にもある（CI 最遅 run で 2.1〜3.4 秒の test が 5 件）。1 件ずつ後追いすることになり、`storage.test.ts` の `60_000` が既にその 1 件目だった。今回この上書きも消す
- retry で通す: 赤の原因が消えず、本当に壊れたときも緑になる
- CI の並列度を下げる: 遅い run で全体が遅くなることは測れたが、並列実行が原因だという測定はない。suite 全体が遅くなる代わりに、ぶれの原因は残る（[AGENTS.md](../AGENTS.md#6-将来要件を先回りしない)）

残るリスク:

- 本当に hang した test の検出が 5 秒から 120 秒へ遅くなります。suite 全体が通常 30 秒なので、CI の待ち時間としては許容します
- test が徐々に遅くなっても、120 秒までは気付きません。速さの退行は `pnpm bench` で見ます

## D-030: HEIC / HEIF の original を受け付け、derivative を作れる環境かは probe で決める

**状態:** 採用（2026-09-22。[D-019](#d-019-v1-は-heic--heif-を受け付けずiphone-は-safari-の-jpeg-変換に任せる) を置き換える）

D-019 は「iPhone の Safari が HEIC を JPEG に変換して渡す」報告に任せ、HEIC / HEIF を Client が拒否していました。これは「カメラが記録した byte 列を残す」ことを諦める判断で、D-019 自身が再検討の条件として「カメラの HEIC byte 列を残したいという要求が出たとき」を挙げていました。その要求が出たため、D-019 の案 2（HEIC を original として保存し、derivative は既存経路で作る）を採用します。

**original は受け取った byte 列のまま保存します。** HEIC を JPEG へ変換して original と呼ぶことはしません。derivative は既存の canvas 経路で作る JPEG のままで、APP1 / APP13 の除去も finalize の検査も変わりません。

### 受け入れる形式

`ftyp` box の major brand と compatible brands の両方を読んで決めます。major brand だけでは足りません。generic な `mif1` は codec を名乗らないからです。

| 分類 | brand | 扱い |
| --- | --- | --- |
| HEIC still | `heic` `heix` `heim` `heis` | `image/heic` |
| generic HEIF still | `mif1` | `image/heif`。ただし compatible に HEIC still brand があれば、より具体的な `image/heic` |
| HEIC sequence | `hevc` `hevx` `hevm` `hevs` | 拒否 |
| generic HEIF sequence | `msf1` | 拒否 |
| AVIF / AVIF sequence | `avif` `avis` | 拒否 |

宣言された brand のどこかに拒否対象があれば、still brand も名乗っていても拒否します。矛盾した宣言を、都合のよい方に読まないためです。

image sequence を拒否するのは、今回のスコープが still image だからです。Live Photo に対応するかどうかとは別の話で、HEIF image sequence は Live Photo とも別物です。

`ftyp` は untrusted input として読みます。宣言された box size を検査し、16 byte 未満・1024 byte 超・手元の bytes を超える・compatible brands が 4 byte 単位でない・size が 0（EOF まで）や 1（64bit）のものは拒否します。読むのは先頭 1024 byte までです。

### 「decode できた」を原本が健全な証拠にしない

WebKit は、後半が失われた HEIC からでも画像を返します（途中で切れた JPEG と同じ挙動）。thumbnail が出ることは、original が全部揃っていることの証拠になりません。写真庫が預かるのは original なので、ここは decoder の寛容さに任せません。

ISO BMFF の box は自分の長さを持つので、**top-level box を歩いて、ファイル自身が宣言する box の長さと、受け取った byte 数が整合するか**だけを確かめます。確認するのはこの整合性だけで、original が完全であることの証明ではありません。box の中身は読まず、中で壊れているものや、size 0 の box で長さを言い切っていないものは分かりません。

- 宣言が EOF を越える box があれば拒否する（途中で切れたファイル）
- box header より小さい size、box に属さない余り byte も拒否する
- size 0（EOF まで）と size 1（64bit largesize）は仕様どおり受け入れる。free / skip / 未知の box も同じように歩く
- top-level の box type は印字可能な 4 文字であることを要求する。padding は box ではない
- header がこちらの持つ byte 列を越える場合は判定しない（unverified）。実ファイルでは起きない

Client はファイル全体を持っているので必ず判定できます。Worker は finalize で既に読んでいる先頭 256KB だけで判定します。box header は先頭に集まるため、100MB の original でも追加の読み出しは要りません。

Worker も fail-closed です。整合しないものは `incomplete_file`、window の内側で判定しきれなかったもの（`unverified`）は `structure_unverified` として `422` で拒否し、どちらも asset を作りません。検査できなかった original を保存しないためです。実機の HEIC で `structure_unverified` が出るようなら、そのときに次の box header だけを R2 から range read して続きを読みます。先回りしては作りません。

この検査が言うのは「宣言された box の長さと受け取った byte 数が合っている」ことだけです。image data が壊れていないことも、original が完全であることも保証しません。JPEG / PNG / WebP には同じ検査を入れていません（今回の範囲外です。途中で切れた JPEG の扱いは [D-020](#d-020-取り込みの頑健性は-client-側の最小修正で担保する) のままです）。

### metadata の読み取りは decode のあとに置く

`exifr` は、box が zero padding になっている HEIC で返ってこなくなります（実測。[verification.md](verification.md)）。上の box type の規則でこの形は先に弾けますが、untrusted なファイルに対して最も無防備なのは metadata parser なので、順番も変えます。

`preparePhoto` は、head を sniff → probe → 全体を読む → 構造を確認 → SHA-256 → decode → **decode に成功してから** metadata を読む、の順で進みます。decoder が受け付けなかったファイルは exifr に渡りません。

### decode できるかは capability probe で決める

埋め込んだ 513 byte の HEIC を `createImageBitmap` に 1 度だけ通し、結果を cache します。UA も `navigator` も見ません。probe が失敗する環境では、reserve と R2 PUT の前に「このブラウザでは HEIC を処理できません」と伝えて止めます。probe は通るがそのファイルだけ失敗した場合は「壊れているか未対応の形式です」と伝えます。この 2 つを分けることが、ブラウザの制約と壊れたファイルを推測なしに区別する方法です。

**この probe は HEVC / HEIC に対してのみ答えます。** `image/heif` は他の codec を含められるため、probe の結果から HEIF 全体の対応可否を推定しません。`image/heif` はそのファイル自身の decode 結果だけで判断し、失敗時も browser 全体の対応可否を断定しません。

実測（Playwright、2026-09-22）: macOS の WebKit は HEIC を decode でき、EXIF Orientation 6 の 64x32 が 32x64 になりました。Chromium は `InvalidStateError` です。同じ WebKit でも CI の Linux runner では decode できません。**decode の可否は engine ではなく実行環境で決まります。** probe が UA 判定より正しいことが、ここでも確かめられました。数値は [benchmarks.md](benchmarks.md)、経過は [verification.md](verification.md) にあります。

Chrome / Firefox のために libheif（WASM）や Cloudflare Images を入れることはしません。D-019 の案 3・案 4 に対する評価は変わっていません。bundle と更新追従、mobile Safari の memory、finalize に増える外部依存と失敗経路、非同期化に必要な Queues（[D-009](#d-009-client-specific-bff-と-background-infrastructure-を先回りして置かない)）の費用に対して、現在の要求は「iPhone で撮った原本を残す」ことだけです。

### `accept` は hint でしかない

`<input accept>` は `image/jpeg,image/png,image/webp,image/heic,image/heif` の明示列挙にします。対応形式を個別に並べるのは、WebKit で `image/*` と HEIC を混ぜた指定により JPEG / PNG が HEIC へ transcode される挙動が報告されており、WebKit 側では bug として修正されているものの、利用中の Safari への反映時期に依存したくないからです。

`accept` は正しさの根拠にしません。EdgePhotos は受け取った bytes を必ず sniff し、実際の形式を記録します。ピッカーが JPEG → HEIC、HEIC → JPEG のどちらに変換して渡しても、保存するのは受け取った byte 列で、表示もその形式になります。

**`accept` に HEIC を足しても、原本が渡される保証はありません。** ピッカーが変換したかどうかを Web アプリから知る方法はなく、EdgePhotos が取得していない byte 列を「保存した」とは記録も表示もしません。実機での挙動は未確認です（[verification.md](verification.md)）。

### export manifest を v2 へ上げる

`contentType` の enum を広げた manifest は、v1 しか知らない reader では読めません。同じ `formatVersion: 1` のまま意味を変えるのは [D-025](#d-025-backup-manifest-を-v1-として確定し読み込み時に検証する) の「知らない version は部分的に読まずに拒否する」に反するので、v2 へ上げます。

- 新規 export は v2 を書く
- reader は v1 と v2 の両方を読む。v1 の manifest は v1 の契約（JPEG / PNG / WebP のみ）で検証する
- version と契約の対応は schema の discriminated union 1 つで表す。migration の仕組みは作らない

### 影響と残るリスク

- HEIC を decode できない環境（Chrome / Firefox）では HEIC を追加できません。JPEG / PNG / WebP は変わりません
- 既に保存した HEIC の derivative を、decode できない環境で作り直すことはできません。repair はその枚数を別に数え、「このブラウザでは読み取れない形式でした」と伝えます
- HEIC の decode は JPEG より重くなります。12.2MP で decode が約 1.7 倍、decode 後の derivative 生成は同じです（[benchmarks.md](benchmarks.md)）。bitmap の memory は JPEG と同じで、並列数 2 の制限（[D-020](#d-020-取り込みの頑健性は-client-側の最小修正で担保する)）がそのまま効きます
- bundle は probe 用 fixture の 684 byte（gzip 495 byte）だけ増えます
- HEIC の decoder は OS / browser のものです。EdgePhotos が足す parser は `ftyp` の読み取りだけで、Worker は decode しません
- 構造の検査は HEIC / HEIF だけに入れました。JPEG / PNG / WebP は今までどおりで、途中で切れた JPEG は WebKit では登録されます
- WebKit は mdat を 0xff で埋めた HEIC も decode します。構造が揃っているファイルを decode 失敗として拒否する経路は、e2e では再現できていません（unit test のみ）
- fixture の orientation は EXIF で持っています。実機の HEIC が使う `irot` / `imir` は未確認です

再検討する条件は、cross-browser の HEIC upload が実際の要求になったとき、または native client を作るときです。その場合も、まず original を変えずに derivative を作る経路を探します。

## D-031: 年月の一覧を別の endpoint で返し、jump は既存の cursor で行う

**状態:** 採用（2026-09-22）

数千枚の library では、古い写真へ辿り着くために timeline を延々と読み進めることになります。解くのは「目的の時期へ直接移動できること」だけで、検索基盤は作りません。

### 年月の一覧は 1 行 1 月で返す

`GET /api/v1/assets/months` が、写真のある年月を新しい順に、件数と cursor を付けて返します。

```sql
SELECT substr(COALESCE(taken_at, created_at), 1, 7) AS month, COUNT(*),
       MAX(printf('%015d', sort_at + 100000000000000) || id)
FROM assets WHERE status = 'ready' AND trashed_at IS NULL GROUP BY month ORDER BY month DESC
```

response の行数は library の枚数ではなく、写真のある月数で決まります。写真が 0 枚の月は行がありません。navigation を作るために全 asset を client へ渡すことはしません。

`MAX` が 1 つの値しか取れないため、月の先頭の写真の `(sort_at, id)` を 1 つの文字列に符号化しています。`sort_at` を負にならない値へずらして固定長へ padding し、後ろに id を繋げます。この順序は timeline の並び順と一致します（詳細は「jump は写真を指す cursor で行う」）。

D1 側は ready かつ trash でない行の走査です。`assets_timeline` は `(sort_at, id)` なので、この GROUP BY には使えません。10,000 件で 19,500 行・5 ms です（[benchmarks.md](benchmarks.md)）。

同じことを window function（`ROW_NUMBER() OVER (PARTITION BY month ...)`）で書く方が素直ですが、20,000 件で rows_read が 39,000 → 96,029、7 → 27 ms になりました。読む行が 2.5 倍になるため採りません。符号化した pair は rows_read を増やさず、20,000 件で 13 ms です。

式 index（`substr(COALESCE(taken_at, created_at), 1, 7)` の部分 index）は測ったうえで入れていません。20,000 件で rows_read は 39,000 → 19,000、13 → 3 ms になりますが、どちらも枚数に比例します。現在の library では index 無しで 1〜5 ms で、対価は migration と、drizzle-kit の snapshot が式 index を持ち続けることです。rows_read が運用上の問題になった時点で入れます。

月ごとの件数を別 table に持って維持する案は採りません。upload・trash・restore・完全削除・restore 済み backup のすべてに整合性の責任が増え、D1 と R2 が単一 transaction ではない前提（[AGENTS.md](../AGENTS.md)）で「count だけずれた library」を作れてしまいます。取り込むのは、実測した month query の rows_read が運用上の問題になったときです。

### 月の定義は「記録した撮影時刻の digits」

`takenAt` があればその先頭 7 文字、無ければ `createdAt`（UTC）です。`sort_at` は使いません。`sort_at` は offset 付きの撮影時刻を UTC の瞬間へ直すので、`2024-05-01T08:00:00+09:00` の写真が 2024-04 になります。grid の見出しは撮影時刻の digits をそのまま出すため（[architecture.md](architecture.md#6-保存する画像の契約)）、`sort_at` を月にすると見出しと navigation が食い違います。

`takenAt` の無い写真だけは、navigation が UTC の月、見出しが閲覧端末の timezone の月です。月境界の数時間で違う月に見えることがあります。並び順の fallback（`sort_at` = upload 時刻）は変えていません。端末の timezone を server に送って月を計算し直す案は、household の 2 人が別の timezone にいると「同じ library に別の年月構成」が見えるため採りません。

### jump は写真を指す cursor で行う

守るべき契約は「選んだ月へ移動したら、最初に出る写真がその月の最も新しい写真である」ことです。

cursor は、その写真自身を指す `(sort_at, id, at)` です。`at` が付いた cursor は、その行を page に含めます（`(sort_at, id) <= (s, i)`）。既存の cursor の比較にそのまま乗るので、cursor の形式は増えても pagination の仕組みは変わりません。「指定月へ行く」ために offset pagination へ変えることもしていません。

はじめは「その月の `MAX(sort_at) + 1` の位置」を cursor にしていました。これは契約を守れません。**月は撮影時刻の digits、並び順は UTC の瞬間なので、違う月の写真が同じ `sort_at` を持てます。**

```text
2024-05-01T09:00:00+09:00  -> 2024-05-01T00:00:00Z（月は 2024-05）
2024-04-30T12:00:00-12:00  -> 2024-05-01T00:00:00Z（月は 2024-04）
```

同じ瞬間なので、最終的な並びは id で決まります。4 月の写真の id が大きければ、5 月を選んだのに 4 月の見出しから始まります。位置を指す cursor では、その瞬間の写真をすべて拾ってしまうためです。写真自身を指す cursor なら、選んだ月の写真が必ず page の先頭になります。上にある 4 月の写真は「これより新しい写真」で読めます。

`at` が効くのは古い方向だけです。上方向ではその写真は下の page に属するため、境界の行を含めません。こうすると、jump した位置から上と下へ読んだ結果が、timeline をちょうど 1 回覆います。

最も新しい月の cursor は null です。その月は timeline の先頭から始まるので、cursor は要りません。上に page があるかのように見せることもなくなります。

### jump の後も上下に読めるようにする

jump した位置より新しい写真を読む方法が必要です。`AssetSummary` は `sort_at` を持たないので、client 側では作れません。`GET /api/v1/assets` に `direction=newer` と `prevCursor` を足しました。`direction=newer` は `(sort_at, id) > cursor` を `ASC` で読み、返す items は常に新しい順です。`assets_timeline` を逆向きに辿るだけで、新しい index は要りません。

cursor が null のときだけ「その方向に写真が無い」を意味します。request が来た側の cursor は、その先を読んでいないので null にしません。渡すと空の page が返ることがあります。これを厳密にするには、page ごとにもう 1 回 query することになるため、意味の方を弱く定義しています。

この弱さが見えるのは、最も新しい写真より上を読もうとしたときだけです。最も新しい月の cursor を null にしたので、年月から入った場合はその状態になりません。

上方向は IntersectionObserver ではなく button です。上へ足すと、読んでいた写真の位置がずれます。押したときだけ動く方が分かりやすく、押した結果として新しい写真が画面に出ます。

読んでいた位置を保つ案は採りません。足した分の高さが要りますが、section は `content-visibility: auto` なので、render されるまで高さは `contain-intrinsic-size` の見積もりです。実測では、押した直後に合わせても、その section が render された時点で約 1,200px ずれました（Chromium）。Safari には `overflow-anchor` も無いため、どちらの方法でも browser 任せにはできません。

### client の状態

`createPageList` は、list を組み立てた request の並び（jump の cursor、下への append、上への prepend）を覚えます。presigned URL の期限切れで読み直すとき、同じ範囲を同じ順で読み直すためです。先頭から読み直すと、jump した list が先頭の月に置き換わります。

年月は `?m=YYYY-MM` として URL に残します。back / forward と reload で同じ月へ戻れます。SPA router も scroll 復元の仕組みも足していません。pixel 単位の位置は戻しません。選んだ月の先頭に戻ります。

写真が 1 枚も無くなった月が URL に残っている場合は、param を落として最新から表示します。エラーにはしません。

### virtualization は入れない

grid は `content-visibility: auto` で画面外の section を render しません。Chromium の実測では、年月から開いた画面は 120 tile・419 node です。末尾まで読み込めば 5,000 tile・15,128 node になりますが、年月へ直接移動できるようになったので、古い写真を見るために末尾まで読む必要はありません（[benchmarks.md](benchmarks.md)）。

この測定の thumbnail は 1x1 の画像なので、decode 済み画像の memory は含みません。実際に画像を表示した値は、10,000 件を末尾まで読み込んだ Chromium の 64 MB / 30,487 node です（[benchmarks.md](benchmarks.md)）。

つまり「全部 scroll すれば枚数の分だけ node を持つ」ことは変わっていません。変えたのは、古い写真を見るために全部 scroll する必要をなくしたことです。実機の memory は [roadmap.md](roadmap.md) の Post-merge verification で見ます。そこで問題が出たときに virtualization を候補に入れます。

### 範囲外

full text search、AI / semantic search、tag、場所、uploader での絞り込み、member ごとの timeline は作りません。viewer の ←/→ は読み込み済みの範囲のままで、jump した先頭より新しい写真へは進みません（grid の button で読んでから開きます）。navigation は library 全体に対するもので、household の 2 人には同じ年月構成が見えます（[D-028](#d-028-許可した複数の-email-が-1-つの-library-を対等に共同利用する)）。

### 再検討する条件

- month query の rows_read または時間が、実測で運用上の問題になったとき（式 index、あるいは維持する集計 table を候補に入れる）
- 実測した DOM node 数・memory が問題になったとき（virtualization を候補に入れる）
- `takenAt` の無い写真の月が、実際の利用で分かりにくいと分かったとき

## D-032: まとめての操作は、既存の冪等な単体 API を並列に呼んで行う

**状態:** 採用（2026-09-22）

数十枚を選んで album へ入れる、まとめてゴミ箱へ送る、といった整理の操作を入れます。写真を 1 枚ずつ viewer から扱う必要をなくすためです。

やり方は 2 つありました。bulk endpoint を足して asset ID の配列を受け取るか、既にある単体 endpoint をそのまま並列に呼ぶかです。先に測りました（[benchmarks.md](benchmarks.md)）。

50 枚を 6 並列で呼んだときの server 側の cost は、album 追加・favorite・trash のいずれも 24〜60 ms で、request あたり読む行は 1 行です。1,000 件と 10,000 件で変わりません。既存の endpoint がどれも id で 1 行を引くだけだからです。

そのため endpoint は追加しません。bulk endpoint が減らせるのは往復の回数だけで、server の処理量は同じです。household の端末から 50 枚なら、6 並列で約 9 波です。

**1 枚 = 1 request = 1 つの結果とする。** batch は全体として失敗しません。10 枚のうち 1 枚が失敗しても、成功した 9 枚は成功のままです。失敗した asset だけを選び直して再試行できます。all-or-nothing にはしません。D1 と R2 をまたいで巻き戻す仕組みを作らないという既存の方針（[D-012](#d-012-finalize-の保存確認は存在サイズ形式派生画像-metadata-とする)、[D-023](#d-023-d1-と-r2-の突合は-owner-が実行し自動で消すのは中断した-upload-の残りだけにする)）と同じです。

**結果の分類は HTTP status ではなく error code で行う。** 5 つに分けます。

| 分類 | 何が起きたか | 再試行 |
| --- | --- | --- |
| ok | 望む状態になった（元からその状態だった場合を含む） | 不要 |
| gone | `ASSET_NOT_FOUND`。別 member が完全に削除した | しない |
| skipped | `ASSET_TRASHED`。その写真には適用しない | しない |
| blocked | 操作そのものが成立していない | 出さない |
| failed | それ以外 | 出す |

`ALBUM_NOT_FOUND` は `ASSET_NOT_FOUND` と同じ 404 ですが、無いのは写真ではなく album です。写真 1 枚の問題として飲み込みません。同時に、同じ request をもう一度送っても album は戻らないので、再試行も出しません。`UNAUTHENTICATED` / `FORBIDDEN` / `ORIGIN_NOT_ALLOWED` / `VALIDATION_FAILED` / `SERVER_MISCONFIGURED` も同じ理由で blocked です。blocked のときは選択をそのまま残します。別の album を選び直せるようにするためです。

この区別は upload の batch が既に持っているもの（`settledFailure`）と同じ考え方です。「もう一度送れば変わるか」で分けます。

**favorite は toggle ではなく `true` / `false` を送る。** 再試行が状態を反転させないためです。server が 2xx を返した時点で望む状態になっているので、「変更した」と「既にその状態だった」を client は区別しません。

**破壊的な操作は件数を含む確認を通す。** 1 枚の trash は undo 付きの toast ですが（`ConfirmDialog` の「元に戻せる操作は toast」）、50 枚では toast 1 つで 50 件を戻すことになり、失敗した一部だけを戻す形にもなりません。まとめてゴミ箱へ送るときだけ、件数を書いた確認を出します。original は削除しません。既存の trash / restore / purge のままです。完全削除のまとめ操作は入れません。

**実行中は選択を凍結する。** 実行は開始時点の写真に対して行われます。その間に選択を変えられると、一度も送っていない写真が選択から消えたり、読者が外した写真が結果の書き戻しで戻ってきたりします。50 枚で 1〜2 秒なので、途中で選択を編集できる価値より、この race を無くす価値が上回ります。background job にはしません。

凍結は入口ごとに掛けます。checkbox と bar の各操作に加え、選択を抜ける Escape も実行中は効きません。control だけを disabled にすると keyboard から同じ race に入れます。

**album の一覧は選択を始めるたびに読み直す。** `ALBUM_NOT_FOUND` のときは選択を残して「別の album を選ぶ」で回復させるので、その menu が前回の一覧のままでは噛み合いません。cache を無効化する仕組みは作らず、選択の開始を読み直す契機にします。

**selection は view ごとの一時 state とする。** URL にも IndexedDB にも書きません。grid は view ごとに作り直されるので、view を移ると選択は消えます。view をまたぐ manager は作りません。年月の jump も選択を解除します（別の場所へ移動する操作なので）。pagination で page を足したときは保持します。

却下した案:

- bulk endpoint を先に作る: 測定が必要性を示していない。増えるのは partial result の契約と上限値と validation で、減るのは往復だけ
- client 側で重複排除してから送る: 別の member が同時に触るので、client の知識は必ず古くなりうる。album membership の uniqueness は既に server にある
- 汎用の job queue / undo history: [将来要件を先回りしない](../AGENTS.md#6-将来要件を先回りしない)

影響: 公開 API は変わりません。`pnpm bench` に bulk の測定が増えます。

残るリスク:

- 選択して操作するまでの間に別の member が写真を変えても、決めるのは server です。結果は写真ごとに `ASSET_NOT_FOUND` / `ASSET_TRASHED` として返り、件数で報告します。画面の選択が正しいことは前提にしていません
- 同じ写真に対する操作が 2 人から同時に届いた場合、どちらも冪等なので最後の状態に落ち着きます。どちらが先だったかは記録しません
- 失敗した写真が残ったまま画面を離れると、その選択は消えます。写真は操作前の状態のままで、もう一度選び直せます
- 操作は成功したのに直後の読み直しが失敗した場合、画面には古い tile が残ります。toast がそう伝えるので、再読み込みで直せます

再検討する条件:

- 1 回の選択が数百枚に伸びたとき
- 実機の往復時間で待ちが体感できるとき（先に測る。bulk endpoint はそのときの候補で、partial result の形は上のまま持ち込む）
