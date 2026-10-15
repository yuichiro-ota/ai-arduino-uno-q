/* =========================================================================
 * brain.js — 会話(LiteLLM経由でOllama) / 暇つぶし行動
 *   LiteLLM の OpenAI互換API (/v1/chat/completions) をブラウザから直接呼ぶ。
 *   返答先頭の [emotion:x][motion:y] タグを解析してキャラへ反映する。
 * ========================================================================= */

const RITSU_CFG = (() => {
  const cfg = Object.assign({
    llmUrl: '/llm', llmModel: 'chat',
    llmTimeoutSec: 30, idleMinSec: 25, idleMaxSec: 60,
    pixelRatio: 1.5, antialias: true, petals: 40, simpleMaterials: false,
  }, window.RITSU_CONFIG || {});
  const q = new URLSearchParams(location.search);
  // ?lite=1 で描画を最軽量に(GPUが弱い/不安定な環境の切り分け用)
  if (q.get('lite') === '1') Object.assign(cfg, { pixelRatio: 0.75, antialias: false, petals: 0, simpleMaterials: true });
  if (q.get('pr')) cfg.pixelRatio = parseFloat(q.get('pr'));
  if (q.get('llm')) cfg.llmUrl = q.get('llm');
  if (q.get('model')) cfg.llmModel = q.get('model');
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
const IDLE_MOTIONS_ONLY = ['nodSlow', 'lookAround', 'tiltR', 'stretch', 'happyBounce',
                           'danceC', 'sleepyNod', 'rhythmSway', 'pikoJump', 'mojimoji',
                           'guruguru', 'twirl'];

const TAG_RE = /\[(emotion|motion):([a-zA-Z0-9_]+)\]/g;
const FALLBACK_REPLY = '[emotion:shy][motion:tiltL] ごめんなさい、少し考えごとをしていました。もう一度お願いできますか?';

class RitsuBrain {
  /** act({text, motion, emotion}) でキャラに反映。onStatus(ok) でLLMランプ更新 */
  constructor({ act, onStatus }) {
    this.act = act;
    this.onStatus = onStatus || (() => {});
    this.history = [];
    this.busy = false;
    this.lastInteraction = performance.now();
  }

  async chat(userText) {
    userText = userText.trim();
    if (!userText || this.busy) return;
    this.busy = true;
    this.lastInteraction = performance.now();
    this.act({ motion: 'listening' });

    const reply = await this._complete(userText);
    let emotion = 'happy', motion = 'talkGesture1';
    for (const [, kind, name] of reply.matchAll(TAG_RE)) {
      if (kind === 'emotion') emotion = name; else motion = name;
    }
    const text = reply.replace(TAG_RE, '').trim() || 'ふふっ。';
    this.act({ text, motion, emotion });
    this.lastInteraction = performance.now();
    this.busy = false;
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
      return FALLBACK_REPLY;
    }
    this.history.push({ role: 'user', content: userText },
                      { role: 'assistant', content: reply });
    this.history = this.history.slice(-12);
    return reply;
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
        if (!this.busy && quietSec > RITSU_CFG.idleMinSec) {
          if (Math.random() < 0.5) {
            const [motion, emotion, text] = IDLE_LINES[Math.floor(Math.random() * IDLE_LINES.length)];
            this.act({ text, motion, emotion });
          } else {
            this.act({ motion: IDLE_MOTIONS_ONLY[Math.floor(Math.random() * IDLE_MOTIONS_ONLY.length)] });
          }
        }
        schedule();
      }, sec * 1000);
    };
    schedule();
  }
}
window.RitsuBrain = RitsuBrain;
