//! SSH 密钥对生成器（上游 PR #1873）。
//!
//! 生成一把能直接用的 SSH 密钥对：
//!
//! - **私钥**：`openssh-key-v1` 容器（`-----BEGIN OPENSSH PRIVATE KEY-----`），
//!   就是 `ssh-keygen -t ed25519` 写出来的那种文件。可选口令加密
//!   （`bcrypt-pbkdf` + `aes256-ctr`，OpenSSH 自己的方案）。
//! - **公钥**：authorized_keys 那一行（`ssh-ed25519 AAAA… comment`）。
//! - **指纹**：`SHA256:…`，与 `ssh-keygen -l` 的输出一致。
//!
//! ## 跟上游 PR #1873 的三处不同
//!
//! 1. **上游的 RSA 私钥是 PKCS#8 PEM，界面却写着「OpenSSH format」。**
//!    PKCS#8 的 PEM 能被 `openssl` 读，但 **`ssh` 读不了** —— `ssh` 只认
//!    `openssh-key-v1` 容器。这里 RSA 也给真正的 OpenSSH 私钥，外加一份
//!    PKCS#8 供 `openssl` 用。
//! 2. **上游把 Ed25519 的密钥生成放在浏览器的 WebCrypto 里**，RSA 放在
//!    node-forge 里，两条链路各写一遍线格式。这里统一在服务端：密钥生成、
//!    线格式、指纹全在一处，`ssh_key.rs` 里的编码器还被 RSA 密钥工具
//!    （上游 PR #888 的 `ssh` / `openssh` 两档）复用。
//! 3. **上游没有口令**。这里支持 —— OpenSSH 的私钥默认是加密的，
//!    一把明文私钥躺在剪贴板里的风险和「用户忘了加密」一样大。
//!
//! 另外补了 **ECDSA P-256**：有些服务器只收 ECDSA，而 Ed25519 又太新。
//!
//! ## 安全边界
//!
//! 私钥在**服务端**生成：它短暂地存在于本进程的堆上，随后经 HTTP 响应体
//! 发往浏览器。这条链路上它就是明文，只受 TLS 保护。服务端不做任何补救，
//! 也不该做 —— 与 [`super::rsa_key_pair_generator`] 同一个口径。
//! 私钥**绝不落盘、不进缓存、不进日志、不进错误信息**。
//!
//! 口令只在这一次请求的内存里活着：它不进响应、不进日志、不进错误信息。

use ed25519_dalek::SigningKey;
use p256::ecdsa::SigningKey as EcdsaSigningKey;
use p256::FieldBytes;
use rand::Rng;
use rsa::pkcs8::EncodePrivateKey;
use rsa::traits::{PrivateKeyParts, PublicKeyParts};
use rsa::RsaPrivateKey;
use serde_json::{json, Map, Value};

use super::rsa_formats::part_bytes;
use super::ssh_key::{SshBuf, SshKey};
use super::{util, ToolError, ToolResult};

/// 支持的密钥算法。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Algorithm {
    Ed25519,
    EcdsaP256,
    Rsa2048,
    Rsa3072,
    Rsa4096,
}

impl Algorithm {
    /// 从注册表下拉框的值解析。认不出来返回 `None` ——
    /// 下拉框的值是外部输入，不该由它决定「用哪个算法」。
    pub fn from_value(value: &str) -> Option<Self> {
        Some(match value {
            "ed25519" => Algorithm::Ed25519,
            "ecdsa-p256" => Algorithm::EcdsaP256,
            "rsa2048" => Algorithm::Rsa2048,
            "rsa3072" => Algorithm::Rsa3072,
            "rsa4096" => Algorithm::Rsa4096,
            _ => return None,
        })
    }

    /// 给人看的算法名。
    pub fn label(self) -> &'static str {
        match self {
            Algorithm::Ed25519 => "Ed25519",
            Algorithm::EcdsaP256 => "ECDSA P-256",
            Algorithm::Rsa2048 => "RSA 2048",
            Algorithm::Rsa3072 => "RSA 3072",
            Algorithm::Rsa4096 => "RSA 4096",
        }
    }

    /// SSH 线格式里的密钥类型标识。
    pub fn key_type(self) -> &'static str {
        match self {
            Algorithm::Ed25519 => "ssh-ed25519",
            Algorithm::EcdsaP256 => "ecdsa-sha2-nistp256",
            _ => "ssh-rsa",
        }
    }

    /// `ssh-keygen` 默认的私钥文件名（`id_ed25519` / `id_ecdsa` / `id_rsa`）。
    ///
    /// 结果区里那段说明要告诉用户「存成哪个文件」，而文件名是跟着算法走的 ——
    /// 所以它从算法算出来，不写死在文案里。
    pub fn key_file(self) -> &'static str {
        match self {
            Algorithm::Ed25519 => "id_ed25519",
            Algorithm::EcdsaP256 => "id_ecdsa",
            _ => "id_rsa",
        }
    }
}

/// 支持的算法名 —— 错误信息与 [`Algorithm::from_value`] 的白名单共用一份。
const ALLOWED_HINT: &str = "ed25519 / ecdsa-p256 / rsa2048 / rsa3072 / rsa4096";

/// 与注册表 `ApiSpec.fields` 保持一致。
pub async fn handle(payload: Value) -> ToolResult {
    // RSA 密钥生成是纯 CPU 且耗时随位长爆炸（4096 位要好几秒），
    // 丢到 blocking 线程池，别占住 actix 的 worker。
    super::util::blocking(move || compute(payload)).await
}

fn compute(payload: Value) -> ToolResult {
    let alg_name = util::str_or(&payload, "algorithm", "ed25519");
    let alg = Algorithm::from_value(alg_name).ok_or_else(|| {
        // 文案在语言包里（`out.ssh-key-pair-generator.err.unknown_algorithm`）。
        // 用户填的算法名原样回显 —— 它不是秘密，回显能让人一眼看出选错了哪一档。
        ToolError::invalid(
            "out.ssh-key-pair-generator.err.unknown_algorithm",
            &[("algorithm", alg_name), ("allowed", ALLOWED_HINT)],
        )
    })?;

    let comment = util::opt_str(&payload, "comment")
        .map(str::trim)
        .filter(|c| !c.is_empty())
        .unwrap_or("it-tools")
        .to_string();

    let passphrase = util::opt_str(&payload, "passphrase").filter(|p| !p.is_empty());

    let generated = generate(alg)?;

    let private_key = generated
        .ssh_key
        .private_pem(passphrase.as_deref(), &comment)?;

    // 结果区里**给人看的字**走语言包（行标题、成句的值、那段说明）；
    // 机器可读的值（公钥行、指纹、算法名、密钥类型、PEM）原样保留。
    let lang = util::lang(&payload);
    let mut table = Map::new();
    util::row(
        &mut table,
        &payload,
        "out.ssh-key-pair-generator.public_key",
        json!(generated.ssh_key.public_line(&comment)),
    );
    util::row(
        &mut table,
        &payload,
        "out.ssh-key-pair-generator.fingerprint",
        json!(generated.ssh_key.fingerprint()),
    );
    util::row(
        &mut table,
        &payload,
        "out.ssh-key-pair-generator.algorithm",
        json!(alg.label()),
    );
    util::row(
        &mut table,
        &payload,
        "out.ssh-key-pair-generator.key_type",
        json!(generated.ssh_key.key_type),
    );
    util::row(
        &mut table,
        &payload,
        "out.ssh-key-pair-generator.comment",
        json!(comment),
    );
    let protection = if passphrase.is_some() {
        crate::i18n::t(lang, "out.ssh-key-pair-generator.passphrase_encrypted")
    } else {
        crate::i18n::t(lang, "out.ssh-key-pair-generator.passphrase_unencrypted")
    };
    util::row(
        &mut table,
        &payload,
        "out.ssh-key-pair-generator.passphrase_protection",
        json!(protection),
    );
    if let Some(pem) = &generated.pkcs8_pem {
        util::row(
            &mut table,
            &payload,
            "out.ssh-key-pair-generator.pkcs8",
            json!(pem),
        );
    }
    // 那段说明里提到私钥该存成哪个文件 —— 那是跟着算法走的，
    // 所以语言包里留个 `{key_file}` 占位，两种语言可以各自决定语序。
    //
    // **行标题是短词，说明本身是值** —— 表格的标题列宽度是固定的，
    // 把一整句话塞进标题列，表格会被撑到卡片外面去（值列被挤没）。
    let notes = crate::i18n::t(lang, "out.ssh-key-pair-generator.notes")
        .replace("{key_file}", alg.key_file());
    util::row(
        &mut table,
        &payload,
        "out.ssh-key-pair-generator.usage",
        json!(notes),
    );

    Ok(json!({
        "output": private_key,
        "table": table,
    }))
}

/// 生成出来的密钥对。
struct Generated {
    /// 线格式那一半（公钥 blob 与私钥段）。
    ssh_key: SshKey,
    /// 额外的 PKCS#8 私钥 PEM —— 有的人要拿去喂 `openssl`。
    pkcs8_pem: Option<String>,
}

/// 按算法生成密钥对。
fn generate(alg: Algorithm) -> Result<Generated, ToolError> {
    match alg {
        Algorithm::Ed25519 => gen_ed25519(alg),
        Algorithm::EcdsaP256 => gen_ecdsa_p256(alg),
        Algorithm::Rsa2048 | Algorithm::Rsa3072 | Algorithm::Rsa4096 => {
            gen_rsa(alg, bits_of(alg))
        }
    }
}

fn bits_of(alg: Algorithm) -> usize {
    match alg {
        Algorithm::Rsa2048 => 2048,
        Algorithm::Rsa3072 => 3072,
        Algorithm::Rsa4096 => 4096,
        _ => unreachable!("只有 RSA 会走到这里"),
    }
}

/// Ed25519。
///
/// OpenSSH 的 ed25519 私钥段里那个 64 字节的「秘密」是 **种子 ‖ 公钥**，
/// 不是公钥重复两遍 —— 写错了 `ssh-keygen -y` 会算出不一样的公钥。
fn gen_ed25519(alg: Algorithm) -> Result<Generated, ToolError> {
    let mut seed = [0u8; 32];
    rand::rng().fill_bytes(&mut seed);
    let signing = SigningKey::from_bytes(&seed);
    let pubkey = signing.verifying_key().to_bytes();

    let mut secret = Vec::with_capacity(64);
    secret.extend_from_slice(&seed);
    secret.extend_from_slice(&pubkey);

    let mut public_blob = SshBuf::new();
    public_blob.put_str(alg.key_type());
    public_blob.put_bytes(&pubkey);

    let mut private_fields = SshBuf::new();
    private_fields.put_bytes(&pubkey);
    private_fields.put_bytes(&secret);

    Ok(Generated {
        ssh_key: SshKey::new(alg.key_type(), public_blob.into_vec(), private_fields.into_vec()),
        pkcs8_pem: Some(ed25519_pkcs8_pem(&seed)),
    })
}

/// ECDSA P-256（RFC 5656）。
///
/// 公钥 blob 是 `string("ecdsa-sha2-nistp256") + string("nistp256") + string(Q)`，
/// Q 是**未压缩**的曲线点（`0x04 ‖ X ‖ Y`，65 字节）。
///
/// 私钥段里的私钥标量按 **`mpint`** 写（RFC 5656 §3.1）——不是定长 32 字节。
/// 写错这一处 `ssh-keygen` 会解不出私钥。
fn gen_ecdsa_p256(alg: Algorithm) -> Result<Generated, ToolError> {
    // `ecdsa 0.17` 的 `SigningKey::random` 已经标了 deprecated（它让位给
    // `elliptic_curve::Generate` trait，而那个 trait 要另开 feature），
    // 与其为一个弃用 API 去改依赖的特性开关，不如自己抽 32 字节再喂给
    // `from_bytes`：P-256 的阶 n 离 2^256 只差 2^-32，所以抽到非法标量的概率约
    // 4 亿分之一 —— 循环重抽即可，实际上永远一次就成。
    let mut raw = [0u8; 32];
    let signing = loop {
        rand::rng().fill_bytes(&mut raw);
        if let Ok(sk) = EcdsaSigningKey::from_bytes(&FieldBytes::from(raw)) {
            break sk;
        }
    };
    let verifying = signing.verifying_key();

    // 未压缩点：0x04 ‖ X(32) ‖ Y(32)
    let point = verifying.to_sec1_point(false);
    let q = point.as_bytes();

    let mut public_blob = SshBuf::new();
    public_blob.put_str(alg.key_type());
    public_blob.put_str("nistp256");
    public_blob.put_bytes(q);

    let mut private_fields = SshBuf::new();
    private_fields.put_str("nistp256");
    private_fields.put_bytes(q);
    // 私钥标量：定长 32 字节的大端，交给 mpint 去掉前导零
    private_fields.put_mpint(&signing.to_bytes());

    Ok(Generated {
        ssh_key: SshKey::new(
            alg.key_type(),
            public_blob.into_vec(),
            private_fields.into_vec(),
        ),
        pkcs8_pem: Some(ecdsa_p256_pkcs8_pem(&signing.to_bytes(), q)),
    })
}

/// RSA。
///
/// OpenSSH 的 RSA 私钥段是 `n ‖ e ‖ d ‖ iqmp ‖ p ‖ q` 六个 `mpint`，
/// 公钥 blob 是 `e ‖ n`（顺序是反的！）。
fn gen_rsa(alg: Algorithm, bits: usize) -> Result<Generated, ToolError> {
    let mut key = RsaPrivateKey::new(&mut rand::rng(), bits)
        .map_err(|e| ToolError::Internal(format!("生成 {bits} 位 RSA 密钥失败: {e}")))?;
    // `crt_coefficient()`（iqmp）要 precompute 之后才有值
    key.precompute()
        .map_err(|e| ToolError::Internal(format!("RSA 预计算失败: {e}")))?;

    let public = key.to_public_key();

    let mut public_blob = SshBuf::new();
    public_blob.put_str(alg.key_type());
    public_blob.put_mpint(&part_bytes(public.e()));
    public_blob.put_mpint(&part_bytes(public.n()));

    let mut private_fields = SshBuf::new();
    private_fields.put_mpint(&part_bytes(key.n()));
    private_fields.put_mpint(&part_bytes(key.e()));
    private_fields.put_mpint(&part_bytes(key.d()));
    private_fields.put_mpint(&iqmp(&key));
    private_fields.put_mpint(&part_bytes(&key.primes()[0]));
    private_fields.put_mpint(&part_bytes(&key.primes()[1]));

    let pkcs8 = key
        .to_pkcs8_pem(rsa::pkcs8::LineEnding::LF)
        .map(|s| s.to_string())
        .map_err(|e| ToolError::Internal(format!("PKCS#8 私钥编码失败: {e}")))?;

    Ok(Generated {
        ssh_key: SshKey::new(alg.key_type(), public_blob.into_vec(), private_fields.into_vec()),
        pkcs8_pem: Some(pkcs8),
    })
}

/// `iqmp` = q⁻¹ mod p（CRT 系数），直接写成 SSH 的 `mpint` 字节。
///
/// rsa 0.10 的 `crt_coefficient()` 返回 `Option<BoxedUint>`（值，不是引用）；
/// 算不出来时给空字节串 —— 0 的 mpint 就是空串。
fn iqmp(key: &RsaPrivateKey) -> Vec<u8> {
    match key.crt_coefficient() {
        Some(c) => part_bytes(&c),
        None => Vec::new(),
    }
}

/// Ed25519 的 PKCS#8 PEM。
///
/// Ed25519 的 PKCS#8 结构是**固定 48 字节**，没有变长的地方，所以手写 DER
/// 比引 `pkcs8` crate 还省事：
///
/// ```text
/// SEQUENCE {
///   INTEGER 0
///   SEQUENCE { OID 1.3.101.112 }        ← id-Ed25519
///   OCTET STRING { OCTET STRING { 32 字节种子 } }
/// }
/// ```
fn ed25519_pkcs8_pem(seed: &[u8; 32]) -> String {
    let mut der = Vec::with_capacity(48);
    der.extend_from_slice(&[0x30, 0x2e]); // SEQUENCE, 46 字节
    der.extend_from_slice(&[0x02, 0x01, 0x00]); // INTEGER 0
    der.extend_from_slice(&[0x30, 0x05]); // SEQUENCE, 5 字节
    der.extend_from_slice(&[0x06, 0x03, 0x2b, 0x65, 0x70]); // OID 1.3.101.112
    der.extend_from_slice(&[0x04, 0x22]); // OCTET STRING, 34 字节
    der.extend_from_slice(&[0x04, 0x20]); // OCTET STRING, 32 字节
    der.extend_from_slice(seed);
    super::ssh_key::pem_block("PRIVATE KEY", &der, super::ssh_key::PEM_LINE_OPENSSL)
}

/// ECDSA P-256 的 PKCS#8 PEM。
///
/// PKCS#8 里装的是 SEC1 的 `ECPrivateKey`（RFC 5915）：
///
/// ```text
/// SEQUENCE {
///   INTEGER 1
///   OCTET STRING { 32 字节私钥标量 }
///   [0] { OID 1.2.840.10045.3.1.7 }    ← prime256v1
///   [1] { BIT STRING { 未压缩公钥点 } }
/// }
/// ```
fn ecdsa_p256_pkcs8_pem(scalar: &[u8], q: &[u8]) -> String {
    let mut der = Vec::with_capacity(121);
    der.extend_from_slice(&[0x30, 0x77]); // SEQUENCE, 119 字节
    der.extend_from_slice(&[0x02, 0x01, 0x01]); // INTEGER 1
    der.extend_from_slice(&[0x04, 0x20]); // OCTET STRING, 32 字节
    der.extend_from_slice(scalar);
    der.extend_from_slice(&[0xa0, 0x0a]); // [0] 显式标签, 10 字节
    der.extend_from_slice(&[0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07]);
    der.extend_from_slice(&[0xa1, 0x44]); // [1] 显式标签, 68 字节
    der.extend_from_slice(&[0x03, 0x42, 0x00]); // BIT STRING, 66 字节, 0 个无用比特
    der.extend_from_slice(q);
    super::ssh_key::pem_block("PRIVATE KEY", &der, super::ssh_key::PEM_LINE_OPENSSL)
}

#[cfg(test)]
mod tests {
    use super::*;
    // iqmp 的模乘断言用 num-bigint 写起来最顺（密钥分量本身是 crypto-bigint 的）
    use num_bigint::BigUint;

    /// 结果表的行标题是按语言包取的，断言时按同样的方式取标题 ——
    /// 把标题的字面量抄一遍的话，改一次文案就要改一次断言。
    fn label(key: &str) -> String {
        crate::i18n::t(crate::i18n::FALLBACK, key)
    }

    /// 解开 SSH 线格式的 `string`。
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

    /// 拆开一个 openssh-key-v1 的私钥 PEM。
    fn parse_openssh(pem: &str) -> (Vec<u8>, Vec<u8>, Vec<u8>) {
        use base64::engine::general_purpose::STANDARD as B64;
        use base64::Engine as _;
        let body: String = pem
            .lines()
            .filter(|l| !l.starts_with("-----"))
            .collect::<Vec<_>>()
            .join("");
        let buf = B64.decode(body).unwrap();
        assert_eq!(&buf[..15], b"openssh-key-v1\0");
        let mut pos = 15;
        let cipher = read_string(&buf, &mut pos);
        assert_eq!(cipher, b"none");
        let kdf = read_string(&buf, &mut pos);
        assert_eq!(kdf, b"none");
        assert!(read_string(&buf, &mut pos).is_empty());
        assert_eq!(u32::from_be_bytes(buf[pos..pos + 4].try_into().unwrap()), 1);
        pos += 4;
        let public_blob = read_string(&buf, &mut pos);
        let section = read_string(&buf, &mut pos);
        assert_eq!(pos, buf.len());
        (public_blob, section, cipher)
    }

    /// 私钥段：checkint ×2 ‖ string(类型) ‖ 算法字段 ‖ string(注释) ‖ 填充。
    fn split_section(section: &[u8]) -> (Vec<u8>, Vec<u8>, Vec<u8>) {
        let mut pos = 8;
        let kind = read_string(section, &mut pos);
        // 算法字段的长度要从「注释」的位置倒推，先把注释找出来
        // —— 这里用「剩下的都是算法字段 + 注释 + 填充」的方式不好切，
        // 所以调用方各自切，这里只给类型与剩余部分。
        let rest = section[pos..].to_vec();
        (kind, rest, Vec::new())
    }

    #[test]
    fn ed25519_private_key_has_the_openssh_shape() {
        let g = gen_ed25519(Algorithm::Ed25519).unwrap();
        let pem = g.ssh_key.private_pem(None, "me@host").unwrap();
        assert!(pem.starts_with("-----BEGIN OPENSSH PRIVATE KEY-----\n"));
        assert!(pem.trim_end().ends_with("-----END OPENSSH PRIVATE KEY-----"));

        let (public_blob, section, _) = parse_openssh(&pem);

        // 公钥 blob：string("ssh-ed25519") + string(32 字节公钥)
        let mut pos = 0;
        assert_eq!(read_string(&public_blob, &mut pos), b"ssh-ed25519");
        let pubkey = read_string(&public_blob, &mut pos);
        assert_eq!(pubkey.len(), 32);
        assert_eq!(pos, public_blob.len());

        // 私钥段：checkint ×2 ‖ "ssh-ed25519" ‖ pubkey ‖ secret(64) ‖ 注释
        let (kind, rest, _) = split_section(&section);
        assert_eq!(kind, b"ssh-ed25519");
        let mut pos = 0;
        let pub_in_priv = read_string(&rest, &mut pos);
        assert_eq!(pub_in_priv, pubkey, "私钥段里的公钥必须与公钥 blob 一致");
        let secret = read_string(&rest, &mut pos);
        assert_eq!(secret.len(), 64, "secret 必须是 种子 ‖ 公钥");
        assert_eq!(&secret[32..], &pubkey[..], "secret 的后 32 字节就是公钥");
        let comment = read_string(&rest, &mut pos);
        assert_eq!(comment, b"me@host");

        // "none" 加密器的分组长度是 8
        assert_eq!(section.len() % 8, 0);
    }

    #[test]
    fn ed25519_public_line_and_fingerprint_are_consistent() {
        let g = gen_ed25519(Algorithm::Ed25519).unwrap();
        let line = g.ssh_key.public_line("me@host");
        let mut parts = line.split(' ');
        assert_eq!(parts.next(), Some("ssh-ed25519"));
        use base64::engine::general_purpose::STANDARD as B64;
        use base64::Engine as _;
        let blob = B64.decode(parts.next().unwrap()).unwrap();
        assert_eq!(blob, g.ssh_key.public_blob());
        // 注释是第三段（没有注释时就没有第三段）
        assert_eq!(parts.next(), Some("me@host"));
        assert_eq!(parts.next(), None);
    }

    #[test]
    fn ecdsa_p256_private_key_has_the_openssh_shape() {
        let g = gen_ecdsa_p256(Algorithm::EcdsaP256).unwrap();
        let pem = g.ssh_key.private_pem(None, "c").unwrap();
        let (public_blob, section, _) = parse_openssh(&pem);

        let mut pos = 0;
        assert_eq!(read_string(&public_blob, &mut pos), b"ecdsa-sha2-nistp256");
        assert_eq!(read_string(&public_blob, &mut pos), b"nistp256");
        let q = read_string(&public_blob, &mut pos);
        assert_eq!(q.len(), 65, "Q 是未压缩点：0x04 ‖ X ‖ Y");
        assert_eq!(q[0], 0x04);
        assert_eq!(pos, public_blob.len());

        let (kind, rest, _) = split_section(&section);
        assert_eq!(kind, b"ecdsa-sha2-nistp256");
        let mut pos = 0;
        assert_eq!(read_string(&rest, &mut pos), b"nistp256");
        let q_in_priv = read_string(&rest, &mut pos);
        assert_eq!(q_in_priv, q);
        let d = read_mpint(&rest, &mut pos);
        assert!(!d.is_empty() && d.len() <= 32, "私钥标量是 mpint");
        // 标量只有 32 字节，去掉前导零之后只会更短
        assert!(d.len() <= 32);
    }

    #[test]
    fn rsa_private_key_has_the_openssh_shape() {
        let g = gen_rsa(Algorithm::Rsa2048, 2048).unwrap();
        let pem = g.ssh_key.private_pem(None, "r").unwrap();
        let (public_blob, section, _) = parse_openssh(&pem);

        // 公钥 blob 的顺序是 e 在前、n 在后
        let mut pos = 0;
        assert_eq!(read_string(&public_blob, &mut pos), b"ssh-rsa");
        let e = read_mpint(&public_blob, &mut pos);
        let n = read_mpint(&public_blob, &mut pos);
        assert_eq!(pos, public_blob.len());
        assert_eq!(e, vec![0x01, 0x00, 0x01]);

        let (kind, rest, _) = split_section(&section);
        assert_eq!(kind, b"ssh-rsa");
        let mut pos = 0;
        let n2 = read_mpint(&rest, &mut pos);
        let e2 = read_mpint(&rest, &mut pos);
        let d = read_mpint(&rest, &mut pos);
        let iqmp = read_mpint(&rest, &mut pos);
        let p = read_mpint(&rest, &mut pos);
        let q = read_mpint(&rest, &mut pos);
        assert_eq!(n2, n, "私钥段里的 n 必须与公钥 blob 一致");
        assert_eq!(e2, e);

        // iqmp 必须是 q 在模 p 下的逆元（模乘断言用 num-bigint 写最顺）
        let prod = (&BigUint::from_bytes_be(&iqmp) * &BigUint::from_bytes_be(&q))
            % &BigUint::from_bytes_be(&p);
        assert_eq!(prod, BigUint::from(1u32));
        assert!(!d.is_empty());
    }

    #[test]
    fn a_passphrase_produces_an_encrypted_openssh_private_key() {
        let g = gen_ed25519(Algorithm::Ed25519).unwrap();
        let pem = g.ssh_key.private_pem(Some("secret"), "c").unwrap();
        use base64::engine::general_purpose::STANDARD as B64;
        use base64::Engine as _;
        let body: String = pem
            .lines()
            .filter(|l| !l.starts_with("-----"))
            .collect::<Vec<_>>()
            .join("");
        let buf = B64.decode(body).unwrap();
        let mut pos = 15;
        assert_eq!(read_string(&buf, &mut pos), b"aes256-ctr");
        assert_eq!(read_string(&buf, &mut pos), b"bcrypt");
        // kdfoptions = string(salt16) + uint32(rounds)
        // （外层再套一层 string，所以容器里这一段是 4 + 24 字节）
        let kdfopts = read_string(&buf, &mut pos);
        let mut kpos = 0;
        let salt = read_string(&kdfopts, &mut kpos);
        assert_eq!(salt.len(), 16);
        assert_eq!(
            u32::from_be_bytes(kdfopts[kpos..kpos + 4].try_into().unwrap()),
            16
        );
        assert_eq!(kpos + 4, kdfopts.len());
        // 密钥个数
        assert_eq!(u32::from_be_bytes(buf[pos..pos + 4].try_into().unwrap()), 1);
        pos += 4;

        // **公钥 blob 在 openssh-key-v1 里是明文的** —— ssh-keygen 不问口令就能
        // 把它显示出来。所以「文件里不能出现 ssh-ed25519」这条断言是错的：
        // 要查的是**私钥段**有没有被加密。
        let public_blob = read_string(&buf, &mut pos);
        assert!(public_blob.windows(11).any(|w| w == b"ssh-ed25519"));
        let section = read_string(&buf, &mut pos);
        assert_eq!(pos, buf.len());

        // 私钥段是密文：里面不该有明文的类型标识
        assert!(!section.windows(11).any(|w| w == b"ssh-ed25519"));
        // 密文长度 = 明文（4+4+类型+字段+注释）补齐到 16 的倍数
        assert_eq!(section.len() % 16, 0);

        // 用口令把它解回来 —— checkint 必须一致，类型必须是 ssh-ed25519。
        // （这一段等价于 `ssh-keygen -y -P secret -f <file>` 做的事。）
        let mut derived = [0u8; 48];
        bcrypt_pbkdf::bcrypt_pbkdf(b"secret", &salt, 16, &mut derived).unwrap();
        let plain = crate::tools::ssh_key::aes256_ctr(&derived[..32], &derived[32..], &section).unwrap();
        assert_eq!(u32::from_be_bytes(plain[0..4].try_into().unwrap()),
                   u32::from_be_bytes(plain[4..8].try_into().unwrap()),
                   "checkint1 与 checkint2 必须相等");
        let mut ppos = 8;
        assert_eq!(read_string(&plain, &mut ppos), b"ssh-ed25519");
    }

    #[test]
    fn unknown_algorithms_are_rejected() {
        assert_eq!(Algorithm::from_value("ed25519"), Some(Algorithm::Ed25519));
        assert_eq!(Algorithm::from_value("rsa4096"), Some(Algorithm::Rsa4096));
        assert_eq!(Algorithm::from_value("dsa"), None);
        assert_eq!(Algorithm::from_value(""), None);
        let err = compute(json!({ "algorithm": "dsa" })).expect_err("未知算法必须报错");
        match &err {
            ToolError::InvalidKeyed { key, .. } => assert_eq!(
                *key,
                "out.ssh-key-pair-generator.err.unknown_algorithm"
            ),
            other => panic!("应当报 unknown_algorithm，实际 {other:?}"),
        }
    }

    /// 错误信息跟着请求语言走 —— 语言不是工具决定的，是 API 层按请求语言
    /// 调用 `localize` 渲染的。
    #[test]
    fn the_error_message_follows_the_requested_language() {
        let err = compute(json!({ "algorithm": "dsa" })).unwrap_err();
        // 语言包里还没并进来时，localize 退回键本身 —— 这时断言跳过
        if !crate::i18n::has("zh-CN", "out.ssh-key-pair-generator.err.unknown_algorithm") {
            return;
        }
        let en = err.localize("en");
        let zh = err.localize("zh-CN");
        assert_ne!(en, zh, "两种语言不该是同一句");
        assert!(
            !en.contains("out.ssh-key-pair-generator"),
            "英文界面不该露出键：{en}"
        );
    }

    #[test]
    fn the_response_carries_the_private_key_and_the_public_line() {
        let out = compute(json!({ "algorithm": "ed25519", "comment": "me@host" })).unwrap();
        assert!(out["output"]
            .as_str()
            .unwrap()
            .starts_with("-----BEGIN OPENSSH PRIVATE KEY-----"));
        let table = out["table"].as_object().unwrap();
        // 行的**标题**是按语言取出来的，所以断言要按语言包里的键去取标题，
        // 而不是把标题的字面量抄一遍 —— 抄一遍的话，改一次文案就要改一次断言。
        // 这里没带 __lang，走英文兜底。
        let public_key = label("out.ssh-key-pair-generator.public_key");
        let fingerprint = label("out.ssh-key-pair-generator.fingerprint");
        let comment = label("out.ssh-key-pair-generator.comment");
        assert!(table[&public_key].as_str().unwrap().starts_with("ssh-ed25519 "));
        assert!(table[&fingerprint].as_str().unwrap().starts_with("SHA256:"));
        assert_eq!(table[&comment], json!("me@host"));
    }

    /// 表格的标题要跟着请求语言走 —— 英文界面不该出现中文行标题。
    #[test]
    fn the_row_labels_follow_the_request_language() {
        let en = compute(json!({ "algorithm": "ed25519" })).unwrap();
        let zh = compute(json!({ "algorithm": "ed25519", "__lang": "zh-CN" })).unwrap();
        let en_table = en["table"].as_object().unwrap();
        let zh_table = zh["table"].as_object().unwrap();
        let key = "out.ssh-key-pair-generator.public_key";
        let en_label = crate::i18n::t("en", key);
        let zh_label = crate::i18n::t("zh-CN", key);

        assert!(en_table.contains_key(&en_label), "{en_table:?}");
        assert!(zh_table.contains_key(&zh_label), "{zh_table:?}");

        // 两种语言的标题确实不一样 —— 不然上面两条断言等于什么都没验。
        // 语言包还没并进来时，两边都退回键本身（键还没进语言包，分不出语言），
        // 这时先跳过这条；并进来之后它一定会跑。
        if crate::i18n::has("en", key) && crate::i18n::has("zh-CN", key) {
            assert_ne!(en_label, zh_label);
            assert!(!zh_table.contains_key(&en_label), "{zh_table:?}");
            assert!(!en_table.contains_key(&zh_label), "{en_table:?}");
        }
    }

    /// 那段说明里的私钥文件名要跟着算法走 —— RSA 的私钥不该被叫做 id_ed25519。
    #[test]
    fn the_notes_name_the_right_private_key_file() {
        // 说明是**值**，行标题是那个短词（"Usage" / "用法"）。
        let row = label("out.ssh-key-pair-generator.usage");
        let key = "out.ssh-key-pair-generator.notes";
        for (alg, file) in [
            ("ed25519", "id_ed25519"),
            ("ecdsa-p256", "id_ecdsa"),
            ("rsa2048", "id_rsa"),
        ] {
            let out = compute(json!({ "algorithm": alg })).unwrap();
            let table = out["table"].as_object().unwrap();
            let notes = table[&row].as_str().unwrap();
            // 占位符一定被换掉了
            assert!(!notes.contains("{key_file}"), "{alg}: {notes}");
            // 语言包里那段说明还没并进来时，取到的就是键本身，验不了文件名；
            // 并进来之后下面这条才会真的跑。
            if crate::i18n::has("en", key) {
                assert!(notes.contains(file), "{alg}: {notes}");
            }
        }
    }

    /// 行的**标题**必须短 —— 表格的标题列是固定宽度的，
    /// 把一整句话塞进标题列，表格会被撑到卡片外面去，
    /// 值列被挤成一条竖线（一个字符一行，还多一条横向滚动条）。
    #[test]
    fn the_row_labels_are_short() {
        let out = compute(json!({ "algorithm": "ed25519" })).unwrap();
        let table = out["table"].as_object().unwrap();
        for (k, _) in table {
            assert!(k.chars().count() <= 40, "行标题太长，会把表格撑破: {k}");
        }
    }

    /// Ed25519 的 PKCS#8 DER 是固定的 48 字节，结构也要对。
    #[test]
    fn ed25519_pkcs8_der_has_the_expected_structure() {
        let pem = ed25519_pkcs8_pem(&[0u8; 32]);
        use base64::engine::general_purpose::STANDARD as B64;
        use base64::Engine as _;
        let body: String = pem
            .lines()
            .filter(|l| !l.starts_with("-----"))
            .collect::<Vec<_>>()
            .join("");
        let der = B64.decode(body).unwrap();
        assert_eq!(der.len(), 48);
        assert_eq!(der[0], 0x30);
        assert_eq!(der[1], 0x2e);
        // 结构：SEQUENCE(46) { INTEGER 0, SEQUENCE(5){ OID }, OCTET STRING(34){ OCTET STRING(32) } }
        // OID 1.3.101.112 = id-Ed25519，在 der[7..12]
        assert_eq!(&der[7..12], &[0x06, 0x03, 0x2b, 0x65, 0x70]);
    }

    /// 把生成的私钥写到磁盘，供 `ssh-keygen` 做**外部对拍**。
    ///
    /// 单元测试只能验证「我写的东西符合我自己理解的结构」，
    /// 真正的判据是 **`ssh-keygen -y -f <file>` 能读出同一个公钥**。
    /// 这个测试默认跳过；跑法：
    ///
    /// ```sh
    /// IT_TOOLS_SSH_DUMP=/tmp/sshcheck cargo test --offline \
    ///     dump_keys_for_ssh_keygen -- --ignored --nocapture
    /// ```
    #[test]
    #[ignore = "需要外部的 ssh-keygen 对拍"]
    fn dump_keys_for_ssh_keygen() {
        let dir = std::env::var("IT_TOOLS_SSH_DUMP").expect("设置 IT_TOOLS_SSH_DUMP");
        std::fs::create_dir_all(&dir).unwrap();

        let cases: Vec<(&str, Algorithm, Option<&str>)> = vec![
            ("ed25519", Algorithm::Ed25519, None),
            ("ecdsa", Algorithm::EcdsaP256, None),
            ("rsa2048", Algorithm::Rsa2048, None),
            ("ed25519-enc", Algorithm::Ed25519, Some("hunter2")),
            ("ecdsa-enc", Algorithm::EcdsaP256, Some("hunter2")),
            ("rsa2048-enc", Algorithm::Rsa2048, Some("hunter2")),
        ];

        for (name, alg, passphrase) in cases {
            let g = generate(alg).unwrap();
            let pem = g
                .ssh_key
                .private_pem(passphrase, "it-tools@example")
                .unwrap();
            let path = format!("{dir}/id_{name}");
            std::fs::write(&path, pem).unwrap();
            std::fs::write(
                format!("{dir}/id_{name}.pub"),
                format!("{}\n", g.ssh_key.public_line("it-tools@example")),
            )
            .unwrap();
            std::fs::write(
                format!("{dir}/id_{name}.fp"),
                format!("{}\n", g.ssh_key.fingerprint()),
            )
            .unwrap();
        }
    }
}
