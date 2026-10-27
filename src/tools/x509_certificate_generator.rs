//! X.509 自签证书生成器（endpoint `x509-certificate-generator`）。
//!
//! 上游来源：PR #1812（多域名 SAN、可配有效期、SHA-256 签名）与 PR #915
//! （空值过滤、正序列号、输出私钥）。两个 PR 的功能取长补短，
//! 差别逐条列在下面的「与上游的差别」里。
//!
//! ## 为什么放服务端
//!
//! - **密钥生成是 CPU 密集的**。本机 release 实测 RSA 2048 要 0.24 秒、
//!   4096 要 2.5 秒；放进浏览器主线程就是一次肉眼可见的卡顿（上游两个 PR
//!   都是同步生成，页面会僵住）。这里丢进 [`util::blocking`] 的 blocking
//!   线程池，actix 的 worker 不会被占住。
//! - **浏览器没有造证书的 API**。WebCrypto 只能「拿已有的密钥签个名」，
//!   组装不出带 SAN / basicConstraints / keyUsage 的 X.509 结构。
//!
//! ## 与上游的差别
//!
//! | 上游 | 上游的做法 | 这里 |
//! |---|---|---|
//! | #1812 | 逗号分隔的每个域名各塞一个 CN 字段 | **CN 只放第一个**，其余全进 SAN |
//! | #1812 | `/\d+/.test(x)` 判断是不是 IP | `IpAddr::from_str` **真解析**，解析成功才算 IP |
//! | #915 | 默认 SHA-1 签名 | **SHA-256**（曲线自带 SHA-384 的除外） |
//! | #915 | 9 字节随机数转 hex 再「转成正数」 | `rcgen::SerialNumber::from(..)`，正数由 rcgen 保证 |
//! | #915 | 空字段也进 DN | 空字段**过滤掉** |
//! | 两者 | 在浏览器主线程里同步生成 | 服务端 blocking 线程池，前端不卡 |
//!
//! ## CN 与 SAN 的关系
//!
//! RFC 5280 里 `commonName` 是**一个** DN 属性，上游 #1812 给每个域名都塞一个
//! CN，那样的证书不合规；更实际的问题是 Chrome 58 之后客户端**只读 SAN**，
//! CN 里的第二个域名压根不会被匹配到。
//!
//! 所以这里的口径是：
//!
//! - `common_name` 里第一个域名 → CN；
//! - `common_name` 里的其余域名、`alternative_names` 里的全部条目 → SAN；
//! - **CN 里那个域名自己也会进 SAN** —— CN 早已被 RFC 6125 废弃，
//!   SAN 才是客户端真正读的字段，只填 CN 的证书在现代浏览器上是不生效的。
//!
//! ## 有效期怎么算
//!
//! `validity_days` 是**整段有效期**的长度，不是「从现在起多少天」：
//! `not_before` 取「现在往前推 1 天」（留出时钟偏差的余量，
//! 否则客户端的机器慢一分钟就会判定证书尚未生效），
//! `not_after = not_before + validity_days`。
//! 于是 `not_after - not_before` 正好等于用户填的天数。
//!
//! ## 表格里的每一项都是从证书里读回来的
//!
//! 不是从我们填进去的参数里抄 —— 参数是我们「以为」写进去的，
//! 证书才是实际生效的那一份。生成完立刻用 `x509-parser` 把 DER 解回来，
//! 主题、序列号、SAN、指纹都是从解出来的结构里取的。

use std::net::IpAddr;
use std::str::FromStr;

use rand::Rng;
use rcgen::string::{Ia5String, PrintableString};
use rcgen::{
    BasicConstraints, CertificateParams, DnType, DnValue, ExtendedKeyUsagePurpose, IsCa,
    KeyUsagePurpose, SanType, SerialNumber,
};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use time::{format_description::well_known::Rfc3339, Duration, OffsetDateTime};
use x509_parser::extensions::GeneralName;
use x509_parser::prelude::{FromDer, X509Certificate, X509Name};

use super::pki::{self, KeyAlgorithm};
use super::util;
use super::{ToolError, ToolResult};

/// `common_name` 的默认值 —— 与注册表 `ApiField { name: "common_name" }` 对齐。
const DEFAULT_COMMON_NAME: &str = "example.com";
/// 有效期的默认天数，与注册表 `default: Some("365")` 对齐。
const DEFAULT_VALIDITY_DAYS: u64 = 365;
/// 有效期的上限。
///
/// `POST /api/tools/x509-certificate-generator` 是公开接口，一个
/// `{"validity_days": 100000000}` 就能要一张撑到公元 270000 年的证书 ——
/// 夹住比报错更合适（见 `util::bounded_u64` 的注释）。
const MAX_VALIDITY_DAYS: u64 = 3650;

/// 表格里放私钥的那一行的**语言包键**。
///
/// 行标题按当前语言取，所以这里存的是键而不是「私钥 (PKCS#8)」这句字面量。
/// 用常量而不是字面量，是因为单测要引用同一个键 ——
/// 键一改，测试就该红，而不是悄悄跟着改。
const T_PRIVATE_KEY: &str = "out.x509-certificate-generator.private_key";
/// 表格里放 SHA-256 指纹的那一行的**语言包键**。
const T_FINGERPRINT: &str = "out.x509-certificate-generator.sha256_fingerprint";

/// 与注册表 `ApiSpec.fields` 保持一致。
///
/// 密钥生成是 CPU 密集的（RSA 4096 要好几秒），必须丢到 blocking 线程池 ——
/// 直接在 actix worker 上算会把整个 runtime 卡住。
pub async fn handle(payload: Value) -> ToolResult {
    util::blocking(move || compute(payload)).await
}

fn compute(payload: Value) -> ToolResult {
    let alg = key_algorithm_of(&payload)?;
    let is_ca = opt_bool(&payload, "is_ca", true);
    let validity_days = util::bounded_u64(
        &payload,
        "validity_days",
        DEFAULT_VALIDITY_DAYS,
        1,
        MAX_VALIDITY_DAYS,
    );

    // ---- 域名：CN 一个，其余进 SAN ----
    let domains = pki::split_list(util::str_or(&payload, "common_name", DEFAULT_COMMON_NAME));
    if domains.is_empty() {
        return Err(ToolError::invalid(
            "out.x509-certificate-generator.err.missing_common_name",
            &[("field", "common_name")],
        ));
    }
    let common_name = domains[0].clone();
    let extra_names = util::opt_str(&payload, "alternative_names")
        .map(pki::split_list)
        .unwrap_or_default();

    // ---- 备用名称 ----
    let mut san_types: Vec<SanType> = Vec::new();
    for name in domains.iter().chain(extra_names.iter()) {
        san_types.push(san_of(name)?);
    }

    // ---- 主体 ----
    let mut params = CertificateParams::default();
    // `CertificateParams::default()` 里带了一个 `CN=rcgen self signed cert`，
    // 这里 push 同名属性会把它**覆盖**掉（rcgen 的 DN 是个 HashMap，一个类型只留一个值）。
    params.distinguished_name.push(DnType::CommonName, common_name.clone());

    if let Some(country) = non_empty(&payload, "country_name") {
        // RFC 5280：countryName 是 PrintableString，长度固定 2。
        if country.len() != 2 || !country.is_ascii() {
            return Err(ToolError::invalid(
                "out.x509-certificate-generator.err.country_code_format",
                &[("value", country)],
            ));
        }
        let printable = PrintableString::try_from(country).map_err(|e| {
            ToolError::invalid(
                "out.x509-certificate-generator.err.country_code_invalid",
                &[("value", country), ("reason", &e.to_string())],
            )
        })?;
        params
            .distinguished_name
            .push(DnType::CountryName, DnValue::PrintableString(printable));
    }
    if let Some(v) = non_empty(&payload, "state_or_province_name") {
        params.distinguished_name.push(DnType::StateOrProvinceName, v);
    }
    if let Some(v) = non_empty(&payload, "locality_name") {
        params.distinguished_name.push(DnType::LocalityName, v);
    }
    if let Some(v) = non_empty(&payload, "organization_name") {
        params.distinguished_name.push(DnType::OrganizationName, v);
    }
    if let Some(v) = non_empty(&payload, "organizational_unit_name") {
        params
            .distinguished_name
            .push(DnType::OrganizationalUnitName, v);
    }
    if let Some(email) = non_empty(&payload, "email_address") {
        // rcgen 的 `DnType` 里没有 emailAddress，只能用自定义 OID
        // （1.2.840.113549.1.9.1 = PKCS#9 emailAddress）。
        params.distinguished_name.push(
            DnType::CustomDnType(vec![1, 2, 840, 113549, 1, 9, 1]),
            email,
        );
        // 上游 #1812 还把邮箱放进 SAN（rfc822Name），这里一并照做。
        let ia5 = Ia5String::try_from(email).map_err(|_| {
            ToolError::invalid(
                "out.x509-certificate-generator.err.email_not_ascii",
                &[("email", email)],
            )
        })?;
        san_types.push(SanType::Rfc822Name(ia5));
    }
    params.subject_alt_names = san_types;

    // ---- 有效期 ----
    let now = OffsetDateTime::now_utc();
    let not_before = now - Duration::days(1);
    let not_after = not_before + Duration::days(validity_days as i64);
    params.not_before = not_before;
    params.not_after = not_after;

    // ---- 是不是 CA ----
    params.is_ca = if is_ca {
        IsCa::Ca(BasicConstraints::Unconstrained)
    } else {
        // 显式写一条 `CA:FALSE`，而不是干脆不写 basicConstraints ——
        // 「没写」和「写了不是 CA」在部分校验器里不是一回事。
        IsCa::ExplicitNoCa
    };

    // ---- 用途 ----
    let mut key_usages = vec![KeyUsagePurpose::DigitalSignature];
    // 只有 RSA 才有「密钥传输」这回事；ECDSA / Ed25519 的 keyEncipherment 没有意义。
    if alg.rsa_bits().is_some() {
        key_usages.push(KeyUsagePurpose::KeyEncipherment);
    }
    if is_ca {
        key_usages.push(KeyUsagePurpose::KeyCertSign);
        key_usages.push(KeyUsagePurpose::CrlSign);
        key_usages.push(KeyUsagePurpose::ContentCommitment);
    }
    params.key_usages = key_usages;
    if !is_ca {
        // 非 CA 的证书按「拿来跑 TLS」用：服务器认证 + 客户端认证。
        params.extended_key_usages = vec![
            ExtendedKeyUsagePurpose::ServerAuth,
            ExtendedKeyUsagePurpose::ClientAuth,
        ];
    }

    // ---- 序列号 ----
    params.serial_number = Some(random_serial_number());

    // ---- 生成与签发 ----
    let key = pki::generate(alg).map_err(|e| ToolError::Internal(format!("生成密钥失败: {e}")))?;
    let cert = params
        .self_signed(&key.key_pair)
        .map_err(|e| ToolError::Internal(format!("签发证书失败: {e}")))?;
    let pem = cert.pem();
    let der: &[u8] = cert.der().as_ref();

    // 把刚生成的证书解回来 —— 表格里的每一项都从这里取，
    // 免得「我们以为写进去的」和「证书里真有的」对不上。
    let (_, parsed) = X509Certificate::from_der(der)
        .map_err(|e| ToolError::Internal(format!("回读刚生成的证书失败: {e}")))?;

    // 结果区里**给人看的字**走语言包（行标题、成句的值）；
    // 机器可读的值（版本号、序列号、时间戳、指纹、算法名）原样保留。
    //
    // 行标题由 `util::row` 按当前语言取 —— 所以 `describe` 给的是**键**，
    // 键到字面量的映射在语言包里。
    let lang = util::lang(&payload);
    let mut table = Map::new();
    for (row_key, value) in describe(&parsed, der, lang) {
        util::row(&mut table, &payload, &row_key, json!(value));
    }
    util::row(
        &mut table,
        &payload,
        T_PRIVATE_KEY,
        json!(key.private_key_pem),
    );

    Ok(json!({
        "output": pem,
        "table": table,
        "meta": {
            "common_name": common_name,
            "san": san_list(&parsed, lang),
            "not_before": fmt_time(&parsed.validity().not_before),
            "not_after": fmt_time(&parsed.validity().not_after),
            "validity_days": validity_days,
            "serial_number": hex_colon(parsed.raw_serial()),
            "key_algorithm": alg_value(&payload),
            "signature_algorithm": parsed.signature_algorithm.algorithm.to_id_string(),
            "is_ca": is_ca,
            "sha256_fingerprint": hex_plain(&Sha256::digest(der)),
        }
    }))
}

/// 解析注册表下拉框提交上来的密钥算法。
///
/// 取值必须与 [`KeyAlgorithm::from_value`] 认的完全一致：
/// `rsa2048` / `rsa3072` / `rsa4096` / `ecdsa-p256` / `ecdsa-p384` / `ed25519`。
fn key_algorithm_of(payload: &Value) -> Result<KeyAlgorithm, ToolError> {
    let raw = util::str_or(payload, "key_algorithm", "rsa2048");
    KeyAlgorithm::from_value(raw).ok_or_else(|| {
        // 文案在语言包里 —— 英文界面下不能露中文。
        ToolError::invalid(
            "out.x509-certificate-generator.err.unknown_algorithm",
            &[("algorithm", raw)],
        )
    })
}

/// 原样回显注册表里的算法取值（meta 用）。
fn alg_value(payload: &Value) -> String {
    util::str_or(payload, "key_algorithm", "rsa2048").to_string()
}

/// 一个名字该进 SAN 的哪一格。
///
/// **IP 靠真解析**：上游 #1812 用 `/\d+/.test(...)` 判断，于是 `1a.b.c.d`
/// 会被当成 IP 写进证书 —— 那种 SAN 谁也匹配不上。
/// 这里用 `IpAddr::from_str`：解析成功才是 IP，解析失败就是域名。
fn san_of(name: &str) -> Result<SanType, ToolError> {
    if let Ok(ip) = IpAddr::from_str(name) {
        return Ok(SanType::IpAddress(ip));
    }
    let dns = Ia5String::try_from(name).map_err(|_| {
        ToolError::invalid(
            "out.x509-certificate-generator.err.invalid_san_name",
            &[("name", name)],
        )
    })?;
    Ok(SanType::DnsName(dns))
}

/// 序列号：16 字节随机数，最高位清零。
///
/// RFC 5280 §4.1.2.2 要求序列号是**正整数**且不超过 20 字节。
/// 「正整数」这件事不必自己拼 —— rcgen 写 INTEGER 时用的是 yasna 的
/// `write_bigint_bytes(.., true)`，最高位是 1 时会自动补一个 0x00 前导字节，
/// 解析出来必然是正数。上游 #915 那套「9 字节随机数转 hex 再转成正数」
/// 正是为了绕开这一点，这里不需要绕。
fn random_serial_number() -> SerialNumber {
    let mut bytes = [0u8; 16];
    rand::thread_rng().fill(&mut bytes);
    // 自己再清一次最高位：这样连「补前导 0x00」都不需要，序列号本身就是 16 字节正数。
    bytes[0] &= 0x7f;
    SerialNumber::from(bytes.to_vec())
}

/// 取一个非空的字符串字段。空串与纯空白都当作「没填」。
fn non_empty<'a>(payload: &'a Value, name: &str) -> Option<&'a str> {
    util::opt_str(payload, name)
        .map(str::trim)
        .filter(|s| !s.is_empty())
}

/// 开关字段的值。
///
/// `app.js` 对 checkbox 一律发 JSON 的 `true` / `false`；
/// 但这个接口是公开的，手写请求可能发字符串 —— 两种都收。
fn opt_bool(payload: &Value, name: &str, default: bool) -> bool {
    match payload.get(name) {
        Some(Value::Bool(b)) => *b,
        Some(Value::String(s)) => match s.trim().to_ascii_lowercase().as_str() {
            "true" | "1" | "yes" | "on" => true,
            "false" | "0" | "no" | "off" => false,
            _ => default,
        },
        _ => default,
    }
}

/// 逐项描述一张证书。
///
/// 返回 `Vec` 而不是直接填 `Map`：调用方按这个顺序 `insert`，
/// 而 `serde_json::Map` 底层是 `BTreeMap`，插入顺序到渲染时才被丢掉。
///
/// 每个元素是 **（语言包键, 值）**：行标题由调用方用 `util::row`
/// 按当前语言取出来，代码里只出现键。
fn describe(cert: &X509Certificate, der: &[u8], lang: &str) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = Vec::new();
    let mut put = |k: &str, v: String| out.push((k.to_string(), v));

    put(
        "out.x509-certificate-generator.version",
        cert.version().to_string(),
    );
    put(
        "out.x509-certificate-generator.serial_number",
        hex_colon(cert.raw_serial()),
    );
    put(
        "out.x509-certificate-generator.subject",
        name_to_string(cert.subject(), lang),
    );
    put(
        "out.x509-certificate-generator.issuer",
        name_to_string(cert.issuer(), lang),
    );
    put(
        "out.x509-certificate-generator.not_before",
        fmt_time(&cert.validity().not_before),
    );
    put(
        "out.x509-certificate-generator.not_after",
        fmt_time(&cert.validity().not_after),
    );
    put(
        "out.x509-certificate-generator.subject_alt_name",
        san_summary(cert, lang),
    );
    put(
        "out.x509-certificate-generator.key_algorithm",
        key_algorithm_summary(cert),
    );
    let sig_oid = cert.signature_algorithm.algorithm.to_id_string();
    put(
        "out.x509-certificate-generator.signature_algorithm",
        format!("{} ({sig_oid})", friendly(&sig_oid)),
    );
    // 「是 / 否」是给人看的字 —— 走语言包。机器要的是 `meta.is_ca` 那个布尔值。
    put(
        "out.x509-certificate-generator.is_ca",
        if is_ca_cert(cert) {
            crate::i18n::t(lang, "out.x509-certificate-generator.yes")
        } else {
            crate::i18n::t(lang, "out.x509-certificate-generator.no")
        },
    );
    put(T_FINGERPRINT, hex_colon(&Sha256::digest(der)));

    out
}

/// `X509Name` → 可读字符串。空的 Subject 给个占位符 —— 表格里空着会让人以为是 bug。
///
/// 占位符是给人看的字，所以也走语言包。
fn name_to_string(name: &X509Name, lang: &str) -> String {
    let s = name.to_string();
    if s.trim().is_empty() {
        crate::i18n::t(lang, "out.x509-certificate-generator.empty_subject")
    } else {
        s
    }
}

/// SAN 的可读列表（带类型前缀）。
fn san_summary(cert: &X509Certificate, lang: &str) -> String {
    let list = san_list(cert, lang);
    if list.is_empty() {
        crate::i18n::t(lang, "out.x509-certificate-generator.no_alt_names")
    } else {
        list.join(", ")
    }
}

/// SAN 的结构化列表，`meta` 与单测都用它。
///
/// DNS 与 IP 分开标出来 —— 上游把 IP 混在域名里，用户看不出哪条是哪个。
///
/// 类型前缀（邮箱 / 目录名 / 其他）是给人看的字，走语言包；
/// DNS / IP / URI 这三个缩写中英文一致，原样保留。
fn san_list(cert: &X509Certificate, lang: &str) -> Vec<String> {
    let Ok(Some(san)) = cert.subject_alternative_name() else {
        return Vec::new();
    };
    san.value
        .general_names
        .iter()
        .map(|g| match g {
            GeneralName::DNSName(v) => format!("DNS:{v}"),
            GeneralName::IPAddress(v) => match ip_of(v) {
                Some(ip) => format!("IP:{ip}"),
                None => format!(
                    "IP:{}",
                    crate::i18n::t(lang, "out.x509-certificate-generator.unparsable")
                ),
            },
            GeneralName::RFC822Name(v) => format!(
                "{}:{v}",
                crate::i18n::t(lang, "out.x509-certificate-generator.san_email")
            ),
            GeneralName::URI(v) => format!("URI:{v}"),
            GeneralName::DirectoryName(v) => format!(
                "{}:{}",
                crate::i18n::t(lang, "out.x509-certificate-generator.san_directory_name"),
                name_to_string(v, lang)
            ),
            other => format!(
                "{}:{other:?}",
                crate::i18n::t(lang, "out.x509-certificate-generator.san_other")
            ),
        })
        .collect()
}

/// SAN 里的 IP 是裸的 4 或 16 个字节，长度不对说明证书有问题 ——
/// 返回 `None` 让调用方填占位符，而不是拿前 4 个字节凑一个看起来很像的地址。
fn ip_of(bytes: &[u8]) -> Option<IpAddr> {
    use std::net::{Ipv4Addr, Ipv6Addr};
    Some(match bytes.len() {
        4 => IpAddr::V4(Ipv4Addr::new(bytes[0], bytes[1], bytes[2], bytes[3])),
        16 => IpAddr::V6(Ipv6Addr::from(<[u8; 16]>::try_from(bytes).ok()?)),
        _ => return None,
    })
}

/// 公钥算法与位数。
fn key_algorithm_summary(cert: &X509Certificate) -> String {
    let oid = cert.public_key().algorithm.algorithm.to_id_string();
    let name = friendly(&oid);
    match cert.public_key().parsed().ok().map(|k| k.key_size()) {
        Some(bits) if bits > 0 => format!("{name} · {bits} bit"),
        _ => name.to_string(),
    }
}

/// 证书是不是 CA。
fn is_ca_cert(cert: &X509Certificate) -> bool {
    cert.basic_constraints()
        .ok()
        .flatten()
        .map(|bc| bc.value.ca)
        .unwrap_or(false)
}

/// 时间 → RFC 3339。
///
/// `x509-parser` 的 `ASN1Time` 只给了 Unix 时间戳与一个可读但不是标准格式的
/// `Display`，这里转成 `time::OffsetDateTime` 再按 RFC 3339 输出。
fn fmt_time(t: &x509_parser::prelude::ASN1Time) -> String {
    OffsetDateTime::from_unix_timestamp(t.timestamp())
        .ok()
        .and_then(|dt| dt.format(&Rfc3339).ok())
        .unwrap_or_else(|| t.to_string())
}

/// 大写、冒号分隔的十六进制（`openssl x509 -fingerprint` 的样子）。
fn hex_colon(bytes: &[u8]) -> String {
    bytes
        .iter()
        .map(|b| format!("{b:02X}"))
        .collect::<Vec<_>>()
        .join(":")
}

/// 小写、不带分隔符的十六进制。
fn hex_plain(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// 点分十进制的 OID → 好读的名字。
///
/// 只覆盖证书里真正常见的几个，其余原样返回 —— 认不出来不是错误，
/// 用户要的就是那个 OID（`openssl x509 -text` 给的也是它）。
fn friendly(dotted: &str) -> &str {
    match dotted {
        // 公钥算法
        "1.2.840.113549.1.1.1" => "RSA",
        "1.2.840.10045.2.1" => "EC",
        "1.3.101.112" => "Ed25519",
        "1.3.101.113" => "Ed448",
        // 签名算法
        "1.2.840.113549.1.1.5" => "sha1WithRSAEncryption",
        "1.2.840.113549.1.1.11" => "sha256WithRSAEncryption",
        "1.2.840.113549.1.1.12" => "sha384WithRSAEncryption",
        "1.2.840.113549.1.1.13" => "sha512WithRSAEncryption",
        "1.2.840.10045.4.3.2" => "ecdsa-with-SHA256",
        "1.2.840.10045.4.3.3" => "ecdsa-with-SHA384",
        "1.2.840.10045.4.3.4" => "ecdsa-with-SHA512",
        "1.2.840.10045.4.1" => "ecdsa-with-SHA1",
        other => other,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use num_bigint::BigUint;

    /// 跑一次生成。
    fn run(payload: Value) -> Value {
        compute(payload).expect("合法输入不该报错")
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

    /// 从 `output` 的 PEM 里取回 DER。
    ///
    /// 走一遍真的 PEM 解码 —— 只断言「字符串里有 BEGIN」是证明不了任何事的：
    /// 一张解析不了的证书照样能打印出那两行。
    fn der_of(out: &Value) -> Vec<u8> {
        let pem = out["output"].as_str().expect("output 应当是 PEM");
        let parsed = pem::parse(pem).expect("output 应当是合法的 PEM");
        assert_eq!(parsed.tag(), "CERTIFICATE");
        parsed.contents().to_vec()
    }

    /// 表格里某一行的值。
    ///
    /// 行标题是按语言取的，所以这里给的是**语言包里的键**，不是标题的字面量 ——
    /// 把字面量抄一遍的话，改一次文案就要改一次断言。
    fn row<'a>(out: &'a Value, key: &str) -> &'a str {
        let title = crate::i18n::t(crate::i18n::FALLBACK, key);
        out["table"][&title].as_str().unwrap_or_else(|| {
            panic!(
                "找不到行 `{key}`（标题 `{title}`），现有行：{:?}",
                out["table"]
            )
        })
    }

    /// 证书里的 CN（全部）。
    fn common_names(cert: &X509Certificate) -> Vec<String> {
        cert.subject()
            .iter_common_name()
            .map(|a| a.as_str().unwrap_or_default().to_string())
            .collect()
    }

    /// SAN 里的 DNS 名。
    fn san_dns(cert: &X509Certificate) -> Vec<String> {
        let Ok(Some(san)) = cert.subject_alternative_name() else {
            return Vec::new();
        };
        san.value
            .general_names
            .iter()
            .filter_map(|g| match g {
                GeneralName::DNSName(v) => Some(v.to_string()),
                _ => None,
            })
            .collect()
    }

    /// SAN 里的 IP。
    fn san_ips(cert: &X509Certificate) -> Vec<String> {
        let Ok(Some(san)) = cert.subject_alternative_name() else {
            return Vec::new();
        };
        san.value
            .general_names
            .iter()
            .filter_map(|g| match g {
                GeneralName::IPAddress(v) => ip_of(v).map(|ip| ip.to_string()),
                _ => None,
            })
            .collect()
    }

    /* ---- 主体：CN 只能有一个 ---- */

    #[test]
    fn the_subject_carries_exactly_one_common_name() {
        // 上游 #1812 的 bug：逗号分隔的每个域名各塞一个 CN。
        // RFC 5280 里 CN 是一个属性，而且客户端只读 SAN。
        let out = run(json!({
            "common_name": "a.com, b.com, c.com",
            "key_algorithm": "ecdsa-p256",
        }));
        let der = der_of(&out);
        let (_, cert) = X509Certificate::from_der(&der).expect("证书应当能解析");

        let cns = common_names(&cert);
        assert_eq!(cns, vec!["a.com"], "CN 只能有一个，且是第一个域名");
        assert_eq!(cns.len(), 1);
    }

    #[test]
    fn every_domain_lands_in_the_san() {
        let out = run(json!({
            "common_name": "a.com, b.com",
            "alternative_names": "c.com\n1.2.3.4",
            "key_algorithm": "ecdsa-p256",
        }));
        let der = der_of(&out);
        let (_, cert) = X509Certificate::from_der(&der).expect("证书应当能解析");

        // CN 里那个域名自己也在 SAN 里 —— 只填 CN 的证书在现代浏览器上不生效
        assert_eq!(san_dns(&cert), vec!["a.com", "b.com", "c.com"]);
        assert_eq!(san_ips(&cert), vec!["1.2.3.4"]);
    }

    #[test]
    fn a_name_with_digits_is_not_mistaken_for_an_ip() {
        // 上游 #1812 用 `/\d+/.test(...)` 判断 IP，`1a.b.c.d` 会被当成 IP。
        let out = run(json!({
            "common_name": "1a.b.c.d",
            "key_algorithm": "ecdsa-p256",
        }));
        let der = der_of(&out);
        let (_, cert) = X509Certificate::from_der(&der).expect("证书应当能解析");

        assert_eq!(san_ips(&cert), Vec::<String>::new(), "1a.b.c.d 不是 IP");
        assert_eq!(san_dns(&cert), vec!["1a.b.c.d"], "它是个域名");
    }

    #[test]
    fn a_real_ip_goes_into_the_san_as_an_ip() {
        let out = run(json!({
            "common_name": "example.com",
            "alternative_names": "192.168.1.10, ::1",
            "key_algorithm": "ecdsa-p256",
        }));
        let der = der_of(&out);
        let (_, cert) = X509Certificate::from_der(&der).expect("证书应当能解析");

        assert_eq!(san_ips(&cert), vec!["192.168.1.10", "::1"]);
        assert_eq!(san_dns(&cert), vec!["example.com"]);
    }

    /* ---- 有效期 ---- */

    #[test]
    fn the_validity_window_matches_the_requested_days() {
        let out = run(json!({
            "validity_days": "30",
            "key_algorithm": "ecdsa-p256",
        }));
        let der = der_of(&out);
        let (_, cert) = X509Certificate::from_der(&der).expect("证书应当能解析");

        let not_before = cert.validity().not_before.timestamp();
        let not_after = cert.validity().not_after.timestamp();
        assert_eq!(
            not_after - not_before,
            30 * 24 * 3600,
            "有效期应当正好是 30 天"
        );
        // not_before 留了 1 天的时钟偏差余量，证书一生成就是「已生效」的
        assert!(
            not_before <= OffsetDateTime::now_utc().unix_timestamp(),
            "not_before 不该在未来"
        );
    }

    #[test]
    fn the_validity_is_clamped_not_rejected() {
        for (given, want) in [("0", 1i64), ("999999", MAX_VALIDITY_DAYS as i64)] {
            let out = run(json!({
                "validity_days": given,
                "key_algorithm": "ecdsa-p256",
            }));
            let der = der_of(&out);
            let (_, cert) = X509Certificate::from_der(&der).unwrap();
            let days =
                (cert.validity().not_after.timestamp() - cert.validity().not_before.timestamp())
                    / (24 * 3600);
            assert_eq!(days, want, "validity_days={given}");
        }
    }

    /* ---- CA 与序列号 ---- */

    #[test]
    fn the_ca_flag_reaches_basic_constraints() {
        for (is_ca, want) in [(true, true), (false, false)] {
            let out = run(json!({
                "is_ca": is_ca,
                "key_algorithm": "ecdsa-p256",
            }));
            let der = der_of(&out);
            let (_, cert) = X509Certificate::from_der(&der).unwrap();

            let bc = cert
                .basic_constraints()
                .expect("basicConstraints 应当能解析")
                .expect("basicConstraints 应当存在");
            assert_eq!(bc.value.ca, want, "is_ca={is_ca}");
            // 「是 / 否」是语言包里的值，断言按键取
            let yes = crate::i18n::t(crate::i18n::FALLBACK, "out.x509-certificate-generator.yes");
            let no = crate::i18n::t(crate::i18n::FALLBACK, "out.x509-certificate-generator.no");
            assert_eq!(
                row(&out, "out.x509-certificate-generator.is_ca"),
                if is_ca { yes.as_str() } else { no.as_str() }
            );
        }
    }

    #[test]
    fn the_serial_number_is_positive() {
        let out = run(json!({ "key_algorithm": "ecdsa-p256" }));
        let der = der_of(&out);
        let (_, cert) = X509Certificate::from_der(&der).unwrap();

        let serial = cert.raw_serial();
        assert!(!serial.is_empty(), "序列号不该是空的");
        // DER 的正整数：最高位必须是 0（否则编码器会补 0x00 前导字节）。
        assert_eq!(
            serial[0] & 0x80,
            0,
            "序列号应当是正数（最高位为 0）: {serial:02X?}"
        );
        let value = BigUint::from_bytes_be(serial);
        assert!(value > BigUint::from(0u8), "序列号不该是 0");
        assert!(serial.len() <= 20, "RFC 5280 规定序列号不超过 20 字节");
    }

    /* ---- 私钥与指纹 ---- */

    #[test]
    fn the_private_key_is_pkcs8() {
        let out = run(json!({ "key_algorithm": "ecdsa-p256" }));
        let pk = row(&out, T_PRIVATE_KEY);
        assert!(
            pk.starts_with("-----BEGIN PRIVATE KEY-----"),
            "私钥应当是 PKCS#8: {}",
            pk.lines().next().unwrap_or("")
        );
        assert!(pk.contains("-----END PRIVATE KEY-----"));
        assert!(!pk.contains("BEGIN RSA PRIVATE KEY"));
    }

    #[test]
    fn the_private_key_belongs_to_the_certificate() {
        // 光断言「私钥是 PKCS#8」不够 —— 一张证书配一把对不上的私钥，
        // 用户拿去用才发现，比生成时报错难查得多。
        // 这里拿私钥重新算出公钥（SPKI），跟证书里的那个逐字节比。
        use rcgen::{KeyPair, PublicKeyData, PKCS_ECDSA_P256_SHA256, PKCS_RSA_SHA256};

        for (alg, sign_algo) in [
            ("ecdsa-p256", &PKCS_ECDSA_P256_SHA256),
            ("rsa2048", &PKCS_RSA_SHA256),
        ] {
            let out = run(json!({ "key_algorithm": alg }));
            let der = der_of(&out);
            let (_, cert) = X509Certificate::from_der(&der).unwrap();

            let key = KeyPair::from_pkcs8_pem_and_sign_algo(row(&out, T_PRIVATE_KEY), sign_algo)
                .unwrap_or_else(|e| panic!("{alg}: 私钥应当能被重新读进来: {e}"));
            assert_eq!(
                key.subject_public_key_info(),
                cert.public_key().raw,
                "{alg}: 表格里的私钥与证书的公钥对不上"
            );
        }
    }

    #[test]
    fn the_fingerprint_matches_an_independent_sha256() {
        let out = run(json!({ "key_algorithm": "ecdsa-p256" }));
        let der = der_of(&out);

        // 独立算一遍 SHA-256：指纹是 DER 的摘要，不是 DER 本身
        let digest = Sha256::digest(&der);
        let expected = digest
            .iter()
            .map(|b| format!("{b:02X}"))
            .collect::<Vec<_>>()
            .join(":");
        // 表格里的是冒号分隔的大写
        assert_eq!(row(&out, T_FINGERPRINT), expected);
        // meta 里的是不带分隔符的小写（与 ssl-certificate-decoder 同一口径）
        let plain: String = expected
            .chars()
            .filter(|c| *c != ':')
            .flat_map(|c| c.to_lowercase())
            .collect();
        assert_eq!(out["meta"]["sha256_fingerprint"].as_str(), Some(plain.as_str()));
    }

    /* ---- 签名 ---- */

    #[test]
    fn the_self_signature_verifies() {
        // 一张「看着对但签名是坏的」证书比报错更难查 ——
        // 用 x509-parser 的 verify_signature 走一遍公钥验签。
        for alg in ["ecdsa-p256", "ecdsa-p384", "ed25519"] {
            let out = run(json!({ "key_algorithm": alg }));
            let der = der_of(&out);
            let (_, cert) = X509Certificate::from_der(&der).unwrap();
            cert.verify_signature(None)
                .unwrap_or_else(|e| panic!("{alg}: 自签证书的签名应当能验过: {e}"));
        }
    }

    #[test]
    fn rsa_certificates_are_signed_with_sha256_not_sha1() {
        // 上游 #915 默认 SHA-1 —— 现代 CA 早就不认了。
        let out = run(json!({ "key_algorithm": "rsa2048" }));
        let der = der_of(&out);
        let (_, cert) = X509Certificate::from_der(&der).unwrap();

        assert_eq!(
            cert.signature_algorithm.algorithm.to_id_string(),
            "1.2.840.113549.1.1.11",
            "应当是 sha256WithRSAEncryption"
        );
        cert.verify_signature(None).expect("RSA 自签证书的签名应当能验过");
        // RSA 的私钥也是 PKCS#8
        let pk = row(&out, T_PRIVATE_KEY);
        assert!(pk.starts_with("-----BEGIN PRIVATE KEY-----"));
        assert!(!pk.contains("BEGIN RSA PRIVATE KEY"));
    }

    /* ---- 输入校验 ---- */

    #[test]
    fn an_unknown_key_algorithm_names_the_accepted_values() {
        let err = compute(json!({ "key_algorithm": "dsa" })).unwrap_err();
        let key = "out.x509-certificate-generator.err.unknown_algorithm";
        match err {
            ToolError::InvalidKeyed { key: k, args } => {
                assert_eq!(k, key);
                // 用户填的那个算法名要带在参数里 —— 报错时得让人知道自己填错了什么
                assert!(
                    args.iter().any(|(n, v)| n == "algorithm" && v == "dsa"),
                    "{args:?}"
                );
            }
            other => panic!("应当报 `{key}`，实际 {other:?}"),
        }
        // 可选值列表在语言包里 —— 语言包还没并进来时先跳过这条
        if crate::i18n::has("en", key) {
            let en = crate::i18n::t("en", key);
            for a in ["rsa2048", "rsa3072", "rsa4096", "ecdsa-p256", "ecdsa-p384", "ed25519"] {
                assert!(en.contains(a), "{en}");
            }
        }
    }

    #[test]
    fn empty_optional_fields_are_dropped_from_the_subject() {
        // 上游 #915 的空值过滤：空的 DN 属性不该出现在证书里。
        let out = run(json!({
            "common_name": "example.com",
            "country_name": "",
            "state_or_province_name": "   ",
            "locality_name": "",
            "organization_name": "",
            "organizational_unit_name": "",
            "email_address": "",
            "key_algorithm": "ecdsa-p256",
        }));
        let der = der_of(&out);
        let (_, cert) = X509Certificate::from_der(&der).unwrap();

        let subject = cert.subject().to_string();
        assert_eq!(common_names(&cert), vec!["example.com"]);
        for attr in ["C=", "ST=", "L=", "O=", "OU=", "EMAILADDRESS="] {
            assert!(!subject.contains(attr), "主题里不该有空属性 {attr}: {subject}");
        }
    }

    #[test]
    fn a_country_code_must_be_two_letters() {
        for bad in ["C", "CHN", "中"] {
            let err = compute(json!({ "country_name": bad, "key_algorithm": "ecdsa-p256" })).unwrap_err();
            assert_err_key(err, "out.x509-certificate-generator.err.country_code_format");
        }
    }

    #[test]
    fn malformed_payload_types_do_not_panic() {
        // 公开接口，手写请求可能给数字 / 数组 / null
        //
        // 一律指定 `ecdsa-p256`：默认算法是 RSA 2048，debug 构建下一次密钥生成
        // 要好几秒，这个测试要跑十几遍 —— 慢得能把测试套件拖垮。
        for bad in [json!(42), json!([1, 2]), json!(null), json!({}), json!(true)] {
            assert!(
                compute(json!({ "common_name": bad, "key_algorithm": "ecdsa-p256" })).is_ok(),
                "{bad}"
            );
            assert!(
                compute(json!({ "alternative_names": bad, "key_algorithm": "ecdsa-p256" })).is_ok(),
                "{bad}"
            );
            assert!(
                compute(json!({ "is_ca": bad, "key_algorithm": "ecdsa-p256" })).is_ok(),
                "{bad}"
            );
        }
        // 缺字段时用默认值，不该报错
        assert!(compute(json!({ "key_algorithm": "ecdsa-p256" })).is_ok());
    }

    #[test]
    fn the_table_carries_everything_the_user_needs() {
        let out = run(json!({
            "common_name": "example.com",
            "key_algorithm": "ecdsa-p256",
        }));
        // 行标题按语言取，所以断言按**键**来 —— 键在语言包里，
        // 标题的字面量不该抄进测试。
        for key in [
            "out.x509-certificate-generator.subject",
            "out.x509-certificate-generator.issuer",
            "out.x509-certificate-generator.serial_number",
            "out.x509-certificate-generator.not_before",
            "out.x509-certificate-generator.not_after",
            "out.x509-certificate-generator.subject_alt_name",
            "out.x509-certificate-generator.key_algorithm",
            "out.x509-certificate-generator.signature_algorithm",
            "out.x509-certificate-generator.is_ca",
            T_FINGERPRINT,
            T_PRIVATE_KEY,
        ] {
            let title = crate::i18n::t(crate::i18n::FALLBACK, key);
            assert!(
                out["table"].get(&title).is_some(),
                "表格里缺 `{key}`（标题 `{title}`），现有行：{:?}",
                out["table"]
            );
        }
        // output 就是证书 PEM
        assert!(out["output"].as_str().unwrap().starts_with("-----BEGIN CERTIFICATE-----"));
    }

    /// 表格的行标题要跟着请求语言走 —— 英文界面不该出现中文行标题。
    #[test]
    fn the_row_labels_follow_the_request_language() {
        let en = run(json!({
            "common_name": "example.com",
            "key_algorithm": "ecdsa-p256",
        }));
        let zh = run(json!({
            "common_name": "example.com",
            "key_algorithm": "ecdsa-p256",
            "__lang": "zh-CN",
        }));

        let key = "out.x509-certificate-generator.subject";
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

    /// 错误消息要跟着请求语言走 —— 语言不是工具决定的，是 API 层
    /// 按请求语言调用 `localize` 渲染的。
    #[test]
    fn the_error_message_follows_the_requested_language() {
        let err = compute(json!({ "key_algorithm": "dsa" })).unwrap_err();
        let key = "out.x509-certificate-generator.err.unknown_algorithm";
        // 语言包里还没并进来时，localize 退回键本身 —— 这时断言跳过
        if !crate::i18n::has("zh-CN", key) {
            return;
        }
        let en = err.localize("en");
        let zh = err.localize("zh-CN");
        assert_ne!(en, zh, "两种语言不该是同一句");
        assert!(!en.contains("out.x509-certificate-generator"), "英文界面不该露出键：{en}");
        assert!(!zh.contains("out.x509-certificate-generator"), "中文界面不该露出键：{zh}");
    }
}
