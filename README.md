# EdgePhotos

**Your photos. Your Cloudflare account. No server to manage.**

EdgePhotos は、あなた自身の Cloudflare アカウントへデプロイして使う、小さなセルフホスト型の写真ライブラリです。

VPS や NAS を運用せずに、家族の写真を自分の Cloudflare アカウントで管理したい人のために作っています。Google フォトの機能を全部そろえることは目指さず、写真の保存・閲覧・整理・共有と、データを自分で export / restore できることに範囲を絞ります。

> [!WARNING]
> 現在 **alpha** です（[段階の呼び方](docs/roadmap.md#段階の呼び方)）。
>
> EdgePhotos を写真の唯一の保存先にしないでください。別の場所に原本を残し、定期的に `pnpm backup export` と `pnpm backup check` を実行してください（[Backup と export](docs/operations.md#9-backup-と-export)）。

![EdgePhotos のタイムライン画面。撮影月ごとに写真が並ぶ](docs/images/timeline.png)

## できること

- 写真のアップロード
- タイムライン
- お気に入り
- アルバム
- ゴミ箱と完全削除
- 期限付き共有リンクと、その失効・再発行
- export / restore

## 初期版で扱わないもの

- 動画
- Live Photos
- RAW 現像
- 顔認識・AI 検索
- バックグラウンド自動同期
- 利用者ごとに分かれたライブラリ
- 任意クラウドへの抽象化
- EdgePhotos 自体の課金・サブスクリプション

## セットアップ

必要なもの:

- Workers / D1 / R2 / Cloudflare Access を利用できる Cloudflare アカウント
- Node.js 22.18 以上と pnpm（wrangler を動かすため、デプロイにも開発にも必要です）

リソースの作成、Access と R2 の設定、セットアップの確認までの手順は [運用・デプロイ・復元](docs/operations.md) にあります。

### 費用

EdgePhotos 自体は無料です。Cloudflare の料金は、保存容量と利用量で決まります。

| 月平均の R2 保存量 | Workers Free | Workers Paid |
| ---: | ---: | ---: |
| 10 GB | $0〜 | $5〜 |
| 100 GB | 約 $1.35〜 | 約 $6.35〜 |
| 500 GB | 約 $7.35〜 | 約 $12.35〜 |
| 1,000 GB | 約 $14.85〜 | 約 $19.85〜 |

R2 Standard の保存料金（10 GB-month / 月まで無料、超えた分は $0.015 / GB-month）と、Workers の plan 料金だけを足した概算です（2026-09 時点）。この表には、R2 の操作料金や Workers / D1 の超過料金は含みません。R2 の保存量には、写真本体に加えて表示用の derivative も含まれます。

Workers Free の CPU 上限は 1 request 10 ms です。現在の測定では、EdgePhotos がこの上限に安定して収まることを確認できていません。継続して使うなら Workers Paid を推奨します（[測定](docs/benchmarks.md#plan-に依存する注意)）。

最新の料金は [R2](https://developers.cloudflare.com/r2/pricing/) と [Workers](https://developers.cloudflare.com/workers/platform/pricing/) の料金ページを確認してください。

## ローカルで開発する

```bash
pnpm install
pnpm db:migrate:local
pnpm dev              # http://localhost:5173 （Access を模擬した household member として動作）
```

```bash
pnpm check            # typecheck + lint + db:check + cli:check + test + build
```

リポジトリ構成とテストの方針は [開発ガイド](docs/development.md) にあります。

## 写真ファイルの保存

EdgePhotos は、アップロード時に受け取った写真の byte 列を変更せず保存します。EdgePhotos 側で別の形式へ変換して置き換えることはありません。

ブラウザや写真ピッカーが、EdgePhotos へ渡す前にファイル形式を変換することはあります。その場合は変換後のファイルを保存し、画面にもその形式を表示します（[D-030](docs/decisions.md#d-030-heic--heif-の-original-を受け付けderivative-を作れる環境かは-probe-で決める)）。

## セキュリティ

- R2 bucket は private のまま使います
- ライブラリへのアクセスは Cloudflare Access で保護します
- 認証なしで写真を閲覧できるのは、明示的に作成した共有リンクからだけです。共有で渡すのは表示用の画像だけで、保存した写真ファイルそのものは渡しません
- household member の間に権限の区別はありません。どの member もライブラリ全体を削除・export できます

脅威モデルと秘密情報の扱いは [セキュリティ](docs/security.md) にあります。脆弱性の報告は [SECURITY.md](SECURITY.md) を参照してください。

## アーキテクチャ概要

```text
Web: Preact + Signals
        |
        | HTTP/JSON
        v
Cloudflare Access
        |
        v
Cloudflare Worker / Hono
   +---------+---------+
   |                   |
  D1               private R2
metadata        originals / derivatives

写真本体:
Web -- presigned PUT/GET --> R2
```

Worker は認証・認可、API、D1 の状態管理、R2 の保存確認、署名 URL の発行を担当します。写真バイナリは通常 Worker を経由せず、有効期限の短い presigned URL でクライアントと R2 の間を直接流れます。

詳細は [アーキテクチャ](docs/architecture.md) を参照してください。

### 設計上のトレードオフ

EdgePhotos は任意のクラウドへ移せる抽象化を持たず、Cloudflare に寄せて作ります。アプリケーションのデプロイ単位を 1 Worker に保てる代わりに、Cloudflare への lock-in を受け入れます（[D-003](docs/decisions.md#d-003-cloudflare-native-の-1-worker-構成とする)）。

<details>
<summary>技術スタック</summary>

| 領域 | 採用 |
| --- | --- |
| Web UI | Preact + `@preact/signals` |
| Build | Vite + Cloudflare Vite Plugin |
| Styling / UI | Tailwind CSS v4 + shadcn/ui + Base UI |
| API | Hono + `@hono/zod-openapi` |
| Database | Cloudflare D1 + Drizzle（schema・型・migration 生成） |
| Object storage | private Cloudflare R2 |
| Authentication | Cloudflare Access |
| Deployment | 1 Worker + Static Assets + D1 + R2 |

</details>

## ドキュメント

- [アーキテクチャ](docs/architecture.md) — 現在採用している構造と境界
- [セキュリティ](docs/security.md) — 認証・共有・秘密情報・データ保護
- [開発ガイド](docs/development.md) — リポジトリ構成、テスト、CI、開発ルール
- [運用・デプロイ・復元](docs/operations.md) — セットアップ、更新、backup / restore、監視と点検
- [設計判断](docs/decisions.md) — 重要な選択とその理由
- [検証記録](docs/verification.md) — 実環境と Browser で確認した内容
- [測定](docs/benchmarks.md) — scale と取り込み memory の数値
- [ロードマップ](docs/roadmap.md) — これからの実装順序と到達点
- [変更の記録](docs/changelog.md) — 完了した実装段階
- [AGENTS.md](AGENTS.md) — AI / 開発支援ツール向けの作業ガードレール

## ライセンス

MIT License
