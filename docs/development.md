# 開発ガイド

コードをどこに置き、どう検証し、どう変更するかをまとめます。

## 1. 変更の進め方

通常変更は次の流れで十分です。

```text
実装 -> 必要なテスト -> CI -> commit
```

構造を変える場合だけ、実装前に [decisions.md](decisions.md) へ理由と採用案を短く記録します。対象は、認証境界、API 境界、upload protocol、object layout、migration 等です。

Issue、PR、ADR を変更ごとに義務化しません。

## 2. repository の構成

```text
index.html                 private app entry
share.html                 public share page entry
src/
  web/
    app.tsx                shell + routing
    main.tsx
    components/ui/         shadcn/ui-style wrappers (Button, Dialog, DropdownMenu on Base UI)
    features/
      uploads/  timeline/  albums/  shares/  settings/
    lib/
      api/client.ts        fetch client for /api/v1 (api/error.ts: ApiRequestError, DOM-free)
      image.ts             SHA-256, EXIF, canvas derivatives
      task-limit.ts        upload concurrency shared across selections
      original-limit.ts    original size limit checked before reading a file
      original-type.ts     original format from its first bytes (same check as finalize)
    share/main.tsx         share page (no private app code)
    state/router.ts
  worker/
    index.ts               Worker entry (dev-only wiring behind import.meta.env.DEV)
    app.ts                 Hono app: middleware + all route contracts (OpenAPI)
    auth/access.ts         Access assertion -> AppPrincipal
    http/                  errors, Origin check, security headers
    db/
      schema.ts            D1 schema (Drizzle) -> row types, simple queries, generated migrations
      index.ts             Db type + createDb (Drizzle over the D1 binding)
    services/              uploads / assets / albums / shares / export / storage-audit (query builder or explicit SQL)
    storage/               object keys, R2 presigner, finalize inspection, local blob emulation
  contracts/
    schemas.ts             zod schemas shared by Worker (runtime + OpenAPI) and Web (types only)
    export-manifest.ts     manifest format id, paged-export assembly, integrity rules (zod-free)
    image-type.ts          magic-byte format detection (finalize and Web)
    errors.ts
migrations/                D1 migrations (forward-only, applied by wrangler)
  meta/                    drizzle-kit snapshots / journal (generated; not applied)
drizzle.config.ts          drizzle-kit generate settings (no D1 credentials)
scripts/
  backup.ts                backup export / check / restore / verify CLI
  storage.ts               storage audit / cleanup CLI (`pnpm storage`)
  diagnose.ts              read-only setup diagnostics CLI (`pnpm diagnose`)
  cli-client.ts            API client for the CLIs (EDGEPHOTOS_URL / EDGEPHOTOS_ACCESS_TOKEN)
  cli-check.ts             starts the CLIs under Node type stripping (`pnpm cli:check`)
  db-check.ts              schema vs committed migrations drift check
  lib/backup.ts            API-based export / restore / verify (used by CLI and tests)
  lib/diagnose.ts          setup checks (used by CLI and tests)
  vite-dev-access.ts       dev server Access emulation
tests/
  unit/  integration/  e2e/   workerd tests (`pnpm test`)
  bench/                   scale measurements (`pnpm bench`, not part of `pnpm check`)
  helpers.ts               test app factory, signed assertions, synthetic image fixtures
e2e/                       real-browser tests (Playwright, `pnpm test:e2e`)
playwright.config.ts
```

route は現状 `src/worker/app.ts` に集約しています。route 数が増えて見通しが悪くなった時点で `routes/` へ分割します。

`contracts/` に置くのは 2 種類だけです。Browser bundle に公開してよい API schema / type と、Worker と Client が同じ結果を出す必要のある小さな純関数（manifest の組み立て、形式の判定）です。

server secret 型や storage credential 実装は置きません。

`scripts/` は Node の型除去（type stripping）でそのまま実行します。相対 import には `.ts` を付け、parameter property など型除去で動かない構文を使いません。

workerd の test は bundler を通すため、この違いを検出できません。`pnpm cli:check`（`pnpm check` に含む）が CLI を実際に起動して確かめます。

## 3. Preact / Signals

Signals は Client UI state と派生 state に使用します。

例:

- 選択中 asset
- upload progress
- dialog state
- filter
- derived count

Server state の正しさまで Signals に背負わせません。保存完了の最終判定は Server が行います。

v1 は `fetch` を使う小さな API client から始めます。data-fetching framework は、cache invalidation が実際に複雑になった場合のみ追加判断します。

## 4. ローカル開発

```bash
pnpm install
pnpm db:migrate:local      # local D1 (.wrangler/state) に migration を適用
pnpm dev                   # http://localhost:5173
```

`pnpm dev` は Access を模擬し、`DEV_HOUSEHOLD_EMAILS`（既定 `you@localhost.test,partner@localhost.test`）の最初の member として API を呼べます（[D-016](decisions.md)）。値の形式は production の `HOUSEHOLD_EMAILS` と同じです。member を切り替えた状態を見たい場合は、先頭を入れ替えて起動し直します。

`APP_ORIGIN` は `http://localhost:5173` 固定です。`127.0.0.1` で開くと Origin check で書き込みが拒否されます。

`pnpm build && pnpm preview` は production build を local で起動します。Access や R2 の設定がないため、private API は `503` を返します。

## 5. shadcn/ui + Base UI の採用条件

feature 実装前に、少なくとも次の component を Preact の production build で確認します。

- Dialog
- Menu / Dropdown
- Select または Combobox

確認項目:

- build できる
- Signals controlled state で動く
- keyboard navigation
- focus restore
- touch interaction
- TypeScript errors がない

不成立の場合は、feature code を積む前に UI primitive のみ再選定します。

確認結果（2026-09、`@base-ui/react` 1.8 + `preact/compat`）:

- Dialog / Menu: production build・TypeScript は成立。`e2e/keyboard.spec.ts` で自動化済み（focus trap、Escape、focus restore、Menu の矢印キー移動、Menu から Dialog を開いて Enter で送信）
  - `pnpm dev` 上の Chromium で確認した内容: Dialog の focus 移動、Escape で閉じる、trigger への focus restore、Menu の ArrowDown / Enter 操作と focus restore
- Select / Combobox: 現状の UI で未使用のため未確認
- touch interaction: iPhone 13 相当の viewport と touch（Playwright WebKit）で tap 操作を自動化済み（`e2e/mobile.spec.ts`）。実機では未確認

## 6. Hono / OpenAPI

API route は `@hono/zod-openapi` で schema と route contract を定義します。

同じ schema を以下に利用します。

- runtime validation
- TypeScript inference
- OpenAPI generation

手書き OpenAPI YAML と別の runtime schema を二重管理しません。

開発環境では OpenAPI JSON を取得できるようにし、本番では private area に置きます。

## 7. D1 / migration

D1 schema は `src/worker/db/schema.ts`（Drizzle）で定義します。方針は [D-017](decisions.md) です。

- row 型は `typeof table.$inferSelect` / `$inferInsert` から導出し、手書きしない
- 単純な CRUD は query builder で書く
- 複雑な query（相関 subquery、動的 filter、keyset pagination、集計など）は `sql` テンプレートの明示的な SQL で書く
- どちらも bind parameter を使う
- Repository / DAO / relational query API を作らない。service 関数から `ctx.db` を直接使う
- schema の property 名は column 名と同じ snake_case にし、ORM 側の値変換を使わない

schema を変える手順:

```bash
# 1. src/worker/db/schema.ts を変更
pnpm db:generate add_something   # migrations/000N_add_something.sql と migrations/meta/ を生成
# 2. 生成 SQL を review する（既存データ、NOT NULL 追加、table 再作成に注意）。必要なら手で直す
pnpm db:migrate:local
pnpm db:check && pnpm test
# 3. .sql と migrations/meta/ を commit
```

- migration は forward-only。適用済みの `.sql` を編集・改名しない
- 実際に適用されるのは commit した `migrations/*.sql` で、`schema.ts` と食い違う場合も `.sql` が優先される。一致は `pnpm db:check`（snapshot との差分）と `tests/integration/migrations.test.ts`（適用後の D1 との差分）で検証する
- 既存データがある前提で migration を書く
- `drizzle-kit push` / `drizzle-kit migrate` は使わない。適用は `wrangler d1 migrations apply` だけ
- production migration を通常の test command から実行しない

### baseline（`0001_initial`）

`0001_initial.sql` は Drizzle 導入前に手書きした migration で、baseline として扱います。

`0001_initial.sql` は変更しません。production の `d1_migrations` は file 名で記録されているため、改名や再生成もしません。

`migrations/meta/0001_snapshot.json` は、同じ schema を drizzle-kit で生成した snapshot です。journal の entry は `idx: 1` / `tag: 0001_initial` です。drizzle-kit は次の番号を「最後の idx + 1」で決めるため、以後の migration は `0002_*` から始まります。この journal を `idx: 0` へ「直さない」でください。

`0001_initial.sql` と snapshot の差は次の 2 点だけで、どちらも既存データに影響しません。

- SQL 側の TEXT PRIMARY KEY は `NOT NULL` を明示していない（SQLite の歴史的仕様で NULL を受け付ける）。snapshot は `NOT NULL` として扱う。app は常に id を指定する
- `uploads.asset_id` の UNIQUE は、SQL 側では column 制約（無名の autoindex）、snapshot では `uploads_asset_id_unique` という index

この差が原因で生成 SQL が誤っていれば CI で分かります。test の setup は空の D1 へ `0001` から順に全 migration を適用し、drift test が `schema.ts` と比較します。生成 migration は毎回「0001 適用済みの DB に対する rehearsal」を通ります。

rehearsal が保証するのは、DDL として適用できることだけです。table は空なので、既存データの保存（table 作り直し時の列の対応、値の変換、NOT NULL や CHECK の強化）は検証しません。データを変換する migration を初めて書くときは、その migration 用の fixture を追加します。

例: `asset_id` の `.unique()` を外して生成すると `DROP INDEX uploads_asset_id_unique;` になり、setup が `no such index` で失敗します。table を作り直す migration（`__new_uploads` を作ってコピーし、rename する）に手で直すと通ります。

`wrangler` と `readD1Migrations` は `.sql` だけを読むため、`migrations/meta/` は適用対象になりません。

## 8. テスト方針

### Unit

純粋な domain logic、hash / ID validation、error mapping 等。

### Integration

特に次を重視します。

- upload reservation
- finalize idempotency
- D1 / R2 partial failure
- storage audit の分類とページ境界、cleanup が消してよいものだけを消すこと
- 差分 backup、backup の検査、restore の再開（呼び出しのどこで止まっても同じ結果になること）
- authorization
- album membership
- share revoke
- migration
- export / restore

### E2E（workerd）

全画面網羅ではなく、重要な縦経路を優先します。

```text
auth
-> upload
-> ready
-> timeline
-> album
-> share
```

`tests/e2e/vertical.test.ts` が HTTP だけでこの経路を通します。

### Browser E2E（Playwright）

workerd の test では見えない、Browser 固有の部分だけを対象にします。Server の挙動（認可、finalize の検査、share の検証など）は integration test が固定します。Browser E2E では再検査せず、判断が分かれた場合も integration test を優先します。

| spec | 確認すること | project |
| --- | --- | --- |
| `upload.spec.ts` | file input → canvas で作った derivative（512 / 2048 の上限）→ finalize 成功（WebKit の APP1 / APP13 除去を含む）→ timeline と viewer の表示。HEIC は decode できる engine（WebKit）で形式と向きまで確認し、できない engine（Chromium）では拒否の文言を確認する。HEIC を名乗る壊れた bytes はどちらでも拒否される。presigned URL の期限切れ後に画像が回復すること。全件完了したアップロード表示だけが数秒後に消えること（実行中・失敗ありでは残る） | chromium, mobile-webkit |
| `share.spec.ts` | album 作成 → viewer の menu から追加 → 共有リンク → 別 context の guest が閲覧（secret は Authorization header だけ、Cookie なし。thumbnail URL の期限切れから回復）→ 拡大表示の focus（閉じるボタンへ移り、Tab でも dialog 内に留まり、閉じると元の写真へ戻る）→ 再発行・無効化の確認 dialog（キャンセル・Escape では何も変わらない）→ 旧リンクと無効化したリンクは無効表示 | chromium |
| `keyboard.spec.ts` | Base UI の Dialog / Menu の keyboard 操作と focus。viewer の ←/→ での移動（Menu 内では写真が変わらない）と、閉じたあとに最後の写真へ focus が戻ること | chromium |
| `viewer.spec.ts` | preview の取得失敗・読み込み失敗で「高画質で表示できませんでした」と再試行が出ること。album が多い menu が画面内に収まり、keyboard で末尾までスクロールできること | chromium |
| `mobile.spec.ts` | iPhone 相当の viewport で横スクロールがないこと、下部タブが scroll 後も画面内にあり、ゴミ箱へはライブラリから行け、ゴミ箱ではライブラリのタブが現在地になり戻れること、Undo toast のボタンが 44px 以上で離れていること、共有 dialog の入力欄が 16px 以上であること、tap で viewer（写真が画面幅か高さいっぱい）・共有 dialog が開き、画面内に収まること | mobile-webkit |

```bash
pnpm exec playwright install --only-shell chromium webkit   # 初回のみ
pnpm test:e2e
```

`pnpm dev`（Access と presigned URL の模擬、[D-016](decisions.md)）を `.wrangler/e2e` の使い捨て local D1 / R2 で起動します（`EDGEPHOTOS_STATE_DIR`）。普段の `pnpm dev` の library には触れません。

port 5173 を使うため、`pnpm dev` を止めてから実行します。写真は Browser の canvas で毎回ランダムに描くので、fixture を commit しません。

spec を増やすのは、Browser でしか起きない不具合を直したときだけにします。

### Scale benchmark

`pnpm bench` は `tests/bench/scale.bench.ts` を実行します。assert はしません。

合成データで表示するのは、主要 API の時間、SQL の query plan と rows_read、storage audit の全走査、backup / restore の request 数です。

結果と判断は [benchmarks.md](benchmarks.md) に記録します。

```bash
pnpm bench                                                        # 1,000 / 10,000 件
BENCH_SIZES=100000 BENCH_BACKUP_MAX=0 BENCH_BIG_ALBUM=50000 pnpm bench   # 10 万件（seed だけで約 5 分）
```

### 時間制限

test の時間制限は `vitest.config.ts` の `testTimeout` / `hookTimeout` で一括して決めます（現在 120 秒）。test ごとの上書きは書きません。

この制限は、止まってしまった test を打ち切るためのものです。速さを固定するためのものではありません。性能は `pnpm bench` で測り、[benchmarks.md](benchmarks.md) に記録します。時間制限を性能の assert として使うと、CI の速度差が「コードの欠陥ではない赤」になります（[D-029](decisions.md)）。

値は、CI で観測した最遅の test の約 4 倍に取っています。CI runner の速度は同じコードでも run ごとに 3 倍以上ぶれます（[verification.md](verification.md#ci-の時間制限2026-09-21)）。

test が制限に掛かったら、まず「本当に止まっているのか、CI が遅いだけなのか」を測ってから直します。遅い test を速くする必要が出たときは、制限を上げるのではなく test の作り方を変えます。

### 実行

```bash
pnpm test        # unit + integration + e2e（workerd 上、D1 / R2 は Miniflare の local emulation）
pnpm test:e2e    # Browser E2E（Chromium と WebKit）
pnpm db:check    # schema.ts と migrations/meta の snapshot が一致するか
pnpm cli:check   # CLI が Node の型除去で起動するか
pnpm check       # typecheck + lint + db:check + cli:check + test + build
```

integration test は `createApp()` に test 用の Access 鍵と local blob signer を注入します。D1 と R2 binding は、実際の migration を適用したものを使います。

D1 / R2 の障害は、binding を Proxy で包んで再現します。

## 9. テスト用 fixture

実人物・実位置情報を使いません。

用意する合成 fixture:

- 通常 JPEG
- EXIF orientation 各種
- 架空 GPS 付き JPEG
- timezone 不明日時
- 透明 PNG
- WebP
- 壊れた画像
- 拡張子偽装
- 上限付近のサイズ / 画素数

original の期待 SHA-256 を fixture metadata として固定します。

現状の自動テストは、Worker が decode しない前提で `tests/helpers.ts` が合成 JPEG / PNG の byte 列（架空の EXIF GPS segment を含む）を生成して使います。Browser E2E は canvas で描いた JPEG を使います。

HEIC だけは Browser で作れないので、合成画像から作った小さな HEIC を 2 つ commit しています（`tests/fixtures/`、計 1.7KB、実人物・実位置情報なし）。生成手順は `tests/fixtures/README.md` にあります。workers の test runtime には fs がないため、`vitest.config.ts` が base64 の binding として渡します（`TEST_MIGRATIONS` と同じ経路）。E2E は同じファイルを `readFileSync` で読みます。壊れた HEIC や brand 違いは、実行時に byte 列を組み立てて作り、commit しません。

orientation、透明 PNG、WebP、壊れた画像などの decode 差は、下記の一度きりの検証で確認済みで、常設の fixture にはしていません。

Browser での取り込み検証（decode、orientation、derivative、memory）は、公開されている実機サンプルと合成画像を使いました。scratch 環境で一度きりの Playwright script として実施し、fixture も script も commit していません。

結果は [verification.md](verification.md) に、memory の数値は [benchmarks.md](benchmarks.md) にあります。

Browser 差に起因する修正は、DOM に依存しない純関数へ切り出し、unit test で固定します（`tests/unit/web-image.test.ts`。WebKit が実際に出力した APP1 / APP13 の byte 列を含みます）。

## 10. 環境分離

最低限次を分離します。

- local
- remote-test
- production

D1、R2、Access application、signing credential を production と共有しません。

ローカル用の認証 bypass を production build に混ぜません。

## 11. CI

最初は次だけで十分です。

- typecheck
- lint / format check
- schema と migration の drift check（`pnpm db:check`）
- unit / integration tests
- production build
- Browser E2E（別 job。Chromium と WebKit）

GitHub Actions は commit SHA で固定します。Dependabot（`.github/dependabot.yml`）が npm と Actions の更新 PR を週 1 回作ります。

Remote の破壊操作を通常の test command に含めません。CI は Cloudflare の credential を持ちません。

## 12. ドキュメントの規約

### どこに何を書くか

文書と実装が食い違う場合の優先順位を決めておきます。API 契約は `@hono/zod-openapi` の route schema、DB schema は適用済みの `migrations/*.sql`、`AppPrincipal` の具体的な型は実装の型定義、動作の細部は test を優先します。

実環境や Browser で確かめた結果は [verification.md](verification.md)、性能と memory の数値は [benchmarks.md](benchmarks.md) に書きます。operations / decisions / roadmap / README には検証の詳しい経過や測定値を重複して書かず、状態や判断に必要な短い要約とリンクだけを置きます。

完了した実装段階の記録は [changelog.md](changelog.md)、これからの作業は [roadmap.md](roadmap.md) に書きます。

### 文章と表記

- 本文は日本語で書く。path と code identifier は英語のまま
- 製品名・固有名詞は原綴り（Cloudflare、Access、R2、D1、Preact、Hono、Vite など）
- コード上の名称と EdgePhotos 固有の用語は原綴りを使う。説明の文は自然な日本語を優先する。既存の文を、統一のためだけに書き換えない
- 短く書く。一文に論点を詰め込みすぎない。ただし字数や文の数で機械的に区切らない
- 節番号は `## N. 見出し` の 1 段だけ。`## N.1` を作らず、独立した節へ上げる。見出しは日本語を基本とし、固有名詞はラテン文字のまま（例: `## 7. D1 / migration`）。roadmap の段階名（Foundation、Release polish など）は、他文書から名前で参照する呼称なので原綴りのままとする
- 他の文書の一部を指すときは、節番号ではなく見出し名のリンクで書く
- 画面に出る文言は「」でくくる。code identifier と command は `` ` `` でくくる
