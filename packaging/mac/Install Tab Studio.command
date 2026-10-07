#!/bin/bash
set -euo pipefail
cd -- "$(dirname "$0")"
source_app="$PWD/Tab Studio.app"
target_root="$HOME/Applications"
target_app="$target_root/Tab Studio.app"
stage_app="$target_root/Tab Studio-install-$$.app"

if [[ ! -d "$source_app" ]]; then
  echo 'Tab Studio.app が見つかりません。ZIPをすべて展開してください。'
  exit 1
fi
if /usr/bin/pgrep -x 'Tab Studio' >/dev/null; then
  echo 'Tab Studioを終了してから、もう一度インストールしてください。'
  exit 1
fi
/usr/bin/osascript -e 'display dialog "Tab StudioをホームフォルダのApplicationsにインストールします。既存のアプリがあればバックアップします。" buttons {"キャンセル", "インストール"} default button "インストール" cancel button "キャンセル"'
/bin/mkdir -p "$target_root"
/usr/bin/ditto "$source_app" "$stage_app"
# A local ad-hoc signature is needed after packaging the bundle on Windows.
# This is not a Developer ID signature or Apple notarization.
/usr/bin/codesign --force --deep --sign - "$stage_app"
/usr/bin/codesign --verify --deep --strict "$stage_app"
if [[ -e "$target_app" ]]; then
  /bin/mv "$target_app" "$target_root/Tab Studio-backup-$(/bin/date +%Y%m%d-%H%M%S)-$$.app"
fi
/bin/mv "$stage_app" "$target_app"
echo "インストール先: $target_app"
echo 'Appleの公証はありません。初回起動の案内は同梱READMEを確認してください。'
/usr/bin/open "$target_app"
