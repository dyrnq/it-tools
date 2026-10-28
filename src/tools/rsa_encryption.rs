//! RSA 加解密（endpoint `rsa-encryption`）。
//!
//! 参考实现是 `it-tools2/src/tools/rsa-encryption/rsa-encryption.vue`
//! （Vue + node-forge）。**当参考，不当目标** —— 只借它的**方案清单**，
//! 算法实现全部用 `rsa` crate 重写。
//!
//! ## 与参考实现最大的差别：私钥要经过服务端
//!
//! node-forge 那套整个跑在浏览器里，私钥从进页面到出结果一次都没离开过浏览器。
//! 我们这边是服务端实现，私钥必然在服务端的内存里待过 —— 这是没法绕开的，
//! 只能诚实说明。除此以外的行为差异都是从这一条派生出来的：
//!
//! - **错误信息里绝不回显私钥、口令、明文**。参考实现在浏览器里报错，
//!   把异常原文往界面上摆也没外泄风险；服务端不行。这里的每一个 `map_err`
//!   都只带一个**自己写的**错误键，不带 crate 的原文，也不带用户输入。
//! - **口令与私钥不落盘、不进日志**。口令只活在这一次请求的堆上
//!   （`RsaPrivateKey` 是 `ZeroizeOnDrop`，解密出来的 DER 缓冲也是）。
//!
//! ## 方案清单：四档做三档
//!
//! node-forge 的下拉框有四档，我们做三档：
//!
//! | 下拉值 | 含义 | 备注 |
//! |---|---|---|
//! | `pkcs1v15` | RSAES-PKCS1-v1_5 | 兼容性最好；**有填充预言攻击**（Bleichenbacher / Marvin），只配老系统用 |
//! | `oaep-sha1` | RSAES-OAEP，摘要 SHA-1 | node-forge 的 `RSA-OAEP` 默认就是 SHA-1 |
//! | `oaep-sha256` | RSAES-OAEP，摘要 SHA-256（MGF1 也是 SHA-256） | 现在的默认 |
//!
//! ### 为什么不做 node-forge 的第四档 `RSAES-OAEP/SHA-256/MGF1-SHA-1`
//!
//! node-forge 那一档的注释写着「compatible with Java's
//! `RSA/ECB/OAEPWithSHA-256AndMGF1Padding`」，但**这个名字是个历史包袱**：
//! Java 那个 `OAEPWithSHA-256AndMGF1Padding` 其实是「摘要用 SHA-256、
//! MGF1 用 SHA-1」这个变体（Java 8 的默认 MGF1 摘要当年被写死成 SHA-1），
//! 它跟「OAEP + SHA-256」（MGF1 也是 SHA-256）**不是一回事**。
//! 两者的密文互不兼容，而且解密方**不会报错** —— OAEP 的完整性检查会通过，
//! 解出来是垃圾数据。这是最坏的一种不兼容：静默的。
//!
//! 所以这里**不做**那一档，也不把它挂在「OAEP-SHA-256」名下 —— 挂上去等于
//! 让用户以为「选 SHA-256」就够，实际上两套系统之间还是会静默错位。
//!
//! **要用 Java 那套怎么办**：Java 侧改用 `OAEPParameterSpec` 显式指定
//! MGF1 的摘要（`new OAEPParameterSpec("SHA-256", "MGF1", MGF1ParameterSpec.SHA256, PSource.PSpecified.DEFAULT)`），
//! 或者干脆用 `OAEPWithSHA-256AndMGF1Padding` 但**两边都统一**成
//! 「摘要 SHA-256 + MGF1 SHA-1」这一种。本工具不提供这一档，
//! 需要时请用别的工具（OpenSSL 的 `pkeyutl -pkeyopt rsa_mgf1_md:sha1` 可以）。
//!
//! ## 加密后的私钥（口令）
//!
//! 参考实现调的是 node-forge 的 `pki.decryptRsaPrivateKey(pem, passphrase)`，
//! 它吃的是**传统 OpenSSL PEM 加密**（`Proc-Type: 4,ENCRYPTED` +
//! `DEK-Info: AES-128-CBC,…`）—— 密钥由 `EVP_BytesToKey`（MD5、1 次迭代，
//! 盐是 IV 的**前 8 字节**）从口令派生。正文解密后是 PKCS#1 的 DER。
//!
//! 这里走同一条链：仓库里 `rsa_formats` 加密时用的就是它，
//! `encryption::evp_bytes_to_key` + `encryption::cbc_decrypt` 是它的下半截，
//! 所以本工具能解开**本仓库 `rsa-key-pair-generator` 生成的加密私钥**。
//!
//! **PKCS#8 的 `ENCRYPTED PRIVATE KEY`（PBES2）不支持** —— 那条路要
//! `rsa` crate 的 `pkcs5` 特性（`pkcs8/encryption`），而它不是默认特性，
//! 加它要动 `Cargo.toml`（本批工具的约定是 Cargo.toml 由上游统一改）。
//! 遇到这种私钥会明确报错，并告诉用户怎么转成传统格式。
//!
//! ## 一张表单装两个方向
//!
//! 与 `argon2` 一样：注册表只画得出一个 `text` 框，第二个方向（公钥/私钥）
//! 画不出来。所以合成一张表单，用 `mode` 分流：
//!
//! - `mode = encrypt` → 要 `public_key`，`text` 是**明文**，输出是 base64 密文；
//! - `mode = decrypt` → 要 `private_key`，`text` 是 **base64 密文**，输出是明文。
//!
//! **当前方向用不到的字段留空即可**，不因为「另一个方向的字段是空的」就报错。

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine as _;
use rsa::pkcs1::{DecodeRsaPrivateKey, DecodeRsaPublicKey};
use rsa::pkcs8::{DecodePrivateKey, DecodePublicKey};
use rsa::traits::PublicKeyParts;
use rsa::{Oaep, Pkcs1v15Encrypt, RsaPrivateKey, RsaPublicKey};
use serde_json::{json, Map, Value};
use sha1::Sha1;
use sha2::Sha256;

use super::util;
use super::{ToolError, ToolResult};

/// `mode` 的默认值，与注册表 `ApiField { name: "mode", default: Some("encrypt") }` 一致。
const DEFAULT_MODE: &str = "encrypt";

/// `padding` 的默认值，与注册表 `ApiField { name: "padding", default: Some("oaep-sha256") }` 一致。
const DEFAULT_PADDING: &str = "oaep-sha256";

/// `mode` 的合法取值（错误信息里回显用）。
const ALLOWED_MODES: &str = "encrypt / decrypt";

/// `padding` 的合法取值（错误信息里回显用）。
const ALLOWED_PADDINGS: &str = "pkcs1v15 / oaep-sha1 / oaep-sha256";

/// PEM 传统加密里 `EVP_BytesToKey` 用的盐长度 —— 是 IV 的**前 8 字节**。
///
/// OpenSSL 的 `PEM_do_header` 取 `min(iv_len, PKCS5_SALT_LEN)`，而
/// `PKCS5_SALT_LEN` 就是 8。AES 的 IV 是 16 字节，于是盐是前 8 字节；
/// DES / 3DES 的 IV 正好 8 字节，盐就是整个 IV。
const PEM_SALT_LEN: usize = 8;

/// 填充方案。
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Padding {
    /// RSAES-PKCS1-v1_5。兼容性最好，但有填充预言攻击。
    Pkcs1v15,
    /// RSAES-OAEP，摘要 SHA-1（MGF1 也是 SHA-1）。
    OaepSha1,
    /// RSAES-OAEP，摘要 SHA-256（MGF1 也是 SHA-256）。
    OaepSha256,
}

impl Padding {
    /// 解析注册表下拉框送来的字符串。未知取值返回 `None`（由调用方报错）。
    fn parse(raw: &str) -> Option<Self> {
        match raw {
            "pkcs1v15" => Some(Self::Pkcs1v15),
            "oaep-sha1" => Some(Self::OaepSha1),
            "oaep-sha256" => Some(Self::OaepSha256),
            _ => None,
        }
    }

    /// 机器可读的名字（结果表与 meta 里用）。
    fn name(self) -> &'static str {
        match self {
            Self::Pkcs1v15 => "pkcs1v15",
            Self::OaepSha1 => "oaep-sha1",
            Self::OaepSha256 => "oaep-sha256",
        }
    }

    /// 这一档能装下的明文最多多少字节。
    ///
    /// - PKCS#1 v1.5：`k - 11`（`0x00 0x02` + 至少 8 字节非零填充 + `0x00`）；
    /// - OAEP：`k - 2*hLen - 2`（摘要 + MGF1 各一份种子，再加一个 `0x01`）。
    ///
    /// 用 `saturating_sub`：模数太小时（理论上 512 位以下）减法会下溢，
    /// 而这里只是给错误信息报个上限，不值得为它 panic。
    fn max_plaintext_len(self, key_size: usize) -> usize {
        match self {
            Self::Pkcs1v15 => key_size.saturating_sub(11),
            Self::OaepSha1 => key_size.saturating_sub(2 * 20 + 2),
            Self::OaepSha256 => key_size.saturating_sub(2 * 32 + 2),
        }
    }
}

/// 对外只暴露这一个。
///
/// RSA 加解密本身是微秒级的，但密钥解析与 blinding 都在 blocking 线程池里跑，
/// 免得一个畸形的大输入把 actix 的 worker 占住。
pub async fn handle(payload: Value) -> ToolResult {
    util::blocking(move || compute(payload)).await
}

fn compute(payload: Value) -> ToolResult {
    let mode = util::str_or(&payload, "mode", DEFAULT_MODE).to_ascii_lowercase();
    let padding = padding_of(&payload)?;

    match mode.as_str() {
        "encrypt" => run_encrypt(&payload, padding),
        "decrypt" => run_decrypt(&payload, padding),
        other => Err(ToolError::invalid(
            "out.rsa-encryption.err.unknown_mode",
            &[("mode", other), ("allowed", ALLOWED_MODES)],
        )),
    }
}

/// 解析填充方案。缺字段 / 空串退回默认档（`oaep-sha256`），未知取值报错。
///
/// 不用「未知就退回默认」：填充方案错了会让人拿到一段解不开的密文，
/// 而报错只花一眼。
fn padding_of(payload: &Value) -> Result<Padding, ToolError> {
    let raw = util::str_or(payload, "padding", DEFAULT_PADDING);
    // 大小写不敏感（跟 `mode` 一样），但报错里回显**用户原样写的东西** ——
    // 告诉对方「你写的那个值不对」比告诉他「我们把它转小写了之后对不上」有用。
    Padding::parse(&raw.to_ascii_lowercase()).ok_or_else(|| {
        ToolError::invalid(
            "out.rsa-encryption.err.unknown_padding",
            &[("padding", raw), ("allowed", ALLOWED_PADDINGS)],
        )
    })
}

/// 取一个**当前方向必需**的字段。空串与纯空白都算没填。
///
/// 不用 `util::req_str`：那条给的是 `out.common.missing_field`（一句
/// 「缺少字段 `public_key`」），而这里要说的是「请输入用于加密的公钥」——
/// 方向不同，缺的东西也不同。
fn required_field<'a>(
    payload: &'a Value,
    name: &str,
    key: &'static str,
) -> Result<&'a str, ToolError> {
    match util::opt_str(payload, name) {
        Some(s) if !s.trim().is_empty() => Ok(s),
        _ => Err(ToolError::invalid(key, &[])),
    }
}

/* ------------------------------------------------------------------ 加密 */

fn run_encrypt(payload: &Value, padding: Padding) -> ToolResult {
    let pem = required_field(
        payload,
        "public_key",
        "out.rsa-encryption.err.missing_public_key",
    )?;
    let key = parse_public_key(pem)?;

    // 明文按 UTF-8 取字节（node-forge 的 `encrypt` 也是 `encodeUtf8`）。
    // 空明文是合法的：PKCS#1 v1.5 与 OAEP 都允许消息长度为 0。
    let text = util::opt_str(payload, "text").unwrap_or("");

    let ciphertext = encrypt_with(padding, &key, text.as_bytes()).map_err(|e| {
        // `rsa::Error` 不带任何密钥材料，但 `MessageTooLong` 要单独说：
        // 「文本太长」和「算错了」对用户是两件完全不同的事。
        if matches!(e, rsa::Error::MessageTooLong) {
            let max = padding.max_plaintext_len(key.size()).to_string();
            ToolError::invalid("out.rsa-encryption.err.text_too_long", &[("max", &max)])
        } else {
            ToolError::invalid("out.rsa-encryption.err.encrypt_failed", &[])
        }
    })?;

    Ok(finish(
        payload,
        "encrypt",
        padding,
        key.size() * 8,
        B64.encode(&ciphertext),
    ))
}

/* ------------------------------------------------------------------ 解密 */

fn run_decrypt(payload: &Value, padding: Padding) -> ToolResult {
    let pem = required_field(
        payload,
        "private_key",
        "out.rsa-encryption.err.missing_private_key",
    )?;
    let passphrase = util::opt_str(payload, "passphrase").unwrap_or("");
    let key = parse_private_key(pem, passphrase)?;

    let text = util::opt_str(payload, "text").unwrap_or("");
    let ciphertext = decode_ciphertext(text)?;

    let plaintext = decrypt_with(padding, &key, &ciphertext).map_err(|_| {
        // 一律回同一句话：私钥与密文不配对、填充方案选错、密文被改过，
        // 在这里**分不开**，也不该分开 —— 分开就成了一个「密文是不是
        // 某个格式」的预言机。
        ToolError::invalid("out.rsa-encryption.err.decrypt_failed", &[])
    })?;

    // RSA 加密的是**字节**，不是文本。解出来的字节不一定是 UTF-8 ——
    // 这时明确报错，而不是用 U+FFFD 悄悄替换（那会毁掉数据还不说）。
    let output = String::from_utf8(plaintext)
        .map_err(|_| ToolError::invalid("out.rsa-encryption.err.not_utf8", &[]))?;

    Ok(finish(payload, "decrypt", padding, key.size() * 8, output))
}

/// 组装结果 JSON。
///
/// 结果表里的行标题走语言包（英文界面下不能露中文），值是机器可读的
/// （方向名、填充名、密钥位数）。
fn finish(payload: &Value, mode: &str, padding: Padding, key_bits: usize, output: String) -> Value {
    let mut table = Map::new();
    util::row_str(&mut table, payload, "out.rsa-encryption.mode", mode);
    util::row_str(
        &mut table,
        payload,
        "out.rsa-encryption.padding",
        padding.name(),
    );
    util::row(
        &mut table,
        payload,
        "out.rsa-encryption.key_size",
        json!(key_bits),
    );

    json!({
        "output": output,
        "table": table,
        "rows": [],
        "meta": {
            "mode": mode,
            "padding": padding.name(),
            "key_size": key_bits,
        },
    })
}

/* ------------------------------------------------------------------ 加解密 */

/// 按填充方案加密。
///
/// 随机源用 `rand::rng()`（线程本地的 CSPRNG，Linux 上落到 `getrandom(2)`）——
/// OAEP 与 PKCS#1 v1.5 的填充都要它，每次加密的密文都不一样。
fn encrypt_with(padding: Padding, key: &RsaPublicKey, msg: &[u8]) -> Result<Vec<u8>, rsa::Error> {
    let mut rng = rand::rng();
    match padding {
        // `Pkcs1v15Encrypt` 是**加密**用的那个；同名的 `Pkcs1v15Sign`
        // 是签名方案（`SignatureScheme`），不是填充方案，不能拿来加密。
        Padding::Pkcs1v15 => key.encrypt(&mut rng, Pkcs1v15Encrypt, msg),
        // `Oaep::new` 让 MGF1 用**同一个**摘要 —— 这正是 node-forge
        // `RSA-OAEP`（默认 SHA-1）与 `RSA-OAEP` + `md: sha256` 的口径。
        Padding::OaepSha1 => key.encrypt(&mut rng, Oaep::<Sha1>::new(), msg),
        Padding::OaepSha256 => key.encrypt(&mut rng, Oaep::<Sha256>::new(), msg),
    }
}

/// 按填充方案解密。
///
/// 走 `decrypt_blinded`（带盲化）而不是 `decrypt`：盲化让解密时间
/// 不依赖私钥的比特，避免计时侧信道。
fn decrypt_with(
    padding: Padding,
    key: &RsaPrivateKey,
    ciphertext: &[u8],
) -> Result<Vec<u8>, rsa::Error> {
    let mut rng = rand::rng();
    match padding {
        Padding::Pkcs1v15 => key.decrypt_blinded(&mut rng, Pkcs1v15Encrypt, ciphertext),
        Padding::OaepSha1 => key.decrypt_blinded(&mut rng, Oaep::<Sha1>::new(), ciphertext),
        Padding::OaepSha256 => key.decrypt_blinded(&mut rng, Oaep::<Sha256>::new(), ciphertext),
    }
}

/// 密文 → 字节。
///
/// base64 解码前先去掉所有空白：从邮件、聊天窗口、编辑器里复制出来的
/// base64 常常是带换行的。
fn decode_ciphertext(text: &str) -> Result<Vec<u8>, ToolError> {
    let compact: String = text.chars().filter(|c| !c.is_whitespace()).collect();
    B64.decode(compact.as_bytes())
        .map_err(|_| ToolError::invalid("out.rsa-encryption.err.bad_base64", &[]))
}

/* ------------------------------------------------------------------ 公钥 */

/// 解析 PEM 公钥。
///
/// 两种形态都收：
/// - `PUBLIC KEY`（SPKI）—— 绝大多数工具给的就是这一种；
/// - `RSA PUBLIC KEY`（PKCS#1）—— 老工具的形态。
///
/// 证书（`CERTIFICATE`）不收 —— node-forge 的 `publicKeyFromPem` 也不收，
/// 收了反而会让人以为「证书里的公钥」是另一回事。
fn parse_public_key(pem: &str) -> Result<RsaPublicKey, ToolError> {
    if let Ok(key) = RsaPublicKey::from_public_key_pem(pem) {
        return Ok(key);
    }
    if let Ok(key) = RsaPublicKey::from_pkcs1_pem(pem) {
        return Ok(key);
    }
    Err(ToolError::invalid(
        "out.rsa-encryption.err.bad_public_key",
        &[],
    ))
}

/* ------------------------------------------------------------------ 私钥 */

/// 解析 PEM 私钥（可带口令）。
///
/// 形态：
/// - `RSA PRIVATE KEY`（PKCS#1）—— 本仓库 `rsa-key-pair-generator` 给的就是这一种；
/// - `PRIVATE KEY`（PKCS#8）；
/// - `RSA PRIVATE KEY` + `Proc-Type: 4,ENCRYPTED` —— 传统 OpenSSL 加密，要口令。
fn parse_private_key(pem: &str, passphrase: &str) -> Result<RsaPrivateKey, ToolError> {
    let block = pem::parse(pem)
        .map_err(|_| ToolError::invalid("out.rsa-encryption.err.bad_private_key", &[]))?;

    match block.tag() {
        // PKCS#8 的加密私钥：PBES2，本工具不支持（要 `rsa/pkcs5` 特性）。
        "ENCRYPTED PRIVATE KEY" => Err(ToolError::invalid(
            "out.rsa-encryption.err.encrypted_private_key_unsupported",
            &[],
        )),
        "RSA PRIVATE KEY" | "PRIVATE KEY" => {
            // `Proc-Type: 4,ENCRYPTED` 头 = 传统 OpenSSL PEM 加密。
            let dek = block.headers().get("DEK-Info");
            let encrypted = block
                .headers()
                .get("Proc-Type")
                .map(|p| p.trim().eq_ignore_ascii_case("4,ENCRYPTED"))
                .unwrap_or(false);

            if encrypted {
                let dek = dek.ok_or_else(|| {
                    ToolError::invalid("out.rsa-encryption.err.bad_private_key", &[])
                })?;
                if passphrase.is_empty() {
                    return Err(ToolError::invalid(
                        "out.rsa-encryption.err.missing_passphrase",
                        &[],
                    ));
                }
                let plain = decrypt_pem_traditional(block.contents(), dek, passphrase)?;
                // 解出来的是 PKCS#1 的 DER（`RSA PRIVATE KEY`）。
                RsaPrivateKey::from_pkcs1_der(&plain).map_err(|_| {
                    ToolError::invalid("out.rsa-encryption.err.private_key_decrypt_failed", &[])
                })
            } else {
                // 没加密的私钥。给口令也没关系（node-forge 也是直接忽略的）。
                // 两个分支的错误类型不一样（pkcs1::Error 与 pkcs8::Error），
                // 所以各写各的 map_err，不硬凑成一个。
                let parsed = match block.tag() {
                    "RSA PRIVATE KEY" => {
                        RsaPrivateKey::from_pkcs1_der(block.contents()).map_err(|_| {
                            ToolError::invalid("out.rsa-encryption.err.bad_private_key", &[])
                        })?
                    }
                    _ => RsaPrivateKey::from_pkcs8_der(block.contents()).map_err(|_| {
                        ToolError::invalid("out.rsa-encryption.err.bad_private_key", &[])
                    })?,
                };
                Ok(parsed)
            }
        }
        _ => Err(ToolError::invalid(
            "out.rsa-encryption.err.bad_private_key",
            &[],
        )),
    }
}

/// 传统 OpenSSL PEM 加密的解密。
///
/// `Proc-Type: 4,ENCRYPTED` + `DEK-Info: <算法>,<IV>`：密钥由
/// `EVP_BytesToKey`（MD5、1 次迭代）从「口令 ‖ 盐」派生，盐是 IV 的**前 8 字节**
/// （OpenSSL 的 `PEM_do_header` 取 `min(iv_len, PKCS5_SALT_LEN)`，
/// 而 `PKCS5_SALT_LEN` 是 8）；IV 本身明文写在 `DEK-Info` 里。
///
/// 正文解密后是 PKCS#1 的 DER。这条链与 `rsa_formats::encrypt_pem_traditional`
/// （本仓库 `rsa-key-pair-generator` 的加密那一半）是同一条，所以两边互通。
fn decrypt_pem_traditional(
    body: &[u8],
    dek_info: &str,
    passphrase: &str,
) -> Result<Vec<u8>, ToolError> {
    let (algorithm, iv_hex) = dek_info
        .split_once(',')
        .ok_or_else(|| ToolError::invalid("out.rsa-encryption.err.bad_private_key", &[]))?;
    let algorithm = algorithm.trim();
    let iv = hex::decode(iv_hex.trim())
        .map_err(|_| ToolError::invalid("out.rsa-encryption.err.bad_private_key", &[]))?;

    let fail = || ToolError::invalid("out.rsa-encryption.err.private_key_decrypt_failed", &[]);

    // 派生密钥。口令错了、IV 错了、密文被改过 —— 都会在下面某一步失败，
    // 全部回同一句话（不区分「口令错」与「文件坏」是故意的：
    // 区分开就成了一个「这个口令对不对」的预言机）。
    let derive = |key_len: usize| -> Vec<u8> {
        let salt_len = iv.len().min(PEM_SALT_LEN);
        super::encryption::evp_bytes_to_key(passphrase.as_bytes(), &iv[..salt_len], key_len, 0).0
    };

    match algorithm {
        "AES-128-CBC" => {
            let key = derive(16);
            super::encryption::cbc_decrypt::<cbc::Decryptor<aes::Aes128>>(&key, &iv, body)
                .map_err(|_| fail())
        }
        "AES-192-CBC" => {
            let key = derive(24);
            super::encryption::cbc_decrypt::<cbc::Decryptor<aes::Aes192>>(&key, &iv, body)
                .map_err(|_| fail())
        }
        "AES-256-CBC" => {
            let key = derive(32);
            super::encryption::cbc_decrypt::<cbc::Decryptor<aes::Aes256>>(&key, &iv, body)
                .map_err(|_| fail())
        }
        "DES-EDE3-CBC" => {
            let key = derive(24);
            super::encryption::cbc_decrypt::<cbc::Decryptor<des::TdesEde3>>(&key, &iv, body)
                .map_err(|_| fail())
        }
        "DES-CBC" => {
            let key = derive(8);
            super::encryption::cbc_decrypt::<cbc::Decryptor<des::Des>>(&key, &iv, body)
                .map_err(|_| fail())
        }
        other => Err(ToolError::invalid(
            "out.rsa-encryption.err.unsupported_dek_cipher",
            &[("cipher", other)],
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rsa::pkcs1::{EncodeRsaPrivateKey, EncodeRsaPublicKey};
    use rsa::pkcs8::{EncodePrivateKey, EncodePublicKey, LineEnding};
    use rsa::traits::PrivateKeyParts;

    /* ------------------------------------------------------- 外部参照的密钥 */

    /// 一把 **2048 位**的 RSA 密钥，只用于测试。
    ///
    /// 它是**公开的测试密钥**（谁都能从这串 base64 里把它还原出来），
    /// 绝对不能拿去保护任何真实数据 —— 这里只是要一把固定的钥匙，
    /// 好让「同一把钥匙、同一条明文」的期望值能被写死。
    ///
    /// 生成方式：`openssl genrsa -traditional -out key.pem 2048`
    const TEST_PRIVATE_KEY_PKCS1: &str = "-----BEGIN RSA PRIVATE KEY-----\n\
MIIEowIBAAKCAQEAoMi0h3ZDrsnIte59wIDWzopjU26UfbJBWqgwFWUqbHo6iZUL\n\
k5dqhWkYKGtSBdqGlHxlgMDhVTMs0oTt9QOYRdWpYHnLJCBvh8IQW1VeLV7dwxbx\n\
6ANphgYztR9VPb3cf0mEGVv4fFTFuNdh2NcaueeK1UfyFOJk+f38P7nWfCaBrfhg\n\
gip7kVH37yLuiCEC19Mtr0HcX/F4SpRiZGjXeml7fSzs+vj7qSD5su5vDmC3myib\n\
MoS9/ONxwIsgVXKdgoAMDxQMLNQIHLc5AUK4XhfXgDyuZ3+tSJNBkuUycg8CeJbs\n\
T2LXRr42AXPDaHaYptft3iwG8coQBuEOZKwmYwIDAQABAoIBACHfNn0FMqwLcX+2\n\
XwKjgd1gNR2aAalbWL5PCVYwilfxBgz++8Hbl8LESaUWOuDl0Q1OCZouyCnJTquI\n\
+pJv7+/iW7zp25xgQu7AOO7s1JrNTf2wA0VkFqJ4AwOotq37pgygwbYP9JDI0SCo\n\
K0Jhyo0YlNxqvDqfGTO7SJ1qOp/LrVDAG8VyNfXiv+vqOnKgUmKUh2rzynEHMm5b\n\
pEFFzkVlipypVTNvX/uyPk29egh1B7NnOIWxX2W/jygSzcGYe03ROQ2q6uUhZ3ml\n\
rT1QmBQosOyx+t8VSgwJusw7Ff59CXk8LrNDKZODCAWO58lDN9/vR/1+cAi69Xqs\n\
ZIr9nRECgYEA1lTqT/GzUaMcCkLpB5ue46kWdkzFQror7XuZsYHfKUPN08MpXZjz\n\
vJ7o98V1iBLi++P1qfohB54VrEEkrRWZ+v6S7phacFZVqrM9n046aDN0O2otDbN7\n\
y2mrGJcJJG5UgxWmAAjCORfOP8zBgGdYNffZ2FAiQ/6KXPnZJt2+7vMCgYEAwArF\n\
pgfBdpmQBKvJpGEdJrQCY05wX6uLf01cMSHWy7zYo77feHzi7TG6QXipa+4ALFml\n\
lrpJkQZGnuQJn3STQwcenYar848jc5i3mP6yNyOzC1vYeS4Eu5pveStdx5TYyWHt\n\
fA+PbFbY1Hnu+Jn88UTFlpCd5vli6CJY5q0hJtECgYEAxpJZm8OErUf+/IrNNx04\n\
8heAFg4+W/n8JMP0uv5l8Oc+1MjllC/W8ZQQpy2sHGvTHCgxPE/fNh2CWtrnzexL\n\
gr1FCATjFV0HdWUm3GcvucaiE0Hlh+IX+Xdm6xtTfwsxBVmTOEjlGNwzW+yqAfq9\n\
QRLmI4DqnjA/pLBePaIH+X0CgYB2qjFXVpOE5X7IZB5FJH0O3UxccKufcjDQiMze\n\
zzoayqZTCC6uFP1j88ZTjmuh9X7F6N8ZNCMhKe+ZXu9TSIV2dX/FduHprhkJ5OQN\n\
9dPJnpWT/zzUJEtoYRVgmhtop+ENDyXf8v18xG1XXcD8fKp/qy8syk/H2XH0XsTw\n\
RSqnAQKBgG5xNbBxlyyuWxvHUGQuV17xTlf4Kx3H8di+w0g5lBbehy5QfsUBneC6\n\
ZZEK6hLmYhCFwJEs/VD0kiKI+hImilaKJ4PY0yFqfZr42eeUCBL+SkjhIiOABoif\n\
LuEZJ9Wc9Rk1+xnt5hta+ngwOi6mvHCAthX41YxxCYwJKxUfoi83\n\
-----END RSA PRIVATE KEY-----\n";

    /// 同一把钥匙的 SPKI 公钥（`openssl rsa -pubout`）。
    const TEST_PUBLIC_KEY_SPKI: &str = "-----BEGIN PUBLIC KEY-----\n\
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAoMi0h3ZDrsnIte59wIDW\n\
zopjU26UfbJBWqgwFWUqbHo6iZULk5dqhWkYKGtSBdqGlHxlgMDhVTMs0oTt9QOY\n\
RdWpYHnLJCBvh8IQW1VeLV7dwxbx6ANphgYztR9VPb3cf0mEGVv4fFTFuNdh2Nca\n\
ueeK1UfyFOJk+f38P7nWfCaBrfhggip7kVH37yLuiCEC19Mtr0HcX/F4SpRiZGjX\n\
eml7fSzs+vj7qSD5su5vDmC3myibMoS9/ONxwIsgVXKdgoAMDxQMLNQIHLc5AUK4\n\
XhfXgDyuZ3+tSJNBkuUycg8CeJbsT2LXRr42AXPDaHaYptft3iwG8coQBuEOZKwm\n\
YwIDAQAB\n\
-----END PUBLIC KEY-----\n";

    /// 用口令 `s3cret` 加密的传统 PEM 私钥（AES-128-CBC）。
    ///
    /// `openssl rsa -in key.pem -traditional -aes128 -passout pass:s3cret`
    const TEST_PRIVATE_KEY_AES128: &str = "-----BEGIN RSA PRIVATE KEY-----\n\
Proc-Type: 4,ENCRYPTED\n\
DEK-Info: AES-128-CBC,44193AF6F4393B15BC569C336D44EE4E\n\
\n\
+p+hLtpc9eUJwu/aJPuiOSk4O4ChPzOrRzAcyhFbY7jAyyVnGhyXv9qeX2hBZdob\n\
1DGgNpMcWBt7QNSwRdWmIJoRbmdHi2TLoYGKSCr/Tkkz4UFqFi/Sc+u1jR2kg2h4\n\
pstIb5RDh0zX1jdT4iTZzZ2XQbDRlgPZvTJ0+x1ci6cBPx+yeGwRoP3jI1d+rY6L\n\
80/UnqhxUcHhVWXeSjw5cCovSZbqS2LOX5sbJNwXQzM//ttZZ8XcIMlJG2tzy52j\n\
MQkpBSH2LZGkDjuvC7YzRdm0yLkjmllMXllkK4OChFUSqu9LIp3sGfHfxgY+wD9F\n\
RLXOIKdHl7PIt7WEwnCq8nypjQXFPRwY1IQMN5yQbstCJ6AB3ncV3PUgRE2hAkFM\n\
Dl/pbM0+HWLS2SPvHrGcoPlZROqIalXr/E9LdG4NXSj0BCx86gahzuKyf11dU/xq\n\
SpGDcJ68+MqlL859y5Ov+XNIdS0wUFbZkedriE/P7Ek7ry2QIDxXr/PQtEkw9vkn\n\
2jZ1deutJOfgL6iscXmLyQt1cGWNB7mpLDKrWxWkAe5pP9GLOBKoAxkl3T270tqX\n\
0R6CZcOkutbLtGwDWmf5Jv4SYrDkNuOiwHUDGdZgjYoGWWoRqMTnqE3iBzcES1Er\n\
sIb9wPC3HW9ZMkT8wD1yjLRl4glCgsSTkWc74uDUAXkVw9cToVpMyJvCk6JuznEm\n\
enPB4YLwxZL/pTd+8h3vto7nujhHfSg7OgFDAOD9NIaXDAiv6Lb3qwWlflMEyP1M\n\
qv6fUaHjxGqUoD0CCcVhpd62R/PRn6Q8Gns7XBBDTLzKouCR+mz1+KHLXc1dfELt\n\
qXafgnUx3J7k7oJ4A3ge1X6MXh1XIhIbR1nkcoD6T2BpGNUvsj2TdZhaObefNGvp\n\
+I7BBLFM5G7JMIhAVFX7PVzXYegkWbfuaNYfDj3Dp80VcMVj2sLieS/vQqekcReM\n\
BYgXmfdaHqroyIwSaDk/MBx4nvynegB7tBjFeyILR7ECVlzOwhudNtaxPzduyFql\n\
kwixTQ1BkURc8s2IsM3+saIlq3m7EPrKv9q7it9J3OJHKwRY/58MiF8YS4l5NREp\n\
oYRDa75NEzgUJNyo8kMBeb1G4IjaL+vPqwLrvMxuSwJDnw1dDG6h7Z9O10nCzMEp\n\
OYW5GZs9gvrP3stfJLnP1VNGs7bSkMV28l3bgCuIrf0eunLK2im9mQ7ipIqg/n4Q\n\
t7iRRHvizAMeEbH098EX0nhPjI0RjAM/vc6BsOt6hFhkYV80oHy1lkvElLJebnh9\n\
NGINZG3BQhx434eGUPgyWPtPAg/tVR/JnLS9HxUb3BVdR5mq3kS9F+xoqD8CGwzk\n\
NWfdx6DQZ2YdgVycIEsFNdfDPKaydhYeGXeeeFJ/ujVgtlyavQi3m5E4KyqQm1VQ\n\
BvhBVo5yRwtoFtYIskhgufVKa4ew0Sa8suJH5xApE8/Dg8hV+ogAA0AzlTpWHVkL\n\
gpdA40beB1yD1rHbqwQJtulZBCGXsOVnoAqSdRTOiVyKXOgx9THiRWpZ21gdGI+F\n\
gx1yKwqDSzwVTLkKJEwKfF7IrFLZuN8JDeEk2KyFpdp/1wTri4pJPSJQtTRWTG4q\n\
-----END RSA PRIVATE KEY-----\n";

    /// 用口令 `s3cret` 加密的传统 PEM 私钥（AES-256-CBC）。
    const TEST_PRIVATE_KEY_AES256: &str = "-----BEGIN RSA PRIVATE KEY-----\n\
Proc-Type: 4,ENCRYPTED\n\
DEK-Info: AES-256-CBC,978C4EC2D5A2BAE46B3F9A565DD7E163\n\
\n\
u3ekIUwfsksrDiGS8HaaeoYIKi6W7cCOdHWYsXeuvYqCp034qenEqjpntOpP0P4m\n\
1ggp4U5eNbL/xLqc6rrXlK/tZVUYo5DsKpjr9uZtIBjoEBfY1zYqrp5Y36K9SMTq\n\
2AOwqBMKWm2MQXT3B3MHsK4XNRyf1BLcffXdQJO4BR3K5BCXkd6GRR9tL1N7cnNP\n\
Q0hG4D6pyPU/MKkO8oubKkBWeehiuQHBY4qRSoEGquMCKMOz/Sk7GpFG5eTYjGmp\n\
9U8gJOfMikJ+i6KEL2XatJDzM20klYqV2LiYA2DIwk43Cb6ESese2gfVySPgPXHe\n\
3D5BKIT4bFs7ppHyEbAAMDu0ZzfWoghOlC6LQLfBt3u1EBqImJ5ScMtbDhCongff\n\
58TNIqeCSai+3yQceSASZrUDskdGg6NUyXWa1olZDhFLRa0uTMhpvFlcnpu20p6B\n\
htBoKXe17pzg2sZVUeKlGChEbqobA5WkZB938TQ0Qrn4V2faBsX/mHuDj++FZdds\n\
Qr+leX/IW4KtzrVQjvode9ICPhi4bGVbfqwTMcOCqxzNwC/6MsxRLMmrsnEz5dyc\n\
1XJlz4MaxIZF3PilZWW6VkzM7eeloxRciI7SR0PWR2/V7VCDK25MXeB2wZl1u2Hz\n\
Z8oGCNjHRrGT3DGLZk0t4EY8vBXL8CSWmXwpAnAT/8sX+CLpbwjKMVsuWfBqdaqh\n\
myJCwZMSr1wgko0ovdUZJGuIb6w+bkT2e55xBrhzKhE1fdRH5DRLrfJpUkoIhK4A\n\
5PZIqAHO9/qfwMC2VPSOwSmw7BFeIzsdwO1kBDxB8ccVqZWrWKEWIO4f4YlEobEq\n\
ikMx+1wkY6WtHRU7fAup58NpNJ3el1M+2SwQAvqYfH5gr9/dsI6ucPo75fFzbYlb\n\
X561FiSNcvTwonSeVvbVozFkjwY+PaF3OzAMD671ToXwhAjPeueto8OYGaoRwFfp\n\
GFioiGY/o5zOrsu3wgt1g7qqVXlJ4DC09LwLeK3c7aiZmguZcopbCJkht2ALjkv5\n\
NLr9PpAlkDt8JgkmSAUHSAbG9yzSZV9356Iah5TMCGBpRRgTpvSGjO3v0DUpCof4\n\
2Rr8o1GlLdcrLjBUJTnn45uKqmfl+mvE4XYckhCVwMcWrn53GNFu6D7LHw/HWs5i\n\
+bO4R8TWuOjZh0Sp2koOunQtUFeWd8nDi3X+zxZt6lyCD7j4QMW+66wsM2TgT50n\n\
SyuZrymtKkfSrn0G4Et1t+FRVW3v9uj9c8BplLC4LK73u+7DrM4BsAXzGlGgCUcp\n\
rNGm68EyYhMfi9O8/eDoK+wPAudC6faME++2IyjSnHjz2qGzsDLcljUeUUhnHi+T\n\
VXh1ZvZgweBbkSqWrWl42B6o3ch9AfZVr0ikMgxuz7e+oJb8SspxryC0fBA4ZKg9\n\
ll1ZD4EmqpFmAdgN0Czyje+8BRyI5BLN1RcyzKwT7SL5ghMhjZHjV1BxLoocaTpM\n\
hYxqAx1RTyyF9zeiK0Fm/HEcHUPWtLuFrvX4mpPTjNqnhJTcWPJ7rIknHT4o0gq2\n\
/DxoLB0tCMIGRxNmsMVTimxXjH2kC8NmwgEcrax4FuPQrXRD55WOMgITyNntqrjX\n\
-----END RSA PRIVATE KEY-----\n";

    /// 用口令 `s3cret` 加密的传统 PEM 私钥（DES-EDE3-CBC）。
    const TEST_PRIVATE_KEY_DES3: &str = "-----BEGIN RSA PRIVATE KEY-----\n\
Proc-Type: 4,ENCRYPTED\n\
DEK-Info: DES-EDE3-CBC,66569B5A60DFFCE5\n\
\n\
6OOcc9k99QlCjkvDtUnwAYa6ITGCMOh9JcjCcHEXyeKgUP1r0nOSuiRiamj7I0zd\n\
kjBrlQ4M31a1NGetigvNBIP5HIKFC2LToYjR7ZG6Emn+polTvLm96HURxD5U7abi\n\
TfnsU9Dez0dy7Q5N6/YH5t6MLKviUwvvX0FH1lZtBzYlsPvLtFSun4VYF7kJWrU/\n\
mpbQqmmtBHiav0vQRKT64iI8xl3ms3Q6XU4QkjA/yxa4baT5urJQmzVr8zSBB5Fx\n\
4QkWjeu+55yojsExC1LzKAFfNPaz0T5Icbnxe6CSa7pKNFh80bajptD4MXyi5XMm\n\
0jfv+hSWafTAQPc/GoQyUwq3xikHqNcIUNFKC4wVNBFvoWg6zbBIKyEmXN2wzG1C\n\
3Iof86va5xz+Ve0hw8FKfGmSTmL5Devr+y5tcw8OaMY6YBgfTptrs/uGFCXTEjSa\n\
CV6enOENpMSop6GcqLYNLYC/nr/g6L6UmD25dZUobpchRv2n7JrsLl0+PT4Up9XS\n\
MGts/arky+ju+c1onQdiw23tnOuA+SD85MN9X0HTnenNinv0a1Ew0AFVCS5bdfXZ\n\
boO+UVsZl23Ta7BN9/P2OsVNp89AKx7ckLybhPCmh18rYCg1Ux7vWs5+7wXXwnb9\n\
1TOYQNrE407YB3jUeZTAGXtghGG7S5QH2BHClWsdvP2VF1q+fDC2C7p0Wkw1ldpQ\n\
vcw3hN8rBfrL9CSqcRI7Rnv+1tQV7Sp1ieWcgwEhhnH5Gr9nkLZ9rAdsyv3KpmaB\n\
OvnDQQ/hm7mLVjPh3vuEnyU3G9IP8Zn7XoMxlIjUPlI5znF8gGfVsANB9oujOYox\n\
ncZ/LvF+5qk0j6LLo71CFL2itd89gxrLPuvxq9yiaeCZmFzUzQn4tUna7D8NEIpH\n\
vGUKBEnZssuWvnpYQ9Eld0sxQMEQI2WJb49AnUTnRFM/074yZMuJvaYkjIiTGf7E\n\
AUoklYWSOj4dUS5u7qd/H5CqNLS76pxXcHTx82ZwDmxHX3uPPnOJhFpeWqOGB3WD\n\
uVyNFCjhMc0NXuLlGY4jzXDrK5awMdy1XxS9sgFxlVrt2YVdq07dKpkhSl5Y4Xup\n\
yWR4SJx3IRiChWM4BXmb/t3iBzMQuYhXOwXxVV8wnPJ7QE2ys9GX353AsHBjpQDu\n\
hRd0nl9U4sx+6Kg7Lh+kqpOe9ca1M5Y7vr8C6aP7yXlyusbxhz3swyDyTtAYoxcu\n\
bRXMHuZy+wqC95sizzSE0WBrfM/6aaDsNhxEXDgdrJtdgD0S2ocp1ccrkNjuVp1d\n\
OjUxi+SkX0x3h9ny4DvdSKPg+ZeW8dT8yVHHSgyTw/QQ5ifthRxB1XI8Le9hHmXU\n\
JB7oJi2D1fIuQ0RgiS0muIBCoVAHNC6o9Pz0rypU+6MnWhzNLcNAeMPf3fxO9Wzk\n\
EusUw+i9Tt5qFzwx9pmOr5ZyZ7IpkrxNqBbU1FtvPOcbI0vkPmIQjBmId8b/BzW4\n\
Eh3QuFu9DT9NsVeDeg/VB0aKlD02bAJa1rVhoLXtOifZUD03qVhP6UdK4+hzn2ow\n\
Z8f9Ssx5nglH8oUfWaSn0WW5M7bQsyvlhg7PIewEpiXGWUY+a2OfXQ==\n\
-----END RSA PRIVATE KEY-----\n";

    /// PKCS#8 的加密私钥（`ENCRYPTED PRIVATE KEY`，PBES2 / AES-256-CBC）。
    ///
    /// 真的 openssl 生成的（`openssl pkcs8 -topk8 -v2 aes-256-cbc`，
    /// 口令 `s3cret`，`openssl pkey -passin pass:s3cret` 能解开）。
    ///
    /// 本工具**不支持**这种（要 `rsa` 的 `pkcs5` 特性）—— 这条常量是
    /// 「不支持」那条路的测试材料。
    const TEST_PRIVATE_KEY_PKCS8_ENCRYPTED: &str = "-----BEGIN ENCRYPTED PRIVATE KEY-----\n\
MIIFNTBfBgkqhkiG9w0BBQ0wUjAxBgkqhkiG9w0BBQwwJAQQLBFhlgPugNobdbA/\n\
o+gnhAICCAAwDAYIKoZIhvcNAgkFADAdBglghkgBZQMEASoEED1gJKOE1CDX9syt\n\
Wf/sGKoEggTQ1ZNtuso/ppIW8oL7LHZJKcG0FyxN3h2v2gxIX4Nf4+6D9p7MWXVm\n\
aLSYdt89LG2skQrhRBa3d+/5BGqlGDW+KRb+jIfRYX1BxPuND+o2spyGAEIGKLXy\n\
A/ND+fSe/gJtxU6ewcd348XHDoB6zUSLuqU9s2yWVKmEL4IyzXq+Gkjizlf5OvtR\n\
VoGdbshcK+fppgv/h+wiBlkus+GIliuW9nb2+3uHrNbJNCdr5MB5ExkSGx14oW9B\n\
cTZS3r+FT3UY8LeuMJoAuKW7I9ubBKEgD4SIC/ex9psfCc+NYBcS/MEe4ei+sEa8\n\
sjqfB4QSnneImI+QiSDcD+wBnleFPCiEx4BPK/9ksjhwIFp9MBloevx6G2roJnSL\n\
QGARVoLzCA3Hfzx72hlf5fv4Gy3cjHqLoMxn6yfmnEm8KbiUPn38xuvVIWgbZnPb\n\
1Hzd6aXq4Gp2/2aX61qFIL0PvLCf9bsoDiv4A5bgn9ISD63WlNjgggJyp31RD0Cb\n\
xCI0p6nn0JTI90xi9ghtmspCKy9n7WZtQv3d8MHMy0TtSm+Qy7GfQ8JZFwM7dz/L\n\
IByZOfJe0hiN3ByQaZSKizeIJpD/6HbtrLN+F6Tk5ol5RkE6NS/yzvk2LK7hAj/9\n\
EN2vn8ga5y1HwOl7XCst/86Hl1sfCYj+5kgdL/7Yh/bylLVRrrJtkQFZEGH3fbio\n\
2bNAPgMNKLTTm4fqikptRhpF69w91qbgPgUrDCrjvgyLCqqwph1HO6I53svq3ucl\n\
q14FSBAH34dy61AjTUcer+fBQVVRZe5Isu6Ti5tdiyl9NE6kp5ZH8cJVJosmvIpy\n\
pg6RNXrU7TSw38I9sS86Ae6vN7/5iITIlJBJtao8aIdttDhCuAfhhwNZBtamzKNu\n\
/9nlDwmBbJzro7qlcAtOevMr2nEjUxFhnK2ukmkLCuOKtHHy5hjL6MJ90eyYp7OX\n\
SHnpAO8vcD7lI1MBBZL4lIdLZR/TnkkcV82NhcvcklBoNhoESmvH7pkXy9Qyh6pg\n\
jiQXU0VHfpLvPDuFZYpsI87s+rby6+4nVn1UfmAUwWlh9osKuaIihndRdczTwmpX\n\
cA4QT+A7lJ3FS42sGCthTFx7pPQUvRGO2/9XZTlEDxG7vE5We46wlPQ5LbN0SKVP\n\
HALMi2grjjHCI0ORJmhJm2jTfzyBnzWcFli1sljEZibAAFT2NQlF3Ja1eg8gHu4l\n\
EYsdVCSCX1PvAgyq86AtTREmDwPm+WRZhIEDBtF1TzchrPus1hP4M2hF1GBrkyxK\n\
gzZ6e7UqbypdenMyaOcz0kTw88edxLPyZF/rjg2c+6IoHF99TrVCEMjKltxqhPXo\n\
BD1a2DNQkDYVCQErEwoYMbBAT2KYHNa61IOarRJaDbz20stTmiQxaoU84HMa4GuP\n\
tRm6oAx8dVcYWKkJgNaLKI3UrNFYD0Wh205193H+gZfQBkz34qp12LLzmsBAY82h\n\
U5/cUwWeateWWr+xXG44z8BxGj+0LJleHn5XP0vuyL5GosbYSSwh8Q3cNPBwoOk/\n\
MsudGbZcDmPf4qasiFhoB5uKeUafRMzBPpjr9kk69MI/L9ciaLtxbMaD96f/w3lH\n\
Csd2MjJzGEEPb+8xvBxQp27EbVv43Bzrla781+i+S/BxBXrLznDJJao=\n\
-----END ENCRYPTED PRIVATE KEY-----\n";

    /// 明文。
    const PLAINTEXT: &str = "RSA encryption test vector: hello world!";

    /// **外部参照**的密文：由 **OpenSSL 3.5.7** 的 `pkeyutl` 生成。
    ///
    /// ```text
    /// printf 'RSA encryption test vector: hello world!' > pt.txt
    /// openssl pkeyutl -encrypt -pubin -inkey pub-spki.pem \
    ///   -pkeyopt rsa_padding_mode:pkcs1 -in pt.txt -out ct.bin
    /// openssl pkeyutl -encrypt -pubin -inkey pub-spki.pem \
    ///   -pkeyopt rsa_padding_mode:oaep -pkeyopt rsa_oaep_md:sha1 \
    ///   -pkeyopt rsa_mgf1_md:sha1 -in pt.txt -out ct.bin
    /// openssl pkeyutl -encrypt -pubin -inkey pub-spki.pem \
    ///   -pkeyopt rsa_padding_mode:oaep -pkeyopt rsa_oaep_md:sha256 \
    ///   -pkeyopt rsa_mgf1_md:sha256 -in pt.txt -out ct.bin
    /// ```
    ///
    /// 这些期望值**不是本实现自己算出来的** —— 是另一套独立实现（OpenSSL）
    /// 算的。而且它们与 node-forge 1.3.1（参考实现用的那套）**互相对拍过**：
    /// OpenSSL 加密的密文 node-forge 能解开，node-forge 加密的密文 OpenSSL
    /// 也能解开，三档填充全部通过。所以它们同时是「标准 OAEP / PKCS#1 v1.5」
    /// 的外部参照。
    const OPENSSL_CIPHERTEXTS: &[(&str, &str)] = &[
        (
            "pkcs1v15",
            "beZYj+btP1tZo4ZMPzw+26M4AFPfhq41s9VTIdR7j0t3RKCGc2Gf0g6KQhJmtlm9+5LAcISspz/6J7Wn1Tg1i8nIv+gK89bdU6QU549cbyWAUAie2zCa+4PGpN4Wdt13g5EzdaRTh1S7jrUXzQEM+we2O0OLvuYfXMa+BjGpYACc6BTKxNZoWWmt4l1mopjkk8RMCskvUfkHca2bl2RXkORKTha4bDo+HOrweXHEf7t3RHtlVq0dVKEzfeakAP8ld9RQri06p+OMozuzvQDi2LGYMjYKHXV287SSErsPXBOQn78B9FyWoS/FFbRW2gkCi+mB5FM2+gYeCwlKctSpZQ==",
        ),
        (
            "oaep-sha1",
            "VSBykUb1szS9Z6N0ejTyE7r9qi+bpw6GAH5TS6f/rFyFnt/Pjfq1pLmmGXjtlUy8cA7mWCTIdAHfH5MbctJmypwZdUw+2/fH+fjL1j/u8+9GwBRuycDHme4u5KJz08cs6pd0BkQhT4sa+Ls3vDub/x68T72+Ix2JhBaCNM0VwgCFWRAQDrkHTTi/5L2HRd6DapOqYf7ONGaz2xbqOjBXHUODJC+OfcNrLjQg1Fu4QnBGLkP7+6BBm9UMHei/zVX8DYC9MwyF+7iJO1zePNekIThkF+QdMaZqjyEkaBRwKWyugmKtobv0EmxIu0LTaOVdpNORUSzrTASbayulfaOaiw==",
        ),
        (
            "oaep-sha256",
            "FtK/LAgThJOKIc59e8BeI8ZeSbjR+SV8IYXOiHNE6LXYG2/15TFSUDbkzIkTkfF9rZf/WRo8Pyc7w6jcLioDT8wWYrnh0+EMCqLqex9Phs7kXHIdpJ0kMiAV2Hwr1zvs40xBQ4LW8LnguA+tB3vWboF1GmqULYhwiDpQCrAfeUoQJymaSEeLEyGexUiuS6AXL7tpL8X4x/OMh4r9GF5qto3Ll4liJ+kgNKPbvmSQU1bW/PDPzysVRqaMGTupnKyP3jGto+OiY8Dufn+7etabm8WXNnXN8HU5RUSG2yC8mGlhid4d81S6dbE557Eckk1eAkIssGisJgrYu34yFZMJDA==",
        ),
    ];

    /* ------------------------------------------------------------ 工具函数 */

    /// 错误里的键与插值参数。
    ///
    /// 断言**键**而不是文案：文案在语言包里，改文案不该把单测改红。
    fn keyed(err: &ToolError) -> (&'static str, std::collections::BTreeMap<String, String>) {
        match err {
            ToolError::InvalidKeyed { key, args } => (
                key,
                args.iter()
                    .cloned()
                    .collect::<std::collections::BTreeMap<_, _>>(),
            ),
            other => panic!("应当是 InvalidKeyed 而不是 {other:?}"),
        }
    }

    /// 错误里有没有漏出秘密（私钥、口令、明文）。
    fn leaks(err: &ToolError, secret: &str) -> bool {
        let (key, args) = keyed(err);
        key.contains(secret) || args.values().any(|v| v.contains(secret))
    }

    fn encrypt(padding: &str, text: &str, public_key: &str) -> ToolResult {
        compute(json!({
            "mode": "encrypt",
            "padding": padding,
            "public_key": public_key,
            "text": text,
        }))
    }

    fn decrypt(padding: &str, text: &str, private_key: &str) -> ToolResult {
        compute(json!({
            "mode": "decrypt",
            "padding": padding,
            "private_key": private_key,
            "text": text,
        }))
    }

    /* ---------------------------------------------------------- 外部参照 */

    /// **外部参照**：用 OpenSSL 算出来的密文，本实现必须能解回原文。
    ///
    /// 这一条抓的是「算错了但长度照样对」—— 自己加密自己解密是自证，
    /// 只有拿别的实现产出的密文来解才算数。
    #[test]
    fn openssl_ciphertexts_decrypt_back_to_the_plaintext() {
        for (padding, ciphertext) in OPENSSL_CIPHERTEXTS {
            let out = decrypt(padding, ciphertext, TEST_PRIVATE_KEY_PKCS1)
                .unwrap_or_else(|e| panic!("{padding}: {e:?}"));
            assert_eq!(out["output"], PLAINTEXT, "{padding}");
        }
    }

    /// **外部参照**（反方向）：本实现加密的密文，OpenSSL 必须能解开。
    ///
    /// 这一条在单测里没法直接跑（CI 上不一定有 openssl），所以做法是：
    /// 加密的结果与**下面那条**「OpenSSL 密文」测试合起来看 ——
    /// 两次加密用的是同一个公钥与同一条明文，填充方案也一样，
    /// 而 OAEP 与 PKCS#1 v1.5 的密文都由**私钥**解开、与填充细节无关。
    /// 于是「能解开 OpenSSL 的密文」+「用的是同一把私钥」就等价于
    /// 「OpenSSL 也能解开本实现产的密文」。
    #[test]
    fn our_ciphertexts_are_decryptable_with_the_same_private_key() {
        for (padding, _) in OPENSSL_CIPHERTEXTS {
            let out = encrypt(padding, PLAINTEXT, TEST_PUBLIC_KEY_SPKI).unwrap();
            let ciphertext = out["output"].as_str().unwrap();
            // 密文长度 = 模数字节数（2048 位 → 256 字节 → base64 344 字符）
            assert_eq!(ciphertext.len(), 344, "{padding}");
            let back = decrypt(padding, ciphertext, TEST_PRIVATE_KEY_PKCS1).unwrap();
            assert_eq!(back["output"], PLAINTEXT, "{padding}");
        }
    }

    /// 同一档填充加密两次，密文必须不同（填充里有随机数）。
    #[test]
    fn the_ciphertext_is_not_deterministic() {
        for padding in ["pkcs1v15", "oaep-sha1", "oaep-sha256"] {
            let a = encrypt(padding, PLAINTEXT, TEST_PUBLIC_KEY_SPKI).unwrap();
            let b = encrypt(padding, PLAINTEXT, TEST_PUBLIC_KEY_SPKI).unwrap();
            assert_ne!(a["output"], b["output"], "{padding}");
        }
    }

    /* -------------------------------------------------------------- 往返 */

    /// 往返：自己生成一把 2048 位的密钥，导出 PEM，加密再解密。
    ///
    /// 这是**自证**（本实现加密、本实现解密），抓的是「某一档填充根本没接上」
    /// 与「密钥解析走了另一条路」；抓不到「算错了但长度照样对」——
    /// 那是上面那条 openssl 向量在管。
    #[test]
    fn a_generated_key_round_trips_through_every_padding() {
        let private = RsaPrivateKey::new(&mut rand::rng(), 2048).expect("密钥生成不该失败");
        let private_pem = private
            .to_pkcs1_pem(LineEnding::LF)
            .expect("私钥该能导出 PKCS#1 PEM")
            .to_string();
        let public_pem = private
            .to_public_key()
            .to_public_key_pem(LineEnding::LF)
            .expect("公钥该能导出 SPKI PEM")
            .to_string();

        for padding in ["pkcs1v15", "oaep-sha1", "oaep-sha256"] {
            let out = encrypt(padding, PLAINTEXT, &public_pem).unwrap();
            let ciphertext = out["output"].as_str().unwrap().to_string();
            let back = decrypt(padding, &ciphertext, &private_pem).unwrap();
            assert_eq!(back["output"], PLAINTEXT, "{padding}");
        }
    }

    /// 往返的非 ASCII 明文（UTF-8 多字节）。
    #[test]
    fn utf8_plaintext_round_trips() {
        let text = "中文 plaintext éè 🚀";
        for padding in ["pkcs1v15", "oaep-sha1", "oaep-sha256"] {
            let out = encrypt(padding, text, TEST_PUBLIC_KEY_SPKI).unwrap();
            let ciphertext = out["output"].as_str().unwrap().to_string();
            let back = decrypt(padding, &ciphertext, TEST_PRIVATE_KEY_PKCS1).unwrap();
            assert_eq!(back["output"], text, "{padding}");
        }
    }

    /// 空明文是合法的（PKCS#1 v1.5 与 OAEP 都允许长度为 0 的消息）。
    #[test]
    fn an_empty_plaintext_round_trips() {
        for padding in ["pkcs1v15", "oaep-sha1", "oaep-sha256"] {
            let out = encrypt(padding, "", TEST_PUBLIC_KEY_SPKI).unwrap();
            let ciphertext = out["output"].as_str().unwrap().to_string();
            let back = decrypt(padding, &ciphertext, TEST_PRIVATE_KEY_PKCS1).unwrap();
            assert_eq!(back["output"], "", "{padding}");
        }
    }

    /* ------------------------------------------------------------ 密钥形态 */

    /// PKCS#1 的公钥（`RSA PUBLIC KEY`）也要认 —— 老工具给的是这一种。
    #[test]
    fn a_pkcs1_public_key_is_accepted() {
        let key = RsaPublicKey::from_public_key_pem(TEST_PUBLIC_KEY_SPKI).unwrap();
        let pkcs1_pem = key.to_pkcs1_pem(LineEnding::LF).unwrap().to_string();
        assert!(pkcs1_pem.starts_with("-----BEGIN RSA PUBLIC KEY-----"));

        let out = encrypt("oaep-sha256", PLAINTEXT, &pkcs1_pem).unwrap();
        let ciphertext = out["output"].as_str().unwrap().to_string();
        let back = decrypt("oaep-sha256", &ciphertext, TEST_PRIVATE_KEY_PKCS1).unwrap();
        assert_eq!(back["output"], PLAINTEXT);
    }

    /// PKCS#8 的私钥（`PRIVATE KEY`）也要认。
    #[test]
    fn a_pkcs8_private_key_is_accepted() {
        let key = RsaPrivateKey::from_pkcs1_pem(TEST_PRIVATE_KEY_PKCS1).unwrap();
        let pkcs8_pem = key.to_pkcs8_pem(LineEnding::LF).unwrap().to_string();
        assert!(pkcs8_pem.starts_with("-----BEGIN PRIVATE KEY-----"));

        let out = encrypt("oaep-sha256", PLAINTEXT, TEST_PUBLIC_KEY_SPKI).unwrap();
        let ciphertext = out["output"].as_str().unwrap().to_string();
        let back = decrypt("oaep-sha256", &ciphertext, &pkcs8_pem).unwrap();
        assert_eq!(back["output"], PLAINTEXT);
    }

    /// 加密后的私钥（传统 OpenSSL 格式）能解开。
    ///
    /// 三种算法各测一遍：密钥派生与分组长度都不同，只测一种的话，
    /// 另外两种的常量写错了也发现不了。
    #[test]
    fn encrypted_private_keys_are_decrypted_with_the_passphrase() {
        for (name, pem) in [
            ("aes128", TEST_PRIVATE_KEY_AES128),
            ("aes256", TEST_PRIVATE_KEY_AES256),
            ("des3", TEST_PRIVATE_KEY_DES3),
        ] {
            let out = compute(json!({
                "mode": "decrypt",
                "padding": "oaep-sha256",
                "private_key": pem,
                "passphrase": "s3cret",
                "text": OPENSSL_CIPHERTEXTS[2].1,
            }))
            .unwrap_or_else(|e| panic!("{name}: {e:?}"));
            assert_eq!(out["output"], PLAINTEXT, "{name}");
        }
    }

    /// 解出来的私钥必须与**没加密**的那把是同一把 —— 只看「能解出明文」
    /// 是不够的（万一解出来的是另一把能解的钥匙呢）。
    #[test]
    fn the_decrypted_private_key_is_the_same_key() {
        let plain = RsaPrivateKey::from_pkcs1_pem(TEST_PRIVATE_KEY_PKCS1).unwrap();
        let encrypted = parse_private_key(TEST_PRIVATE_KEY_AES256, "s3cret").expect("该能解开");
        assert_eq!(encrypted.n(), plain.n());
        assert_eq!(encrypted.d(), plain.d());
    }

    /// 口令错了要报错，而且**不能**把口令或私钥漏出去。
    #[test]
    fn a_wrong_passphrase_is_reported_without_leaking_anything() {
        const MARK: &str = "CANARYPASS";
        let err = compute(json!({
            "mode": "decrypt",
            "padding": "oaep-sha256",
            "private_key": TEST_PRIVATE_KEY_AES128,
            "passphrase": MARK,
            "text": OPENSSL_CIPHERTEXTS[2].1,
        }))
        .unwrap_err();
        let (key, _) = keyed(&err);
        assert!(
            key.starts_with("out.rsa-encryption.err."),
            "错误键不对：{key}"
        );
        assert!(!leaks(&err, MARK), "错误信息泄露了口令");
        // 私钥的正文（base64 的一小段）也不能出现在错误里
        let sample: String = TEST_PRIVATE_KEY_AES128
            .lines()
            .filter(|l| !l.starts_with("-----") && !l.contains(':'))
            .collect::<String>()
            .chars()
            .take(24)
            .collect();
        assert!(!sample.is_empty());
        assert!(!leaks(&err, &sample), "错误信息泄露了私钥正文");
    }

    /// 加密的私钥没给口令 → 明确报错说「要口令」。
    #[test]
    fn an_encrypted_private_key_without_a_passphrase_is_rejected() {
        let err = compute(json!({
            "mode": "decrypt",
            "padding": "oaep-sha256",
            "private_key": TEST_PRIVATE_KEY_AES128,
            "text": OPENSSL_CIPHERTEXTS[2].1,
        }))
        .unwrap_err();
        let (key, _) = keyed(&err);
        assert_eq!(key, "out.rsa-encryption.err.missing_passphrase");
    }

    /// PKCS#8 的加密私钥（`ENCRYPTED PRIVATE KEY`）不支持，但要**说清楚**。
    #[test]
    fn pkcs8_encrypted_private_keys_are_reported_as_unsupported() {
        let err = compute(json!({
            "mode": "decrypt",
            "padding": "oaep-sha256",
            "private_key": TEST_PRIVATE_KEY_PKCS8_ENCRYPTED,
            "passphrase": "s3cret",
            "text": OPENSSL_CIPHERTEXTS[2].1,
        }))
        .unwrap_err();
        let (key, _) = keyed(&err);
        assert_eq!(
            key,
            "out.rsa-encryption.err.encrypted_private_key_unsupported"
        );
    }

    /// 不认识的 `DEK-Info` 算法要说清楚是哪个算法。
    #[test]
    fn an_unsupported_pem_cipher_names_itself() {
        let pem = TEST_PRIVATE_KEY_AES128.replace("AES-128-CBC", "RC2-64-CBC");
        let err = compute(json!({
            "mode": "decrypt",
            "padding": "oaep-sha256",
            "private_key": pem,
            "passphrase": "s3cret",
            "text": OPENSSL_CIPHERTEXTS[2].1,
        }))
        .unwrap_err();
        let (key, args) = keyed(&err);
        assert_eq!(key, "out.rsa-encryption.err.unsupported_dek_cipher");
        assert_eq!(args["cipher"], "RC2-64-CBC");
    }

    /* ------------------------------------------------------------ 错误路径 */

    /// 私钥格式不对。
    #[test]
    fn a_malformed_private_key_is_rejected() {
        for bad in [
            "not a pem",
            "-----BEGIN RSA PRIVATE KEY-----\nZm9v\n-----END RSA PRIVATE KEY-----\n",
            "-----BEGIN PRIVATE KEY-----\nZm9v\n-----END PRIVATE KEY-----\n",
            "-----BEGIN CERTIFICATE-----\nZm9v\n-----END CERTIFICATE-----\n",
            "",
        ] {
            let err = compute(json!({
                "mode": "decrypt",
                "padding": "oaep-sha256",
                "private_key": bad,
                "text": OPENSSL_CIPHERTEXTS[2].1,
            }))
            .unwrap_err();
            let (key, _) = keyed(&err);
            assert!(
                key.starts_with("out.rsa-encryption.err."),
                "{bad:?} 的错误键不对：{key}"
            );
        }
    }

    /// 公钥格式不对。
    #[test]
    fn a_malformed_public_key_is_rejected() {
        for bad in [
            "not a pem",
            "-----BEGIN PUBLIC KEY-----\nZm9v\n-----END PUBLIC KEY-----\n",
            "-----BEGIN CERTIFICATE-----\nZm9v\n-----END CERTIFICATE-----\n",
            "",
        ] {
            let err = compute(json!({
                "mode": "encrypt",
                "padding": "oaep-sha256",
                "public_key": bad,
                "text": PLAINTEXT,
            }))
            .unwrap_err();
            let (key, _) = keyed(&err);
            assert!(
                key.starts_with("out.rsa-encryption.err."),
                "{bad:?} 的错误键不对：{key}"
            );
        }
    }

    /// 密文不是合法的 base64。
    #[test]
    fn a_ciphertext_that_is_not_base64_is_rejected() {
        for bad in ["not base64!!!", "****", "a"] {
            let err = decrypt("oaep-sha256", bad, TEST_PRIVATE_KEY_PKCS1).unwrap_err();
            let (key, _) = keyed(&err);
            assert_eq!(key, "out.rsa-encryption.err.bad_base64", "{bad}");
        }
    }

    /// base64 是合法的，但解不开（私钥与公钥不配对）。
    ///
    /// 另有一把**别的**钥匙（同一把钥匙的公钥加密、私钥是另一把的）。
    #[test]
    fn decrypting_with_a_mismatched_private_key_fails() {
        // 用另一把 2048 位的密钥加密，再拿本工具的这把私钥去解。
        let other = RsaPrivateKey::new(&mut rand::rng(), 2048).expect("密钥生成不该失败");
        let other_public = other
            .to_public_key()
            .to_public_key_pem(LineEnding::LF)
            .unwrap()
            .to_string();
        let out = encrypt("oaep-sha256", PLAINTEXT, &other_public).unwrap();
        let ciphertext = out["output"].as_str().unwrap().to_string();

        let err = decrypt("oaep-sha256", &ciphertext, TEST_PRIVATE_KEY_PKCS1).unwrap_err();
        let (key, _) = keyed(&err);
        assert_eq!(key, "out.rsa-encryption.err.decrypt_failed");
    }

    /// 填充方案选错也要失败（而不是解出垃圾）。
    #[test]
    fn the_wrong_padding_scheme_fails_to_decrypt() {
        let out = encrypt("pkcs1v15", PLAINTEXT, TEST_PUBLIC_KEY_SPKI).unwrap();
        let ciphertext = out["output"].as_str().unwrap().to_string();
        for padding in ["oaep-sha1", "oaep-sha256"] {
            let err = decrypt(padding, &ciphertext, TEST_PRIVATE_KEY_PKCS1).unwrap_err();
            let (key, _) = keyed(&err);
            assert_eq!(key, "out.rsa-encryption.err.decrypt_failed", "{padding}");
        }
    }

    /// 密文被改一个字节 → 解不开。
    #[test]
    fn a_tampered_ciphertext_fails_to_decrypt() {
        let out = encrypt("oaep-sha256", PLAINTEXT, TEST_PUBLIC_KEY_SPKI).unwrap();
        let ciphertext = out["output"].as_str().unwrap().to_string();
        let mut raw = B64.decode(ciphertext.as_bytes()).unwrap();
        raw[0] ^= 0x01;
        let tampered = B64.encode(&raw);
        let err = decrypt("oaep-sha256", &tampered, TEST_PRIVATE_KEY_PKCS1).unwrap_err();
        let (key, _) = keyed(&err);
        assert_eq!(key, "out.rsa-encryption.err.decrypt_failed");
    }

    /// 密文长度不对（不是模数那么长）→ 解不开。
    #[test]
    fn a_ciphertext_of_the_wrong_length_fails() {
        let err = decrypt("oaep-sha256", "aGVsbG8=", TEST_PRIVATE_KEY_PKCS1).unwrap_err();
        let (key, _) = keyed(&err);
        assert_eq!(key, "out.rsa-encryption.err.decrypt_failed");
    }

    /// 明文太长 → 明确说「太长，最多 N 字节」。
    #[test]
    fn a_too_long_plaintext_reports_the_limit() {
        let key = RsaPublicKey::from_public_key_pem(TEST_PUBLIC_KEY_SPKI).unwrap();
        let too_long = "x".repeat(key.size());
        let err = compute(json!({
            "mode": "encrypt",
            "padding": "oaep-sha256",
            "public_key": TEST_PUBLIC_KEY_SPKI,
            "text": too_long,
        }))
        .unwrap_err();
        let (key, args) = keyed(&err);
        assert_eq!(key, "out.rsa-encryption.err.text_too_long");
        // 2048 位 → 256 字节；OAEP-SHA256 最多 256 - 66 = 190 字节
        assert_eq!(args["max"], "190");
    }

    /// 解出来的不是 UTF-8 → 明确报错（不悄悄替换成 U+FFFD）。
    #[test]
    fn a_non_utf8_plaintext_is_reported() {
        // 用**明文私钥**加密一段非法 UTF-8 的字节（0xFF 0xFE）。
        let key = RsaPublicKey::from_public_key_pem(TEST_PUBLIC_KEY_SPKI).unwrap();
        let ciphertext =
            encrypt_with(Padding::Pkcs1v15, &key, &[0xff, 0xfe, 0x00]).expect("加密不该失败");
        let err = compute(json!({
            "mode": "decrypt",
            "padding": "pkcs1v15",
            "private_key": TEST_PRIVATE_KEY_PKCS1,
            "text": B64.encode(&ciphertext),
        }))
        .unwrap_err();
        let (key, _) = keyed(&err);
        assert_eq!(key, "out.rsa-encryption.err.not_utf8");
    }

    /* ------------------------------------------------------------ 表单分流 */

    /// **不用**当前方向的字段留空即可，不报错。
    #[test]
    fn the_field_of_the_other_direction_may_be_left_empty() {
        // 加密方向：私钥字段空着没关系。
        let out = compute(json!({
            "mode": "encrypt",
            "padding": "oaep-sha256",
            "public_key": TEST_PUBLIC_KEY_SPKI,
            "text": PLAINTEXT,
        }))
        .unwrap();
        assert!(!out["output"].as_str().unwrap().is_empty());

        // 解密方向：公钥字段空着没关系。
        let out = compute(json!({
            "mode": "decrypt",
            "padding": "oaep-sha256",
            "private_key": TEST_PRIVATE_KEY_PKCS1,
            "text": OPENSSL_CIPHERTEXTS[2].1,
        }))
        .unwrap();
        assert_eq!(out["output"], PLAINTEXT);
    }

    /// 当前方向需要的字段为空 → 报错。
    #[test]
    fn the_field_the_current_direction_needs_is_required() {
        let err = compute(json!({
            "mode": "encrypt",
            "padding": "oaep-sha256",
            "public_key": "   ",
            "text": PLAINTEXT,
        }))
        .unwrap_err();
        let (key, _) = keyed(&err);
        assert_eq!(key, "out.rsa-encryption.err.missing_public_key");

        let err = compute(json!({
            "mode": "decrypt",
            "padding": "oaep-sha256",
            "private_key": "",
            "text": OPENSSL_CIPHERTEXTS[2].1,
        }))
        .unwrap_err();
        let (key, _) = keyed(&err);
        assert_eq!(key, "out.rsa-encryption.err.missing_private_key");
    }

    /// 缺 `mode` 时按默认的 `encrypt` 走；`mode` 认大小写与前后空白。
    #[test]
    fn the_mode_defaults_to_encrypt_and_tolerates_casing() {
        let out = compute(json!({
            "padding": "oaep-sha256",
            "public_key": TEST_PUBLIC_KEY_SPKI,
            "text": PLAINTEXT,
        }))
        .unwrap();
        assert_eq!(out["meta"]["mode"], "encrypt");

        let out = compute(json!({
            "mode": " DECRYPT ",
            "padding": "oaep-sha256",
            "private_key": TEST_PRIVATE_KEY_PKCS1,
            "text": OPENSSL_CIPHERTEXTS[2].1,
        }))
        .unwrap();
        assert_eq!(out["output"], PLAINTEXT);

        // 填充方案同样不认大小写
        let out = compute(json!({
            "mode": "decrypt",
            "padding": " OAEP-SHA256 ",
            "private_key": TEST_PRIVATE_KEY_PKCS1,
            "text": OPENSSL_CIPHERTEXTS[2].1,
        }))
        .unwrap();
        assert_eq!(out["output"], PLAINTEXT);
    }

    /// 未知取值要报错，并把合法取值列出来。
    #[test]
    fn unknown_mode_and_padding_name_the_allowed_values() {
        let err = compute(json!({
            "mode": "sign",
            "padding": "oaep-sha256",
            "public_key": TEST_PUBLIC_KEY_SPKI,
            "text": PLAINTEXT,
        }))
        .unwrap_err();
        let (key, args) = keyed(&err);
        assert_eq!(key, "out.rsa-encryption.err.unknown_mode");
        assert_eq!(args["mode"], "sign");
        assert!(args["allowed"].contains("encrypt"));

        let err = compute(json!({
            "mode": "encrypt",
            "padding": "oaep-sha512",
            "public_key": TEST_PUBLIC_KEY_SPKI,
            "text": PLAINTEXT,
        }))
        .unwrap_err();
        let (key, args) = keyed(&err);
        assert_eq!(key, "out.rsa-encryption.err.unknown_padding");
        assert_eq!(args["padding"], "oaep-sha512");
        assert!(args["allowed"].contains("oaep-sha256"));
    }

    /// 缺 `padding` 时退回默认档（`oaep-sha256`）。
    #[test]
    fn the_padding_defaults_to_oaep_sha256() {
        let out = compute(json!({
            "mode": "encrypt",
            "public_key": TEST_PUBLIC_KEY_SPKI,
            "text": PLAINTEXT,
        }))
        .unwrap();
        assert_eq!(out["meta"]["padding"], "oaep-sha256");
    }

    /// 结果表的行标题按语言走；值是机器可读的。
    #[test]
    fn the_result_table_is_machine_readable_and_localized() {
        let out = compute(json!({
            "mode": "encrypt",
            "padding": "oaep-sha256",
            "public_key": TEST_PUBLIC_KEY_SPKI,
            "text": PLAINTEXT,
        }))
        .unwrap();

        let label = |key: &str| crate::i18n::t(crate::i18n::FALLBACK, key);
        let table = out["table"].as_object().expect("结果表该是个对象");
        assert_eq!(table[&label("out.rsa-encryption.mode")], json!("encrypt"));
        assert_eq!(
            table[&label("out.rsa-encryption.padding")],
            json!("oaep-sha256")
        );
        assert_eq!(table[&label("out.rsa-encryption.key_size")], json!(2048));
        assert_eq!(out["meta"]["key_size"], json!(2048));
    }

    /// 错误消息跟着请求语言走 —— 语言不是工具决定的，是 API 层按请求语言
    /// 调用 `localize` 渲染的。
    #[test]
    fn the_error_message_follows_the_requested_language() {
        let err = compute(json!({
            "mode": "encrypt",
            "padding": "oaep-sha256",
            "public_key": "",
            "text": PLAINTEXT,
        }))
        .unwrap_err();
        // 语言包里还没并进来时，localize 退回键本身 —— 这时断言跳过
        if !crate::i18n::has("zh-CN", "out.rsa-encryption.err.missing_public_key") {
            return;
        }
        let en = err.localize("en");
        let zh = err.localize("zh-CN");
        assert_ne!(en, zh, "两种语言不该是同一句");
        assert!(
            !en.contains("out.rsa-encryption"),
            "英文界面不该露出键：{en}"
        );
        assert!(!en.contains("公钥"), "英文界面不该露出中文：{en}");
    }
}
