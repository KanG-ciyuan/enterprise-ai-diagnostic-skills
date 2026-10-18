#!/usr/bin/env bash
#
# 组装可公开发布的静态资源目录。
#
# 为什么需要这个脚本
# ------------------
# Cloudflare Pages 项目 enterprise-ai-diagnostic 是「直接上传」部署
# （Git Provider: No），wrangler pages deploy <dir> 会上传你给它的整个目录。
# 在此之前 pages_build_output_dir = "."，于是部署根目录里的所有东西
# 都成了公开静态资源 —— 包括 wrangler.toml（含 D1 database_id 与鉴权模式）、
# schema.sql、seed.sql、测试脚本和内部文档。
#
# 这里改用「白名单」而不是黑名单：只有下面 ASSETS 里列出的文件会进入
# dist/。新增静态资源必须显式登记，漏登记的表现是资源 404（容易发现），
# 而不是敏感文件泄露（难以发现）。
#
# 注意：functions/ 不在这里处理。Cloudflare Pages 由 wrangler 从**运行目录**
# 查找 functions/，与上传的静态目录无关。已实测确认。
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$ROOT/dist"

# ── 发布清单 ────────────────────────────────────────────────────────
# 只有列在这里的文件会被发布。顺序无关，但请按用途分组便于审阅。
ASSETS=(
  # 页面
  "index.html"
  "authorization-confirmation.html"

  # 前端脚本
  "app.js"
  "api-client.js"
  "formal-ui-contract.js"
  "agent-adapter.js"
  "authorization-confirmation.js"

  # 样式
  "styles.css"

  # 演示用静态数据（客户端 mock，不含真实企业数据）
  "mock-data.js"

  # Pages 响应头配置，必须随静态目录一起发布才生效
  "_headers"

  # 阻断旧构建遗留的内部路径。旧部署曾把这些文件作为静态资源返回并带
  # 7 天缓存头（实测 cf-cache-status: HIT, age 14798s），白名单构建不再
  # 提供它们，但需要这个文件覆盖边缘缓存。
  "_redirects"
)

# ── 明确禁止进入 dist/ 的内容 ──────────────────────────────────────
# 这不是主要的防护手段（主要手段是上面的白名单），而是防止后来者
# 误把敏感文件加进 ASSETS。构建时若在输出目录里发现这些名字，直接失败。
FORBIDDEN_PATTERNS=(
  "wrangler*.toml"
  "*.sql"
  "*.md"
  "schema*"
  "seed*"
  ".env*"
  "*secret*"
  "*credential*"
)

echo "→ 组装静态资源到 dist/"

if [ ! -d "$ROOT" ]; then
  echo "✗ 找不到项目根目录: $ROOT" >&2
  exit 1
fi

rm -rf "$OUT"
mkdir -p "$OUT"

missing=0
for f in "${ASSETS[@]}"; do
  if [ ! -f "$ROOT/$f" ]; then
    echo "  ✗ 清单里的文件不存在: $f" >&2
    missing=1
    continue
  fi
  cp "$ROOT/$f" "$OUT/$f"
  printf "  ✓ %-40s %8sB\n" "$f" "$(wc -c < "$ROOT/$f" | tr -d ' ')"
done

if [ "$missing" -ne 0 ]; then
  echo "✗ 有清单文件缺失，构建中止" >&2
  exit 1
fi

# ── 发布前自检：输出目录里不得出现被禁模式 ─────────────────────────
violations=0
for pattern in "${FORBIDDEN_PATTERNS[@]}"; do
  while IFS= read -r -d '' hit; do
    echo "  🔴 dist/ 里出现被禁文件: $(basename "$hit")" >&2
    violations=$((violations + 1))
  done < <(find "$OUT" -maxdepth 1 -name "$pattern" -print0 2>/dev/null)
done

if [ "$violations" -ne 0 ]; then
  echo "✗ 自检未通过：dist/ 含 $violations 个不应发布的文件，构建中止" >&2
  rm -rf "$OUT"
  exit 1
fi

count=$(find "$OUT" -maxdepth 1 -type f | wc -l | tr -d ' ')
echo "→ 完成：dist/ 共 $count 个文件"
echo "  下一步：wrangler pages dev dist        （本地预览）"
echo "          wrangler pages deploy dist     （发布，需人工确认）"
