/* =========================================================================
 * voice.js — 声で話す
 *   聞く: マイク → 話している区間だけを切り出す(音量で判定) → /stt (Whisper, CT200) → 文字 → onText
 *   話す: 律のセリフ → /tts (VOICEVOX, CT200) → 再生。再生中の音量で口を動かす(level)
 *   律がしゃべっている間と、その直後はマイクを使わない(自分の声を聞き取らないように)。
 *   スピーカーフォン(Anker PowerConf)本体とブラウザの両方のエコーキャンセルも使う。
 * ========================================================================= */

const VOICE_FRAME = 2048;          // 音量を見る単位 [サンプル] (48kHz で約43ms)
const VOICE_START_FRAMES = 3;      // 声の大きさがこの回数続いたら話し始め(約130ms)
const VOICE_END_SEC = 0.7;         // この秒数静かになったら話し終わり
const VOICE_MIN_SEC = 0.4;         // これより短い音は咳や物音として捨てる
const VOICE_MAX_SEC = 12;          // 長すぎる話はここで区切る
const VOICE_PREROLL = 8;           // 話し始めの前も少し含める [単位] (約350ms。語頭が切れないように)
const VOICE_MIN_RMS = 0.012;       // 静かな部屋でも、これより小さい音は声とみなさない
const VOICE_NOISE_K = 3;           // 周りの雑音の何倍の大きさなら声とみなすか
const VOICE_TAIL_SEC = 0.5;        // 律がしゃべり終えてから、この秒数はマイクを使わない(残響を拾わないように)
// 無音や雑音から Whisper が作りがちな文(動画の締めの言葉など)。これだけなら捨てる
// 「律ちゃん」の聞き違い(小さいモデルは「ただしちゃん」「りっちゃん」などと書く)を直す
const NAME_FIX = /(りつ|リツ|りっ|リッ|ただし|立|率)(ちゃん|さん)/g;
const STT_HALLUCINATIONS = /^(ご視聴ありがとうございました|チャンネル登録(よろしくお願いします)?|ご清聴ありがとうございました|おやすみなさい|字幕.*|はい)[。!！]?$/;

class RitsuVoice {
  /** cfg: config.js の voice / onText(text): 聞き取れた言葉 / canListen(): 今聞いてよいか /
   *  onState(state): 'off' | 'ready' | 'hearing' | 'recognizing' (MIC ランプ用) / onRecognizing(on) */
  constructor(cfg, { onText, canListen, onState, onRecognizing } = {}) {
    this.cfg = Object.assign({ stt: '/stt', tts: '/tts', speaker: 'WhiteCUL', style: 'ノーマル', speed: 1.0,
                               volume: 1.0, listen: true }, cfg || {});
    this.onText = onText || (() => {});
    this.canListen = canListen || (() => true);
    this.onState = onState || (() => {});
    this.onRecognizing = onRecognizing || (() => {});
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
    const src = this.ctx.createMediaStreamSource(stream);
    // ScriptProcessor は古い方式だが、UNO Q の Chromium でも確実に動き、ファイルを分けなくてよい
    const proc = this.ctx.createScriptProcessor(VOICE_FRAME, 1, 1);
    const mute = this.ctx.createGain();
    mute.gain.value = 0;                            // マイクの音はスピーカーへ流さない
    src.connect(proc).connect(mute).connect(this.ctx.destination);
    const frameSec = VOICE_FRAME / this.ctx.sampleRate;
    let noise = 0.005, loud = 0, quiet = 0, inSpeech = false;
    let chunks = [], pre = [];
    this.onState('ready');
    proc.onaudioprocess = e => {
      const x = new Float32Array(e.inputBuffer.getChannelData(0));
      let sum = 0;
      for (const v of x) sum += v * v;
      const rms = Math.sqrt(sum / x.length);
      const busy = this.speaking || performance.now() - this.speakEnd < VOICE_TAIL_SEC * 1000 || !this.canListen();
      if (busy) {                                   // 聞かない間は捨てる
        if (inSpeech) this.onState('ready');
        inSpeech = false; loud = 0; chunks = []; pre = [];
        return;
      }
      const th = Math.max(VOICE_MIN_RMS, noise * VOICE_NOISE_K);
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
        if (speech.length * frameSec >= VOICE_MIN_SEC + VOICE_PREROLL * frameSec) this._recognize(speech);
      }
    };
    this._keepAlive = [stream, src, proc];          // ガベージコレクトで止まらないように
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
    }
    this.onRecognizing(false);
    this.onState('ready');
    if (!text || STT_HALLUCINATIONS.test(text) || !/[\p{L}\p{N}]/u.test(text)) {
      if (text) console.log('[voice] ignored:', text);
      return;
    }
    console.log('[voice] heard:', text);
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
