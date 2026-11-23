#!/usr/bin/env bash
# 考公脑库 · 在线学习系统 — Linux / macOS 启动脚本
# 用法:  bash start.sh   (可选环境变量 KAOGONG_PORT 指定端口，默认 8300)
set -e
cd "$(dirname "$0")"
export KAOGONG_PORT="${KAOGONG_PORT:-8300}"
# 本地开发数据放在 dev-data/（与线上 data/ 隔离，发布时不会被上传覆盖）
export KAOGONG_USER_DB="${KAOGONG_USER_DB:-$(dirname "$0")/dev-data/users.db}"
echo "[INFO] 启动考公脑库 → http://127.0.0.1:${KAOGONG_PORT}  (0.0.0.0:${KAOGONG_PORT})"
exec python3 server.py
