//! JWT（JWS）签名与验签 —— 上游 PR #1453 的移植。
//!
//! 上游那一版把整件事交给 npm 的 `jose` 包，界面是「选算法 → 填 payload →
//! 给密钥 → 签」，另外还给 `jwt-parser` 加了一张签名验证卡。
//!
//! ## 为什么放服务端
//!
//! 参考实现走浏览器端的 `crypto.subtle`。但 **`crypto.subtle` 只在安全上下文里
//! 存在**（HTTPS 或 localhost），本服务默认是 `http://0.0.0.0:8080` 裸 HTTP，
//! 局域网里用 `http://192.168.x.x:8080` 访问时 `window.crypto.subtle` 是
//! `undefined` —— 工具页会直接变成「算法不支持」。所以这里的密码学运算放在
//! Rust 侧：浏览器只负责收表单、发请求。
//!
//! 代价是**私钥会经过服务端**。本服务没有认证，私钥在这条链路上就是明文，
//! 只受 TLS 保护。这与已有的 `rsa-key-pair-generator`（密钥本来就在服务端生成）
//! 是同一个取舍。
//!
//! ## 支持的算法
//!
//! | 前缀 | 含义 | 密钥 |
//! |---|---|---|
//! | `HS` | HMAC with SHA-256/384/512 | 共享口令 |
//! | `RS` | RSASSA-PKCS1-v1_5 with SHA-256/384/512 | RSA 私钥 / 公钥 |
//! | `PS` | RSASSA-PSS with SHA-256/384/512（盐长 = 摘要长） | RSA 私钥 / 公钥 |
//! | `ES` | ECDSA over P-256 / P-384 / P-521 | EC 私钥 / 公钥 |
//!
//! `none`（不签名）**不支持** —— 一个「能验签」的工具如果能验 `alg=none` 的令牌，
//! 那它验出来的「有效」是假的。
//!
//! ## 签名值的字节形态
//!
//! JWS（RFC 7515 §3.1）规定签名段是：
//!
//! - HMAC：MAC 值本身；
//! - RSA：定长（模长）大端整数；
//! - ECDSA：**R‖S 拼接**（每个分量补齐到曲线域长），**不是** DER。
//!
//! 这一点很容易搞错：OpenSSL 与 Node 的 `sign()` 默认吐 DER，而 JWS 要的是
//! 裸拼接。所以这里用 `ecdsa` crate 的 `Signature::to_bytes()`（裸拼接），
//! 验签时再 `from_slice()` 回来。
//!
//! ## 密钥格式
//!
//! 私钥接受 PKCS#1（`RSA PRIVATE KEY`）、PKCS#8（`PRIVATE KEY`）、SEC1
//! （`EC PRIVATE KEY`）；公钥接受 SPKI（`PUBLIC KEY`）与 PKCS#1
//! （`RSA PUBLIC KEY`）。另外接受 JWK（RFC 7517）。
//!
//! **加密的私钥不支持**（`ENCRYPTED PRIVATE KEY` / 带 `Proc-Type` 的 PEM）：
//! 本工具不收口令，给出口令却不解密等于骗人，直接报错。
//!
//! ## 算法混淆的防护
//!
//! 验签时 `alg` 取自**令牌自己的 header**，所以必须防住「拿公钥当 HMAC 密钥」
//! 这一类攻击（RS256 → HS256 混淆）：
//!
//! - `HS*` 只接受共享口令，给了 PEM / JWK 一律报错；
//! - `RS*` / `PS*` / `ES*` 只接受公钥，给了口令一律报错。
//!
//! 宁可报错也不「猜着算」—— 算错的结果是「验签失败」，而报错的结果是
//! 「你用错了密钥类型」，后者才查得动。

use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64URL;
use base64::Engine as _;
use hmac::{Hmac, Mac};
use rsa::signature::{RandomizedSigner, SignatureEncoding, Signer, Verifier};
use rsa::traits::{PrivateKeyParts, PublicKeyParts};
use rsa::{BigUint, RsaPrivateKey, RsaPublicKey};
use serde_json::{json, Value};
use sha2::{Sha256, Sha384, Sha512};

use super::util::{bounded_u64, opt_str, req_str};
use super::{ToolError, ToolResult};

/// 令牌的最大长度（字符）。签名验证要重算一遍签名，几十万字符的令牌没有意义。
const MAX_TOKEN_LEN: usize = 64 * 1024;

/// 密钥材料的最大长度（字符）。
const MAX_KEY_LEN: usize = 64 * 1024;

/// 生成的 RSA 密钥默认位数。
const DEFAULT_RSA_BITS: u64 = 2048;

/// 生成的 RSA 密钥最大位数（4096 位要几秒，再大就没意义了）。
const MAX_RSA_BITS: u64 = 4096;

/* ---------------------------------------------------------------- 宏工具 */

// 宏必须写在用它的函数之前（Rust 的宏是文本展开，按出现顺序生效）。

/// HMAC 签名。HMAC 接受任意长度的密钥，所以 `new_from_slice` 的错误只可能是
/// 类型不对，`expect` 是安全的。
macro_rules! hmac_sign {
    ($digest:ty, $secret:expr, $data:expr) => {{
        let mut mac = <Hmac<$digest>>::new_from_slice($secret).expect("HMAC 接受任意长度的密钥");
        mac.update($data);
        mac.finalize().into_bytes().to_vec()
    }};
}

/// HMAC 验签（定长比较）。
macro_rules! hmac_verify {
    ($digest:ty, $secret:expr, $data:expr, $sig:expr) => {{
        let expected = hmac_sign!($digest, $secret, $data);
        expected.len() == $sig.len() && constant_time_eq(&expected, $sig)
    }};
}

/// RSASSA-PKCS1-v1_5 签名。
macro_rules! rsa_pkcs1_sign {
    ($digest:ty, $key:expr, $data:expr) => {
        rsa::pkcs1v15::SigningKey::<$digest>::new($key)
            .try_sign($data)
            .map(|s| s.to_bytes().to_vec())
            .map_err(|e| ToolError::invalid("out.jwt.err.sign_failed", &[("detail", &e.to_string())]))
    };
}

/// RSASSA-PSS 签名。盐长由 `SigningKey::new` 定成摘要长度 —— 这正是 JWA 的要求。
///
/// PSS 的盐是随机的，而 `rsa` 的 `Signer` 实现要开 `getrandom` 特性才有；
/// 这里直接用 `RandomizedSigner` 配自己的 `OsRng`（`rand_core 0.6` 的那个 ——
/// `rsa 0.9.10` 要的就是这一版的 trait），不用为一个功能去改依赖的
/// 特性开关（那会让 `rsa` 的 `getrandom` 影响到全项目）。
macro_rules! rsa_pss_sign {
    ($digest:ty, $key:expr, $data:expr) => {
        rsa::pss::SigningKey::<$digest>::new($key)
            .try_sign_with_rng(&mut rand_core::OsRng, $data)
            .map(|s| s.to_bytes().to_vec())
            .map_err(|e| ToolError::invalid("out.jwt.err.sign_failed", &[("detail", &e.to_string())]))
    };
}

/// RSASSA-PKCS1-v1_5 验签。
macro_rules! rsa_pkcs1_verify {
    ($digest:ty, $key:expr, $data:expr, $sig:expr) => {{
        let bytes: &[u8] = $sig;
        match rsa::pkcs1v15::Signature::try_from(bytes) {
            Ok(sig) => rsa::pkcs1v15::VerifyingKey::<$digest>::new($key)
                .verify($data, &sig)
                .is_ok(),
            Err(_) => false,
        }
    }};
}

/// RSASSA-PSS 验签。
macro_rules! rsa_pss_verify {
    ($digest:ty, $key:expr, $data:expr, $sig:expr) => {{
        let bytes: &[u8] = $sig;
        match rsa::pss::Signature::try_from(bytes) {
            Ok(sig) => rsa::pss::VerifyingKey::<$digest>::new($key)
                .verify($data, &sig)
                .is_ok(),
            Err(_) => false,
        }
    }};
}

/* ------------------------------------------------------------------ 算法 */

/// JWS 支持的签名算法。
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Alg {
    Hs256,
    Hs384,
    Hs512,
    Rs256,
    Rs384,
    Rs512,
    Ps256,
    Ps384,
    Ps512,
    Es256,
    Es384,
    Es512,
}

impl Alg {
    /// 全部算法，顺序与界面下拉框一致。
    pub const ALL: [Alg; 12] = [
        Alg::Hs256,
        Alg::Hs384,
        Alg::Hs512,
        Alg::Rs256,
        Alg::Rs384,
        Alg::Rs512,
        Alg::Ps256,
        Alg::Ps384,
        Alg::Ps512,
        Alg::Es256,
        Alg::Es384,
        Alg::Es512,
    ];

    /// 解析算法名。`none` 与未知算法一律返回 `None`。
    pub fn parse(raw: &str) -> Option<Self> {
        Some(match raw {
            "HS256" => Alg::Hs256,
            "HS384" => Alg::Hs384,
            "HS512" => Alg::Hs512,
            "RS256" => Alg::Rs256,
            "RS384" => Alg::Rs384,
            "RS512" => Alg::Rs512,
            "PS256" => Alg::Ps256,
            "PS384" => Alg::Ps384,
            "PS512" => Alg::Ps512,
            "ES256" => Alg::Es256,
            "ES384" => Alg::Es384,
            "ES512" => Alg::Es512,
            _ => return None,
        })
    }

    /// 算法名（写进 header 的 `alg`）。
    pub fn name(self) -> &'static str {
        match self {
            Alg::Hs256 => "HS256",
            Alg::Hs384 => "HS384",
            Alg::Hs512 => "HS512",
            Alg::Rs256 => "RS256",
            Alg::Rs384 => "RS384",
            Alg::Rs512 => "RS512",
            Alg::Ps256 => "PS256",
            Alg::Ps384 => "PS384",
            Alg::Ps512 => "PS512",
            Alg::Es256 => "ES256",
            Alg::Es384 => "ES384",
            Alg::Es512 => "ES512",
        }
    }

    /// 界面要显示的元信息。
    ///
    /// 下拉框、说明文字、该填哪种密钥 —— 全从这里出，
    /// 前端不再自己抄一份算法表（抄了就迟早对不上）。
    pub fn info(self) -> AlgInfo {
        match self {
            Alg::Hs256 => AlgInfo {
                alg: "HS256",
                family: "HMAC",
                key_type: "secret",
                key_desc: "256 bit (32 byte) secret",
                verify: "HMAC-SHA256",
            },
            Alg::Hs384 => AlgInfo {
                alg: "HS384",
                family: "HMAC",
                key_type: "secret",
                key_desc: "384 bit (48 byte) secret",
                verify: "HMAC-SHA384",
            },
            Alg::Hs512 => AlgInfo {
                alg: "HS512",
                family: "HMAC",
                key_type: "secret",
                key_desc: "512 bit (64 byte) secret",
                verify: "HMAC-SHA512",
            },
            Alg::Rs256 => AlgInfo {
                alg: "RS256",
                family: "RSA",
                key_type: "keypair",
                key_desc: "RSA key of at least 2048 bit modulus length",
                verify: "RSA-SHA256",
            },
            Alg::Rs384 => AlgInfo {
                alg: "RS384",
                family: "RSA",
                key_type: "keypair",
                key_desc: "RSA key of at least 2048 bit modulus length",
                verify: "RSA-SHA384",
            },
            Alg::Rs512 => AlgInfo {
                alg: "RS512",
                family: "RSA",
                key_type: "keypair",
                key_desc: "RSA key of at least 2048 bit modulus length",
                verify: "RSA-SHA512",
            },
            Alg::Ps256 => AlgInfo {
                alg: "PS256",
                family: "RSA-PSS",
                key_type: "keypair",
                key_desc: "RSA key of at least 2048 bit modulus length",
                verify: "RSA-PSS-SHA256",
            },
            Alg::Ps384 => AlgInfo {
                alg: "PS384",
                family: "RSA-PSS",
                key_type: "keypair",
                key_desc: "RSA key of at least 2048 bit modulus length",
                verify: "RSA-PSS-SHA384",
            },
            Alg::Ps512 => AlgInfo {
                alg: "PS512",
                family: "RSA-PSS",
                key_type: "keypair",
                key_desc: "RSA key of at least 2048 bit modulus length",
                verify: "RSA-PSS-SHA512",
            },
            Alg::Es256 => AlgInfo {
                alg: "ES256",
                family: "ECDSA",
                key_type: "keypair",
                key_desc: "NIST P-256 elliptic curve key",
                verify: "ECDSA-SHA256",
            },
            Alg::Es384 => AlgInfo {
                alg: "ES384",
                family: "ECDSA",
                key_type: "keypair",
                key_desc: "NIST P-384 elliptic curve key",
                verify: "ECDSA-SHA384",
            },
            Alg::Es512 => AlgInfo {
                alg: "ES512",
                family: "ECDSA",
                key_type: "keypair",
                key_desc: "NIST P-521 elliptic curve key",
                verify: "ECDSA-SHA512",
            },
        }
    }
}

/// 一个算法的展示信息。
pub struct AlgInfo {
    /// 算法名。
    pub alg: &'static str,
    /// 家族：HMAC / RSA / RSA-PSS / ECDSA。
    pub family: &'static str,
    /// 要哪种密钥：`secret`（共享口令）或 `keypair`（公私钥）。
    pub key_type: &'static str,
    /// 密钥要求的中文说明。
    pub key_desc: &'static str,
    /// 验签算法的名字。
    pub verify: &'static str,
}

/* -------------------------------------------------------------- 密钥材料 */

/// 用户给的密钥材料：要么是一段 PEM，要么是一段 JWK。
///
/// 类型本身是 pub 的（`convert` 的签名里要出现它），但两个变体的字段是私有的 ——
/// 外面只能把它当成「一份不透明的密钥材料」传给 [`parse_material`] 的下游函数。
pub enum Material {
    /// PEM 解出来的标签与 DER 内容。
    Pem { tag: String, der: Vec<u8> },
    /// JWK（JSON 对象）。
    Jwk(Value),
}

/// 一次请求里用户给的三样东西。
#[derive(Default, Clone)]
pub struct Keys {
    /// 共享口令（HMAC 用）。
    pub secret: Option<String>,
    /// 私钥（PEM 或 JWK）。
    pub private_key: Option<String>,
    /// 公钥（PEM 或 JWK）。
    pub public_key: Option<String>,
}

/// 把用户填的文本解析成密钥材料。
///
/// PEM 还是 JWK 看文本长什么样：`{` 开头当 JWK，否则当 PEM。
fn parse_material(text: &str) -> Result<Material, ToolError> {
    let text = text.trim();
    if text.is_empty() {
        return Err(ToolError::invalid("out.jwt.err.empty_key", &[]));
    }
    if text.len() > MAX_KEY_LEN {
        return Err(ToolError::invalid("out.jwt.err.key_too_long", &[]));
    }
    if text.starts_with('{') {
        let value: Value = serde_json::from_str(text).map_err(|e| {
            ToolError::invalid("out.jwt.err.invalid_jwk", &[("detail", &e.to_string())])
        })?;
        if !value.is_object() {
            return Err(ToolError::invalid("out.jwt.err.jwk_not_object", &[]));
        }
        return Ok(Material::Jwk(value));
    }
    let pem = pem::parse(text)
        .map_err(|e| ToolError::invalid("out.jwt.err.invalid_pem", &[("detail", &e.to_string())]))?;
    if pem.tag().contains("ENCRYPTED") {
        return Err(ToolError::invalid(
            "out.jwt.err.encrypted_key_unsupported",
            &[],
        ));
    }
    Ok(Material::Pem {
        tag: pem.tag().to_string(),
        der: pem.contents().to_vec(),
    })
}

/* ------------------------------------------------------------ base64url */

/// base64url 编码（无填充，JWS 的要求）。
fn b64u(bytes: &[u8]) -> String {
    B64URL.encode(bytes)
}

/// base64url 解码。失败返回 `None`（而不是抛错 —— 验签失败就是验签失败）。
fn unb64u(text: &str) -> Option<Vec<u8>> {
    B64URL.decode(text.as_bytes()).ok()
}

/* ---------------------------------------------------------------- 签名 */

/**
 * 生成 JOSE header。
 *
 * 字段顺序固定为 `alg` 在前、`typ` 在后 —— `serde_json` 的 map 默认按键排序，
 * `alg` < `typ` 正好就是这个顺序（`json!` 宏的写法不保证顺序，所以这里
 * 显式排序，别改成 `json!`）。
 */
fn jose_header(alg: Alg) -> String {
    let mut map = serde_json::Map::new();
    map.insert("alg".into(), Value::String(alg.name().into()));
    map.insert("typ".into(), Value::String("JWT".into()));
    Value::Object(map).to_string()
}

/// 签一个令牌。
///
/// `payload` 是**原始 JSON 文本**而不是解析后的值：JWS 签的是字节，
/// 重新序列化会改键序（`serde_json` 默认按键排序），签出来的东西就跟用户
/// 看到的不一样了。文本仍然要校验是合法 JSON。
pub fn sign(alg: Alg, payload: &str, keys: &Keys) -> Result<String, ToolError> {
    let payload = payload.trim();
    if payload.is_empty() {
        return Err(ToolError::invalid("out.jwt.err.empty_payload", &[]));
    }
    serde_json::from_str::<Value>(payload)
        .map_err(|e| ToolError::invalid("out.jwt.err.invalid_payload", &[("detail", &e.to_string())]))?;

    let header = jose_header(alg);
    let signing_input = format!("{}.{}", b64u(header.as_bytes()), b64u(payload.as_bytes()));

    let signature = match alg {
        Alg::Hs256 => {
            let secret = require_secret(keys)?;
            hmac_sign!(Sha256, secret.as_bytes(), signing_input.as_bytes())
        }
        Alg::Hs384 => {
            let secret = require_secret(keys)?;
            hmac_sign!(Sha384, secret.as_bytes(), signing_input.as_bytes())
        }
        Alg::Hs512 => {
            let secret = require_secret(keys)?;
            hmac_sign!(Sha512, secret.as_bytes(), signing_input.as_bytes())
        }
        Alg::Rs256 => {
            let key = rsa_private_key(&require_private_key(keys)?)?;
            rsa_pkcs1_sign!(Sha256, key, signing_input.as_bytes())?
        }
        Alg::Rs384 => {
            let key = rsa_private_key(&require_private_key(keys)?)?;
            rsa_pkcs1_sign!(Sha384, key, signing_input.as_bytes())?
        }
        Alg::Rs512 => {
            let key = rsa_private_key(&require_private_key(keys)?)?;
            rsa_pkcs1_sign!(Sha512, key, signing_input.as_bytes())?
        }
        Alg::Ps256 => {
            let key = rsa_private_key(&require_private_key(keys)?)?;
            rsa_pss_sign!(Sha256, key, signing_input.as_bytes())?
        }
        Alg::Ps384 => {
            let key = rsa_private_key(&require_private_key(keys)?)?;
            rsa_pss_sign!(Sha384, key, signing_input.as_bytes())?
        }
        Alg::Ps512 => {
            let key = rsa_private_key(&require_private_key(keys)?)?;
            rsa_pss_sign!(Sha512, key, signing_input.as_bytes())?
        }
        Alg::Es256 => {
            let key = p256_curve::private_key(&require_private_key(keys)?)?;
            p256_curve::sign(&key, signing_input.as_bytes())?
        }
        Alg::Es384 => {
            let key = p384_curve::private_key(&require_private_key(keys)?)?;
            p384_curve::sign(&key, signing_input.as_bytes())?
        }
        Alg::Es512 => {
            let key = p521_curve::private_key(&require_private_key(keys)?)?;
            p521_curve::sign(&key, signing_input.as_bytes())?
        }
    };

    Ok(format!("{signing_input}.{}", b64u(&signature)))
}

/// 验一个令牌。
///
/// 返回签名是否有效、header 与 payload。签名不匹配时 `valid` 为 `false`，
/// 但**不是**错误 —— 「验签失败」是结论，「令牌格式不对」才是错误。
pub fn verify(token: &str, keys: &Keys) -> Result<Verification, ToolError> {
    let token = token.trim();
    if token.is_empty() {
        return Err(ToolError::invalid("out.jwt.err.empty_token", &[]));
    }
    if token.len() > MAX_TOKEN_LEN {
        return Err(ToolError::invalid("out.jwt.err.token_too_long", &[]));
    }
    let parts: Vec<&str> = token.split('.').collect();
    if parts.len() != 3 {
        return Err(ToolError::invalid(
            "out.jwt.err.invalid_token_segments",
            &[("count", &parts.len().to_string())],
        ));
    }
    if parts[2].is_empty() {
        return Err(ToolError::invalid("out.jwt.err.empty_signature", &[]));
    }

    let header_bytes = unb64u(parts[0])
        .ok_or_else(|| ToolError::invalid("out.jwt.err.header_not_base64", &[]))?;
    let header: Value = serde_json::from_slice(&header_bytes)
        .map_err(|e| ToolError::invalid("out.jwt.err.invalid_header", &[("detail", &e.to_string())]))?;
    let alg_name = header
        .get("alg")
        .and_then(Value::as_str)
        .ok_or_else(|| ToolError::invalid("out.jwt.err.missing_alg", &[]))?;
    let alg = Alg::parse(alg_name)
        .ok_or_else(|| ToolError::invalid("out.jwt.err.unknown_algorithm", &[("alg", alg_name)]))?;

    let payload_bytes = unb64u(parts[1])
        .ok_or_else(|| ToolError::invalid("out.jwt.err.payload_not_base64", &[]))?;
    let payload: Value = serde_json::from_slice(&payload_bytes)
        .map_err(|e| ToolError::invalid("out.jwt.err.invalid_payload", &[("detail", &e.to_string())]))?;

    let signature = unb64u(parts[2])
        .ok_or_else(|| ToolError::invalid("out.jwt.err.signature_not_base64", &[]))?;
    let signing_input = format!("{}.{}", parts[0], parts[1]);

    let valid = match alg {
        Alg::Hs256 => {
            let secret = require_secret(keys)?;
            hmac_verify!(Sha256, secret.as_bytes(), signing_input.as_bytes(), &signature)
        }
        Alg::Hs384 => {
            let secret = require_secret(keys)?;
            hmac_verify!(Sha384, secret.as_bytes(), signing_input.as_bytes(), &signature)
        }
        Alg::Hs512 => {
            let secret = require_secret(keys)?;
            hmac_verify!(Sha512, secret.as_bytes(), signing_input.as_bytes(), &signature)
        }
        Alg::Rs256 => {
            let key = rsa_public_key(&require_public_key(keys)?)?;
            rsa_pkcs1_verify!(Sha256, key, signing_input.as_bytes(), &signature)
        }
        Alg::Rs384 => {
            let key = rsa_public_key(&require_public_key(keys)?)?;
            rsa_pkcs1_verify!(Sha384, key, signing_input.as_bytes(), &signature)
        }
        Alg::Rs512 => {
            let key = rsa_public_key(&require_public_key(keys)?)?;
            rsa_pkcs1_verify!(Sha512, key, signing_input.as_bytes(), &signature)
        }
        Alg::Ps256 => {
            let key = rsa_public_key(&require_public_key(keys)?)?;
            rsa_pss_verify!(Sha256, key, signing_input.as_bytes(), &signature)
        }
        Alg::Ps384 => {
            let key = rsa_public_key(&require_public_key(keys)?)?;
            rsa_pss_verify!(Sha384, key, signing_input.as_bytes(), &signature)
        }
        Alg::Ps512 => {
            let key = rsa_public_key(&require_public_key(keys)?)?;
            rsa_pss_verify!(Sha512, key, signing_input.as_bytes(), &signature)
        }
        Alg::Es256 => {
            let key = p256_curve::public_key(&require_public_key(keys)?)?;
            p256_curve::verify(&key, signing_input.as_bytes(), &signature)
        }
        Alg::Es384 => {
            let key = p384_curve::public_key(&require_public_key(keys)?)?;
            p384_curve::verify(&key, signing_input.as_bytes(), &signature)
        }
        Alg::Es512 => {
            let key = p521_curve::public_key(&require_public_key(keys)?)?;
            p521_curve::verify(&key, signing_input.as_bytes(), &signature)
        }
    };

    Ok(Verification {
        valid,
        alg: alg.name(),
        header,
        payload,
    })
}

/// 验签结果。
#[derive(Debug)]
pub struct Verification {
    /// 签名是否有效。
    pub valid: bool,
    /// 令牌 header 里声明的算法。
    pub alg: &'static str,
    /// 令牌 header。
    pub header: Value,
    /// 令牌 payload。
    pub payload: Value,
}

/* --------------------------------------------------- 密钥来源的统一入口 */

/// 取共享口令。给了私钥 / 公钥也要报错 —— 那说明用户用错了算法或用错了框。
fn require_secret(keys: &Keys) -> Result<String, ToolError> {
    if let Some(secret) = keys.secret.as_ref().filter(|s| !s.is_empty()) {
        return Ok(secret.clone());
    }
    if keys.private_key.as_ref().is_some_and(|k| !k.trim().is_empty())
        || keys.public_key.as_ref().is_some_and(|k| !k.trim().is_empty())
    {
        return Err(ToolError::invalid("out.jwt.err.secret_expected", &[]));
    }
    Err(ToolError::invalid("out.jwt.err.missing_secret", &[]))
}

/// 取私钥（PEM 或 JWK）。口令在这里一律拒绝。
fn require_private_key(keys: &Keys) -> Result<Material, ToolError> {
    let text = keys
        .private_key
        .as_ref()
        .filter(|k| !k.trim().is_empty())
        .ok_or_else(|| {
            if keys.secret.as_ref().is_some_and(|s| !s.is_empty()) {
                ToolError::invalid("out.jwt.err.private_key_expected", &[])
            } else {
                ToolError::invalid("out.jwt.err.missing_private_key", &[])
            }
        })?;
    parse_material(text)
}

/// 取公钥（PEM 或 JWK）。口令在这里一律拒绝。
fn require_public_key(keys: &Keys) -> Result<Material, ToolError> {
    let text = keys
        .public_key
        .as_ref()
        .filter(|k| !k.trim().is_empty())
        .ok_or_else(|| {
            if keys.secret.as_ref().is_some_and(|s| !s.is_empty()) {
                ToolError::invalid("out.jwt.err.public_key_expected", &[])
            } else {
                ToolError::invalid("out.jwt.err.missing_public_key", &[])
            }
        })?;
    parse_material(text)
}

/* ------------------------------------------------------------------ HMAC */

/// 逐字节比较，长度不同直接返回 false（不短路内容比较）。
fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

/* ------------------------------------------------------------------- RSA */

/// 从 PEM / JWK 里解出 RSA 私钥。
fn rsa_private_key(material: &Material) -> Result<RsaPrivateKey, ToolError> {
    match material {
        Material::Pem { tag, der } => {
            // PKCS#1 与 PKCS#8 都试一遍：标签不一定可靠（有人会自己改标签），
            // 靠 DER 试出来的结果才准。
            rsa::pkcs1::DecodeRsaPrivateKey::from_pkcs1_der(der)
                .or_else(|_| rsa::pkcs8::DecodePrivateKey::from_pkcs8_der(der))
                .map_err(|e| {
                    ToolError::invalid(
                        "out.jwt.err.invalid_private_key",
                        &[("kind", "RSA"), ("tag", tag), ("detail", &e.to_string())],
                    )
                })
        }
        Material::Jwk(jwk) => {
            if jwk.get("kty").and_then(Value::as_str) != Some("RSA") {
                return Err(ToolError::invalid("out.jwt.err.jwk_wrong_kty", &[("kty", "RSA")]));
            }
            let n = jwk_uint(jwk, "n")?;
            let e = jwk_uint(jwk, "e")?;
            let d = jwk_uint(jwk, "d")?;
            let (Some(p), Some(q)) = (jwk.get("p"), jwk.get("q")) else {
                return Err(ToolError::invalid("out.jwt.err.jwk_missing_primes", &[]));
            };
            let p = jwk_uint_value(p, "p")?;
            let q = jwk_uint_value(q, "q")?;
            RsaPrivateKey::from_components(n, e, d, vec![p, q]).map_err(|e| {
                ToolError::invalid(
                    "out.jwt.err.invalid_jwk_components",
                    &[("kind", "RSA"), ("detail", &e.to_string())],
                )
            })
        }
    }
}

/// 从 PEM / JWK 里解出 RSA 公钥。
fn rsa_public_key(material: &Material) -> Result<RsaPublicKey, ToolError> {
    match material {
        Material::Pem { tag, der } => {
            rsa::pkcs8::DecodePublicKey::from_public_key_der(der)
                .or_else(|_| rsa::pkcs1::DecodeRsaPublicKey::from_pkcs1_der(der))
                .map_err(|e| {
                    ToolError::invalid(
                        "out.jwt.err.invalid_public_key",
                        &[("kind", "RSA"), ("tag", tag), ("detail", &e.to_string())],
                    )
                })
        }
        Material::Jwk(jwk) => {
            if jwk.get("kty").and_then(Value::as_str) != Some("RSA") {
                return Err(ToolError::invalid("out.jwt.err.jwk_wrong_kty", &[("kty", "RSA")]));
            }
            let n = jwk_uint(jwk, "n")?;
            let e = jwk_uint(jwk, "e")?;
            RsaPublicKey::new(n, e).map_err(|e| {
                ToolError::invalid(
                    "out.jwt.err.invalid_jwk_components",
                    &[("kind", "RSA"), ("detail", &e.to_string())],
                )
            })
        }
    }
}

/// 取 JWK 里的一个 base64url 大整数分量（按名字取，如 `n` / `e` / `d`）。
fn jwk_uint(value: &Value, name: &str) -> Result<BigUint, ToolError> {
    let text = value.get(name).and_then(Value::as_str).unwrap_or_default();
    decode_jwk_uint(text, name)
}

/// 取 JWK 里**直接给出**的 base64url 大整数分量（`p` / `q` 那种）。
///
/// `label` 只是给错误消息用的名字 —— 分量名要出现在消息里，
/// 不能留空（空名字会拼出「JWK 的  不是合法的 base64url」这种话）。
fn jwk_uint_value(value: &Value, label: &str) -> Result<BigUint, ToolError> {
    decode_jwk_uint(value.as_str().unwrap_or_default(), label)
}

/// 解一个 base64url 的 JWK 分量。
fn decode_jwk_uint(text: &str, label: &str) -> Result<BigUint, ToolError> {
    let bytes = unb64u(text).ok_or_else(|| {
        ToolError::invalid("out.jwt.err.jwk_invalid_base64", &[("field", label)])
    })?;
    Ok(BigUint::from_bytes_be(&bytes))
}

/* ----------------------------------------------------------------- ECDSA */

/// 生成一条曲线上的六个动作：解私钥、解公钥、签名、验签、导 JWK。
///
/// 三条曲线（P-256 / P-384 / P-521）只有类型不同，要做的事完全一样，
/// 所以用宏生成三份 —— 逻辑只写一遍，不会出现「只有 P-256 那份忘了做某个
/// 检查」这种只有一份实现才有的坑。
macro_rules! ecdsa_curve {
    ($name:ident, $krate:ident, $curve:ty, $crv:literal, $field_len:expr) => {
        mod $name {
            use super::{Material, ToolError};
            use serde_json::Value;
            use $krate::ecdsa::{
                signature::{Signer, Verifier},
                Signature, SigningKey, VerifyingKey,
            };
            use $krate::pkcs8::{DecodePrivateKey, DecodePublicKey};

            /// JWK 里的曲线名。
            pub const CRV: &str = $crv;

            /// 这个曲线的域长（字节）。
            pub const FIELD_LEN: usize = $field_len;

            /// 解私钥：PEM（PKCS#8 / SEC1）或 JWK。
            pub fn private_key(material: &Material) -> Result<SigningKey, ToolError> {
                match material {
                    Material::Pem { tag, der } => {
                        if tag == "EC PRIVATE KEY" {
                            // SEC1：先解出标量，再交给 ecdsa
                            let secret = $krate::elliptic_curve::SecretKey::<$curve>::from_sec1_der(der)
                                .map_err(|e| {
                                    ToolError::invalid(
                                        "out.jwt.err.invalid_private_key",
                                        &[("kind", CRV), ("tag", tag), ("detail", &e.to_string())],
                                    )
                                })?;
                            return SigningKey::from_bytes(&secret.to_bytes()).map_err(|e| {
                                ToolError::invalid(
                                    "out.jwt.err.invalid_private_key",
                                    &[("kind", CRV), ("tag", tag), ("detail", &e.to_string())],
                                )
                            });
                        }
                        // 曲线不对时，这里报出来的是「期望的曲线 + 实际解出来的 OID」，
                        // 把话说清楚比丢一个裸 OID 给用户强。
                        SigningKey::from_pkcs8_der(der).map_err(|e| {
                            ToolError::invalid(
                                "out.jwt.err.invalid_private_key",
                                &[("kind", CRV), ("tag", tag), ("detail", &e.to_string())],
                            )
                        })
                    }
                    Material::Jwk(jwk) => {
                        if jwk.get("kty").and_then(Value::as_str) != Some("EC") {
                            return Err(ToolError::invalid("out.jwt.err.jwk_wrong_kty", &[("kty", "EC")]));
                        }
                        let crv = jwk.get("crv").and_then(Value::as_str).unwrap_or_default();
                        if crv != CRV {
                            return Err(ToolError::invalid(
                                "out.jwt.err.curve_mismatch",
                                &[("curve", crv), ("expected", CRV)],
                            ));
                        }
                        let d = super::jwk_field(jwk, "d")?;
                        SigningKey::from_slice(&d).map_err(|e| {
                            ToolError::invalid(
                                "out.jwt.err.invalid_jwk_components",
                                &[("kind", CRV), ("detail", &e.to_string())],
                            )
                        })
                    }
                }
            }

            /// 解公钥：PEM（SPKI）或 JWK。
            pub fn public_key(material: &Material) -> Result<VerifyingKey, ToolError> {
                match material {
                    Material::Pem { tag, der } => VerifyingKey::from_public_key_der(der).map_err(
                        |e| {
                            ToolError::invalid(
                                "out.jwt.err.invalid_public_key",
                                &[("kind", CRV), ("tag", tag), ("detail", &e.to_string())],
                            )
                        },
                    ),
                    Material::Jwk(jwk) => {
                        if jwk.get("kty").and_then(Value::as_str) != Some("EC") {
                            return Err(ToolError::invalid("out.jwt.err.jwk_wrong_kty", &[("kty", "EC")]));
                        }
                        let crv = jwk.get("crv").and_then(Value::as_str).unwrap_or_default();
                        if crv != CRV {
                            return Err(ToolError::invalid(
                                "out.jwt.err.curve_mismatch",
                                &[("curve", crv), ("expected", CRV)],
                            ));
                        }
                        let x = super::jwk_field(jwk, "x")?;
                        let y = super::jwk_field(jwk, "y")?;
                        // 坐标必须是这个域的长度。RFC 7518 §6.2.1.2 要求定长，
                        // 少了前导零的短坐标会让点落到曲线的别处去 ——
                        // 与其让验签给出一个莫名其妙的 false，不如当场说清楚。
                        if x.len() != FIELD_LEN || y.len() != FIELD_LEN {
                            return Err(ToolError::invalid(
                                "out.jwt.err.jwk_coordinate_length",
                                &[
                                    ("curve", CRV),
                                    ("expected", &FIELD_LEN.to_string()),
                                    ("x_len", &x.len().to_string()),
                                    ("y_len", &y.len().to_string()),
                                ],
                            ));
                        }
                        // JWK 给的是仿射坐标，SEC1 要的是未压缩点 0x04 || x || y
                        let mut sec1 = Vec::with_capacity(1 + x.len() + y.len());
                        sec1.push(0x04);
                        sec1.extend_from_slice(&x);
                        sec1.extend_from_slice(&y);
                        VerifyingKey::from_sec1_bytes(&sec1).map_err(|e| {
                            ToolError::invalid(
                                "out.jwt.err.invalid_jwk_components",
                                &[("kind", CRV), ("detail", &e.to_string())],
                            )
                        })
                    }
                }
            }

            /// 签名。摘要由曲线自己定（P-256→SHA-256 …），与 JWA 的配对一致。
            pub fn sign(key: &SigningKey, data: &[u8]) -> Result<Vec<u8>, ToolError> {
                // 显式标注类型：`Signer` 对同一把钥匙有多个实现（裸签名 / 带 OID
                // / DER），不标注编译器推不出来。
                let signature: Signature = key.try_sign(data).map_err(|e| {
                    ToolError::invalid("out.jwt.err.sign_failed", &[("detail", &e.to_string())])
                })?;
                Ok(signature.to_bytes().to_vec())
            }

            /// 验签。签名段必须是 R‖S 的裸拼接（不是 DER）。
            pub fn verify(key: &VerifyingKey, data: &[u8], signature: &[u8]) -> bool {
                match Signature::from_slice(signature) {
                    Ok(sig) => key.verify(data, &sig).is_ok(),
                    Err(_) => false,
                }
            }

            /// 私钥的 JWK（RFC 7518 §6.2）。
            pub fn private_jwk(key: &SigningKey) -> Value {
                let mut map = serde_json::Map::new();
                map.insert("kty".into(), Value::String("EC".into()));
                map.insert("crv".into(), Value::String(CRV.into()));
                let (x, y) = coordinates(key.verifying_key());
                map.insert("x".into(), Value::String(super::b64u(&x)));
                map.insert("y".into(), Value::String(super::b64u(&y)));
                let d = key.to_bytes();
                map.insert("d".into(), Value::String(super::b64u(&d)));
                Value::Object(map)
            }

            /// 公钥的 JWK。
            pub fn public_jwk(key: &VerifyingKey) -> Value {
                let mut map = serde_json::Map::new();
                map.insert("kty".into(), Value::String("EC".into()));
                map.insert("crv".into(), Value::String(CRV.into()));
                let (x, y) = coordinates(key);
                map.insert("x".into(), Value::String(super::b64u(&x)));
                map.insert("y".into(), Value::String(super::b64u(&y)));
                Value::Object(map)
            }

            /// 私钥的 PKCS#8 PEM。
            pub fn private_pem(key: &SigningKey) -> Result<String, ToolError> {
                $krate::pkcs8::EncodePrivateKey::to_pkcs8_pem(
                    key,
                    $krate::pkcs8::LineEnding::LF,
                )
                .map(|p| p.to_string())
                .map_err(|e| ToolError::Internal(format!("EC 私钥 PEM 编码失败: {e}")))
            }

            /// 公钥的 SPKI PEM。
            pub fn public_pem(key: &VerifyingKey) -> Result<String, ToolError> {
                $krate::pkcs8::EncodePublicKey::to_public_key_pem(
                    key,
                    $krate::pkcs8::LineEnding::LF,
                )
                .map(|p| p.to_string())
                .map_err(|e| ToolError::Internal(format!("EC 公钥 PEM 编码失败: {e}")))
            }

            /// PEM ↔ JWK 互转：给一份密钥材料，两种表示一起给回去。
            pub fn convert(
                kind: super::KeyKind,
                material: &Material,
            ) -> Result<super::Converted, ToolError> {
                match kind {
                    super::KeyKind::Private => {
                        let key = private_key(material)?;
                        let public = key.verifying_key();
                        Ok(super::Converted {
                            pem: private_pem(&key)?,
                            jwk: private_jwk(&key),
                            public_pem: Some(public_pem(public)?),
                            public_jwk: Some(public_jwk(public)),
                        })
                    }
                    super::KeyKind::Public => {
                        let key = public_key(material)?;
                        Ok(super::Converted {
                            pem: public_pem(&key)?,
                            jwk: public_jwk(&key),
                            public_pem: None,
                            public_jwk: None,
                        })
                    }
                }
            }

            /// 从未压缩的 SEC1 点里切出仿射坐标 (x, y)。
            fn coordinates(key: &VerifyingKey) -> (Vec<u8>, Vec<u8>) {
                let point = key.to_sec1_point(false);
                let bytes = point.as_bytes();
                let half = bytes.len() / 2;
                (bytes[1..1 + half].to_vec(), bytes[1 + half..].to_vec())
            }
        }
    };
}

ecdsa_curve!(p256_curve, p256, p256::NistP256, "P-256", 32);
ecdsa_curve!(p384_curve, p384, p384::NistP384, "P-384", 48);
ecdsa_curve!(p521_curve, p521, p521::NistP521, "P-521", 66);

/// 取 JWK 里一个定长的域分量（base64url）。
fn jwk_field(jwk: &Value, name: &str) -> Result<Vec<u8>, ToolError> {
    let text = jwk.get(name).and_then(Value::as_str).unwrap_or_default();
    let bytes = unb64u(text).ok_or_else(|| {
        ToolError::invalid("out.jwt.err.jwk_invalid_base64", &[("field", name)])
    })?;
    if bytes.is_empty() {
        return Err(ToolError::invalid("out.jwt.err.jwk_missing_field", &[("field", name)]));
    }
    Ok(bytes)
}

/* ------------------------------------------------------------ 密钥生成 */

/// 生成一对密钥。
pub struct Generated {
    /// 私钥（PKCS#8 PEM）。
    pub private_key: String,
    /// 公钥（SPKI PEM）。
    pub public_key: String,
    /// 私钥的 JWK。
    pub private_jwk: Value,
    /// 公钥的 JWK。
    pub public_jwk: Value,
}

/// 生成密钥对。HMAC 没有密钥对（它是对称的），所以报错。
pub fn generate(alg: Alg, bits: u64) -> Result<Generated, ToolError> {
    match alg {
        Alg::Hs256 | Alg::Hs384 | Alg::Hs512 => {
            Err(ToolError::invalid("out.jwt.err.hmac_no_key_pair", &[]))
        }
        Alg::Rs256 | Alg::Rs384 | Alg::Rs512 | Alg::Ps256 | Alg::Ps384 | Alg::Ps512 => {
            generate_rsa(bits)
        }
        Alg::Es256 => generate_ec(Alg::Es256),
        Alg::Es384 => generate_ec(Alg::Es384),
        Alg::Es512 => generate_ec(Alg::Es512),
    }
}

/// 生成 RSA 密钥对。
fn generate_rsa(bits: u64) -> Result<Generated, ToolError> {
    use rand_core::OsRng;
    let bits = bits.clamp(1024, MAX_RSA_BITS) as usize;
    let key = RsaPrivateKey::new(&mut OsRng, bits)
        .map_err(|e| ToolError::Internal(format!("RSA 密钥生成失败: {e}")))?;
    let public = key.to_public_key();

    let private_pem =
        rsa::pkcs8::EncodePrivateKey::to_pkcs8_pem(&key, rsa::pkcs8::LineEnding::LF)
            .map_err(|e| ToolError::Internal(format!("私钥 PEM 编码失败: {e}")))?;
    let public_pem =
        rsa::pkcs8::EncodePublicKey::to_public_key_pem(&public, rsa::pkcs8::LineEnding::LF)
            .map_err(|e| ToolError::Internal(format!("公钥 PEM 编码失败: {e}")))?;

    Ok(Generated {
        private_key: private_pem.to_string(),
        public_key: public_pem.to_string(),
        private_jwk: rsa_private_jwk(&key),
        public_jwk: rsa_public_jwk(&public),
    })
}

/// RSA 私钥的 JWK。
fn rsa_private_jwk(key: &RsaPrivateKey) -> Value {
    let primes = key.primes();
    let (p, q) = (primes[0].clone(), primes[1].clone());
    let d = key.d().clone();
    let mut map = serde_json::Map::new();
    map.insert("kty".into(), Value::String("RSA".into()));
    map.insert("n".into(), jwk_int(key.n()));
    map.insert("e".into(), jwk_int(key.e()));
    map.insert("d".into(), jwk_int(&d));
    map.insert("p".into(), jwk_int(&p));
    map.insert("q".into(), jwk_int(&q));
    // dp / dq / qi 是 CRT 参数，RFC 7518 里是可选的，但给了更完整
    map.insert("dp".into(), jwk_int(&(&d % &(&p - &BigUint::from(1u32)))));
    map.insert("dq".into(), jwk_int(&(&d % &(&q - &BigUint::from(1u32)))));
    if let Some(qi) = mod_inverse(&q, &p) {
        map.insert("qi".into(), jwk_int(&qi));
    }
    Value::Object(map)
}

/// RSA 公钥的 JWK。
fn rsa_public_jwk(key: &RsaPublicKey) -> Value {
    let mut map = serde_json::Map::new();
    map.insert("kty".into(), Value::String("RSA".into()));
    map.insert("n".into(), jwk_int(key.n()));
    map.insert("e".into(), jwk_int(key.e()));
    Value::Object(map)
}

/// 大整数 → base64url（JWK 的整数一律是大端无符号）。
fn jwk_int(value: &BigUint) -> Value {
    Value::String(b64u(&value.to_bytes_be()))
}

/// RSA 私钥的 PKCS#8 PEM。
fn rsa_private_pem(key: &RsaPrivateKey) -> Result<String, ToolError> {
    rsa::pkcs8::EncodePrivateKey::to_pkcs8_pem(key, rsa::pkcs8::LineEnding::LF)
        .map(|p| p.to_string())
        .map_err(|e| ToolError::Internal(format!("私钥 PEM 编码失败: {e}")))
}

/// RSA 公钥的 SPKI PEM。
fn rsa_public_pem(key: &RsaPublicKey) -> Result<String, ToolError> {
    rsa::pkcs8::EncodePublicKey::to_public_key_pem(key, rsa::pkcs8::LineEnding::LF)
        .map(|p| p.to_string())
        .map_err(|e| ToolError::Internal(format!("公钥 PEM 编码失败: {e}")))
}

/// 生成 EC 密钥对。
fn generate_ec(alg: Alg) -> Result<Generated, ToolError> {
    use rand::Rng;

    // 私钥是域里的一个标量：随机取域长个字节，若不合法（0 或 ≥ n）就重取。
    // P-521 的 n 略小于 2^521，所以 66 字节随机数大约有 1/128 的概率越界，
    // 重取几次就过去了。
    let mut rng = rand::rng();
    let (private_pem, public_pem, private_jwk, public_jwk) = match alg {
        Alg::Es256 => {
            let mut bytes = [0u8; 32];
            let key = loop {
                rng.fill_bytes(&mut bytes);
                if let Ok(key) = p256::ecdsa::SigningKey::from_slice(&bytes) {
                    break key;
                }
            };
            let pem = p256::pkcs8::EncodePrivateKey::to_pkcs8_pem(
                &key,
                p256::pkcs8::LineEnding::LF,
            )
            .map_err(|e| ToolError::Internal(format!("EC 私钥编码失败: {e}")))?;
            let public_pem = p256::pkcs8::EncodePublicKey::to_public_key_pem(
                key.verifying_key(),
                p256::pkcs8::LineEnding::LF,
            )
            .map_err(|e| ToolError::Internal(format!("EC 公钥编码失败: {e}")))?;
            (
                pem.to_string(),
                public_pem.to_string(),
                p256_curve::private_jwk(&key),
                p256_curve::public_jwk(key.verifying_key()),
            )
        }
        Alg::Es384 => {
            let mut bytes = [0u8; 48];
            let key = loop {
                rng.fill_bytes(&mut bytes);
                if let Ok(key) = p384::ecdsa::SigningKey::from_slice(&bytes) {
                    break key;
                }
            };
            let pem = p384::pkcs8::EncodePrivateKey::to_pkcs8_pem(
                &key,
                p384::pkcs8::LineEnding::LF,
            )
            .map_err(|e| ToolError::Internal(format!("EC 私钥编码失败: {e}")))?;
            let public_pem = p384::pkcs8::EncodePublicKey::to_public_key_pem(
                key.verifying_key(),
                p384::pkcs8::LineEnding::LF,
            )
            .map_err(|e| ToolError::Internal(format!("EC 公钥编码失败: {e}")))?;
            (
                pem.to_string(),
                public_pem.to_string(),
                p384_curve::private_jwk(&key),
                p384_curve::public_jwk(key.verifying_key()),
            )
        }
        Alg::Es512 => {
            let mut bytes = [0u8; 66];
            let key = loop {
                rng.fill_bytes(&mut bytes);
                if let Ok(key) = p521::ecdsa::SigningKey::from_slice(&bytes) {
                    break key;
                }
            };
            let pem = p521::pkcs8::EncodePrivateKey::to_pkcs8_pem(
                &key,
                p521::pkcs8::LineEnding::LF,
            )
            .map_err(|e| ToolError::Internal(format!("EC 私钥编码失败: {e}")))?;
            let public_pem = p521::pkcs8::EncodePublicKey::to_public_key_pem(
                key.verifying_key(),
                p521::pkcs8::LineEnding::LF,
            )
            .map_err(|e| ToolError::Internal(format!("EC 公钥编码失败: {e}")))?;
            (
                pem.to_string(),
                public_pem.to_string(),
                p521_curve::private_jwk(&key),
                p521_curve::public_jwk(key.verifying_key()),
            )
        }
        _ => unreachable!("只有 ES* 才走 ECDSA"),
    };

    Ok(Generated {
        private_key: private_pem,
        public_key: public_pem,
        private_jwk,
        public_jwk,
    })
}

/* --------------------------------------------------------- 密钥格式转换 */

/// 要转换的是私钥还是公钥。
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum KeyKind {
    Private,
    Public,
}

/// 转换结果：一份密钥的两种表示。
#[derive(Debug)]
pub struct Converted {
    /// PEM（私钥是 PKCS#8，公钥是 SPKI）。
    pub pem: String,
    /// JWK。
    pub jwk: Value,
    /// 从私钥顺带导出的公钥 PEM。转公钥时没有（公钥推不出私钥）。
    pub public_pem: Option<String>,
    /// 从私钥顺带导出的公钥 JWK。
    pub public_jwk: Option<Value>,
}

/// PEM ↔ JWK 互转。
///
/// 两种表示说的是同一把钥匙，所以一次调用把两种都给回去 ——
/// 前端不用先判断输入是哪一种，填了 PEM 就同步出 JWK，填了 JWK 就同步出 PEM。
/// 上游 PR #1453 的界面正是这么做的（两个输入框双向 watch）。
///
/// 给的是私钥时，顺带把公钥也导出来：公钥本来就是私钥的一部分，
/// 用户粘进来一把私钥却只想要个公钥是很常见的用法。
pub fn convert(alg: Alg, kind: KeyKind, material: &Material) -> Result<Converted, ToolError> {
    match alg {
        Alg::Hs256 | Alg::Hs384 | Alg::Hs512 => {
            Err(ToolError::invalid("out.jwt.err.hmac_nothing_to_convert", &[]))
        }
        Alg::Rs256 | Alg::Rs384 | Alg::Rs512 | Alg::Ps256 | Alg::Ps384 | Alg::Ps512 => {
            match kind {
                KeyKind::Private => {
                    let key = rsa_private_key(material)?;
                    let public = key.to_public_key();
                    Ok(Converted {
                        pem: rsa_private_pem(&key)?,
                        jwk: rsa_private_jwk(&key),
                        public_pem: Some(rsa_public_pem(&public)?),
                        public_jwk: Some(rsa_public_jwk(&public)),
                    })
                }
                KeyKind::Public => {
                    let key = rsa_public_key(material)?;
                    Ok(Converted {
                        pem: rsa_public_pem(&key)?,
                        jwk: rsa_public_jwk(&key),
                        public_pem: None,
                        public_jwk: None,
                    })
                }
            }
        }
        Alg::Es256 => p256_curve::convert(kind, material),
        Alg::Es384 => p384_curve::convert(kind, material),
        Alg::Es512 => p521_curve::convert(kind, material),
    }
}

/// 模逆元（扩展欧几里得）。
///
/// `BigUint` 只能表示非负数，而扩展欧几里得里的系数会变负，所以用
/// `(绝对值, 是否为负)` 这样的二元组表示带符号的中间结果。
fn mod_inverse(a: &BigUint, m: &BigUint) -> Option<BigUint> {
    let zero = BigUint::from(0u32);
    if *m == zero {
        return None;
    }
    let mut r0 = m.clone();
    let mut r1 = a.clone() % m;
    let mut t0 = (BigUint::from(0u32), false);
    let mut t1 = (BigUint::from(1u32), false);
    while r1 != zero {
        let q = &r0 / &r1;
        let r = &r0 % &r1;
        let qt = &q * &t1.0;
        let t = signed_sub(t0, (qt, t1.1));
        r0 = r1;
        r1 = r;
        t0 = t1;
        t1 = t;
    }
    if r0 != BigUint::from(1u32) {
        // 不互质，没有逆元
        return None;
    }
    let (value, negative) = t0;
    let reduced = value % m;
    Some(if negative && reduced != zero {
        m - reduced
    } else {
        reduced
    })
}

/// 带符号整数的减法：`(值, 是否为负) - (值, 是否为负)`。
fn signed_sub(a: (BigUint, bool), b: (BigUint, bool)) -> (BigUint, bool) {
    match (a.1, b.1) {
        (false, false) => {
            if a.0 >= b.0 {
                (a.0 - b.0, false)
            } else {
                (b.0 - a.0, true)
            }
        }
        (false, true) => (a.0 + b.0, false),
        (true, false) => (a.0 + b.0, true),
        (true, true) => {
            if b.0 >= a.0 {
                (b.0 - a.0, false)
            } else {
                (a.0 - b.0, true)
            }
        }
    }
}

/* ------------------------------------------------------------- HTTP 入口 */

/// 处理一次 `/api/jwt/{action}` 请求。
pub async fn handle(action: &str, payload: Value) -> ToolResult {
    match action {
        "sign" => sign_request(payload).await,
        "verify" => verify_request(payload).await,
        "keygen" => keygen_request(payload).await,
        "convert" => convert_request(payload).await,
        other => Err(ToolError::invalid("out.jwt.err.unknown_action", &[("action", other)])),
    }
}

/// 算法清单（给前端的下拉框）。
///
/// 服务端是唯一事实来源：前端不再自己抄一份算法表 ——
/// 抄了就迟早对不上（上游加算法、我们改支持范围时，前端会撒谎）。
///
/// `unsupported` 列的是**知道但做不了**的：ES256K 要 secp256k1 曲线，
/// 离线依赖里没有对应的 crate。硬凑一个别的曲线出来会给出与别人不互通的
/// 签名 —— 宁可明说没有。
pub fn algorithms() -> Value {
    let list: Vec<Value> = Alg::ALL
        .iter()
        .map(|alg| {
            let info = alg.info();
            json!({
                "alg": info.alg,
                "family": info.family,
                "keyType": info.key_type,
                "keyDesc": info.key_desc,
                "verify": info.verify,
            })
        })
        .collect();
    json!({
        "algorithms": list,
        "unsupported": [{
            "alg": "ES256K",
            "verify": "ECDSA-SHA256(secp256k1)",
            "reason": "secp256k1 曲线未内置",
        }],
    })
}

/// 从请求里取出算法。
fn request_alg(payload: &Value) -> Result<Alg, ToolError> {
    let raw = req_str(payload, "alg")?;
    Alg::parse(raw)
        .ok_or_else(|| ToolError::invalid("out.jwt.err.unknown_algorithm", &[("alg", raw)]))
}

/// 从请求里取出密钥材料。
fn request_keys(payload: &Value) -> Keys {
    Keys {
        secret: opt_str(payload, "secret").map(str::to_string),
        private_key: opt_str(payload, "privateKey").map(str::to_string),
        public_key: opt_str(payload, "publicKey").map(str::to_string),
    }
}

/// 签名。
async fn sign_request(payload: Value) -> ToolResult {
    let alg = request_alg(&payload)?;
    let body = req_str(&payload, "payload")?.to_string();
    let keys = request_keys(&payload);
    let token = sign(alg, &body, &keys)?;
    let (header, claims) = split_token(&token)?;
    Ok(json!({
        "token": token,
        "header": header,
        "payload": claims,
    }))
}

/// 验签。
async fn verify_request(payload: Value) -> ToolResult {
    let token = req_str(&payload, "token")?.to_string();
    let keys = request_keys(&payload);
    let result = verify(&token, &keys)?;
    Ok(json!({
        "valid": result.valid,
        "alg": result.alg,
        "header": result.header,
        "payload": result.payload,
    }))
}

/// 生成密钥对。
async fn keygen_request(payload: Value) -> ToolResult {
    let alg = request_alg(&payload)?;
    let bits = bounded_u64(&payload, "bits", DEFAULT_RSA_BITS, 1024, MAX_RSA_BITS);
    // RSA 密钥生成是 CPU 密集的（2048 位约 0.1 秒，4096 位要好几秒），
    // 丢到 blocking 线程池，别占住 actix 的 worker。
    super::util::blocking(move || {
        let generated = generate(alg, bits)?;
        Ok(json!({
            "privateKey": generated.private_key,
            "publicKey": generated.public_key,
            "privateKeyJwk": generated.private_jwk,
            "publicKeyJwk": generated.public_jwk,
        }))
    })
    .await
}

/// PEM ↔ JWK 互转。
async fn convert_request(payload: Value) -> ToolResult {
    let alg = request_alg(&payload)?;
    let kind = match opt_str(&payload, "kind").unwrap_or("private") {
        "private" => KeyKind::Private,
        "public" => KeyKind::Public,
        other => {
            return Err(ToolError::invalid(
                "out.jwt.err.unknown_key_kind",
                &[("kind", other)],
            ))
        }
    };
    let text = req_str(&payload, "material")?.to_string();
    let material = parse_material(&text)?;
    let converted = convert(alg, kind, &material)?;
    Ok(json!({
        "pem": converted.pem,
        "jwk": converted.jwk,
        "publicPem": converted.public_pem,
        "publicJwk": converted.public_jwk,
    }))
}

/// 把令牌拆成 header 与 payload（用来回显给界面）。
fn split_token(token: &str) -> Result<(Value, Value), ToolError> {
    let parts: Vec<&str> = token.split('.').collect();
    let header =
        serde_json::from_slice(&unb64u(parts[0]).unwrap_or_default()).unwrap_or(Value::Null);
    let payload =
        serde_json::from_slice(&unb64u(parts[1]).unwrap_or_default()).unwrap_or(Value::Null);
    Ok((header, payload))
}

#[cfg(test)]
mod tests {
    use super::*;
    use rsa::pkcs8::{DecodePrivateKey, DecodePublicKey};

    /// 测试向量来自 Node 的 `crypto`（底层是 OpenSSL），是公认权威的实现。
    /// 公钥是生成后固定下来的。
    ///
    /// **向量文件里只有公开材料**：共享口令、公钥、OpenSSL 签出来的签名。
    /// 私钥一个都不存 —— 仓库是公开的，GitHub 对公开仓库默认开着 push protection，
    /// 一段货真价实的私钥文本就能把**第一次推送整个拦下来**；而且这把钥匙
    /// 本来就是 `fixtures/generate-jwt-vectors.js` 现生成的一次性货色，
    /// 互操作性的证据是「OpenSSL 签的签名，我们验得过」加上对应的公钥，
    /// 私钥并不在证据链上。测试要私钥的地方，一律现生成一把（见 `generated()`）。
    ///
    /// **只有确定性的算法能逐字节比对**：HMAC 与 RSA PKCS#1 v1.5 是确定的，
    /// 而 RSA-PSS 的盐是随机的、ECDSA 的临时点 k 也是随机的（RFC 6979 的
    /// 确定性 k 只有 RustCrypto 用）。所以 PSS/ECDSA 的向量用来做「验签」测试
    /// —— OpenSSL 签的能验过，这本身就是最强的互操作性证据。
    ///
    /// （PKCS#1 v1.5 那组也从「重签一遍、逐字节比对」改成了「验签」——
    /// 对它来说这两件事是一回事：EM 的编码是唯一的，同一把钥匙、同一段消息，
    /// 合法签名只有一个字节序列，验得过就说明我们签出来的跟 OpenSSL 的一模一样。）
    const VECTORS: &str = include_str!("fixtures/jwt_vectors.json");

    fn all() -> Value {
        serde_json::from_str(VECTORS).expect("向量文件是合法 JSON")
    }

    /// 某个算法的向量条目。
    fn vector(alg: &str) -> Value {
        all()["vectors"][alg].clone()
    }

    /// 向量里的 payload 文本。
    fn payload() -> String {
        all()["payload"].as_str().unwrap().to_string()
    }

    /// 错误的键。
    ///
    /// 错误是「带键」的：文案在语言包里，键本身只有一串路径。
    /// 所以断言「报的是哪个错」要断言**键**，而不是 `to_string()`。
    fn err_key(err: &ToolError) -> &'static str {
        match err {
            ToolError::InvalidKeyed { key, .. } => key,
            other => panic!("应当是 InvalidKeyed，得到 {other:?}"),
        }
    }

    /// 断言错误是「带键」的、键就是期望的那个，并且中文文案提到了某个词。
    ///
    /// 键是语言无关的 —— 改文案不该连测试一起改；
    /// 中文那句只查「有没有提到这个词」，换个说法也不会红。
    fn assert_err(err: &ToolError, want_key: &str, zh_hint: &str) {
        assert_eq!(err_key(err), want_key, "{err:?}");
        if crate::i18n::has("zh-CN", want_key) {
            let msg = err.localize("zh-CN");
            assert!(msg.contains(zh_hint), "中文文案里该提到「{zh_hint}」：{msg}");
        }
    }

    /// 某个算法对应的密钥材料。
    ///
    /// **这里只有公开的那一半**（HMAC 是共享口令）——
    /// 非对称算法的私钥不在向量文件里（见本模块开头的说明），
    /// 要私钥的测试自己调 `generated()` 现生成一把。
    fn keys(alg: &str) -> Keys {
        let all = all();
        if alg.starts_with("HS") {
            return Keys {
                secret: all["secret"].as_str().map(str::to_string),
                ..Default::default()
            };
        }
        if alg.starts_with("RS") || alg.starts_with("PS") {
            return Keys {
                public_key: all["rsaPublicPem"].as_str().map(str::to_string),
                ..Default::default()
            };
        }
        let crv = match alg {
            "ES256" => "P-256",
            "ES384" => "P-384",
            _ => "P-521",
        };
        Keys {
            public_key: all["ecPublicPem"][crv].as_str().map(str::to_string),
            ..Default::default()
        }
    }

    /// 现生成一把密钥对 —— 测试要私钥时用这个。
    ///
    /// 向量文件里不放私钥（仓库公开，push protection 会拦推送），
    /// 所以要私钥的地方就在这里现生成一把：一次性货色，用完即弃。
    /// `bits` 只对 RSA 有意义（EC 的曲线由算法定死了）。
    ///
    /// RSA 用 2048 位：PS512 的盐长 = 摘要长 = 64 字节，
    /// 加上摘要与域分隔一共要 130 字节，模长 1024 位（128 字节）装不下。
    fn generated(alg: Alg) -> Keys {
        let g = generate(alg, 2048).unwrap();
        Keys {
            private_key: Some(g.private_key),
            public_key: Some(g.public_key),
            ..Default::default()
        }
    }

    /// 向量里的完整令牌（签名输入 + 签名）。
    fn token(alg: &str) -> String {
        let v = vector(alg);
        format!(
            "{}.{}",
            v["input"].as_str().unwrap(),
            v["sig"].as_str().unwrap()
        )
    }

    /// 签名输入（header.payload）。
    fn signing_input(alg: &str) -> String {
        vector(alg)["input"].as_str().unwrap().to_string()
    }

    #[test]
    fn header_is_alg_then_typ() {
        assert_eq!(jose_header(Alg::Hs256), r#"{"alg":"HS256","typ":"JWT"}"#);
        assert_eq!(jose_header(Alg::Es512), r#"{"alg":"ES512","typ":"JWT"}"#);
    }

    #[test]
    fn base64url_has_no_padding() {
        assert_eq!(b64u(b"a"), "YQ");
        assert_eq!(b64u(b"ab"), "YWI");
        assert_eq!(b64u(b"abc"), "YWJj");
        assert_eq!(unb64u("YQ").as_deref(), Some(&b"a"[..]));
        assert!(unb64u("YQ==").is_none(), "带填充的不接受");
    }

    #[test]
    fn hmac_signatures_match_openssl() {
        for alg in ["HS256", "HS384", "HS512"] {
            let signed = sign(Alg::parse(alg).unwrap(), &payload(), &keys(alg)).unwrap();
            assert_eq!(signed, token(alg), "{alg} 的签名与 OpenSSL 不一致");
        }
    }

    /// OpenSSL 签的 PKCS#1 v1.5 签名必须验得过。
    ///
    /// 原来是「用向量里的私钥重签一遍、跟 OpenSSL 的逐字节比对」——
    /// 现在向量里没有私钥了（见本模块开头的说明），改成验签。
    /// **对 PKCS#1 v1.5 来说这两件事是一回事**：EM 的编码是唯一的
    /// （0x00 || 0x01 || 0xFF… || 0x00 || DigestInfo），同一把钥匙、
    /// 同一段消息，合法签名只有一个字节序列 —— 验得过，
    /// 就说明我们签出来的跟 OpenSSL 的一模一样。
    #[test]
    fn rsa_pkcs1_signatures_from_openssl_verify() {
        for alg in ["RS256", "RS384", "RS512"] {
            let result = verify(&token(alg), &keys(alg)).unwrap();
            assert!(result.valid, "{alg} 的 OpenSSL 签名应当能验过");
            assert_eq!(result.alg, alg);
        }
    }

    #[test]
    fn pss_signatures_from_openssl_verify() {
        // PSS 的盐是随机的，签不出同样的字节，但 OpenSSL 签的必须能验过
        for alg in ["PS256", "PS384", "PS512"] {
            let result = verify(&token(alg), &keys(alg)).unwrap();
            assert!(result.valid, "{alg} 的 OpenSSL 签名应当能验过");
            assert_eq!(result.alg, alg);
        }
    }

    #[test]
    fn ecdsa_signatures_from_openssl_verify() {
        // ECDSA 的临时点随机，同理
        for alg in ["ES256", "ES384", "ES512"] {
            let result = verify(&token(alg), &keys(alg)).unwrap();
            assert!(result.valid, "{alg} 的 OpenSSL 签名应当能验过");
            assert_eq!(result.alg, alg);
        }
    }

    #[test]
    fn pss_salt_length_is_the_digest_length() {
        // JWA 规定 PSS 的盐长 = 摘要长。用盐长 0 签一个，验签必须失败 ——
        // 这说明验签端确实在校验盐长，而不是「什么 PSS 都收」。
        // 钥匙现生成（向量文件里没有私钥 —— 见本模块开头的说明）。
        let g = generate(Alg::Rs256, 1024).unwrap();
        let private = RsaPrivateKey::from_pkcs8_der(
            pem::parse(g.private_key.as_str())
                .unwrap()
                .contents(),
        )
        .unwrap();
        let public = RsaPublicKey::from_public_key_der(
            pem::parse(g.public_key.as_str())
                .unwrap()
                .contents(),
        )
        .unwrap();
        let data = signing_input("PS256");
        let bad = rsa::pss::SigningKey::<Sha256>::new_with_salt_len(private, 0)
            .try_sign_with_rng(&mut rand_core::OsRng, data.as_bytes())
            .unwrap()
            .to_bytes()
            .to_vec();
        assert!(
            !rsa_pss_verify!(Sha256, public, data.as_bytes(), &bad),
            "盐长不是摘要长的 PSS 签名必须验不过"
        );
    }

    #[test]
    fn round_trips_for_every_algorithm() {
        // 私钥现生成：RSA 一把、EC 每条曲线一把（同族共用一把，
        // 省得每种摘要都重新生成一次 —— RSA 密钥生成不便宜）。
        let rsa = generated(Alg::Rs256);
        let es256 = generated(Alg::Es256);
        let es384 = generated(Alg::Es384);
        let es512 = generated(Alg::Es512);
        for alg in Alg::ALL {
            let name = alg.name();
            let material = match name {
                // HMAC 用向量里的共享口令
                "HS256" | "HS384" | "HS512" => keys(name),
                "RS256" | "RS384" | "RS512" | "PS256" | "PS384" | "PS512" => rsa.clone(),
                "ES256" => es256.clone(),
                "ES384" => es384.clone(),
                _ => es512.clone(),
            };
            let signed = sign(alg, &payload(), &material).unwrap();
            let result = verify(&signed, &material).unwrap();
            assert!(result.valid, "{name} 的自签自验应当通过");
            assert_eq!(result.payload["name"], "John Doe");
        }
    }

    #[test]
    fn rejects_a_tampered_payload() {
        let original = token("HS256");
        let parts: Vec<&str> = original.split('.').collect();
        let forged = format!(
            "{}.{}.{}",
            parts[0],
            b64u(br#"{"sub":"1234567890","name":"Eve","iat":1516239022}"#),
            parts[2]
        );
        let result = verify(&forged, &keys("HS256")).unwrap();
        assert!(!result.valid, "改了 payload 必须验不过");
    }

    #[test]
    fn rejects_a_tampered_signature() {
        let original = token("HS256");
        let parts: Vec<&str> = original.split('.').collect();
        let mut sig = unb64u(parts[2]).unwrap();
        sig[0] ^= 0xff;
        let forged = format!("{}.{}.{}", parts[0], parts[1], b64u(&sig));
        let result = verify(&forged, &keys("HS256")).unwrap();
        assert!(!result.valid, "改了签名必须验不过");
    }

    #[test]
    fn refuses_alg_none() {
        let header = b64u(br#"{"alg":"none","typ":"JWT"}"#);
        let payload = b64u(br#"{"a":1}"#);
        let token = format!("{header}.{payload}.");
        let err = verify(&token, &Keys::default()).unwrap_err();
        assert_err(&err, "out.jwt.err.empty_signature", "签名段为空");
    }

    #[test]
    fn refuses_to_use_a_public_key_as_an_hmac_secret() {
        // RS256 → HS256 混淆：攻击者拿公钥当 HMAC 密钥，签名就能伪造
        let all = all();
        let pem = all["rsaPublicPem"].as_str().unwrap().to_string();
        // 攻击者用公钥文本当口令，伪造出一个 HS256 令牌
        let forged = sign(
            Alg::Hs256,
            &payload(),
            &Keys {
                secret: Some(pem.clone()),
                ..Default::default()
            },
        )
        .unwrap();
        // 受害者只配了公钥 —— 本工具必须拒绝拿 PEM 当 HMAC 口令
        let material = Keys {
            secret: None,
            private_key: None,
            public_key: Some(pem),
        };
        let err = verify(&forged, &material).unwrap_err();
        assert_err(&err, "out.jwt.err.secret_expected", "共享口令");
    }

    #[test]
    fn refuses_to_use_a_secret_as_an_asymmetric_key() {
        let material = Keys {
            secret: Some("secret".into()),
            private_key: None,
            public_key: None,
        };
        let err = sign(Alg::Rs256, &payload(), &material).unwrap_err();
        assert_err(&err, "out.jwt.err.private_key_expected", "私钥");
        // 验签同理：令牌声明的是 RS256，用户却只给了共享口令
        let err = verify(&token("RS256"), &material).unwrap_err();
        assert_err(&err, "out.jwt.err.public_key_expected", "公钥");
    }

    #[test]
    fn payload_must_be_valid_json() {
        let material = Keys {
            secret: Some("s".into()),
            ..Default::default()
        };
        let err = sign(Alg::Hs256, "not json", &material).unwrap_err();
        assert_err(&err, "out.jwt.err.invalid_payload", "JSON");
    }

    #[test]
    fn payload_bytes_are_preserved_verbatim() {
        // 键序与空格都按用户写的来 —— JWS 签的是字节，不是解析后的值
        let material = Keys {
            secret: Some("s".into()),
            ..Default::default()
        };
        let signed = sign(Alg::Hs256, r#"{ "b" : 2, "a" : 1 }"#, &material).unwrap();
        let payload = unb64u(signed.split('.').nth(1).unwrap()).unwrap();
        assert_eq!(String::from_utf8(payload).unwrap(), r#"{ "b" : 2, "a" : 1 }"#);
    }

    #[test]
    fn token_must_have_three_segments() {
        let material = Keys {
            secret: Some("s".into()),
            ..Default::default()
        };
        assert!(verify("a.b", &material).is_err());
        assert!(verify("a.b.c.d", &material).is_err());
        assert!(verify("", &material).is_err());
    }

    #[test]
    fn generated_rsa_key_pair_round_trips() {
        let generated = generate(Alg::Rs256, 1024).unwrap();
        assert!(generated.private_key.contains("BEGIN PRIVATE KEY"));
        assert!(generated.public_key.contains("BEGIN PUBLIC KEY"));
        let signed = sign(
            Alg::Rs256,
            &payload(),
            &Keys {
                private_key: Some(generated.private_key.clone()),
                ..Default::default()
            },
        )
        .unwrap();
        let result = verify(
            &signed,
            &Keys {
                public_key: Some(generated.public_key.clone()),
                ..Default::default()
            },
        )
        .unwrap();
        assert!(result.valid);
    }

    #[test]
    fn generated_rsa_jwk_can_be_used_to_sign() {
        let generated = generate(Alg::Ps256, 1024).unwrap();
        let jwk = serde_json::to_string(&generated.private_jwk).unwrap();
        let signed = sign(
            Alg::Ps256,
            &payload(),
            &Keys {
                private_key: Some(jwk),
                ..Default::default()
            },
        )
        .unwrap();
        let public_jwk = serde_json::to_string(&generated.public_jwk).unwrap();
        let result = verify(
            &signed,
            &Keys {
                public_key: Some(public_jwk),
                ..Default::default()
            },
        )
        .unwrap();
        assert!(result.valid, "JWK 形式的 RSA 密钥应当能签能验");
    }

    #[test]
    fn rsa_jwk_carries_the_crt_parameters() {
        let generated = generate(Alg::Rs256, 1024).unwrap();
        let jwk = &generated.private_jwk;
        for field in ["n", "e", "d", "p", "q", "dp", "dq", "qi"] {
            assert!(jwk.get(field).is_some(), "JWK 缺少 {field}");
        }
        // qi = q^-1 mod p
        // JWK 里的整数是 base64url 串，所以要用 `jwk_uint_value`（直接解串），
        // 不能用 `jwk_uint`（那个是去一个 JSON 对象里按名字取分量）。
        let p = jwk_uint_value(jwk.get("p").unwrap(), "p").unwrap();
        let q = jwk_uint_value(jwk.get("q").unwrap(), "q").unwrap();
        let qi = jwk_uint_value(jwk.get("qi").unwrap(), "qi").unwrap();
        assert_eq!((&q * &qi) % &p, BigUint::from(1u32));
    }

    #[test]
    fn generated_ec_key_pair_round_trips() {
        for alg in [Alg::Es256, Alg::Es384, Alg::Es512] {
            let generated = generate(alg, 0).unwrap();
            assert!(generated.private_key.contains("BEGIN PRIVATE KEY"));
            let signed = sign(
                alg,
                &payload(),
                &Keys {
                    private_key: Some(generated.private_key.clone()),
                    ..Default::default()
                },
            )
            .unwrap();
            let result = verify(
                &signed,
                &Keys {
                    public_key: Some(generated.public_key.clone()),
                    ..Default::default()
                },
            )
            .unwrap();
            assert!(result.valid, "{alg:?} 的自签自验应当通过");
        }
    }

    #[test]
    fn generated_ec_jwk_can_be_used_to_sign() {
        for alg in [Alg::Es256, Alg::Es384, Alg::Es512] {
            let generated = generate(alg, 0).unwrap();
            let jwk = serde_json::to_string(&generated.private_jwk).unwrap();
            let signed = sign(
                alg,
                &payload(),
                &Keys {
                    private_key: Some(jwk),
                    ..Default::default()
                },
            )
            .unwrap();
            let public_jwk = serde_json::to_string(&generated.public_jwk).unwrap();
            let result = verify(
                &signed,
                &Keys {
                    public_key: Some(public_jwk),
                    ..Default::default()
                },
            )
            .unwrap();
            assert!(result.valid, "{alg:?} 的 JWK 密钥应当能签能验");
        }
    }

    #[test]
    fn ec_jwk_rejects_a_mismatched_curve() {
        let generated = generate(Alg::Es256, 0).unwrap();
        let jwk = serde_json::to_string(&generated.private_jwk).unwrap();
        let err = sign(
            Alg::Es384,
            &payload(),
            &Keys {
                private_key: Some(jwk),
                ..Default::default()
            },
        )
        .unwrap_err();
        assert_err(&err, "out.jwt.err.curve_mismatch", "曲线");
    }

    #[test]
    fn hmac_has_no_key_pair() {
        assert!(generate(Alg::Hs256, 2048).is_err());
    }

    #[test]
    fn mod_inverse_works() {
        let m = BigUint::from(11u32);
        assert_eq!(
            mod_inverse(&BigUint::from(3u32), &m),
            Some(BigUint::from(4u32))
        );
        // 费马小定理自检：a^(p-1) ≡ 1 (mod p)
        let p = BigUint::from(1_000_003u32);
        let a = BigUint::from(65_537u32);
        let inv = mod_inverse(&a, &p).unwrap();
        assert_eq!((&a * &inv) % &p, BigUint::from(1u32));
        // 不互质时没有逆元
        assert!(mod_inverse(&BigUint::from(4u32), &BigUint::from(8u32)).is_none());
    }

    /* ------------------------------------------------------------ 格式转换 */

    #[test]
    fn converts_an_rsa_pem_private_key_into_a_jwk() {
        // 私钥现生成（向量文件里不放私钥 —— 见本模块开头的说明）
        let pem = generate(Alg::Rs256, 1024).unwrap().private_key;
        let converted = convert(Alg::Rs256, KeyKind::Private, &parse_material(&pem).unwrap()).unwrap();
        assert!(converted.pem.contains("BEGIN PRIVATE KEY"), "私钥仍是 PEM");
        assert_eq!(converted.jwk["kty"], "RSA");
        assert_eq!(converted.jwk["crv"], Value::Null, "RSA 的 JWK 没有 crv");
        assert!(converted.jwk["n"].is_string(), "JWK 带 n");
        assert!(converted.jwk["d"].is_string(), "私钥 JWK 带 d");
    }

    #[test]
    fn converts_a_jwk_back_into_a_pem() {
        let pem = generate(Alg::Rs256, 1024).unwrap().private_key;
        let jwk = rsa_private_jwk(&rsa_private_key(&parse_material(&pem).unwrap()).unwrap());
        let text = serde_json::to_string(&jwk).unwrap();
        let converted = convert(Alg::Rs256, KeyKind::Private, &parse_material(&text).unwrap()).unwrap();
        assert!(converted.pem.contains("BEGIN PRIVATE KEY"), "JWK 又变回 PEM");
        // 往返之后还是同一把钥匙
        let again = rsa_private_key(&parse_material(&converted.pem).unwrap()).unwrap();
        assert_eq!(again.n(), rsa_private_key(&parse_material(&pem).unwrap()).unwrap().n());
    }

    #[test]
    fn converting_a_private_key_also_yields_the_public_key() {
        let g = generate(Alg::Rs256, 1024).unwrap();
        let converted =
            convert(Alg::Rs256, KeyKind::Private, &parse_material(&g.private_key).unwrap()).unwrap();
        let public_pem = converted.public_pem.expect("私钥应能推出公钥");
        assert!(public_pem.contains("BEGIN PUBLIC KEY"));
        // 导出的公钥就是这把私钥的公钥
        let a = rsa_public_key(&parse_material(&public_pem).unwrap()).unwrap();
        let b = rsa_public_key(&parse_material(&g.public_key).unwrap()).unwrap();
        assert_eq!(a.n(), b.n());
        assert_eq!(a.e(), b.e());
    }

    #[test]
    fn converting_a_public_key_yields_no_private_key() {
        let all = all();
        let pem = all["rsaPublicPem"].as_str().unwrap();
        let converted = convert(Alg::Rs256, KeyKind::Public, &parse_material(pem).unwrap()).unwrap();
        assert!(converted.pem.contains("BEGIN PUBLIC KEY"));
        assert!(converted.public_pem.is_none(), "公钥推不出公钥（没意义）");
        assert!(converted.public_jwk.is_none());
        assert_eq!(converted.jwk["kty"], "RSA");
        assert!(converted.jwk["d"].is_null(), "公钥 JWK 不带 d");
    }

    #[test]
    fn converts_an_ec_key_pair() {
        // 私钥现生成（向量文件里不放私钥 —— 见本模块开头的说明）
        let pem = generate(Alg::Es256, 0).unwrap().private_key;
        let converted = convert(Alg::Es256, KeyKind::Private, &parse_material(&pem).unwrap()).unwrap();
        assert_eq!(converted.jwk["kty"], "EC");
        assert_eq!(converted.jwk["crv"], "P-256");
        assert!(converted.public_pem.unwrap().contains("BEGIN PUBLIC KEY"));
        // 换条曲线就不该认这把钥匙
        let err = convert(Alg::Es384, KeyKind::Private, &parse_material(&pem).unwrap()).unwrap_err();
        assert_err(&err, "out.jwt.err.invalid_private_key", "P-384");
    }

    #[test]
    fn hmac_has_nothing_to_convert() {
        let err = convert(
            Alg::Hs256,
            KeyKind::Private,
            &parse_material(r#"{"kty":"oct"}"#).unwrap(),
        )
        .unwrap_err();
        assert_err(&err, "out.jwt.err.hmac_nothing_to_convert", "共享口令");
    }

    /// 前端的备用算法表与服务端的必须一致 ——
    /// 前端那张表只是「接口取不到时的兜底」，对不上就会给用户一个假的下拉框。
    #[test]
    fn fallback_algorithm_table_matches_the_server() {
        let file = crate::embed::StaticAsset::get("js/tools/jwt-generator.js")
            .expect("缺少 js/tools/jwt-generator.js");
        let text = String::from_utf8(file.data.into_owned()).expect("模块不是 UTF-8");
        let start = text
            .find("BEGIN_FALLBACK_ALGS")
            .expect("缺少 BEGIN_FALLBACK_ALGS 标记");
        let end = text
            .find("END_FALLBACK_ALGS")
            .expect("缺少 END_FALLBACK_ALGS 标记");
        assert!(start < end, "标记顺序反了");
        let block = &text[start..end];

        // 抓出每一项的 alg: 'XXX'
        let mut names: Vec<String> = Vec::new();
        let mut rest = block;
        while let Some(at) = rest.find("alg: '") {
            rest = &rest[at + "alg: '".len()..];
            let close = rest.find('\'').expect("alg 的引号没闭合");
            names.push(rest[..close].to_string());
            rest = &rest[close..];
        }

        let expected: Vec<String> = Alg::ALL.iter().map(|a| a.name().to_string()).collect();
        assert_eq!(
            names, expected,
            "JS 备用算法表与服务端的 Alg::ALL 对不上（顺序也要一样）"
        );
    }

    /// 算法清单本身也要能对上：接口给前端的每一个算法，服务端都得认。
    #[test]
    fn algorithm_list_is_consistent() {
        let list = algorithms();
        let algs = list["algorithms"].as_array().unwrap();
        assert_eq!(algs.len(), Alg::ALL.len());
        for (entry, alg) in algs.iter().zip(Alg::ALL.iter()) {
            assert_eq!(entry["alg"], alg.name());
            assert_eq!(entry["keyType"], alg.info().key_type);
            assert!(!entry["verify"].as_str().unwrap().is_empty());
        }
        // 知道但做不了的要说清楚，别装没这回事
        let unsupported = list["unsupported"].as_array().unwrap();
        assert_eq!(unsupported[0]["alg"], "ES256K");
        assert!(!unsupported[0]["reason"].as_str().unwrap().is_empty());
    }
}
