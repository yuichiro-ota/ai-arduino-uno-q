#!/usr/bin/env python3
"""
ritsu_perception.py — 律の人検出 ROS 2 ノード (Orbbec Gemini 335)

カラー画像で顔検出(OpenCV YuNet)し、深度から顔の3D位置を計算して配信する。律の視線追従の目になる。

発行トピック:
  /ritsu/person          geometry_msgs/PointStamped  顔(両目の中点)の位置 [m]
                         frame_id=camera_color_optical_frame (x:右 / y:下 / z:前、ROSの光学座標系)
  /ritsu/person_present  std_msgs/Bool     人がいるか (見失ったときに false)
  /ritsu/camera_alive    std_msgs/Bool     2秒ごとの生存通知 (画面の CAMERA ランプ用)
  /camera/imu            sensor_msgs/Imu   加速度の生データ (linear_acceleration のみ)
  /ritsu/tilt            geometry_msgs/Vector3  カメラの傾き [度] x=roll(左右) y=pitch(前後)。起動直後を0度とする

環境変数:
  CAMERA_ROTATE   0/90/180/270 — カメラを縦置きする場合の回転補正
  PERCEPTION_FPS  配信頻度 [回/秒] (default 15)
  IMU_ROLL_SIGN   傾きの左右が逆のとき -1 (default 1)
  DEBUG_SNAPSHOT  1 にすると5秒ごとにカメラ画像(検出枠つき)を debug/camera.jpg に保存する
                  (docker-compose で renderer/debug にマウント → http://<UNO Q>:8080/debug/camera.jpg で見られる)
"""
import math
import os
import threading
import time

import cv2
import numpy as np
import rclpy
from geometry_msgs.msg import PointStamped, Vector3
from sensor_msgs.msg import Imu
from std_msgs.msg import Bool

ROTATE = int(os.environ.get("CAMERA_ROTATE", "0"))
FPS = float(os.environ.get("PERCEPTION_FPS", "15"))
LOG_EVERY_SEC = 5   # 検出状況をログへ出す間隔
NO_FRAME_RESTART_SEC = 10   # この秒数カメラから映像が来なければ開き直す
STATUS_EVERY_SEC = 2        # /ritsu/camera_alive を送る間隔
FACE_MODEL = os.environ.get("FACE_MODEL", "/app/models/yunet.onnx")
FACE_SCORE = float(os.environ.get("FACE_SCORE", "0.6"))   # 顔とみなす信頼度の下限
IMU_ROLL_SIGN = float(os.environ.get("IMU_ROLL_SIGN", "1"))
TILT_EVERY_SEC = 0.1        # /ritsu/tilt を送る間隔
DEBUG_SNAPSHOT = os.environ.get("DEBUG_SNAPSHOT", "0") == "1"
SNAPSHOT_PATH = "/app/debug/camera.jpg"

# ---------------- ROS 2 ----------------
rclpy.init()
node = rclpy.create_node("ritsu_perception")
pub_person = node.create_publisher(PointStamped, "/ritsu/person", 10)
pub_present = node.create_publisher(Bool, "/ritsu/person_present", 10)
pub_alive = node.create_publisher(Bool, "/ritsu/camera_alive", 10)
pub_imu = node.create_publisher(Imu, "/camera/imu", 10)
pub_tilt = node.create_publisher(Vector3, "/ritsu/tilt", 10)


def publish_person(x, y, z):
    msg = PointStamped()
    msg.header.stamp = node.get_clock().now().to_msg()
    msg.header.frame_id = "camera_color_optical_frame"
    msg.point.x, msg.point.y, msg.point.z = x, y, z
    pub_person.publish(msg)


def publish_bool(pub, value: bool):
    pub.publish(Bool(data=value))


# ---------------- IMU (カメラの傾き) ----------------
class TiltSensor:
    """加速度センサーの重力方向から、起動時を基準にした左右(roll)・前後(pitch)の傾きを求める。
    カメラ座標系(x:右 / y:下 / z:前)の重力ベクトルを想定。"""

    def __init__(self):
        self.lock = threading.Lock()
        self.g = None          # 平滑化した重力ベクトル
        self.base = None       # 基準(起動直後)の roll/pitch
        self.samples = 0
        self.last_pub = 0.0
        self.roll = self.pitch = 0.0

    def on_accel(self, x, y, z):
        with self.lock:
            if self.g is None:
                self.g = [x, y, z]
            else:   # 手ブレや振動を落とすローパス
                self.g = [a + 0.15 * (b - a) for a, b in zip(self.g, (x, y, z))]
            gx, gy, gz = self.g
            roll = math.degrees(math.atan2(gx, gy))
            pitch = math.degrees(math.atan2(gz, gy))
            self.samples += 1
            if self.samples == 50:          # 最初の約0.5秒ぶんで基準を決める
                self.base = (roll, pitch)
            if self.base is None:
                return
            self.roll = IMU_ROLL_SIGN * ((roll - self.base[0] + 180) % 360 - 180)
            self.pitch = (pitch - self.base[1] + 180) % 360 - 180
            now = time.time()
            if now - self.last_pub >= TILT_EVERY_SEC:
                self.last_pub = now
                pub_tilt.publish(Vector3(x=round(self.roll, 1), y=round(self.pitch, 1), z=0.0))
                imu = Imu()
                imu.header.stamp = node.get_clock().now().to_msg()
                imu.header.frame_id = "camera_imu_frame"
                imu.linear_acceleration.x, imu.linear_acceleration.y, imu.linear_acceleration.z = x, y, z
                imu.orientation_covariance[0] = -1.0          # 姿勢・角速度は出さない
                imu.angular_velocity_covariance[0] = -1.0
                pub_imu.publish(imu)


tilt = TiltSensor()


def start_imu(pipeline):
    """加速度センサーを映像とは別に、コールバックで読む。使えなければ None を返して映像だけで動く"""
    from pyorbbecsdk import OBSensorType
    try:
        sensor = pipeline.get_device().get_sensor(OBSensorType.ACCEL_SENSOR)
        profile = sensor.get_stream_profile_list().get_stream_profile_by_index(0)

        def on_frame(frame):
            f = frame.as_accel_frame()
            if f is not None:
                tilt.on_accel(float(f.get_x()), float(f.get_y()), float(f.get_z()))

        sensor.start(profile, on_frame)
        print("[perception] IMU (accel) started")
        return sensor
    except Exception as e:
        print(f"[perception] IMU unavailable: {e}")
        return None


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


def save_snapshot(view, box, found, depth, scale):
    """検出の様子を確認するための画像(左:カラー+顔枠 / 右:深度)を保存する"""
    img = cv2.cvtColor(view, cv2.COLOR_RGB2BGR)
    if box:
        x, y, w, h = box
        cv2.rectangle(img, (x, y), (x + w, y + h), (0, 255, 0) if found else (0, 0, 255), 2)
    label = f"z={found['z']:.2f}m" if found else ("face, no depth" if box else "no face")
    cv2.putText(img, label, (10, 30), cv2.FONT_HERSHEY_SIMPLEX, 0.9, (0, 255, 255), 2)
    d = rotate_img(depth, ROTATE).astype(np.float32) * scale
    d = np.clip(d / 4000.0 * 255.0, 0, 255).astype(np.uint8)    # 0〜4m を濃淡に
    d = cv2.applyColorMap(d, cv2.COLORMAP_JET)
    d[rotate_img(depth, ROTATE) == 0] = 0                          # 深度なしは黒
    d = cv2.resize(d, (img.shape[1], img.shape[0]))
    os.makedirs(os.path.dirname(SNAPSHOT_PATH), exist_ok=True)
    tmp = SNAPSHOT_PATH + ".tmp.jpg"
    cv2.imwrite(tmp, np.hstack([img, d]))
    os.replace(tmp, SNAPSHOT_PATH)


def detect_face(detector, view):
    """最も大きい(=近い)顔を返す: ((x, y, w, h), (目の中点 u, v), score)。無ければ None"""
    vh, vw = view.shape[:2]
    detector.setInputSize((vw, vh))
    _, faces = detector.detect(cv2.cvtColor(view, cv2.COLOR_RGB2BGR))
    if faces is None or not len(faces):
        return None
    f = max(faces, key=lambda r: r[2] * r[3])
    x, y, w, h = (int(v) for v in f[:4])
    eye_u = int((f[4] + f[6]) / 2)   # 右目(4,5)と左目(6,7)の中点
    eye_v = int((f[5] + f[7]) / 2)
    return (x, y, w, h), (eye_u, eye_v), float(f[14])


def main():
    detector = cv2.FaceDetectorYN.create(FACE_MODEL, "", (640, 480), FACE_SCORE, 0.3, 5)

    pipeline, (fx, fy, cx, cy) = open_camera()
    print(f"[perception] camera ready fx={fx:.1f} fy={fy:.1f}")
    imu = start_imu(pipeline)

    last_pub = 0.0
    last_log = 0.0
    last_frame = time.time()
    last_status = 0.0
    miss = 0
    hits = 0
    faces = 0        # 顔は見つかった回数(深度が取れずに捨てた分も含む)
    no_depth = 0     # 顔はあったが深度が取れなかった回数
    while True:
        fs = pipeline.wait_for_frames(200)
        cf = fs.get_color_frame() if fs else None
        df = fs.get_depth_frame() if fs else None
        if cf is None or df is None:
            if time.time() - last_frame > NO_FRAME_RESTART_SEC:
                if imu:
                    imu.stop()
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
        det = detect_face(detector, view)

        found = None
        box = None
        if det:
            faces += 1
            box, (eye_u, eye_v), score = det
            h, w = color.shape[:2]
            u, v = to_sensor_uv(eye_u, eye_v, w, h)
            u = int(np.clip(u, 2, w - 3))
            v = int(np.clip(v, 2, h - 3))

            # 顔中心周辺 5x5 の深度中央値 [mm] → [m]
            patch = depth[v - 2:v + 3, u - 2:u + 3].astype(np.float32) * scale
            valid = patch[(patch > 200) & (patch < 6000)]
            if not valid.size:
                no_depth += 1
            else:
                z = float(np.median(valid)) / 1000.0
                found = {"x": (u - cx) / fx * z,
                         "y": (v - cy) / fy * z,     # 光学座標系なので y は下が+
                         "z": z}

        if found:
            publish_person(found["x"], found["y"], found["z"])
            if miss:
                publish_bool(pub_present, True)
            miss = 0
            hits += 1
        else:
            miss += 1
            if miss in (3, 30):  # 途切れ通知(連投しない)
                publish_bool(pub_present, False)

        if now - last_status >= STATUS_EVERY_SEC:
            publish_bool(pub_alive, True)
            last_status = now

        if now - last_log >= LOG_EVERY_SEC:
            state = (f"person x={found['x']:+.2f} y={found['y']:+.2f} z={found['z']:.2f}m"
                     if found else "no person")
            imu_state = (f", tilt roll={tilt.roll:+.0f} pitch={tilt.pitch:+.0f}" if imu and tilt.base
                         else (", imu waiting" if imu else ""))
            print(f"[perception] {state} ({hits} hits, {faces} faces, {no_depth} no-depth / "
                  f"{LOG_EVERY_SEC}s{imu_state})")
            if DEBUG_SNAPSHOT:
                save_snapshot(view, box, found, depth, scale)
            last_log, hits, faces, no_depth = now, 0, 0, 0


if __name__ == "__main__":
    while rclpy.ok():   # docker stop (SIGTERM) で rclpy が終了したら抜ける
        try:
            main()
        except Exception as e:  # カメラ抜け等からの自動復帰
            if not rclpy.ok():
                break
            print(f"[perception] error: {e} — retry in 3s", flush=True)
            publish_bool(pub_present, False)
            time.sleep(3)
