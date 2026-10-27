#!/usr/bin/env bash
# 打 Docker 镜像。
#
#   ./buildx.sh --push false                    # 只编，不推
#   ./buildx.sh --push true --version v0.1.0    # 编完推到 Docker Hub
#
# 镜像里装的是**外面编好的二进制**，不是在镜像里编的：
# release 流水线里 `cross` 已经交叉编译好了静态 musl 版本，
# 放到 dist/<arch>/it-tools 就行 —— 不然 arm64 那一层要在 QEMU 里模拟编译，
# 慢到没法看。
#
# 所以这个脚本的前置条件是 dist/ 里已经摆好了对应架构的二进制：
#
#   mkdir -p dist/amd64 dist/arm64
#   cp target/x86_64-unknown-linux-musl/release/it-tools dist/amd64/it-tools
#   cp target/aarch64-unknown-linux-musl/release/it-tools dist/arm64/it-tools
#
# docker/Dockerfile 是个模板，脚本把 __BASE_IMAGE__ 换成真实的基础镜像，
# 生成 docker/Dockerfile.<base> 之后再 build —— 用完就删。
set -Eeuo pipefail

CODE_BASE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
cd "$CODE_BASE"

base_image="alpine:3.22"
version=""
push="false"
load="false"
latest="true"
repo="dyrnq"
image_name="it-tools"
platforms="linux/amd64,linux/arm64"

usage() {
    cat <<'EOF'
用法: buildx.sh [选项]

  --base, --base-image <image>   基础镜像（默认 alpine:3.22）
  --version, --ver <tag>         版本号 tag（默认：CI 里取 git tag，
                                 本地取 sha-<短 commit>）
  --push <true|false>            true = 推到 Docker Hub（默认 false）
  --load <true|false>            true = 装进本机 docker（默认 false），
                                 只能配单个架构
  --no-latest                    不额外打 :latest 这个 tag（默认会打）。
                                 CI 里的 main 镜像用这个 —— latest 归发版
                                 流水线，一直指向最后一个正式版本。
  --platforms <list>             目标架构，逗号分隔
                                 （默认 linux/amd64,linux/arm64）
  --repo <namespace>             Docker Hub 命名空间（默认 dyrnq）
  --image-name, --image <name>   镜像名（默认 it-tools）
  -h, --help                     这段话
EOF
}

while [ $# -gt 0 ]; do
    case "$1" in
        --base-image | --base)
            base_image="$2"
            shift 2
            ;;
        --version | --ver)
            version="$2"
            shift 2
            ;;
        --push)
            push="$2"
            shift 2
            ;;
        --load)
            load="$2"
            shift 2
            ;;
        --no-latest)
            latest="false"
            shift
            ;;
        --platforms)
            platforms="$2"
            shift 2
            ;;
        --repo)
            repo="$2"
            shift 2
            ;;
        --image-name | --image)
            image_name="$2"
            shift 2
            ;;
        -h | --help)
            usage
            exit 0
            ;;
        *)
            echo "错误: 不认识的参数 $1" >&2
            usage >&2
            exit 1
            ;;
    esac
done

case "${push}" in
    true | false) ;;
    *)
        echo "错误: --push 只能是 true 或 false" >&2
        exit 1
        ;;
esac
case "${load}" in
    true | false) ;;
    *)
        echo "错误: --load 只能是 true 或 false" >&2
        exit 1
        ;;
esac
# 版本号：CI 里推 tag 就用 tag 名（v0.1.0），其它情况用短 commit。
# 本地这个仓库可能一个 commit 都还没有，git rev-parse 会失败 —— 兜住。
short_sha="$(git rev-parse --short=7 HEAD 2>/dev/null || echo unknown)"
if [ -z "${version}" ]; then
    if [ "${GITHUB_REF_TYPE:-}" = "tag" ] && [ -n "${GITHUB_REF_NAME:-}" ]; then
        version="${GITHUB_REF_NAME}"
    elif [ "${short_sha}" != "unknown" ]; then
        version="sha-${short_sha}"
    else
        version="latest"
    fi
fi

# 每个架构的二进制都得在 —— 这是这个脚本最常见的翻车点。
for platform in ${platforms//,/ }; do
    arch="${platform#linux/}"
    arch="${arch%%/*}" # 去掉 /v8 这种后缀
    if [ ! -f "dist/${arch}/it-tools" ]; then
        echo "错误: dist/${arch}/it-tools 不存在" >&2
        echo "  镜像里放的是外面编好的二进制，Dockerfile 按 TARGETARCH 去 dist/<arch>/ 找。" >&2
        echo "  参见 README 的 Docker 一节。" >&2
        exit 1
    fi
done

tag_names=("${repo}/${image_name}:${version}")
if [ "${latest}" = "true" ] && [ "${version}" != "latest" ]; then
    tag_names+=("${repo}/${image_name}:latest")
fi
tags=()
for name in "${tag_names[@]}"; do
    tags+=(--tag "${name}")
done

# docker/Dockerfile 是模板，基础镜像换掉就行。
base_tag="$(awk -F: '{print $NF}' <<<"${base_image}")"
dockerfile="Dockerfile.$(echo "${base_tag}" | tr -c 'A-Za-z0-9._-' '-')"
sed -e "s@__BASE_IMAGE__@${base_image}@g" ./docker/Dockerfile >"./docker/${dockerfile}"
trap 'rm -f "./docker/${dockerfile}"' EXIT

echo "基础镜像: ${base_image}"
echo "架构:     ${platforms}"
echo "tag:      ${tag_names[*]}"

# --load 是给本机试跑用的（冒烟测试那一步）：docker 的本地镜像仓库装不下
# 多架构的镜像，所以只能配一个架构。
if [ "${load}" = "true" ]; then
    if [[ "${platforms}" == *,* ]]; then
        echo "错误: --load 只能配单个架构" >&2
        exit 1
    fi
    if [ "${push}" = "true" ]; then
        echo "错误: --load 和 --push 不能一起用" >&2
        exit 1
    fi
    output="type=docker"
else
    output="type=image,push=${push}"
fi

docker buildx build \
    --platform "${platforms}" \
    --output "${output}" \
    --file "./docker/${dockerfile}" \
    "${tags[@]}" \
    .
