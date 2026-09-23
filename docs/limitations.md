# 既知の制約

現在わかっている制約をまとめます。どれも v1 の完成条件には含めません。

これからの作業は [roadmap.md](roadmap.md)、判断の経緯は [decisions.md](decisions.md) にあります。

## 1. 中断した upload の片付けは手動

finalize されなかった upload の行と object は、member が storage cleanup を実行するまで残ります（[D-023](decisions.md)）。写真の整合性には影響しません。

定期実行は入れていません。次のどちらかが続く場合に、Cron も候補に含めて検討します（[将来要件を先回りしない](../AGENTS.md#6-将来要件を先回りしない)）。

- cleanup を実行しても `library: interrupted uploads` の件数がすぐに増える
- R2 使用量が、export manifest の `originalSize` 合計を大きく上回り、storage audit に出ない差がある

## 2. original の破損の修復は手作業

storage audit は original / derivative の欠落や違いを見つけますが、original は直しません。backup の original から upload し直す手順は運用の [監視と点検](operations.md#12-監視と点検) にあります。

欠けた derivative だけは、original に触れずに作り直せます（[D-026](decisions.md)）。

## 3. audit は derivative の中身を見ない

storage audit は object の有無だけを見ます。そのため「object はあるが JPEG として使えない derivative」は `missing_derivative` に出ず、表示が崩れたままでも「問題なし」と数えられます。

この状態を作れるのは、作り直しで使えない bytes を PUT したまま戻ってこなかった client だけです（[D-026](decisions.md) の「残るリスク」）。その写真をもう一度作り直せば `If-Match` で置き換わります。

10 万枚の audit で derivative を 1 つずつ読み直す代価に見合わないため、`--deep` にも入れていません。必要になった場合の候補は、通常の audit は有無だけのままにして、`--deep` に derivative の header 検査を足すことです。

## 4. どの行も指さない object は消さない

D1 の time travel の後などに残る `unreferenced_objects` は報告だけします。取り出しと削除は R2 の Dashboard で行います。

## 5. 大きな album の 1 ページは album の大きさに比例して読む

album の中身を撮影日時順に返すため、album の全 member を読んで並べ替えます（[benchmarks.md](benchmarks.md)）。

直すには `album_assets` に `sort_at` を持たせる非正規化とデータ移行が要ります。

## 6. backup / restore は逐次

10 万枚の初回 backup と restore は、remote で 10 時間を超える見積もりです。差分 backup と `--resume` により、途中で止まっても最初からにはなりません（[D-024](decisions.md)）。

## 7. WebP の EXIF は読まない

WebP の `takenAt` は常に `null` です。EXIF orientation は WebKit では適用され、Chromium では適用されないため、同じ WebP でも Browser によって width / height と derivative の向きが変わります。

## 8. derivative の検査は header segment の種類まで

finalize が derivative について保証するのは、先頭 256 KiB のうち最初の scan（SOS）までに現れる segment が allowlist に入っていること、APP0 / APP14 が決まった形であること、SOF があることだけです（[security.md](security.md#7-metadata-の漏れ防止)）。次は検査しません。

- SOF / DHT / DQT / DRI の中身
- progressive JPEG の scan の間に挟んだ segment
- EOI の後ろに付けたデータ
- 画素そのもの

canvas の encoder はこうした場所に情報を書かないため、正規の client の derivative には現れません。household member が細工した bytes を直接 PUT した場合は、上の場所に載せた情報が share 閲覧者へ届く derivative に残ります。

## 9. 途中で切れた JPEG の扱いが Browser で違う

Chromium は拒否し、WebKit は読めた部分から derivative を作って original を保存します。
