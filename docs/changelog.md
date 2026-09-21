# 変更の記録

この文書は、完了した実装段階を新しい順に索引します。判断・検証・測定の詳細は持ちませんが、その段階固有の完了条件は残します。

経緯と根拠は [decisions.md](decisions.md)、確認した内容は [verification.md](verification.md)、測定値は [benchmarks.md](benchmarks.md) にあります。これからの作業は [roadmap.md](roadmap.md) にあります。

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

- **Feature 1 — Upload + Timeline:** owner が写真を upload し、完了後に timeline へ表示されるようにしました。original / thumbnail / preview は想定した経路で保存・取得します
- **Feature 2 — Favorite + Albums:** favorite の切り替えと、album の作成・変更・削除、asset の追加・削除を実装しました
- **Feature 3 — Sharing:** album の共有リンクを発行し、expiry・revoke・regenerate を機能させました。guest が見られるのは許可された thumbnail / preview だけです
- **Feature 4 — Delete + Restore:** trash への移動と復元、明示操作としての完全削除、中断した purge の再開を実装しました
- **Feature 5 — Export + Restore:** metadata と original manifest を export し、別の空環境へ restore できるようにしました。restore 後に asset 数、hash、album 関係を検証できます

確認した内容は [verification.md](verification.md) にあります。
