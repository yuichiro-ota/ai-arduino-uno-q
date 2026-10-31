/* =========================================================================
 * context.js — 会話を自然にするための「今の状況」
 *   日時・時間帯・季節・平日/土日/祝日・季節の行事・天気と、カメラ前の人の有無・距離をまとめる。
 *   天気は Open-Meteo (APIキー不要) から定期的に取得する。取れないときは天気の話をしない。
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
const APPROACH_SPEED = 0.35;   // [m/s] これより速く近づいたら「近づいてくる」
const EDGE_XN = 0.45;          // |x/z| がこれより大きい位置で見失ったら画面の端から去った(約24度)

/* ---- 天気 (WMO 天気コード → 日本語・種類) ---- */
function weatherName(code) {
  const t = [[0, '快晴', 'clear'], [1, '晴れ', 'clear'], [2, '晴れ時々くもり', 'cloudy'], [3, 'くもり', 'cloudy'],
             [48, '霧', 'fog'], [57, '霧雨', 'rain'], [61, '小雨', 'rain'], [63, '雨', 'rain'], [67, '強い雨', 'rain'],
             [71, '小雪', 'snow'], [75, '雪', 'snow'], [77, '雪', 'snow'], [81, 'にわか雨', 'rain'],
             [82, '激しいにわか雨', 'rain'], [86, 'にわか雪', 'snow'], [99, '雷雨', 'storm']];
  const hit = t.find(([max]) => code <= max) || t[t.length - 1];
  return { text: hit[1], kind: hit[2] };
}
const WEATHER_STALE_MIN = 120;   // これより古い天気は使わない

class RitsuContext {
  /** weather: { lat, lon, place, refreshMin } を渡すと天気を取得する(lat が無ければ取得しない) */
  constructor({ weather } = {}) {
    this.weather = null;            // { text, kind, temp, feels, max, min, rainProb, rainSoon, at }
    this.news = [];                 // 最近のニュースの見出し [{title, cat}] (memory ノードが Yahoo!ニュースから取る)
    if (weather && weather.lat != null) this._startWeather(weather);
    this.personZ = null;            // 最後に見えた顔までの距離 [m]
    this.personXn = 0;              // 最後に見えた顔の左右の位置 x/z (カメラから見て右が+)
    this.personLastSeen = -Infinity;
    this.personSince = null;        // 今回見え始めた時刻(いなくなったら null)
    this.looking = false;           // 顔がこちらを向いているか (/ritsu/looking)
    this.lookedAt = -Infinity;      // 最後にこちらを向いた時刻
    this.visit = null;              // 今回の来訪 { id, looked, approached, master }
    this.visitCount = 0;
    this.identity = '';             // 顔で見分けた相手 'master' | '' (/ritsu/person_id)
    this.idSeenAt = -Infinity;      // 最後に /ritsu/person_id が届いた時刻(顔の見分けが動いているか)
    this.listeners = { arrive: [], leave: [], near: [], look: [], approach: [], touch: [], identify: [] };
    this._nearNotified = false;
    this._track = [];               // 直近の [時刻, z, xn] (近づく速さ・去った方向用)
    this._handSince = null;         // 画面のすぐ前に手が来た時刻
    this._handLast = -Infinity;
    setInterval(() => this._checkLeave(), 250);
  }

  on(ev, cb) { this.listeners[ev].push(cb); }
  _emit(ev, ...a) { for (const cb of this.listeners[ev]) cb(...a); }

  /* ---- カメラ(ROS 2 の /ritsu/person から呼ばれる)。xn = x/z ---- */
  onPerson(z, xn = 0) {
    const now = performance.now();
    const absent = now - this.personLastSeen;
    this.personZ = z;
    this.personXn = xn;
    this.personLastSeen = now;
    this._track.push([now, z, xn]);
    while (this._track.length && now - this._track[0][0] > 1500) this._track.shift();
    if (this.personSince === null) {
      this.personSince = now;
      this._nearNotified = false;
      this.visit = { id: ++this.visitCount, looked: false, approached: false, master: this.identity === 'master' };
      this._track = [[now, z, xn]];
      this._emit('arrive', absent / 1000);   // 前回いなくなってからの秒数
      if (this.looking) this._onLookStart();
    }
    if (z < DISTANCE.NEAR && !this._nearNotified) {
      this._nearNotified = true;
      this._emit('near', z);
    } else if (z > DISTANCE.NEAR + 0.2) {
      this._nearNotified = false;
    }
    // ① 近づいてくる: 直近1秒ほどで APPROACH_SPEED [m/s] より速く近づいた(来訪ごとに1回)
    const old = this._track.find(([t]) => now - t >= 700);
    if (old && !this.visit.approached && z > DISTANCE.NEAR && z < 2.8) {
      const speed = (old[1] - z) / ((now - old[0]) / 1000);
      if (speed > APPROACH_SPEED) {
        this.visit.approached = true;
        this._emit('approach', z);
      }
    }
  }

  /** ⑤ 顔がこちらを向いているか (/ritsu/looking から呼ばれる) */
  onLooking(on) {
    const was = this.looking;
    this.looking = on;
    if (on && !was) this._onLookStart();
  }
  _onLookStart() {
    this.lookedAt = performance.now();
    if (!this.personPresent) return;      // 人の位置がまだ届いていない(届いたら onPerson から呼ばれる)
    const first = !this.visit.looked;
    this.visit.looked = true;
    this._emit('look', first);
  }
  /** 直近 sec 秒以内にこちらを向いたか */
  lookedWithin(sec) { return this.looking || performance.now() - this.lookedAt < sec * 1000; }

  /** 顔で見分けた相手 (/ritsu/person_id から呼ばれる)。来訪中に初めてマスターと分かったら知らせる */
  onIdentity(id) {
    this.idSeenAt = performance.now();
    this.identity = id === 'master' ? 'master' : '';
    if (this.identity && this.visit && !this.visit.master) {
      this.visit.master = true;
      this._emit('identify', this.identity);
    }
  }
  /** 顔の見分けが動いているか(マスターの顔が登録されていて、カメラのノードから通知が来ている) */
  get recognizerAlive() { return performance.now() - this.idSeenAt < 5000; }
  /** 目の前の人がマスターか */
  get isMaster() { return this.personPresent && this.identity === 'master'; }

  /** ③ 画面のすぐ前の手 (/ritsu/hand_near から呼ばれる)。xn = x/z, yn = y/z(下が+)。
   *  0.3秒続いたら1回だけ、画面上の左右と手の位置を知らせる */
  onHand(xn, yn = 0) {
    const now = performance.now();
    if (now - this._handLast > 600) this._handSince = now;     // 途切れたら数え直し
    this._handLast = now;
    if (this._handSince !== null && now - this._handSince > 300) {
      this._handSince = null;                                   // 手を離すまで次は知らせない
      this._emit('touch', xn > 0 ? -1 : 1, { xn, yn });         // 画面上の左右(カメラの右 = 画面の左)
    }
  }

  /** ② 去った: 画面の端で見失ったらすぐ、遠ざかりながら見失ったら少し待って、それ以外は LEAVE_SEC 秒で。
   *  去った方向(画面上の左右 -1/1、分からなければ 0)も知らせる */
  _checkLeave() {
    const LEAVE_SEC = 8;
    if (this.personSince === null) return;
    const now = performance.now();
    const lost = (now - this.personLastSeen) / 1000;
    if (lost < 0.8) return;
    const tr = this._track;
    const first = tr[0], last = tr[tr.length - 1];
    const dt = last && first ? (last[0] - first[0]) / 1000 : 0;
    const edge = last && Math.abs(last[2]) > EDGE_XN;
    const receding = dt > 0.3 && (last[1] - first[1]) / dt > 0.2;   // 0.2 m/s 以上で遠ざかっていた
    if (!(edge || (receding && lost > 2.5) || lost > LEAVE_SEC)) return;
    const dir = last && Math.abs(last[2]) > 0.15 ? (last[2] > 0 ? -1 : 1) : 0;
    const stayed = (this.personLastSeen - this.personSince) / 1000;
    const visit = this.visit;
    this.personSince = null;
    this.visit = null;
    this._emit('leave', stayed, dir, visit);
  }

  /* ---- 天気 ---- */
  _startWeather({ lat, lon, place, refreshMin = 20 }) {
    this.weatherPlace = place || '';
    const url = 'https://api.open-meteo.com/v1/forecast?' + new URLSearchParams({
      latitude: lat, longitude: lon, timezone: 'Asia/Tokyo', forecast_days: 1,
      current: 'temperature_2m,apparent_temperature,weather_code',
      daily: 'temperature_2m_max,temperature_2m_min,precipitation_probability_max',
      hourly: 'precipitation_probability',
    });
    const load = async () => {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const j = await res.json();
        const w = weatherName(j.current.weather_code);
        // この先3時間の降水確率の最大
        const i = j.hourly.time.indexOf(j.current.time.slice(0, 13) + ':00');
        const next = i >= 0 ? j.hourly.precipitation_probability.slice(i + 1, i + 4) : [];
        this.weather = {
          ...w, temp: j.current.temperature_2m, feels: j.current.apparent_temperature,
          max: j.daily.temperature_2m_max[0], min: j.daily.temperature_2m_min[0],
          rainProb: j.daily.precipitation_probability_max[0],
          rainSoon: !['rain', 'snow', 'storm'].includes(w.kind) && next.some(p => p >= 50),
          at: Date.now(),
        };
      } catch (e) {
        console.warn('[context] weather error:', e);
      }
    };
    load();
    setInterval(load, refreshMin * 60000);
  }

  /** 新しい天気だけ返す(取得できない・古いときは null) */
  get currentWeather() {
    const w = this.weather;
    return w && Date.now() - w.at < WEATHER_STALE_MIN * 60000 ? w : null;
  }

  get personPresent() { return this.personSince !== null && performance.now() - this.personLastSeen < 2000; }

  get visitSec() { return this.personSince === null ? 0 : (performance.now() - this.personSince) / 1000; }

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
    const w = this.currentWeather;
    if (w) {
      const r = n => Math.round(n);
      lines.push(`天気${this.weatherPlace ? `(${this.weatherPlace})` : ''}: ${w.text} ${r(w.temp)}℃(体感${r(w.feels)}℃) / ` +
                 `今日の最高${r(w.max)}℃・最低${r(w.min)}℃ / 降水確率${w.rainProb}%` +
                 (w.rainSoon ? ' / この後3時間以内に雨が降りそう' : ''));
    }
    if (this.news.length) {
      lines.push(`最近のニュースの見出し: ${this.news.slice(0, 6).map(n => `${n.title}(${n.cat})`).join(' / ')}`);
    }
    if (this.personPresent) {
      const DIST = { near: 'すぐ目の前(とても近い)', mid: '話しやすい距離', far: '少し離れたところ' };
      const sec = Math.round((performance.now() - this.personSince) / 1000);
      const stay = sec < 10 ? '今来たところで' : sec < 60 ? `${sec}秒前から` : `${Math.round(sec / 60)}分前から`;
      const who = this.identity === 'master' ? 'マスター(律を作った人。顔で本人と分かった)が' : '';
      lines.push(`目の前の人: ${who}${DIST[this.personDistance]}(約${this.personZ.toFixed(1)}m)にいる。${stay}見えている。` +
                 (this.looking ? '今こちらを見ている' : 'こちらは見ていない'));
    } else {
      lines.push('目の前の人: カメラには誰も映っていない(画面の向こうから話しかけられている)');
    }
    return lines.join('\n');
  }
}
window.RitsuContext = RitsuContext;
window.RitsuHoliday = RitsuHoliday;
