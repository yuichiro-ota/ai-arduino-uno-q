/* =========================================================================
 * main.js — シーン構築 / 会話UI / 字幕 / 口パク / ROS 2連携 / 視線追従
 *   会話・暇つぶし行動は brain.js (RitsuBrain) が担当し、act() 経由で反映する。
 *
 * ROS 2 (nginx の /rosbridge 経由で rosbridge に接続、ros.js)
 *   購読 /ritsu/chat_user      std_msgs/String  JSON {"text":"...","from":"..."}  入力ページ・画面のキーボード (kioskのみ応答)
 *   購読 /ritsu/person         geometry_msgs/PointStamped  顔の位置 [m] 光学座標系(x:右 / y:下 / z:前) (視線追従)
 *   購読 /ritsu/person_present std_msgs/Bool
 *   購読 /ritsu/camera_alive   std_msgs/Bool    人検出の生存通知(2秒ごと。CAMERAランプ)
 *   購読 /ritsu/tilt           geometry_msgs/Vector3  カメラの傾き[度] x=roll。左右に大きく傾くと「おっとっと」
 *   購読 /ritsu/looking        std_msgs/Bool    顔がこちらを向いているか (挨拶は目が合った人にだけ)
 *   購読 /ritsu/hand_near      geometry_msgs/PointStamped  画面のすぐ前の手 (内側から、手のある位置へ手を合わせる)
 *   購読 /ritsu/person_id      std_msgs/String  JSON {"id":"master"|""} 顔で見分けた相手 (マスターと呼ぶ)
 *   購読 /ritsu/memory         std_msgs/String  JSON 保存された記憶と反応の結果 (ritsu_memory.py)
 *   発行 /ritsu/memory_put     std_msgs/String  JSON {"key","value"} 覚えたことを保存 (kioskのみ)
 *   発行 /ritsu/log            std_msgs/String  JSON 来訪・反応・その結果の記録 (kioskのみ)
 *   発行 /ritsu/turn           std_msgs/String  JSON {"reason","sec"} 台車ごと相手の方を向いてと頼む (kioskのみ)
 *   発行 /ritsu/move           std_msgs/String  JSON {"action":"back/forward/left/right/stop"} 台車で少し動く (kioskのみ)
 *   購読 /ritsu/base_event     std_msgs/String  JSON 台車からの知らせ(障害物で止まった など) (kioskのみ)
 *   発行 /ritsu/enroll         std_msgs/String  JSON {"action":"add"|"clear"} マスターの顔の登録 (RITSU.enroll())
 *   声: voice.js が /stt (Whisper) で聞き取り、/tts (VOICEVOX) で読み上げる(kiosk 画面のみ)。聞き取った言葉は
 *       /ritsu/chat_user に from:"voice" で流す
 *   発行 /ritsu/say            std_msgs/String  JSON {"text":"...","emotion":"happy","motion":"wave","source":"llm|fallback|idle|idle-llm"}
 *   発行 /ritsu/thinking       std_msgs/Bool    返事を考え中
 * =========================================================================
 * ========================================================================= */

(async () => {
  /* ===== Three.js シーン ===== */
  const stage = document.getElementById('stage');
  const renderer3d = new THREE.WebGLRenderer({
    antialias: RITSU_CFG.antialias,
    powerPreference: 'high-performance',
  });
  renderer3d.setPixelRatio(Math.min(window.devicePixelRatio, RITSU_CFG.pixelRatio));
  renderer3d.setSize(innerWidth, innerHeight);
  stage.appendChild(renderer3d.domElement);

  const scene = new THREE.Scene();

  // 桜色→クリームの縦グラデーション背景(縦長ディスプレイ映え)
  {
    const c = document.createElement('canvas');
    c.width = 2; c.height = 512;
    const g = c.getContext('2d');
    const grad = g.createLinearGradient(0, 0, 0, 512);
    grad.addColorStop(0, '#ffe3ea');
    grad.addColorStop(0.55, '#fff6ec');
    grad.addColorStop(1, '#d9f3ea');
    g.fillStyle = grad; g.fillRect(0, 0, 2, 512);
    scene.background = new THREE.CanvasTexture(c);
  }

  // 縦長(9:16想定)で全身が入るカメラ
  const camera = new THREE.PerspectiveCamera(38, innerWidth / innerHeight, 0.1, 50);
  camera.position.set(0, 1.25, 3.1);
  camera.lookAt(0, 1.05, 0);

  scene.add(new THREE.AmbientLight(0xffffff, 0.85));
  const key = new THREE.DirectionalLight(0xfff0e8, 1.1);
  key.position.set(1.5, 3, 2.5);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0xbdeee2, 0.5);
  rim.position.set(-2, 2, -2);
  scene.add(rim);

  // ふわふわ漂う桜の花びらパーティクル
  const petals = [];
  {
    const geo = new THREE.CircleGeometry(0.02, 6);
    const mat = new THREE.MeshBasicMaterial({ color: 0xffb7c5, transparent: true, opacity: 0.7, side: THREE.DoubleSide });
    for (let i = 0; i < RITSU_CFG.petals; i++) {
      const m = new THREE.Mesh(geo, mat);
      m.position.set((Math.random() - 0.5) * 3, Math.random() * 3, (Math.random() - 0.5) * 1.5 - 0.3);
      m.userData = { v: 0.1 + Math.random() * 0.25, w: Math.random() * 2, ph: Math.random() * 6.28 };
      petals.push(m); scene.add(m);
    }
  }

  // 足元の円形ステージ
  const disk = new THREE.Mesh(
    new THREE.CylinderGeometry(0.85, 0.9, 0.05, 40),
    new THREE.MeshToonMaterial({ color: 0xffd9e2 }));
  disk.position.y = -0.03;
  scene.add(disk);

  /* ===== キャラクター & モーション =====
     models/avatar.vrm があればVRM、無ければ内蔵モデル(もちこ)を使用 */
  const mochiko = await createAvatar(scene);
  const player = new MotionPlayer(mochiko);
  const DEFAULT_EMOTION = 'happy';
  mochiko.setEmotion(DEFAULT_EMOTION);
  // 表情はモーションと字幕が終わったらいつもの表情に戻す(驚いた顔のまま残らないように)
  // のぞき込みはカメラが戻った時点(stepCamera から resetEmotionAfterCamera を呼ぶ)、
  // 振り向きはモーション(首の戻り)が終わった時点で戻す
  const CAMERA_MOTIONS = ['peek', 'glassTouchL', 'glassTouchR'];
  const MOTION_END_MOTIONS = ['noticeL', 'noticeR', 'ottotoL', 'ottotoR', 'seeOffL', 'seeOffR', 'lookUp'];
  let emotionTimer = null;
  let emotionUntilCamera = false;
  function resetEmotionAfterCamera() {
    if (!emotionUntilCamera) return;
    emotionUntilCamera = false;
    mochiko.setEmotion(DEFAULT_EMOTION);
  }
  function setEmotionFor(emotion, motion, text) {
    mochiko.setEmotion(emotion);
    clearTimeout(emotionTimer);
    emotionUntilCamera = false;
    if (emotion === DEFAULT_EMOTION) return;
    if (CAMERA_MOTIONS.includes(motion)) { emotionUntilCamera = true; return; }
    if (MOTION_END_MOTIONS.includes(motion)) {
      emotionTimer = setTimeout(() => mochiko.setEmotion(DEFAULT_EMOTION), MOTIONS[motion].dur * 1000);
      return;
    }
    const motionSec = (MOTIONS[motion] && MOTIONS[motion].dur) || 0;
    const textSec = text ? Math.max(3.5, text.length * 0.22) : 0;
    emotionTimer = setTimeout(() => mochiko.setEmotion(DEFAULT_EMOTION),
                              Math.max(2.5, motionSec, textSec) * 1000);
  }

  /* ===== 字幕 + 口パク =====
     音声は無いので、字幕表示中は文字数ぶん口をパクパクさせる */
  const subtitle = document.getElementById('subtitle');
  let subTimer = null;
  let talkLeft = 0;           // 口パク残り時間[秒]
  let visemeA = 0;
  /** flap: 字幕の文字数ぶん口をパクパクさせる(声で読み上げるときは音量で口を動かすので false) */
  function showSubtitle(text, flap = true) {
    stopThinking();
    subtitle.textContent = text;
    subtitle.classList.add('show');
    clearTimeout(subTimer);
    subTimer = setTimeout(() => subtitle.classList.remove('show'),
                          Math.max(3500, text.length * 220));
    talkLeft = flap ? text.length * 0.12 : 0;
  }

  /* ===== 考え中の「・・・」 =====
   * LLM に問い合わせている間は吹き出しに「・・・」を出す。話しかけへの返事はすぐ、
   * 独り言や反応は THINK_DELAY 秒たっても答えが無いときだけ(すぐ返るときにちらつかないように)。
   * 別のセリフを表示している間は、独り言や反応の「・・・」でそれを消さない */
  const THINK_DELAY = 0.4;
  let thinkTimer = null;
  const showingLine = () => subtitle.classList.contains('show') && !subtitle.classList.contains('thinking');
  function startThinking() {
    clearTimeout(thinkTimer);
    thinkTimer = null;
    if (subtitle.classList.contains('thinking')) return;
    clearTimeout(subTimer);
    subtitle.innerHTML = '<span>・</span><span>・</span><span>・</span>';
    subtitle.classList.add('show', 'thinking');
  }
  function stopThinking() {
    clearTimeout(thinkTimer);
    thinkTimer = null;
    subtitle.classList.remove('thinking');
  }
  function endThinking() {        // 返事が来ないまま終わった(何もしない・失敗)ときは吹き出しを閉じる
    if (subtitle.classList.contains('thinking')) subtitle.classList.remove('show');
    stopThinking();
  }
  function onQuery(n) {
    if (n > 0) {
      if (!thinkTimer && !showingLine() && !subtitle.classList.contains('thinking'))
        thinkTimer = setTimeout(() => { if (brain.queries > 0 && !showingLine()) startThinking(); }, THINK_DELAY * 1000);
    } else if (!brain.busy) {
      endThinking();
    }
  }

  /* ===== カメラワーク =====
   *  全身(既定) → 会話中は胸から上へ寄る → その上に「振り向き」の振れと「のぞき込み」の寄りを重ねる */
  const camHome = camera.position.clone();
  const lookHome = new THREE.Vector3(0, 1.05, 0);
  const TALK_HOLD = 20;       // 最後の会話からこの秒数は寄ったまま
  const PEEK_IN = 0.9, PEEK_HOLD = 2.6, PEEK_OUT = 1.1;
  const PEEK_FACE_LIFT = 0.14;   // 寄ったとき顔を画面の上側へずらす量(距離に対する割合)
  const PAN_DUR = 3.8;        // motions.js の noticeL/R と同じ長さ
  const headRest = new THREE.Vector3(0, 1.45, 0);   // 立ち姿の頭の位置(会話の寄り先の基準)
  let headRestReady = false;
  let talkK = 0;              // 0:全身 .. 1:会話の寄り
  let peekT = -1;             // -1: のぞき込み中でない
  let peekDist = 0.55;        // のぞき込みで寄る距離 [m] (手を合わせるときは手も入るよう少し引く)
  let peekSide = 0;           // 寄る先を左右へずらす [m] (手を合わせるときは手の側へ)
  let panT = -1, panDir = 0;  // 振り向き中のカメラの振れ
  const v = { basePos: new THREE.Vector3(), baseLook: new THREE.Vector3(),
              talkPos: new THREE.Vector3(), talkLook: new THREE.Vector3(),
              head: new THREE.Vector3(), near: new THREE.Vector3(), look: new THREE.Vector3() };
  const headPos = out => mochiko.headWorldPosition ? mochiko.headWorldPosition(out) : out.set(0, 1.45, 0);
  const envelope = (t, tin, thold, tout) =>
    t < tin ? ease(t / tin) : t < tin + thold ? 1 : t < tin + thold + tout ? 1 - ease((t - tin - thold) / tout) : -1;

  function startPeek(dist = 0.55, side = 0) { if (peekT < 0) { peekT = 0; peekDist = dist; peekSide = side; } }
  function startPan(dir) { panT = 0; panDir = dir; }

  function stepCamera(dt, now) {
    if (!headRestReady) { headPos(headRest); headRestReady = true; }

    // ① 会話中は胸から上へ寄る
    const talking = brain.busy || (now - brain.lastChat) / 1000 < TALK_HOLD;
    talkK += ((talking ? 1 : 0) - talkK) * Math.min(1, dt * 1.2);
    v.talkPos.set(headRest.x, headRest.y - 0.1, headRest.z + 1.3);
    v.talkLook.set(headRest.x, headRest.y - 0.2, headRest.z);    // 頭を画面のやや上へ(下の吹き出しと重ならないように)
    v.basePos.lerpVectors(camHome, v.talkPos, talkK);
    v.baseLook.lerpVectors(lookHome, v.talkLook, talkK);

    // ② 物音に振り向く: 律の向く側へカメラも少し振れる
    if (panT >= 0) {
      panT += dt;
      const k = envelope(panT, PAN_DUR * 0.3, PAN_DUR * 0.32, PAN_DUR * 0.25);
      if (k < 0) panT = -1;
      else { v.baseLook.x += panDir * 0.18 * k; v.basePos.x += panDir * 0.04 * k; }
    }

    // のぞき込み: 前かがみで動く頭を毎フレーム追い、目元の正面 0.55m まで寄る
    let pk = 0;
    if (peekT >= 0) {
      peekT += dt;
      pk = envelope(peekT, PEEK_IN, PEEK_HOLD, PEEK_OUT);
      if (pk < 0) { peekT = -1; pk = 0; resetEmotionAfterCamera(); }
    }
    // 寄った画面でも顔が下の吹き出しに隠れないよう、カメラを平行に下げて顔を画面の上から約3割の位置に置く
    // (画角38度: 下げる量 = 距離 × 0.14 で、顔の中心が画面中央から上へ半分の高さの約4割)
    headPos(v.head).y += 0.03 - peekDist * PEEK_FACE_LIFT;
    v.head.x += peekSide;
    v.near.set(v.head.x, v.head.y, v.head.z + peekDist);
    camera.position.lerpVectors(v.basePos, v.near, pk);
    camera.lookAt(v.look.lerpVectors(v.baseLook, v.head, pk));
    mochiko.lookOverride = pk > 0.2 ? camera.position : null;
  }

  /* ===== ROS 2 (rosbridge) ===== */
  const lampRos = document.getElementById('lamp-ros');
  const ros = window.ROSLIB ? new RitsuRos(null, ok => lampRos.classList.toggle('on', ok)) : null;
  const pubJson = (name, obj) => ros && ros.pub(name, 'std_msgs/String', { data: JSON.stringify(obj) });
  const pubBool = (name, value) => ros && ros.pub(name, 'std_msgs/Bool', { data: value });
  // 会話を ROS 2 で受け渡すのは kiosk 画面だけ。それ以外(デバッグ表示など)はその場で完結させる
  const chatOverRos = () => RITSU_CFG.kiosk && ros && ros.connected;

  let gaze = null;            // {x,y} -1..1
  let gazeTimeout = 0;

  // おっとっと: カメラが左右に TILT_ON 度以上傾いたら、傾いた側へよろける。
  // TILT_OFF 度未満に戻るまでは再発動しない(傾けっぱなしで連発しないように)
  const TILT_ON = 15, TILT_OFF = 8, TILT_COOLDOWN = 3000;
  const OTTOTO_LINES = ['おっとっと……!', 'わわっ、傾いてますよ……!', 'きゃっ……!', null, null];
  let tiltArmed = true, lastOttoto = -Infinity;
  function onTilt(roll) {
    const now = performance.now();
    if (Math.abs(roll) < TILT_OFF) tiltArmed = true;
    if (!tiltArmed || Math.abs(roll) < TILT_ON || now - lastOttoto < TILT_COOLDOWN || brain.busy) return;
    tiltArmed = false;
    lastOttoto = now;
    brain.act({ motion: roll > 0 ? 'ottotoR' : 'ottotoL', emotion: 'surprised',
                text: OTTOTO_LINES[Math.floor(Math.random() * OTTOTO_LINES.length)], source: 'idle' });
  }

  // CAMERAランプ: 緑=人を検出中 / 黄=カメラは動いているが人はいない / 灰=人検出からの通知なし
  const lampCam = document.getElementById('lamp-cam');
  let camSeenAt = -Infinity, personSeenAt = -Infinity;
  setInterval(() => {
    const now = performance.now();
    const alive = now - camSeenAt < 5000;
    const person = now - personSeenAt < 1500;
    lampCam.classList.toggle('on', alive && person);
    lampCam.classList.toggle('idle', alive && !person);
  }, 500);

  /* ===== 相手に合わせた姿勢 =====
   * 目は視線追従で、首は vrm_avatar.js が目に合わせて相手を追う。その下で体も少し相手へ向け、
   * すぐ目の前の人には少しのけぞり、離れたところからこちらを見ている人には少し身を乗り出す。
   * 基準ポーズを動かすので、モーションはその上に重なる */
  const ATTEND_YAW = 0.12;      // 相手の左右(視線と同じ -1..1)に対する体の向き [rad]
  const ATTEND_BACK = 0.05;     // 近い人に、のけぞる量 [rad]
  const ATTEND_LEAN = -0.06;    // 遠くでこちらを見ている人に、身を乗り出す量 [rad]
  function stepAttention(dt) {
    const base = mochiko._base;
    let yaw = 0, pitch = 0;
    if (ctx.personPresent) {
      yaw = THREE.MathUtils.clamp(-ctx.personXn * 2.2, -1, 1) * ATTEND_YAW;   // 視線追従と同じ向き(カメラの右 = 画面の左)
      const d = ctx.personDistance;
      pitch = d === 'near' ? ATTEND_BACK : d === 'far' && ctx.looking ? ATTEND_LEAN : 0;
    }
    const k = Math.min(1, dt * 1.5);
    base.bodyYaw += (yaw - base.bodyYaw) * k;
    base.bodyPitch += (pitch - base.bodyPitch) * k;
  }

  /* ===== 手を合わせる位置 =====
   * 画面のすぐ前の手の位置(カメラから見た向き x/z, y/z)に合わせて、腕を上げる高さと開き具合、カメラの寄り先を変える */
  const TOUCH_Y0 = 0.4;         // この高さ(y/z、下が+)の手には、モーションそのままの高さで手を合わせる
  function touchAdjust(motion, hand) {
    if (!hand) return { adjust: null, side: motion === 'glassTouchR' ? 0.12 : -0.12 };
    const clamp = THREE.MathUtils.clamp;
    const up = clamp((TOUCH_Y0 - hand.yn) * 0.8, -0.4, 0.25);             // 高い手ほど腕を上げる
    const out = clamp((Math.abs(hand.xn) - 0.3) * 0.8, -0.2, 0.3);       // 端の手ほど腕を開く
    const sign = motion === 'glassTouchR' ? 1 : -1;
    const adjust = sign > 0 ? { shoulderLx: up, shoulderLz: out } : { shoulderRx: up, shoulderRz: -out };
    return { adjust, side: sign * (0.06 + clamp(Math.abs(hand.xn), 0, 0.6) * 0.15) };
  }

  /* ===== 会話 & 暇つぶし ===== */
  const lampLlm = document.getElementById('lamp-llm');
  const ctx = new RitsuContext({ weather: RITSU_CFG.weather });   // 日時・季節・天気・カメラ前の人など、会話に使う今の状況
  let voice = null;              // 声 (下で作る。act から使う)
  const brain = new RitsuBrain({
    ctx,
    // 記憶と反応の記録は kiosk 画面だけが memory ノードへ送る(デバッグで開いた画面が書き換えないように)
    persist: RITSU_CFG.kiosk && ros ? { put: (key, value) => pubJson('/ritsu/memory_put', { key, value }),
                                        log: obj => pubJson('/ritsu/log', obj) } : null,
    act({ text, motion, emotion, source, hand }) {
      if (emotion) setEmotionFor(emotion, motion, text);
      const touch = motion === 'glassTouchL' || motion === 'glassTouchR' ? touchAdjust(motion, hand) : null;
      if (motion) player.play(motion, touch && touch.adjust);
      if (motion === 'peek') startPeek(0.62);
      if (touch) startPeek(1.15, touch.side);
      if (motion === 'noticeL' || motion === 'noticeR') startPan(motion === 'noticeR' ? 1 : -1);
      if (motion === 'seeOffL' || motion === 'seeOffR') startPan(motion === 'seeOffR' ? 1 : -1);
      if (text) {
        // 声で読み上げる: 会話・反応はいつも、独り言は idleAloud か人がいるとき
        const aloud = voice && voice.ttsOk &&
                      (!String(source).startsWith('idle') || ctx.personPresent || RITSU_CFG.voice.idleAloud);
        showSubtitle(text, !aloud);
        if (aloud) voice.speak(text).then(ok => { if (!ok && subtitle.textContent === text) talkLeft = text.length * 0.12; });
        if (RITSU_CFG.kiosk) pubJson('/ritsu/say', { text, emotion, motion, source });
      }
    },
    // LLMランプ: 緑=返事が来ている / 黄=返事が遅い(独り言・反応は用意したセリフにしている) / 灰=つながらない・失敗
    onStatus: st => { lampLlm.classList.toggle('on', st === true); lampLlm.classList.toggle('idle', st === 'slow'); },
    // 話しかけられた: しゃべっている独り言を止める(返事を最優先にする)
    onInterrupt: () => {
      if (voice && !voice.fillerPlaying) voice.interrupt();   // 「うんうん」などの相槌は最後まで言う
      talkLeft = 0;
    },
    onThinking: on => {
      if (on) startThinking(); else endThinking();
      if (RITSU_CFG.kiosk) pubBool('/ritsu/thinking', on);
    },
    // 台車ごと相手の方を向く(台車のノード ritsu_base が顔を見ながら回る。kiosk のみ)
    onTurn: ({ reason, search }) => { if (RITSU_CFG.kiosk) pubJson('/ritsu/turn', { reason, sec: search ? 12 : 8, search: !!search }); },
    // 「後ろに下がって」「前に来て」「左向いて」「右向いて」で台車が少し動く(kiosk のみ)
    onMove: action => { if (RITSU_CFG.kiosk) pubJson('/ritsu/move', { action }); },
    onQuery,
  });
  brain.ping();
  brain.startIdle();

  /* ===== 話す / 静かにする =====
   * スピーカーの絵: 緑で音が出ている=話す / 灰色に×=黙る(残りの時間も出す。最後の1分は秒で)。押すと切り替え */
  const talkMode = document.getElementById('talk-mode');
  const talkModeText = document.getElementById('talk-mode-text');
  const updateTalkMode = () => {
    const quiet = brain.quiet;
    const left = Math.ceil((brain.quietUntil - performance.now()) / 1000);
    talkMode.classList.toggle('quiet', quiet);
    talkModeText.textContent = !quiet ? '話す' : `黙る（残り${left > 60 ? `${Math.ceil(left / 60)}分` : `${left}秒`}）`;
  };
  talkMode.addEventListener('click', () => {
    if (brain.quiet) brain.setQuiet(0);
    else brain.setQuiet();
    updateTalkMode();
  });
  setInterval(updateTalkMode, 1000);

  /* ===== 声 (voice.js) =====
   * MICランプ: 緑=聞いている / 薄い緑=今は聞いていない(人が映っていない・律が話している・返事を考え中) /
   *           黄=声を聞き取り中・文字にしている / 灰=マイクが使えない */
  const lampMic = document.getElementById('lamp-mic');
  const AIZUCHI_MIN_SEC = 1.0;   // これより短い言葉(「はい」など)には相槌を打たない
  const THINK_FILLER_SEC = 1.5;  // 聞き取ってからこの秒数たっても返事が無ければ「えっと……」
  const LISTEN_NOD_SEC = 2.2;    // 話を聞いている間のうなずきの間隔
  let listenNod = null;
  voice = RITSU_CFG.voiceOn ? new RitsuVoice(RITSU_CFG.voice, {
    // 返事を考えている間と、(needPerson のとき)カメラに誰も映っていない間は聞かない(周りの話し声に答えないように)
    canListen: () => !brain.busy && (!RITSU_CFG.voice.needPerson || ctx.personPresent),
    onText: text => {
      if (chatOverRos()) pubJson('/ritsu/chat_user', { text, from: 'voice' });
      else brain.chat(text, { from: 'voice' });
      setTimeout(() => { if (brain.busy && voice.filler('think')) player.play('thinking'); }, THINK_FILLER_SEC * 1000);
    },
    onRecognizing: on => { if (on) startThinking(); else if (!brain.busy) endThinking(); },
    // 相槌: 話し終わった直後に「うんうん」などとうなずく(短すぎる声・確率 aizuchi で間引く)
    // 割り込み: 律の声を止めて、聞く姿勢に
    onBargeIn: () => {
      talkLeft = 0;
      subtitle.classList.remove('show');
      player.play('listening');
    },
    onSpeechEnd: sec => {
      if (sec < AIZUCHI_MIN_SEC || Math.random() >= (RITSU_CFG.voice.aizuchi ?? 0.7)) return;
      if (voice.filler('ack')) player.play('nod');
    },
    onState: st => {
      lampMic.classList.toggle('on', st === 'ready' || st === 'paused');
      lampMic.classList.toggle('paused', st === 'paused');
      lampMic.classList.toggle('idle', st === 'hearing' || st === 'recognizing');
      // 相手が話している間は、聞く姿勢になって小さくうなずく(声は出さない。相手の声と重なるため)
      clearInterval(listenNod);
      if (st === 'hearing') {
        player.play('listening');
        listenNod = setInterval(() => player.play('nodSmall'), LISTEN_NOD_SEC * 1000);
      }
    },
  }) : null;
  if (voice) {
    document.getElementById('lamp-mic-wrap').classList.remove('hidden');
    document.getElementById('credit').textContent = `VOICEVOX:${voice.cfg.speaker}`;
    voice.init();
    // マイクの様子を ROS 2 へ(kiosk のみ)。/remote の「マイク」で見られる(kiosk 画面で F12 を開かなくてよいように)
    if (RITSU_CFG.kiosk && ros) setInterval(() => {
      const m = voice.mic;
      pubJson('/ritsu/voice_status', { capture: m.capture, device: m.device, audio: voice.ctx ? voice.ctx.state : '',
        frames: m.frames, level: +m.level.toFixed(3), peak: +m.peak.toFixed(3), threshold: +m.threshold.toFixed(3),
        listening: m.listening, why: m.why, barge: +m.bargeThreshold.toFixed(3), echo: +m.echo.toFixed(3), tts: voice.ttsOk, heard: m.heard, ignored: m.ignored, error: m.error });
      m.peak = 0;
      m.echo = 0;
    }, 1000);
  }

  if (ros) {
    if (RITSU_CFG.kiosk) {
      ros.sub('/ritsu/chat_user', 'std_msgs/String', m => {
        let msg;
        try { msg = JSON.parse(m.data); } catch { msg = { text: m.data }; }   // 素の文字列でも受け付ける
        if (typeof msg.text === 'string') brain.chat(msg.text.slice(0, 200), { from: msg.from });
      });
    }
    ros.sub('/ritsu/tilt', 'geometry_msgs/Vector3', m => onTilt(m.x));
    ros.sub('/ritsu/camera_alive', 'std_msgs/Bool', () => { camSeenAt = performance.now(); });
    ros.sub('/ritsu/looking', 'std_msgs/Bool', m => ctx.onLooking(m.data));
    ros.sub('/ritsu/hand_near', 'geometry_msgs/PointStamped', m => {
      if (m.point.z > 0) ctx.onHand(m.point.x / m.point.z, m.point.y / m.point.z);
    });
    ros.sub('/ritsu/person_id', 'std_msgs/String', m => {
      try { ctx.onIdentity(JSON.parse(m.data).id); } catch { /* 壊れた通知は無視 */ }
    });
    ros.sub('/ritsu/memory', 'std_msgs/String', m => {
      try { brain.onMemory(JSON.parse(m.data)); } catch (e) { console.warn('[main] memory:', e); }
    });
    // /remote の「覚えたこと」から直す・消す・足す(記憶を持っている kiosk 画面だけが受ける)
    // 台車からの知らせ(頼まれて前に進もうとしたのに障害物で止まった、など)。話すのは kiosk 画面だけ
    if (RITSU_CFG.kiosk) ros.sub('/ritsu/base_event', 'std_msgs/String', m => {
      try { brain.onBaseEvent(JSON.parse(m.data)); } catch (e) { console.warn('[main] base_event:', e); }
    });
    if (RITSU_CFG.kiosk) ros.sub('/ritsu/memory_edit', 'std_msgs/String', m => {
      try { brain.editMemory(JSON.parse(m.data)); } catch (e) { console.warn('[main] memory_edit:', e); }
    });
    ros.sub('/ritsu/person', 'geometry_msgs/PointStamped', m => {
      camSeenAt = personSeenAt = performance.now();
      if (m.point.z > 0) ctx.onPerson(m.point.z, m.point.x / m.point.z);
      // 光学座標系[m](x:右 / y:下 / z:前) → 視線オフセット(-1..1)
      const { x, y } = m.point;
      const z = Math.max(0.3, m.point.z || 1.0);
      gaze = {
        x: THREE.MathUtils.clamp(-(x / z) * 2.2, -1, 1),
        y: THREE.MathUtils.clamp((y / z) * 2.0 + 0.15, -1, 1),
      };
      gazeTimeout = 1.2;   // 検出が途切れたら1.2秒で正面に戻る
    });
  }

  // 画面のチャット欄(index.html でコメントにしてある間は無い)
  const input = document.getElementById('chat-input');
  if (input) {
    const send = () => {
      const text = input.value.trim();
      if (!text) return;
      input.value = '';
      // kiosk では画面のキーボード入力も ROS 2 に流し、入力ページの履歴にも出す
      if (chatOverRos()) pubJson('/ritsu/chat_user', { text, from: 'screen' });
      else brain.chat(text);
    };
    document.getElementById('chat-send').addEventListener('click', send);
    input.addEventListener('keydown', e => { if (e.key === 'Enter') send(); });
  }

  /* ===== メインループ ===== */
  let last = performance.now();
  function loop(now) {
    requestAnimationFrame(loop);
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;

    // 視線タイムアウト
    if (gazeTimeout > 0) { gazeTimeout -= dt; if (gazeTimeout <= 0) gaze = null; }

    // 口パク(字幕の文字数ぶん開閉し、減衰しつつ反映)
    if (talkLeft > 0) {
      talkLeft -= dt;
      visemeA = 0.25 + 0.55 * Math.abs(Math.sin(now / 1000 * 11));
    }
    if (voice && voice.speaking) visemeA = Math.max(visemeA, voice.update() * 0.9);   // 読み上げの音量で口を動かす
    mochiko.p.mouthOpen += (visemeA - mochiko.p.mouthOpen) * Math.min(1, dt * 14);
    visemeA *= 1 - Math.min(1, dt * 3);

    stepAttention(dt);
    player.step(dt);
    mochiko.update(dt, gaze);
    stepCamera(dt, now);

    // 花びら
    for (const m of petals) {
      m.position.y -= m.userData.v * dt;
      m.position.x += Math.sin(now / 1000 * m.userData.w + m.userData.ph) * 0.001;
      m.rotation.z += dt * m.userData.w;
      if (m.position.y < -0.1) m.position.y = 3;
    }

    renderer3d.render(scene, camera);
  }
  requestAnimationFrame(loop);

  addEventListener('resize', () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer3d.setSize(innerWidth, innerHeight);
  });

  // デバッグ:コンソールから MOCHI.play('wave') などで再生可能
  window.RITSU = window.MOCHI = {
    play: n => player.play(n), list: () => player.list(), ch: mochiko, brain,
    peek: () => brain.act({ motion: 'peek', emotion: 'surprised' }),
    notice: (dir = 1) => brain.act({ motion: dir > 0 ? 'noticeR' : 'noticeL', emotion: 'surprised' }),
    ottoto: (dir = 1) => brain.act({ motion: dir > 0 ? 'ottotoR' : 'ottotoL', emotion: 'surprised' }),
    ctx, say: text => brain.act({ text, motion: 'talkGesture1', emotion: 'happy' }),
    // カメラ無しで人の検出を試す: RITSU.person(1.2) を1秒ごとに数回呼ぶ(止めると8秒後に「帰った」扱い)
    person: (z = 1.2, xn = 0) => ctx.onPerson(z, xn),
    look: (on = true) => ctx.onLooking(on),     // 目が合ったことにする
    hand: (xn = 0.3, yn = 0.4) => ctx.onHand(xn, yn),   // 画面のすぐ前に手が来たことにする(xn>0 はカメラから見て右=画面の左)
    master: (on = true) => ctx.onIdentity(on ? 'master' : ''),   // 目の前の人をマスターということにする
    // マスターの顔を登録する(カメラの正面で約4秒じっとする)/ 消す。結果は /ritsu/enroll_status
    enroll: (action = 'add') => pubJson('/ritsu/enroll', { action }),
    memory: () => ({ ...brain.memory, stats: brain.stats }),
    voice: () => voice,
    // マイクの音量を sec 秒ぶん表示する。話して level が threshold を超えれば声として拾える
    replay: () => voice && voice.replay(),   // 最後に聞き取った声を再生する(途切れていないか確かめる)
    micTest: (sec = 5) => {
      if (!voice) return console.log('声が使えない画面です(?voice=1 を付ける)');
      console.log('マイク:', voice.mic.device, '/ 取り込み:', voice.mic.capture);
      const t = setInterval(() => {
        const m = voice.mic;
        console.log(`level ${m.level.toFixed(3)} / threshold ${m.threshold.toFixed(3)} ${m.listening ? '聞いている' : '聞いていない(人がいない・話し中など)'}` +
                    ` ${'#'.repeat(Math.min(40, Math.round(m.level * 400)))}`);
      }, 250);
      setTimeout(() => clearInterval(t), sec * 1000);
    },
    speak: text => brain.act({ text, motion: 'talkGesture1', emotion: 'happy', source: 'llm' }),
    quiet: (sec = 300) => brain.setQuiet(sec),   // 静かにさせる(0 で取り消す)
    act: motion => brain.act({ motion }),
  };
})();
