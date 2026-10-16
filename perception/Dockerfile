# Orbbec Gemini 335 人検出サービス (x86_64 の開発PC / arm64 どちらでも)
FROM python:3.10-slim-bookworm

RUN apt-get update && apt-get install -y --no-install-recommends \
    libgl1 libglib2.0-0 libusb-1.0-0 udev \
    && rm -rf /var/lib/apt/lists/*

# Orbbec公式Python SDK (Gemini 335対応)。Linux x64 / arm64 向けの公式wheelを利用する。
# サンプル用の依存(open3d・pygame・evdev 等。evdev はコンパイルが必要)まで入るため --no-deps で本体だけ入れる。
# 実行に必要な numpy は requirements.txt 側で入る。
RUN pip install --no-cache-dir --no-deps pyorbbecsdk2==2.1.1

COPY requirements.txt .
RUN pip install --no-cache-dir --timeout 120 --retries 10 -r requirements.txt

WORKDIR /app
COPY app.py .
ENV PYTHONUNBUFFERED=1
CMD ["python", "app.py"]
