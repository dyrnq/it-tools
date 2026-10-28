//! File hasher —— 上传文件的全部摘要（endpoint `file-hasher`）。
//!
//! 参考实现是 it-tools2 的 `file-hasher`：它在浏览器里用 `hash-wasm` 一次算出
//! 20 多种摘要并列表显示（md5 / sha1 / sha2 / sha3 / blake2 / keccak /
//! sm3 / whirlpool / ripemd160 / adler32 / crc32 …）。
//!
//! ## 算法清单不在这儿写第二份
//!
//! 摘要算法跟 `hash-text` 共用同一份清单（`hash_text::ALL`）和同一份实现
//! （`hash_text::hex`）。**不另写一张表** —— 两张表迟早会漂移，症状是
//! 「这个工具能算、那个工具算不出来」或者反过来。
//! `the_digests_match_the_hash_text_tool` 那条单测盯着这件事。
//!
//! 差在算法上：参考实现有 sm3 与 whirlpool，本仓库的 cargo 缓存里没有这两个
//! crate（这台机器不能联网拉），所以清单里也没有 —— 这是**少算**，
//! 不是算错，`hash-text` 的注释里记着同一件事。
//!
//! ## 输入是 base64，不是原始字节
//!
//! `src/handlers/api.rs` 的 multipart 分支只取**第一个文件字段**的原始字节，
//! 交给 handler 的是 `{"file": "<base64>"}`；**其它表单字段在这一步全被丢掉了**。
//! 所以这个工具**不能有第二个字段** —— 参考实现里那个「digest encoding」
//! 下拉（Bin / Hex / Base64 / Base64url）在这里做不出来，输出固定成十六进制。
//!
//! ## 大小上限
//!
//! base64 会把体积撑大 4/3，而 actix 的 `PayloadConfig` 默认放行 64 MB
//! ⇒ 真实文件最大约 48 MB。上限取 [`MAX_FILE_BYTES`]，超了报
//! `out.file-hasher.err.file_too_large`。
//!
//! ## 为什么丢到 blocking 线程池
//!
//! 几十 MB 的文件要算 23 种摘要，是 CPU 密集的活 —— 直接在 actix 的 worker 上算，
//! 那个 worker 上的所有请求都得排队。所以走 [`util::blocking`]。

use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use serde_json::{json, Map, Value};

use super::hash_text;
use super::util;
use super::{ToolError, ToolResult};

/// 上传文件的大小上限（字节）。
///
/// 64 MB 是 actix `PayloadConfig` 的默认上限，而 multipart 的内容在这里
/// 是 **base64**（体积 ×4/3），所以真实文件的上限是 64 MB × 3/4 = 48 MB。
/// 取整到 48 MB，多一点余量。
const MAX_FILE_BYTES: usize = 48 * 1024 * 1024;

pub async fn handle(payload: Value) -> ToolResult {
    util::blocking(move || compute(payload)).await
}

fn compute(payload: Value) -> ToolResult {
    compute_with_max(payload, MAX_FILE_BYTES)
}

/// 上限做成参数，是为了单测能拿一个小阈值试「超限」那条路 ——
/// 否则就得在测试里造一个 48 MB 的字符串。
fn compute_with_max(payload: Value, max_bytes: usize) -> ToolResult {
    // `file` 是 multipart 里那个文件字段的 base64。
    // 缺字段是用户侧错误（多半是手写请求），不是 500。
    let encoded = util::opt_str(&payload, "file")
        .ok_or_else(|| ToolError::invalid("out.common.missing_field", &[("field", "file")]))?;

    // 先按编码长度粗筛一道，免得为了拒绝一个超大的文件先把同样大的 Vec
    // 解出来（base64 每 4 个字符还原 3 个字节）。
    if encoded.len() > max_bytes / 3 * 4 + 8 {
        return Err(file_too_large(encoded.len() / 4 * 3, max_bytes));
    }

    // base64 解码失败是用户侧错误而不是 500：多半是有人直接 curl 了个非法 body。
    let bytes = BASE64
        .decode(encoded.trim())
        .map_err(|_| ToolError::invalid("out.file-hasher.err.invalid_base64", &[]))?;

    if bytes.len() > max_bytes {
        return Err(file_too_large(bytes.len(), max_bytes));
    }

    // 一个算法一个算法地算，`hex` 收的是 `&[u8]` —— 文件内容**不会**被复制，
    // 内存里只留一份。顺序与 `hash_text::ALL` 一致（也就是 `hash-text`
    // 并排视图里的顺序）。
    let mut table = Map::new();
    let mut rows: Vec<Value> = Vec::new();
    for algorithm in hash_text::ALL {
        let Some(digest) = hash_text::hex(algorithm, &bytes) else {
            continue;
        };
        table.insert((*algorithm).to_string(), json!(digest));
        // `rows` 是给「一行一个格式」那种界面用的 —— 参考实现的 file-hasher
        // 就是一列「算法名 + 只读框 + 复制图标」，前端按 rows 渲染。
        // 标签是算法名本身（md5 / sha256 这种通用标识符），不翻译。
        rows.push(json!({ "key": algorithm, "label": algorithm, "value": digest }));
    }

    Ok(json!({
        "output": "",
        "table": table,
        "rows": rows,
        "meta": { "size": bytes.len(), "count": rows.len() },
    }))
}

/// 「文件太大」这条错误。`{size}` 是文件大小（字节），`{max}` 是上限。
fn file_too_large(size: usize, max: usize) -> ToolError {
    ToolError::invalid(
        "out.file-hasher.err.file_too_large",
        &[("size", &size.to_string()), ("max", &max.to_string())],
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// 已知字节串的摘要跟 `hash-text` 算出来的**必须一样** ——
    /// 两处共用同一份 `hash_text::hex`，这里守住「共用」这件事没被改坏。
    #[test]
    fn the_digests_match_the_hash_text_tool() {
        let data = b"abc";
        let out = compute(json!({ "file": BASE64.encode(data) })).unwrap();
        let table = out["table"].as_object().unwrap();
        assert_eq!(table.len(), hash_text::ALL.len());
        for algorithm in hash_text::ALL {
            assert_eq!(
                table[*algorithm],
                hash_text::hex(algorithm, data).unwrap(),
                "{algorithm} 的摘要跟 hash-text 对不上"
            );
        }
    }

    /// 已知向量（外部参照）：MD5 / SHA-256 的公开标准值。
    ///
    /// * MD5("abc") = 900150983cd24fb0d6963f7d28e17f72 —— RFC 1321 附录 A.5；
    /// * SHA-256("abc") = ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad
    ///   —— FIPS 180-4 的例子。
    ///
    /// 顺带把 SHA-1 与 SHA-512 也钉上（RFC 3174 / FIPS 180-4）。
    #[test]
    fn the_digests_match_the_published_vectors() {
        let out = compute(json!({ "file": BASE64.encode(b"abc") })).unwrap();
        let table = out["table"].as_object().unwrap();
        assert_eq!(table["md5"], "900150983cd24fb0d6963f7d28e17f72");
        assert_eq!(
            table["sha256"],
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        assert_eq!(table["sha1"], "a9993e364706816aba3e25717850c26c9cd0d89d");
        assert_eq!(
            table["sha512"],
            "ddaf35a193617abacc417349ae20413112e6fa4e89a97ea20a9eeee64b55d39a\
             2192992a274fc1a836ba3c23a3feebbd454d4423643ce80e2a9ac94fa54ca49f"
        );
    }

    /// 空文件：空字节串的摘要也是确定的值（MD5 的 d41d8cd9… 是众所周知的）。
    ///
    /// 这里**不**报错 —— 参考实现对空文件也是照样算出所有摘要。
    /// （走界面上传时空文件会被 `src/handlers/api.rs` 挡掉，
    /// 那是 HTTP 层的事，跟这个 handler 无关。）
    #[test]
    fn an_empty_file_hashes_to_the_empty_digests() {
        let out = compute(json!({ "file": "" })).unwrap();
        let table = out["table"].as_object().unwrap();
        assert_eq!(table["md5"], "d41d8cd98f00b204e9800998ecf8427e");
        assert_eq!(
            table["sha256"],
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
        assert_eq!(out["meta"]["size"], 0);
        assert_eq!(out["meta"]["count"], hash_text::ALL.len());
    }

    /// base64 解不开要报「不是合法的 base64」，不是 500。
    #[test]
    fn invalid_base64_is_reported() {
        let err = compute(json!({ "file": "这不是 base64!!" })).unwrap_err();
        assert!(
            matches!(&err, ToolError::InvalidKeyed { key, .. }
                if *key == "out.file-hasher.err.invalid_base64"),
            "实际是 {err:?}"
        );
    }

    /// 缺 `file` 字段要报「缺字段」。
    #[test]
    fn a_missing_file_field_is_reported() {
        let err = compute(json!({})).unwrap_err();
        assert!(
            matches!(&err, ToolError::InvalidKeyed { key, .. }
                if *key == "out.common.missing_field"),
            "实际是 {err:?}"
        );
    }

    /// 超限要报错，而不是先把文件解出来再丢掉。
    ///
    /// 上限做成参数就是为了在这儿不用造一个 48 MB 的字符串。
    #[test]
    fn an_oversized_file_is_rejected() {
        // 64 个字节 → base64 88 个字符；编码长度这一关就拦得住。
        let err = compute_with_max(json!({ "file": BASE64.encode([0u8; 64]) }), 16).unwrap_err();
        assert!(
            matches!(&err, ToolError::InvalidKeyed { key, args, .. }
                if *key == "out.file-hasher.err.file_too_large"
                    && args.iter().any(|(n, v)| n == "max" && v == "16")),
            "实际是 {err:?}"
        );
    }

    /// 编码长度那一关放过、但解出来的字节超了 —— 另一条路也得拦住。
    #[test]
    fn an_oversized_file_is_rejected_after_decoding() {
        // 20 个字节 → base64 28 个字符；上限 16 时 max/3*4+8 = 28，
        // 编码长度那一关刚好放过，解出来才超。
        let err = compute_with_max(json!({ "file": BASE64.encode([0u8; 20]) }), 16).unwrap_err();
        match err {
            ToolError::InvalidKeyed { key, args } => {
                assert_eq!(key, "out.file-hasher.err.file_too_large");
                assert!(
                    args.iter().any(|(n, v)| n == "size" && v == "20"),
                    "实际是 {args:?}"
                );
            }
            other => panic!("应当报 file_too_large，实际 {other:?}"),
        }
    }

    /// `meta` 报文件大小与算法条数。
    #[test]
    fn the_meta_reports_the_size_and_the_count() {
        let out = compute(json!({ "file": BASE64.encode(b"abc") })).unwrap();
        assert_eq!(out["meta"]["size"], 3);
        assert_eq!(out["meta"]["count"], hash_text::ALL.len());
    }

    /// `rows` 一行一个算法，标签就是算法名。
    #[test]
    fn the_rows_carry_the_algorithm_name() {
        let out = compute(json!({ "file": BASE64.encode(b"abc") })).unwrap();
        let rows = out["rows"].as_array().unwrap();
        assert_eq!(rows.len(), hash_text::ALL.len());
        assert_eq!(rows[0]["key"], "md5");
        assert_eq!(rows[0]["label"], "md5");
        assert_eq!(rows[0]["value"], "900150983cd24fb0d6963f7d28e17f72");
        // 并排视图没有单一主结果
        assert_eq!(out["output"], "");
    }

    /// 错误文案在语言包里，按请求语言渲染 —— 英文界面下不该露出中文。
    #[test]
    fn the_error_message_follows_the_requested_language() {
        let err = compute(json!({ "file": "!!!" })).unwrap_err();
        // 语言包里还没并进来时，localize 退回键本身 —— 这时断言跳过
        if !crate::i18n::has("zh-CN", "out.file-hasher.err.invalid_base64") {
            return;
        }
        let en = err.localize("en");
        let zh = err.localize("zh-CN");
        assert_ne!(en, zh, "两种语言不该是同一句");
        assert!(!en.contains("out.file-hasher"), "英文界面不该露出键：{en}");
    }
}
