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

v1 の完成条件には含めませんが、後から迷わないよう記録します。

**失敗した upload の行が残り続ける。** `reserve` 済みで finalize されなかった `uploads` row は削除されません。期限切れ row を掃除する経路はありません。R2 object が残る場合も同様です。`expires_at` を過ぎた件数だけは diagnostics（ライブラリ画面と `pnpm diagnose`）で分かります。R2 に残った object の量は、D1 から分からないため数えていません。

写真のデータ整合性は壊れません。finalize されていない upload は asset にならず、timeline・album・share・export のどれにも出ないためです。`finalizeUpload()` は R2 に object が実在することを確認してから `ready` にします。期限内に PUT が済んでいれば、期限後の finalize も成立します（background に回した tab の復帰を拒否しないため、finalize は期限を見ません）。PUT が済んでいない reserve は、presigned URL が失効しているため後から完了できません。

ただし、運用には影響します。残骸が増えるほど、次の問題が大きくなります。

- R2 の保存料金が増える
- R2 の使用量と backup の大きさが一致しなくなる
- diagnostics の WARN が常に出て、新しい異常に気付きにくくなる
- 後で cleanup するときに、消してよい object の判定が難しくなる

同じ写真の upload を同時に finalize した場合、重複になった側の object も残ることがあります。D1 に重複と記録したあと best effort で削除するだけで、削除の失敗は再試行しないためです（[D-014](decisions.md)）。

現時点では、残骸がどの程度発生するかを測れておらず、自動 cleanup の要求も出ていません。そのため diagnostics で件数を観測するだけに留めています（[AGENTS.md](../AGENTS.md) §6）。実利用で残骸が増え続け、運用上の問題になった場合は、Cron / Queues なども候補に含めて最小の cleanup 方法を選びます。判断の目安は次の 2 つです。

- `library: interrupted uploads` の件数が増え続ける
- Cloudflare Dashboard の R2 使用量が、export manifest の `originalSize` の合計を大きく上回る。manifest には thumbnail / preview の size が無いので、その分の差は正常

**WebP の EXIF は読まない。** `exifr` は WebP の EXIF を解析しないため、WebP の `takenAt` は常に `null` です。WebP の EXIF orientation は、WebKit では適用され、Chromium では適用されません。そのため同じ WebP でも、Browser によって width / height と derivative の向きが変わります。カメラが WebP を出力することはまれなので、v1 では扱いません。

**途中で切れた JPEG の扱いが Browser で違う。** Chromium は decode 失敗として拒否します。WebKit は読めた部分だけで derivative を作り、切れた byte 列をそのまま original として保存します。

## Continuous-use hardening（2026-09-17）

private alpha を継続利用に近づけるための段階です。新しい構成は足さず、測って弱点だけを直しました。

- ✅ Browser 固有の経路を Playwright で自動化（[D-021](decisions.md)）。途中で見つけた「期限切れ URL で画像が壊れたまま残る」不具合を修正
- ✅ read-only の設定診断 `pnpm diagnose`（[operations.md](operations.md) §7）。production 用の top-level 設定が secret と衝突する形だったのを修正
- ✅ 1,000 / 10,000 件の scale 測定（[benchmarks.md](benchmarks.md)）
- ✅ Actions の SHA 固定、Dependabot、release / rollback / credential 更新 / 復旧 drill の手順（operations.md §8、§13、§14）

続き（確認した内容は [verification.md](verification.md)）:

- ✅ 完全削除が途中で止まった写真を選び直すと「登録済み」と表示され、実際には登録されない不具合を修正。止まる前に reserve していた upload の finalize が、新しい object を重複として消す不具合も同じ原因（[D-014](decisions.md)）
- ✅ 止まった完全削除を、ライブラリ画面から再開できるようにした（以前は対象が画面に出ず、再開できなかった）
- ✅ 期限切れの未完了 upload を、進行中のものと分けて数える（ライブラリ画面、`pnpm diagnose` の WARN）
- ✅ 取り込み中に写真を選び直すと、同時に decode する枚数が 2 を超えていた不具合を修正（[D-020](decisions.md)）
- ✅ 100MB を超えるファイルは、読み込む前に専用の文言で拒否する（以前は全体を memory に読み、decode してから `VALIDATION_FAILED` で失敗していた）
- ✅ 撮影日時の offset が無い場合の扱いを明文化（architecture.md §6）
- ✅ `pnpm diagnose` が `APP_ORIGIN` と実際の URL の不一致を検出する（状態を変えない probe。operations.md §7）

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
