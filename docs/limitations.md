# 既知の制約

EdgePhotos は現在 alpha です。使い始める前に知っておいてほしい制約をまとめます。各項目には、何が起きるか、どう対処するか、いつ見直すかを書きます。

特に次の 4 つを先に確認してください。

1. EdgePhotos を写真の唯一の保存先にしない。別の場所に原本を残し、定期的に backup を取る（[Backup と export](operations.md#9-backup-と-export)）
2. 大きな library では、初回の backup と restore に何時間もかかる（[backup / restore には時間がかかる](#backup--restore-には時間がかかる)）
3. 点検で見つかった問題の一部は、自動では直らない。CLI、アプリのメンテナンス画面、R2 の Dashboard のどれかで対応する（[片付けと修復](#3-片付けと修復)）
4. WebP には撮影日時が付かず、向きが Browser によって変わる（[WebP は写真ライブラリには勧めない](#webp-は写真ライブラリには勧めない)）

どれも v1 までに直す予定はありません。これからの作業は [roadmap.md](roadmap.md)、判断の経緯は [decisions.md](decisions.md) にあります。

## 1. 想定している規模

10 万枚までの library を想定して測っています。ただし、10 万枚の library を日常的に使えることはまだ確かめていません。確かめた範囲は次のとおりです（数値は [benchmarks.md](benchmarks.md)）。

| 対象 | 確かめた範囲 |
| --- | --- |
| API（timeline・album・export・点検） | 合成 10 万枚を local で測定。timeline は library の大きさによらず一定 |
| Browser の timeline | 合成 1 万枚を desktop の Chromium / WebKit で測定 |
| backup / restore | 1 万枚まで local で測定。remote は数十枚で実走し、大きな library の所要時間は見積もり |
| スマートフォン | 未確認。数千枚の timeline を v1 までに実機で確かめる（[Post-merge verification](roadmap.md#post-merge-verification)） |
| 10 万枚を超える library | 測っていない |

## 2. 使うときの制約

### backup / restore には時間がかかる

初回の backup と restore は、写真の枚数に比例して時間がかかります。remote では 1 万枚で 1〜1.5 時間、10 万枚で 10 時間を超える見積もりです。original の転送時間は含まないため、回線によってはさらに延びます。

途中で止まっても、最初からやり直す必要はありません。

- backup: 同じコマンドを再実行すると、取得済みの写真を飛ばして続きから取得します。書きかけのファイルは残らず、前回の `manifest.json` は完了するまで有効なままです
- restore: `--resume` を付けて再実行すると、restore 済みの写真を飛ばして続けます
- 2 回目以降の backup は差分で、変わった写真だけを取得します

手順は [Backup と export](operations.md#9-backup-と-export) と [Restore](operations.md#10-restore) にあります。

### WebP は写真ライブラリには勧めない

WebP で取り込むと、次の 2 つが起きます。JPEG で取り込めるなら、そちらを使ってください。

- 撮影日時が付かない。timeline では、ライブラリに入った日時の位置に並びます
- 向きが Browser によって変わる。回転情報を持つ WebP は、Safari などの WebKit で取り込むと回転し、Chrome などの Chromium で取り込むと回転しません

EdgePhotos が WebP の EXIF を読まないためです（`takenAt` は常に `null`）。向きは取り込んだ Browser の decoder が決め、そのまま thumbnail / preview と width / height に残ります。

### 途中で切れた JPEG は WebKit では登録される

後半が欠けた JPEG を取り込むと、Chrome などの Chromium は拒否します。Safari などの WebKit は受け付け、欠けた部分が灰色の thumbnail / preview を作って、欠けた original をそのまま保存します。

灰色の写真を見つけたら、元の写真が壊れていないか確かめてください。無事なら取り込み直し、灰色の方は削除します。

### 大きな album は開くたびに album 全体を読む

album の中身を撮影日時順に並べるため、1 ページ開くたびに album の全写真を読みます。album が大きいほど重くなり、5 万枚の album では 1 ページごとに約 15 万行を読みます。Workers Free の D1 の上限（1 日 500 万行）では、1 日に 30 回あまり開くと上限に達します（[benchmarks.md](benchmarks.md)）。

直すには、album の中身の並び順を別に持たせる schema 変更とデータ移行が要ります。Free の上限に当たるか、体感で遅くなった時点で行います。

## 3. 片付けと修復

storage audit（メンテナンス画面の「保存状態の点検」、または `pnpm storage audit`）が見つけた問題のうち、次のものは自動では片付きません。分類ごとの対応は [D1 と R2 の突合](operations.md#d1-と-r2-の突合storage-audit--cleanup) にあります。

### 中断した upload は自動では片付かない

通信の切断や画面ロックで upload が途中で止まると、登録されなかった写真のデータが R2 に残ります。library の写真には影響しませんが、保存容量を使います。

中断から 1 日たったものは、メンテナンス画面の「中断したアップロードを整理する」か `pnpm storage cleanup --apply` で片付けられます。定期的な自動実行はしていません（[D-023](decisions.md)）。

cleanup の直後に `library: interrupted uploads` の件数がまた増える、または R2 の使用量が export manifest の `originalSize` の合計を大きく上回り、audit にも出ない差がある場合に、cleanup を Cron で定期実行することを検討します（Cron は derivative の再送にだけ使っています。[D-042](decisions.md)）。

### server での thumbnail 生成の失敗は、閉じた画面には届かない

original が 20 MB 以下の写真は、upload の後に server が thumbnail / preview を作ります（[D-042](decisions.md)）。画面を開いている間は、server が作れなかった写真を Browser で作り直すか、作れない理由を表示します。画面を閉じた後に失敗した写真は、ライブラリに現れないだけで、通知はありません。

メンテナンス画面の「保存状態の点検」が `derivative_failed` として数えます。original は消さずに残します。その写真をもう一度追加すると、「中断したアップロードを整理する」が残った分を片付けます。一時的な理由で失敗したものは、整理するときにもう一度 server で作り直します。

### 20 MB を超える HEIC は、decode できる Browser でしか追加できない

Cloudflare Images の binding が受け付ける入力は 20 MB までです。それを超える original は Browser 経路で derivative を作るため、HEIC を decode できない Browser（Chrome / Firefox）では追加できません。追加の前に理由を表示して止めます。

### どの写真も指さないデータは自動では消さない

D1 を time travel で過去の状態へ戻した後などに、どの写真にも結び付かないデータが R2 に残ります。time travel の後なら、戻した期間に upload した写真のデータの可能性があります。audit は `unreferenced_objects` として報告するだけで、削除しません。

写真を取り戻したい場合も、不要なので消したい場合も、R2 の Dashboard で操作します。

### 壊れた original は自動では直らない

audit が original の欠落や破損を見つけても、EdgePhotos は original を直しません。backup の original から戻します。現在の手順は、その写真をアプリで完全削除し、backup の original を upload し直すことです。album と favorite は付け直します。

thumbnail / preview が欠けているだけなら、メンテナンス画面の「サムネイルを作り直す」で直せます。original は変わりません（[D-026](decisions.md)）。

### 点検は thumbnail / preview の中身を見ない

audit は thumbnail / preview があるかどうかだけを見ます。データはあるのに画像として表示できない thumbnail / preview は、表示が崩れていても「問題なし」と数えられます。

メンテナンス画面の「サムネイルを作り直す」は audit が欠けていると挙げた写真だけを対象にするため、この写真は画面からは直せません。

この状態が起きるのは、作り直しの途中で壊れたデータを送ったまま止まった client があった場合だけです（[D-026](decisions.md) の「残るリスク」）。10 万枚の audit で全件を読み直す代価に見合わないため、`--deep` にも検査を入れていません。必要になったら、`--deep` に JPEG header の検査を足し、見つかった写真を作り直せるようにします。

## 4. 共有の画像に残りうる情報

共有リンクで渡す thumbnail / preview は、JPEG として完全には検査していません。

EdgePhotos のアプリが作った画像には、撮影場所などの metadata は入りません。ただし household member がアプリを通さずに細工した画像を直接 upload した場合は、検査しない部分に載せた情報が共有先に届くことがあります。検査の範囲は [metadata の漏れ防止](security.md#7-metadata-の漏れ防止) にあります。
