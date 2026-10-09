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
| S1 | 最小の Tauri v2 アプリで dist/ を WebView2 に表示。alphaTab 描画・Worker・AudioWorklet・wasm(NAM)・再生音が動くか | 完了 2d38102：デモ表示 2.7 秒・描画完了 6.2 秒（debug）、再生位置が進む、エラー 0。AudioWorklet・WebAssembly あり（SharedArrayBuffer なしは Electron と同じ） | 起動してデモ譜面が描画され、再生位置が進み、コンソールにエラーなし |
| S2 | 自動テストの方式：WebView2 のリモートデバッグポート + Playwright `connectOverCDP` で既存スクリプトを流せるか（tauri-driver より既存資産を使える） | 完了：`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=N` で接続でき、クリック・キー入力・evaluate が使える（scripts/tauri-app.mjs） | 簡単なスクリプトで画面のテキスト取得・キー操作ができる |
| S3 | バイナリ IPC：`tauri::ipc::Response` で 40MB を返す時間、生のリクエスト本体で 40MB を受け取る時間 | 判明：Rust→画面は 38MB で 0.57 秒（debug）。画面→Rust の生の本体は 1MB あたり約 60ms（debug）で、38MB 一括だと WebView 側が落ちる。→ 4MB ごとに分けて送る（upload_chunk）方式にした | 実測値の記録（目安 40MB で 1 秒未満） |
| S4 | PDF：WebView2 `PrintToPdf`（方式 a）で print.html から PDF を作れるか、Electron 版と見た目が同等か | 完了：デモ譜面で Electron 版と同じ A4・1 ページ・同じ配置。ページ番号は Electron のフッター雛形の代わりに CSS の @page 余白ボックス（`1 / 1`）で同じ位置に出る（scripts/tauri-export-check.mjs で両方を生成して比較） | PDF が生成され、ページ数・余白・ページ番号が Electron 版と一致 |

## P1 — Tauri v2 の殻（音声は WebAudio のまま、Windows 優先）

| # | 項目 | 状態 | 完了条件 |
|---|---|---|---|
| P1-1 | `src-tauri/` 雛形、`pnpm tauri:dev` / `tauri:build`、dist を読み込む | 完了 2d38102 | Tauri 版が起動しデモ譜面が表示される。Electron 版のチェックは基準どおり |
| P1-2 | `src/platform/tauri.ts`：Tauri 上で `window.desktop` / `nativeFx` を提供（ブリッジの Tauri 実装） | 完了：tests/tauri-bridge.test.ts（6 件）。ファイル本体は `長さ+JSON+バイト列` の枠で受け渡し、4MB を超える送信は分割 | typecheck・test 合格。Electron 版で読み込まれない |
| P1-3 | Rust：セッション（最近使ったファイル・ワークスペース・最後のファイル）。形式は session-store.cjs と同じ JSON | 完了：src-tauri/src/session.rs＋単体テスト。初回起動時に Electron 版のセッション（%APPDATA%/tab-studio）を一度だけ取り込む | Rust 単体テスト＋再起動でタブが戻る |
| P1-4 | Rust：開く／保存／別名保存／履歴から開く／パス指定で開く／accept-open／activate／reset。許可パス（documentPaths）を Rust 側で保持。ファイル本体はバイナリで受け渡し | 完了：src-tauri/src/commands.rs、scripts/tauri-files-check.mjs（開く→編集→上書き保存→許可外パスの拒否→38MB 往復→再起動で履歴が戻る） | Rust 単体テスト＋画面操作で開いて保存できる |
| P1-5 | Rust：復旧データ（文書ごと gzip＋manifest、旧 recovery.json 読み込み）。recovery-store.cjs と同じ形 | 完了：src-tauri/src/recovery.rs＋単体テスト、画面からの書き込み・読み戻しも tauri-files-check で確認 | Rust 単体テストで Electron 版と同じ JSON を返す |
| P1-6 | 書き出し（GP/TG/MIDI）と PDF（S4 の方式） | 完了：src-tauri/src/pdf.rs、scripts/tauri-export-check.mjs。トラック別 PDF・上書き確認も実装（自動テストは単一 PDF のみ） | 各形式のファイルが生成され、署名チェックが通る |
| P1-7 | ウィンドウ：大きさの記憶、閉じる確認（close-request → finishClose）、全画面、二重起動防止＋「このアプリで開く」 | 一部完了：大きさの記憶（終了時）・閉じる確認・全画面。×ボタンで未保存の確認が出て、キャンセルで残り、「保存せず終了」で終わることを tauri-files-check で確認。二重起動防止は Electron 版にも無いため後回し | 未保存で閉じると確認が出る。2 つ目の起動でファイルが既存ウィンドウに渡る |
| P1-8 | nativeFx：NAM モデル読み込みは Rust で提供。SFZ・外部 VST は Tauri 版では「未対応」として無効（P2 で置き換え） | 完了：`features:{sfz:false,externalFx:false}`。ミキサーは SFZ 読み込みボタンを出さず、外部 FX 欄に「この版ではまだ使えません」と表示。Electron 版は変化なし | ミキサーでエラーが出ず、SFZ/外部 FX の項目が無効表示 |
| P1-9 | UI チェックを Tauri 版でも流す仕組み（S2 の方式） | 完了：`UI_TARGET=tauri node scripts/run-ui-checks.mjs …`（scripts/tauri-ui-shim.mjs が Electron 用スクリプトを Tauri 版に向ける）。Electron で合格する 14 本のうち 10 本が Tauri でも合格。残り 4 本（mixer-actions・mixer-layout・mixer-stability・memory-lifecycle）は外部 VST（BIAS FX 2）を使う部分で止まる＝P1-8 の設計どおり。テスト時は WebView の保存領域も TAB_STUDIO_TEST_DATA 内に分ける | Electron 版で合格する 14 本のうち、ファイル入出力以外が Tauri 版でも合格 |
| P1-10 | 終了判定：起動時間・メモリを Electron 版と比較して記録 | 完了：`node scripts/shell-compare.mjs 3`（下の表） |
| P1-12 | インストーラー（NSIS）作成と NAM モデル等の同梱設定 | 保留（要許可）：インストーラーの作成は依頼者の確認が必要。現状は `src-tauri/target/release/tab-studio.exe` を直接起動して試せる |
| P1-13 | 依頼者による手動確認（ダイアログで開く・名前を付けて保存・PDF・音の確認） | 依頼中 |
| P1-11 | 設定の引き継ぎ：Electron 版の localStorage（設定・表示・クリック・練習）を初回起動時に取り込む | 完了：src-tauri/src/legacy_storage.rs（LevelDB を一時コピーして読む。rusty-leveldb）＋単体テスト。実データで tabstudio-view・tabstudio-click が引き継がれることを確認。Tauri 側に既にある値は上書きしない。初回 1 回だけ | Rust 単体テスト＋実データで設定が引き継がれる | 数値を記録 |

### P1-10 計測（release、Windows 10、中央値 3 回、scripts/shell-compare.mjs）

| | スタート画面まで | デモ譜面の表示完了まで | メモリ（全プロセス合計） | プロセス数 |
|---|---|---|---|---|
| Electron（開発版の electron.exe） | 1.37 秒 | 2.02 秒 | 470MB | 6 |
| Tauri（release） | 1.56 秒 | 2.69 秒 | 404MB（−14%） | 8 |

- 表示完了の差 0.65 秒の主因は 42MB の音色ファイル（GeneralUser-Classical.sf3）を WebView に渡す時間（約 0.75 秒）。Tauri の資産圧縮を切って 1.1 秒→0.75 秒に縮めた（exe は 93MB→110MB）。P2 で音源の読み込み自体が Rust 側に移るので、そこで解消する見込み。
- 大きさ：Electron 版は展開後 747MB・インストーラー 430MB（Python 実行環境込み）。Tauri 版は exe 110MB（画面・音色ファイル込み、Python なし。NAM モデル等の同梱は P1-12）。

### P1 終了時の確認結果

- typecheck OK、`pnpm test` 201/201（基準 195 ＋ Tauri ブリッジ 6）、build OK、Rust 単体テスト 14/14。
- Tauri：tauri-files-check・tauri-export-check 合格。UI チェック 10/14（残り 4 本は外部 VST 前提で想定どおり）。
- Electron：基準で合格していた 14 本は 14/14（最終回で direct-controls-popover-check が 1 回だけ失敗し、再実行 3 回とも合格。タイミング依存の不安定さで、今回の変更と無関係）。

### P1 で分かったこと・決めたこと

- Electron 版にも「二重起動防止・このアプリで開く」は無かったので、P1-7 の必須からは外し、後回しの改善とする。
- WebView2 の File オブジェクトにはパスが無いため、Tauri 版ではドロップしたファイルを中身だけで開く（保存時は保存先を尋ねる）。Tauri のドラッグ＆ドロップイベントでパスを受け取る改善は後回し。
- 画面→Rust の送信は約 16MB/秒（release でも同じ。WebView2 側の制約）。通常の譜面（1MB 未満）では 0.1 秒未満で問題ないが、大きな保存は遅い。WebView2 の SharedBuffer を使う高速化は後回し。
- 自動テスト用に `TAB_STUDIO_TEST_DATA` と `TAB_STUDIO_TEST_SAVE_DIR` が両方あるときだけ、保存ダイアログを出さずに指定フォルダーへ保存する（Electron の自動テストがダイアログを差し替えていたのと同じ役割）。
- release の exe は約 93MB（画面のファイル・音色ファイルを exe に埋め込むため）。

## P2・P3

計画書の各節を、P1 完了後にこの表へ分解する。

## 作業ログ

- 2026-10-09：初回。tauri-migration ブランチ作成、基準値の取得、この進捗ファイルを作成。
- 2026-10-09：P1-1〜P1-11 を実装・検証。スパイク S1〜S4 完了。残りは P1-12（インストーラー、要許可）と P1-13（手動確認）。

## 次にやること

1. 依頼者の手動確認（P1-13）の結果を反映する。問題があれば直す。
2. 許可が出たら P1-12（NSIS インストーラー、NAM モデル等の同梱）。
3. P2（ネイティブ音声エンジン）を小ステップに分解してこの表に追加し、リスク 1・2（alphaTab の外部メディア再生モード、rustysynth の音質と SF3）のスパイクから始める。
