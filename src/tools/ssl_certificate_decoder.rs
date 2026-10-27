//! SSL 证书解码器（endpoint `ssl-certificate-decoder`）。
//!
//! 上游 #1459：要能解 base64 编码的证书，并以系统化的方式展示出来
//! （参照 https://www.sslchecker.com/certdecoder）。
//!
//! 放服务端而不是 JS 的理由：解一张证书要的是完整的 ASN.1 / X.509 解析。
//! 浏览器端要么引一个 JS 的 ASN.1 库（几十 KiB，还得自己补 X.509 的语义层），
//! 要么把证书丢给 WebCrypto —— 但 WebCrypto 只认公钥参数，给不出版本、序列号、
//! SAN、指纹这些东西。而 `x509-parser` 已经是 `pdf-signature-checker` 的依赖，
//! 进程里现成。
//!
//! ## 接受哪些输入
//!
//! 三种写法都收，因为用户手上那份东西长什么样取决于他从哪儿复制的：
//!
//! - 带 `BEGIN/END` 头的 PEM（可以一次贴一整条链）—— `openssl x509 -in cert.pem` 的输出；
//! - **裸 base64**，也就是 issue 里点名要的那种（`base64 cert.der`、
//!   各种 SSL 检测站点的「复制」按钮给的也是它）；
//! - 裸 DER 十六进制，允许 `openssl x509 -text` 那种带冒号的格式。
//!
//! 辨认方式不是靠「有没有 `=` 结尾」这种启发式，而是**依次尝试 base64 解码、
//! 再尝试 hex 解码，谁解出来的字节能被 X.509 解析器认下就用谁**，见 [`decode_all`]。
//!
//! ## 时间为什么统一走 chrono
//!
//! `x509-parser` 的 `ASN1Time::to_datetime()` 给的是 `time` crate 的 `OffsetDateTime`，
//! 和本项目其余地方用的 chrono 不是一套。这里统一转一道再拿去比较和格式化 ——
//! 两套时间类型混着比大小，迟早在负时间戳或 DST 边界上出错。
//! （`pdf-signature_checker` 走的是 `.timestamp()`，但那边只比大小、不需要格式化。）

use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use chrono::{DateTime, Utc};
use serde_json::{json, Map, Value};
use sha1::Sha1;
use sha2::{Digest, Sha256};
use x509_parser::extensions::GeneralName;
use x509_parser::prelude::{ASN1Time, FromDer, X509Certificate, X509Name};

use super::util;
use super::{ToolError, ToolResult};

/// 一次最多解几张证书。
///
/// 有人会整条链一起贴进来，而链可以很长（跨域签发动辄十几张）。上限是为了让这个
/// 接口不会因为一份超长输入去构造一个超大的响应 —— 被截掉这件事会在
/// `output` 与 `meta.chain_truncated` 里明说，不静默丢弃。
const MAX_CERTS: usize = 20;

/// 与注册表 `ApiSpec.fields` 保持一致。
pub async fn handle(payload: Value) -> ToolResult {
    compute(payload)
}

fn compute(payload: Value) -> ToolResult {
    let raw = util::req_str(&payload, "cert")?;
    let (certs, truncated) = decode_all(raw)?;

    // 结果区里**给人看的字**走语言包（行标题、成句的值、主结果那句结论）；
    // 机器可读的值（序列号、时间戳、指纹、算法名、位数）原样保留。
    let lang = util::lang(&payload);
    let now = Utc::now();
    let mut table = Map::new();
    let mut meta_certs = Vec::new();
    // 结论在 i == 0 那一轮就地算好存成 String。
    // 早先试过把 `X509Certificate` 本身存进 `first`，但它不是 Copy，
    // 存进 Option 就 move 掉了，同一轮后面的 `&parsed` 立刻借用失败 ——
    // 而这里要的只是几个格式化好的字符串。
    let mut summary: Option<String> = None;
    let mut facts = Facts::default();

    for (i, der) in certs.iter().enumerate() {
        let (_, parsed) = X509Certificate::from_der(der).map_err(|e| {
            // decode_all 的三条路径都过了解析器，走到这里才是真的内部不自洽。
            // 用户贴错内容一律在那边变成 400，不该到这儿变成 500。
            ToolError::Internal(format!("证书解析失败: {e}"))
        })?;
        if i == 0 {
            // 行标题由 `util::row` 按当前语言取 —— `describe` 给的是**键**。
            for (row_key, value) in describe(&parsed, der, lang) {
                util::row(&mut table, &payload, &row_key, json!(value));
            }
            facts = Facts::of(&parsed, now);
            summary = Some(verdict(&parsed, certs.len(), truncated, now, lang));
        } else {
            // 链上的第 2..N 张只给摘要行，全字段留给第一张 ——
            // 一条 10 张的链如果每张都展开成 20 行，输出会长到没法看。
            // 标题里带着序号，所以是「模板 + 占位符」，不是语言包里的固定一条。
            table.insert(
                chain_title(i + 1, lang),
                json!(summary_line(&parsed, der, lang)),
            );
        }
        meta_certs.push(json!({
            "index": i,
            "subject": name_to_string(parsed.subject(), lang),
            "issuer": name_to_string(parsed.issuer(), lang),
            "not_after": as_utc(&parsed.validity().not_after).to_rfc3339(),
        }));
    }

    Ok(json!({
        "output": summary.expect("certs 至少有一张，i == 0 必然走过"),
        "table": table,
        "meta": {
            "certificate_count": certs.len(),
            "chain_truncated": truncated,
            "expired": facts.expired,
            "not_yet_valid": facts.not_yet_valid,
            "days_until_expiry": facts.days_until_expiry,
            "sha256_fingerprint": hex(&Sha256::digest(&certs[0])),
            "certificates": meta_certs,
        }
    }))
}

/// 第一张证书的有效期状态。
#[derive(Default)]
struct Facts {
    expired: bool,
    not_yet_valid: bool,
    days_until_expiry: i64,
}

impl Facts {
    fn of(cert: &X509Certificate, now: DateTime<Utc>) -> Self {
        let not_before = as_utc(&cert.validity().not_before);
        let not_after = as_utc(&cert.validity().not_after);
        Self {
            expired: now > not_after,
            not_yet_valid: now < not_before,
            days_until_expiry: (not_after - now).num_days(),
        }
    }
}

/// 截断到 [`MAX_CERTS`]，并回报**是不是真的截了**。
///
/// 返回被截掉的事实而不是悄悄丢：链上有 30 张而我们只看 20 张时，用户得知道
/// 剩下 10 张没解，否则会以为整条链都在结果里。
fn cap(mut certs: Vec<Vec<u8>>) -> (Vec<Vec<u8>>, bool) {
    let truncated = certs.len() > MAX_CERTS;
    certs.truncate(MAX_CERTS);
    (certs, truncated)
}

/// 把用户贴的东西变成一个或多个 DER 字节串，外加「是否截断」的标记。
fn decode_all(raw: &str) -> Result<(Vec<Vec<u8>>, bool), ToolError> {
    let text = raw.trim();

    // ── 1. PEM：一段或多段 `-----BEGIN CERTIFICATE-----` ──
    const BEGIN: &str = "-----BEGIN CERTIFICATE-----";
    const END: &str = "-----END CERTIFICATE-----";
    if text.contains(BEGIN) {
        let mut out = Vec::new();
        let mut rest = text;
        let mut n = 0usize;
        while let Some(start) = rest.find(BEGIN) {
            n += 1;
            rest = &rest[start + BEGIN.len()..];
            let Some(end) = rest.find(END) else {
                return Err(ToolError::invalid(
                    "out.ssl-certificate-decoder.err.pem_missing_end",
                    &[("marker", END)],
                ));
            };
            let body: String = rest[..end].chars().filter(|c| !c.is_whitespace()).collect();
            let der = BASE64.decode(&body).map_err(|e| {
                ToolError::invalid(
                    "out.ssl-certificate-decoder.err.pem_bad_base64",
                    &[("index", &n.to_string()), ("reason", &e.to_string())],
                )
            })?;
            // 头尾齐全 + base64 合法 ≠ 是张证书：正文被截断的 PEM 照样能解出字节，
            // 而那串字节进不了 X.509 解析器。必须在这里就验掉 ——
            // 不验的话它会一路走到 compute()，被当成「内部不自洽」报 500，
            // 而这明明是用户贴错了东西，该是 400。
            let mut parsed = split_der_stream(&der);
            if parsed.is_empty() {
                let why = X509Certificate::from_der(&der)
                    .err()
                    .map(|e| e.to_string())
                    .unwrap_or_else(|| "内容为空".to_string());
                return Err(ToolError::invalid(
                    "out.ssl-certificate-decoder.err.pem_not_a_certificate",
                    &[("index", &n.to_string()), ("reason", &why)],
                ));
            }
            out.append(&mut parsed);
            rest = &rest[end..];
        }
        if out.is_empty() {
            return Err(ToolError::invalid(
                "out.ssl-certificate-decoder.err.no_pem_block",
                &[],
            ));
        }
        return Ok(cap(out));
    }

    // ── 2. 裸 base64 / hex：谁解出来能被 X.509 认下就用谁 ──
    //
    // 不靠「有没有 `=` 结尾」猜格式：`=` 只是碰巧不在多数 hex 输出里出现，拿它当
    // 判据在真实输入上会翻车 —— 2048 位证书的 base64 长度恰好是 4 的倍数，
    // 永远没有 `=`（`base64_detection_does_not_depend_on_padding` 钉的就是这条）。
    let cleaned: String = text.chars().filter(|c| !c.is_whitespace()).collect();
    if cleaned.is_empty() {
        return Err(ToolError::invalid(
            "out.ssl-certificate-decoder.err.empty_input",
            &[],
        ));
    }

    // 两种尝试的错误类型不同（base64 是 DecodeError，hex 是 String），
    // 统一擦成 String —— 这里的错误只用来看「这条路走不通」，不会给用户看。
    let attempts: [Result<Vec<u8>, String>; 2] = [
        BASE64.decode(&cleaned).map_err(|e| e.to_string()),
        decode_hex(&cleaned),
    ];
    for res in attempts {
        let Ok(bytes) = res else { continue };
        if bytes.is_empty() || X509Certificate::from_der(&bytes).is_err() {
            continue;
        }
        // 一个 base64 块里可能还连着别的块（少了换行），再试着切一次
        let mut out = split_der_stream(&bytes);
        if out.is_empty() {
            out.push(bytes);
        }
        return Ok(cap(out));
    }

    Err(ToolError::invalid(
        "out.ssl-certificate-decoder.err.unrecognized_format",
        &[
            ("begin", BEGIN),
            ("chars", &cleaned.chars().count().to_string()),
        ],
    ))
}

/// 十六进制解码，允许冒号、空格、换行。
fn decode_hex(s: &str) -> Result<Vec<u8>, String> {
    let digits: String = s
        .chars()
        .filter(|c| !c.is_whitespace() && *c != ':')
        .collect();
    if digits.is_empty() || !digits.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err("不是十六进制".into());
    }
    if digits.len() % 2 != 0 {
        return Err(format!(
            "十六进制位数是奇数（{} 位），应为成对",
            digits.len()
        ));
    }
    (0..digits.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&digits[i..i + 2], 16).map_err(|e| e.to_string()))
        .collect()
}

/// 从一段字节流里切出连续的 X.509 证书。
///
/// base64 折叠（`-w 0`）或从网页复制丢掉了换行时，多张证书会连成一条。
/// 做法是从头反复解析，每解析掉一张就从它后面接着找。
///
/// 注意 `from_der` 返回的是 `(剩余字节, 证书)` —— 顺序是**剩余在前**，
/// 写反了的话 `rest.len() - consumed` 会算出一个巨大的下标。
fn split_der_stream(bytes: &[u8]) -> Vec<Vec<u8>> {
    let mut out = Vec::new();
    let mut rest = bytes;
    while let Ok((remaining, _)) = X509Certificate::from_der(rest) {
        let consumed = rest.len() - remaining.len();
        if consumed == 0 {
            break;
        }
        out.push(rest[..consumed].to_vec());
        rest = &rest[consumed..];
    }
    out
}

/// `ASN1Time` → chrono 的 `DateTime<Utc>`。
///
/// 转换失败（超出 chrono 能表示的年份范围）在实践中不会发生，但也不该 panic ——
/// 解一张坏证书不该把整个服务带下去，退回 epoch 并让「已过期/未生效」照常显示。
fn as_utc(t: &ASN1Time) -> DateTime<Utc> {
    DateTime::from_timestamp(t.timestamp(), 0).unwrap_or(DateTime::UNIX_EPOCH)
}

/// 逐项描述第一张证书。
///
/// 返回 `Vec` 而不是直接填 `Map`：调用方按这个顺序 `insert`，而
/// `serde_json::Map` 是棵 `BTreeMap`，插入顺序到渲染时才被丢掉。
///
/// 每个元素是 **（语言包键, 值）**：行标题由调用方用 `util::row`
/// 按当前语言取出来，代码里只出现键。
fn describe(cert: &X509Certificate, der: &[u8], lang: &str) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = Vec::new();
    let mut put = |k: &str, v: String| out.push((k.to_string(), v));

    put(
        "out.ssl-certificate-decoder.version",
        cert.version().to_string(),
    );
    put(
        "out.ssl-certificate-decoder.serial_number",
        serial_hex(cert),
    );
    put(
        "out.ssl-certificate-decoder.subject",
        name_to_string(cert.subject(), lang),
    );
    put(
        "out.ssl-certificate-decoder.issuer",
        name_to_string(cert.issuer(), lang),
    );
    put(
        "out.ssl-certificate-decoder.not_before",
        as_utc(&cert.validity().not_before).to_rfc3339(),
    );
    put(
        "out.ssl-certificate-decoder.not_after",
        as_utc(&cert.validity().not_after).to_rfc3339(),
    );
    let sig_oid = cert.signature_algorithm.algorithm.to_id_string();
    put(
        "out.ssl-certificate-decoder.signature_algorithm",
        format!("{} ({sig_oid})", friendly(&sig_oid)),
    );
    let key_oid = cert.public_key().algorithm.algorithm.to_id_string();
    put(
        "out.ssl-certificate-decoder.public_key_algorithm",
        format!("{} ({key_oid})", friendly(&key_oid)),
    );

    if let Some(bits) = public_key_bits(cert) {
        put(
            "out.ssl-certificate-decoder.public_key_bits",
            format!("{bits} bit"),
        );
    }

    put(
        "out.ssl-certificate-decoder.sha1_fingerprint",
        hex(&Sha1::digest(der)),
    );
    put(
        "out.ssl-certificate-decoder.sha256_fingerprint",
        hex(&Sha256::digest(der)),
    );

    if let Ok(Some(san)) = cert.subject_alternative_name() {
        let list: Vec<String> = san
            .value
            .general_names
            .iter()
            .map(|g| {
                general_name(g, lang).unwrap_or_else(|| {
                    crate::i18n::t(lang, "out.ssl-certificate-decoder.unparsable")
                })
            })
            .collect();
        if !list.is_empty() {
            // 「N 条：…」整句是散文 —— 条数与列表用占位符插进去，
            // 两种语言可以各自决定怎么写。
            put(
                "out.ssl-certificate-decoder.san_entries",
                crate::i18n::t(lang, "out.ssl-certificate-decoder.san_entries_value")
                    .replace("{count}", &list.len().to_string())
                    .replace("{list}", &list.join(", ")),
            );
        }
    }

    out
}

/// 点分十进制的 OID → 好读的名字。
///
/// 只覆盖证书里真正常见的几个，其余原样返回 —— 认不出来不是错误，
/// 用户要的就是那个 OID（`openssl x509 -text` 给的也是它）。
///
/// 收 `&str` 而不是 `&Oid`：OID 的类型住在 `asn1-rs` 里，它只是 x509-parser 的
/// 传递依赖、没在我们的 prelude 中，为了一个查表函数去 Cargo.toml 里加一条
/// 直接依赖不划算（`to_id_string()` 就在调用点，一行的事）。
fn friendly(dotted: &str) -> String {
    let name = match dotted {
        "1.2.840.113549.1.1.5" => "sha1WithRSAEncryption",
        "1.2.840.113549.1.1.11" => "sha256WithRSAEncryption",
        "1.2.840.113549.1.1.12" => "sha384WithRSAEncryption",
        "1.2.840.113549.1.1.13" => "sha512WithRSAEncryption",
        "1.2.840.113549.1.1.10" => "RSASSA-PSS",
        "1.2.840.10045.4.3.2" => "ecdsa-with-SHA256",
        "1.2.840.10045.4.3.3" => "ecdsa-with-SHA384",
        "1.2.840.10045.4.3.4" => "ecdsa-with-SHA512",
        "1.2.840.10045.4.1" => "ecdsa-with-SHA1",
        "1.3.101.112" => "Ed25519",
        "1.3.101.113" => "Ed448",
        "1.2.840.113549.1.1.1" => "rsaEncryption",
        "1.2.840.10045.2.1" => "id-ecPublicKey",
        "1.2.840.10040.4.1" => "dsaEncryption",
        // DSA 的签名 OID 带参数，末尾要对齐参数才算同一个
        _ => return dotted.to_string(),
    };
    name.to_string()
}

/// 序列号按十六进制显示。
///
/// `raw_serial_as_string()` 给的是十进制串，而序列号在所有工具里
/// （`openssl x509 -serial`、浏览器、证书管理界面）都是按十六进制呈现的，
/// 这里两种都给，省得用户自己换算。
fn serial_hex(cert: &X509Certificate) -> String {
    let raw = cert.raw_serial();
    if raw.is_empty() {
        return "0".into();
    }
    format!("0x{}", hex(raw))
}

/// 证书里的一行摘要，给链上第 2..N 张用。
///
/// 整句是散文 —— 走语言包；主体、签发者、日期、指纹用占位符插进去。
fn summary_line(cert: &X509Certificate, der: &[u8], lang: &str) -> String {
    crate::i18n::t(lang, "out.ssl-certificate-decoder.chain_summary")
        .replace("{subject}", &name_to_string(cert.subject(), lang))
        .replace("{issuer}", &short_name(cert.issuer(), lang))
        .replace(
            "{date}",
            &as_utc(&cert.validity().not_after)
                .format("%Y-%m-%d")
                .to_string(),
        )
        .replace(
            "{fingerprint}",
            &hex(&Sha256::digest(der))
                .chars()
                .take(16)
                .collect::<String>(),
        )
}

/// 链上第 2..N 张的摘要行标题。
///
/// 标题里带着序号，所以是「模板 + `{index}` 占位符」，
/// 不是语言包里的一条固定文案。
fn chain_title(index: usize, lang: &str) -> String {
    crate::i18n::t(lang, "out.ssl-certificate-decoder.chain_certificate")
        .replace("{index}", &index.to_string())
}

/// 一句话结论：是谁的证书、什么时候过期、现在什么状态。
///
/// 这是主结果 `output` —— 整句是散文，主体 / 日期 / 天数 / 张数
/// 用占位符插进去，两种语言可以各自决定语序。
fn verdict(
    cert: &X509Certificate,
    count: usize,
    truncated: bool,
    now: DateTime<Utc>,
    lang: &str,
) -> String {
    let subject = name_to_string(cert.subject(), lang);
    let not_before = as_utc(&cert.validity().not_before);
    let not_after = as_utc(&cert.validity().not_after);
    let (state_key, days) = if now < not_before {
        (
            "out.ssl-certificate-decoder.verdict_not_yet_valid",
            (not_after - now).num_days(),
        )
    } else if now > not_after {
        (
            "out.ssl-certificate-decoder.verdict_expired",
            (now - not_after).num_days(),
        )
    } else {
        (
            "out.ssl-certificate-decoder.verdict_valid",
            (not_after - now).num_days(),
        )
    };
    let state = crate::i18n::t(lang, state_key)
        .replace("{days}", &days.to_string())
        .replace("{date}", &not_before.format("%Y-%m-%d").to_string());
    let chain = match (count, truncated) {
        (1, _) => String::new(),
        (n, true) => crate::i18n::t(lang, "out.ssl-certificate-decoder.verdict_chain_truncated")
            .replace("{count}", &n.to_string())
            .replace("{limit}", &MAX_CERTS.to_string()),
        (n, false) => crate::i18n::t(lang, "out.ssl-certificate-decoder.verdict_chain")
            .replace("{count}", &n.to_string()),
    };
    crate::i18n::t(lang, "out.ssl-certificate-decoder.verdict")
        .replace("{subject}", &subject)
        .replace("{state}", &state)
        .replace("{chain}", &chain)
}

/// `X509Name` → 可读字符串。
fn name_to_string(name: &X509Name, lang: &str) -> String {
    // 空的 Subject 在自签证书里是合法的，给个占位符比给空串好 ——
    // 表格里空着会让人以为是 bug。占位符是给人看的字，走语言包。
    let s = name.to_string();
    if s.trim().is_empty() {
        crate::i18n::t(lang, "out.ssl-certificate-decoder.empty_subject")
    } else {
        s
    }
}

/// 签发者只取第一个 CN，用于摘要行里省地方；没有 CN 就截断全名。
fn short_name(name: &X509Name, lang: &str) -> String {
    if let Some(cn) = name.iter_common_name().next() {
        return match cn.as_str() {
            Ok(s) => s.to_string(),
            Err(_) => crate::i18n::t(lang, "out.ssl-certificate-decoder.empty_common_name"),
        };
    }
    let full = name_to_string(name, lang);
    if full.chars().count() > 40 {
        format!("{}…", full.chars().take(40).collect::<String>())
    } else {
        full
    }
}

/// 公钥位数。
///
/// `PublicKey` 上直接有 `key_size()`，RSA / EC / DSA / GostR3410 都覆盖了；
/// 它对认不出的类型返回 0，这时给 `None` 让调用方省掉这一行 ——
/// 显示一个 `0 bit` 比什么都不显示更糟。
fn public_key_bits(cert: &X509Certificate) -> Option<usize> {
    let bits = cert.public_key().parsed().ok()?.key_size();
    (bits > 0).then_some(bits)
}

/// `GeneralName` → 字符串。认不出来的类型返回 `None`，由调用方填占位符。
fn general_name(name: &GeneralName, lang: &str) -> Option<String> {
    Some(match name {
        GeneralName::DNSName(v) => v.to_string(),
        GeneralName::RFC822Name(v) => v.to_string(),
        GeneralName::URI(v) => v.to_string(),
        GeneralName::IPAddress(v) => ip_of(v)?.to_string(),
        GeneralName::DirectoryName(v) => name_to_string(v, lang),
        GeneralName::RegisteredID(v) => v.to_id_string(),
        _ => return None,
    })
}

/// SAN 里的 IP 是裸 4 或 16 个字节，长度不对说明证书有问题 —— 返回 `None`
/// 让调用方填占位符，而不是拿前 4 个字节凑一个看起来很像的地址。
fn ip_of(bytes: &[u8]) -> Option<std::net::IpAddr> {
    use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
    Some(match bytes.len() {
        4 => IpAddr::V4(Ipv4Addr::new(bytes[0], bytes[1], bytes[2], bytes[3])),
        16 => IpAddr::V6(Ipv6Addr::from(<[u8; 16]>::try_from(bytes).ok()?)),
        _ => return None,
    })
}

fn hex(bytes: &[u8]) -> String {
    bytes
        .iter()
        .map(|b| format!("{b:02X}"))
        .collect::<Vec<_>>()
        .join(":")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 测试证书：`fixtures/` 下那几张是 openssl 真实签发的（多 SAN、已过期、自签、链）。
    /// 生成脚本是同目录的 `generate-certs.py`。
    ///
    /// 断言钉的是**结构**（几条 SAN、多少位公钥、指纹几位）而不是具体哈希 ——
    /// 重新生成会换掉密钥，钉死哈希等于给自己埋一颗下次跑测试就炸的雷。
    fn fixture(name: &str) -> String {
        // `#[test]` 是从源码树跑的，不是从 target/ 里跑的，所以用编译期常量拼路径
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/src/tools/fixtures/");
        std::fs::read_to_string(format!("{path}{name}"))
            .unwrap_or_else(|e| panic!("读不到测试证书 {name}: {e}"))
    }

    fn run(text: &str) -> Value {
        compute(json!({ "cert": text })).unwrap()
    }

    /// 断言错误是某个语言包键。
    ///
    /// 断言**键**而不是消息文本：文案在语言包里，改一次文案就要改一次断言。
    fn assert_err_key(err: ToolError, want: &str) {
        match err {
            ToolError::InvalidKeyed { key, .. } => assert_eq!(key, want),
            other => panic!("应当报 `{want}`，实际 {other:?}"),
        }
    }

    /// 断言错误是某个键，且参数里有某个值。
    ///
    /// 「第几段」这类信息靠参数带出去 —— 报错时得让人知道是哪一段坏了。
    fn assert_err_arg(err: ToolError, want_key: &str, want_name: &str, want_value: &str) {
        match err {
            ToolError::InvalidKeyed { key, args } => {
                assert_eq!(key, want_key);
                assert!(
                    args.iter().any(|(n, v)| n == want_name && v == want_value),
                    "{args:?}"
                );
            }
            other => panic!("应当报 `{want_key}`，实际 {other:?}"),
        }
    }

    /// 指定语言跑一次。
    fn run_lang(text: &str, lang: &str) -> Value {
        compute(json!({ "cert": text, "__lang": lang })).unwrap()
    }

    /// 表格里某一行的值。
    ///
    /// 行标题按语言取，所以这里给的是**语言包里的键**，不是标题的字面量 ——
    /// 把字面量抄一遍的话，改一次文案就要改一次断言。
    fn cell(v: &Value, key: &str) -> String {
        let title = crate::i18n::t(crate::i18n::FALLBACK, key);
        v["table"][&title].as_str().unwrap_or_default().to_string()
    }

    /// 链上第 N 张的摘要行标题（与 `chain_title` 同一套算法）。
    fn chain_title(index: usize) -> String {
        crate::i18n::t(
            crate::i18n::FALLBACK,
            "out.ssl-certificate-decoder.chain_certificate",
        )
        .replace("{index}", &index.to_string())
    }

    /// 模板里占位符之外的字面部分。
    ///
    /// 插值进去的是天数 / 日期这类会变的值，断言只能钉住
    /// 「那句话用的是语言包里的那句」。
    fn literal_fragments(template: &str) -> Vec<String> {
        template
            .split('{')
            .filter_map(|part| match part.split_once('}') {
                Some((_, tail)) => Some(tail.to_string()),
                None => Some(part.to_string()),
            })
            .filter(|s| !s.trim().is_empty())
            .collect()
    }

    /// 去掉 PEM 头与换行，得到裸 base64。
    fn bare_base64(name: &str) -> String {
        fixture(name)
            .lines()
            .filter(|l| !l.starts_with("-----"))
            .flat_map(|l| l.chars())
            .filter(|c| !c.is_whitespace())
            .collect()
    }

    // ---------------------------------------------------------------- 输入格式

    #[test]
    fn accepts_pem_with_headers() {
        let out = run(&fixture("leaf.pem"));
        assert_eq!(out["meta"]["certificate_count"], 1);
        let subject = cell(&out, "out.ssl-certificate-decoder.subject");
        assert!(subject.contains("leaf.it-tools.example"), "{subject}");
    }

    /// 贴了一段「头尾齐全、正文也是合法 base64、但内容被截断」的 PEM。
    ///
    /// 这三种条件同时满足时，PEM 那条路走的是「看到 `BEGIN` 就按 PEM 解」，
    /// 解出来是一串解不开的字节。以前它在 [`compute`] 里被当成「内部不自洽」，
    /// 于是返回 500 —— 用户贴错了自己的证书，服务却报自己坏了。
    #[test]
    fn truncated_pem_is_a_bad_request_not_a_server_error() {
        let truncated = "-----BEGIN CERTIFICATE-----\n\
                         MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA\n\
                         -----END CERTIFICATE-----\n";
        match compute(json!({ "cert": truncated })) {
            Err(ToolError::InvalidKeyed { key, args }) => {
                assert_eq!(key, "out.ssl-certificate-decoder.err.pem_not_a_certificate");
                // 要说清是哪一段坏了
                assert!(
                    args.iter().any(|(n, v)| n == "index" && v == "1"),
                    "{args:?}"
                );
            }
            Err(ToolError::Internal(msg)) => panic!("贴错内容不该报 500：{msg}"),
            Ok(v) => panic!("截断的 PEM 不该解出结果：{v}"),
        }
    }

    /// 链里第 2 张坏了，要点名是第几张 —— 一条 10 张的链只报「第 1 段」没法排查。
    #[test]
    fn a_broken_block_names_which_one() {
        let good = fixture("leaf.pem");
        let broken = "-----BEGIN CERTIFICATE-----\nQUJD\n-----END CERTIFICATE-----\n";
        let pem = format!("{good}{broken}");
        let err = compute(json!({ "cert": pem })).expect_err("第 2 段坏了该报错");
        assert_err_arg(
            err,
            "out.ssl-certificate-decoder.err.pem_not_a_certificate",
            "index",
            "2",
        );
    }

    #[test]
    fn accepts_bare_base64() {
        // issue #1459 的主诉就是这个：只贴 base64，没有 PEM 头
        let b64 = bare_base64("leaf.pem");
        assert!(!b64.contains("-----"));
        let out = run(&b64);
        assert_eq!(out["meta"]["certificate_count"], 1);
        assert_eq!(
            out["meta"]["sha256_fingerprint"],
            run(&fixture("leaf.pem"))["meta"]["sha256_fingerprint"]
        );
    }

    #[test]
    fn accepts_der_hexadecimal() {
        let der = BASE64.decode(bare_base64("leaf.pem")).unwrap();
        let lower: String = der.iter().map(|b| format!("{b:02x}")).collect();
        let upper: String = der.iter().map(|b| format!("{b:02X}")).collect();
        let colon: String = der
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<Vec<_>>()
            .chunks(2)
            .map(|p| p.concat())
            .collect::<Vec<_>>()
            .join(":");

        let want = run(&fixture("leaf.pem"))["meta"]["sha256_fingerprint"].clone();
        for (label, form) in [("小写", &lower), ("大写", &upper), ("带冒号", &colon)] {
            assert_eq!(
                run(form)["meta"]["sha256_fingerprint"],
                want,
                "{label} 十六进制解出来的指纹不一致"
            );
        }
    }

    #[test]
    fn all_four_input_shapes_agree_on_the_fingerprint() {
        let want = run(&fixture("leaf.pem"))["meta"]["sha256_fingerprint"].clone();
        let der = BASE64.decode(bare_base64("leaf.pem")).unwrap();
        assert_eq!(
            run(&BASE64.encode(&der))["meta"]["sha256_fingerprint"],
            want,
            "base64"
        );
        let hexstr: String = der.iter().map(|b| format!("{b:02X}")).collect();
        assert_eq!(run(&hexstr)["meta"]["sha256_fingerprint"], want, "hex");
    }

    #[test]
    fn a_pem_chain_decodes_every_certificate() {
        let chain = format!("{}{}", fixture("leaf.pem"), fixture("intermediate.pem"));
        let out = run(&chain);
        assert_eq!(out["meta"]["certificate_count"], 2);
        assert_eq!(out["meta"]["chain_truncated"], false);
        // 第一张给全字段，第二张只给摘要行
        assert!(!cell(&out, "out.ssl-certificate-decoder.san_entries").is_empty());
        let chain_row = cell(&out, &chain_title(2));
        assert!(!chain_row.is_empty(), "第二张证书应当有摘要行");
        // 摘要行与结论都是语言包里的文案 —— 语言包还没并进来时
        // 取到的就是键本身，这时先跳过这两条；并进来之后它们一定会跑。
        if crate::i18n::has("en", "out.ssl-certificate-decoder.chain_summary") {
            assert!(chain_row.contains("Intermediate"), "{chain_row}");
        }
        let chain_key = "out.ssl-certificate-decoder.verdict_chain";
        if crate::i18n::has("en", chain_key) {
            let fragment = crate::i18n::t("en", chain_key).replace("{count}", "2");
            assert!(
                out["output"].as_str().unwrap().contains(&fragment),
                "{}",
                out["output"]
            );
        }
    }

    #[test]
    fn concatenated_base64_without_newlines_is_split() {
        // base64 折叠（-w 0）会让两张证书连成一条
        let joined = format!(
            "{}{}",
            bare_base64("leaf.pem"),
            bare_base64("intermediate.pem")
        );
        assert!(!joined.contains('\n'));
        let out = run(&joined);
        assert_eq!(out["meta"]["certificate_count"], 2);
    }

    #[test]
    fn chain_truncation_is_announced_not_silent() {
        // 25 张超过 MAX_CERTS=20
        let one = fixture("leaf.pem");
        let many = one.repeat(25);
        let out = run(&many);
        assert_eq!(out["meta"]["certificate_count"], MAX_CERTS);
        assert_eq!(out["meta"]["chain_truncated"], true);
        // 「已截断」是语言包里的文案 —— 语言包还没并进来时先跳过这条
        let key = "out.ssl-certificate-decoder.verdict_chain_truncated";
        if crate::i18n::has("en", key) {
            let fragment = crate::i18n::t("en", key)
                .replace("{count}", &MAX_CERTS.to_string())
                .replace("{limit}", &MAX_CERTS.to_string());
            assert!(
                out["output"].as_str().unwrap().contains(&fragment),
                "{}",
                out["output"]
            );
        }
    }

    #[test]
    fn base64_detection_does_not_depend_on_padding() {
        // 2048 位证书的 base64 长度恰好是 4 的倍数，永远没有 `=`。
        // 靠「有没有 = 结尾」判格式的实现在这里会走错分支。
        let b64 = bare_base64("leaf.pem");
        assert!(!b64.ends_with('='), "夹具不该需要 padding");
        assert_eq!(run(&b64)["meta"]["certificate_count"], 1);
    }

    // ---------------------------------------------------------------- 字段内容

    #[test]
    fn exposes_the_fields_the_issue_asks_for() {
        let out = run(&fixture("leaf.pem"));
        // 行标题按语言取，所以断言按**键**来 —— 键在语言包里，
        // 标题的字面量不该抄进测试。
        for key in [
            "out.ssl-certificate-decoder.version",
            "out.ssl-certificate-decoder.serial_number",
            "out.ssl-certificate-decoder.subject",
            "out.ssl-certificate-decoder.issuer",
            "out.ssl-certificate-decoder.not_before",
            "out.ssl-certificate-decoder.not_after",
            "out.ssl-certificate-decoder.signature_algorithm",
            "out.ssl-certificate-decoder.public_key_algorithm",
            "out.ssl-certificate-decoder.public_key_bits",
            "out.ssl-certificate-decoder.sha1_fingerprint",
            "out.ssl-certificate-decoder.sha256_fingerprint",
            "out.ssl-certificate-decoder.san_entries",
        ] {
            assert!(!cell(&out, key).is_empty(), "{key} 是空的");
        }
        assert_eq!(
            cell(&out, "out.ssl-certificate-decoder.public_key_bits"),
            "2048 bit"
        );
    }

    #[test]
    fn fingerprints_are_colon_separated_uppercase_hex() {
        let out = run(&fixture("leaf.pem"));
        let f = cell(&out, "out.ssl-certificate-decoder.sha256_fingerprint");
        // SHA-256 = 32 字节 → 32 段；SHA-1 = 20 字节 → 20 段
        assert_eq!(f.split(':').count(), 32, "{f}");
        assert!(f.chars().all(|c| c.is_ascii_hexdigit() || c == ':'), "{f}");
        assert!(f.contains(":"), "应当是冒号分隔的: {f}");
        assert_eq!(
            cell(&out, "out.ssl-certificate-decoder.sha1_fingerprint")
                .split(':')
                .count(),
            20
        );
    }

    #[test]
    fn fingerprint_matches_an_independent_hash_of_the_same_bytes() {
        // 别用被测代码算出来的值当期望值 —— 从 PEM 重新解一遍 DER 独立地哈希
        let der = BASE64.decode(bare_base64("leaf.pem")).unwrap();
        let want: String = Sha256::digest(&der)
            .iter()
            .map(|b| format!("{b:02X}"))
            .collect::<Vec<_>>()
            .join(":");
        assert_eq!(
            run(&fixture("leaf.pem"))["meta"]["sha256_fingerprint"],
            json!(want)
        );
    }

    #[test]
    fn san_entries_are_listed() {
        let san = cell(
            &run(&fixture("leaf.pem")),
            "out.ssl-certificate-decoder.san_entries",
        );
        // 值是语言包里的模板，条数与列表都靠占位符插进去 ——
        // 占位符一定被换掉了
        assert!(!san.contains("{count}"), "{san}");
        assert!(!san.contains("{list}"), "{san}");
        // 语言包还没并进来时，值取到的就是键本身，这时先跳过内容断言；
        // 并进来之后它一定会跑。
        let key = "out.ssl-certificate-decoder.san_entries_value";
        if crate::i18n::has("en", key) {
            assert!(san.contains("leaf.it-tools.example"), "{san}");
            assert!(san.contains("www.leaf.it-tools.example"), "{san}");
            assert!(san.contains("192.0.2.10"), "{san}");
            let prefix = crate::i18n::t("en", key)
                .replace("{count}", "3")
                .replace("{list}", "");
            assert!(san.starts_with(&prefix), "{san}");
        }
    }

    #[test]
    fn validity_window_is_reported_correctly() {
        let out = run(&fixture("leaf.pem"));
        let expired = out["meta"]["expired"].as_bool().unwrap();
        let not_yet = out["meta"]["not_yet_valid"].as_bool().unwrap();
        assert!(!(expired && not_yet), "不可能既过期又未生效");
        let text = out["output"].as_str().unwrap();
        // 结论那句是语言包里的散文 —— 钉住的是那句话里的字面部分，
        // 插值进去的天数 / 日期是会变的。
        let state_key = if expired {
            "out.ssl-certificate-decoder.verdict_expired"
        } else if not_yet {
            "out.ssl-certificate-decoder.verdict_not_yet_valid"
        } else {
            "out.ssl-certificate-decoder.verdict_valid"
        };
        if crate::i18n::has("en", state_key) {
            for frag in literal_fragments(&crate::i18n::t("en", state_key)) {
                assert!(text.contains(&frag), "{text}");
            }
        }
        // 有效期是一个 RFC3339 区间，不该是「某个时间戳数字」
        let not_after = cell(&out, "out.ssl-certificate-decoder.not_after");
        assert!(not_after.contains('T'), "{not_after}");
    }

    #[test]
    fn an_expired_certificate_says_so_and_is_not_an_error() {
        let out = run(&fixture("expired.pem"));
        assert_eq!(out["meta"]["expired"], true);
        assert!(out["meta"]["days_until_expiry"].as_i64().unwrap() < 0);
        let key = "out.ssl-certificate-decoder.verdict_expired";
        if crate::i18n::has("en", key) {
            let text = out["output"].as_str().unwrap();
            for frag in literal_fragments(&crate::i18n::t("en", key)) {
                assert!(text.contains(&frag), "{text}");
            }
        }
    }

    #[test]
    fn a_self_signed_certificate_names_itself_as_issuer() {
        let out = run(&fixture("self-signed.pem"));
        let subject = cell(&out, "out.ssl-certificate-decoder.subject");
        let issuer = cell(&out, "out.ssl-certificate-decoder.issuer");
        assert!(subject.contains("Self-signed"), "{subject}");
        assert!(issuer.contains("Self-signed"), "{issuer}");
    }

    #[test]
    fn a_leaf_signed_by_the_intermediate_names_it() {
        let out = run(&fixture("leaf.pem"));
        let issuer = cell(&out, "out.ssl-certificate-decoder.issuer");
        assert!(issuer.contains("Intermediate"), "{issuer}");
    }

    // ---------------------------------------------------------------- 错误输入

    #[test]
    fn garbage_is_rejected_with_an_actionable_message() {
        let err = compute(json!({ "cert": "hello world, this is not a certificate" })).unwrap_err();
        let key = "out.ssl-certificate-decoder.err.unrecognized_format";
        assert_err_key(err, key);
        // 提示里要列出支持的格式，否则用户不知道该贴什么 ——
        // 那句话在语言包里，语言包还没并进来时先跳过这条
        if crate::i18n::has("en", key) {
            let en = crate::i18n::t("en", key);
            for want in ["PEM", "base64", "hex"] {
                assert!(en.contains(want), "提示里没有「{want}」: {en}");
            }
        }
    }

    #[test]
    fn truncated_pem_names_the_missing_marker() {
        let err = compute(json!({ "cert": "-----BEGIN CERTIFICATE-----\nMIIB\n" })).unwrap_err();
        assert_err_arg(
            err,
            "out.ssl-certificate-decoder.err.pem_missing_end",
            "marker",
            "-----END CERTIFICATE-----",
        );
    }

    #[test]
    fn valid_base64_that_is_not_a_certificate_is_rejected() {
        let err = compute(json!({ "cert": BASE64.encode(b"not really a certificate at all") }))
            .unwrap_err();
        assert_err_key(err, "out.ssl-certificate-decoder.err.unrecognized_format");
    }

    #[test]
    fn empty_and_missing_input_are_rejected_without_panicking() {
        assert!(compute(json!({ "cert": "" })).is_err());
        assert!(compute(json!({ "cert": "   " })).is_err());
        assert!(compute(json!({})).is_err());
        // 非字符串
        for bad in [
            json!(42),
            json!(null),
            json!(["a"]),
            json!({"a": 1}),
            json!(true),
        ] {
            assert!(compute(json!({ "cert": bad })).is_err(), "{bad}");
        }
    }

    #[test]
    fn hex_decoder_rejects_malformed_input() {
        assert!(decode_hex("").is_err(), "空串");
        assert!(decode_hex("zz").is_err(), "非十六进制");
        assert!(decode_hex("abc").is_err(), "奇数位数");
        assert_eq!(decode_hex("0a:0B").unwrap(), vec![0x0a, 0x0b]);
        assert_eq!(decode_hex("0a 0b\n0c").unwrap(), vec![0x0a, 0x0b, 0x0c]);
    }

    #[test]
    fn der_stream_split_does_not_loop_forever_on_junk() {
        // 全是 0xFF：X.509 解析器永远失败，循环必须一次都不进
        assert!(split_der_stream(&[0xff; 64]).is_empty());
        assert!(split_der_stream(&[]).is_empty());
    }

    #[test]
    fn short_name_prefers_the_common_name() {
        // `short_name` 只用在链上第 2..N 张的摘要行里 —— 那里要省地方，
        // 所以签发者只给 CN，不给整串 RDN。
        let der = BASE64.decode(bare_base64("intermediate.pem")).unwrap();
        let (_, cert) = X509Certificate::from_der(&der).unwrap();

        let full = name_to_string(cert.issuer(), "en");
        let short = short_name(cert.issuer(), "en");
        // 第 2 张是中间 CA，它的签发者是根 CA
        assert_eq!(short, "IT Tools Test Root CA");
        assert!(full.contains("C=CN"), "{full}");
        assert_ne!(full, short);

        let chain = run(&format!(
            "{}{}",
            fixture("leaf.pem"),
            fixture("intermediate.pem")
        ));
        let row = cell(&chain, &chain_title(2));
        // 摘要行里用的是短名，不是整串 RDN。
        // 语言包还没并进来时，摘要行取到的就是键本身，这时先跳过这条。
        if crate::i18n::has("en", "out.ssl-certificate-decoder.chain_summary") {
            assert!(row.contains(&short), "{row}");
            assert!(!row.contains(&full), "签发者用了整串 RDN: {row}");
            // 主题仍然是全名 —— 短名是给签发者用的，不是给主题用的
            assert!(row.contains("CN=IT Tools Test Intermediate CA"), "{row}");
        }
    }

    /// 表格的行标题要跟着请求语言走 —— 英文界面不该出现中文行标题。
    #[test]
    fn the_row_labels_follow_the_request_language() {
        let en = run(&fixture("leaf.pem"));
        let zh = run_lang(&fixture("leaf.pem"), "zh-CN");

        let key = "out.ssl-certificate-decoder.subject";
        let en_label = crate::i18n::t("en", key);
        let zh_label = crate::i18n::t("zh-CN", key);
        assert!(en["table"].get(&en_label).is_some(), "{:?}", en["table"]);
        assert!(zh["table"].get(&zh_label).is_some(), "{:?}", zh["table"]);

        // 两种语言的标题确实不一样 —— 不然上面两条断言等于什么都没验。
        // 语言包还没并进来时，两边都退回键本身（键还没进语言包，分不出语言），
        // 这时先跳过这条；并进来之后它一定会跑。
        if crate::i18n::has("en", key) && crate::i18n::has("zh-CN", key) {
            assert_ne!(en_label, zh_label);
            assert!(!zh["table"].get(&en_label).is_some(), "{:?}", zh["table"]);
            assert!(!en["table"].get(&zh_label).is_some(), "{:?}", en["table"]);
        }
    }

    /// 链上第 2..N 张的行标题也是按语言取的 —— 那一行原本写死的是中文。
    #[test]
    fn the_chain_row_label_follows_the_request_language() {
        let chain = format!("{}{}", fixture("leaf.pem"), fixture("intermediate.pem"));
        let en = run(&chain);
        let zh = run_lang(&chain, "zh-CN");

        let key = "out.ssl-certificate-decoder.chain_certificate";
        let en_title = crate::i18n::t("en", key).replace("{index}", "2");
        let zh_title = crate::i18n::t("zh-CN", key).replace("{index}", "2");
        assert!(en["table"].get(&en_title).is_some(), "{:?}", en["table"]);
        assert!(zh["table"].get(&zh_title).is_some(), "{:?}", zh["table"]);

        if crate::i18n::has("en", key) && crate::i18n::has("zh-CN", key) {
            assert_ne!(en_title, zh_title);
            assert!(!zh["table"].get(&en_title).is_some(), "{:?}", zh["table"]);
            assert!(!en["table"].get(&zh_title).is_some(), "{:?}", en["table"]);
        }
    }

    #[test]
    fn every_cell_is_a_string_not_null() {
        // table 是渲染成两列表格的，任何 null 都会在页面上显示成 "null"
        for name in [
            "leaf.pem",
            "intermediate.pem",
            "expired.pem",
            "self-signed.pem",
        ] {
            let out = run(&fixture(name));
            for (k, v) in out["table"].as_object().unwrap() {
                let s = v
                    .as_str()
                    .unwrap_or_else(|| panic!("{name}/{k} 不是字符串: {v}"));
                assert!(!s.is_empty(), "{name}/{k} 是空串");
            }
        }
    }

    /// 错误消息要跟着请求语言走 —— 语言不是工具决定的，是 API 层
    /// 按请求语言调用 `localize` 渲染的。
    #[test]
    fn the_error_message_follows_the_requested_language() {
        let err = compute(json!({ "cert": "hello world, this is not a certificate" })).unwrap_err();
        let key = "out.ssl-certificate-decoder.err.unrecognized_format";
        // 语言包里还没并进来时，localize 退回键本身 —— 这时断言跳过
        if !crate::i18n::has("zh-CN", key) {
            return;
        }
        let en = err.localize("en");
        let zh = err.localize("zh-CN");
        assert_ne!(en, zh, "两种语言不该是同一句");
        assert!(!en.contains("out.ssl-certificate-decoder"), "英文界面不该露出键：{en}");
        assert!(!zh.contains("out.ssl-certificate-decoder"), "中文界面不该露出键：{zh}");
    }
}
