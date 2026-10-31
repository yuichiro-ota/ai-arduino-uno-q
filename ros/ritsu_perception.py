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
  /ritsu/looking         std_msgs/Bool     顔がこちら(カメラ=画面)を向いているか。変化したとき+2秒ごと
  /ritsu/hand_near       geometry_msgs/PointStamped  画面のすぐ前(TOUCH_DIST 以内)にある手などの位置 [m]
                         (光学座標系)。ある間は毎回送る
  /ritsu/person_id       std_msgs/String   JSON {"id":"master"|"","score":0.52} 顔で見分けた相手。
                         変化したとき+2秒ごと(登録した顔が無いときは送らない)
  /ritsu/enroll_status   std_msgs/String   JSON {"state":"capturing"|"done"|"failed"|"cleared","count":n}

購読トピック:
  /ritsu/enroll          std_msgs/String   JSON {"action":"add"|"clear"} マスターの顔を登録する/消す。
                         add: カメラの正面に来た一番大きい顔を約4秒で数枚とり、特徴(128個の数値)を保存する
                         (顔の画像は保存しない)。何回か add すると、向きや明るさの違いに強くなる

環境変数:
  CAMERA_ROTATE   0/90/180/270 — カメラを縦置きする場合の回転補正
  PERCEPTION_FPS  配信頻度 [回/秒] (default 15)
  IMU_ROLL_SIGN   傾きの左右が逆のとき -1 (default 1)
  LOOK_YAW        顔の左右の向き(鼻のずれ/両目の間隔)がこれ以内なら「こちらを見ている」(default 0.2 ≒ 20度)
  TOUCH_DIST      これより近い物を「画面のすぐ前の手」とみなす [m] (default 0.45)
  MASTER_MATCH    登録した顔とみなす類似度の下限 (default 0.40。SFace の推奨は 0.363、上げるほど厳しい)
  FACE_DB         登録した顔の特徴を保存するファイル (default /data/faces/master.npy)
  DEBUG_SNAPSHOT  1 にすると5秒ごとにカメラ画像(検出枠つき)を debug/camera.jpg に保存する
                  (docker-compose で renderer/debug にマウント → http://<UNO Q>:8080/debug/camera.jpg で見られる)
"""
import json
import math
import os
import threading
import time

import cv2
import numpy as np
import rclpy
from geometry_msgs.msg import PointStamped, Vector3
from sensor_msgs.msg import Imu
from std_msgs.msg import Bool, String

ROTATE = int(os.environ.get("CAMERA_ROTATE", "0"))
FPS = float(os.environ.get("PERCEPTION_FPS", "15"))
LOG_EVERY_SEC = 5   # 検出状況をログへ出す間隔
NO_FRAME_RESTART_SEC = 10   # この秒数カメラから映像が来なければ開き直す
STATUS_EVERY_SEC = 2        # /ritsu/camera_alive を送る間隔
FACE_MODEL = os.environ.get("FACE_MODEL", "/app/models/yunet.onnx")
FACE_SCORE = float(os.environ.get("FACE_SCORE", "0.6"))   # 顔とみなす信頼度の下限
IMU_ROLL_SIGN = float(os.environ.get("IMU_ROLL_SIGN", "1"))
TILT_EVERY_SEC = 0.1        # /ritsu/tilt を送る間隔
LOOK_YAW = float(os.environ.get("LOOK_YAW", "0.2"))      # 顔の左右の向き(鼻のずれ/両目の間隔)がこれ以内なら「こちらを見ている」
TOUCH_DIST = float(os.environ.get("TOUCH_DIST", "0.45"))  # [m] これより近い物を「画面のすぐ前の手」とみなす
TOUCH_AREA = 0.03           # 画面のすぐ前の物が画像のこの割合以上なら手とみなす(小さなノイズは無視)
FACE_ID_MODEL = os.environ.get("FACE_ID_MODEL", "/app/models/sface.onnx")
MASTER_MATCH = float(os.environ.get("MASTER_MATCH", "0.40"))
FACE_DB = os.environ.get("FACE_DB", "/data/faces/master.npy")
ID_EVERY_SEC = 1.0          # 顔を見分ける間隔(SFace は UNO Q の CPU で重いので毎フレームはしない)
ID_MIN_FACE = 70            # [px] これより小さい(遠い)顔は見分けない(間違えやすい)
ID_MAX_YAW = 0.35           # 横を向きすぎた顔は見分けない
ENROLL_SHOTS = 6            # 登録1回でとる枚数
ENROLL_SEC = 8              # この秒数で ENROLL_SHOTS 枚とれなければ、とれた分だけ保存する
FACE_DB_MAX = 60            # 保存する特徴の上限(古いものから捨てる)
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
pub_looking = node.create_publisher(Bool, "/ritsu/looking", 10)
pub_hand = node.create_publisher(PointStamped, "/ritsu/hand_near", 10)
pub_person_id = node.create_publisher(String, "/ritsu/person_id", 10)
pub_enroll = node.create_publisher(String, "/ritsu/enroll_status", 10)


def publish_point(pub, x, y, z):
    msg = PointStamped()
    msg.header.stamp = node.get_clock().now().to_msg()
    msg.header.frame_id = "camera_color_optical_frame"
    msg.point.x, msg.point.y, msg.point.z = x, y, z
    pub.publish(msg)


def publish_person(x, y, z):
    publish_point(pub_person, x, y, z)


def publish_bool(pub, value: bool):
    pub.publish(Bool(data=value))


def publish_json(pub, obj):
    pub.publish(String(data=json.dumps(obj, ensure_ascii=False)))


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


def face_yaw(f):
    """YuNet の目・鼻の位置から顔の左右の向きを返す(0=正面、±0.3で約30度)。
    両目を結ぶ線に沿った鼻のずれを両目の間隔で割るので、首をかしげても変わらない"""
    re, le, nose = np.array(f[4:6]), np.array(f[6:8]), np.array(f[8:10])
    e = le - re
    dist = float(np.linalg.norm(e))
    if dist < 1:
        return 1.0
    return float(np.dot(nose - (re + le) / 2, e / dist) / dist)


class LookTracker:
    """こちらを向いている状態が続いたら true、向いていない(顔が無い)状態が続いたら false にする"""
    ON_FRAMES, OFF_FRAMES = 3, 6     # 8fps で約0.4秒 / 約0.75秒

    def __init__(self):
        self.state = False
        self.streak = 0
        self.last_pub = 0.0

    def update(self, frontal):
        if frontal != self.state:
            self.streak += 1
            if self.streak >= (self.ON_FRAMES if frontal else self.OFF_FRAMES):
                self.state, self.streak = frontal, 0
                self.publish()
        else:
            self.streak = 0
        if time.time() - self.last_pub > STATUS_EVERY_SEC:
            self.publish()

    def publish(self):
        publish_bool(pub_looking, self.state)
        self.last_pub = time.time()


class FaceId:
    """登録したマスターの顔かどうかを OpenCV SFace で見分ける。
    特徴は FACE_DB に保存し、/ritsu/enroll で登録・削除する(ROS のコールバックとカメラのループは別スレッド)"""
    STREAK = 2      # 続けてこの回数一致したらマスター、続けてこの回数外れたら別の人

    def __init__(self):
        self.lock = threading.Lock()
        self.rec = None
        try:
            self.rec = cv2.FaceRecognizerSF.create(FACE_ID_MODEL, "")
        except Exception as e:
            print(f"[perception] face id unavailable: {e}")
        self.db = self._load()
        self.enrolling = None       # {"feats": [...], "until": 時刻}
        self.id = ""
        self.streak = 0
        self.score = 0.0
        self.last_run = 0.0
        self.last_pub = 0.0
        node.create_subscription(String, "/ritsu/enroll", self._on_enroll, 10)

    def _load(self):
        try:
            db = np.load(FACE_DB)
            print(f"[perception] face db: {len(db)} features")
            return db
        except FileNotFoundError:
            return None
        except Exception as e:
            print(f"[perception] face db load error: {e}")
            return None

    def _save(self):
        os.makedirs(os.path.dirname(FACE_DB), exist_ok=True)
        tmp = FACE_DB + ".tmp.npy"
        np.save(tmp, self.db)
        os.replace(tmp, FACE_DB)

    def _on_enroll(self, msg):
        try:
            action = json.loads(msg.data).get("action")
        except (ValueError, AttributeError):
            action = msg.data.strip()
        with self.lock:
            if action == "add" and self.rec is not None:
                self.enrolling = {"feats": [], "until": time.time() + ENROLL_SEC, "last": 0.0}
                publish_json(pub_enroll, {"state": "capturing", "count": 0})
            elif action == "clear":
                self.db = None
                self.enrolling = None
                if os.path.exists(FACE_DB):
                    os.remove(FACE_DB)
                self._set_id("", 0.0)
                publish_json(pub_enroll, {"state": "cleared", "count": 0})
            print(f"[perception] enroll: {action}")

    def _set_id(self, new_id, score):
        changed = new_id != self.id
        self.id, self.score = new_id, score
        if changed or time.time() - self.last_pub > STATUS_EVERY_SEC:
            publish_json(pub_person_id, {"id": self.id, "score": round(score, 3)})
            self.last_pub = time.time()

    def update(self, view, face_row, yaw):
        """1フレームごとに呼ぶ。face_row は YuNet の1行(顔が無ければ None)"""
        if self.rec is None:
            return
        now = time.time()
        with self.lock:
            if face_row is None:
                if self.id:
                    self.streak = 0
                    self._set_id("", 0.0)
                self._finish_enroll(now)
                return
            usable = face_row[2] >= ID_MIN_FACE and abs(yaw) < ID_MAX_YAW
            enrolling = self.enrolling is not None
            if not usable or (not enrolling and now - self.last_run < ID_EVERY_SEC):
                if self.db is not None and now - self.last_pub > STATUS_EVERY_SEC:
                    self._set_id(self.id, self.score)
                self._finish_enroll(now)
                return
            if enrolling and now - self.enrolling["last"] < 0.5:     # 登録は少しずつ違う顔をとる
                return
            self.last_run = now
            bgr = cv2.cvtColor(view, cv2.COLOR_RGB2BGR)
            feat = self.rec.feature(self.rec.alignCrop(bgr, face_row)).flatten().astype(np.float32)
            if enrolling:
                self.enrolling["feats"].append(feat)
                self.enrolling["last"] = now
                publish_json(pub_enroll, {"state": "capturing", "count": len(self.enrolling["feats"])})
                self._finish_enroll(now)
                return
            if self.db is None:
                return
            # SFace のコサイン類似度(登録した特徴のうち一番近いもの)
            db = self.db / np.linalg.norm(self.db, axis=1, keepdims=True)
            score = float(np.max(db @ (feat / np.linalg.norm(feat))))
            hit = score >= MASTER_MATCH
            self.streak = self.streak + 1 if hit != (self.id == "master") else 0
            new_id = self.id
            if self.streak >= self.STREAK or abs(score - MASTER_MATCH) >= 0.15:   # はっきり似ている/違うならすぐ
                new_id, self.streak = ("master" if hit else ""), 0
            self._set_id(new_id, float(score))

    def _finish_enroll(self, now):
        e = self.enrolling
        if e is None or (len(e["feats"]) < ENROLL_SHOTS and now < e["until"]):
            return
        self.enrolling = None
        if not e["feats"]:
            publish_json(pub_enroll, {"state": "failed", "count": 0})
            print("[perception] enroll failed: no usable face")
            return
        feats = np.stack(e["feats"])
        self.db = feats if self.db is None else np.concatenate([self.db, feats])[-FACE_DB_MAX:]
        self._save()
        publish_json(pub_enroll, {"state": "done", "count": len(self.db)})
        print(f"[perception] enrolled {len(feats)} shots ({len(self.db)} total)")


def detect_hand_near(depth, scale, face_box, intr):
    """画面のすぐ前(TOUCH_DIST 以内)にある物(手)の位置 {x,y,z} を返す。無ければ None。
    顔の枠の中は除く(近づいた顔を手と間違えないように)。1/4 に間引いて軽くする"""
    fx, fy, cx, cy = intr
    step = 4
    d = depth[::step, ::step].astype(np.float32) * scale / 1000.0      # [m]
    near = (d > 0.12) & (d < TOUCH_DIST)
    if face_box:
        x, y, w, h = face_box                                           # センサー座標の顔の枠
        near[max(0, (y - h // 4) // step):(y + h + h // 4) // step + 1,
             max(0, (x - w // 4) // step):(x + w + w // 4) // step + 1] = False
    if near.mean() < TOUCH_AREA:
        return None
    vs, us = np.nonzero(near)
    z = float(np.median(d[near]))
    u, v = float(us.mean()) * step, float(vs.mean()) * step
    return {"x": (u - cx) / fx * z, "y": (v - cy) / fy * z, "z": z}


def detect_face(detector, view):
    """最も大きい(=近い)顔を返す: ((x, y, w, h), (目の中点 u, v), score, 顔の向き, YuNet の1行)。無ければ None"""
    vh, vw = view.shape[:2]
    detector.setInputSize((vw, vh))
    _, faces = detector.detect(cv2.cvtColor(view, cv2.COLOR_RGB2BGR))
    if faces is None or not len(faces):
        return None
    f = max(faces, key=lambda r: r[2] * r[3])
    x, y, w, h = (int(v) for v in f[:4])
    eye_u = int((f[4] + f[6]) / 2)   # 右目(4,5)と左目(6,7)の中点
    eye_v = int((f[5] + f[7]) / 2)
    return (x, y, w, h), (eye_u, eye_v), float(f[14]), face_yaw(f), f


face_id = FaceId()
# /ritsu/enroll を受け取るため、カメラのループとは別のスレッドで ROS 2 のコールバックを回す
def spin():
    try:
        rclpy.spin(node)
    except Exception:   # docker stop で rclpy が終了したとき
        pass


threading.Thread(target=spin, daemon=True).start()


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
    looking = LookTracker()
    hand_streak = 0  # 画面のすぐ前に物がある連続フレーム数(1フレームだけのノイズは無視)
    hand = None
    yaw = None
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
        yaw = None
        face_row = None
        if det:
            faces += 1
            box, (eye_u, eye_v), score, yaw, face_row = det
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

        looking.update(found is not None and abs(yaw) < LOOK_YAW)
        face_id.update(view, face_row, yaw if yaw is not None else 0.0)

        # 画面のすぐ前の手(顔の枠はセンサー座標に戻してから除く)
        sbox = None
        if box:
            h, w = color.shape[:2]
            (u1, v1), (u2, v2) = (to_sensor_uv(box[0], box[1], w, h),
                                  to_sensor_uv(box[0] + box[2], box[1] + box[3], w, h))
            sbox = (min(u1, u2), min(v1, v2), abs(u2 - u1), abs(v2 - v1))
        hand = detect_hand_near(depth, scale, sbox, (fx, fy, cx, cy))
        hand_streak = hand_streak + 1 if hand else 0
        if hand_streak >= 2:
            publish_point(pub_hand, hand["x"], hand["y"], hand["z"])

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
            state += (f", yaw={yaw:+.2f}{' looking' if looking.state else ''}" if yaw is not None else "")
            state += f", hand z={hand['z']:.2f}m" if hand else ""
            state += f", id={face_id.id or '-'}({face_id.score:.2f})" if face_id.db is not None and found else ""
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
