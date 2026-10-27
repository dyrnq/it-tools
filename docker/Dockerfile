# 镜像模板：buildx.sh 把 __BASE_IMAGE__ 换成真实的基础镜像，
# 生成 docker/Dockerfile.<base> 之后再 build。所以这个文件本身不用改，
# 换基础镜像只改 buildx.sh 的 --base 参数。
#
# 这个文件里**不能有 RUN**：
#   · 每一层 RUN 都要在目标架构的容器里执行，arm64 那一层就得靠 QEMU 模拟，
#     慢得离谱；
#   · 基础镜像里没有我们需要的工具，装东西的 RUN 等于给自己找麻烦。
# 所以可执行位用 COPY --chmod 给，而不是 RUN chmod。
FROM __BASE_IMAGE__

# TARGETARCH 由 buildkit 自动填（amd64 / arm64），跟 buildx --platform 一一对应。
# 布局是 dist/<arch>/it-tools —— 一个上下文里放两个架构的二进制，
# buildkit 自己挑对应架构的那一份。
ARG TARGETARCH

# 二进制是外面编好的（release 流水线里 cross 交叉编译的静态 musl 版本），
# 不是在镜像里编的：那个二进制没有运行期文件依赖（静态资源全在 rust-embed 里，
# 时区库编进了 chrono-tz），静态 musl 在 alpine 上直接能跑。
#
# --chmod 不能省：actions/upload-artifact 不保留可执行位，下载下来是 644。
COPY --chmod=0755 dist/${TARGETARCH}/it-tools /usr/local/bin/it-tools

# 二进制自己的默认是 127.0.0.1 —— 容器里那样绑，端口从外面够不着。
# 用环境变量而不是 CMD：`docker run 镜像 --port 9000` 这种追加参数的做法，
# 在 CMD 方案下会把 --host 一起顶掉，clap 拿到默认值，端口就废了。
# 命令行 > 环境变量 > 默认值，这套优先级本来就是 src/settings.rs 里写好的。
ENV IT_TOOLS_HOST=0.0.0.0 \
    IT_TOOLS_PORT=8080

EXPOSE 8080

# actix 收到 SIGTERM 会干净收摊（scripts/test/integration-test.sh 里有这一条）。
STOPSIGNAL SIGTERM

# 只提供 HTTP，不写盘 —— nobody 就够（alpine 里是 uid 65534）。
USER nobody

ENTRYPOINT ["/usr/local/bin/it-tools"]
