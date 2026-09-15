# 開発ガイド

この文書は、EdgePhotos のコードをどこに置き、どう検証し、どう変更するかを定義します。

## 1. 変更の進め方

通常変更は次の流れで十分です。

```text
実装 -> 必要なテスト -> CI -> commit
```

認証境界、API 境界、upload protocol、object layout、migration 等の構造を変える場合だけ、実装前に [decisions.md](decisions.md) へ理由と採用案を短く記録します。

Issue、PR、ADR を変更ごとに義務化しません。

## 2. Repository layout

初期構成は次を基準とします。

```text
src/
  web/
    app.tsx
    components/
      ui/
    features/
      uploads/
      timeline/
      albums/
      shares/
    lib/
      api/
    state/

  worker/
    index.ts
    auth/
    routes/
      uploads/
      assets/
      albums/
      shares/
      export/
    services/
    storage/
    db/

  contracts/
    schemas/
    errors.ts

migrations/
tests/
  unit/
  integration/
  e2e/
  fixtures/

docs/
```

`contracts/` には Browser bundle に公開してよい API schema / type だけを置きます。server secret 型や storage credential 実装を置きません。

## 3. Preact / Signals

Signals は Client UI state と派生 state に使用します。

例:

- 選択中 asset
- upload progress
- dialog state
- filter
- derived count

Server state の正しさまで Signals に背負わせません。保存完了の最終判定は Server が行います。

v1 は `fetch` を使う小さな API client から始めます。data-fetching framework は cache invalidation が実際に複雑になった場合のみ追加判断します。

## 4. shadcn/ui + Base UI qualification

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

## 5. Hono / OpenAPI

API route は `@hono/zod-openapi` で schema と route contract を定義します。

同じ schema を以下に利用します。

- runtime validation
- TypeScript inference
- OpenAPI generation

手書き OpenAPI YAML と別の runtime schema を二重管理しません。

開発環境では OpenAPI JSON を取得できるようにし、本番では private area に置きます。

## 6. D1 / Migration

D1 access は explicit SQL と prepared statements を使用します。

- migration は forward-only
- DB schema の正本は migration
- 既存データがある前提で migration を書く
- production migration を通常の test command から実行しない

## 7. Test strategy

### Unit

純粋な domain logic、hash / ID validation、error mapping 等。

### Integration

特に次を重視します。

- upload reservation
- finalize idempotency
- D1 / R2 partial failure
- authorization
- album membership
- share revoke
- migration
- export / restore

### E2E

全画面網羅ではなく、重要な縦経路を優先します。

```text
auth
-> upload
-> ready
-> timeline
-> album
-> share
```

見た目だけの変更へ儀式的なテストを増やしません。

## 8. Test fixtures

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

## 9. 環境分離

最低限次を分離します。

- local
- remote-test
- production

D1、R2、Access application、signing credential を production と共有しません。

ローカル用の認証 bypass を production build に混ぜません。

## 10. CI

最初は次だけで十分です。

- typecheck
- lint / format check
- unit / integration tests
- production build

Remote の破壊操作を通常の test command に含めません。

## 11. Documentation rule

ドキュメント本文は日本語、path と code identifier は英語を基本とします。

API の詳細は OpenAPI、DB の詳細は migration、動作の細部は test を正本とします。
