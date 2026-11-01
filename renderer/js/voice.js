/* =========================================================================
 * voice.js — 声で話す
 *   聞く: マイク → 話している区間だけを切り出す(音量で判定) → /stt (Whisper, CT200) → 文字 → onText
 *   話す: 律のセリフ → /tts (VOICEVOX, CT200) → 再生。再生中の音量で口を動かす(level)
 *   律がしゃべっている間と、その直後はマイクを使わない(自分の声を聞き取らないように)。
 *   スピーカーフォン(Anker PowerConf)本体とブラウザの両方のエコーキャンセルも使う。
 * ========================================================================= */

const VOICE_FRAME = 2048;          // 音量を見る単位 [サンプル] (48kHz で約43ms)
const VOICE_START_FRAMES = 3;      // 声の大きさがこの回数続いたら話し始め(約130ms)
const VOICE_END_SEC = 1.0;         // この秒数静かになったら話し終わり(短いと言葉の途中の間で切れ、続きを聞き逃す)
const VOICE_MIN_SEC = 0.4;         // これより短い音は咳や物音として捨てる
const VOICE_MAX_SEC = 12;          // 長すぎる話はここで区切る
const VOICE_PREROLL = 8;           // 話し始めの前も少し含める [単位] (約350ms。語頭が切れないように)
const VOICE_MIN_RMS = 0.012;       // 静かな部屋でも、これより小さい音は声とみなさない
const VOICE_NOISE_K = 3;           // 周りの雑音の何倍の大きさなら声とみなすか
// 相槌。返事を待たせずにすぐ言えるよう、話者が決まったら先に作っておく
//   ack: 相手が話し終わった直後 / think: 返事を考えるのに時間がかかっているとき
const FILLERS = { ack: ['うんうん', 'はい', 'なるほど', 'ふむふむ', 'うん'], think: ['えっと……', 'うーん、そうですね……'] };
const VOICE_TAIL_SEC = 0.5;        // 律がしゃべり終えてから、この秒数はマイクを使わない(残響を拾わないように)
// 無音や雑音から Whisper が作りがちな文(動画の締めの言葉など)。これだけなら捨てる
// 「律ちゃん」の聞き違い(小さいモデルは「ただしちゃん」「りっちゃん」などと書く)を直す
const NAME_FIX = /(りつ|リツ|りっ|リッ|ただし|立|率)(ちゃん|さん)/g;
// 読み上げで VOICEVOX が読み間違える記号を、読み方に直す(字幕はそのまま)。「℃」は「ドシー」と読んでしまう
const READ_FIX = [
  [/(?<![\dA-Za-z])[-−](?=\d)/g, 'マイナス'],       // -3℃ (「3-4」のような区切りはそのまま)
  [/(?:℃|°[CＣ]|度C)/g, '度'],
  [/[%％]/g, 'パーセント'],
  [/(\d)\s*[〜～~]\s*(?=\d)/g, '$1から'],
];
const readable = text => READ_FIX.reduce((t, [re, to]) => t.replace(re, to), text);
const STT_HALLUCINATIONS = /^(ご視聴ありがとうございました|チャンネル登録(よろしくお願いします)?|ご清聴ありがとうございました|おやすみなさい|字幕.*|はい)[。!！]?$/;

// マイクの音を VOICE_FRAME サンプルずつまとめてメインスレッドへ送る AudioWorklet(ファイルを分けないよう文字列で持つ)
const CAPTURE_WORKLET = `
class RitsuCapture extends AudioWorkletProcessor {
  constructor(o) { super(); this.frame = o.processorOptions.frame; this.buf = new Float32Array(this.frame); this.n = 0; }
  process(inputs) {
    const x = inputs[0] && inputs[0][0];
    if (x) for (let i = 0; i < x.length; i++) {
      this.buf[this.n++] = x[i];
      if (this.n === this.frame) { this.port.postMessage(this.buf, [this.buf.buffer]); this.buf = new Float32Array(this.frame); this.n = 0; }
    }
    return true;
  }
}
registerProcessor('ritsu-capture', RitsuCapture);
`;

class RitsuVoice {
  /** cfg: config.js の voice / onText(text): 聞き取れた言葉 / canListen(): 今聞いてよいか /
   *  onState(state): 'off' | 'ready' | 'paused'(人がいない・返事中などで聞いていない) | 'hearing' | 'recognizing'
   *  (MIC ランプ用) / onRecognizing(on) /
   *  onSpeechEnd(sec): 相手が話し終わった(文字にする前。相槌用) */
  constructor(cfg, { onText, canListen, onState, onRecognizing, onSpeechEnd } = {}) {
    this.cfg = Object.assign({ stt: '/stt', tts: '/tts', speaker: 'WhiteCUL', style: 'ノーマル', speed: 1.0,
                               volume: 1.0, listen: true }, cfg || {});
    this.onText = onText || (() => {});
    this.canListen = canListen || (() => true);
    this.onState = onState || (() => {});
    this.onRecognizing = onRecognizing || (() => {});
    this.onSpeechEnd = onSpeechEnd || (() => {});
    this.fillers = { ack: [], think: [] };   // 相槌の音声(AudioBuffer)
    // マイクの様子(確認用。RITSU.micTest() と /remote の「マイク」)
    //   frames: 届いた音の数(増えていればマイクの音は来ている) / peak: 前回見たとき以降の一番大きい音 /
    //   why: 聞いていない理由 / heard・ignored・error: 最後に文字にしたもの・捨てたもの・失敗
    this.mic = { level: 0, peak: 0, threshold: 0, listening: false, why: '', device: '', capture: '', frames: 0,
                 heard: null, ignored: null, error: null };   // マイクの様子(確認用。RITSU.micTest())
    this.ctx = null;
    this.speakerId = null;
    this.ttsOk = false;
    this.level = 0;                // 再生中の音量 0..1 (口の開き)
    this.speaking = false;
    this.speakEnd = 0;             // しゃべり終えた時刻
    this._seq = 0;
    this._src = null;
    this._levelBuf = null;
  }

  /** 音声の準備。自動再生の制限で止まっていたら、最初のタップ・キー入力で動かす */
  async init() {
    this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 512;
    this._levelBuf = new Float32Array(this.analyser.fftSize);
    this.out = this.ctx.createGain();
    this.out.gain.value = this.cfg.volume;
    this.analyser.connect(this.out).connect(this.ctx.destination);
    const resume = () => { if (this.ctx.state === 'suspended') this.ctx.resume(); };
    addEventListener('pointerdown', resume);
    addEventListener('keydown', resume);
    resume();
    await this._findSpeaker();
    if (this.cfg.listen) this._startMic();
  }

  /** VOICEVOX の話者一覧から、設定した声(名前・スタイル)の番号を探す */
  async _findSpeaker() {
    try {
      const res = await fetch(`${this.cfg.tts}/speakers`, { signal: AbortSignal.timeout(10000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const speakers = await res.json();
      const sp = speakers.find(s => s.name === this.cfg.speaker);
      const st = sp && (sp.styles.find(s => s.name === this.cfg.style) || sp.styles[0]);
      if (!st) throw new Error(`speaker not found: ${this.cfg.speaker}/${this.cfg.style}`);
      this.speakerId = st.id;
      this.ttsOk = true;
      console.log(`[voice] speaker ${this.cfg.speaker}(${st.name}) = ${st.id}`);
      this._prepareFillers();
    } catch (e) {
      console.warn('[voice] TTS unavailable:', e);
      this.ttsOk = false;
      setTimeout(() => this._findSpeaker(), 30000);   // CT200 が後から起きたときに備えて探し直す
    }
  }

  /* ================= 話す ================= */

  /** セリフを読み上げる。最初の文を再生し始めたら true になる Promise(字幕の口パクの代わりに音量で口を動かす)。
   *  文ごとに分けて、最初の文ができたらすぐ話し始め、話している間に次の文を作る(話し始めを早くする)。
   *  新しいセリフが来たら、前のセリフは止める */
  speak(text) {
    if (!this.ttsOk || !text) return Promise.resolve(false);
    const seq = ++this._seq;
    this.stop();
    text = readable(text);
    const sentences = (text.match(/[^。!?！？]+[。!?！？…」]*/g) || [text]).map(t => t.trim()).filter(Boolean);
    const jobs = [];
    const synth = i => (jobs[i] = jobs[i] || this._synth(sentences[i]));
    return new Promise(resolve => {
      (async () => {
        let started = false;
        try {
          for (let i = 0; i < sentences.length; i++) {
            const buf = await synth(i);
            if (seq !== this._seq) break;                    // 作っている間に次のセリフが来た
            if (i + 1 < sentences.length) synth(i + 1).catch(() => {});
            const ended = this._play(buf);
            if (!started) { started = true; resolve(true); }
            await ended;
            if (seq !== this._seq) break;
          }
        } catch (e) {
          console.warn('[voice] speak error:', e);
        }
        if (!started) resolve(false);
        if (seq === this._seq) { this.speaking = false; this.speakEnd = performance.now(); }
      })();
    });
  }

  /** VOICEVOX で1文の音声を作る */
  async _synth(text) {
    const q = await fetch(`${this.cfg.tts}/audio_query?speaker=${this.speakerId}&text=${encodeURIComponent(text)}`,
                          { method: 'POST', signal: AbortSignal.timeout(10000) });
    if (!q.ok) throw new Error(`audio_query HTTP ${q.status}`);
    const query = await q.json();
    query.speedScale = this.cfg.speed;
    query.prePhonemeLength = 0.05;
    query.postPhonemeLength = 0.1;
    const res = await fetch(`${this.cfg.tts}/synthesis?speaker=${this.speakerId}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(query),
      signal: AbortSignal.timeout(20000) });
    if (!res.ok) throw new Error(`synthesis HTTP ${res.status}`);
    return this.ctx.decodeAudioData(await res.arrayBuffer());
  }

  /** 1文を再生する。再生が終わる(か止められる)と解決する */
  _play(buf) {
    return new Promise(resolve => {
      const src = this.ctx.createBufferSource();
      src.buffer = buf;
      src.connect(this.analyser);
      src.onended = () => { if (this._src === src) this._src = null; resolve(); };
      this._src = src;
      this.speaking = true;
      src.start();
    });
  }

  /** 相槌の音声を先に作っておく(失敗した相槌は使わないだけ) */
  async _prepareFillers() {
    for (const [kind, texts] of Object.entries(FILLERS)) {
      this.fillers[kind] = [];
      for (const t of texts) {
        try { this.fillers[kind].push(await this._synth(t)); } catch (e) { console.warn('[voice] filler:', t, e); }
      }
    }
  }

  /** 相槌を言う(kind: 'ack' | 'think')。読み上げ中なら言わない。言えたら true */
  filler(kind) {
    const list = this.fillers[kind];
    if (!list || !list.length || this.speaking) return false;
    const seq = ++this._seq;
    this._play(list[Math.floor(Math.random() * list.length)]).then(() => {
      if (seq === this._seq) { this.speaking = false; this.speakEnd = performance.now(); }
    });
    return true;
  }

  stop() {
    if (this._src) {
      const src = this._src;
      this._src = null;
      try { src.stop(); } catch { /* もう止まっている */ }
      this.speaking = false;
      this.speakEnd = performance.now();
    }
  }

  /** 毎フレーム呼ぶ: 再生中の音量を口の開き(0..1)にする */
  update() {
    if (!this.speaking) { this.level = 0; return 0; }
    this.analyser.getFloatTimeDomainData(this._levelBuf);
    let sum = 0;
    for (const v of this._levelBuf) sum += v * v;
    this.level = Math.min(1, Math.sqrt(sum / this._levelBuf.length) * 6);
    return this.level;
  }

  /* ================= 聞く ================= */

  async _startMic() {
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
    } catch (e) {
      console.warn('[voice] mic unavailable:', e);
      this.onState('off');
      return;
    }
    this.mic.device = stream.getAudioTracks()[0] ? stream.getAudioTracks()[0].label : '';
    console.log('[voice] mic:', this.mic.device);
    const src = this.ctx.createMediaStreamSource(stream);
    const mute = this.ctx.createGain();
    mute.gain.value = 0;                            // マイクの音はスピーカーへ流さない
    mute.connect(this.ctx.destination);
    const frameSec = VOICE_FRAME / this.ctx.sampleRate;
    let noise = 0.005, loud = 0, quiet = 0, inSpeech = false, lastBusy = null;
    let chunks = [], pre = [];
    this.onState('ready');
    const onFrame = x => {
      let sum = 0;
      for (const v of x) sum += v * v;
      const rms = Math.sqrt(sum / x.length);
      const why = this.speaking ? '律が話している' : performance.now() - this.speakEnd < VOICE_TAIL_SEC * 1000 ? '話し終わった直後'
                : !this.canListen() ? '返事を考え中か、カメラに人がいない' : '';
      const busy = !!why;
      const th = Math.max(VOICE_MIN_RMS, noise * VOICE_NOISE_K);
      this.mic.frames++;
      this.mic.why = why;
      this.mic.peak = Math.max(this.mic.peak, rms);
      this.mic.level = rms;
      this.mic.threshold = th;
      if (busy !== lastBusy) {                      // 聞く/聞かないが変わったらランプへ
        lastBusy = busy;
        this.mic.listening = !busy;
        if (!inSpeech) this.onState(busy ? 'paused' : 'ready');
      }
      if (busy) {                                   // 聞かない間は捨てる
        if (inSpeech) this.onState('paused');
        inSpeech = false; loud = 0; chunks = []; pre = [];
        return;
      }
      if (!inSpeech) {
        noise += (rms - noise) * (rms < th ? 0.05 : 0.005);   // 周りの雑音の大きさをゆっくり追う
        pre.push(x);
        if (pre.length > VOICE_PREROLL) pre.shift();
        loud = rms > th ? loud + 1 : 0;
        if (loud >= VOICE_START_FRAMES) {
          inSpeech = true; quiet = 0; chunks = [...pre]; pre = [];
          this.onState('hearing');
        }
        return;
      }
      chunks.push(x);
      quiet = rms > th * 0.7 ? 0 : quiet + 1;
      const sec = chunks.length * frameSec;
      if (quiet * frameSec >= VOICE_END_SEC || sec >= VOICE_MAX_SEC) {
        inSpeech = false;
        const speech = chunks.slice(0, chunks.length - Math.max(0, quiet - 2));   // 後ろの無音を落とす
        chunks = [];
        this.onState('ready');
        const sec = speech.length * frameSec - VOICE_PREROLL * frameSec;
        if (sec >= VOICE_MIN_SEC) {
          this.lastClip = speech;                   // 確認用(RITSU.replay() で聞き直せる)
          this._recognize(speech);
          this.onSpeechEnd(sec);
        }
      }
    };
    // 音の取り込みは AudioWorklet(音専用のスレッド)で。ScriptProcessor は画面の描画と同じスレッドで動くので、
    // UNO Q のように描画が重いと間に合わずに音が抜け、言葉が途切れて文字になる。使えないブラウザだけ ScriptProcessor
    let node;
    try {
      if (this.cfg.capture === 'script') throw new Error('capture=script');
      const url = URL.createObjectURL(new Blob([CAPTURE_WORKLET], { type: 'application/javascript' }));
      await this.ctx.audioWorklet.addModule(url);
      node = new AudioWorkletNode(this.ctx, 'ritsu-capture', { processorOptions: { frame: VOICE_FRAME } });
      node.port.onmessage = e => onFrame(e.data);
      this.mic.capture = 'AudioWorklet';
    } catch (e) {
      console.warn('[voice] AudioWorklet unavailable, using ScriptProcessor:', e);
      node = this.ctx.createScriptProcessor(VOICE_FRAME, 1, 1);
      node.onaudioprocess = ev => onFrame(new Float32Array(ev.inputBuffer.getChannelData(0)));
      this.mic.capture = 'ScriptProcessor';
    }
    src.connect(node).connect(mute);
    console.log('[voice] capture:', this.mic.capture);
    this._keepAlive = [stream, src, node];          // ガベージコレクトで止まらないように
  }

  /** 最後に聞き取った声を再生する(確認用。途切れて聞こえるなら取り込みで音が抜けている) */
  replay() {
    if (!this.lastClip) return false;
    const n = this.lastClip.reduce((a, c) => a + c.length, 0);
    const buf = this.ctx.createBuffer(1, n, this.ctx.sampleRate);
    let o = 0;
    for (const c of this.lastClip) { buf.getChannelData(0).set(c, o); o += c.length; }
    const s = this.ctx.createBufferSource();
    s.buffer = buf;
    s.connect(this.ctx.destination);
    s.start();
    return n / this.ctx.sampleRate;
  }

  /** 切り出した声を 16kHz の WAV にして Whisper へ送る */
  async _recognize(chunks) {
    const wav = encodeWav16k(chunks, this.ctx.sampleRate);
    const form = new FormData();
    form.append('file', new Blob([wav], { type: 'audio/wav' }), 'speech.wav');
    form.append('language', 'ja');
    form.append('prompt', '律ちゃん、こんにちは。');   // 名前を「律」と書きやすくするヒント
    this.onState('recognizing');
    this.onRecognizing(true);
    let text = '';
    try {
      const res = await fetch(`${this.cfg.stt}/v1/audio/transcriptions`, { method: 'POST', body: form,
                                                                           signal: AbortSignal.timeout(15000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      text = ((await res.json()).text || '').trim().replace(NAME_FIX, '律$2');
    } catch (e) {
      console.warn('[voice] STT error:', e);
      this.mic.error = { text: String(e), at: Date.now() };
    }
    const sec = +(chunks.length * VOICE_FRAME / this.ctx.sampleRate).toFixed(1);
    this.onRecognizing(false);
    this.onState('ready');
    if (!text || STT_HALLUCINATIONS.test(text) || !/[\p{L}\p{N}]/u.test(text)) {
      if (text) console.log('[voice] ignored:', text);
      this.mic.ignored = { text, sec, at: Date.now() };
      return;
    }
    console.log(`[voice] heard (${sec}s):`, text);
    this.mic.heard = { text, sec, at: Date.now() };
    this.onText(text.slice(0, 200));
  }
}

/** Float32 の音(複数のかたまり)を 16kHz・16bit・モノラルの WAV にする */
function encodeWav16k(chunks, rate) {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const ratio = rate / 16000;
  const n = Math.floor(total / ratio);
  const pcm = new Int16Array(n);
  let ci = 0, off = 0;
  const at = i => {                                 // 通しの番号 i のサンプル
    while (i - off >= chunks[ci].length) { off += chunks[ci].length; ci++; }
    return chunks[ci][i - off];
  };
  for (let i = 0; i < n; i++) {                     // 区間の平均で間引く(簡単な低域通過を兼ねる)
    const a = Math.floor(i * ratio), b = Math.min(total, Math.floor((i + 1) * ratio));
    let s = 0;
    for (let j = a; j < b; j++) s += at(j);
    pcm[i] = Math.max(-1, Math.min(1, s / Math.max(1, b - a))) * 0x7fff;
  }
  const buf = new ArrayBuffer(44 + pcm.byteLength);
  const v = new DataView(buf);
  const str = (o, s) => [...s].forEach((ch, k) => v.setUint8(o + k, ch.charCodeAt(0)));
  str(0, 'RIFF'); v.setUint32(4, 36 + pcm.byteLength, true); str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, 16000, true); v.setUint32(28, 32000, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, pcm.byteLength, true);
  new Int16Array(buf, 44).set(pcm);
  return buf;
}

window.RitsuVoice = RitsuVoice;
