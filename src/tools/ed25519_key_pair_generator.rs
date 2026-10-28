//! Ed25519 密钥对生成（endpoint `ed25519-key-pair-generator`）。
//!
//! ## 这个工具做什么
//!
//! 生成一对 Ed25519 密钥，给出四种表示：
//!
//! | 表示 | 形状 |
//! |---|---|
//! | 私钥（PKCS#8 PEM） | `-----BEGIN PRIVATE KEY-----` |
//! | 公钥（SPKI PEM） | `-----BEGIN PUBLIC KEY-----` |
//! | 私钥原始种子 | 32 字节的 hex（`SigningKey::to_bytes()`） |
//! | 公钥原始字节 | 32 字节的 hex（`VerifyingKey::to_bytes()`） |
//!
//! `format` 下拉决定给哪几种：`pem` 只给两份 PEM，`raw` 只给两份 hex ——
//! 下拉框要真的起作用，两个视图给的是同一堆东西就没必要做这个下拉框。
//!
//! ## 与参考实现的差别
//!
//! 参考实现（`it-tools2` 的 `ed25519-key-pair-generator`）用 npm 的 **sshpk**，
//! 默认档（`format = "ssh"`）给的是 **OpenSSH 格式**私钥
//! （`-----BEGIN OPENSSH PRIVATE KEY-----`）加一行 authorized_keys 公钥，
//! 外加 SHA256 / MD5 指纹。
//!
//! 本实现**不产 OpenSSH 格式**：仓库里已经有
//! [`super::ssh_key_pair_generator`] 专门产出那个（还带口令加密与
//! authorized_keys 那一行），在这里再产一份只会让用户拿错格式 ——
//! **要 OpenSSH 格式请用 ssh-key-pair-generator**。指纹也是 SSH 那一族的东西，
//! 这里给的是 PEM 与原始字节。
//!
//! ## 编码路线：为什么手搓 PKCS#8 / SPKI
//!
//! `ed25519-dalek 3.0` 自带的 `to_pkcs8_pem` / `to_public_key_pem` 要开
//! **`pkcs8` 特性**，而仓库的 `Cargo.toml` 里 `ed25519-dalek = "3.0"` 那一行的
//! 默认特性只有 `fast` 与 `zeroize`，**没有** `pkcs8`（`Cargo.toml` 是接线人
//! 统一改的，这里不碰）。
//!
//! 所以走另一条路：用 `elliptic_curve::pkcs8`（那是 **pkcs8 0.11**，
//! `elliptic-curve 0.14` 自带，`p256` 的默认特性已经把它打开）自己拼
//! `PrivateKeyInfo` 与 `SubjectPublicKeyInfo`，再 DER + PEM ——
//! **不需要改 `Cargo.toml`**。
//!
//! Ed25519 的 PKCS#8 是**定长**的（RFC 8410 § 7）：
//!
//! ```text
//! SEQUENCE {
//!   INTEGER 0
//!   SEQUENCE { OID 1.3.101.112 }        ← id-Ed25519
//!   OCTET STRING { OCTET STRING { 32 字节种子 } }
//! }
//! ```
//!
//! 注意 `privateKey` 里那层**嵌套的 OCTET STRING**：RFC 8410 要求把
//! `CurvePrivateKey`（它本身就是 OCTET STRING）再包一层。少这一层，
//! `openssl` 会直接报「ASN1 parser: error parsing private key」。
//!
//! SPKI 则是：
//!
//! ```text
//! SEQUENCE {
//!   SEQUENCE { OID 1.3.101.112 }
//!   BIT STRING { 32 字节公钥 }
//! }
//! ```
//!
//! ## 安全边界
//!
//! 私钥在**服务端**生成：它短暂地存在于本进程的堆上，随后经 HTTP 响应体发往
//! 浏览器。这条链路上它就是明文，只受 TLS 保护；服务端不做任何补救，也不该做
//! —— 与 [`super::rsa_key_pair_generator`] 同一个口径。
//!
//! 私钥**绝不落盘、不进缓存、不进日志、不进错误信息**：下面所有 `map_err`
//! 带回来的都只是编码器的错误信息，它不携带密钥材料。

use ed25519_dalek::SigningKey;
use elliptic_curve::pkcs8::{
    der::{
        asn1::{Any, BitString, OctetString},
        Document,
    },
    spki::{AlgorithmIdentifier, SubjectPublicKeyInfoOwned},
    EncodePrivateKey, LineEnding, PrivateKeyInfoOwned,
};
use rand::Rng;
use serde_json::{json, Map, Value};

use super::{util, ToolError, ToolResult};

/// id-Ed25519（RFC 8410 § 7）。
const ED25519_OID: elliptic_curve::pkcs8::ObjectIdentifier =
    elliptic_curve::pkcs8::ObjectIdentifier::new_unwrap("1.3.101.112");

/// Ed25519 私钥的长度：32 字节的种子。
const SEED_LEN: usize = 32;

/// 输出格式。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Format {
    /// PEM：私钥给 PKCS#8，公钥给 SPKI。
    Pem,
    /// 原始字节：私钥给 32 字节种子，公钥给 32 字节公钥，都是 hex。
    Raw,
}

impl Format {
    /// 从注册表下拉框的值解析。认不出来返回 `None` ——
    /// 下拉框的值是外部输入，不该由它决定「用哪个格式」。
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

/// 与 `ApiField { name: "format", default: Some("pem") }` 保持一致。
const DEFAULT_FORMAT: &str = "pem";

/// 输出格式的可选值文案 —— 错误信息与 [`Format::from_value`] 的白名单共用一份。
const ALLOWED_FORMATS_HINT: &str = "pem / raw";

/// 解析输出格式。缺字段 / 空串退回默认档（`pem`），未知取值报错。
///
/// 不用「未知就退回默认」：格式错了会让人拿到一把用不了的私钥，
/// 而报错只花一眼。
fn parse_format(payload: &Value) -> Result<Format, ToolError> {
    let raw = util::str_or(payload, "format", DEFAULT_FORMAT);
    Format::from_value(raw).ok_or_else(|| {
        ToolError::invalid(
            "out.ed25519-key-pair-generator.err.unknown_format",
            &[("format", raw), ("allowed", ALLOWED_FORMATS_HINT)],
        )
    })
}

/// Ed25519 的 PKCS#8 私钥 PEM。
///
/// 结构见模块头部（RFC 8410 § 7）。这里不把它交给 `ed25519-dalek` ——
/// 那个 API 要 `pkcs8` 特性，而 `Cargo.toml` 里没开（见模块头部的说明）。
fn pkcs8_pem(seed: &[u8; SEED_LEN]) -> Result<String, ToolError> {
    // `privateKey` 里那层嵌套的 OCTET STRING：DER 的 OCTET STRING 头
    // （0x04 0x20，长度 32 字节定长）+ 种子本身。
    let mut nested = Vec::with_capacity(2 + SEED_LEN);
    nested.push(0x04);
    nested.push(0x20);
    nested.extend_from_slice(seed);

    let info = PrivateKeyInfoOwned {
        algorithm: AlgorithmIdentifier::<Any> {
            oid: ED25519_OID,
            // Ed25519 的算法标识没有参数（RFC 8410 § 3）。
            parameters: None,
        },
        private_key: OctetString::new(nested)
            .map_err(|e| ToolError::Internal(format!("Ed25519 PKCS#8 编码失败: {e}")))?,
        // 公钥不塞进 PKCS#8：v1 的形状就是 48 字节定长，
        // 与 `openssl genpkey -algorithm ed25519` 给的一致。
        public_key: None,
    };

    let pem = info
        .to_pkcs8_pem(LineEnding::LF)
        .map_err(|e| ToolError::Internal(format!("Ed25519 PKCS#8 编码失败: {e}")))?;
    Ok(pem.to_string())
}

/// Ed25519 的 SPKI 公钥 PEM。
fn spki_pem(public: &[u8; SEED_LEN]) -> Result<String, ToolError> {
    let spki = SubjectPublicKeyInfoOwned {
        algorithm: AlgorithmIdentifier::<Any> {
            oid: ED25519_OID,
            parameters: None,
        },
        subject_public_key: BitString::new(0, public.to_vec())
            .map_err(|e| ToolError::Internal(format!("Ed25519 公钥编码失败: {e}")))?,
    };

    let doc = Document::encode_msg(&spki)
        .map_err(|e| ToolError::Internal(format!("Ed25519 公钥编码失败: {e}")))?;
    doc.to_pem("PUBLIC KEY", LineEnding::LF)
        .map_err(|e| ToolError::Internal(format!("Ed25519 公钥编码失败: {e}")))
}

/// 生成一对密钥并编码成用户要的那几种表示。
///
/// `payload` 只用来取当前语言（行标题按语言走语言包），不参与密钥生成。
fn generate(payload: &Value, format: Format) -> ToolResult {
    // 32 字节种子：直接问操作系统要熵。`rand::rng()` 是线程本地的 CSPRNG
    // （Linux 上落到 `getrandom(2)`，退化时走 `/dev/urandom`），每次取随机数
    // 都直接问熵源，不播种。
    //
    // 不用 `SigningKey::generate(&mut rng)` —— 那个 API 要 ed25519-dalek 的
    // `rand_core` 特性，仓库的 `Cargo.toml` 里也没开（默认特性只有
    // `fast` / `zeroize`）。自己抽 32 字节再 `from_bytes` 是同一条路，
    // 且不需要改依赖。
    let mut seed = [0u8; SEED_LEN];
    rand::rng().fill_bytes(&mut seed);

    let signing = SigningKey::from_bytes(&seed);
    let public = signing.verifying_key().to_bytes();

    // 结果表里**给人看的字**只有行标题，值全是机器可读的（PEM、hex）——
    // 行标题按当前语言取，值原样保留。
    let mut table = Map::new();
    let output = match format {
        Format::Pem => {
            let private_pem = pkcs8_pem(&seed)?;
            let public_pem = spki_pem(&public)?;
            util::row(
                &mut table,
                payload,
                "out.ed25519-key-pair-generator.private_key",
                json!(private_pem),
            );
            util::row(
                &mut table,
                payload,
                "out.ed25519-key-pair-generator.public_key",
                json!(public_pem),
            );
            private_pem
        }
        Format::Raw => {
            let private_hex = hex::encode(seed);
            let public_hex = hex::encode(public);
            util::row(
                &mut table,
                payload,
                "out.ed25519-key-pair-generator.private_key_raw",
                json!(private_hex),
            );
            util::row(
                &mut table,
                payload,
                "out.ed25519-key-pair-generator.public_key_raw",
                json!(public_hex),
            );
            private_hex
        }
    };

    Ok(json!({
        "output": output,
        "table": table,
        "meta": {
            "algorithm": "ed25519",
            "format": format.name(),
        },
    }))
}

/// 见 [`util::blocking`]。
pub async fn handle(payload: Value) -> ToolResult {
    util::blocking(move || compute(payload)).await
}

fn compute(payload: Value) -> ToolResult {
    let format = parse_format(&payload)?;
    generate(&payload, format)
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::engine::general_purpose::STANDARD as B64;
    use base64::Engine as _;
    use ed25519_dalek::{Signer, VerifyingKey};
    use elliptic_curve::pkcs8::DecodePrivateKey;

    /// 结果表的行标题是按语言包取的，断言时按同样的方式取标题 ——
    /// 把标题的字面量抄一遍的话，改一次文案就要改一次断言。
    fn label(key: &str) -> String {
        crate::i18n::t(crate::i18n::FALLBACK, key)
    }

    /// 生成一对密钥；`lang` 给 `None` 就是不带 `__lang`（走英文兜底）。
    fn gen_with_lang(format: Format, lang: Option<&str>) -> Value {
        let payload = match lang {
            Some(l) => json!({ util::LANG_KEY: l }),
            None => json!({}),
        };
        generate(&payload, format).expect("密钥生成不该失败")
    }

    fn gen(format: Format) -> Value {
        gen_with_lang(format, None)
    }

    /// 从 PKCS#8 PEM 里把种子挖出来。
    ///
    /// 走的是 `pkcs8` crate 自己的解码器 —— PEM 的 base64 与 DER 的结构都由
    /// 第三方实现来读，测试才算真的在验格式，而不是自己跟自己比。
    fn seed_of(private_pem: &str) -> Vec<u8> {
        let parsed = pem::parse(private_pem).expect("私钥应当是合法的 PEM");
        assert_eq!(parsed.tag(), "PRIVATE KEY");
        let info = PrivateKeyInfoOwned::from_pkcs8_der(parsed.contents())
            .expect("PKCS#8 应当能被解回来");
        // `privateKey` 里是嵌套的 OCTET STRING：0x04 0x20 ‖ 种子
        let nested = info.private_key.as_bytes();
        assert_eq!(&nested[..2], &[0x04, 0x20], "嵌套的 OCTET STRING 头不对");
        nested[2..].to_vec()
    }

    /// 从 SPKI PEM 里把公钥挖出来。
    fn public_of(public_pem: &str) -> Vec<u8> {
        let parsed = pem::parse(public_pem).expect("公钥应当是合法的 PEM");
        assert_eq!(parsed.tag(), "PUBLIC KEY");
        let doc = Document::try_from(parsed.contents()).expect("DER 应当能解成 Document");
        let spki = doc
            .decode_msg::<SubjectPublicKeyInfoOwned>()
            .expect("SPKI 应当能解回来");
        spki.subject_public_key
            .as_bytes()
            .expect("BIT STRING 应当有内容")
            .to_vec()
    }

    /// PEM 的外壳对不对：BEGIN / END 的行、base64 能解开、DER 能解。
    #[test]
    fn pem_headers_are_pkcs8_private_and_spki_public() {
        let out = gen(Format::Pem);

        let private_pem = out["output"].as_str().unwrap();
        assert!(
            private_pem.starts_with("-----BEGIN PRIVATE KEY-----"),
            "{private_pem}"
        );
        assert!(
            private_pem.trim_end().ends_with("-----END PRIVATE KEY-----"),
            "{private_pem}"
        );

        let public_pem = out["table"][&label("out.ed25519-key-pair-generator.public_key")]
            .as_str()
            .unwrap();
        assert!(
            public_pem.starts_with("-----BEGIN PUBLIC KEY-----"),
            "{public_pem}"
        );
        assert!(
            public_pem.trim_end().ends_with("-----END PUBLIC KEY-----"),
            "{public_pem}"
        );

        // base64 能解开（不是「看起来像 base64」）
        for pem in [private_pem, public_pem] {
            let body: String = pem
                .lines()
                .filter(|l| !l.starts_with("-----"))
                .collect::<Vec<_>>()
                .join("");
            assert!(!body.is_empty());
            let der = B64.decode(body).expect("正文该是合法的 base64");
            // DER 顶层一定是 SEQUENCE（0x30）
            assert_eq!(der[0], 0x30, "DER 顶层应当是 SEQUENCE");
        }

        // `output` 与表里的私钥是同一份，别哪天两边接错了
        assert_eq!(
            out["table"][&label("out.ed25519-key-pair-generator.private_key")],
            out["output"]
        );
    }

    /// 真正的断言：只比对 PEM 前缀的话，一个「私钥和公钥各生成一次、互不相干」
    /// 的实现也能通过。必须把私钥解回来、重新导出公钥，看是否与输出逐字节相同。
    #[test]
    fn the_public_key_is_derived_from_the_private_key() {
        let out = gen(Format::Pem);
        let private_pem = out["output"].as_str().unwrap();
        let public_pem = out["table"][&label("out.ed25519-key-pair-generator.public_key")]
            .as_str()
            .unwrap();

        let seed = seed_of(private_pem);
        assert_eq!(seed.len(), SEED_LEN, "Ed25519 的种子是 32 字节");

        // 用解回来的种子重建私钥，重新导出公钥
        let signing = SigningKey::from_bytes(&seed.try_into().unwrap());
        assert_eq!(
            signing.verifying_key().to_bytes().to_vec(),
            public_of(public_pem),
            "公钥必须由私钥导出"
        );

        // 反向也要成立：公钥 PEM 本身能被独立解析
        let verifying = VerifyingKey::from_bytes(&public_of(public_pem).try_into().unwrap())
            .expect("公钥应当是合法的 Ed25519 公钥");
        assert_eq!(verifying.to_bytes().to_vec(), public_of(public_pem));
    }

    /// 自签自验：生成的密钥对签一段数据、再用给出去的公钥验。
    ///
    /// `verify_strict` 比 `verify` 严：它还会检查 R 与 A 的关系
    /// （小订单检查），弱签名（小订单攻击）骗不过去。
    #[test]
    fn the_generated_key_signs_and_verifies() {
        let out = gen(Format::Pem);
        let private_pem = out["output"].as_str().unwrap();
        let public_pem = out["table"][&label("out.ed25519-key-pair-generator.public_key")]
            .as_str()
            .unwrap();

        let seed = seed_of(private_pem);
        let signing = SigningKey::from_bytes(&seed.try_into().unwrap());
        let verifying = VerifyingKey::from_bytes(&public_of(public_pem).try_into().unwrap()).unwrap();

        let message = b"it-tools ed25519 round trip";
        let signature = signing.sign(message);
        verifying
            .verify_strict(message, &signature)
            .expect("自己签的应当能自己验");

        // 改一个字就验不过
        let mut tampered = message.to_vec();
        tampered[0] ^= 0x01;
        assert!(
            verifying.verify_strict(&tampered, &signature).is_err(),
            "被改过的消息不该验过"
        );
    }

    /// 原始字节那一档：私钥是 32 字节种子、公钥是 32 字节公钥，都是 hex。
    #[test]
    fn the_raw_format_gives_the_seed_and_the_public_key_as_hex() {
        let out = gen(Format::Raw);

        let private_hex = out["output"].as_str().unwrap();
        assert_eq!(private_hex.len(), 64, "32 字节 = 64 个 hex 字符");
        assert!(
            private_hex.chars().all(|c| c.is_ascii_hexdigit()),
            "{private_hex}"
        );

        let public_hex = out["table"][&label("out.ed25519-key-pair-generator.public_key_raw")]
            .as_str()
            .unwrap();
        assert_eq!(public_hex.len(), 64);

        // 原始档里**不该**有 PEM —— 下拉框要真的起作用
        assert!(!out["table"]
            .as_object()
            .unwrap()
            .contains_key(&label("out.ed25519-key-pair-generator.private_key")));
        assert!(!out["table"]
            .as_object()
            .unwrap()
            .contains_key(&label("out.ed25519-key-pair-generator.public_key")));

        // 原始档的私钥与 PEM 档的私钥是同一把 —— 换档不该换密钥
        // （两次生成本来就是两把不同的密钥，所以只验形状：
        //  种子必须是合法的 Ed25519 标量，公钥必须与种子匹配）
        let seed: [u8; 32] = hex::decode(private_hex).unwrap().try_into().unwrap();
        let signing = SigningKey::from_bytes(&seed);
        let derived = signing.verifying_key().to_bytes();
        assert_eq!(hex::encode(derived), public_hex, "公钥必须与私钥匹配");
    }

    /// 两次生成的密钥对不同 —— 用了固定种子的话这条会红。
    #[test]
    fn two_generations_differ() {
        let a = gen(Format::Pem);
        let b = gen(Format::Pem);
        assert_ne!(a["output"], b["output"], "连续生成必须得到不同的密钥");
        let public_key = label("out.ed25519-key-pair-generator.public_key");
        assert_ne!(
            a["table"][&public_key], b["table"][&public_key],
            "公钥也跟着变才说明私钥真的换了"
        );
    }

    /// 格式的解析：缺字段 / 空串退回默认档，未知取值报错。
    #[test]
    fn format_parsing_follows_the_registry_default() {
        assert_eq!(parse_format(&json!({})).unwrap(), Format::Pem);
        assert_eq!(
            parse_format(&json!({ "format": "" })).unwrap(),
            Format::Pem
        );
        assert_eq!(
            parse_format(&json!({ "format": "  " })).unwrap(),
            Format::Pem
        );
        assert_eq!(
            parse_format(&json!({ "format": "raw" })).unwrap(),
            Format::Raw
        );

        let err = parse_format(&json!({ "format": "putty" })).expect_err("未知格式必须报错");
        match &err {
            ToolError::InvalidKeyed { key, .. } => {
                assert_eq!(*key, "out.ed25519-key-pair-generator.err.unknown_format")
            }
            other => panic!("应当报 unknown_format，实际 {other:?}"),
        }
    }

    /// 表格的标题要跟着请求语言走 —— 英文界面不该出现中文行标题，
    /// 中文界面也不该出现英文行标题。
    #[test]
    fn the_row_labels_follow_the_request_language() {
        let key = "out.ed25519-key-pair-generator.private_key";
        let en = gen_with_lang(Format::Pem, None);
        let zh = gen_with_lang(Format::Pem, Some("zh-CN"));
        let en_table = en["table"].as_object().unwrap();
        let zh_table = zh["table"].as_object().unwrap();
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

    /// `meta` 里不该有密钥材料。
    #[test]
    fn meta_never_leaks_key_material() {
        let out = gen(Format::Pem);
        let private_pem = out["output"].as_str().unwrap();
        // 取 base64 正文里的一小段，确认它没出现在 meta 里
        let sample: String = private_pem
            .lines()
            .filter(|l| !l.starts_with("-----"))
            .collect::<String>()
            .chars()
            .take(24)
            .collect();
        assert!(!sample.is_empty());
        assert!(
            !out["meta"].to_string().contains(&sample),
            "meta 里不该有密钥内容"
        );
        assert_eq!(out["meta"]["algorithm"], "ed25519");
        assert_eq!(out["meta"]["format"], "pem");
    }

    /// 错误信息跟着请求语言走 —— 语言不是工具决定的，是 API 层按请求语言
    /// 调用 `localize` 渲染的。
    #[test]
    fn the_error_message_follows_the_requested_language() {
        let err = compute(json!({ "format": "putty" })).unwrap_err();
        // 语言包里还没并进来时，localize 退回键本身 —— 这时断言跳过
        if !crate::i18n::has("zh-CN", "out.ed25519-key-pair-generator.err.unknown_format") {
            return;
        }
        let en = err.localize("en");
        let zh = err.localize("zh-CN");
        assert_ne!(en, zh, "两种语言不该是同一句");
        assert!(
            !en.contains("out.ed25519-key-pair-generator"),
            "英文界面不该露出键：{en}"
        );
        // 占位符要真的被替换掉 —— 留着 `{format}` 给用户看等于没说
        assert!(en.contains("putty"), "错误信息里应当带上用户给的值：{en}");
        assert!(!en.contains("{format}"), "占位符没被替换：{en}");
    }

    /// 行的**标题**必须短 —— 表格的标题列是固定宽度的，
    /// 把一整句话塞进标题列，表格会被撑到卡片外面去。
    #[test]
    fn the_row_labels_are_short() {
        for format in [Format::Pem, Format::Raw] {
            let out = gen(format);
            let table = out["table"].as_object().unwrap();
            for k in table.keys() {
                // 语言包还没并进来时，取到的就是键名本身（`out.…`）——
                // 那是键不是标题，没法拿来量长度，跳过。
                if k.starts_with("out.") {
                    continue;
                }
                assert!(k.chars().count() <= 40, "行标题太长，会把表格撑破: {k}");
            }
        }
    }

    /// **外部参照**：`openssl` 能读我们给的 PEM。
    ///
    /// 单元测试只能验证「我写的东西符合我自己理解的结构」，
    /// 真正的判据是 **`openssl pkey -in key.pem -text -noout` 能读出同一把密钥**，
    /// 而且 **`openssl` 用我们的私钥签的报文能被我们的公钥验过**
    /// （反过来也一样）。
    ///
    /// 这个测试默认跳过：CI 的三个系统上 `openssl` 的版本不一样
    /// （macOS 上是 LibreSSL），Ed25519 的支持情况各不一致 ——
    /// 拿一个「本机有没有 openssl」当判据的测试会让 CI 变成「有时绿有时红」。
    /// 跑法：
    ///
    /// ```sh
    /// cargo test --offline --lib tools::ed25519_key_pair_generator -- --ignored --nocapture
    /// ```
    #[test]
    #[ignore = "需要外部的 openssl 对拍"]
    fn openssl_reads_our_pem_and_verifies_our_signature() {
        let out = gen(Format::Pem);
        let private_pem = out["output"].as_str().unwrap().to_string();
        let public_pem = out["table"][&label("out.ed25519-key-pair-generator.public_key")]
            .as_str()
            .unwrap()
            .to_string();

        let dir = temp_dir("ed25519");
        let key_path = dir.join("key.pem");
        let pub_path = dir.join("key.pub.pem");
        let msg_path = dir.join("msg.bin");
        let sig_path = dir.join("sig.bin");
        std::fs::write(&key_path, &private_pem).unwrap();
        std::fs::write(&pub_path, &public_pem).unwrap();
        std::fs::write(&msg_path, b"it-tools ed25519 openssl cross check").unwrap();

        // 1. openssl 读得了我们的私钥
        let (ok, text) = openssl(&["pkey", "-in", key_path.to_str().unwrap(), "-text", "-noout"]);
        assert!(ok, "openssl 读不了我们的私钥:\n{text}");
        assert!(text.contains("ED25519"), "{text}");

        // 2. openssl 读得了我们的公钥
        let (ok, text) = openssl(&[
            "pkey",
            "-pubin",
            "-in",
            pub_path.to_str().unwrap(),
            "-text",
            "-noout",
        ]);
        assert!(ok, "openssl 读不了我们的公钥:\n{text}");
        assert!(text.contains("ED25519"), "{text}");

        // 3. openssl 从私钥导出的公钥要与我们给的一致
        let derived_path = dir.join("derived.pub.pem");
        let (ok, text) = openssl(&[
            "pkey",
            "-in",
            key_path.to_str().unwrap(),
            "-pubout",
            "-out",
            derived_path.to_str().unwrap(),
        ]);
        assert!(ok, "openssl 导不出公钥:\n{text}");
        assert_eq!(
            std::fs::read_to_string(&derived_path).unwrap(),
            public_pem,
            "openssl 从私钥导出的公钥必须与我们给的一致"
        );

        // 4. openssl 签，我们验
        let (ok, text) = openssl(&[
            "pkeyutl",
            "-sign",
            "-inkey",
            key_path.to_str().unwrap(),
            "-rawin",
            "-in",
            msg_path.to_str().unwrap(),
            "-out",
            sig_path.to_str().unwrap(),
        ]);
        assert!(ok, "openssl 签不了:\n{text}");
        let signature = ed25519_dalek::Signature::from_slice(&std::fs::read(&sig_path).unwrap())
            .expect("openssl 的签名应当是 64 字节");
        let seed = seed_of(&private_pem);
        let signing = SigningKey::from_bytes(&seed.try_into().unwrap());
        let verifying = signing.verifying_key();
        verifying
            .verify_strict(b"it-tools ed25519 openssl cross check", &signature)
            .expect("openssl 签的应当能验过");

        // 5. 我们签，openssl 验
        let our_sig = signing.sign(b"it-tools ed25519 openssl cross check");
        let our_sig_path = dir.join("our-sig.bin");
        std::fs::write(&our_sig_path, our_sig.to_bytes()).unwrap();
        let (ok, text) = openssl(&[
            "pkeyutl",
            "-verify",
            "-pubin",
            "-inkey",
            pub_path.to_str().unwrap(),
            "-rawin",
            "-in",
            msg_path.to_str().unwrap(),
            "-sigfile",
            our_sig_path.to_str().unwrap(),
        ]);
        assert!(ok, "openssl 验不过我们的签名:\n{text}");

        std::fs::remove_dir_all(&dir).ok();
    }

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
