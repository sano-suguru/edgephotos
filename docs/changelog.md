# 変更の記録

完了した実装段階を新しい順に並べます。判断・検証・測定の詳細は持たず、その段階固有の完了条件だけを残します。

経緯と根拠は [decisions.md](decisions.md)、確認した内容は [verification.md](verification.md)、測定値は [benchmarks.md](benchmarks.md) にあります。これからの作業は [roadmap.md](roadmap.md) にあります。

## 大量 upload の partial failure（2026-09-22）

数十〜数百枚を選んだ upload で、一部が失敗しても成功した写真をそのまま残し、失敗した行だけを再試行できるようにしました。新しい upload manager や background upload は作っていません。

summary は batch の終わりに、追加した枚数・登録済みだった枚数・追加できなかった枚数をすべて出します。100 枚のうち 1 枚が失敗しても、99 枚が失敗したようには読めません。

同じ file では変わらない失敗（100MB 超、途中で切れた file、decode できない HEIC、server が original そのものを拒否した場合）は再試行の対象から外し、理由を出します。duplicate は失敗ではなく通常の結果のままです。

再試行は file に触れる前に server へ聞きます。転送も登録も終わっていて応答だけ失った写真は、1 往復で確定します。decode や derivative の作り直しは行いません。前処理でしか起きない失敗（memory 不足、decode 失敗）が、すでに保存済みの写真を失敗として見せることがなくなりました。

storage が前の reservation の PUT を拒否したときは、新しい reservation から始めます。端末の時計が遅れていると、失効した presigned URL をまだ期限内と読み続けて、同じ拒否を繰り返していました。

batch の state machine は `src/web/features/uploads/batch.ts` に分けて、Browser なしで自動テストできるようにしました。

保証するのは画面を開いている間だけです。reload や tab を閉じたあとに再試行はできません。Browser から選んだ file をあとから読み直す方法がないため、その場合は選び直しになります（閉じる前に確認を出します）。完成した asset が二重に作られることはなく、finalize されなかった upload の残りは storage cleanup が片付けます（[D-023](decisions.md)）。

判断は [D-020](decisions.md)、確認内容は [verification.md](verification.md)。

## HEIC / HEIF の original 保存（2026-09-22）

HEIC / HEIF を original として受け付けるようにしました。受け取った byte 列は変更せず保存し、timeline や share で使う thumbnail / preview は今までどおり Browser の canvas で作る JPEG です。HEIC を JPEG へ変換して original と呼ぶことはしません。

形式は `ftyp` box の major brand と compatible brands から決めます。still image の brand だけを受け入れ、image sequence と AVIF は拒否します。判定する parser は Client と Worker で同じものです。

HEIC を decode できるかは、埋め込んだ小さな HEIC を実際に decode する probe で判断します。UA では分岐しません。decode できない Browser では、reserve と R2 PUT の前に、何をすればよいかを添えて止めます。`image/heif` は probe の対象にせず、そのファイル自身の decode 結果で判断します。

「decode できた」を原本が健全な証拠にしません。HEIC / HEIF では top-level box を歩いて、宣言された長さがファイル全体を覆うかを Client と Worker の両方で確認します。後半が失われた HEIC は、WebKit が画像を返しても asset にしません。

backup manifest は v2 になりました。v1 の backup も引き続き restore できます。

判断は [D-030](decisions.md)、確認内容は [verification.md](verification.md)、測定値は [benchmarks.md](benchmarks.md)。実機 iPhone / Android での確認は [roadmap.md](roadmap.md) の Post-merge verification に残しています。

## 夫婦 2 人での共同利用（2026-09-21）

private API を使える identity を 1 つの `OWNER_EMAIL` から `HOUSEHOLD_EMAILS`（email の comma 区切り）へ広げました。設定した member はすべて対等で、1 つの library を共同利用します。片方が upload した写真を、もう片方が同じ timeline から見て、favorite・album・share・trash・restore まで同じように扱えます。

D1 の schema は変えていません。asset に所有者を持たないため、migration はありません。既存の deployment は deploy の前に `HOUSEHOLD_EMAILS` を設定します（[operations.md](operations.md#3-利用者が設定する値)）。

判断は [D-028](decisions.md)。

## derivative の作り直し（2026-09-18）

欠けた thumbnail / preview を、original に触れずに作り直せるようにしました。経路は state を持たない 1 つの冪等な呼び出しで、object を 1 つも削除しません。競合したときは、古い repair が新しい結果を取り消せません。

判断は [D-026](decisions.md)、確認内容は [verification.md](verification.md)。残っている確認（Browser からの往復と `If-Match` 付き presigned PUT）は [roadmap.md](roadmap.md) の Release polish にあります。

## 長期保管の整合性（2026-09-17）

長く預けたライブラリが壊れない・壊れたら分かる・戻せることを優先しました。D1 と R2 の突合（storage audit / cleanup）、export のページ分割、差分 backup とオフライン検査、再開できる restore、`--quick` の verify を追加しました。完全削除と復元、finalize の UNIQUE 競合も直しました。機能は足していません。

画面側では、失敗した upload の再試行で転送をやり直さないようにし、失敗表示に「追加されたか・次に何をするか」を出し、アップロード中にタブを閉じる前の確認を足しました。「オリジナル」は「保存したファイル」と表記を改めました。

判断は [D-023](decisions.md) と [D-024](decisions.md)、確認内容は [verification.md](verification.md)、測定値は [benchmarks.md](benchmarks.md)。

## 継続利用のための堅牢化（2026-09-17）

新しい構成は足さず、測って弱点だけを直しました。Browser 固有の経路を Playwright で自動化し、read-only の設定診断 `pnpm diagnose` を足しました。止まった完全削除の再開、取り込みの並列数の上限、`APP_ORIGIN` の不一致検出も直しました。運用面では Actions の SHA 固定、Dependabot、release / rollback / credential 更新 / 復旧 drill の手順を用意しました。

判断は [D-014](decisions.md)、[D-020](decisions.md)、[D-021](decisions.md)。手順は [operations.md](operations.md)、確認内容は [verification.md](verification.md)。

## v1 の機能（Feature 1〜5）

この 5 段階の完了をもって、外部 alpha の前提が揃いました。

- **Feature 1 — Upload + Timeline:** owner が写真を upload し、完了後に timeline へ表示されるようにしました。original / thumbnail / preview は想定した経路で保存・取得され、refresh 後も状態が一貫します
- **Feature 2 — Favorite + Albums:** favorite の切り替えと、album の作成・変更・削除、asset の追加・削除を実装しました
- **Feature 3 — Sharing:** album の共有リンクを発行し、expiry・revoke・regenerate を機能させました。guest が見られるのは許可された thumbnail / preview だけです
- **Feature 4 — Delete + Restore:** trash への移動と復元、明示操作としての完全削除、中断した purge の再開を実装しました
- **Feature 5 — Export + Restore:** metadata と original manifest を export し、別の空環境へ restore できるようにしました。restore 後に asset 数、hash、album 関係を検証できます

確認した内容は [verification.md](verification.md) にあります。
