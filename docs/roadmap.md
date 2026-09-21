# ロードマップ

これから行う作業だけを管理します。段階ごとに、何ができたら終わりとみなすかを書きます。

完了した段階は [changelog.md](changelog.md) にあります。設計の理由は [decisions.md](decisions.md)、不変条件は [architecture.md](architecture.md) と [security.md](security.md) にあります。

状態の凡例（2026-09-18 時点）:

- ✅ 実装・自動テスト済み
- 🟡 実装済みだが一部未検証
- ⬜ 未着手

完了した段階に ✅ だけが並ぶようになったら、その段階を changelog.md へ移します。

## Foundation

以後の feature を載せる共通基盤です。残っているのは production 環境と、UI primitive の実機確認です。

到達点:

- ✅ Web / Worker が同一 deployable unit として起動できる
- ✅ private API の認証と household authorization が機能する
- ✅ D1 migration と private R2 binding が利用できる（local）
- ✅ OpenAPI を生成できる（`/api/v1/openapi.json`）
- 🟡 local / remote-test / production が分離されている（remote-test は D1 / R2 / Worker を作成・デプロイ済み。production は未作成）
- 🟡 shadcn/ui + Base UI の主要 component が Preact production build で成立する（Dialog / Menu の keyboard・focus と、phone 幅の tap は Browser E2E で自動化済み。Select は未使用、touch の実機は未確認）
- ✅ `/share/*` の公開経路と private path の Access 保護を実環境で検証できる
- ✅ R2 presigned PUT / GET と CORS を実環境で検証できる

## Remote integration verification

コードではなく、実 Cloudflare 環境で境界を踏むための段階です。ここを通過するまで、private alpha を「完成」とは扱いません。

到達点:

- ✅ 実 Access で `/*` が許可外の identity を拒否し、`/share/*` の Bypass が公開経路として機能する（Worker 側の household check は test で担保。[verification.md](verification.md)）
- ✅ 実 R2 への presigned PUT / GET が Browser の CORS 越しに成立する（`Content-Type` と `If-None-Match` を含む）
- ✅ original の checksum 付き PUT が実 R2 で機能する（[D-018](decisions.md)）
- 🟡 スマートフォンで撮影した実写真（orientation・GPS・大きい画素数を含む）を 20〜30 枚 upload し、timeline の向きと表示を確認する（合成画像と実機由来の JPEG 1 枚で確認済み。カメラロール原本による確認は Post-merge verification へ送る）

## Post-merge verification

merge を止める条件から外し、実際に使い始めてから確認する項目です。新機能の追加は伴いません。

- ⬜ 普段の入力経路でスマートフォン写真を数枚 upload し、timeline の orientation と preview を確認する
- ⬜ iPhone Safari の実機で、取り込みの memory と lifecycle を確認する（確認項目は [verification.md](verification.md) の「未検証」）
- ⬜ 数千枚の timeline を年月から開き、末尾まで scroll したときの memory と scroll の滑らかさを iPhone / Android で確認する（local の測定は [benchmarks.md](benchmarks.md)。virtualization の要否はこの結果で決める。[D-031](decisions.md)）
- ⬜ Android の実機で、同じ項目のうち該当するものを確認する
- ✅ 共有リンクを private window で開き、revoke 後に閲覧できないことを確認する
- ✅ remote で backup export → verify → 別の空環境への restore を 1 回成功させる

実測の詳細は [verification.md](verification.md) にあります。

## 既知の制約

v1 の完成条件には含めません。

### 中断した upload の片付けは手動

finalize されなかった upload の行と object は、member が storage cleanup を実行するまで残ります（[D-023](decisions.md)）。写真の整合性には影響しません。

定期実行は入れていません。次のどちらかが続く場合に、Cron も候補に含めて検討します（[将来要件を先回りしない](../AGENTS.md#6-将来要件を先回りしない)）。

- cleanup を実行しても `library: interrupted uploads` の件数がすぐに増える
- R2 使用量が、export manifest の `originalSize` 合計を大きく上回り、storage audit に出ない差がある

### original の破損の修復は手作業

storage audit は original / derivative の欠落や違いを見つけますが、original は直しません。backup の original から upload し直す手順は運用の [監視と点検](operations.md#12-監視と点検) にあります。

欠けた derivative だけは、original に触れずに作り直せます（[D-026](decisions.md)）。

### audit は derivative の中身を見ない

storage audit は object の有無だけを見ます。そのため「object はあるが JPEG として使えない derivative」は `missing_derivative` に出ず、表示が崩れたままでも「問題なし」と数えられます。

この状態を作れるのは、作り直しで使えない bytes を PUT したまま戻ってこなかった client だけです（[D-026](decisions.md) の「残るリスク」）。その写真をもう一度作り直せば `If-Match` で置き換わります。

10 万枚の audit で derivative を 1 つずつ読み直す代価に見合わないため、`--deep` にも入れていません。必要になった場合の候補は、通常の audit は有無だけのままにして、`--deep` に derivative の header 検査を足すことです。

### どの行も指さない object は消さない

D1 の time travel の後などに残る `unreferenced_objects` は報告だけします。取り出しと削除は R2 の Dashboard で行います。

### 大きな album の 1 ページは album の大きさに比例して読む

album の中身を撮影日時順に返すため、album の全 member を読んで並べ替えます（[benchmarks.md](benchmarks.md)）。

### backup / restore は逐次

10 万枚の初回 backup と restore は、remote で 10 時間を超える見積もりです。差分 backup と `--resume` により、途中で止まっても最初からにはなりません（[D-024](decisions.md)）。

### WebP の EXIF は読まない

WebP の `takenAt` は常に `null` です。EXIF orientation は WebKit では適用され、Chromium では適用されないため、同じ WebP でも Browser によって width / height と derivative の向きが変わります。

### 途中で切れた JPEG の扱いが Browser で違う

Chromium は拒否し、WebKit は読めた部分から derivative を作って original を保存します。

## Release polish

- **実 R2 で `If-Match` 付き presigned PUT を 1 度踏む。** 作り直しの競合安全性がこれに依存します。公式ドキュメントが PutObject の対応を明記していることと、EdgePhotos の SigV4 署名が正しいことは別の問題なので、自分たちが発行した URL と header で確かめます。Browser から壊れた写真を実際に作り直す往復と合わせて、有効な ETag で `200`、古い ETag で `412`、先に保存された bytes が残ることを見ます（[D-026](decisions.md)、[verification.md](verification.md)）
- **2 人が実環境の端末で 1 つの library を使う。** Worker 側の household 判定は test で担保しています（`tests/integration/household.test.ts`）。実環境でしか分からないのは、Access policy の Allow 一覧と `HOUSEHOLD_EMAILS` が揃っているか、そして 2 人が日常の操作で困らないかです。remote-test に 2 アカウントを設定し、実機 2 台で次を踏みます（[D-028](decisions.md)、[operations.md](operations.md#4-cloudflare-access)）
  - 1 人目が写真を 5 枚 upload し、2 人目が login してその 5 枚を見る
  - 2 人目が別の 5 枚を upload し、1 人目の timeline に出る
  - 同じ写真を双方から upload したとき、duplicate の表示で迷わない
  - 2 人目が album を作り、1 人目がそこへ写真を追加する
  - original を双方から開く
  - 片方が trash し、もう片方が restore する
  - logout / login しても続きから使える
  - 許可していない 3 つ目のアカウントは入れない
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
- HEIC を decode できない Browser（Chrome / Firefox）からの HEIC upload（[D-030](decisions.md)）
- video
- user ごとに分かれた library を持つ multi-user（1 household の共同利用は実装済み。[D-028](decisions.md)）
- advanced search
- Queues / background processing
- client-specific adapter / BFF
- 一括の derivative 再生成（derivative version を将来変える場合。欠けた derivative の作り直しは実装済み。[D-026](decisions.md)）
- 大きな album の page を album の大きさによらず読む（`album_assets` に `sort_at` を持たせる。「既知の制約」参照）
