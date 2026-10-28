//! CIDR 网段 → 地址区间。
//!
//! 参考实现：/data/work/it-tools2/src/tools/ip-cidr-to-range/
//! （sharevb/it-tools 的 fork）。它用 `cidr-tools` 的 `expandCidr`
//! 把网段**展开成每一个地址**再取头尾。
//!
//! ## 与上游的差别
//!
//! 1. **不展开**。`expandCidr('10.0.0.0/8')` 要生成 1600 万个地址字符串，
//!    `0.0.0.0/0` 更是 4 亿个 —— 页面上根本出不来。
//!    这里直接用算术取头尾，结果一样但快几个数量级。
//! 2. **多给几项**：掩码、反掩码、地址总数、可用主机数。
//! 3. **网络类型**用的是本仓库自己的一份小表（[`super::cidr`] 的
//!    `V4_SPECIAL`），不是 IANA 的完整登记表 —— 完整表有几十条，
//!    日常判断用不上。
//! 4. IPv6 **没有广播地址**（RFC 4291 §2.6 取消了），所以 IPv6 的结果里
//!    不给「广播地址」这一行 —— 给的是「最后一个地址」。

use serde_json::{json, Map, Value};

use super::cidr;
use super::util;
use super::{ToolError, ToolResult};

/// 与注册表 `ApiSpec.fields` 保持一致。
pub async fn handle(payload: Value) -> ToolResult {
    compute(payload)
}

fn compute(payload: Value) -> ToolResult {
    let input = util::req_str(&payload, "ip_block")?;
    let (net, prefix) = cidr::parse_network(input).ok_or_else(|| {
        ToolError::invalid("out.common.cidr.err.bad_value", &[("value", input)])
    })?;
    let span = cidr::span_of_network(&net, prefix).ok_or_else(|| {
        ToolError::invalid("out.common.cidr.err.bad_value", &[("value", input)])
    })?;

    let first = cidr::span_first(&span);
    let last = cidr::span_last(&span);
    let lang = util::lang(&payload);

    let mut table = Map::new();
    util::row_str(
        &mut table,
        &payload,
        "out.ip-cidr-to-range.cidr",
        &cidr::fmt_cidr(&net, prefix),
    );
    util::row_str(
        &mut table,
        &payload,
        "out.ip-cidr-to-range.network",
        &cidr::fmt_addr(&net),
    );
    util::row(&mut table, &payload, "out.ip-cidr-to-range.prefix", json!(prefix));
    util::row_str(
        &mut table,
        &payload,
        "out.ip-cidr-to-range.first",
        &cidr::fmt_addr(&first),
    );
    util::row_str(
        &mut table,
        &payload,
        "out.ip-cidr-to-range.last",
        &cidr::fmt_addr(&last),
    );
    // 广播地址只有 IPv4 有 —— IPv6 取消了它（RFC 4291 §2.6）
    if !span.v6 {
        util::row_str(
            &mut table,
            &payload,
            "out.ip-cidr-to-range.broadcast",
            &cidr::fmt_addr(&last),
        );
    }
    util::row_str(
        &mut table,
        &payload,
        "out.ip-cidr-to-range.netmask",
        &cidr::fmt_netmask(span.v6, prefix),
    );
    util::row_str(
        &mut table,
        &payload,
        "out.ip-cidr-to-range.wildcard",
        &cidr::fmt_wildcard(span.v6, prefix),
    );
    util::row_str(
        &mut table,
        &payload,
        "out.ip-cidr-to-range.total",
        &cidr::span_len(&span).to_str_radix(10),
    );
    util::row_str(
        &mut table,
        &payload,
        "out.ip-cidr-to-range.usable",
        &cidr::usable_hosts(&span, prefix),
    );
    util::row_str(
        &mut table,
        &payload,
        "out.ip-cidr-to-range.type",
        &cidr::classify_text(&first, lang),
    );

    Ok(json!({
        "output": cidr::fmt_span(&span),
        "table": table,
        "rows": [],
        "meta": { "prefix": prefix },
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(input: &str) -> Value {
        compute(json!({ "ip_block": input })).expect("应当算出结果")
    }

    fn table_of(v: &Value) -> Map<String, Value> {
        v["table"].as_object().cloned().unwrap()
    }

    /// 行的**标题**是按语言取出来的，所以断言按语言包里的键去取标题，
    /// 而不是把标题的字面量抄一遍 —— 抄一遍的话，改一次文案就要改一次断言。
    fn label(key: &str) -> String {
        crate::i18n::t("en", key)
    }

    #[test]
    fn a_24_block_gives_its_endpoints() {
        let out = run("192.168.1.0/24");
        let table = table_of(&out);
        assert_eq!(out["output"], json!("192.168.1.0 - 192.168.1.255"));
        assert_eq!(
            table[&label("out.ip-cidr-to-range.network")],
            json!("192.168.1.0")
        );
        assert_eq!(
            table[&label("out.ip-cidr-to-range.first")],
            json!("192.168.1.0")
        );
        assert_eq!(
            table[&label("out.ip-cidr-to-range.last")],
            json!("192.168.1.255")
        );
        assert_eq!(
            table[&label("out.ip-cidr-to-range.broadcast")],
            json!("192.168.1.255")
        );
        assert_eq!(
            table[&label("out.ip-cidr-to-range.netmask")],
            json!("255.255.255.0")
        );
        assert_eq!(
            table[&label("out.ip-cidr-to-range.wildcard")],
            json!("0.0.0.255")
        );
        assert_eq!(table[&label("out.ip-cidr-to-range.total")], json!("256"));
        assert_eq!(table[&label("out.ip-cidr-to-range.usable")], json!("254"));
        assert_eq!(table[&label("out.ip-cidr-to-range.prefix")], json!(24));
    }

    #[test]
    fn a_bare_address_is_a_single_host() {
        let out = run("192.168.1.1");
        let table = table_of(&out);
        assert_eq!(out["output"], json!("192.168.1.1 - 192.168.1.1"));
        assert_eq!(table[&label("out.ip-cidr-to-range.total")], json!("1"));
        // /32 只有一个地址，头尾都是它 —— 不扣
        assert_eq!(table[&label("out.ip-cidr-to-range.usable")], json!("1"));
    }

    #[test]
    fn a_slash_31_has_two_usable_addresses() {
        let out = run("192.168.1.0/31");
        let table = table_of(&out);
        assert_eq!(table[&label("out.ip-cidr-to-range.total")], json!("2"));
        assert_eq!(table[&label("out.ip-cidr-to-range.usable")], json!("2"));
    }

    #[test]
    fn ipv6_has_no_broadcast_row() {
        let out = run("2001:db8::/32");
        let table = table_of(&out);
        assert_eq!(
            out["output"],
            json!("2001:db8:: - 2001:db8:ffff:ffff:ffff:ffff:ffff:ffff")
        );
        assert!(!table.contains_key(&label("out.ip-cidr-to-range.broadcast")));
        assert_eq!(
            table[&label("out.ip-cidr-to-range.netmask")],
            json!("ffff:ffff::")
        );
        // /32 的 IPv6 段有 2^96 个地址 —— u32/u64 都装不下
        assert_eq!(
            table[&label("out.ip-cidr-to-range.total")],
            json!("79228162514264337593543950336")
        );
        // IPv6 扣掉头尾两个 anycast 地址
        assert_eq!(
            table[&label("out.ip-cidr-to-range.usable")],
            json!("79228162514264337593543950334")
        );
    }

    #[test]
    fn a_host_address_inside_a_block_is_snapped_to_the_network() {
        let out = run("10.0.0.5/24");
        let table = table_of(&out);
        assert_eq!(out["output"], json!("10.0.0.0 - 10.0.0.255"));
        assert_eq!(
            table[&label("out.ip-cidr-to-range.network")],
            json!("10.0.0.0")
        );
    }

    #[test]
    fn the_type_row_follows_the_address() {
        let out = run("10.0.0.0/8");
        let table = table_of(&out);
        assert_eq!(
            table[&label("out.ip-cidr-to-range.type")],
            json!(crate::i18n::t("en", "out.common.cidr.kind.private"))
        );
    }

    #[test]
    fn bad_input_is_reported() {
        assert!(compute(json!({})).is_err());
        assert!(compute(json!({ "ip_block": "" })).is_err());
        assert!(compute(json!({ "ip_block": "hello" })).is_err());
        assert!(compute(json!({ "ip_block": "192.168.1.0/33" })).is_err());
        assert!(compute(json!({ "ip_block": "2001:db8::/129" })).is_err());
    }
}
