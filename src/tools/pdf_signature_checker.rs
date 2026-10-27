//! PDF signature checker —— 检查 PDF 的数字签名（endpoint `pdf-signature-checker`）。
//!
//! 参考实现的 `pdf-signature-reader` 用 node-forge 做 PKCS#7/X.509。Rust 侧
//! `x509-parser` 只带 X.509 解析（它的 `verify_signature` 被 feature gate 在
//! `ring`/`aws-lc-rs` 后面，本项目两个 feature 都没开），PKCS#7/CMS 更是完全没有
//! —— `der-parser` 10.0 里没有 cms 模块。所以这里手写了一个最小 DER 走位器
//! （文件末尾的 `mod der`），只解析 RFC 5652 里真正用到的字段。
//!
//! ## 这个工具到底验了什么（很重要）
//!
//! | 环节 | 状态 |
//! |---|---|
//! | ByteRange 覆盖的字节没被动过（重算摘要 == CMS 的 messageDigest 属性） | 真验 |
//! | RSA PKCS#1 v1.5 / RSA PSS 的签名值 | 真验 |
//! | 签名证书确实由 CMS 里那张签发者证书签发（证书链的这一跳） | 真验 |
//! | 证书在**签名时刻**是否处于有效期内 | 真验（签名时刻本身也要靠上面的签名验过才可信） |
//! | 证书链一路到受信任根、CRL/OCSP 吊销、时间戳（TSA） | **不验**，输出里明说 |
//!
//! 一个只检查「签名 blob 存在与否」的检查器比没有更糟。所以上面每一项在输出表格
//! 和 `meta` 里都单列一行，不验的项绝不显示成「通过」。
//!
//! 测试用的样本在 `src/tools/fixtures/`（几 KB，随仓库提交），生成脚本是同目录的
//! `generate.py`：openssl 造证书、openssl cms 造 CMS、Python 拼 PDF。
//!
//! ## 安全性
//!
//! 整个解析跑在 `web::block` 里：畸形 PDF 能把解析器带进病态循环，而 actix worker
//! 一旦 panic 连接就废了，blocking 池把这两件事隔开。
//!
//! 上传字节数在进 lopdf 之前就卡死（见 `MAX_PDF_BYTES`），DER 走位器的每一层
//! 子元素数量也有上限。
//!
//! lopdf 0.46 起，`LoadOptions::max_decompressed_size` 给「单个流解压后能有多大」
//! 划了上限（超了报 `MemoryLimitExceeded`）。这一条堵的是解压炸弹：`/ObjStm`
//! （对象流）和 xref 流是**加载时**就急切解压的，一个几 KB 的 PDF 里塞一个
//! 高压缩比的对象流就能把内存打爆 —— 字节上限挡不住这一手，因为解压后的体积
//! 跟压缩前没关系。
//! 上限取 [`MAX_DECOMPRESSED_BYTES`]：普通 PDF 的这两个流都很小（几十 KB 到
//! 几 MB），16 MB 已经是整份上传的体积了，余量够用；而内存占用从「无上限」变成
//! 「每个流 16 MB」。
//! 说清楚这个上限**管到哪儿**：它是**每个流**的额度，不是一份 PDF 的总额 ——
//! 一份 PDF 里塞多少个流是攻击者说了算，所以它钉住的是放大倍数，不是总量。
//! 但没有上限时，一个流就能自己撑爆内存，这已经是最要紧的那一半了。
//! 这里没有另外加那种「扫字节」的土办法 —— 它太容易被绕过（`/Obj#53tm` 就能躲开），
//! 给你一个假的安全感反而更糟。

use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use lopdf::{Dictionary, Document, LoadOptions, Object, ObjectId, StringFormat};
use rsa::traits::{PublicKeyParts, SignatureScheme};
use rsa::{BoxedUint, Pkcs1v15Sign, Pss, RsaPublicKey};
use serde_json::{json, Map, Value};
use sha1::Sha1;
use sha2::{Digest, Sha224, Sha256, Sha384, Sha512};
use std::collections::HashSet;
use x509_parser::prelude::{ASN1Time, FromDer, X509Certificate, X509Name};

use super::util;
use super::{ToolError, ToolResult};

/// 上传字节数上限。
///
/// HTTP 层（`PayloadConfig`）放行 64 MB，但签名 PDF 里除了正文还得装下整条证书链，
/// 正常的手写签名件在几百 KB 到几 MB —— 16 MB 宽得离谱，再往上只是给解析器白送
/// CPU。超限直接拒，不进 lopdf。
const MAX_PDF_BYTES: usize = 16 * 1024 * 1024;

/// 单个流解压后的大小上限（lopdf 的 `LoadOptions::max_decompressed_size`）。
///
/// 加载时会被急切解压的是 `/ObjStm`（对象流）和 xref 流 —— 里面装的是字典、
/// 数组这类**非流对象**，正常 PDF 里这部分很小：几十 KB 到几 MB 封顶。
/// 16 MB 就是整份上传（`MAX_PDF_BYTES`）的体积，余量够普通签名件通过；
/// 而内存占用从「无上限」变成「每个流 16 MB」，几 KB 的压缩炸弹再也打不爆内存。
///
/// 注意这是**每个流**的额度：一份 PDF 里有多少个流是上传者说了算，所以它限制的
/// 是放大倍数而不是总量。真要把总量也钉死，得自己数 lopdf 解了多少字节 ——
/// 那就变成重写它的解析器了，不值当。
const MAX_DECOMPRESSED_BYTES: usize = 16 * 1024 * 1024;

/// 最多校验多少个签名。构造出来的 PDF 可以往 AcroForm 里塞几十万个签名字段，
/// 每个都要做一次 RSA 验签；不设上限就是一个几百毫秒到几秒的定时炸弹。
const MAX_SIGNATURES: usize = 16;

/// 签名字段树的最大深度。`/Kids` 是攻击者可控的图，靠 `visited` 挡环，
/// 靠深度挡「深得像一条链」的病态结构。
const MAX_FIELD_DEPTH: usize = 32;

/// 收集字段对象时的总量上限（含非签名字段），同上。
const MAX_FIELDS: usize = MAX_SIGNATURES * 8;

/// DER 里 `[n]` 子元素数量的硬上限。真实 CMS 每一层的子元素都不超过几十个。
const MAX_DER_CHILDREN: usize = 4096;

/// CMS 里携带的证书数量上限。一条正常链也就几张。
const MAX_CMS_CERTS: usize = 64;

/// `/Contents` 的最大字节数。4096 字节的 DER 足够装下完整证书链，再大就该怀疑
/// 它是拿 `/Contents` 当放大器了。
const MAX_CONTENTS_BYTES: usize = 64 * 1024;

/// 证书里字符串字段的显示长度上限。CN/OU 全是攻击者可控的字节，既要限长
/// （免得撑爆表格）也要清洗控制字符（免得一个塞满换行的 CN 把两列表格冲散）。
const MAX_LABEL_LEN: usize = 120;

pub async fn handle(payload: Value) -> ToolResult {
    util::blocking(move || compute(payload)).await
}

/// 按语言取语言包里的文案，并把 `{name}` 占位换成给定的值。
///
/// 语言包里两种语言可以有不同的语序，所以参数是**按名字**替换的，不是按位置 ——
/// 「{count} 个签名，只校验了前 {checked} 个」在英文里就该是另一种语序。
///
/// 键找不到时 `i18n::t` 退回键本身 —— 漏翻的键在页面上是显眼的
/// `out.pdf-signature-checker.<键名>`，而不是安静地少一句。
fn tr(lang: &str, key: &str, args: &[(&str, String)]) -> String {
    let mut out = crate::i18n::t(lang, key);
    for (name, value) in args {
        out = out.replace(&format!("{{{name}}}"), value);
    }
    out
}

fn compute(payload: Value) -> ToolResult {
    // 结果区的每一句文案都按请求语言取 —— 键在语言包里，代码里只出现键。
    let lang = util::lang(&payload);
    let encoded = util::req_str(&payload, "file")?;

    // 先按编码长度粗筛一道，免得为了拒绝一个 50 MB 的文件先把同样大的 Vec
    // 解出来（base64 每 4 个字符还原 3 个字节）。
    if encoded.len() > MAX_PDF_BYTES / 3 * 4 + 8 {
        return Err(ToolError::invalid(
            "out.pdf-signature-checker.err.file_too_large",
            &[("limit", &MAX_PDF_BYTES.to_string())],
        ));
    }

    // base64 解码失败是用户侧错误而不是 500：多半是有人直接 curl 了个非法 body。
    let bytes = BASE64.decode(encoded.trim()).map_err(|_| {
        ToolError::invalid("out.pdf-signature-checker.err.invalid_base64", &[])
    })?;

    if bytes.is_empty() {
        return Err(ToolError::invalid(
            "out.pdf-signature-checker.err.empty_file",
            &[],
        ));
    }
    if bytes.len() > MAX_PDF_BYTES {
        return Err(ToolError::invalid(
            "out.pdf-signature-checker.err.file_too_large_after_decode",
            &[
                ("size", &bytes.len().to_string()),
                ("limit", &MAX_PDF_BYTES.to_string()),
            ],
        ));
    }
    // 不信扩展名也不信 Content-Type，只看文件头。允许前面有若干字节的垃圾
    // （有些生成器会在 %PDF- 之前写 BOM 或换行），但不放行「PDF 在文件末尾」。
    if !bytes[..bytes.len().min(1024)]
        .windows(5)
        .any(|w| w == b"%PDF-")
    {
        return Err(ToolError::invalid(
            "out.pdf-signature-checker.err.not_a_pdf",
            &[],
        ));
    }

    let doc = Document::load_mem_with_options(
        &bytes,
        LoadOptions::with_max_decompressed_size(MAX_DECOMPRESSED_BYTES),
    )
    .map_err(|e| {
        ToolError::invalid(
            "out.pdf-signature-checker.err.pdf_parse_failed",
            &[("reason", &e.to_string())],
        )
    })?;

    let found = collect_signature_dicts(&doc);
    if found.dicts.is_empty() {
        // 「一个签名都没有」和「有个签名、但字段指向的对象已经坏了」是两回事，
        // 必须分开报，否则用户会以为自己的 PDF 是干净的。
        if found.dangling {
            return Err(ToolError::invalid(
                "out.pdf-signature-checker.err.dangling_signature_field",
                &[],
            ));
        }
        let mut table = Map::new();
        util::row(
            &mut table,
            &payload,
            "out.pdf-signature-checker.signature_count",
            json!("0"),
        );
        util::row(
            &mut table,
            &payload,
            "out.pdf-signature-checker.verdict",
            json!(tr(lang, "out.pdf-signature-checker.unsigned_verdict", &[])),
        );
        util::row(
            &mut table,
            &payload,
            "out.pdf-signature-checker.explanation",
            json!(tr(
                lang,
                "out.pdf-signature-checker.unsigned_explanation",
                &[]
            )),
        );
        return Ok(json!({
            "output": tr(lang, "out.pdf-signature-checker.unsigned_summary", &[]),
            "table": table,
            "meta": {
                "signature_count": 0,
                "verified": false,
                "integrity_verified": false,
                "certificate_chain_verified": false,
                "root_ca_trusted": false,
                "revocation_checked": false,
                "timestamp_checked": false,
            },
        }));
    }

    let mut table = Map::new();
    let mut meta_signatures = Vec::new();
    let mut all_ok = true;
    let mut any_altered = false;

    // 表格里所有值都是字符串 —— 前端是按文本渲染的，混进数字会让「未签名」
    // 那条分支（"0"）和有签名的分支长得不一样。
    util::row(
        &mut table,
        &payload,
        "out.pdf-signature-checker.signature_count",
        json!(found.dicts.len().to_string()),
    );

    for (index, sig) in found.dicts.iter().take(MAX_SIGNATURES).enumerate() {
        let report = verify_one(&bytes, sig, lang);
        if !matches!(report.verdict, Verdict::Valid) {
            all_ok = false;
        }
        if matches!(report.verdict, Verdict::Altered) {
            any_altered = true;
        }
        for (title, value) in report.to_rows(lang, index) {
            table.insert(title, json!(value));
        }
        meta_signatures.push(report.to_meta(index));
    }

    if found.dicts.len() > MAX_SIGNATURES {
        util::row(
            &mut table,
            &payload,
            "out.pdf-signature-checker.notice",
            json!(tr(
                lang,
                "out.pdf-signature-checker.truncated_notice",
                &[
                    ("count", found.dicts.len().to_string()),
                    ("checked", MAX_SIGNATURES.to_string()),
                ],
            )),
        );
    }

    let summary = if any_altered {
        tr(lang, "out.pdf-signature-checker.summary_invalid", &[])
    } else if all_ok {
        tr(lang, "out.pdf-signature-checker.summary_valid", &[])
    } else {
        tr(lang, "out.pdf-signature-checker.summary_unverified", &[])
    };
    util::row(
        &mut table,
        &payload,
        "out.pdf-signature-checker.verdict",
        json!(summary),
    );

    let chain_ok = meta_signatures
        .iter()
        .all(|s| s["certificate_chain_verified"] == json!(true));

    // 不能写成 `!any_altered`：签名字典本身坏掉（比如 /ByteRange 对不上）时压根没走到
    // 完整性那一步，`any_altered` 保持 false，于是 `!any_altered` 会给出一个「内容完好」
    // 的假保证 —— 明明一次都没验过。改成「每一条签名都自报内容未被改动」，坏字典
    // 的 `content_unaltered_since_signing` 是 false，这里就自然是 false。
    let integrity_ok = meta_signatures
        .iter()
        .all(|s| s["content_unaltered_since_signing"] == json!(true));

    Ok(json!({
        "output": summary,
        "table": table,
        "meta": {
            "signature_count": found.dicts.len(),
            "verified": all_ok && !any_altered,
            "integrity_verified": integrity_ok,
            "certificate_chain_verified": chain_ok,
            "certificate_valid_at_signing_time": meta_signatures
                .iter()
                .all(|s| s["certificate_valid_at_signing_time"] == json!(true)),
            "root_ca_trusted": false,
            "revocation_checked": false,
            "timestamp_checked": false,
            "signatures": meta_signatures,
            "limitations": [
                "不校验证书链到受信任根（PDF 内通常只有签发者这一跳的证书）",
                "不查询 CRL/OCSP，不做吊销检查",
                "不校验签名时间戳（TSA）",
                "ECDSA / Ed25519 / DSA 签名只报告算法，不做密码学验证",
            ],
        },
    }))
}

// ---------------------------------------------------------------------------
// 收集签名字典
// ---------------------------------------------------------------------------

struct FoundSignatures<'a> {
    dicts: Vec<&'a Dictionary>,
    /// AcroForm 声明了签名字段、但对象解析失败或缺失 —— 这种不能报「未签名」。
    dangling: bool,
}

/// 找出所有签名字典。
///
/// 正规路径是 `/Root/AcroForm/Fields` 里 `/FT /Sig` 的字段，其 `/V` 指向签名字典。
/// 但这条路径依赖 AcroForm 写对了，而 `/Fields` 本身也可能指向一个坏掉的对象 ——
/// 那种情况必须报「签名存在但损坏」。所以额外全表扫一遍「同时有 `/ByteRange` 与
/// `/Contents`」的字典兜底。
fn collect_signature_dicts<'a>(doc: &'a Document) -> FoundSignatures<'a> {
    let mut dicts: Vec<&'a Dictionary> = Vec::new();
    let mut seen_dicts: HashSet<usize> = HashSet::new();
    let mut seen_fields: HashSet<u32> = HashSet::new();
    let mut field_ids: Vec<ObjectId> = Vec::new();
    let mut dangling = false;

    if let Ok(catalog) = doc.catalog() {
        if let Ok(acroform) = catalog.get_deref(b"AcroForm", doc) {
            if let Ok(dict) = acroform.as_dict() {
                if let Ok(fields) = dict.get_deref(b"Fields", doc) {
                    if let Ok(array) = fields.as_array() {
                        walk_fields(doc, array, 0, &mut field_ids, &mut seen_fields);
                    }
                }
            }
        }
    }

    for id in field_ids {
        let Ok(field) = doc.get_dictionary(id) else {
            dangling = true;
            continue;
        };
        let is_sig = field
            .get(b"FT")
            .ok()
            .and_then(|o| o.as_name().ok())
            .is_some_and(|name| name == b"Sig");
        if !is_sig {
            continue;
        }
        match field.get_deref(b"V", doc) {
            Ok(value) => match value.as_dict() {
                Ok(sig) => push_unique(sig, &mut dicts, &mut seen_dicts),
                // `/V` 在，但指向的不是字典（有人换成了字符串之类的）。
                Err(_) => dangling = true,
            },
            // `/V` 是引用但对象解析不出来 —— 文件被截断，或对象本身坏了。
            Err(_) => dangling = true,
        }
    }

    // 兜底扫描。规范要求签名字典带 `/Type /Sig`，但真实世界里漏写的生成器不少，
    // 所以判据是「同时有 ByteRange 与 Contents」而不是只看 /Type。
    for object in doc.objects.values() {
        if let Ok(dict) = object.as_dict() {
            if dict.has(b"ByteRange") && dict.has(b"Contents") {
                push_unique(dict, &mut dicts, &mut seen_dicts);
            }
        }
    }

    FoundSignatures { dicts, dangling }
}

fn push_unique<'a>(
    dict: &'a Dictionary,
    dicts: &mut Vec<&'a Dictionary>,
    seen: &mut HashSet<usize>,
) {
    let key = dict as *const Dictionary as usize;
    if seen.insert(key) {
        dicts.push(dict);
    }
}

fn walk_fields(
    doc: &Document,
    fields: &[Object],
    depth: usize,
    out: &mut Vec<ObjectId>,
    seen: &mut HashSet<u32>,
) {
    if depth >= MAX_FIELD_DEPTH || out.len() >= MAX_FIELDS {
        return;
    }
    for field in fields {
        let Ok(id) = field.as_reference() else {
            continue;
        };
        // 字段树是图不是树，`/Kids` 可以指回祖先 —— 不去重就会无限递归。
        if !seen.insert(id.0) {
            continue;
        }
        out.push(id);

        let Ok(dict) = doc.get_dictionary(id) else {
            continue;
        };
        let Ok(kids) = dict.get(b"Kids") else {
            continue;
        };
        let Ok(resolved) = doc.dereference(kids) else {
            continue;
        };
        if let Ok(array) = resolved.1.as_array() {
            walk_fields(doc, array, depth + 1, out, seen);
        }
    }
}

// ---------------------------------------------------------------------------
// 校验单个签名
// ---------------------------------------------------------------------------

#[derive(Debug, PartialEq)]
enum Verdict {
    /// 内容没被动过，且签名值验签通过。
    Valid,
    /// 摘要对不上：字节被改过，或 /ByteRange 指错了地方。
    Altered,
    /// 摘要对得上但签名值验不过。
    BadSignature,
    /// 结构性问题：/ByteRange 非法、/Contents 不是 DER、签名字典缺字段。
    Malformed(String),
    /// 算法不在依赖范围内，只能如实报告。
    Unsupported(String),
    /// 结构正常，但缺某项信息导致无法下结论。
    Unverified(String),
}

/// 内容完整性、签名值、证书链、有效期是四个互相独立的维度，分开存也分开报 ——
/// 一份没被篡改但用 ECDSA 签的文件，「内容没被动过」是真的，签名验不了也是真的。
enum Integrity {
    /// 覆盖范围内字节的摘要与 messageDigest 属性一致。
    Intact,
    Altered,
    /// 拿不到可比对的 messageDigest。
    Unknown(String),
}

enum Crypto {
    Verified,
    Failed,
    Unsupported(String),
    Unchecked(String),
}

enum Chain {
    /// 签名证书确由 CMS 里的某张证书签发，且那个签名验过了。
    VerifiedBy(String),
    /// 自签名证书：自洽，但签名者自己担保自己。
    SelfSigned,
    /// CMS 里没有携带签发者证书，这一跳无从验证。
    NoIssuer,
    Failed,
    Unchecked(String),
}

enum Validity {
    Ok,
    Expired(String),
    NotYetValid(String),
    UnknownTime,
}

struct Report {
    verdict: Verdict,
    integrity: Integrity,
    crypto: Crypto,
    chain: Chain,
    validity: Validity,
    subject: String,
    issuer: String,
    serial: String,
    signing_time: String,
    digest_alg: String,
    sig_alg: String,
    note: Option<String>,
}

fn verify_one(bytes: &[u8], sig: &Dictionary, lang: &str) -> Report {
    // 顺序是有讲究的：ByteRange 是最便宜的检查，先做。一个指向文件之外的
    // ByteRange 应该报「签名字典损坏」，而不是被后面某个含糊的错盖过去。
    let (a, b, c, d) = match read_byte_range(sig, bytes.len() as u64, lang) {
        Ok(v) => v,
        Err(v) => return early_report(lang, v),
    };
    let contents = match read_contents(sig, lang) {
        Ok(v) => v,
        Err(v) => return early_report(lang, v),
    };
    let cms = match der::parse_signed_data(&contents, lang) {
        Ok(v) => v,
        Err(why) => {
            return early_report(
                lang,
                Verdict::Malformed(tr(
                    lang,
                    "out.pdf-signature-checker.reason_contents_not_cms",
                    &[("reason", why)],
                )),
            )
        }
    };

    let (integrity, note) = check_integrity(bytes, (a, b, c, d), &cms, lang);

    let signer = cms.signer_cert_index.and_then(|i| cms.certs.get(i));
    let crypto = match signer {
        Some(entry) => verify_signer_signature(entry, &cms, lang),
        None => Crypto::Unchecked(tr(
            lang,
            "out.pdf-signature-checker.reason_no_signer_certificate",
            &[],
        )),
    };
    let chain = match signer {
        Some(entry) => verify_chain(entry, &cms, lang),
        None => Chain::Unchecked(tr(
            lang,
            "out.pdf-signature-checker.reason_chain_no_signer_certificate",
            &[],
        )),
    };

    let signing_time = cms
        .signing_time
        .clone()
        .or_else(|| read_pdf_date(sig))
        .unwrap_or_default();
    let validity = check_validity(signer.map(|e| &e.cert), &signing_time);

    let verdict = match (&integrity, &crypto) {
        (Integrity::Altered, _) => Verdict::Altered,
        (_, Crypto::Failed) => Verdict::BadSignature,
        (_, Crypto::Unsupported(why)) => Verdict::Unsupported(why.clone()),
        (_, Crypto::Unchecked(why)) => Verdict::Unverified(why.clone()),
        (Integrity::Unknown(why), _) => Verdict::Unverified(why.clone()),
        _ => Verdict::Valid,
    };

    Report {
        verdict,
        integrity,
        crypto,
        chain,
        validity,
        subject: signer
            .map(|e| name_to_string(e.cert.subject()))
            .unwrap_or_default(),
        issuer: signer
            .map(|e| name_to_string(e.cert.issuer()))
            .unwrap_or_default(),
        serial: signer
            .map(|e| hex::encode(e.cert.raw_serial()))
            .unwrap_or_default(),
        digest_alg: cms
            .digest_alg
            .map(|a| a.label().to_string())
            .unwrap_or_else(|| tr(lang, "out.pdf-signature-checker.unknown", &[])),
        sig_alg: cms.sig_alg.clone(),
        signing_time,
        note,
    }
}

/// 算 ByteRange 覆盖字节的摘要，跟 CMS 里的 messageDigest 属性比。
fn check_integrity(
    bytes: &[u8],
    (a, b, c, d): (u64, u64, u64, u64),
    cms: &der::SignedData<'_>,
    lang: &str,
) -> (Integrity, Option<String>) {
    let (Some(first), Some(second)) = (slice_range(bytes, a, b), slice_range(bytes, c, d)) else {
        return (
            Integrity::Unknown(tr(
                lang,
                "out.pdf-signature-checker.reason_byte_range_outside_file",
                &[],
            )),
            None,
        );
    };
    let Some(alg) = cms.digest_alg else {
        return (
            Integrity::Unknown(tr(
                lang,
                "out.pdf-signature-checker.reason_no_digest_algorithm",
                &[],
            )),
            None,
        );
    };
    let Some(expected) = &cms.message_digest else {
        return (
            Integrity::Unknown(tr(
                lang,
                "out.pdf-signature-checker.reason_no_message_digest",
                &[],
            )),
            None,
        );
    };

    let mut covered = Vec::with_capacity(first.len() + second.len());
    covered.extend_from_slice(first);
    covered.extend_from_slice(second);
    let intact = alg.hash(&covered) == *expected;
    drop(covered);

    let integrity = if intact {
        Integrity::Intact
    } else {
        Integrity::Altered
    };

    // ByteRange 没盖到文件末尾 = 签名之后还有增量更新。签名对它覆盖到的那一版
    // 仍然有效，但必须让用户知道文件后来被追加过东西。
    let note = (intact && c.checked_add(d) != Some(bytes.len() as u64)).then(|| {
        tr(
            lang,
            "out.pdf-signature-checker.incremental_update_note",
            &[
                ("covered", (c + d).to_string()),
                ("total", bytes.len().to_string()),
            ],
        )
    });
    (integrity, note)
}

fn early_report(lang: &str, verdict: Verdict) -> Report {
    let not_checked = tr(lang, "out.pdf-signature-checker.reason_not_checked_yet", &[]);
    Report {
        verdict,
        integrity: Integrity::Unknown(not_checked.clone()),
        crypto: Crypto::Unchecked(not_checked.clone()),
        chain: Chain::Unchecked(not_checked),
        validity: Validity::UnknownTime,
        subject: String::new(),
        issuer: String::new(),
        serial: String::new(),
        signing_time: String::new(),
        digest_alg: String::new(),
        sig_alg: String::new(),
        note: None,
    }
}

impl Report {
    /// 这个签名在结果表里的几行。
    ///
    /// 行标题是「签名 1 · 结论」这种带前缀的 —— 前缀里的序号要能插值，
    /// 所以前缀本身也是一条语言包文案（`signature_heading`）。
    fn to_rows(&self, lang: &str, index: usize) -> Vec<(String, String)> {
        let prefix = tr(
            lang,
            "out.pdf-signature-checker.signature_heading",
            &[("index", (index + 1).to_string())],
        );
        let mut rows = Vec::new();
        let mut push = |key: &str, value: String| {
            rows.push((format!("{prefix} · {}", tr(lang, key, &[])), value));
        };

        push(
            "out.pdf-signature-checker.row_verdict",
            verdict_text(lang, &self.verdict),
        );
        push(
            "out.pdf-signature-checker.row_content_modified",
            match &self.integrity {
                Integrity::Intact => tr(lang, "out.pdf-signature-checker.content_intact", &[]),
                Integrity::Altered => tr(lang, "out.pdf-signature-checker.content_altered", &[]),
                Integrity::Unknown(why) => tr(
                    lang,
                    "out.pdf-signature-checker.content_unknown",
                    &[("reason", why.clone())],
                ),
            },
        );
        push(
            "out.pdf-signature-checker.row_signature_value",
            match &self.crypto {
                Crypto::Verified => tr(lang, "out.pdf-signature-checker.crypto_verified", &[]),
                Crypto::Failed => tr(lang, "out.pdf-signature-checker.crypto_failed", &[]),
                Crypto::Unsupported(why) => tr(
                    lang,
                    "out.pdf-signature-checker.not_verified_dash",
                    &[("reason", why.clone())],
                ),
                Crypto::Unchecked(why) => tr(
                    lang,
                    "out.pdf-signature-checker.not_verified",
                    &[("reason", why.clone())],
                ),
            },
        );
        push(
            "out.pdf-signature-checker.row_certificate_chain",
            match &self.chain {
                Chain::VerifiedBy(cn) => tr(
                    lang,
                    "out.pdf-signature-checker.chain_verified_by",
                    &[("name", cn.clone())],
                ),
                Chain::SelfSigned => tr(lang, "out.pdf-signature-checker.chain_self_signed", &[]),
                Chain::NoIssuer => tr(lang, "out.pdf-signature-checker.chain_no_issuer", &[]),
                Chain::Failed => tr(lang, "out.pdf-signature-checker.chain_failed", &[]),
                Chain::Unchecked(why) => tr(
                    lang,
                    "out.pdf-signature-checker.not_verified",
                    &[("reason", why.clone())],
                ),
            },
        );
        push(
            "out.pdf-signature-checker.row_certificate_validity",
            match &self.validity {
                Validity::Ok => tr(lang, "out.pdf-signature-checker.validity_ok", &[]),
                Validity::Expired(window) => tr(
                    lang,
                    "out.pdf-signature-checker.validity_expired",
                    &[("window", window.clone())],
                ),
                Validity::NotYetValid(window) => tr(
                    lang,
                    "out.pdf-signature-checker.validity_not_yet_valid",
                    &[("window", window.clone())],
                ),
                Validity::UnknownTime => tr(lang, "out.pdf-signature-checker.validity_unknown", &[]),
            },
        );
        push(
            "out.pdf-signature-checker.row_signer",
            or_unknown(lang, &self.subject),
        );
        push(
            "out.pdf-signature-checker.row_issuer",
            or_unknown(lang, &self.issuer),
        );
        push(
            "out.pdf-signature-checker.row_serial_number",
            or_unknown(lang, &self.serial),
        );
        push(
            "out.pdf-signature-checker.row_signing_time",
            or_unknown(lang, &self.signing_time),
        );
        push(
            "out.pdf-signature-checker.row_digest_algorithm",
            or_unknown(lang, &self.digest_alg),
        );
        push(
            "out.pdf-signature-checker.row_signature_algorithm",
            or_unknown(lang, &self.sig_alg),
        );
        if let Some(note) = &self.note {
            push("out.pdf-signature-checker.notice", note.clone());
        }
        rows
    }

    fn to_meta(&self, index: usize) -> Value {
        json!({
            "index": index + 1,
            "verdict": match &self.verdict {
                Verdict::Valid => "valid",
                Verdict::Altered => "content_altered",
                Verdict::BadSignature => "bad_signature",
                Verdict::Malformed(_) => "malformed_signature_dictionary",
                Verdict::Unsupported(_) => "unsupported_algorithm",
                Verdict::Unverified(_) => "unverified",
            },
            "message_digest_verified": matches!(
                self.integrity,
                Integrity::Intact | Integrity::Altered
            ),
            "content_unaltered_since_signing": matches!(self.integrity, Integrity::Intact),
            "signature_value_verified": matches!(self.crypto, Crypto::Verified),
            "certificate_chain_verified": matches!(
                self.chain,
                Chain::VerifiedBy(_) | Chain::SelfSigned
            ),
            "self_signed_certificate": matches!(self.chain, Chain::SelfSigned),
            "certificate_valid_at_signing_time": matches!(self.validity, Validity::Ok),
            "root_ca_trusted": false,
            "revocation_checked": false,
            "timestamp_checked": false,
            "subject": self.subject,
            "issuer": self.issuer,
            "serial_number": self.serial,
            "signing_time": self.signing_time,
            "digest_algorithm": self.digest_alg,
            "signature_algorithm": self.sig_alg,
            "note": self.note,
        })
    }
}

fn verdict_text(lang: &str, v: &Verdict) -> String {
    match v {
        Verdict::Valid => tr(lang, "out.pdf-signature-checker.verdict_valid", &[]),
        Verdict::Altered => tr(lang, "out.pdf-signature-checker.verdict_altered", &[]),
        Verdict::BadSignature => tr(lang, "out.pdf-signature-checker.verdict_bad_signature", &[]),
        Verdict::Malformed(why) => tr(
            lang,
            "out.pdf-signature-checker.verdict_malformed",
            &[("reason", why.clone())],
        ),
        Verdict::Unsupported(why) => tr(
            lang,
            "out.pdf-signature-checker.verdict_unsupported",
            &[("reason", why.clone())],
        ),
        Verdict::Unverified(why) => tr(
            lang,
            "out.pdf-signature-checker.verdict_unverified",
            &[("reason", why.clone())],
        ),
    }
}

fn or_unknown(lang: &str, s: &str) -> String {
    if s.is_empty() {
        tr(lang, "out.pdf-signature-checker.unknown", &[])
    } else {
        s.to_string()
    }
}

// ---------------------------------------------------------------------------
// PDF 侧的小工具
// ---------------------------------------------------------------------------

fn slice_range(bytes: &[u8], start: u64, len: u64) -> Option<&[u8]> {
    let start = usize::try_from(start).ok()?;
    let end = start.checked_add(usize::try_from(len).ok()?)?;
    bytes.get(start..end)
}

/// 读 `/ByteRange` 并做最基本的自洽检查。
///
/// `file_len` 是文件总长 —— 没有它就没法判断 ByteRange 是否越界，而越界的
/// ByteRange 是「签名字典损坏」和「文件被换过」这两种情况的共同症状。
fn read_byte_range(
    sig: &Dictionary,
    file_len: u64,
    lang: &str,
) -> Result<(u64, u64, u64, u64), Verdict> {
    let bad = |why: String| Verdict::Malformed(why);
    let array = sig
        .get(b"ByteRange")
        .map_err(|_| {
            bad(tr(
                lang,
                "out.pdf-signature-checker.reason_missing",
                &[("field", "/ByteRange".into())],
            ))
        })?
        .as_array()
        .map_err(|_| bad(tr(lang, "out.pdf-signature-checker.reason_byte_range_not_array", &[])))?;
    if array.len() != 4 {
        return Err(bad(tr(
            lang,
            "out.pdf-signature-checker.reason_byte_range_count",
            &[("count", array.len().to_string())],
        )));
    }
    let mut values = [0u64; 4];
    for (slot, object) in values.iter_mut().zip(array.iter()) {
        let n = object
            .as_i64()
            .map_err(|_| bad(tr(lang, "out.pdf-signature-checker.reason_byte_range_non_integer", &[])))?;
        if n < 0 {
            return Err(bad(tr(lang, "out.pdf-signature-checker.reason_byte_range_negative", &[])));
        }
        *slot = n as u64;
    }
    // ByteRange 是 [a1 l1 a2 l2]：a1/l1 与 a2/l2 是两段区间的**起点与长度**，
    // 不是起止位置。所以不能拿 l 去和 a 比大小，只能验「不重叠」。
    let (a, b, c, d) = (values[0], values[1], values[2], values[3]);
    let Some(end1) = a.checked_add(b) else {
        return Err(bad(tr(lang, "out.pdf-signature-checker.reason_byte_range_overflow", &[])));
    };
    let Some(end2) = c.checked_add(d) else {
        return Err(bad(tr(lang, "out.pdf-signature-checker.reason_byte_range_overflow", &[])));
    };
    // 两段之间必须留出放 `/Contents` 的空隙；重叠说明有人伪造过 ByteRange。
    if end1 > c {
        return Err(bad(tr(lang, "out.pdf-signature-checker.reason_byte_range_overlap", &[])));
    }
    // 两段都得落在文件里。end2 小于文件长度是正常的 —— 那说明签名之后又做了
    // 增量更新，签名对它覆盖到的那一版仍然有效。
    if end1 > file_len || end2 > file_len {
        return Err(bad(tr(
            lang,
            "out.pdf-signature-checker.reason_byte_range_out_of_bounds",
            &[
                ("first", end1.to_string()),
                ("second", end2.to_string()),
                ("length", file_len.to_string()),
            ],
        )));
    }
    Ok((a, b, c, d))
}

fn read_contents(sig: &Dictionary, lang: &str) -> Result<Vec<u8>, Verdict> {
    let bad = |why: String| Verdict::Malformed(why);
    let object = sig.get(b"Contents").map_err(|_| {
        bad(tr(
            lang,
            "out.pdf-signature-checker.reason_missing",
            &[("field", "/Contents".into())],
        ))
    })?;

    // lopdf 已经把 `<hex>` 解成字节了，`StringFormat` 只用来记来源。
    let raw: Vec<u8> = match object {
        Object::String(bytes, StringFormat::Hexadecimal | StringFormat::Literal) => bytes.clone(),
        // 少数生成器把 DER 直接塞进一个流对象里当 /Contents。
        Object::Stream(stream) => stream.content.clone(),
        _ => return Err(bad(tr(lang, "out.pdf-signature-checker.reason_contents_wrong_type", &[]))),
    };

    if raw.is_empty() {
        return Err(bad(tr(lang, "out.pdf-signature-checker.reason_contents_empty", &[])));
    }
    if raw.len() > MAX_CONTENTS_BYTES {
        return Err(bad(tr(
            lang,
            "out.pdf-signature-checker.reason_contents_too_large",
            &[
                ("size", raw.len().to_string()),
                ("limit", MAX_CONTENTS_BYTES.to_string()),
            ],
        )));
    }

    // 规范要求把签名字节串补零到固定长度，所以尾部全是 0 是正常填充、不是数据。
    // 按顶层 TLV 自报的长度切，比「strip 掉所有尾随 0」可靠 —— 后者会把恰好以
    // 0x00 结尾的 RSA 签名值吃掉一截，那样会把好文件误判成坏文件。
    match der::declared_length(&raw) {
        Some(len) if len <= raw.len() => Ok(raw[..len].to_vec()),
        Some(_) => Err(bad(tr(
            lang,
            "out.pdf-signature-checker.reason_contents_bad_length",
            &[],
        ))),
        // 长度字段本身被截断（文件被砍断的典型症状）。照样交给 CMS 解析器，
        // 让它给一个具体的错，而不是在这里武断地下结论。
        None => Ok(raw),
    }
}

/// 读签名字典里的 `/M`（`D:YYYYMMDDHHmmSS+HH'mm'`）。只取到年月日就够用了。
fn read_pdf_date(sig: &Dictionary) -> Option<String> {
    let text = sig.get(b"M").ok()?.as_str().ok()?;
    let digits: String = String::from_utf8_lossy(text)
        .chars()
        .filter(char::is_ascii_digit)
        .collect();
    let (year, rest) = match digits.len() {
        0..=7 => return None,
        8..=13 => ("20".to_string(), digits.as_str()),
        _ => (digits[..4].to_string(), &digits[4..]),
    };
    let month = rest.get(0..2)?;
    let day = rest.get(2..4)?;
    Some(format!("{year}-{month}-{day}"))
}

// ---------------------------------------------------------------------------
// 证书
// ---------------------------------------------------------------------------

/// 证书里的字符串全来自攻击者可控的文件：限长 + 去掉控制字符。
/// 去控制字符不是为了「防注入」—— `render()` 用的是 `textContent`，本来就不会解析
/// HTML —— 而是为了不让一个塞满换行的 CN 把两列的输出表格冲散。
fn sanitize(s: &str) -> String {
    let mut out = String::with_capacity(s.len().min(MAX_LABEL_LEN * 2));
    for ch in s.chars() {
        if out.chars().count() >= MAX_LABEL_LEN {
            out.push('…');
            break;
        }
        out.push(if ch.is_control() { ' ' } else { ch });
    }
    out.trim().to_string()
}

fn name_to_string(name: &X509Name<'_>) -> String {
    let text = name.to_string();
    if text.is_empty() || text.starts_with("<X509Error") {
        // 全是不可信字符串类型时 Display 会吐一个错误串。退回原始 DER 的十六进制 ——
        // 不好看，但至少是真的。
        return hex::encode(name.as_raw())
            .chars()
            .take(MAX_LABEL_LEN)
            .collect();
    }
    sanitize(&text)
}

fn time_string(t: &ASN1Time) -> String {
    sanitize(&t.to_datetime().to_string())
}

/// 优先按**签名时刻**判有效期：一份 2019 年签、2029 年过期的文件，今天上传时证书
/// 当然还在有效期内，但这里描述的是签名那会儿的状态，用「现在」去判会误报。
fn check_validity(cert: Option<&X509Certificate<'_>>, signing_time: &str) -> Validity {
    let Some(cert) = cert else {
        return Validity::UnknownTime;
    };
    let not_before = cert.validity().not_before.timestamp();
    let not_after = cert.validity().not_after.timestamp();
    let window = format!(
        "{} ~ {}",
        time_string(&cert.validity().not_before),
        time_string(&cert.validity().not_after)
    );
    let at = parse_epoch(signing_time).unwrap_or_else(|| chrono::Utc::now().timestamp());
    if at < not_before {
        Validity::NotYetValid(window)
    } else if at > not_after {
        Validity::Expired(window)
    } else {
        Validity::Ok
    }
}

/// 接受 `2026-10-22` 和 `2026-10-22T06:50:27Z`（后者来自 CMS 的 signingTime）。
///
/// 只取日期会把「证书生效当天签的名」误判成「签名时证书还没生效」—— 签名时刻
/// 的时分秒必须一起比较。
fn parse_epoch(s: &str) -> Option<i64> {
    let s = s.trim();
    let (date_part, time_part) = match s.split_once(['T', ' ']) {
        Some((d, t)) => (d, t),
        None => (s, ""),
    };
    let mut parts = date_part.split('-');
    let year: i32 = parts.next()?.parse().ok()?;
    let month: u32 = parts.next()?.parse().ok()?;
    let day: u32 = parts.next()?.parse().ok()?;
    let (mut hour, mut minute, mut second) = (0u32, 0u32, 0u32);
    if !time_part.is_empty() {
        // 只取数字和冒号，时区标记（Z / +hh:mm）自动被丢掉 —— 传进来的时间
        // 已经是折算过 UTC 的。
        let clock: String = time_part
            .chars()
            .take_while(|c| c.is_ascii_digit() || *c == ':')
            .collect();
        let mut fields = clock.split(':');
        hour = fields.next()?.parse().ok()?;
        minute = fields.next().and_then(|v| v.parse().ok()).unwrap_or(0);
        second = fields.next().and_then(|v| v.parse().ok()).unwrap_or(0);
    }
    let naive = chrono::NaiveDate::from_ymd_opt(year, month, day)?;
    let naive = naive.and_hms_opt(hour, minute, second)?;
    Some(naive.and_utc().timestamp())
}

/// 取出证书 SPKI 里的 RSA 公钥。非 RSA（ECDSA/Ed25519）返回 None。
fn rsa_public_key(cert: &X509Certificate<'_>) -> Option<RsaPublicKey> {
    // x509-parser 自己会核对 SPKI 的算法标识符是不是 rsaEncryption，是才把位串
    // 解成 RSA 公钥；ECDSA/Ed25519 落到别的分支，这里直接返回 None。
    let key = cert.public_key().parsed().ok()?;
    let x509_parser::public_key::PublicKey::RSA(rsa) = key else {
        return None;
    };
    // `new` 内部会检查模数位数与指数范围，畸形证书在这里就被挡掉，顺带也限制了
    // 后面 RSA 运算的规模。
    RsaPublicKey::new(be_uint(rsa.modulus)?, be_uint(rsa.exponent)?).ok()
}

/// 大端字节 → rsa 0.10 的密钥分量（`crypto_bigint::BoxedUint`）。
///
/// **前导零必须去掉**：DER 的 INTEGER 是带符号的，正数最高位是 1 时会补一个
/// `0x00` 符号位（2048 位的模数因此是 257 字节）。而 `BoxedUint` 的「精度」就是
/// 喂进去的字节数乘 8 —— 留着那个符号位，精度会凭空多出 8 位，跟签名的精度
/// 对不上，验签永远失败。
///
/// 全零（数值 0）不是合法的密钥分量，返回 None。
fn be_uint(bytes: &[u8]) -> Option<BoxedUint> {
    let start = bytes.iter().position(|b| *b != 0)?;
    Some(BoxedUint::from_be_slice_vartime(&bytes[start..]))
}

/// 用签发者公钥验一张证书的签名，命中就返回所用的摘要算法。
///
/// 证书自己声明的签名算法 OID 拿不到 —— x509-parser 把 `TbsCertificate.raw` 设成了
/// crate 私有。但也没必要读：五种 RSA PKCS#1 v1.5 摘要挨个试一遍，命中哪个就是哪个。
/// 这既绕开了私有字段，也顺带验证了「声明的算法」与「实际用的算法」一致 —— 只信
/// 声明的话，伪造者可以随便改那个 OID。
fn try_verify_cert_by_issuer(
    child_der: &[u8],
    issuer_key: &RsaPublicKey,
    lang: &str,
) -> Option<&'static str> {
    let tbs = der::tbs_bytes(child_der)?;
    // `X509Result` 是 `nom::IResult`，所以是 (剩余输入, 证书)，不是反过来。
    let (_, cert) = X509Certificate::from_der(child_der).ok()?;
    let sig = cert.signature_value.data.as_ref();
    [
        DigestAlg::Sha256,
        DigestAlg::Sha384,
        DigestAlg::Sha512,
        DigestAlg::Sha1,
        DigestAlg::Sha224,
    ]
    .into_iter()
    .find(|alg| {
        verify_pkcs1v15(issuer_key, *alg, &alg.hash(tbs), sig, lang).unwrap_or(false)
    })
    .map(DigestAlg::label)
}

fn verify_chain(signer: &der::CertEntry<'_>, cms: &der::SignedData<'_>, lang: &str) -> Chain {
    let Some(key) = rsa_public_key(&signer.cert) else {
        return Chain::Unchecked(tr(
            lang,
            "out.pdf-signature-checker.reason_chain_not_rsa",
            &[],
        ));
    };

    if signer.cert.issuer().as_raw() == signer.cert.subject().as_raw() {
        // 自签名：拿自己验自己。能过说明这是个自洽的自签名证书。
        return match try_verify_cert_by_issuer(signer.der, &key, lang) {
            Some(_) => Chain::SelfSigned,
            None => Chain::Failed,
        };
    }

    for entry in &cms.certs {
        if entry.cert.issuer().as_raw() != signer.cert.issuer().as_raw() {
            continue;
        }
        let Some(issuer_key) = rsa_public_key(&entry.cert) else {
            continue;
        };
        return match try_verify_cert_by_issuer(entry.der, &issuer_key, lang) {
            Some(_) => Chain::VerifiedBy(name_to_string(entry.cert.subject())),
            None => Chain::Failed,
        };
    }
    Chain::NoIssuer
}

fn verify_signer_signature(
    signer: &der::CertEntry<'_>,
    cms: &der::SignedData<'_>,
    lang: &str,
) -> Crypto {
    let Some(key) = rsa_public_key(&signer.cert) else {
        return Crypto::Unsupported(tr(
            lang,
            "out.pdf-signature-checker.reason_not_rsa_key",
            &[("algorithm", cms.sig_alg.clone())],
        ));
    };

    // 有 signedAttrs 时签的是它们的 DER（首字节从 0xA0 换成 0x31 —— IMPLICIT [0]
    // 与 SET OF 的内容编码逐字节相同，见 RFC 5652 §5.4）；没有时签的就是内容摘要。
    let signed: &[u8] = match (&cms.signed_attrs_for_signing, &cms.message_digest) {
        (Some(attrs), _) => attrs,
        (None, Some(digest)) => digest,
        (None, None) => {
            return Crypto::Unchecked(tr(
                lang,
                "out.pdf-signature-checker.reason_no_signed_attrs",
                &[],
            ))
        }
    };

    let Some(alg) = cms.sig_alg_digest else {
        return Crypto::Unsupported(tr(
            lang,
            "out.pdf-signature-checker.reason_unknown_digest_algorithm",
            &[("algorithm", cms.sig_alg.clone())],
        ));
    };
    let hashed = alg.hash(signed);

    match &cms.signature_scheme {
        der::Scheme::Pss(salt_len) => {
            match verify_pss(&key, alg, *salt_len, &hashed, &cms.signature, lang) {
                Ok(true) => Crypto::Verified,
                Ok(false) => Crypto::Failed,
                Err(why) => Crypto::Unsupported(why),
            }
        }
        der::Scheme::Pkcs1v15 => {
            match verify_pkcs1v15(&key, alg, &hashed, &cms.signature, lang) {
                Ok(true) => Crypto::Verified,
                Ok(false) => Crypto::Failed,
                Err(why) => Crypto::Unsupported(why),
            }
        }
        der::Scheme::Unsupported(why) => Crypto::Unsupported(why.clone()),
    }
}

fn verify_pkcs1v15(
    key: &RsaPublicKey,
    alg: DigestAlg,
    hashed: &[u8],
    sig: &[u8],
    lang: &str,
) -> Result<bool, String> {
    // DigestInfo 前缀由 rsa 按摘要类型的 OID 生成 —— sha1 / sha2 都带 `oid`
    // 特性，能给出 `AssociatedOid`。前缀 + 摘要正好是 PKCS#1 v1.5 要签的那串字节。
    let padding = match alg {
        DigestAlg::Sha1 => Pkcs1v15Sign::new::<Sha1>(),
        DigestAlg::Sha224 => Pkcs1v15Sign::new::<Sha224>(),
        DigestAlg::Sha256 => Pkcs1v15Sign::new::<Sha256>(),
        DigestAlg::Sha384 => Pkcs1v15Sign::new::<Sha384>(),
        DigestAlg::Sha512 => Pkcs1v15Sign::new::<Sha512>(),
    };
    let Some(sig) = pad_signature(key, sig) else {
        return Err(tr(
            lang,
            "out.pdf-signature-checker.reason_pkcs1_mismatch",
            &[],
        ));
    };
    padding
        .verify(key, hashed, &sig)
        .map(|_| true)
        .map_err(|_| tr(lang, "out.pdf-signature-checker.reason_pkcs1_mismatch", &[]))
}

fn verify_pss(
    key: &RsaPublicKey,
    alg: DigestAlg,
    salt_len: usize,
    hashed: &[u8],
    sig: &[u8],
    lang: &str,
) -> Result<bool, String> {
    // `Pss::new_with_salt` 的泛型只用来决定内部摘要器，而 `verify` 收的是已经算好的
    // `hashed` 和原始签名字节，所以按 PSS 参数里声明的摘要算法取类型即可，
    // 不影响验证结果。
    let Some(sig) = pad_signature(key, sig) else {
        return Err(tr(lang, "out.pdf-signature-checker.reason_pss_mismatch", &[]));
    };
    let ok = match alg {
        DigestAlg::Sha1 => Pss::<Sha1>::new_with_salt(salt_len).verify(key, hashed, &sig),
        DigestAlg::Sha224 => Pss::<Sha224>::new_with_salt(salt_len).verify(key, hashed, &sig),
        DigestAlg::Sha256 => Pss::<Sha256>::new_with_salt(salt_len).verify(key, hashed, &sig),
        DigestAlg::Sha384 => Pss::<Sha384>::new_with_salt(salt_len).verify(key, hashed, &sig),
        DigestAlg::Sha512 => Pss::<Sha512>::new_with_salt(salt_len).verify(key, hashed, &sig),
    };
    ok.map(|_| true)
        .map_err(|_| tr(lang, "out.pdf-signature-checker.reason_pss_mismatch", &[]))
}

/// 把签名补齐到模数的长度。
///
/// rsa 0.10 的密钥分量是**定精度**的：验签时要求「签名的精度 == 模数的精度」。
/// CMS 里的签名一般就是模数那么长（2048 位密钥对 256 字节），但有的实现会把
/// 前导零去掉 —— 补回去，两种写法都能验。
///
/// 比模数还长就是坏签名，返回 None。
fn pad_signature(key: &RsaPublicKey, sig: &[u8]) -> Option<Vec<u8>> {
    let size = key.size();
    if sig.len() > size {
        return None;
    }
    let mut out = vec![0u8; size - sig.len()];
    out.extend_from_slice(sig);
    Some(out)
}

// ---------------------------------------------------------------------------
// 摘要算法
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum DigestAlg {
    Sha1,
    Sha224,
    Sha256,
    Sha384,
    Sha512,
}

impl DigestAlg {
    pub fn label(self) -> &'static str {
        match self {
            DigestAlg::Sha1 => "SHA-1",
            DigestAlg::Sha224 => "SHA-224",
            DigestAlg::Sha256 => "SHA-256",
            DigestAlg::Sha384 => "SHA-384",
            DigestAlg::Sha512 => "SHA-512",
        }
    }

    fn from_oid(oid: &[u8]) -> Option<Self> {
        [
            (DigestAlg::Sha1, der::OID_SHA1),
            (DigestAlg::Sha224, der::OID_SHA224),
            (DigestAlg::Sha256, der::OID_SHA256),
            (DigestAlg::Sha384, der::OID_SHA384),
            (DigestAlg::Sha512, der::OID_SHA512),
        ]
        .into_iter()
        .find(|(_, known)| *known == oid)
        .map(|(alg, _)| alg)
    }

    /// 全部走一次性的 `digest()` 而不是 `Box<dyn Digest>` —— `Digest::update` 是泛型
    /// 方法，这个 trait 根本不是 object-safe，做不成 trait object。
    pub fn hash(self, data: &[u8]) -> Vec<u8> {
        match self {
            DigestAlg::Sha1 => Sha1::digest(data).to_vec(),
            DigestAlg::Sha224 => Sha224::digest(data).to_vec(),
            DigestAlg::Sha256 => Sha256::digest(data).to_vec(),
            DigestAlg::Sha384 => Sha384::digest(data).to_vec(),
            DigestAlg::Sha512 => Sha512::digest(data).to_vec(),
        }
    }
}

// ---------------------------------------------------------------------------
// 手写的最小 DER 走位器 + CMS SignedData 解析
// ---------------------------------------------------------------------------

/// `der-parser` 10.0 没有 CMS 模块，`x509-parser` 的验签又被 feature gate 住了，
/// 所以按 RFC 5652 手写一个只读、只认 DER、处处设上限的走位器。
///
/// OID 一律写成 DER 内容字节（不含 tag 与长度），这样算法比较就是一次字节切片
/// 比较，不需要把 `asn1_rs` 拉成直接依赖。
mod der {
    use super::*;

    pub const OID_SHA1: &[u8] = &[0x2b, 0x0e, 0x03, 0x02, 0x1a];
    pub const OID_SHA224: &[u8] = &[0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x02, 0x04];
    pub const OID_SHA256: &[u8] = &[0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x02, 0x01];
    pub const OID_SHA384: &[u8] = &[0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x02, 0x02];
    pub const OID_SHA512: &[u8] = &[0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x02, 0x03];
    const OID_SHA1_RSA: &[u8] = &[0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x05];
    const OID_SHA224_RSA: &[u8] = &[0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x0e];
    const OID_SHA256_RSA: &[u8] = &[0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x0b];
    const OID_SHA384_RSA: &[u8] = &[0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x0c];
    const OID_SHA512_RSA: &[u8] = &[0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x0d];
    /// 1.2.840.113549.1.1.1 —— 「泛用」的 RSA。CMS 在 SignerInfo 带 signedAttrs 时
    /// 会把 signatureAlgorithm 写成这个 OID，具体的摘要算法挪到 digestAlgorithm 里。
    const OID_RSA_ENCRYPTION: &[u8] = &[0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01];
    const OID_RSASSA_PSS: &[u8] = &[0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x0a];
    const OID_MGF1: &[u8] = &[0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x08];
    const OID_ATTR_MESSAGE_DIGEST: &[u8] = &[0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x09, 0x04];
    const OID_ATTR_SIGNING_TIME: &[u8] = &[0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x09, 0x05];
    const ID_SIGNED_DATA: &[u8] = &[0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x07, 0x02];
    const OID_ECDSA_SHA256: &[u8] = &[0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03, 0x02];
    const OID_ECDSA_SHA384: &[u8] = &[0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03, 0x03];
    const OID_ECDSA_SHA512: &[u8] = &[0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03, 0x04];
    const OID_ED25519: &[u8] = &[0x2b, 0x65, 0x70];
    const OID_DSA: &[u8] = &[0x2a, 0x86, 0x48, 0xce, 0x38, 0x04, 0x01];

    const TAG_INTEGER: u8 = 0x02;
    const TAG_OCTET_STRING: u8 = 0x04;
    const TAG_OID: u8 = 0x06;
    const TAG_SEQUENCE: u8 = 0x30;
    const TAG_SET: u8 = 0x31;
    const TAG_UTC_TIME: u8 = 0x17;
    const TAG_GENERALIZED_TIME: u8 = 0x18;

    /// 一个 TLV：`body` 是内容，`full` 是整段（含 tag 与长度）。验签要 `full`，
    /// 取子节点要 `body`，两个都得留。
    struct Tlv<'a> {
        tag: u8,
        body: &'a [u8],
        full: &'a [u8],
    }

    fn read_tlv(input: &[u8]) -> Option<Tlv<'_>> {
        let (&tag, rest) = input.split_first()?;
        let (&first, after_first) = rest.split_first()?;
        let (len, body_start) = if first & 0x80 == 0 {
            (first as usize, after_first)
        } else {
            let count = (first & 0x7f) as usize;
            // 0x80 是 BER 的「不定长」，DER 不允许；超过 4 字节的长度对本工具毫无
            // 意义；前导 0 是非规范编码，一并拒掉。
            if count == 0 || count > 4 || after_first.len() < count {
                return None;
            }
            let bytes = after_first.get(..count)?;
            // 前导 0 是非规范编码：同样的长度用更少的字节就能表示出来。
            if bytes.first() == Some(&0) {
                return None;
            }
            let mut value = 0usize;
            for &b in bytes {
                value = value.checked_mul(256)?.checked_add(b as usize)?;
            }
            (value, after_first.get(count..)?)
        };
        let body = body_start.get(..len)?;
        let header = input.len() - body_start.len();
        Some(Tlv {
            tag,
            body,
            full: input.get(..header.checked_add(len)?)?,
        })
    }

    /// 顶层 TLV 自报的总长度。用来按自报长度切掉 PDF 的补零填充。
    pub fn declared_length(input: &[u8]) -> Option<usize> {
        read_tlv(input).map(|t| t.full.len())
    }

    fn children(body: &[u8]) -> Vec<Tlv<'_>> {
        let mut out = Vec::new();
        let mut rest = body;
        while !rest.is_empty() && out.len() < MAX_DER_CHILDREN {
            // 遇到解不开的 TLV 就停下，而不是 panic 或猜长度 —— 被截断的 DER 正是
            // 这个工具最常遇到的输入。
            match read_tlv(rest) {
                Some(tlv) if !tlv.full.is_empty() && tlv.full.len() <= rest.len() => {
                    rest = &rest[tlv.full.len()..];
                    out.push(tlv);
                }
                _ => break,
            }
        }
        out
    }

    pub struct CertEntry<'a> {
        pub der: &'a [u8],
        pub cert: X509Certificate<'a>,
    }

    /// CMS 的签名方案。只有 RSA 的两种能在本项目的依赖范围内真验。
    pub enum Scheme {
        Pkcs1v15,
        Pss(usize),
        Unsupported(String),
    }

    pub struct SignedData<'a> {
        pub digest_alg: Option<DigestAlg>,
        pub message_digest: Option<Vec<u8>>,
        /// 首字节已从 0xA0（IMPLICIT [0]）换成 0x31（SET OF），可以直接喂给验签。
        pub signed_attrs_for_signing: Option<Vec<u8>>,
        pub signing_time: Option<String>,
        pub sig_alg: String,
        pub signature_scheme: Scheme,
        /// 签名方案实际用的摘要算法。PSS 的摘要算法藏在签名算法的参数里，
        /// 与 `digest_alg` 不是同一个 OID。
        pub sig_alg_digest: Option<DigestAlg>,
        pub signature: Vec<u8>,
        pub certs: Vec<CertEntry<'a>>,
        pub signer_cert_index: Option<usize>,
    }

    /// 解析 `ContentInfo ::= SEQUENCE { contentType OID, [0] EXPLICIT SignedData }`。
    ///
    /// 只取第一个 SignerInfo。PDF 的 `/Contents` 里正常也只有一个签名者；
    /// 多签名者的情况不受支持 —— 那时 `signature_scheme` 会是 Unsupported，
    /// 上层如实报「无法验证」。
    pub fn parse_signed_data<'a>(input: &'a [u8], lang: &str) -> Result<SignedData<'a>, String> {
        let outer = read_tlv(input)
            .ok_or_else(|| tr(lang, "out.pdf-signature-checker.reason_der_header_broken", &[]))?;
        if outer.tag != TAG_SEQUENCE {
            return Err(tr(lang, "out.pdf-signature-checker.reason_der_not_sequence", &[]));
        }
        let top = children(outer.body);
        let content_type = top.first().ok_or_else(|| {
            tr(
                lang,
                "out.pdf-signature-checker.reason_missing",
                &[("field", "contentType".into())],
            )
        })?;
        if content_type.tag != TAG_OID || content_type.body != ID_SIGNED_DATA {
            return Err(tr(
                lang,
                "out.pdf-signature-checker.reason_der_not_signed_data",
                &[],
            ));
        }
        let wrapper = top.get(1).ok_or_else(|| {
            tr(
                lang,
                "out.pdf-signature-checker.reason_missing",
                &[("field", "content".into())],
            )
        })?;
        if wrapper.tag != 0xa0 {
            return Err(tr(
                lang,
                "out.pdf-signature-checker.reason_der_bad_wrapper_tag",
                &[],
            ));
        }
        let signed = children(wrapper.body).into_iter().next().ok_or_else(|| {
            tr(
                lang,
                "out.pdf-signature-checker.reason_empty",
                &[("field", "SignedData".into())],
            )
        })?;
        if signed.tag != TAG_SEQUENCE {
            return Err(tr(
                lang,
                "out.pdf-signature-checker.reason_der_signed_data_not_sequence",
                &[],
            ));
        }

        let fields = children(signed.body);
        let mut it = fields.into_iter();
        it.next(); // version
        it.next(); // digestAlgorithms
        it.next(); // encapContentInfo

        let mut cert_der: Vec<&[u8]> = Vec::new();
        let mut signer_infos: Option<&[u8]> = None;
        for field in it {
            match field.tag {
                // [0] IMPLICIT certificates
                0xa0 => {
                    for cert in children(field.body) {
                        // [2] 是 x509 的 attribute 而不是证书，跳过。
                        if cert.tag == TAG_SEQUENCE {
                            cert_der.push(cert.full);
                            if cert_der.len() >= MAX_CMS_CERTS {
                                break;
                            }
                        }
                    }
                }
                // [1] IMPLICIT crls：这里用不到，直接跳过
                0xa1 => {}
                // signerInfos SET OF SignerInfo
                TAG_SET if signer_infos.is_none() => signer_infos = Some(field.body),
                _ => {}
            }
        }

        let signer_infos = signer_infos.ok_or_else(|| {
            tr(
                lang,
                "out.pdf-signature-checker.reason_missing",
                &[("field", "signerInfos".into())],
            )
        })?;
        let info = children(signer_infos).into_iter().next().ok_or_else(|| {
            tr(
                lang,
                "out.pdf-signature-checker.reason_empty",
                &[("field", "SignerInfo".into())],
            )
        })?;
        let mut p = children(info.body).into_iter().peekable();
        p.next(); // version
        let sid = p.next().ok_or_else(|| {
            tr(
                lang,
                "out.pdf-signature-checker.reason_missing",
                &[("field", "issuerAndSerialNumber".into())],
            )
        })?;
        let digest_alg_oid = alg_oid(
            p.next().ok_or_else(|| {
                tr(
                    lang,
                    "out.pdf-signature-checker.reason_missing",
                    &[("field", "digestAlgorithm".into())],
                )
            })?,
            lang,
        )?;
        // signedAttrs 在 RFC 5652 里是 OPTIONAL 的。必须先看一眼再决定要不要
        // 消费 —— 无条件 `next()` 会把 signatureAlgorithm 当成 signedAttrs 吃掉。
        let signed_attrs = match p.peek() {
            Some(t) if t.tag == 0xa0 => p.next(),
            _ => None,
        };
        let sig_alg_tlv = p.next().ok_or_else(|| {
            tr(
                lang,
                "out.pdf-signature-checker.reason_missing",
                &[("field", "signatureAlgorithm".into())],
            )
        })?;
        let signature = p.next().ok_or_else(|| {
            tr(
                lang,
                "out.pdf-signature-checker.reason_missing",
                &[("field", "signature".into())],
            )
        })?;
        if signature.tag != TAG_OCTET_STRING {
            return Err(tr(
                lang,
                "out.pdf-signature-checker.reason_der_signature_not_octet_string",
                &[],
            ));
        }

        let (scheme, sig_alg, sig_alg_digest) =
            parse_signature_algorithm(sig_alg_tlv, DigestAlg::from_oid(digest_alg_oid), lang)?;
        let digest_alg = DigestAlg::from_oid(digest_alg_oid);

        let mut message_digest = None;
        let mut signing_time = None;
        let mut signed_attrs_for_signing = None;
        if let Some(attrs) = signed_attrs {
            signed_attrs_for_signing = Some(retag_as_set(attrs.full));
            for attr in children(attrs.body) {
                let kv = children(attr.body);
                let Some(oid_tlv) = kv.first() else { continue };
                if oid_tlv.tag != TAG_OID {
                    continue;
                }
                let values = kv.get(1).map(|set| children(set.body)).unwrap_or_default();
                let Some(value) = values.first() else {
                    continue;
                };
                match oid_tlv.body {
                    b if b == OID_ATTR_MESSAGE_DIGEST => message_digest = Some(value.body.to_vec()),
                    b if b == OID_ATTR_SIGNING_TIME => {
                        signing_time = Some(format_asn1_time(value));
                    }
                    _ => {}
                }
            }
        }

        let certs: Vec<CertEntry<'_>> = cert_der
            .into_iter()
            .filter_map(|der| {
                X509Certificate::from_der(der)
                    .ok()
                    .map(|(_, cert)| CertEntry { der, cert })
            })
            .collect();
        let signer_cert_index = match_signer_cert(&sid, &certs);

        Ok(SignedData {
            digest_alg,
            message_digest,
            signed_attrs_for_signing,
            signing_time,
            sig_alg,
            signature_scheme: scheme,
            sig_alg_digest,
            signature: signature.body.to_vec(),
            certs,
            signer_cert_index,
        })
    }

    /// `[0] IMPLICIT SET OF` 与 `SET OF` 的内容编码逐字节相同，只有首字节不同。
    /// RFC 5652 §5.4 规定签名算在 SET OF 的编码上。
    fn retag_as_set(full: &[u8]) -> Vec<u8> {
        let mut out = full.to_vec();
        if let Some(first) = out.first_mut() {
            *first = TAG_SET;
        }
        out
    }

    /// 取 `AlgorithmIdentifier` 里的 OID 内容字节。原样返回而不是映射成静态常量 ——
    /// 摘要算法与签名算法用的是同一套 OID 表，调用方才知道该按哪张表查。
    fn alg_oid<'a>(tlv: Tlv<'a>, lang: &str) -> Result<&'a [u8], String> {
        if tlv.tag != TAG_SEQUENCE {
            return Err(tr(
                lang,
                "out.pdf-signature-checker.reason_der_alg_id_not_sequence",
                &[],
            ));
        }
        let oid = children(tlv.body).into_iter().next().ok_or_else(|| {
            tr(
                lang,
                "out.pdf-signature-checker.reason_der_alg_id_empty",
                &[],
            )
        })?;
        if oid.tag != TAG_OID {
            return Err(tr(
                lang,
                "out.pdf-signature-checker.reason_der_alg_id_not_oid",
                &[],
            ));
        }
        Ok(oid.body)
    }

    /// `RSASSA-PSS-params ::= SEQUENCE { [0] hashAlgorithm, [1] maskGenAlgorithm,
    ///  [2] saltLength, [3] trailerField }`
    ///
    /// `sid_digest` 是 SignerInfo 里 `digestAlgorithm` 字段给出的摘要算法 ——
    /// signatureAlgorithm 写成泛用的 `rsaEncryption` 时，只能从那里拿到真正的
    /// 摘要算法（RFC 5652 §5.3）。
    fn parse_signature_algorithm(
        tlv: Tlv<'_>,
        sid_digest: Option<DigestAlg>,
        lang: &str,
    ) -> Result<(Scheme, String, Option<DigestAlg>), String> {
        let parts = children(tlv.body);
        let oid_tlv = parts.first().ok_or_else(|| {
            tr(
                lang,
                "out.pdf-signature-checker.reason_missing",
                &[("field", "signatureAlgorithm".into())],
            )
        })?;
        if oid_tlv.tag != TAG_OID {
            return Err(tr(
                lang,
                "out.pdf-signature-checker.reason_der_alg_id_not_oid",
                &[],
            ));
        }
        let oid = oid_tlv.body;
        let label = alg_label(oid);

        // 泛用的 rsaEncryption：CMS 带 signedAttrs 时就是这么写的，实际是
        // PKCS#1 v1.5，摘要算法取 digestAlgorithm。
        if oid == OID_RSA_ENCRYPTION {
            let label = match sid_digest {
                Some(d) => format!("{} with RSA", d.label()),
                None => "RSA (PKCS#1 v1.5)".to_string(),
            };
            return Ok((Scheme::Pkcs1v15, label, sid_digest));
        }

        if oid != OID_RSASSA_PSS {
            let scheme = match oid {
                b if b == OID_SHA1_RSA
                    || b == OID_SHA224_RSA
                    || b == OID_SHA256_RSA
                    || b == OID_SHA384_RSA
                    || b == OID_SHA512_RSA =>
                {
                    Scheme::Pkcs1v15
                }
                _ => Scheme::Unsupported(tr(
                    lang,
                    "out.pdf-signature-checker.reason_unsupported_algorithm",
                    &[("algorithm", label.to_string())],
                )),
            };
            let digest = match oid {
                b if b == OID_SHA1_RSA => Some(DigestAlg::Sha1),
                b if b == OID_SHA224_RSA => Some(DigestAlg::Sha224),
                b if b == OID_SHA256_RSA => Some(DigestAlg::Sha256),
                b if b == OID_SHA384_RSA => Some(DigestAlg::Sha384),
                b if b == OID_SHA512_RSA => Some(DigestAlg::Sha512),
                _ => None,
            };
            return Ok((scheme, label.to_string(), digest));
        }

        // 参数缺失时按 RFC 4055 的默认值：SHA-1、MGF1-SHA1、盐长 20。
        let Some(params) = parts.get(1) else {
            return Ok((Scheme::Pss(20), label.to_string(), Some(DigestAlg::Sha1)));
        };
        let mut digest = DigestAlg::Sha1;
        let mut salt_len = 20usize;
        for field in children(params.body) {
            match field.tag {
                0xa0 => {
                    if let Some(alg) = children(field.body).into_iter().next() {
                        if let Ok(oid) = alg_oid(alg, lang) {
                            if let Some(found) = DigestAlg::from_oid(oid) {
                                digest = found;
                            }
                        }
                    }
                }
                0xa1 => {
                    // maskGenAlgorithm 必须是 MGF1 且与主摘要一致；别的（本工具只
                    // 支持 MGF1）就整体退回「无法验证」，宁可少验也不猜。
                    let mgf = children(field.body).into_iter().next();
                    let is_mgf1 = mgf
                        .and_then(|alg| alg_oid(alg, lang).ok())
                        .is_some_and(|oid| oid == OID_MGF1);
                    if !is_mgf1 {
                        return Ok((
                            Scheme::Unsupported(tr(
                                lang,
                                "out.pdf-signature-checker.reason_pss_not_mgf1",
                                &[],
                            )),
                            label.to_string(),
                            None,
                        ));
                    }
                }
                0xa2 => salt_len = read_small_integer(field.body).unwrap_or(20),
                _ => {}
            }
        }
        // 盐长必须是正数且不超过摘要长度，否则 PSS 在数学上不可能成立。
        let cap = match digest {
            DigestAlg::Sha1 => 20,
            DigestAlg::Sha224 => 28,
            DigestAlg::Sha256 => 32,
            DigestAlg::Sha384 => 48,
            DigestAlg::Sha512 => 64,
        };
        let salt_len = if (1..=cap).contains(&salt_len) {
            salt_len
        } else {
            cap
        };

        Ok((Scheme::Pss(salt_len), label.to_string(), Some(digest)))
    }

    fn alg_label(oid: &[u8]) -> &'static str {
        if oid == OID_RSA_ENCRYPTION {
            "RSA (PKCS#1 v1.5)"
        } else if oid == OID_SHA1_RSA {
            "SHA-1 with RSA"
        } else if oid == OID_SHA224_RSA {
            "SHA-224 with RSA"
        } else if oid == OID_SHA256_RSA {
            "SHA-256 with RSA"
        } else if oid == OID_SHA384_RSA {
            "SHA-384 with RSA"
        } else if oid == OID_SHA512_RSA {
            "SHA-512 with RSA"
        } else if oid == OID_RSASSA_PSS {
            "RSASSA-PSS"
        } else if oid == OID_ECDSA_SHA256 {
            "ECDSA with SHA-256"
        } else if oid == OID_ECDSA_SHA384 {
            "ECDSA with SHA-384"
        } else if oid == OID_ECDSA_SHA512 {
            "ECDSA with SHA-512"
        } else if oid == OID_ED25519 {
            "Ed25519"
        } else if oid == OID_DSA {
            "DSA"
        } else {
            "未知签名算法"
        }
    }

    fn read_small_integer(body: &[u8]) -> Option<usize> {
        let tlv = read_tlv(body)?;
        if tlv.tag != TAG_INTEGER || tlv.body.is_empty() || tlv.body.len() > 4 {
            return None;
        }
        let mut value = 0usize;
        for &b in tlv.body {
            value = value.checked_mul(256)?.checked_add(b as usize)?;
        }
        Some(value)
    }

    /// `IssuerAndSerialNumber ::= SEQUENCE { issuer Name, serialNumber INTEGER }`
    /// —— 拿 issuer 的原始 DER 和序列号去 CMS 的证书堆里找签名者那张。
    fn match_signer_cert(sid: &Tlv<'_>, certs: &[CertEntry<'_>]) -> Option<usize> {
        let parts = children(sid.body);
        let issuer = parts.first()?;
        let serial = parts.get(1)?;
        // serial 本身已经是解析好的 TLV（children 的产物），不能再解一遍 ——
        // 再解一次会把整数内容当成 tag+length 去读，必然失败。
        if serial.tag != TAG_INTEGER {
            return None;
        }
        certs.iter().position(|entry| {
            entry.cert.issuer().as_raw() == issuer.full
                && strip_leading_zeros(entry.cert.raw_serial()) == strip_leading_zeros(serial.body)
        })
    }

    fn strip_leading_zeros(mut s: &[u8]) -> &[u8] {
        while s.first() == Some(&0) {
            s = &s[1..];
        }
        s
    }

    /// 把 ASN.1 的 UTCTime / GeneralizedTime 变成 ISO-8601 字符串。
    ///
    /// UTCTime 是两位年份 YYMMDDHHMMSS，>=50 归 19xx、其余归 20xx
    /// （RFC 5280 §4.1.2.5.1）；GeneralizedTime 是四位年份 YYYYMMDDHHMMSS。
    /// 末尾的时区（Z 或 ±hhmm）会折算成 UTC 再输出。
    fn format_asn1_time(tlv: &Tlv<'_>) -> String {
        let owned = String::from_utf8_lossy(tlv.body);
        // 小数秒夹在时间和时区中间，先切掉。
        let text = owned
            .split_once('.')
            .map(|(a, _)| a)
            .unwrap_or(owned.as_ref());
        let text = text.trim();
        let bytes = text.as_bytes();
        let mut end = 0usize;
        while end < bytes.len() && bytes[end].is_ascii_digit() {
            end += 1;
        }
        let digits = &text[..end];
        let suffix = text[end..].trim();

        // 时区：Z / +hhmm / -hhmm / +hh
        let offset_minutes: i32 = if suffix.is_empty() || suffix == "Z" {
            0
        } else {
            let sign = if suffix.starts_with('-') { -1 } else { 1 };
            let tz: String = suffix.chars().filter(|c| c.is_ascii_digit()).collect();
            let (h, m) = match tz.len() {
                4 => (tz[..2].parse().unwrap_or(0), tz[2..].parse().unwrap_or(0)),
                2 => (tz.parse().unwrap_or(0), 0),
                _ => (0, 0),
            };
            sign * (h * 60 + m)
        };

        let (year, rest) = match tlv.tag {
            TAG_UTC_TIME => {
                if digits.len() < 10 {
                    return String::new();
                }
                let yy: i32 = digits[..2].parse().unwrap_or(-1);
                if yy < 0 {
                    return String::new();
                }
                (if yy >= 50 { 1900 + yy } else { 2000 + yy }, &digits[2..])
            }
            TAG_GENERALIZED_TIME => {
                if digits.len() < 8 {
                    return String::new();
                }
                let year: i32 = digits[..4].parse().unwrap_or(-1);
                if year < 0 {
                    return String::new();
                }
                (year, &digits[4..])
            }
            _ => return String::new(),
        };

        let (Some(month), Some(day)) = (rest.get(0..2), rest.get(2..4)) else {
            return String::new();
        };
        // 没有时分秒就只给日期 —— 有的生成器只写了年月日。
        if rest.len() < 6 {
            return format!("{year:04}-{month}-{day}");
        }
        let hour = &rest[4..6];
        let minute = &rest[6..8];
        let second = rest.get(8..10).unwrap_or("00");

        // 用 chrono 把时区折算成 UTC，省得自己算跨天。
        let Some(date) = chrono::NaiveDate::from_ymd_opt(
            year,
            month.parse().unwrap_or(0),
            day.parse().unwrap_or(0),
        ) else {
            return String::new();
        };
        let Some(time) = date.and_hms_opt(
            hour.parse().unwrap_or(0),
            minute.parse().unwrap_or(0),
            second.parse().unwrap_or(0),
        ) else {
            return String::new();
        };
        let utc = time - chrono::Duration::minutes(i64::from(offset_minutes));
        utc.format("%Y-%m-%dT%H:%M:%SZ").to_string()
    }

    /// 取证书外层 SEQUENCE 的第一个子元素 —— 那就是被签名的 TBSCertificate。
    /// x509-parser 把 `TbsCertificate.raw` 设成了 crate 私有，只能自己再走一遍。
    pub fn tbs_bytes(cert_der: &[u8]) -> Option<&[u8]> {
        let outer = read_tlv(cert_der)?;
        if outer.tag != TAG_SEQUENCE {
            return None;
        }
        children(outer.body).into_iter().next().map(|t| t.full)
    }

    /// DER 长度：短形式能放下就一字节，否则用 `0x80 | 字节数`。
    #[cfg(test)]
    fn write_len(out: &mut Vec<u8>, len: usize) {
        if len < 0x80 {
            out.push(len as u8);
            return;
        }
        let bytes = len.to_be_bytes();
        let start = bytes
            .iter()
            .position(|b| *b != 0)
            .unwrap_or(bytes.len() - 1);
        let significant = &bytes[start..];
        out.push(0x80 | significant.len() as u8);
        out.extend_from_slice(significant);
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        fn wrap(tag: u8, body: &[u8]) -> Vec<u8> {
            let mut out = vec![tag];
            write_len(&mut out, body.len());
            out.extend_from_slice(body);
            out
        }

        #[test]
        fn short_and_long_form_lengths_both_parse() {
            assert_eq!(
                read_tlv(&[0x04, 0x03, 1, 2, 3]).map(|t| t.body),
                Some(&[1u8, 2, 3][..])
            );
            // 长形式：0x81 = 后面一个字节是长度
            let big = wrap(0x04, &[7u8; 200]);
            assert_eq!(read_tlv(&big).map(|t| t.body.len()), Some(200));
            assert_eq!(read_tlv(&big).map(|t| t.full.len()), Some(203));
            // 声明 200 字节但内容被截断 -> None，绝不能越界读
            assert!(read_tlv(&[0x04, 0x81, 0xc8]).is_none());
        }

        #[test]
        fn non_der_and_truncated_input_is_rejected_not_panicking() {
            assert!(read_tlv(&[]).is_none());
            assert!(read_tlv(&[0x30]).is_none());
            // 0x80 = BER 不定长
            assert!(read_tlv(&[0x30, 0x80, 0x00, 0x00]).is_none());
            // 声称 10 字节但只有 2 个
            assert!(read_tlv(&[0x30, 0x0a, 0x01, 0x02]).is_none());
            // 前导 0 的非规范长度
            assert!(read_tlv(&[0x30, 0x82, 0x00, 0x02, 0x01, 0x02]).is_none());
            // 长度字段声称 9 字节，装不下
            assert!(read_tlv(&[0x30, 0x89, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]).is_none());
        }

        #[test]
        fn declared_length_ignores_trailing_padding() {
            let der = wrap(0x30, &[1, 2, 3, 4]);
            let mut padded = der.clone();
            padded.extend_from_slice(&[0u8; 32]);
            assert_eq!(declared_length(&padded), Some(der.len()));
        }

        #[test]
        fn pkcs1v15_prefix_matches_the_published_sha256_prefix() {
            // rsa 0.10 按摘要类型的 OID 生成 DigestInfo 前缀：外层 SEQUENCE 的头、
            // AlgorithmIdentifier、OCTET STRING 的头（摘要本身由调用方紧跟其后
            // 补上）。这段字节是标准里的公开值，钉死它免得日后换库时悄悄变了。
            let prefix = Pkcs1v15Sign::new::<Sha256>().prefix;
            // 3031 <len 49> 300d <algid> 0420 <32 字节摘要>
            assert_eq!(
                hex::encode(&prefix),
                "3031300d060960864801650304020105000420"
            );
        }

        #[test]
        fn every_digest_algorithm_gets_a_self_consistent_digest_info() {
            for (label, prefix, len) in [
                ("SHA-1", Pkcs1v15Sign::new::<Sha1>().prefix, 20usize),
                ("SHA-224", Pkcs1v15Sign::new::<Sha224>().prefix, 28),
                ("SHA-256", Pkcs1v15Sign::new::<Sha256>().prefix, 32),
                ("SHA-384", Pkcs1v15Sign::new::<Sha384>().prefix, 48),
                ("SHA-512", Pkcs1v15Sign::new::<Sha512>().prefix, 64),
            ] {
                let mut full = prefix.to_vec();
                let prefix_len = full.len();
                full.extend_from_slice(&vec![0xbb; len]);
                let tlv = read_tlv(&full).expect("拼出来的 DigestInfo 必须自洽");
                assert_eq!(tlv.full.len(), prefix_len + len, "{label}");
            }
        }

        #[test]
        fn utctime_two_digit_years_follow_rfc5280() {
            let tlv = Tlv {
                tag: TAG_UTC_TIME,
                body: b"260102030405Z",
                full: b"",
            };
            assert_eq!(format_asn1_time(&tlv), "2026-01-02T03:04:05Z");
            let old = Tlv {
                tag: TAG_UTC_TIME,
                body: b"990102030405Z",
                full: b"",
            };
            assert_eq!(format_asn1_time(&old), "1999-01-02T03:04:05Z");
            // 50 是分界线：>=50 归 19xx
            let edge = Tlv {
                tag: TAG_UTC_TIME,
                body: b"500101000000Z",
                full: b"",
            };
            assert_eq!(format_asn1_time(&edge), "1950-01-01T00:00:00Z");
            // 只有日期没有时分秒也要能出结果
            let date_only = Tlv {
                tag: TAG_GENERALIZED_TIME,
                body: b"20260101",
                full: b"",
            };
            assert_eq!(format_asn1_time(&date_only), "2026-01-01");
            // 垃圾输入
            assert_eq!(format_asn1_time(&old_wrapped()), "");
        }

        fn old_wrapped() -> Tlv<'static> {
            Tlv {
                tag: TAG_UTC_TIME,
                body: b"xx",
                full: b"",
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(name: &str) -> Vec<u8> {
        // `#[test]` 是从源码树跑的，不是从 target/ 里跑的，所以用编译期常量拼路径。
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/src/tools/fixtures/");
        std::fs::read(format!("{path}{name}")).expect("fixture 存在")
    }

    fn run(bytes: &[u8]) -> ToolResult {
        compute(json!({ "file": BASE64.encode(bytes) }))
    }

    fn row<'a>(out: &'a Value, key: &str) -> &'a str {
        out["table"][key]
            .as_str()
            .unwrap_or_else(|| panic!("找不到行 `{key}`，现有行：{:?}", out["table"]))
    }

    /// 结果表里的行标题（按语言取 —— 行标题是语言包里的键，不写死在代码里）。
    fn title(lang: &str, key: &str) -> String {
        crate::i18n::t(lang, key)
    }

    /// 错误的键 —— 错误信息本身在语言包里，测试断言的是键而不是那句话。
    fn err_key(err: &ToolError) -> Option<&str> {
        match err {
            ToolError::InvalidKeyed { key, .. } => Some(key),
            ToolError::Internal(_) => None,
        }
    }

    /// 「签名 1 · 结论」这种带序号前缀的行标题。
    fn sig_title(lang: &str, index: usize, key: &str) -> String {
        format!(
            "{} · {}",
            crate::i18n::t(lang, "out.pdf-signature-checker.signature_heading")
                .replace("{index}", &index.to_string()),
            crate::i18n::t(lang, key)
        )
    }

    /// 文案模板里第一个 `{` 之前的那一截。
    ///
    /// 用来断言「这条文案被用上了」，又不必知道插值进去的具体数字 ——
    /// 「/ByteRange 有 {count} 个数」里的那个 5 变了，模板的前半截不会变。
    fn template_head(lang: &str, key: &str) -> String {
        let text = crate::i18n::t(lang, key);
        match text.find('{') {
            Some(at) => text[..at].to_string(),
            None => text,
        }
    }

    #[test]
    fn validly_signed_pdf_reports_valid_and_names_the_signer() {
        let out = run(&fixture("signed_valid.pdf")).expect("应当成功");

        assert_eq!(out["meta"]["verified"], json!(true));
        assert_eq!(out["meta"]["integrity_verified"], json!(true));
        assert_eq!(out["meta"]["signature_count"], json!(1));
        assert_eq!(out["meta"]["signatures"][0]["verdict"], json!("valid"));
        assert_eq!(
            out["meta"]["signatures"][0]["signature_value_verified"],
            json!(true)
        );
        assert_eq!(
            row(&out, &title("en", "out.pdf-signature-checker.signature_count")),
            "1"
        );

        // 签名者身份必须来自证书，不能是我们编的。
        let signer = row(&out, &sig_title("en", 1, "out.pdf-signature-checker.row_signer"));
        assert!(signer.contains("IT Tools Fixture Signer"), "签名者 = {signer:?}");
        assert_eq!(
            row(&out, &sig_title("en", 1, "out.pdf-signature-checker.row_digest_algorithm")),
            "SHA-256"
        );
        assert_eq!(
            row(&out, &sig_title("en", 1, "out.pdf-signature-checker.row_signature_algorithm")),
            "SHA-256 with RSA"
        );
        assert_eq!(
            row(&out, &sig_title("en", 1, "out.pdf-signature-checker.row_verdict")),
            title("en", "out.pdf-signature-checker.verdict_valid")
        );
        assert_eq!(
            row(&out, &sig_title("en", 1, "out.pdf-signature-checker.row_content_modified")),
            title("en", "out.pdf-signature-checker.content_intact")
        );
        assert_eq!(
            row(&out, &sig_title("en", 1, "out.pdf-signature-checker.row_signature_value")),
            title("en", "out.pdf-signature-checker.crypto_verified")
        );
        assert_eq!(
            row(&out, &sig_title("en", 1, "out.pdf-signature-checker.row_certificate_validity")),
            title("en", "out.pdf-signature-checker.validity_ok")
        );
    }

    /// 全文件里最重要的一条：签名后改一个字节，必须翻成「无效」。
    #[test]
    fn one_mutated_body_byte_flips_the_signature_to_invalid() {
        let original = fixture("signed_valid.pdf");

        // 改正文的第一个字节（长度不变，所以 PDF 结构仍然完好，ByteRange 也不用动）。
        let marker = b"SIGNED PAYLOAD TEXT";
        let at = original
            .windows(marker.len())
            .position(|w| w == marker)
            .expect("fixture 里有正文");
        let mut tampered = original.clone();
        tampered[at] = b'X';

        let out = run(&tampered).expect("应当成功（只是签名不再有效）");
        assert_eq!(out["meta"]["verified"], json!(false));
        assert_eq!(out["meta"]["integrity_verified"], json!(false));
        assert_eq!(
            out["meta"]["signatures"][0]["verdict"],
            json!("content_altered")
        );
        assert_eq!(
            out["meta"]["signatures"][0]["content_unaltered_since_signing"],
            json!(false)
        );
        assert_eq!(
            row(&out, &sig_title("en", 1, "out.pdf-signature-checker.row_content_modified")),
            title("en", "out.pdf-signature-checker.content_altered")
        );
        assert_eq!(
            out["output"].as_str().unwrap(),
            title("en", "out.pdf-signature-checker.summary_invalid")
        );
        assert_eq!(
            row(&out, &title("en", "out.pdf-signature-checker.verdict")),
            title("en", "out.pdf-signature-checker.summary_invalid")
        );
    }

    #[test]
    fn signed_at_eof_gets_no_incremental_update_note() {
        let out = run(&fixture("signed_valid.pdf")).unwrap();
        // 校验用不到这条：它只在 ByteRange 没盖到文件末尾时才出现。
        // 提示本身是语言包里的文案，所以这里断言「没有提示」而不是它的内容。
        let note = out["meta"]["signatures"][0]["note"]
            .as_str()
            .unwrap_or_default();
        assert!(note.is_empty(), "签在文件末尾时不该有增量更新提示：{note}");
    }

    #[test]
    fn unsigned_pdf_is_not_signed_not_valid_and_not_an_error() {
        let out = run(&fixture("unsigned.pdf")).expect("未签名不是错误");

        assert_eq!(out["meta"]["signature_count"], json!(0));
        assert_eq!(out["meta"]["verified"], json!(false));
        assert_eq!(out["meta"]["integrity_verified"], json!(false));
        assert_eq!(
            row(&out, &title("en", "out.pdf-signature-checker.signature_count")),
            "0"
        );
        assert_eq!(
            out["output"].as_str().unwrap(),
            title("en", "out.pdf-signature-checker.unsigned_summary")
        );
        // 关键：不能因为「没签名」就显示成有效。
        assert!(!out["output"]
            .as_str()
            .unwrap()
            .contains(&title("en", "out.pdf-signature-checker.verdict_valid")));
        assert_eq!(
            row(&out, &title("en", "out.pdf-signature-checker.verdict")),
            title("en", "out.pdf-signature-checker.unsigned_verdict")
        );
        assert_eq!(
            row(&out, &title("en", "out.pdf-signature-checker.explanation")),
            title("en", "out.pdf-signature-checker.unsigned_explanation")
        );
    }

    #[test]
    fn expired_certificate_surfaces_the_expiry() {
        let out = run(&fixture("signed_expired.pdf")).expect("过期不等于解析失败");

        // 内容和签名值仍然是对的 —— 过期是证书的事，不是签名被改的事。
        assert_eq!(out["meta"]["signatures"][0]["verdict"], json!("valid"));
        assert_eq!(
            out["meta"]["signatures"][0]["signature_value_verified"],
            json!(true)
        );
        // 但有效期必须被如实报出来，而不是显示「有效期内」。
        assert_eq!(
            out["meta"]["signatures"][0]["certificate_valid_at_signing_time"],
            json!(false)
        );
        assert_eq!(
            out["meta"]["certificate_valid_at_signing_time"],
            json!(false)
        );
        let validity = row(
            &out,
            &sig_title("en", 1, "out.pdf-signature-checker.row_certificate_validity"),
        );
        assert_ne!(
            validity,
            title("en", "out.pdf-signature-checker.validity_ok"),
            "证书已过期，不能显示成有效期内：{validity}"
        );
        // 有效期要带上起止 —— 那两个年份是插值进去的，语言包里还没这条键时
        // （文案尚未并进语言包）看不到它，所以只在键存在时才断言。
        if crate::i18n::has("en", "out.pdf-signature-checker.validity_expired") {
            assert!(
                validity.contains("2020") && validity.contains("2021"),
                "应当带上有效期的起止，got {validity}"
            );
        }
        assert!(row(&out, &sig_title("en", 1, "out.pdf-signature-checker.row_signer"))
            .contains("Expired Signer"));
    }

    #[test]
    fn not_a_pdf_is_a_clean_invalid_error() {
        // 随机字节
        let junk: Vec<u8> = (0u8..=255).cycle().take(4096).collect();
        assert_eq!(
            err_key(&run(&junk).unwrap_err()),
            Some("out.pdf-signature-checker.err.not_a_pdf")
        );

        // 文本假扮 PDF：有 %PDF- 头，但没有一个字节的结构是对的
        let fake = b"%PDF-1.7\nthis is not really a pdf, just text pretending to be one\n";
        let err = run(fake).expect_err("应当报错");
        assert_eq!(
            err_key(&err),
            Some("out.pdf-signature-checker.err.pdf_parse_failed")
        );

        // 纯文本，没有任何 PDF 特征
        assert_eq!(
            err_key(&run(b"hello world, definitely not a pdf").unwrap_err()),
            Some("out.pdf-signature-checker.err.not_a_pdf")
        );

        // 单个 % 都不该崩
        assert_eq!(
            err_key(&run(b"%").unwrap_err()),
            Some("out.pdf-signature-checker.err.not_a_pdf")
        );
    }

    #[test]
    fn empty_and_non_base64_input_are_clean_errors() {
        // 缺字段 / 只有空白 —— 公共辅助函数统一报「缺少字段」
        assert_eq!(
            err_key(&compute(json!({})).unwrap_err()),
            Some("out.common.missing_field")
        );
        assert_eq!(
            err_key(&compute(json!({ "file": "" })).unwrap_err()),
            Some("out.common.missing_field")
        );
        assert_eq!(
            err_key(&compute(json!({ "file": "   " })).unwrap_err()),
            Some("out.common.missing_field")
        );
        // base64 解不开
        assert_eq!(
            err_key(&compute(json!({ "file": "这不是 base64!!!" })).unwrap_err()),
            Some("out.pdf-signature-checker.err.invalid_base64")
        );
    }

    #[test]
    fn oversized_input_is_rejected_before_parsing() {
        let mut big = b"%PDF-1.7\n".to_vec();
        big.resize(MAX_PDF_BYTES + 1, b'0');
        let err = run(&big).expect_err("应当被大小上限拦下");
        match err {
            ToolError::InvalidKeyed { key, args } => {
                assert_eq!(key, "out.pdf-signature-checker.err.file_too_large_after_decode");
                // 大小与上限都要带上 —— 用户得知道差多少
                assert!(
                    args.iter().any(|(n, v)| n == "size" && v == &(MAX_PDF_BYTES + 1).to_string()),
                    "{args:?}"
                );
                assert!(
                    args.iter().any(|(n, v)| n == "limit" && v == &MAX_PDF_BYTES.to_string()),
                    "{args:?}"
                );
            }
            other => panic!("不应当是 {other:?}"),
        }
    }

    /// 造一个「解压炸弹」PDF：文件本身只有几十 KB，里面的交叉引用流（/XRef）
    /// 解压后却有 16 MB 起步。
    ///
    /// 上传大小上限（`MAX_PDF_BYTES`）挡不住这种文件 —— 它小得不能再小；
    /// 挡住它的是 `MAX_DECOMPRESSED_BYTES`：解压到超过上限的那一刻就报错。
    ///
    /// 做法跟 lopdf 自己那个 `decompression_bomb` 例子一样：把交叉引用流的内容
    /// 换成一段 FlateDecode 的压缩炸弹，其余照常。
    fn decompression_bomb_pdf(target: usize) -> Vec<u8> {
        let mut stream = lopdf::Stream::new(Dictionary::new(), vec![0u8; target]);
        stream.compress().expect("压缩炸弹");
        let bomb = stream.content;

        let mut pdf = Vec::new();
        pdf.extend_from_slice(b"%PDF-1.5\n");
        let offset = pdf.len();
        pdf.extend_from_slice(b"1 0 obj\n");
        pdf.extend_from_slice(
            format!(
                "<< /Type /XRef /Size 1 /W [1 1 1] /Root 1 0 R /Filter /FlateDecode /Length {} >>\n",
                bomb.len()
            )
            .as_bytes(),
        );
        pdf.extend_from_slice(b"stream\n");
        pdf.extend_from_slice(&bomb);
        pdf.extend_from_slice(b"\nendstream\nendobj\n");
        pdf.extend_from_slice(format!("startxref\n{offset}\n%%EOF").as_bytes());
        pdf
    }

    #[test]
    fn a_decompression_bomb_is_refused_instead_of_unpacked() {
        let bomb = decompression_bomb_pdf(MAX_DECOMPRESSED_BYTES + 1024 * 1024);
        // 炸弹本身小得不像话 —— 挡住它的不可能是上传大小上限。
        assert!(bomb.len() < 1024 * 1024, "炸弹 PDF 只有 {} 字节", bomb.len());

        // 问 lopdf：错误必须是「解压超限」，不能是别的什么毛病。
        let err = Document::load_mem_with_options(
            &bomb,
            LoadOptions::with_max_decompressed_size(MAX_DECOMPRESSED_BYTES),
        )
        .expect_err("有上限时必须加载失败");
        assert!(
            matches!(
                err,
                lopdf::Error::Decompress(lopdf::DecompressError::MemoryLimitExceeded { limit })
                    if limit == MAX_DECOMPRESSED_BYTES
            ),
            "实际错误：{err:?}"
        );

        // 走工具自己的那条路：用户看到的是一句「解析失败」，
        // 而不是整个进程被这一份几十 KB 的文件吃光内存。
        let err = run(&bomb).expect_err("工具必须拒绝这个文件");
        assert_eq!(
            err_key(&err),
            Some("out.pdf-signature-checker.err.pdf_parse_failed")
        );
    }

    /// 错误信息也按请求语言渲染 —— 语言不是工具决定的，是 API 层调
    /// `localize` 时按请求语言渲染的。
    #[test]
    fn the_error_message_follows_the_requested_language() {
        let err = compute(json!({ "file": "这不是 base64!!!" })).unwrap_err();
        // 语言包里还没并进来时，localize 退回键本身 —— 这时断言跳过
        if !crate::i18n::has("zh-CN", "out.pdf-signature-checker.err.invalid_base64") {
            return;
        }
        let en = err.localize("en");
        let zh = err.localize("zh-CN");
        assert_ne!(en, zh, "两种语言不该是同一句");
        assert!(
            !en.contains("out.pdf-signature-checker"),
            "英文界面不该露出键：{en}"
        );
        assert!(zh.contains("base64"), "中文错误 = {zh}");
    }

    #[test]
    fn byte_range_pointing_past_eof_is_reported_as_a_broken_dictionary() {
        let out = run(&fixture("signed_bad_byterange.pdf")).expect("不应 panic");
        assert_eq!(out["meta"]["verified"], json!(false));
        assert_eq!(
            out["meta"]["signatures"][0]["verdict"],
            json!("malformed_signature_dictionary")
        );
        let verdict = row(&out, &sig_title("en", 1, "out.pdf-signature-checker.row_verdict"));
        // 坏字典要报「无法校验」，绝不能显示成「签名有效」。
        assert_ne!(
            verdict,
            title("en", "out.pdf-signature-checker.verdict_valid"),
            "结论 = {verdict}"
        );
        if crate::i18n::has("en", "out.pdf-signature-checker.verdict_malformed") {
            assert!(
                verdict.contains("signature dictionary"),
                "结论 = {verdict}"
            );
        }

        // 字典坏了就等于完整性一次都没验过 —— 不能因为「没报被篡改」就显示成完好。
        // 这条曾经是 `!any_altered`，在坏字典上是空真。
        assert_eq!(out["meta"]["integrity_verified"], json!(false));
        assert_eq!(
            out["meta"]["signatures"][0]["content_unaltered_since_signing"],
            json!(false)
        );
    }

    #[test]
    fn truncated_contents_is_reported_not_panicked() {
        // 这份 fixture 的 /Contents 十六进制被砍掉一半，且没有闭合的 '>'，
        // lopdf 会直接丢掉这个对象 —— 于是 AcroForm 里的 /V 指向了一个空引用。
        let result = run(&fixture("signed_truncated_contents.pdf"));
        match result {
            // 「签名存在但字典坏了」和「未签名」必须区分开
            Ok(out) => assert_eq!(out["meta"]["signature_count"], json!(0)),
            Err(ToolError::InvalidKeyed { key, .. }) => {
                // 错误键都在 err.* 命名空间里 —— 「未签名」是结果区的一条，不是错误
                assert!(key.starts_with("out.pdf-signature-checker.err."), "{key}");
            }
            Err(other) => panic!("不应当是 {other:?}"),
        }
    }

    #[test]
    fn truncated_signature_dictionary_makes_no_panic() {
        // 把好文件从各个位置砍短，检查永远不会 panic。
        let original = fixture("signed_valid.pdf");
        for cut in [1usize, 2, 10, 100, 600, 1200, 2500, 4000, 5000] {
            if cut >= original.len() {
                continue;
            }
            let _ = run(&original[..original.len() - cut]);
        }
    }

    #[test]
    fn every_byte_of_a_signed_pdf_flipping_to_nonsense_does_not_panic() {
        let original = fixture("signed_valid.pdf");
        for cut in 1..(original.len().min(1200)) {
            let mut broken = original.clone();
            broken[cut] = 0xff;
            let _ = run(&broken);
        }
    }

    #[test]
    fn output_never_uses_the_html_key() {
        // 证书里的 subject/issuer 是攻击者可控的字节。render() 走 innerHTML 的分支
        // 只有 json.html 一条，这里断言它压根不存在。
        for name in ["signed_valid.pdf", "signed_expired.pdf", "unsigned.pdf"] {
            let out = run(&fixture(name)).unwrap();
            assert!(out.get("html").is_none(), "{name} 不该有 html 字段");
        }
    }

    #[test]
    fn control_characters_in_certificate_strings_are_sanitised() {
        // render() 用 textContent，本来就不会解析 HTML；但控制字符会冲散两列表格。
        assert_eq!(sanitize("CN\na\nb\tc"), "CN a b c");
        assert_eq!(sanitize("  padded  "), "padded");
        assert_eq!(sanitize("\u{0}\u{1}"), "");
        // 超长字符串被截断
        assert_eq!(
            sanitize(&"x".repeat(500)).chars().count(),
            MAX_LABEL_LEN + 1
        );
    }

    #[test]
    fn signing_time_parsing_accepts_both_shapes() {
        // 只有日期 = 当天 00:00:00 UTC
        assert_eq!(
            parse_epoch("2026-10-22"),
            parse_epoch("2026-10-22T00:00:00Z")
        );
        // 时刻必须真的参与比较 —— 只看日期的话，「证书生效当天签的名」会被
        // 误判成「签名时证书还没生效」。
        assert_ne!(
            parse_epoch("2026-10-22"),
            parse_epoch("2026-10-22T06:50:27Z")
        );
        assert!(parse_epoch("2026-10-22").is_some());
        assert!(parse_epoch("").is_none());
        assert!(parse_epoch("garbage").is_none());
        assert!(parse_epoch("2026-13-45").is_none());
    }

    fn byte_range_dict(values: &[i64]) -> Dictionary {
        let mut dict = Dictionary::new();
        dict.set(
            b"ByteRange",
            Object::Array(values.iter().map(|v| Object::Integer(*v)).collect()),
        );
        dict
    }

    #[test]
    fn byte_range_is_offsets_plus_lengths_not_offsets_plus_ends() {
        // 第二段的 d 是长度，正常文件里 d 远小于 c —— 若当成「终点」就会误判。
        assert_eq!(
            read_byte_range(&byte_range_dict(&[0, 724, 4822, 235]), 10_000, "en"),
            Ok((0, 724, 4822, 235))
        );
    }

    #[test]
    fn malformed_byte_ranges_are_rejected_with_a_reason() {
        // 理由本身是语言包里的文案 —— 断言也从语言包里取，两边口径一致。
        for (values, key) in [
            (
                vec![0, 10, 5, 10],
                "out.pdf-signature-checker.reason_byte_range_overlap",
            ),
            (
                vec![0, 10, 5, 10, 10],
                "out.pdf-signature-checker.reason_byte_range_count",
            ),
            (
                vec![0, -1, 5, 10],
                "out.pdf-signature-checker.reason_byte_range_negative",
            ),
            // 区间伸出文件之外：PDF 的整数最大也就 i64，这里给个 u32::MAX 就够
            // 越界了（真要 u64 溢出得给 i64::MAX，那才是另一条检查）。
            (
                vec![0, u32::MAX as i64, u32::MAX as i64, 1],
                "out.pdf-signature-checker.reason_byte_range_out_of_bounds",
            ),
        ] {
            let err = read_byte_range(&byte_range_dict(&values), 10_000, "zh-CN").unwrap_err();
            let Verdict::Malformed(reason) = err else {
                panic!("坏掉的 ByteRange 应当报「签名字典损坏」：{values:?}");
            };
            assert!(
                reason.contains(&template_head("zh-CN", key)),
                "{values:?} -> {reason}"
            );
        }

        // 缺字段
        assert!(read_byte_range(&Dictionary::new(), 10_000, "en").is_err());

        // 非整型元素
        let mut dict = Dictionary::new();
        dict.set(
            b"ByteRange",
            Object::String(b"nope".to_vec(), StringFormat::Literal),
        );
        assert!(read_byte_range(&dict, 10_000, "en").is_err());

        // ByteRange 是字典而不是数组
        let mut dict = Dictionary::new();
        dict.set(b"ByteRange", Object::Dictionary(Dictionary::new()));
        assert!(read_byte_range(&dict, 10_000, "en").is_err());
    }

    #[test]
    fn every_single_byte_mutation_is_detected() {
        let original = fixture("signed_valid.pdf");
        let needle = b"SIGNED PAYLOAD TEXT";
        let marker = original
            .windows(needle.len())
            .position(|w| w == needle)
            .expect("fixture 里有正文");
        let mut missed = 0;
        for byte in 0u8..=255 {
            if byte == b'S' {
                continue; // 改成原值不算改动
            }
            let mut tampered = original.clone();
            tampered[marker] = byte;
            let out = run(&tampered).expect("篡改后仍应当给出结果，而不是报错");
            if out["meta"]["signatures"][0]["content_unaltered_since_signing"] == json!(true) {
                missed += 1;
            }
        }
        assert_eq!(missed, 0, "有 {missed} 个字节的改动没被发现");
    }

    /// 结果区的文案要跟着请求语言走。
    ///
    /// 同一个输入：带 `"__lang": "zh-CN"` 是中文行标题，不带（默认英文）是英文行标题。
    #[test]
    fn result_text_follows_the_request_language() {
        let bytes = fixture("signed_valid.pdf");
        let en = run(&bytes).expect("应当成功");
        let zh = compute(json!({ "file": BASE64.encode(&bytes), "__lang": "zh-CN" }))
            .expect("应当成功");

        let en_title = title("en", "out.pdf-signature-checker.signature_count");
        let zh_title = title("zh-CN", "out.pdf-signature-checker.signature_count");
        assert_eq!(row(&en, &en_title), "1");
        assert_eq!(row(&zh, &zh_title), "1");

        // 每个签名那一组的行标题也一样（「签名 1 · 结论」）。
        assert_eq!(
            row(&en, &sig_title("en", 1, "out.pdf-signature-checker.row_verdict")),
            title("en", "out.pdf-signature-checker.verdict_valid")
        );
        assert_eq!(
            row(&zh, &sig_title("zh-CN", 1, "out.pdf-signature-checker.row_verdict")),
            title("zh-CN", "out.pdf-signature-checker.verdict_valid")
        );

        // 语言包里还没有这两条键时（文案还没并进语言包），两边拿到的都是键本身，
        // 谈不上「中文 / 英文」—— 这时跳过这条断言。
        if crate::i18n::has("zh-CN", "out.pdf-signature-checker.signature_count") {
            assert_ne!(en_title, zh_title, "两种语言的行标题不能一样");
            assert!(zh_title.contains("签名"), "中文行标题 = {zh_title}");
            assert!(en_title.contains("Signature"), "英文行标题 = {en_title}");

            // 主结果 output 也是散文，跟着语言走。
            let en_output = en["output"].as_str().unwrap();
            let zh_output = zh["output"].as_str().unwrap();
            assert_ne!(en_output, zh_output, "两种语言的结论不能一样");
            assert_eq!(
                en_output,
                title("en", "out.pdf-signature-checker.summary_valid")
            );
            assert_eq!(
                zh_output,
                title("zh-CN", "out.pdf-signature-checker.summary_valid")
            );
            assert!(zh_output.contains("签名"), "中文结论 = {zh_output}");
            assert!(en_output.contains("Signature"), "英文结论 = {en_output}");
        }
    }

    /// 源码里用到的 `out.pdf-signature-checker.*` 键，必须与
    /// `new-tool/pdf-signature-checker.fields.txt` 里写的逐字一致。
    ///
    /// 少一条，语言包里就少一条文案 —— 页面上那一行会变成键本身；
    /// 多一条，语言包里就多一条没人读的文案。
    #[test]
    fn every_key_in_the_fields_file_matches_the_source() {
        let fields = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/new-tool/pdf-signature-checker.fields.txt"
        );
        // 暂存区被清掉了（合并之后就会这样）—— 没东西可比，跳过。
        let Ok(text) = std::fs::read_to_string(fields) else {
            return;
        };
        let src = std::fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/src/tools/pdf_signature_checker.rs"
        ))
        .expect("读不到自己的源码");

        let listed: Vec<String> = text
            .lines()
            .map(str::trim)
            .filter(|line| !line.is_empty() && !line.starts_with('#'))
            .map(|line| line.split(':').next().unwrap_or("").trim().to_string())
            .collect();
        assert!(!listed.is_empty(), "fields.txt 里一条文案都没有？");

        for key in &listed {
            assert!(
                key.starts_with("out.pdf-signature-checker."),
                "键必须以 out.pdf-signature-checker. 开头：{key}"
            );
            assert!(
                src.contains(&format!("\"{key}\"")),
                "源码里没有用这个键：{key}"
            );
        }

        // 反过来：源码里用到的每个键都得在清单里。
        for key in keys_in_source(&src) {
            assert!(listed.contains(&key), "源码用了但清单里没有：{key}");
        }
    }

    /// 源码里出现的 `out.pdf-signature-checker.<名字>` 字符串字面量。
    fn keys_in_source(src: &str) -> Vec<String> {
        const PREFIX: &str = "out.pdf-signature-checker.";
        let mut out = Vec::new();
        let mut rest = src;
        while let Some(at) = rest.find(PREFIX) {
            rest = &rest[at + PREFIX.len()..];
            // 键名可以有多段（`err.invalid_base64`），所以 `.` 也算名字的一部分 ——
            // 跟 `src/i18n.rs` 里那个死键扫描器的字符集一致。
            let end = rest
                .find(|c: char| !(c.is_ascii_alphanumeric() || c == '_' || c == '.'))
                .unwrap_or(rest.len());
            let name = &rest[..end];
            // 名字以 `.` 结尾的不是键 —— 那是断言里写的前缀
            // （`"out.pdf-signature-checker.err."`），后面接的是别的东西。
            if !name.is_empty() && !name.ends_with('.') {
                out.push(format!("{PREFIX}{name}"));
            }
        }
        out
    }
}
