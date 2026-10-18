#!/usr/bin/env bash
#
# 本地演示模式启动脚本
#
# 为什么用 `wrangler pages dev` 而不是 Python 后端：
#
#   演示入口的前端 (`api-client.js`) 用 `formalBaseUrl = ""`（同源）调用正式接口。
#   只有 `wrangler pages dev` 会同时提供静态前端和 Pages Functions，因此同源成立、
#   cookie 会话成立、全部接口都在。
#
#   Python 参考后端 (`backend/`) 是另一套实现：它只认 `Authorization: Bearer`，
#   缺少 11 个前端在调的端点，且跑在不同端口上，所以前端够不到它。
#   它保留作为历史参考，但**不是**演示路径。
#
# 本地地址均为 127.0.0.1（回环），不含任何账号、域名或密钥，也不访问线上资源。
#
# 静态资源走白名单构建
# --------------------
# 不再把整个项目目录当作静态资源（那会把 wrangler.toml、schema.sql、
# 测试脚本一并公开）。先由 scripts/build-static.sh 按清单组装 dist/，
# 再让 Pages 只提供 dist/。functions/ 由 wrangler 从当前目录查找，
# 不受影响 —— 这一点已实测确认。
#
set -euo pipefail

PORT="${PORT:-8788}"
HOST="${HOST:-127.0.0.1}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if ! command -v wrangler >/dev/null 2>&1; then
  echo "✘ 找不到 wrangler。安装：npm i -g wrangler" >&2
  exit 1
fi

# 每次启动都重新组装，避免 dist/ 落后于源文件
"$ROOT/scripts/build-static.sh"

echo "────────────────────────────────────────────────────────────"
echo " 企业 AI 流程诊断 · 本地演示模式"
echo "────────────────────────────────────────────────────────────"
echo " 前端 + 后端 + 本地 D1 由同一条命令启动，与线上同一份代码。"
echo
echo " 打开：   http://${HOST}:${PORT}/"
echo " 健康：   http://${HOST}:${PORT}/api/health"
echo " 静态资源： dist/（白名单构建，见 scripts/build-static.sh）"
echo
echo " 本地状态：${ROOT}/.wrangler/state（已 gitignore，仅本机）"
echo " 首次运行会建表；所有数据只写入本地，不触碰线上。"
echo "────────────────────────────────────────────────────────────"
echo

cd "$ROOT"
exec wrangler pages dev dist --port "$PORT" --ip "$HOST"
