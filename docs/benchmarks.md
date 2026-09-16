# Scale 測定

1,000〜10,000 asset を想定した測定結果と、その結果をもとに下した判断を記録します。測定は合成データで行い、実写真は使っていません。

再測定:

```bash
pnpm bench      # tests/bench/scale.bench.ts（local workerd。assert はせず数値を表示する）
```

## 環境（2026-09-17）

- macOS / Apple Silicon、Node 24.19、`@cloudflare/vitest-pool-workers` の workerd と Miniflare（D1 は SQLite、R2 は local）
- API は実際の SigV4 signer（偽の credential）で URL を署名して測った。ネットワーク遅延は含まない
- `rows_read` は、app が実際に発行した SQL を記録し、同じ bind 値で再実行して取った
- remote の往復時間は remote-test で実測した（read-only。次の表）
- Browser は `vite dev`（development build）に 10,000 件を投入し、Playwright の Chromium と WebKit で測った。画像は route で 22KB の JPEG に差し替え、R2 と転送時間は含めない

remote-test の往復時間（中央値、東京から）:

| request | ms |
| --- | --- |
| `GET /api/v1/me` | 19 |
| `GET /api/v1/assets?limit=60` | 35 |
| `GET /api/v1/assets/{id}`、`/original` | 31〜33 |
| `GET /api/v1/export`（数件） | 67 |
| R2 presigned GET（小さい thumbnail） | 105 |

## API（local、中央値）

| 操作 | 1,000 件 | 10,000 件 | rows_read（10,000 件） |
| --- | --- | --- | --- |
| timeline 1 ページ目（60） | 5 ms | 5 ms | 64 |
| timeline 1 ページ目（200 = 上限） | 14 ms | 15 ms | 212 |
| timeline 最終ページ（60） | 4 ms | 4 ms | 9,959 → **65**（修正後） |
| timeline を 200 件ずつ全件 | 68 ms | 693 ms（48 ページ） | |
| favorites 1 ページ目（1%） | 1 ms | 6 ms | 6,001 |
| trash 1 ページ目（5%） | 4 ms | 5 ms | 1,211 |
| album 一覧（21 album） | 1 ms | 5 ms | 18,062 |
| album の 1 ページ目（5,000 枚の album） | 5 ms | 8 ms | 14,751 + 存在確認 10,002 → **1** |
| album へ追加 / から削除 | 1〜2 ms | 1〜3 ms | 10,004 → **1**（修正後） |
| 共有 album の 1 ページ目（120） | 6 ms | 8 ms | 14,751 |
| album 削除（5,000 枚） | | 17 ms | |
| export manifest | 11 ms / 600 KiB | 84 ms / 5.8 MiB | 37,042 |
| diagnostics | 1 ms | 3 ms | 30,022 |

CPU だけの cost（Node、同じ V8）:

| 処理 | ms |
| --- | --- |
| SigV4 の presign 120 回（timeline の 60 件分） | 約 15（初回の warm-up を含む） |
| SigV4 の presign 400 回（limit=200） | 約 26 |
| export の `JSON.stringify`（1,000 / 10,000 件） | 1.1 / 10.6 |

## Query plan

remote-test の D1 に、同じ SQL を bind parameter 付きで `EXPLAIN QUERY PLAN` した結果（D1 の REST query API。read-only）:

| cursor の書き方 | plan |
| --- | --- |
| `(sort_at < ? OR (sort_at = ? AND id < ?))`（修正前） | `SCAN a USING INDEX assets_timeline` |
| `(sort_at, id) < (?, ?)`（修正後） | `SEARCH a USING INDEX assets_timeline ((sort_at,id)<(?,?))` |

値を literal で埋め込むと、修正前の形でも `SEARCH` になります。app は bind するので、本番でも修正前は index を先頭から走査していました。

その他の plan（local、10,000 件）:

- timeline / favorites / trash: `SCAN a USING INDEX assets_timeline`。先頭から条件に合う行を 61 件集めて止まる。favorites は 1% なので約 6,000 行を読む
- album の page: `SEARCH aa USING COVERING INDEX (album_id=?)` → `SEARCH a (id=?)` → `USE TEMP B-TREE FOR ORDER BY`。album の全 member を読んで並べ替える
- album の件数: member ごとの相関 subquery。album 一覧は全 album の member 数の合計を読む
- export: assets を全件、membership を全件 join
- diagnostics: assets を 3 回全件 scan

## Backup / restore（local、API 経由の逐次処理）

| 操作 | 1,000 件 | 10,000 件 | request 数（10,000 件） |
| --- | --- | --- | --- |
| `backupLibrary`（original + derivative） | 3.2〜4.4 s | 34 s | API 20,001 + storage GET 30,000 |
| `verifyLibrary` | 1.5 s | 15 s | API 10,001 + storage GET 10,000 |
| `restoreLibrary`（空の環境へ） | 10〜12 s | 100〜105 s | API 29,622 + storage PUT 30,000 |

どちらも asset 数に比例しました。10,000 件でも memory と D1 の上限には当たりません（manifest は 5.8 MiB）。

remote での見積もり（上の往復時間から。original の転送時間は含まない）:

- backup: API 20,000 × 約 30 ms + storage GET 30,000 × 約 105 ms ≒ 1 時間
- restore: API 約 30,000 × 30〜50 ms + storage PUT 30,000 × 約 100 ms 以上 ≒ 1〜1.5 時間
- original が 1 枚 3 MB なら 10,000 件で 30 GB。回線次第で、転送時間も同じ桁になる

## Browser（10,000 件、`vite dev`）

| 項目 | Chromium | WebKit |
| --- | --- | --- |
| timeline の最初の tile | 398 ms（FCP 216 ms） | 349 ms（FCP 211 ms） |
| 最初の表示で取得する thumbnail | 60 | 60 |
| 「さらに読み込む」1 回（1,000 件表示時） | 70 ms | 104 ms |
| 同（3,000 件） | 79 ms | 192 ms |
| 同（6,000 件） | 114 ms | 437 ms |
| 同（10,000 件） | 147 ms（最大 274） | 816 ms（最大 1,437） |
| JS heap / DOM node（10,000 件表示時） | 64 MB / 30,487 | 取得不可 |
| 10,000 件表示時に viewer を開く | 206 ms | 1,316 ms |
| お気に入りへ移動 | 139 ms | 227 ms |

production build の bundle（gzip）: app 83 KB、共通 CSS / JS 14 KB、共有ページ 1.5 KB。

期限切れ URL の回復（[D-021](decisions.md)）の cost（1,020 件表示時、Chromium）: API 17 回。表示済みの thumbnail は再取得しない（修正前の実装では 1,021 枚を取り直していた）。1 分以内に次の失敗が起きても再取得しない。

## 判断

### 変更したもの

| 項目 | 根拠 | 変更 |
| --- | --- | --- |
| timeline の cursor | 本番 D1 の plan が `SCAN`。rows_read が page の深さに比例（10,000 件の最終ページで 9,959 行）。D1 は rows read で課金・制限される | row value の比較に書き換え（index は追加していない）。最終ページは 65 行 |
| album の存在確認 | 追加・削除・page 取得・共有の作成のたびに member 数を数えていた（5,000 枚の album で 1 回 10,004 行）。restore で 5,000 枚を album に入れると、合計約 2,500 万行になる | 主キーでの存在確認に置き換え（1 行）。件数が必要な album 取得・一覧はそのまま |
| 期限切れ URL の回復 | 1,020 件表示時に 1,021 枚を再取得していた | 表示済みの thumbnail は URL を差し替えない |
| backup / restore の再試行 | 10,000 件で約 6 万回の逐次 request。1 回の通信失敗で全体が止まり、restore は空の環境を作り直す必要があった | 冪等な request だけを backoff 付きで最大 4 回試す（D-020 と同じ基準。`412` は保存済み）。`POST /albums` は繰り返さない |

### 測って、変更しなかったもの

| 項目 | 測定 | 判断 |
| --- | --- | --- |
| favorites / trash 用の index | 10,000 件で 6 ms、6,001 行 | index を追加しない。favorite が 1% より少なく、library がさらに大きくなれば再検討する |
| album の page と共有 album | 5,000 枚の album で 8 ms、1 ページあたり 14,751 行 | 変更しない。album の中身を撮影日時順に返すには、assets 側の値で並べ替える必要がある。非正規化は見合わない |
| album 一覧の件数 | 21 album で 18,062 行、5 ms | 変更しない |
| diagnostics | 30,022 行、3 ms | 変更しない。表示は設定画面と restore 前の確認だけ |
| export | 10,000 件で 84 ms、5.8 MiB | 変更しない。D1 に結果サイズの上限はなく（1 行 2 MB、query 30 秒）、Worker の memory にも余裕がある |
| backup / restore の並列化 | remote で約 1〜1.5 時間（10,000 件）と見積もった。並列化で縮むのは往復時間の分だけで、転送時間は縮まない | 並列化しない。年に数回の操作で、再試行を入れたので途中で止まりにくい |
| restore の再開 | | 実装しない。途中で止まった場合は、これまでどおり空の環境を作り直す（[operations.md](operations.md) §10） |
| timeline の仮想スクロール | 10,000 件を手で読み込むと、WebKit で 1 回 0.8 秒、viewer を開くのに 1.3 秒 | 入れない。60 件ずつ 160 回以上押した場合の値で、最初の表示は 60 件のまま速い |
| Queue / Durable Objects / 別 Worker / cache | どの測定でも必要性が出なかった | 追加しない |
| 前処理の並列数 | 今回は測っていない（[D-020](decisions.md) の測定のまま） | 2 のまま |

### plan に依存する注意

Workers Free の CPU 上限は 1 request 10 ms です。timeline の 1 ページ（60 件 = 120 URL の署名）は CPU だけで 10 ms 前後、10,000 件の export は `JSON.stringify` だけで約 11 ms かかります。数千件以上を Free で使うと、上限に当たる可能性があります。Workers Paid（既定 30 秒）では問題になりません。どちらの plan で使うかは運用者が決めます。コードは変更していません。

D1 の rows read も plan で上限が違います（Free は 1 日 500 万行）。修正後、timeline を 1 ページ読む cost は page の深さによらず約 60 行です。album 一覧と album の page は、album の大きさに比例します。
