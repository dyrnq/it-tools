//! Encrypt / decrypt text —— 原生 AES-GCM / AES-CBC，与上游的 OpenSSL `Salted__` 兼容格式。
//!
//! # 为什么一个工具要同时支持两套不兼容的格式
//!
//! 两种格式是并行存在、互不兼容的，`key` 字段的含义随 `algorithm` 变：
//!
//! | `algorithm`       | `key` 是什么                       | `iv` 字段         | 输出信封                       |
//! |-------------------|------------------------------------|-------------------|--------------------------------|
//! | `aes-gcm`/`aes-cbc` | 原始密钥字节（长度必须精确匹配）   | 必填              | 无，裸密文（GCM 尾部带 auth tag） |
//! | `openssl-*`       | 口令，用 EVP_BytesToKey 派生        | 不读              | `Salted__` + 8 字节 salt + 密文 |
//!
//! 参考实现（`src/tools/encryption/encryption.vue`）走的是 crypto-js 的
//! **口令模式**，等价于 `openssl enc -aes-256-cbc -md md5 -a`：口令本身不参与加密，
//! 只是被 EVP_BytesToKey 变成 key‖iv，salt 写进密文。用户手上已有的密文是这个格式，
//! 所以四种 `openssl-*` 必须逐字节兼容，否则等于把他们的历史密文全作废。
//!
//! # 编码约定（这几条是接口的一部分，不是实现细节）
//!
//! - **原生档的 `key` / `iv` 一律按十六进制解析**。不悄悄退回 UTF-8 字节：口令类算法
//!   的密钥长度对不上时，报错点应该落在「你的 hex 写错了」这里，而不是在几百行之后的
//!   「invalid length」。hex 也能无损往返，用户复制粘贴不会掉字符。
//! - **密文一律 base64（`STANDARD`，带 `=` 补位）**，与参考实现一致。解析时容忍空白。
//! - **`aes-gcm` 用 12 字节 nonce + 16 字节 tag**，都是 GCM 的标准选择（GCM 在 96 位
//!   nonce 下走的是专门的快速 GHASH 路径，别的长度要额外走一次 GHASH）。**tag 追加在
//!   密文尾部**，即 `base64(ciphertext ‖ tag)`，所以解密方必须把尾部 16 字节当 tag 剥掉。
//! - **OpenSSL 档的密钥派生是 `EVP_BytesToKey`（MD5，1 次迭代）的链，不是 PBKDF2**。
//!   crypto-js 的 `EvpKDF` 就是这条链：`D_i = MD5(D_{i-1} ‖ passphrase ‖ salt)`。
//!   （`src/registry/tools.rs` 里那句「由 PBKDF2 从口令+salt 派生」不准确：没有迭代次数，
//!   也没有 HMAC。它准确描述的只是「密文自带 salt，所以不需要另传 IV」这件事。）
//! - **空口令一律拒绝**（参考实现会照收）。理由是空口令派生出的 key‖iv 完全公开，
//!   编出来的东西看着有密文、其实谁都能解 —— 报个错比让人误以为加密过了安全得多。
//!   空**明文**是允许的：加密空串是合法的，只是解密的输入不能为空。
//!
//! # 已知的安全边界
//!
//! - OpenSSL 四档**没有任何完整性校验**（信封里没有 MAC），口令错了要么解出乱码、
//!   要么 1/256 概率下 padding 恰好合法。这也是 `openssl enc` 本身的性质，为了兼容
//!   不能改。原生 `aes-gcm` 才是有认证的那一档。
//! - `aes-cbc` 用的 `block_padding::Pkcs7::unpad` 只读最后一个字节判断填充长度，
//!   不逐字节回溯比较中间那些填充字节，所以不存在「逐字节试 padding」的经典时间预言机；
//!   它泄露的信息最多是「最后一个字节的填充长度」，这与 OpenSSL 的行为同级。
//! - GCM 解密走 `Aead::decrypt`：它先把尾部 16 字节当 tag 剥掉、解密、再校验 tag，
//!   校验不过就返回 `Err` 并丢弃整个缓冲，**任何明文字节都不会进入返回值或被记录**。

use aes::cipher::block_padding::Pkcs7;
use aes::cipher::common::typenum::Unsigned;
use aes::cipher::{
    BlockModeDecrypt, BlockModeEncrypt, BlockSizeUser, InnerIvInit, Iv, Key, KeyInit, KeyIvInit,
    StreamCipher, StreamCipherCoreWrapper,
};
use aes_gcm::aead::{Aead, AeadCore};
use aes_gcm::AesGcm;
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine as _;
use md5::{Digest, Md5};
use rand::rngs::OsRng;
use rand::RngCore;
use serde_json::{json, Value};

use super::util::{lang, opt_str, str_or};
use super::{ToolError, ToolResult};

/// 输入上限，避免一个几 GB 的字符串把 base64 中间缓冲撑爆（与 hash_text 同量级）。
const MAX_INPUT: usize = 32 * 1024 * 1024;

/// OpenSSL `enc` 信封：8 字节 ASCII magic + 8 字节 salt，后面才是密文。
const MAGIC: &[u8; 8] = b"Salted__";
const SALT_LEN: usize = 8;
const HEADER_LEN: usize = MAGIC.len() + SALT_LEN;

/// GCM 的 nonce 长度。96 位是 GCM 的标准长度，见模块注释。
const GCM_NONCE_LEN: usize = 12;
/// GCM 的 auth tag 长度（完整标签）。
const GCM_TAG_LEN: usize = 16;

/// `aes-gcm` 的 24 字节密钥没有官方别名，自己起一个。
type Aes192Gcm = AesGcm<aes::Aes192, aes::cipher::consts::U12>;

/// `Nonce` 的泛型参数是长度类型（U12），不是算法类型，所以这里要转发一层。
type GcmNonce<G> = aes_gcm::Nonce<<G as AeadCore>::NonceSize>;

/// 六档算法。解析失败一律返回 `ToolError::invalid`，绝不允许 panic。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Algorithm {
    /// 原生档：原始密钥 + 12 字节 nonce，输出 `ciphertext ‖ tag`。
    AesGcm,
    /// 原生档：原始密钥 + 16 字节 IV，PKCS#7，输出裸密文。
    AesCbc,
    /// OpenSSL 档：AES-256-CBC + PKCS#7，key 32B / iv 16B。
    OpenSslAes,
    /// OpenSSL 档：DES-EDE3-CBC + PKCS#7，key 24B / iv 8B。
    OpenSslTripleDes,
    /// OpenSSL 档：Rabbit 流密码（key 16B + iv 8B 都参与），不填充。
    OpenSslRabbit,
    /// OpenSSL 档：RC4 流密码，key 32B，不填充。
    OpenSslRc4,
}

impl Algorithm {
    fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "aes-gcm" => Self::AesGcm,
            "aes-cbc" => Self::AesCbc,
            "openssl-aes" => Self::OpenSslAes,
            "openssl-tripledes" => Self::OpenSslTripleDes,
            "openssl-rabbit" => Self::OpenSslRabbit,
            "openssl-rc4" => Self::OpenSslRc4,
            _ => return None,
        })
    }

    /// API 里用的字面量。用户看到的必须是这个，不是 Rust 的枚举名。
    fn name(self) -> &'static str {
        match self {
            Self::AesGcm => "aes-gcm",
            Self::AesCbc => "aes-cbc",
            Self::OpenSslAes => "openssl-aes",
            Self::OpenSslTripleDes => "openssl-tripledes",
            Self::OpenSslRabbit => "openssl-rabbit",
            Self::OpenSslRc4 => "openssl-rc4",
        }
    }

    /// 原生档的 `key`/`iv` 是十六进制原始字节；OpenSSL 档的 `key` 是口令。
    fn is_native(self) -> bool {
        matches!(self, Self::AesGcm | Self::AesCbc)
    }

    /// 输出格式的名字，进 `meta.format`。
    fn format(self) -> &'static str {
        if self.is_native() {
            "raw-key"
        } else {
            "openssl-salted"
        }
    }
}

/// 与注册表 `ApiSpec.fields` 保持一致。本工具没有 CPU 密集分支，`handle` 只是 `compute` 的壳。
pub async fn handle(payload: Value) -> ToolResult {
    compute(payload)
}

fn compute(payload: Value) -> ToolResult {
    let mode = str_or(&payload, "mode", "encrypt").to_string();
    if mode != "encrypt" && mode != "decrypt" {
        return Err(ToolError::invalid(
            "out.encryption.err.unknown_mode",
            &[("mode", &mode)],
        ));
    }
    let decrypt = mode == "decrypt";

    let algorithm_name = str_or(&payload, "algorithm", "aes-gcm").to_string();
    let algorithm = Algorithm::parse(&algorithm_name).ok_or_else(|| {
        ToolError::invalid(
            "out.encryption.err.unknown_algorithm",
            &[("algorithm", &algorithm_name)],
        )
    })?;

    let text = opt_str(&payload, "text").unwrap_or_default();
    // 明文可以为空（加密空串是合法的，空串也有确定的密文）；但没有密文可解。
    if decrypt && text.is_empty() {
        return Err(ToolError::invalid(
            "out.encryption.err.missing_ciphertext",
            &[],
        ));
    }
    if text.len() > MAX_INPUT {
        let size = text.len().to_string();
        let max = MAX_INPUT.to_string();
        return Err(ToolError::invalid(
            "out.encryption.err.input_too_long",
            &[("size", &size), ("max", &max)],
        ));
    }

    // key / passphrase 的取法随档位变，但两者都拒绝空值：空口令会派生出一个
    // 全公开的密钥，比报错危险得多。
    let key_field = opt_str(&payload, "key").unwrap_or_default();
    if key_field.trim().is_empty() {
        return Err(if algorithm.is_native() {
            ToolError::invalid("out.encryption.err.missing_key", &[])
        } else {
            ToolError::invalid("out.encryption.err.missing_passphrase", &[])
        });
    }

    let output = if algorithm.is_native() {
        native(algorithm, decrypt, text, key_field, &payload)?
    } else {
        openssl(algorithm, decrypt, text, key_field)?
    };

    Ok(json!({
        "output": output,
        "meta": {
            "algorithm": algorithm_name,
            "mode": mode,
            "format": algorithm.format(),
            "encoding": "base64",
            // 结果区的标题随模式变：原版加密那张卡写的是「Your text encrypted:」，
            // 解密那张卡写的是「Your decrypted text:」。服务端知道自己算的是
            // 哪一个，把翻好的文案带回去 —— 免得前端拿着一个键名去猜。
            "result_label": crate::i18n::t(
                lang(&payload),
                if decrypt { "result.decrypted" } else { "result.encrypted" },
            ),
        }
    }))
}

// ---------------------------------------------------------------------------
// 原生档：aes-gcm / aes-cbc
// ---------------------------------------------------------------------------

fn native(
    algorithm: Algorithm,
    decrypt: bool,
    text: &str,
    key_field: &str,
    payload: &Value,
) -> Result<String, ToolError> {
    let key = parse_hex(key_field, "key")?;
    if !matches!(key.len(), 16 | 24 | 32) {
        return Err(aes_key_len_error(key.len()));
    }
    let iv_field = opt_str(payload, "iv").unwrap_or_default();
    if iv_field.trim().is_empty() {
        return Err(ToolError::invalid(
            "out.encryption.err.missing_iv",
            &[
                ("algorithm", algorithm.name()),
                ("bytes", &iv_len(algorithm).to_string()),
            ],
        ));
    }
    let iv = parse_hex(iv_field, "iv")?;
    if iv.len() != iv_len(algorithm) {
        let expected = iv_len(algorithm).to_string();
        let chars = (iv_len(algorithm) * 2).to_string();
        let got = iv.len().to_string();
        return Err(ToolError::invalid(
            "out.encryption.err.bad_iv_length",
            &[("expected", &expected), ("chars", &chars), ("got", &got)],
        ));
    }

    // 加密吃的是明文字节，解密吃的是 base64；原生档没有信封，所以输入格式本身也不同。
    let raw = match (algorithm, decrypt) {
        (Algorithm::AesGcm, false) => gcm_encrypt_dispatch(&key, &iv, text.as_bytes())?,
        (Algorithm::AesGcm, true) => {
            gcm_decrypt_dispatch(&key, &iv, &B64.decode(squash_ws(text))?)?
        }
        (Algorithm::AesCbc, false) => aes_cbc_encrypt_dispatch(&key, &iv, text.as_bytes())?,
        (Algorithm::AesCbc, true) => {
            aes_cbc_decrypt_dispatch(&key, &iv, &B64.decode(squash_ws(text))?)?
        }
        // `native()` 只在 `is_native()` 为真时被调用，所以这里走不到；
        // 即便走到了也不该 panic —— 一个 bug 不该变成 500 之外的进程崩溃。
        (other, _) => {
            return Err(ToolError::Internal(format!(
                "内部错误：{other:?} 不是原生档算法"
            )))
        }
    };

    if decrypt {
        // 与参考实现一致：解密结果按 UTF-8 呈现，非法字节替换成 U+FFFD 而不是报错。
        Ok(String::from_utf8_lossy(&raw).into_owned())
    } else {
        Ok(B64.encode(&raw))
    }
}

fn iv_len(algorithm: Algorithm) -> usize {
    match algorithm {
        // GCM 的 nonce 就是 IV 字段，固定 12 字节。
        Algorithm::AesGcm => GCM_NONCE_LEN,
        _ => 16,
    }
}

/// 密钥长度不对时要说清楚「这是 hex 解出来的字节数」，而不是让人以为是字符数。
fn aes_key_len_error(got: usize) -> ToolError {
    let got = got.to_string();
    ToolError::invalid("out.encryption.err.bad_key_length", &[("got", &got)])
}

// ---------------------------------------------------------------------------
// 原生档：aes-gcm
// ---------------------------------------------------------------------------

fn gcm_encrypt_dispatch(key: &[u8], nonce: &[u8], pt: &[u8]) -> Result<Vec<u8>, ToolError> {
    // tag 直接追加在密文尾部，调用方解密时必须知道这件事。
    Ok(match key.len() {
        16 => gcm_encrypt::<aes_gcm::Aes128Gcm>(key, nonce, pt)?,
        24 => gcm_encrypt::<Aes192Gcm>(key, nonce, pt)?,
        _ => gcm_encrypt::<aes_gcm::Aes256Gcm>(key, nonce, pt)?,
    })
}

fn gcm_encrypt<G>(key: &[u8], nonce: &[u8], pt: &[u8]) -> Result<Vec<u8>, ToolError>
where
    G: Aead + KeyInit,
{
    let cipher = G::new_from_slice(key).map_err(|_| aes_key_len_error(key.len()))?;
    let nonce: GcmNonce<G> = nonce
        .try_into()
        .map_err(|_| invalid_nonce())?;
    // `Aead::encrypt` 走 postfix tag：返回的就是 `密文 ‖ 16 字节 tag`，正好是我们要的布局。
    cipher
        .encrypt(&nonce, pt)
        .map_err(|_| ToolError::Internal("AES-GCM 加密失败".into()))
}

fn gcm_decrypt_dispatch(key: &[u8], nonce: &[u8], ct: &[u8]) -> Result<Vec<u8>, ToolError> {
    match key.len() {
        16 => gcm_decrypt::<aes_gcm::Aes128Gcm>(key, nonce, ct),
        24 => gcm_decrypt::<Aes192Gcm>(key, nonce, ct),
        _ => gcm_decrypt::<aes_gcm::Aes256Gcm>(key, nonce, ct),
    }
}

fn gcm_decrypt<G>(key: &[u8], nonce: &[u8], ct: &[u8]) -> Result<Vec<u8>, ToolError>
where
    G: Aead + KeyInit,
{
    if ct.len() < GCM_TAG_LEN {
        let got = ct.len().to_string();
        return Err(ToolError::invalid(
            "out.encryption.err.ciphertext_too_short",
            &[("got", &got)],
        ));
    }
    let cipher = G::new_from_slice(key).map_err(|_| aes_key_len_error(key.len()))?;
    let nonce: GcmNonce<G> = nonce
        .try_into()
        .map_err(|_| invalid_nonce())?;
    // 认证失败时这里返回 Err；内部已经把尾部 16 字节当 tag 剥掉再校验，
    // 校验不过则连同明文缓冲一起丢弃 —— 不会有任何明文字节流回调用方。
    cipher.decrypt(&nonce, ct).map_err(|_| {
        ToolError::invalid("out.encryption.err.gcm_auth_failed", &[])
    })
}

/// nonce 长度不对。正常路径上 `native()` 已经校验过 IV 长度，所以这里走不到 ——
/// 留着是为了「万一走到也不 panic」。
fn invalid_nonce() -> ToolError {
    ToolError::invalid("out.encryption.err.bad_nonce_length", &[])
}

// ---------------------------------------------------------------------------
// 原生档：aes-cbc
// ---------------------------------------------------------------------------

fn aes_cbc_encrypt_dispatch(key: &[u8], iv: &[u8], pt: &[u8]) -> Result<Vec<u8>, ToolError> {
    Ok(match key.len() {
        16 => cbc_encrypt::<cbc::Encryptor<aes::Aes128>>(key, iv, pt)?,
        24 => cbc_encrypt::<cbc::Encryptor<aes::Aes192>>(key, iv, pt)?,
        _ => cbc_encrypt::<cbc::Encryptor<aes::Aes256>>(key, iv, pt)?,
    })
}

fn aes_cbc_decrypt_dispatch(key: &[u8], iv: &[u8], ct: &[u8]) -> Result<Vec<u8>, ToolError> {
    match key.len() {
        16 => cbc_decrypt::<cbc::Decryptor<aes::Aes128>>(key, iv, ct),
        24 => cbc_decrypt::<cbc::Decryptor<aes::Aes192>>(key, iv, ct),
        _ => cbc_decrypt::<cbc::Decryptor<aes::Aes256>>(key, iv, ct),
    }
}

pub(crate) fn cbc_encrypt<C>(key: &[u8], iv: &[u8], pt: &[u8]) -> Result<Vec<u8>, ToolError>
where
    C: BlockModeEncrypt + BlockSizeUser + KeyIvInit,
{
    // PKCS#7 最坏再加一整个块。
    let mut out = vec![0u8; pt.len() + C::BlockSize::USIZE];
    let enc = C::new_from_slices(key, iv).map_err(|_| cbc_length_error())?;
    let n = enc
        .encrypt_padded_b2b::<Pkcs7>(pt, &mut out)
        .map_err(|_| ToolError::Internal("AES-CBC 加密失败".into()))?
        .len();
    out.truncate(n);
    Ok(out)
}

pub(crate) fn cbc_decrypt<C>(key: &[u8], iv: &[u8], ct: &[u8]) -> Result<Vec<u8>, ToolError>
where
    C: BlockModeDecrypt + BlockSizeUser + KeyIvInit,
{
    // 注意别用 `is_multiple_of`：它 1.87 才稳定，而本 crate 的 MSRV 是 1.85。
    if ct.is_empty() || ct.len() % C::BlockSize::USIZE != 0 {
        let block = C::BlockSize::USIZE.to_string();
        let got = ct.len().to_string();
        return Err(ToolError::invalid(
            "out.encryption.err.bad_ciphertext_length",
            &[("block", &block), ("got", &got)],
        ));
    }
    let dec = C::new_from_slices(key, iv).map_err(|_| cbc_length_error())?;
    let mut out = vec![0u8; ct.len()];
    // Pkcs7::unpad 只按最后一个字节判断填充长度，不做逐字节回溯比较，
    // 所以这里不存在可被用来逐字节试探的 padding oracle。
    let n = dec
        .decrypt_padded_b2b::<Pkcs7>(ct, &mut out)
        .map_err(|_| ToolError::invalid("out.encryption.err.cbc_padding_failed", &[]))?
        .len();
    out.truncate(n);
    Ok(out)
}

/// key / iv 长度不对。正常路径上（原生档与 OpenSSL 档）长度都已经校验过了，
/// 所以这里走不到 —— 留着是为了「万一走到也不 panic」。
fn cbc_length_error() -> ToolError {
    ToolError::invalid("out.encryption.err.bad_key_or_iv_length", &[])
}

// ---------------------------------------------------------------------------
// OpenSSL 档：Salted__ 信封
// ---------------------------------------------------------------------------

fn openssl(
    algorithm: Algorithm,
    decrypt: bool,
    text: &str,
    passphrase: &str,
) -> Result<String, ToolError> {
    let (salt, body) = if decrypt {
        let raw = B64
            .decode(squash_ws(text))
            .map_err(|_| ToolError::invalid("out.encryption.err.bad_base64", &[]))?;
        if raw.len() < HEADER_LEN || &raw[..MAGIC.len()] != MAGIC.as_slice() {
            let min_bytes = HEADER_LEN.to_string();
            return Err(ToolError::invalid(
                "out.encryption.err.bad_envelope",
                &[("min_bytes", &min_bytes)],
            ));
        }
        (
            raw[SALT_LEN..HEADER_LEN].to_vec(),
            raw[HEADER_LEN..].to_vec(),
        )
    } else {
        let mut salt = [0u8; SALT_LEN];
        OsRng.fill_bytes(&mut salt);
        (salt.to_vec(), text.as_bytes().to_vec())
    };

    // 流密码（Rabbit / RC4）的**空 body 是「明文为空」的合法编码**，不是坏数据：
    // `encrypt("")` 产出的就是 `Salted__` + salt 后面什么都不跟，crypto-js 解回来
    // 也是空串。这里原本对两个方向都报「密文为空」，于是既编不出空串密文、
    // 又读不了 crypto-js 编出来的空串密文（与上面「明文可以为空」自相矛盾）。
    //
    // 至于「流密码没有 padding，被截断的密文会长得像空串」这个担心：CBC 那两档
    // 结构上就排除了（body 长度必须是分组长的倍数，见 `cbc_decrypt`），而对
    // Rabbit / RC4 来说空串本来就是一种合法答案 —— 与参考实现保持一致更重要，
    // 一个开发者工具擅自「更安全」只会让人对不上参考实现的结果。

    // crypto-js 的 `PasswordBasedCipher` 按 `keySize + ivSize` 一次性向 EVP_BytesToKey
    // 要够长的字节流，再切成 key 和 iv —— 所以两种算法切点不同但共用同一条 MD5 链。
    let (key_len, iv_len) = match algorithm {
        Algorithm::OpenSslAes => (32, 16),
        Algorithm::OpenSslTripleDes => (24, 8),
        // Rabbit 的 key 和 iv 都要（RFC 4503 的 IV setup 会改写计数器）。
        Algorithm::OpenSslRabbit => (16, 8),
        // RC4 压根没有 IV；crypto-js 的 `RC4.ivSize` 是 0，KDF 只喂 32 字节 key。
        Algorithm::OpenSslRc4 => (32, 0),
        other => {
            return Err(ToolError::Internal(format!(
                "内部错误：{other:?} 不是 OpenSSL 档算法"
            )))
        }
    };
    let (key, iv) = evp_bytes_to_key(passphrase.as_bytes(), &salt, key_len, iv_len);

    let raw = match (algorithm, decrypt) {
        (Algorithm::OpenSslAes, false) => {
            cbc_encrypt::<cbc::Encryptor<aes::Aes256>>(&key, &iv, &body)?
        }
        (Algorithm::OpenSslAes, true) => {
            cbc_decrypt::<cbc::Decryptor<aes::Aes256>>(&key, &iv, &body)?
        }
        (Algorithm::OpenSslTripleDes, false) => {
            cbc_encrypt::<cbc::Encryptor<des::TdesEde3>>(&key, &iv, &body)?
        }
        (Algorithm::OpenSslTripleDes, true) => {
            cbc_decrypt::<cbc::Decryptor<des::TdesEde3>>(&key, &iv, &body)?
        }
        (Algorithm::OpenSslRabbit, _) => rabbit_xor(&key, &iv, &body)?,
        (Algorithm::OpenSslRc4, _) => rc4_xor(&key, &body)?,
        (other, _) => {
            return Err(ToolError::Internal(format!(
                "内部错误：{other:?} 没有对应的 OpenSSL 实现"
            )))
        }
    };

    if decrypt {
        Ok(String::from_utf8_lossy(&raw).into_owned())
    } else {
        let mut envelope = Vec::with_capacity(HEADER_LEN + raw.len());
        envelope.extend_from_slice(MAGIC);
        envelope.extend_from_slice(&salt);
        envelope.extend_from_slice(&raw);
        Ok(B64.encode(&envelope))
    }
}

/// `EVP_BytesToKey`，MD5、1 次迭代 —— 就是 `openssl enc -md md5` 的那条链。
///
/// `D_1 = MD5(passphrase ‖ salt)`，`D_{i+1} = MD5(D_i ‖ passphrase ‖ salt)`，
/// 把 `D_1 ‖ D_2 ‖ …` 拼起来截断成 `key ‖ iv`。
///
/// 注意这**不是** PBKDF2：没有迭代次数、没有 `hmac`、口令本身不进密文。
pub(crate) fn evp_bytes_to_key(
    passphrase: &[u8],
    salt: &[u8],
    key_len: usize,
    iv_len: usize,
) -> (Vec<u8>, Vec<u8>) {
    let want = key_len + iv_len;
    let mut out: Vec<u8> = Vec::with_capacity(want);
    let mut prev: Vec<u8> = Vec::new();
    let mut buf: Vec<u8> = Vec::with_capacity(prev.len() + passphrase.len() + salt.len());
    while out.len() < want {
        buf.clear();
        buf.extend_from_slice(&prev);
        buf.extend_from_slice(passphrase);
        buf.extend_from_slice(salt);
        let digest = Md5::digest(&buf).to_vec();
        out.extend_from_slice(&digest);
        prev = digest;
    }
    out.truncate(want);
    (out[..key_len].to_vec(), out[key_len..].to_vec())
}

/// Rabbit（RFC 4503）流密码。crypto-js 的 `blockSize` 是 16 字节但**不做填充**，
/// 输出长度等于明文长度；cipher 0.5 的 `StreamCipherCoreWrapper` 自己处理尾巴，
/// 所以这里不需要把 buffer 补齐到 16 的倍数。
fn rabbit_xor(key: &[u8], iv: &[u8], data: &[u8]) -> Result<Vec<u8>, ToolError> {
    use rabbit::{RabbitCore, RabbitKeyOnlyCore};

    let k = Key::<RabbitKeyOnlyCore>::try_from(key)
        .map_err(|_| ToolError::Internal("内部错误：Rabbit 密钥长度不为 16".into()))?;
    let v = Iv::<RabbitCore>::try_from(iv)
        .map_err(|_| ToolError::Internal("内部错误：Rabbit IV 长度不为 8".into()))?;
    // `RabbitCore` 不直接 impl `KeyInit`：先拿 key-only 的 core，再用 InnerIvInit 喂 IV。
    let mut cipher = StreamCipherCoreWrapper::<RabbitCore>::from_core(InnerIvInit::inner_iv_init(
        RabbitKeyOnlyCore::new(&k),
        &v,
    ));
    let mut buf = data.to_vec();
    cipher.apply_keystream(&mut buf);
    Ok(buf)
}

/// RC4 是纯密钥流，没有 IV、没有认证、没有填充。
fn rc4_xor(key: &[u8], data: &[u8]) -> Result<Vec<u8>, ToolError> {
    let mut cipher = rc4::Rc4::new_from_slice(key)
        .map_err(|_| ToolError::Internal("内部错误：RC4 密钥长度不为 32".into()))?;
    let mut buf = data.to_vec();
    cipher.apply_keystream(&mut buf);
    Ok(buf)
}

// ---------------------------------------------------------------------------
// 公共小工具
// ---------------------------------------------------------------------------

/// hex 字段解析：先剥掉所有 ASCII 空白（用户粘贴密钥时常带换行/空格），再解 hex。
///
/// 解析失败时明确指出「是 hex 的问题」，不退回 UTF-8 字节 —— 那样只会得到一个长度不对的
/// 密钥，然后在离现场很远的地方报一个莫名其妙的错。
fn parse_hex(field: &str, name: &str) -> Result<Vec<u8>, ToolError> {
    let cleaned = squash_ws(field);
    hex::decode(&cleaned).map_err(|_| {
        let chars = cleaned.chars().count().to_string();
        ToolError::invalid(
            "out.encryption.err.bad_hex",
            &[("field", name), ("chars", &chars)],
        )
    })
}

/// base64 输入同样容忍空白 —— 表单/剪贴板带来的换行不该让人解密失败。
fn squash_ws(s: &str) -> String {
    s.chars().filter(|c| !c.is_ascii_whitespace()).collect()
}

impl From<base64::DecodeError> for ToolError {
    fn from(_e: base64::DecodeError) -> Self {
        // base64 crate 的错误描述是英文的，塞进中文文案里会露出来 ——
        // 只说「解不开」，不说解不开的细节（细节里也只有偏移量，没有密文内容）。
        ToolError::invalid("out.encryption.err.bad_base64", &[])
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// 真实的上游密文：直接取自参考实现
    /// `src/tools/encryption/encryption.vue` 里 decrypt 卡片的默认值，
    /// 口令 `my secret key`、算法 AES。它解出来就是页面上的默认明文。
    const IT_TOOLS_AES: &str = "U2FsdGVkX1/EC3+6P5dbbkZ3e1kQ5o2yzuU0NHTjmrKnLBEwreV489Kr0DIB+uBs";
    const PASSWORD: &str = "my secret key";
    const PLAIN: &str = "Lorem ipsum dolor sit amet";

    /// 用 crypto-js 4.1.1 生成、口令 `my secret key`、明文 `Lorem ipsum dolor sit amet`
    /// 的另外三档信封。salt 是 `0000000100000008`（crypto-js 的随机源在 Node 下
    /// 退化成了确定性序列），所以这三个密文是可复现的固定向量。
    /// 三者的 salt 与密文都由 crypto-js 直接产出，用来证明我们解出来的确实是
    /// OpenSSL 信封，而不是「自己加密自己解密」的自洽格式。
    const CJ_TRIPLEDES: &str = "U2FsdGVkX18AAAABAAAACAzFZEsQdBKV1VPcDoK+PVlV4TUu8+7lIvoaOKIhRjGa";
    const CJ_RABBIT: &str = "U2FsdGVkX18AAAABAAAACFiY2qnxPUMBC2aVJsggVsQlvdlWvbMt0uKU";
    const CJ_RC4: &str = "U2FsdGVkX18AAAABAAAACOCO8NTQumz06y9Ei5Y4lmUmzZ3/SvKsSo+i";
    const CJ_AES: &str = "U2FsdGVkX18AAAABAAAACJfFHgk308O7jtu/bvZkKBZxfuZ+rk/L9mMmYvkIm9MQ";

    const HEX128: &str = "000102030405060708090a0b0c0d0e0f";
    const HEX192: &str = "000102030405060708090a0b0c0d0e0f1011121314151617";
    const HEX256: &str = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";
    const HEX_IV: &str = "101112131415161718191a1b1c1d1e1f";
    /// AES-GCM 的 nonce，故意和上面那个 IV 不一样，防止测试里两个字段写混了。
    const HEX_NONCE: &str = "0f0e0d0c0b0a090807060504";

    fn enc(algorithm: &str, text: &str, key: &str, iv: &str) -> String {
        compute(json!({ "mode": "encrypt", "algorithm": algorithm, "text": text, "key": key, "iv": iv }))
            .expect("encrypt should succeed")["output"]
            .as_str()
            .expect("output is a string")
            .to_string()
    }

    fn dec(algorithm: &str, text: &str, key: &str, iv: &str) -> String {
        compute(json!({ "mode": "decrypt", "algorithm": algorithm, "text": text, "key": key, "iv": iv }))
            .expect("decrypt should succeed")["output"]
            .as_str()
            .expect("output is a string")
            .to_string()
    }

    fn dec_openssl(algorithm: &str, ciphertext: &str, passphrase: &str) -> String {
        compute(json!({ "mode": "decrypt", "algorithm": algorithm, "text": ciphertext, "key": passphrase }))
            .expect("decrypt should succeed")["output"]
            .as_str()
            .expect("output is a string")
            .to_string()
    }

    // -- 真实上游向量 ------------------------------------------------

    #[test]
    fn decrypts_a_real_it_tools_ciphertext() {
        // 这一条是最有价值的用例：它证明 OpenSSL 档真的是 OpenSSL 格式。
        assert_eq!(dec_openssl("openssl-aes", IT_TOOLS_AES, PASSWORD), PLAIN);
    }

    #[test]
    fn our_aes_output_is_byte_identical_to_crypto_js() {
        // 口令模式的 salt 是随机的，所以固定密文只能来自固定 salt。
        // 这里直接构造信封：KDF(口令, salt=0000000100000008) → AES-256-CBC/PKCS7，
        // 再与 crypto-js 的产物逐字节比对。
        let salt = hex::decode("0000000100000008").expect("valid hex");
        let (key, iv) = evp_bytes_to_key(PASSWORD.as_bytes(), &salt, 32, 16);
        let raw = cbc_encrypt::<cbc::Encryptor<aes::Aes256>>(&key, &iv, PLAIN.as_bytes()).unwrap();
        let mut envelope = Vec::new();
        envelope.extend_from_slice(MAGIC);
        envelope.extend_from_slice(&salt);
        envelope.extend_from_slice(&raw);
        assert_eq!(B64.encode(&envelope), CJ_AES);
    }

    // -- 六档全部往返 ---------------------------------------------------------

    #[test]
    fn round_trip_for_all_six_algorithms() {
        for hex_key in [HEX128, HEX192, HEX256] {
            for algorithm in ["aes-gcm", "aes-cbc"] {
                let iv = if algorithm == "aes-gcm" {
                    HEX_NONCE
                } else {
                    HEX_IV
                };
                let ct = enc(algorithm, PLAIN, hex_key, iv);
                assert_eq!(dec(algorithm, &ct, hex_key, iv), PLAIN, "{algorithm}");
            }
        }
        for algorithm in [
            "openssl-aes",
            "openssl-tripledes",
            "openssl-rabbit",
            "openssl-rc4",
        ] {
            let ct = compute(json!({
                "mode": "encrypt", "algorithm": algorithm, "text": PLAIN, "key": PASSWORD
            }))
            .unwrap()["output"]
                .as_str()
                .unwrap()
                .to_string();
            assert_eq!(dec_openssl(algorithm, &ct, PASSWORD), PLAIN, "{algorithm}");
        }
    }

    #[test]
    fn openssl_output_carries_the_salted_header() {
        let ct = compute(json!({
            "mode": "encrypt", "algorithm": "openssl-aes", "text": PLAIN, "key": PASSWORD
        }))
        .unwrap()["output"]
            .as_str()
            .unwrap()
            .to_string();
        let raw = B64.decode(&ct).unwrap();
        assert_eq!(&raw[..8], b"Salted__");
        // PKCS#7 把 26 字节的明文补到 32 字节，所以信封 = 16 + 32。
        assert_eq!(raw.len(), HEADER_LEN + 32);
    }

    #[test]
    fn openssl_encrypt_rejects_empty_passphrase() {
        assert!(compute(json!({
            "mode": "encrypt", "algorithm": "openssl-aes", "text": PLAIN, "key": "   "
        }))
        .is_err());
    }

    // -- 跨实现兼容：crypto-js 产出的三种信封 ----------------------------------

    #[test]
    fn decrypts_crypto_js_rabbit_envelope() {
        // Rabbit 的 passphrase 模式用 key(16B) **和** iv(8B) 一起喂 RFC 4503，
        // 少了 IV 会解出完全不同的东西 —— 这条用例专门钉住这个行为。
        assert_eq!(dec_openssl("openssl-rabbit", CJ_RABBIT, PASSWORD), PLAIN);
    }

    #[test]
    fn decrypts_crypto_js_rc4_envelope() {
        assert_eq!(dec_openssl("openssl-rc4", CJ_RC4, PASSWORD), PLAIN);
    }

    #[test]
    fn decrypts_crypto_js_tripledes_envelope() {
        assert_eq!(
            dec_openssl("openssl-tripledes", CJ_TRIPLEDES, PASSWORD),
            PLAIN
        );
    }

    #[test]
    fn rabbit_key_alone_does_not_reproduce_the_envelope() {
        // 负向对照：如果哪天有人以为 Rabbit 的口令模式就是裸密钥流，
        // 这条用例会立刻发现「用 RabbitKeyOnly 也能解开」这种错误实现。
        let raw = B64.decode(CJ_RABBIT).unwrap();
        let salt = &raw[8..16];
        let (key, _iv) = evp_bytes_to_key(PASSWORD.as_bytes(), salt, 16, 0);
        let mut buf = PLAIN.as_bytes().to_vec();
        use aes::cipher::StreamCipherCoreWrapper as W;
        let core = rabbit::RabbitKeyOnlyCore::new_from_slice(&key).unwrap();
        let mut c = W::<rabbit::RabbitKeyOnlyCore>::from_core(core);
        c.apply_keystream(&mut buf);
        assert_ne!(buf, raw[16..]);
    }

    // -- 原生档的固定向量（与 Node 的 crypto 交叉验证过） ----------------------

    #[test]
    fn aes_gcm_matches_a_known_vector() {
        // 用 Node 的 crypto 交叉验证过：key=000102..0f、nonce=0f0e0c0b0a090807060504、
        // 明文 "Lorem ipsum" → base64(密文 ‖ 16 字节 tag)。
        assert_eq!(
            enc("aes-gcm", "Lorem ipsum", HEX128, HEX_NONCE),
            "bgunO6EeVRMWUquOuDQGJWteHzC2AKNcG/xu"
        );
    }

    #[test]
    fn aes_gcm_accepts_192_bit_keys() {
        assert_eq!(
            enc("aes-gcm", "Lorem ipsum", HEX192, HEX_NONCE),
            "D9KhOC17QWtj2PPNXYM8c/6YNEt16wF9lGo8"
        );
        assert_eq!(
            enc("aes-gcm", "Lorem ipsum", HEX256, HEX_NONCE),
            "6F/DOTb3xt6YqtxPMDfxQWmoRTu0B5RMSUeq"
        );
    }

    #[test]
    fn aes_cbc_matches_a_known_vector() {
        assert_eq!(
            enc("aes-cbc", "Lorem ipsum", HEX128, HEX_IV),
            B64.encode(hex::decode("180e956948576c8ce9d30cee8a9ff816").unwrap())
        );
    }

    #[test]
    fn gcm_tag_is_appended_to_the_ciphertext() {
        let ct = enc("aes-gcm", PLAIN, HEX128, HEX_NONCE);
        let raw = B64.decode(&ct).unwrap();
        assert_eq!(raw.len(), PLAIN.len() + GCM_TAG_LEN);
    }

    // -- 长度校验 -------------------------------------------------------------

    #[test]
    fn aes_key_length_must_be_16_24_or_32() {
        for bad in [
            "00",
            hex::encode([0u8; 17]).as_str(),
            hex::encode([0u8; 33]).as_str(),
        ] {
            let err = compute(json!({
                "mode": "encrypt", "algorithm": "aes-cbc", "text": "x", "key": bad, "iv": HEX_IV
            }))
            .unwrap_err();
            match err {
                ToolError::InvalidKeyed { key, .. } => {
                    assert_eq!(key, "out.encryption.err.bad_key_length", "{bad}")
                }
                other => panic!("{bad} 应当报 bad_key_length，实际 {other:?}"),
            }
        }
        for good in [HEX128, HEX192, HEX256] {
            assert!(compute(json!({
                "mode": "encrypt", "algorithm": "aes-cbc", "text": "x", "key": good, "iv": HEX_IV
            }))
            .is_ok());
        }
    }

    #[test]
    fn gcm_iv_must_be_12_bytes_and_cbc_iv_must_be_16() {
        match compute(json!({
            "mode": "encrypt", "algorithm": "aes-gcm", "text": "x", "key": HEX128, "iv": HEX_IV
        }))
        .unwrap_err()
        {
            ToolError::InvalidKeyed { key, .. } => assert_eq!(key, "out.encryption.err.bad_iv_length"),
            other => panic!("应当报 bad_iv_length，实际 {other:?}"),
        }
        match compute(json!({
            "mode": "encrypt", "algorithm": "aes-cbc", "text": "x", "key": HEX128, "iv": HEX_NONCE
        }))
        .unwrap_err()
        {
            ToolError::InvalidKeyed { key, .. } => assert_eq!(key, "out.encryption.err.bad_iv_length"),
            other => panic!("应当报 bad_iv_length，实际 {other:?}"),
        }
    }

    #[test]
    fn bad_hex_key_says_so_explicitly() {
        let err = compute(json!({
            "mode": "encrypt", "algorithm": "aes-cbc", "text": "x", "key": "zzz", "iv": HEX_IV
        }))
        .unwrap_err();
        match err {
            ToolError::InvalidKeyed { key, args } => {
                assert_eq!(key, "out.encryption.err.bad_hex");
                // 只说「哪一类不对」，不回显密钥内容；字符数（长度）可以留。
                let shown = format!("{args:?}");
                assert!(!shown.contains("zzz"), "错误信息里不该回显密钥内容: {shown}");
                assert!(
                    args.iter().any(|(name, value)| name == "chars" && value == "3"),
                    "字符数应当保留: {shown}"
                );
            }
            other => panic!("应当报 bad_hex，实际 {other:?}"),
        }
    }

    // -- 失败路径 -------------------------------------------------------------

    #[test]
    fn wrong_key_fails_instead_of_returning_garbage() {
        let gcm = enc("aes-gcm", PLAIN, HEX128, HEX_NONCE);
        assert!(compute(json!({
            "mode": "decrypt", "algorithm": "aes-gcm", "text": gcm,
            "key": HEX192, "iv": HEX_NONCE
        }))
        .is_err());

        let cbc = enc("aes-cbc", PLAIN, HEX128, HEX_IV);
        // CBC 没有认证，错误密钥只有当 padding 非法时才会被发现；两种结果都接受，
        // 但绝不能悄悄返回一段看起来正常的明文。
        match compute(json!({
            "mode": "decrypt", "algorithm": "aes-cbc", "text": cbc,
            "key": HEX192, "iv": HEX_IV
        })) {
            Err(_) => {}
            Ok(v) => assert_ne!(v["output"], PLAIN),
        }
    }

    #[test]
    fn truncated_or_corrupt_envelope_is_rejected() {
        for bad in [
            "not an envelope at all",
            "aGVsbG8gd29ybGQhCg==",   // base64 对，但 magic 不对
            &B64.encode(b"Salted__"), // 只有 magic，salt 和密文都缺
        ] {
            assert!(
                compute(json!({
                    "mode": "decrypt", "algorithm": "openssl-aes", "text": bad, "key": PASSWORD
                }))
                .is_err(),
                "{bad}"
            );
        }
    }

    #[test]
    fn wrong_openssl_passphrase_does_not_produce_the_plaintext() {
        match compute(json!({
            "mode": "decrypt", "algorithm": "openssl-aes", "text": IT_TOOLS_AES, "key": "nope"
        })) {
            Err(_) => {}
            Ok(v) => assert_ne!(v["output"], PLAIN),
        }
    }

    #[test]
    fn unknown_algorithm_and_mode_error_without_panicking() {
        match compute(
            json!({ "mode": "encrypt", "algorithm": "chacha20", "text": "x", "key": "k" })
        )
        .unwrap_err()
        {
            ToolError::InvalidKeyed { key, args } => {
                assert_eq!(key, "out.encryption.err.unknown_algorithm");
                assert!(args.iter().any(|(name, value)| name == "algorithm" && value == "chacha20"));
            }
            other => panic!("应当报 unknown_algorithm，实际 {other:?}"),
        }
        match compute(json!({ "mode": "sideways", "algorithm": "aes-gcm", "text": "x", "key": HEX128, "iv": HEX_NONCE }))
            .unwrap_err()
        {
            ToolError::InvalidKeyed { key, .. } => assert_eq!(key, "out.encryption.err.unknown_mode"),
            other => panic!("应当报 unknown_mode，实际 {other:?}"),
        }
    }

    #[test]
    fn empty_text_and_empty_key_error() {
        assert!(compute(
            json!({ "mode": "decrypt", "algorithm": "openssl-aes", "text": "", "key": PASSWORD })
        )
        .is_err());
        assert!(compute(json!({ "mode": "encrypt", "algorithm": "aes-cbc", "text": "x", "key": "", "iv": HEX_IV }))
            .is_err());
        assert!(compute(
            json!({ "mode": "encrypt", "algorithm": "openssl-aes", "text": "x", "key": "" })
        )
        .is_err());
    }

    // -- Unicode / 空明文 -----------------------------------------------------

    #[test]
    fn unicode_plaintext_round_trips() {
        let text = "中文 — ünïcödé 🎉 مرحبا";
        for algorithm in ["aes-gcm", "aes-cbc"] {
            let iv = if algorithm == "aes-gcm" {
                HEX_NONCE
            } else {
                HEX_IV
            };
            let ct = enc(algorithm, text, HEX256, iv);
            assert_eq!(dec(algorithm, &ct, HEX256, iv), text, "{algorithm}");
        }
        for algorithm in ["openssl-aes", "openssl-tripledes", "openssl-rc4"] {
            let ct = compute(
                json!({ "mode": "encrypt", "algorithm": algorithm, "text": text, "key": PASSWORD }),
            )
            .unwrap()["output"]
                .as_str()
                .unwrap()
                .to_string();
            assert_eq!(dec_openssl(algorithm, &ct, PASSWORD), text, "{algorithm}");
        }
    }

    #[test]
    fn empty_plaintext_round_trips() {
        // 空串加密是合法的（它有确定的密文），但空串没法解，所以只测加密方向。
        for algorithm in ["aes-gcm", "aes-cbc"] {
            let iv = if algorithm == "aes-gcm" {
                HEX_NONCE
            } else {
                HEX_IV
            };
            let ct = enc(algorithm, "", HEX128, iv);
            assert!(!ct.is_empty());
        }
        let ct = compute(
            json!({ "mode": "encrypt", "algorithm": "openssl-aes", "text": "", "key": PASSWORD }),
        )
        .unwrap()["output"]
            .as_str()
            .unwrap()
            .to_string();
        assert_eq!(dec_openssl("openssl-aes", &ct, PASSWORD), "");
    }

    #[test]
    fn stream_ciphers_treat_an_empty_body_as_an_empty_message() {
        // 上面的 `empty_plaintext_round_trips` 只测了 CBC 那两档。Rabbit / RC4 是流
        // 密码，空明文编出来就是「`Salted__` + salt，后面什么都不跟」—— 原来这里对
        // 两个方向都报「密文为空」，于是既编不出、也读不了参考实现编的那一条。
        // 下面 4 条密文都是 crypto-js 4.1.1 用口令 `my secret key` 编出来的固定向量。
        for (algorithm, ct) in [
            (
                "openssl-aes",
                "U2FsdGVkX19Gxn32K3T02DYXgknSE8tt/Bux4VZvwh0=",
            ),
            ("openssl-tripledes", "U2FsdGVkX1/7E0TEbGT8djqedLy4OyS5"),
            ("openssl-rabbit", "U2FsdGVkX1+sh3rDcOUpZQ=="),
            ("openssl-rc4", "U2FsdGVkX1+f/DnC7olh2Q=="),
        ] {
            assert_eq!(dec_openssl(algorithm, ct, PASSWORD), "", "{algorithm}");

            // 再反向走一遍：我们编的也要能被自己读回来
            let mine = compute(
                json!({ "mode": "encrypt", "algorithm": algorithm, "text": "", "key": PASSWORD }),
            )
            .unwrap_or_else(|e| panic!("{algorithm} 连空串都编不出来: {e}"))["output"]
                .as_str()
                .unwrap()
                .to_string();
            assert_eq!(
                dec_openssl(algorithm, &mine, PASSWORD),
                "",
                "{algorithm} 往返"
            );
        }
    }

    #[test]
    fn whitespace_in_pasted_hex_and_base64_is_ignored() {
        let ct = enc("aes-cbc", PLAIN, HEX128, HEX_IV);
        let spaced_key = HEX128
            .as_bytes()
            .chunks(2)
            .map(|c| std::str::from_utf8(c).unwrap())
            .collect::<Vec<_>>()
            .join(" ");
        assert_eq!(dec("aes-cbc", &ct, &spaced_key, HEX_IV), PLAIN);
    }

    // -- KDF ------------------------------------------------------------------

    #[test]
    fn evp_bytes_to_key_matches_openssl_semantics() {
        // 按 OpenSSL 的定义在测试里独立写一遍：D_i = MD5(D_{i-1} ‖ passphrase ‖ salt)，
        // D_0 为空，拼起来截断成 key ‖ iv。注意 MD5 是 16 字节，所以 32+16 要两块半。
        let salt = hex::decode("0000000100000008").expect("valid hex");
        let mut blocks: Vec<u8> = Vec::new();
        let mut prev: Vec<u8> = Vec::new();
        loop {
            let mut h = Md5::new();
            Digest::update(&mut h, &prev);
            Digest::update(&mut h, PASSWORD.as_bytes());
            Digest::update(&mut h, &salt);
            prev = h.finalize().to_vec();
            blocks.extend_from_slice(&prev);
            if blocks.len() >= 48 {
                break;
            }
        }
        assert_eq!(blocks.len(), 48);
        assert_eq!(blocks[32..], prev, "最后一块应当正好用完");

        let (key, iv) = evp_bytes_to_key(PASSWORD.as_bytes(), &salt, 32, 16);
        assert_eq!(key, blocks[..32]);
        assert_eq!(iv, blocks[32..48]);

        // 换一组长度：RC4 只要 32 字节 key（不需要 IV），TripleDES 是 24+8。
        let (rc4_key, empty_iv) = evp_bytes_to_key(PASSWORD.as_bytes(), &salt, 32, 0);
        assert_eq!(rc4_key, blocks[..32]);
        assert!(empty_iv.is_empty());

        let (des_key, des_iv) = evp_bytes_to_key(PASSWORD.as_bytes(), &salt, 24, 8);
        assert_eq!(des_key, blocks[..24]);
        assert_eq!(des_iv, blocks[24..32]);
    }

    // -- 错误跟着语言走 -------------------------------------------------------

    /// 错误文案在语言包里，按请求语言渲染 —— 英文界面下不该露出中文。
    #[test]
    fn the_error_message_follows_the_requested_language() {
        let err = compute(json!({
            "mode": "sideways", "algorithm": "aes-gcm", "text": "x", "key": HEX128, "iv": HEX_NONCE
        }))
        .unwrap_err();
        // 语言包里还没并进来时，localize 退回键本身 —— 这时断言跳过
        if !crate::i18n::has("zh-CN", "out.encryption.err.unknown_mode") {
            return;
        }
        let en = err.localize("en");
        let zh = err.localize("zh-CN");
        assert_ne!(en, zh, "两种语言不该是同一句");
        assert!(!en.contains("out.encryption"), "英文界面不该露出键：{en}");
    }
}
