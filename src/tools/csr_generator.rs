//! CSR（证书签名请求）生成器（endpoint `csr-generator`）。
//!
//! 上游是 it-tools PR #910 的 `generateCSR`（node-forge）：生成一对 RSA 密钥，
//! 填好主体，用这把密钥给 CSR 签名，最后给出 CSR PEM、公钥 PEM 与私钥 PEM。
//!
//! ## 为什么放服务端
//!
//! - **密钥生成是 CPU 密集的**，耗时随位长爆炸：4096 位 RSA 要好几秒。上游把它
//!   丢进 Web Worker（免得主线程卡住），我们这边对应的是丢进 actix 的 blocking
//!   线程池（见 [`util::blocking`]）—— 直接在 actix worker 上算，会把那个 worker
//!   上的所有请求一起堵住。
//! - 浏览器也造不出 PKCS#10 那个结构：WebCrypto 的 `generateKey` 只能造出密钥，
//!   CSR 的 ASN.1 仍得自己拼。
//!
//! ## 口径
//!
//! - **签名算法用 SHA-256**。上游的 node-forge `csr.sign()` 默认签 SHA-1，
//!   而 SHA-1 早就进了各大 CA 的拒绝名单。RSA 走 `PKCS_RSA_SHA256`（PKCS#1 v1.5），
//!   ECDSA P-256 走 SHA-256、P-384 走 SHA-384，Ed25519 没有单独的摘要步骤。
//! - **主体里只放用户填了的字段** —— 这是上游那句
//!   `.filter(attr => attr.value !== null && attr.value?.trim() !== '')` 的语义：
//!   空的 `O=` 会编出畸形的 DN，多数 CA 直接拒收。
//! - **私钥以明文 PKCS#8 给出**，本版不支持口令加密（原因见下一节）。
//! - **CN 也会进 SAN**（当它像个主机名时）。CA/B Forum 从 2017 年起就要求所有
//!   域名必须出现在 SAN 里、CN 只当标签看 —— CN 不在 SAN 里的证书，浏览器一样拒。
//!
//! ## 为什么没有「口令加密的私钥」
//!
//! 上游支持 `pki.encryptRsaPrivateKey(privateKey, password)`。但 **rcgen 0.14.10
//! 没有这个能力**：`KeyPair` 只有 `serialize_pem()`，没有
//! `serialize_pem_with_passphrase`（那是更后面的 rcgen 版本才加的）。
//! 自己手写 PKCS#5 加密意味着要自己实现 PBKDF2 + AES-CBC + PEM 头，
//! 稍有偏差就会给用户一把「连自己都解不开的私钥」。
//! 所以这一版干脆不给口令字段：私钥明文给出，界面与结果里都写清楚
//! 「请自行妥善保管」。
//!
//! ## 与上游的差别
//!
//! | | 上游（node-forge） | 这里 |
//! |---|---|---|
//! | 签名算法 | SHA-1（node-forge 默认） | SHA-256 |
//! | 密钥算法 | 只有 RSA | RSA 2048/3072/4096 + ECDSA P-256/P-384 + Ed25519 |
//! | 多域名 | 不支持（只有 CN） | 第一个名字进 CN，其余进 SAN；CN 本身也进 SAN |
//! | IP 地址 | 不支持 | `IpAddr::from_str` 真解析，编成 IP SAN |
//! | 口令加密私钥 | 支持 | 不支持（rcgen 0.14 没有这个 API） |
//! | 跑在哪 | 浏览器主线程（+ Web Worker） | 服务端 blocking 线程池 |

use std::net::IpAddr;
use std::str::FromStr;

use rcgen::string::Ia5String;
use rcgen::{CertificateParams, DistinguishedName, DnType, DnValue, SanType};
use serde_json::{json, Map, Value};

use super::pki::{self, KeyAlgorithm};
use super::{util, ToolError, ToolResult};

/// 注册表 `ApiField { name: "key_algorithm", default: Some("rsa2048") }` 的默认值。
const DEFAULT_KEY_ALGORITHM: &str = "rsa2048";

/// `emailAddress` 的 OID：1.2.840.113549.1.9.1。
///
/// rcgen 0.14.10 的 `DnType` **没有** `EmailAddress` 这个变体（只有 CountryName /
/// LocalityName / StateOrProvinceName / OrganizationName / OrganizationalUnitName /
/// CommonName），所以只能按自定义 OID 写 —— rcgen 自己的测试也是这么写的。
const OID_EMAIL_ADDRESS: &[u64] = &[1, 2, 840, 113549, 1, 9, 1];

/// 主体里除 CN 之外的字段，顺序跟上游（node-forge 的 `setSubject`）一致。
///
/// 三元组是 `(表单字段名, DnType, DN 摘要里的短名)`。
const SUBJECT_FIELDS: &[(&str, DnType, &str)] = &[
    ("country_name", DnType::CountryName, "C"),
    ("state_or_province_name", DnType::StateOrProvinceName, "ST"),
    ("locality_name", DnType::LocalityName, "L"),
    ("organization_name", DnType::OrganizationName, "O"),
    (
        "organizational_unit_name",
        DnType::OrganizationalUnitName,
        "OU",
    ),
];

/// 备用名称（SAN）里的一项。
#[derive(Debug, Clone, PartialEq, Eq)]
enum Name {
    /// DNS 名（`dNSName`）
    Dns(String),
    /// IP 地址（`iPAddress`）
    Ip(IpAddr),
}

impl Name {
    /// 表里展示的样子：`DNS:example.com` / `IP:192.0.2.1`
    fn label(&self) -> String {
        match self {
            Name::Dns(dns) => format!("DNS:{dns}"),
            Name::Ip(ip) => format!("IP:{ip}"),
        }
    }
}

/// 见 [`util::blocking`]。
pub async fn handle(payload: Value) -> ToolResult {
    util::blocking(move || compute(payload)).await
}

fn compute(payload: Value) -> ToolResult {
    let alg_value = util::str_or(&payload, "key_algorithm", DEFAULT_KEY_ALGORITHM);
    let alg = KeyAlgorithm::from_value(alg_value).ok_or_else(|| {
        // 文案在语言包里 —— 英文界面下不能露中文。
        ToolError::invalid(
            "out.csr-generator.err.unknown_algorithm",
            &[("algorithm", alg_value)],
        )
    })?;

    // 备用名称：逗号 / 分号 / 空白 / 换行都当分隔符（`pki::split_list`）
    let alt_input = util::opt_str(&payload, "alternative_names").unwrap_or("");
    let mut rest: Vec<String> = pki::split_list(alt_input);

    // CN：填了就用填的；没填就用备用名称里的第一个。
    // 「第一个进 CN、其余进 SAN」这条口径在这里落地。
    let cn_input = util::opt_str(&payload, "common_name").unwrap_or("").trim();
    let common_name = if cn_input.is_empty() {
        if rest.is_empty() {
            return Err(ToolError::invalid(
                "out.csr-generator.err.missing_common_name",
                &[("field", "common_name")],
            ));
        }
        rest.remove(0)
    } else {
        cn_input.to_string()
    };

    // 组装主体。**只放用户填了的字段** —— 空的 `O=` 会编出畸形的 DN。
    let mut dn = DistinguishedName::new();
    let mut summary: Vec<String> = Vec::new();

    dn.push(DnType::CommonName, common_name.clone());
    summary.push(format!("CN={common_name}"));

    for (field, dn_type, short) in SUBJECT_FIELDS {
        let value = util::opt_str(&payload, field).unwrap_or("").trim();
        if value.is_empty() {
            continue;
        }
        dn.push(dn_type.clone(), value.to_string());
        summary.push(format!("{short}={value}"));
    }

    // emailAddress 按 RFC 5280 应当是 IA5String，rcgen 的 `DnType` 里没有现成的
    // 变体，用自定义 OID + IA5String 值。
    let email = util::opt_str(&payload, "email_address")
        .unwrap_or("")
        .trim();
    if !email.is_empty() {
        let ia5 = Ia5String::try_from(email).map_err(|_| {
            ToolError::invalid(
                "out.csr-generator.err.email_not_ascii",
                &[("email", email)],
            )
        })?;
        dn.push(
            DnType::CustomDnType(OID_EMAIL_ADDRESS.to_vec()),
            DnValue::Ia5String(ia5),
        );
        summary.push(format!("E={email}"));
    }

    // 组装备用名称。CN 自己先进去（它多半就是个域名），其余名字跟在后面。
    let mut sans: Vec<Name> = Vec::new();
    if let Some(name) = host_name(&common_name) {
        sans.push(name);
    }
    for raw in &rest {
        let name = parse_san(raw)?;
        if !sans.contains(&name) {
            sans.push(name);
        }
    }

    let mut params = CertificateParams::default();
    // `CertificateParams::default()` 会往 DN 里塞一个
    // `CN=rcgen self signed cert` —— 必须清掉，否则 DN 里会有两个 CN，
    // 其中一个还是那句占位文案。
    params.distinguished_name = dn;
    params.subject_alt_names = sans
        .iter()
        .map(to_san)
        .collect::<Result<Vec<_>, ToolError>>()?;

    let key = pki::generate(alg).map_err(|e| ToolError::Internal(format!("生成密钥失败: {e}")))?;

    let csr = params
        .serialize_request(&key.key_pair)
        .map_err(|e| ToolError::Internal(format!("生成 CSR 失败: {e}")))?;
    let csr_pem = csr
        .pem()
        .map_err(|e| ToolError::Internal(format!("CSR 编码成 PEM 失败: {e}")))?;

    // 公钥用 SPKI（`-----BEGIN PUBLIC KEY-----`）—— 上游 node-forge 的
    // `pki.publicKeyToPem` 输出的也是这个格式，`openssl` 与浏览器都认。
    let public_key_pem = key.key_pair.public_key_pem();

    // 结果区里**给人看的字**走语言包（行标题、成句的值）；
    // 机器可读的值原样保留（主体摘要、SAN 列表、算法名、签名算法名、两段 PEM）。
    let lang = util::lang(&payload);
    let mut table = Map::new();
    util::row(
        &mut table,
        &payload,
        "out.csr-generator.subject",
        json!(summary.join(", ")),
    );
    util::row(
        &mut table,
        &payload,
        "out.csr-generator.subject_alternative_name",
        json!(if sans.is_empty() {
            // CN 是个「标签」而不是主机名、用户又没填备用名称时，SAN 真的会是空的
            crate::i18n::t(lang, "out.csr-generator.no_san")
        } else {
            sans.iter().map(Name::label).collect::<Vec<_>>().join(", ")
        }),
    );
    util::row(
        &mut table,
        &payload,
        "out.csr-generator.key_algorithm",
        json!(alg.label()),
    );
    util::row(
        &mut table,
        &payload,
        "out.csr-generator.signature_algorithm",
        json!(signature_algorithm(alg)),
    );
    util::row(
        &mut table,
        &payload,
        "out.csr-generator.public_key",
        json!(public_key_pem),
    );
    util::row(
        &mut table,
        &payload,
        "out.csr-generator.private_key",
        json!(key.private_key_pem.clone()),
    );
    util::row(
        &mut table,
        &payload,
        "out.csr-generator.note",
        json!(crate::i18n::t(lang, "out.csr-generator.private_key_note")),
    );

    Ok(json!({
        "output": csr_pem,
        "table": table,
        "meta": {
            "key_algorithm": alg_value,
            "signature_algorithm": signature_algorithm(alg),
            "common_name": common_name,
            "dns_names": sans
                .iter()
                .filter_map(|n| match n {
                    Name::Dns(dns) => Some(dns.clone()),
                    Name::Ip(_) => None,
                })
                .collect::<Vec<_>>(),
            "ip_addresses": sans
                .iter()
                .filter_map(|n| match n {
                    Name::Ip(ip) => Some(ip.to_string()),
                    Name::Dns(_) => None,
                })
                .collect::<Vec<_>>(),
            "private_key_encrypted": false,
            "generated_at": chrono::Utc::now().to_rfc3339(),
        }
    }))
}

/// 把一条用户输入的名字解析成 SAN 的一项。
///
/// **IP 是真解析的**（`IpAddr::from_str`），不是拿正则猜的 —— 正则分不清
/// `1.2.3.4` 与 `1.2.3.4.example.com`，而 `IpAddr::from_str` 不会。
fn parse_san(raw: &str) -> Result<Name, ToolError> {
    let s = raw.trim();
    if s.is_empty() {
        return Err(ToolError::invalid(
            "out.csr-generator.err.empty_alternative_name",
            &[],
        ));
    }
    if let Ok(ip) = IpAddr::from_str(s) {
        return Ok(Name::Ip(ip));
    }
    // 带冒号却又不是合法 IP —— 多半是想写 IPv6 却写错了。
    // 当成 DNS 名编进去会得到一个毫无意义的 SAN，还是当场报错。
    if s.contains(':') {
        return Err(ToolError::invalid(
            "out.csr-generator.err.invalid_ipv6",
            &[("value", s)],
        ));
    }
    // DNS 的 SAN 只能是 IA5String（非 ASCII 直接拒绝）。
    if !s.is_ascii() {
        return Err(ToolError::invalid(
            "out.csr-generator.err.non_ascii_dns_name",
            &[("name", s)],
        ));
    }
    Ok(Name::Dns(s.to_string()))
}

/// 判断一个字符串「像不像主机名」，像才把它当 DNS 名编进 SAN。
///
/// 这是给 CN 用的：CN 常常是「Example Inc.」这种**标签**而不是域名，
/// 把标签塞进 SAN 会让 CA 那边多出一个非法的 DNS 名。判据是
/// 「只由字母数字与 `-` `.` `_` `*` 组成」—— 覆盖 `example.com`、
/// `*.example.com`、`localhost`，也排除带空格的 `Example Inc.` 与中文名。
fn host_name(s: &str) -> Option<Name> {
    let s = s.trim();
    if s.is_empty() {
        return None;
    }
    if let Ok(ip) = IpAddr::from_str(s) {
        return Some(Name::Ip(ip));
    }
    let looks_like_host = s
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '.' | '_' | '*'));
    if !looks_like_host {
        return None;
    }
    Some(Name::Dns(s.to_string()))
}

/// 把一项名字变成 rcgen 的 `SanType`。
fn to_san(name: &Name) -> Result<SanType, ToolError> {
    match name {
        Name::Ip(ip) => Ok(SanType::IpAddress(*ip)),
        Name::Dns(dns) => {
            let ia5 = Ia5String::try_from(dns.as_str()).map_err(|_| {
                ToolError::invalid(
                    "out.csr-generator.err.invalid_dns_name",
                    &[("name", dns.as_str())],
                )
            })?;
            Ok(SanType::DnsName(ia5))
        }
    }
}

/// 这个工具实际用的签名算法。
///
/// 与 `pki::generate` 内部选的一致：RSA 一律 `PKCS_RSA_SHA256`，ECDSA 按曲线
/// 走 SHA-256 / SHA-384，Ed25519 没有单独的摘要步骤。
fn signature_algorithm(alg: KeyAlgorithm) -> &'static str {
    match alg {
        KeyAlgorithm::Rsa2048 | KeyAlgorithm::Rsa3072 | KeyAlgorithm::Rsa4096 => {
            "SHA-256 with RSA (PKCS#1 v1.5)"
        }
        KeyAlgorithm::EcdsaP256 => "SHA-256 with ECDSA (P-256)",
        KeyAlgorithm::EcdsaP384 => "SHA-384 with ECDSA (P-384)",
        KeyAlgorithm::Ed25519 => "Ed25519",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use x509_parser::certification_request::X509CertificationRequest;
    use x509_parser::extensions::GeneralName;
    use x509_parser::prelude::{FromDer, ParsedExtension};

    /// CN 的 OID：2.5.4.3
    const OID_COMMON_NAME: &str = "2.5.4.3";
    /// emailAddress 的 OID：1.2.840.113549.1.9.1
    const OID_EMAIL: &str = "1.2.840.113549.1.9.1";

    /// 结果表的行标题是按语言包取的，断言时按同样的方式取标题 ——
    /// 把标题的字面量抄一遍的话，改一次文案就要改一次断言。
    fn label(key: &str) -> String {
        crate::i18n::t(crate::i18n::FALLBACK, key)
    }

    /// 把 PEM 拆回 DER，再交给 x509-parser。
    ///
    /// 解析回来是这些单测的重点：只断言「字符串里有 BEGIN」的话，
    /// 一张**签名是坏的** CSR 也能通过那种检查 —— 而「签名对不对」恰恰是
    /// 用户把 CSR 交给 CA 之后才会发现的事。
    ///
    /// 用闭包而不是返回解析结果：`X509CertificationRequest` 借用 DER，
    /// 而 DER 是这里的局部变量，返回出去就成了悬垂引用。
    fn with_csr<R>(pem: &str, f: impl FnOnce(&X509CertificationRequest<'_>) -> R) -> R {
        let parsed = pem::parse(pem).expect("CSR 应当是合法的 PEM");
        let der = parsed.contents().to_vec();
        let (_, csr) = X509CertificationRequest::from_der(&der).expect("CSR 应当能被解析");
        f(&csr)
    }

    /// 取主体里某个 OID 的全部值。
    fn subject_values(csr: &X509CertificationRequest<'_>, oid: &str) -> Vec<String> {
        csr.certification_request_info
            .subject
            .iter_attributes()
            .filter(|attr| attr.attr_type().to_id_string() == oid)
            .filter_map(|attr| attr.as_str().ok().map(str::to_owned))
            .collect()
    }

    /// 取 SAN 里的 DNS 名。
    fn san_dns(csr: &X509CertificationRequest<'_>) -> Vec<String> {
        san_names(csr)
            .into_iter()
            .filter_map(|name| match name {
                GeneralName::DNSName(dns) => Some(dns.to_owned()),
                _ => None,
            })
            .collect()
    }

    /// 取 SAN 里的 IP 地址。
    ///
    /// `GeneralName::IPAddress` 给的是**字节**（4 字节 IPv4、16 字节 IPv6），
    /// 这里还原成点分十进制再比字符串。
    fn san_ips(csr: &X509CertificationRequest<'_>) -> Vec<String> {
        san_names(csr)
            .into_iter()
            .filter_map(|name| match name {
                GeneralName::IPAddress(bytes) => Some(match bytes.len() {
                    4 => {
                        let mut v4 = [0u8; 4];
                        v4.copy_from_slice(bytes);
                        IpAddr::from(v4).to_string()
                    }
                    16 => {
                        let mut v6 = [0u8; 16];
                        v6.copy_from_slice(bytes);
                        IpAddr::from(v6).to_string()
                    }
                    // x509-parser 只会给出 4 或 16 字节；别的长度不认
                    _ => return None,
                }),
                _ => None,
            })
            .collect()
    }

    /// SAN 扩展里的全部名字。
    fn san_names<'b>(csr: &'b X509CertificationRequest<'_>) -> Vec<GeneralName<'b>> {
        csr.requested_extensions()
            .map(|exts| {
                exts.filter_map(|ext| match ext {
                    ParsedExtension::SubjectAlternativeName(san) => Some(san.general_names.clone()),
                    _ => None,
                })
                .flatten()
                .collect()
            })
            .unwrap_or_default()
    }

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

    /// 大部分单测用 ECDSA P-256 而不是默认的 RSA 2048。
    ///
    /// 不是为了快而牺牲覆盖面：RSA 那条路径由
    /// `every_key_algorithm_produces_a_verifiable_csr` 与
    /// `the_private_key_is_pkcs8_and_the_public_key_is_spki` 单独兜住。
    /// dev profile 未优化时一次 RSA 2048 要两三秒，十几个用例加起来就是半分钟。
    const FAST_ALG: &str = "ecdsa-p256";

    /// 跑一次 `compute`，并把 `key_algorithm` 换成快的那个（除非用例自己指定了）。
    fn run_fast(mut payload: Value) -> Value {
        if let Some(map) = payload.as_object_mut() {
            map.entry("key_algorithm")
                .or_insert_with(|| json!(FAST_ALG));
        }
        compute(payload).expect("合法输入不该报错")
    }

    #[test]
    fn the_csr_round_trips_through_x509_parser_and_the_signature_verifies() {
        let out = run(json!({
            "common_name": "example.com",
            "organization_name": "Example Inc.",
            "key_algorithm": "ecdsa-p256",
        }));
        let pem = out["output"].as_str().unwrap();
        assert!(
            pem.starts_with("-----BEGIN CERTIFICATE REQUEST-----"),
            "{pem}"
        );

        with_csr(pem, |csr| {
            // 签名必须验得过 —— 一张「看着对但签名是坏的」 CSR 交给 CA 才会被拒
            csr.verify_signature().expect("CSR 的签名应当验得过");

            // CN 只有一个，且就是输入的那个
            let cn = subject_values(csr, OID_COMMON_NAME);
            assert_eq!(cn, vec!["example.com".to_string()]);
            // O 也进去了
            assert_eq!(
                subject_values(csr, "2.5.4.10"),
                vec!["Example Inc.".to_string()]
            );
        });
    }

    #[test]
    fn every_key_algorithm_produces_a_verifiable_csr() {
        // 每种算法都要能签、能验 —— `pki::generate` 换算法时最容易漏掉的是
        // 「密钥生成成功但 CSR 签名用的算法对不上」
        for alg in ["rsa2048", "ecdsa-p256", "ecdsa-p384", "ed25519"] {
            let out = run(json!({
                "common_name": "example.com",
                "key_algorithm": alg,
            }));
            let pem = out["output"].as_str().unwrap();
            with_csr(pem, |csr| {
                csr.verify_signature()
                    .unwrap_or_else(|e| panic!("{alg}: 签名验不过: {e}"));
                assert_eq!(
                    subject_values(csr, OID_COMMON_NAME),
                    vec!["example.com".to_string()],
                    "{alg}"
                );
            });
        }
    }

    #[test]
    fn the_private_key_is_pkcs8_and_the_public_key_is_spki() {
        let out = run(json!({ "common_name": "example.com" }));
        let private_pem = out["table"][&label("out.csr-generator.private_key")]
            .as_str()
            .unwrap();
        assert!(
            private_pem.starts_with("-----BEGIN PRIVATE KEY-----"),
            "私钥应当是 PKCS#8: {}",
            private_pem.lines().next().unwrap_or("")
        );
        assert!(private_pem.contains("-----END PRIVATE KEY-----"));
        assert!(!private_pem.contains("BEGIN RSA PRIVATE KEY"));

        let public_pem = out["table"][&label("out.csr-generator.public_key")]
            .as_str()
            .unwrap();
        assert!(
            public_pem.starts_with("-----BEGIN PUBLIC KEY-----"),
            "公钥应当是 SPKI: {}",
            public_pem.lines().next().unwrap_or("")
        );
        assert!(public_pem.contains("-----END PUBLIC KEY-----"));
    }

    #[test]
    fn extra_domains_and_ips_land_in_the_san() {
        let out = run_fast(json!({
            "common_name": "example.com",
            "alternative_names": "www.example.com, api.example.com\n192.0.2.10, 2001:db8::1",
        }));
        let pem = out["output"].as_str().unwrap();
        with_csr(pem, |csr| {
            csr.verify_signature().expect("签名应当验得过");

            let dns = san_dns(csr);
            assert!(dns.contains(&"example.com".to_string()), "{dns:?}");
            assert!(dns.contains(&"www.example.com".to_string()), "{dns:?}");
            assert!(dns.contains(&"api.example.com".to_string()), "{dns:?}");

            let ips = san_ips(csr);
            assert!(ips.contains(&"192.0.2.10".to_string()), "{ips:?}");
            assert!(ips.contains(&"2001:db8::1".to_string()), "{ips:?}");

            // DNS 与 IP 得分开 —— IP 不能被当成 DNS 名编出去
            assert!(!dns.contains(&"192.0.2.10".to_string()), "{dns:?}");
        });
    }

    #[test]
    fn the_first_name_becomes_the_cn_when_the_cn_field_is_left_empty() {
        let out = run_fast(json!({
            "common_name": "",
            "alternative_names": "first.example.com, second.example.com",
        }));
        let pem = out["output"].as_str().unwrap();
        with_csr(pem, |csr| {
            assert_eq!(
                subject_values(csr, OID_COMMON_NAME),
                vec!["first.example.com".to_string()]
            );
            let dns = san_dns(csr);
            assert!(dns.contains(&"first.example.com".to_string()), "{dns:?}");
            assert!(dns.contains(&"second.example.com".to_string()), "{dns:?}");
        });
    }

    #[test]
    fn empty_subject_fields_are_not_encoded_into_the_dn() {
        // 上游那句 `.filter(attr => attr.value !== null && attr.value?.trim() !== '')`
        // 的语义：空的 O= 会编出畸形的 DN
        let out = run_fast(json!({
            "common_name": "example.com",
            "organization_name": "",
            "organizational_unit_name": "   ",
            "country_name": "",
            "locality_name": "",
            "state_or_province_name": "",
            "email_address": "",
        }));
        let pem = out["output"].as_str().unwrap();
        with_csr(pem, |csr| {
            for oid in [
                "2.5.4.6", "2.5.4.8", "2.5.4.7", "2.5.4.10", "2.5.4.11", OID_EMAIL,
            ] {
                assert!(
                    subject_values(csr, oid).is_empty(),
                    "{oid} 不该出现在 DN 里: {:?}",
                    subject_values(csr, oid)
                );
            }
            // DN 里只有 CN 一个条目
            assert_eq!(
                csr.certification_request_info
                    .subject
                    .iter_attributes()
                    .count(),
                1
            );
        });
    }

    #[test]
    fn a_filled_subject_is_encoded_and_empty_ones_are_dropped() {
        let out = run_fast(json!({
            "common_name": "example.com",
            "organization_name": "Example Inc.",
            "organizational_unit_name": "Ops",
            "country_name": "CN",
            "locality_name": "Shanghai",
            "state_or_province_name": "Shanghai",
            "email_address": "ops@example.com",
        }));
        let pem = out["output"].as_str().unwrap();
        with_csr(pem, |csr| {
            assert_eq!(subject_values(csr, OID_COMMON_NAME), vec!["example.com"]);
            assert_eq!(subject_values(csr, "2.5.4.10"), vec!["Example Inc."]);
            assert_eq!(subject_values(csr, "2.5.4.11"), vec!["Ops"]);
            assert_eq!(subject_values(csr, "2.5.4.6"), vec!["CN"]);
            assert_eq!(subject_values(csr, "2.5.4.7"), vec!["Shanghai"]);
            assert_eq!(subject_values(csr, "2.5.4.8"), vec!["Shanghai"]);
            assert_eq!(subject_values(csr, OID_EMAIL), vec!["ops@example.com"]);
        });
    }

    #[test]
    fn the_subject_summary_lists_only_the_filled_fields() {
        let out = run_fast(json!({
            "common_name": "example.com",
            "organization_name": "Example Inc.",
        }));
        let subject = out["table"][&label("out.csr-generator.subject")]
            .as_str()
            .unwrap();
        assert!(subject.contains("CN=example.com"), "{subject}");
        assert!(subject.contains("O=Example Inc."), "{subject}");
        assert!(!subject.contains("C="), "{subject}");
        assert!(!subject.contains("OU="), "{subject}");
    }

    #[test]
    fn a_label_like_cn_is_not_forced_into_the_san() {
        // CN 是「Example Inc.」这种标签时不该塞进 SAN —— 那会多出一个非法的 DNS 名
        let out = run_fast(json!({
            "common_name": "Example Inc.",
            "alternative_names": "www.example.com",
        }));
        let pem = out["output"].as_str().unwrap();
        with_csr(pem, |csr| {
            let dns = san_dns(csr);
            assert_eq!(dns, vec!["www.example.com".to_string()], "{dns:?}");
            // 但 CN 仍然是 CN
            assert_eq!(
                subject_values(csr, OID_COMMON_NAME),
                vec!["Example Inc.".to_string()]
            );
        });
    }

    #[test]
    fn a_label_cn_without_alternative_names_leaves_the_san_empty() {
        // CN 是标签、又没填备用名称时，SAN 真的会是空的 —— 表里要写清楚，
        // 不能留个空字符串让人以为是渲染坏了。
        // 占位值走语言包：英文界面下不该出现中文括号。
        let out = run_fast(json!({ "common_name": "Example Inc." }));
        let no_san = crate::i18n::t("en", "out.csr-generator.no_san");
        assert_eq!(
            out["table"][&label("out.csr-generator.subject_alternative_name")].as_str(),
            Some(no_san.as_str())
        );
        let pem = out["output"].as_str().unwrap();
        with_csr(pem, |csr| {
            // 一个 SAN 都没有时，rcgen 干脆不写扩展请求属性
            assert!(
                csr.requested_extensions().is_none(),
                "没有 SAN 时不该有扩展请求属性"
            );
            // CSR 本身仍然是合法的
            csr.verify_signature().expect("签名应当验得过");
        });
    }

    #[test]
    fn a_non_ascii_dns_name_is_rejected_with_a_punycode_hint() {
        let err = compute(json!({
            "common_name": "example.com",
            "alternative_names": "例え.テスト",
        }))
        .expect_err("非 ASCII 的 DNS 名应当报错");
        let key = "out.csr-generator.err.non_ascii_dns_name";
        assert_err_key(err, key);
        // 「用 Punycode 编码」这个提示在语言包里 —— 语言包还没并进来时
        // localize 退回键本身，这时先跳过这条。
        if crate::i18n::has("en", key) {
            let en = crate::i18n::t("en", key);
            assert!(en.contains("Punycode"), "{en}");
        }
    }

    #[test]
    fn a_broken_ipv6_address_is_rejected_instead_of_becoming_a_dns_name() {
        let err = compute(json!({
            "common_name": "example.com",
            "alternative_names": "2001:db8::zz",
        }))
        .expect_err("不合法的 IPv6 应当报错");
        assert_err_key(err, "out.csr-generator.err.invalid_ipv6");
    }

    #[test]
    fn an_unknown_key_algorithm_names_the_accepted_values() {
        let err = compute(json!({
            "common_name": "example.com",
            "key_algorithm": "dsa",
        }))
        .expect_err("未知算法必须报错");
        let key = "out.csr-generator.err.unknown_algorithm";
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
            for alg in ["rsa2048", "ecdsa-p256", "ed25519"] {
                assert!(en.contains(alg), "{en}");
            }
        }
    }

    #[test]
    fn a_missing_common_name_is_an_error_not_an_empty_subject() {
        let err = compute(json!({ "common_name": "" })).expect_err("两者都空必须报错");
        assert_err_key(err, "out.csr-generator.err.missing_common_name");
    }

    #[test]
    fn a_missing_common_name_falls_back_to_the_first_alternative_name() {
        let out = run_fast(json!({
            "common_name": "",
            "alternative_names": "only.example.com",
        }));
        let pem = out["output"].as_str().unwrap();
        with_csr(pem, |csr| {
            assert_eq!(
                subject_values(csr, OID_COMMON_NAME),
                vec!["only.example.com".to_string()]
            );
        });
    }

    #[test]
    fn the_output_and_the_table_both_carry_what_the_user_needs() {
        let out = run_fast(json!({ "common_name": "example.com" }));
        // output 是 CSR PEM —— 用户最想要的那一样
        assert!(out["output"]
            .as_str()
            .unwrap()
            .contains("BEGIN CERTIFICATE REQUEST"));
        // table 里三样都在（行标题按语言取，断言时按同样的键取标题）
        for key in [
            "out.csr-generator.subject",
            "out.csr-generator.subject_alternative_name",
            "out.csr-generator.key_algorithm",
            "out.csr-generator.signature_algorithm",
            "out.csr-generator.public_key",
            "out.csr-generator.private_key",
        ] {
            assert!(
                !out["table"][&label(key)].as_str().unwrap_or("").is_empty(),
                "{key} 是空的"
            );
        }
        // 明文私钥这件事要说清楚 —— 那句话走语言包
        let note = out["table"][&label("out.csr-generator.note")].as_str().unwrap();
        assert_eq!(note, crate::i18n::t("en", "out.csr-generator.private_key_note"));
    }

    /// 表格的标题要跟着请求语言走 —— 英文界面不该出现中文行标题，
    /// 中文界面也不该出现英文行标题。
    #[test]
    fn the_row_labels_follow_the_request_language() {
        let key = "out.csr-generator.subject";
        let en = run_fast(json!({ "common_name": "example.com" }));
        let zh = run_fast(json!({ "common_name": "example.com", "__lang": "zh-CN" }));
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

    /// 表里成句的值（SAN 为空时的占位、私钥那句提醒）也要跟着语言走 ——
    /// 英文界面下不该冒出一句中文。
    #[test]
    fn the_sentence_values_follow_the_request_language() {
        // CN 是标签又没填备用名称 → SAN 为空 → 占位值
        let en = run_fast(json!({ "common_name": "Example Inc." }));
        let zh = run_fast(json!({
            "common_name": "Example Inc.",
            "__lang": "zh-CN",
        }));
        let en_san = crate::i18n::t("en", "out.csr-generator.subject_alternative_name");
        let zh_san = crate::i18n::t("zh-CN", "out.csr-generator.subject_alternative_name");
        assert_eq!(
            en["table"][&en_san].as_str(),
            Some(crate::i18n::t("en", "out.csr-generator.no_san").as_str())
        );
        assert_eq!(
            zh["table"][&zh_san].as_str(),
            Some(crate::i18n::t("zh-CN", "out.csr-generator.no_san").as_str())
        );

        // 私钥那句提醒
        let en_note = crate::i18n::t("en", "out.csr-generator.note");
        let zh_note = crate::i18n::t("zh-CN", "out.csr-generator.note");
        assert_eq!(
            en["table"][&en_note].as_str(),
            Some(crate::i18n::t("en", "out.csr-generator.private_key_note").as_str())
        );
        assert_eq!(
            zh["table"][&zh_note].as_str(),
            Some(crate::i18n::t("zh-CN", "out.csr-generator.private_key_note").as_str())
        );
    }

    #[test]
    fn malformed_payload_types_do_not_panic() {
        // 公开接口，手写请求可能给数字 / 数组 / null。
        // 类型不对的 CN 会被当成「没填」而报错 —— 重点是**不 panic**。
        for bad in [
            json!(42),
            json!([1, 2]),
            json!(null),
            json!(true),
            json!({}),
        ] {
            let out = compute(json!({ "common_name": bad, "key_algorithm": FAST_ALG }));
            assert!(out.is_err(), "{bad}: 应当报错而不是当成合法输入");
            assert!(
                matches!(out, Err(ToolError::InvalidKeyed { .. })),
                "{bad}: 应当是输入错误: {out:?}"
            );
        }
        assert!(compute(json!({})).is_err(), "两者都空应当报错");
        // 算法字段类型不对时退回默认，而不是崩掉
        let out = compute(json!({ "common_name": "example.com", "key_algorithm": json!(42) }));
        assert!(out.is_ok(), "{out:?}");
    }

    /// 错误消息要跟着请求语言走 —— 语言不是工具决定的，是 API 层
    /// 按请求语言调用 `localize` 渲染的。
    #[test]
    fn the_error_message_follows_the_requested_language() {
        let err = compute(json!({ "common_name": "example.com", "key_algorithm": "dsa" }))
            .expect_err("未知算法必须报错");
        let key = "out.csr-generator.err.unknown_algorithm";
        // 语言包里还没并进来时，localize 退回键本身 —— 这时断言跳过
        if !crate::i18n::has("zh-CN", key) {
            return;
        }
        let en = err.localize("en");
        let zh = err.localize("zh-CN");
        assert_ne!(en, zh, "两种语言不该是同一句");
        assert!(!en.contains("out.csr-generator"), "英文界面不该露出键：{en}");
        assert!(!zh.contains("out.csr-generator"), "中文界面不该露出键：{zh}");
    }
}
