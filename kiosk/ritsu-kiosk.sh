#!/bin/sh
# 律のキオスク表示 (UNO Q の Xfce 自動ログイン後に autostart から起動)
# 画面の向き・URL は環境変数で上書きできる: ROTATE=left URL=http://localhost:8080/ ./ritsu-kiosk.sh

ROTATE="${ROTATE:-right}"                       # normal / left / right / inverted
URL="${URL:-http://localhost:8080/?lite=1}"     # ?lite=1: Adreno 702 のGPUが固まらない軽量描画

sleep 3                                         # デスクトップの準備待ち
xrandr --output DP-1 --rotate "$ROTATE"
xset s off -dpms s noblank                      # 画面の自動消灯・省電力を無効化
sleep 2

# --ignore-gpu-blocklist: Adreno 702 は WebGL がブロックリスト入りしているため解除
# --use-angle=gles     : 既定の描画方式だとGPUが固まるため OpenGL ES を直接使う
exec chromium --kiosk --noerrdialogs --disable-infobars --disable-session-crashed-bubble \
  --ignore-gpu-blocklist --use-angle=gles --password-store=basic "$URL"
