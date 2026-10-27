#!/usr/bin/env bash
# 下载 layui 到 static/lib/layui（供 rust-embed 打进二进制）
#
# 用法: scripts/bump-layui.sh [版本号]     默认 v2.11.2
#
# 优先取 GitHub Release 资产；取不到时回退 npm registry（网络环境常能通 npm）。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
CODE_BASE="$(dirname "$SCRIPT_DIR")"
ver="${1:-v2.11.2}"
ver_n="${ver#v}"

TARGET="${CODE_BASE}/static/lib/layui"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# ---- 1. 尝试 GitHub Release ----
if curl -fsSL --connect-timeout 10 --max-time 120 \
     "https://github.com/layui/layui/releases/download/${ver}/layui-${ver}.zip" \
     -o "$TMP/layui.zip" 2>/dev/null && unzip -tq "$TMP/layui.zip" >/dev/null 2>&1; then
  echo "来源: GitHub Release ${ver}"
  unzip -q -o "$TMP/layui.zip" -d "$TMP/x"
  SRC="$TMP/x/layui-${ver}/layui"
else
  # ---- 2. 回退 npm registry ----
  echo "GitHub Release 不可达，回退 npm registry ..."
  curl -fsSL --connect-timeout 10 --max-time 120 \
    "https://registry.npmjs.org/layui/-/layui-${ver_n}.tgz" -o "$TMP/layui.tgz"
  echo "来源: npm registry layui@${ver_n}"
  mkdir -p "$TMP/x"
  tar -xzf "$TMP/layui.tgz" -C "$TMP/x"
  SRC="$TMP/x/package/dist"
fi

[ -d "$SRC" ] || { echo "错误: 未找到 layui 发行目录"; exit 1; }

mkdir -p "$TARGET"
cp -f -R "$SRC/." "$TARGET/"

echo "layui ${ver} -> ${TARGET}"
echo "版本: $(grep -oE 'v?[0-9]+\.[0-9]+\.[0-9]+' "$TARGET/layui.js" 2>/dev/null | head -1 || echo 未知)"
du -sh "$TARGET"