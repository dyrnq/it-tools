#!/usr/bin/env python3
"""Generate deterministic signed-PDF test fixtures for src/tools/pdf_signature_checker.rs.

Run:  python3 src/tools/fixtures/generate.py [输出目录]

输出目录默认就是本文件所在的目录（夹具随仓库提交，测试按文件名读它们）。
"""
import os
import subprocess
import sys
import tempfile

OUT = sys.argv[1] if len(sys.argv) > 1 else os.path.dirname(os.path.abspath(__file__))
os.makedirs(OUT, exist_ok=True)
WORK = tempfile.mkdtemp(prefix="pdfsig")


def run(*args, **kw):
    return subprocess.run(args, check=True, capture_output=True, **kw)


def make_cert(name, cn, not_before=None, not_after=None):
    """Self-signed RSA-2048 cert with an optional fixed validity window."""
    key = os.path.join(WORK, name + ".key")
    csr = os.path.join(WORK, name + ".csr")
    crt = os.path.join(WORK, name + ".crt")
    run("openssl", "req", "-new", "-newkey", "rsa:2048", "-nodes",
        "-keyout", key, "-out", csr, "-subj", f"/C=CN/O=IT Tools Fixture/CN={cn}")
    cmd = ["openssl", "x509", "-req", "-in", csr, "-signkey", key,
           "-out", crt, "-set_serial", "4242"]
    if not_after:
        cmd += ["-not_before", not_before, "-not_after", not_after]
    else:
        cmd += ["-days", "3650"]
    run(*cmd)
    return crt, key


BODY_TEXT = b"SIGNED PAYLOAD TEXT"
CONTENT = b"BT /F1 12 Tf 10 50 Td (" + BODY_TEXT + b") Tj ET"


def build_pdf(sig_len: int | None) -> bytes:
    """Assemble the PDF. sig_len=None -> unsigned document."""
    objs = {}
    objs[1] = b"<< /Type /Catalog /Pages 2 0 R"
    if sig_len is not None:
        # AcroForm is required for a signature to be discoverable by spec.
        objs[1] += b" /AcroForm << /Fields [4 0 R] /SigFlags 3 >>"
    objs[1] += b" >>"
    objs[2] = b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>"
    objs[3] = (b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 120] "
               b"/Contents 6 0 R /Resources << /Font << /F1 5 0 R >> >> >>")
    if sig_len is not None:
        objs[4] = b"<< /FT /Sig /T (Signature1) /Ff 0 /Rect [0 0 0 0] /V 7 0 R >>"
    objs[5] = b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"
    objs[6] = b"<< /Length " + str(len(CONTENT)).encode() + b" >>\nstream\n" + CONTENT + b"\nendstream"

    last = 6 if sig_len is None else 7
    if sig_len is not None:
        # Fixed-width placeholder: 10-digit zero-padded ByteRange keeps every
        # byte offset stable regardless of the final signature length.
        objs[7] = (b"<< /Type /Sig /Filter /Adobe.PPKLite /SubFilter /adbe.pkcs7.detached "
                   b"/Name (Test Signer) /M (D:20260101000000Z) "
                   b"/ByteRange [0000000000 0000000000 0000000000 0000000000] "
                   b"/Contents <" + b"0" * (2 * sig_len) + b"> >>")

    out = bytearray(b"%PDF-1.7\n%\xe2\xe3\xcf\xd3\n")
    offsets = {}
    for n in sorted(objs):
        offsets[n] = len(out)
        out += str(n).encode() + b" 0 obj\n" + objs[n] + b"\nendobj\n"

    xref_at = len(out)
    out += b"xref\n0 " + str(last + 1).encode() + b"\n"
    out += b"0000000000 65535 f \n"
    for n in range(1, last + 1):
        out += ("%010d 00000 n \n" % offsets[n]).encode() if n in offsets else b"0000000000 00000 f \n"
    out += b"trailer\n<< /Size " + str(last + 1).encode() + b" /Root 1 0 R >>\n"
    out += b"startxref\n" + str(xref_at).encode() + b"\n%%EOF\n"
    return bytes(out)


def byte_range(pdf: bytes, sig_len: int):
    """Locate the /Contents placeholder and derive the ByteRange tuple."""
    marker = b"/Contents <" + b"0" * (2 * sig_len) + b">"
    i = pdf.index(marker)
    start = i + len(b"/Contents ")          # points at '<'
    end = start + 1 + 2 * sig_len + 1       # one past '>'
    return [0, start, end, len(pdf) - end], start, end


def sign(pdf: bytes, sig_len: int, crt: str, key: str) -> bytes:
    br, start, end = byte_range(pdf, sig_len)

    # 同宽替换：占位符与实值的字节长度必须完全一致，否则所有偏移量都会平移。
    placeholder = b"/ByteRange [" + b" ".join(b"0000000000" for _ in range(4)) + b"]"
    filled = b"/ByteRange [" + b" ".join(("%010d" % v).encode() for v in br) + b"]"
    assert len(placeholder) == len(filled), (len(placeholder), len(filled))

    # 先把 ByteRange 落进文件再算摘要：/ByteRange 自己就在被签名的字节范围内，
    # 用占位符去签会得到一个「看起来正常但永远验不过」的签名。
    out = bytearray(pdf)
    i = out.index(placeholder)
    out[i:i + len(placeholder)] = filled

    covered = bytes(out[:start]) + bytes(out[end:])
    plain = os.path.join(WORK, "covered.bin")
    with open(plain, "wb") as f:
        f.write(covered)
    der_path = os.path.join(WORK, "sig.der")
    run("openssl", "cms", "-sign", "-binary", "-in", plain,
        "-signer", crt, "-inkey", key, "-outform", "DER",
        "-md", "sha256", "-nosmimecap", "-out", der_path)
    der = open(der_path, "rb").read()
    if len(der) > sig_len:
        raise RuntimeError(f"signature {len(der)} exceeds placeholder {sig_len}")

    marker = b"/Contents <" + b"0" * (2 * sig_len) + b">"
    i = out.index(marker)
    hexed = der.hex().encode()
    out[i + len(b"/Contents <"): i + len(b"/Contents <") + len(hexed)] = hexed
    return bytes(out)


def emit(name: str, data: bytes):
    path = os.path.join(OUT, name)
    with open(path, "wb") as f:
        f.write(data)
    print(f"{name}: {len(data)} bytes")


good_crt, good_key = make_cert("good", "IT Tools Fixture Signer")

# --- valid signed PDF: grow the placeholder until the DER fits ---
size = 1024
for _ in range(6):
    pdf = build_pdf(size)
    try:
        signed = sign(pdf, size, good_crt, good_key)
        break
    except RuntimeError:
        size *= 2
else:
    raise SystemExit("could not size placeholder")
emit("signed_valid.pdf", signed)

# --- unsigned, well-formed PDF (no AcroForm, no signature object) ---
emit("unsigned.pdf", build_pdf(None))

# --- expired certificate: same pipeline, cert whose notAfter is in the past ---
exp_crt, exp_key = make_cert("expired", "IT Tools Expired Signer",
                             not_before="20200101000000Z", not_after="20210101000000Z")
exp_pdf = build_pdf(size)
emit("signed_expired.pdf", sign(exp_pdf, size, exp_crt, exp_key))

# --- corrupted signature dictionary: ByteRange points past EOF ---
# [a1 l1 a2 l2] 是两段区间的起点+长度，所以要写成两段都在文件外，
# 但仍然不重叠（a1+l1 <= a2），这样工具报的才是「越界」而不是「重叠」。
corrupt = bytearray(signed)
i = corrupt.index(b"/ByteRange [")
j = corrupt.index(b"]", i) + 1
corrupt[i:j] = b"/ByteRange [0000000000 9999999999 9999999999 9999999999]"
emit("signed_bad_byterange.pdf", bytes(corrupt))

# --- truncated /Contents: half the hex, then no closing '>' ---
trunc = bytearray(signed)
i = trunc.index(b"/Contents <") + len(b"/Contents <")
half = (len(signed) - i - 200) // 2
del trunc[i:i + 2 * half]
emit("signed_truncated_contents.pdf", bytes(trunc))

print("work dir:", WORK)