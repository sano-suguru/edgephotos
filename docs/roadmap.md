# ロードマップ

v1 までに残っている作業だけを管理します。終わった段階は [changelog.md](changelog.md) へ移します。

設計の理由は [decisions.md](decisions.md)、不変条件は [architecture.md](architecture.md) と [security.md](security.md)、既知の制約は [limitations.md](limitations.md) にあります。各項目の確認手順と合格の条件は、リンク先の [verification.md](verification.md) にあります。

状態の凡例（2026-09-24 時点）:

- ⬜ 未着手
- 🟡 一部済み

## 段階の呼び方

- **alpha**（現在）: remote-test で主要な外部境界を確認し、v1 に向けて production と実機での確認、Release polish を進める段階
- **v1**: Production、Post-merge verification、Release polish をすべて終えた段階

beta は置いていません。alpha と v1 の間に別の呼び名が要る状況になったら、その時点で足します。

## Production

- 🟡 [運用・デプロイ・復元](operations.md) の setup / update を production で上から実走し、初見のセットアップで足りない手順を直す。setup は 2026-09-24 に production の作成・初回 deploy・diagnose・upload まで実走した。secrets file の置き場所だけ手順から外れた（[verification.md](verification.md#production-の作成と初回-deploy2026-09-24)）。update は未実走
- ⬜ uninstall は、写真を置いていない使い捨ての環境で実走する。production では行わない
- ⬜ 家族の写真を production に入れる前に、Workers Logs の invocation log で share API の `Authorization` と `Cf-Access-Jwt-Assertion` の値が伏せられているかを確かめる。伏せられていなければ `invocation_logs` を無効にするかを決める（[ログ](security.md#9-ログ)）

## Post-merge verification

merge を止める条件から外し、実際に使い始めてから確認する項目です。新機能の追加は伴いません。

- ⬜ 普段の入力経路でスマートフォン写真を数枚 upload し、timeline の orientation と preview を確認する
- ⬜ iPhone Safari の実機で取り込みを確認する（[iPhone / Android 実機での取り込み](verification.md#iphone--android-実機での取り込み)）
- ⬜ iPhone Safari の実機で original のダウンロードを確認する。大きな JPEG、大きな HEIC、100 MB に近いファイル、続けて数回。失敗したら D-036 の再検討条件に当たる（[D-036](decisions.md)）
- ⬜ Android の実機で、同じ項目のうち該当するものを確認する
- ⬜ 数千枚の timeline を年月から開き、末尾まで scroll したときの memory と滑らかさを iPhone / Android で確認する。virtualization の要否はこの結果で決める（[D-031](decisions.md)、[benchmarks.md](benchmarks.md)）
- ⬜ Dialog / Menu の touch 操作を実機で確認する（keyboard・focus と phone 幅の tap は Browser E2E で自動化済み）

## Release polish

- ⬜ 実 R2 で derivative の作り直しを往復する。`If-Match` 付き presigned PUT を含む。先に remote-test の R2 CORS へ `if-match` を加える（[derivative の作り直しの往復](verification.md#derivative-の作り直しの往復)）
- ⬜ 2 人が実機で 1 つの library を使う（[2 人の household での利用](verification.md#2-人の-household-での利用)）
- ⬜ Deploy to Cloudflare ボタン
- ⬜ private app に CSP を付ける（[HTTP / Browser](security.md#8-http--browser)）
- 🟡 screenshots / demo（README に timeline の 1 枚がある）
- ⬜ accessibility の基本確認
- ⬜ client-side image processing を実機で計測する（desktop の Chromium / WebKit では計測済み。[benchmarks.md](benchmarks.md)）
- ⬜ v1 の release 時に、その時点の manifest version を後方互換の起点として decisions.md に記録する。以降はその version からの reader を残す（[D-035](decisions.md)）

## Future

v1 の完成条件には含めません。必要になった時点で、解決手段を [decisions.md](decisions.md) で決めます。

- Native client（Android など）
- background sync
- HEIC をデコードできない環境からの HEIC upload（[D-030](decisions.md)）
- video
- user ごとに分かれた library を持つ multi-user（1 household の共同利用は実装済み。[D-028](decisions.md)）
- advanced search
- 一括の derivative 再生成（derivative version を将来変える場合。欠けた derivative の作り直しは実装済み。[D-026](decisions.md)）
- 大きな album の page を、album の大きさによらず読む（[limitations.md](limitations.md)）
