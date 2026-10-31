# 律の ROS 2 (Jazzy) ノード群: rosbridge と人検出(Orbbec Gemini 335)
# x86_64 の開発PC / arm64 の UNO Q どちらでも同じイメージでビルドできる
FROM ros:jazzy-ros-base

RUN apt-get update && apt-get install -y --no-install-recommends \
    ros-jazzy-rosbridge-server python3-pip libusb-1.0-0 udev \
    && rm -rf /var/lib/apt/lists/*

# Orbbec公式Python SDK。サンプル用の依存(open3d等)まで入るため --no-deps で本体だけ入れる
RUN pip install --no-cache-dir --break-system-packages --no-deps pyorbbecsdk2==2.1.1
COPY requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir --break-system-packages -r /tmp/requirements.txt

WORKDIR /app
# 顔検出モデル YuNet (OpenCV Zoo, MIT License, 約230KB)
ADD https://media.githubusercontent.com/media/opencv/opencv_zoo/main/models/face_detection_yunet/face_detection_yunet_2023mar.onnx models/yunet.onnx
# 顔の見分け(マスターの顔) SFace (OpenCV Zoo, Apache 2.0, 約37MB)
ADD https://media.githubusercontent.com/media/opencv/opencv_zoo/main/models/face_recognition_sface/face_recognition_sface_2021dec.onnx models/sface.onnx
COPY ritsu_perception.py ritsu_memory.py ./
ENV PYTHONUNBUFFERED=1
