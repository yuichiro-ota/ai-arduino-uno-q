#!/usr/bin/env python3
"""
ritsu_base.py — 律の台車(メカナム4輪)の ROS 2 ノード

/cmd_vel(進む・横に動く・回る速さ)を4輪の速さに直し、UNO Q の STM32 で動くスケッチ(arduino/ritsu-base)へ
arduino-router(Linux 側の Bridge の仲立ち)経由で送る。エンコーダーの数から、どれだけ動いたかを /odom に出す。

購読トピック:
  /cmd_vel          geometry_msgs/Twist  linear.x 前[m/s] / linear.y 左[m/s] / angular.z 左回り[rad/s]
                    CMD_TIMEOUT_SEC 来なければ止まる。速さは MAX_LINEAR / MAX_ANGULAR まで
  /ritsu/base_test  std_msgs/String  JSON {"wheel":0-3, "pwm":-255〜255, "sec":1}
                    1輪だけ PWM を直接出す(配線と向きの確かめ用。0=左前 1=右前 2=左後 3=右後)
  /ritsu/turn       std_msgs/String  JSON {"reason":"greet", "sec":8, "search":false}  人の方を向いてと頼む(画面の律が反応するときに送る)
                    search=true(「こっち向いて」と頼まれた): 顔が見えていなければ最後に見た側へ回って探し(SEARCH_MAX_DEG まで)、
                    ずれが小さくても正面まで向く
                    /ritsu/person の顔の左右のずれを見ながらその場で回り、正面(TURN_DONE_DEG 以内)で止まる。
                    ずれが TURN_START_DEG 以内なら回らない(目線だけで足りる)。顔を見失う・sec 秒たつ・
                    /cmd_vel(手の操作)が来たらやめる
  /ritsu/turn_enable  std_msgs/Bool  人の方を向くか(/remote の切り替え)
  /ritsu/move       std_msgs/String  JSON {"action":"back"|"forward"|"left"|"right"|"stop"}  少しだけ動く(「後ろに下がって」など)。
                    stop は少し動く・人の方を向くのをすぐやめる
                    前後は MOVE_DIST [m]、左右は MOVE_TURN_DEG 度(左右は律から見た向き)。エンコーダーで測った量で止め、
                    時間でも打ち切る。/cmd_vel(手の操作)が来たらやめる
  /ritsu/person     geometry_msgs/PointStamped  顔の位置(光学座標系 x:右 z:前)
  /ritsu/walk       std_msgs/String  JSON {"on":true, "sec":60}  おさんぽモード: ゆっくり前に進み、正面 WALK_CLEAR 以内に物が
                    見えたらその場で空いている方へ回って、空いたらまた進む(後ろは見えないので下がらない)。
                    sec 秒・「止まって」(/ritsu/move stop)・/cmd_vel(手の操作)・カメラの知らせが途切れたらやめる
  /ritsu/obstacle   std_msgs/String  JSON {"front","left","right"} 前方の障害物までの距離 [m](カメラのノードが出す)
                    front が OBSTACLE_STOP より近い間は、前に進む指令だけ止める(回る・下がるはできる。十字ボタンも同じ)
発行トピック:
  /odom             nav_msgs/Odometry  frame odom / child base_link
  /ritsu/base_status  std_msgs/String  JSON {"ok":bool, "error":"...", "fault":[...], "enc_b":[...], "speed":[4輪 m/s], "cmd":[vx,vy,wz],
                                                "turn":"向いている理由" or null, "turn_enable":bool, "move":"動いている向き" or null,
                                                "obstacle":{"front","left","right"} or null, "blocked":bool,
                                                "walk":"forward"|"left"|"right" or null(おさんぽ中の動き)}
  /ritsu/base_event   std_msgs/String  JSON {"type":"blocked","by":"move"|"manual"|"walk","dist":0.32,"free":"left"|"right"|null}
                      前に進もうとして障害物で止めたとき(画面の律が知らせる)。free は空いている側(両方なら広い方)
                      JSON {"type":"walk","state":"start"|"stop","why":"time"|"stop"|"manual"|"camera"|"off"} おさんぽの始まり・終わり
                    enc_b は向きを B相で読めている車輪(最初に少し回すと決まる)

環境変数:
  ROUTER_SOCK     arduino-router のソケット (default /var/run/arduino-router.sock)
  WHEEL_DIAMETER  車輪の直径 [m] (default 0.08)
  WHEEL_LX        車体の中心から前輪・後輪の軸までの距離 [m] (default 0.10)
  WHEEL_LY        車体の中心から左右の車輪までの距離 [m] (default 0.12)
  WHEEL_INVERT    向きが逆の車輪を 1 に。左前,右前,左後,右後 (default 1,0,1,0: 律の台車の配線で前へ進む向き)
  PULSES_PER_REV  車輪1回転のパルス数 (default 440 = 11ライン × 減速1:40、A相の立ち上がり)
  MAX_LINEAR      [m/s] (default 0.3)   MAX_ANGULAR [rad/s] (default 1.2)
  TURN_ENABLE     人の方を向くか(起動時。/remote で切り替えられる) (default 1)
  TURN_MAX        向くときの回る速さの上限 [rad/s] (default 0.4 ≒ 1秒に23度)
  TURN_SIGN       向く向きが逆(人から離れるように回る)なら -1 (default 1)
  MOVE_DIST       「前に来て」「後ろに下がって」で動く距離 [m] (default 0.15)
  MOVE_TURN_DEG   「左向いて」「右向いて」で回る角度 [度] (default 30)
  OBSTACLE_STOP   正面の障害物がこれより近いと前に進まない [m] (default 0.4)
  WALK_SPEED      おさんぽで前に進む速さ [m/s] (default 0.08)
  WALK_CLEAR      おさんぽで、正面の物がこれより近くなったら向きを変える [m] (default 0.7)
"""
import json
import math
import os
import socket
import time

import msgpack
import rclpy
from geometry_msgs.msg import PointStamped, Twist
from nav_msgs.msg import Odometry
from std_msgs.msg import Bool, String

ROUTER_SOCK = os.environ.get("ROUTER_SOCK", "/var/run/arduino-router.sock")
WHEEL_R = float(os.environ.get("WHEEL_DIAMETER", "0.08")) / 2
LXY = float(os.environ.get("WHEEL_LX", "0.10")) + float(os.environ.get("WHEEL_LY", "0.12"))
INVERT = [-1 if s.strip() == "1" else 1 for s in os.environ.get("WHEEL_INVERT", "1,0,1,0").split(",")][:4]
PPR = float(os.environ.get("PULSES_PER_REV", "440"))
MAX_LINEAR = float(os.environ.get("MAX_LINEAR", "0.3"))
MAX_ANGULAR = float(os.environ.get("MAX_ANGULAR", "1.2"))
TURN_ENABLE = os.environ.get("TURN_ENABLE", "1") != "0"
TURN_MAX = float(os.environ.get("TURN_MAX", "0.4"))
TURN_SIGN = -1.0 if os.environ.get("TURN_SIGN", "1").strip() == "-1" else 1.0
TURN_MIN = 0.2                       # [rad/s] これより遅いと動き出さない
TURN_GAIN = 1.2                      # ずれ [rad] に掛けて回る速さにする(ずれが小さいほどゆっくり)
TURN_START_DEG = 10                  # 頼まれたとき、ずれがこれ以内なら回らない
TURN_DONE_DEG = 5                    # これ以内に入ったら止まる
TURN_LOST_SEC = 1.0                  # 顔をこれだけ見失ったらやめる
TURN_SEC_MAX = 15
SEARCH_MAX_DEG = 150                 # 「こっち向いて」で顔を探して回る角度の上限
SEARCH_SPEED = 0.35                  # [rad/s] 探すときの回る速さ
MOVE_DIST = float(os.environ.get("MOVE_DIST", "0.15"))
MOVE_TURN_DEG = float(os.environ.get("MOVE_TURN_DEG", "30"))
MOVE_SPEED = 0.1                     # [m/s] 前後に動く速さ
MOVE_TURN_SPEED = 0.5                # [rad/s] 左右を向く速さ
OBSTACLE_STOP = float(os.environ.get("OBSTACLE_STOP", "0.4"))
OBSTACLE_STALE_SEC = 1.0             # これより古い障害物の知らせは使わない(カメラが止まっている)
OBSTACLE_FREE = 0.8                  # [m] 左右の物がこれより遠ければ「空いている」
WALK_SPEED = float(os.environ.get("WALK_SPEED", "0.08"))
WALK_CLEAR = float(os.environ.get("WALK_CLEAR", "0.7"))
WALK_TURN_SPEED = 0.5                # [rad/s] おさんぽで向きを変える速さ
WALK_TURN_MAX_DEG = 200              # 回ってもこれだけで正面が空かなければやめる(囲まれている)
WALK_SEC_MAX = 600
MOVE_ACTIONS = {"forward": (MOVE_SPEED, 0.0), "back": (-MOVE_SPEED, 0.0),
                "left": (0.0, MOVE_TURN_SPEED), "right": (0.0, -MOVE_TURN_SPEED)}
RATE_HZ = 20
CMD_TIMEOUT_SEC = 0.5
STATUS_EVERY = 10                    # base_status は RATE_HZ の何回に1回
WHEELS = ("左前", "右前", "左後", "右後")
M_PER_PULSE = 2 * math.pi * WHEEL_R / PPR


class Router:
    """arduino-router へ MessagePack-RPC で呼び出す(STM32 が Bridge.provide した名前を呼べる)"""

    def __init__(self, path):
        self.path = path
        self.sock = None
        self.msgid = 0
        self.unpacker = msgpack.Unpacker(raw=False)

    def close(self):
        if self.sock:
            self.sock.close()
        self.sock = None

    def call(self, method, params, timeout=0.3):
        if not self.sock:
            self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            self.sock.settimeout(timeout)
            self.sock.connect(self.path)
            self.unpacker = msgpack.Unpacker(raw=False)
        self.msgid = (self.msgid + 1) & 0x7FFFFFFF
        self.sock.sendall(msgpack.packb([0, self.msgid, method, params]))
        end = time.monotonic() + timeout
        while time.monotonic() < end:
            for msg in self.unpacker:
                if isinstance(msg, list) and len(msg) == 4 and msg[0] == 1 and msg[1] == self.msgid:
                    if msg[2]:
                        raise RuntimeError(str(msg[2]))
                    return msg[3]
            data = self.sock.recv(4096)
            if not data:
                raise ConnectionError("router closed")
            self.unpacker.feed(data)
        raise TimeoutError(f"{method}: 返事がない")


def clamp(v, lim):
    return max(-lim, min(lim, v))


def main():
    rclpy.init()
    node = rclpy.create_node("ritsu_base")
    odom_pub = node.create_publisher(Odometry, "/odom", 10)
    status_pub = node.create_publisher(String, "/ritsu/base_status", 10)
    event_pub = node.create_publisher(String, "/ritsu/base_event", 10)
    router = Router(ROUTER_SOCK)
    st = {"cmd": (0.0, 0.0, 0.0), "cmd_at": 0.0, "test": None, "last": None, "x": 0.0, "y": 0.0, "th": 0.0,
          "speed": [0.0] * 4, "fault": 0, "enc_b": 0, "ok": False, "error": "", "n": 0, "t": time.monotonic(),
          "person": None, "turn": None, "turn_enable": TURN_ENABLE, "move": None,
          "obstacle": None, "obstacle_at": 0.0, "blocked": False, "blocked_said": 0.0, "walk": None}

    def on_cmd(msg):
        st["cmd"] = (clamp(msg.linear.x, MAX_LINEAR), clamp(msg.linear.y, MAX_LINEAR), clamp(msg.angular.z, MAX_ANGULAR))
        st["cmd_at"] = time.monotonic()
        st["test"] = None
        st["turn"] = st["move"] = None   # 手の操作を優先する
        if st["walk"]:
            stop_walk("manual")

    def on_person(msg):
        if msg.point.z > 0:
            st["person"] = (msg.point.x, msg.point.z, time.monotonic())

    def on_turn(msg):
        try:
            m = json.loads(msg.data)
            reason, sec = str(m.get("reason", ""))[:20], min(TURN_SEC_MAX, float(m.get("sec", 8)))
            search = bool(m.get("search", False))
        except (ValueError, TypeError, AttributeError):
            return
        p = st["person"]
        if not st["turn_enable"] or st["test"] or time.monotonic() - st["cmd_at"] < 1.0:
            return
        seen = p and time.monotonic() - p[2] <= TURN_LOST_SEC
        if not seen and not search:
            return
        if seen and abs(math.degrees(math.atan2(p[0], p[1]))) <= (TURN_DONE_DEG if search else TURN_START_DEG):
            return                       # ほぼ正面: 目線だけで足りる
        # 見えていなければ、最後に顔を見た側へ探しに回る(一度も見ていなければ左回り)
        side = -1.0 if p and p[0] > 0 else 1.0
        st["turn"] = {"reason": reason, "until": time.monotonic() + sec, "search": search and not seen,
                      "side": side, "th": st["th"], "since": time.monotonic()}
        st["move"] = None
        where = f"{math.degrees(math.atan2(p[0], p[1])):+.0f}度" if seen else f"顔が見えないので{'右' if side < 0 else '左'}へ探す"
        node.get_logger().info(f"人の方を向く: {reason} ({where})")

    def on_move(msg):
        try:
            action = json.loads(msg.data)["action"]
        except (ValueError, TypeError, KeyError):
            return
        if action == "stop":
            st["move"] = st["turn"] = None
            if st["walk"]:
                stop_walk("stop")
            node.get_logger().info("止まって と頼まれた")
            return
        if action not in MOVE_ACTIONS or st["test"] or time.monotonic() - st["cmd_at"] < 1.0:
            return
        vx, wz = MOVE_ACTIONS[action]
        sec = (MOVE_DIST / abs(vx) if vx else math.radians(MOVE_TURN_DEG) / abs(wz)) * 2 + 1   # 測れなくても止まる
        st["turn"] = None
        st["move"] = {"action": action, "vx": vx, "wz": wz, "x": st["x"], "y": st["y"], "th": st["th"],
                      "until": time.monotonic() + sec}
        node.get_logger().info(f"少し動く: {action}")

    def move_cmd():
        """少し動いている間の (vx, wz)。動き終わったら None"""
        m = st["move"]
        if not m:
            return None
        moved = math.hypot(st["x"] - m["x"], st["y"] - m["y"])
        turned = abs(math.degrees(st["th"] - m["th"]))
        done = moved >= MOVE_DIST if m["vx"] else turned >= MOVE_TURN_DEG
        if done or time.monotonic() > m["until"]:
            node.get_logger().info(f"動き終わった: {m['action']} ({moved:.2f}m {turned:.0f}度{'' if done else '・時間切れ'})")
            st["move"] = None
            return None
        return m["vx"], m["wz"]

    def on_obstacle(msg):
        try:
            o = json.loads(msg.data)
            st["obstacle"] = {k: (float(o[k]) if o.get(k) is not None else None) for k in ("front", "left", "right")}
            st["obstacle_at"] = time.monotonic()
        except (ValueError, TypeError, AttributeError, KeyError):
            pass

    def free_side():
        """空いている側(4-link-robot の Jev の決め方と同じ: 空いている方、両方なら広い方)。どちらも塞がっていれば None"""
        o = st["obstacle"] or {}
        far = {k: (o.get(k) if o.get(k) is not None else 9.0) for k in ("left", "right")}
        open_ = [k for k, v in far.items() if v >= OBSTACLE_FREE]
        return max(open_, key=lambda k: far[k]) if open_ else None

    def guard_forward(vx, vy, wz, by):
        """正面に障害物があれば前に進む分を止める。止めたら知らせる"""
        o, now = st["obstacle"], time.monotonic()
        front = o["front"] if o and now - st["obstacle_at"] < OBSTACLE_STALE_SEC else None
        blocked = vx > 0 and front is not None and front < OBSTACLE_STOP
        if blocked and not st["blocked"] and now - st["blocked_said"] > 3.0:
            st["blocked_said"] = now
            free = free_side()
            event_pub.publish(String(data=json.dumps({"type": "blocked", "by": by, "dist": front, "free": free})))
            node.get_logger().info(f"前に障害物 {front:.2f}m: 進まない (空いている側: {free or 'なし'})")
        st["blocked"] = blocked
        return (0.0 if blocked else vx), vy, wz

    def obstacle_now():
        o = st["obstacle"]
        return o if o and time.monotonic() - st["obstacle_at"] < OBSTACLE_STALE_SEC else None

    def event(obj):
        event_pub.publish(String(data=json.dumps(obj)))

    def on_walk(msg):
        try:
            m = json.loads(msg.data)
            on, sec = bool(m.get("on", True)), min(WALK_SEC_MAX, float(m.get("sec", 60)))
        except (ValueError, TypeError, AttributeError):
            return
        if not on:
            if st["walk"]:
                stop_walk("off")
            return
        if st["test"]:
            return
        if not obstacle_now():
            node.get_logger().warn("おさんぽ: カメラから障害物の知らせが無いので始めない")
            event({"type": "walk", "state": "stop", "why": "camera"})
            return
        st["walk"] = {"until": time.monotonic() + sec, "phase": "forward", "dir": 1.0, "th": 0.0}
        st["move"] = st["turn"] = None
        node.get_logger().info(f"おさんぽ: 始める({sec:.0f}秒)")
        event({"type": "walk", "state": "start"})

    def stop_walk(why):
        st["walk"] = None
        node.get_logger().info(f"おさんぽ: やめる({why})")
        event({"type": "walk", "state": "stop", "why": why})

    def walk_decide(o):
        """おさんぽの次の動き(4-link-robot の Jev と同じ形の判断。後ろは見えないので BACK は使わず、その場で回る)。
        local-jev などに差し替えるときはここを置き換える"""
        if o["front"] is None or o["front"] >= WALK_CLEAR:
            return "FORWARD"
        return "LEFT" if free_side() == "left" else "RIGHT" if free_side() == "right" else (
            "LEFT" if (o["left"] or 9.0) >= (o["right"] or 9.0) else "RIGHT")

    def walk_cmd():
        """おさんぽ中の (vx, wz)。やめたら None"""
        w = st["walk"]
        if not w:
            return None
        o = obstacle_now()
        if time.monotonic() > w["until"]:
            stop_walk("time")
            return None
        if not o:
            stop_walk("camera")          # 見えないまま進まない
            return None
        if w["phase"] == "forward":
            act = walk_decide(o)
            if act == "FORWARD":
                return WALK_SPEED, 0.0
            w.update(phase="turn", dir=1.0 if act == "LEFT" else -1.0, th=st["th"])
            node.get_logger().info(f"おさんぽ: 正面 {o['front']:.2f}m に物 → {'左' if act == 'LEFT' else '右'}へ向きを変える")
        # 向きを変えている: 正面が空くまで同じ向きに回る(行ったり来たりしない)
        if o["front"] is None or o["front"] >= WALK_CLEAR + 0.1:
            w["phase"] = "forward"
            return WALK_SPEED, 0.0
        if abs(math.degrees(st["th"] - w["th"])) > WALK_TURN_MAX_DEG:
            stop_walk("blocked")
            return None
        return 0.0, WALK_TURN_SPEED * w["dir"]

    def on_turn_enable(msg):
        st["turn_enable"] = bool(msg.data)
        if not msg.data:
            st["turn"] = None
        node.get_logger().info(f"人の方を向く: {'する' if msg.data else 'しない'}")

    def turn_cmd():
        """人の方を向いている間の回る速さ [rad/s]。向き終わった・やめたら None"""
        t, p, now = st["turn"], st["person"], time.monotonic()
        if not t:
            return None
        seen = p and now - p[2] <= TURN_LOST_SEC
        if t["search"]:
            if seen and p[2] > t.get("since", 0):
                t["search"] = False      # 見つけた: ここから顔を見ながら正面に合わせる
                node.get_logger().info(f"顔を見つけた: {math.degrees(math.atan2(p[0], p[1])):+.0f}度")
            elif now > t["until"] or abs(math.degrees(st["th"] - t["th"])) >= SEARCH_MAX_DEG:
                node.get_logger().info(f"顔が見つからなかった: {t['reason']}")
                st["turn"] = None
                return None
            else:
                return SEARCH_SPEED * t["side"] * TURN_SIGN
        if now > t["until"] or not seen:
            st["turn"] = None
            return None
        angle = math.atan2(p[0], p[1])   # 右にいるほど正
        if abs(math.degrees(angle)) <= TURN_DONE_DEG:
            node.get_logger().info(f"向き終わった: {t['reason']}")
            st["turn"] = None
            return None
        wz = min(TURN_MAX, max(TURN_MIN, TURN_GAIN * abs(angle)))
        return -math.copysign(wz, angle) * TURN_SIGN   # 右にいたら右回り(angular.z は左回りが正)

    def on_test(msg):
        try:
            m = json.loads(msg.data)
            wheel, pwm = int(m["wheel"]), clamp(int(m.get("pwm", 120)), 255)
            sec = min(3.0, float(m.get("sec", 1)))
        except (ValueError, KeyError, TypeError):
            return
        if 0 <= wheel < 4:
            st["test"] = (wheel, pwm * INVERT[wheel], time.monotonic() + sec)   # 正の PWM で前へ進む向き
            node.get_logger().info(f"試し回し: {WHEELS[wheel]} PWM {pwm} {sec}秒")

    def wheel_targets():
        """cmd_vel → 4輪の速さ [パルス/秒](上から見てローラーが X 字に並ぶメカナムの付け方)"""
        if time.monotonic() - st["cmd_at"] > CMD_TIMEOUT_SEC:
            st["cmd"] = (0.0, 0.0, 0.0)
            move = move_cmd()
            turn = turn_cmd() if move is None else None
            walk = walk_cmd() if move is None and turn is None else None
            if move is not None:
                st["cmd"] = (move[0], 0.0, move[1])
            elif turn is not None:
                st["cmd"] = (0.0, 0.0, turn)
            elif walk is not None:
                st["cmd"] = (walk[0], 0.0, walk[1])
        manual = time.monotonic() - st["cmd_at"] <= CMD_TIMEOUT_SEC
        vx, vy, wz = guard_forward(*st["cmd"], "manual" if manual else "move" if st["move"] else "walk" if st["walk"] else "turn")
        if st["blocked"] and st["move"] and st["move"]["vx"] > 0:
            st["move"] = None            # 「前に来て」は止めて終わり(障害物の前で待ち続けない)
        v = (vx - vy - LXY * wz, vx + vy + LXY * wz, vx + vy - LXY * wz, vx - vy + LXY * wz)
        return [int(round(v[i] / M_PER_PULSE)) * INVERT[i] for i in range(4)]

    def tick():
        test = st["test"]
        try:
            if test and time.monotonic() < test[2]:
                pwm = [0] * 4
                pwm[test[0]] = test[1]
                res = router.call("base_pwm", pwm)
            else:
                st["test"] = None
                res = router.call("base_set", wheel_targets())
            vals = [int(s) for s in str(res).split(",")]
            pulses, fault, enc_b = vals[:4], vals[4], vals[5] if len(vals) > 5 else 0
            if not st["ok"]:
                node.get_logger().info("STM32 とつながった")
            st["ok"], st["error"] = True, ""
        except (OSError, RuntimeError, ValueError) as e:
            if st["ok"] or not st["error"]:
                node.get_logger().warn(f"STM32 とつながらない: {e}")
            st["ok"], st["error"] = False, str(e)[:120]
            router.close()
            st["last"] = None
            st["n"] += 1
            if st["n"] % STATUS_EVERY == 0:
                publish_status()
            return
        now = time.monotonic()
        dt, st["t"] = now - st["t"], now
        st["fault"], st["enc_b"] = fault, enc_b
        if st["last"] is not None and dt > 0:
            d = [(pulses[i] - st["last"][i]) * INVERT[i] * M_PER_PULSE for i in range(4)]   # 各輪の進んだ距離 [m]
            st["speed"] = [round(x / dt, 3) for x in d]
            dx = sum(d) / 4
            dy = (-d[0] + d[1] + d[2] - d[3]) / 4
            dth = (-d[0] + d[1] - d[2] + d[3]) / (4 * LXY)
            th = st["th"] + dth / 2
            st["x"] += dx * math.cos(th) - dy * math.sin(th)
            st["y"] += dx * math.sin(th) + dy * math.cos(th)
            st["th"] += dth
            o = Odometry()
            o.header.stamp = node.get_clock().now().to_msg()
            o.header.frame_id, o.child_frame_id = "odom", "base_link"
            o.pose.pose.position.x, o.pose.pose.position.y = st["x"], st["y"]
            o.pose.pose.orientation.z, o.pose.pose.orientation.w = math.sin(st["th"] / 2), math.cos(st["th"] / 2)
            o.twist.twist.linear.x, o.twist.twist.linear.y, o.twist.twist.angular.z = dx / dt, dy / dt, dth / dt
            odom_pub.publish(o)
        st["last"] = pulses
        st["n"] += 1
        if st["n"] % STATUS_EVERY == 0:
            publish_status()

    def publish_status():
        status_pub.publish(String(data=json.dumps({
            "ok": st["ok"], "error": st["error"], "speed": st["speed"],
            "fault": [WHEELS[i] for i in range(4) if st["fault"] & (1 << i)],
            "enc_b": [WHEELS[i] for i in range(4) if st["enc_b"] & (1 << i)],   # 向きを B相で読めている車輪
            "cmd": [round(c, 2) for c in st["cmd"]], "test": WHEELS[st["test"][0]] if st["test"] else None,
            "turn": st["turn"]["reason"] if st["turn"] else None, "turn_enable": st["turn_enable"],
            "move": st["move"]["action"] if st["move"] else None,
            "obstacle": st["obstacle"] if time.monotonic() - st["obstacle_at"] < OBSTACLE_STALE_SEC else None,
            "blocked": st["blocked"],
            "walk": (None if not st["walk"] else "forward" if st["walk"]["phase"] == "forward"
                     else "left" if st["walk"]["dir"] > 0 else "right"),
        }, ensure_ascii=False)))

    node.create_subscription(Twist, "/cmd_vel", on_cmd, 10)
    node.create_subscription(String, "/ritsu/base_test", on_test, 10)
    node.create_subscription(PointStamped, "/ritsu/person", on_person, 10)
    node.create_subscription(String, "/ritsu/turn", on_turn, 10)
    node.create_subscription(Bool, "/ritsu/turn_enable", on_turn_enable, 10)
    node.create_subscription(String, "/ritsu/move", on_move, 10)
    node.create_subscription(String, "/ritsu/obstacle", on_obstacle, 10)
    node.create_subscription(String, "/ritsu/walk", on_walk, 10)
    node.create_timer(1.0 / RATE_HZ, tick)
    node.get_logger().info(f"台車: 車輪 直径{WHEEL_R * 2:.3f}m 向き{INVERT} 最大 {MAX_LINEAR}m/s {MAX_ANGULAR}rad/s "
                           f"ソケット {ROUTER_SOCK} 人の方を向く {'する' if TURN_ENABLE else 'しない'}(最大 {TURN_MAX}rad/s)")
    try:
        rclpy.spin(node)
    except (KeyboardInterrupt, Exception):
        pass
    finally:
        try:
            router.call("base_set", [0, 0, 0, 0])
        except Exception:
            pass


if __name__ == "__main__":
    main()
