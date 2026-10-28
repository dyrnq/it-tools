//! ECDSA 密钥对生成（endpoint `ecdsa-key-pair-generator`）。
//!
//! ## 这个工具做什么
//!
//! 在 NIST P-256 / P-384 / P-521 上生成一对 ECDSA 密钥。曲线由 `curve` 下拉框选，
//! 输出格式由 `format` 下拉框选：
//!
//! | 档位 | 给什么 |
//! |---|---|
//! | `pem`（默认） | 私钥 **PKCS#8** PEM、���钥 **SEC1** PEM、公钥 **SPKI** PEM |
//! | `raw` | 私钥标量的 hex、公钥未压缩点的 hex |
//!
//! 下拉框要真的起作用：`pem` 档里**不该**出现 hex，`raw` 档里**不该**出现 PEM。
//!
//! ## 两种私钥格式为什么都给
//!
//! * **PKCS#8**（`-----BEGIN PRIVATE KEY-----`）是通用格式，`openssl pkey`、
//!   Java 的 `PKCS8EncodedKeySpec`、Python 的 `cryptography` 都吃它。
//!   这是 `output`（主结果）给的那一份。
//! * **SEC1**（`-----BEGIN EC PRIVATE KEY-----`）是 `openssl ecparam -genkey`
//!   默认给的那种，好多老工具（TLS 配置文件、`ssh` 的某些用法）只认它。
//!
//! 两种都放在结果表里，用户自己挑 —— 少给一种就有一半用户拿不到能用的东西。
//!
//! ## 与参考实现的差别
//!
//! 参考实现（`it-tools2` 的 `ecdsa-key-pair-generator`）用 npm 的 **sshpk**，
//! 曲线给的是 `nistp256` / `nistp384` / `nistp521`，输出是 **OpenSSH 格式**的私钥
//! 加一行 authorized_keys 公钥，外加 SHA256 / MD5 指纹。
//!
//! 本实现给的是 **PEM 与原始字节**，不产 OpenSSH 格式 —— 仓库里已经有
//! [`super::ssh_key_pair_generator`] 专门产出那个，**要 OpenSSH 格式请用
//! ssh-key-pair-generator**。曲线的叫法也从 sshpk 的 `nistp256` 改成标准的
//! `p256` / `p384` / `p521`（`openssl ecparam -name prime256v1` 那一族）。
//!
//! ## 编码路线
//!
//! `p256` / `p384` / `p521` 0.14 的默认特性里已经带了 `pem` 与 `pkcs8`
//! （`pem` → `elliptic-curve/pem` → `pkcs8/pem`、`sec1/pem`），
//! 所以 **PKCS#8 与 SEC1 都是库自己的编码器产的**，不用手搓 DER：
//!
//! * `SigningKey::to_pkcs8_pem()`（`EncodePrivateKey`）—— PKCS#8。
//!   里面的 SEC1 结构不带曲线参数（RFC 5915 § 3：PKCS#8 里曲线由
//!   algorithm identifier 的 OID 带着）。
//! * `SecretKey::to_sec1_pem()` —— SEC1，带 `parameters = NamedCurve(OID)`
//!   与公钥点，跟 `openssl ecparam -genkey` 给的结构一致。
//! * `VerifyingKey::to_public_key_pem()`（`EncodePublicKey`）—— SPKI。
//!
//! **不需要改 `Cargo.toml`。**
//!
//! ## 随机数
//!
//! 私钥的标量是**拒绝采样**出来的：抽 32 / 48 / 66 字节的随机数，
//! 若它不是 [1, n-1] 里的合法标量就丢掉重来（P-521 的域比阶 n 大 7 位，
//! 大约每 128 次要重抽一次；P-256 几乎不会重来）。
//!
//! 不用 `SigningKey::random(&mut rand::rng())`：那个 API 要的是
//! **rand_core 0.9** 的 `CryptoRng`，而仓库里的 `rand 0.10` 用的是
//! **rand_core 0.10** —— 两代的 trait 不是同一个 trait，传不进去。
//!
//! ## 安全边界
//!
//! 私钥在**服务端**生成：它短暂地存在于本进程的堆上，随后经 HTTP 响应体发往
//! 浏览器。这条链路上它就是明文，只受 TLS 保护；服务端不做任何补救，也不该做
//! —— 与 [`super::rsa_key_pair_generator`] 同一个口径。
//!
//! 私钥**绝不落盘、不进缓存、不进日志、不进错误信息**：下面所有 `map_err`
//! 带回来的都只是编码器的错误信息，它不携带密钥材料。

use elliptic_curve::pkcs8::{EncodePrivateKey, EncodePublicKey, LineEnding};
use elliptic_curve::SecretKey;
use rand::Rng;
use serde_json::{json, Map, Value};

use super::{util, ToolError, ToolResult};

/// 密钥对生成后手里的东西：四种表示（两份私钥 PEM、一份公钥 PEM、两份 hex）。
struct GeneratedKey {
    /// 私钥的 PKCS#8 PEM（`-----BEGIN PRIVATE KEY-----`）
    pkcs8_pem: String,
    /// 私钥的 SEC1 PEM（`-----BEGIN EC PRIVATE KEY-----`）
    sec1_pem: String,
    /// 公钥的 SPKI PEM（`-----BEGIN PUBLIC KEY-----`）
    public_pem: String,
    /// 私钥标量的 hex（32 / 48 / 66 字节）
    private_hex: String,
    /// 公钥未压缩点的 hex（65 / 97 / 133 字节，`0x04` 开头）
    public_hex: String,
}

/// 支持的曲线。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Curve {
    P256,
    P384,
    P521,
}

impl Curve {
    /// 从注册表下拉框的值解析。认不出来返回 `None` ——
    /// 下拉框的值是外部输入，不该由它决定「用哪条曲线」。
    fn from_value(value: &str) -> Option<Self> {
        Some(match value {
            "p256" => Curve::P256,
            "p384" => Curve::P384,
            "p521" => Curve::P521,
            _ => return None,
        })
    }

    /// 机器可读的曲线名（也是 `meta` 里的 `curve`）。
    fn name(self) -> &'static str {
        match self {
            Curve::P256 => "p256",
            Curve::P384 => "p384",
            Curve::P521 => "p521",
        }
    }
}

/// 输出格式。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Format {
    /// PEM：私钥给 PKCS#8 与 SEC1，公钥给 SPKI。
    Pem,
    /// 原始字节：私钥给标量，公钥给未压缩点，都是 hex。
    Raw,
}

impl Format {
    /// 从注册表下拉框的值解析。
    fn from_value(value: &str) -> Option<Self> {
        Some(match value {
            "pem" => Format::Pem,
            "raw" => Format::Raw,
            _ => return None,
        })
    }

    /// 机器可读的格式名（也是 `meta` 里的 `format`）。
    fn name(self) -> &'static str {
        match self {
            Format::Pem => "pem",
            Format::Raw => "raw",
        }
    }
}

/// 与 `ApiField { name: "curve", default: Some("p256") }` 保持一致。
const DEFAULT_CURVE: &str = "p256";
/// 与 `ApiField { name: "format", default: Some("pem") }` 保持一致。
const DEFAULT_FORMAT: &str = "pem";

/// 曲线取值的可选项文案 —— 错误信息与 [`Curve::from_value`] 的白名单共用一份。
const ALLOWED_CURVES_HINT: &str = "p256 / p384 / p521";
/// 输出格式的可选项文案。
const ALLOWED_FORMATS_HINT: &str = "pem / raw";

/// 解析曲线。缺字段 / 空串退回默认档（`p256`），未知取值报错。
fn parse_curve(payload: &Value) -> Result<Curve, ToolError> {
    let raw = util::str_or(payload, "curve", DEFAULT_CURVE);
    Curve::from_value(raw).ok_or_else(|| {
        ToolError::invalid(
            "out.ecdsa-key-pair-generator.err.unknown_curve",
            &[("curve", raw), ("allowed", ALLOWED_CURVES_HINT)],
        )
    })
}

/// 解析输出格式。缺字段 / 空串退回默认档（`pem`），未知取值报错。
fn parse_format(payload: &Value) -> Result<Format, ToolError> {
    let raw = util::str_or(payload, "format", DEFAULT_FORMAT);
    Format::from_value(raw).ok_or_else(|| {
        ToolError::invalid(
            "out.ecdsa-key-pair-generator.err.unknown_format",
            &[("format", raw), ("allowed", ALLOWED_FORMATS_HINT)],
        )
    })
}

/// P-256 的密钥。
fn generate_p256() -> Result<GeneratedKey, ToolError> {
    let signing = loop {
        let mut bytes = [0u8; 32];
        rand::rng().fill_bytes(&mut bytes);
        if let Ok(key) = p256::ecdsa::SigningKey::from_slice(&bytes) {
            break key;
        }
    };
    let secret = SecretKey::from(&signing);
    Ok(GeneratedKey {
        pkcs8_pem: signing
            .to_pkcs8_pem(LineEnding::LF)
            .map_err(|e| ToolError::Internal(format!("P-256 私钥编码失败: {e}")))?
            .to_string(),
        sec1_pem: secret
            .to_sec1_pem(LineEnding::LF)
            .map_err(|e| ToolError::Internal(format!("P-256 私钥编码失败: {e}")))?
            .to_string(),
        public_pem: signing
            .verifying_key()
            .to_public_key_pem(LineEnding::LF)
            .map_err(|e| ToolError::Internal(format!("P-256 公钥编码失败: {e}")))?,
        private_hex: hex::encode(signing.to_bytes()),
        public_hex: hex::encode(signing.verifying_key().to_sec1_bytes()),
    })
}

/// P-384 的密钥。
fn generate_p384() -> Result<GeneratedKey, ToolError> {
    let signing = loop {
        let mut bytes = [0u8; 48];
        rand::rng().fill_bytes(&mut bytes);
        if let Ok(key) = p384::ecdsa::SigningKey::from_slice(&bytes) {
            break key;
        }
    };
    let secret = SecretKey::from(&signing);
    Ok(GeneratedKey {
        pkcs8_pem: signing
            .to_pkcs8_pem(LineEnding::LF)
            .map_err(|e| ToolError::Internal(format!("P-384 私钥编码失败: {e}")))?
            .to_string(),
        sec1_pem: secret
            .to_sec1_pem(LineEnding::LF)
            .map_err(|e| ToolError::Internal(format!("P-384 私钥编码失败: {e}")))?
            .to_string(),
        public_pem: signing
            .verifying_key()
            .to_public_key_pem(LineEnding::LF)
            .map_err(|e| ToolError::Internal(format!("P-384 公钥编码失败: {e}")))?,
        private_hex: hex::encode(signing.to_bytes()),
        public_hex: hex::encode(signing.verifying_key().to_sec1_bytes()),
    })
}

/// P-521 的密钥。
fn generate_p521() -> Result<GeneratedKey, ToolError> {
    let signing = loop {
        let mut bytes = [0u8; 66];
        rand::rng().fill_bytes(&mut bytes);
        if let Ok(key) = p521::ecdsa::SigningKey::from_slice(&bytes) {
            break key;
        }
    };
    let secret = SecretKey::from(&signing);
    Ok(GeneratedKey {
        pkcs8_pem: signing
            .to_pkcs8_pem(LineEnding::LF)
            .map_err(|e| ToolError::Internal(format!("P-521 私钥编码失败: {e}")))?
            .to_string(),
        sec1_pem: secret
            .to_sec1_pem(LineEnding::LF)
            .map_err(|e| ToolError::Internal(format!("P-521 私钥编码失败: {e}")))?
            .to_string(),
        public_pem: signing
            .verifying_key()
            .to_public_key_pem(LineEnding::LF)
            .map_err(|e| ToolError::Internal(format!("P-521 公钥编码失败: {e}")))?,
        private_hex: hex::encode(signing.to_bytes()),
        public_hex: hex::encode(signing.verifying_key().to_sec1_bytes()),
    })
}

/// 按曲线生成密钥对。
fn generate(curve: Curve) -> Result<GeneratedKey, ToolError> {
    match curve {
        Curve::P256 => generate_p256(),
        Curve::P384 => generate_p384(),
        Curve::P521 => generate_p521(),
    }
}

/// 生成密钥对并编码成用户要的那几种表示。
///
/// `payload` 只用来取当前语言（行标题按语言走语言包），不参与密钥生成。
fn compute_with(payload: &Value, curve: Curve, format: Format) -> ToolResult {
    let key = generate(curve)?;

    // 结果表里**给人看的字**只有行标题，值全是机器可读的（PEM、hex）——
    // 行标题按当前语言取，值原样保留。
    let mut table = Map::new();
    let output = match format {
        Format::Pem => {
            util::row(
                &mut table,
                payload,
                "out.ecdsa-key-pair-generator.private_key",
                json!(key.pkcs8_pem),
            );
            util::row(
                &mut table,
                payload,
                "out.ecdsa-key-pair-generator.private_key_sec1",
                json!(key.sec1_pem),
            );
            util::row(
                &mut table,
                payload,
                "out.ecdsa-key-pair-generator.public_key",
                json!(key.public_pem),
            );
            key.pkcs8_pem
        }
        Format::Raw => {
            util::row(
                &mut table,
                payload,
                "out.ecdsa-key-pair-generator.private_key_raw",
                json!(key.private_hex),
            );
            util::row(
                &mut table,
                payload,
                "out.ecdsa-key-pair-generator.public_key_raw",
                json!(key.public_hex),
            );
            key.private_hex
        }
    };

    Ok(json!({
        "output": output,
        "table": table,
        "meta": {
            "algorithm": "ecdsa",
            "curve": curve.name(),
            "format": format.name(),
        },
    }))
}

/// 见 [`util::blocking`]。
pub async fn handle(payload: Value) -> ToolResult {
    util::blocking(move || {
        let curve = parse_curve(&payload)?;
        let format = parse_format(&payload)?;
        compute_with(&payload, curve, format)
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::engine::general_purpose::STANDARD as B64;
    use base64::Engine as _;

    /// 结果表的行标题是按语言包取的，断言时按同样的方式取标题 ——
    /// 把标题的字面量抄一遍的话，改一次文案就要改一次断言。
    fn label(key: &str) -> String {
        crate::i18n::t(crate::i18n::FALLBACK, key)
    }

    /// 生成一对密钥；`lang` 给 `None` 就是不带 `__lang`（走英文兜底）。
    fn gen_with_lang(curve: Curve, format: Format, lang: Option<&str>) -> Value {
        let payload = match lang {
            Some(l) => json!({ util::LANG_KEY: l }),
            None => json!({}),
        };
        compute_with(&payload, curve, format).expect("密钥生成不该失败")
    }

    fn gen(curve: Curve) -> Value {
        gen_with_lang(curve, Format::Pem, None)
    }

    /// PEM 的外壳对不对：BEGIN / END 的行、base64 能解开、DER 顶层是 SEQUENCE。
    fn assert_pem_shape(pem: &str, label: &str) {
        assert!(
            pem.starts_with(&format!("-----BEGIN {label}-----")),
            "{pem}"
        );
        assert!(
            pem.trim_end().ends_with(&format!("-----END {label}-----")),
            "{pem}"
        );
        let body: String = pem
            .lines()
            .filter(|l| !l.starts_with("-----"))
            .collect::<Vec<_>>()
            .join("");
        assert!(!body.is_empty(), "{pem}");
        let der = B64.decode(body).expect("正文该是合法的 base64");
        assert_eq!(der[0], 0x30, "DER 顶层应当是 SEQUENCE");
    }

    /// 私钥的 PEM 是不是三种标签都对。
    #[test]
    fn the_private_key_is_given_in_both_pkcs8_and_sec1() {
        for curve in [Curve::P256, Curve::P384, Curve::P521] {
            let out = gen(curve);
            let pkcs8 = out["output"].as_str().unwrap();
            assert_pem_shape(pkcs8, "PRIVATE KEY");
            // `output` 是 PKCS#8，别哪天接成 SEC1 了
            assert!(!pkcs8.contains("EC PRIVATE KEY"), "{pkcs8}");

            let sec1 = out["table"][&label("out.ecdsa-key-pair-generator.private_key_sec1")]
                .as_str()
                .unwrap();
            assert_pem_shape(sec1, "EC PRIVATE KEY");

            let public = out["table"][&label("out.ecdsa-key-pair-generator.public_key")]
                .as_str()
                .unwrap();
            assert_pem_shape(public, "PUBLIC KEY");

            // `output` 与表里的 PKCS#8 是同一份
            assert_eq!(
                out["table"][&label("out.ecdsa-key-pair-generator.private_key")],
                out["output"]
            );
        }
    }

    /// 原始字节那一档：私钥是标量、公钥是未压缩点，都是 hex；
    /// 这一档里**不该**有 PEM。
    #[test]
    fn the_raw_format_gives_hex_and_no_pem() {
        let out = gen_with_lang(Curve::P256, Format::Raw, None);
        let table = out["table"].as_object().unwrap();

        let private_hex = out["output"].as_str().unwrap();
        assert_eq!(private_hex.len(), 64, "P-256 的标量是 32 字节");
        assert!(private_hex.chars().all(|c| c.is_ascii_hexdigit()));

        let public_hex = table[&label("out.ecdsa-key-pair-generator.public_key_raw")]
            .as_str()
            .unwrap();
        assert_eq!(public_hex.len(), 130, "P-256 的未压缩点是 65 字节");
        assert!(public_hex.starts_with("04"), "未压缩点以 0x04 开头");

        // 原始档里不该有 PEM —— 下拉框要真的起作用
        assert!(!table.contains_key(&label("out.ecdsa-key-pair-generator.private_key")));
        assert!(!table.contains_key(&label("out.ecdsa-key-pair-generator.private_key_sec1")));
        assert!(!table.contains_key(&label("out.ecdsa-key-pair-generator.public_key")));
    }

    /// 三条曲线的私钥长度与公钥长度都要对。
    #[test]
    fn the_raw_sizes_match_each_curve() {
        for (curve, scalar_len, point_len) in [
            (Curve::P256, 64, 130),
            (Curve::P384, 96, 194),
            (Curve::P521, 132, 266),
        ] {
            let out = gen_with_lang(curve, Format::Raw, None);
            let table = out["table"].as_object().unwrap();
            let private_hex = out["output"].as_str().unwrap();
            let public_hex = table[&label("out.ecdsa-key-pair-generator.public_key_raw")]
                .as_str()
                .unwrap();
            assert_eq!(private_hex.len(), scalar_len, "{}", curve.name());
            assert_eq!(public_hex.len(), point_len, "{}", curve.name());
        }
    }

    /// 两次生成的密钥对不同 —— 用了固定种子的话这条会红。
    #[test]
    fn two_generations_differ() {
        for curve in [Curve::P256, Curve::P384, Curve::P521] {
            let a = gen(curve);
            let b = gen(curve);
            assert_ne!(a["output"], b["output"], "{}", curve.name());
        }
    }

    /// 格式的解析：缺字段 / 空串退回默认档，未知取值报错。
    #[test]
    fn the_parsing_follows_the_registry_defaults() {
        assert_eq!(parse_curve(&json!({})).unwrap(), Curve::P256);
        assert_eq!(parse_curve(&json!({ "curve": "" })).unwrap(), Curve::P256);
        assert_eq!(parse_curve(&json!({ "curve": "p521" })).unwrap(), Curve::P521);
        assert_eq!(parse_format(&json!({})).unwrap(), Format::Pem);
        assert_eq!(parse_format(&json!({ "format": "raw" })).unwrap(), Format::Raw);

        let err = parse_curve(&json!({ "curve": "brainpool" })).expect_err("未知曲线必须报错");
        match &err {
            ToolError::InvalidKeyed { key, .. } => {
                assert_eq!(*key, "out.ecdsa-key-pair-generator.err.unknown_curve")
            }
            other => panic!("应当报 unknown_curve，实际 {other:?}"),
        }

        let err = parse_format(&json!({ "format": "der" })).expect_err("未知格式必须报错");
        match &err {
            ToolError::InvalidKeyed { key, .. } => {
                assert_eq!(*key, "out.ecdsa-key-pair-generator.err.unknown_format")
            }
            other => panic!("应当报 unknown_format，实际 {other:?}"),
        }
    }

    /// 错误信息跟着请求语言走 —— 语言不是工具决定的，是 API 层按请求语言
    /// 调用 `localize` 渲染的。
    #[test]
    fn the_error_message_follows_the_requested_language() {
        // 语言包里还没并进来时，localize 退回键本身 —— 这时断言跳过
        if !crate::i18n::has("zh-CN", "out.ecdsa-key-pair-generator.err.unknown_curve") {
            return;
        }
        let err = parse_curve(&json!({ "curve": "brainpool" })).unwrap_err();
        let en = err.localize("en");
        let zh = err.localize("zh-CN");
        assert_ne!(en, zh, "两种语言不该是同一句");
        assert!(
            !en.contains("out.ecdsa-key-pair-generator"),
            "英文界面不该露出键：{en}"
        );
        // 占位符要真的被替换掉 —— 留着 `{curve}` 给用户看等于没说
        assert!(en.contains("brainpool"), "错误信息里应当带上用户给的值：{en}");
        assert!(!en.contains("{curve}"), "占位符没被替换：{en}");
    }

    /// 表格的标题要跟着请求语言走。
    #[test]
    fn the_row_labels_follow_the_request_language() {
        let key = "out.ecdsa-key-pair-generator.private_key";
        let en = gen_with_lang(Curve::P256, Format::Pem, None);
        let zh = gen_with_lang(Curve::P256, Format::Pem, Some("zh-CN"));
        let en_table = en["table"].as_object().unwrap();
        let zh_table = zh["table"].as_object().unwrap();
        assert!(en_table.contains_key(&crate::i18n::t("en", key)), "{en_table:?}");
        assert!(
            zh_table.contains_key(&crate::i18n::t("zh-CN", key)),
            "{zh_table:?}"
        );

        if crate::i18n::has("en", key) && crate::i18n::has("zh-CN", key) {
            assert!(!zh_table.contains_key(&crate::i18n::t("en", key)), "{zh_table:?}");
            assert!(!en_table.contains_key(&crate::i18n::t("zh-CN", key)), "{en_table:?}");
        }
    }

    /// `meta` 里不该有密钥材料。
    #[test]
    fn meta_never_leaks_key_material() {
        let out = gen(Curve::P256);
        let private_pem = out["output"].as_str().unwrap();
        let sample: String = private_pem
            .lines()
            .filter(|l| !l.starts_with("-----"))
            .collect::<String>()
            .chars()
            .take(24)
            .collect();
        assert!(!sample.is_empty());
        assert!(!out["meta"].to_string().contains(&sample), "meta 里不该有密钥内容");
        assert_eq!(out["meta"]["algorithm"], "ecdsa");
        assert_eq!(out["meta"]["curve"], "p256");
        assert_eq!(out["meta"]["format"], "pem");
    }

    /// 行的**标题**必须短 —— 表格的标题列是固定宽度的。
    #[test]
    fn the_row_labels_are_short() {
        for format in [Format::Pem, Format::Raw] {
            let out = gen_with_lang(Curve::P256, format, None);
            for k in out["table"].as_object().unwrap().keys() {
                // 语言包还没并进来时，取到的就是键名本身（`out.…`）——
                // 那是键不是标题，没法拿来量长度，跳过。
                if k.starts_with("out.") {
                    continue;
                }
                assert!(k.chars().count() <= 40, "行标题太长，会把表格撑破: {k}");
            }
        }
    }

    /// 每条曲线的私钥公钥要真的配得上对，并且能签能验。
    ///
    /// 断言走的是**库自己的解码器**（`from_sec1_pem` / `from_pkcs8_pem` /
    /// `from_public_key_pem`）—— 把 PEM 解回密钥再签一遍，才抓得到
    /// 「编码时把公钥写错了」这类问题。
    macro_rules! curve_round_trip {
        ($mod_name:ident, $curve:ident, $gen:ident, $curve_type:ident) => {
            mod $mod_name {
                use super::*;
                use $curve::ecdsa::signature::{Signer, Verifier};
                use $curve::ecdsa::{SigningKey, VerifyingKey};
                use elliptic_curve::pkcs8::spki::DecodePublicKey;
                use elliptic_curve::pkcs8::DecodePrivateKey;

                #[test]
                fn the_pem_round_trips_and_the_key_signs() {
                    let key = super::$gen().expect("生成密钥");

                    // SEC1 解回来
                    let secret = SecretKey::<$curve::$curve_type>::from_sec1_pem(&key.sec1_pem)
                        .expect("SEC1 应当能解回来");
                    // PKCS#8 解回来
                    let signing = SigningKey::from_pkcs8_pem(&key.pkcs8_pem)
                        .expect("PKCS#8 应当能解回来");
                    // SPKI 解回来
                    let verifying = VerifyingKey::from_public_key_pem(&key.public_pem)
                        .expect("SPKI 应当能解回来");

                    // 三份说的是同一把钥匙
                    assert_eq!(
                        hex::encode(secret.to_bytes()),
                        key.private_hex,
                        "SEC1 里的私钥与原始档对不上"
                    );
                    assert_eq!(
                        hex::encode(signing.to_bytes()),
                        key.private_hex,
                        "PKCS#8 里的私钥与原始档对不上"
                    );
                    assert_eq!(
                        hex::encode(verifying.to_sec1_bytes()),
                        key.public_hex,
                        "SPKI 里的公钥与原始档对不上"
                    );

                    // 用解回来的私钥签，用解回来的公钥验
                    //
                    // 签名类型要写出来：`Signer` 对固定长度的 `Signature` 与
                    // DER 编码的 `DerSignature` 都有实现，不写类型推不出来。
                    let message = b"it-tools ecdsa round trip";
                    let signature: $curve::ecdsa::Signature = signing.sign(message);
                    verifying
                        .verify(message, &signature)
                        .expect("自己签的应当能自己验");

                    // 改一个字就验不过
                    let mut tampered = message.to_vec();
                    tampered[0] ^= 0x01;
                    assert!(
                        verifying.verify(&tampered, &signature).is_err(),
                        "被改过的消息不该验过"
                    );
                }
            }
        };
    }

    curve_round_trip!(p256_tests, p256, generate_p256, NistP256);
    curve_round_trip!(p384_tests, p384, generate_p384, NistP384);
    curve_round_trip!(p521_tests, p521, generate_p521, NistP521);

    /// **外部参照**：`openssl` 能读我们给的 PEM，而且能验我们签的东西。
    ///
    /// 单元测试只能验证「我写的东西符合我自己理解的结构」，
    /// 真正的判据是 **`openssl ec -in key.pem -text -noout` 能读出同一把密钥**，
    /// 而且 **`openssl` 签的报文能被我们的公钥验过**（反过来也一样）。
    ///
    /// 这个测试默认跳过：CI 的三个系统上 `openssl` 的版本不一样，
    /// 拿一个「本机有没有 openssl」当判据的测试会让 CI 变成「有时绿有时红」。
    /// 跑法：
    ///
    /// ```sh
    /// cargo test --offline --lib tools::ecdsa_key_pair_generator -- --ignored --nocapture
    /// ```
    macro_rules! openssl_cross_check {
        ($mod_name:ident, $curve:ident, $gen:ident, $curve_type:ident, $openssl_curve:expr, $digest:expr) => {
            mod $mod_name {
                use $curve::ecdsa::signature::{Signer, Verifier};
                use $curve::ecdsa::VerifyingKey;
                use elliptic_curve::pkcs8::spki::DecodePublicKey;
                use elliptic_curve::pkcs8::DecodePrivateKey;

                #[test]
                #[ignore = "需要外部的 openssl 对拍"]
                fn openssl_reads_our_pem_and_verifies_our_signature() {
                    let key = super::$gen().expect("生成密钥");

                    let dir = super::temp_dir(stringify!($mod_name));
                    let sec1_path = dir.join("key.sec1.pem");
                    let pkcs8_path = dir.join("key.pkcs8.pem");
                    let pub_path = dir.join("key.pub.pem");
                    let msg_path = dir.join("msg.bin");
                    let sig_path = dir.join("sig.bin");
                    std::fs::write(&sec1_path, &key.sec1_pem).unwrap();
                    std::fs::write(&pkcs8_path, &key.pkcs8_pem).unwrap();
                    std::fs::write(&pub_path, &key.public_pem).unwrap();
                    std::fs::write(&msg_path, b"it-tools ecdsa openssl cross check").unwrap();

                    // 1. openssl 读得了我们的 SEC1 私钥
                    let (ok, text) = super::openssl(&[
                        "ec",
                        "-in",
                        sec1_path.to_str().unwrap(),
                        "-text",
                        "-noout",
                    ]);
                    assert!(ok, "openssl 读不了我们的 SEC1 私钥:\n{text}");
                    assert!(text.contains($openssl_curve), "{text}");

                    // 2. openssl 读得了我们的 PKCS#8 私钥
                    let (ok, text) = super::openssl(&[
                        "pkey",
                        "-in",
                        pkcs8_path.to_str().unwrap(),
                        "-text",
                        "-noout",
                    ]);
                    assert!(ok, "openssl 读不了我们的 PKCS#8 私钥:\n{text}");
                    assert!(text.contains($openssl_curve), "{text}");

                    // 3. openssl 读得了我们的公钥
                    let (ok, text) = super::openssl(&[
                        "pkey",
                        "-pubin",
                        "-in",
                        pub_path.to_str().unwrap(),
                        "-text",
                        "-noout",
                    ]);
                    assert!(ok, "openssl 读不了我们的公钥:\n{text}");
                    assert!(text.contains($openssl_curve), "{text}");

                    // 4. openssl 从私钥导出的公钥要与我们给的一致
                    let derived_path = dir.join("derived.pub.pem");
                    let (ok, text) = super::openssl(&[
                        "pkey",
                        "-in",
                        sec1_path.to_str().unwrap(),
                        "-pubout",
                        "-out",
                        derived_path.to_str().unwrap(),
                    ]);
                    assert!(ok, "openssl 导不出公钥:\n{text}");
                    assert_eq!(
                        std::fs::read_to_string(&derived_path).unwrap(),
                        key.public_pem,
                        "openssl 从私钥导出的公钥必须与我们给的一致"
                    );

                    // 5. openssl 签，我们验
                    let (ok, text) = super::openssl(&[
                        "dgst",
                        $digest,
                        "-sign",
                        sec1_path.to_str().unwrap(),
                        "-out",
                        sig_path.to_str().unwrap(),
                        msg_path.to_str().unwrap(),
                    ]);
                    assert!(ok, "openssl 签不了:\n{text}");
                    // `openssl dgst -sign` 给的是 **DER 编码**的 ECDSA 签名
                    // （SEQUENCE{INTEGER r, INTEGER s}），不是定长的 r‖s ——
                    // 解码器要按 DER 来读。
                    let signature = $curve::ecdsa::Signature::from_der(
                        &std::fs::read(&sig_path).unwrap(),
                    )
                    .expect("openssl 的签名应当是 DER 编码的 ECDSA 签名");
                    let verifying = VerifyingKey::from_public_key_pem(&key.public_pem)
                        .expect("SPKI 应当能解回来");
                    verifying
                        .verify(b"it-tools ecdsa openssl cross check", &signature)
                        .expect("openssl 签的应当能验过");

                    // 6. 我们签，openssl 验
                    let signing = $curve::ecdsa::SigningKey::from_pkcs8_pem(&key.pkcs8_pem).unwrap();
                    let our_sig: $curve::ecdsa::Signature =
                        signing.sign(b"it-tools ecdsa openssl cross check");
                    let our_sig_path = dir.join("our-sig.bin");
                    // `openssl dgst -verify` 吃的是 **DER 编码**的签名
                    // （跟 `dgst -sign` 一样），不是定长的 r‖s。
                    std::fs::write(&our_sig_path, our_sig.to_der().to_bytes()).unwrap();
                    let (ok, text) = super::openssl(&[
                        "dgst",
                        $digest,
                        "-verify",
                        pub_path.to_str().unwrap(),
                        "-signature",
                        our_sig_path.to_str().unwrap(),
                        msg_path.to_str().unwrap(),
                    ]);
                    assert!(ok, "openssl 验不过我们的签名:\n{text}");

                    std::fs::remove_dir_all(&dir).ok();
                }
            }
        };
    }

    openssl_cross_check!(
        p256_openssl,
        p256,
        generate_p256,
        NistP256,
        "prime256v1",
        "-sha256"
    );
    openssl_cross_check!(p384_openssl, p384, generate_p384, NistP384, "secp384r1", "-sha384");
    openssl_cross_check!(p521_openssl, p521, generate_p521, NistP521, "secp521r1", "-sha512");

    /// 建一个临时目录（这个仓库没有 `tempfile` 依赖）。
    fn temp_dir(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "it-tools-{tag}-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// 跑一条 `openssl` 命令，返回 (成功与否, 输出)。
    ///
    /// 30 秒是上限：卡住的子进程能把 CI 的 job 一起拖死。
    fn openssl(args: &[&str]) -> (bool, String) {
        let (tx, rx) = std::sync::mpsc::channel();
        let args: Vec<String> = args.iter().map(|s| s.to_string()).collect();
        std::thread::spawn(move || {
            let out = std::process::Command::new("openssl")
                .args(&args)
                // stdin 一根都不给：openssl 找不到别的输入源时会去读控制台，
                // 而 CI 上那个控制台是没有输入的。
                .stdin(std::process::Stdio::null())
                .output()
                .expect("本机装了 openssl 命令行工具");
            let text = format!(
                "{}{}",
                String::from_utf8_lossy(&out.stdout),
                String::from_utf8_lossy(&out.stderr)
            );
            let _ = tx.send((out.status.success(), text));
        });
        match rx.recv_timeout(std::time::Duration::from_secs(30)) {
            Ok(result) => result,
            Err(_) => (false, "openssl 超时（30 秒）".to_string()),
        }
    }
}
