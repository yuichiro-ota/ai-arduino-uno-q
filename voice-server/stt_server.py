#!/usr/bin/env python3
"""
stt_server.py — 律の文字起こしサーバー (faster-whisper)

律の画面(ブラウザ)が切り出した声(WAV)を受け取り、文字にして返す。CT200 (RTX 3050) で動かす想定。
OpenAI の文字起こし API と同じ形なので、ほかの道具からも使える。

  POST /v1/audio/transcriptions   multipart: file=音声, language=ja(省略可), prompt=言い回しのヒント(省略可)
                                  → {"text": "...", "duration": 秒, "elapsed": 処理秒}
  GET  /health                    → {"ok": true, "model": "..."}

環境変数:
  WHISPER_MODEL    モデル (default large-v3-turbo。軽くするなら small / medium)
  WHISPER_DEVICE   cuda / cpu (default cuda)
  WHISPER_COMPUTE  計算の精度 (default: cuda なら int8_float16、cpu なら int8)
  WHISPER_DIR      モデルの保存先 (default /opt/ritsu-voice/models)
"""
import io
import os
import time
import wave

import numpy as np

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from faster_whisper import WhisperModel

MODEL = os.environ.get("WHISPER_MODEL", "large-v3-turbo")
DEVICE = os.environ.get("WHISPER_DEVICE", "cuda")
COMPUTE = os.environ.get("WHISPER_COMPUTE", "int8_float16" if DEVICE == "cuda" else "int8")
MODEL_DIR = os.environ.get("WHISPER_DIR", "/opt/ritsu-voice/models")
MAX_BYTES = 5 * 1024 * 1024      # 16kHz モノラルで約2分半。これより大きい音声は受け付けない
NO_SPEECH = 0.6                  # 「声ではない」確率がこれより高い区間は捨てる(無音で文を作る幻聴を防ぐ)

print(f"[stt] loading {MODEL} on {DEVICE} ({COMPUTE})", flush=True)
model = WhisperModel(MODEL, device=DEVICE, compute_type=COMPUTE, download_root=MODEL_DIR)
print("[stt] ready", flush=True)
app = FastAPI()


def load_audio(data):
    """WAV(律の画面が送る 16kHz・16bit)は自分で読む(PyAV の版によって読めないことがあるため)。
    それ以外の形式は faster-whisper(PyAV)に任せる"""
    if data[:4] != b"RIFF":
        return io.BytesIO(data)
    with wave.open(io.BytesIO(data)) as w:
        if w.getsampwidth() != 2:
            return io.BytesIO(data)
        rate, ch = w.getframerate(), w.getnchannels()
        x = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float32) / 32768.0
    if ch > 1:
        x = x.reshape(-1, ch).mean(axis=1)
    if rate != 16000:                                  # 16kHz へ(線形補間)
        n = int(len(x) * 16000 / rate)
        x = np.interp(np.linspace(0, len(x) - 1, n), np.arange(len(x)), x).astype(np.float32)
    return x


@app.get("/health")
def health():
    return {"ok": True, "model": MODEL, "device": DEVICE}


@app.post("/v1/audio/transcriptions")
def transcribe(file: UploadFile = File(...), language: str = Form("ja"), prompt: str = Form(None),
               model_name: str = Form(None, alias="model")):
    data = file.file.read(MAX_BYTES + 1)
    if len(data) > MAX_BYTES:
        raise HTTPException(413, "audio too large")
    started = time.time()
    try:
        segments, info = model.transcribe(load_audio(data), language=language or None, beam_size=1,
                                          vad_filter=True, condition_on_previous_text=False,
                                          initial_prompt=prompt or None)
        text = "".join(s.text for s in segments if s.no_speech_prob < NO_SPEECH).strip()
    except Exception as e:   # 壊れた音声など
        raise HTTPException(400, f"cannot transcribe: {e}")
    elapsed = time.time() - started
    print(f"[stt] {info.duration:.1f}s audio → {elapsed:.2f}s: {text[:40]}", flush=True)
    return {"text": text, "duration": round(info.duration, 2), "elapsed": round(elapsed, 2)}
