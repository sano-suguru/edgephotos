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

**状態:** 採用

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
