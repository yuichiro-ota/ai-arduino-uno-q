#!/bin/sh
# 律のキオスク表示 (UNO Q の Xfce 自動ログイン後に autostart から起動)
# 画面の向き・URL は環境変数で上書きできる: ROTATE=left URL=http://localhost:8080/ ./ritsu-kiosk.sh

ROTATE="${ROTATE:-right}"                       # normal / left / right / inverted
# ?lite=1: Adreno 702 のGPUが固まらない軽量描画 / ?kiosk=1: 入力ページ(ROS 2)からの話しかけに応答する
URL="${URL:-http://localhost:8080/?lite=1&kiosk=1}"
# 律の会話は日時・曜日・祝日を使うので、本体の時刻設定に関係なく日本時間で動かす
export TZ="${TZ:-Asia/Tokyo}"

sleep 3                                         # デスクトップの準備待ち
xrandr --output DP-1 --rotate "$ROTATE"
xset s off -dpms s noblank                      # 画面の自動消灯・省電力を無効化
sleep 2

# --ignore-gpu-blocklist: Adreno 702 は WebGL がブロックリスト入りしているため解除
# --use-angle=gles     : 既定の描画方式だとGPUが固まるため OpenGL ES を直接使う
# --autoplay-policy / --use-fake-ui-for-media-stream: 律の声を画面のタップなしで再生し、マイクの許可を自動で出す
#   (マイク・スピーカーは OS の既定の機器。Anker PowerConf を既定にしておく)
exec chromium --kiosk --noerrdialogs --disable-infobars --disable-session-crashed-bubble \
  --ignore-gpu-blocklist --use-angle=gles --password-store=basic \
  --autoplay-policy=no-user-gesture-required --use-fake-ui-for-media-stream "$URL"
