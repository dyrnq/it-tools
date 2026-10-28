//! 一段地址 → 最少的几个 CIDR。
//!
//! 参考实现：/data/work/it-tools2/src/tools/ip-range-to-cidr/
//! （sharevb/it-tools 的 fork）。它把区间里的**每一个地址**都放进一个
//! `BigInt64Array`，再交给 `cidr-tools` 的 `mergeCidr` 合并。
//!
//! ## 与上游的差别
//!
//! 1. **不枚举**。上游的做法是 O(区间里的地址数) 的内存：
//!    一个 `/8` 要 1600 万个元素，一个 IPv6 的 `/0` 要 4 亿个 ——
//!    `new BigInt64Array(Number(ipRangeLength))` 直接把标签页搞死。
//!    这里直接算，复杂度是 O(拆出来的网段数)，一个 `/0` 也是一个网段。
//! 2. **IPv6 也能用**。上游的 `BigInt64Array` 装不下大于 2^63-1 的数，
//!    所以 IPv6 的 `/0` 在上游是算不出来的。
//! 3. **一个输入框**。上游是「起始地址」「结束地址」两个框，
//!    这里合成一个「地址区间」框，三种写法都收：
//!    `10.0.0.1-10.0.0.100`、`10.0.0.0/24`、`10.0.0.1`。
//! 4. **起始大于结束会报错**。上游是静悄悄地返回空列表
//!    （页面上什么都不显示），这里明确告诉用户「结束地址比起始地址小」。

use serde_json::{json, Map, Value};

use super::cidr;
use super::util;
use super::ToolResult;

/// 与注册表 `ApiSpec.fields` 保持一致。
pub async fn handle(payload: Value) -> ToolResult {
    compute(payload)
}

fn compute(payload: Value) -> ToolResult {
    let input = util::req_str(&payload, "ip_range")?;
    let span = cidr::parse_span(input).map_err(|e| cidr::span_error(e, input))?;

    let cidrs = cidr::span_to_cidrs(&span);
    let list: Vec<String> = cidrs
        .iter()
        .map(|(addr, prefix)| cidr::fmt_cidr(addr, *prefix))
        .collect();

    let first = cidr::span_first(&span);
    let last = cidr::span_last(&span);

    let mut table = Map::new();
    util::row_str(
        &mut table,
        &payload,
        "out.ip-range-to-cidr.first",
        &cidr::fmt_addr(&first),
    );
    util::row_str(
        &mut table,
        &payload,
        "out.ip-range-to-cidr.last",
        &cidr::fmt_addr(&last),
    );
    util::row_str(
        &mut table,
        &payload,
        "out.ip-range-to-cidr.addresses",
        &cidr::span_len(&span).to_str_radix(10),
    );
    util::row_str(
        &mut table,
        &payload,
        "out.ip-range-to-cidr.cidrs",
        &list.len().to_string(),
    );

    Ok(json!({
        "output": list.join("\n"),
        "table": table,
        "rows": [],
        "meta": { "count": list.len() },
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(input: &str) -> Value {
        compute(json!({ "ip_range": input })).expect("应当算出结果")
    }

    fn table_of(v: &Value) -> Map<String, Value> {
        v["table"].as_object().cloned().unwrap()
    }

    fn label(key: &str) -> String {
        crate::i18n::t("en", key)
    }

    #[test]
    fn a_range_becomes_the_fewest_cidrs() {
        // 与 Python `ipaddress.summarize_address_range` 一致
        let out = run("192.168.1.1-192.168.1.10");
        assert_eq!(
            out["output"],
            json!(
                "192.168.1.1/32\n192.168.1.2/31\n192.168.1.4/30\n192.168.1.8/31\n192.168.1.10/32"
            )
        );
        let table = table_of(&out);
        assert_eq!(
            table[&label("out.ip-range-to-cidr.first")],
            json!("192.168.1.1")
        );
        assert_eq!(
            table[&label("out.ip-range-to-cidr.last")],
            json!("192.168.1.10")
        );
        assert_eq!(
            table[&label("out.ip-range-to-cidr.addresses")],
            json!("10")
        );
        assert_eq!(table[&label("out.ip-range-to-cidr.cidrs")], json!("5"));
    }

    #[test]
    fn an_aligned_range_is_one_cidr() {
        let out = run("10.0.0.0-10.0.0.255");
        assert_eq!(out["output"], json!("10.0.0.0/24"));
        assert_eq!(table_of(&out)[&label("out.ip-range-to-cidr.cidrs")], json!("1"));
    }

    #[test]
    fn a_cidr_input_gives_the_same_cidr_back() {
        let out = run("192.168.0.0/16");
        assert_eq!(out["output"], json!("192.168.0.0/16"));
    }

    #[test]
    fn a_single_address_is_a_host_route() {
        let out = run("192.168.1.1");
        assert_eq!(out["output"], json!("192.168.1.1/32"));
    }

    #[test]
    fn the_whole_ipv4_space_is_one_line() {
        let out = run("0.0.0.0-255.255.255.255");
        assert_eq!(out["output"], json!("0.0.0.0/0"));
        assert_eq!(
            table_of(&out)[&label("out.ip-range-to-cidr.addresses")],
            json!("4294967296")
        );
    }

    #[test]
    fn ipv6_ranges_work_too() {
        // 「::10」是十六进制 —— 是第 16 个地址，不是第 10 个
        let out = run("2001:db8::1-2001:db8::10");
        assert_eq!(
            out["output"],
            json!(
                "2001:db8::1/128\n2001:db8::2/127\n2001:db8::4/126\n2001:db8::8/125\n2001:db8::10/128"
            )
        );
    }

    #[test]
    fn bad_input_is_reported() {
        assert!(compute(json!({})).is_err());
        assert!(compute(json!({ "ip_range": "hello" })).is_err());
        // 起始大于结束
        assert!(compute(json!({ "ip_range": "10.0.0.9-10.0.0.1" })).is_err());
        // 两端版本不一样
        assert!(compute(json!({ "ip_range": "10.0.0.1-2001:db8::1" })).is_err());
    }
}
