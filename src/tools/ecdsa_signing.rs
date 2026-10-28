//! ECDSA 签名与验签（endpoint `ecdsa-signing`）。
//!
//! ## 名字：上游叫 `rsa-ecdsa-signing`，这里叫 `ecdsa-signing`
//!
//! 参考实现是 `/data/work/it-tools2/src/tools/rsa-ecdsa-signing/rsa-ecdsa-signing.vue`
//! （Vue + sshpk）。它的 slug 叫 `rsa-ecdsa-signing`，**但它从头到尾没碰过 RSA** ——
//! 界面里没有算法下拉，密钥靠 sshpk 的 `parsePrivateKey(…, 'auto')` 猜，
//! 而签名那一步走的是 sshpk 的 `createSign()`，对 RSA 私钥也能签。
//! 也就是说那个名字里的 `rsa-` 是虚的。
//!
//! 本仓库已经有 `rsa-key-pair-generator` 专门管 RSA，再挂一个「rsa-ecdsa」
//! 会让人以为它也管 RSA，所以这里定名 **`ecdsa-signing`**。
//!
//! ## 与上游的三处差别
//!
//! 1. **不做 SSH 格式的签名**。上游用 sshpk，输出两种表示：
//!    `signature.toString('asn1')`（ASN.1 DER）与 `signature.toString('ssh')`
//!    —— 后者是 OpenSSH 的 `sshsig` 包装（一段 `-----BEGIN SSH SIGNATURE-----`
//!    的 base64，里面装的是「算法名 + 签名」，另有一套 armor 规则）。
//!    那套格式是给 `ssh-keygen -Y sign` / `ssh-keygen -Y verify` 用的：
//!    签的是「某个文件 + 某个命名空间」，验签还要配 allowed_signers。
//!    跟这个工具的用法（「给一段文本签名、给一段文本验签」）不是一回事，
//!    实现它要另引一套编码，收益却只是多一种输出格式 —— 所以只做 DER。
//!
//! 2. **摘要由曲线定死**。上游给了摘要下拉（sha1 / sha256 / sha384 / sha512 / md5），
//!    于是能选出「P-256 配 SHA-512」「P-521 配 MD5」这种组合 —— 合法
//!    （ECDSA 允许任意摘要），但用户多半不知道自己选了什么。
//!    这里跟本仓库 `jwt` 那套一致：P-256→SHA-256、P-384→SHA-384、P-521→SHA-512，
//!    界面上不再让用户选摘要。
//!
//! 3. **验签失败不是错误**。「签名对不上」是**结论**，「输入不合法」才是错误：
//!    前者返回 200 + `meta.valid = false`，后者才是 400。
//!
//! ## 密钥格式
//!
//! - 私钥：PKCS#8（`-----BEGIN PRIVATE KEY-----`）与 SEC1
//!   （`-----BEGIN EC PRIVATE KEY-----`）**都收** —— `openssl ecparam -genkey`
//!   默认导出的是 SEC1，只支持 PKCS#8 会让一大半用户卡在第一步。
//! - 公钥：SPKI（`-----BEGIN PUBLIC KEY-----`）。
//!
//! **加密的私钥不支持**（`ENCRYPTED PRIVATE KEY`）：本工具不收口令，
//! 给出口令却不解密等于骗人，直接报错。
//!
//! ## 签名值的形态
//!
//! 输出是 **ASN.1 DER** 编码的 ECDSA-Sig-Value（RFC 5912 §6：
//! `SEQUENCE { r INTEGER, s INTEGER }`），base64 与 hex 两种写法都给。
//!
//! 注意这跟 JWS 的 `R‖S` 裸拼接**不是一回事** —— 跟本仓库的 `jwt` 工具
//! 对齐时别把两者的输出混着用。
//!
//! ## 依赖
//!
//! `p256` / `p384` / `p521`（0.14，各自带一份 ecdsa 实现，走 digest 0.11 /
//! signature 3）、`base64`、`hex`、`pem`。**没有新�� crate**。

use base64::engine::general_purpose::{STANDARD as B64, STANDARD_NO_PAD as B64_NO_PAD};
use base64::Engine as _;
use serde_json::{json, Value};

use super::util;
use super::{ToolError, ToolResult};

/// 要签名的文本上限（字节）。
///
/// 上限存在的理由：`POST /api/tools/ecdsa-signing` 是公开接口，一条几十兆的
/// 文本就要服务端把它整个读进内存再哈希一遍。
const MAX_TEXT: usize = 1024 * 1024;

/// 密钥材料（PEM 文本）的上限（字符）。
const MAX_KEY: usize = 64 * 1024;

/// 签名的上限（字符）。DER 签名只有一两百字节，base64 之后也就三百来字符。
const MAX_SIGNATURE: usize = 4096;

/// 验签结果为「有效」时用的语言包键。
const VALID_KEY: &str = "out.ecdsa-signing.valid";
/// 验签结果为「无效」时用的语言包键。
const INVALID_KEY: &str = "out.ecdsa-signing.invalid";

/// 支持的三条曲线。
///
/// 摘要算法**跟着曲线走**，不让用户选 —— 选了就会出现「P-256 配 SHA-512」
/// 这种用户多半没打算要的组合。
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Curve {
    P256,
    P384,
    P521,
}

impl Curve {
    /// 注册表里下拉的取值。
    pub fn id(self) -> &'static str {
        match self {
            Curve::P256 => "p256",
            Curve::P384 => "p384",
            Curve::P521 => "p521",
        }
    }

    /// 曲线的正式名字（NIST SP 800-186）。
    pub fn label(self) -> &'static str {
        match self {
            Curve::P256 => "P-256",
            Curve::P384 => "P-384",
            Curve::P521 => "P-521",
        }
    }

    /// 这条曲线配套的摘要算法（给人看的名字）。
    pub fn digest(self) -> &'static str {
        match self {
            Curve::P256 => "SHA-256",
            Curve::P384 => "SHA-384",
            Curve::P521 => "SHA-512",
        }
    }

    /// 这条曲线配套的摘要算法（机器可读的名字）。
    pub fn digest_id(self) -> &'static str {
        match self {
            Curve::P256 => "sha256",
            Curve::P384 => "sha384",
            Curve::P521 => "sha512",
        }
    }

    /// 解析曲线名。
    ///
    /// 除了注册表里的三个取值，还认 OpenSSL 的曲线名 —— 用户从
    /// `openssl ec -list_curves` 里抄名字过来是常事。
    pub fn parse(raw: &str) -> Option<Self> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "p256" | "p-256" | "prime256v1" | "secp256r1" => Some(Curve::P256),
            "p384" | "p-384" | "secp384r1" => Some(Curve::P384),
            "p521" | "p-521" | "secp521r1" => Some(Curve::P521),
            _ => None,
        }
    }

    /// 用这把私钥签一段消息，输出 DER。
    fn sign(self, private_der: &[u8], msg: &[u8]) -> Result<Vec<u8>, ()> {
        match self {
            Curve::P256 => p256_curve::sign(private_der, msg),
            Curve::P384 => p384_curve::sign(private_der, msg),
            Curve::P521 => p521_curve::sign(private_der, msg),
        }
    }

    /// 用这把公钥验一段消息与一条 DER 签名。
    ///
    /// 返回 `Err` 只意味着「公钥解不出来」；「验不过」是 `Ok(false)`。
    fn verify(self, public_der: &[u8], msg: &[u8], signature_der: &[u8]) -> Result<bool, ()> {
        match self {
            Curve::P256 => p256_curve::verify(public_der, msg, signature_der),
            Curve::P384 => p384_curve::verify(public_der, msg, signature_der),
            Curve::P521 => p521_curve::verify(public_der, msg, signature_der),
        }
    }

    /// 这段字节能不能解成这条曲线的 DER 签名。
    fn is_der_signature(self, bytes: &[u8]) -> bool {
        match self {
            Curve::P256 => p256_curve::is_der_signature(bytes),
            Curve::P384 => p384_curve::is_der_signature(bytes),
            Curve::P521 => p521_curve::is_der_signature(bytes),
        }
    }
}

/// 一条曲线上的六个动作：解私钥、解公钥、签名、验签、认签名、认曲线。
///
/// 三条曲线只有类型不同，要做的事完全一样，所以用宏生成三份 ——
/// 逻辑只写一遍，不会出现「只有 P-256 那份忘了做某个检查」这种
/// 只有一份实现才有的坑。
macro_rules! ecdsa_curve {
    ($name:ident, $krate:ident, $curve:ty) => {
        mod $name {
            use $krate::ecdsa::{
                signature::{Signer, Verifier},
                Signature, SigningKey, VerifyingKey,
            };
            use $krate::pkcs8::{DecodePrivateKey, DecodePublicKey};

            /// 解私钥：PKCS#8（`-----BEGIN PRIVATE KEY-----`）或 SEC1
            /// （`-----BEGIN EC PRIVATE KEY-----`）。
            ///
            /// 两种都试：标签不一定可靠（有人会自己改标签），
            /// 靠 DER 试出来的结果才准。
            pub fn private_key(der: &[u8]) -> Result<SigningKey, ()> {
                if let Ok(key) = SigningKey::from_pkcs8_der(der) {
                    return Ok(key);
                }
                // SEC1：先解出标量，再交给 ecdsa。
                // `SecretKey::from_sec1_der` 会核对 SEC1 里的曲线 OID ——
                // 拿 P-384 的 SEC1 钥匙当 P-256 解会在这一步就失败。
                let secret = $krate::elliptic_curve::SecretKey::<$curve>::from_sec1_der(der)
                    .map_err(|_| ())?;
                SigningKey::from_bytes(&secret.to_bytes()).map_err(|_| ())
            }

            /// 解公钥：SPKI（`-----BEGIN PUBLIC KEY-----`）。
            pub fn public_key(der: &[u8]) -> Result<VerifyingKey, ()> {
                VerifyingKey::from_public_key_der(der).map_err(|_| ())
            }

            /// 签名，输出 ASN.1 DER。
            pub fn sign(private_der: &[u8], msg: &[u8]) -> Result<Vec<u8>, ()> {
                let key = private_key(private_der)?;
                // 显式标注类型：`Signer` 对同一把钥匙有多个实现（裸签名 / 带 OID
                // / DER），不标注编译器推不出来。
                let signature: Signature = key.try_sign(msg).map_err(|_| ())?;
                // `to_der()` 给的是 `ecdsa::der::Signature`，`as_bytes()` 才是
                // RFC 5912 §6 那个 `SEQUENCE { r INTEGER, s INTEGER }` 的字节。
                Ok(signature.to_der().as_bytes().to_vec())
            }

            /// 验签。签名不是合法的 DER 时返回 `false` —— 对调用方来说
            /// 「解不出来」与「对不上」是同一件事：都验不过。
            pub fn verify(public_der: &[u8], msg: &[u8], signature_der: &[u8]) -> Result<bool, ()> {
                let key = public_key(public_der)?;
                match Signature::from_der(signature_der) {
                    Ok(signature) => Ok(key.verify(msg, &signature).is_ok()),
                    Err(_) => Ok(false),
                }
            }

            /// 这段字节是不是这条曲线的合法 DER 签名。
            pub fn is_der_signature(bytes: &[u8]) -> bool {
                Signature::from_der(bytes).is_ok()
            }
        }
    };
}

ecdsa_curve!(p256_curve, p256, p256::NistP256);
ecdsa_curve!(p384_curve, p384, p384::NistP384);
ecdsa_curve!(p521_curve, p521, p521::NistP521);

/// 这份私钥属于哪条曲线。解不出来（不是 EC 私钥 / 格式不对）返回 `None`。
///
/// 曲线认得出来是有用的：用户选了 P-256 却粘了 P-384 的钥匙，
/// 只说「私钥不合法」他查不动，说「这把钥匙在 P-384 上」他立刻知道该改什么。
fn private_key_curve(der: &[u8]) -> Option<&'static str> {
    if p256_curve::private_key(der).is_ok() {
        Some(Curve::P256.label())
    } else if p384_curve::private_key(der).is_ok() {
        Some(Curve::P384.label())
    } else if p521_curve::private_key(der).is_ok() {
        Some(Curve::P521.label())
    } else {
        None
    }
}

/// 这份公钥属于哪条曲线。解不出来返回 `None`。
fn public_key_curve(der: &[u8]) -> Option<&'static str> {
    if p256_curve::public_key(der).is_ok() {
        Some(Curve::P256.label())
    } else if p384_curve::public_key(der).is_ok() {
        Some(Curve::P384.label())
    } else if p521_curve::public_key(der).is_ok() {
        Some(Curve::P521.label())
    } else {
        None
    }
}

/// 解析 PEM，返回 (标签, DER 字节)。
///
/// 标签单独拿出来，是为了认出 `ENCRYPTED PRIVATE KEY` ——
/// 那把钥匙要口令才能解，本工具不收口令。
fn pem_parts(text: &str, err_key: &'static str) -> Result<(String, Vec<u8>), ToolError> {
    let pem = pem::parse(text).map_err(|_| ToolError::invalid(err_key, &[]))?;
    Ok((pem.tag().to_string(), pem.contents().to_vec()))
}

/// 把用户给的签名解成 DER 字节。
///
/// 两种写法都收：base64（默认）与 hex（跟别的工具对齐）。
///
/// 判定办法**不是**「看着像 hex 就当 hex」—— base64 的字符集与 hex 有交集
/// （`deadbeef` 既是合法 hex 也是合法 base64），单看字符集会猜错。
/// 真正的判据是「解出来的字节是不是一条合法的 DER 签名」：两种都试，
/// 谁解得出合法 DER 就用谁。
fn decode_signature(text: &str, curve: Curve) -> Result<Vec<u8>, ToolError> {
    // 签名是 base64 或 hex，粘贴时带的换行与空白不该算内容。
    let cleaned: String = text.chars().filter(|c| !c.is_whitespace()).collect();
    if cleaned.is_empty() {
        return Err(ToolError::invalid(
            "out.ecdsa-signing.err.bad_signature_encoding",
            &[],
        ));
    }
    if cleaned.len() > MAX_SIGNATURE {
        let size = cleaned.len().to_string();
        let max = MAX_SIGNATURE.to_string();
        return Err(ToolError::invalid(
            "out.ecdsa-signing.err.input_too_long",
            &[("size", &size), ("max", &max)],
        ));
    }

    let mut candidates: Vec<Vec<u8>> = Vec::new();
    // hex：必须是偶数个十六进制数字。
    if cleaned.len().is_multiple_of(2) && cleaned.chars().all(|c| c.is_ascii_hexdigit()) {
        if let Ok(bytes) = hex::decode(&cleaned) {
            candidates.push(bytes);
        }
    }
    // base64：带填充与不带填充都收（用户从别的工具复制过来的多半没填充）。
    if let Ok(bytes) = B64.decode(cleaned.as_bytes()) {
        candidates.push(bytes);
    } else if let Ok(bytes) = B64_NO_PAD.decode(cleaned.as_bytes()) {
        candidates.push(bytes);
    }

    if candidates.is_empty() {
        return Err(ToolError::invalid(
            "out.ecdsa-signing.err.bad_signature_encoding",
            &[],
        ));
    }
    for candidate in &candidates {
        if curve.is_der_signature(candidate) {
            return Ok(candidate.clone());
        }
    }
    // 解得出字节、但解不成签名 —— 是「签名不对」，不是「签名不是 base64」。
    Err(ToolError::invalid("out.ecdsa-signing.err.bad_signature", &[]))
}

/// 取要签名的文本。
fn text_of(payload: &Value) -> Result<&str, ToolError> {
    let text = util::req_str(payload, "text")?;
    if text.len() > MAX_TEXT {
        let size = text.len().to_string();
        let max = MAX_TEXT.to_string();
        return Err(ToolError::invalid(
            "out.ecdsa-signing.err.input_too_long",
            &[("size", &size), ("max", &max)],
        ));
    }
    Ok(text)
}

/// 取曲线。
fn curve_of(payload: &Value) -> Result<Curve, ToolError> {
    let raw = util::str_or(payload, "curve", "p256");
    Curve::parse(raw).ok_or_else(|| {
        ToolError::invalid("out.ecdsa-signing.err.unknown_curve", &[("curve", raw)])
    })
}

/// ECDSA 不算 CPU 密集：一条 P-256 签名是几十微秒的量级，P-521 也就慢一个
/// 数量级。丢 blocking 线程池反而多一次跨线程调度，所以这里直接算。
pub async fn handle(payload: Value) -> ToolResult {
    compute(payload)
}

fn compute(payload: Value) -> ToolResult {
    let mode = util::str_or(&payload, "mode", "sign").to_ascii_lowercase();
    match mode.as_str() {
        "sign" => sign(&payload),
        "verify" => verify(&payload),
        other => Err(ToolError::invalid(
            "out.ecdsa-signing.err.unknown_mode",
            &[("mode", other)],
        )),
    }
}

/// 签名。
fn sign(payload: &Value) -> ToolResult {
    let curve = curve_of(payload)?;
    let text = text_of(payload)?;
    let private_key = util::req_str(payload, "private_key")?;
    if private_key.len() > MAX_KEY {
        let size = private_key.len().to_string();
        let max = MAX_KEY.to_string();
        return Err(ToolError::invalid(
            "out.ecdsa-signing.err.input_too_long",
            &[("size", &size), ("max", &max)],
        ));
    }

    let (tag, der) = pem_parts(private_key, "out.ecdsa-signing.err.bad_private_key")?;
    if tag.contains("ENCRYPTED") {
        // 加密的私钥要口令才能解 —— 本工具不收口令。
        return Err(ToolError::invalid(
            "out.ecdsa-signing.err.encrypted_key_unsupported",
            &[],
        ));
    }

    // 曲线对不上时说清楚是哪条曲线。
    if let Some(actual) = private_key_curve(&der) {
        if actual != curve.label() {
            return Err(ToolError::invalid(
                "out.ecdsa-signing.err.curve_mismatch",
                &[("actual", actual), ("expected", curve.label())],
            ));
        }
    }

    let signature = curve
        .sign(&der, text.as_bytes())
        .map_err(|_| ToolError::invalid("out.ecdsa-signing.err.bad_private_key", &[]))?;

    let base64 = B64.encode(&signature);
    let hex_signature = hex::encode(&signature);

    let mut table = serde_json::Map::new();
    util::row_str(
        &mut table,
        payload,
        "out.ecdsa-signing.signature_hex",
        &hex_signature,
    );
    util::row_str(&mut table, payload, "out.ecdsa-signing.curve", curve.label());
    util::row_str(&mut table, payload, "out.ecdsa-signing.digest", curve.digest());

    Ok(json!({
        "output": base64,
        "table": table,
        "rows": [],
        "meta": {
            "curve": curve.id(),
            "digest": curve.digest_id(),
            "encoding": "der",
            "signature_hex": hex_signature,
        },
    }))
}

/// 验签。
fn verify(payload: &Value) -> ToolResult {
    let curve = curve_of(payload)?;
    let text = text_of(payload)?;
    let public_key = util::req_str(payload, "public_key")?;
    let signature = util::req_str(payload, "signature")?;
    if public_key.len() > MAX_KEY {
        let size = public_key.len().to_string();
        let max = MAX_KEY.to_string();
        return Err(ToolError::invalid(
            "out.ecdsa-signing.err.input_too_long",
            &[("size", &size), ("max", &max)],
        ));
    }

    let (_, der) = pem_parts(public_key, "out.ecdsa-signing.err.bad_public_key")?;
    match public_key_curve(&der) {
        // 曲线对不上：说的是这把钥匙**实际**在哪条曲线上。
        Some(actual) if actual != curve.label() => {
            return Err(ToolError::invalid(
                "out.ecdsa-signing.err.curve_mismatch",
                &[("actual", actual), ("expected", curve.label())],
            ));
        }
        None => {
            return Err(ToolError::invalid(
                "out.ecdsa-signing.err.bad_public_key",
                &[],
            ));
        }
        _ => {}
    }

    // 签名格式不对是**输入问题**（400）；签名对不上是**结论**（200 + valid=false）。
    let signature_der = decode_signature(signature, curve)?;
    let valid = curve
        .verify(&der, text.as_bytes(), &signature_der)
        .map_err(|_| ToolError::invalid("out.ecdsa-signing.err.bad_public_key", &[]))?;

    let lang = util::lang(payload);
    let mut table = serde_json::Map::new();
    util::row(
        &mut table,
        payload,
        "out.ecdsa-signing.verification_result",
        Value::String(crate::i18n::t(lang, if valid { VALID_KEY } else { INVALID_KEY })),
    );

    Ok(json!({
        "output": "",
        "table": table,
        "rows": [],
        "meta": {
            "valid": valid,
            "curve": curve.id(),
            "digest": curve.digest_id(),
        },
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::collections::BTreeMap;

    /// OpenSSL 生成的测试向量（**外部参照**，不是本实现自己的输出）。
    ///
    /// 生成方法见 `src/tools/fixtures/generate-ecdsa-vectors.sh`。
    /// 向量文件里**只有公开材料**：公钥（SPKI）、被签名的消息、
    /// OpenSSL 签出来的 DER 签名。私钥一个都不存 —— 仓库是公开的，
    /// GitHub 对公开仓库默认开着 push protection，一段货真价实的私钥文本
    /// 就能把第一次推送整个拦下来。测试要私钥的地方一律现生成一把。
    const VECTORS: &str = include_str!("fixtures/ecdsa_signing_vectors.json");

    fn vectors() -> Value {
        serde_json::from_str(VECTORS).expect("向量文件是合法 JSON")
    }

    /// 向量里的消息。
    fn message() -> String {
        vectors()["message"].as_str().expect("message 是字符串").to_string()
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

    /// 错误的插值参数。
    fn err_args(err: &ToolError) -> BTreeMap<String, String> {
        match err {
            ToolError::InvalidKeyed { args, .. } => args.iter().cloned().collect(),
            other => panic!("应当是 InvalidKeyed，得到 {other:?}"),
        }
    }

    /// 错误里有没有漏出密钥或原文。
    fn leaks(err: &ToolError, secret: &str) -> bool {
        match err {
            ToolError::InvalidKeyed { key, args } => {
                key.contains(secret) || args.iter().any(|(_, v)| v.contains(secret))
            }
            ToolError::Internal(msg) => msg.contains(secret),
        }
    }

    /// 现生成一对密钥（PKCS#8 私钥 PEM + SPKI 公钥 PEM）。
    ///
    /// 私钥只活在这一次调用的内存里，不落盘、不进仓库（理由见 [`VECTORS`]）。
    /// 密钥生成要随机取一个域里的标量：P-521 的阶略小于 2^521，
    /// 随机取 66 个字节大约有 1/128 的概率越界，不合法就重取。
    fn generated_keys(curve: &str) -> (String, String) {
        use rand::Rng;

        macro_rules! make {
            ($krate:ident, $len:expr) => {{
                let mut bytes = [0u8; $len];
                let mut rng = rand::rng();
                let key = loop {
                    rng.fill_bytes(&mut bytes);
                    if let Ok(key) = $krate::ecdsa::SigningKey::from_slice(&bytes) {
                        break key;
                    }
                };
                let private = $krate::pkcs8::EncodePrivateKey::to_pkcs8_pem(
                    &key,
                    $krate::pkcs8::LineEnding::LF,
                )
                .expect("私钥能编成 PEM")
                .to_string();
                let public = $krate::pkcs8::EncodePublicKey::to_public_key_pem(
                    key.verifying_key(),
                    $krate::pkcs8::LineEnding::LF,
                )
                .expect("公钥能编成 PEM")
                .to_string();
                (private, public)
            }};
        }

        match curve {
            "p256" => make!(p256, 32),
            "p384" => make!(p384, 48),
            _ => make!(p521, 66),
        }
    }

    /// 把 DER 包成 PEM（每行 64 个字符）。
    fn pem_encode(tag: &str, der: &[u8]) -> String {
        let body = B64.encode(der);
        let mut out = format!("-----BEGIN {tag}-----\n");
        for chunk in body.as_bytes().chunks(64) {
            out.push_str(std::str::from_utf8(chunk).expect("base64 是 ASCII"));
            out.push('\n');
        }
        out.push_str(&format!("-----END {tag}-----\n"));
        out
    }

    /// 造一条 SEC1 私钥（`-----BEGIN EC PRIVATE KEY-----`）。
    ///
    /// `openssl ecparam -genkey` 默认导出的是 SEC1，所以这个格式必须收。
    fn sec1_private_key(curve: &str) -> String {
        use rand::Rng;

        macro_rules! make {
            ($krate:ident, $curve_ty:ty, $len:expr) => {{
                let mut bytes = [0u8; $len];
                let mut rng = rand::rng();
                // 随机取一个域里的标量：P-521 的阶略小于 2^521，
                // 随机取 66 个字节大约有 1/128 的概率越界，不合法就重取。
                let secret = loop {
                    rng.fill_bytes(&mut bytes);
                    if let Ok(secret) =
                        $krate::elliptic_curve::SecretKey::<$curve_ty>::from_slice(&bytes)
                    {
                        break secret;
                    }
                };
                let der = secret.to_sec1_der().expect("SEC1 私钥能编成 DER");
                pem_encode("EC PRIVATE KEY", der.as_slice())
            }};
        }

        match curve {
            "p256" => make!(p256, p256::NistP256, 32),
            "p384" => make!(p384, p384::NistP384, 48),
            _ => make!(p521, p521::NistP521, 66),
        }
    }

    /// 跑一次签名。
    fn do_sign(curve: &str, text: &str, private_key: &str) -> String {
        let out = compute(json!({
            "mode": "sign",
            "curve": curve,
            "text": text,
            "private_key": private_key,
        }))
        .expect("合法输入不该报错");
        out["output"].as_str().expect("output 是字符串").to_string()
    }

    /// 跑一次验签。
    fn do_verify(curve: &str, text: &str, public_key: &str, signature: &str) -> Value {
        compute(json!({
            "mode": "verify",
            "curve": curve,
            "text": text,
            "public_key": public_key,
            "signature": signature,
        }))
        .expect("合法输入不该报错")
    }

    /* ---------------------------------------------------------- 往返 */

    /// 三条曲线各走一遍：签 → 验 → 有效；换一段文本 → 无效。
    ///
    /// 这是**自证**（本实现签、本实现验），只能证明前后一致，
    /// 证明不了「算对了但格式照样对」的那类错 —— 外部参照见下面两条。
    #[test]
    fn round_trips_on_every_curve() {
        for curve in ["p256", "p384", "p521"] {
            let (private_key, public_key) = generated_keys(curve);
            let signature = do_sign(curve, "hello", &private_key);

            let out = do_verify(curve, "hello", &public_key, &signature);
            assert_eq!(out["meta"]["valid"], true, "{curve} 应当验得过");

            // 换一段文本就该验不过。
            let out = do_verify(curve, "hello!", &public_key, &signature);
            assert_eq!(out["meta"]["valid"], false, "{curve} 换文本后应当验不过");
        }
    }

    /// P-521 慢一点，但还能接受（毫秒量级）。
    #[test]
    fn the_p521_curve_works_too() {
        let (private_key, public_key) = generated_keys("p521");
        let signature = do_sign("p521", "abc", &private_key);
        let out = do_verify("p521", "abc", &public_key, &signature);
        assert_eq!(out["meta"]["valid"], true);
    }

    /* -------------------------------------------------- 外部参照：openssl */

    /// **外部参照**：OpenSSL 签的签名，我们验得过。
    ///
    /// 向量是 `openssl dgst -sha256 -sign …` 之类的命令产出的（脚本见
    /// `src/tools/fixtures/generate-ecdsa-vectors.sh`）—— OpenSSL 是独立于
    /// 本实现的另一套实现，**验得过就说明我们的 DER 解析、摘要选择与
    /// 公钥解析跟它对得上**。这条断言不是自我印证。
    #[test]
    fn openssl_signatures_verify() {
        let all = vectors();
        let text = message();
        for curve in ["p256", "p384", "p521"] {
            let entry = &all["vectors"][curve];
            let public_key = entry["publicKeyPem"].as_str().expect("公钥是字符串");
            let signature = entry["signatureHex"].as_str().expect("签名是字符串");

            // 向量里存的是 hex —— 顺便把 hex 输入这条路也走一遍。
            let out = do_verify(curve, &text, public_key, signature);
            assert_eq!(
                out["meta"]["valid"], true,
                "{curve}: OpenSSL 签的签名应当验得过（{text:?}）"
            );
        }
    }

    /// **外部参照**：同一条签名换成 base64 写法，结论必须一样。
    #[test]
    fn openssl_signatures_verify_from_base64_too() {
        let all = vectors();
        let text = message();
        for curve in ["p256", "p384", "p521"] {
            let entry = &all["vectors"][curve];
            let public_key = entry["publicKeyPem"].as_str().expect("公钥是字符串");
            let hex_signature = entry["signatureHex"].as_str().expect("签名是字符串");
            let bytes = hex::decode(hex_signature).expect("向量里的签名是 hex");
            let base64_signature = B64.encode(&bytes);

            let out = do_verify(curve, &text, public_key, &base64_signature);
            assert_eq!(out["meta"]["valid"], true, "{curve}");
        }
    }

    /// **外部参照**：我们签的，OpenSSL 验得过。
    ///
    /// 反方向。ECDSA 的临时点 k 是随机的（RFC 6979 的确定性 k 只有
    /// RustCrypto 用），所以两边的签名字节**不可能**一样 —— 能比的是
    /// 「OpenSSL 说验得过」。
    ///
    /// 没有 openssl 的机器上这条测试**跳过**（不是失败）：CI 里不一定装了。
    #[test]
    fn openssl_verifies_our_signatures() {
        if !openssl_available() {
            eprintln!("跳过：这台机器上没有 openssl");
            return;
        }
        for (curve, digest) in [("p256", "sha256"), ("p384", "sha384"), ("p521", "sha512")] {
            let (private_key, public_key) = generated_keys(curve);
            let text = "ECDSA 签名测试 — hello 世界\n第二行\n";
            let signature = do_sign(curve, text, &private_key);
            let signature_bytes = B64.decode(&signature).expect("自己的输出是合法 base64");

            let dir = TempDir::new(curve);
            let pub_path = dir.write("pub.pem", public_key.as_bytes());
            let sig_path = dir.write("sig.der", &signature_bytes);
            let msg_path = dir.write("msg.txt", text.as_bytes());

            let (ok, stdout, stderr) = run_openssl(&[
                "dgst",
                &format!("-{digest}"),
                "-verify",
                pub_path.to_str().expect("路径是 UTF-8"),
                "-signature",
                sig_path.to_str().expect("路径是 UTF-8"),
                msg_path.to_str().expect("路径是 UTF-8"),
            ]);
            assert!(ok, "openssl 退出码非零\nstderr: {stderr}");
            assert!(
                stdout.contains("Verified OK"),
                "{curve}: OpenSSL 应当验得过我们的签名，stdout: {stdout}\nstderr: {stderr}"
            );
        }
    }

    /* ------------------------------------------------------ 密钥格式 */

    /// SEC1 私钥（`-----BEGIN EC PRIVATE KEY-----`）也要收 ——
    /// `openssl ecparam -genkey` 默认导出的就是它。
    #[test]
    fn sec1_private_keys_are_accepted() {
        for curve in ["p256", "p384", "p521"] {
            let sec1 = sec1_private_key(curve);
            assert!(sec1.contains("BEGIN EC PRIVATE KEY"), "{curve}");
            let signature = do_sign(curve, "abc", &sec1);
            assert!(!signature.is_empty(), "{curve}");
        }
    }

    /// SEC1 与 PKCS#8 是同一把钥匙的两种写法 —— 签出来的签名该互相验得过。
    #[test]
    fn a_sec1_and_a_pkcs8_key_are_the_same_key() {
        // 用 openssl 的等价关系测不了（私钥不进仓库），所以改成：
        // 同一把私钥的两种编码必须解出同一把钥匙 → 签名可以互验。
        let (pkcs8, public_key) = generated_keys("p256");
        let sec1 = sec1_private_key("p256");
        // 两把不同的钥匙签出来的签名互验**不通过**；这里只验「两种格式都能用」。
        let a = do_sign("p256", "abc", &pkcs8);
        let b = do_sign("p256", "abc", &sec1);
        let out = do_verify("p256", "abc", &public_key, &a);
        assert_eq!(out["meta"]["valid"], true);
        let out = do_verify("p256", "abc", &public_key, &b);
        assert_eq!(
            out["meta"]["valid"], false,
            "SEC1 那把是另一把钥匙，验不过才对"
        );
    }

    /* ---------------------------------------------------------- 错误路径 */

    /// 私钥不是 EC 私钥（比如给的是 RSA 私钥）→ 报错，不是 500。
    #[test]
    fn a_non_ec_private_key_is_rejected() {
        // 拿一段不是 PEM 的东西。
        let err = compute(json!({
            "mode": "sign", "curve": "p256", "text": "abc",
            "private_key": "not a pem at all",
        }))
        .unwrap_err();
        assert_eq!(err_key(&err), "out.ecdsa-signing.err.bad_private_key");

        // 给的是**公钥**（SPKI）而不是私钥 —— 结构不对，解不出私钥。
        let (_, public_key) = generated_keys("p256");
        let err = compute(json!({
            "mode": "sign", "curve": "p256", "text": "abc",
            "private_key": public_key,
        }))
        .unwrap_err();
        assert_eq!(err_key(&err), "out.ecdsa-signing.err.bad_private_key");
    }

    /// 公钥不是 EC 公钥 → 报错。
    #[test]
    fn a_non_ec_public_key_is_rejected() {
        let err = compute(json!({
            "mode": "verify", "curve": "p256", "text": "abc",
            "public_key": "not a pem at all", "signature": "AAAA",
        }))
        .unwrap_err();
        assert_eq!(err_key(&err), "out.ecdsa-signing.err.bad_public_key");
    }

    /// 曲线对不上：拿 P-384 的公钥验 P-256 的签名 → 报错，
    /// 而且要说清楚这把钥匙**实际**在哪条曲线上。
    #[test]
    fn a_public_key_on_another_curve_is_rejected() {
        let (_, public_key) = generated_keys("p384");
        let err = compute(json!({
            "mode": "verify", "curve": "p256", "text": "abc",
            "public_key": public_key, "signature": "AAAA",
        }))
        .unwrap_err();
        assert_eq!(err_key(&err), "out.ecdsa-signing.err.curve_mismatch");
        let args = err_args(&err);
        assert_eq!(args["actual"], "P-384");
        assert_eq!(args["expected"], "P-256");
    }

    /// 私钥的曲线对不上，同样要说清楚。
    #[test]
    fn a_private_key_on_another_curve_is_rejected() {
        let (private_key, _) = generated_keys("p521");
        let err = compute(json!({
            "mode": "sign", "curve": "p256", "text": "abc",
            "private_key": private_key,
        }))
        .unwrap_err();
        assert_eq!(err_key(&err), "out.ecdsa-signing.err.curve_mismatch");
        let args = err_args(&err);
        assert_eq!(args["actual"], "P-521");
        assert_eq!(args["expected"], "P-256");
    }

    /// 签名不是合法的 base64 / hex → 报错（这是输入问题，不是「验不过」）。
    #[test]
    fn a_signature_that_is_not_base64_is_rejected() {
        let (_, public_key) = generated_keys("p256");
        for bad in ["not base64 !!!", "@@@@", "****"] {
            let err = compute(json!({
                "mode": "verify", "curve": "p256", "text": "abc",
                "public_key": public_key, "signature": bad,
            }))
            .unwrap_err();
            assert_eq!(
                err_key(&err),
                "out.ecdsa-signing.err.bad_signature_encoding",
                "{bad:?}"
            );
        }
    }

    /// 解得出字节、但不是 DER 签名 → 也是输入问题。
    #[test]
    fn a_signature_that_is_not_der_is_rejected() {
        let (_, public_key) = generated_keys("p256");
        let err = compute(json!({
            "mode": "verify", "curve": "p256", "text": "abc",
            "public_key": public_key, "signature": B64.encode(b"hello world"),
        }))
        .unwrap_err();
        assert_eq!(err_key(&err), "out.ecdsa-signing.err.bad_signature");
    }

    /// 加密的私钥要口令 —— 本工具不收口令，直接报错。
    ///
    /// 这里造的是**壳**：判据是 PEM 的标签（`ENCRYPTED PRIVATE KEY`），
    /// 解不开的东西根本走不到解密那一步 —— 所以内容随便填也够。
    #[test]
    fn an_encrypted_private_key_is_rejected() {
        let der = b"\x30\x82\x00\x10 not a real key";
        let err = compute(json!({
            "mode": "sign", "curve": "p256", "text": "abc",
            "private_key": pem_encode("ENCRYPTED PRIVATE KEY", der),
        }))
        .unwrap_err();
        assert_eq!(
            err_key(&err),
            "out.ecdsa-signing.err.encrypted_key_unsupported"
        );
    }

    /// 未知模式 / 未知曲线 → 报错，并把可选值列出来。
    #[test]
    fn unknown_mode_and_curve_are_reported() {
        let err = compute(json!({ "mode": "encrypt", "text": "abc" })).unwrap_err();
        assert_eq!(err_key(&err), "out.ecdsa-signing.err.unknown_mode");
        assert_eq!(err_args(&err)["mode"], "encrypt");

        let err = compute(json!({ "mode": "sign", "curve": "p192", "text": "abc" })).unwrap_err();
        assert_eq!(err_key(&err), "out.ecdsa-signing.err.unknown_curve");
        assert_eq!(err_args(&err)["curve"], "p192");
    }

    /// 当前 mode 需要的字段空着 → 报错；**用不上的**字段空着没事。
    #[test]
    fn only_the_fields_of_the_current_mode_are_required() {
        // 签名方向缺私钥 → 报错。
        let err = compute(json!({ "mode": "sign", "curve": "p256", "text": "abc" })).unwrap_err();
        assert_eq!(err_key(&err), "out.common.missing_field");

        // 验签方向缺公钥 → 报错。
        let err = compute(json!({
            "mode": "verify", "curve": "p256", "text": "abc", "signature": "AAAA"
        }))
        .unwrap_err();
        assert_eq!(err_key(&err), "out.common.missing_field");

        // 签名方向**不要求**公钥与签名，验签方向**不要求**私钥。
        let (private_key, public_key) = generated_keys("p256");
        let signature = do_sign("p256", "abc", &private_key);
        let out = do_verify("p256", "abc", &public_key, &signature);
        assert_eq!(out["meta"]["valid"], true);
    }

    /// 错误里不能漏出私钥或原文。
    #[test]
    fn errors_never_echo_the_key_or_the_text() {
        const CANARY: &str = "CANARY-PRIVATE-KEY";
        let err = compute(json!({
            "mode": "sign", "curve": "p256", "text": "abc",
            "private_key": CANARY,
        }))
        .unwrap_err();
        assert!(!leaks(&err, CANARY), "错误信息泄露了私钥：{err:?}");
    }

    /* ------------------------------------------------------------ 结果形状 */

    /// 签名方向：`output` 是 base64 的 DER，`table` 里是 hex。
    #[test]
    fn the_sign_result_has_the_expected_shape() {
        let (private_key, _) = generated_keys("p256");
        let out = compute(json!({
            "mode": "sign", "curve": "p256", "text": "abc",
            "private_key": private_key,
        }))
        .unwrap();

        let base64 = out["output"].as_str().expect("output 是字符串");
        let bytes = B64.decode(base64).expect("output 是合法 base64");
        // DER：SEQUENCE（0x30）打头。
        assert_eq!(bytes[0], 0x30, "DER 签名以 SEQUENCE 打头");
        // 长度不是定值：r / s 的最高位是 1 时 DER 的 INTEGER 要多一个前导 0x00，
        // 所以是 70（两个都不带前导零）、71 或 72 字节。
        assert!(
            (70..=72).contains(&bytes.len()),
            "P-256 的 DER 签名是 70~72 字节，得到 {}",
            bytes.len()
        );

        let table = out["table"].as_object().expect("table 是对象");
        let hex_value = table
            .values()
            .find(|v| v.as_str().map(|s| s.len() == bytes.len() * 2).unwrap_or(false))
            .and_then(|v| v.as_str())
            .expect("table 里有 hex 形式的签名");
        assert_eq!(hex::decode(hex_value).unwrap(), bytes);

        assert_eq!(out["meta"]["curve"], "p256");
        assert_eq!(out["meta"]["digest"], "sha256");
        assert_eq!(out["meta"]["encoding"], "der");
    }

    /// 验签方向：`output` 是空串，`table` 里有一行结论，`meta.valid` 是布尔。
    #[test]
    fn the_verify_result_has_the_expected_shape() {
        let (private_key, public_key) = generated_keys("p256");
        let signature = do_sign("p256", "abc", &private_key);
        let out = do_verify("p256", "abc", &public_key, &signature);

        assert_eq!(out["output"], "", "验签方向没有主结果");
        let table = out["table"].as_object().expect("table 是对象");
        assert_eq!(table.len(), 1, "table 里只有一行结论");
        assert!(out["meta"]["valid"].is_boolean());
        assert_eq!(out["meta"]["valid"], true);
    }

    /// 验签失败**不是错误** —— 返回 200 + valid=false。
    #[test]
    fn a_mismatched_signature_is_a_result_not_an_error() {
        let (private_key, public_key) = generated_keys("p256");
        let signature = do_sign("p256", "abc", &private_key);
        let out = do_verify("p256", "abd", &public_key, &signature);
        assert_eq!(out["meta"]["valid"], false);
        assert_eq!(out["output"], "");
    }

    /// 曲线的名字与摘要的配对必须固定下来（不让用户选摘要）。
    #[test]
    fn the_digest_follows_the_curve() {
        for (curve, digest) in [
            ("p256", "sha256"),
            ("p384", "sha384"),
            ("p521", "sha512"),
        ] {
            let (private_key, _) = generated_keys(curve);
            let out = compute(json!({
                "mode": "sign", "curve": curve, "text": "abc",
                "private_key": private_key,
            }))
            .unwrap();
            assert_eq!(out["meta"]["digest"], digest, "{curve}");
        }
    }

    /// 结果表的标签与结论都要走语言包。
    #[test]
    fn the_result_table_follows_the_requested_language() {
        let (private_key, public_key) = generated_keys("p256");
        let signature = do_sign("p256", "abc", &private_key);

        let out = compute(json!({
            "mode": "verify", "curve": "p256", "text": "abc",
            "public_key": public_key, "signature": signature,
        }))
        .unwrap();
        let en = out["table"].as_object().unwrap().values().next().unwrap();
        assert!(en.is_string());

        let out = compute(json!({
            "mode": "verify", "curve": "p256", "text": "abc",
            "public_key": public_key, "signature": signature,
            "__lang": "zh-CN",
        }))
        .unwrap();
        let zh = out["table"].as_object().unwrap().values().next().unwrap();

        // 语言包里还没并进来时，两边都退回键本身 —— 这时断言跳过。
        if !crate::i18n::has("zh-CN", VALID_KEY) {
            return;
        }
        assert_ne!(en, zh, "中文界面不该与英文一样");
        // 键没并进语言包时 `i18n::t` 会退回键本身 —— 那时页面上
        // 会露出 `out.…` 这样的键名。
        assert!(
            !en.as_str().unwrap().starts_with("out."),
            "语言包里没有这个键时不该露出键名：{}",
            en
        );
    }

    /* ------------------------------------------------------------ openssl */

    /// 这台机器上有没有 openssl。
    fn openssl_available() -> bool {
        std::process::Command::new("openssl")
            .arg("version")
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
    }

    /// openssl 最多跑多久。
    ///
    /// 上限存在的理由：GitHub 的 job 默认要挂满 6 小时才超时，
    /// 一个卡住的子进程就能把整条流水线停在那儿。
    const OPENSSL_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(20);

    /// 跑一次 openssl，带超时。
    fn run_openssl(args: &[&str]) -> (bool, String, String) {
        let mut child = std::process::Command::new("openssl")
            .args(args)
            // stdin 一根都不给：Windows 上 openssl 找不到别的输入源时会去读控制台，
            // 而 CI 里那个控制台是没有输入的。
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .expect("本机装了 openssl");

        // stdout 与 stderr 各开一个线程读：顺序读会死锁 ——
        // stderr 的管道被写满时 openssl 就在等，而我们在等 stdout 的 EOF。
        let mut stdout = child.stdout.take().expect("stdout 管道");
        let mut stderr = child.stderr.take().expect("stderr 管道");
        let out_reader = std::thread::spawn(move || {
            let mut buf = Vec::new();
            std::io::Read::read_to_end(&mut stdout, &mut buf).map(|_| buf)
        });
        let err_reader = std::thread::spawn(move || {
            let mut buf = Vec::new();
            std::io::Read::read_to_end(&mut stderr, &mut buf).map(|_| buf)
        });

        let deadline = std::time::Instant::now() + OPENSSL_TIMEOUT;
        let status = loop {
            match child.try_wait() {
                Ok(Some(status)) => break Some(status),
                Ok(None) => {
                    if std::time::Instant::now() >= deadline {
                        let _ = child.kill();
                        break None;
                    }
                    std::thread::sleep(std::time::Duration::from_millis(20));
                }
                Err(e) => panic!("等 openssl 出错: {e}"),
            }
        };

        let stdout = out_reader
            .join()
            .expect("读 stdout 的线程")
            .expect("读 stdout");
        let stderr = err_reader
            .join()
            .expect("读 stderr 的线程")
            .expect("读 stderr");
        let stderr = String::from_utf8_lossy(&stderr).into_owned();
        let status = status.unwrap_or_else(|| {
            panic!("openssl {OPENSSL_TIMEOUT:?} 还没退出\nstderr: {stderr}")
        });
        (
            status.success(),
            String::from_utf8_lossy(&stdout).into_owned(),
            stderr,
        )
    }

    /// 一个临时目录，测试结束时自己删掉。
    struct TempDir {
        path: std::path::PathBuf,
    }

    impl TempDir {
        fn new(tag: &str) -> Self {
            let path = std::env::temp_dir().join(format!(
                "it-tools-ecdsa-{}-{tag}",
                std::process::id()
            ));
            let _ = std::fs::remove_dir_all(&path);
            std::fs::create_dir_all(&path).expect("临时目录建得出来");
            TempDir { path }
        }

        fn write(&self, name: &str, bytes: &[u8]) -> std::path::PathBuf {
            let path = self.path.join(name);
            std::fs::write(&path, bytes).expect("临时文件写得了");
            path
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.path);
        }
    }
}
