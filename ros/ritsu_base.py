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
発行トピック:
  /odom             nav_msgs/Odometry  frame odom / child base_link
  /ritsu/base_status  std_msgs/String  JSON {"ok":bool, "error":"...", "fault":[...], "speed":[4輪 m/s], "cmd":[vx,vy,wz]}

環境変数:
  ROUTER_SOCK     arduino-router のソケット (default /var/run/arduino-router.sock)
  WHEEL_DIAMETER  車輪の直径 [m] (default 0.08)
  WHEEL_LX        車体の中心から前輪・後輪の軸までの距離 [m] (default 0.10)
  WHEEL_LY        車体の中心から左右の車輪までの距離 [m] (default 0.12)
  WHEEL_INVERT    向きが逆の車輪を 1 に。左前,右前,左後,右後 (default 0,1,0,1: 右側は鏡写しに付くため)
  PULSES_PER_REV  車輪1回転のパルス数 (default 440 = 11ライン × 減速1:40、A相の立ち上がり)
  MAX_LINEAR      [m/s] (default 0.3)   MAX_ANGULAR [rad/s] (default 1.2)
"""
import json
import math
import os
import socket
import time

import msgpack
import rclpy
from geometry_msgs.msg import Twist
from nav_msgs.msg import Odometry
from std_msgs.msg import String

ROUTER_SOCK = os.environ.get("ROUTER_SOCK", "/var/run/arduino-router.sock")
WHEEL_R = float(os.environ.get("WHEEL_DIAMETER", "0.08")) / 2
LXY = float(os.environ.get("WHEEL_LX", "0.10")) + float(os.environ.get("WHEEL_LY", "0.12"))
INVERT = [-1 if s.strip() == "1" else 1 for s in os.environ.get("WHEEL_INVERT", "0,1,0,1").split(",")][:4]
PPR = float(os.environ.get("PULSES_PER_REV", "440"))
MAX_LINEAR = float(os.environ.get("MAX_LINEAR", "0.3"))
MAX_ANGULAR = float(os.environ.get("MAX_ANGULAR", "1.2"))
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
    router = Router(ROUTER_SOCK)
    st = {"cmd": (0.0, 0.0, 0.0), "cmd_at": 0.0, "test": None, "last": None, "x": 0.0, "y": 0.0, "th": 0.0,
          "speed": [0.0] * 4, "fault": 0, "ok": False, "error": "", "n": 0, "t": time.monotonic()}

    def on_cmd(msg):
        st["cmd"] = (clamp(msg.linear.x, MAX_LINEAR), clamp(msg.linear.y, MAX_LINEAR), clamp(msg.angular.z, MAX_ANGULAR))
        st["cmd_at"] = time.monotonic()
        st["test"] = None

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
        vx, vy, wz = st["cmd"]
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
            *pulses, fault = [int(s) for s in str(res).split(",")]
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
        st["fault"] = fault
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
            "cmd": [round(c, 2) for c in st["cmd"]], "test": WHEELS[st["test"][0]] if st["test"] else None,
        }, ensure_ascii=False)))

    node.create_subscription(Twist, "/cmd_vel", on_cmd, 10)
    node.create_subscription(String, "/ritsu/base_test", on_test, 10)
    node.create_timer(1.0 / RATE_HZ, tick)
    node.get_logger().info(f"台車: 車輪 直径{WHEEL_R * 2:.3f}m 向き{INVERT} 最大 {MAX_LINEAR}m/s {MAX_ANGULAR}rad/s "
                           f"ソケット {ROUTER_SOCK}")
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
