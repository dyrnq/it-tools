#!/usr/bin/env bash
#
# 下载并安装 cross（Rust 的交叉编译工具，不是 C 的那个 cross）。
#
# 为什么不直接 `cargo install cross`：
#   现场编要好几分钟，而 CI 矩阵里有好几项要编它。而且装出来落在 ~/.cargo/bin ——
#   那目录要是进了 cargo 缓存，下一次的 `cargo install cross` 会因为「已安装」
#   直接报错（binary already exists）。下载发行版就没这回事：解开就是 cross +
#   cross-util 两个文件。现场编只留作最后的兜底。
#
# 为什么要写这么多层：
#   2026-11-09 的 CI 上，cross 的发行版资产下载返回了 **504**（GitHub 自己的边缘
#   节点回的，不是我们的网络）—— 同一个 run 里 x86_64 那个 job 下载成功，
#   aarch64 那个 job 失败，连带 Docker 那个 job 整个被跳过。
#   本机也复现过：同一个 URL 交替出现 504、连不上、以及「连上了但慢到 40 秒只
#   下了一半」。所以这里准备了三条路，按顺序试：
#     1) 官方 gnu 发行版资产（动态链接，装到 /usr/local/bin 就是常规做法）；
#     2) 官方 musl 发行版资产（静态链接，在 glibc 的机器上照样跑）；
#     3) `cargo install cross` 现场编（最慢，但只要 crates.io 通就有）。
#   每一步都带重试 —— 504 是瞬时错误，重试几次通常就过去了。
#
# 怎么算「下好了」：
#   不是看 curl 的退出码，也不是只跑个 gzip -t，更不是只 `tar t` 列一下成员 ——
#   而是**按实际用法校验**：解到临时目录里 → 确认 cross 与 cross-util 都在 →
#   真跑一次 `cross --version` → 才装。
#   2026-11-09 本机就撞到过一个「列得出成员、但 gzip 流被截断」的包：
#   `tar t` 只读文件头，不读文件内容，所以半截的包照样列得出 cross 和 cross-util；
#   真正解到一半才会报 "gzip: stdin: unexpected end of file"。
#   直接往 $DEST 解还有个更糟的后果：解一半失败，$DEST 里留下一个**半截的**
#   cross，后面谁再调它都得先把它删掉。
#
# 为什么不写成 `curl ... | tar xz`：
#   管道里 curl 的失败会被 tar 盖住，日志里看到的是「gzip: stdin: unexpected end
#   of file」这种看不懂的报错，真实原因其实是上游 504。改成：先落盘 → 校验 →
#   再解开。
#
# 用法：bash scripts/install-cross.sh [安装目录，默认 /usr/local/bin]
set -euo pipefail

DEST="${1:-/usr/local/bin}"
ATTEMPTS="${CROSS_DOWNLOAD_ATTEMPTS:-3}"

# 候选资产。gnu 排前面：它就是 cross 官方给 CI 的那个。
# musl 是静态链接的，退路用 —— 在 Ubuntu runner 上跑没有任何问题。
URLS=(
  "https://github.com/cross-rs/cross/releases/latest/download/cross-x86_64-unknown-linux-gnu.tar.gz"
  "https://github.com/cross-rs/cross/releases/latest/download/cross-x86_64-unknown-linux-musl.tar.gz"
)

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
TARBALL="$TMP/cross.tar.gz"
# 解包用的暂存目录。先解在这儿、验过了再装 —— 别往 $DEST 里解一半。
STAGE="$TMP/stage"

# 下载一个候选资产并校验。成功返回 0，失败返回非 0。
try_download() {
  local url="$1" attempt wait
  for attempt in $(seq 1 "$ATTEMPTS"); do
    echo "下载 $(basename "$url")（第 $attempt/$ATTEMPTS 次）……"
    # --retry 3：curl 自己会重试 5xx 这类瞬时错误（504 就在它的默认列表里，
    # 实测：服务端连续回 3 次 504、第 4 次正常，curl 照样拿到内容、退出码 0）。
    # 不用 --retry-all-errors：那会让 404（资产根本不存在）也重试，白等。
    # --retry-connrefused：连不上也重试。
    # --speed-limit/--speed-time：慢到 1 KB/s 以下并且持续 60 秒就当它死了 ——
    #   否则一个卡死的连接能一直挂着，直到整个 job 超时。
    # 上面这几层管不了的，由外层的循环兜底。
    if curl -fsSL \
        --connect-timeout 30 \
        --retry 3 --retry-connrefused --retry-delay 5 \
        --speed-limit 1024 --speed-time 60 \
        -o "$TARBALL" "$url"; then
      # 校验：解到临时目录（不是列成员 —— 列表只读文件头，半截的包也列得出），
      # 确认两个可执行文件都在，再真跑一次 --version。
      rm -rf "$STAGE"
      mkdir -p "$STAGE"
      if tar xzf "$TARBALL" -C "$STAGE" 2>/dev/null \
        && [ -f "$STAGE/cross" ] \
        && [ -f "$STAGE/cross-util" ]; then
        chmod +x "$STAGE/cross" "$STAGE/cross-util"
        # 半截的可执行文件 exec 会失败（"cannot execute binary file"）——
        # 跑一次就知道装上去以后能不能用。
        if "$STAGE/cross" --version >/dev/null 2>&1; then
          return 0
        fi
        echo "  解出来的 cross 跑不起来（包是半截的），不算数。" >&2
      else
        echo "  拿到的包不完整（$(stat -c %s "$TARBALL" 2>/dev/null || echo 0) 字节），不算数。" >&2
      fi
    fi
    [ "$attempt" -lt "$ATTEMPTS" ] || break
    wait=$((attempt * 10))
    echo "  ${wait} 秒后重试" >&2
    sleep "$wait"
  done
  return 1
}

# 把 cross 放到 PATH 上，并确认它真能跑。
install_tarball() {
  echo "安装到 $DEST ……"
  # CI 的 runner 上 /usr/local/bin 要 sudo；装到自己能写的目录时不用。
  mkdir -p "$DEST" 2>/dev/null || sudo mkdir -p "$DEST"
  if [ -w "$DEST" ]; then
    cp "$STAGE/cross" "$STAGE/cross-util" "$DEST/"
    chmod +x "$DEST/cross" "$DEST/cross-util"
  else
    sudo cp "$STAGE/cross" "$STAGE/cross-util" "$DEST/"
    sudo chmod +x "$DEST/cross" "$DEST/cross-util"
  fi
  # 用绝对路径调：装到别的目录时它不一定在 PATH 上。
  "$DEST/cross" --version
}

installed=0
for url in "${URLS[@]}"; do
  if try_download "$url" && install_tarball; then
    installed=1
    break
  fi
  echo "这个源没成，换下一个。" >&2
done

if [ "$installed" -eq 0 ]; then
  echo "发行版资产全都没下下来，最后退回现场编 cross（慢，要几分钟）……" >&2
  # --root 指到临时目录：~/.cargo/bin 要是进了 cargo 缓存，装出来的 cross
  # 会跟下一轮「已安装」冲突（binary already exists）。
  cargo install cross --locked --root "$TMP/cross-root"
  mkdir -p "$DEST" 2>/dev/null || sudo mkdir -p "$DEST"
  if [ -w "$DEST" ]; then
    cp "$TMP/cross-root/bin/cross" "$TMP/cross-root/bin/cross-util" "$DEST/"
    chmod +x "$DEST/cross" "$DEST/cross-util"
  else
    sudo cp "$TMP/cross-root/bin/cross" "$TMP/cross-root/bin/cross-util" "$DEST/"
    sudo chmod +x "$DEST/cross" "$DEST/cross-util"
  fi
  "$DEST/cross" --version
fi
