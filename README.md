# EdgePhotos

**Your photos. Your Cloudflare account. No server.**

EdgePhotos は、利用者自身の Cloudflare アカウントへデプロイする、サーバーレス・セルフホスト型の写真ライブラリです。

写真の保存・閲覧・整理・共有に必要な機能へ範囲を絞り、Cloudflare Workers、D1、R2、Access を使って構成します。

## 状態

**private alpha 候補（実装済み・実環境未検証）**。upload、timeline、favorite、album、期限付き共有と失効、trash と完全削除、export / restore を実装し、local の Workers runtime（Miniflare の D1 / R2）で自動テストしています。

ただし中核経路である Client → presigned URL → private R2 と Cloudflare Access の境界は、まだ実環境で踏んでいません。ここを通すまで private alpha として完成扱いにしません。残作業は [ロードマップ](docs/roadmap.md) の Remote integration verification を参照してください。

## ローカルで試す

Node.js 22.18 以上と pnpm が必要です。

```bash
pnpm install
pnpm db:migrate:local
pnpm dev              # http://localhost:5173 （Access を模擬した owner として動作）
```

```bash
pnpm check            # typecheck + lint + test + build
```

デプロイ手順と必要な設定は [運用・デプロイ・復元](docs/operations.md) を参照してください。

## 初期スコープ

含めるもの:

- 写真アップロード
- タイムライン
- お気に入り
- アルバム
- 期限付き共有リンク
- 共有の失効・再発行
- export / restore
- 安全な更新と migration

初期版に含めないもの:

- 動画
- Live Photos
- RAW 現像
- HEIC 変換
- 顔認識・AI 検索
- バックグラウンド自動同期
- 複数オーナー
- 任意クラウドへの抽象化
- 課金

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
Web / Future Native -- presigned PUT/GET --> R2
```

Worker は認証・認可、API、D1 の状態管理、R2 の保存確認、署名 URL の発行を担当します。写真バイナリは通常 Worker を経由せず、短命な presigned URL を使って Client と private R2 の間で直接転送します。

詳細は [アーキテクチャ](docs/architecture.md) を参照してください。

## 技術スタック

| 領域 | 採用 |
| --- | --- |
| Web UI | Preact + `@preact/signals` |
| Build | Vite + Cloudflare Vite Plugin |
| Styling / UI | Tailwind CSS v4 + shadcn/ui + Base UI |
| API | Hono + `@hono/zod-openapi` |
| Database | Cloudflare D1 |
| Object storage | private Cloudflare R2 |
| Authentication | Cloudflare Access |
| Deployment | 1 Worker + Static Assets + D1 + R2 |

## ドキュメント

- [アーキテクチャ](docs/architecture.md) — 現在採用している構造と境界
- [セキュリティ](docs/security.md) — 認証・共有・秘密情報・データ保護
- [開発ガイド](docs/development.md) — リポジトリ構成、テスト、CI、開発ルール
- [運用・デプロイ・復元](docs/operations.md) — セットアップ、更新、backup / restore
- [設計判断](docs/decisions.md) — 重要な選択とその理由
- [ロードマップ](docs/roadmap.md) — 実装順序と各段階の到達点
- [AGENTS.md](AGENTS.md) — AI / 開発支援ツール向けの作業ガードレール

## ライセンス

MIT License
