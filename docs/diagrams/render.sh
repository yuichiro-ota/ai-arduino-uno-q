#!/bin/bash
# *.mmd (Mermaid) → *.png。Docker の Playwright で描く(日本語フォントは Windows の BIZ UDゴシック)
# 使い方: docs/diagrams で ./render.sh   (1枚だけなら ./render.sh 01-hardware.mmd)
cd "$(dirname "$0")"
docker run --rm -i -v "$PWD":/d -v /mnt/c/Windows/Fonts:/usr/share/fonts/win:ro \
  mcr.microsoft.com/playwright/python:v1.48.0-jammy bash -c \
  "pip install -q playwright==1.48.0 >/dev/null 2>&1; fc-cache -f >/dev/null; cd /d && python3 render.py $*"
