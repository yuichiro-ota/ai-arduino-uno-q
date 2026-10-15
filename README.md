# 律 (Ritsu) — Arduino UNO Q 版バーチャル看板娘 (VRM + three.js)

VRMモデル「律」を Arduino UNO Q の HDMI 出力に表示する、表示専用の軽量構成です。
UNO Q では nginx コンテナが静的ファイルを配信し、`/llm/` を LiteLLM（Proxmox CT201）へ中継します。APIキーは nginx 側で付けるので、ブラウザには渡りません。

```
UNO Q (192.168.3.80)                              CT201 (192.168.3.16)     Ollama
┌───────────────────────────────────────┐        ┌────────────────┐     ┌──────────────┐
│ Chromium ──▶ nginx:8080  静的配信       │        │                │──▶ │ 192.168.3.3  │
│ (kiosk)      └ /llm/* ──(+APIキー)──────┼──────▶ │ LiteLLM :4000  │     │ 192.168.3.15 │
└───────────────────────────────────────┘        └────────────────┘     └──────────────┘
```

- 48種類のモーション、8種類の表情、自動まばたき、呼吸、髪の揺れ（スプリングボーン）
- チャット入力 → LLM の返答を字幕で表示し、返答の `[emotion:x][motion:y]` タグで表情とモーションを付ける。口パクあり（音声なし）
- 一定間隔で独り言やダンスをする暇つぶし行動
- `renderer/models/avatar.vrm` を差し替えるだけで別の VRM（0.x / 1.0）に変えられる。ファイルが無い場合は内蔵モデルで起動する

## ファイル構成

| パス | 内容 |
|---|---|
| `docker-compose.yml` | `nginx:alpine`（arm64 対応）。ビルド不要 |
| `.env` | **LiteLLM の接続先とAPIキー**（`.env.example` からコピー。配信されない場所にある） |
| `nginx/default.conf.template` | 起動時に `.env` の値を埋め込む nginx 設定。`/llm/` を LiteLLM に中継してキーを付ける |
| `renderer/config.js` | モデル名（`chat` / `chat-large`）、タイムアウト、暇つぶしの間隔 |
| `renderer/index.html` | 画面（three.js / three-vrm は jsdelivr CDN から読み込み） |
| `renderer/js/brain.js` | LLM 呼び出し、タグ解析、暇つぶし行動 |
| `renderer/js/main.js` | シーン、字幕、口パク、チャット UI |
| `renderer/js/vrm_avatar.js` / `character.js` / `motions.js` | VRM 制御、内蔵モデル、モーション定義 |

## 1. LiteLLM（CT201）

- systemd の `litellm.service`。設定は `/etc/litellm/config.yaml`、キーは `/etc/litellm/litellm.env` の `LITELLM_MASTER_KEY`
- ritsu が使う model_name は次の2つ

| model_name | 中身 |
|---|---|
| `chat` | gemma3:4b（192.168.3.3 / 192.168.3.15 に分散） |
| `chat-large` | gemma3:12b（192.168.3.3 のみ。失敗したら `chat` に切り替わる） |

確認（UNO Q 上で実行）:

```bash
curl -s http://192.168.3.16:4000/v1/models -H "Authorization: Bearer <key>"
```

## 2. 設定

```bash
cp .env.example .env    # LITELLM_URL / LITELLM_KEY を記入
chmod 600 .env
```

モデルは `renderer/config.js` の `llmModel` で選びます（`chat` / `chat-large`）。一時的に切り替えるときは `http://localhost:8080/?model=chat-large` のように指定できます。

## 3. UNO Q へ配置して起動

UNO Q には GitHub の Deploy key（読み取り専用）を登録してあります。

```bash
# 初回
cd ~/ritu && git clone git@github.com:yuichiro-ota/ai-arduino-uno-q.git
cd ai-arduino-uno-q
cp .env.example .env && chmod 600 .env   # LITELLM_KEY を記入（.env は Git の管理外）
docker compose up -d

# 更新（WSL で push したあと）
cd ~/ritu/ai-arduino-uno-q && git pull
```

`git pull` で取り込んだ `config.js` や JS の変更、VRM の差し替えは、ブラウザを再読み込みするだけで反映されます。`.env` を変えたときは `docker compose up -d --force-recreate` を実行してください。

画面右上の **LLM** ランプが緑なら LiteLLM に接続できています。

## 4. キオスク表示（UNO Q の画面に全画面で表示）

UNO Q のデスクトップは LightDM + Xfce（X11 `:0`）です。映像は USB-C ハブの DisplayPort（`DP-1`）から出ます。

```bash
# arduino ユーザーで自動ログイン
sudo mkdir -p /etc/lightdm/lightdm.conf.d
printf '[Seat:*]\nautologin-user=arduino\nautologin-session=xfce\n' | sudo tee /etc/lightdm/lightdm.conf.d/50-ritsu-autologin.conf
sudo groupadd -f autologin && sudo gpasswd -a arduino autologin

# ログイン後に kiosk/ritsu-kiosk.sh を起動
mkdir -p ~/.config/autostart
cp kiosk/ritsu-kiosk.desktop ~/.config/autostart/
sudo reboot
```

`kiosk/ritsu-kiosk.sh` が行うこと:
- 画面を縦向きに回転（`ROTATE`、既定は `right`）
- 画面の自動消灯と省電力を無効化
- Chromium を `--ignore-gpu-blocklist --use-angle=gles` 付きで、`?lite=1`（軽量描画）を開いて起動

注意点:
- **GPU（Adreno 702）**: 標準の描画のままだと GPU が固まり（`dmesg` に `gpu lockup`）、画面が消えます。`?lite=1` で回避しています。どこまで軽くするかは `renderer/config.js` の描画設定で調整します。
- **画面が映らない、または映ってすぐ消える**: Xfce のディスプレイ設定が壊れている場合があります。`~/.config/xfce4/xfconf/xfce-perchannel-xml/displays.xml` を退避して `sudo systemctl restart lightdm` を実行してください。
- **SSH から画面を操作するとき**: `DISPLAY=:0` を付けます。MobaXterm などで X11 転送が有効だと、Windows 側に表示されます。

## デバッグ

ブラウザのコンソールから次のように操作できます。

```js
RITSU.play('wave')          // モーション再生
RITSU.list()                // モーション一覧
RITSU.brain.chat('こんにちは') // 会話テスト
```
