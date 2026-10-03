# 開発ガイド

コードをどこに置き、どう検証し、どう変更するかの入口です。すべてをここで説明するわけではありません。

食い違ったときの正本は、動作は code と test、検証の結果は [verification.md](verification.md)、性能の数値は [benchmarks.md](benchmarks.md)、判断の理由は [decisions.md](decisions.md) です。詳しくは [ドキュメントの規約](#12-ドキュメントの規約) にあります。

## 1. 変更の進め方

通常の変更は次の流れで十分です。

```text
実装 -> 必要なテスト -> CI -> commit
```

構造を変える場合だけ、実装前に [decisions.md](decisions.md) へ理由と採用案を短く記録します。対象は、認証境界、API 境界、upload protocol、object layout、migration などです。

Issue、PR、ADR を変更ごとに義務化しません。

merge の前に、`pnpm check` と CI（Browser E2E を含む）が通っていることを確かめます。

変更ごとに最低限やること:

| 変更 | 最低限やること |
| --- | --- |
| 画面の見た目 | [design.md](design.md) の規則に合わせる。儀式的なテストは足さない |
| Browser でしか起きない挙動 | Browser E2E の spec を足すか直し、`pnpm test:e2e` |
| API | `src/worker/app.ts` の route schema を変え、integration test で固定する |
| D1 schema | [D1 / migration](#7-d1--migration) の手順 |
| 認証・認可（household の許可リストを含む）、upload finalize と重複、削除と復元、share の revoke、R2 key、migration、export / restore | 回帰テストが必須。一覧の正本は [AGENTS.md の「テストの厚さはリスクで決める」](../AGENTS.md#9-テストの厚さはリスクで決める) |
| `scripts/` の CLI | `pnpm cli:check`（`pnpm check` に含む） |
| 性能に効く変更 | `pnpm bench` で測り、[benchmarks.md](benchmarks.md) に記録する |

## 2. コードの置き場所

迷ったら次で決めます。細かい構成は repository そのものを見てください。

- 画面の機能: `src/web/features/`
- API: `src/worker/app.ts`（route と OpenAPI の契約）と `src/worker/services/`
- D1 schema: `src/worker/db/schema.ts`。migration は生成する（[D1 / migration](#7-d1--migration)）
- Worker と Browser が共有する schema と純関数: `src/contracts/`
- 共有ページ: `src/web/share/`（`share.html` の entry）。private app の画面や API client を import しない
- 運用の CLI: `scripts/`
- テスト: workerd 上は `tests/`、Browser は `e2e/`

route は今は `src/worker/app.ts` にまとめています。route が増えて見通しが悪くなったら `routes/` へ分けます。

`contracts/` に置くのは 2 種類だけです。Browser に配信してよい API の schema と型と、Worker と Browser が同じ結果を出す必要のある小さな純関数（manifest の組み立て、形式の判定）です。server secret の型や storage の credential を扱う実装は置きません。

`scripts/` は Node の型除去（type stripping）でそのまま実行します。相対 import には `.ts` を付け、parameter property など型除去で動かない構文を使いません。workerd の test は bundler を通すのでこの違いを検出できず、`pnpm cli:check` が CLI を実際に起動して確かめます。

## 3. Client state と Server state

Signals は、画面の中だけで完結する state とそこから派生する値に使います。選択中の asset、upload の進み具合、dialog の開閉、filter、件数などです。

保存が完了したかどうかの最終判定は Server が行います。Signals にその正しさを持たせません。

API の呼び出しは `fetch` を使う小さな client で書きます。data-fetching framework は、cache の無効化が実際に複雑になってから導入を検討します。

## 4. ローカル開発

```bash
pnpm install
pnpm db:migrate:local      # local D1 (.wrangler/state) に migration を適用
pnpm dev                   # http://localhost:5173
```

`pnpm dev` は Access を模擬し、`DEV_HOUSEHOLD_EMAILS`（既定 `you@localhost.test,partner@localhost.test`）の最初の member として API を呼べます（[D-016](decisions.md)）。値の形式は production の `HOUSEHOLD_EMAILS` と同じです。別の member として操作したいときは、先頭を入れ替えて起動し直します。

`APP_ORIGIN` は `http://localhost:5173` 固定です。`127.0.0.1` で開くと Origin check で書き込みが拒否されます。

`pnpm build && pnpm preview` は production build を local で起動します。Access や R2 の設定がないため、private API は `503` を返します。

## 5. UI primitive を足すとき

UI primitive は shadcn/ui + Base UI です。まだ使っていない component（Select、Combobox など）を足すときは、機能を作り込む前に Preact の production build で次を確かめます。

- build と typecheck が通る
- Signals で制御した state で動く
- keyboard で操作でき、閉じたあとに focus が戻る
- touch で操作できる

成り立たなければ、機能の実装より先に primitive の選定だけをやり直します。

Dialog と Menu の確認結果は [verification.md](verification.md#base-ui-の採用確認2026-09-16) にあります。

## 6. Hono / OpenAPI

API route は `@hono/zod-openapi` で schema と route の契約を定義します。同じ schema を runtime の検証、TypeScript の型推論、OpenAPI の生成に使います。

手書きの OpenAPI YAML と別の runtime schema を二重に管理しません。

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
- 既存データがある前提で migration を書く。CI は空の D1 に適用するだけなので、データを変換する migration を初めて書くときは fixture を足す
- `drizzle-kit push` / `drizzle-kit migrate` は使わない。適用は `wrangler d1 migrations apply` だけ
- production の migration を通常の test command から実行しない

`0001_initial` は Drizzle 導入前の特殊な baseline です。変更・改名・再生成をせず、journal の `idx: 1` も直しません。`uploads.asset_id` の UNIQUE を変える migration は手で直す必要があります。理由と既知の差は [migrations/README.md](../migrations/README.md) にあります。

## 8. テスト方針

### Unit

純粋な domain logic、hash / ID の検証、error の対応付けなど。

### Integration

Server の挙動を固定する中心の層です。特に次を重視します。

- upload の予約と finalize の冪等性
- D1 / R2 の片側だけの失敗
- authorization
- album membership
- share の revoke
- storage audit の分類とページ境界、cleanup が消してよいものだけを消すこと
- export / restore
- 差分 backup、backup の検査、restore の再開（どこで止まっても同じ結果になること）
- migration

integration test は `createApp()` に test 用の Access 鍵と local blob signer を注入します。D1 と R2 の binding は、実際の migration を適用したものを使います。D1 / R2 の障害は、binding を Proxy で包んで再現します。

### E2E（workerd）

全画面は網羅せず、重要な縦の経路を通します。`tests/e2e/vertical.test.ts` が HTTP だけで次を通します。

```text
auth -> upload -> ready -> timeline -> album -> share
```

### Browser E2E（Playwright）

workerd の test では見えない、Browser 固有の部分だけを対象にします。Server の挙動（認可、finalize の検査、share の検証など）は integration test が固定するので、ここでは再検査しません。判断が分かれたら integration test を優先します。

spec を増やすのは、Browser でしか起きない不具合を直したときだけです。

| spec | 守るもの | project |
| --- | --- | --- |
| `upload.spec.ts` | canvas での derivative 生成から finalize と表示まで（`useBrowserDerivatives` で Browser 経路に固定）。server 経路で page が decode しないこと。HEIC、URL の期限切れからの回復 | chromium, mobile-webkit |
| `share.spec.ts` | 共有リンクの発行から guest の閲覧、再発行・無効化まで | chromium |
| `keyboard.spec.ts` | Base UI の Dialog / Menu、viewer、複数選択の keyboard 操作と focus | chromium |
| `timeline.spec.ts` | 年月 navigation と複数選択 | chromium, mobile-webkit |
| `viewer.spec.ts` | preview の失敗表示、長い menu、情報 panel、original の保存 | chromium |
| `trash.spec.ts` | ゴミ箱・復元・album から外す操作と「元に戻す」 | chromium |
| `manage.spec.ts` | 「管理」と「メンテナンス」の表示 | chromium |
| `theme.spec.ts` | dark / light の配色 | chromium |
| `csp.spec.ts` | CSP が付き、違反する script と画像が拒否されること | chromium |
| `mobile.spec.ts` | phone 幅の layout、下部タブ、touch target、tap 操作 | mobile-webkit |

個々の確認内容は spec の test 名にあります。

```bash
pnpm exec playwright install --only-shell chromium webkit   # 初回のみ
pnpm test:e2e
```

`pnpm dev`（Access と presigned URL の模擬、[D-016](decisions.md)）を `.wrangler/e2e` の使い捨ての local D1 / R2 で起動します（`EDGEPHOTOS_STATE_DIR`）。普段の `pnpm dev` の library には触れません。port 5173 を使うため、`pnpm dev` を止めてから実行します。

spec の書き方:

- `--project` で 1 つだけ実行しても通るように書く。CI は chromium と mobile-webkit を別の runner で並列に実行し、それぞれが自分の dev server と library を持つ
- `e2e/fixtures.ts` の `test` を使う。page と guest の context で CSP 違反を集め、1 件でもあれば失敗にする。`vite dev` も production と同じ policy で動く（[D-037](decisions.md)）
- mock が画像を返すときは、`data:` URL ではなく同じ origin の URL を `page.route` で返す
- 写真は canvas で毎回ランダムに描き、fixture を commit しない
- Browser の対応を engine 名で分岐しない。HEIC の decode のように、同じ engine でも実行環境で結果が変わる（[verification.md](verification.md#heic--heif-の取り込み2026-09-22)）

### Scale benchmark

`pnpm bench` は `tests/bench/scale.bench.ts` を実行します。assert はしません。合成データで、主要 API の時間、SQL の query plan と rows_read、storage audit の全走査、backup / restore の request 数を表示します。結果と判断は [benchmarks.md](benchmarks.md) に記録します。

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

## 9. テスト用 fixture

実在の人物と実際の位置情報を使いません。画像は合成で作ります。

- workerd の test: `tests/helpers.ts` が合成 JPEG / PNG の byte 列（架空の EXIF GPS を含む）を組み立てる。Worker は画像を decode しないので、これで足りる
- server 側の derivative 生成（[D-042](decisions.md)）: workerd の test では Images と queue を in-memory の fake に差し替える（`AppOptions.derivatives`、`backgroundContext`）。障害は D1 / R2 を包む Proxy で注入する（`tests/integration/server-derivatives.test.ts`）。`vite dev` と Browser E2E は wrangler の local Images（sharp による低忠実度。HEIC は非対応）と local queue を使う
- Browser E2E: canvas で描いた JPEG
- HEIC: Browser で作れないため、合成画像から作った小さな HEIC だけを `tests/fixtures/` に commit している。生成手順は `tests/fixtures/README.md`。壊れた HEIC や brand 違いは実行時に組み立てる

Browser ごとの decode の差（orientation、透明 PNG、WebP、壊れた画像など）は常設の fixture にせず、一度きりの検証で確かめました（[verification.md](verification.md#browser-での取り込み2026-09-17)）。

Browser の差に起因する修正は、DOM に依存しない純関数へ切り出し、unit test で固定します（例: `tests/unit/web-image.test.ts` は WebKit が実際に出力した APP1 / APP13 の byte 列を含む）。

## 10. 環境分離

local、remote-test、production を分けます。復旧 drill 用に restore-test も置きます。restore した写真の複製は、drill ごとに消します（[復旧 drill](operations.md#14-復旧-drill)）。

D1、R2、Access application、署名用の credential を production と共有しません。

ローカル用の認証 bypass を production build に混ぜません。

## 11. CI

CI は typecheck、lint、`pnpm db:check`、`pnpm test`、build と、Browser E2E（Chromium と WebKit の別 job）を実行します。Cloudflare の credential を持たず、Remote の破壊操作を通常の test command に含めません。

GitHub Actions は commit SHA で固定します。Dependabot（`.github/dependabot.yml`）が npm と Actions の更新 PR を週 1 回作ります。

## 12. ドキュメントの規約

### どこに何を書くか

文書と実装が食い違う場合の優先順位を決めておきます。API 契約は `@hono/zod-openapi` の route schema、DB schema は適用済みの `migrations/*.sql`、`AppPrincipal` の具体的な型は実装の型定義、動作の細部は test を優先します。

実環境や Browser で確かめた結果は [verification.md](verification.md)、性能と memory の数値は [benchmarks.md](benchmarks.md) に書きます。operations / decisions / roadmap / README には検証の詳しい経過や測定値を重複して書かず、状態や判断に必要な短い要約とリンクだけを置きます。

画面の見た目と操作感の規則は [design.md](design.md) に書きます。

完了した実装段階の記録は [changelog.md](changelog.md)、これからの作業は [roadmap.md](roadmap.md)、v1 の完成条件に含めない制約は [limitations.md](limitations.md) に書きます。roadmap には終わった作業を残しません。

### 文章と表記

- 本文は日本語で書く。path と code identifier は英語のまま
- 製品名・固有名詞は原綴り（Cloudflare、Access、R2、D1、Preact、Hono、Vite など）
- コード上の名称と EdgePhotos 固有の用語は原綴りを使う。説明の文は自然な日本語を優先する。既存の文を、統一のためだけに書き換えない
- 短く書く。一文に論点を詰め込みすぎない。ただし字数や文の数で機械的に区切らない
- 節番号は `## N. 見出し` の 1 段だけ。`## N.1` を作らず、独立した節へ上げる。見出しは日本語を基本とし、固有名詞はラテン文字のまま（例: `## 7. D1 / migration`）。roadmap の段階名（Foundation、Release polish など）は、他文書から名前で参照する呼称なので原綴りのままとする
- 他の文書の一部を指すときは、節番号ではなく見出し名のリンクで書く
- 画面に出る文言は「」でくくる。code identifier と command は `` ` `` でくくる
