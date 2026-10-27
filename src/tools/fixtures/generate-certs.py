#!/usr/bin/env python3
"""Generate deterministic X.509 test fixtures for src/tools/ssl_certificate_decoder.rs.

Run:  python3 src/tools/fixtures/generate-certs.py

产出的证书随仓库提交（几 KB），所以测试里断言的是「结构」而不是具体指纹 ——
重新跑一次会换掉密钥，断言里的哈希值就全失效了。

覆盖三种证书形态：链上的叶子（多 SAN）、中间 CA、已过期的、自签的。
"""
import os
import subprocess
import sys
import tempfile

OUT = os.path.dirname(os.path.abspath(__file__))
WORK = tempfile.mkdtemp(prefix="certs")


def run(*args, **kw):
    """openssl 失败时把 stderr 打出来 —— 它自己会带一行 `unable to load certificate`，
    不打出来的话看到的只是一个 exit status 1，排查起来要重跑一遍猜。"""
    p = subprocess.run(args, capture_output=True, text=True, **kw)
    if p.returncode != 0:
        sys.stderr.write(" ".join(args) + "\n" + p.stderr)
        raise SystemExit(1)
    return p


def key_and_csr(name, cn):
    """一把密钥 + 一个 CSR。密钥不留在仓库里，只有证书要。"""
    key = os.path.join(WORK, name + ".key")
    csr = os.path.join(WORK, name + ".csr")
    run("openssl", "req", "-new", "-newkey", "rsa:2048", "-nodes",
        "-keyout", key, "-out", csr, "-subj", f"/C=CN/O=IT Tools Fixture/CN={cn}")
    return key, csr


def self_signed(name, cn, days=None, not_before=None, not_after=None, serial="4242"):
    key, csr = key_and_csr(name, cn)
    crt = os.path.join(WORK, name + ".crt")
    cmd = ["openssl", "x509", "-req", "-in", csr, "-signkey", key,
           "-out", crt, "-set_serial", serial]
    cmd += ["-days", str(days)] if days else ["-not_before", not_before, "-not_after", not_after]
    run(*cmd)
    return crt, key


def ca_signed(name, cn, issuer_crt, issuer_key, days=None, not_before=None,
              not_after=None, serial="4243", san=None):
    key, csr = key_and_csr(name, cn)
    crt = os.path.join(WORK, name + ".crt")
    cmd = ["openssl", "x509", "-req", "-in", csr, "-out", crt,
           "-CA", issuer_crt, "-CAkey", issuer_key, "-set_serial", serial]
    cmd += ["-days", str(days)] if days else ["-not_before", not_before, "-not_after", not_after]
    if san:
        ext = os.path.join(WORK, name + ".ext")
        with open(ext, "w") as fh:
            fh.write(san)
        cmd += ["-extfile", ext]
    run(*cmd)
    return crt, key


def publish(src, name):
    """把 openssl 的输出重排成 64 列、结尾一个换行，diff 起来不晃眼。"""
    text = subprocess.run(["openssl", "x509", "-in", src, "-outform", "PEM"],
                          check=True, capture_output=True, text=True).stdout
    body = "".join(text.splitlines()[1:-1])
    lines = [body[i:i + 64] for i in range(0, len(body), 64)]
    with open(os.path.join(OUT, name), "w") as fh:
        fh.write("-----BEGIN CERTIFICATE-----\n")
        fh.write("\n".join(lines) + "\n")
        fh.write("-----END CERTIFICATE-----\n")
    print(f"  {name}  {os.path.getsize(os.path.join(OUT, name))} B")


print("生成证书夹具…")

# 根 CA：只用来签中间 CA，本身不作为夹具（工具的测试不需要一条三层的链）
root_crt, root_key = self_signed("root", "IT Tools Test Root CA", days=7300, serial="1000")

# 中间 CA —— 链测试里的第二张
inter_crt, inter_key = ca_signed("intermediate", "IT Tools Test Intermediate CA",
                                  root_crt, root_key, days=3650, serial="1001")

# 叶子：3 条 SAN（DNS + DNS + IP），用来钉住 SAN 解析那一支
leaf_crt, _ = ca_signed(
    "leaf", "leaf.it-tools.example", inter_crt, inter_key, days=3650, serial="1002",
    san="subjectAltName=DNS:leaf.it-tools.example,DNS:www.leaf.it-tools.example,IP:192.0.2.10\n")

# 已过期：not_after 落在两年前，钉住「过期是正常结论、不是错误」那一支
exp_crt, _ = self_signed("expired", "expired.it-tools.example",
                         not_before="20240101000000Z", not_after="20250101000000Z",
                         serial="1003")

# 自签：主题与签发者相同
self_crt, _ = self_signed("self-signed", "Self-signed.it-tools.example", days=3650, serial="1004")

publish(leaf_crt, "leaf.pem")
publish(inter_crt, "intermediate.pem")
publish(exp_crt, "expired.pem")
publish(self_crt, "self-signed.pem")
print(f"夹具在 {OUT}")