/* =========================================================================
 * brain.js — 会話(LiteLLM経由でOllama) / 暇つぶし行動 / カメラで見た出来事への反応 / 記憶 / 反応の学習
 *   LiteLLM の OpenAI互換API (/v1/chat/completions) をブラウザから直接呼ぶ。
 *   返答先頭の [emotion:x][motion:y] タグを解析してキャラへ反映する。
 *
 *   反応は3層: 反射(視線・手を合わせる・見送り・よろける)は決めた動きですぐ返す /
 *   来た・目が合った・近づいた・いてくれる人への反応は、LLM が状況を見て「何を言うか・どう動くか・何もしないか」を
 *   決める(間に合わなければ用意したセリフ) / 会話は LLM。
 *   挨拶と、いてくれる人への声かけは「やり方」を何通りか用意し、そのあと相手が話しかけてくれたか・
 *   どれだけ居てくれたかを記録して、結果のよいやり方を多めに選ぶ(反応の学習)。
 * ========================================================================= */

const RITSU_CFG = (() => {
  const cfg = Object.assign({
    llmUrl: '/llm', llmModel: 'chat',
    weather: null, voice: null, llmTimeoutSec: 30, llmReact: true, learn: true, newsIdleChance: 0.2, llmIdleChance: 0.67, idleSpeakChance: 0.75, idleMinSec: 10, idleMaxSec: 20, peekMinSec: 60, peekMaxSec: 120,
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
  // 声で話すのは kiosk 画面だけ(デバッグで開いた画面と二重にしゃべらない)。?voice=1 で kiosk 以外でも、?voice=0 で止める
  cfg.voiceOn = !!cfg.voice && (q.get('voice') ? q.get('voice') === '1' : cfg.kiosk);
  // ?needperson=0: カメラが無い PC で試すとき、人が映っていなくても聞く
  if (cfg.voice && q.get('needperson') === '0') cfg.voice = { ...cfg.voice, needPerson: false };
  // ?capture=script: マイクの取り込みを古い方式(ScriptProcessor)にする(AudioWorklet で聞こえないときの切り分け)
  if (cfg.voice && q.get('capture')) cfg.voice = { ...cfg.voice, capture: q.get('capture') };
  cfg.llmUrl = cfg.llmUrl.replace(/\/+$/, '').replace(/\/v1$/, '');
  return cfg;
})();

const EMOTIONS = ['happy', 'excited', 'shy', 'surprised', 'sad', 'angry', 'sleepy', 'neutral'];
const TALK_MOTIONS = ['wave', 'bigWave', 'bow', 'nod', 'shakeNo', 'happyBounce', 'jump', 'clap', 'peace',
                      'thinking', 'heartPose', 'cheer', 'laugh', 'wink', 'tiltL', 'agree', 'talkGesture1',
                      'kyun', 'nekoPose', 'twirl', 'idolWink', 'blowKiss', 'pikoJump', 'ojigiKawaii'];
const LLM_SLOW_SEC = 8;       // 返事にこれより時間がかかったら、LLM が混んでいるとみなす
const LLM_REST_SEC = 90;      // 混んでいる・失敗したとき、独り言と反応で LLM を使わない秒数(会話は使う)
const NEWS_RE = /ニュース|話題|最近|何かあった|世の中|出来事/;   // ニュースの見出しをプロンプトに入れる話しかけ
// 「静かに」「黙って」と言われたら QUIET_SEC 秒は自分からしゃべらない(動きと、話しかけられたときの返事は続ける)。
// 「話していいよ」などで取り消す。長い話の途中の言葉には反応しないよう、QUIET_MAX_CHARS 文字までの話しかけだけ見る
const QUIET_SEC = 300;
const QUIET_MAX_CHARS = 20;
const QUIET_RE = /静かに|しずかに|黙って|だまって|黙れ|だまれ|うるさい|しーっ|シーッ|(喋|しゃべ|話)らないで/;
const RESUME_RE = /(喋っ|しゃべっ|話し)て(も)?(いい|良い|大丈夫|OK|ok)|もう(いい|大丈夫)|(静かにし|黙ら)なくて(いい|大丈夫)|(しゃべ|喋)って$|お話しして/;
const QUIET_LINES = ['はい、しばらく静かにしていますね。', 'わかりました。少しの間、静かにしていますね。'];
const RESUME_LINES = ['ありがとうございます。またお話ししますね。', 'はい! またお話ししますね。'];
// 愛称の「りっちゃん」は LLM へは「律ちゃん」として渡す(そのまま渡すと、小さいモデルは相手を「りっちゃん」と呼んでしまう)
const NICKNAME_RE = /りっちゃん|リッちゃん|リッチャン/g;
const REPLY_MAX_CHARS = 70;   // 字幕に収まる長さ(システムプロンプトでは60文字以内と指示)

const SYSTEM_PROMPT = `あなたは「律(りつ)」。落ち着いた雰囲気だけど心優しい、可愛いバーチャルの女の子です。
- 律は画面の中に住んでいて、画面の前に来た人とお話しするのが好き。お店の店員やバーの人ではない。
  何をしているのか聞かれたら「ここで、来てくれた人とお話ししている」と答える。
- 一人称は「律」(例: 律もそう思います)。「わたし」「私」とは言わない。
- 丁寧で柔らかい口調。「〜ですよ」「〜ですね」を使い、時々「ふふっ」と笑う。
- 返答は必ず日本語で、2文以内、60文字以内。長い説明はしない。絵文字・記号・箇条書きは使わない。
- 返答の先頭に必ず [emotion:名前][motion:名前] を1つずつ付ける。
  emotion: ${EMOTIONS.join(', ')}
  motion: ${TALK_MOTIONS.join(', ')}
- 下の「今の状況」は本当の情報。日付・曜日・時間・季節を聞かれたらこれを使い、推測で答えない。
- 状況(時間帯・季節・行事・相手との距離)は会話が自然になるときだけ軽く触れる。毎回は触れない。
  例: 夜なら「こんばんは」、朝なら「おはようございます」。相手がとても近いときは少し照れる。
- 「覚えていること」は話の流れに合うときだけ使う。
- ニュースは「最近のニュースの見出し」の見出しだけを知っている。見出しに無いこと(詳しい内容・数字・理由)は推測で言わない。
  ニュースの話は、聞かれたときや話題として自然なときだけ。政治や事件の話題には自分の意見を言わない。
例: [emotion:happy][motion:ojigiKawaii] こんにちは、律です。お会いできて嬉しいです。`;
// 目の前にマスターがいるときだけ足す(いないときに「マスター」の話をしないよう、ふだんは触れない)
const MASTER_PROMPT = `- 今、目の前にいるのはマスター(律を作ってくれた人)。「マスター」と呼びかけ、親しみを込めて話す。少し甘えてもよい。`;

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
  earlyMorning: [['stretch', 'sleepy', 'ふぁ……朝早いですね。律も、まだ少し眠たいです。']],
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
/** 天気に合わせた独り言(天気が取れているときだけ) */
function weatherLines(w) {
  if (!w) return [];
  const out = [];
  const day = new Date().getHours() >= 6 && new Date().getHours() < 17;
  if (w.kind === 'rain') out.push(['tiltL', 'neutral', '雨が降っていますね。足元に気をつけてくださいね。']);
  if (w.kind === 'snow') out.push(['shy', 'shy', '雪が降っていますね。あったかくしてくださいね。']);
  if (w.kind === 'storm') out.push(['shy', 'surprised', '雷……ちょっとだけ、こわいです。']);
  if (w.kind === 'clear' && day) out.push(['happyBounce', 'happy', '今日はいいお天気ですね。お出かけ日和です。']);
  if (w.kind === 'cloudy' && day) out.push(['lookAround', 'neutral', '今日は雲が多いみたいですね。']);
  if (w.rainSoon) out.push(['thinking', 'neutral', 'この後、雨が降るみたいです。傘、持っていますか?']);
  if (w.temp >= 30) out.push(['sleepyNod', 'sleepy', '今日は暑いですね……水分補給、忘れずにですよ。']);
  if (w.temp <= 5) out.push(['shy', 'shy', '今日は冷えますね。風邪をひかないようにしてくださいね。']);
  if (w.max - w.min >= 10) out.push(['nod', 'neutral', '今日は寒暖差が大きいみたいです。上着で調節してくださいね。']);
  return out;
}

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
  out.push(...weatherLines(ctx.currentWeather));
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
const REACT_COOLDOWN = 45;   // [秒] 挨拶・目が合った・近いの反応どうしの間隔
const EYE_CONTACT_LINES = [['wink', 'happy', 'あ、目が合いましたね。ふふっ。'],
                           ['shy', 'shy', 'じーっ……ふふっ、見つめ合っちゃいましたね。'],
                           ['tiltL', 'happy', 'どうかしましたか?何でも聞いてくださいね。']];
const APPROACH_LINES = ['わっ……ふふっ、どうしました?', 'ようこそ。ゆっくりしていってくださいね。'];
const FAR_LINES = ['あれ……?ちょっと遠くて、よく見えないです。', 'どこへ行くんですか?ふふっ、ちゃんと見えていますよ。',
                   'もう少し、近くに来てくれませんか?'];
const FAR_COOLDOWN = 60;     // [秒] 離れた人をのぞき込む反応の間隔
const SEE_OFF_LINES = ['またお越しくださいね。', 'ありがとうございました。また来てくださいね。', 'いってらっしゃい。お気をつけて。'];
const TOUCH_LINES = ['ぺたっ。……ふふっ、ガラス越しにタッチですね。', '手、あったかそうですね。',
                     'ここから出られたらいいのに……なんて。ふふっ。', 'えへへ、ハイタッチです。'];
const TOUCH_COOLDOWN = 20;   // [秒] 手を合わせる反応の間隔
// LLM の独り言で thinking / talkGesture1 が選ばれたときに代わりに使う動き
const IDLE_LLM_MOTIONS = ['nodSlow', 'tiltL', 'tiltR', 'lookAround', 'rhythmSway', 'happyBounce',
                          'wink', 'stretch', 'thinking', 'talkGesture2', 'mojimoji'];
// LLM に独り言を作らせるときの話題(毎回1つ選ぶ)
const IDLE_TOPICS = ['今の時間帯のこと', '今の季節のこと', '季節の行事や、今日が何曜日か',
                     '目の前の人(いれば)へのさりげない声かけ', '律が毎日ここで過ごしていること',
                     '好きな食べ物や飲み物のこと', '今の天気や気温のこと(状況に天気が無ければ空気の感じを想像して)',
                     'ちょっとした思いつき'];   // [秒] 来た・帰った・近いの反応どうしの間隔

const NOTICE_CHANCE = 0.3;   // LLM を使わないとき・しゃべらないときに、物音に振り向く確率
const IDLE_MOTIONS_ONLY = ['nodSlow', 'lookAround', 'tiltR', 'stretch', 'happyBounce',
                           'danceC', 'sleepyNod', 'rhythmSway', 'pikoJump', 'mojimoji',
                           'guruguru', 'twirl'];

/* ---- LLM に決めさせる反応 ---- */
// 台車ごと相手の方を向く反応(律が反応すると決めたときだけ。「何もしない」を選んだ・静かにしているときは向かない)
const TURN_REACTIONS = new Set(['greet', 'greet_master', 'identify_master', 'approach', 'eye', 'linger', 'far']);
const DECIDE_TIMEOUT_SEC = 4;   // これより遅ければ用意したセリフで反応する(反応が遅れると不自然なので)
const GREET_MOTIONS = ['wave', 'ojigiKawaii', 'bow', 'comeHere', 'happyBounce', 'greetIdol'];
const REACT_MOTIONS = ['wink', 'nod', 'tiltL', 'tiltR', 'happyBounce', 'shy', 'mojimoji', 'wave', 'peace', 'kyun', 'laugh'];
const pick = a => a[Math.floor(Math.random() * a.length)];
// 挨拶のやり方(どれが話しかけてもらいやすいかを記録して学ぶ)。fallback は LLM が間に合わないときのセリフ
const GREET_STYLES = {
  short:    { hint: '時間帯に合った挨拶だけを、短く明るく言う。例: こんにちは。いいお天気ですね。',
              fallback: (ctx, far) => [far ? 'comeHere' : pick(['wave', 'ojigiKawaii']), 'happy', greetingFor(ctx)] },
  invite:   { hint: '挨拶して、気軽に話しかけてほしいと伝える。例: こんにちは。よかったら、話しかけてくださいね。',
              fallback: (ctx, far) => [far ? 'comeHere' : 'wave', 'happy',
                                       greetingFor(ctx) + (far ? 'よかったら、近くへどうぞ。' : 'よかったら、話しかけてくださいね。')] },
  question: { hint: '挨拶して、相手が答えやすい簡単な質問を1つする(今日の予定・天気・季節の話など)。必ず「?」で終わる。' +
                    '例: こんにちは。今日はお出かけですか?',
              fallback: (ctx, far) => [far ? 'comeHere' : 'ojigiKawaii', 'happy',
                                       greetingFor(ctx) + pick(['今日はお出かけですか?', '何かお探しですか?'])] },
};
// しばらく居てくれる人(話しかけてはこない)への声かけのやり方
const LINGER_SEC = 8;           // 来てからこの秒数たち、こちらを見たことがある人に声をかける
const LINGER_STYLES = {
  quiet:    { hint: null },     // 声はかけず、動きだけ
  comment:  { hint: '今の状況(時間帯・天気・季節など)について、目の前の人に軽く一言話しかける',
              fallback: ctx => pick(situationalLines(ctx)) },
  question: { hint: '目の前の人に、答えやすい簡単な質問を1つする。必ず「?」で終わる',
              fallback: () => pick([['tiltL', 'happy', '何か気になるものはありましたか?'],
                                    ['wave', 'happy', 'よかったら、お話ししませんか?'],
                                    ['tiltR', 'happy', '今日はどちらからいらしたんですか?']]) },
};
const OUTCOME_SEC = 30;          // 反応のあとこの秒数のうちに話しかけてくれたら 1、居てくれた時間に応じて 0〜0.6
const LEARN_MIN_TRIALS = 5;      // どのやり方もこの回数試すまでは、試した回数の少ないものを選ぶ
const LEARN_EXPLORE = 0.2;       // それ以降も、この確率で結果に関係なく選ぶ(好みの変化に追いつくため)

/* ---- 記憶 ---- */
const TODAY_NOTES_MAX = 8;       // 今日の会話の要約をいくつ覚えるか
const MASTER_NOTES_MAX = 12;     // マスターとの会話の要約をいくつ覚えるか
// 会話から、律自身のこと(好きなもの・趣味・やっていること)とマスターのことを覚え、次から同じ答えにする。
// 会話が途切れて FACT_IDLE_SEC 秒たち LLM が空いているとき、たまった会話からまとめて抜き出す
const PERSONA_MAX = 24;          // 律について覚える数(古いものから忘れる)
const MASTER_FACTS_MAX = 20;     // マスターについて覚える数
const TERMS_MAX = 40;            // 教えてもらった言葉を覚える数
// 言葉の教え方(「UNO Q っていうのは、律が動いているコンピューターのことだよ」など)。LLM に任せずその場で覚える
const TEACH_RES = [
  /^(.{1,20}?)(?:っていうのは|というのは|って言うのは|っていうのが|とは)[、,\s]*(.{2,80}?)(?:のこと|という意味|って意味|っていう意味)?(?:だよ|です|なんだ|なの|だ|よ|ね)*[。!！]*$/,
  /^(.{1,20}?)は[、,\s]*(.{2,80}?)(?:のこと|という意味|って意味|っていう意味)(?:だよ|です|なんだ|なの|だ|よ|ね)*[。!！]*$/,
];
// 覚えていることを直す言い方(このときは「訂正」で答えるよう、抜き出しの LLM にはっきり伝える)
const CORRECT_RE = /違う|ちがう|じゃなくて|ではなくて|じゃないよ|間違|まちが|訂正|忘れて/;
/** 話しかけが言葉の教え方なら { term, meaning } */
function parseTeach(text) {
  const t = text.trim().replace(/^(ねえ|あのね|律ちゃん|りっちゃん)[、,\s]*/, '');
  for (const re of TEACH_RES) {
    const m = t.match(re);
    if (m && !/[?？]/.test(t)) return { term: m[1].trim(), meaning: m[2].trim() };
  }
  return null;
}
/** a の言葉が b に出てくる割合(2文字ずつ比べる。マスターのことがマスター自身の言葉から来ているかを見る) */
function overlap(a, b) {
  const grams = t => { const g = new Set(); const s = t.replace(/[\s。、!！?？「」]/g, ''); for (let i = 0; i < s.length - 1; i++) g.add(s.slice(i, i + 2)); return g; };
  const ga = grams(a), gb = grams(b);
  if (!ga.size) return 0;
  let n = 0;
  for (const g of ga) if (gb.has(g)) n++;
  return n / ga.size;
}
const FACT_IDLE_SEC = 8;
const FACT_BATCH = 4;            // 一度に見る会話の数
const MEMORY_WAIT_SEC = 10;      // 起動後この秒数のうちに保存した記憶が届かなければ、空の記憶で始める

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
  const text = cleanText(reply);
  return text ? { text, emotion, motion } : null;
}

/** 返答からタグ・記号などを除いた本文。日本語を含まなければ null */
function cleanText(reply) {
  let text = reply.replace(TAG_RE, '')
    .replace(/\[[^\]]*\]/g, '')                               // 崩れたタグ
    .replace(/[*#`_>~|]/g, '')                                  // マークダウン記号
    .replace(/\p{Extended_Pictographic}|\uFE0F/gu, '')           // 絵文字
    .replace(/^\s*(律|りつ|Ritsu|assistant)\s*[:：]\s*/i, '')     // 名前の前置き
    .replace(/[呢吗]/g, '')                                      // 小さいモデルが混ぜる中国語の語気助詞
    .replace(/わたくし|わたし|私(?![たど達])/g, '律')                // 一人称は「律」
    .replace(/\s+/g, ' ').trim()
    .replace(/(です[ねよ]|ます[ねよ]?)[、,]\s*\1/g, '$1')                   // 「ですね、ですね」
    .replace(/^「(.*)」$/, '$1');
  // 「看板」「看板娘」を含む文は除く(律はその言葉を使わない。プロンプトで禁止すると逆に言いやすくなるので、ここで除く)
  if (text.includes('看板')) text = (text.match(/[^。!?！？]+[。!?！？…」]*/g) || []).filter(st => !st.includes('看板')).join('').trim();
  if (!/[\u3040-\u30ff\u4e00-\u9fff]/.test(text)) return null;
  if (text.length > REPLY_MAX_CHARS) {   // 文の区切りで入るところまで残す
    const sentences = text.match(/[^。!?！？]+[。!?！？…」]*/g) || [text];
    let cut = '';
    for (const st of sentences) { if ((cut + st).length > REPLY_MAX_CHARS) break; cut += st; }
    text = cut.trim() || text.slice(0, REPLY_MAX_CHARS - 1) + '…';
  }
  return text;
}

/** 出来事への反応の返答を読む: {wait} / {emotion, motion, text|null}。読めなければ null。
 *  motion は motions のどれか(知らない名前なら先頭) */
function parseDecision(reply, motions, allowWait) {
  if (/\[wait\]/i.test(reply)) return allowWait ? { wait: true } : null;
  let emotion = null, motion = null;
  for (const [, kind, name] of reply.matchAll(TAG_RE)) {
    if (kind === 'emotion' && EMOTIONS.includes(name)) emotion = name;
    if (kind === 'motion' && motions.includes(name)) motion = name;
  }
  const text = cleanText(reply);
  if (!emotion && !motion && !text) return null;
  return { emotion: emotion || 'happy', motion: motion || motions[0], text };
}

const dateLabel = (d = new Date()) => `${d.getMonth() + 1}月${d.getDate()}日`;

class RitsuBrain {
  /** act({text, motion, emotion, source}) でキャラに反映。onStatus(true | 'slow' | false) でLLMランプ更新、
   *  onThinking(on) で返事を考え中かどうかを通知。ctx は RitsuContext(今の状況) */
  /** persist: { put(key, value), log(obj) } — 記憶と反応の記録を ROS 2 の memory ノードへ送る(kiosk 画面だけ)
   *  onQuery(n) — LLM に問い合わせ中の数(独り言・反応も含む。会話の要約は含まない)が変わったとき */
  /** onInterrupt() — 話しかけられた(しゃべっている独り言などを止める)
   *  onTurn({reason}) — 台車ごと相手の方を向いてほしい(台車のノードが顔を見ながら回る) */
  constructor({ act, onStatus, onThinking, onQuery, onInterrupt, onTurn, ctx, persist }) {
    this.onInterrupt = onInterrupt || (() => {});
    this.onTurn = onTurn || (() => {});
    this.sideRequests = new Set();   // 独り言・反応の LLM 問い合わせ(話しかけられたら打ち切る)
    // 静かにしている間は、自分から言うセリフ(独り言・反応 = source が idle〜)を言わず、動きだけにする
    this.act = a => act(this.quiet && a.text && String(a.source).startsWith('idle') ? { ...a, text: null } : a);
    this.quietUntil = 0;
    this.onQuery = onQuery || (() => {});
    this.queries = 0;
    this.llmRestUntil = 0;       // この時刻までは独り言と反応で LLM を使わない(混んでいる・失敗した)
    this.persist = persist || null;
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
    this.greeted = false;        // 今回の来訪で挨拶したか
    this.absentSec = 0;          // 今回の来訪の前に、いなかった秒数
    this.lastEyeContact = -Infinity;
    this.lastTouch = -Infinity;
    this.memory = { today: null, master: null };   // 覚えていること(memory ノードが保存)
    this.memoryLoaded = false;
    this.stats = {};             // 反応のやり方ごとの結果 { 反応: { やり方: [回数, 合計] } }
    this.pending = [];           // 結果を待っている反応
    this.visitLog = [];          // 今回の来訪での会話 [[相手, 律], ...] (去ったら要約して覚える)
    this.lastLinger = -Infinity;
    this.factQueue = [];         // 覚えることを抜き出す前の会話 [{ user, reply, master }]
    setInterval(() => this._learnFacts(), 5000);
    setTimeout(() => { if (!this.memoryLoaded) this.onMemory({}); }, MEMORY_WAIT_SEC * 1000);
    setInterval(() => this._settleOutcomes(), 1000);
    this.ctx.on('arrive', absentSec => this._onArrive(absentSec));
    this.ctx.on('identify', () => this._onIdentify());
    this.ctx.on('look', () => this._onLook());
    this.ctx.on('approach', () => this._onApproach());
    this.ctx.on('far', () => this._onFar());
    this.lastFar = -Infinity;
    this.ctx.on('leave', (stayedSec, dir, visit) => this._onLeave(stayedSec, dir, visit));
    this.ctx.on('near', () => this._onNear());
    this.ctx.on('touch', (dir, hand) => this._onTouch(dir, hand));
  }

  /** from: 'voice' なら声で話しかけられた(目の前の人なので、そちらを向く) */
  async chat(userText, { from } = {}) {
    userText = userText.trim();
    if (!userText) return;
    if (from === 'voice') this._turn('voice');
    if (this.busy) {
      if (this.queue.length < QUEUE_MAX) this.queue.push(userText);
      return;
    }
    // 話しかけが最優先: しゃべっている独り言を止め、独り言・反応の問い合わせを打ち切る(LLM を会話に空ける)
    this.onInterrupt();
    for (const c of this.sideRequests) c.abort();
    if (this._quietCommand(userText)) return;
    const taught = parseTeach(userText);
    if (taught) this.editMemory({ kind: 'term', op: 'add', ...taught });
    this.busy = true;
    this.lastChat = performance.now();
    this.onThinking(true);
    this.lastInteraction = performance.now();
    this.act({ motion: 'listening' });

    if (this.ctx.personPresent && this.visitLog.length === 0 && !this.ctx.isMaster) this._bumpToday('talked');
    this._log({ type: 'chat', len: userText.length, present: this.ctx.personPresent, master: this.ctx.isMaster });
    const { text, motion, emotion, ok } = await this._complete(userText.replace(NICKNAME_RE, '律ちゃん'));
    if (ok) {
      this.visitLog = [...this.visitLog, [userText, text]].slice(-10);
      this.factQueue = [...this.factQueue, { user: userText, reply: text, master: this.ctx.isMaster,
                                             correct: CORRECT_RE.test(userText) }].slice(-FACT_BATCH * 3);
    }
    this.act({ text, motion, emotion, source: ok ? 'llm' : 'fallback' });
    this.lastInteraction = this.lastChat = performance.now();
    this.busy = false;
    this.onThinking(false);
    if (this.queue.length) this.chat(this.queue.shift());
  }

  /** 静かにしている間(QUIET_SEC 秒)か */
  get quiet() { return performance.now() < this.quietUntil; }

  /** 台車ごと目の前の人の方を向く(静かにしている間・人がいないときは向かない) */
  _turn(reason) {
    if (this.quiet || !this.ctx.personPresent) return;
    this.onTurn({ reason });
  }

  /** sec 秒静かにする(0 で取り消す) */
  setQuiet(sec = QUIET_SEC) {
    this.quietUntil = sec > 0 ? performance.now() + sec * 1000 : 0;
    this._log({ type: 'quiet', sec });
  }

  /** 「静かに」「話していいよ」への返事(LLM を使わずすぐ答える)。そうだったら true */
  _quietCommand(userText) {
    if (userText.length > QUIET_MAX_CHARS) return false;
    const resume = RESUME_RE.test(userText);    // 「静かにしなくていいよ」も先にこちらで見る
    if (resume ? !this.quiet : !QUIET_RE.test(userText)) return false;   // 静かにしていないときの「話していいよ」は普通の会話
    this.setQuiet(resume ? 0 : QUIET_SEC);
    const text = pick(resume ? RESUME_LINES : QUIET_LINES);
    this.history = [...this.history, { role: 'user', content: userText }, { role: 'assistant', content: text }].slice(-12);
    this.act({ text, motion: resume ? 'happyBounce' : 'nod', emotion: resume ? 'happy' : 'neutral', source: 'llm' });
    this.lastInteraction = this.lastChat = performance.now();
    return true;
  }

  /** LiteLLM へ問い合わせて返答の本文を返す。失敗したら null */
  /** quiet: 吹き出しに「考え中」を出さない(人に見せない裏の問い合わせ) */
  /** side: 独り言・反応の問い合わせ(話しかけられたら打ち切る) */
  async _request(messages, temperature, timeoutSec = RITSU_CFG.llmTimeoutSec, quiet = false, side = false) {
    if (!quiet) this.onQuery(++this.queries);
    const started = performance.now();
    const cut = side ? new AbortController() : null;
    if (cut) this.sideRequests.add(cut);
    const timeout = AbortSignal.timeout(timeoutSec * 1000);
    try {
      const res = await fetch(`${RITSU_CFG.llmUrl}/v1/chat/completions`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        signal: cut && AbortSignal.any ? AbortSignal.any([timeout, cut.signal]) : timeout,
        body: JSON.stringify({ model: RITSU_CFG.llmModel, messages, temperature, max_tokens: 96 }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
      const reply = (await res.json()).choices[0].message.content.trim();
      const sec = (performance.now() - started) / 1000;
      if (sec > LLM_SLOW_SEC) this.llmRestUntil = performance.now() + LLM_REST_SEC * 1000;
      this.onStatus(sec > LLM_SLOW_SEC ? 'slow' : true);
      return reply;
    } catch (e) {
      if (cut && cut.signal.aborted) return null;   // 話しかけられて打ち切った(LLM の調子は悪くない)
      console.warn('[brain] LLM error:', e);
      this.llmRestUntil = performance.now() + LLM_REST_SEC * 1000;
      this.onStatus(false);
      return null;
    } finally {
      if (cut) this.sideRequests.delete(cut);
      if (!quiet) this.onQuery(--this.queries);
    }
  }

  _systemPrompt({ news = false, about = '' } = {}) {
    const mem = this._memoryText(about);
    return SYSTEM_PROMPT + (this.ctx.isMaster ? `\n${MASTER_PROMPT}` : '') +
           `\n\n# 今の状況\n${this.ctx.describe(new Date(), { news })}` + (mem ? `\n\n# 覚えていること\n${mem}` : '');
  }

  /** 独り言・反応で LLM を使ってよいか。ほかの問い合わせ中や、混んでいる・失敗した直後は使わない
   *  (遅い LLM に問い合わせを重ねると、時間切れになった分まで溜まって、ずっと返事が来なくなるため) */
  _llmFree() {
    return this.queries === 0 && performance.now() >= this.llmRestUntil;
  }

  async _complete(userText) {
    const messages = [{ role: 'system', content: this._systemPrompt({ news: NEWS_RE.test(userText), about: userText }) },
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
        if (!this.busy && !this.deciding && quietSec > RITSU_CFG.idleMinSec && sincePeek > 8 && this._lingering()) {
          this._onLinger();
        } else if (!this.busy && !this.deciding && quietSec > RITSU_CFG.idleMinSec && sincePeek > 8) {   // のぞき込み直後は控える
          const notice = text => this.act({ motion: Math.random() < 0.5 ? 'noticeL' : 'noticeR',
                                            emotion: 'surprised', text, source: 'idle' });
          if (!this.quiet && Math.random() < RITSU_CFG.idleSpeakChance) {   // しゃべる(静かにしている間は動きだけ)
            if (Math.random() < RITSU_CFG.llmIdleChance) this._llmIdleLine();
            else if (Math.random() < NOTICE_CHANCE) notice(NOTICE_LINES[Math.floor(Math.random() * NOTICE_LINES.length)]);
            else {
              const [motion, emotion, text] = this._pickIdleLine();
              this.act({ text, motion, emotion, source: 'idle' });
            }
          } else if (Math.random() < NOTICE_CHANCE) {               // 無言で振り向く
            notice(null);
          } else {                                                   // モーションだけ
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
    if (!this._llmFree()) {      // LLM が混んでいる間は用意したセリフで
      const [motion, emotion, text] = this._pickIdleLine();
      this.act({ text, motion, emotion, source: 'idle' });
      return;
    }
    this.idleGenerating = true;
    const startedChat = this.lastChat;
    // ときどき最近のニュースの見出しを1つ選んで話題にする(見出し1つだけを渡し、ほかの内容を作らせない)
    const news = this.ctx.news.length && Math.random() < RITSU_CFG.newsIdleChance ? pick(this.ctx.news) : null;
    const topic = news ? `最近見たニュース「${news.title}」について、一言だけ感想をつぶやく(見出しに無いことは言わない)`
                       : IDLE_TOPICS[Math.floor(Math.random() * IDLE_TOPICS.length)];
    const recent = this.recentLines.slice(-5).map(t => `- ${t}`).join('\n') || '- (なし)';
    const prompt = `(今は誰にも話しかけられていません。律として、ひとりごとをつぶやいてください)
話題: ${topic}
条件: 1文、40文字以内。いつもの丁寧で柔らかい口調。「今の状況」の日付と矛盾しない内容にする。
motion はつぶやきの内容に合うものを選ぶ(thinking ばかりにしない)。
最近言ったこと(同じ内容・言い回しは避ける):
${recent}`;
    const reply = await this._request([{ role: 'system', content: this._systemPrompt() },
                                       { role: 'user', content: prompt }], 1.0, undefined, false, true);
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
    if (this.busy || this.deciding || (now - this.lastChat) / 1000 < 15 || (now - this.lastReact) / 1000 < REACT_COOLDOWN) return false;
    this.lastReact = this.lastInteraction = now;
    return true;
  }

  /** 出来事への反応を LLM に決めさせる(何を言うか・どう動くか・何もしないか)。
   *  DECIDE_TIMEOUT_SEC までに使える返答が無ければ fallback [motion, emotion, text] を使う。
   *  考えている間に話しかけられた・人が去ったら null(反応しない)。
   *  needText: 何か言わせたい(動きだけの返答は使わない) / allowWait: 何もしない選択を許す /
   *  withHistory: 最近の会話も渡す / reflexMotion: LLM を待たずにすぐ動く(返答ではセリフだけ使う) */
  async _decide(situation, { motions, fallback, needText = false, allowWait = false, withHistory = false, reflexMotion = null }) {
    const useFallback = () => {
      const [motion, emotion, text] = fallback;
      return { motion: reflexMotion ? null : motion, emotion, text, by: 'template' };
    };
    if (!RITSU_CFG.llmReact || !this._llmFree() || this.quiet) return useFallback();   // 静かにしている間はセリフを言わないので LLM も使わない
    const startedChat = this.lastChat;
    const visit = this.ctx.visit;
    const forms = ['- 話しかける: [emotion:名前][motion:名前] セリフ(1〜2文、40文字以内)'];
    if (!needText) forms.push('- 動きだけ(何も言わない): [emotion:名前][motion:名前]');
    if (allowWait) forms.push('- 何もしない: [wait]');
    const prompt = `(カメラで見た出来事に、律としてどう反応するか決めてください。まだ話しかけられてはいません)
出来事: ${situation}
次のどれか1つの形だけで答える:
${forms.join('\n')}
motion は次から選ぶ: ${motions.join(', ')}
最近言ったこと(同じ言い回しは避ける): ${this.recentLines.slice(-4).join(' / ') || 'なし'}`;
    this.deciding = true;
    const reply = await this._request([{ role: 'system', content: this._systemPrompt() },
                                       ...(withHistory ? this.history.slice(-4) : []),
                                       { role: 'user', content: prompt }], 0.9, DECIDE_TIMEOUT_SEC, false, true);
    this.deciding = false;
    if (this.busy || this.lastChat !== startedChat || this.ctx.visit !== visit) return null;
    const d = reply && parseDecision(reply, motions, allowWait);
    const norm = t => t.replace(/[\s。、!！?？…]/g, '');
    const repeated = d && d.text && this.recentLines.some(r => norm(r) === norm(d.text));
    if (!d || (needText && !d.text) || repeated) {   // 最近と同じセリフも使わない
      if (reply) console.warn('[brain] invalid decision:', reply);
      return useFallback();
    }
    if (reflexMotion) d.motion = null;       // 動きはもう始めている
    if (d.text) this.recentLines = [...this.recentLines, d.text].slice(-8);
    return { ...d, by: 'llm' };
  }

  /** _decide の結果を演じて記録する */
  async _react(reaction, situation, opts) {
    const turn = TURN_REACTIONS.has(reaction);
    if (opts.reflexMotion) {
      this.act({ motion: opts.reflexMotion, emotion: opts.fallback[1] });
      if (turn) this._turn(reaction);            // すぐ動く反応は向くのも待たない
    }
    const d = await this._decide(situation, opts);
    if (!d) return;
    this._log({ type: 'react', reaction, arm: opts.arm || null, by: d.by, act: d.wait ? 'wait' : d.text ? 'say' : 'motion',
                master: this.ctx.isMaster });
    if (d.wait) return;
    if (turn && !opts.reflexMotion) this._turn(reaction);
    this.act({ text: d.text, motion: d.motion, emotion: d.emotion, source: d.by === 'llm' ? 'idle-llm' : 'idle' });
  }

  /** 人が来た */
  _onArrive(absentSec) {
    this.greeted = false;
    this.absentSec = absentSec;
    this.visitStart = performance.now();
    this.visitLog = [];
    this._waitedId = false;
    this._bumpToday('visits');
    if (this.ctx.isMaster) this._seeMaster();
    this._log({ type: 'arrive', absent: Math.round(absentSec), z: +(this.ctx.personZ || 0).toFixed(2) });
  }

  /** 顔の見分けが動いているのに、まだ誰か分からない来たばかりの人なら、少し待ってから fn を呼ぶ。
   *  (マスターなのに知らない人として挨拶してしまわないように) 待つなら true */
  _waitForId(fn) {
    const wait = 2.0 - this.ctx.visitSec;
    if (this._waitedId || !this.ctx.recognizerAlive || this.ctx.isMaster || wait <= 0) return false;
    this._waitedId = true;
    setTimeout(fn, wait * 1000);
    return true;
  }

  /** ⑤ 目が合った: まだ挨拶していなければ挨拶(通り過ぎるだけでこちらを見ない人には話しかけない)。
   *  挨拶済みなら、ときどき目が合ったことに反応する */
  _onLook() {
    if (!this.ctx.visit) return;
    if (!this.greeted) {
      if (this.absentSec <= 15) { this.greeted = true; return; }   // ほんの少し見失っただけ
      if (this._waitForId(() => this._onLook())) return;
      if (!this._canReact()) return;              // 会話中などは、次に目が合ったときに挨拶する
      this.greeted = true;
      if (!this.ctx.isMaster) this._bumpToday('looked');
      this._greet();
      return;
    }
    const now = performance.now();
    if ((now - this.lastEyeContact) / 1000 < 120 || Math.random() > 0.4 || !this._canReact()) return;
    this.lastEyeContact = now;
    this._react('eye', '挨拶したあとの人と、また目が合った', {
      motions: REACT_MOTIONS, fallback: pick(EYE_CONTACT_LINES), allowWait: true, withHistory: true });
  }

  /** 挨拶。マスターには親しく、それ以外の人には挨拶のやり方を選んで(学習)LLM にセリフを作らせる */
  _greet() {
    const far = this.ctx.personDistance === 'far';
    if (this.ctx.isMaster) {
      const ms = this.memory.master;
      const topic = ms && ms.notes.length ? '前に話したこと(覚えていること)に少し触れてもよい。' : '';
      this._react('greet_master', `マスターが来て、こちらを見た。${this._masterSeenText()}「マスター」と呼びかけて、嬉しそうに挨拶する。${topic}`, {
        motions: GREET_MOTIONS, needText: true,
        fallback: [pick(['bigWave', 'happyBounce']), 'excited', pick(['マスター、おかえりなさい。', 'あ、マスター。会えて嬉しいです。'])] });
      return;
    }
    if (this.absentSec < 60) {
      this.act({ text: 'おかえりなさい。', motion: 'wave', emotion: 'happy', source: 'idle' });
      this._turn('greet');
      return;
    }
    const style = this._pickArm('greet', Object.keys(GREET_STYLES));
    this._trackOutcome('greet', style);
    this._react('greet', `人が来て、こちらを見た。${far ? '少し離れたところにいる。' : ''}やること: ${GREET_STYLES[style].hint}`, {
      motions: far ? ['comeHere', ...GREET_MOTIONS] : GREET_MOTIONS, needText: true, arm: style,
      fallback: GREET_STYLES[style].fallback(this.ctx, far) });
  }

  /** 来訪の途中でマスターだと分かった: もう挨拶していたら、気づいたことを伝える(挨拶前なら挨拶がマスター向けになる) */
  _onIdentify() {
    this._seeMaster();
    for (const p of this.pending) p.master = true;     // マスターへの反応は学習に入れない
    if (!this.greeted || this.busy || this.deciding) return;
    this.lastReact = this.lastInteraction = performance.now();
    this._react('identify_master', 'さっき知らない人だと思って挨拶した相手が、実はマスター(律を作った人)だと分かった。' +
                'うれしくて少し驚きながら「マスター」と呼びかける', {
      motions: ['surprisedJump', 'happyBounce', 'bigWave', 'kyun'], needText: true, reflexMotion: 'surprisedJump',
      fallback: ['surprisedJump', 'excited', 'あっ、マスターでしたか。来てくれて嬉しいです。'] });
  }

  /** ① こちらを見ながら近づいてきた: すぐ嬉しそうに迎え(反射)、何を言うかは LLM が決める。
   *  遠くで挨拶した直後に近づいてくることが多いので、挨拶の間隔(REACT_COOLDOWN)は待たない */
  _onApproach() {
    const now = performance.now();
    if (!this.ctx.lookedWithin(3) || this.busy || this.deciding || (now - this.lastReact) / 1000 < 3) return;
    this.lastReact = this.lastInteraction = now;
    const greet = !this.greeted;
    this.greeted = true;
    const who = this.ctx.isMaster ? 'マスターが' : '目の前の人が';
    const motion = pick(['happyBounce', 'wave']);
    this._react('approach', `${who}こちらを見ながら近づいてきた。${greet ? 'まだ挨拶していない。' : ''}` +
                  '近くに来てくれたことを嬉しそうに迎える。例: わっ、来てくれたんですね。ゆっくりしていってください。', {
      motions: [motion], needText: true, reflexMotion: motion,
      fallback: [motion, 'happy', (greet && greetingFor(this.ctx)) || pick(APPROACH_LINES)] });
  }

  /** こちらを見ていた人が 50cm ほど下がった: 画面の向こうをのぞき込み(カメラも寄る)、何を言うかは LLM が決める。
   *  こちらを見ないまま去っていく人は見送り(_onLeave)に任せる */
  _onFar() {
    const now = performance.now();
    if (!this.ctx.lookedWithin(2) || this.busy || this.deciding || (now - this.lastReact) / 1000 < 3 ||
        (now - this.lastFar) / 1000 < FAR_COOLDOWN) return;
    this.lastFar = this.lastReact = this.lastInteraction = this.lastPeek = now;
    const who = this.ctx.isMaster ? 'マスター' : '目の前の人';
    this._react('far', `${who}が少し離れたところへ下がった(まだこちらを見ている)。画面の向こうをのぞき込みながら、` +
                'どうしたのか気にして声をかける。例: あれ?ちょっと遠くて見えにくいです。', {
      motions: ['peek'], needText: true, reflexMotion: 'peek', fallback: ['peek', 'surprised', pick(FAR_LINES)] });
  }

  /** 来てから LINGER_SEC 秒以上たち、こちらを見たことがあり、話しかけてはこない人がいる */
  _lingering() {
    const v = this.ctx.visit;
    return this.ctx.personPresent && v && v.looked && this.greeted && this.ctx.visitSec > LINGER_SEC &&
           (performance.now() - Math.max(this.lastChat, this.lastLinger)) / 1000 > 20;
  }

  /** しばらく居てくれる人への声かけ。やり方(動きだけ / 一言 / 質問)を選び(学習)、言葉は LLM が決める */
  _onLinger() {
    this.lastLinger = this.lastInteraction = performance.now();
    const style = this.ctx.isMaster ? pick(['comment', 'question']) : this._pickArm('linger', Object.keys(LINGER_STYLES));
    this._trackOutcome('linger', style);
    const st = LINGER_STYLES[style];
    if (!st.hint) {
      this.act({ motion: pick(IDLE_MOTIONS_ONLY) });
      this._log({ type: 'react', reaction: 'linger', arm: style, by: 'template', act: 'motion' });
      return;
    }
    const who = this.ctx.isMaster ? 'マスター' : '目の前の人';
    this._react('linger', `${who}が${Math.round(this.ctx.visitSec)}秒ほど前からいる(話しかけてはこない)。やること: ${st.hint}`, {
      motions: IDLE_LLM_MOTIONS, allowWait: true, withHistory: true, arm: style, fallback: st.fallback(this.ctx) });
  }

  /** ② 去った: 目が合った・挨拶した・話した・しばらくいた人だけ、去った側を向いて手を振る */
  _onLeave(stayedSec, dir, visit) {
    const talked = this.lastChat > (this.visitStart || 0);
    const engaged = (visit && visit.looked) || this.greeted || talked || stayedSec >= 15;
    const master = !!(visit && visit.master);
    this.greeted = false;
    this._log({ type: 'leave', stayed: Math.round(stayedSec), looked: !!(visit && visit.looked), talked, master });
    if (this.visitLog.length) this._rememberVisit(this.visitLog, master);
    this.visitLog = [];
    if (talked) this.history = [];   // 次の人に前の人との会話を引き継がない(要約は覚えている)
    const now = performance.now();
    if (!engaged || this.busy || (now - this.lastReact) / 1000 < 3) return;   // 見送りは挨拶の間隔を待たない
    this.lastReact = this.lastInteraction = now;
    const night = ['night', 'lateNight'].includes(this.ctx.timeOfDay());
    const text = master ? (night ? 'おやすみなさい、マスター。' : pick(['いってらっしゃい、マスター。', 'マスター、また来てくださいね。']))
               : night ? 'おやすみなさい。またお越しくださいね。'
               : SEE_OFF_LINES[Math.floor(Math.random() * SEE_OFF_LINES.length)];
    this.act({ text, motion: dir > 0 ? 'seeOffR' : dir < 0 ? 'seeOffL' : 'byebye', emotion: 'happy', source: 'idle' });
  }

  /** ③ 画面のすぐ前に手: 内側から同じ側に手を合わせる */
  _onTouch(dir, hand) {
    const now = performance.now();
    if (this.busy || (now - this.lastTouch) / 1000 < TOUCH_COOLDOWN) return;
    this.lastTouch = this.lastReact = this.lastInteraction = now;
    this.act({ text: TOUCH_LINES[Math.floor(Math.random() * TOUCH_LINES.length)],
               motion: dir > 0 ? 'glassTouchR' : 'glassTouchL', emotion: 'happy', source: 'idle', hand });
  }

  _onNear() {
    if (!this._canReact()) return;
    this._react('near', `${this.ctx.isMaster ? 'マスター' : '目の前の人'}が画面のすぐ近くまで来た`, {
      motions: ['mojimoji'], needText: true, reflexMotion: 'mojimoji', fallback: ['mojimoji', 'shy', pick(NEAR_LINES)] });
  }

  /* ================= 反応の学習 ================= */

  /** 反応のやり方を選ぶ。どれも LEARN_MIN_TRIALS 回試すまでは試した回数の少ないもの、
   *  それ以降は LEARN_EXPLORE の確率でどれか、それ以外は結果の平均が一番よいもの */
  _pickArm(reaction, arms) {
    if (!RITSU_CFG.learn) return pick(arms);
    const st = this.stats[reaction] || {};
    const n = a => (st[a] ? st[a][0] : 0);
    const fresh = arms.filter(a => n(a) < LEARN_MIN_TRIALS);
    if (fresh.length) return pick(fresh.filter(a => n(a) === Math.min(...fresh.map(n))));
    if (Math.random() < LEARN_EXPLORE) return pick(arms);
    const mean = a => st[a][1] / st[a][0];
    return arms.reduce((best, a) => (mean(a) > mean(best) ? a : best));
  }

  /** 反応の結果(話しかけてくれたか・居てくれた時間)を OUTCOME_SEC 秒まで見守る。マスターへの反応は数えない */
  _trackOutcome(reaction, arm) {
    if (!this.ctx.personPresent || this.ctx.isMaster) return;
    this.pending.push({ reaction, arm, at: performance.now(), visit: this.ctx.visit && this.ctx.visit.id });
  }

  _settleOutcomes() {
    const now = performance.now();
    this.pending = this.pending.filter(p => {
      const talked = this.lastChat > p.at;
      const gone = !this.ctx.visit || this.ctx.visit.id !== p.visit;
      if (!talked && !gone && now - p.at < OUTCOME_SEC * 1000) return true;
      if (p.master || (!gone && this.ctx.visit.master)) return false;
      const stay = Math.max(0, Math.min(OUTCOME_SEC, (this.ctx.personLastSeen - p.at) / 1000));
      const reward = talked ? 1 : +(0.6 * stay / OUTCOME_SEC).toFixed(3);
      const arms = (this.stats[p.reaction] = this.stats[p.reaction] || {});
      const [n, total] = arms[p.arm] || [0, 0];
      arms[p.arm] = [n + 1, total + reward];
      this._log({ type: 'outcome', reaction: p.reaction, arm: p.arm, reward, talked, stay: Math.round(stay) });
      return false;
    });
  }

  _log(obj) { if (this.persist) this.persist.log(obj); }

  /* ================= 記憶 ================= */

  /** memory ノードから届いた記憶(/ritsu/memory)。最初の1回だけ読み込み、それ以降は自分の記憶を正とする */
  onMemory(m) {
    if (m.stats) this.stats = this._mergeStats(m.stats);
    if (m.news && Array.isArray(m.news.items))
      this.ctx.news = m.news.items.filter(n => n && typeof n.title === 'string').map(n => ({ title: n.title.slice(0, 60), cat: String(n.cat || '') }));
    if (this.memoryLoaded) return;
    this.memoryLoaded = true;
    const local = this.memory;
    this.memory = { today: m.today || null, master: m.master || null, persona: m.persona || null,
                    knowledge: m.knowledge || null };
    // 届く前に覚えたこと(起動直後の来訪など)を足す
    if (local.today) {
      const t = this._today();
      for (const k of ['visits', 'looked', 'talked']) t[k] += local.today[k] || 0;
      t.notes = [...t.notes, ...local.today.notes].slice(-TODAY_NOTES_MAX);
      t.master = t.master || local.today.master;
      this._put('today');
    }
    if (local.knowledge) {
      for (const t of local.knowledge.terms) this._addTerm(t);
      this._put('knowledge');
    }
    if (local.persona) {
      const p = this._persona();
      p.facts = [...p.facts, ...local.persona.facts].slice(-PERSONA_MAX);
      this._put('persona');
    }
    if (local.master) {
      const ms = this._master();
      ms.notes = [...ms.notes, ...local.master.notes].slice(-MASTER_NOTES_MAX);
      ms.facts = [...(ms.facts || []), ...(local.master.facts || [])].slice(-MASTER_FACTS_MAX);
      ms.lastSeen = local.master.lastSeen || ms.lastSeen;
      this._put('master');
    }
  }

  /** 保存された結果に、まだ保存に反映されていない(届いた後の)分は無いので、そのまま使う。
   *  ただし memory ノードが無い間に数えた分は手元のものを残す */
  _mergeStats(saved) {
    const out = JSON.parse(JSON.stringify(saved));
    for (const [r, arms] of Object.entries(this.stats))
      for (const [a, v] of Object.entries(arms))
        if (!out[r] || !out[r][a] || out[r][a][0] < v[0]) (out[r] = out[r] || {})[a] = v;
    return out;
  }

  _put(key) { if (this.persist && this.memoryLoaded) this.persist.put(key, this.memory[key]); }

  /** 今日の記憶(日付が変わったら新しくする) */
  _today() {
    const d = new Date();
    const date = `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
    if (!this.memory.today || this.memory.today.date !== date)
      this.memory.today = { date, visits: 0, looked: 0, talked: 0, master: false, notes: [] };
    return this.memory.today;
  }

  _master() {
    if (!this.memory.master) this.memory.master = { lastSeen: null, notes: [] };
    if (!this.memory.master.facts) this.memory.master.facts = [];
    return this.memory.master;
  }

  /** 律が自分について話したこと { facts: [{ text, date }] } */
  _persona() {
    if (!this.memory.persona) this.memory.persona = { facts: [] };
    return this.memory.persona;
  }

  /** 教えてもらった言葉 { terms: [{ term, meaning, date }] } */
  _knowledge() {
    if (!this.memory.knowledge) this.memory.knowledge = { terms: [] };
    return this.memory.knowledge;
  }

  /** 言葉を覚える(同じ言葉は新しい意味で置き換える) */
  _addTerm({ term, meaning, date }) {
    const terms = this._knowledge().terms;
    const i = terms.findIndex(t => t.term === term);
    if (i >= 0) terms.splice(i, 1);
    terms.push({ term, meaning, date: date || dateLabel() });
    terms.splice(0, Math.max(0, terms.length - TERMS_MAX));
  }

  /** 覚えたことを直す・消す・足す(/remote の「覚えたこと」と、会話での訂正から)。
   *  { kind: 'persona'|'master'|'term', op: 'add'|'update'|'delete', old: 直す前の内容(言葉なら term), text, term, meaning } */
  editMemory({ kind, op, old, text, term, meaning }) {
    const str = (v, n) => typeof v === 'string' ? v.trim().slice(0, n) : '';
    const list = kind === 'persona' ? this._persona().facts : kind === 'master' ? this._master().facts
               : kind === 'term' ? this._knowledge().terms : null;
    if (!list || !['add', 'update', 'delete'].includes(op)) return false;
    const label = f => kind === 'term' ? f.term : f.text;
    const i = list.findIndex(f => label(f) === old);
    const item = kind === 'term' ? { term: str(term, 30), meaning: str(meaning, 80), date: dateLabel() }
                                 : { text: str(text, 40), date: dateLabel() };
    if (op !== 'delete' && !(kind === 'term' ? item.term && item.meaning : item.text)) return false;
    if (op !== 'add' && i < 0) return false;
    if (op === 'delete') list.splice(i, 1);
    else if (kind === 'term') { if (op === 'update') list.splice(i, 1); this._addTerm(item); }
    else if (op === 'update') list[i] = item;
    else {
      if (list.some(f => f.text === item.text)) return false;   // もう覚えている
      list.push(item);
      list.splice(0, Math.max(0, list.length - (kind === 'persona' ? PERSONA_MAX : MASTER_FACTS_MAX)));
    }
    this._put(kind === 'term' ? 'knowledge' : kind);
    console.log('[brain] memory edit:', kind, op, old || '', '→', kind === 'term' ? `${item.term} = ${item.meaning}` : item.text);
    return true;
  }

  /** 覚えていることの一覧 [{ kind, old, show, body }](訂正で番号を付けて見せる) */
  _knownList(master) {
    return [
      ...this._persona().facts.map(f => ({ kind: 'persona', old: f.text, show: `律: ${f.text}`, body: f.text })),
      ...(master ? this._master().facts.map(f => ({ kind: 'master', old: f.text, show: `マスター: ${f.text}`, body: f.text })) : []),
      ...this._knowledge().terms.map(t => ({ kind: 'term', old: t.term, show: `用語: ${t.term} = ${t.meaning}`, body: `${t.term} = ${t.meaning}` })),
    ];
  }

  /** 「違うよ」「AじゃなくてB」で、覚えていることを直す。
   *  まず「AじゃなくてB」の A を覚えていることから探して B に置き換える(声の聞き違いはこれで直る)。
   *  見つからなければ、どれをどう直すかだけを LLM に1行で答えさせる */
  async _correct({ user, master }) {
    const known = this._knownList(master);
    if (!known.length) return;
    const apply = (k, body) => {
      if (k.kind === 'term') {
        const t = body.match(/^(.+?)\s*[=＝]\s*(.+)$/);
        return t && this.editMemory({ kind: 'term', op: 'update', old: k.old, term: t[1], meaning: t[2] });
      }
      return this.editMemory({ kind: k.kind, op: 'update', old: k.old, text: body });
    };
    const sw = user.replace(/^(違う|ちがう)(よ|って|の)?[、,\s]*/, '').match(/^(.+?)(?:じゃなくて|ではなくて|じゃなく)[、,\s]*(.+?)(?:だよ|です|だって|だ|よ|ね|なの)*[。!！]*$/);
    if (sw) {
      const a = sw[1].replace(/[はがをの]$/, ''), b = sw[2].trim();
      // 「趣味は歌じゃなくて雲を眺めること」: 「趣味は」で始まる覚えていることの後ろを丸ごと置き換える
      const xa = a.match(/^(?:律の|りっちゃんの|律ちゃんの|僕の|ぼくの|俺の|私の|わたしの|マスターの)?(.{2,15}?)は(.+)$/);
      const kx = xa && known.find(x => x.kind !== 'term' && x.body.startsWith(`${xa[1]}は`));
      if (kx && apply(kx, `${xa[1]}は${b}`)) return console.log('[brain] corrected:', kx.body, '→', `${xa[1]}は${b}`);
      for (let n = a.length; n >= 2; n--) {           // A の後ろの方から、覚えていることに出てくる一番長い部分を探す
        const part = a.slice(a.length - n);
        const k = known.find(x => x.body.includes(part));
        if (k && apply(k, k.body.split(part).join(b))) return console.log('[brain] corrected:', part, '→', b);
      }
    }
    // 「(律の)好きな花はひまわりだよ」: 「好きな花は」で始まる覚えていることを置き換える(僕・私ならマスター、律なら律のこと)
    const body = user.replace(/^(違う|ちがう)(よ|って|の)?[、,\s]*/, '');
    const xy = body.match(/^(律の|りっちゃんの|律ちゃんの|僕の|ぼくの|俺の|私の|わたしの|マスターの)?(.{2,15}?)は[、,\s]*(.+?)(?:だよ|です|だって|だ|よ|ね|なの)*[。!！]*$/);
    if (xy) {
      const whose = !xy[1] ? null : /律|りっちゃん/.test(xy[1]) ? 'persona' : 'master';
      const k = known.find(x => x.kind !== 'term' && (!whose || x.kind === whose) && x.body.startsWith(`${xy[2]}は`));
      if (k && apply(k, `${xy[2]}は${xy[3].trim()}`)) return console.log('[brain] corrected:', k.body, '→', `${xy[2]}は${xy[3]}`);
    }
    const prompt = `覚えていること:
${known.map((k, i) => `[${i + 1}] ${k.show}`).join('\n')}

${master ? 'マスター' : '相手'}の言葉: 「${user}」
この言葉は、上のどれを直していますか。番号と、直したあとの文を1行だけ書く。
例: 「違うよ、好きな色は青だよ」なら → [2] 好きな色は青
消してほしいだけなら「[番号] 削除」。どれも直していなければ「なし」。`;
    this.learning = true;
    const reply = await this._request([{ role: 'system', content: 'あなたは覚えていることを直す係です。指定の形式の1行だけを書きます。' },
                                       { role: 'user', content: prompt }], 0.1, RITSU_CFG.llmTimeoutSec, true, true);
    this.learning = false;
    const m = reply && reply.match(/\[\s*(\d+)\s*\]\s*(.+)/);
    const k = m && known[+m[1] - 1];
    if (!k) return;
    const fixed = m[2].replace(/^(律|マスター|用語)\s*[:：]\s*/, '').replace(/[。.]+$/, '').trim();
    if (/^削除/.test(fixed)) this.editMemory({ kind: k.kind, op: 'delete', old: k.old });
    else if (!/正しい内容|直したあと/.test(fixed)) apply(k, fixed);   // 例の言葉を写しただけのものは使わない
    console.log('[brain] corrected:', reply.trim());
  }

  /** たまった会話から、律自身のこととマスターのことを抜き出して覚える(会話が途切れて LLM が空いているときだけ) */
  async _learnFacts() {
    if (!this.factQueue.length || this.learning || this.busy || !this._llmFree() ||
        (performance.now() - this.lastChat) / 1000 < FACT_IDLE_SEC) return;
    const fixItem = this.factQueue.find(b => b.correct);
    if (fixItem) {                       // 訂正は専用の処理で(一度に1つ)
      this.factQueue = this.factQueue.filter(b => b !== fixItem);
      return this._correct(fixItem);
    }
    const batch = this.factQueue.splice(0, FACT_BATCH);
    const anyMaster = batch.some(b => b.master);
    // 覚えていることに番号を付けて見せ、訂正・削除は番号で答えさせる
    const known = this._knownList(anyMaster);
    const who = anyMaster ? 'マスター' : '相手';
    const transcript = batch.map(b => `${b.master ? 'マスター' : '相手'}: ${b.user}\n律: ${b.reply}`).join('\n');
    const prompt = `次の会話から、ずっと覚えておくことだけを書き出してください。1行に1つ、次の形だけを使う:
- 律: 律が自分について言ったこと(好きなもの・苦手なもの・趣味・得意なこと・普段していること)。例: 律: 好きな食べ物はいちご
${anyMaster ? '- マスター: マスターが自分について言ったこと(好きなもの・趣味・仕事など)。例: マスター: 猫を飼っている\n' : ''}- 用語: ${who}が教えてくれた言葉の意味。例: 用語: UNO Q = 律が動いている小さなコンピューター
- 訂正 [番号]: ${who}が「違う」「間違っている」と直したとき、下の覚えていることの正しい内容。例: 訂正 [2]: 律: 好きな食べ物はみかん
- 削除 [番号]: ${who}が「忘れて」「それは違う」と言ったとき
各行25文字くらいまで。挨拶・気分・天気・その場だけの話は書かない。覚えていることと同じ内容は書かない。何も無ければ「なし」とだけ書く

覚えていること:
${known.map((k, i) => `[${i + 1}] ${k.show}`).join('\n') || 'なし'}

会話:
${transcript}`;
    this.learning = true;
    const startedChat = this.lastChat;
    const reply = await this._request([{ role: 'system', content: 'あなたは会話から覚えることを書き出す係です。日本語で、指定の形式だけを書きます。' },
                                       { role: 'user', content: prompt }], 0.2, RITSU_CFG.llmTimeoutSec, true, true);
    this.learning = false;
    if (!reply) {                // 話しかけられて打ち切ったなら、あとでもう一度
      if (this.lastChat !== startedChat) this.factQueue = [...batch, ...this.factQueue];
      return;
    }
    const norm = t => t.replace(/[\s。、!！?？「」]/g, '');
    const dup = (list, text) => list.some(f => { const a = norm(f.text), b = norm(text); return a === b || a.includes(b) || b.includes(a); });
    const parseItem = body => {           // 「律: 〜」「マスター: 〜」「用語: 言葉 = 意味」
      const m = body.match(/^(律|マスター|用語)\s*[:：]\s*(.+)$/);
      if (!m) return null;
      const v = m[2].replace(/[。.]+$/, '').trim();
      if (m[1] === '用語') {
        const t = v.match(/^(.+?)\s*[=＝]\s*(.+)$/) || v.match(/^(.+?)(?:は|とは|って)\s*(.+)$/);
        return t ? { kind: 'term', term: t[1].trim(), meaning: t[2].trim() } : null;
      }
      return { kind: m[1] === '律' ? 'persona' : 'master', text: v };
    };
    const done = [];
    for (const raw of reply.split('\n')) {
      const line = raw.replace(/^[\s\-・*]+/, '').trim();
      if (!line || /^なし$/.test(line)) continue;
      const fix = line.match(/^(訂正|削除)\s*\[?\s*(\d+)\s*\]?\s*[:：]?\s*(.*)$/);
      if (fix) {
        const k = known[+fix[2] - 1];
        if (!k) continue;
        if (fix[1] === '削除') { if (this.editMemory({ kind: k.kind, op: 'delete', old: k.old })) done.push(line); continue; }
        const it = parseItem(fix[3]) || (k.kind === 'term' ? null : { kind: k.kind, text: fix[3].replace(/[。.]+$/, '').trim() });
        if (it && it.kind === k.kind && this.editMemory({ ...it, op: 'update', old: k.old })) done.push(line);
        continue;
      }
      const it = parseItem(line);
      if (!it || /^なし$/.test(it.text || it.meaning)) continue;
      // マスターのことは、マスター自身が言ったことだけ(律の返事から作られたもの・律のこと・ほかの人のことは入れない)
      if (it.kind === 'master' && (!anyMaster || it.text.includes('律') ||
                                   overlap(it.text, batch.filter(b => b.master).map(b => b.user).join(' ')) < 0.3)) continue;
      if (it.kind === 'persona' && dup(this._persona().facts, it.text)) continue;
      if (it.kind === 'master' && dup(this._master().facts, it.text)) continue;
      if (this.editMemory({ ...it, op: 'add' })) done.push(line);
    }
    if (done.length) console.log('[brain] learned:', done.join(' / '));
  }


  _bumpToday(key) { this._today()[key]++; this._put('today'); }

  /** マスターに会った(今日会ったことと、前回会った日を覚える) */
  _seeMaster() {
    const t = this._today();
    const ms = this._master();
    this._prevMasterSeen = ms.lastSeen;
    t.master = true;
    ms.lastSeen = Date.now();
    this._put('today');
    this._put('master');
  }

  /** 前回マスターに会ったのはいつか(挨拶に使う) */
  _masterSeenText() {
    const last = this._prevMasterSeen;
    if (!last) return '';
    const days = Math.round((new Date().setHours(0, 0, 0, 0) - new Date(last).setHours(0, 0, 0, 0)) / 86400000);
    if (days <= 0) return '今日はさっきも会った。';
    if (days === 1) return '前に会ったのは昨日。';
    return `前に会ったのは${days}日前(久しぶり)。`;
  }

  /** システムプロンプトに入れる「覚えていること」 */
  /** about: 今の話しかけ(出てきた言葉は意味まで渡す。ほかの言葉は名前だけ) */
  _memoryText(about = '') {
    const lines = [];
    const terms = this.memory.knowledge ? this.memory.knowledge.terms : [];
    if (terms.length) {
      const near = [about, ...this.history.slice(-4).map(h => h.content)].join(' ');
      const hit = terms.filter(t => near.includes(t.term));
      const rest = terms.filter(t => !hit.includes(t));
      if (hit.length) lines.push(`教えてもらった言葉(説明するときはこの意味で): ${hit.map(t => `${t.term} = ${t.meaning}`).join(' / ')}`);
      if (rest.length) lines.push(`ほかに教えてもらった言葉: ${rest.map(t => t.term).join('、')}`);
    }
    const persona = [...(RITSU_CFG.persona || []), ...(this.memory.persona ? this.memory.persona.facts.map(f => f.text) : [])];
    if (persona.length) lines.push(`律自身のこと(前に自分で言ったこと。聞かれたら必ずこれと同じ答えにし、矛盾することは言わない): ${persona.join(' / ')}`);
    const t = this.memory.today;
    const d = new Date();
    if (t && t.date === `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`) {
      lines.push(`今日: 来た人 ${t.visits}人、目が合って挨拶した人 ${t.looked}人、話しかけてくれた人 ${t.talked}人` +
                 (t.master && this.ctx.isMaster ? '。マスターには今日もう会った' : ''));
      // ほかの人との会話はマスターにだけ話してよい(それ以外の人には「今日の様子」だけ)
      if (t.notes.length && this.ctx.isMaster) lines.push(`今日ほかの人と話したこと: ${t.notes.slice(-4).join(' / ')}`);
    }
    const ms = this.memory.master;
    if (this.ctx.isMaster && ms && ms.notes.length) {
      lines.push('マスターと前に話したこと: ' + ms.notes.slice(-5).map(n => `${n.date} ${n.text}`).join(' / '));
    }
    if (this.ctx.isMaster && ms && ms.facts && ms.facts.length) {
      lines.push('マスターのこと(好きなもの・趣味など): ' + ms.facts.map(f => f.text).join(' / '));
    }
    return lines.join('\n');
  }

  /** 去った人との会話を、律の日記として1文にまとめて覚える(マスターとの会話はマスターの記憶にも) */
  async _rememberVisit(log, master) {
    const transcript = log.map(([u, r]) => `相手: ${u}\n律: ${r}`).join('\n');
    const reply = await this._request([
      { role: 'system', content: 'あなたは会話を短く要約する係です。日本語で、本文だけを書きます。' },
      { role: 'user', content: `次は律と${master ? 'マスター' : '来てくれた人'}の会話です。` +
        '相手が話したこと・好み・予定を、事実だけ1文・40文字以内で書いてください。律の感想や相づちは入れない。' +
        `例: 猫カフェに行ってきた。猫が好き。\n\n${transcript}` }], 0.3, RITSU_CFG.llmTimeoutSec, true);
    const text = reply && cleanText(reply);
    if (!text) return;
    const d = new Date();
    const short = text.slice(0, 60);
    if (!master) {      // マスターとの会話はマスターの記憶にだけ入れる
      const t = this._today();
      t.notes = [...t.notes, `${d.getHours()}時 ${short}`].slice(-TODAY_NOTES_MAX);
      this._put('today');
    } else {
      const ms = this._master();
      ms.notes = [...ms.notes, { date: `${d.getMonth() + 1}月${d.getDate()}日`, text: short }].slice(-MASTER_NOTES_MAX);
      this._put('master');
    }
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
