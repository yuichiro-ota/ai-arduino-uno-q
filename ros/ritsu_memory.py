#!/usr/bin/env python3
"""
ritsu_memory.py — 律の記憶と反応の記録 ROS 2 ノード

画面の律(ブラウザ)は再読み込みすると忘れてしまうので、覚えておくこと・反応の記録をこのノードがファイルに残す。
画像や音声は扱わない。会話の中身は、律が LLM で1文にまとめた要約だけを memory.json に残す。
最近のニュースの見出し(Yahoo!ニュース・トピックスの RSS)も定期的に取ってきて、律の話題として渡す。
事件・事故などの暗い見出しは NEWS_BLOCK の言葉で除く。

購読トピック:
  /ritsu/memory_put  std_msgs/String  JSON {"key":"today"|"master"|"persona"|"knowledge", "value":{...}}  覚えていることを書き換える
  /ritsu/log         std_msgs/String  JSON {"type":"arrive"|"leave"|"react"|"outcome"|..., ...}  反応の記録
                     日付ごとに DATA_DIR/log/YYYY-MM-DD.jsonl へ追記する
  memory.json は保存のたびに DATA_DIR/backup/memory-YYYY-MM-DD.json にも控えを残し(BACKUP_DAYS 日分)、
  起動時に memory.json が壊れていたら一番新しい控えから戻す
発行トピック:
  /ritsu/memory      std_msgs/String  JSON {"today":{...}, "master":{...}, "persona":{...}, "knowledge":{...}, "stats":{...}, "news":{...}}
                     書き換えたとき+5秒ごと。stats は直近 LEARN_DAYS 日の反応の結果
                     {"反応": {"やり方": [回数, 結果の合計]}} (律が反応のやり方を選ぶのに使う)
                     news は {"items":[{"title":"...","cat":"エンタメ"}], "at":"取得時刻"}

環境変数:
  DATA_DIR    保存先 (default /data)
  LEARN_DAYS  反応の結果を集計する日数 (default 30)
  NEWS_FEEDS  ニュースの種類(Yahoo!ニュース・トピックスの RSS 名をカンマ区切り。空にすると取らない)
              (default top-picks,entertainment,sports,science,it)
  NEWS_REFRESH_MIN  ニュースを取りに行く間隔[分] (default 30)
"""
import glob
import json
import os
import threading
import urllib.request
import xml.etree.ElementTree as ET
from datetime import date, datetime, timedelta

import rclpy
from std_msgs.msg import String

DATA_DIR = os.environ.get("DATA_DIR", "/data")
LEARN_DAYS = int(os.environ.get("LEARN_DAYS", "30"))
MEMORY_PATH = os.path.join(DATA_DIR, "memory.json")
LOG_DIR = os.path.join(DATA_DIR, "log")
BACKUP_DIR = os.path.join(DATA_DIR, "backup")   # memory.json の日ごとの控え(壊れたときに戻す)
BACKUP_DAYS = 14
KEYS = ("today", "master", "persona", "knowledge")   # memory_put で書き換えてよい項目
#   persona: 律が自分について話したこと / knowledge: 教えてもらった言葉
MAX_VALUE_BYTES = 20000              # 1項目の大きさの上限(壊れた送信でファイルが膨らまないように)
PUBLISH_EVERY_SEC = 5
REPORT_EVERY_SEC = 600               # 反応の結果をログへ出す間隔
NEWS_FEEDS = [f.strip() for f in os.environ.get("NEWS_FEEDS", "top-picks,entertainment,sports,science,it").split(",")
              if f.strip()]
NEWS_REFRESH_MIN = float(os.environ.get("NEWS_REFRESH_MIN", "30"))
NEWS_URL = "https://news.yahoo.co.jp/rss/topics/{}.xml"
NEWS_CAT = {"top-picks": "主要", "domestic": "国内", "world": "国際", "business": "経済", "entertainment": "エンタメ",
            "sports": "スポーツ", "it": "IT", "science": "科学", "local": "地域"}
NEWS_PER_FEED = 4                    # 1つの種類から使う見出しの数
# 律が明るく話題にしにくい見出し(事件・事故・災害・訃報など)はこの言葉を含んだら除く
NEWS_BLOCK = ("死", "亡", "殺", "事故", "衝突", "逮捕", "容疑", "被害", "被告", "遺族", "刺", "重傷", "けが", "負傷",
              "搬送", "中毒", "転覆", "火災", "火事", "墜落", "地震", "津波", "噴火", "不正", "詐欺", "侵入", "戦",
              "攻撃", "ミサイル", "テロ", "虐待", "暴行", "性的", "わいせつ", "不倫", "離婚", "訃報", "自殺", "行方不明",
              "クマ", "感染", "判決", "起訴", "書類送検", "炎上", "批判", "謝罪", "流出", "漏えい", "漏洩", "関与",
              "サイバー")


def _read(path):
    with open(path, encoding="utf-8") as f:
        m = json.load(f)
    return {k: m[k] for k in KEYS if k in m}


def load_memory():
    """memory.json が壊れていたら(電源が急に切れたときなど)、その日ごとの控えのうち一番新しいものから戻す"""
    try:
        return _read(MEMORY_PATH)
    except FileNotFoundError:
        pass
    except (OSError, ValueError) as e:
        broken = f"{MEMORY_PATH}.broken-{datetime.now():%Y%m%d-%H%M%S}"
        print(f"[memory] memory.json が読めない({e})。{broken} に移して控えから戻す", flush=True)
        try:
            os.replace(MEMORY_PATH, broken)
        except OSError:
            pass
    for path in sorted(glob.glob(os.path.join(BACKUP_DIR, "memory-*.json")), reverse=True):
        try:
            m = _read(path)
            print(f"[memory] 控え {os.path.basename(path)} から戻した", flush=True)
            return m
        except (OSError, ValueError):
            continue
    return {}


def save_memory(memory):
    """書き終わってから入れ替え(fsync で、電源が急に切れても中身が空にならないように)、その日の控えも残す"""
    os.makedirs(BACKUP_DIR, exist_ok=True)
    data = json.dumps(memory, ensure_ascii=False, indent=1)
    for path in (MEMORY_PATH, os.path.join(BACKUP_DIR, f"memory-{date.today().isoformat()}.json")):
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
    for old in sorted(glob.glob(os.path.join(BACKUP_DIR, "memory-*.json")))[:-BACKUP_DAYS]:
        os.remove(old)


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


def fetch_news():
    """NEWS_FEEDS の見出しを取ってくる。暗い見出しと重複は除く。取れなければ None"""
    items, seen = [], set()
    for feed in NEWS_FEEDS:
        try:
            req = urllib.request.Request(NEWS_URL.format(feed), headers={"User-Agent": "ritsu-memory/1.0"})
            with urllib.request.urlopen(req, timeout=10) as res:
                channel = ET.fromstring(res.read()).find("channel")
        except Exception as e:   # ネットワーク・形式の異常は、その種類だけ飛ばす
            print(f"[memory] news {feed}: {e}", flush=True)
            continue
        n = 0
        for item in channel.findall("item") if channel is not None else []:
            title = (item.findtext("title") or "").strip()
            if not title or title in seen or any(w in title for w in NEWS_BLOCK):
                continue
            seen.add(title)
            items.append({"title": title, "cat": NEWS_CAT.get(feed, feed)})
            n += 1
            if n >= NEWS_PER_FEED:
                break
    return items or None


def main():
    rclpy.init()
    node = rclpy.create_node("ritsu_memory")
    pub = node.create_publisher(String, "/ritsu/memory", 10)
    memory = load_memory()
    stats = load_stats()
    print(f"[memory] loaded: {list(memory)} / stats {json.dumps(stats, ensure_ascii=False)}", flush=True)

    news = {}

    def publish():
        pub.publish(String(data=json.dumps({**memory, "stats": stats, **({"news": news} if news else {})},
                                           ensure_ascii=False)))

    def refresh_news():
        items = fetch_news()
        if items:
            news.update(items=items, at=datetime.now().isoformat(timespec="minutes"))
            print(f"[memory] news: {len(items)} 件 ({' / '.join(i['title'] for i in items[:3])} ...)", flush=True)

    def start_news():   # 取りに行く間も記憶の配信を止めないよう別スレッドで
        threading.Thread(target=refresh_news, daemon=True).start()

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
    if NEWS_FEEDS:
        start_news()
        node.create_timer(NEWS_REFRESH_MIN * 60, start_news)
    try:
        rclpy.spin(node)
    except (KeyboardInterrupt, Exception):
        pass


if __name__ == "__main__":
    main()
