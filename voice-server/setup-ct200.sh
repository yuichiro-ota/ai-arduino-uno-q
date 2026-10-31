#!/bin/bash
# setup-ct200.sh — 律の声のサーバー(文字起こし Whisper + 音声合成 VOICEVOX)を CT200 に入れる
#
#   CT200 (Ollama のコンテナ、RTX 3050) の中で root で実行する。何度実行しても大丈夫。
#     ritsu-stt.service : faster-whisper の文字起こし   :8100  (stt_server.py)
#     ritsu-tts.service : VOICEVOX ENGINE の音声合成     :50021
#   UNO Q の nginx が /stt/ と /tts/ をここへ中継する(.env の STT_URL / TTS_URL)。
#
#   使い方(Proxmox 本体から):
#     pct push 200 voice-server/setup-ct200.sh /root/setup-ct200.sh
#     pct push 200 voice-server/stt_server.py  /root/stt_server.py
#     pct exec 200 -- bash /root/setup-ct200.sh
#   必要なもの: ディスクの空き 約10GB(VOICEVOX 約5GB・Whisper のモデル 約1.6GB・CUDA ライブラリ 約2GB)、
#              メモリ 約3GB の余裕(CT200 の割り当てを 7〜8GB に)
set -euo pipefail

DIR=/opt/ritsu-voice
VOICEVOX_VER="${VOICEVOX_VER:-0.26.0}"
WHISPER_MODEL="${WHISPER_MODEL:-large-v3-turbo}"
HERE="$(cd "$(dirname "$0")" && pwd)"

say() { echo "[setup] $*"; }
[ "$(id -u)" -eq 0 ] || { echo "root で実行してください" >&2; exit 1; }
[ -f "$HERE/stt_server.py" ] || { echo "stt_server.py を同じフォルダに置いてください" >&2; exit 1; }
nvidia-smi -L >/dev/null 2>&1 || say "注意: GPU が見えません(nvidia-smi)。そのままだと CPU で動き、遅くなります"

say "必要なパッケージ"
apt-get update -qq
apt-get install -y -qq python3-venv python3-pip p7zip-full curl >/dev/null

say "文字起こし(faster-whisper)"
mkdir -p "$DIR/models"
[ -x "$DIR/venv/bin/python" ] || python3 -m venv "$DIR/venv"
"$DIR/venv/bin/pip" install -q --upgrade pip
# CUDA 12 の cuBLAS / cuDNN 9 は pip で入れる(CT200 に CUDA を入れなくてよい)
"$DIR/venv/bin/pip" install -q "faster-whisper>=1.1,<2" fastapi "uvicorn[standard]" python-multipart \
    nvidia-cublas-cu12 "nvidia-cudnn-cu12>=9,<10"
install -m 644 "$HERE/stt_server.py" "$DIR/stt_server.py"
# nvidia.*.lib は __init__.py の無いパッケージ(__file__ が無い)なので __path__ から場所を取る
LIBS=$("$DIR/venv/bin/python" -c 'import nvidia.cublas.lib as b, nvidia.cudnn.lib as d; print(list(b.__path__)[0] + ":" + list(d.__path__)[0])')

say "音声合成(VOICEVOX ENGINE $VOICEVOX_VER、GPU 版)"
if [ ! -x "$DIR/voicevox/run" ] || [ "$(cat "$DIR/voicevox/.version" 2>/dev/null)" != "$VOICEVOX_VER" ]; then
  mkdir -p "$DIR/dl"
  base="https://github.com/VOICEVOX/voicevox_engine/releases/download/$VOICEVOX_VER"
  for part in 001 002; do
    f="voicevox_engine-linux-nvidia-$VOICEVOX_VER.7z.$part"
    [ -f "$DIR/dl/$f" ] || curl -fL --retry 3 -o "$DIR/dl/$f" "$base/$f"
  done
  rm -rf "$DIR/dl/x" && mkdir -p "$DIR/dl/x"
  7z x -y -o"$DIR/dl/x" "$DIR/dl/voicevox_engine-linux-nvidia-$VOICEVOX_VER.7z.001" >/dev/null
  run=$(find "$DIR/dl/x" -maxdepth 3 -name run -type f | head -1)
  [ -n "$run" ] || { echo "VOICEVOX の run が見つかりません" >&2; exit 1; }
  rm -rf "$DIR/voicevox" && mv "$(dirname "$run")" "$DIR/voicevox"
  chmod +x "$DIR/voicevox/run"
  echo "$VOICEVOX_VER" > "$DIR/voicevox/.version"
  rm -rf "$DIR/dl"                       # ダウンロードした約3GBは消す
fi

say "サービス"
cat > /etc/systemd/system/ritsu-stt.service <<EOF
[Unit]
Description=Ritsu STT (faster-whisper)
After=network-online.target

[Service]
WorkingDirectory=$DIR
Environment=WHISPER_MODEL=$WHISPER_MODEL
Environment=WHISPER_DIR=$DIR/models
Environment=LD_LIBRARY_PATH=$LIBS
ExecStart=$DIR/venv/bin/uvicorn stt_server:app --host 0.0.0.0 --port 8100
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
cat > /etc/systemd/system/ritsu-tts.service <<EOF
[Unit]
Description=Ritsu TTS (VOICEVOX ENGINE)
After=network-online.target

[Service]
WorkingDirectory=$DIR/voicevox
ExecStart=$DIR/voicevox/run --host 0.0.0.0 --port 50021 --use_gpu
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable -q --now ritsu-stt ritsu-tts
systemctl restart ritsu-stt ritsu-tts

say "起動を待っています(初回は Whisper のモデル 約1.6GB をダウンロードするので数分かかります)"
for i in $(seq 1 300); do
  stt=$(curl -s -m 2 localhost:8100/health || true)
  tts=$(curl -s -m 2 localhost:50021/version || true)
  [ -n "$stt" ] && [ -n "$tts" ] && break
  sleep 2
done
say "文字起こし: ${stt:-まだ起動していません(journalctl -u ritsu-stt -f で確認)}"
say "音声合成:   VOICEVOX ${tts:-まだ起動していません(journalctl -u ritsu-tts -f で確認)}"
say "GPU の使用状況:"
nvidia-smi --query-compute-apps=process_name,used_memory --format=csv,noheader 2>/dev/null || true
