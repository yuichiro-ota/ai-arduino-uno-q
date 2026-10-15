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

```bash
# WSL から転送（容量の大きいものは /home/arduino 配下へ）
rsync -av --exclude '.git' ./ arduino@192.168.3.80:/home/arduino/ritsu/

# UNO Q 上で
cd /home/arduino/ritsu
docker compose up -d
```

`config.js` の編集や VRM の差し替えは、ブラウザを再読み込みするだけで反映されます。`.env` を変えたときは `docker compose up -d --force-recreate` を実行してください。

画面右上の **LLM** ランプが緑なら LiteLLM に接続できています。

## 4. Chromium キオスク表示（HDMI）

```bash
chromium --kiosk --noerrdialogs --disable-infobars --disable-session-crashed-bubble \
  --autoplay-policy=no-user-gesture-required http://localhost:8080
```

自動起動させる場合は `~/.config/autostart/ritsu.desktop` に上のコマンドを `Exec=` として登録します。

## デバッグ

ブラウザのコンソールから次のように操作できます。

```js
RITSU.play('wave')          // モーション再生
RITSU.list()                // モーション一覧
RITSU.brain.chat('こんにちは') // 会話テスト
```
