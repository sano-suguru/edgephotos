# 検証記録

この文書は、EdgePhotos を実環境と Browser で確認した結果と、まだ確認していない項目を記録します。確認済みの項目には、再現や判断に必要な範囲で、環境・日付・使ったデータ・結果を書きます。

運用の手順は [operations.md](operations.md)、性能と memory の数値は [benchmarks.md](benchmarks.md)、判断は [decisions.md](decisions.md) を正本とします。

同じ対象を確認し直したときは、既存の記述を最新の結果で更新します。追記するのは、新しい対象を確認したときと、経緯を残す必要があるときだけです。

## 現在の状況

- 最終確認: 2026-09-17
- 確認済みの環境: local（Miniflare / `vite dev` / `vite preview`）、`remote-test`
- 未確認: production 環境の作成と deploy、iPhone / Android 実機での取り込み（[未検証](#未検証)）

各項目に日付がある場合は、その日付が優先します。

## local

migration 適用、fail-closed、upload → timeline → album → share → revoke、export / restore / verify を確認済み。

## remote-test（2026-09-16〜17）

### 環境と設定

- D1・R2 の作成、remote D1 migration、`CLOUDFLARE_ENV=remote-test` での build と deploy、未設定 Worker が private / share API を `503` で拒否すること、共有ページの header / CSP、`/share/assets/*` の配信を確認済み。
- Access 境界: private path（`/`、`/api/v1/*`）が Access login へ 302、`/share`・`/share/{shareId}`・`/share/api/v1/*`・`/share/assets/*` が Access を通過して Worker に到達することを確認済み。
- owner 以外の identity を Worker が `403` にする経路は、Access policy が owner のみ Allow である限り Worker まで到達しないため、remote-test では実測できない。この検査は多層防御であり、回帰は unit test 側で担保する。
- preview URL: 無効化前は preview URL 上の private API が Access のリダイレクトを受けず、Worker 自身の JWT 検証だけが `401 UNAUTHENTICATED` で拒否していた。漏洩はなかった。無効化後は preview URL が `404` になることを確認済み（無効にする理由は [operations.md](operations.md) §4）。
- secret 運用: 7 件を Worker secret 化し、`secrets.required` 未充足時に deploy が不足名を挙げて失敗すること、充足後に fail-closed が解けて share API が `503` から `404 SHARE_UNAVAILABLE` になることを確認済み。
- R2 CORS: bucket 限定の rule を適用し、読み戻しを確認済み。`x-amz-checksum-sha256` を AllowedHeaders に加えた rule（[D-018](decisions.md)）も適用・読み戻し済み。

### upload と checksum

- original の checksum（[D-018](decisions.md)）: remote-test で Browser から、canvas で生成した合成 JPEG を使って確認済み（2026-09-16）。reserve が返す original の PUT header に `x-amz-checksum-sha256` が入る。同じ size で 1 byte だけ違う body の PUT は R2 が `400 BadDigest` で拒否し、その時点の finalize は `409 UPLOAD_OBJECT_MISSING`（`original`）。同じ URL へ正しい bytes を PUT し直すと `200`、finalize は `200 created`。S3 API で PUT した object の `checksums.sha256` を、binding の `head()` から読めることを確認した。owner 用 GET で読み戻した original の SHA-256 は `assets.sha256` と一致した。確認に使った asset は trash へ移動済み。
- upload 経路: owner が Access login を通したうえで、private API の成功応答、`reserve -> PUT -> finalize` が remote-test で通ることを確認済み。PUT の宛先が `*.r2.cloudflarestorage.com` であること（Worker が本体を中継しないこと）を DevTools で確認。これにより、remote-test に設定した `ACCESS_AUD` と `ACCESS_TEAM_DOMAIN` で owner の JWT 検証が通ることも確認した。
- 実 R2 の `412`（2026-09-17、Browser の `fetch()` から CORS 越し、canvas で作った合成 JPEG）: 同じ presigned PUT URL へ 2 回目の PUT を送ると、original・thumbnail とも `412` が返り、`res.status` として読めた（network error にはならない）。そのあとの finalize は `200 created` で、再試行で `412` を受けた upload がそのまま ready になれることを確認した。確認に使った asset は trash へ移動済み。
- duplicate handling と完全削除: 同一 original の再 upload が `409 DUPLICATE_ASSET` になること、完全削除後は同じ original を再登録できることを確認済み。

### share と境界

- share 経路: album 作成 -> asset 追加 -> share 発行 -> 正しい secret で `200` -> revoke -> 同じ secret で `404` までを確認済み。secret 不正・secret 無しはいずれも `404`。`url` は `/share/{id}#{secret}` の形。share から `original` を要求すると `400`（variant は `thumbnail` / `preview` のみ）。derivative は `*.r2.cloudflarestorage.com` から直接取得。
- CSRF 境界: 他 origin からの `POST /api/v1/albums` が `403 ORIGIN_NOT_ALLOWED`。
- presigned URL の失効: share の derivative URL が発行 300 秒後に R2 で `403 ExpiredRequest` になることを確認済み。revoke 済み share の既発行 URL が残り TTL の間だけ有効なのは [security.md](security.md) §5 の契約どおり。

### backup / restore

- backup: remote-test に対する `pnpm backup export` と `verify` が通り、original の SHA-256 照合が一致（`ok: true`）。
- restore（2026-09-16 の drill）: 空の `edgephotos-restore-test`（D1 / R2 / Access / CORS / secret を別に用意）へ `pnpm backup restore` を実行し、`ok: true` を確認済み。restore 先から export し直して manifest を突き合わせ、asset 数・original の SHA-256・album 構成と membership・主要 metadata（size / content type / filename / width / height / takenAt / isFavorite）が一致することを確認。変わるのは `id` と `createdAt` だけで、[D-015](decisions.md) のとおり。空でない library への restore が拒否されることも確認済み。
- 20 件規模の restore: restore-test を空にしてから 20 asset・1 album を restore し、restore 先の export と突き合わせて asset 数・SHA-256 集合・album membership・metadata 7 項目が一致、original 20 件の再 hash もズレなしを確認。
- `edgephotos-restore-test` は drill 用の一時環境で、検証後に Worker・D1・R2 bucket・Access application・R2 API token をすべて削除した。

### 画像形式と original

- 画像形式と orientation: EXIF orientation 1〜8、GPS タグ付き、JPEG / PNG / WebP、160×120 から 6000×4000、1:4 と 40:9 の比率を含む合成 19 枚を upload。orientation 8 種はすべて同じ向き・同じ寸法として登録され、client が EXIF を適用していることを確認。derivative は全件 EXIF・GPS を持たず、thumbnail 512 / preview 2048 の上限を守り、上限より小さい original を拡大しない。
- original の byte 保持: export した original を再 hash し、ローカル原本の SHA-256 と全件一致することを確認。trash へ移動して復元した asset も SHA-256 が変わらない。
- 実機由来の画像: 共有経由で保存し直した iPhone の JPEG を 1 枚 upload。`DateTimeOriginal` も GPS も持たない最小限の EXIF でしたが、`takenAt` が `null` になるだけで upload・derivative 生成・SHA-256 保持はいずれも正常でした。

## Browser での取り込み（2026-09-17）

local の `vite dev`、Playwright の Chromium 151 と WebKit 26.5、macOS。公開されている実機サンプル（[metadata-extractor-images](https://github.com/drewnoakes/metadata-extractor-images) と [exif-samples](https://github.com/ianare/exif-samples)。iPhone 4S〜6 Plus、Pixel 2、Galaxy S4〜S8 / Note 8、OnePlus 8、LG G3、Xperia Z3、Moto G、Oppo R7 Plus、Nokia 8.3 ほか）と、Pillow で作った合成 fixture を使った。どちらも repository には入れていない。script は scratch 環境で一度きり実行し、commit していない（[development.md](development.md) §8）。

- metadata: EXIF orientation 1〜8（実機の縦位置 orientation 6 を含む）は、両 engine とも thumbnail の向きが一致した。MakerNote（最大約 60KB）、`OffsetTimeOriginal` あり・なし、`CreateDate` が偽の値（`2002:12:08`）で `DateTimeOriginal` が正しい機種、空白や範囲外の日付、orientation 0 / 9、IFD offset の破損は、いずれも upload が成功した。日付が読めない場合だけ `takenAt` が `null` になる。200 件を upload し、width / height / takenAt を Pillow で求めた期待値と照合して、両 engine とも不一致 0 件。iPhone の HEIC を macOS の `sips`（ImageIO。iOS の変換も ImageIO によると推定しているが、実機では未確認）で JPEG に変換すると、`DateTimeOriginal`・`OffsetTimeOriginal`・MakerNote が残り、`-04:00` の offset 付きで取り込めた（Safari の変換結果の代わり。[D-019](decisions.md)）。Playwright WebKit 26.5 は `createImageBitmap` で HEIC を decode でき、Chromium は `InvalidStateError` になる。
- 拒否されるもの: 空ファイル、画像でない中身、APP1 の長さが壊れた JPEG、HEIC（専用の文言を表示。[D-019](decisions.md)）。途中で切れた JPEG は、Chromium では decode 失敗として拒否され、WebKit では下半分が灰色のまま成功する。
- 見つかって直した問題（[D-020](decisions.md)）: WebKit の canvas JPEG に APP1 / APP13 が付き、finalize が全件 `422` にしていた（WebKit で 200 件中 200 件が失敗）。PUT が 1 回失敗すると、その写真全体が失敗していた（通信断、応答の喪失、`503` を route で再現）。300 枚を選ぶと、97 件を残して完了表示になっていた。修正後は、WebKit と Chromium で 200 件が全件成功、失敗を注入した 3 件は再試行で成功（応答を失った PUT は `412` を経て成功）、300 件の選択は 300 件とも登録された。
- memory と前処理の並列数: 数値は [benchmarks.md](benchmarks.md) の「Browser の取り込み memory」。
- Browser の制約で試せなかったこと: WebKit では Playwright で横取りした PUT の Blob 本文が失われるため、再試行の再現は Chromium だけで行った（再試行のコードは engine に依存しない）。

## continuous-use 修正（2026-09-17）

対象は、完全削除が止まった写真の再 upload、止まった削除の再開、期限切れ upload の件数、取り込みの並列数、100MB 超の事前拒否、`APP_ORIGIN` の診断。

### local

server 側は workerd の自動テスト、並列数は unit test。ライブラリ画面の表示と「削除を再開」、100MB 超の拒否は、Playwright の Chromium で一度だけ確認した（spec は commit していない）。`worker: APP_ORIGIN` は local の `vite dev` に対して CLI を実行し、`localhost` で PASS、`127.0.0.1` で FAIL になることを確認した。

### remote-test

同日に remote-test へ deploy し、owner token 付きの Node script と Browser で確認した。写真は marker だけの合成 JPEG で、Worker は decode しない。

`pnpm diagnose` は FAIL なし。`worker: APP_ORIGIN` が PASS、`library: interrupted uploads` が WARN（以前の検証で残った期限切れ 2 件。600 秒待つ新しい中断は作っていない）。止まった削除は、trash 済みのテスト asset を D1 で直接 `purging` にして作った（`UPDATE assets SET status='purging' WHERE id=<テスト asset> AND trashed_at IS NOT NULL`。R2 の削除失敗は remote では起こせないため）。確認できたこと:

- `library: unfinished deletes` の WARN、ライブラリ画面の表示、「削除を再開」で削除処理中が 0 になること
- 止まった削除と同じ写真の reserve が `409` ではなく `201` を返し、古い asset の R2 object と D1 row が消えること。続く finalize は `200 created`
- 削除前に reserve・PUT 済みだった upload の finalize が `200 created` を返し、その original を owner 用 URL から読み戻せること（新しい object を重複として消さない）
- 誤った `Origin` の album 作成が `403 ORIGIN_NOT_ALLOWED`、正しい `Origin` では `400 VALIDATION_FAILED` になり、album 数が変わらないこと
- 実 D1 での並行実行（各 3 回）: 同じ `purging` asset に `DELETE` 2 本と同じ写真の reserve を同時に送ると、`DELETE` は 204/204 または 204/404（`ASSET_NOT_FOUND`）、reserve はすべて `201`。同じ写真の pending upload 2 件を、`purging` の asset の `DELETE` と同時に finalize すると、どの回も片方が `created`、片方が同じ asset への `duplicate` になり、再送しても同じ結果だった。UNIQUE 競合の fallback を通ったかどうかは外から区別できない。「競合の勝者が `purging`」の分岐は再現していない（コードの確認のみ）
- 上の 204/404 のように別の request が先に削除を終えると、「削除を再開」はその 404 で止まっていた。そのあと、404 の ID は飛ばして残りを続けるよう修正した（unit test で確認。この修正は remote-test に deploy していない）
- テスト asset はすべて完全削除し、件数は検証前（写真 21、ゴミ箱 2、削除処理中 0、未完了 upload 2、album 1）に戻した。D1 に今回の upload 行は残っていない

## 閲覧 UI の改善（2026-09-17）

local（`vite dev`、使い捨ての `EDGEPHOTOS_STATE_DIR`）に、reserve → PUT → finalize で合成 JPEG 90 枚（撮影日時を約 4 か月に分散）と album 3 件を入れ、Playwright script で確認した。実写真は使っていない。

- desktop Chromium（1440×900）: viewer の ←/→ で前後の写真へ移動し、60 枚目を越えると次のページを読み込んで移動を続けられる。先頭では「前の写真」が出ない。Escape で閉じると最後に表示した写真の tile に focus が戻る
- phone（WebKit iPhone 13 相当）: 横スクロールなし、header 49px、タブは画面下に固定。viewer の「次の写真」、情報パネルの表示
- phone（Chromium Pixel 7 相当、CDP の touch event）: 左右スワイプで前後に移動、タップで操作ボタンを隠す
- ゴミ箱へ移動すると viewer は次の写真を表示し、「元に戻す」で server 上も復元される。完全削除とアルバム削除は確認 dialog を出し、キャンセルで何も変わらない
- storage への PUT を失敗させると日本語の失敗表示と「再試行」が出て、再試行で完了する。一覧 API の 500 では server の英語 message を出さず、再試行で表示が戻る
- album 一覧は各 album の最新の写真を cover にする（`limit=1` の album assets API。API の変更なし）
- 2 枚を続けてゴミ箱へ移動すると「元に戻す」が 2 つ並び、それぞれが対応する写真だけを復元する。情報パネルは写真を移動しても開いたままで、viewer を開き直すと閉じている。アップロード中の表示は完了枚数（例: 0 / 3 枚）と処理中のファイル名

常設の回帰は `e2e/keyboard.spec.ts` と `e2e/mobile.spec.ts`（[development.md](development.md) §7）。iPhone / Android の実機での swipe と safe area は未確認。

## 未検証

iPhone / Android 実機での取り込みは未確認です。desktop の WebKit では代用できません。[roadmap.md](roadmap.md) の Post-merge verification で、次を確認します。

iPhone Safari:

- 48MP の HEIC を複数選択する（iOS Safari の memory 上限（jetsam）と 48MP 以上の decode。落ちる場合は前処理の並列数 1 を試す。[D-020](decisions.md)）
- iCloud にしかない写真を選ぶ
- 100〜200 枚を選ぶ
- upload 中に画面をロックする、Safari を background へ移す、Wi-Fi とモバイル回線を切り替える
- 10 分を超えて中断し、presigned URL の期限（600 秒）切れを踏む
- 選択時の HEIC → JPEG 変換と、位置情報の扱いを確認する

Android: 上と同じ項目のうち該当するもの（HEIF 設定の端末を含む）。

表示が崩れた場合に見る箇所は `src/web/lib/image.ts` の `createImageBitmap(file, { imageOrientation: 'from-image' })` です。original は byte 単位で保持されるので、derivative を作り直せば復旧します。
