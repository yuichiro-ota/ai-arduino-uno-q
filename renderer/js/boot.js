/* boot.js — ESモジュール(three / three-vrm)を読み込んでグローバルへ橋渡しし、
 * 既存のスクリプト群を順番にロードする起動シーケンス */
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm';

window.THREE = THREE;
window.__VRM = { GLTFLoader, VRMLoaderPlugin, VRMUtils };

for (const src of ['js/character.js', 'js/vrm_avatar.js', 'js/motions.js', 'js/context.js', 'js/brain.js', 'js/main.js']) {
  await new Promise((resolve, reject) => {
    const el = document.createElement('script');
    el.src = src;
    el.onload = resolve;
    el.onerror = () => reject(new Error('load failed: ' + src));
    document.body.appendChild(el);
  });
}
