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

**中断した upload の片付けは手動。** finalize されなかった upload の行と object は、owner が storage cleanup を実行するまで残ります（[D-023](decisions.md)）。写真の整合性には影響しません。定期実行は入れていません。次のどちらかが続く場合に、Cron も候補に含めて検討します（[AGENTS.md](../AGENTS.md) §6）。

- cleanup を実行しても `library: interrupted uploads` の件数がすぐに増える
- R2 使用量が、export manifest の `originalSize` 合計を大きく上回り、storage audit に出ない差がある

**壊れた写真の修復は手作業。** storage audit は original / derivative の欠落や違いを見つけますが、直しません。backup の original から upload し直す手順は [operations.md](operations.md) §12 にあります。derivative だけを作り直す経路はありません。

**どの行も指さない object は消さない。** D1 の time travel の後などに残る `unreferenced_objects` は報告だけします。取り出しと削除は R2 の Dashboard で行います。

**大きな album の 1 ページは album の大きさに比例して読む。** album の中身を撮影日時順に返すため、album の全 member を読んで並べ替えます（[benchmarks.md](benchmarks.md)）。

**backup / restore は逐次。** 10 万枚の初回 backup と restore は remote で 10 時間を超える見積もりです。差分 backup と `--resume` により、途中で止まっても最初からにはなりません（[D-024](decisions.md)）。

**WebP の EXIF は読まない。** WebP の `takenAt` は常に `null` です。EXIF orientation は WebKit では適用され、Chromium では適用されないため、同じ WebP でも Browser によって width / height と derivative の向きが変わります。

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

## Long-term integrity（2026-09-17）

機能は足さず、長く預けたライブラリが壊れない・壊れたら分かる・戻せることを優先した段階です。判断は [D-023](decisions.md) と [D-024](decisions.md)、数値は [benchmarks.md](benchmarks.md)、確認内容は [verification.md](verification.md) にあります。

- ✅ 完全削除と同時に trash から復元された写真を削除しない。finalize の UNIQUE 競合で自分の object を消さない
- ✅ D1 / R2 の突合（storage audit、`--deep` で R2 の SHA-256 記録と照合）と、中断した upload の cleanup
- ✅ export のページ分割（10 万枚で 1 response 55 MiB だった）
- ✅ 差分 backup、backup ディレクトリのオフライン検査、1 枚の破損で止まらない backup
- ✅ 再開できる restore、`createdAt` と並び順の保持、verify の `--quick` と storage audit
- ✅ favorites / trash / 止まった削除の部分 index、diagnostics の走査削減、album cover を一覧で返す
- ✅ 失敗した upload の再試行で転送をやり直さない。失敗表示に「追加されたか・次に何をするか」を出す。アップロード中にタブを閉じる前の確認
- ✅ 元ファイルの形式を中身で判定する。「オリジナル」を「保存したファイル」と表記する
- ✅ 1,000 / 10,000 / 100,000 件の scale 測定

## Derivative repair（2026-09-18）

`missing_derivative` を、original に触れずに直せるようにした段階です。判断は [D-026](decisions.md)、確認内容は [verification.md](verification.md) にあります。

- ✅ `POST /api/v1/assets/{assetId}/derivatives/repair`（state を持たない冪等な 1 呼び出し。original は読むだけ）
- ✅ Browser の既存 derivative pipeline の再利用（upload と同じ renderer・長辺・metadata 除去）
- ✅ 作り直しの前後で original の SHA-256・asset ID・album・favorite・trash・日時が変わらないことの回帰テスト
- ✅ object を 1 つも削除しない。使えない derivative は検査時点の ETag への `If-Match` で置き換える（古い repair が新しい結果を取り消せない）
- ✅ ライブラリ画面の「サムネイルを作り直す」と、`pnpm diagnose` の `r2: CORS` が `GET` も検査すること
- ✅ remote-test: bucket の CORS が `GET` を許し、実 R2 の preflight が app origin にだけ `Access-Control-Allow-Origin` を返すこと（設定変更は不要だった）
- ⬜ remote-test: Browser から壊れた写真を実際に作り直す往復と、`If-Match` 付き presigned PUT の `200` / `412`（deploy と Access login が要る。[verification.md](verification.md) の「未検証」）

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
- 一括の derivative 再生成（derivative version を将来変える場合。欠けた derivative の作り直しは実装済み。[D-026](decisions.md)）
- 大きな album の page を album の大きさによらず読む（`album_assets` に `sort_at` を持たせる。「既知の制約」参照）
