//! 包含一批地址、排除一批地址 → 剩下的是哪些。
//!
//! 参考实现：/data/work/it-tools2/src/tools/ip-include-exclude/
//! （sharevb/it-tools 的 fork）。它用 `ip-matching` 把两边的输入拆成掩码，
//! 再交给 `cidr-tools` 的 `excludeCidr` 算出「包含的里面扣掉排除的」。
//!
//! ## 与上游的差别
//!
//! 1. **换行也算分隔符**。上游只按 `, ; |` 切分（`/\s*[,;|]+\s*/`），
//!    所以两行 CIDR 在上游是**一坨**（解析失败 → 静悄悄地什么都不显示）。
//!    这里换行、空格、逗号、分号、竖线都算分隔符 —— 一个多行文本框
//!    本来就该一行一个。
//! 2. **掩码写法不收**。上游的 `getMatch` 还认 `255.255.255.0` 这种掩码，
//!    但掩码得先知道它是几位的才写得出来，实际用的人极少 ——
//!    这里只收三种：CIDR、地址区间、单个地址。
//! 3. **排除不存在的段落会明说**。上游把「排除段根本不在包含段里」当
//!    成没事发生。这里在结果里给一行「有几个排除段没起作用」——
//!    用户以为自己排掉了什么，其实没排掉，是最容易踩的坑。
//! 4. **重���或相邻的包含段会合并**。上游是逐个掩码处理的，
//!    `192.168.0.0/25` 与 `192.168.0.128/25` 在上游是两个网段，
//!    这里合成一个。

use num_bigint::BigUint;
use serde_json::{json, Map, Value};

use super::cidr;
use super::util;
use super::{ToolError, ToolResult};

/// 结果里最多列多少个网段。
///
/// 贪心切分出来的网段数一般很少（把 `/0` 挖掉一个小块也只是多出十来个），
/// 但输入可以是任意多段 —— 上限是为了不让页面上出现几十万行。
const MAX_CIDRS: usize = 4096;

/// 与注册表 `ApiSpec.fields` 保持一致。
pub async fn handle(payload: Value) -> ToolResult {
    compute(payload)
}

fn compute(payload: Value) -> ToolResult {
    let include_text = util::str_or(&payload, "include_ranges", "");
    let exclude_text = util::str_or(&payload, "exclude_ranges", "");

    let included = parse_list(include_text)?;
    if included.is_empty() {
        return Err(ToolError::invalid(
            "out.ip-include-exclude.err.no_include",
            &[("field", "include_ranges")],
        ));
    }
    let excluded = parse_list(exclude_text)?;

    // 合并之后再来减 —— 先减再合并会漏掉「两段各自被挖掉一半，合起来是个洞」
    // 这种情形（挖掉的两段中间又合上了）。
    let included = cidr::merge_spans(included);
    let excluded = cidr::merge_spans(excluded);

    // 逐个排除段从包含段里减掉
    let mut remaining = included.clone();
    let mut effective = 0usize;
    for ex in &excluded {
        let before: BigUint = remaining.iter().map(cidr::span_len).sum();
        let mut next = Vec::new();
        for r in &remaining {
            next.extend(cidr::subtract_span(r, ex));
        }
        let after: BigUint = next.iter().map(cidr::span_len).sum();
        if after < before {
            effective += 1;
        }
        remaining = next;
    }
    let remaining = cidr::merge_spans(remaining);

    // 剩下的每一段切成数量最少的 CIDR
    let mut cidrs: Vec<String> = Vec::new();
    let mut rows: Vec<Value> = Vec::new();
    let mut total_addresses = num_bigint::BigUint::from(0u8);
    for span in &remaining {
        for (addr, prefix) in cidr::span_to_cidrs(span) {
            let text = cidr::fmt_cidr(&addr, prefix);
            let block = cidr::span_of_network(&addr, prefix).unwrap_or_else(|| span.clone());
            let first = cidr::span_first(&block);
            let last = cidr::span_last(&block);
            rows.push(json!({
                "key": text,
                "label": text,
                "value": format!("{} - {}", cidr::fmt_addr(&first), cidr::fmt_addr(&last)),
            }));
            cidrs.push(text);
            total_addresses += cidr::span_len(&block);
        }
    }
    if cidrs.len() > MAX_CIDRS {
        return Err(ToolError::invalid(
            "out.common.cidr.err.too_many",
            &[
                ("count", &cidrs.len().to_string()),
                ("limit", &MAX_CIDRS.to_string()),
            ],
        ));
    }

    let mut table = Map::new();
    util::row_str(
        &mut table,
        &payload,
        "out.ip-include-exclude.included",
        &included
            .iter()
            .map(cidr::fmt_span)
            .collect::<Vec<_>>()
            .join(", "),
    );
    util::row_str(
        &mut table,
        &payload,
        "out.ip-include-exclude.excluded",
        &excluded
            .iter()
            .map(cidr::fmt_span)
            .collect::<Vec<_>>()
            .join(", "),
    );
    util::row_str(
        &mut table,
        &payload,
        "out.ip-include-exclude.remaining",
        &cidrs.len().to_string(),
    );
    util::row_str(
        &mut table,
        &payload,
        "out.ip-include-exclude.total_addresses",
        &total_addresses.to_str_radix(10),
    );
    util::row_str(
        &mut table,
        &payload,
        "out.ip-include-exclude.effective_excludes",
        &effective.to_string(),
    );

    Ok(json!({
        "output": cidrs.join("\n"),
        "table": table,
        "rows": rows,
        "meta": { "count": cidrs.len() },
    }))
}

/// 把一段文本拆成若干个地址段。
///
/// 分隔符：换行、空格、逗号、分号、竖线。CIDR 里不会出现这些字符，
/// 所以按它们切分不会切坏东西。
fn parse_list(text: &str) -> Result<Vec<cidr::Span>, ToolError> {
    let mut out = Vec::new();
    for piece in text.split(|c: char| c.is_whitespace() || c == ',' || c == ';' || c == '|') {
        let piece = piece.trim();
        if piece.is_empty() {
            continue;
        }
        let span = cidr::parse_span(piece).map_err(|e| cidr::span_error(e, piece))?;
        out.push(span);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(include: &str, exclude: &str) -> Value {
        compute(json!({ "include_ranges": include, "exclude_ranges": exclude }))
            .expect("应当算出结果")
    }

    fn table_of(v: &Value) -> Map<String, Value> {
        v["table"].as_object().cloned().unwrap()
    }

    fn label(key: &str) -> String {
        crate::i18n::t("en", key)
    }

    #[test]
    fn an_excluded_block_is_taken_out() {
        // 与 Python `ipaddress` 的区间减法一致
        let out = run("192.168.0.0/16", "192.168.1.0/24");
        assert_eq!(
            out["output"],
            json!(
                "192.168.0.0/24\n192.168.2.0/23\n192.168.4.0/22\n192.168.8.0/21\n\
                 192.168.16.0/20\n192.168.32.0/19\n192.168.64.0/18\n192.168.128.0/17"
            )
        );
    }

    #[test]
    fn several_excluded_blocks_are_all_taken_out() {
        let out = run("10.0.0.0/24", "10.0.0.0/25\n10.0.0.128/25");
        // 两半都被挖掉了 → 什么都不剩
        assert_eq!(out["output"], json!(""));
        assert_eq!(table_of(&out)[&label("out.ip-include-exclude.remaining")], json!("0"));
    }

    #[test]
    fn separators_all_work() {
        let expected = "192.168.0.0/24\n192.168.3.0/24\n192.168.4.0/22\n192.168.8.0/21\n\
                        192.168.16.0/20\n192.168.32.0/19\n192.168.64.0/18\n192.168.128.0/17";
        for sep in ["\n", " ", ",", ";", "|"] {
            let out = run(
                "192.168.0.0/16",
                &format!("192.168.1.0/24{sep}192.168.2.0/24"),
            );
            assert_eq!(out["output"], json!(expected), "分隔符 {sep:?}");
        }
    }

    #[test]
    fn excluding_nothing_leaves_everything() {
        let out = run("192.168.0.0/24", "");
        assert_eq!(out["output"], json!("192.168.0.0/24"));
    }

    #[test]
    fn an_exclusion_outside_the_included_range_does_nothing() {
        let out = run("192.168.0.0/24", "10.0.0.0/8");
        assert_eq!(out["output"], json!("192.168.0.0/24"));
        // 明说「一个排除段没起作用」
        assert_eq!(
            table_of(&out)[&label("out.ip-include-exclude.effective_excludes")],
            json!("0")
        );
    }

    #[test]
    fn overlapping_included_blocks_are_merged_first() {
        let out = run("192.168.0.0/25,192.168.0.128/25", "192.168.0.64/26");
        assert_eq!(out["output"], json!("192.168.0.0/26\n192.168.0.128/25"));
    }

    #[test]
    fn the_remaining_blocks_carry_their_address_range() {
        let out = run("192.168.0.0/16", "192.168.1.0/24");
        let rows = out["rows"].as_array().unwrap();
        assert_eq!(rows.len(), 8);
        assert_eq!(rows[0]["key"], json!("192.168.0.0/24"));
        assert_eq!(rows[0]["value"], json!("192.168.0.0 - 192.168.0.255"));
        assert_eq!(rows[1]["key"], json!("192.168.2.0/23"));
        assert_eq!(rows[1]["value"], json!("192.168.2.0 - 192.168.3.255"));
        assert_eq!(rows[7]["key"], json!("192.168.128.0/17"));
        assert_eq!(rows[7]["value"], json!("192.168.128.0 - 192.168.255.255"));
    }

    #[test]
    fn bad_input_is_reported() {
        assert!(compute(json!({})).is_err());
        assert!(compute(json!({ "include_ranges": "" })).is_err());
        assert!(compute(json!({ "include_ranges": "nonsense" })).is_err());
    }

    #[test]
    fn ipv4_and_ipv6_can_be_mixed_in_one_list() {
        // 一个列表里既有 IPv4 又有 IPv6 是说得通的 —— 两段地址空间不打架
        let out = run("10.0.0.0/8,2001:db8::/32", "");
        assert_eq!(
            out["output"],
            json!("10.0.0.0/8\n2001:db8::/32")
        );
    }
}
