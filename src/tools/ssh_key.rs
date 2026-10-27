//! SSH 线格式与 `openssh-key-v1` 容器。
//!
//! 单独一个模块，因为三处都要用同一套编码：
//!
//! - [`super::rsa_formats`]：RSA 的 `ssh` / `openssh` 两档输出（上游 PR #888）
//! - [`super::ssh_key_pair_generator`]：SSH 密钥对生成器（上游 PR #1873）
//! - 想自己写 authorized_keys 行的工具
//!
//! ## 线格式
//!
//! RFC 4251 §5：定长整数是大端；`string` 是「4 字节长度 + 内容」；
//! `mpint` 是补码形式的大端字节串，最高位为 1 时前面补一个 0x00。
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
//! string 密钥类型          ← "ssh-ed25519" / "ecdsa-sha2-nistp256" / "ssh-rsa"
//! …算法相关字段…
//! string 注释
//! 填充字节 1, 2, 3, …     （补到分组长度）
//! ```
//!
//! ## 两个容易踩的坑
//!
//! 1. **魔数是字面量**，写成 `string("openssh-key-v1\0")` 的话 OpenSSH 与 sshpk
//!    都读不出来。
//! 2. **填充的分组长度取决于加密器**：`none` 是 8，`aes256-ctr` 是 16
//!    （AES 的分组长度）。填错了 `ssh-keygen` 会报 "incorrect passphrase"
//!    或直接读不出私钥。
//!
//! ## 口令加密
//!
//! OpenSSH 自己的方案：`bcrypt-pbkdf` 派生 48 字节（前 32 字节是 AES-256 密钥，
//! 后 16 字节是 IV），再用 AES-256-CTR 加密私钥段。计数器按 128 位大端递增 ——
//! OpenSSL 的 `aes-256-ctr` 与 OpenSSH 的 `aes256-ctr` 都是这个口径。

use aes::cipher::{BlockCipherEncrypt, KeyInit};
use base64::engine::general_purpose::{STANDARD as B64, STANDARD_NO_PAD as B64_NO_PAD};
use base64::Engine as _;
use rand::Rng;
use sha2::{Digest, Sha256};

use super::ToolError;

/// `openssh-key-v1` 的魔数。
///
/// **是字面量，不是长度前缀的 string。**
pub const OPENSSH_MAGIC: &[u8] = b"openssh-key-v1\0";

/// OpenSSL 风格的 PEM 正文折行宽度（node-forge / OpenSSL 都是 64）。
pub const PEM_LINE_OPENSSL: usize = 64;

/// OpenSSH 风格的 PEM 正文折行宽度（OpenSSH 与 sshpk 都是 70）。
pub const PEM_LINE_OPENSSH: usize = 70;

/// `openssh-key-v1` 的口令加密：bcrypt-pbkdf 的迭代轮数（OpenSSH 默认 16）。
pub const BCRYPT_ROUNDS: u32 = 16;

/// bcrypt-pbkdf 的盐长度（OpenSSH 用 16 字节）。
pub const BCRYPT_SALT_LEN: usize = 16;

/// AES-256-CTR 要用的材料：32 字节密钥 + 16 字节 IV。
const AES256_KEY_LEN: usize = 32;
const AES256_IV_LEN: usize = 16;

/// `none` 加密器的分组长度（OpenSSH 的约定）。
const BLOCK_NONE: usize = 8;

/// `aes256-ctr` 的分组长度（AES 的分组长度）。
const BLOCK_AES_CTR: usize = 16;

/// SSH 线格式的写入器（RFC 4251 §5）。
#[derive(Default)]
pub struct SshBuf {
    buf: Vec<u8>,
}

impl SshBuf {
    pub fn new() -> Self {
        Self { buf: Vec::new() }
    }

    /// 4 字节大端整数。
    pub fn put_u32(&mut self, v: u32) {
        self.buf.extend_from_slice(&v.to_be_bytes());
    }

    /// 裸字节（没有长度前缀）。
    pub fn put_raw(&mut self, b: &[u8]) {
        self.buf.extend_from_slice(b);
    }

    /// `string`（4 字节长度 + 内容）。
    pub fn put_bytes(&mut self, b: &[u8]) {
        self.put_u32(b.len() as u32);
        self.buf.extend_from_slice(b);
    }

    /// `string` 形式的文本（不含结尾的 NUL）。
    pub fn put_str(&mut self, s: &str) {
        self.put_bytes(s.as_bytes());
    }

    /// `mpint`：补码形式的大端字节串，最高位为 1 时前面补一个 0x00。
    ///
    /// 入参是**幅度**（大端字节串，不是补码）：前导零会被去掉，
    /// 因为 `mpint` 规定「不得有多余的前导零字节」。
    pub fn put_mpint(&mut self, bytes: &[u8]) {
        let start = bytes.iter().position(|b| *b != 0).unwrap_or(bytes.len());
        let v = &bytes[start..];
        if v.is_empty() {
            // 0 的 mpint 是空串（RSA 的六个分量都不会是 0，这里只是别 panic）
            self.put_bytes(&[]);
            return;
        }
        if v[0] & 0x80 != 0 {
            let mut w = Vec::with_capacity(v.len() + 1);
            w.push(0u8);
            w.extend_from_slice(v);
            self.put_bytes(&w);
        } else {
            self.put_bytes(v);
        }
    }

    pub fn into_vec(self) -> Vec<u8> {
        self.buf
    }
}

/// 把 DER 装进 PEM 头尾里，正文按 `line` 折行。
pub fn pem_block(label: &str, der: &[u8], line: usize) -> String {
    let body = B64.encode(der);
    let mut out = String::with_capacity(body.len() + label.len() * 2 + 32);
    out.push_str("-----BEGIN ");
    out.push_str(label);
    out.push_str("-----\n");
    for chunk in body.as_bytes().chunks(line) {
        // base64 是 ASCII，切出来的必然是合法 UTF-8
        out.push_str(std::str::from_utf8(chunk).expect("base64 一定是 ASCII"));
        out.push('\n');
    }
    out.push_str("-----END ");
    out.push_str(label);
    out.push_str("-----\n");
    out
}

/// 一把 SSH 密钥：类型标识 + 公钥 blob + 私钥段里的算法字段。
///
/// 私钥段的结构是
/// `checkint1 ‖ checkint2 ‖ string(类型) ‖ 算法字段 ‖ string(注释)`，
/// 所以这里只把「算法字段」交给它，各算法自己拼。
pub struct SshKey {
    /// 密钥类型标识：`ssh-ed25519` / `ecdsa-sha2-nistp256` / `ssh-rsa`。
    pub key_type: &'static str,
    /// 公钥 blob（authorized_keys 那一行 base64 的内容）。
    public_blob: Vec<u8>,
    /// 私钥段里「类型标识之后、注释之前」的那一串。
    private_fields: Vec<u8>,
}

impl SshKey {
    pub fn new(
        key_type: &'static str,
        public_blob: Vec<u8>,
        private_fields: Vec<u8>,
    ) -> Self {
        Self {
            key_type,
            public_blob,
            private_fields,
        }
    }

    /// 公钥 blob。
    pub fn public_blob(&self) -> &[u8] {
        &self.public_blob
    }

    /// authorized_keys 的一行：`ssh-ed25519 <base64>[ comment]`。
    pub fn public_line(&self, comment: &str) -> String {
        let blob = B64.encode(self.public_blob());
        if comment.is_empty() {
            format!("{} {blob}", self.key_type)
        } else {
            format!("{} {blob} {comment}", self.key_type)
        }
    }

    /// OpenSSH 的 SHA256 指纹：`SHA256:<base64(摘要)>`，base64 不带补位。
    ///
    /// 与 `ssh-keygen -l -f` 的输出对得上。
    pub fn fingerprint(&self) -> String {
        let digest = Sha256::digest(self.public_blob());
        format!("SHA256:{}", B64_NO_PAD.encode(digest))
    }

    /// `openssh-key-v1` 私钥（`-----BEGIN OPENSSH PRIVATE KEY-----`）。
    ///
    /// `passphrase` 为 `None` 或空串时按「不加密」处理。
    pub fn private_pem(
        &self,
        passphrase: Option<&str>,
        comment: &str,
    ) -> Result<String, ToolError> {
        let passphrase = passphrase.filter(|p| !p.is_empty());

        // 私钥段
        let mut section = SshBuf::new();
        // 两个相同的随机数：解出来对不上就说明口令/密钥不对
        let check = random_u32();
        section.put_u32(check);
        section.put_u32(check);
        section.put_str(self.key_type);
        section.put_raw(&self.private_fields);
        section.put_str(comment);
        let mut body = section.into_vec();

        let (ciphername, kdfname, kdfoptions) = match passphrase {
            Some(pw) => {
                let mut salt = [0u8; BCRYPT_SALT_LEN];
                rand::rng().fill_bytes(&mut salt);

                // bcrypt-pbkdf 派生 48 字节：前 32 是 AES-256 密钥，后 16 是 IV
                let mut derived = [0u8; AES256_KEY_LEN + AES256_IV_LEN];
                bcrypt_pbkdf::bcrypt_pbkdf(pw.as_bytes(), &salt, BCRYPT_ROUNDS, &mut derived)
                    .map_err(|e| ToolError::Internal(format!("bcrypt-pbkdf 派生失败: {e}")))?;
                let (key_bytes, iv) = derived.split_at(AES256_KEY_LEN);

                // 填充到分组长度再加密
                pad_to_block(&mut body, BLOCK_AES_CTR);
                body = aes256_ctr(key_bytes, iv, &body)?;

                let mut kdf = SshBuf::new();
                kdf.put_bytes(&salt);
                kdf.put_u32(BCRYPT_ROUNDS);

                ("aes256-ctr", "bcrypt", kdf.into_vec())
            }
            None => {
                // "none" 加密器的分组长度按 OpenSSH 的约定是 8
                pad_to_block(&mut body, BLOCK_NONE);
                ("none", "none", Vec::new())
            }
        };

        let mut outer = SshBuf::new();
        outer.put_raw(OPENSSH_MAGIC);
        outer.put_str(ciphername);
        outer.put_str(kdfname);
        outer.put_bytes(&kdfoptions);
        outer.put_u32(1);
        outer.put_bytes(&self.public_blob);
        outer.put_bytes(&body);

        Ok(pem_block(
            "OPENSSH PRIVATE KEY",
            &outer.into_vec(),
            PEM_LINE_OPENSSH,
        ))
    }
}

/// `OPENSSH PUBLIC KEY`：只有公钥那一半的 openssh-key-v1 外壳。
///
/// sshpk 的公钥 `toString('openssh')` 就是这个形状；OpenSSH 自己不写这种文件，
/// 但 sshpk 能读回去。
pub fn openssh_public_pem(public_blob: &[u8]) -> String {
    let mut b = SshBuf::new();
    b.put_raw(OPENSSH_MAGIC);
    b.put_str("none");
    b.put_str("none");
    b.put_bytes(&[]); // kdfoptions
    b.put_u32(1); // nkeys
    b.put_bytes(public_blob);
    pem_block("OPENSSH PUBLIC KEY", &b.into_vec(), PEM_LINE_OPENSSH)
}

/// 私钥段末尾的填充：字节依次是 1、2、3…，直到长度是分组长度的整数倍。
fn pad_to_block(buf: &mut Vec<u8>, block: usize) {
    let mut i = 1u8;
    while buf.len() % block != 0 {
        buf.push(i);
        i = i.wrapping_add(1);
    }
}

/// 4 字节随机数。
fn random_u32() -> u32 {
    let mut b = [0u8; 4];
    rand::rng().fill_bytes(&mut b);
    u32::from_be_bytes(b)
}

/// AES-256-CTR：拿 ECB 加密一个递增的计数器当密钥流。
///
/// 自己写而不是引 `ctr` crate：CTR 就是「计数器 + ECB」，二十来行；
/// 而 `ctr` crate 的版本要和 `cipher` 对上（`aes 0.9` 配 `cipher 0.5`，
/// `ctr 0.10` 也是 `cipher 0.5`，但 `ctr 0.9` 是 `cipher 0.4`），
/// 自己写少一层版本耦合。
///
/// 计数器按 128 位大端递增 —— OpenSSL 的 `aes-256-ctr` 与 OpenSSH 的
/// `aes256-ctr` 都是这个口径。
pub fn aes256_ctr(key: &[u8], iv: &[u8], data: &[u8]) -> Result<Vec<u8>, ToolError> {
    if key.len() != AES256_KEY_LEN || iv.len() != AES256_IV_LEN {
        return Err(ToolError::Internal("内部错误：CTR 的密钥/IV 长度不对".into()));
    }
    let cipher = aes::Aes256::new_from_slice(key)
        .map_err(|_| ToolError::Internal("内部错误：AES-256 密钥长度不对".into()))?;

    let mut counter = [0u8; AES256_IV_LEN];
    counter.copy_from_slice(iv);

    let mut out = Vec::with_capacity(data.len());
    for chunk in data.chunks(16) {
        let mut keystream = aes::cipher::Block::<aes::Aes256>::default();
        keystream.copy_from_slice(&counter);
        cipher.encrypt_block(&mut keystream);
        for (b, k) in chunk.iter().zip(keystream.iter()) {
            out.push(b ^ k);
        }
        // 计数器 +1（大端，128 位回绕）
        for byte in counter.iter_mut().rev() {
            let (v, carry) = byte.overflowing_add(1);
            *byte = v;
            if !carry {
                break;
            }
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn read_string(buf: &[u8], pos: &mut usize) -> Vec<u8> {
        let len = u32::from_be_bytes(buf[*pos..*pos + 4].try_into().unwrap()) as usize;
        *pos += 4;
        let out = buf[*pos..*pos + len].to_vec();
        *pos += len;
        out
    }

    /// 拆开一个 openssh-key-v1 的 PEM 正文。
    pub(crate) struct Parsed {
        pub cipher: Vec<u8>,
        pub kdf: Vec<u8>,
        pub kdfopts: Vec<u8>,
        pub public_blob: Vec<u8>,
        /// 私钥段；`OPENSSH PUBLIC KEY` 那种只有公钥的文件里没有这一段。
        pub section: Option<Vec<u8>>,
    }

    pub(crate) fn parse_openssh(pem: &str) -> Parsed {
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
        Parsed {
            cipher,
            kdf,
            kdfopts,
            public_blob,
            section,
        }
    }

    /// 一把假的 ed25519 密钥：公钥 32 字节随便填，私钥字段同理。
    fn fake_key() -> SshKey {
        let pubkey = [7u8; 32];
        let mut public_blob = SshBuf::new();
        public_blob.put_str("ssh-ed25519");
        public_blob.put_bytes(&pubkey);

        let mut private_fields = SshBuf::new();
        private_fields.put_bytes(&pubkey);
        private_fields.put_bytes(&[9u8; 64]);

        SshKey::new("ssh-ed25519", public_blob.into_vec(), private_fields.into_vec())
    }

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

        // 前导零必须去掉：mpint 不允许有多余的前导零字节
        let mut b = SshBuf::new();
        b.put_mpint(&[0x00, 0x00, 0x7f]);
        let buf = b.into_vec();
        assert_eq!(&buf[4..], &[0x7f]);

        // 全零 = 0 = 空串
        let mut b = SshBuf::new();
        b.put_mpint(&[0x00, 0x00]);
        let buf = b.into_vec();
        assert_eq!(&buf[4..], &[] as &[u8]);
    }

    #[test]
    fn unencrypted_private_key_pads_to_eight_bytes() {
        let pem = fake_key().private_pem(None, "note").unwrap();
        let parsed = parse_openssh(&pem);
        assert_eq!(parsed.cipher, b"none");
        assert_eq!(parsed.kdf, b"none");
        assert!(parsed.kdfopts.is_empty());

        let section = parsed.section.expect("私钥文件该有私钥段");
        assert_eq!(section.len() % BLOCK_NONE, 0);
    }

    #[test]
    fn encrypted_private_key_pads_to_sixteen_bytes() {
        let pem = fake_key().private_pem(Some("secret"), "note").unwrap();
        let parsed = parse_openssh(&pem);
        assert_eq!(parsed.cipher, b"aes256-ctr");
        assert_eq!(parsed.kdf, b"bcrypt");

        let section = parsed.section.expect("私钥文件该有私钥段");
        // aes256-ctr 的分组长度是 16，不是 8 —— 填成 8 的话 ssh-keygen 读不出来
        assert_eq!(section.len() % BLOCK_AES_CTR, 0);

        // kdfoptions = string(salt) + uint32(rounds)
        let mut pos = 0;
        let salt = read_string(&parsed.kdfopts, &mut pos);
        assert_eq!(salt.len(), BCRYPT_SALT_LEN);
        assert_eq!(
            u32::from_be_bytes(parsed.kdfopts[pos..pos + 4].try_into().unwrap()),
            BCRYPT_ROUNDS
        );
    }

    #[test]
    fn the_two_check_ints_are_equal() {
        let pem = fake_key().private_pem(None, "note").unwrap();
        let section = parse_openssh(&pem).section.expect("该有私钥段");
        let c1 = u32::from_be_bytes(section[0..4].try_into().unwrap());
        let c2 = u32::from_be_bytes(section[4..8].try_into().unwrap());
        assert_eq!(c1, c2);
    }

    #[test]
    fn public_line_and_fingerprint_have_the_expected_shape() {
        let key = fake_key();
        let line = key.public_line("me@example.com");
        let mut parts = line.split(' ');
        assert_eq!(parts.next(), Some("ssh-ed25519"));
        let blob = B64.decode(parts.next().unwrap()).unwrap();
        assert_eq!(blob, key.public_blob());
        assert_eq!(parts.next(), Some("me@example.com"));
        assert_eq!(parts.next(), None);

        // 没有注释时不能多一个空格
        let line = key.public_line("");
        assert_eq!(line.split(' ').count(), 2);

        // 指纹是 base64(SHA256(blob))，不带补位
        let fp = key.fingerprint();
        assert!(fp.starts_with("SHA256:"), "{fp}");
        assert!(!fp.contains('='), "指纹的 base64 不带补位: {fp}");
    }

    /// CTR 是自写的，拿已知向量验一遍：NIST SP 800-38A 的 AES-256-CTR 用例。
    #[test]
    fn aes256_ctr_matches_the_nist_vector() {
        // NIST SP 800-38A F.5.5 CTR-AES256.Encrypt
        let key =
            hex::decode("603deb1015ca71be2b73aef0857d77811f352c073b6108d72d9810a30914dff4")
                .unwrap();
        let iv = hex::decode("f0f1f2f3f4f5f6f7f8f9fafbfcfdfeff").unwrap();
        let plain = hex::decode(
            "6bc1bee22e409f96e93d7e117393172a\
             ae2d8a571e03ac9c9eb76fac45af8e51\
             30c81c46a35ce411e5fbc1191a0a52ef\
             f69f2445df4f9b17ad2b417be66c3710",
        )
        .unwrap();
        let expect = hex::decode(
            "601ec313775789a5b7a7f504bbf3d228\
             f443e3ca4d62b59aca84e990cacaf5c5\
             2b0930daa23de94ce87017ba2d84988d\
             dfc9c58db67aada613c2dd08457941a6",
        )
        .unwrap();
        assert_eq!(aes256_ctr(&key, &iv, &plain).unwrap(), expect);
    }
}
