# ロードマップ

この文書は、v1 を完成させるための実装順序と各段階の到達点だけを管理します。

状態の凡例: ✅ 実装・自動テスト済み / 🟡 実装済みだが一部未検証 / ⬜ 未着手（2026-09-16 時点）設計の理由は [decisions.md](decisions.md)、不変条件は [architecture.md](architecture.md) と [security.md](security.md) を参照してください。

## Foundation

以後の feature を載せる共通基盤を作ります。

到達点:

- ✅ Web / Worker が同一 deployable unit として起動できる
- ✅ private API の認証・owner authorization が機能する
- ✅ D1 migration と private R2 binding が利用できる（local）
- ✅ OpenAPI を生成できる（`/api/v1/openapi.json`）
- 🟡 local / remote-test / production が分離されている（remote-test は D1 / R2 / Worker を作成・デプロイ済み。production は未作成）
- 🟡 shadcn/ui + Base UI の主要 component が Preact production build で成立する（Dialog / Menu は確認済み、Select と touch は未確認）
- ⬜ `/share/*` の公開経路と private path の Access 保護を実環境で検証できる
- ⬜ R2 presigned PUT / GET と CORS を実環境で検証できる（署名形式は unit test 済み）

## Feature 1: Upload + Timeline

到達点:

- ✅ owner が写真を upload できる
- ✅ upload 完了後に timeline へ表示される
- 🟡 original / thumbnail / preview が想定した経路で保存・取得できる（local blob 模擬で確認、実 R2 は未検証）
- ✅ refresh 後も状態が一貫する

## Feature 2: Favorite + Albums

到達点:

- ✅ favorite を切り替えられる
- ✅ album を作成・変更・削除できる
- ✅ asset を album へ追加・削除できる

## Feature 3: Sharing

到達点:

- ✅ album の共有リンクを発行できる
- ✅ expiry、revoke、regenerate が機能する
- ✅ guest は許可された thumbnail / preview のみ閲覧できる

## Feature 4: Delete + Restore

到達点:

- ✅ asset を trash へ移動・復元できる
- ✅ permanent delete を明示操作として実行できる
- ✅ 中断した purge を再開できる

## Feature 5: Export + Restore

到達点:

- ✅ metadata と original manifest を export できる
- 🟡 別の空環境へ restore できる（local の別 D1 / R2 で自動テスト済み、実環境での実測は未実施）
- ✅ restore 後に asset 数、hash、album 関係を検証できる

この段階を外部 alpha の前提とします。

## Release polish

- Deploy to Cloudflare
- setup guide
- update / uninstall procedure
- screenshots / demo
- accessibility の基本確認
- 実機での client-side image processing 計測

## Future

v1 の完成条件には含めません。

- Android client
- Managed OAuth integration for Native client
- background sync
- HEIC
- video
- multi-user
- advanced search
- Queues / background processing
- client-specific adapter / BFF
