# Tauri版の操作検証で見つけた不具合の修正（2026-10-11）

WindowsのTauri release版で再現した4件を修正した。

| 不具合 | 修正と確認 |
|---|---|
| 保存中にタブを切り替えると、別の譜面のファイルを上書きする | 保存開始時の文書・保存先を固定する。完了時のパス・保存済み状態は元の文書だけに反映する。文書ごとの編集世代を確認し、保存中の追加編集は未保存のまま残す。同じ文書の連続保存は同じ処理を待つ。168小節×4トラックで実ファイルの内容まで確認した。 |
| 先頭の音符が再生されない | alphaTabの位置報告は時間から計算したtickに1を加えるため、外部音声エンジンへのシーク時に補正する。先頭と拍の境界のテストを追加し、実機で先頭音のDSP出力を確認した。 |
| トラックを並べ替えても譜面の表示順が変わらない | 表示対象をトラック番号順に正規化し、描画時にも順番をそろえる。並べ替え、取り消し、やり直し、複製、一部トラック表示を実機で確認した。 |
| SoundFont交換が反映されず「読み込み中」のままになる | SF2/SF3をネイティブ音声エンジンへ送るコマンドを追加し、通常再生と試聴の音源を交換する。MIDI再読み込みとの競合を防ぎ、不正な音源を選んだ場合は従来の音源を維持する。読み込み中は再生を待たせ、成功・失敗の状態を表示する。 |

保存して閉じる処理も、待っている間に追加編集があれば文書を閉じない。

検証結果：

- `pnpm test`：258件合格。
- `pnpm run tauri:build -- --no-bundle`：型チェックとWindows releaseビルド成功。
- `cargo test --manifest-path src-tauri/Cargo.toml --release --lib`：23件合格。
- `node scripts/tauri-regression-check.mjs`：4件の回帰確認と、保存中の追加編集・連続保存・別タブの未保存状態・TG再読み込み・トラック操作・SF2/SF3交換・不正音源からの復帰が合格。WebViewの例外なし。
- `TAURI_PROFILE=release node --import tsx scripts/tauri-native-playback-check.mjs`：速度変更、ループ、NAM、BIAS FX 2、曲末までの再生が合格。外部FXの遅延フレーム数0。
- `TAURI_PROFILE=release node scripts/tauri-files-check.mjs`：ファイル保存、再起動後のタブ復元、復旧データ、終了処理が合格。

回帰チェックは専用の新規テストプロファイルとテスト用ファイルを使う。音声検証はスピーカーをミュートし、実際のDSP出力と再生位置を確認する。結果は `test-results/tauri-regressions-1791704988122/results.json` に保存した。

修正版は `Tab Studio (Tauri).cmd` が参照する `src-tauri/target/release/tab-studio.exe` に反映済み。
