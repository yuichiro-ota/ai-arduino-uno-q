#!/usr/bin/env python3
"""
ritsu_memory.py — 律の記憶と反応の記録 ROS 2 ノード

画面の律(ブラウザ)は再読み込みすると忘れてしまうので、覚えておくこと・反応の記録をこのノードがファイルに残す。
画像や音声は扱わない。会話の中身は、律が LLM で1文にまとめた要約だけを memory.json に残す。

購読トピック:
  /ritsu/memory_put  std_msgs/String  JSON {"key":"today"|"master", "value":{...}}  覚えていることを書き換える
  /ritsu/log         std_msgs/String  JSON {"type":"arrive"|"leave"|"react"|"outcome"|..., ...}  反応の記録
                     日付ごとに DATA_DIR/log/YYYY-MM-DD.jsonl へ追記する
発行トピック:
  /ritsu/memory      std_msgs/String  JSON {"today":{...}, "master":{...}, "stats":{...}}
                     書き換えたとき+5秒ごと。stats は直近 LEARN_DAYS 日の反応の結果
                     {"反応": {"やり方": [回数, 結果の合計]}} (律が反応のやり方を選ぶのに使う)

環境変数:
  DATA_DIR    保存先 (default /data)
  LEARN_DAYS  反応の結果を集計する日数 (default 30)
"""
import glob
import json
import os
from datetime import date, datetime, timedelta

import rclpy
from std_msgs.msg import String

DATA_DIR = os.environ.get("DATA_DIR", "/data")
LEARN_DAYS = int(os.environ.get("LEARN_DAYS", "30"))
MEMORY_PATH = os.path.join(DATA_DIR, "memory.json")
LOG_DIR = os.path.join(DATA_DIR, "log")
KEYS = ("today", "master")           # memory_put で書き換えてよい項目
MAX_VALUE_BYTES = 20000              # 1項目の大きさの上限(壊れた送信でファイルが膨らまないように)
PUBLISH_EVERY_SEC = 5
REPORT_EVERY_SEC = 600               # 反応の結果をログへ出す間隔


def load_memory():
    try:
        with open(MEMORY_PATH, encoding="utf-8") as f:
            m = json.load(f)
            return {k: m[k] for k in KEYS if k in m}
    except FileNotFoundError:
        return {}
    except (OSError, ValueError) as e:
        print(f"[memory] load error: {e}", flush=True)
        return {}


def save_memory(memory):
    os.makedirs(DATA_DIR, exist_ok=True)
    tmp = MEMORY_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(memory, f, ensure_ascii=False, indent=1)
    os.replace(tmp, MEMORY_PATH)


def add_outcome(stats, e):
    arms = stats.setdefault(str(e["reaction"]), {})
    n, total = arms.get(str(e["arm"]), [0, 0.0])
    arms[str(e["arm"])] = [n + 1, round(total + max(0.0, min(1.0, float(e["reward"]))), 4)]


def load_stats():
    """直近 LEARN_DAYS 日の記録から、反応のやり方ごとの結果を集計する"""
    stats = {}
    since = (date.today() - timedelta(days=LEARN_DAYS)).isoformat()
    for path in sorted(glob.glob(os.path.join(LOG_DIR, "*.jsonl"))):
        if os.path.basename(path)[:10] < since:
            continue
        with open(path, encoding="utf-8") as f:
            for line in f:
                try:
                    e = json.loads(line)
                    if e.get("type") == "outcome":
                        add_outcome(stats, e)
                except (ValueError, KeyError, TypeError):
                    pass
    return stats


def main():
    rclpy.init()
    node = rclpy.create_node("ritsu_memory")
    pub = node.create_publisher(String, "/ritsu/memory", 10)
    memory = load_memory()
    stats = load_stats()
    print(f"[memory] loaded: {list(memory)} / stats {json.dumps(stats, ensure_ascii=False)}", flush=True)

    def publish():
        pub.publish(String(data=json.dumps({**memory, "stats": stats}, ensure_ascii=False)))

    def on_put(msg):
        try:
            m = json.loads(msg.data)
            key, value = m["key"], m["value"]
        except (ValueError, KeyError, TypeError):
            return
        if key not in KEYS or len(json.dumps(value, ensure_ascii=False).encode()) > MAX_VALUE_BYTES:
            print(f"[memory] rejected put: {str(key)[:20]}", flush=True)
            return
        memory[key] = value
        save_memory(memory)
        publish()

    def on_log(msg):
        try:
            e = json.loads(msg.data)
            if not isinstance(e, dict) or len(msg.data) > 4000:
                return
        except ValueError:
            return
        e["ts"] = datetime.now().isoformat(timespec="seconds")
        os.makedirs(LOG_DIR, exist_ok=True)
        with open(os.path.join(LOG_DIR, f"{date.today().isoformat()}.jsonl"), "a", encoding="utf-8") as f:
            f.write(json.dumps(e, ensure_ascii=False) + "\n")
        if e.get("type") == "outcome":
            try:
                add_outcome(stats, e)
            except (KeyError, TypeError, ValueError):
                pass

    def report():
        lines = []
        for reaction, arms in sorted(stats.items()):
            parts = [f"{arm} {n}回 平均{total / n:.2f}" for arm, (n, total) in sorted(arms.items()) if n]
            lines.append(f"{reaction}: " + " / ".join(parts))
        print("[memory] 反応の結果(直近%d日): %s" % (LEARN_DAYS, "; ".join(lines) or "まだ無し"), flush=True)

    node.create_subscription(String, "/ritsu/memory_put", on_put, 10)
    node.create_subscription(String, "/ritsu/log", on_log, 10)
    node.create_timer(PUBLISH_EVERY_SEC, publish)
    node.create_timer(REPORT_EVERY_SEC, report)
    report()
    try:
        rclpy.spin(node)
    except (KeyboardInterrupt, Exception):
        pass


if __name__ == "__main__":
    main()
