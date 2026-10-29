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
  const CAMERA_MOTIONS = ['peek'];
  const MOTION_END_MOTIONS = ['noticeL', 'noticeR', 'ottotoL', 'ottotoR'];
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
  function showSubtitle(text) {
    subtitle.textContent = text;
    subtitle.classList.add('show');
    clearTimeout(subTimer);
    subTimer = setTimeout(() => subtitle.classList.remove('show'),
                          Math.max(3500, text.length * 220));
    talkLeft = text.length * 0.12;
  }

  /* ===== カメラワーク =====
   *  全身(既定) → 会話中は胸から上へ寄る → その上に「振り向き」の振れと「のぞき込み」の寄りを重ねる */
  const camHome = camera.position.clone();
  const lookHome = new THREE.Vector3(0, 1.05, 0);
  const TALK_HOLD = 20;       // 最後の会話からこの秒数は寄ったまま
  const PEEK_IN = 0.9, PEEK_HOLD = 2.6, PEEK_OUT = 1.1;
  const PAN_DUR = 3.8;        // motions.js の noticeL/R と同じ長さ
  const headRest = new THREE.Vector3(0, 1.45, 0);   // 立ち姿の頭の位置(会話の寄り先の基準)
  let headRestReady = false;
  let talkK = 0;              // 0:全身 .. 1:会話の寄り
  let peekT = -1;             // -1: のぞき込み中でない
  let panT = -1, panDir = 0;  // 振り向き中のカメラの振れ
  const v = { basePos: new THREE.Vector3(), baseLook: new THREE.Vector3(),
              talkPos: new THREE.Vector3(), talkLook: new THREE.Vector3(),
              head: new THREE.Vector3(), near: new THREE.Vector3(), look: new THREE.Vector3() };
  const headPos = out => mochiko.headWorldPosition ? mochiko.headWorldPosition(out) : out.set(0, 1.45, 0);
  const envelope = (t, tin, thold, tout) =>
    t < tin ? ease(t / tin) : t < tin + thold ? 1 : t < tin + thold + tout ? 1 - ease((t - tin - thold) / tout) : -1;

  function startPeek() { if (peekT < 0) peekT = 0; }
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
    headPos(v.head).y += 0.03;
    v.near.set(v.head.x, v.head.y, v.head.z + 0.55);
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

  /* ===== 会話 & 暇つぶし ===== */
  const lampLlm = document.getElementById('lamp-llm');
  const ctx = new RitsuContext();   // 日時・季節・カメラ前の人など、会話に使う今の状況
  const brain = new RitsuBrain({
    ctx,
    act({ text, motion, emotion, source }) {
      if (emotion) setEmotionFor(emotion, motion, text);
      if (motion) player.play(motion);
      if (motion === 'peek') startPeek();
      if (motion === 'noticeL' || motion === 'noticeR') startPan(motion === 'noticeR' ? 1 : -1);
      if (text) {
        showSubtitle(text);
        if (RITSU_CFG.kiosk) pubJson('/ritsu/say', { text, emotion, motion, source });
      }
    },
    onStatus: ok => lampLlm.classList.toggle('on', ok),
    onThinking: on => { if (RITSU_CFG.kiosk) pubBool('/ritsu/thinking', on); },
  });
  brain.ping();
  brain.startIdle();

  if (ros) {
    if (RITSU_CFG.kiosk) {
      ros.sub('/ritsu/chat_user', 'std_msgs/String', m => {
        let msg;
        try { msg = JSON.parse(m.data); } catch { msg = { text: m.data }; }   // 素の文字列でも受け付ける
        if (typeof msg.text === 'string') brain.chat(msg.text.slice(0, 200));
      });
    }
    ros.sub('/ritsu/tilt', 'geometry_msgs/Vector3', m => onTilt(m.x));
    ros.sub('/ritsu/camera_alive', 'std_msgs/Bool', () => { camSeenAt = performance.now(); });
    ros.sub('/ritsu/person', 'geometry_msgs/PointStamped', m => {
      camSeenAt = personSeenAt = performance.now();
      if (m.point.z > 0) ctx.onPerson(m.point.z);
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

  const input = document.getElementById('chat-input');
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
    mochiko.p.mouthOpen += (visemeA - mochiko.p.mouthOpen) * Math.min(1, dt * 14);
    visemeA *= 1 - Math.min(1, dt * 3);

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
    person: (z = 1.2) => ctx.onPerson(z),
  };
})();
