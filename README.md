# 律 (Ritsu) — Arduino UNO Q 版バーチャル看板娘 (VRM + three.js + ROS 2)

VRMモデル「律」を Arduino UNO Q の画面に表示し、会話・視線追従・カメラの傾きへの反応を行います。
センサーと画面のやり取りは **ROS 2 (Jazzy)** で行い、ブラウザ（画面の律・iPhone の入力ページ）は rosbridge 経由で ROS 2 につながります。将来、台車（メカナムホイール）のノードも同じ ROS 2 に足せます。

```
                     UNO Q (192.168.3.80)                                   CT201 (192.168.3.16)
iPhone ─/remote─▶ nginx:8080 ─ /llm/* (+APIキー) ───────────────────▶ LiteLLM :4000 ─▶ Ollama
(Safari)            └ /rosbridge ─▶ rosbridge :9090 ◀──ROS 2──▶ ritsu_perception (深度カメラ Gemini 335)
                                        ▲
                         Chromium(kiosk) = 画面の律
```

- 48種類のモーション、8種類の表情、自動まばたき、呼吸、髪の揺れ（スプリングボーン）
- チャット入力 → LLM の返答を画面下側の吹き出し（縦置きモニターで読みやすい大きな文字、顔を隠さない位置）で表示し、返答の `[emotion:x][motion:y]` タグで表情とモーションを付ける。口パクあり（音声なし）
- **iPhone などから話しかけられる**: `http://192.168.3.80:8080/remote` を開くと、入力ページから画面の律に話しかけ、返事を受け取れる（複数台で同時に使える）
- 深度カメラで人の顔の位置を測り（`/ritsu/person`）、律の目線がその人を追う
- カメラ（IMU）が左右に15度以上傾くと、傾いた側へ「おっとっと」とよろける
- 会話が無いと1〜2分に1回カメラが目元まで寄ってのぞき込む、話しかけると胸から上へ寄る、物音に振り向く
- 一定間隔で独り言やダンスをする暇つぶし行動
- **今の状況に合わせた会話**（`renderer/js/context.js`）: 日時・時間帯・季節・平日/土日/祝日（振替休日を含む）・季節の行事・天気（Open-Meteo、`config.js` の `weather` で場所を設定）・カメラ前の人の距離を LLM に渡し、会話が無い間は約20秒に1回しゃべり、そのうち約30秒に1回は LLM が状況から毎回違う独り言を作る（`config.js` の `idleMinSec` / `idleMaxSec` / `idleSpeakChance` / `llmIdleChance`）。残りは状況に合わせて用意したセリフから選ぶ。人が来たら時間帯に合った挨拶、帰ったらお見送り、とても近いと照れる
- **返答の検証**: LLM の返答から知らない表情・モーション名、崩れたタグ、記号、絵文字、名前の前置きを取り除き、長すぎる返答は文の区切りで切る。日本語でない返答は使わない
- `renderer/models/avatar.vrm` を差し替えるだけで別の VRM（0.x / 1.0）に変えられる。ファイルが無い場合は内蔵モデルで起動する

## ファイル構成

| パス | 内容 |
|---|---|
| `docker-compose.yml` | `renderer`（nginx）、`rosbridge`、`perception`（人検出）。ROS 2 の2つはホストネットワーク + `ipc: host` |
| `.env` | **LiteLLM の接続先とAPIキー**（`.env.example` からコピー。配信されない場所にある） |
| `nginx/default.conf.template` | 起動時に `.env` の値を埋め込む nginx 設定。`/llm/` を LiteLLM に中継してキーを付ける。`/rosbridge` を rosbridge に中継、`/remote` で入力ページを返す |
| `ros/Dockerfile` | ROS 2 Jazzy のイメージ（rosbridge、Orbbec SDK、OpenCV、顔検出モデル YuNet） |
| `ros/ritsu_perception.py` | 人検出・傾きの ROS 2 ノード |
| `renderer/config.js` | モデル名（`chat` / `chat-large`）、タイムアウト、暇つぶし・のぞき込みの間隔、描画の重さ |
| `renderer/index.html` | 画面（three.js / three-vrm / roslib.js は jsdelivr CDN から読み込み） |
| `renderer/remote.html` | iPhone などから話しかける入力ページ |
| `renderer/js/ros.js` | rosbridge への接続（自動再接続・購読のやり直し） |
| `renderer/js/context.js` | 今の状況（日時・季節・祝日・カメラ前の人） |
| `renderer/js/brain.js` | LLM 呼び出し、返答の検証、状況に合わせた独り言・挨拶 |
| `renderer/js/main.js` | シーン、カメラワーク、吹き出し、口パク、チャット UI、ROS 2 連携 |
| `renderer/js/vrm_avatar.js` / `character.js` / `motions.js` | VRM 制御、内蔵モデル、モーション定義 |
| `kiosk/ritsu-kiosk.sh` | キオスク表示の起動スクリプト |

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
docker compose up -d --build

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

## 5. ROS 2 トピック

| トピック | 型 | 送る側 → 受け取る側 | 内容 |
|---|---|---|---|
| `/ritsu/chat_user` | `std_msgs/String` | 入力ページ・画面のキーボード → 画面の律 | JSON `{"text":"...","from":"..."}`（素の文字列でも可） |
| `/ritsu/say` | `std_msgs/String` | 画面の律 → 入力ページ | JSON `{"text":"...","emotion":"happy","motion":"wave","source":"llm/fallback/idle"}` |
| `/ritsu/thinking` | `std_msgs/Bool` | 画面の律 → 入力ページ | 返事を考え中 |
| `/ritsu/person` | `geometry_msgs/PointStamped` | 人検出 → 画面の律 | 顔（両目の中点）の位置 [m]。`camera_color_optical_frame`（x:右、y:下、z:前） |
| `/ritsu/person_present` | `std_msgs/Bool` | 人検出 → | 人を見失ったら false |
| `/ritsu/camera_alive` | `std_msgs/Bool` | 人検出 → 画面の律 | 2秒ごとの生存通知（画面右上の CAMERA ランプ: 緑=人を検出中、黄=人はいない、灰=通知なし） |
| `/ritsu/tilt` | `geometry_msgs/Vector3` | 人検出 → 画面の律 | カメラの傾き [度]。x=roll（左右）、y=pitch（前後）。起動時を0度。左右15度以上で「おっとっと」（8度未満に戻るまで再発動しない） |
| `/camera/imu` | `sensor_msgs/Imu` | 人検出 → | 加速度の生データ（`linear_acceleration` のみ） |

- `/ritsu/chat_user` に応答するのは、URL に `?kiosk=1` を付けて開いた画面（キオスク表示）だけです。PC などで `index.html` を開いて確認しても、二重に返事をしません。
- ROS 2 のコマンドで試す例: `docker exec -it ritsu-camera bash -c "source /opt/ros/jazzy/setup.bash && ros2 topic echo /ritsu/person"`
- 別のマシン（台車の Jetson など）の ROS 2 からも、同じネットワーク・同じ `ROS_DOMAIN_ID`（既定 0）ならトピックが見えます。

## 6. 深度カメラ（Orbbec Gemini 335）

`perception` サービス（`ros/ritsu_perception.py`）が人検出です。カラー映像から OpenCV の YuNet で顔を検出し、深度から3次元の位置を求めて `/ritsu/person` に送ります。IMU（加速度）からカメラの傾きも求めます。

```bash
docker compose up -d --build              # 律の画面・rosbridge・人検出をまとめて起動
docker logs -f ritsu-camera               # 検出状況が5秒ごとに出る
```

- 環境変数: `CAMERA_ROTATE`（カメラを縦置きしたとき 90/180/270）、`PERCEPTION_FPS`（1秒あたりの検出回数、既定 8）、`IMU_ROLL_SIGN`（傾けた向きと律がよろける向き。Gemini 335 実機に合わせて既定は -1）、`DEBUG_SNAPSHOT`（1 で確認用画像を `:8080/debug/camera.jpg` に出す。LAN 内の誰でも見えるので確認後は外す）
- カメラから10秒映像が来なければ、自動で開き直します。
- 開発PC（WSL）で使うときは、Windows 側で usbipd-win を使ってカメラを WSL に渡します（`usbipd bind --busid <BUSID>` → `usbipd attach --wsl --busid <BUSID>`）。

## デバッグ

ブラウザのコンソールから次のように操作できます。

```js
RITSU.play('wave')          // モーション再生
RITSU.list()                // モーション一覧
RITSU.brain.chat('こんにちは') // 会話テスト
RITSU.ctx.describe()        // LLM に渡している「今の状況」
RITSU.person(1.2)           // カメラ無しで人が来たことにする(距離[m])。8秒呼ばないと帰った扱い
```
