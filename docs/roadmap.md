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
- ✅ `/share/*` の公開経路と private path の Access 保護を実環境で検証できる
- ✅ R2 presigned PUT / GET と CORS を実環境で検証できる

## Feature 1: Upload + Timeline

到達点:

- ✅ owner が写真を upload できる
- ✅ upload 完了後に timeline へ表示される
- ✅ original / thumbnail / preview が想定した経路で保存・取得できる（実 R2 で確認済み。PUT / GET とも Browser から R2 へ直行し、Worker は本体を中継しない）
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
- ✅ 別の空環境へ restore できる（local の別 D1 / R2 で自動テスト済み、実環境でも `edgephotos-restore-test` へ実測済み）
- ✅ restore 後に asset 数、hash、album 関係を検証できる

この段階を外部 alpha の前提とします。

## Remote integration verification

コードではなく、実 Cloudflare 環境で境界を踏むための段階です。ここを通過するまで private alpha を「完成」とは扱いません。

到達点:

- ✅ 実 Access で `/*` が owner 以外を拒否し、`/share/*` の Bypass が公開経路として機能する
- ✅ 実 R2 への presigned PUT / GET が Browser の CORS 越しに成立する（`Content-Type` と `If-None-Match` を含む）
- ⬜ スマートフォンで撮影した実写真（orientation・GPS・大きい画素数を含む）を 20〜30 枚 upload し、timeline の向きと表示を確認する
- ✅ 共有リンクを private window で開き、revoke 後に閲覧できないことを確認する
- ✅ remote で backup export → verify → 別の空環境への restore を 1 回成功させる

実測の詳細は [operations.md](operations.md) 冒頭の検証状況を正本とします。

## 既知の制約

v1 の完成条件には含めませんが、後から迷わないよう記録します。

**失敗した upload の行が残り続ける。** `reserve` 済みで finalize されなかった `uploads` row は削除されません。`expires_at` は書き込まれますが現状どこからも読まれず、期限切れ row を掃除する経路もありません。R2 object が残る場合も同様です。

これはデータの汚れであって、認証やデータ整合性の問題ではありません。`finalizeUpload()` は R2 に object が実在することを確認してから `ready` にするため、期限切れ reserve を後から finalize しようとしても presigned URL が R2 側で失効しており PUT が通りません。

自動 cleanup を始めると Cron / Queues へスコープが広がるため、要求か測定結果が出るまで着手しません（[AGENTS.md](../AGENTS.md) §6）。

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
- 失敗した upload の cleanup（「既知の制約」参照。`expires_at` を使うか、定期実行を入れるかを含めて未定）
