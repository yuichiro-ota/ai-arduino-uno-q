# 律 (Ritsu) — Arduino UNO Q 版バーチャルキャラクター (VRM + three.js + ROS 2)

VRMモデル「律」を Arduino UNO Q の画面に表示し、会話・視線追従・カメラの傾きへの反応を行います。
センサーと画面のやり取りは **ROS 2 (Jazzy)** で行い、ブラウザ（画面の律・iPhone の入力ページ）は rosbridge 経由で ROS 2 につながります。将来、台車（メカナムホイール）のノードも同じ ROS 2 に足せます。

```
                     UNO Q (192.168.3.80)                                   CT201 (192.168.3.16)
iPhone ─/remote─▶ nginx:8080 ─ /llm/* (+APIキー) ───────────────────▶ LiteLLM :4000 ─▶ Ollama
(Safari)            └ /rosbridge ─▶ rosbridge :9090 ◀──ROS 2──▶ ritsu_perception (深度カメラ Gemini 335・顔の見分け)
                                        ▲             ◀──ROS 2──▶ ritsu_memory (記憶・反応の記録 → ./data)
                         Chromium(kiosk) = 画面の律
```

- 48種類のモーション、8種類の表情、自動まばたき、呼吸、髪の揺れ（スプリングボーン）
- チャット入力 → LLM の返答を画面下側の吹き出し（縦置きモニターで読みやすい大きな文字、顔を隠さない位置）で表示し、返答の `[emotion:x][motion:y]` タグで表情とモーションを付ける。口パクあり（音声なし）
- **iPhone などから話しかけられる**: `http://192.168.3.80:8080/remote` を開くと、入力ページから画面の律に話しかけ、返事を受け取れる（複数台で同時に使える）
- 深度カメラで人の顔の位置を測り（`/ritsu/person`）、律の目線がその人を追う
- カメラ（IMU）が左右に15度以上傾くと、傾いた側へ「おっとっと」とよろける
- **目が合った人にだけ挨拶する**: 顔の向き（目と鼻の位置）からこちらを見ているかを判定し、通り過ぎるだけの人には話しかけない
- **近づいてくる人を迎える**: こちらを見ながら近づいてくると、嬉しそうに跳ねたり手を振ったりして迎える
- **離れた人をのぞき込む**: こちらを見ていた人が、一番近づいたところから 50cm ほど下がると（`context.js` の `STEP_BACK`）、カメラが寄って画面の向こうをのぞき込み「あれ?遠くて見えにくいです」（1分に1回まで。こちらを見ずに去る人は見送り）
- **去っていく人を見送る**: 画面の端から去ったらその側を向いて手を振る（目が合った・挨拶した・話した・しばらくいた人だけ）
- **ガラスに手**: 画面のすぐ前（45cm以内）に手を出すと、律も内側から、手のある高さ・位置に合わせて手を合わせる
- **相手に合わせた姿勢**: 人がいる間は体も少し相手へ向け、すぐ目の前の人には少しのけぞり、離れたところからこちらを見ている人には身を乗り出す
- **マスターの顔を覚える**: 入力ページの「マスター登録」で顔を登録すると（OpenCV SFace。顔の画像は保存せず、見分けるための数値だけを UNO Q の `data/faces/` に保存）、その人を「マスター」と呼んで親しく話す。知らない人として挨拶したあとで気づいたら「あっ、マスターでしたか」
- **LLM が反応を決める**: 来た・目が合った・近づいた・しばらく居てくれる人への反応は、LLM が今の状況と記憶を見て「何を言うか・どう動くか・何もしないか」を決める（4秒以内に答えが無ければ用意したセリフ）。手を合わせる・見送る・迎える・のぞき込む・よろけるなどの体の反応は待たずにすぐ動く
- **記憶**（`ros/ritsu_memory.py`）: 今日来た人・目が合った人・話してくれた人の数、話した人との会話の要約（LLM が1文にまとめる）、マスターとの会話の要約と前回会った日を `data/memory.json` に残し、会話に使う。ほかの人やマスターとの会話の中身は、マスター以外には話さない。次の人に前の人との会話は引き継がない
- **反応の学習**: 挨拶（短く / 話しかけてと誘う / 質問する）と、しばらく居てくれる人への声かけ（動きだけ / 一言 / 質問）のやり方ごとに、そのあと30秒のうちに話しかけてくれたか・どれだけ居てくれたかを記録し（`data/log/日付.jsonl`）、結果のよいやり方を多めに選ぶ（2割は試しに別のやり方）。マスターへの反応は数えない。`docker logs ritsu-memory` で10分ごとに集計が出る
- 会話が無いと1〜2分に1回カメラが目元まで寄ってのぞき込む、話しかけると胸から上へ寄る、物音に振り向く
- 一定間隔で独り言やダンスをする暇つぶし行動
- **今の状況に合わせた会話**（`renderer/js/context.js`）: 日時・時間帯・季節・平日/土日/祝日（振替休日を含む）・季節の行事・天気（Open-Meteo、`config.js` の `weather` で場所を設定）・カメラ前の人の距離を LLM に渡し、会話が無い間は約20秒に1回しゃべり、そのうち約30秒に1回は LLM が状況から毎回違う独り言を作る（`config.js` の `idleMinSec` / `idleMaxSec` / `idleSpeakChance` / `llmIdleChance`）。残りは状況に合わせて用意したセリフから選ぶ。人が来たら時間帯に合った挨拶、帰ったらお見送り、とても近いと照れる
- **声で話す**（`renderer/js/voice.js`、`voice-server/`）: USB スピーカーフォン（Anker PowerConf）で聞いて話す。話している区間を音量で切り出して CT200 の Whisper で文字にし、返事を VOICEVOX（WhiteCUL ノーマル）で読み上げ、声の大きさに合わせて口を動かす。最初の文ができたらすぐ話し始める。相手が話している間は聞く姿勢で小さくうなずき、話し終わったら「うんうん」「なるほど」と相槌（先に作っておいた声なので待たない）、返事に時間がかかると「えっと……」。律がしゃべっている間とカメラに誰も映っていない間は聞かない。独り言も声に出す（`idleAloud: false` で人がいるときだけ）。読み上げでは「℃」を「度」、「%」を「パーセント」と読む。画面右下に「VOICEVOX:WhiteCUL」と表示（VOICEVOX の利用条件）
- **静かにする**: 「静かに」「黙って」「うるさい」などと言われる（声でもチャットでも）と、5分間は自分からしゃべらない（独り言・挨拶などの反応は動きだけ。話しかけられたら答える）。「話していいよ」「もういいよ」などで取り消す。コンソールでは `RITSU.quiet()` / `RITSU.quiet(0)`
- **最近のニュース**: memory ノードが30分ごとに Yahoo!ニュース・トピックスの見出し（主要・エンタメ・スポーツ・科学・IT）を取り、事件・事故・災害などの暗い見出しを除いて律に渡す。聞かれたら答え、会話が無い間の独り言でもときどき話題にする（`config.js` の `newsIdleChance`）。見出しに無い内容は推測で話さない
- **考え中の「・・・」**: LLM に問い合わせている間は吹き出しに「・・・」を出す（話しかけへの返事はすぐ、独り言や反応は0.4秒たっても答えが無いときだけ）
- **返答の検証**: LLM の返答から知らない表情・モーション名、崩れたタグ、記号、絵文字、名前の前置きを取り除き、長すぎる返答は文の区切りで切る。日本語でない返答は使わない
- `renderer/models/avatar.vrm` を差し替えるだけで別の VRM（0.x / 1.0）に変えられる。ファイルが無い場合は内蔵モデルで起動する

## ファイル構成

| パス | 内容 |
|---|---|
| `docker-compose.yml` | `renderer`（nginx）、`rosbridge`、`perception`（人検出）、`memory`（記憶・反応の記録）。ROS 2 の3つはホストネットワーク + `ipc: host` |
| `.env` | **LiteLLM の接続先とAPIキー**（`.env.example` からコピー。配信されない場所にある） |
| `nginx/default.conf.template` | 起動時に `.env` の値を埋め込む nginx 設定。`/llm/` を LiteLLM に中継してキーを付ける。`/rosbridge` を rosbridge に中継、`/remote` で入力ページを返す |
| `ros/Dockerfile` | ROS 2 Jazzy のイメージ（rosbridge、Orbbec SDK、OpenCV、顔検出モデル YuNet、顔の見分けモデル SFace） |
| `ros/ritsu_perception.py` | 人検出・傾き・マスターの顔の見分けの ROS 2 ノード |
| `ros/ritsu_memory.py` | 記憶（`data/memory.json`）と反応の記録（`data/log/`）、ニュースの見出しの取得の ROS 2 ノード |
| `data/` | 記憶・反応の記録・登録した顔の数値（UNO Q の中だけ。Git の管理外） |
| `voice-server/` | CT200 に入れる声のサーバー: `stt_server.py`（faster-whisper の文字起こし :8100）と `setup-ct200.sh`（Whisper と VOICEVOX ENGINE を systemd サービスとして入れる） |
| `renderer/js/voice.js` | マイクで聞く（区間の切り出し → /stt）・読み上げ（/tts）・口の動き |
| `renderer/config.js` | モデル名（`chat` / `chat-large`）、タイムアウト、暇つぶし・のぞき込みの間隔、描画の重さ |
| `renderer/index.html` | 画面（three.js / three-vrm / roslib.js は jsdelivr CDN から読み込み） |
| `renderer/remote.html` | iPhone などから話しかける入力ページ |
| `renderer/js/ros.js` | rosbridge への接続（自動再接続・購読のやり直し） |
| `renderer/js/context.js` | 今の状況（日時・季節・祝日・カメラ前の人） |
| `renderer/js/brain.js` | LLM 呼び出し、返答の検証、状況に合わせた独り言・挨拶、LLM が決める反応、記憶、反応の学習 |
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
| `/ritsu/looking` | `std_msgs/Bool` | 人検出 → 画面の律 | 顔がこちら（カメラ）を向いているか。変化したとき＋2秒ごと |
| `/ritsu/hand_near` | `geometry_msgs/PointStamped` | 人検出 → 画面の律 | 画面のすぐ前（`TOUCH_DIST` 以内）の手の位置 [m]、光学座標系。ある間は毎回 |
| `/ritsu/tilt` | `geometry_msgs/Vector3` | 人検出 → 画面の律 | カメラの傾き [度]。x=roll（左右）、y=pitch（前後）。起動時を0度。左右15度以上で「おっとっと」（8度未満に戻るまで再発動しない） |
| `/camera/imu` | `sensor_msgs/Imu` | 人検出 → | 加速度の生データ（`linear_acceleration` のみ） |
| `/ritsu/person_id` | `std_msgs/String` | 人検出 → 画面の律 | JSON `{"id":"master"または"","score":0.52}` 顔で見分けた相手。変化したとき＋2秒ごと（顔を登録していないときは送らない） |
| `/ritsu/enroll` | `std_msgs/String` | 入力ページ → 人検出 | JSON `{"action":"add"}` でマスターの顔を登録（約4秒で6枚）、`{"action":"clear"}` で消す |
| `/ritsu/enroll_status` | `std_msgs/String` | 人検出 → 入力ページ | JSON `{"state":"capturing/done/failed/cleared","count":n}` |
| `/ritsu/memory` | `std_msgs/String` | 記憶 → 画面の律 | JSON 覚えていること `today` / `master`、反応の結果 `stats`、ニュースの見出し `news`。5秒ごと |
| `/ritsu/memory_put` | `std_msgs/String` | 画面の律（kiosk） → 記憶 | JSON `{"key":"today/master","value":{...}}` |
| `/ritsu/log` | `std_msgs/String` | 画面の律（kiosk） → 記憶 | JSON 来訪・反応・その結果の記録（`data/log/日付.jsonl` に追記） |

- `/ritsu/chat_user` に応答するのは、URL に `?kiosk=1` を付けて開いた画面（キオスク表示）だけです。PC などで `index.html` を開いて確認しても、二重に返事をしません。
- ROS 2 のコマンドで試す例: `docker exec -it ritsu-camera bash -c "source /opt/ros/jazzy/setup.bash && ros2 topic echo /ritsu/person"`
- 別のマシン（台車の Jetson など）の ROS 2 からも、同じネットワーク・同じ `ROS_DOMAIN_ID`（既定 0）ならトピックが見えます。

## 声（マイク・スピーカー）

```
Anker PowerConf ─USB─ UNO Q  Chromium(律) ─ /stt/ ─▶ CT200 ritsu-stt  :8100  (Whisper large-v3-turbo, GPU)
                                         └ /tts/ ─▶ CT200 ritsu-tts  :50021 (VOICEVOX ENGINE, GPU)
```

1. **CT200 に声のサーバーを入れる**（Proxmox 本体で。ディスクの空き約10GB、CT200 のメモリを 7〜8GB に増やしてから）
   ```bash
   pct set 200 -memory 8192
   pct push 200 voice-server/setup-ct200.sh /root/setup-ct200.sh
   pct push 200 voice-server/stt_server.py  /root/stt_server.py
   pct exec 200 -- bash /root/setup-ct200.sh
   ```
   VOICEVOX のダウンロード（約2.8GB）と Whisper のモデル（約1.6GB）で、初回は時間がかかります。状態は `pct exec 200 -- journalctl -u ritsu-stt -u ritsu-tts -f`。
2. **UNO Q**: `git pull` → `docker compose up -d --force-recreate renderer`（nginx に /stt/ /tts/ の中継が増えるため）。中継先は既定で CT200（`.env` の `STT_URL` / `TTS_URL` で変えられる）
3. **UNO Q の既定のマイク・スピーカーを PowerConf にする**
   ```bash
   pactl list short sinks; pactl list short sources          # PowerConf の名前を確認
   pactl set-default-sink   <alsa_output.usb-...PowerConf...>
   pactl set-default-source <alsa_input.usb-...PowerConf...>
   ```
   そのあとキオスクを起動し直す（`kiosk/ritsu-kiosk.sh` はタップなしで音を出し、マイクの許可を自動で出すオプション付き）
4. 画面左上に **MIC** ランプが出る: 緑=聞いている / 黄=声を聞き取り中・文字にしている / 灰=マイクが使えない

- 設定は `config.js` の `voice`（声の種類・速さ・音量、人が映っている間だけ聞くか、誰もいないときの独り言も声に出すか）。`voice: null` で声を使わない
- 声で話すのは kiosk 画面だけ。PC で試すときは `http://localhost:8080/?voice=1&needperson=0`（マイクは `localhost` か https でしか使えないので、PC で動かした律の画面で試す）
- 聞き取った言葉は入力ページの履歴に「声で」と出る
- PowerConf はバッテリー入りなので、つなぎっぱなしで長く使うと電池が傷みやすい

## 記憶・ニュース（memory ノード）

- 環境変数: `LEARN_DAYS`（反応の結果を集計する日数、既定 30）、`NEWS_FEEDS`（Yahoo!ニュース・トピックスの種類をカンマ区切り。既定 `top-picks,entertainment,sports,science,it`。ほかに `domestic` `world` `business` `local`。空にするとニュースを取らない）
- 除く見出しの言葉は `ros/ritsu_memory.py` の `NEWS_BLOCK`。取れた見出しは `docker logs ritsu-memory` に出る
- Yahoo!ニュースの RSS は個人での利用を想定したもの。お店などで使うときは利用規約を確認してください

## 6. 深度カメラ（Orbbec Gemini 335）

`perception` サービス（`ros/ritsu_perception.py`）が人検出です。カラー映像から OpenCV の YuNet で顔を検出し、深度から3次元の位置を求めて `/ritsu/person` に送ります。IMU（加速度）からカメラの傾きも求めます。

```bash
docker compose up -d --build              # 律の画面・rosbridge・人検出をまとめて起動
docker logs -f ritsu-camera               # 検出状況が5秒ごとに出る
```

- 環境変数: `CAMERA_ROTATE`（カメラを縦置きしたとき 90/180/270）、`PERCEPTION_FPS`（1秒あたりの検出回数、既定 8）、`IMU_ROLL_SIGN`（傾けた向きと律がよろける向き。Gemini 335 実機に合わせて既定は -1）、`LOOK_YAW`（こちらを見ているとみなす顔の向き、既定 0.2 ≒ 20度。挨拶されにくければ大きく）、`TOUCH_DIST`（手を合わせる距離、既定 0.45m）、`MASTER_MATCH`（登録した顔とみなす類似度、既定 0.40。別の人をマスターと呼ぶなら上げる、本人なのに呼ばれなければ下げる）、`DEBUG_SNAPSHOT`（1 で確認用画像を `:8080/debug/camera.jpg` に出す。LAN 内の誰でも見えるので確認後は外す）
- カメラから10秒映像が来なければ、自動で開き直します。
- マスターの顔は、`http://192.168.3.80:8080/remote` の「マスター登録」→ カメラの正面で「登録」を押して約4秒じっとする、で登録します。眼鏡の有無・明るさ・少し違う向きで何回か登録すると見分けやすくなります（最大60枚分）。見分けは70px以上の大きさの、ほぼ正面の顔だけで、1秒に1回行います。ログの `id=master(0.62)` が見分けた結果と類似度です。入力ページは LAN 内の誰でも開けるので、登録ボタンも誰でも押せます。
- 開発PC（WSL）で使うときは、Windows 側で usbipd-win を使ってカメラを WSL に渡します（`usbipd bind --busid <BUSID>` → `usbipd attach --wsl --busid <BUSID>`）。

## デバッグ

ブラウザのコンソールから次のように操作できます。

```js
RITSU.play('wave')          // モーション再生
RITSU.list()                // モーション一覧
RITSU.brain.chat('こんにちは') // 会話テスト
RITSU.ctx.describe()        // LLM に渡している「今の状況」
RITSU.person(1.2)           // カメラ無しで人が来たことにする(距離[m])。8秒呼ばないと帰った扱い
RITSU.look(true)            // 目が合ったことにする
RITSU.hand(0.3, 0.4)        // 画面のすぐ前に手が来たことにする(x/z, y/z。0.3秒以上続けて呼ぶ)
RITSU.master(true)          // 目の前の人をマスターということにする
RITSU.enroll()              // マスターの顔を登録する(RITSU.enroll('clear') で消す)
RITSU.memory()              // 覚えていることと反応の結果
RITSU.act('glassTouchR')    // モーションをカメラワーク付きで再生
```
