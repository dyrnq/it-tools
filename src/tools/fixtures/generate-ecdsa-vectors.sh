#!/usr/bin/env bash
#
# 生成 ECDSA 的测试向量（ecdsa_signing_vectors.json）。
#
# **产物里只有公开材料**：公钥（SPKI PEM）、被签名的消息、OpenSSL 签出来的
# DER 签名。私钥一个都不留 —— 仓库是公开的，GitHub 对公开仓库默认开着
# push protection，一段货真价实的私钥文本就能把第一次推送整个拦下来。
# 而且这把钥匙本来就是这里现生成的一次性货色：互操作性的证据是
# 「OpenSSL 签的签名，我们验得过」加上对应的公钥，私钥并不在证据链上。
# 测试要私钥的地方一律现生成一把（见 src/tools/ecdsa_signing.rs 的单测）。
#
# **产物不是逐字节可复现的**：每次跑都现生成一把新钥匙，签名里的随机数也是新的，
# 所以公钥和签名每次都不一样。仓库里那一份只是一个快照 —— 用它跑测试没问题
# （公钥验得过签名就够了），但别指望重跑一次能得到同一个文件，也别把
# 「文件变了」当成出了故障。
#
# 用法：
#     bash src/tools/fixtures/generate-ecdsa-vectors.sh
#
# 产物写在**脚本自己所在的目录**，跟当前工作目录无关。
#
# 依赖：openssl（3.x）、python3（只用来拼 JSON）。

set -euo pipefail

# 产物写回**脚本自己所在的目录**。
# 下面那段 Python 是用 heredoc 喂进去的（stdin），`__file__` 在那儿根本没定义 ——
# `os.path.abspath(__file__)` 算出来是当前工作目录，脚本从哪儿跑就写到哪儿去：
# 从仓库根跑一次，仓库根就多出一个 ecdsa_signing_vectors.json。
# 所以这里把目录显式传进去。
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# 被签名的消息。带中文与换行 —— 签的是**字节**，UTF-8 多字节与末尾换行
# 都得原样进去，不能在中间被规范化掉。
MESSAGE='ECDSA 签名测试 — hello 世界
第二行
'
printf '%s' "$MESSAGE" > "$WORK/msg.txt"

for spec in "prime256v1 sha256 p256" "secp384r1 sha384 p384" "secp521r1 sha512 p521"; do
    # shellcheck disable=SC2086
    set -- $spec
    curve="$1" hash="$2" id="$3"

    # SEC1 私钥（`openssl ecparam -genkey` 的默认输出）→ PKCS#8 私钥。
    # 两个都要：工具的签名方向收 PKCS#8（也收 SEC1），向量里留的是公钥。
    openssl ecparam -name "$curve" -genkey -noout -out "$WORK/sec1-$id.pem" 2>/dev/null
    openssl pkcs8 -topk8 -nocrypt -in "$WORK/sec1-$id.pem" -out "$WORK/pkcs8-$id.pem"
    openssl ec -in "$WORK/sec1-$id.pem" -pubout -out "$WORK/pub-$id.pem" 2>/dev/null

    # 签名。`openssl dgst` 默认吐 DER 编码的 ECDSA 签名 —— 正是我们要的形态。
    openssl dgst "-$hash" -sign "$WORK/pkcs8-$id.pem" -out "$WORK/sig-$id.der" "$WORK/msg.txt"

    # 自检：OpenSSL 自己验得过。
    openssl dgst "-$hash" -verify "$WORK/pub-$id.pem" \
        -signature "$WORK/sig-$id.der" "$WORK/msg.txt" | grep -q 'Verified OK'
done

WORK="$WORK" HERE="$HERE" python3 - <<'PY'
import json
import os

work = os.environ["WORK"]
here = os.environ["HERE"]
message = open(os.path.join(work, "msg.txt"), "rb").read().decode("utf-8")

out = {
    "_comment": [
        "ECDSA 测试向量 —— 全部由 OpenSSL 3.5.7 生成（外部参照，不是本实现自己的输出）。",
        "生成方法见同目录的 generate-ecdsa-vectors.sh。",
        "产物里只有公开材料：公钥（SPKI）、被签名的消息、OpenSSL 签出来的 DER 签名。",
        "私钥不在这儿 —— 仓库是公开的，GitHub 对公开仓库默认开着 push protection。",
    ],
    "message": message,
    "vectors": {},
}

for cid, digest in (("p256", "sha256"), ("p384", "sha384"), ("p521", "sha512")):
    out["vectors"][cid] = {
        "curve": cid,
        "digest": digest,
        "publicKeyPem": open(os.path.join(work, f"pub-{cid}.pem")).read(),
        "signatureHex": open(os.path.join(work, f"sig-{cid}.der"), "rb").read().hex(),
    }

path = os.path.join(here, "ecdsa_signing_vectors.json")
with open(path, "w", encoding="utf-8") as f:
    json.dump(out, f, ensure_ascii=False, indent=2)
    f.write("\n")
print("wrote", path)
PY
