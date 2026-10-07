# Tab Studio 0.3.9 — 初期版の配布

## Windows

`Tab-Studio-0.3.9-Setup.exe`を開き、インストール先を選んでインストールします。Windows 10/11の64ビット版を対象にしています。デスクトップまたはスタートメニューのTab Studioから起動します。アンインストールはWindowsの「インストールされているアプリ」から行えます。

インストーラの埋め込みアーカイブと展開したアプリの起動・音源準備・基本キー操作・終了確認をWindowsで検証しています。OSへ実際に登録するインストール/アンインストールの往復テストは実施していません。開発元証明書による署名はなく、初回にWindowsの確認画面が出る場合があります。

## Mac

- Apple Silicon（M1以降）: `Tab-Studio-0.3.9-mac-arm64-Install.zip`
- Intel Mac: `Tab-Studio-0.3.9-mac-x64-Install.zip`

ZIP全体を展開し、`Install Tab Studio.command`を開きます。自分のホームフォルダの`Applications`へアプリをコピーし、Mac上でローカル署名を行います。既存アプリがある場合は日時付きでバックアップします。macOS 12以降を対象にしています。

Mac環境がないため、インストール・起動・音声再生は未確認です。DMG/PKGではなく、インストールスクリプト付きZIPです。Apple Developer ID署名・公証はありません。ローカル署名は開発元の認証を意味しません。初回起動の確認については[Apple公式の案内](https://support.apple.com/ja-jp/102445)を参照してください。

## Mac用DMGを作成する場合

同梱のソースZIPをMacへ展開し、Node.js 22以降とpnpm 11を用意して`packaging/Build Mac DMG.command`を実行します。DMGにはTab Studio.appとApplicationsへのリンクを配置します。生成物はローカル署名のみで、Appleの公証はありません。

ソースには手動実行用のGitHub Actions設定も含めています。GitHubへのアップロード・ワークフローの実行・公開リリースの作成は行っていません。

## 譜面と保存データ

譜面はアプリとは別に保存します。アプリのインストール・更新で保存済み譜面を書き換えません。初回起動の確認用には同梱デモを利用できます。
