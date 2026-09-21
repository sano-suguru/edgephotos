# 検証記録

実環境と Browser で確認した結果と、まだ確認していない項目を書きます。

確認済みの項目には、環境・日付・使ったデータ・結果を書きます。再現と判断に必要な範囲に限ります。

同じ対象を確認し直したときは、既存の記述を最新の結果で更新します。追記するのは、新しい対象を確認したときと、経緯を残す必要があるときだけです。

運用の手順は [operations.md](operations.md)、性能と memory の数値は [benchmarks.md](benchmarks.md)、判断の理由は [decisions.md](decisions.md) にあります。

## 現在の状況

- 最終確認: 2026-09-21
- 確認済みの環境: local（Miniflare / `vite dev` / `vite preview`）、`remote-test`
- 未確認: production 環境の作成と deploy、iPhone / Android 実機での取り込み、derivative の作り直しの remote-test（[未検証](#未検証)）

各項目に日付がある場合は、その日付が優先します。

## local

migration 適用、fail-closed、upload → timeline → album → share → revoke、export / restore / verify を確認済み。

## remote-test（2026-09-16〜17）

### 環境と設定

- D1・R2 の作成、remote D1 migration、`CLOUDFLARE_ENV=remote-test` での build と deploy を確認済み。
- 未設定の Worker が private / share API を `503` で拒否すること、共有ページの header / CSP、`/share/assets/*` の配信も確認済み。
- `wrangler d1 create` の後、`wrangler.jsonc` に `database_id` を書かなくても deploy できた。wrangler が `database_name` で既存 D1 を解決する（wrangler 4.131 で確認）。
- Access 境界: private path（`/`、`/api/v1/*`）が Access login へ 302 した。`/share`・`/share/{shareId}`・`/share/api/v1/*`・`/share/assets/*` は Access を通過して Worker に到達した。
- owner 以外の identity を Worker が `403` にする経路は、remote-test では実測できない。Access policy が owner のみ Allow である限り、Worker まで到達しないため。この検査は多層防御であり、回帰は unit test 側で担保する。
- preview URL: 無効化前は、preview URL 上の private API が Access のリダイレクトを受けなかった。Worker 自身の JWT 検証だけが `401 UNAUTHENTICATED` で拒否していた。漏洩はなかった。無効化後は preview URL が `404` になることを確認済み（無効にする理由は運用の [Cloudflare Access](operations.md#4-cloudflare-access)）。
- secret 運用: 7 件を Worker secret 化した。`secrets.required` が未充足のとき、deploy が不足名を挙げて失敗することを確認。充足後は fail-closed が解け、share API が `503` から `404 SHARE_UNAVAILABLE` になった。
- R2 CORS: bucket 限定の rule を適用し、読み戻しを確認済み。`x-amz-checksum-sha256` を AllowedHeaders に加えた rule も適用・読み戻し済み（[D-018](decisions.md)）。

### upload と checksum

original の checksum を remote-test の Browser から確認した（2026-09-16。canvas で生成した合成 JPEG。[D-018](decisions.md)）。

- reserve が返す original の PUT header に `x-amz-checksum-sha256` が入る。
- 同じ size で 1 byte だけ違う body の PUT は、R2 が `400 BadDigest` で拒否した。その時点の finalize は `409 UPLOAD_OBJECT_MISSING`（`original`）。
- 同じ URL へ正しい bytes を PUT し直すと `200`、finalize は `200 created`。
- S3 API で PUT した object の `checksums.sha256` を、binding の `head()` から読めた。
- owner 用 GET で読み戻した original の SHA-256 は `assets.sha256` と一致した。
- 確認に使った asset は trash へ移動済み。

upload 経路:

- owner が Access login を通したうえで、private API の成功応答と `reserve -> PUT -> finalize` が remote-test で通った。
- PUT の宛先が `*.r2.cloudflarestorage.com` であることを DevTools で確認した。Worker は本体を中継していない。
- これにより、remote-test に設定した `ACCESS_AUD` と `ACCESS_TEAM_DOMAIN` で owner の JWT 検証が通ることも確認した。

実 R2 の `412`（2026-09-17。Browser の `fetch()` から CORS 越し。canvas で作った合成 JPEG）:

- 同じ presigned PUT URL へ 2 回目の PUT を送ると、original・thumbnail とも `412` が返った。`res.status` として読め、network error にはならない。
- そのあとの finalize は `200 created`。再試行で `412` を受けた upload が、そのまま ready になれることを確認した。
- 確認に使った asset は trash へ移動済み。

duplicate handling と完全削除: 同一 original の再 upload が `409 DUPLICATE_ASSET` になること、完全削除後は同じ original を再登録できることを確認済み。

### share と境界

- share 経路: album 作成 → asset 追加 → share 発行 → 正しい secret で `200` → revoke → 同じ secret で `404` までを確認済み。
- secret 不正・secret 無しはいずれも `404`。`url` は `/share/{id}#{secret}` の形。
- share から `original` を要求すると `400`。variant は `thumbnail` / `preview` のみ。
- derivative は `*.r2.cloudflarestorage.com` から直接取得した。
- CSRF 境界: 他 origin からの `POST /api/v1/albums` が `403 ORIGIN_NOT_ALLOWED`。
- presigned URL の失効: share の derivative URL が、発行 300 秒後に R2 で `403 ExpiredRequest` になることを確認済み。
- revoke 済み share の既発行 URL が残り TTL の間だけ有効なのは、契約どおり（[共有失効（revoke）の意味](security.md#5-共有失効revokeの意味)）。

### backup / restore

- backup: remote-test に対する `pnpm backup export` と `verify` が通った。original の SHA-256 照合も一致（`ok: true`）。
- restore（2026-09-16 の drill）: 空の `edgephotos-restore-test` へ `pnpm backup restore` を実行し、`ok: true` を確認した。D1 / R2 / Access / CORS / secret は別に用意した。
- restore 先から export し直して manifest を突き合わせた。asset 数・original の SHA-256・album 構成と membership が一致した。
- 主要 metadata（size / content type / filename / width / height / takenAt / isFavorite）も一致した。
- 変わるのは `id` と `createdAt` だけで、[D-015](decisions.md) のとおり。`createdAt` はこの drill の後、[D-024](decisions.md) で保たれるようになった。
- 空でない library への restore が拒否されることも確認済み。
- 20 件規模の restore: restore-test を空にしてから 20 asset・1 album を restore した。restore 先の export と突き合わせ、asset 数・SHA-256 集合・album membership・metadata 7 項目が一致した。original 20 件の再 hash もズレなし。
- `edgephotos-restore-test` は drill 用の一時環境で、検証後に Worker・D1・R2 bucket・Access application・R2 API token をすべて削除した。

### 画像形式と original

画像形式と orientation: 合成 19 枚を upload した。EXIF orientation 1〜8、GPS タグ付き、JPEG / PNG / WebP、160×120 から 6000×4000、1:4 と 40:9 の比率を含む。

- orientation 8 種はすべて同じ向き・同じ寸法として登録された。Client が EXIF を適用している。
- derivative は全件 EXIF・GPS を持たなかった。thumbnail 512 / preview 2048 の上限を守り、上限より小さい original を拡大しない。

original の byte 保持:

- export した original を再 hash し、ローカル原本の SHA-256 と全件一致した。
- trash へ移動して復元した asset も SHA-256 が変わらなかった。

実機由来の画像: 共有経由で保存し直した iPhone の JPEG を 1 枚 upload した。`DateTimeOriginal` も GPS も持たない最小限の EXIF だったが、`takenAt` が `null` になるだけだった。upload・derivative 生成・SHA-256 保持はいずれも正常。

## Browser での取り込み（2026-09-17）

local の `vite dev`、Playwright の Chromium 151 と WebKit 26.5、macOS。

使った画像は 2 種類。

- 公開されている実機サンプル: [metadata-extractor-images](https://github.com/drewnoakes/metadata-extractor-images) と [exif-samples](https://github.com/ianare/exif-samples)。iPhone 4S〜6 Plus、Pixel 2、Galaxy S4〜S8 / Note 8、OnePlus 8、LG G3、Xperia Z3、Moto G、Oppo R7 Plus、Nokia 8.3 ほかを含む
- Pillow で作った合成 fixture

どちらも repository には入れていない。script は scratch 環境で一度きり実行し、commit していない（[テスト用 fixture](development.md#9-テスト用-fixture)）。

metadata:

- EXIF orientation 1〜8（実機の縦位置 orientation 6 を含む）は、両 engine とも thumbnail の向きが一致した。
- 次のものはいずれも upload が成功した: MakerNote（最大約 60KB）、`OffsetTimeOriginal` あり・なし、空白や範囲外の日付、orientation 0 / 9、IFD offset の破損
- `CreateDate` が偽の値（`2002:12:08`）で `DateTimeOriginal` が正しい機種も、upload が成功した
- 日付が読めない場合だけ `takenAt` が `null` になる。
- 200 件を upload し、width / height / takenAt を Pillow で求めた期待値と照合した。両 engine とも不一致 0 件。
- iPhone の HEIC を macOS の `sips` で JPEG に変換すると、`DateTimeOriginal`・`OffsetTimeOriginal`・MakerNote が残り、`-04:00` の offset 付きで取り込めた。Safari の変換結果の代わりに確認したもの（[D-019](decisions.md)）。**iOS の変換も ImageIO によると推定しているが、実機では未確認。**
- Playwright WebKit 26.5 は `createImageBitmap` で HEIC を decode できた。Chromium は `InvalidStateError` になった。

拒否されるもの: 空ファイル、画像でない中身、APP1 の長さが壊れた JPEG、HEIC（専用の文言を表示。[D-019](decisions.md)）。途中で切れた JPEG は engine で分かれ、Chromium では decode 失敗として拒否され、WebKit では下半分が灰色のまま成功する。

見つかって直した問題（[D-020](decisions.md)）:

- WebKit の canvas JPEG に APP1 / APP13 が付き、finalize が全件 `422` にしていた（WebKit で 200 件中 200 件が失敗）。
- PUT が 1 回失敗すると、その写真全体が失敗していた（通信断、応答の喪失、`503` を route で再現）。
- 300 枚を選ぶと、97 件を残して完了表示になっていた。
- 修正後は、WebKit と Chromium で 200 件が全件成功した。失敗を注入した 3 件も再試行で成功し、応答を失った PUT は `412` を経て成功した。300 件の選択は 300 件とも登録された。

memory と前処理の並列数の数値は [benchmarks.md](benchmarks.md) の「Browser の取り込み memory」にあります。

Browser の制約で試せなかったこと: WebKit では Playwright で横取りした PUT の Blob 本文が失われる。そのため再試行の再現は Chromium だけで行った（再試行のコードは engine に依存しない）。

## 継続利用のための修正（2026-09-17）

対象は、完全削除が止まった写真の再 upload、止まった削除の再開、期限切れ upload の件数、取り込みの並列数、100MB 超の事前拒否、`APP_ORIGIN` の診断。

### local

Server 側は workerd の自動テスト、並列数は unit test で確認した。

ライブラリ画面の表示と「削除を再開」、100MB 超の拒否は、Playwright の Chromium で一度だけ確認した（spec は commit していない）。

`worker: APP_ORIGIN` は local の `vite dev` に対して CLI を実行し、`localhost` で PASS、`127.0.0.1` で FAIL になることを確認した。

### remote-test

同日に remote-test へ deploy し、owner token 付きの Node script と Browser で確認した。写真は marker だけの合成 JPEG で、Worker は decode しない。

`pnpm diagnose` は FAIL なし。`worker: APP_ORIGIN` が PASS、`library: interrupted uploads` が WARN（以前の検証で残った期限切れ 2 件。600 秒待つ新しい中断は作っていない）。

その前の構成（`worker: APP_ORIGIN` と `library: *` を足す前）でも、owner token ありで 15 項目すべて PASS だった。`EDGEPHOTOS_URL` を別の origin にすると `r2: CORS for upload`（現在の `r2: CORS`）が FAIL になることも確認した。

止まった削除は、trash 済みのテスト asset を D1 で直接 `purging` にして作った。R2 の削除失敗は remote では起こせないためである。

```sql
UPDATE assets SET status='purging' WHERE id=<テスト asset> AND trashed_at IS NOT NULL
```

確認できたこと:

- `library: unfinished deletes` の WARN、ライブラリ画面の表示、「削除を再開」で削除処理中が 0 になること
- 止まった削除と同じ写真の reserve が `409` ではなく `201` を返し、古い asset の R2 object と D1 row が消えること。続く finalize は `200 created`
- 削除前に reserve・PUT 済みだった upload の finalize が `200 created` を返し、その original を owner 用 URL から読み戻せること（新しい object を重複として消さない）
- 誤った `Origin` の album 作成が `403 ORIGIN_NOT_ALLOWED`、正しい `Origin` では `400 VALIDATION_FAILED` になり、album 数が変わらないこと

実 D1 での並行実行（各 3 回）:

- 同じ `purging` asset に `DELETE` 2 本と同じ写真の reserve を同時に送ると、`DELETE` は 204/204 または 204/404（`ASSET_NOT_FOUND`）、reserve はすべて `201` だった。
- 同じ写真の pending upload 2 件を、`purging` の asset の `DELETE` と同時に finalize すると、どの回も片方が `created`、片方が同じ asset への `duplicate` になった。再送しても同じ結果。
- UNIQUE 競合の fallback を通ったかどうかは外から区別できない。
- **「競合の勝者が `purging`」の分岐は再現していない（コードの確認のみ）。**

この検証で見つけて直したもの:

- 上の 204/404 のように別の request が先に削除を終えると、「削除を再開」はその 404 で止まっていた。404 の ID は飛ばして残りを続けるよう修正した（unit test で確認）。**この修正は remote-test に deploy していない。**

後始末: テスト asset はすべて完全削除し、件数は検証前（写真 21、ゴミ箱 2、削除処理中 0、未完了 upload 2、album 1）に戻した。D1 に今回の upload 行は残っていない。

## 閲覧 UI の改善（2026-09-17）

local の `vite dev`（使い捨ての `EDGEPHOTOS_STATE_DIR`）に、合成 JPEG 90 枚と album 3 件を reserve → PUT → finalize で入れた。撮影日時は約 4 か月に分散させた。確認は Playwright script で行い、実写真は使っていない。

- desktop Chromium（1440×900）: viewer の ←/→ で前後の写真へ移動できる。60 枚目を越えると次のページを読み込んで移動を続けられる。先頭では「前の写真」が出ない。Escape で閉じると、最後に表示した写真の tile に focus が戻る
- phone（WebKit iPhone 13 相当）: 横スクロールなし、header 49px、タブは画面下に固定。viewer の「次の写真」と情報パネルの表示も確認
- phone（Chromium Pixel 7 相当、CDP の touch event）: 左右スワイプで前後に移動、タップで操作ボタンを隠す
- ゴミ箱へ移動すると viewer は次の写真を表示し、「元に戻す」で Server 上も復元される。完全削除とアルバム削除は確認 dialog を出し、キャンセルで何も変わらない
- storage への PUT を失敗させると、日本語の失敗表示と「再試行」が出て、再試行で完了する。一覧 API の 500 では Server の英語 message を出さず、再試行で表示が戻る
- album 一覧は各 album の最新の写真を cover にする（`limit=1` の album assets API。API の変更なし）
- 2 枚を続けてゴミ箱へ移動すると「元に戻す」が 2 つ並び、それぞれが対応する写真だけを復元する
- 情報パネルは写真を移動しても開いたままで、viewer を開き直すと閉じている。アップロード中の表示は完了枚数（例: 0 / 3 枚）と処理中のファイル名

Hallmark audit 後の修正（同日）は 8 件。

- 共有リンクの再発行・無効化の確認 dialog
- viewer の preview 失敗表示と再試行
- 共有ページ拡大表示の focus 管理
- Undo toast の touch target
- 長い menu のスクロール
- phone のゴミ箱の現在地表示
- 共有 dialog の入力欄 16px
- 全件完了したアップロード表示の自動消去

Playwright（Chromium / WebKit iPhone 13 相当）で確認した。各 spec は、対応する修正を戻すと失敗することも確認した。

修正中に、入れ子の Dialog で Base UI の生成 id が重複する不具合を見つけて直した。確認 dialog が外側の dialog の説明文で名前付けされていた。

**iOS Safari 実機での入力時 zoom と touch 操作は未確認。**

常設の回帰は `e2e/keyboard.spec.ts`、`e2e/mobile.spec.ts`、`e2e/viewer.spec.ts`（[テスト方針](development.md#8-テスト方針)）。**iPhone / Android の実機での swipe と safe area は未確認。**

## 見た目の整理（2026-09-17）

機能・情報設計・API は変えず、色・枠・影・ボタンの強弱だけを見直した。

変更の内容:

- token は無彩色にした
- 塗りのボタンは、header のアップロード（desktop）と各画面の主操作に限る
- pill 形は header 行の操作だけ。form と dialog のボタンは角丸の長方形
- header と phone のタブは不透明
- accent は現在地・focus・進捗に限る
- 入れ子の確認 dialog では外側の dialog を暗くする
- phone では黒塗りのアップロードが写真より先に目に入ったため、phone だけ塗りのないアイコンにした

確認方法: local の `vite dev`（使い捨ての `EDGEPHOTOS_STATE_DIR`）に合成 JPEG 18 枚と album 2 件を入れた。Playwright で desktop Chromium（1440×900）と WebKit iPhone 13 相当の timeline・album・共有 dialog・確認 dialog・ライブラリ・viewer を、変更前後で撮って比べた。彩度の低い合成画像 24 枚でも timeline を撮った。

共有ページだけは `vite build` + `vite preview` で share API を mock して確認した。`vite dev` では CSP（`style-src 'self'`）が inline style を拒否し、CSS が当たらないため。

`pnpm check` と `pnpm test:e2e`（13 件）が通った。

## 長期保管の整合性（2026-09-17）

対象は、storage audit / cleanup、paged export、差分 backup と `check`、restore の `--resume`、verify の `--quick` です。加えて、完全削除と復元の競合、finalize の UNIQUE 競合、upload の再試行、元ファイルの形式判定も含みます。

### local（workerd の自動テスト）

競合 2 件は、修正前のコードで再現するテストを先に書いて失敗を確認した。

- 完全削除の開始と trash からの復元が交差すると、復元した写真が `purging` になって R2 から消えていた。
- finalize の D1 batch が commit した後に UNIQUE 違反が報告されると、自分の asset の 3 object を重複として消していた。SQLite 自体は、同じ upload の再送では id の競合を先に検出する。現在の D1 でこの経路に入る状況は確認しておらず、防御として直した。

storage audit:

- 1 つの ID の下に layout 外の key を 8,001 個置くと、その ID は `audit_incomplete` になった。`missing_derivative` と誤報せず、次の写真の点検は続く。印を付ける処理を外すとテストが失敗することも確かめた
- 10 分類のすべてを 1 つのライブラリに作り、`limit` を 1・2・3・5・200 にしても同じ結果になった
- object の無い asset と行だけの upload が、ページ境界をまたいでも漏れなかった
- audit の前後で D1 と R2 が変わらないことを確認した。ページの終わりを決める処理（asset 側・upload 側）を 1 つずつ外すとテストが失敗することも確かめた

storage cleanup:

- 転送済みの中断 upload は写真になった（元の upload 時刻と撮影日時を保持）
- 消えるのは、欠けている・行だけの upload と重複の残りだけだった
- 写真・trash・止まった削除・object の欠けた写真・どの行も指さない object・1 日以内の upload・進行中の upload は残った
- 2 回目は何もしない。R2 の障害では何も消さず `failed` に数える
- cleanup が upload を片付けた後、検査を終えていた finalize は asset を作らなかった（`410`）

backup:

- 2 回目は storage への request が 0、写真を 1 枚足すと 3 request
- 途中で切れたファイルは取り直した。同じ size で 1 bit 違うファイルは `check` だけが検出した
- original が壊れた写真があっても残りを backup し、その写真を名前で挙げた

restore:

- Access token が 3〜14 回目のどの API 呼び出しで切れても、`--resume` で最後まで進んだ。`verify`（全件 download）も `ok` になった
- 記録に無い album や backup に無い写真がある library には再開しない。終わった restore は再開しない
- restore 後の timeline の並びは元と同じだった（撮影日時の無い写真を含む）

verify: `--quick` が download 0 件で `ok` になり、original の size が変わった写真を storage audit で検出した。

paged export: 1 件ずつ・2 件ずつのページを重複なく連結できた。ページの間に写真の削除と追加があっても、manifest が知らない asset を指さなかった。

backup manifest v1（[D-025](decisions.md)）:

- export が書いた manifest はそのまま通り、未知の key を足しても通った
- 15 件以上あるときは 10 件と残件数を出した

次のものを、field の位置と理由付きで拒否した。

- 壊れた JSON、別の `format`、`formatVersion: 2`、必須 field の欠落、型違い
- 大文字や 63 桁の SHA-256、size 0 / 負数 / 上限超え、扱えない content type
- 空や 256 文字の filename、0 pixel、空や前後に空白のある album title
- ISO 8601 でない `takenAt`、instant でない `createdAt` / `trashedAt` / `exportedAt`
- 実在しない日時（`2024-99-99…`、3 月 1 日へ繰り上がる `2024-02-30`）
- asset ID の重複、1 つの original に 2 つの asset、album ID の重複、album 内の重複、存在しない asset への membership も拒否した

restore の入口: 壊れた manifest と壊れた `restore-state.json` は、対象ライブラリへ 1 度も request を送らずに拒否された（request が出たらテストが失敗する client で確認）。

### remote-test（2026-09-18）

`edgephotos-remote-test` へ deploy して実行した。合成 JPEG のみを使い、実写真は追加していない。

- migration `0002`・`0003` を remote D1 へ適用した。`pnpm diagnose --env remote-test` は FAIL なし（`worker: D1 schema` が `0003_filtered_list_indexes.sql`）
- D1 の `EXPLAIN QUERY PLAN`（REST、read-only）で、部分 index が D1 でも選ばれることを確認した
  - favorites: `SCAN a USING INDEX assets_favorites`
  - trash（cursor 付き）: `SEARCH a USING INDEX assets_trash ((sort_at,id)<(?,?))`
  - 止まった削除の一覧: `SCAN assets USING COVERING INDEX assets_purging`
- storage audit: `limit` を 1・2・3・500 に変えても、分類も件数も同じだった（25 枚・75 object）。実 R2 の `list()` の並びと `startAfter` は、ページ境界の前提どおりに動いた
- `--deep`: 直前に upload した asset は R2 が記録した SHA-256 と一致した。D-018 より前の 21 件だけが `original_checksum_unrecorded` になった。S3 API で PUT した object の checksum を binding の `head()` から読めることを、この構成でも確認した
- backup: 初回 27.9 秒（25 枚、storage GET 75 回）、変更なしの 2 回目は 0.64 秒（download 0、API 4 回）、1 枚追加後は 1 件だけ download。`pnpm backup check` は `ok: true`
- verify: 通常 7.1 秒（26 件 download）、`--quick` 6.1 秒（download 21 件 = checksum の記録が無い古い original のみ、5 件は R2 の記録で確認）
- storage cleanup: 以前の検証で残っていた期限切れ upload 2 件を dry run で確認し、`--apply` で破棄した（`discarded 2, cleared 2, failed 0`）。実行後の audit は「不整合なし」、`pnpm diagnose` の WARN も消えた

### restore drill（2026-09-18、`edgephotos-restore-test`）

空の D1・R2・Access application・R2 API token を新しく作り、remote-test の backup から restore した。

- restore を API 呼び出しの 13 回目と 41 回目で `401` にして 2 回中断させ、`--resume` で完走した（26 枚・1 album、最後の実行での upload は 4 枚）
- restore 先の `pnpm backup verify` は通常・`--quick` とも `ok: true`（問題 0 件）。`pnpm storage audit --deep` も「不整合なし」
- 中断した restore が残した reservation 1 件は `uploads in progress` として見えた（期限内なので cleanup の対象外）
- 終了後に Worker・D1・R2 bucket を削除した（R2 bucket は object を消してから削除）。この drill 用の R2 API token（対象は drill の bucket のみ）も削除した
- Access application 2 件は、次の drill で再利用できるため残した（[復旧 drill](operations.md#14-復旧-drill)）

作業中に分かった運用上の注意（[利用者が設定する値](operations.md#3-利用者が設定する値) に反映）:

- `wrangler secret put` で先に Worker を作ってから deploy すると、deploy 前に入れた secret は残らなかった
- 標準入力が端末でない環境では、secret の値が空のまま「Success」と表示される

### local（Browser）

`pnpm test:e2e`（Chromium・WebKit、13 件）が通った。

加えて、`vite dev` の使い捨て state に対して、Chromium で一度きりの Playwright script を実行した（commit していない）。

- album 一覧は cover の画像を読み込み、album ごとの request（`/api/v1/albums/{id}/assets`）を 1 回も送らない。空の album は icon のまま
- finalize が 3 回 `503` になった写真は「転送は終わりましたが、登録を確認できませんでした…再試行すると、転送をやり直さずに登録します」と表示された。再試行で PUT を 1 回も送らずに完了した
- 中身が PNG で名前が `.jpg` のファイルは、PNG として upload され完了した（以前は finalize が `content_type_mismatch` で毎回拒否した）
- 3 日前の中断 upload（行だけ）を D1 に入れると、ライブラリ画面の「点検する」が「途中で止まったアップロード」1 件を表示した。「中断したアップロードを整理する」で破棄され、再点検で問題なしになった

### 形式と Browser 差の確認（コードの確認のみ）

取り込み結果が Browser で変わりうる点:

- derivative の画素（縮小の実装と JPEG encoder の違い）。content identity には使わないので許容する
- WebP の orientation と、途中で切れた JPEG（[roadmap.md](roadmap.md) の既知の制約のまま）
- 撮影日時は JS の `exifr` で読むので engine に依存しない

元ファイルの形式は、今回から中身の先頭 byte で決める（finalize と同じ関数）。Browser が拡張子から推測する `type` の違いに左右されない。

## derivative の作り直し（2026-09-18）

### local（workerd の自動テスト）

`tests/integration/repair.test.ts` と `tests/unit/repair.test.ts`。R2 の object を直接消して壊し、作り直して audit が正常に戻るまでを確認した（[D-026](decisions.md)）。

- thumbnail だけ・preview だけ・両方の欠損を、それぞれ `missing_derivative` として検出し、作り直したあと audit が空になること
- 作り直しの前後で、次がすべて一致すること: `assets` 行全体、`album_assets`、`uploads` 行、original の size / etag / R2 記録の SHA-256、original の byte 列から計算し直した SHA-256。favorite と album に入れた写真、trash 内の写真でも同じ
- original が無い / size 違い / 同じ size で SHA-256 違いのとき、URL を発行せず `409 REPAIR_SOURCE_UNUSABLE` になること
- 壊れた derivative を PUT した場合（EXIF あり・JPEG でない・途中で切れている・空・size 超過）、その object を削除せずに報告し、検査時点の ETag への `If-Match` で置き換えられること
- 同時実行: 2 つの repair から同じ key へ PUT すると、後から届いた方が `412` になり、先に保存された bytes が残ること。妥当な derivative が上書きされないこと
- 完全削除と重なった場合: 削除後に届いた PUT は derivative key だけを残し（original は残らない）、audit が `unreferenced_objects` として報告すること。以後の repair は `404`
- Client 側（`repairAsset`）: `status: 'ok'` だけを完了とみなすこと。PUT が成功しても、Server がまだ欠損と言う間は作り直しを繰り返すこと。回数に上限があること。original の SHA-256 が合わなければ何も PUT しないこと

古い view を持った repair が、新しい repair の結果を取り消せないことも確認した。同じ「使えない object」を見た 2 つの repair のうち一方が写真を直したあと、もう一方の target を使うと `412` になり、直った derivative が byte 単位で残る。削除してから作り直す実装に差し替えると、このテストが落ちることも確かめた。

実装上の注意: `If-Match` に raw の `etag` を渡すと、R2 は `Invalid ETag in if-match header` を投げる。引用符付きの `httpEtag` を使う。

`pnpm diagnose` の `r2: CORS` が、`AllowedMethods` に `GET` の無い rule を FAIL にすることも unit test で確認した。

### remote-test（2026-09-18、CORS の設定と preflight のみ）

作り直しは original を `<img>` ではなく `fetch()` で読むため、応答に `Access-Control-Allow-Origin` が要る（[D-026](decisions.md)）。`edgephotos-remote-test` の bucket に対して、認証なしの読み取りだけで確認した。

- `wrangler r2 bucket cors list edgephotos-remote-test` の結果は、`allowed_origins` が app origin 1 つ、`allowed_methods` が `GET, PUT`、`allowed_headers` が `content-type, if-none-match, x-amz-checksum-sha256`。運用の [R2 CORS](operations.md#6-r2-cors) の規則のままで、作り直しのための設定変更は不要だった
- 実 R2 への preflight（`OPTIONS`、app origin）: `GET` / `PUT` とも `204` で、`Access-Control-Allow-Origin` に app origin、`Access-Control-Allow-Methods` に `GET, PUT` が返った。`fetch()` が original の body を読めることの前提を実環境で確認した
- 別 origin（`https://evil.example`）からの同じ preflight は `403` で、CORS header を返さない（「`APP_ORIGIN` に限定する」。セキュリティの [presigned URL](security.md#6-presigned-url)）

**Browser から実際に壊れた写真を作り直す往復は未実施**（下の「未検証」）。

## CI の時間制限（2026-09-21）

GitHub Actions で `Test timed out in 5000ms` が断続的に出ていました。落ちるのは `tests/integration/export-restore.test.ts` の 1 件です。

> interrupted restore > continues where it stopped, at any point, and ends identical to the backup

判断は [D-029](decisions.md) にあります。

### CI で測った値

GitHub Actions `ubuntu-latest`、`pnpm test`。run 35576409905 の 2 回の attempt は同じ commit（62e9047、ドキュメントのみ）です。

| run | tests 合計 | storage audit の 8001 key test | interrupted restore |
| --- | --- | --- | --- |
| 35576409905 attempt 1（失敗） | 77.90s | 28880ms | 7197ms（5000ms で打ち切り） |
| 35579077350 | 34.93s | 15194ms | 2068ms |
| 35575268896 | 27.97s | 13275ms | 1981ms |
| 35576409905 attempt 2 | 20.39s | 8915ms | 1659ms |

同じコードで最も重い test が 8.9 秒から 28.9 秒まで 3.2 倍ぶれます。run の中では全部が同じ比率で伸びます（tests 合計 ÷ 8001 key test = 2.1〜2.7）。失敗した run は、この test だけが遅かったのではなく、run 全体が遅い側の端でした。

### 同じ原因で落ちうるもの

最遅 run（35576409905 attempt 1）で 5000ms に近かった test です。local は macOS / 8 core での `pnpm test`。

| test | local | 最遅 CI | 5000ms までの余裕 |
| --- | --- | --- | --- |
| storage audit: says an id was not fully checked | 5765ms | 28880ms | 既に `60_000` を個別指定していた |
| export/restore: continues where it stopped | 1002ms | 7197ms | 超過 |
| storage audit: classifies every inconsistency | 362ms | 3403ms | 1.5 倍 |
| export/restore: round-trips assets | 450ms | 2394ms | 2.1 倍 |
| storage audit: does not write anything | 763ms | 2102ms | 2.4 倍 |
| albums: adds and removes assets idempotently | — | 2083ms | 2.4 倍 |
| export/restore: verification detects missing assets | 138ms | 1763ms | 2.8 倍 |
| uploads: unique constraint race | — | 1718ms | 2.9 倍 |

CI と local の比は test ごとに 2.8〜12.8 倍と一定しません。

`storage.test.ts` の `beforeEach(resetStorage)` も同じ位置にあります。8001 key を作る test の直後の 1 回だけ local で 768ms かかります（他の回は 0〜5ms）。

CI では測っていません。同じ file の test で観測した CI / local 比は 5.0 倍（5765ms → 28880ms）です。これを掛けると約 3.8 秒、既定の `hookTimeout` 10 秒に対する余裕は 2.6 倍という見積もりになります。

### 失敗した test の中身

local で 12 周（okCalls 3〜14）の内訳を測りました。合計 690〜712ms で、突出した処理はありません。

- API 呼び出し 292 回: Worker 内 345ms
- storage 呼び出し 102 回: 85ms
- test 側の RS256 署名 292 回: 179ms（1 回 0.6ms。認証込みの GET 1 件が 1.0ms）
- D1 / R2 の初期化 12 回: 34ms

test file 単独では 725ms、suite 全体では 960〜1085ms です。`storage.test.ts` を外しても 989〜1133ms で変わらないので、local では重い 1 file が他を押し出しているのではありません。

### 直したあと

`vitest.config.ts` に `testTimeout` / `hookTimeout` = 120 秒を置き、`storage.test.ts` の個別指定を消しました。test の中身と assertion は変えていません。

run 35581112151 を 5 回続けて実行し、すべて緑でした。

| attempt | tests 合計 | storage audit の 8001 key test | interrupted restore |
| --- | --- | --- | --- |
| 1 | 66.54s | 25014ms | 5975ms |
| 2 | 28.94s | 13648ms | 2058ms |
| 3 | 29.73s | 13400ms | 2136ms |
| 4 | 26.64s | 12150ms | 1921ms |
| 5 | 30.33s | 14654ms | 2379ms |

attempt 1 は遅い runner に当たり、interrupted restore が 5975ms かかりました。変更前の 5000ms なら、この attempt は落ちています。最も重い test は 25014ms で、120 秒に対して 4.8 倍の余裕があります。

## 未検証

### iPhone / Android 実機での取り込み

未確認です。desktop の WebKit では代用できません。[roadmap.md](roadmap.md) の Post-merge verification で確認します。

iPhone Safari:

- 48MP の HEIC を複数選択する。iOS Safari の memory 上限（jetsam）と 48MP 以上の decode を見る。落ちる場合は前処理の並列数 1 を試す（[D-020](decisions.md)）
- iCloud にしかない写真を選ぶ
- 100〜200 枚を選ぶ
- upload 中に画面をロックする、Safari を background へ移す、Wi-Fi とモバイル回線を切り替える
- 10 分を超えて中断し、presigned URL の期限（600 秒）切れを踏む
- 選択時の HEIC → JPEG 変換と、位置情報の扱いを確認する

Android: 上と同じ項目のうち該当するもの（HEIF 設定の端末を含む）。

### derivative の作り直しの往復

bucket の CORS 設定と実 R2 の preflight までは確認済みです（上）。Browser からの往復は未実施です（[D-026](decisions.md)）。

remote-test への deploy と Access login（対話操作）が要ります。presigned URL の署名には Worker secret の R2 credential が要るため、`wrangler` だけでは代用できません（`wrangler r2 object put` に条件付きの option はありません）。

確認する項目:

- 壊した写真（remote-test の bucket から thumbnail を 1 つ削除）を、ライブラリ画面の「サムネイルを作り直す」で直せること。作り直し後に audit が正常へ戻ること
- 実 R2 の presigned GET を Browser の `fetch()` から CORS 越しに読み、body の SHA-256 が `assets.sha256` と一致すること（preflight は確認済み。実際に body を読むのはこの手順）
- 作り直した derivative の PUT（`Content-Type` + `If-None-Match: *`）が通り、同じ URL への 2 回目が `412` になること
- 実 R2 の `head().checksums.sha256` を使った original の照合が、作り直しの入口で期待どおり働くこと（`409 REPAIR_SOURCE_UNUSABLE`）
- **`If-Match` 付き presigned PUT**（この経路で初めて使う条件）: 検査した ETag なら `200`、古い ETag なら `412`、先に保存された bytes が残ること
- `pnpm diagnose` の `r2: CORS` が remote-test の bucket で PASS すること
- 確認に使った asset は trash へ移動する（この文書の他の項目と同じ扱い）

表示が崩れた場合に見る箇所は `src/web/lib/image.ts` の `createImageBitmap(file, { imageOrientation: 'from-image' })` です。original は byte 単位で保持されるので、derivative を作り直せば復旧します。
