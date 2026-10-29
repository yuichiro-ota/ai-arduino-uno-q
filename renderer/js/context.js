/* =========================================================================
 * context.js — 会話を自然にするための「今の状況」
 *   日時・時間帯・季節・平日/土日/祝日・季節の行事と、カメラ前の人の有無・距離をまとめる。
 *   brain.js が LLM へのシステムプロンプトと独り言の選択に使う。
 * ========================================================================= */

/* ---- 日本の祝日(振替休日・国民の休日を含む。特例の年は扱わない) ---- */
const RitsuHoliday = (() => {
  const cache = {};
  const key = (m, d) => `${m}-${d}`;
  const nthMonday = (y, m, n) => {           // m: 1-12
    const first = new Date(y, m - 1, 1).getDay();
    return 1 + ((8 - first) % 7) + (n - 1) * 7;
  };
  function build(y) {
    const h = {};
    const add = (m, d, name) => { h[key(m, d)] = name; };
    add(1, 1, '元日');
    add(1, nthMonday(y, 1, 2), '成人の日');
    add(2, 11, '建国記念の日');
    add(2, 23, '天皇誕生日');
    const k = y - 1980, leap = Math.floor(k / 4);
    add(3, Math.floor(20.8431 + 0.242194 * k - leap), '春分の日');
    add(4, 29, '昭和の日');
    add(5, 3, '憲法記念日');
    add(5, 4, 'みどりの日');
    add(5, 5, 'こどもの日');
    add(7, nthMonday(y, 7, 3), '海の日');
    add(8, 11, '山の日');
    add(9, nthMonday(y, 9, 3), '敬老の日');
    add(9, Math.floor(23.2488 + 0.242194 * k - leap), '秋分の日');
    add(10, nthMonday(y, 10, 2), 'スポーツの日');
    add(11, 3, '文化の日');
    add(11, 23, '勤労感謝の日');
    // 振替休日: 祝日が日曜なら、その後の最初の祝日でない日
    for (const kk of Object.keys(h)) {
      const [m, d] = kk.split('-').map(Number);
      const dt = new Date(y, m - 1, d);
      if (dt.getDay() !== 0) continue;
      do dt.setDate(dt.getDate() + 1); while (h[key(dt.getMonth() + 1, dt.getDate())]);
      if (dt.getFullYear() === y) h[key(dt.getMonth() + 1, dt.getDate())] = '振替休日';
    }
    // 国民の休日: 前後を祝日に挟まれた平日
    for (let dt = new Date(y, 0, 2); dt.getFullYear() === y; dt.setDate(dt.getDate() + 1)) {
      const prev = new Date(dt), next = new Date(dt);
      prev.setDate(dt.getDate() - 1); next.setDate(dt.getDate() + 1);
      if (!h[key(dt.getMonth() + 1, dt.getDate())] && dt.getDay() !== 0 &&
          h[key(prev.getMonth() + 1, prev.getDate())] && h[key(next.getMonth() + 1, next.getDate())])
        h[key(dt.getMonth() + 1, dt.getDate())] = '国民の休日';
    }
    return h;
  }
  return {
    /** 祝日名 or null */
    name(date) {
      const y = date.getFullYear();
      if (!cache[y]) cache[y] = build(y);
      return cache[y][key(date.getMonth() + 1, date.getDate())] || null;
    },
  };
})();

/* ---- 季節の行事(その日付の前後に話題にしてよいもの) ---- */
const SEASON_EVENTS = [
  // [開始月, 開始日, 終了月, 終了日, 名前]
  [1, 1, 1, 7, 'お正月'],
  [2, 1, 2, 3, '節分'],
  [2, 7, 2, 14, 'バレンタイン'],
  [3, 1, 3, 3, 'ひな祭り'],
  [3, 25, 4, 10, 'お花見の季節'],
  [4, 29, 5, 6, 'ゴールデンウィーク'],
  [6, 10, 7, 15, '梅雨'],
  [7, 1, 7, 7, '七夕'],
  [8, 13, 8, 16, 'お盆'],
  [9, 15, 9, 30, 'お月見'],
  [10, 20, 10, 31, 'ハロウィン'],
  [12, 15, 12, 25, 'クリスマス'],
  [12, 26, 12, 31, '年末'],
];

const DISTANCE = { NEAR: 0.7, FAR: 1.8 };   // [m] これより近い/遠い

class RitsuContext {
  constructor() {
    this.personZ = null;            // 最後に見えた顔までの距離 [m]
    this.personLastSeen = -Infinity;
    this.personSince = null;        // 今回見え始めた時刻(いなくなったら null)
    this.listeners = { arrive: [], leave: [], near: [] };
    this._nearNotified = false;
    setInterval(() => this._checkLeave(), 1000);
  }

  on(ev, cb) { this.listeners[ev].push(cb); }
  _emit(ev, ...a) { for (const cb of this.listeners[ev]) cb(...a); }

  /* ---- カメラ(ROS 2 の /ritsu/person から呼ばれる) ---- */
  onPerson(z) {
    const now = performance.now();
    const absent = now - this.personLastSeen;
    this.personZ = z;
    this.personLastSeen = now;
    if (this.personSince === null) {
      this.personSince = now;
      this._nearNotified = false;
      this._emit('arrive', absent / 1000);   // 前回いなくなってからの秒数
    }
    if (z < DISTANCE.NEAR && !this._nearNotified) {
      this._nearNotified = true;
      this._emit('near', z);
    } else if (z > DISTANCE.NEAR + 0.2) {
      this._nearNotified = false;
    }
  }

  /** 顔を見失ってから LEAVE_SEC 秒で「いなくなった」とみなす(横を向いた等の一瞬の見失いは無視) */
  _checkLeave() {
    const LEAVE_SEC = 8;
    if (this.personSince === null) return;
    const now = performance.now();
    if (now - this.personLastSeen < LEAVE_SEC * 1000) return;
    const stayed = (this.personLastSeen - this.personSince) / 1000;
    this.personSince = null;
    this._emit('leave', stayed);
  }

  get personPresent() { return this.personSince !== null && performance.now() - this.personLastSeen < 2000; }

  /** 'near' | 'mid' | 'far' | null */
  get personDistance() {
    if (!this.personPresent) return null;
    return this.personZ < DISTANCE.NEAR ? 'near' : this.personZ > DISTANCE.FAR ? 'far' : 'mid';
  }

  /* ---- 日時 ---- */
  /** 時間帯 'earlyMorning' | 'morning' | 'noon' | 'afternoon' | 'evening' | 'night' | 'lateNight' */
  timeOfDay(d = new Date()) {
    const h = d.getHours();
    if (h < 4) return 'lateNight';
    if (h < 7) return 'earlyMorning';
    if (h < 11) return 'morning';
    if (h < 14) return 'noon';
    if (h < 17) return 'afternoon';
    if (h < 19) return 'evening';
    if (h < 23) return 'night';
    return 'lateNight';
  }

  season(d = new Date()) {
    const m = d.getMonth() + 1;
    return m >= 3 && m <= 5 ? 'spring' : m >= 6 && m <= 8 ? 'summer' : m >= 9 && m <= 11 ? 'autumn' : 'winter';
  }

  /** 'holiday'(祝日) | 'weekend'(土日) | 'weekday' */
  dayType(d = new Date()) {
    if (RitsuHoliday.name(d)) return 'holiday';
    const w = d.getDay();
    return w === 0 || w === 6 ? 'weekend' : 'weekday';
  }

  events(d = new Date()) {
    const md = (d.getMonth() + 1) * 100 + d.getDate();
    return SEASON_EVENTS.filter(([m1, d1, m2, d2]) => md >= m1 * 100 + d1 && md <= m2 * 100 + d2)
                        .map(e => e[4]);
  }

  /** LLM のシステムプロンプトに入れる「今の状況」 */
  describe(d = new Date()) {
    const W = '日月火水木金土';
    const TOD = { lateNight: '深夜', earlyMorning: '早朝', morning: '朝', noon: '昼',
                  afternoon: '午後', evening: '夕方', night: '夜' };
    const SEASON = { spring: '春', summer: '夏', autumn: '秋', winter: '冬' };
    const holiday = RitsuHoliday.name(d);
    const type = this.dayType(d);
    const dayText = type === 'holiday' ? `祝日(${holiday})` : type === 'weekend' ? '週末のお休み' : '平日';
    const lines = [
      `日時: ${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日(${W[d.getDay()]}) ` +
      `${d.getHours()}時${String(d.getMinutes()).padStart(2, '0')}分 / ${TOD[this.timeOfDay(d)]}`,
      `季節: ${SEASON[this.season(d)]} / ${dayText}`,
    ];
    // 行事は期間の終わりの日付も付ける(前日なのに「今日はハロウィン」と言わないように)
    const md = (d.getMonth() + 1) * 100 + d.getDate();
    const ev = SEASON_EVENTS.filter(([m1, d1, m2, d2]) => md >= m1 * 100 + d1 && md <= m2 * 100 + d2)
                            .map(([, , m2, d2, name]) => md === m2 * 100 + d2 ? `${name}(今日まで)` : `${name}(${m2}月${d2}日まで)`);
    if (ev.length) lines.push(`季節の話題: ${ev.join('、')}`);
    if (this.personPresent) {
      const DIST = { near: 'すぐ目の前(とても近い)', mid: '話しやすい距離', far: '少し離れたところ' };
      const sec = Math.round((performance.now() - this.personSince) / 1000);
      const stay = sec < 10 ? '今来たところで' : sec < 60 ? `${sec}秒前から` : `${Math.round(sec / 60)}分前から`;
      lines.push(`目の前の人: ${DIST[this.personDistance]}(約${this.personZ.toFixed(1)}m)にいる。${stay}見えている`);
    } else {
      lines.push('目の前の人: カメラには誰も映っていない(画面の向こうから話しかけられている)');
    }
    return lines.join('\n');
  }
}
window.RitsuContext = RitsuContext;
window.RitsuHoliday = RitsuHoliday;
