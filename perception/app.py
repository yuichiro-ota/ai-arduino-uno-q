#!/usr/bin/env python3
"""
perception/app.py — Orbbec Gemini 335 人検出サービス

カラー画像で顔検出(MediaPipe)し、深度から顔の3D位置を計算して
`perception/person` トピックへ配信する。律の視線追従の目になる。

配信フォーマット:
  {"present": true, "x": -0.31, "y": 0.05, "z": 1.42, "conf": 0.93}
  x: 右+ / y: 上+ / z: カメラからの距離 [m](カメラ座標系)
  見失ったら {"present": false}

環境変数:
  MQTT_HOST       MQTTブローカー (default 127.0.0.1)。開発PCからは UNO Q の 192.168.3.80
  CAMERA_ROTATE   0/90/180/270 — カメラを縦置きする場合の回転補正
  PERCEPTION_FPS  配信頻度 [回/秒] (default 15)
"""
import json
import os
import time

import cv2
import numpy as np
import paho.mqtt.client as mqtt

MQTT_HOST = os.environ.get("MQTT_HOST", "127.0.0.1")
ROTATE = int(os.environ.get("CAMERA_ROTATE", "0"))
FPS = float(os.environ.get("PERCEPTION_FPS", "15"))
LOG_EVERY_SEC = 5   # 検出状況をログへ出す間隔
NO_FRAME_RESTART_SEC = 10   # この秒数カメラから映像が来なければ開き直す

# ---------------- MQTT ----------------
mq = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id="ritsu-perception")
mq.connect_async(MQTT_HOST, 1883, keepalive=30)   # ブローカーが後から起動しても自動で再接続
mq.loop_start()


def publish(payload: dict):
    mq.publish("perception/person", json.dumps(payload), qos=0)


# ---------------- Orbbec Gemini 335 ----------------
def open_camera():
    """pyorbbecsdkでカラー+深度をD2C(深度→カラー位置合わせ)付きで開く"""
    from pyorbbecsdk import (Pipeline, Config, OBSensorType, OBFormat,
                             OBAlignMode)
    pipeline = Pipeline()
    config = Config()

    color_profiles = pipeline.get_stream_profile_list(OBSensorType.COLOR_SENSOR)
    color = color_profiles.get_video_stream_profile(640, 480, OBFormat.RGB, 30)
    config.enable_stream(color)

    depth_profiles = pipeline.get_stream_profile_list(OBSensorType.DEPTH_SENSOR)
    depth = depth_profiles.get_video_stream_profile(640, 480, OBFormat.Y16, 30)
    config.enable_stream(depth)

    config.set_align_mode(OBAlignMode.SW_MODE)  # 深度をカラーに位置合わせ
    pipeline.start(config)

    # カラーカメラの内部パラメータ(3D位置計算に使用)
    params = pipeline.get_camera_param()
    intr = params.rgb_intrinsic
    return pipeline, (intr.fx, intr.fy, intr.cx, intr.cy)


def frames_to_np(color_frame, depth_frame):
    w, h = color_frame.get_width(), color_frame.get_height()
    color = np.frombuffer(color_frame.get_data(), dtype=np.uint8).reshape(h, w, 3)
    dw, dh = depth_frame.get_width(), depth_frame.get_height()
    depth = np.frombuffer(depth_frame.get_data(), dtype=np.uint16).reshape(dh, dw)
    scale = depth_frame.get_depth_scale()  # mm/unit
    return color, depth, scale


def rotate_img(img, rot):
    if rot == 90:
        return cv2.rotate(img, cv2.ROTATE_90_CLOCKWISE)
    if rot == 180:
        return cv2.rotate(img, cv2.ROTATE_180)
    if rot == 270:
        return cv2.rotate(img, cv2.ROTATE_90_COUNTERCLOCKWISE)
    return img


def to_sensor_uv(u_v, v_v, w, h):
    """回転後の画像座標を元のセンサー座標に戻す"""
    if ROTATE == 90:
        return v_v, h - 1 - u_v
    if ROTATE == 270:
        return w - 1 - v_v, u_v
    if ROTATE == 180:
        return w - 1 - u_v, h - 1 - v_v
    return u_v, v_v


def main():
    import mediapipe as mp
    detector = mp.solutions.face_detection.FaceDetection(
        model_selection=1, min_detection_confidence=0.5)  # model 1 = 〜5m対応

    pipeline, (fx, fy, cx, cy) = open_camera()
    print(f"[perception] camera ready fx={fx:.1f} fy={fy:.1f} -> mqtt {MQTT_HOST}:1883")

    last_pub = 0.0
    last_log = 0.0
    last_frame = time.time()
    miss = 0
    hits = 0
    while True:
        fs = pipeline.wait_for_frames(200)
        cf = fs.get_color_frame() if fs else None
        df = fs.get_depth_frame() if fs else None
        if cf is None or df is None:
            if time.time() - last_frame > NO_FRAME_RESTART_SEC:
                pipeline.stop()
                raise RuntimeError(f"no frames from camera for {NO_FRAME_RESTART_SEC}s")
            continue
        last_frame = time.time()

        now = time.time()
        if now - last_pub < 1.0 / FPS:
            continue
        last_pub = now

        color, depth, scale = frames_to_np(cf, df)
        view = rotate_img(color, ROTATE)
        result = detector.process(view)

        found = None
        if result.detections:
            # 最も大きい(=近い)顔を採用
            det = max(result.detections,
                      key=lambda d: d.location_data.relative_bounding_box.width)
            bb = det.location_data.relative_bounding_box
            vh, vw = view.shape[:2]
            h, w = color.shape[:2]
            u, v = to_sensor_uv(int((bb.xmin + bb.width / 2) * vw),
                                int((bb.ymin + bb.height / 3) * vh),  # 目の高さあたり
                                w, h)
            u = int(np.clip(u, 2, w - 3))
            v = int(np.clip(v, 2, h - 3))

            # 顔中心周辺 5x5 の深度中央値 [mm] → [m]
            patch = depth[v - 2:v + 3, u - 2:u + 3].astype(np.float32) * scale
            valid = patch[(patch > 200) & (patch < 6000)]
            if valid.size:
                z = float(np.median(valid)) / 1000.0
                found = {"present": True,
                         "x": round((u - cx) / fx * z, 3),
                         "y": round(-(v - cy) / fy * z, 3),  # 画像下+ → 上+ に反転
                         "z": round(z, 3),
                         "conf": round(det.score[0], 2)}

        if found:
            publish(found)
            miss = 0
            hits += 1
        else:
            miss += 1
            if miss in (3, 30):  # 途切れ通知(連投しない)
                publish({"present": False})

        if now - last_log >= LOG_EVERY_SEC:
            state = (f"person x={found['x']:+.2f} y={found['y']:+.2f} z={found['z']:.2f}m"
                     if found else "no person")
            print(f"[perception] {state} ({hits} hits / {LOG_EVERY_SEC}s, "
                  f"mqtt {'ok' if mq.is_connected() else 'disconnected'})")
            last_log, hits = now, 0


if __name__ == "__main__":
    while True:
        try:
            main()
        except Exception as e:  # カメラ抜け等からの自動復帰
            print(f"[perception] error: {e} — retry in 3s")
            publish({"present": False})
            time.sleep(3)
