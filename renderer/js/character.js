/* =========================================================================
 * character.js — 「もちこ」本体
 * 外部モデル(VRM等)を一切使わず、Three.jsのプリミティブから手続き生成する
 * 世界に一つだけのオリジナル3Dキャラクター。
 *
 * リグ(可動パラメータ)は this.p に集約され、motions.js のキーフレームと
 * main.js の視線追従/リップシンクの両方から駆動される。
 * ========================================================================= */

const MochiPalette = {
  skin:      0xffe8dc,
  skinShade: 0xffcfc0,
  hair:      0xffb7c5,   // 桜色ツインテール
  hairDark:  0xf295aa,
  eyeIris:   0x7ec8b8,   // ミントグリーンの瞳
  eyePupil:  0x3f6e63,
  white:     0xffffff,
  outfit:    0xfff6ec,   // クリーム色ワンピース
  outfitTrim:0xff6f91,
  ribbon:    0xff6f91,
  blush:     0xffa3b5,
  mouth:     0xd96a7f,
  shoe:      0xff8fa8,
};

function toonMat(color) {
  // 3段階トゥーングラデーションでアニメ調の陰影にする
  const c = document.createElement('canvas');
  c.width = 4; c.height = 1;
  const g = c.getContext('2d');
  g.fillStyle = '#666'; g.fillRect(0, 0, 1, 1);
  g.fillStyle = '#aaa'; g.fillRect(1, 0, 1, 1);
  g.fillStyle = '#fff'; g.fillRect(2, 0, 2, 1);
  const tex = new THREE.CanvasTexture(c);
  tex.minFilter = tex.magFilter = THREE.NearestFilter;
  return new THREE.MeshToonMaterial({ color, gradientMap: tex });
}
function flatMat(color) { return new THREE.MeshBasicMaterial({ color }); }

class Mochiko {
  constructor(scene) {
    this.root = new THREE.Group();
    scene.add(this.root);

    // ---- 可動パラメータ(モーションの操作対象) ----
    this.p = {
      headYaw: 0, headPitch: 0, headRoll: 0,
      bodyY: 0, bodyYaw: 0, bodyLean: 0, bodyPitch: 0,
      shoulderLx: 0, shoulderLz: 0, shoulderRx: 0, shoulderRz: 0,
      elbowL: 0, elbowR: 0, forearmL: 0, forearmR: 0,
      wristL: 0, wristR: 0,
      blink: 0,               // 0=開 1=閉
      mouthOpen: 0,           // リップシンク
      mouthSmile: 0.6,        // -1=への字 1=にっこり
      browY: 0,               // -1=困り 1=上げ
      blush: 0.35,
      eyeX: 0, eyeY: 0,       // 視線オフセット(視線追従が書き込む)
      winkL: 0, winkR: 0,
    };
    this._base = { ...this.p };   // 基準ポーズ

    this._blinkTimer = 1.5 + Math.random() * 3;
    this._time = 0;

    this._build();
  }

  /* ------------------------------------------------------------------ */
  _build() {
    const P = MochiPalette;
    const skin = toonMat(P.skin), hair = toonMat(P.hair),
          hairD = toonMat(P.hairDark), outfit = toonMat(P.outfit),
          trim = toonMat(P.outfitTrim), ribbon = toonMat(P.ribbon);

    /* ===== 身体 ===== */
    this.body = new THREE.Group();
    this.root.add(this.body);

    // 胴体(ワンピース上部)
    const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.34, 0.42, 8, 20), outfit);
    torso.position.y = 1.05;
    this.body.add(torso);

    // スカート(ふんわりAライン)
    const skirt = new THREE.Mesh(new THREE.ConeGeometry(0.62, 0.62, 28, 1, true), outfit);
    skirt.position.y = 0.78;
    this.body.add(skirt);
    const skirtTrim = new THREE.Mesh(new THREE.TorusGeometry(0.60, 0.035, 10, 32), trim);
    skirtTrim.rotation.x = Math.PI / 2;
    skirtTrim.position.y = 0.49;
    this.body.add(skirtTrim);

    // 胸元リボン
    const bowKnot = new THREE.Mesh(new THREE.SphereGeometry(0.055, 12, 12), ribbon);
    bowKnot.position.set(0, 1.32, 0.31);
    this.body.add(bowKnot);
    for (const s of [-1, 1]) {
      const wing = new THREE.Mesh(new THREE.ConeGeometry(0.07, 0.16, 10), ribbon);
      wing.rotation.z = s * Math.PI / 2;
      wing.position.set(s * 0.11, 1.32, 0.30);
      this.body.add(wing);
    }

    // 脚とお靴
    for (const s of [-1, 1]) {
      const leg = new THREE.Mesh(new THREE.CapsuleGeometry(0.075, 0.34, 6, 12), skin);
      leg.position.set(s * 0.13, 0.28, 0);
      this.body.add(leg);
      const shoe = new THREE.Mesh(new THREE.SphereGeometry(0.10, 12, 12), toonMat(P.shoe));
      shoe.scale.set(1, 0.7, 1.4);
      shoe.position.set(s * 0.13, 0.06, 0.04);
      this.body.add(shoe);
    }

    /* ===== 腕(肩ピボット → 肘ピボット → 手) ===== */
    this.shoulderL = this._buildArm(skin, outfit, trim, +1);
    this.shoulderR = this._buildArm(skin, outfit, trim, -1);
    this.body.add(this.shoulderL.pivot, this.shoulderR.pivot);

    /* ===== 頭部 ===== */
    this.head = new THREE.Group();
    this.head.position.y = 1.62;
    this.body.add(this.head);

    // 顔(アニメ調に少し縦長・大きめ)
    const face = new THREE.Mesh(new THREE.SphereGeometry(0.34, 32, 32), skin);
    face.scale.set(1, 1.04, 0.95);
    face.position.y = 0.16;
    this.head.add(face);

    // 耳
    for (const s of [-1, 1]) {
      const ear = new THREE.Mesh(new THREE.SphereGeometry(0.06, 10, 10), skin);
      ear.position.set(s * 0.33, 0.14, 0);
      this.head.add(ear);
    }

    /* ---- 目(白目→虹彩グループ→瞳孔→ハイライト、まぶたで瞬き) ---- */
    this.eyes = { L: this._buildEye(+1), R: this._buildEye(-1) };
    this.head.add(this.eyes.L.group, this.eyes.R.group);

    // 眉
    this.brows = [];
    for (const s of [-1, 1]) {
      const brow = new THREE.Mesh(new THREE.CapsuleGeometry(0.012, 0.09, 4, 8), hairD);
      brow.rotation.z = Math.PI / 2 + s * 0.15;
      brow.position.set(s * 0.14, 0.33, 0.30);
      this.brows.push(brow);
      this.head.add(brow);
    }

    // ほっぺ(チーク)
    this.blushMeshes = [];
    for (const s of [-1, 1]) {
      const b = new THREE.Mesh(new THREE.CircleGeometry(0.055, 16),
        new THREE.MeshBasicMaterial({ color: P.blush, transparent: true, opacity: 0.35 }));
      b.position.set(s * 0.20, 0.08, 0.315);
      b.rotation.y = s * 0.35;
      this.blushMeshes.push(b);
      this.head.add(b);
    }

    // 口(スケールで開閉・微笑カーブ)
    this.mouth = new THREE.Mesh(new THREE.SphereGeometry(0.05, 16, 16), flatMat(P.mouth));
    this.mouth.scale.set(1, 0.25, 0.4);
    this.mouth.position.set(0, 0.045, 0.335);
    this.head.add(this.mouth);

    /* ---- 髪 ---- */
    // 後ろ髪ベース
    const backHair = new THREE.Mesh(new THREE.SphereGeometry(0.375, 32, 32), hair);
    backHair.scale.set(1, 1.08, 1);
    backHair.position.set(0, 0.20, -0.04);
    this.head.add(backHair);

    // 前髪(ぱっつん+サイド)
    for (let i = -3; i <= 3; i++) {
      const bang = new THREE.Mesh(new THREE.ConeGeometry(0.062, 0.20, 8), hair);
      bang.rotation.x = Math.PI;                     // 下向き
      const x = i * 0.095;
      bang.position.set(x, 0.36 - Math.abs(i) * 0.012, 0.30 - Math.abs(i) * 0.02);
      this.head.add(bang);
    }
    for (const s of [-1, 1]) {
      const side = new THREE.Mesh(new THREE.ConeGeometry(0.075, 0.42, 10), hair);
      side.rotation.x = Math.PI;
      side.position.set(s * 0.32, 0.05, 0.13);
      this.head.add(side);
    }

    // アホ毛(彼女のトレードマーク)
    this.ahoge = new THREE.Group();
    const a1 = new THREE.Mesh(new THREE.ConeGeometry(0.03, 0.22, 8), hair);
    a1.rotation.z = 0.5;
    a1.position.set(0.04, 0.09, 0);
    this.ahoge.add(a1);
    this.ahoge.position.set(0, 0.56, 0.02);
    this.head.add(this.ahoge);

    // ツインテール(チェーン構造 — update()で物理っぽく揺らす)
    this.tails = [];
    for (const s of [-1, 1]) {
      const segments = [];
      let parent = this.head;
      let pos = new THREE.Vector3(s * 0.36, 0.34, -0.05);
      for (let i = 0; i < 5; i++) {
        const g = new THREE.Group();
        g.position.copy(pos);
        parent.add(g);
        const r = 0.13 - i * 0.018;
        const ball = new THREE.Mesh(new THREE.SphereGeometry(r, 14, 14), i % 2 ? hairD : hair);
        ball.position.y = -r * 0.9;
        g.add(ball);
        segments.push(g);
        parent = g;
        pos = new THREE.Vector3(s * 0.02, -r * 1.7, 0);
      }
      // 毛先
      const tip = new THREE.Mesh(new THREE.ConeGeometry(0.05, 0.18, 8), hair);
      tip.rotation.x = Math.PI;
      tip.position.y = -0.14;
      parent.add(tip);
      // 結びリボン
      const knot = new THREE.Mesh(new THREE.SphereGeometry(0.05, 10, 10), ribbon);
      segments[0].add(knot);
      for (const w of [-1, 1]) {
        const wing = new THREE.Mesh(new THREE.ConeGeometry(0.06, 0.15, 8), ribbon);
        wing.rotation.z = w * Math.PI / 2;
        wing.position.set(w * 0.09, 0.02, 0);
        segments[0].add(wing);
      }
      this.tails.push({ side: s, segments, phase: Math.random() * Math.PI * 2 });
    }
  }

  _buildArm(skin, outfit, trim, side) {
    const pivot = new THREE.Group();
    pivot.position.set(side * 0.36, 1.36, 0);

    // パフスリーブ
    const sleeve = new THREE.Mesh(new THREE.SphereGeometry(0.11, 12, 12), outfit);
    pivot.add(sleeve);

    const upper = new THREE.Mesh(new THREE.CapsuleGeometry(0.055, 0.20, 6, 12), skin);
    upper.position.y = -0.16;
    pivot.add(upper);

    const elbow = new THREE.Group();
    elbow.position.y = -0.30;
    pivot.add(elbow);

    const fore = new THREE.Mesh(new THREE.CapsuleGeometry(0.05, 0.18, 6, 12), skin);
    fore.position.y = -0.12;
    elbow.add(fore);

    const wrist = new THREE.Group();
    wrist.position.y = -0.24;
    elbow.add(wrist);
    const hand = new THREE.Mesh(new THREE.SphereGeometry(0.07, 12, 12), skin);
    wrist.add(hand);

    // 基本ポーズ:腕を少し外に下ろす
    pivot.rotation.z = side * 0.28;
    return { pivot, elbow, wrist, side };
  }

  _buildEye(side) {
    const group = new THREE.Group();
    group.position.set(side * 0.145, 0.16, 0.27);

    // 白目
    const sclera = new THREE.Mesh(new THREE.SphereGeometry(0.085, 20, 20), flatMat(MochiPalette.white));
    sclera.scale.set(0.9, 1.25, 0.5);
    group.add(sclera);

    // 虹彩(このグループを動かして視線を作る)
    const irisG = new THREE.Group();
    group.add(irisG);
    const iris = new THREE.Mesh(new THREE.SphereGeometry(0.062, 20, 20), flatMat(MochiPalette.eyeIris));
    iris.scale.set(0.85, 1.15, 0.4);
    iris.position.z = 0.026;
    irisG.add(iris);
    const pupil = new THREE.Mesh(new THREE.SphereGeometry(0.032, 14, 14), flatMat(MochiPalette.eyePupil));
    pupil.scale.set(0.85, 1.15, 0.4);
    pupil.position.z = 0.05;
    irisG.add(pupil);
    // キラキラハイライト×2
    const hi1 = new THREE.Mesh(new THREE.SphereGeometry(0.016, 8, 8), flatMat(0xffffff));
    hi1.position.set(0.02, 0.035, 0.062);
    irisG.add(hi1);
    const hi2 = new THREE.Mesh(new THREE.SphereGeometry(0.009, 8, 8), flatMat(0xffffff));
    hi2.position.set(-0.022, -0.02, 0.062);
    irisG.add(hi2);

    // まぶた(肌色の板をかぶせてスケールで瞬き)
    const lid = new THREE.Mesh(new THREE.SphereGeometry(0.088, 20, 20), toonMat(MochiPalette.skin));
    lid.scale.set(0.95, 0.01, 0.55);
    lid.position.set(0, 0.105, 0.005);
    group.add(lid);

    // まつげ
    const lash = new THREE.Mesh(new THREE.CapsuleGeometry(0.010, 0.10, 4, 8), flatMat(0x6b4a55));
    lash.rotation.z = Math.PI / 2;
    lash.position.set(0, 0.105, 0.045);
    group.add(lash);

    return { group, irisG, lid };
  }

  /* ------------------------------------------------------------------ */
  /** 表情プリセット(brainからemotionトピックで指定される) */
  setEmotion(name) {
    const presets = {
      neutral:   { mouthSmile: 0.5,  browY: 0,    blush: 0.35 },
      happy:     { mouthSmile: 1.0,  browY: 0.4,  blush: 0.6 },
      excited:   { mouthSmile: 1.0,  browY: 0.8,  blush: 0.8 },
      shy:       { mouthSmile: 0.4,  browY: -0.5, blush: 1.0 },
      surprised: { mouthSmile: 0.1,  browY: 1.0,  blush: 0.4 },
      sad:       { mouthSmile: -0.8, browY: -1.0, blush: 0.2 },
      angry:     { mouthSmile: -0.5, browY: -0.3, blush: 0.5 },
      sleepy:    { mouthSmile: 0.2,  browY: -0.6, blush: 0.3 },
    };
    const e = presets[name] || presets.neutral;
    this._emotionTarget = e;
  }

  /** 毎フレーム更新。motionsからのポーズ適用後に呼ぶ */
  update(dt, gaze) {
    this._time += dt;
    const p = this.p, t = this._time;

    // ---- 常時アイドル(呼吸・体の揺れ) ----
    const breathe = Math.sin(t * 1.6) * 0.012;
    const sway = Math.sin(t * 0.7) * 0.02;

    // ---- 瞬き ----
    this._blinkTimer -= dt;
    if (this._blinkTimer <= 0) {
      this._blinkPhase = 0.22;                      // 瞬きの長さ
      this._blinkTimer = 1.8 + Math.random() * 4;
    }
    let blinkAuto = 0;
    if (this._blinkPhase > 0) {
      this._blinkPhase -= dt;
      const k = 1 - Math.abs(this._blinkPhase / 0.22 * 2 - 1);
      blinkAuto = Math.min(1, k * 1.4);
    }

    // ---- 表情の緩和(スムーズに変化) ----
    if (this._emotionTarget) {
      const e = this._emotionTarget, k = Math.min(1, dt * 4);
      p.mouthSmile += (e.mouthSmile - p.mouthSmile) * k;
      p.browY     += (e.browY - p.browY) * k;
      p.blush     += (e.blush - p.blush) * k;
    }

    // ---- 視線追従(gaze: {x,y} -1..1 / nullで正面) ----
    if (gaze) {
      const k = Math.min(1, dt * 6);
      p.eyeX += (gaze.x - p.eyeX) * k;
      p.eyeY += (gaze.y - p.eyeY) * k;
    } else {
      p.eyeX *= 1 - Math.min(1, dt * 2);
      p.eyeY *= 1 - Math.min(1, dt * 2);
    }

    /* ======== パラメータ → 実ジオメトリ反映 ======== */
    this.body.position.y = p.bodyY + breathe;
    this.body.rotation.set(p.bodyPitch, p.bodyYaw, p.bodyLean + sway);

    // 頭:モーション + 視線の30%を頭でも追う
    this.head.rotation.set(
      p.headPitch - p.eyeY * 0.25,
      p.headYaw + p.eyeX * 0.35,
      p.headRoll
    );

    // 腕
    this.shoulderL.pivot.rotation.set(p.shoulderLx, 0,  0.28 + p.shoulderLz);
    this.shoulderR.pivot.rotation.set(p.shoulderRx, 0, -0.28 + p.shoulderRz);
    this.shoulderL.elbow.rotation.x = p.elbowL;
    this.shoulderR.elbow.rotation.x = p.elbowR;
    this.shoulderL.elbow.rotation.z = p.forearmL;
    this.shoulderR.elbow.rotation.z = p.forearmR;
    this.shoulderL.wrist.rotation.z = p.wristL;
    this.shoulderR.wrist.rotation.z = p.wristR;

    // 目:虹彩移動 + まぶた
    for (const [key, eye] of Object.entries(this.eyes)) {
      const wink = key === 'L' ? p.winkL : p.winkR;
      const close = Math.max(p.blink, blinkAuto, wink);
      eye.irisG.position.set(p.eyeX * 0.032, p.eyeY * 0.028, 0);
      eye.lid.scale.y = 0.01 + close * 1.15;
      eye.lid.position.y = 0.105 - close * 0.09;
      eye.irisG.visible = close < 0.85;
    }

    // 眉
    this.brows[0].position.y = 0.33 + this.p.browY * 0.03;
    this.brows[1].position.y = 0.33 + this.p.browY * 0.03;
    this.brows[0].rotation.z = Math.PI / 2 - 0.15 - Math.min(0, p.browY) * 0.35;
    this.brows[1].rotation.z = Math.PI / 2 + 0.15 + Math.min(0, p.browY) * 0.35;

    // 口:リップシンク(開き) × 微笑(カーブ)
    const open = Math.max(0.06, p.mouthOpen);
    this.mouth.scale.set(0.9 + p.mouthSmile * 0.35, 0.25 + open * 1.6, 0.4);
    this.mouth.position.y = 0.045 + p.mouthSmile * 0.012 - open * 0.02;

    // チーク
    for (const b of this.blushMeshes) b.material.opacity = 0.1 + p.blush * 0.5;

    // ツインテール物理風スイング(頭の動きに遅れてついてくる)
    for (const tail of this.tails) {
      tail.phase += dt * 2.2;
      tail.segments.forEach((seg, i) => {
        const lag = (i + 1) * 0.35;
        seg.rotation.z = Math.sin(tail.phase - lag) * 0.10
                       + p.headRoll * 0.5 * (i + 1) * -0.3
                       + p.bodyLean * -0.4;
        seg.rotation.x = Math.cos(tail.phase * 0.8 - lag) * 0.07
                       + (p.headYaw) * 0.15;
      });
    }

    // アホ毛はいつもぴょこぴょこ
    this.ahoge.rotation.z = Math.sin(t * 3.1) * 0.18;
    this.ahoge.rotation.x = Math.cos(t * 2.3) * 0.12;
  }
}
