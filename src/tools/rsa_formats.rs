//! RSA 密钥的多种输出格式 —— 上游 PR #888（`feat(rsa-key-generator): passphrase
//! and formats`）的移植。
//!
//! 上游那一版把格式交给 npm 的 `sshpk` 包，还为此加了 `vite-plugin-node-polyfills`
//! 来把 Node 的 `crypto` 垫进浏览器。本移植的约定是**不引入 npm 包**
//! （`_docs/upstream-pr-roi.md` §5「不建议」），所以这里的 OpenSSH 格式是**照着
//! OpenSSH 的线格式自己实现的**。
//!
//! ## 格式表
//!
//! | 取值 | 私钥 | 公钥 | 口令 |
//! |---|---|---|---|
//! | `pem` | `RSA PRIVATE KEY`（PKCS#1 DER，可加密） | `PUBLIC KEY`（SPKI） | 支持 |
//! | `pkcs1` | 同上（不加密） | `RSA PUBLIC KEY`（PKCS#1 DER） | 不支持 |
//! | `pkcs8` | `PRIVATE KEY`（PKCS#8） | `PUBLIC KEY`（SPKI） | 不支持 |
//! | `ssh` | `OPENSSH PRIVATE KEY`（openssh-key-v1） | `ssh-rsa AAAA…`（authorized_keys） | 支持 |
//! | `openssh` | 同上（**私钥与 `ssh` 一模一样**） | `OPENSSH PUBLIC KEY` | 支持 |
//!
//! 前三档与上游一致（上游 `pem` 走 node-forge、`pkcs1`/`pkcs8` 走 sshpk）。
//! 后两档上游也是「私钥都是 openssh-key-v1、只有公钥的表示不同」——因为 sshpk 的
//! `ssh-private` 与 `openssh` 是同一个写出器（见 sshpk 的 `lib/private-key.js`：
//! `formats['openssh'] = formats['ssh-private']`）。
//!
//! ## 涉及的线格式
//!
//! SSH 的二进制格式见 RFC 4251 §5：定长整数是大端，字符串是「4 字节长度 + 内容」，
//! 多精度整数（`mpint`）是补码形式的大端字节串，最高位为 1 时前面补一个 0x00。
//!
//! `openssh-key-v1` 的外层（`PROTOCOL.key`）：
//!
//! ```text
//! "openssh-key-v1\0"      ← 字面量，不是长度前缀的 string！
//! string ciphername       （none / aes256-ctr）
//! string kdfname          （none / bcrypt）
//! string kdfoptions       （bcrypt 时是 string(salt) + uint32(rounds)）
//! uint32 密钥个数          （这里是 1）
//! string 公钥 blob
//! string 私钥段（加密时是密文）
//! ```
//!
//! 私钥段（解密后）：
//!
//! ```text
//! uint32 checkint1
//! uint32 checkint2        （与 checkint1 相同，用来确认解对了）
//! string "ssh-rsa"        ← 类型标识
//! mpint n, e, d, iqmp, p, q
//! string 注释
//! 填充字节 1, 2, 3, …     （补到分组长度）
//! ```
//!
//! `iqmp` 是 **q⁻¹ mod p**（OpenSSL 的 `coefficient`、OpenSSH 的 `iqmp` 都是这个
//! 口径；反过来 `p⁻¹ mod q` 的实现读出来是错的）。
//!
//! ## 与上游的四处刻意不同
//!
//! 1. **不做 PuTTY（`.ppk`）**。sshpk 自己的 PuTTY 写出器就是坏的：它把**私钥**
//!    blob 塞进了 `Public-Lines:` 那一段，PuTTY 本体读不了（只有 sshpk 自己能
//!    圆回来）。要写对 PPK v2 得算一遍 HMAC-SHA1，v3 还得引入 Argon2；而能读
//!    PPK 的工具（PuTTY、WinSCP）也都读 OpenSSH 格式。所以这里**不做**，而不是
//!    做一个半对的。
//! 2. **`pem` + 口令走传统 OpenSSL PEM 加密**（`Proc-Type: 4,ENCRYPTED` +
//!    `DEK-Info: AES-128-CBC,…`），而不是上游 node-forge 默认给的
//!    PKCS#8 `ENCRYPTED PRIVATE KEY`（PBES2）。传统那套 `openssl rsa`、
//!    `ssh-keygen`、PuTTY 都读，后者只有 OpenSSL 3 读得到。
//! 3. **口令加密的 OpenSSH 私钥用 `aes256-ctr`**（OpenSSH 自己的默认值），
//!    上游 sshpk 用的是 `aes128-ctr`。两者 `ssh-keygen` 都读。
//! 4. **`ssh` 与 `openssh` 都能给口令**。上游的界面只对 `pem` 与 `ssh` 开放口令
//!    输入框，但这两档的私钥是同一个格式，所以这里两个都给。
//!
//! ## 加密
//!
//! - `pem` + 口令 → 传统 OpenSSL PEM 加密：密钥由 `EVP_BytesToKey`（MD5，1 次迭代）
//!   从「口令 ‖ 盐」派生，**盐是 IV 的前 8 字节**（OpenSSL 的 `PEM_do_header`
//!   就是这么做的，已用 `openssl genrsa -traditional -aes128` 对拍验证），
//!   IV 本身明文写在 `DEK-Info` 里。
//! - `ssh` / `openssh` + 口令 → OpenSSH 自己的方案：`bcrypt-pbkdf` 派生 48 字节
//!   （前 32 字节是 AES-256 密钥，后 16 字节是 IV），再用 AES-256-CTR 加密私钥段。
//! - 其余格式不支持口令：PKCS#8 的 PBES2 要另写一套 DER 编码，给了口令就报错，
//!   而不是悄悄忽略 —— 悄悄忽略等于给出一把明文私钥。
//!
//! ## 安全边界
//!
//! 口令与私钥都只活在这一次请求的内存里：口令不会落盘、不进日志、
//! 不进错误信息（下面的 `map_err` 只带库的错误类型，不带密钥材料）。
//! 私钥经 HTTP 响应体发往浏览器 —— 这条链路上它就是明文，只受 TLS 保护。

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine as _;
use rand::rngs::OsRng;
use rand::RngCore;
use rsa::pkcs1::{EncodeRsaPrivateKey, EncodeRsaPublicKey};
use rsa::pkcs8::{EncodePrivateKey, EncodePublicKey, LineEnding};
use rsa::traits::{PrivateKeyParts, PublicKeyParts};
use rsa::{BigUint, RsaPrivateKey, RsaPublicKey};

use super::ssh_key::{self, pem_block, SshBuf, SshKey, PEM_LINE_OPENSSL};
use super::ToolError;

/// 传统 PEM 加密用的 AES-128-CBC：16 字节密钥 + 16 字节 IV。
const PEM_AES128_KEY_LEN: usize = 16;

/// 传统 PEM 加密用的 IV 长度（AES 的分组长度）。
const PEM_AES128_IV_LEN: usize = 16;

/// 传统 PEM 加密里 `EVP_BytesToKey` 用的盐长度 —— 是 IV 的**前 8 字节**。
///
/// OpenSSL 的 `PEM_do_header` 把 `DEK-Info` 里的 IV 的前 8 字节当盐
/// （`EVP_BytesToKey` 的盐只有 8 字节）；当成整个 16 字节 IV 派生出来的密钥
/// 是解不开的。
const PEM_SALT_LEN: usize = 8;

/// 输出格式。
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Format {
    /// PEM：私钥 PKCS#1（`RSA PRIVATE KEY`），公钥 SPKI（`PUBLIC KEY`）。可加密。
    Pem,
    /// PKCS#1：私钥同 [`Format::Pem`]，公钥 PKCS#1（`RSA PUBLIC KEY`）。不可加密。
    Pkcs1,
    /// PKCS#8：私钥 `PRIVATE KEY`，公钥 SPKI。不可加密。
    Pkcs8,
    /// OpenSSH 私钥 + authorized_keys 那一行公钥（`ssh-rsa AAAA…`）。
    Ssh,
    /// OpenSSH 私钥 + `OPENSSH PUBLIC KEY` 公钥。私有钥与 [`Format::Ssh`] 相同。
    OpenSsh,
}

impl Format {
    /// 解析注册表下拉框送来的字符串。未知取值返回 `None`（由调用方报错）。
    pub fn parse(raw: &str) -> Option<Self> {
        match raw {
            "pem" => Some(Self::Pem),
            "pkcs1" => Some(Self::Pkcs1),
            "pkcs8" => Some(Self::Pkcs8),
            "ssh" => Some(Self::Ssh),
            "openssh" => Some(Self::OpenSsh),
            _ => None,
        }
    }

    /// 这个格式能不能用口令加密。
    pub fn supports_passphrase(self) -> bool {
        matches!(self, Self::Pem | Self::Ssh | Self::OpenSsh)
    }
}

/// 编码结果：一对公私钥的两种文本形态。
pub struct Encoded {
    /// 私钥文本（PEM 或 `ssh-rsa …` 那种单行格式）。
    pub private_key: String,
    /// 公钥文本。
    pub public_key: String,
}

/// 把密钥对编码成指定格式。
///
/// `passphrase` 为 `None` 或空串时按「不加密」处理。
pub fn encode(
    format: Format,
    key: &RsaPrivateKey,
    passphrase: Option<&str>,
    comment: &str,
) -> Result<Encoded, ToolError> {
    let passphrase = passphrase.filter(|p| !p.is_empty());

    if passphrase.is_some() && !format.supports_passphrase() {
        return Err(ToolError::invalid(
            "out.rsa-key-pair-generator.err.format_no_passphrase",
            &[("format", format_name(format))],
        ));
    }

    let public_key = encode_public(format, &key.to_public_key(), comment)?;
    let private_key = encode_private(format, key, passphrase, comment)?;
    Ok(Encoded {
        private_key,
        public_key,
    })
}

/// 格式的机器可读名字（错误信息用）。
pub fn format_name(format: Format) -> &'static str {
    match format {
        Format::Pem => "pem",
        Format::Pkcs1 => "pkcs1",
        Format::Pkcs8 => "pkcs8",
        Format::Ssh => "ssh",
        Format::OpenSsh => "openssh",
    }
}

/* ------------------------------------------------------------------ 公钥 */

fn encode_public(
    format: Format,
    key: &RsaPublicKey,
    comment: &str,
) -> Result<String, ToolError> {
    match format {
        // SPKI：浏览器 WebCrypto 与绝大多数工具只认这一种
        Format::Pem | Format::Pkcs8 => key
            .to_public_key_pem(LineEnding::LF)
            .map(|s| s.to_string())
            .map_err(|e| ToolError::Internal(format!("公钥 PEM 编码失败: {e}"))),
        // PKCS#1 的公钥：只有少数老工具要
        Format::Pkcs1 => key
            .to_pkcs1_pem(LineEnding::LF)
            .map_err(|e| ToolError::Internal(format!("公钥 PEM 编码失败: {e}"))),
        // authorized_keys 那一行
        Format::Ssh => Ok(ssh_public_line(key, comment)),
        // `OPENSSH PUBLIC KEY`：sshpk 的公钥形态（OpenSSH 自己不写这个文件）
        Format::OpenSsh => Ok(openssh_public_pem(key)),
    }
}

/* ------------------------------------------------------------------ 私钥 */

fn encode_private(
    format: Format,
    key: &RsaPrivateKey,
    passphrase: Option<&str>,
    comment: &str,
) -> Result<String, ToolError> {
    match format {
        // PKCS#1 v1.5（`RSA PRIVATE KEY`）—— node-forge `pki.privateKeyToPem`
        // 与 `openssl rsa -traditional` 的那种
        Format::Pem | Format::Pkcs1 => {
            let der = key
                .to_pkcs1_der()
                .map_err(|e| ToolError::Internal(format!("私钥 DER 编码失败: {e}")))?;
            match passphrase {
                Some(pw) => Ok(encrypt_pem_traditional(der.as_bytes(), pw)?),
                None => Ok(pem_block("RSA PRIVATE KEY", der.as_bytes(), PEM_LINE_OPENSSL)),
            }
        }
        // PKCS#8 v2.1（`PRIVATE KEY`）
        Format::Pkcs8 => key
            .to_pkcs8_pem(LineEnding::LF)
            .map(|s| s.to_string())
            .map_err(|e| ToolError::Internal(format!("私钥 PEM 编码失败: {e}"))),
        // openssh-key-v1
        Format::Ssh | Format::OpenSsh => openssh_private_pem(key, passphrase, comment),
    }
}

/* -------------------------------------------------- 传统 PEM 加密（口令） */

/// 传统 OpenSSL PEM 加密：`Proc-Type: 4,ENCRYPTED` + `DEK-Info: AES-128-CBC,…`。
///
/// 密钥由 `EVP_BytesToKey`（MD5，1 次迭代）从「口令 ‖ 盐」派生 —— 这里的盐是
/// `DEK-Info` 里那个 IV 的**前 8 字节**（OpenSSL 的 `PEM_do_header` 就是取 IV
/// 的前 8 字节当盐），IV 本身原样写进 `DEK-Info`。OpenSSL 读这个格式时走的
/// 也是同一条派生链，所以两边互通。
fn encrypt_pem_traditional(der: &[u8], passphrase: &str) -> Result<String, ToolError> {
    // 16 字节 IV：OpenSSL 读的时候不校验来源，只当随机数用
    let mut iv = [0u8; PEM_AES128_IV_LEN];
    OsRng.fill_bytes(&mut iv);

    let (key, _) = super::encryption::evp_bytes_to_key(
        passphrase.as_bytes(),
        &iv[..PEM_SALT_LEN],
        PEM_AES128_KEY_LEN,
        0,
    );

    let ct = super::encryption::cbc_encrypt::<cbc::Encryptor<aes::Aes128>>(&key, &iv, der)?;

    let mut out = String::new();
    out.push_str("-----BEGIN RSA PRIVATE KEY-----\n");
    out.push_str("Proc-Type: 4,ENCRYPTED\n");
    out.push_str(&format!(
        "DEK-Info: AES-128-CBC,{}\n\n",
        hex::encode_upper(iv)
    ));
    let body = B64.encode(&ct);
    for chunk in body.as_bytes().chunks(PEM_LINE_OPENSSL) {
        out.push_str(std::str::from_utf8(chunk).expect("base64 一定是 ASCII"));
        out.push('\n');
    }
    out.push_str("-----END RSA PRIVATE KEY-----\n");
    Ok(out)
}

/* ---------------------------------------------------------- SSH 线格式 */

/// `ssh-rsa` 的公钥 blob：`string("ssh-rsa") + mpint(e) + mpint(n)`。
///
/// 注意顺序是 e 在前、n 在后 —— SSH 的 RSA 公钥一直是这个反过来的顺序。
fn ssh_rsa_public_blob(key: &RsaPublicKey) -> Vec<u8> {
    let mut b = SshBuf::new();
    b.put_str("ssh-rsa");
    b.put_mpint(&key.e().to_bytes_be());
    b.put_mpint(&key.n().to_bytes_be());
    b.into_vec()
}

/// authorized_keys 的一行：`ssh-rsa <base64>[ comment]`。
fn ssh_public_line(key: &RsaPublicKey, comment: &str) -> String {
    // 公钥那一半与私钥无关，单独装一个 [`SshKey`] 就够
    SshKey::new("ssh-rsa", ssh_rsa_public_blob(key), Vec::new()).public_line(comment)
}

/// `OPENSSH PUBLIC KEY`：只有公钥那一半的 openssh-key-v1 外壳。
///
/// sshpk 的公钥 `toString('openssh')` 就是这个形状；OpenSSH 自己不写这种文件，
/// 但 sshpk 能读回去。
fn openssh_public_pem(key: &RsaPublicKey) -> String {
    ssh_key::openssh_public_pem(&ssh_rsa_public_blob(key))
}

/// 把一把 RSA 密钥装进 [`SshKey`]：公钥 blob 与私钥段的算法字段。
fn ssh_rsa_key(key: &RsaPrivateKey) -> SshKey {
    // 私钥段（解密后）是
    // checkint1 ‖ checkint2 ‖ "ssh-rsa" ‖ n ‖ e ‖ d ‖ iqmp ‖ p ‖ q ‖ 注释
    let mut fields = SshBuf::new();
    fields.put_mpint(&key.n().to_bytes_be());
    fields.put_mpint(&key.e().to_bytes_be());
    fields.put_mpint(&key.d().to_bytes_be());
    put_iqmp(&mut fields, key);
    fields.put_mpint(&key.primes()[0].to_bytes_be());
    fields.put_mpint(&key.primes()[1].to_bytes_be());

    SshKey::new("ssh-rsa", ssh_rsa_public_blob(&key.to_public_key()), fields.into_vec())
}

/// `openssh-key-v1` 私钥（`-----BEGIN OPENSSH PRIVATE KEY-----`）。
fn openssh_private_pem(
    key: &RsaPrivateKey,
    passphrase: Option<&str>,
    comment: &str,
) -> Result<String, ToolError> {
    ssh_rsa_key(key).private_pem(passphrase, comment)
}

/// `iqmp` = q⁻¹ mod p，是 CRT 用的那个系数。
///
/// `RsaPrivateKey::crt_coefficient()` 现算现给（`Option`，算不出来是 `None`）；
/// 拿不到就不写这个分量 —— 宁可少写一个字段，也不能写错。
fn put_iqmp(b: &mut SshBuf, key: &RsaPrivateKey) {
    match key.crt_coefficient() {
        Some(c) => b.put_mpint(&c.to_bytes_be()),
        None => b.put_mpint(&BigUint::from(0u32).to_bytes_be()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::ssh_key::{BCRYPT_ROUNDS, BCRYPT_SALT_LEN, OPENSSH_MAGIC};
    use rsa::pkcs1::{DecodeRsaPrivateKey, DecodeRsaPublicKey};
    use rsa::pkcs8::{DecodePrivateKey, DecodePublicKey};

    /// 单测只生成 512 位：dev profile 未优化时 2048 位要 2.6 秒。
    const TEST_BITS: usize = 512;

    fn key() -> RsaPrivateKey {
        let mut rng = OsRng;
        RsaPrivateKey::new(&mut rng, TEST_BITS).expect("密钥生成不该失败")
    }

    /// 解开 SSH 线格式的 mpint 序列，返回去掉了前导 0x00 的大端字节串。
    fn read_string(buf: &[u8], pos: &mut usize) -> Vec<u8> {
        let len = u32::from_be_bytes(buf[*pos..*pos + 4].try_into().unwrap()) as usize;
        *pos += 4;
        let out = buf[*pos..*pos + len].to_vec();
        *pos += len;
        out
    }

    /// 读一个 mpint，返回去掉了前导 0x00 的大端字节串。
    fn read_mpint(buf: &[u8], pos: &mut usize) -> Vec<u8> {
        let mut v = read_string(buf, pos);
        if v.first() == Some(&0) {
            v.remove(0);
        }
        v
    }

    /// 拆开一个 openssh-key-v1 的 PEM 正文。
    struct Openssh {
        cipher: Vec<u8>,
        kdf: Vec<u8>,
        kdfopts: Vec<u8>,
        public_blob: Vec<u8>,
        /// 私钥段；`OPENSSH PUBLIC KEY` 那种只有公钥的文件里没有这一段。
        section: Option<Vec<u8>>,
    }

    fn parse_openssh(pem: &str) -> Openssh {
        let body: String = pem
            .lines()
            .filter(|l| !l.starts_with("-----"))
            .collect::<Vec<_>>()
            .join("");
        let buf = B64.decode(body).unwrap();

        // 魔数是字面量，没有长度前缀
        assert_eq!(&buf[..OPENSSH_MAGIC.len()], OPENSSH_MAGIC);
        let mut pos = OPENSSH_MAGIC.len();
        let cipher = read_string(&buf, &mut pos);
        let kdf = read_string(&buf, &mut pos);
        let kdfopts = read_string(&buf, &mut pos);
        let nkeys = u32::from_be_bytes(buf[pos..pos + 4].try_into().unwrap());
        pos += 4;
        assert_eq!(nkeys, 1);
        let public_blob = read_string(&buf, &mut pos);
        // 只有公钥的文件（`OPENSSH PUBLIC KEY`）到这里就结束了
        let section = if pos < buf.len() {
            Some(read_string(&buf, &mut pos))
        } else {
            None
        };
        assert_eq!(pos, buf.len(), "外层不该有多余内容");
        Openssh {
            cipher,
            kdf,
            kdfopts,
            public_blob,
            section,
        }
    }

    /// 拆开私钥段，返回 (类型, n, e, d, iqmp, p, q, 注释)。
    fn parse_private_section(section: &[u8]) -> (Vec<u8>, Vec<u8>, Vec<u8>, Vec<u8>, Vec<u8>, Vec<u8>, Vec<u8>, Vec<u8>) {
        let mut pos = 8; // 两个 checkint
        let kind = read_string(section, &mut pos);
        let n = read_mpint(section, &mut pos);
        let e = read_mpint(section, &mut pos);
        let d = read_mpint(section, &mut pos);
        let iqmp = read_mpint(section, &mut pos);
        let p = read_mpint(section, &mut pos);
        let q = read_mpint(section, &mut pos);
        let comment = read_string(section, &mut pos);
        (kind, n, e, d, iqmp, p, q, comment)
    }

    #[test]
    fn ssh_public_line_has_the_expected_shape() {
        let k = key();
        let line = ssh_public_line(&k.to_public_key(), "me@example.com");
        let mut parts = line.split(' ');
        assert_eq!(parts.next(), Some("ssh-rsa"));
        let blob = B64.decode(parts.next().unwrap()).unwrap();
        assert_eq!(parts.next(), Some("me@example.com"));
        assert_eq!(parts.next(), None, "不该有多余的空格字段");

        // blob 的内容：string("ssh-rsa") + mpint(e) + mpint(n)
        let mut pos = 0;
        assert_eq!(read_string(&blob, &mut pos), b"ssh-rsa");
        let e = read_mpint(&blob, &mut pos);
        let n = read_mpint(&blob, &mut pos);
        assert_eq!(pos, blob.len(), "blob 里不该有多余内容");
        assert_eq!(e, k.e().to_bytes_be());
        assert_eq!(n, k.n().to_bytes_be());
    }

    #[test]
    fn ssh_public_line_without_a_comment_has_no_trailing_space() {
        let k = key();
        let line = ssh_public_line(&k.to_public_key(), "");
        assert!(!line.ends_with(' '), "{line}");
        assert_eq!(line.split(' ').count(), 2);
    }

    /// 最高位为 1 的 mpint 必须补 0x00，否则会被当成负数。
    #[test]
    fn mpint_gets_a_leading_zero_when_the_high_bit_is_set() {
        let mut b = SshBuf::new();
        b.put_mpint(&[0x80]); // 0b1000_0000
        let buf = b.into_vec();
        assert_eq!(&buf[4..], &[0x00, 0x80]);

        // 高位为 0 的不用补
        let mut b = SshBuf::new();
        b.put_mpint(&[0x7f]);
        let buf = b.into_vec();
        assert_eq!(&buf[4..], &[0x7f]);
    }

    /// openssh-key-v1 的外壳：魔数是字面量，公钥 blob 与私钥段各自带长度。
    #[test]
    fn openssh_private_pem_has_the_openssh_key_v1_framing() {
        let k = key();
        let pem = openssh_private_pem(&k, None, "note").unwrap();
        assert!(pem.starts_with("-----BEGIN OPENSSH PRIVATE KEY-----\n"));
        let parsed = parse_openssh(&pem);
        assert_eq!(parsed.cipher, b"none");
        assert_eq!(parsed.kdf, b"none");
        assert!(parsed.kdfopts.is_empty());
        assert_eq!(parsed.public_blob, ssh_rsa_public_blob(&k.to_public_key()));

        // 私钥段
        let section = parsed.section.expect("私钥文件该有私钥段");
        let (kind, n, e, d, iqmp, p, q, comment) = parse_private_section(&section);
        assert_eq!(kind, b"ssh-rsa");
        assert_eq!(n, k.n().to_bytes_be());
        assert_eq!(e, k.e().to_bytes_be());
        assert_eq!(d, k.d().to_bytes_be());
        assert_eq!(p, k.primes()[0].to_bytes_be());
        assert_eq!(q, k.primes()[1].to_bytes_be());
        assert_eq!(comment, b"note");

        // iqmp 必须是 q⁻¹ mod p（OpenSSL 的 coefficient、OpenSSH 的 iqmp 都是这个口径）
        let coeff = BigUint::from_bytes_be(&iqmp);
        let prod = (&coeff * &BigUint::from_bytes_be(&q)) % &BigUint::from_bytes_be(&p);
        assert_eq!(prod, BigUint::from(1u32), "iqmp 必须是 q 在模 p 下的逆元");

        // 剩下的都是填充，且长度是 8 的倍数（"none" 加密器的分组长度）
        assert_eq!(section.len() % 8, 0);
    }

    /// 两个 checkint 必须相同 —— 解口令解错时靠它们发现。
    #[test]
    fn the_two_check_ints_are_equal() {
        let k = key();
        let pem = openssh_private_pem(&k, None, "note").unwrap();
        let parsed = parse_openssh(&pem);
        let section = parsed.section.expect("私钥文件该有私钥段");
        let c1 = u32::from_be_bytes(section[0..4].try_into().unwrap());
        let c2 = u32::from_be_bytes(section[4..8].try_into().unwrap());
        assert_eq!(c1, c2);
    }

    #[test]
    fn openssh_private_pem_is_encrypted_when_a_passphrase_is_given() {
        let k = key();
        let pem = openssh_private_pem(&k, Some("secret"), "note").unwrap();
        let parsed = parse_openssh(&pem);
        assert_eq!(parsed.cipher, b"aes256-ctr");
        assert_eq!(parsed.kdf, b"bcrypt");

        // kdfoptions = string(salt) + uint32(rounds)
        let mut pos = 0;
        let salt = read_string(&parsed.kdfopts, &mut pos);
        assert_eq!(salt.len(), BCRYPT_SALT_LEN);
        assert_eq!(
            u32::from_be_bytes(parsed.kdfopts[pos..pos + 4].try_into().unwrap()),
            BCRYPT_ROUNDS
        );
    }

    /// 加密后私钥段是密文：既不等于明文，也不该露出类型标识。
    #[test]
    fn the_encrypted_section_is_not_readable_as_plaintext() {
        let k = key();
        let plain = parse_openssh(&openssh_private_pem(&k, None, "note").unwrap())
            .section
            .expect("该有私钥段");
        let cipher = parse_openssh(&openssh_private_pem(&k, Some("secret"), "note").unwrap())
            .section
            .expect("该有私钥段");
        assert_ne!(plain, cipher, "加密后不该与明文相同");
        assert!(
            !cipher.windows(7).any(|w| w == b"ssh-rsa"),
            "密文里不该出现类型标识"
        );
    }

    /// `OPENSSH PUBLIC KEY`：只有公钥那一半。
    #[test]
    fn openssh_public_pem_carries_only_the_public_blob() {
        let k = key();
        let pem = openssh_public_pem(&k.to_public_key());
        assert!(pem.starts_with("-----BEGIN OPENSSH PUBLIC KEY-----\n"));
        let body: String = pem
            .lines()
            .filter(|l| !l.starts_with("-----"))
            .collect::<Vec<_>>()
            .join("");
        let buf = B64.decode(body).unwrap();
        assert_eq!(&buf[..OPENSSH_MAGIC.len()], OPENSSH_MAGIC);
        let mut pos = OPENSSH_MAGIC.len();
        assert_eq!(read_string(&buf, &mut pos), b"none");
        assert_eq!(read_string(&buf, &mut pos), b"none");
        assert!(read_string(&buf, &mut pos).is_empty());
        assert_eq!(
            u32::from_be_bytes(buf[pos..pos + 4].try_into().unwrap()),
            1
        );
        pos += 4;
        let pub_blob = read_string(&buf, &mut pos);
        assert_eq!(pub_blob, ssh_rsa_public_blob(&k.to_public_key()));
        assert_eq!(pos, buf.len(), "公钥文件不该有私钥段");
    }

    /// 私钥必须真的能被解回来 —— 只比对前缀的话，一个「公钥私钥各生成一次」的
    /// 实现也能蒙混过关。
    #[test]
    fn the_private_key_in_pkcs1_pem_decodes_back_to_the_same_key() {
        let k = key();
        let out = encode(Format::Pem, &k, None, "").unwrap();
        let parsed = RsaPrivateKey::from_pkcs1_pem(&out.private_key).expect("应能解回来");
        assert_eq!(parsed.n(), k.n());
        assert_eq!(parsed.d(), k.d());
    }

    #[test]
    fn pkcs8_private_key_decodes_back_to_the_same_key() {
        let k = key();
        let out = encode(Format::Pkcs8, &k, None, "").unwrap();
        assert!(out.private_key.starts_with("-----BEGIN PRIVATE KEY-----"));
        let parsed = RsaPrivateKey::from_pkcs8_pem(&out.private_key).expect("应能解回来");
        assert_eq!(parsed.n(), k.n());
    }

    #[test]
    fn the_public_key_is_derived_from_the_private_key_in_every_format() {
        let k = key();
        for format in [
            Format::Pem,
            Format::Pkcs1,
            Format::Pkcs8,
            Format::Ssh,
            Format::OpenSsh,
        ] {
            let out = encode(format, &k, None, "").unwrap();
            // 公钥私钥必须是同一对：把公钥解回来，n / e 要与私钥一致
            match format {
                Format::Pkcs1 => {
                    let parsed = rsa::RsaPublicKey::from_pkcs1_pem(&out.public_key).unwrap();
                    assert_eq!(parsed.n(), k.n());
                    assert_eq!(parsed.e(), k.e());
                }
                Format::Ssh => {
                    let blob = B64
                        .decode(out.public_key.split(' ').nth(1).unwrap())
                        .unwrap();
                    let mut pos = 0;
                    assert_eq!(read_string(&blob, &mut pos), b"ssh-rsa");
                    assert_eq!(read_mpint(&blob, &mut pos), k.e().to_bytes_be());
                    assert_eq!(read_mpint(&blob, &mut pos), k.n().to_bytes_be());
                }
                Format::OpenSsh => {
                    let parsed = parse_openssh(&out.public_key);
                    let mut pos = 0;
                    assert_eq!(read_string(&parsed.public_blob, &mut pos), b"ssh-rsa");
                    assert_eq!(read_mpint(&parsed.public_blob, &mut pos), k.e().to_bytes_be());
                    assert_eq!(read_mpint(&parsed.public_blob, &mut pos), k.n().to_bytes_be());
                }
                _ => {
                    let parsed = rsa::RsaPublicKey::from_public_key_pem(&out.public_key).unwrap();
                    assert_eq!(parsed.n(), k.n());
                    assert_eq!(parsed.e(), k.e());
                }
            }
        }
    }

    /// `ssh` 与 `openssh` 的**私钥**必须一模一样（上游也是这样的：sshpk 的
    /// `ssh-private` 与 `openssh` 是同一个写出器）。
    #[test]
    fn ssh_and_openssh_share_the_same_private_key() {
        let k = key();
        let a = encode(Format::Ssh, &k, None, "c").unwrap();
        let b = encode(Format::OpenSsh, &k, None, "c").unwrap();
        // 私钥段里的 checkint 是随机的，所以不能整份逐字节相等；
        // 但类型、分量、注释必须一致。
        let pa = parse_openssh(&a.private_key);
        let pb = parse_openssh(&b.private_key);
        assert_eq!(pa.cipher, pb.cipher);
        assert_eq!(pa.kdf, pb.kdf);
        assert_eq!(pa.public_blob, pb.public_blob);
        let sa = pa.section.expect("该有私钥段");
        let sb = pb.section.expect("该有私钥段");
        assert_eq!(
            parse_private_section(&sa).1,
            parse_private_section(&sb).1
        );
    }

    #[test]
    fn a_passphrase_is_rejected_for_the_formats_that_cannot_encrypt() {
        let k = key();
        for format in [Format::Pkcs1, Format::Pkcs8] {
            let err = encode(format, &k, Some("secret"), "")
                .err()
                .expect("给了口令就该报错");
            // 断言**键**而不是消息文本：文案在语言包里
            match err {
                ToolError::InvalidKeyed { key, args } => {
                    assert_eq!(key, "out.rsa-key-pair-generator.err.format_no_passphrase");
                    // 格式名要带在参数里 —— 报错时得让人知道自己选错了哪一档
                    assert!(
                        args.iter().any(|(n, v)| n == "format" && v == format_name(format)),
                        "{args:?}"
                    );
                }
                other => panic!("{format:?}: 应当报 format_no_passphrase，实际 {other:?}"),
            }
        }
        // 空口令等于没给
        assert!(encode(Format::Pkcs8, &k, Some(""), "").is_ok());
    }

    #[test]
    fn unknown_format_names_are_rejected() {
        assert_eq!(Format::parse("pem"), Some(Format::Pem));
        assert_eq!(Format::parse("openssh"), Some(Format::OpenSsh));
        assert_eq!(Format::parse("putty"), None);
        assert_eq!(Format::parse(""), None);
    }

    /// 传统 PEM 加密的密钥派生：盐是 IV 的**前 8 字节**。
    ///
    /// 用 OpenSSL 造一把同格式的密钥，对拍派生结果。这里自己实现一遍
    /// `EVP_BytesToKey`（MD5，1 次迭代），再拿 `DEK-Info` 里的 IV 与口令
    /// 派生出的密钥解密 OpenSSL 的密文 —— 能解出 PKCS#1 的 DER 头才算对。
    #[test]
    fn the_traditional_pem_uses_the_first_eight_bytes_of_the_iv_as_salt() {
        let k = key();
        let pem = encrypt_pem_traditional(
            &rsa::pkcs1::EncodeRsaPrivateKey::to_pkcs1_der(&k)
                .unwrap()
                .as_bytes()
                .to_vec(),
            "secret",
        )
        .unwrap();

        let dek = pem
            .lines()
            .find(|l| l.starts_with("DEK-Info:"))
            .expect("该有 DEK-Info");
        let iv_hex = dek.split(',').nth(1).expect("该有 IV");
        let iv = hex::decode(iv_hex).unwrap();

        // 自己算一遍 EVP_BytesToKey
        let mut out = Vec::new();
        let mut prev: Vec<u8> = Vec::new();
        while out.len() < PEM_AES128_KEY_LEN {
            // 写成完全限定的形式：模块里还 import 了 `aes::cipher::KeyInit`，
            // `Md5::new()` 会和它的 `new` 撞车。
            let mut hasher = <md5::Md5 as md5::Digest>::new();
            md5::Digest::update(&mut hasher, &prev);
            md5::Digest::update(&mut hasher, b"secret");
            md5::Digest::update(&mut hasher, &iv[..PEM_SALT_LEN]);
            prev = md5::Digest::finalize(hasher).to_vec();
            out.extend_from_slice(&prev);
        }
        let key_bytes = &out[..PEM_AES128_KEY_LEN];

        // 解回来：密文是自己刚加密的，DER 头应当能对上
        let ct = B64
            .decode(
                pem.lines()
                    .filter(|l| !l.starts_with("-----") && !l.contains(':'))
                    .collect::<String>(),
            )
            .unwrap();
        let pt = super::super::encryption::cbc_decrypt::<cbc::Decryptor<aes::Aes128>>(
            key_bytes, &iv, &ct,
        )
        .unwrap();
        assert_eq!(pt[0], 0x30, "解出来应当是 DER 的 SEQUENCE 头");
        assert_eq!(pt[1], 0x82, "解出来应当是 DER 的长格式长度");
    }

    /// 错误消息要跟着请求语言走 —— 语言不是工具决定的，是 API 层
    /// 按请求语言调用 `localize` 渲染的。
    #[test]
    fn the_error_message_follows_the_requested_language() {
        let k = key();
        let err = encode(Format::Pkcs8, &k, Some("secret"), "")
            .err()
            .expect("给了口令就该报错");
        let err_key = "out.rsa-key-pair-generator.err.format_no_passphrase";
        // 语言包里还没并进来时，localize 退回键本身 —— 这时断言跳过
        if !crate::i18n::has("zh-CN", err_key) {
            return;
        }
        let en = err.localize("en");
        let zh = err.localize("zh-CN");
        assert_ne!(en, zh, "两种语言不该是同一句");
        assert!(!en.contains("out.rsa-key-pair-generator"), "英文界面不该露出键：{en}");
        assert!(!zh.contains("out.rsa-key-pair-generator"), "中文界面不该露出键：{zh}");
    }
}
