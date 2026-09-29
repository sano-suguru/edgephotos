# AGENTS.md

EdgePhotos を変更する AI エージェントと開発支援ツール向けのガードレールです。

設計理由の正本ではありません。作業中に破ってはいけない条件と、変更時に確認すべき文書だけを記載します。理由はリンク先にあります。

## 1. アーキテクチャ上の不変条件

- original は変更・再エンコード・上書きしない
- R2 bucket を public にしない
- upload は `reserve -> presigned PUT -> finalize` とする
- Worker が R2 保存状態を確認する前に asset を `ready` にしない
- finalize の再送で asset を重複作成しない
- object key に元ファイル名、メールアドレス、撮影日、share secret を含めない
- Web 専用の application API を作らない
- API 契約は HTTP/JSON + OpenAPI を基本とする
- private API は認証設定が壊れた場合も fail-closed とする
- share では original を配信しない
- share secret の平文を D1 へ保存しない

## 2. 秘密情報と実データ

- production secret を commit しない
- JWT、share secret、presigned URL、API key をログへ出さない
- production D1 / R2 をローカルテストや CI から参照しない
- 家族写真、顔写真、実 GPS 情報を fixture にしない
- デバッグ情報を AI へ渡す場合も secret、署名 query、実写真を含めない

## 3. 認証の境界

Cloudflare Access 固有の token / assertion / Cookie を、認証後の処理へ直接持ち込まないでください。

HTTP 層で検証し、正規化した principal だけを渡します。`AppPrincipal` の定義はアーキテクチャの [認証境界](docs/architecture.md#3-認証境界) にあります。文書と型定義が食い違っていたら、型定義を現在の挙動として扱い、同じ変更で文書を直します。

利用者は 1 つの household（対等な少人数の member）です。Access を通過した全員を member と扱わないでください。許可する identity は Worker 側でも必ず照合します（[D-028](docs/decisions.md)）。

member を区別する権限や、asset ごとの所有者を持ち込まないでください。

## 4. ストレージ

R2 key の規約:

```text
originals/{assetId}
derivatives/v1/{assetId}/thumbnail.jpg
derivatives/v1/{assetId}/preview.jpg
```

派生画像の生成規則を将来変更する場合は derivative version を追加し、original を変更しません。

D1 と R2 を単一 transaction として扱わず、片側だけ成功する異常系を前提にしてください。

D1 schema は `src/worker/db/schema.ts` で変更し、`pnpm db:generate <name>` で生成した SQL を review して commit します。

適用済みの `migrations/*.sql` と `migrations/meta/_journal.json` の baseline entry（`idx: 1`）は書き換えないでください。`drizzle-kit push` は使いません。

client と backup manifest の互換性（[D-035](docs/decisions.md)）:

- alpha の間は、以前の alpha の形式との互換を保たなくてよい。形式を変えたら reader も同じ変更で変える。保存済みのデータは migration で引き継ぐ
- v1 release 以降に出た manifest version の reader を削除しない
- manifest は未知の key を拒否する

## 5. 採用済み構成を勝手に置き換えない

ユーザーが明示的に求めていない限り、`docs/decisions.md` に記録された採用構成を別 framework / service へ置き換えないでください。置き換える場合は、実装より先に Decision Log を更新します。

- Preact / Signals / Vite
- Tailwind CSS v4 / shadcn/ui + Base UI
- Hono / `@hono/zod-openapi`
- Cloudflare D1 / private R2 / Access
- Drizzle（D1 の schema・型・migration 生成に限定。[D-017](docs/decisions.md)）
- 1 Worker + Static Assets
- HTTP/JSON + OpenAPI の API boundary

## 6. 将来要件を先回りしない

現在の要求や測定結果がないまま、次を追加しないでください。

- client-specific BFF
- Queues
- Durable Objects
- Cron
- multi-cloud provider abstraction
- generic repository pattern
- plugin framework
- user ごとに分かれた library を持つ multi-user model
- Android 専用 API
- 独自認証サーバー
- telemetry SaaS

これは禁止リストではなく、導入条件です。「将来必要かもしれない」「一般的にこの構成で使う」という理由だけでは追加しません。現在の構成では解決できない要求・障害・運用負荷・性能問題・測定結果が確認できたら、候補から外さずに最小で分かりやすい解決策として評価します。

導入するときは、現在の構成で足りない点、具体的に良くなる点、増える運用・障害・保守のコストを `docs/decisions.md` に記録します。

## 7. 作業前に読むもの

通常の UI 修正など、アーキテクチャに影響しない変更で全ドキュメントを読み直す必要はありません。

構造を変更する作業では、最低限次を確認してください。

1. `docs/architecture.md`
2. `docs/security.md`
3. `docs/decisions.md`
4. `docs/development.md`

## 8. 変更時のドキュメント更新

| 変更する対象 | 更新する文書 |
| --- | --- |
| 認証境界、API 境界、upload protocol、object layout | `docs/architecture.md` と `docs/decisions.md` |
| 脅威モデル、公開範囲、secret の扱い | `docs/security.md` |
| 開発フロー、test、CI、repository layout | `docs/development.md` |
| デプロイ、migration、backup / restore | `docs/operations.md` |
| 優先順位や feature scope | `docs/roadmap.md` |
| v1 の完成条件に含めない制約 | `docs/limitations.md` |
| 実環境や Browser で確かめた結果 | `docs/verification.md`（性能と memory の数値は `docs/benchmarks.md`） |
| 完了した実装段階 | `docs/changelog.md` |

verification.md で状態が変わったら、同じ変更で冒頭の「現在の状態」の表も直します。

検証の詳しい経過・証拠・測定値を operations / decisions / roadmap / README へ重複して書かないでください。これらの文書には、状態や判断に必要な短い要約だけを置き、詳細は verification / benchmarks へリンクします。

UI の余白変更などで Decision Log を追加しないでください。

文章と表記の規約は開発ガイドの [ドキュメントの規約](docs/development.md#13-ドキュメントの規約) にあります。

## 9. テストの厚さはリスクで決める

特に次を変える場合は回帰テストを必須とします。

- authentication / authorization（household の許可リストを含む）
- upload finalize
- duplicate handling
- delete / restore
- share revoke
- R2 key generation
- migration
- export / restore

見た目だけの変更へ儀式的なテストを増やす必要はありません。

## 10. 開発プロセス

変更の進め方は `docs/development.md` に従います。この文書と食い違っていたら `docs/development.md` に従って作業し、同じ変更でこの文書を直します。

機能スコープは小さくしてよい一方、重要な認証・データ・API 境界を「後で置き換える前提の仮実装」にしないでください。
