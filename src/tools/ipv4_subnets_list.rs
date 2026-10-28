//! IPv4 网段 → 它的子网清单。
//!
//! 参考实现：/data/work/it-tools2/src/tools/ipv4-subnets-list/
//! （sharevb/it-tools 的 fork）。它给一个 IPv4 地址（可带掩码），
//! 从这个掩码开始，**一级一级往下切**（/24 → /25 → /26 … → /30），
//! 每一级都列出全部子网，并给出每个子网的网络地址、第一个、最后一个与广播地址。
//!
//! ## 与上游的差别
//!
//! 1. **可以只切一级**。多一个「子网前缀长度」输入框：填了就只列那一级，
//!    留空才是上游那种「一级级全列」。
//! 2. **有上限**。上游对 `/16` 会列出 32766 个子网 —— 页面上根本出不来。
//!    这里超过 [`MAX_SUBNETS`] 就报错说清楚差多少。
//! 3. **IPv6 输入会明确报错**。上游的 `getSubnetsInfos` 遇到 IPv6 直接
//!    返回空数组 —— 页面上什么都没有，也不说为什么。
//! 4. 结果里给的是**可用主机区间**（网络地址与广播地址去掉），
//!    与上游的 firstIP / lastIP 一个口径。

use std::net::Ipv4Addr;

use serde_json::{json, Map, Value};

use super::cidr;
use super::util;
use super::{ToolError, ToolResult};

/// 最多列多少个子网。
const MAX_SUBNETS: u64 = 4096;

/// 切到 /30 为止 —— /31 与 /32 没有「可用主机」可言。
const LAST_PREFIX: u8 = 30;

/// 与注册表 `ApiSpec.fields` 保持一致。
pub async fn handle(payload: Value) -> ToolResult {
    compute(payload)
}

fn compute(payload: Value) -> ToolResult {
    let input = util::req_str(&payload, "ip_block")?;
    let (net, prefix) = cidr::parse_network(input).ok_or_else(|| {
        ToolError::invalid("out.common.cidr.err.bad_value", &[("value", input)])
    })?;
    let base = match net {
        std::net::IpAddr::V4(v4) => v4,
        std::net::IpAddr::V6(_) => {
            return Err(ToolError::invalid(
                "out.common.cidr.err.ipv4_only",
                &[("value", input)],
            ))
        }
    };

    // 目标前缀：填了就只列那一级；留空 = 从本段的前缀一路切到 /30（上游的做法）
    let targets: Vec<u8> = match util::opt_u64(&payload, "subnet_prefix") {
        Some(p) if p > 32 => {
            return Err(ToolError::invalid(
                "out.common.cidr.err.prefix_too_long",
                &[("prefix", &p.to_string())],
            ))
        }
        Some(p) if (p as u8) < prefix => {
            return Err(ToolError::invalid(
                "out.common.cidr.err.prefix_too_short",
                &[("prefix", &prefix.to_string()), ("target", &p.to_string())],
            ))
        }
        Some(p) => vec![p as u8],
        None => (prefix..=LAST_PREFIX).collect(),
    };

    // 数量上限：先算清楚再生成，别生成一半才发现太多
    let total: u64 = targets.iter().map(|p| 1u64 << (p - prefix)).sum();
    if total > MAX_SUBNETS {
        return Err(ToolError::invalid(
            "out.common.cidr.err.too_many",
            &[
                ("count", &total.to_string()),
                ("limit", &MAX_SUBNETS.to_string()),
            ],
        ));
    }

    let mut list: Vec<String> = Vec::new();
    let mut table = Map::new();
    for target in targets {
        let count = 1u64 << (target - prefix);
        let step = 1u64 << (32 - target);
        let start = u32::from(base) as u64;
        for i in 0..count {
            let addr = Ipv4Addr::from((start + i * step) as u32);
            let text = format!("{addr}/{target}");
            list.push(text.clone());
            table.insert(text, json!(usable_range(&addr, target)));
        }
    }

    util::row_str(
        &mut table,
        &payload,
        "out.ipv4-subnets-list.network",
        &format!("{base}/{prefix}"),
    );
    util::row_str(
        &mut table,
        &payload,
        "out.ipv4-subnets-list.count",
        &total.to_string(),
    );

    Ok(json!({
        "output": list.join("\n"),
        "table": table,
        "rows": [],
        "meta": { "count": total },
    }))
}

/// 一个子网的可用主机区间（"192.168.0.1 - 192.168.0.126"）。
///
/// /31 与 /32 没有网络地址与广播地址的概念（RFC 3021）—— 都是能用的。
fn usable_range(net: &Ipv4Addr, prefix: u8) -> String {
    if prefix >= 31 {
        return format!("{net} - {net}");
    }
    let size = 1u64 << (32 - prefix);
    let start = u32::from(*net) as u64;
    let first = Ipv4Addr::from((start + 1) as u32);
    let last = Ipv4Addr::from((start + size - 2) as u32);
    format!("{first} - {last}")
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

    fn label(key: &str) -> String {
        crate::i18n::t("en", key)
    }

    /// 上游对 `192.168.0.0/24` 会列出 /24 到 /30 的每一级 ——
    /// 1 + 2 + 4 + 8 + 16 + 32 + 64 = 127 个子网。
    #[test]
    fn blank_prefix_lists_every_size() {
        let out = run("192.168.0.0/24");
        let text = out["output"].as_str().unwrap();
        let lines: Vec<&str> = text.lines().collect();
        assert_eq!(lines.len(), 127);
        assert_eq!(lines[0], "192.168.0.0/24");
        assert_eq!(lines[1], "192.168.0.0/25");
        assert_eq!(lines[2], "192.168.0.128/25");
        assert_eq!(lines[126], "192.168.0.252/30");
        let table = table_of(&out);
        assert_eq!(
            table[&label("out.ipv4-subnets-list.network")],
            json!("192.168.0.0/24")
        );
        assert_eq!(table[&label("out.ipv4-subnets-list.count")], json!("127"));
    }

    #[test]
    fn a_given_prefix_lists_only_that_size() {
        let out = compute(json!({ "ip_block": "192.168.0.0/16", "subnet_prefix": 24 })).unwrap();
        let text = out["output"].as_str().unwrap();
        let lines: Vec<&str> = text.lines().collect();
        assert_eq!(lines.len(), 256);
        assert_eq!(lines[0], "192.168.0.0/24");
        assert_eq!(lines[1], "192.168.1.0/24");
        assert_eq!(lines[255], "192.168.255.0/24");
    }

    #[test]
    fn each_subnet_carries_its_usable_range() {
        let out = compute(json!({ "ip_block": "192.168.0.0/24", "subnet_prefix": 26 })).unwrap();
        let table = table_of(&out);
        assert_eq!(table["192.168.0.0/26"], json!("192.168.0.1 - 192.168.0.62"));
        assert_eq!(
            table["192.168.0.64/26"],
            json!("192.168.0.65 - 192.168.0.126")
        );
        assert_eq!(
            table["192.168.0.192/26"],
            json!("192.168.0.193 - 192.168.0.254")
        );
    }

    #[test]
    fn a_slash_31_has_no_reserved_addresses() {
        // /31 里两个地址都能用（RFC 3021）—— 没有网络地址也没有广播地址
        let out = compute(json!({ "ip_block": "192.168.0.0/31", "subnet_prefix": 31 })).unwrap();
        let table = table_of(&out);
        assert_eq!(table["192.168.0.0/31"], json!("192.168.0.0 - 192.168.0.0"));
        // 一个 /31 里只有一个 /31 —— 没有第二个
        assert_eq!(out["output"].as_str().unwrap().lines().count(), 1);

        // 从 /30 切到 /31 就有两个了，两个都是「地址 - 自己」
        let out = compute(json!({ "ip_block": "192.168.0.0/30", "subnet_prefix": 31 })).unwrap();
        let table = table_of(&out);
        assert_eq!(table["192.168.0.0/31"], json!("192.168.0.0 - 192.168.0.0"));
        assert_eq!(table["192.168.0.2/31"], json!("192.168.0.2 - 192.168.0.2"));
    }

    #[test]
    fn a_host_address_snaps_to_its_network() {
        let out = run("192.168.1.5/24");
        let text = out["output"].as_str().unwrap();
        assert!(text.starts_with("192.168.1.0/24"), "{text}");
    }

    #[test]
    fn nonsense_is_reported() {
        assert!(compute(json!({})).is_err());
        assert!(compute(json!({ "ip_block": "hello" })).is_err());
        // IPv6 输入要明确说不行，而不是给个空结果
        assert!(compute(json!({ "ip_block": "2001:db8::/32" })).is_err());
        // 目标前缀比本段还短
        assert!(compute(json!({ "ip_block": "192.168.0.0/24", "subnet_prefix": 16 })).is_err());
        // 目标前缀超过 32
        assert!(compute(json!({ "ip_block": "192.168.0.0/24", "subnet_prefix": 33 })).is_err());
    }

    #[test]
    fn too_many_subnets_is_refused() {
        // /16 一级级切到 /30 有 32766 个 —— 超上限
        assert!(compute(json!({ "ip_block": "192.168.0.0/16" })).is_err());
        // 但只切一级就没问题
        assert!(compute(json!({ "ip_block": "192.168.0.0/16", "subnet_prefix": 24 })).is_ok());
    }
}
