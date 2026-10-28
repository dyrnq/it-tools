#!/usr/bin/env bash
#
# 从固定的 commit 快照拉取 gitignore / gitattributes 模板，生成 static/data/*.json。
#
# 为什么必须钉 commit（别把 commit 改成"分支头"）：
#
#   模板是从 GitHub 上的仓库取的，仓库的分支头会往前走。今天界面上预览到的
#   Node.gitignore，和下周用户照着命令拉下来的 Node.gitignore，很可能已经不是
#   同一份了 —— 用户看到的内容跟他复制走的命令对不上，是这类工具最容易出的错。
#   所以这里把 commit 写死在脚本里，生成的 JSON 里也写同一个 commit，
#   工具界面上显示的下载链接同样指这个 commit：预览、命令、数据三者永远一致。
#
#   （fork it-tools2 的 scripts/update-git-templates.mjs 也是这么做的：
#   先用 API 把分支头解成 commit sha，再按那个 sha 抓内容。）
#
# 为什么不用 raw.githubusercontent 一个个抓：
#   几百个文件就是几百个请求，那边不稳、还会被限流。改成一次性拿仓库的 tarball
#   （codeload.github.com），解开后按目录结构挑文件 —— 一次请求、一次解压。
#
# 内容要按字节照抄，别"顺手规范化"：
#   界面上的预览和命令里那条 raw 链接必须给出同一份字节。raw.githubusercontent
#   吐的是 blob 的原样：Lasal.gitignore、Global/NotepadPP.gitignore 里是 CRLF，
#   Global/macOS.gitignore 里还有一个光秃秃的 CR。用 Python 的文本模式读会把
#   \r\n、\r 一律折成 \n，于是预览里看着一样、下载下来字节不一样。
#   所以下面一律按二进制读，再自己解 UTF-8。
#
# 符号链接为什么跳过：
#   上游有 Fortran.gitignore -> C++.gitignore 这样的别名。链接的 blob 里存的是
#   "目标路径"这几个字，raw.githubusercontent 原样吐出来（不是目标文件的内容）。
#   留着它，预览和命令下载就对不上；把内容换成目标文件的内容，链接又会指向
#   另一个路径 —— 链接名推不出该下载哪个 URL。所以别名直接不进数据集，
#   规则本身还在（选 C++ 就是同一份）。
#
# 拉不下来怎么办：
#   重试若干次；还不行就**停下来报错**，绝不交半份数据。
#   半份数据比没有数据更糟：用户会以为模板就这么多。
#
# 用法：
#   scripts/build-git-templates.sh
#
set -euo pipefail

# ---- 钉死的快照（改这里 = 换一版模板，界面上的 commit 也会跟着变） ----

GITIGNORE_REPO="github/gitignore"
GITIGNORE_COMMIT="0e5d690153ca3da8a4a1aef2d053406f408f531c"
GITIGNORE_EXT=".gitignore"

GITATTRIBUTES_REPO="alexkaratarakis/gitattributes"
GITATTRIBUTES_COMMIT="2c20a14833a5ab196c7fc3effcc72ef4e895f4d4"
GITATTRIBUTES_EXT=".gitattributes"

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="$ROOT/static/data"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

log() { printf '%s\n' "$*" >&2; }

# 拉一次 tarball，失败重试若干次。
fetch_tarball() {
  local repo="$1" commit="$2" dest="$3"
  local url="https://codeload.github.com/${repo}/tar.gz/${commit}"
  local attempt=1 max=5
  while [ "$attempt" -le "$max" ]; do
    if curl -fsSL --connect-timeout 20 --max-time 600 -o "$dest" "$url"; then
      return 0
    fi
    log "  下载失败（第 ${attempt}/${max} 次）：${url}"
    attempt=$((attempt + 1))
    sleep $((attempt * 3))
  done
  log "拉不下 ${url}：网络不通，或上游仓库/commit 已经不在了。"
  log "重试 ${max} 次仍失败 —— 先把网络或者 commit 弄对，不要交半份数据。"
  return 1
}

# 一个仓库 → 一份 JSON。
build_one() {
  local repo="$1" commit="$2" ext="$3" out="$4" prefix="$5"
  local tarball="$WORK/${prefix}.tar.gz"
  local unpack="$WORK/${prefix}"

  log "→ ${repo}@${commit}"

  fetch_tarball "$repo" "$commit" "$tarball"

  # tarball 的顶层目录名里带着 commit（形如 gitignore-<40 位 sha>）。
  # 拿它核对下载到的确实是钉住的那一版 —— 免得 URL 写错还浑然不觉。
  local tops expected actual
  tops="$(tar -tzf "$tarball" | cut -d/ -f1 | sort -u)"
  expected="${prefix}-${commit}"
  actual="$(printf '%s\n' "$tops" | head -1)"
  if [ "$actual" != "$expected" ]; then
    log "tarball 的顶层目录是 ${actual}，与预期的 ${expected} 对不上 —— 中间大概被缓存或代理改过。"
    return 1
  fi

  rm -rf "$unpack"
  mkdir -p "$unpack"
  tar -xzf "$tarball" -C "$unpack" --strip-components=1

  # 组 JSON。键是「相对仓库根的路径去掉后缀」：
  #   Node.gitignore                → "Node"
  #   community/JavaScript/Vue.gitignore → "community/JavaScript/Vue"
  # 不能只用文件名 —— 仓库里确实有重名（Racket.gitignore 与 community/Racket.gitignore、
  # community/BoxLang/ColdBox.gitignore 与 community/CFML/ColdBox.gitignore），
  # 只用文件名会丢模板。
  python3 - "$unpack" "$ext" "$out" "$commit" "$repo" "$ROOT" <<'PY'
import json
import os
import sys

unpack, ext, out, commit, repo, root = sys.argv[1:7]

names = []
links = []
for dirpath, _dirs, files in os.walk(unpack):
    for name in files:
        path = os.path.join(dirpath, name)
        if not name.endswith(ext):
            continue
        rel = os.path.relpath(path, unpack)
        key = rel[: -len(ext)]
        if not key:            # 仓库根上那个裸的 ".gitignore" 没有名字，跳过
            continue
        if os.path.islink(path):
            links.append((rel, os.readlink(path)))
            continue
        names.append(key)

if links:
    print(f"{repo}: 跳过 {len(links)} 个符号链接（上游的别名，raw 上取到的是目标路径而非内容）",
          file=sys.stderr)
    for rel, target in sorted(links):
        print(f"    {rel} -> {target}", file=sys.stderr)

if not names:
    sys.exit(f"{repo}: 一个 {ext} 都没找到 —— 快照结构跟预期不符")

templates = {}
for key in sorted(names):
    path = os.path.join(unpack, key + ext)
    with open(path, "rb") as fh:          # 二进制读：别让 Python 顺手把 \r\n 折成 \n
        raw = fh.read()
    try:
        templates[key] = raw.decode("utf-8")
    except UnicodeDecodeError as err:
        sys.exit(f"{repo}: {key}{ext} 不是合法的 UTF-8（{err}）—— 别猜它该是什么编码")

data = {
    "commit": commit,
    "source": f"https://github.com/{repo}",
    "templates": templates,
}

os.makedirs(os.path.dirname(out), exist_ok=True)
with open(out, "w", encoding="utf-8") as fh:
    json.dump(data, fh, ensure_ascii=False, indent=2, sort_keys=False)
    fh.write("\n")

print(f"{os.path.relpath(out, root)}: {len(templates)} 个模板，commit {commit}")
PY
}

build_one "$GITIGNORE_REPO" "$GITIGNORE_COMMIT" "$GITIGNORE_EXT" \
  "$OUT_DIR/gitignore-templates.json" "gitignore"

build_one "$GITATTRIBUTES_REPO" "$GITATTRIBUTES_COMMIT" "$GITATTRIBUTES_EXT" \
  "$OUT_DIR/gitattributes-templates.json" "gitattributes"

log "完成。"
