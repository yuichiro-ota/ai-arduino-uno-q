/* =========================================================================
 * brain.js — 会話(LiteLLM経由でOllama) / 暇つぶし行動
 *   LiteLLM の OpenAI互換API (/v1/chat/completions) をブラウザから直接呼ぶ。
 *   返答先頭の [emotion:x][motion:y] タグを解析してキャラへ反映する。
 * ========================================================================= */

const RITSU_CFG = (() => {
  const cfg = Object.assign({
    llmUrl: '/llm', llmModel: 'chat',
    llmTimeoutSec: 30, idleMinSec: 25, idleMaxSec: 60, peekMinSec: 60, peekMaxSec: 120,
    pixelRatio: 1.5, antialias: true, petals: 40, simpleMaterials: false,
  }, window.RITSU_CONFIG || {});
  const q = new URLSearchParams(location.search);
  // ?lite=1 で描画を最軽量に(GPUが弱い/不安定な環境の切り分け用)
  if (q.get('lite') === '1') Object.assign(cfg, { pixelRatio: 0.75, antialias: false, petals: 0, simpleMaterials: true });
  // 描画設定を1項目ずつ切り替えて試す: ?pr=1 / ?aa=0 / ?pet=0 / ?sm=1
  if (q.get('pr')) cfg.pixelRatio = parseFloat(q.get('pr'));
  if (q.get('aa')) cfg.antialias = q.get('aa') === '1';
  if (q.get('pet')) cfg.petals = parseInt(q.get('pet'), 10) || 0;
  if (q.get('sm')) cfg.simpleMaterials = q.get('sm') === '1';
  if (q.get('llm')) cfg.llmUrl = q.get('llm');
  if (q.get('model')) cfg.llmModel = q.get('model');
  // ?kiosk=1 の画面だけが MQTT の chat/user に応答する(デバッグで開いた他の画面と二重に返事しない)
  cfg.kiosk = q.get('kiosk') === '1';
  cfg.mqttUrl = cfg.mqttUrl || `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/mqtt`;
  cfg.llmUrl = cfg.llmUrl.replace(/\/+$/, '').replace(/\/v1$/, '');
  return cfg;
})();

const SYSTEM_PROMPT = `あなたは「律(りつ)」。落ち着いた雰囲気だけど心優しい、可愛いバーチャル看板娘です。
- 一人称は「わたし」。丁寧で柔らかい口調。「〜ですよ」「〜ですね」を使い、時々「ふふっ」と笑う。
- 返答は必ず2文以内、60文字以内。長い説明はしない。
- 返答の先頭に必ず [emotion:名前][motion:名前] を1つずつ付ける。
  emotion: happy, excited, shy, surprised, sad, angry, sleepy, neutral
  motion: wave, bigWave, bow, nod, shakeNo, happyBounce, jump, clap, peace,
          thinking, heartPose, cheer, laugh, wink, tiltL, agree, talkGesture1,
          kyun, nekoPose, twirl, idolWink, blowKiss, pikoJump, ojigiKawaii
例: [emotion:happy][motion:ojigiKawaii] こんにちは、律です。お会いできて嬉しいです。`;

const IDLE_LINES = [
  ['stretch',     'sleepy',  'んっ……少しだけ、伸びをしますね。'],
  ['lookAround',  'neutral', '今日はどなたか、来てくださるかな。'],
  ['rhythmSway',  'happy',   'ふふっ、いい音楽が聞こえる気がします。'],
  ['danceA',      'excited', '実は……ダンスの練習をしているんですよ。'],
  ['thinking',    'neutral', '今日のお茶は、何にしましょうか……'],
  ['happyBounce', 'happy',   'なんだか、楽しい気分です。ふふっ。'],
  ['tiltL',       'neutral', 'あら?今、何か聞こえたような……'],
  ['sleepyNod',   'sleepy',  'ふぁ……少しだけ、眠たいかも……'],
  ['cheer',       'excited', '今日も一日、頑張りましょうね。'],
  ['wink',        'happy',   '見ていてくださって、ありがとうございます。'],
  ['twirl',       'excited', 'くるりん……ふふっ、どうでしょう?'],
  ['kyun',        'shy',     'きゅんっ……なんて、冗談ですよ。ふふ。'],
  ['nekoPose',    'happy',   'にゃん……猫さんの真似、してみました。'],
];
const PEEK_LINES = [
  'じーっ……。そこに、どなたかいらっしゃいますか?',
  'ふふっ、ちゃんと見えていますよ。',
  'あれ?今、目が合いましたね。',
  '画面の向こうって、どうなっているんでしょう……',
];
const NOTICE_LINES = [
  '……?今、何か聞こえましたか?',
  'あら……?気のせい、でしょうか。',
  '……?誰か、いらっしゃいました?',
  '今の音……なんでしょう?',
];
const NOTICE_CHANCE = 0.25;  // 暇つぶし1回あたり、物音に振り向く確率
const IDLE_MOTIONS_ONLY = ['nodSlow', 'lookAround', 'tiltR', 'stretch', 'happyBounce',
                           'danceC', 'sleepyNod', 'rhythmSway', 'pikoJump', 'mojimoji',
                           'guruguru', 'twirl'];

const TAG_RE = /\[(emotion|motion):([a-zA-Z0-9_]+)\]/g;
const QUEUE_MAX = 5;   // 返事中に届いた話しかけを順番待ちさせる上限
const FALLBACK_REPLY = '[emotion:shy][motion:tiltL] ごめんなさい、少し考えごとをしていました。もう一度お願いできますか?';

class RitsuBrain {
  /** act({text, motion, emotion, source}) でキャラに反映。onStatus(ok) でLLMランプ更新、
   *  onThinking(on) で返事を考え中かどうかを通知 */
  constructor({ act, onStatus, onThinking }) {
    this.act = act;
    this.onStatus = onStatus || (() => {});
    this.onThinking = onThinking || (() => {});
    this.history = [];
    this.queue = [];
    this.busy = false;
    this.lastInteraction = performance.now();
    this.lastPeek = performance.now();
    this.lastChat = -Infinity;   // 最後に話しかけられた時刻(会話中のカメラ寄り用)
  }

  async chat(userText) {
    userText = userText.trim();
    if (!userText) return;
    if (this.busy) {
      if (this.queue.length < QUEUE_MAX) this.queue.push(userText);
      return;
    }
    this.busy = true;
    this.lastChat = performance.now();
    this.onThinking(true);
    this.lastInteraction = performance.now();
    this.act({ motion: 'listening' });

    const { reply, ok } = await this._complete(userText);
    let emotion = 'happy', motion = 'talkGesture1';
    for (const [, kind, name] of reply.matchAll(TAG_RE)) {
      if (kind === 'emotion') emotion = name; else motion = name;
    }
    const text = reply.replace(TAG_RE, '').trim() || 'ふふっ。';
    this.act({ text, motion, emotion, source: ok ? 'llm' : 'fallback' });
    this.lastInteraction = this.lastChat = performance.now();
    this.busy = false;
    this.onThinking(false);
    if (this.queue.length) this.chat(this.queue.shift());
  }

  async _complete(userText) {
    const messages = [{ role: 'system', content: SYSTEM_PROMPT },
                      ...this.history.slice(-6),
                      { role: 'user', content: userText }];
    let reply;
    try {
      const res = await fetch(`${RITSU_CFG.llmUrl}/v1/chat/completions`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(RITSU_CFG.llmTimeoutSec * 1000),
        body: JSON.stringify({ model: RITSU_CFG.llmModel, messages,
                               temperature: 0.9, max_tokens: 96 }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
      reply = (await res.json()).choices[0].message.content.trim();
      this.onStatus(true);
    } catch (e) {
      console.warn('[brain] LLM error:', e);
      this.onStatus(false);
      return { reply: FALLBACK_REPLY, ok: false };
    }
    this.history.push({ role: 'user', content: userText },
                      { role: 'assistant', content: reply });
    this.history = this.history.slice(-12);
    return { reply, ok: true };
  }

  /** 接続確認 (/v1/models) してランプに反映 */
  async ping() {
    try {
      const res = await fetch(`${RITSU_CFG.llmUrl}/v1/models`, { signal: AbortSignal.timeout(5000) });
      this.onStatus(res.ok);
    } catch {
      this.onStatus(false);
    }
  }

  /** 一定間隔でランダムな独り言 or モーションだけ */
  startIdle() {
    const schedule = () => {
      const sec = RITSU_CFG.idleMinSec + Math.random() * (RITSU_CFG.idleMaxSec - RITSU_CFG.idleMinSec);
      setTimeout(() => {
        const quietSec = (performance.now() - this.lastInteraction) / 1000;
        const sincePeek = (performance.now() - this.lastPeek) / 1000;
        if (!this.busy && quietSec > RITSU_CFG.idleMinSec && sincePeek > 8) {   // のぞき込み直後は控える
          if (Math.random() < NOTICE_CHANCE) {
            // 半分は無言で振り向くだけ(毎回しゃべると不自然なため)
            this.act({ motion: Math.random() < 0.5 ? 'noticeL' : 'noticeR', emotion: 'surprised',
                       text: Math.random() < 0.5 ? NOTICE_LINES[Math.floor(Math.random() * NOTICE_LINES.length)] : null,
                       source: 'idle' });
          } else if (Math.random() < 0.5) {
            const [motion, emotion, text] = IDLE_LINES[Math.floor(Math.random() * IDLE_LINES.length)];
            this.act({ text, motion, emotion, source: 'idle' });
          } else {
            this.act({ motion: IDLE_MOTIONS_ONLY[Math.floor(Math.random() * IDLE_MOTIONS_ONLY.length)] });
          }
        }
        schedule();
      }, sec * 1000);
    };
    schedule();
    this._startPeek();
  }

  /** 会話が無い間、peekMinSec〜peekMaxSec 秒に1回のぞき込む(話しかけられたら数え直し) */
  _startPeek() {
    const gap = () => RITSU_CFG.peekMinSec + Math.random() * (RITSU_CFG.peekMaxSec - RITSU_CFG.peekMinSec);
    let next = gap();
    setInterval(() => {
      const now = performance.now();
      const since = (now - Math.max(this.lastInteraction, this.lastPeek)) / 1000;
      if (this.busy || since < next) return;
      this.lastPeek = now;
      next = gap();
      this.act({ text: PEEK_LINES[Math.floor(Math.random() * PEEK_LINES.length)],
                 motion: 'peek', emotion: 'surprised', source: 'idle' });
    }, 1000);
  }
}
window.RitsuBrain = RitsuBrain;
