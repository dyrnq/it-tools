#!/usr/bin/env bash
# 从 nmap 的 OUI 库生成 data/oui.txt（供 rust-embed 打进二进制）
#
# 用法: scripts/build-oui.sh [源文件]   默认 /usr/share/nmap/nmap-mac-prefixes
#
# 源文件是 nmap 自带的 make-mac-prefixes 产物，其数据来自 IEEE 的注册机构
# （https://regauth.standards.ieee.org/）。nmap 另外自己补了 5 个 OUI，保留即可。
#
# 源格式是「HEX 前缀 + 单个空格 + 厂商名」，注释行以 `#` 开头；本脚本把它规范成
# 「HEX 前缀 + TAB + 厂商名」并按前缀升序排序 —— 排序是为了让脚本幂等、
# 让数据刷新时的 diff 只显示真正变化的行（解析器用 HashMap，不依赖顺序）。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
CODE_BASE="$(dirname "$SCRIPT_DIR")"
SRC="${1:-/usr/share/nmap/nmap-mac-prefixes}"
OUT="${CODE_BASE}/data/oui.txt"

[ -r "$SRC" ] || { echo "错误: 读不到 OUI 源文件 $SRC"; exit 1; }
mkdir -p "$(dirname "$OUT")"

TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT

# awk 而不是 cut/sed：厂商名本身可能含空格甚至连续空格（如 "Coach Master International  d.b.a."），
# 按「第一个空格」切才能原样保留，而不是把字段之间的空白压掉。
# 只保留 6 位前缀：OUI 的定义就是 24 bit，参考实现也是取前 6 位；
# 源文件里还有 5199 条 7 位（MA-M）和 5882 条 9 位（MA-S）前缀，是 IEEE 更细粒度的分配，
# 它们的前 6 位在同文件里都有条目，保留下来只是让二进白白多长 0.4 MiB。
LC_ALL=C awk '
    /^#/            { next }
    index($0, " ") == 0 { next }
    {
        pos = index($0, " ")
        prefix = substr($0, 1, pos - 1)
        vendor  = substr($0, pos + 1)
        if (length(prefix) != 6) next
        if (prefix !~ /^[0-9A-Fa-f]{6}$/) next
        # 厂商名可能是全角括号这类非 ASCII 字符，awk 按字节处理也没问题，
        # 因为切的是空格（单字节）而不是按字段
        gsub(/^[ \t]+|[ \t]+$/, "", vendor)
        if (length(vendor) == 0) next
        printf "%s\t%s\n", toupper(prefix), vendor
    }
' "$SRC" | LC_ALL=C sort -u > "$TMP"

{
    echo "# 本文件由 scripts/build-oui.sh 生成，请勿手改"
    echo "# 数据来源: IEEE 注册机构（https://regauth.standards.ieee.org/），经 nmap 的 nmap-mac-prefixes 转出"
    echo "# 格式: <6 位 OUI><TAB><厂商名>，按 OUI 升序"
    cat "$TMP"
} > "$OUT"

echo "OUI 表 -> ${OUT}"
echo "条目数: $(( $(wc -l < "$OUT") - 3 ))"
du -h "$OUT"