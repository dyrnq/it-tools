#!/usr/bin/env bash
# 开发用启动脚本：debug 构建 + 静态资源从磁盘读，改完刷新即可见。
#
#   ./run.sh                  # 监听 127.0.0.1:8080
#   ./run.sh --port 9000      # 其余参数原样透传给二进制
#
# 发行部署请用 `cargo build --release`，那时静态资源会打进二进制，
# 单文件即可运行，不需要本目录下的任何资源。
set -euo pipefail

CODE_BASE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
cd "$CODE_BASE"

if ! command -v cargo >/dev/null 2>&1; then
  echo "错误: 找不到 cargo，请先安装 Rust 工具链" >&2
  exit 1
fi

# layui 是 rust-embed 的一部分，缺了会编译成空目录
if [ ! -f static/lib/layui/layui.js ]; then
  echo "提示: 未找到 static/lib/layui，正在下载 ..." >&2
  scripts/bump-layui.sh
fi

# 注意【不要】加 --features debug-embed：那个 feature 的语义是反的，见 src/embed.rs。
# 普通 cargo run（debug profile）本来就是每次请求现读磁盘，改完刷新即可见。
exec cargo run -- "$@"