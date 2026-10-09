# 性能改善で入れた仕組み（2026-10、Electron版）

計画書 `performance_and_tauri_migration_plan.txt` の §2 クイックウィンを、Electron のまま実装した。計測結果は `docs/performance-baseline-2026-10.md`。

## 計測

- `src/perf.ts`：`perfStart/perfTime/perfRecord` で区間を記録する（`performance.measure` にも出す）。`window.tabStudio.perf.summary()` で中央値・p95・最大・合計を返し、`perf.reset()` で消去する。
- 主な区間：`edit.commit`（汎用編集）、`edit.normalize`（全曲正規化）、`edit.refinish`（小節単位の再計算）、`edit.local`/`edit.fret`（拍単位）、`edit.history`/`edit.restoreBars`（取り消し）、`render.sync`（render() の同期部分）、`render.full`/`render.background`（描画完了まで）、`midi.generate`/`midi.load`、`recovery.*`、`ui.*`、`nav.move`、`file.parse`/`file.restore`/`file.exportTg`、`audio.packet`（音声パケットのメインスレッド中継。直結経路では発生しない）。
- `scripts/perf-benchmark.mjs [label]`：dist をElectronで開き、168小節×2トラックと合成600小節×8トラック（GP7で読み込み）で各操作の handler/settled 時間と内部区間を記録する。`PERF_FIXTURE=168x2|600x8` で片方だけ実行。`scripts/perf-summary.mjs a.json [b.json]` で比較表を出す。
- `window.tabStudio.verifySnapshot()`：差分更新している編集スナップショットが新規の直列化と一致するか確認する（不一致なら差分パスを返す）。ベンチマークは最後に必ず確認する。

## 編集（B1）

- `src/bar-edit.ts`
  - `canRefinishBar(bar)`：小節内とその前後の境界拍に、タイ・スライド・ハンマリング・レットリング/パームミュートの連鎖・装飾音・ワーミー・フェルマータ・サステインペダルが無いこと。これらは alphaTab の `finish()` が初回の状態を引きずるため、該当すれば従来どおり全曲正規化に回す。
  - `refinishBar(bar)`：拍の連鎖・tick・連符グループを、その小節だけ再計算する。Score オブジェクトは同じままなので、alphaTab は MIDI を再生成しない（再生時に `playbackDirty` で生成。フレット入力と同じ扱い）。
  - `restoreBars(score, data, bars)`：小節単位の編集の取り消し／やり直しで、その小節だけを履歴スナップショットから作り直して差し替える。
- `main.ts` の `commitInBar()`：音価・付点・連符・休符挿入・拍のクリア・音符削除・ストローク・ドラム音・強弱など、選択小節で完結する編集の入口。編集後に条件を満たさなくなった場合（タイを付けた等）は、そのまま全曲正規化に切り替える。
- `EditSnapshot.patchBar` / `patchTracks`：小節、またはトラックのヘッダ（名前・再生情報・ミキサー設定）だけをスナップショットに反映する。ほかの部分は前の履歴と共有する。
- 同値性は `tests/bar-edit.test.ts` で、全曲正規化の結果（直列化と finish 後の派生状態）と比べて確認している。

## 描画への受け渡し（render transfer）

- alphaTab は描画のたびに、メインスレッドで全曲を `scoreToJsObject` してレイアウトWorkerへ送っていた（600×8 で1回1秒前後）。
- `scripts/render-patch.mjs` が alphaTab 1.8.4 にパッチを当てる。メイン側は Vite プラグイン（`vite.config.ts`）、Worker 側は `public/alphatab/alphaTab.core.mjs`（`scripts/prepare-assets.mjs` で再生成）に入る。
  - メイン：`globalThis.__tabStudioRenderData.data(score)` があれば編集スナップショットを使い、前回送った版との差分（`src/snapshot-diff.ts`）だけを送る。
  - Worker：保持している版に差分を適用してから `jsObjectToScore` する。
- フック未設定・別の Score の場合は、alphaTab 本来の動作になる。

## UI の差分更新（B4/B5）

- 文書タブ：`src/app/document-tabs.ts`。文書IDで行を保持し、変化した行だけを書き換える。`markDirty` は未保存への変化時だけタブを更新する。
- トラック欄：Score とトラック数が同じなら、カードを作り直さず値だけ更新する（`refreshTrackCards`）。ミキサーも `sync()` だけにする。
- テンポ表示はテンポマップ（Score と編集リビジョンごと）、範囲の拍一覧はメモ化（`scopeBeats`）。パレットの二重更新もやめた。

## 再生追従（B6）

- `installPlaybackFrame(api, onCursor)` がカーソル座標と遷移時間を `ScoreFollower.cursorMoved` に渡す。追従はその数値から現在位置を補間し、フレームごとに `querySelector`/`getBoundingClientRect` を呼ばない。シートのオフセットは再生開始時とリサイズ時だけ測る。

## 復旧データ（B7）

- `src/app/recovery-controller.ts`（main.ts から分離）＋`src/recovery.worker.ts`＋`electron/recovery-store.cjs`。
- デスクトップ版は userData/recovery/ に、文書ごとの gzip（`document-<id>.json.gz`）と小さな manifest を書く。内容が変わった文書だけを書き直し、manifest は最後に書く。読み込み時は従来と同じ JSON 形にまとめて返すので、復元コードは共通。旧 `recovery.json` も読める。
- 書き込みに失敗したら、Worker が保存済みの記録を忘れるので、次回はすべて書き直す。ブラウザ版（localStorage）は従来どおり 1 つの JSON。

## 読み込み・書き出し（B8）

- `src/app/document-io.ts`＋`src/document-loader.worker.ts`：前面の読み込み（TG/GP/tabstudio）、TG 保存、GP/TG/MIDI 書き出し、PDF 用 JSON の生成を Worker で行う。メッセージには必ず `cmd` を付ける（alphaTab 自身の Worker ハンドラも同じメッセージを受け取るため）。
- 保存・書き出しは、毎回ライブの Score を新しく直列化したものから作る（差分スナップショットの不整合が保存ファイルに入らないようにするため）。書き込み中に編集された場合は、未保存のままにする。

## 音声（B2）

- 合成 Worker → `studio-output` AudioWorklet を MessageChannel で直結した（`scripts/channel-audio.mjs` の追加パッチ、`public/mixer-output.js`、`src/mixer-audio.ts`）。トラックへの振り分けとクリック音の生成は Worklet で行い、サンプル要求と再生済み数も Worker に直接返す。メインスレッドは制御メッセージだけを扱う。
- SFZ 音源（IPC が必要）のトラックがある再生では、従来の中継経路を使う（再生中に SFZ が追加された場合も中継に戻す）。
- バッファ量（prime 32768 / 目標 65536 フレーム）は変えていない。下げるかどうかは聴感確認のあとで判断する。

## Tauri 移行の継ぎ目

- `src/platform/bridge.ts`：`window.desktop` と `window.nativeFx` の型と、`platform.desktop` / `platform.nativeFx` の窓口。アプリのコードはここ以外からホストにアクセスしない。
- main.ts から分離したもの：`app/recovery-controller.ts`、`app/document-tabs.ts`、`app/menu-bar.ts`、`app/document-io.ts`。
