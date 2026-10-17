/* =========================================================================
 * vrm_avatar.js — VRMモデル差し替えアダプタ
 *
 * renderer/models/avatar.vrm が存在すればそれを読み込み、無ければ内蔵の
 * 手続き生成モデル(Mochiko)にフォールバックする。
 *
 * VRMAvatar は Mochiko と同一インターフェース(.p / setEmotion / update)を
 * 実装しているため、motions.js の36モーション・視線追従・リップシンク・
 * 表情がそのまま全部VRMでも動く。VRMのスプリングボーン(髪揺れ等)も有効。
 * 対応: VRM 0.x / 1.0(@pixiv/three-vrm 経由)
 * ========================================================================= */

class VRMAvatar {
  static async load(scene, url) {
    const { GLTFLoader, VRMLoaderPlugin, VRMUtils } = window.__VRM;
    const loader = new GLTFLoader();
    loader.register(parser => new VRMLoaderPlugin(parser));
    const gltf = await loader.loadAsync(url);
    const vrm = gltf.userData.vrm;
    VRMUtils.removeUnnecessaryVertices?.(gltf.scene);
    VRMUtils.rotateVRM0(vrm);           // VRM0.xの向きをVRM1(+Z正面)に統一
    if (RITSU_CFG.simpleMaterials) VRMAvatar._simplifyMaterials(vrm.scene);
    scene.add(vrm.scene);
    return new VRMAvatar(vrm, scene);
  }

  /** MToon(トゥーン+輪郭線)を MeshBasicMaterial に置き換えてGPU負荷を下げる */
  static _simplifyMaterials(root) {
    root.traverse(o => {
      if (!o.isMesh) return;
      const src = Array.isArray(o.material) ? o.material[0] : o.material;  // [1]は輪郭線パス
      o.material = new THREE.MeshBasicMaterial({
        map: src.map || null,
        color: src.color ? src.color.clone() : 0xffffff,
        transparent: !!src.transparent,
        alphaTest: src.alphaTest || 0,
        side: src.side,
      });
    });
  }

  /** 頭のワールド座標(カメラ寄り用) */
  headWorldPosition(out = new THREE.Vector3()) {
    const head = this.vrm.humanoid?.getRawBoneNode('head');
    return head ? head.getWorldPosition(out) : out.set(0, 1.45, 0);
  }

  constructor(vrm, scene) {
    this.vrm = vrm;

    // ---- Mochikoと同一の可動パラメータ(motions.jsが書き込む) ----
    this.p = {
      headYaw: 0, headPitch: 0, headRoll: 0,
      bodyY: 0, bodyYaw: 0, bodyLean: 0, bodyPitch: 0,
      shoulderLx: 0, shoulderLz: 0, shoulderRx: 0, shoulderRz: 0,
      elbowL: 0, elbowR: 0, forearmL: 0, forearmR: 0,
      wristL: 0, wristR: 0,
      legLx: 0, legLz: 0, legRx: 0, legRz: 0, kneeL: 0, kneeR: 0,   // 足(太もも前後/横・ひざ)
      blink: 0, mouthOpen: 0, mouthSmile: 0.6, browY: 0, blush: 0.35,
      eyeX: 0, eyeY: 0, winkL: 0, winkR: 0,
    };
    this._base = { ...this.p };
    this._blinkTimer = 2 + Math.random() * 3;
    this._blinkPhase = 0;
    this._time = 0;
    this._exprWeights = {};   // 表情のなめらか遷移用

    // 正規化ボーン(T-pose基準・モデル差を吸収)
    const b = n => vrm.humanoid?.getNormalizedBoneNode(n);
    this.bones = {
      hips: b('hips'), spine: b('spine'), chest: b('chest'),
      upperChest: b('upperChest'),
      neck: b('neck'), head: b('head'),
      shL: b('leftShoulder'),    shR: b('rightShoulder'),
      uArmL: b('leftUpperArm'),  uArmR: b('rightUpperArm'),
      lArmL: b('leftLowerArm'),  lArmR: b('rightLowerArm'),
      handL: b('leftHand'),      handR: b('rightHand'),
      uLegL: b('leftUpperLeg'),  uLegR: b('rightUpperLeg'),
      lLegL: b('leftLowerLeg'),  lLegR: b('rightLowerLeg'),
    };
    this._hipsY = this.bones.hips ? this.bones.hips.position.y : 1.0;

    // ---- VRoid系モデルの領域別モーフ(Fcl_*)検出 ----
    // VRoidの感情プリセット(Joy等)は顔全体モーフFcl_ALL_*を使っており、
    // まばたきのFcl_EYE_Close_L/Rと形の違う「閉じ目」変形が混ざると
    // まつ毛が顔メッシュに沈んで目が消える(肌色になる)。
    // Fclモーフを持つモデルでは眉/目/口を領域別モーフで直接駆動し、
    // まぶたはFcl_EYE_Close_L/Rのみで閉じることで破綻を根本的に防ぐ。
    this._faceMeshes = [];
    vrm.scene.traverse(o => {
      if (o.isMesh && o.morphTargetDictionary
          && o.morphTargetDictionary['Fcl_EYE_Close_L'] !== undefined) {
        this._faceMeshes.push(o);
      }
    });
    this._fclTarget = {};
    this._fclWeights = {};   // 領域別モーフのなめらか遷移用

    // 視線ターゲット(three-vrmのlookAtで眼球を動かす)
    this.lookTarget = new THREE.Object3D();
    scene.add(this.lookTarget);
    if (vrm.lookAt) vrm.lookAt.target = this.lookTarget;

    // 立ち姿の基準:T-poseから腕を下ろす
    this.ARM_DOWN = Math.PI / 2 - 0.24;   // 約76°下げ(自然な「気をつけ」)

    // 指を軽く曲げて自然に(T-poseのパー状態は硬く見えるため)
    this._relaxFingers(vrm);
  }

  _relaxFingers(vrm) {
    const fingers = ['Index', 'Middle', 'Ring', 'Little'];
    for (const side of ['left', 'right']) {
      const sgn = side === 'left' ? 1 : -1;
      for (const f of fingers) {
        for (const [seg, curl] of [['Proximal', 0.28], ['Intermediate', 0.35], ['Distal', 0.2]]) {
          const n = vrm.humanoid?.getNormalizedBoneNode(`${side}${f}${seg}`);
          if (n) n.rotation.z = sgn * curl;
        }
      }
      const thumb = vrm.humanoid?.getNormalizedBoneNode(`${side}ThumbProximal`);
      if (thumb) thumb.rotation.y = sgn * 0.3;
    }
  }

  /** 表情プリセット → VRM Expression へのマッピング
   *  happyプリセットは閉じ目(にっこり目)を含むため、常用する happy は
   *  目が開いたままになる弱めの重みに抑え、excited(大笑い)のみ全開にする */
  setEmotion(name) {
    const map = {
      neutral:   { happy: 0.15 },
      happy:     { happy: 0.35 },
      excited:   { happy: 1.0 },
      shy:       { happy: 0.3 },
      surprised: { surprised: 1.0 },
      sad:       { sad: 0.9 },
      angry:     { angry: 0.8 },
      sleepy:    { relaxed: 0.9 },
    };
    this._emotionTarget = map[name] || map.neutral;

    // VRoid系: 領域別モーフで感情を表現。目は基本開けたまま
    // (眉と口だけで感情を出し、閉じ目はexcitedのFcl_EYE_Joyのみ)
    const fcl = {
      neutral:   {},
      happy:     { Fcl_BRW_Joy: 0.7, Fcl_MTH_Joy: 0.45 },
      excited:   { Fcl_BRW_Joy: 1.0, Fcl_MTH_Joy: 0.8, Fcl_EYE_Joy: 1.0 },
      shy:       { Fcl_BRW_Sorrow: 0.35, Fcl_MTH_Fun: 0.5 },
      surprised: { Fcl_BRW_Surprised: 1.0, Fcl_EYE_Surprised: 0.9, Fcl_MTH_Surprised: 0.6 },
      sad:       { Fcl_BRW_Sorrow: 0.9, Fcl_EYE_Sorrow: 0.6, Fcl_MTH_Sorrow: 0.6 },
      angry:     { Fcl_BRW_Angry: 0.9, Fcl_EYE_Angry: 0.6, Fcl_MTH_Angry: 0.5 },
      sleepy:    { Fcl_EYE_Natural: 0.6, Fcl_MTH_Neutral: 0.3 },
    };
    this._fclTarget = fcl[name] || fcl.neutral;
    // Mochiko互換パラメータも一応更新(mouthSmile等をモーションが参照するため)
    const smile = { happy: 1, excited: 1, shy: 0.4, neutral: 0.5 }[name];
    if (smile !== undefined) this.p.mouthSmile = smile;
  }

  _setExpr(name, v) {
    const em = this.vrm.expressionManager;
    if (em && em.getExpression?.(name) !== null && em.getExpression?.(name) !== undefined) {
      em.setValue(name, THREE.MathUtils.clamp(v, 0, 1));
    } else if (em && em.setValue) {
      try { em.setValue(name, THREE.MathUtils.clamp(v, 0, 1)); } catch (e) {}
    }
  }

  /** 領域別モーフを直接書き込む(VRM Expressionを経由しない) */
  _setMorph(name, v) {
    for (const m of this._faceMeshes) {
      const i = m.morphTargetDictionary[name];
      if (i !== undefined) m.morphTargetInfluences[i] = THREE.MathUtils.clamp(v, 0, 1);
    }
  }

  update(dt, gaze) {
    this._time += dt;
    const p = this.p, t = this._time, B = this.bones;

    /* ---- 瞬き(Mochikoと同じロジック) ---- */
    this._blinkTimer -= dt;
    if (this._blinkTimer <= 0) {
      this._blinkPhase = 0.22;
      this._blinkTimer = 1.8 + Math.random() * 4;
    }
    let blinkAuto = 0;
    if (this._blinkPhase > 0) {
      this._blinkPhase -= dt;
      const k = 1 - Math.abs(this._blinkPhase / 0.22 * 2 - 1);
      blinkAuto = Math.min(1, k * 1.4);
    }

    /* ---- 視線追従 ---- */
    if (gaze) {
      const k = Math.min(1, dt * 6);
      p.eyeX += (gaze.x - p.eyeX) * k;
      p.eyeY += (gaze.y - p.eyeY) * k;
    } else {
      p.eyeX *= 1 - Math.min(1, dt * 2);
      p.eyeY *= 1 - Math.min(1, dt * 2);
    }
    // 眼球:モデル正面1.5m先の仮想ターゲットを動かす
    if (this.lookOverride) this.lookTarget.position.copy(this.lookOverride);  // のぞき込み中はカメラを見る
    else this.lookTarget.position.set(p.eyeX * 1.2, 1.4 + p.eyeY * 0.7, 1.6);

    /* ---- アイドル(呼吸・体の揺れ) ---- */
    const breathe = Math.sin(t * 1.6) * 0.006;
    const sway = Math.sin(t * 0.7) * 0.015;

    /* ======== パラメータ → VRMボーン ======== */
    if (B.hips) {
      B.hips.position.y = this._hipsY + p.bodyY;
      B.hips.rotation.set(p.bodyPitch * 0.5, p.bodyYaw, p.bodyLean * 0.5 + sway * 0.5);
    }
    if (B.spine) B.spine.rotation.set(p.bodyPitch * 0.5 + breathe, 0, p.bodyLean * 0.5 + sway * 0.5);
    if (B.chest) B.chest.rotation.x = breathe;

    // 頭:モーション + 視線の一部を頭でも追う。首40%/頭60%に分担して自然に
    const hx = p.headPitch - p.eyeY * 0.25;
    const hy = p.headYaw + p.eyeX * 0.35;
    const hz = p.headRoll;
    if (B.neck) B.neck.rotation.set(hx * 0.4, hy * 0.4, hz * 0.4);
    if (B.head) B.head.rotation.set(hx * 0.6, hy * 0.6, hz * 0.6);

    // 腕:T-pose(左+X/右-X)→ 下ろした姿勢を基準に、Mochikoの角度定義を写像
    // 腕を大きく上げた時は肩ボーンも一緒にすくめると自然
    const raiseL = Math.max(0, p.shoulderLz - 0.8);
    const raiseR = Math.max(0, -p.shoulderRz - 0.8);
    if (B.shL) B.shL.rotation.z = -raiseL * 0.18;
    if (B.shR) B.shR.rotation.z = raiseR * 0.18;
    // 実測較正済み: 律(VRM0/three-vrm正規化ボーン)では腕下ろし=左+z/右-z
    if (B.uArmL) {
      B.uArmL.rotation.set(p.shoulderLx, 0, this.ARM_DOWN - p.shoulderLz * 0.82);
    }
    if (B.uArmR) {
      B.uArmR.rotation.set(p.shoulderRx, 0, -this.ARM_DOWN - p.shoulderRz * 0.82);
    }
    if (B.lArmL) B.lArmL.rotation.set(p.forearmL, THREE.MathUtils.clamp(p.elbowL, -2.6, 0), 0);
    if (B.lArmR) B.lArmR.rotation.set(p.forearmR, THREE.MathUtils.clamp(-p.elbowR, 0, 2.6), 0);
    if (B.handL) B.handL.rotation.z = p.wristL;
    if (B.handR) B.handR.rotation.z = p.wristR;

    // 足: x負=太ももを前へ上げる / z=横へ開く(左+・右-で外側) / ひざ x正=曲げる
    if (B.uLegL) B.uLegL.rotation.set(p.legLx, 0, p.legLz);
    if (B.uLegR) B.uLegR.rotation.set(p.legRx, 0, p.legRz);
    if (B.lLegL) B.lLegL.rotation.x = p.kneeL;
    if (B.lLegR) B.lLegR.rotation.x = p.kneeR;

    /* ======== 表情(VRM Expression) ======== */
    // 瞬き・ウインク
    const closeL = Math.max(p.blink, blinkAuto, p.winkL);
    const closeR = Math.max(p.blink, blinkAuto, p.winkR);
    const eyeClose = Math.max(closeL, closeR);
    const em = this.vrm.expressionManager;
    if (this._faceMeshes.length) {
      // VRoid系: まぶたはblinkLeft/Right Expression(=Fcl_EYE_Close_L/Rのみに
      // バインド)で閉じる。Close系モーフはExpressionにバインドされているため
      // 直接書いてもexpressionManagerが毎フレームリセットしてしまう
      this._setExpr('blinkLeft', closeL);
      this._setExpr('blinkRight', closeR);

      // 感情はExpression非バインドの領域別モーフを直接駆動してなめらか遷移。
      // 目系モーフはClose系と混ざるとまぶたが破綻するため閉眼中はフェードアウト
      const names = new Set([
        ...Object.keys(this._fclWeights),
        ...Object.keys(this._fclTarget || {}),
      ]);
      for (const n of names) {
        const target = (this._fclTarget && this._fclTarget[n]) || 0;
        const cur = this._fclWeights[n] || 0;
        const next = cur + (target - cur) * Math.min(1, dt * 4);
        this._fclWeights[n] = next;
        this._setMorph(n, n.startsWith('Fcl_EYE') ? next * (1 - eyeClose) : next);
      }

      // リップシンク(音量ベース)はExpression経由(Fcl_MTH_Aに解決される)
      if (em) this._setExpr('aa', p.mouthOpen);
    } else if (em) {
      if (em.getExpression?.('blinkLeft') || em.getExpression?.('blinkRight')) {
        this._setExpr('blinkLeft', closeL);
        this._setExpr('blinkRight', closeR);
      } else {
        this._setExpr('blink', Math.max(closeL, closeR));
      }
      // リップシンク(音量ベース)
      this._setExpr('aa', p.mouthOpen);

      // 感情表情のなめらか遷移
      // happy等は閉じ目モーフを含み、瞬き/ウインクのモーフと二重適用されると
      // まぶたが破綻して目が消えるため、閉眼中は感情側の重みを引っ込める
      if (this._emotionTarget) {
        for (const name of ['happy', 'angry', 'sad', 'relaxed', 'surprised']) {
          const target = this._emotionTarget[name] || 0;
          const cur = this._exprWeights[name] || 0;
          const next = cur + (target - cur) * Math.min(1, dt * 4);
          this._exprWeights[name] = next;
          this._setExpr(name, next * (1 - eyeClose));
        }
      }
    }

    // スプリングボーン(髪・スカート等の物理)+ Expression反映
    this.vrm.update(dt);
  }
}

/* ------------------------------------------------------------------ */
/** models/avatar.vrm があればVRM、無ければ内蔵モデル(もちこ)を返す */
async function createAvatar(scene) {
  try {
    const head = await fetch('models/avatar.vrm', { method: 'HEAD' });
    if (head.ok) {
      const avatar = await VRMAvatar.load(scene, 'models/avatar.vrm');
      console.log('[avatar] VRMモデルを読み込みました');
      return avatar;
    }
  } catch (e) {
    console.warn('[avatar] VRM読み込み失敗:', e);
  }
  console.log('[avatar] models/avatar.vrm が無いため内蔵モデルで起動します');
  return new Mochiko(scene);
}
window.createAvatar = createAvatar;
