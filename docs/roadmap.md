# ロードマップ

この文書は、v1 を完成させるための実装順序と各段階の到達点だけを管理します。

状態の凡例: ✅ 実装・自動テスト済み / 🟡 実装済みだが一部未検証 / ⬜ 未着手（2026-09-17 時点）設計の理由は [decisions.md](decisions.md)、不変条件は [architecture.md](architecture.md) と [security.md](security.md) を参照してください。

## Foundation

以後の feature を載せる共通基盤を作ります。

到達点:

- ✅ Web / Worker が同一 deployable unit として起動できる
- ✅ private API の認証・owner authorization が機能する
- ✅ D1 migration と private R2 binding が利用できる（local）
- ✅ OpenAPI を生成できる（`/api/v1/openapi.json`）
- 🟡 local / remote-test / production が分離されている（remote-test は D1 / R2 / Worker を作成・デプロイ済み。production は未作成）
- 🟡 shadcn/ui + Base UI の主要 component が Preact production build で成立する（Dialog / Menu の keyboard・focus と、phone 幅の tap は Browser E2E で自動化済み。Select は未使用、touch の実機は未確認）
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

- ✅ 実 Access で `/*` が owner 以外を拒否し、`/share/*` の Bypass が公開経路として機能する（Worker 側の owner check は unit test で担保。[verification.md](verification.md)）
- ✅ 実 R2 への presigned PUT / GET が Browser の CORS 越しに成立する（`Content-Type` と `If-None-Match` を含む）
- ✅ original の checksum 付き PUT（[D-018](decisions.md)）が実 R2 で機能する
- 🟡 スマートフォンで撮影した実写真（orientation・GPS・大きい画素数を含む）を 20〜30 枚 upload し、timeline の向きと表示を確認する（合成画像と実機由来の JPEG 1 枚で確認済み。カメラロール原本による確認は post-merge verification へ送る）

## Post-merge verification

merge を止める条件から外し、実際に使い始めてから確認する項目です。新機能の追加は伴いません。

- ⬜ 普段の入力経路でスマートフォン写真を数枚 upload し、timeline の orientation と preview を確認する
- ⬜ iPhone Safari の実機で、取り込みの memory と lifecycle を確認する（確認項目は [verification.md](verification.md) の「未検証」）
- ⬜ Android の実機で、同じ項目のうち該当するものを確認する
- ✅ 共有リンクを private window で開き、revoke 後に閲覧できないことを確認する
- ✅ remote で backup export → verify → 別の空環境への restore を 1 回成功させる

実測の詳細は [verification.md](verification.md) を正本とします。

## 既知の制約

v1 の完成条件には含めません。

**未完了 upload の cleanup は未実装。** finalize されなかった `uploads` row と R2 object は残ります。同じ写真を同時に finalize したときの重複側 object も、best effort の削除に失敗すれば残ります（[D-014](decisions.md)）。finalize されない upload は asset にならないため、写真のデータ整合性は壊れません。影響は R2 の料金、backup との容量差、diagnostics の WARN が常時出ることです。

現在は、期限切れの件数を diagnostics（ライブラリ画面と `pnpm diagnose`）で観測するだけです。R2 に残った object は D1 から分からないため数えていません。次のどちらかが続く場合に、Cron / Queues も候補に含めて cleanup 方式を検討します（[AGENTS.md](../AGENTS.md) §6）。

- `library: interrupted uploads` の件数が増え続ける
- R2 使用量が、export manifest の `originalSize` 合計を大きく上回る（thumbnail / preview の分の差は正常）

**WebP の EXIF は読まない。** WebP の `takenAt` は常に `null` です。EXIF orientation の適用も Browser で異なり、WebKit は適用し、Chromium は適用しません。

**途中で切れた JPEG の扱いが Browser で違う。** Chromium は拒否し、WebKit は読めた部分から derivative を作って original を保存します。

## Continuous-use hardening（2026-09-17）

新しい構成は足さず、測って弱点だけを直した段階です。詳細は [verification.md](verification.md) と [benchmarks.md](benchmarks.md) にあります。

- ✅ Browser 固有の経路の Playwright 自動化（[D-021](decisions.md)）
- ✅ read-only の設定診断 `pnpm diagnose`（[operations.md](operations.md) §7）
- ✅ 1,000 / 10,000 件の scale 測定
- ✅ Actions の SHA 固定、Dependabot、release / rollback / credential 更新 / 復旧 drill の手順（operations.md §8、§13、§14）
- ✅ 止まった完全削除の再開と、それに伴う再 upload の不具合の修正（[D-014](decisions.md)）
- ✅ 取り込みの並列数の上限修正（[D-020](decisions.md)）と、100MB 超の事前拒否
- ✅ 期限切れ upload の件数表示、`APP_ORIGIN` の不一致検出、撮影日時の offset が無い場合の扱いの明文化（architecture.md §6）

## Release polish

- Deploy to Cloudflare
- setup guide
- update / uninstall procedure
- screenshots / demo
- accessibility の基本確認
- 実機での client-side image processing 計測（desktop の Chromium / WebKit では計測済み。[benchmarks.md](benchmarks.md)）

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
