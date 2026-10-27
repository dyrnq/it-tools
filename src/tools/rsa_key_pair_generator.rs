//! RSA 密钥对生成（endpoint `rsa-key-pair-generator`）。
//!
//! 参考实现（node-forge）把 `pki.rsa.generateKeyPair` 丢进 Web Worker，理由和这里
//! 丢进 actix 的 blocking 线程池完全一样：**密钥生成是纯 CPU 且耗时随位长爆炸**。
//! 本机 release 构建实测：2048 位 0.24 秒、4096 位 2.5 秒、8192 位 6.5 秒、
//! 16384 位 **286 秒与 434 秒两次采样**（方差极大，取决于找质数的运气，调研报告里
//! 「10~60 秒」的估计偏乐观了一个数量级）。占用 worker 线程期间这个 worker 上所有
//! 请求都排队，所以 [`handle`] 走 [`util::blocking`] 而不是直接算 —— 注意 16384 位
//! 即使丢进了 blocking 池也仍然会占住一条线程五分钟起。
//!
//! ## 安全边界
//!
//! - 私钥在**服务端**生成：它短暂地存在于本进程的堆上（`RsaPrivateKey` 是
//!   `ZeroizeOnDrop`，`to_pkcs1_pem` 返回 `Zeroizing<String>`，两者析构都会清零
//!   缓冲区），随后经 HTTP 响应体发往浏览器。这条链路上它就是明文，只受 TLS
//!   保护；服务端不做任何补救，也不该做。
//! - 私钥**绝不落盘、不进缓存、不进日志、不进错误信息**（本文件所有 `map_err`
//!   都只带 `rsa::Error`，它不携带密钥材料）。参考实现同理，密钥只活在浏览器
//!   里；差别是我们没得选，只能诚实说明服务端也在内存里见过它。
//!
//! ## 输出格式
//!
//! 私钥用 **PKCS#1 v1.5**（tag `RSA PRIVATE KEY`），公钥用 **SPKI**（PKCS#8 的
//! 公钥形态，tag `PUBLIC KEY`）—— 这是 node-forge `pki.privateKeyToPem` /
//! `pki.publicKeyToPem` 的输出版本，`openssl`、浏览器 WebCrypto、绝大多数工具都
//! 只认这一对。参考实现的描述文案里写的是「public pem certificate」，但代码里
//! 从来没有构造 X.509 证书（没有 issuer、没有签名、没有序列号），所以这里也
//! **只发公钥本身**。
//!
//! 这一段是默认档（`pem`）。上游 PR #888 把它扩成了六种格式（外加口令与注释），
//! 这里的实现见 [`rsa_formats`]：多出来的几档是 OpenSSH 的两种私钥格式与
//! `ssh-rsa AAAA…` 那种 authorized_keys 用的公钥行。

use rand::rngs::OsRng;
use rsa::RsaPrivateKey;
use serde_json::{json, Map, Value};

use super::rsa_formats::{self, Format};
use super::{util, ToolError, ToolResult};

/// 注册表 `ApiSpec` 里 `bits` 下拉的全部取值。
///
/// 用白名单而不是 `util::bounded_u64` 的夹取：RSA 的上界是「几分钟」而不是
/// 「一个更大的合法值」，把 `999999` 悄悄夹成 16384 会让用户白等几分钟；
/// `bounded_u64` 的注释拿 RSA 举例只是说「别 panic」，不是说要夹取。
const ALLOWED_BITS: [usize; 4] = [2048, 4096, 8192, 16384];

/// 与 `ApiField { name: "bits", default: Some("2048") }` 保持一致。
const DEFAULT_BITS: usize = 2048;

/// 可选值的文案，错误信息与白名单共用一份。
const ALLOWED_HINT: &str = "2048 / 4096 / 8192 / 16384";

/// 输出格式的可选值文案 —— 错误信息与 [`Format::parse`] 的白名单共用一份。
const ALLOWED_FORMATS_HINT: &str = "pem / pkcs1 / pkcs8 / ssh / openssh";

/// 与 `ApiField { name: "output_format", default: Some("pem") }` 保持一致。
const DEFAULT_FORMAT: &str = "pem";

/// 解析并校验 `bits`。
///
/// 表单提交的是字符串（`FieldKind::Select`），直接 `curl` 过来的是 JSON number，
/// 两种都要认；缺字段 / `null` / 纯空白退回注册表默认值，与 [`util::str_or`] 的
/// 口径一致 —— `urlencoded` 提交时缺字段就是空串，那是「没填」而不是「填了
/// 一个非法值」。其余取值一律报错：位长同时决定了「这次请求会占住一条 blocking
/// 线程多久」，静默替换成默认值会让用户以为自己拿到了 16384 位。
fn parse_bits(payload: &Value) -> Result<usize, ToolError> {
    let raw = match payload.get("bits") {
        None | Some(Value::Null) => return Ok(DEFAULT_BITS),
        Some(Value::Number(n)) => n.to_string(),
        Some(Value::String(s)) => s.trim().to_owned(),
        // 数组 / 对象 / 布尔既不是「没填」也不是合法选项
        Some(_) => {
            return Err(ToolError::invalid(
                "out.rsa-key-pair-generator.err.bad_bits_type",
                &[],
            ))
        }
    };

    if raw.is_empty() {
        return Ok(DEFAULT_BITS);
    }

    // `usize::from_str` 拒绝 `2048abc`、`2048.0`、`0x800`、`256.0`，也拒绝负数 ——
    // 用户手改出来的这些值不该被当成合法位长；它会接受 `+2048`，那也只是同一个数。
    match raw.parse::<usize>() {
        Ok(bits) if ALLOWED_BITS.contains(&bits) => Ok(bits),
        _ => Err(invalid_bits(&raw)),
    }
}

/// 位长不在白名单里。文案在语言包里（`out.rsa-key-pair-generator.err.bad_bits`），
/// 用户填的值原样回显 —— 位长不是秘密，回显能让用户一眼看出自己填错了什么。
fn invalid_bits(raw: &str) -> ToolError {
    ToolError::invalid(
        "out.rsa-key-pair-generator.err.bad_bits",
        &[("bits", raw), ("allowed", ALLOWED_HINT)],
    )
}

/// 解析输出格式。缺字段 / 空串退回默认档（`pem`），未知取值报错。
///
/// 不用「未知就退回默认」：格式错了会让人拿到一把用不了的私钥，
/// 而报错只花一眼。
fn parse_format(payload: &Value) -> Result<Format, ToolError> {
    let raw = util::str_or(payload, "output_format", DEFAULT_FORMAT);
    Format::parse(raw).ok_or_else(|| {
        ToolError::invalid(
            "out.rsa-key-pair-generator.err.unknown_format",
            &[("format", raw), ("allowed", ALLOWED_FORMATS_HINT)],
        )
    })
}

/// 取口令。缺字段 / 空串 = 不加密。
///
/// 口令只在这一次请求的内存里活着：不落盘、不进日志、不进错误信息。
fn parse_passphrase(payload: &Value) -> Option<String> {
    util::opt_str(payload, "passphrase")
        .filter(|p| !p.is_empty())
        .map(str::to_owned)
}

/// 取注释（authorized_keys 那一行与 OpenSSH 私钥里都会带上它）。
fn parse_comment(payload: &Value) -> String {
    util::opt_str(payload, "comment")
        .unwrap_or("")
        .to_owned()
}

/// 响应里的 `meta`。
///
/// `app.js` 的 `render()` 不渲染 `meta`，所以这条超长耗时的提示只给 API 消费方
/// （curl / 脚本）看，不去挤 `table` —— 那几行是放密钥的，混进一句中文会让人
/// 复制密钥时顺手把它一起复制走。
///
/// 但它仍然是一句**给人看的话**：API 的调用方可能是英文环境，所以这句提示
/// 走语言包（`out.rsa-key-pair-generator.err.large_bits_note`）。
/// `meta` 里的其余字段是机器可读的（位数、格式名、时间戳），原样不动。
fn build_meta(bits: usize, format: Format, lang: &str) -> Value {
    let mut meta = json!({
        "bits": bits,
        "format": rsa_formats::format_name(format),
        "generatedAt": chrono::Utc::now().to_rfc3339(),
    });
    if bits > 8192 {
        let bits_text = bits.to_string();
        meta["note"] = json!(crate::i18n::t_args(
            lang,
            "out.rsa-key-pair-generator.err.large_bits_note",
            &[("bits", &bits_text)],
        ));
    }
    meta
}

/// 生成并编码一对密钥；入参必须已经过 [`parse_bits`] 与 [`parse_format`]。
///
/// 校验和生成拆成两步而不是一步，是因为单测要跑 512 位（dev profile 未优化，
/// 2048 位就要 2.6 秒），而 512 不在注册表的选项里 —— 测试直接调这一步。
///
/// `payload` 只用来取当前语言（行标题按语言走语言包），不参与密钥生成。
fn generate(
    payload: &Value,
    bits: usize,
    format: Format,
    passphrase: Option<&str>,
    comment: &str,
) -> ToolResult {
    // `OsRng` 是零大小类型，每次取随机数都直接落到操作系统熵源（Linux 上是
    // `getrandom(2)`，退化时走 `/dev/urandom`），既不缓存也不播种。它实现的是
    // `rand_core 0.6` 的 `RngCore + CryptoRng`，而 `rsa 0.9.10` 依赖的正是
    // `rand_core 0.6.4`（`rand 0.8` 也是），三者靠 rand_core 里的 blanket impl
    // `impl<T: CryptoRng + RngCore> CryptoRngCore for T` 合流，不需要任何版本桥接。
    //
    // 用 `RsaPrivateKey::new` 而不是任何并行变体：`rsa 0.9` 的
    // `algorithms::generate` 里没有 rayon 分支，它就是这个版本唯一的密钥生成入口。
    let mut rng = OsRng;
    let private_key = RsaPrivateKey::new(&mut rng, bits)
        .map_err(|e| ToolError::Internal(format!("RSA 私钥生成失败: {e}")))?;

    // 编码交给 `rsa_formats`：PEM / PKCS#1 / PKCS#8 / OpenSSH 两种，
    // 口令与注释也在那里处理。
    let encoded = rsa_formats::encode(format, &private_key, passphrase, comment)?;

    let private_key_text = encoded.private_key;
    let public_key_text = encoded.public_key;

    // 结果表里**给人看的字**只有行标题，值全是机器可读的（PEM、位长数字、
    // 格式名）—— 行标题按当前语言取，值原样保留。
    let mut table = Map::new();
    util::row(
        &mut table,
        payload,
        "out.rsa-key-pair-generator.private_key",
        json!(private_key_text),
    );
    util::row(
        &mut table,
        payload,
        "out.rsa-key-pair-generator.public_key",
        json!(public_key_text),
    );
    util::row(
        &mut table,
        payload,
        "out.rsa-key-pair-generator.bits",
        json!(bits),
    );
    util::row(
        &mut table,
        payload,
        "out.rsa-key-pair-generator.format",
        json!(rsa_formats::format_name(format)),
    );

    let mut meta = build_meta(bits, format, util::lang(payload));
    // 公钥再单独放一份到 meta 里：结果区要按原版的形状排 ——
    // 「<h3>Public key</h3> + 一张代码卡」和「<h3>Private key</h3> + 另一张」。
    // table 里的键名是按语言包取的（中文界面里键名是「公钥」），
    // 前端拿不到稳定的键名，只能走 meta 这条固定的路。
    meta["public_key"] = json!(public_key_text);

    Ok(json!({
        "output": private_key_text,
        "table": table,
        "meta": meta,
    }))
}

/// 见 [`util::blocking`]。
pub async fn handle(payload: Value) -> ToolResult {
    util::blocking(move || compute(payload)).await
}

fn compute(payload: Value) -> ToolResult {
    let bits = parse_bits(&payload)?;
    let format = parse_format(&payload)?;
    let passphrase = parse_passphrase(&payload);
    let comment = parse_comment(&payload);
    generate(&payload, bits, format, passphrase.as_deref(), &comment)
}

#[cfg(test)]
mod tests {
    use super::*;
    use rsa::pkcs1::DecodeRsaPrivateKey;
    use rsa::pkcs8::{DecodePublicKey, EncodePublicKey, LineEnding};
    use rsa::traits::PublicKeyParts;
    use rsa::RsaPublicKey;

    /// 单测只生成 512 位：dev profile 未优化时 2048 位就要 2.6 秒，16384 位是
    /// 分钟级。大位长只测校验与 meta 分支，绝不生成。
    const TEST_BITS: usize = 512;

    /// 结果表的行标题是按语言包取的，断言时按同样的方式取标题 ——
    /// 把标题的字面量抄一遍的话，改一次文案就要改一次断言。
    fn label(key: &str) -> String {
        crate::i18n::t(crate::i18n::FALLBACK, key)
    }

    /// 生成一把密钥；`lang` 给 `None` 就是不带 `__lang`（走英文兜底）。
    fn gen_with_lang(bits: usize, lang: Option<&str>) -> Value {
        let payload = match lang {
            Some(l) => json!({ util::LANG_KEY: l }),
            None => json!({}),
        };
        generate(&payload, bits, Format::Pem, None, "").expect("密钥生成不该失败")
    }

    fn gen(bits: usize) -> Value {
        gen_with_lang(bits, None)
    }

    #[test]
    fn pem_headers_are_pkcs1_private_and_spki_public() {
        let out = gen(TEST_BITS);

        let private_pem = out["output"].as_str().unwrap();
        assert!(
            private_pem.starts_with("-----BEGIN RSA PRIVATE KEY-----"),
            "{private_pem}"
        );
        assert!(
            private_pem
                .trim_end()
                .ends_with("-----END RSA PRIVATE KEY-----"),
            "{private_pem}"
        );

        let public_pem = out["table"][&label("out.rsa-key-pair-generator.public_key")]
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

        // `output` 与 table 里的私钥是同一份，别哪天两边接错了
        assert_eq!(
            out["table"][&label("out.rsa-key-pair-generator.private_key")],
            out["output"]
        );
    }

    /// 真正的断言：只比对 PEM 前缀的话，一个「私钥和公钥各生成一次、互不相干」
    /// 的实现也能通过。必须把私钥解回来、重新导出公钥，看是否与输出逐字节相同。
    #[test]
    fn public_key_is_derived_from_the_private_key() {
        let out = gen(TEST_BITS);
        let private_pem = out["output"].as_str().unwrap();
        let public_pem = out["table"][&label("out.rsa-key-pair-generator.public_key")]
            .as_str()
            .unwrap();

        let parsed = RsaPrivateKey::from_pkcs1_pem(private_pem).expect("私钥应能被解回来");
        let derived = parsed
            .to_public_key()
            .to_public_key_pem(LineEnding::LF)
            .unwrap();
        assert_eq!(derived, public_pem, "公钥必须由私钥导出");

        // 反向也要成立：公钥 PEM 本身能被独立解析，且 n / e 与私钥一致
        let parsed_public =
            RsaPublicKey::from_public_key_pem(public_pem).expect("公钥应能被解回来");
        assert_eq!(parsed_public.n(), parsed.n());
        assert_eq!(parsed_public.e(), parsed.e());
        assert_eq!(parsed_public.size(), TEST_BITS / 8);
    }

    #[test]
    fn two_generations_differ() {
        let a = gen(TEST_BITS);
        let b = gen(TEST_BITS);
        assert_ne!(a["output"], b["output"], "同一位长连续生成必须得到不同密钥");
        let public_key = label("out.rsa-key-pair-generator.public_key");
        assert_ne!(
            a["table"][&public_key], b["table"][&public_key],
            "公钥也跟着变才说明私钥真的换了"
        );
    }

    /// 表格的标题要跟着请求语言走 —— 英文界面不该出现中文行标题，
    /// 中文界面也不该出现英文行标题。
    #[test]
    fn the_row_labels_follow_the_request_language() {
        let key = "out.rsa-key-pair-generator.private_key";
        let en = gen_with_lang(TEST_BITS, None);
        let zh = gen_with_lang(TEST_BITS, Some("zh-CN"));
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

    #[test]
    fn modulus_bit_length_equals_the_request() {
        for bits in [512usize, 1024] {
            let payload = json!({});
            let out = generate(&payload, bits, Format::Pem, None, "").unwrap();
            let private_pem = out["output"].as_str().unwrap();
            let parsed = RsaPrivateKey::from_pkcs1_pem(private_pem).unwrap();
            assert_eq!(
                parsed.n().bits(),
                bits,
                "{bits} 位密钥的模数应当正好 {bits} 位"
            );
            assert_eq!(out["meta"]["bits"], bits);
            assert_eq!(out["table"][&label("out.rsa-key-pair-generator.bits")], bits);
        }
    }

    /// 4096 / 8192 / 16384 只测「能不能被接受」，绝不真的生成。
    #[test]
    fn large_sizes_are_validated_but_never_generated() {
        for bits in ALLOWED_BITS {
            let raw = bits.to_string();
            assert_eq!(parse_bits(&json!({ "bits": raw })).unwrap(), bits);
        }

        // 表单之外还要认 JSON number 与前后空白
        assert_eq!(parse_bits(&json!({ "bits": 8192 })).unwrap(), 8192);
        assert_eq!(parse_bits(&json!({ "bits": " 4096 " })).unwrap(), 4096);

        // 缺字段 / 空串 / 纯空白 / null 一律退回注册表默认值，而不是报错
        assert_eq!(parse_bits(&json!({})).unwrap(), DEFAULT_BITS);
        assert_eq!(parse_bits(&json!({ "bits": "" })).unwrap(), DEFAULT_BITS);
        assert_eq!(parse_bits(&json!({ "bits": "   " })).unwrap(), DEFAULT_BITS);
        assert_eq!(parse_bits(&json!({ "bits": null })).unwrap(), DEFAULT_BITS);
    }

    #[test]
    fn unsupported_sizes_are_rejected_without_panicking() {
        for bad in [
            "512", "1024", "0", "-2048", "abc", "2048abc", "2048.0", "0x800", "2049", "256",
            "16385", "2 048", "２048", "1e4",
        ] {
            let err = compute(json!({ "bits": bad })).expect_err("白名单外的取值必须报错");
            match &err {
                ToolError::InvalidKeyed { key, .. } => {
                    assert_eq!(*key, "out.rsa-key-pair-generator.err.bad_bits", "{bad}")
                }
                other => panic!("应当报 bad_bits，实际 {other:?}"),
            }
        }

        // 类型不对也报错，且是在生成之前就报错（不会白等几秒）
        for bad in [json!(true), json!([2048]), json!({ "n": 2048 })] {
            match compute(json!({ "bits": bad })) {
                Err(ToolError::InvalidKeyed { key, .. }) => assert_eq!(
                    key,
                    "out.rsa-key-pair-generator.err.bad_bits_type",
                    "{bad}"
                ),
                other => panic!("应当报 bad_bits_type，实际 {other:?}"),
            }
        }
    }

    /// 格式的解析：缺字段 / 空串退回默认档，未知取值报错。
    #[test]
    fn format_parsing_follows_the_same_rules_as_bits() {
        assert_eq!(parse_format(&json!({})).unwrap(), Format::Pem);
        assert_eq!(
            parse_format(&json!({ "output_format": "" })).unwrap(),
            Format::Pem
        );
        assert_eq!(
            parse_format(&json!({ "output_format": "openssh" })).unwrap(),
            Format::OpenSsh
        );

        let err = parse_format(&json!({ "output_format": "putty" })).expect_err("未知格式必须报错");
        match &err {
            ToolError::InvalidKeyed { key, .. } => {
                assert_eq!(*key, "out.rsa-key-pair-generator.err.unknown_format")
            }
            other => panic!("应当报 unknown_format，实际 {other:?}"),
        }
    }

    /// 口令：空串等于没给（不是「用空口令加密」）。
    #[test]
    fn an_empty_passphrase_means_no_passphrase() {
        assert_eq!(parse_passphrase(&json!({})), None);
        assert_eq!(parse_passphrase(&json!({ "passphrase": "" })), None);
        assert_eq!(
            parse_passphrase(&json!({ "passphrase": "secret" })),
            Some("secret".to_owned())
        );
    }

    /// 五种格式都要能跑通，产出的私钥与公钥都是非空的。
    #[test]
    fn every_format_produces_a_key_pair() {
        for (name, format) in [
            ("pem", Format::Pem),
            ("pkcs1", Format::Pkcs1),
            ("pkcs8", Format::Pkcs8),
            ("ssh", Format::Ssh),
            ("openssh", Format::OpenSsh),
        ] {
            let payload = json!({});
            let out = generate(&payload, TEST_BITS, format, None, "me@example.com").unwrap();
            let private_key = out["output"].as_str().unwrap();
            let public_key = out["table"][&label("out.rsa-key-pair-generator.public_key")]
                .as_str()
                .unwrap();
            assert!(!private_key.is_empty(), "{name}");
            assert!(!public_key.is_empty(), "{name}");
            assert_eq!(out["table"][&label("out.rsa-key-pair-generator.format")], name);
            assert_eq!(out["meta"]["format"], name);
        }
    }

    /// 给了口令但格式不支持时要报错 —— 悄悄忽略口令等于给出一把明文私钥。
    #[test]
    fn an_unsupported_passphrase_is_rejected_instead_of_ignored() {
        let err = compute(json!({ "output_format": "pkcs8", "passphrase": "secret" }))
            .expect_err("pkcs8 不支持口令加密");
        match &err {
            ToolError::InvalidKeyed { key, .. } => assert_eq!(
                *key,
                "out.rsa-key-pair-generator.err.format_no_passphrase"
            ),
            other => panic!("应当报 format_no_passphrase，实际 {other:?}"),
        }
    }

    /// 错误信息跟着请求语言走 —— 语言不是工具决定的，是 API 层按请求语言
    /// 调用 `localize` 渲染的。
    #[test]
    fn the_error_message_follows_the_requested_language() {
        let err = compute(json!({ "bits": "1024" })).unwrap_err();
        // 语言包里还没并进来时，localize 退回键本身 —— 这时断言跳过
        if !crate::i18n::has("zh-CN", "out.rsa-key-pair-generator.err.bad_bits") {
            return;
        }
        let en = err.localize("en");
        let zh = err.localize("zh-CN");
        assert_ne!(en, zh, "两种语言不该是同一句");
        assert!(
            !en.contains("out.rsa-key-pair-generator"),
            "英文界面不该露出键：{en}"
        );
    }

    /// 口令加密后的私钥不该再是明文：正文里不能直接看到 PKCS#1 的 DER 头。
    #[test]
    fn an_encrypted_private_key_is_not_readable_without_the_passphrase() {
        let out = compute(json!({ "format": "pem", "passphrase": "secret" })).unwrap();
        let private_pem = out["output"].as_str().unwrap();
        assert!(private_pem.contains("Proc-Type: 4,ENCRYPTED"), "{private_pem}");
        assert!(private_pem.contains("DEK-Info: AES-128-CBC,"), "{private_pem}");
        // 没有口令时解不开：DER 的头几个字节（0x30 0x82）不该出现在明文里
        let body: String = private_pem
            .lines()
            .filter(|l| !l.starts_with("-----") && !l.contains(":"))
            .collect();
        assert!(!body.contains("MIG"), "正文里不该出现明文 DER 的痕迹");
    }

    #[test]
    fn meta_warns_only_for_slow_sizes() {
        assert!(build_meta(2048, Format::Pem, "en").get("note").is_none());
        assert!(build_meta(8192, Format::Pem, "en").get("note").is_none());
        assert_eq!(build_meta(16384, Format::Pem, "en")["bits"], 16384);
        let note = build_meta(16384, Format::Pem, "zh-CN")["note"]
            .as_str()
            .unwrap()
            .to_string();
        // 那句耗时提示走语言包：语言包还没并进来时取到的就是键本身，
        // 并进来之后下面这两条才会真的跑。
        if crate::i18n::has("zh-CN", "out.rsa-key-pair-generator.err.large_bits_note") {
            assert!(note.contains("分钟"), "16384 位必须给出耗时提示: {note}");
            assert!(note.contains("16384"), "提示里要带上实际位长: {note}");
        }

        // RFC3339，`app.js` 不渲染 meta，但 API 消费方要能解析
        let meta = build_meta(2048, Format::Pem, "en");
        let generated_at = meta["generatedAt"].as_str().unwrap();
        assert!(chrono::DateTime::parse_from_rfc3339(generated_at).is_ok());
    }

    /// `meta.note` 是给 API 消费方看的一句**人话**，所以它也得跟着语言走 ——
    /// 英文环境不该收到一句中文。
    #[test]
    fn the_slow_generation_note_follows_the_request_language() {
        let key = "out.rsa-key-pair-generator.err.large_bits_note";
        if !crate::i18n::has("zh-CN", key) {
            return;
        }
        let en = build_meta(16384, Format::Pem, "en")["note"]
            .as_str()
            .unwrap()
            .to_string();
        let zh = build_meta(16384, Format::Pem, "zh-CN")["note"]
            .as_str()
            .unwrap()
            .to_string();
        assert_ne!(en, zh, "两种语言不该是同一句");
        assert!(!en.contains("分钟"), "英文界面不该露出中文: {en}");
        assert!(en.contains("16384"), "{en}");
    }

    #[test]
    fn meta_never_leaks_key_material() {
        let out = gen(TEST_BITS);
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
    }
}
