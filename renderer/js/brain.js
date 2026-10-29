/* =========================================================================
 * brain.js — 会話(LiteLLM経由でOllama) / 暇つぶし行動
 *   LiteLLM の OpenAI互換API (/v1/chat/completions) をブラウザから直接呼ぶ。
 *   返答先頭の [emotion:x][motion:y] タグを解析してキャラへ反映する。
 * ========================================================================= */

const RITSU_CFG = (() => {
  const cfg = Object.assign({
    llmUrl: '/llm', llmModel: 'chat',
    llmTimeoutSec: 30, llmIdleChance: 0.5, idleMinSec: 25, idleMaxSec: 60, peekMinSec: 60, peekMaxSec: 120,
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
  // ?kiosk=1 の画面だけが ROS 2 の /ritsu/chat_user に応答する(デバッグで開いた他の画面と二重に返事しない)
  cfg.kiosk = q.get('kiosk') === '1';
  cfg.llmUrl = cfg.llmUrl.replace(/\/+$/, '').replace(/\/v1$/, '');
  return cfg;
})();

const EMOTIONS = ['happy', 'excited', 'shy', 'surprised', 'sad', 'angry', 'sleepy', 'neutral'];
const TALK_MOTIONS = ['wave', 'bigWave', 'bow', 'nod', 'shakeNo', 'happyBounce', 'jump', 'clap', 'peace',
                      'thinking', 'heartPose', 'cheer', 'laugh', 'wink', 'tiltL', 'agree', 'talkGesture1',
                      'kyun', 'nekoPose', 'twirl', 'idolWink', 'blowKiss', 'pikoJump', 'ojigiKawaii'];
const REPLY_MAX_CHARS = 70;   // 字幕に収まる長さ(システムプロンプトでは60文字以内と指示)

const SYSTEM_PROMPT = `あなたは「律(りつ)」。落ち着いた雰囲気だけど心優しい、可愛いバーチャル看板娘です。
- 一人称は「わたし」。丁寧で柔らかい口調。「〜ですよ」「〜ですね」を使い、時々「ふふっ」と笑う。
- 返答は必ず日本語で、2文以内、60文字以内。長い説明はしない。絵文字・記号・箇条書きは使わない。
- 返答の先頭に必ず [emotion:名前][motion:名前] を1つずつ付ける。
  emotion: ${EMOTIONS.join(', ')}
  motion: ${TALK_MOTIONS.join(', ')}
- 下の「今の状況」は本当の情報。日付・曜日・時間・季節を聞かれたらこれを使い、推測で答えない。
- 状況(時間帯・季節・行事・相手との距離)は会話が自然になるときだけ軽く触れる。毎回は触れない。
  例: 夜なら「こんばんは」、朝なら「おはようございます」。相手がとても近いときは少し照れる。
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

/* ---- 状況に合わせた独り言 [motion, emotion, text] (context.js の RitsuContext を参照) ---- */
const TOD_LINES = {
  earlyMorning: [['stretch', 'sleepy', 'ふぁ……朝早いですね。わたしも、まだ少し眠たいです。']],
  morning:      [['cheer', 'happy', '朝の空気って、気持ちいいですね。'],
                 ['stretch', 'happy', 'んーっ……今日も一日、始まりますね。']],
  noon:         [['thinking', 'neutral', 'そろそろお昼ごはんの時間ですね。何にしようかな……']],
  afternoon:    [['tiltL', 'neutral', '午後は、なんだかのんびりした気分になりますね。'],
                 ['sleepyNod', 'sleepy', 'お昼のあとって、眠くなりますよね……ふぁ。']],
  evening:      [['lookAround', 'neutral', 'もう夕方ですね。一日があっという間です。']],
  night:        [['thinking', 'neutral', '夜は静かで、落ち着きますね。'],
                 ['wink', 'happy', '今日も一日、お疲れさまでした。']],
  lateNight:    [['sleepyNod', 'sleepy', 'こんな夜更けまで……あまり無理しないでくださいね。'],
                 ['sleepyNod', 'sleepy', 'ふぁ……そろそろ、おやすみの時間でしょうか……']],
};
const SEASON_LINES = {
  spring: [['happyBounce', 'happy', '春は、なんだかわくわくしますね。']],
  summer: [['nod', 'neutral', '暑い日が続きますね。水分補給、忘れずにですよ。']],
  autumn: [['happyBounce', 'happy', '秋は、食べ物がおいしい季節ですね。ふふっ。'],
           ['lookAround', 'neutral', '少し涼しくなってきましたね。']],
  winter: [['shy', 'shy', '寒いですね……あったかくしてくださいね。']],
};
const EVENT_LINES = {
  'お正月':           ['ojigiKawaii', 'happy', 'あけましておめでとうございます。今年もよろしくお願いしますね。'],
  '節分':             ['laugh', 'happy', '鬼は外、福は内……ふふっ、豆まきの季節ですね。'],
  'バレンタイン':     ['kyun', 'shy', 'もうすぐバレンタインですね。チョコ、好きですか?'],
  'ひな祭り':         ['happyBounce', 'happy', 'ひな祭りですね。ひなあられ、食べたいなぁ。'],
  'お花見の季節':     ['twirl', 'excited', '桜の季節ですね。お花見、行きましたか?'],
  'ゴールデンウィーク': ['happyBounce', 'excited', 'ゴールデンウィークですね。どこかへお出かけしますか?'],
  '梅雨':             ['tiltL', 'neutral', '雨の日が多いですね。傘、忘れないでくださいね。'],
  '七夕':             ['thinking', 'happy', '七夕ですね。お願いごと、決まりましたか?'],
  'お盆':             ['nodSlow', 'neutral', 'お盆休み、ゆっくりできていますか?'],
  'お月見':           ['lookAround', 'happy', 'お月見の季節ですね。お団子、食べたいなぁ。'],
  'ハロウィン':       ['twirl', 'excited', 'もうすぐハロウィンですね。仮装、何がいいかな?'],
  'クリスマス':       ['happyBounce', 'excited', 'もうすぐクリスマスですね。わくわくします。'],
  '年末':             ['nodSlow', 'neutral', '今年もあと少しですね。一年、早かったなぁ。'],
};
const DISTANCE_LINES = {
  mid: [['wave', 'happy', 'よかったら、話しかけてくださいね。'],
        ['tiltL', 'neutral', '何か、お探しですか?']],
  far: [['comeHere', 'happy', 'そこの方、よかったら近くへどうぞ。'],
        ['wave', 'happy', 'ふふっ、遠くからでも見えていますよ。']],
};

/** 今の状況で言ってよい独り言の候補 */
function situationalLines(ctx) {
  const d = new Date();
  const out = [...TOD_LINES[ctx.timeOfDay(d)], ...SEASON_LINES[ctx.season(d)]];
  for (const ev of ctx.events(d)) if (EVENT_LINES[ev]) out.push(EVENT_LINES[ev]);
  if (d.getMonth() === 9 && d.getDate() === 31) out.push(['twirl', 'excited', 'ハッピーハロウィン!トリック・オア・トリート、ですよ。']);
  const type = ctx.dayType(d), w = d.getDay();
  if (type === 'holiday') out.push(['happyBounce', 'happy', `今日は${RitsuHoliday.name(d)}ですね。のんびりできていますか?`]);
  else if (type === 'weekend') out.push(['happyBounce', 'happy', '今日はお休みですね。ゆっくりしていってください。']);
  else if (w === 1) out.push(['cheer', 'happy', '月曜日ですね。今週も、一緒に頑張りましょう。']);
  else if (w === 5) out.push(['happyBounce', 'happy', '今日は金曜日。あと少しで週末ですよ、ふふっ。']);
  else out.push(['ojigiKawaii', 'happy', 'お仕事や学校、お疲れさまです。']);
  const dist = ctx.personDistance;
  if (DISTANCE_LINES[dist]) out.push(...DISTANCE_LINES[dist]);
  if (ctx.personPresent && performance.now() - ctx.personSince > 180000)
    out.push(['nodSlow', 'happy', 'ゆっくりしていってくださいね。']);
  return out;
}

/** 人が来た・帰った・近づいたときのひとこと */
function greetingFor(ctx) {
  return { earlyMorning: 'おはようございます。朝早いですね。', morning: 'おはようございます。',
           noon: 'こんにちは。', afternoon: 'こんにちは。', evening: 'こんにちは。もう夕方ですね。',
           night: 'こんばんは。', lateNight: 'こんばんは。夜遅くまでお疲れさまです。' }[ctx.timeOfDay()];
}
const NEAR_LINES = ['わっ……ち、近いです……!', 'ふふっ、そんなに近くで見られると照れちゃいます。',
                    'あの……ちょっとだけ、近いかも……'];
const REACT_COOLDOWN = 45;
// LLM に独り言を作らせるときの話題(毎回1つ選ぶ)
const IDLE_LLM_MOTIONS = ['nodSlow', 'tiltL', 'tiltR', 'lookAround', 'rhythmSway', 'happyBounce',
                          'wink', 'stretch', 'thinking', 'talkGesture2', 'mojimoji'];
const IDLE_TOPICS = ['今の時間帯のこと', '今の季節のこと', '季節の行事や、今日が何曜日か',
                     '目の前の人(いれば)へのさりげない声かけ', '看板娘のお仕事のこと',
                     '好きな食べ物や飲み物のこと', '天気や空気の感じを想像して', 'ちょっとした思いつき'];   // [秒] 来た・帰った・近いの反応どうしの間隔

const NOTICE_CHANCE = 0.25;  // 暇つぶし1回あたり、物音に振り向く確率
const IDLE_MOTIONS_ONLY = ['nodSlow', 'lookAround', 'tiltR', 'stretch', 'happyBounce',
                           'danceC', 'sleepyNod', 'rhythmSway', 'pikoJump', 'mojimoji',
                           'guruguru', 'twirl'];

const TAG_RE = /\[(emotion|motion):([a-zA-Z0-9_]+)\]/g;
const QUEUE_MAX = 5;   // 返事中に届いた話しかけを順番待ちさせる上限
const FALLBACK_REPLY = '[emotion:shy][motion:tiltL] ごめんなさい、少し考えごとをしていました。もう一度お願いできますか?';

/** LLM の返答を検証して整える。使えない返答なら null
 *  - [emotion:x][motion:y] を取り出し、知らない名前は既定値へ
 *  - 残ったタグ・記号・絵文字・「律:」などの前置きを除く
 *  - 長すぎる返答は文の区切りで REPLY_MAX_CHARS 文字までに切る
 *  - 日本語(ひらがな・カタカナ・漢字)を含まない返答は使わない */
function validateReply(reply) {
  let emotion = 'happy', motion = 'talkGesture1';
  for (const [, kind, name] of reply.matchAll(TAG_RE)) {
    if (kind === 'emotion' && EMOTIONS.includes(name)) emotion = name;
    if (kind === 'motion' && typeof MOTIONS !== 'undefined' && MOTIONS[name]) motion = name;
  }
  let text = reply.replace(TAG_RE, '')
    .replace(/\[[^\]]*\]/g, '')                               // 崩れたタグ
    .replace(/[*#`_>~|]/g, '')                                  // マークダウン記号
    .replace(/\p{Extended_Pictographic}|\uFE0F/gu, '')           // 絵文字
    .replace(/^\s*(律|りつ|Ritsu|assistant)\s*[:：]\s*/i, '')     // 名前の前置き
    .replace(/\s+/g, ' ').trim()
    .replace(/^「(.*)」$/, '$1');
  if (!/[\u3040-\u30ff\u4e00-\u9fff]/.test(text)) return null;
  if (text.length > REPLY_MAX_CHARS) {   // 文の区切りで入るところまで残す
    const sentences = text.match(/[^。!?！？]+[。!?！？…」]*/g) || [text];
    let cut = '';
    for (const st of sentences) { if ((cut + st).length > REPLY_MAX_CHARS) break; cut += st; }
    text = cut.trim() || text.slice(0, REPLY_MAX_CHARS - 1) + '…';
  }
  return { text, emotion, motion };
}

class RitsuBrain {
  /** act({text, motion, emotion, source}) でキャラに反映。onStatus(ok) でLLMランプ更新、
   *  onThinking(on) で返事を考え中かどうかを通知。ctx は RitsuContext(今の状況) */
  constructor({ act, onStatus, onThinking, ctx }) {
    this.act = act;
    this.ctx = ctx || new RitsuContext();
    this.onStatus = onStatus || (() => {});
    this.onThinking = onThinking || (() => {});
    this.history = [];
    this.queue = [];
    this.busy = false;
    this.lastInteraction = performance.now();
    this.lastPeek = performance.now();
    this.lastChat = -Infinity;   // 最後に話しかけられた時刻(会話中のカメラ寄り用)
    this.lastReact = -Infinity;  // 来た・帰った・近いに反応した時刻
    this.recentLines = [];       // 最近言った独り言(続けて同じことを言わないように)
    this.ctx.on('arrive', absentSec => this._onArrive(absentSec));
    this.ctx.on('leave', stayedSec => this._onLeave(stayedSec));
    this.ctx.on('near', () => this._onNear());
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

    const { text, motion, emotion, ok } = await this._complete(userText);
    this.act({ text, motion, emotion, source: ok ? 'llm' : 'fallback' });
    this.lastInteraction = this.lastChat = performance.now();
    this.busy = false;
    this.onThinking(false);
    if (this.queue.length) this.chat(this.queue.shift());
  }

  /** LiteLLM へ問い合わせて返答の本文を返す。失敗したら null */
  async _request(messages, temperature) {
    try {
      const res = await fetch(`${RITSU_CFG.llmUrl}/v1/chat/completions`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(RITSU_CFG.llmTimeoutSec * 1000),
        body: JSON.stringify({ model: RITSU_CFG.llmModel, messages, temperature, max_tokens: 96 }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
      const reply = (await res.json()).choices[0].message.content.trim();
      this.onStatus(true);
      return reply;
    } catch (e) {
      console.warn('[brain] LLM error:', e);
      this.onStatus(false);
      return null;
    }
  }

  _systemPrompt() { return `${SYSTEM_PROMPT}\n\n# 今の状況\n${this.ctx.describe()}`; }

  async _complete(userText) {
    const messages = [{ role: 'system', content: this._systemPrompt() },
                      ...this.history.slice(-6),
                      { role: 'user', content: userText }];
    const reply = await this._request(messages, 0.9);
    if (reply === null) return { ...validateReply(FALLBACK_REPLY), ok: false };
    const v = validateReply(reply);
    if (!v) {
      console.warn('[brain] invalid reply:', reply);
      return { ...validateReply(FALLBACK_REPLY), ok: false };
    }
    // 履歴には整えた形で残す(崩れた返答を次の返答が真似しないように)
    this.history.push({ role: 'user', content: userText },
                      { role: 'assistant', content: `[emotion:${v.emotion}][motion:${v.motion}] ${v.text}` });
    this.history = this.history.slice(-12);
    return { ...v, ok: true };
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
            if (Math.random() < RITSU_CFG.llmIdleChance) this._llmIdleLine();
            else {
              const [motion, emotion, text] = this._pickIdleLine();
              this.act({ text, motion, emotion, source: 'idle' });
            }
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

  /** 今の状況(時間帯・季節・行事・曜日・目の前の人)を渡して、LLM に独り言を作らせる。
   *  毎回話題を1つ指定して偏りを減らし、最近言ったことは避けさせる。
   *  作っている間に話しかけられたら捨てる。失敗したら用意したセリフで代わりに言う */
  async _llmIdleLine() {
    if (this.idleGenerating) return;
    this.idleGenerating = true;
    const startedChat = this.lastChat;
    const topic = IDLE_TOPICS[Math.floor(Math.random() * IDLE_TOPICS.length)];
    const recent = this.recentLines.slice(-5).map(t => `- ${t}`).join('\n') || '- (なし)';
    const prompt = `(今は誰にも話しかけられていません。看板娘として、ひとりごとをつぶやいてください)
話題: ${topic}
条件: 1文、40文字以内。いつもの丁寧で柔らかい口調。「今の状況」の日付と矛盾しない内容にする。
motion はつぶやきの内容に合うものを選ぶ(thinking ばかりにしない)。
最近言ったこと(同じ内容・言い回しは避ける):
${recent}`;
    const reply = await this._request([{ role: 'system', content: this._systemPrompt() },
                                       { role: 'user', content: prompt }], 1.0);
    this.idleGenerating = false;
    const v = reply && validateReply(reply);
    if (this.busy || this.lastChat !== startedChat) return;   // 作っている間に会話が始まった
    if (!v || this.recentLines.includes(v.text)) {
      if (reply) console.warn('[brain] invalid idle line:', reply);
      const [motion, emotion, text] = this._pickIdleLine();
      this.act({ text, motion, emotion, source: 'idle' });
      return;
    }
    this.recentLines = [...this.recentLines, v.text].slice(-8);
    // 小さいモデルは独り言だと thinking / neutral ばかり選ぶので、そのときは独り言向けの動きから選び直す
    let { motion, emotion } = v;
    if (motion === 'thinking' || motion === 'talkGesture1') motion = IDLE_LLM_MOTIONS[Math.floor(Math.random() * IDLE_LLM_MOTIONS.length)];
    if (emotion === 'neutral' && Math.random() < 0.6) emotion = 'happy';
    this.act({ text: v.text, motion, emotion, source: 'idle-llm' });
  }

  /** 半分は今の状況(時間帯・季節・曜日・人との距離)に合った独り言、半分はいつもの独り言。
   *  最近言ったものは避ける */
  _pickIdleLine() {
    const situ = situationalLines(this.ctx).filter(l => !this.recentLines.includes(l[2]));
    const base = IDLE_LINES.filter(l => !this.recentLines.includes(l[2]));
    const pool = situ.length && (Math.random() < 0.5 || !base.length) ? situ : base;
    const line = pool[Math.floor(Math.random() * pool.length)];
    this.recentLines = [...this.recentLines, line[2]].slice(-8);
    return line;
  }

  /** 来た・帰った・近いへの反応をしてよいか(会話中・直前の反応のすぐ後は控える) */
  _canReact() {
    const now = performance.now();
    if (this.busy || (now - this.lastChat) / 1000 < 15 || (now - this.lastReact) / 1000 < REACT_COOLDOWN) return false;
    this.lastReact = this.lastInteraction = now;
    return true;
  }

  _onArrive(absentSec) {
    if (absentSec < 60) {   // ちょっと離れて戻ってきた
      if (absentSec > 15 && Math.random() < 0.5 && this._canReact())
        this.act({ text: 'おかえりなさい。', motion: 'wave', emotion: 'happy', source: 'idle' });
      return;
    }
    if (!this._canReact()) return;
    const far = this.ctx.personDistance === 'far';
    this.act({ text: greetingFor(this.ctx) + (far ? 'よかったら、近くへどうぞ。' : ''),
               motion: far ? 'comeHere' : Math.random() < 0.5 ? 'wave' : 'ojigiKawaii',
               emotion: 'happy', source: 'idle' });
  }

  _onLeave(stayedSec) {
    if (stayedSec < 15 || !this._canReact()) return;
    const night = ['night', 'lateNight'].includes(this.ctx.timeOfDay());
    const text = night ? 'おやすみなさい。またお越しくださいね。'
               : ['またお越しくださいね。', 'ありがとうございました。また来てくださいね。'][Math.floor(Math.random() * 2)];
    this.act({ text, motion: 'byebye', emotion: 'happy', source: 'idle' });
  }

  _onNear() {
    if (!this._canReact()) return;
    this.act({ text: NEAR_LINES[Math.floor(Math.random() * NEAR_LINES.length)],
               motion: 'mojimoji', emotion: 'shy', source: 'idle' });
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
