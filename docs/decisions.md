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

**状態:** 採用

finalize では Worker が R2 binding で次を確認してから asset を `ready` にします。

- reserve した 3 object がすべて存在する
- 各 object の size が reserve 時の申告値と一致する
- original の先頭 byte が申告 content type（JPEG / PNG / WebP）と一致する
- thumbnail / preview が JPEG で、APP1（EXIF / XMP）・APP13（IPTC）segment を含まない

original の SHA-256 は Client が reserve 時に申告し、重複判定の索引として使います。Worker は finalize 時に original 全体を hash しません。Workers の CPU 上限内で大きな original を毎回 hash するのは現実的でないためです。保存済み original の SHA-256 は backup / restore / verify（`pnpm backup`）で R2 から再取得して検証します。

したがって `assets.sha256` は **client-asserted content identity** です。server が byte 列から計算し直した verified identity ではありません。v1 は 1 owner で、脅威は「owner が自分自身に嘘をつく」ことになるため、この区別を許容します。将来 multi-user や untrusted client を扱う場合は、この前提が崩れるため再検討が必要です。

## D-013: presigned PUT は `If-None-Match: *` と `Content-Type` を署名対象にする

**状態:** 採用

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
  - `uploads.asset_id` の UNIQUE は SQL 側では column 制約（無名の autoindex）、snapshot では `uploads_asset_id_unique` という index。将来この制約を変える migration を生成した場合は、生成 SQL をそのまま使わず確認する
- production DB の再作成は不要

`wrangler` と `readD1Migrations` は `.sql` だけを読むため、`migrations/meta/` は適用対象になりません。
