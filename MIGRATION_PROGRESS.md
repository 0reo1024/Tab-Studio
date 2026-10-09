# Tauri 移行の進捗

計画書：`performance_and_tauri_migration_plan.txt` ／ 手順：`MIGRATION_PROMPT.md`
作業ブランチ：`tauri-migration`（main には触らない）
Electron 版の性能改善の記録：`docs/performance-progress.md`

## 基準値（tauri-migration 開始時、7e7842d = main 68d9019 + このプロンプト）

| チェック | 結果 |
|---|---|
| `pnpm run typecheck` | OK |
| `pnpm test` | 195/195 合格 |
| `pnpm run build` | OK（チャンクサイズ警告のみ。従来から） |
| UI チェック `node scripts/run-ui-checks.mjs` | 14/28（docs/performance-progress.md の表。失敗 14 本は旧 UI 前提・タイムアウトで以前から） |
| 性能 | `docs/perf-reports/after.json`（168×2 と 600×8） |

開発環境：Rust 1.99（MSVC）、VS 2022、WebView2 154、Node 24、pnpm。追加インストール不要。

## P0 — Electron 内の準備

| # | 項目 | 状態 | 完了条件 |
|---|---|---|---|
| P0-1 | 計測の仕組み（クイックウィン10） | 完了 c93c7ce | perf-benchmark が両フィクスチャで動く |
| P0-2 | platform/bridge.ts（ホストへの唯一の窓口） | 完了 c93c7ce | src 内で window.desktop/nativeFx の直接参照なし（確認済み） |
| P0-3 | クイックウィン 1〜8（B1,B2,B4〜B8） | 完了 c93c7ce〜1f244a5 | docs/performance-progress.md |
| P0-4 | main.ts の分割（document-io / tabs / menu-bar / recovery） | 一部完了 | 残りの edit-transaction・render-scheduler・playback-controller は P3 の直前に行う（P1 はホスト側の置き換えで、これらの継ぎ目を必要としないため） |
| P0-5 | B3 Python ホストのバイナリ化 | 後回し | P1 の Tauri 版では SFZ・外部 FX を無効にし、P2 のネイティブ音声で Python ごと置き換える。Electron 版は現状維持 |
| P0-6 | B11 メーターの rAF 停止 | 後回し | 小さな改善。P2 でメーター自体がエンジン側に移る |

→ P1 の前提（ブリッジ・計測）は揃っているので P1 に進む。

## スパイク（P1 に関わるもの）

| # | 内容 | 状態 | 完了条件 |
|---|---|---|---|
| S1 | 最小の Tauri v2 アプリで dist/ を WebView2 に表示。alphaTab 描画・Worker・AudioWorklet・wasm(NAM)・再生音が動くか | 未 | 起動してデモ譜面が描画され、再生位置が進み、コンソールにエラーなし |
| S2 | 自動テストの方式：WebView2 のリモートデバッグポート + Playwright `connectOverCDP` で既存スクリプトを流せるか（tauri-driver より既存資産を使える） | 未 | 簡単なスクリプトで画面のテキスト取得・キー操作ができる |
| S3 | バイナリ IPC：`tauri::ipc::Response` で 40MB を返す時間、生のリクエスト本体で 40MB を受け取る時間 | 未 | 実測値の記録（目安 40MB で 1 秒未満） |
| S4 | PDF：WebView2 `PrintToPdf`（方式 a）で print.html から PDF を作れるか、Electron 版と見た目が同等か | 未 | PDF が生成され、ページ数・余白・ページ番号が Electron 版と一致 |

## P1 — Tauri v2 の殻（音声は WebAudio のまま、Windows 優先）

| # | 項目 | 状態 | 完了条件 |
|---|---|---|---|
| P1-1 | `src-tauri/` 雛形、`pnpm tauri:dev` / `tauri:build`、dist を読み込む | 未 | Tauri 版が起動しデモ譜面が表示される。Electron 版のチェックは基準どおり |
| P1-2 | `src/platform/tauri.ts`：Tauri 上で `window.desktop` / `nativeFx` を提供（ブリッジの Tauri 実装） | 未 | typecheck・test 合格。Electron 版で読み込まれない |
| P1-3 | Rust：セッション（最近使ったファイル・ワークスペース・最後のファイル）。形式は session-store.cjs と同じ JSON | 未 | Rust 単体テスト＋再起動でタブが戻る |
| P1-4 | Rust：開く／保存／別名保存／履歴から開く／パス指定で開く／accept-open／activate／reset。許可パス（documentPaths）を Rust 側で保持。ファイル本体はバイナリで受け渡し | 未 | Rust 単体テスト＋画面操作で開いて保存できる |
| P1-5 | Rust：復旧データ（文書ごと gzip＋manifest、旧 recovery.json 読み込み）。recovery-store.cjs と同じ形 | 未 | Rust 単体テストで Electron 版と同じ JSON を返す |
| P1-6 | 書き出し（GP/TG/MIDI）と PDF（S4 の方式） | 未 | 各形式のファイルが生成され、署名チェックが通る |
| P1-7 | ウィンドウ：大きさの記憶、閉じる確認（close-request → finishClose）、全画面、二重起動防止＋「このアプリで開く」 | 未 | 未保存で閉じると確認が出る。2 つ目の起動でファイルが既存ウィンドウに渡る |
| P1-8 | nativeFx：NAM モデル読み込みは Rust で提供。SFZ・外部 VST は Tauri 版では「未対応」として無効（P2 で置き換え） | 未 | ミキサーでエラーが出ず、SFZ/外部 FX の項目が無効表示 |
| P1-9 | UI チェックを Tauri 版でも流す仕組み（S2 の方式） | 未 | Electron 版で合格する 14 本のうち、ファイル入出力以外が Tauri 版でも合格 |
| P1-10 | 終了判定：起動時間・メモリを Electron 版と比較して記録 | 未 | 数値を記録 |

## P2・P3

計画書の各節を、P1 完了後にこの表へ分解する。

## 作業ログ

- 2026-10-09：初回。tauri-migration ブランチ作成、基準値の取得、この進捗ファイルを作成。
