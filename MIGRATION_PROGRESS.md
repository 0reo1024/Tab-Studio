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
| P1-8 | nativeFx：NAM モデル読み込みは Rust で提供。SFZ・外部 VST は Tauri 版では「未対応」として無効（P2 で置き換え） | 完了（その後 SFZ は Python ホスト経由で対応、外部 VST のみ無効）：`features:{sfz:false,externalFx:false}`。ミキサーは SFZ 読み込みボタンを出さず、外部 FX 欄に「この版ではまだ使えません」と表示。Electron 版は変化なし | ミキサーでエラーが出ず、SFZ/外部 FX の項目が無効表示 |
| P1-9 | UI チェックを Tauri 版でも流す仕組み（S2 の方式） | 完了：`UI_TARGET=tauri node scripts/run-ui-checks.mjs …`（scripts/tauri-ui-shim.mjs が Electron 用スクリプトを Tauri 版に向ける）。Electron で合格する 14 本のうち 10 本が Tauri でも合格。残り 4 本（mixer-actions・mixer-layout・mixer-stability・memory-lifecycle）は外部 VST（BIAS FX 2）を使う部分で止まる＝P1-8 の設計どおり。テスト時は WebView の保存領域も TAB_STUDIO_TEST_DATA 内に分ける | Electron 版で合格する 14 本のうち、ファイル入出力以外が Tauri 版でも合格 |
| P1-10 | 終了判定：起動時間・メモリを Electron 版と比較して記録 | 完了：`node scripts/shell-compare.mjs 3`（下の表） |
| P1-12 | インストーラー（NSIS）作成と NAM モデル等の同梱設定 | スキップ（依頼者の指示、2026-10-10）。以前の記載：保留（要許可）：インストーラーの作成は依頼者の確認が必要。現状は `src-tauri/target/release/tab-studio.exe` を直接起動して試せる |
| P1-13 | 依頼者による手動確認（ダイアログで開く・名前を付けて保存・PDF・音の確認） | 完了（依頼者が確認、2026-10-10） |
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

## P2 — ネイティブ音声エンジン（crates/tabstudio-audio）

方針：エンジンは独立した Rust ライブラリとして作り、コマンドライン（`tabstudio-audio`）で単体検証してから Tauri に組み込む。Electron 版は WebAudio のまま。Tauri 版も、聴感の承認（S6）が出るまでは今の音のまま。

| # | 項目 | 状態 | 完了条件 |
|---|---|---|---|
| S5 | alphaTab の外部メディア再生モード（PlayerMode.EnabledExternalMedia）で、カーソル・再生位置・シーク・速度・ループ・曲末が外部の時計で動くか（計画のリスク 1） | 完了 | spikes/s5-external-media：すべて動作。規則：外部エンジンは「速度を掛けた後の実時間（ms）」を報告する（0.5 倍速なら曲 1 秒 = 報告 2 秒）。ループ末尾では alphaTab が seekTo(開始) を呼ぶ |
| S6 | Rust の音源（rustysynth）が今の音（alphaSynth）と同等に鳴るか、SF3 を扱えるか（リスク 2） | 数値は完了・聴感は依頼中 | 下の表。聞き比べ素材：`test-results/聞き比べ-新しい音源/` |
| P2-1 | SF3→SF2 変換（Ogg Vorbis 展開、lewton） | 完了 | src/sf3.rs＋テスト（sonivox の SF3 と SF2 原本が名前・長さ・ループで一致）。GeneralUser-Classical.sf3（42MB）→ 1.2 秒 |
| P2-2 | 音源本体：rustysynth を取り込み、1 音ごとのピッチベンド（alphaTab が全音符に出す MIDI 2.0 形式）と alphaSynth 互換の音量計算を追加 | 完了 | src/synth/（MIT、licenses/rustysynth-MIT.txt） |
| P2-3 | イベント列：alphaTab の MIDI（アプリの調整後）→ 16 バイト固定長のバイナリ（src/audio/event-list.ts ⇔ src/song.rs）。テンポ変化を含む tick⇔秒 | 完了 | tests/event-list.test.ts、song.rs のテスト |
| P2-4 | 再生器（Player）：トラックごとに音源を持ち（ミキサー用の個別出力）、イベントをサンプル単位で発音、速度、シーク時のコントロール復元、ループ折り返しを音声処理の中で行う | 完了（オフライン） | player.rs のテスト 4 件 |
| P2-5 | リアルタイム出力（cpal、WASAPI）：別スレッドの命令キュー、音声スレッドでのメモリ確保・ロックなし、再生位置の公開 | 完了：src/engine.rs（命令キュー rtrb、古い曲は制御側で解放）、src/output.rs。実機（Nano Cortex、48kHz、WASAPI 共有 480 フレーム＝10ms）で 8 トラックの密な和音：最大処理 1.5ms／予算 10ms、過負荷 0 回（10 秒）。再生開始の反映 0.9ms、シーク 1.4ms 以下（`tabstudio-audio live`） | 512 フレームで途切れなし、再生開始 100ms 未満 |
| P2-6 | ミキサー：トラックの音量・パン・ミュート・ソロ、マスター、リミッター、メーター（ピーク/RMS） | 基本部分完了：音量・パン・ミュート・ソロ・マスター・リミッター（−1dBFS）・ピークメーター（engine.rs のテスト 5 件）。RMS は画面側の要件確認後 | 単体テスト＋メーター値 |
| P2-7 | メトロノーム・カウントイン（サンプル単位） | 完了：src/click.rs（今の 4 種類の波形を移植、TS と 1e-6 以内で一致）＋「標準」は alphaSynth と同じ打楽器キー 33。拍の位置は alphaTab の配置規則（tickShift 込み）を移植。カウントインは最後のクリックのあと正確なサンプルで曲が始まる。ソロ・ミュートの影響を受けない | クリック位置が拍と一致 |
| P2-8 | Tauri への組み込み（以下に分割） | 完了（8a〜8e） | |
| P2-8a | Rust 側の窓口（src-tauri/src/audio.rs）：音色の SF3→SF2 変換キャッシュ、出力デバイスの起動、曲の読み込み（イベント列を生のバイトで）、命令（再生・停止・シーク・速度・ループ・トラック・マスター・メトロノーム・カウントイン）、状態の通知（Channel、約 60 回/秒） | 完了：Tauri 上で invoke からエンジン起動（初回の音色変換込み 1.95 秒、2 回目以降はキャッシュ）、読み込み・再生・シーク・0.5 倍速・ループ折り返し・一時停止・カウントイン→再生開始を確認（scripts/tauri-audio-check.mjs、確認中は無音）。開発ビルドでも依存部品を最適化（以前は 17 秒） | Rust テスト＋Tauri 上で invoke から再生・位置の進行を確認 |
| P2-8b | 画面側の窓口（src/audio/native-engine.ts）：invoke の包み、alphaTab 外部メディア用ハンドラ（時間軸の換算：報告＝曲の秒÷速度） | 完了：src/audio/native-engine.ts（テスト 3 件）、window.nativeAudio（Tauri のみ）。Tauri 上で状態通知が 0.5 秒に 31 回（約 60 回/秒）届くことを確認 | 偽の invoke での単体テスト |
| P2-8c | スイッチ付きで本体に接続：Tauri 版で「新しい音源エンジン」設定が有効なときだけ alphaTab を外部メディアモードにし、MixerAudio の代わりにエンジンを使う。既定は無効 | 完了：設定「新しい音源エンジンで再生する（試験中）」（Tauri 版のみ表示、既定オフ、再起動後に有効）。オン：alphaTab を外部メディアモードにし、MIDI 読み込み→エンジン、再生前に読み込み完了を待つ、ループは tick でエンジンへ（サンプル単位で折り返し）。シークは tick で送る（alphaTab は速度変更時に新速度で再シークしてから playbackRate を設定するため、ms 換算だと位置が飛んだ）。scripts/tauri-native-playback-check.mjs が 3 回連続合格（再生・一時停止・50%＝889〜898 tick/秒・1 小節ループ・ミュート・カウントイン・曲末で停止）。オフ：Electron 14/14、Tauri 10/14（従来どおり） | 設定オフで既存の全チェックが変わらない／オンで再生・停止・シーク・ループ・速度が動く |
| P2-8d | ミキサー画面（音量・パン・ミュート・ソロ・マスター・クリック）とメーターをエンジンへ | ほぼ完了：トラック音量・パン・ミュート・ソロ・マスターは MixerAudio と同じ計算でエンジンへ（mixerAudio.sync を経由）、メーターはエンジンの値、クリック・カウントインもエンジン。tests/native-playback.test.ts。残り：トラック単位のリバーブ送り・FX・NAM・SFZ（P2-10〜12） | 操作がエンジンの命令になることをテスト |
| P2-8e | 新エンジン有効の Tauri 版で UI チェック | 完了：新エンジン オンの Tauri で 14 本中 8 本合格。不合格 6 本は外部 VST 前提 4 本（mixer-actions・mixer-layout・mixer-stability・memory-lifecycle）と、WebAudio の内部を直接調べる 2 本（mixer-routing：AudioWorklet のノード、nylon-guitar：WebAudio の AnalyserNode）で、新エンジンには当てはまらない。同時に Electron 14/14、Tauri オフ 9〜10/14（direct-controls-popover-check はまれに時間切れ、再実行 3/3 合格） | 再生系のチェックが合格 |
| P2-9 | 試聴（ノートプレビュー）をエンジンで鳴らす | 完了（新エンジン オン時）：試聴は今の試聴用ワーカーと同じ MIDI（120bpm・4 分音符・ベロシティ 100、フレーズは抜粋譜面）をエンジンに送り、エンジンが書き出してトラックの音量・パン・ミュートを通して鳴らす（src/audio/native-preview.ts、engine.rs の Preview）。2 つ目の音色ファイルの読み込みは無し。input-preview-check が新エンジンで合格（ピーク・長さ・鳴ったかも一致） | 2 つ目の音色ファイルの読み込みが不要に |
| P2-10 | 組み込み FX（EQ・コンプ・ディレイ・リバーブ）を Rust で | 完了：EQ・コンプ・ディレイ・リバーブ・リミッター・パン・NAM のトーン調整を Rust で（src/dsp.rs、compressor.rs、fx.rs）。今の版（Chromium の WebAudio）に同じ試験音を通した結果（spikes/s7-fx-reference）との差：EQ・コンプ・リミッター・ディレイ・NAM トーン・パンは 0.00dB、リバーブ −0.06dB（2.7ms 遅れのみ）。コンプは Chromium の DynamicsCompressorKernel を移植（自動メイクアップ等）、ディレイは WebAudio のフィードバックで 1 周ごとに 128 サンプル遅れる点も再現。ミキサーの流れも同じ（FX→パン→音量→バス、ポストのリバーブ送り、バス 1/√鳴っている数、クリックはバスの後、マスター、リミッター）。負荷：8 トラック全部に EQ・コンプ・ディレイ＋リバーブで実時間の 9%、実機 480 フレームで処理落ち 0・最大 5.4ms（リバーブは 2 段の分割畳み込みにして 30 倍速く） | 今の WebAudio 版と数値で比較 |
| P2-11 | NAM（ギターアンプのモデル）をネイティブで | 完了：WebAudio 版と同じ nam-engine.wasm（neural-amp-modeler-wasm 2.0.1、MIT）を wasmtime 49（Apache-2.0 WITH LLVM-exception、プロジェクト依存として追加）で実行（src/nam.rs）。wasmtime は Emscripten の旧形式の例外処理を実行できないため、binaryen 132（Apache-2.0、作業フォルダで一度だけ使用・PC へのインストールなし）の --translate-to-exnref で変換したものを crate に同梱（scripts/convert-nam-wasm.mjs で同一バイトを再生成できることを確認）。スパイク S9（spikes/s9-nam-wasm）：Deluxe A2・4 秒のギター DI で V8（ワークレットと同じ計算）と全 192000 サンプル完全一致、1 トラック実時間の約 5%、モジュールのコンパイル約 1.1 秒（audio-cache に保存して次回から省略、デバイス起動時に裏で準備）。トラックの先頭に入力ゲイン→NAM（モノラル、0.5×(L+R)）→Bass/Mid/Treble→キャビネット（70 Hz/6500 Hz）→出力ゲイン、以降はモノラルとして FX と StereoPanner のモノラル則でパン。ワークレットと同じフェードイン 1024 フレーム・無音 1 秒で停止。モデルは audio_nam（フレーム本体に JSON）で送り、同じモデルなら再読み込みしない。つまみは trackNamTone で即時反映（フィルター状態を保持）。あわせて：GM のギタートラックに FX を入れると Guitar DI を使う MixerAudio の動作を新エンジンにも反映。既存の不具合を修正：SFZ 音源の読み込み中に再生が始まり約 10 秒無音だった（読み込みを待ってから再生・読み込み中表示、同じ音源の二重読み込みを防止）。テスト：Rust エンジン 39・Tauri 20・TS 222 合格、tauri-native-playback-check（NAM の場面を追加、エンジン側に同じモデルが載っていることも確認）3 回連続合格。UI チェックは基準どおり：Electron 14/28（基準と同じ 14 本）、Tauri オフ 10、新エンジン オン 8（不合格は P2-8e と同じ理由）。注意：Tauri のテスト用ビルドは `npx tauri build --no-bundle`（cargo build 単体だと画面が組み込まれず開発サーバーを探す） | wasm 版と出力比較 |
| P2-12 | SFZ（sfizz の C API） | 完了：sfizz を Rust から直接呼ぶ（実行時に sfizz.dll を読み込み、src/sfz.rs）。sfz-host.py の処理を移植（弦ごとのレーン、使う音程だけの領域に絞った読み込み、キースイッチ、1 音ベンドとスライド・タイの基準、CC・ピッチホイール）。弦・奏法・ベンド基準は曲データの予約欄で渡す。今の版（Python 経由）と同じイベントを鳴らした結果は完全一致（差 −∞dB、spikes/s8-sfz-ab）。曲の再読み込みでは足りない音程があるときだけ作り直し、トラック・弦ごとに並列で読み込む。Champagne.tg：新エンジンで表示 4.2 秒＋再生開始まで 8.5 秒（今の版は約 14 秒）。NAM のトラックは必ず Guitar DI。 | Standard Guitar が鳴る |
| P2-13 | 外部 VST3（別プロセスの Rust ホスト、共有メモリ） | 完了（BIAS FX 2 の編集画面が表示されることをユーザーが目視で確認、2026-10-10）。ライセンス確認：VST 3 SDK は 3.8（2025-10）から MIT。Rust バインディングは vst3 crate 0.3（MIT/Apache-2.0、SDK 本体は含まない）。GPL の部品は使わない（現行の pedalboard は GPL-3.0 の別プロセス）。ユーザーの指示（P2-13 に進んで）で着手。段階 1 完了：crates/tabstudio-fx-host（プラグインごとに別プロセス、fx-host.py と同じ行プロトコル：process/state/restore/reset/editor/editor-close/close）。スパイク S10（spikes/s10-vst3-host）：pedalboard と比較して bx_greenscreamer は出力・状態ファイルとも完全一致、BIAS FX 2 は読み込み直後 0.12 秒以降は完全一致、bx_megasingle は -86 dB の差（JUCE がパラメーターを float に丸めるためと推定）。状態は .vstpreset（Comp/Cont、クラス ID は COM の並び）で Electron 版と相互に読み書きできる。NA IR Loader は pedalboard では読めないがこちらでは読める。編集画面は自前のウィンドウに IPlugView を表示、閉じると隠すだけで状態を返す（bx_greenscreamer の画面を取り込み確認。BIAS FX 2 は pedalboard 版と同じく自動取り込みでは「Loading」表示のままで、実画面の確認は人の目が必要）。Tauri：src-tauri の 2 つ目の実行ファイルとして同時にビルドされ、fx_scan/fx_folder/fx_load/fx_process/fx_editor/fx_state/fx_close で接続（features.externalFx=true）。BIAS FX 2 を使う UI チェック 4 本（mixer-actions・mixer-layout・mixer-stability・memory-lifecycle）が Tauri で初めて合格。段階 2 完了：新エンジンの中で外部 FX を処理。crates/tabstudio-fxlink（名前付き共有メモリに入力・出力のリングバッファ、ホストを起こすイベント）。エンジンは各ブロックを書き込み、固定 2048 フレーム（48 kHz で 43 ms）遅れた出力を読むだけで待たない（間に合わなければ無音として数える）。プラグイン自身のレイテンシーはホスト側で差し引く（pedalboard と同じ）。バイパスは同じ遅れの原音。WebAudio 版の遅延ノードと同じく、他トラックとクリックを最も遅いトラックに合わせて遅らせ、再生中に報告する位置もその分引く（カーソルが聞こえる音に合う）。ホストへは link コマンドで接続、ミキサーの FX ID ごとに 1 プロセスを保持（オンオフで再読み込みしない）、編集画面の状態は保存用に記録。確認：fxlink 3・エンジン 38（他 2 件は既存の手動用で ignore）・Tauri 23・TS 224 のテスト合格。tauri-native-playback-check に NAM＋BIAS FX 2 の場面を追加し 3 回連続合格（再生開始 0.8〜1.9 秒、ホストの遅れ 0 フレーム）。新エンジン オンで mixer-actions・mixer-layout が合格。mixer-stability と memory-lifecycle は WebAudio の内部（audioWorklet、resourceStats）を直接調べるため新エンジンには当てはまらない（同じ内容は上の確認で代替）。全体の UI チェック：Electron 13〜14/28、Tauri オフ 13〜14/28（外部 FX の 4 本が新たに合格）、新エンジン オン 10/28。mixer-stability-check は Electron でも 3 回中 1 回、Tauri オフで 5 回中 2 回「無音の隙間」で落ちる。隙間は外部 FX より手前の SFZ 出力にも同じ長さで出ており（underrun 0）、取り込み範囲に曲の休符が入るかどうかのタイミング依存で、今回の変更とは無関係 | BIAS FX 2 が読み込める |
| P2-14 | 終了判定：8 トラック（SFZ 2・NAM 2 含む）で 512 フレーム途切れなし、再生開始 100ms 未満、聴感の承認 | 完了（2026-10-10）。聴感：ユーザーが承認（「OK」）。途切れ：tabstudio-audio live（実機 WASAPI、512 指定で 480 フレーム／10 ms、8 トラック全てに EQ・コンプ・ディレイとリバーブ送り、SFZ Guitar DI 2 トラックに NAM、16 分音符ごとに 3 和音の高密度な試験曲）で 180 秒×2 回とも処理落ち 0（平均 1.5 ms、最長 7.8 ms／6.3 ms）。最初は 30 秒に 0〜1 回の処理落ち（最長 12 ms）があり、原因は sfizz（SFZ 1 トラックで平均 0.8 ms、まれに 9 ms）と NAM のまれな重さが同じコールバックに重なること（GM のみなら 180 秒で最長 1.8 ms）。対策：トラックごとの音源計算（src/player.rs）とミキサー部（NAM・FX・遅れ合わせ・パン・音量、src/engine.rs）を作業スレッド（src/pool.rs、最大 3 本、確保・ロックなし）で並列化。並列と直列で出力が完全一致することをテストで確認。作業スレッドの二重実行の競合を見つけて修正（20000 回×20 セットで再現なし）。参考：条件より重い SFZ 4＋NAM 2 では 120 秒に 1 回（10.15 ms）。再生開始：live で 3〜11 ms。アプリ（scripts/tauri-p2-exit-check.mjs、Champagne.tg を新エンジンで）でボタンから再生開始まで中央値 12 ms（IPC 往復込み）、60 秒再生で処理落ち 0（最長 4.4 ms）、外部 FX の遅れ 0。最初の 1 回は SFZ・NAM・FX の読み込みを含み 6.6 秒。audio_status に callbacks（回数・処理落ち・最長・平均）を追加 | |

### S6 の結果（同じイベント列を両方で録音して比較、scripts は spikes/s6-synth-ab/）

| 譜面 | 音量差（新−今） | 波形の包絡の一致度 | タイミング差 |
|---|---|---|---|
| デモ（エレキ） | −0.2 dB | 0.998 | 0 ms |
| デモ（ナイロン＝SF3 圧縮音） | 0.0 dB | 0.999 | 0 ms |
| チョーキング・ビブラート | +0.3 dB | 0.990 | 0 ms（ベンドの音程の動きも一致：64.1→68.19） |
| ピアノ・ベース・ストリングス | −0.1 dB | 0.998 | 0 ms |
| テスト用 GP | 0.0 dB | 0.992 | 20 ms 以内 |

分かったこと：
- alphaTab の MidiEventType は NoteOn=128・NoteOff=144 で MIDI の状態バイトと逆。変換で吸収した（テストで検出できるようにした）。
- alphaTab は全音符の直前に 1 音ごとのピッチベンド（中央値）を出す。標準 MIDI 用の音源ではベンドが鳴らないため、音源側に追加した。
- 音量の違いの原因：alphaSynth は ベロシティ＝直線、減衰＝100%、チャンネル音量×エクスプレッション＝3 乗、マスター 1。rustysynth は 2 乗・40%・2 乗・0.5。互換モードを追加し、残りの一定差 1.5 dB を補正。
- api.exportAudio は MIDI を作り直すので、アプリが再生時に入れる CC7/CC10=63 が入らない。比較では同じ値になるよう合わせた。
- 今の音源（alphaSynth）はステレオ収録の音（sampleType が左右）を読み飛ばす。新しい音源は鳴らす。
- 速度：Rust の音源はデモ曲を実時間の約 270 倍で生成。

## P3

楽譜のデータモデル（tabstudio-core）を Rust で作り、WASM として画面（WebView）で同期的に使い、保存・復旧ではネイティブでも同じものを使う。alphaTab の Score は「表示用の派生データ」になる。

| # | 項目 | 状態 | 完了条件 |
|---|---|---|---|
| P3-0 | P0-4 の残り：main.ts から edit-transaction（commit 系）・render-scheduler・playback-controller を分離 | 完了：src/app/edit-transaction.ts（commit・commitBeats・取り消し履歴・undo/redo、main.ts とはホストの関数でつなぐ）、src/app/render-scheduler.ts（描画中の依頼の統合、フレット入力後の遅延再描画）。単体テスト 6 件追加、TS 241 合格、Electron UI チェック 14/28（基準と同じ顔ぶれ）。playback-controller は分けない：再生は P2 で NativePlayback／externalMediaHandler に移り、P3（データと編集）には継ぎ目が要らないため | 振る舞いを変えずに分離。型チェック・単体テスト・UI チェックが基準どおり |
| S11 | スパイク：WASM のビルドと読み込み（wasm32 ターゲット＋wasm-bindgen、Vite・Tauri・Electron の WebView で動く、大きさと呼び出しコスト） | 完了（2026-10-10）。依頼者の許可を得て rustup target add wasm32-unknown-unknown と cargo install wasm-bindgen-cli 0.2.129 を実行。spikes/s11-wasm：状態を持つ Doc（編集・取り消し・JSON 入出力）を wasm-bindgen（--target web）で 79 KB。1 回の呼び出し：Node 0.024 µs、Tauri（WebView2 154）0.039 µs、Electron（Chromium 146）0.074 µs、取り消しも正しい。参考：10 万拍の JSON 化 20 ms・読み込み 28 ms（全体を JSON で往復しない設計の根拠）。CSP は未設定なので WASM は制限されない。Vite への組み込みは P3-4 で | 3 つの環境で関数が呼べる。1 回の呼び出しが数 µs |
| S12 | スパイク：alphaTab の JSON（scoreToJsObject）→ core → JSON が全フィクスチャで一致 | 完了：demo・GP 各形式・TG 2 種・Champagne.tg（JSON 5.3 MB）で内容が一致（キーの順は型付き項目が先になるが alphaTab はキーで読む）。core の JSON から alphaTab が同じ曲を作れることも確認 | demo・Champagne・tests のフィクスチャで差分なし |
| P3-1 | crates/tabstudio-core：モデル（固定 ID、有理数の時間、奏法の型）と serde | 一部完了：構造（トラック〜音符）と音価・付点・フレット・弦を型付き、その他の項目はそのまま保持、全要素にセッション内で固定の uid。有理数の時間と奏法の型は、コマンド移行（P3-6）で必要になった順に追加 | 単体テスト |
| P3-2 | alphaTab JSON との相互変換（アプリが使う項目は欠落なし） | 完了（S12 の比較を常設テストに：crates/tabstudio-core の every_fixture_round_trips、TABSTUDIO_CORE_FIXTURES で手元の曲も） | S12 の比較を常設テストに |
| P3-3 | 編集操作を「逆操作つきのコマンド」に。トランザクション（1 操作＝1 回の取り消し）と変更範囲（トラック・小節・声部・種類） | 完了：項目の変更・挿入・削除の 3 種の基本操作が逆操作を返す。トランザクションは失敗時に巻き戻し、取り消し履歴は逆操作のみ（500 段）。変更範囲は変わった小節・構造・曲全体。ランダムな編集 400 回→全取り消しで完全に元通り、全やり直しで完全に編集後 | 適用→逆適用で元に戻るテスト（ランダム操作を含む） |
| P3-4 | WASM バインディングと TS ラッパー（src/core） | 完了：CoreDocument（wasm-bindgen）、scripts/build-core-wasm.mjs で src/core/wasm/ に生成（393 KB、コミット済みなのでアプリのビルドに Rust は不要）、src/core/index.ts。編集は位置で指定し core 内で uid に変換。Node のテスト 3 件。画面での読み込みは P3-5 で | Node の単体テストから呼べる。ビルドに組み込み |
| P3-5 | アダプター：変更範囲を alphaTab の Score にその場で反映し、変更小節から再描画 | 未 | JSON の往復なしで表示が一致（verifySnapshot と同じ比較） |
| P3-6 | コマンドを 1 つずつ移行（フレット入力 → 音価 → 奏法 → 小節の挿入削除 → 貼り付け → 移調 …）。旧経路（normalizeEdit）は使用回数 0 まで残す | 未 | 移行したコマンドの単体テストと UI チェックが基準どおり。使用回数を計測 |
| P3-7 | tg-reader / tg-writer を Rust に（quick-xml＋zip） | 未 | TS 版と読み書き結果が一致 |
| P3-8 | 復旧：最後の保存＋操作ジャーナルを追記、クラッシュ時は再生。自動保存の負荷を測定 | 未 | ジャーナルからの復元テスト。自動保存が O(前回からの操作数) |
| P3-9 | 終了判定：長い曲で一般的な編集が O(変更小節)、全テスト・UI チェックが基準どおり | 未 | 計測値（perf-benchmark）を基準と比較 |

## 作業ログ

- 2026-10-09：初回。tauri-migration ブランチ作成、基準値の取得、この進捗ファイルを作成。
- 2026-10-09：P1-1〜P1-11 を実装・検証。スパイク S1〜S4 完了。残りは P1-12（インストーラー、要許可）と P1-13（手動確認）。

- 2026-10-09：P2 開始。S5（外部メディア再生モード）完了、S6（音源の数値比較）完了・聴感確認を依頼。P2-1〜P2-4 完了。

- 2026-10-09：不具合報告（Champagne.tg が再生されない）。Tauri 版：SFZ 音源（Guitar DI）を設定したトラックで読み込みエラーになり再生できなかった→SFZ を使えない版では GM 音源で鳴らすよう修正（eaeedd3）。Electron 版：NAM 2 台＋SFZ 2 台の準備に約 10 秒かかり、その間は再生ボタンが「NAM読み込み中」で押せない（動作は正常。短縮は P2 のネイティブ化で解消予定）。
- 2026-10-09：続報（Gtr2 がずっとパームミュートの音）。SFZ を設定したトラックはファイル内の GM 楽器番号が無関係な値（Gtr2=28 ミュート・ギター、Gtr1=5 エレピ）だったため、SFZ を使えない版では生成した MIDI の楽器番号を 27（クリーン・エレキ）に置き換えるようにした（src/audio/sfz-fallback.ts、テスト 2 件）。譜面の設定は変えない。
- 2026-10-09：依頼「SFZ を使えるように、NAM 中は必ず Standard Guitar DI」。Tauri 版でも Electron と同じ Python の sfz-host を Rust から起動する形で SFZ に対応（src-tauri/src/sampler.rs、単体テスト 3 件）。外部 VST は引き続き未対応。NAM が有効なトラックは、ギター判定に関係なく必ず Guitar DI を使う。見つからない場合は案内を表示。Champagne.tg：Tauri 版で SFZ 2 台（12 弦レーン）＋NAM 2 台が約 10 秒で準備でき、再生・音切れ 0。Electron の UI チェック 6 本（ミキサー・NAM・SFZ 関係）合格。P1-8 の「SFZ は無効」は撤回。
- 2026-10-09：P2-8a〜8d。ついでに Tauri 版の不具合を修正：window.confirm（起動時の「前回の未保存の譜面を復元しますか？」）が許可設定不足で出せなかった→ capabilities に dialog:allow-confirm / allow-message を追加。
- 2026-10-09：P2-8e（新エンジンをオンにした Tauri 版で UI チェック、`UI_TARGET=tauri UI_NATIVE_AUDIO=1`）で見つかって直したこと：
  - 再生停止（Ctrl+Space）後に古い位置で上書きしていた → エンジンの位置は「alphaTab も再生中」のときだけ渡し、停止時は曲末に達した場合だけ最後の位置を渡す。
  - エンジン側でループを折り返すと alphaTab の playerFinished が出ず、「ループのたびにカウント」やスピードトレーナーが動かなかった → 折り返しを検知したら alphaTab にループ終端（+2ms）を一度渡し、alphaTab の開始位置へのシーク（同じ位置）は送らない。
  - 曲を読み込み直すとエンジンの速度とループが消えていた → エンジンは速度を引き継ぎ、画面側は読み込み完了ごとに速度・ループを送り直す。読み込み前のループ指定は覚えておいて後で送る。読み込み前の tick シークは 0 として扱う。
  - 起動前に命令が来ると捨てられていた → 命令はエンジン起動の完了を待ってから送る。
  - enhancements（ループのたびのカウント）は一時停止の通知が非同期で来る前提だった → 通知を受けた処理を一拍遅らせる（Electron の動作は不変）。

## 次にやること

1. 依頼者の聞き比べ（S6）と手動確認（P1-13）の結果を反映する。
2. P2-5（cpal によるリアルタイム出力）から続ける。
3. 許可が出たら P1-12（インストーラー）。
