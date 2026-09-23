# 変更の記録

完了した実装段階を新しい順に並べます。見出しの日付は、その段階を終えた日です。

書くのは、その段階で完了した挙動と範囲、更新時に要る作業、まだ残っている外部での確認です。個々の実装方法・判断の理由・測定値の詳細は持ちません。

経緯と根拠は [decisions.md](decisions.md)、確認した内容は [verification.md](verification.md)、測定値は [benchmarks.md](benchmarks.md) にあります。これからの作業は [roadmap.md](roadmap.md) にあります。

## 画面の型の統一（2026-09-23）

全画面の見た目を 1 つの規則に揃えました（[design.md](design.md)）。機能・情報設計・API・文言は変えていません。

ページ見出し・空状態・角丸・区切り線・文字の大きさを全画面で共通にしました。viewer と共有ページの暗い面も同じ token にしました。ボタンには押下と処理中の状態があり、phone で触る操作はすべて 44px 以上です。dialog と menu は短く fade して開閉します。reduced motion の設定では fade だけです。

timeline では「年月で移動」と「選択」を 1 行にまとめ、月見出しの横にその月の枚数を出します。

## 複数選択とまとめての操作（2026-09-22）

timeline / favorites / album で写真を複数選び、album への追加・お気に入り・ゴミ箱への移動をまとめて行えるようにしました。

選択は明示的に始めます。通常の tap はこれまでどおり写真を開きます。選択中は tap でも keyboard（Tab と Space）でも写真を選べ、viewer は開きません。選択件数・全解除・実行できる操作は画面上端に留まる bar に出ます。

まとめての操作は部分成功として扱います。10 枚のうち 1 枚が失敗しても、成功した 9 枚は取り消しません。終わったあと選択に残るのは失敗した写真だけです。別の member が消した写真とゴミ箱にある写真は、失敗ではなく件数として報告します。

再試行は、もう一度送れば結果が変わりうる失敗にだけ出します。album が消えていた場合は選択を残すので、別の album を選び直せます。

ゴミ箱へまとめて移す操作は、件数を書いた確認を通します。original は削除せず、既存の trash / restore / purge のままです。完全削除のまとめ操作は入れていません。

選択は URL にも端末にも保存しません。page を足しても残り、年月を移るか別の view へ行くと解除されます。

判断は [D-032](decisions.md)。

## timeline の年月 navigation（2026-09-22）

timeline から、目的の時期へ直接移動できるようにしました。検索機能は追加していません。

timeline に写真のある年月と件数の一覧を出し、選んだ月の最も新しい写真から表示します。移動したあとは上へも下へも読め、同じ写真が二重に出ることも、間を飛ばすこともありません。

月の見出しは sticky にしました。scroll 中も、見ている写真がどの年月かが分かります。

選んだ年月は `?m=YYYY-MM` として URL に残ります。back / forward と reload で同じ月へ戻れます。

月には、写真に記録された撮影日時の年月を使います。撮影日時が無ければ upload 時刻（UTC）を使います。並び順は変えていません。

判断は [D-031](decisions.md)、測定値は [benchmarks.md](benchmarks.md)。数千枚の timeline を実機で scroll したときの memory と滑らかさの確認は、[roadmap.md](roadmap.md) の Post-merge verification に残しています。

## 大量 upload の partial failure（2026-09-22）

数十〜数百枚を選んだ upload で、一部が失敗しても成功した写真をそのまま残し、失敗した行だけを再試行できるようにしました。background upload は作っていません。

batch の終わりに、追加した枚数・登録済みだった枚数・追加できなかった枚数をすべて出します。100 枚のうち 1 枚が失敗しても、99 枚が失敗したようには読めません。

同じ file では変わらない失敗（100MB 超、途中で切れた file、decode できない HEIC、server が original そのものを拒否した場合）は再試行の対象から外し、理由を出します。権限や設定のように、画面そのものが拒否された場合も同じ扱いです。ログインを確認できなかった場合だけは再試行を残し、選んだ写真を失わずに続けられる手順を出します。duplicate は失敗ではなく通常の結果のままです。

保存は終わっていて応答だけを失った写真は、再試行ですぐ確定し、転送も前処理もやり直しません。前処理でしか起きない失敗（memory 不足、decode 失敗）が、保存済みの写真を失敗として見せることもなくなりました。

保証するのは画面を開いている間だけです。reload や tab を閉じたあとは選び直しになります（閉じる前に確認を出します）。完成した asset が二重に作られることはありません。完了しなかった upload の残りは、ライブラリ画面の「ストレージの点検」で片付けられます。

判断は [D-020](decisions.md)、確認内容は [verification.md](verification.md)。

## HEIC / HEIF の original 保存（2026-09-22）

HEIC / HEIF を original として受け付けるようにしました。受け取った byte 列は変更せず保存し、timeline や share で使う thumbnail / preview は今までどおり JPEG です。HEIC を JPEG へ変換して original と呼ぶことはしません。

受け入れるのは静止画だけです。image sequence と AVIF は拒否します。

取り込めるのは HEIC を decode できる Browser だけです。decode できない Browser では、upload を始める前に、何をすればよいかを添えて止めます。decode できても、後半が失われたファイルは asset にしません。

backup manifest は v2 になりました。v1 の backup も引き続き restore できます。

判断は [D-030](decisions.md)、確認内容は [verification.md](verification.md)、測定値は [benchmarks.md](benchmarks.md)。**確認は macOS 上の Playwright（Chromium・WebKit）までです。** iPhone / Android の実機での確認は [roadmap.md](roadmap.md) の Post-merge verification に残しています。

## 夫婦 2 人での共同利用（2026-09-21）

**更新時の作業:** 既存の deployment は、deploy の前に `HOUSEHOLD_EMAILS` を設定します。設定しないと deploy が失敗します（[operations.md](operations.md#3-利用者が設定する値)）。

private API を使える identity を 1 つの `OWNER_EMAIL` から `HOUSEHOLD_EMAILS`（email の comma 区切り）へ広げました。設定した member はすべて対等で、1 つの library を共同利用します。片方が upload した写真を、もう片方が同じ timeline から見て、favorite・album・share・trash・restore まで同じように扱えます。

DB の migration はありません。

判断は [D-028](decisions.md)。2 人が実機で 1 つの library を使う確認は [roadmap.md](roadmap.md) の Release polish に残しています。

## derivative の作り直し（2026-09-18）

欠けた thumbnail / preview を、original に触れずに作り直せるようにしました。経路は state を持たない 1 つの冪等な呼び出しで、object を 1 つも削除しません。競合したときは、古い repair が新しい結果を取り消せません。

判断は [D-026](decisions.md)、確認内容は [verification.md](verification.md)。残っている確認（Browser からの往復と `If-Match` 付き presigned PUT）は [roadmap.md](roadmap.md) の Release polish にあります。

## 長期保管の整合性（2026-09-17）

長く預けたライブラリで、不整合を起こしにくくすること・起きたら検出できること・backup から戻せることを優先しました。D1 と R2 の突合（storage audit / cleanup）、export のページ分割、差分 backup とオフライン検査、再開できる restore、`--quick` の verify を追加しました。完全削除と復元、finalize の UNIQUE 競合も直しました。機能は足していません。

画面側では、失敗した upload の再試行で転送をやり直さないようにし、失敗表示に「追加されたか・次に何をするか」を出し、アップロード中にタブを閉じる前の確認を足しました。「オリジナル」は「保存したファイル」と表記を改めました。

判断は [D-023](decisions.md) と [D-024](decisions.md)、確認内容は [verification.md](verification.md)、測定値は [benchmarks.md](benchmarks.md)。

## 継続利用のための堅牢化（2026-09-17）

新しい構成は足さず、測って弱点だけを直しました。Browser 固有の経路を Playwright で自動化し、read-only の設定診断 `pnpm diagnose` を足しました。止まった完全削除の再開、取り込みの並列数の上限、`APP_ORIGIN` の不一致検出も直しました。運用面では Actions の SHA 固定、Dependabot、release / rollback / credential 更新 / 復旧 drill の手順を用意しました。

判断は [D-014](decisions.md)、[D-020](decisions.md)、[D-021](decisions.md)。手順は [operations.md](operations.md)、確認内容は [verification.md](verification.md)。

## Foundation と実環境の境界確認（2026-09-17）

以後の feature を載せる共通基盤と、実 Cloudflare 環境（`remote-test`）で境界を踏む確認です。

完了条件:

- Web / Worker が同一 deployable unit として起動できる
- private API の認証と household authorization が機能する
- D1 migration と private R2 binding が利用できる（local）
- OpenAPI を生成できる（`/api/v1/openapi.json`）
- 実 Access で `/*` が許可外の identity を拒否し、`/share/*` の Bypass が公開経路として機能する
- 実 R2 への presigned PUT / GET が Browser の CORS 越しに成立する（`Content-Type` と `If-None-Match` を含む）
- original の checksum 付き PUT が実 R2 で機能する（[D-018](decisions.md)）

Post-merge verification のうち、次の 2 つもこの時点で終えています。

- 共有リンクを private window で開き、revoke 後に閲覧できないことを確認する
- remote で backup export → verify → 別の空環境への restore を 1 回成功させる

残っていた production 環境の作成、Dialog / Menu の touch 操作、スマートフォンで撮った写真での確認は、roadmap の Production と Post-merge verification へ移しました。

## v1 の機能（Feature 1〜5）

この 5 段階の完了をもって、外部 alpha の前提が揃いました。

- **Feature 1 — Upload + Timeline:** owner が写真を upload し、完了後に timeline へ表示されるようにしました。original / thumbnail / preview は想定した経路で保存・取得され、refresh 後も状態が一貫します
- **Feature 2 — Favorite + Albums:** favorite の切り替えと、album の作成・変更・削除、asset の追加・削除を実装しました
- **Feature 3 — Sharing:** album の共有リンクを発行し、expiry・revoke・regenerate を機能させました。guest が見られるのは許可された thumbnail / preview だけです
- **Feature 4 — Delete + Restore:** trash への移動と復元、明示操作としての完全削除、中断した purge の再開を実装しました
- **Feature 5 — Export + Restore:** metadata と original manifest を export し、別の空環境へ restore できるようにしました。restore 後に asset 数、hash、album 関係を検証できます

確認した内容は [verification.md](verification.md) にあります。
