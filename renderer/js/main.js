/* =========================================================================
 * main.js — シーン構築 / 会話UI / 字幕 / 口パク
 *   会話・暇つぶし行動は brain.js (RitsuBrain) が担当し、act() 経由で反映する。
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
  mochiko.setEmotion('happy');

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

  /* ===== 会話 & 暇つぶし ===== */
  const lampLlm = document.getElementById('lamp-llm');
  const brain = new RitsuBrain({
    act({ text, motion, emotion }) {
      if (emotion) mochiko.setEmotion(emotion);
      if (motion) player.play(motion);
      if (text) showSubtitle(text);
    },
    onStatus: ok => lampLlm.classList.toggle('on', ok),
  });
  brain.ping();
  brain.startIdle();

  const input = document.getElementById('chat-input');
  const send = () => {
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    brain.chat(text);
  };
  document.getElementById('chat-send').addEventListener('click', send);
  input.addEventListener('keydown', e => { if (e.key === 'Enter') send(); });

  /* ===== メインループ ===== */
  let last = performance.now();
  function loop(now) {
    requestAnimationFrame(loop);
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;

    // 口パク(字幕の文字数ぶん開閉し、減衰しつつ反映)
    if (talkLeft > 0) {
      talkLeft -= dt;
      visemeA = 0.25 + 0.55 * Math.abs(Math.sin(now / 1000 * 11));
    }
    mochiko.p.mouthOpen += (visemeA - mochiko.p.mouthOpen) * Math.min(1, dt * 14);
    visemeA *= 1 - Math.min(1, dt * 3);

    player.step(dt);
    mochiko.update(dt, null);

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
  window.RITSU = window.MOCHI = { play: n => player.play(n), list: () => player.list(), ch: mochiko, brain };
})();
