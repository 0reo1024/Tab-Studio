# 性能改善の進捗（Electron版、Tauri移行前）

最終更新：2026-10-09 ／ 計画書：`performance_and_tauri_migration_plan.txt` §1・§2
設計メモ：`docs/performance-architecture-notes.md`
計測結果：`docs/performance-baseline-2026-10.md`

## 再開手順

1. `pnpm test`（現在 195 件すべて合格）
2. `pnpm build && node scripts/perf-benchmark.mjs <label>`。結果は `test-results/perf-<label>-*/report.json`。比較は `node scripts/perf-summary.mjs base.json after.json`。
3. UIの確認は `node scripts/run-ui-checks.mjs [名前...]`。スタート画面より前に書かれた古いスクリプトには、デモを開く shim を自動で付ける。
4. 基準値（HEAD 8d54f5c に計測プローブだけを入れたもの）を取り直す場合：`git worktree add --detach <dir> 8d54f5c`、node_modules をジャンクションで共有し、`src/perf.ts` を置いて、プローブの差し込み（main.ts の該当関数を perfTime で包む）を行う。

## 完了（コミット c93c7ce と、その直後の修正・文書コミット）

| 項目 | 内容 | 主な効果（中央値、168×2 → 600×8 は計測文書を参照） |
|---|---|---|
| 計測（段階A） | perf.ts、perf-benchmark/summary、verifySnapshot | 基準値を記録 |
| B1 小節単位の編集 | commitInBar／refinishBar／patchBar、小節単位の取り消し・やり直し（restoreBars） | 音価変更・付点・取り消しで全曲正規化と MIDI 再生成が不要に |
| 描画への受け渡し | alphaTab パッチ（scripts/render-patch.mjs）でスナップショット差分だけを Worker に送る | render.sync の全曲直列化をなくした |
| §2-2 スナップショットの無効化抑制 | ミキサー／トラック設定は patchTracks | 次の編集で全曲を再直列化しない |
| B4/B5 UI の差分更新 | タブ・トラック欄・ミキサーの差分更新、テンポマップ、範囲メモ化、パレット二重更新の除去 | ui.* の区間がほぼ一定に |
| B6 再生追従 | カーソル座標を数値で受け取る | フレームごとの DOM 読み取りをなくした |
| B7 復旧データ | 文書ごと・変更分だけ・gzip（electron/recovery-store.cjs） | 600×8 で 1 回 109MB だった全量書き込みを解消 |
| B8 入出力の Worker 化 | 読み込み・TG 保存・書き出し・PDF 用 JSON（app/document-io.ts） | 200×8 の TG 読み込み 4.4 秒・保存 2.1 秒がメインスレッドから外れた |
| B2 音声の直結 | 合成 Worker → Worklet の MessagePort、振り分けとクリック音は Worklet で処理 | メインスレッドでの音声パケット処理が 0（SFZ 使用時は従来経路） |
| 継ぎ目 | platform/bridge.ts、main.ts から recovery / tabs / menu-bar / document-io を分離 | |

## 要確認（ユーザー）

- **音質の聴感確認**：B2 の直結経路（GM 音源のみの再生、クリック音の各種類、シーク、ループ、曲の終わり）。数値はアンダーラン数で確認済み（計測文書）。SFZ 使用時は従来経路のまま。
- バッファ量（prime 32768 / 目標 65536）は変えていない。下げると再生開始が速くなるが、聴感確認のあとで判断する。

## 未着手・次の一手

1. B3：Python ホスト（SFZ・外部 FX）を JSON+base64 から長さ付きバイナリにする、utilityProcess＋MessagePort にする。
2. 構造編集（小節の挿入・削除、トラック操作、拍子、移調、貼り付けの一部）は今も全曲正規化。操作コマンド＋逆操作のモデル（計画 P3）で置き換える。
3. **大きな譜面の TG 保存ができない**：600×8 では TG 内の TabStudioProject（JSON の複製）が 40MB 上限を超え、保存が失敗する（ベースラインから同じ）。保存形式の変更が必要なので、別途判断する。
4. main.ts の分割を続ける：edit-transaction（commit/history）、render-scheduler、playback-controller。
5. 古い UI チェックのうち、ベースラインでも失敗するもの（confirmed-edit、edit-mode、editing-stress、navigation、focus-shortcuts、multitrack、track-display-loop、menu-settings、layout、playback-seek、mixer-check、mixer-technique、workspace-features、startup-techniques）の更新。原因はタイムアウト・音声待ち・旧 UI 前提で、今回の変更によるものではない（下の表）。
6. B11：ミキサーのメーターが無音でも rAF で動き続けるのを止める。

## UI チェック（run-ui-checks.mjs、28 本）

| | 合格 |
|---|---|
| ベースライン（8d54f5c） | 12/28 |
| 変更後（c93c7ce） | 14/28 |

ベースラインで合格したものはすべて変更後も合格。変更後に増えた合格は mixer-stability と memory-lifecycle。mixer-technique は両方で失敗する（ベースラインは NAM の読み込み待ちで、変更後はその先のトリル操作で失敗）。
