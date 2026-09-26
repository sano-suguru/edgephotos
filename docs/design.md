# 画面の設計

Web UI の見た目と操作感の規則です。画面を足すときや直すときは、この規則に合わせます。

値の正本は `src/web/styles.css` の `@theme` です。この文書は、どの token をどの役割に使うかを決めます。確認した結果は [verification.md](verification.md#見た目の整理2026-09-17) と [画面の型の統一](verification.md#画面の型の統一2026-09-23) にあります。

## 1. 方針

- 写真が色を持つ。chrome（header、tab、ボタン、見出し）は無彩色にする
- accent は現在地・focus・進捗・選択だけに使う。飾りに使わない
- section は余白と文字の強弱で分ける。枠や影で囲まない
- 画面ごとに型を変えない。見出し・空状態・ボタンの形は全画面で同じ部品を使う

## 2. 色

| token | 役割 |
| --- | --- |
| `background` / `foreground` | 地と文字 |
| `muted` / `muted-foreground` | tonal ボタン・input の地、補足の文字 |
| `border` | hairline（区切り線・menu の枠・header の下線）。`black/5` などを直接書かない |
| `primary` / `primary-foreground` | 塗りのボタン（ink） |
| `accent` / `accent-foreground` | 現在地・focus ring・進捗・選択（選択の check は `accent-foreground`） |
| `destructive` / `destructive-foreground` | 取り消せない操作とエラー |
| `favorite` | viewer のお気に入りの星 |

写真を見る暗い面（viewer、共有ページの拡大表示、info toast）は stage token を使います: `stage`（地）、`stage-raised`（info panel・toast）、`stage-control`（写真の上に置くボタンの地）、`stage-hover`、`stage-hairline`、`on-stage` / `on-stage-muted`（文字）。

OS が dark のとき（`prefers-color-scheme: dark`）は、`styles.css` が上の表の token だけを dark の値に置き換えます。stage token と `favorite` は両方で同じです。影が見えない dark では、dialog と info toast の縁に hairline を出します（`dark:ring-1`）。テーマを切り替える UI は持ちません。

`text-white`・`bg-black/40`・`neutral-900` のような token 外の色は書きません。必要な色が無ければ `@theme` に役割名で足します。

## 3. 文字

- font は system font だけを使う（`--font-sans`）。font file を読み込まない（[security.md](security.md#8-http--browser)）
- 見出しは 2 段: ページの h1 は `text-title`、その下の見出し（月・section・dialog title）は `text-heading`。本文は `text-sm`、補足は `text-xs`
- h1・h2・h3 には `palt` がかかる（和文の字間を詰める）
- 枚数・日付・件数は `tabular-nums`
- input は `text-base md:text-sm`。phone で 16px 未満にすると iOS Safari が入力時に拡大する（`e2e/mobile.spec.ts` が検査）

## 4. 形

| 形 | 使う場所 |
| --- | --- |
| `rounded-full` | icon ボタン、header 行のページ操作（pill） |
| `rounded-control` | input、form・dialog のボタン、menu item、text 的なボタン |
| `rounded-surface` | dialog、menu、album の cover、toast、upload 状況 |
| `rounded-t-sheet` | phone の info sheet |
| 角なし | 写真の grid の tile |

## 5. ボタン

- 塗りのボタン（`default`）は 1 画面 1 つ。header のアップロード（desktop）と各画面の主操作に限る
- 塗りの赤（`destructive`）は、取り消せない操作を確認する段だけ
- それ以外は tonal（`secondary`）・ghost・text で下げる
- phone では塗りのないアイコンにする操作がある（アップロード）。小さな画面で塗りが写真より先に目に入るため
- 全ボタンに押下の状態がある（`active:`、motion を許す環境では少し縮む）
- 処理中は `busy`: 無効化して `aria-busy` を付け、label は残したまま spinner を遅れて出す（すぐ終わる処理では出ない）

## 6. 部品

- ページ見出しは `PageHeader`（`components/ui/page.tsx`）。戻る link は phone だけに出す（desktop は header nav にある）。album のように nav に無い場所へ戻るときは `always`
- 空の一覧は `EmptyState`（`components/ui/empty.tsx`）: icon、1 行、埋め方の補足
- timeline の月見出しは、年を下げて月を強く出す。timeline に限り月の枚数を並べる（favorites・album・ゴミ箱の一覧では出さない。枚数は library 全体の集計のため）
- timeline の「年月で移動」と「選択」は 1 行に置く。選択中も「年月で移動」は選択 bar の上に残す（別の月を開くと選択が終わる）
- header と phone のタブは不透明。写真が下に透けない
- desktop nav の現在地は、太さと ink に加えて accent の短い下線。pill は置かない
- 入れ子の確認 dialog では、外側の dialog を暗くする

## 7. 操作の大きさ

- phone で触る操作は 44px 以上。`Button` は md 未満で自動的に 44px になる
- header の高さ（`h-12 md:h-14`）は固定。sticky の月見出しと選択 bar が `md:top-14` で揃えている

## 8. 動き

- 動かすのは `opacity` と `transform`（`scale` / `translate`）だけ
- dialog と menu は開閉で短く fade し、少し拡大縮小する。phone の info sheet は fade だけ
- `prefers-reduced-motion: reduce` では fade だけにする（scale は `motion-safe:` の下に置く）
- focus ring は動かさない。focus と同時に出る
- 成功は静かに示す。取り消せる操作は確認 dialog ではなく Undo 付きの toast にする
