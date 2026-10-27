//! IPv6 子网计算器（上游 PR #1885）。
//!
//! 给一个 IPv6 地址（可带 `/前缀`），算出它所在的网段：网络地址、地址区间、
//! 地址总数、掩码、类型，以及**把这个网段再切成更小的子网**的清单。
//!
//! ## 为什么只做 #1885
//!
//! 上游有三个 IPv6 子网计算器的 PR（#963 / #944 / #1885）。
//! #1885 是**唯一有真测试**的 —— 它的 `ipv6-subnet-calculator.differential.test.ts`
//! 拿 **CPython `ipaddress` 标准库**当外部 oracle 做了差分测试，
//! 124 个用例已经提交到仓库里（我们把它收进 `fixtures/ipv6_subnet.json`，
//! Rust 侧直接拿它当回归用例）。
//!
//! #963 与 #870 共用的 `src/utils/ip.ts` 拖 6 个 npm 包，
//! 而它的测试**100% 是假绿**（真实断言全被注释掉换成 `expect(true).to.eql(true)`）。
//! #944 没有测试。
//!
//! ## 口径
//!
//! - 「最后一个地址」是网段内**最大的地址**。IPv6 严格说**没有广播地址**
//!   （RFC 4291 §2.6 取消了），但工具里还是要给用户一个上界。
//! - 「可用主机数」按 RFC 4291 §2.6.1 扣掉头尾两个地址
//!   （头是 subnet-router anycast，尾是 subnet anycast）——
//!   主机位不足 2 个时（/127、/128）不扣。
//! - 展开 / 压缩的口径与 [`super::ipv6`] 一致，与 Python `ipaddress` 对齐。

use serde_json::{json, Map, Value};

use super::ipv6;
use super::util;
use super::{ToolError, ToolResult};

/// 切分子网时最多列多少条。
///
/// 切 `/32` → `/48` 是 65536 条，全列出来能把浏览器拖死。
/// 超了就报错并说清楚「差多少」，而不是悄悄截断。
const MAX_SPLITS: usize = 1024;

/// 与注册表 `ApiSpec.fields` 保持一致。
pub async fn handle(payload: Value) -> ToolResult {
    compute(payload)
}

fn compute(payload: Value) -> ToolResult {
    let input = util::req_str(&payload, "cidr")?;
    let (addr, prefix) = ipv6::parse_cidr(input).ok_or_else(|| {
        ToolError::invalid(
            "out.ipv6-subnet-calculator.err.bad_cidr",
            &[("cidr", input)],
        )
    })?;
    let lang = util::lang(&payload);

    let network = ipv6::network_addr(&addr, prefix);
    let first = network;
    let last = ipv6::broadcast_addr(&addr, prefix);
    let total = ipv6::total_addresses(prefix);
    let mask = ipv6::mask_addr(prefix);

    let mut table = Map::new();
    util::row_str(
        &mut table,
        &payload,
        "out.ipv6-subnet-calculator.input",
        &ipv6::expand(&addr),
    );
    util::row(
        &mut table,
        &payload,
        "out.ipv6-subnet-calculator.prefix",
        json!(prefix),
    );
    util::row_str(
        &mut table,
        &payload,
        "out.ipv6-subnet-calculator.network",
        &ipv6::compress(&network),
    );
    util::row_str(
        &mut table,
        &payload,
        "out.ipv6-subnet-calculator.first",
        &ipv6::compress(&first),
    );
    util::row_str(
        &mut table,
        &payload,
        "out.ipv6-subnet-calculator.last",
        &ipv6::compress(&last),
    );
    util::row_str(
        &mut table,
        &payload,
        "out.ipv6-subnet-calculator.total",
        &total,
    );
    util::row_str(
        &mut table,
        &payload,
        "out.ipv6-subnet-calculator.usable",
        &usable_hosts(prefix, &total),
    );
    util::row_str(
        &mut table,
        &payload,
        "out.ipv6-subnet-calculator.netmask",
        &ipv6::compress(&mask),
    );
    util::row_str(
        &mut table,
        &payload,
        "out.ipv6-subnet-calculator.netmask_binary",
        &ipv6::to_binary(&mask),
    );
    util::row_str(
        &mut table,
        &payload,
        "out.ipv6-subnet-calculator.wildcard",
        &ipv6::compress(&ipv6::Ipv6Addr::from(!ipv6::mask_bits(prefix))),
    );

    let class = ipv6::classify(&addr, lang);
    util::row_str(
        &mut table,
        &payload,
        "out.ipv6-subnet-calculator.type",
        &class.kind,
    );
    util::row_str(
        &mut table,
        &payload,
        "out.ipv6-subnet-calculator.scope",
        &crate::i18n::t(lang, ipv6::scope_key(class.scope)),
    );
    if let Some(range) = class.prefix {
        util::row_str(
            &mut table,
            &payload,
            "out.ipv6-subnet-calculator.range",
            &range,
        );
    }

    // 可选：把这个网段再切成更小的子网
    if let Some(split_prefix) = util::opt_u64(&payload, "split_prefix") {
        let splits = split_subnets(&network, prefix, split_prefix as u8)?;
        for (i, subnet) in splits.iter().enumerate() {
            let label = crate::i18n::t(lang, "out.ipv6-subnet-calculator.subnet")
                .replace("{index}", &i.to_string());
            table.insert(label, json!(subnet));
        }
    }

    Ok(json!({
        "output": format!("{}/{}", ipv6::compress(&network), prefix),
        "table": table,
    }))
}

/// 可用主机数。
///
/// 主机位 ≥ 2 时扣掉头尾两个 anycast 地址（RFC 4291 §2.6.1）；
/// /127 与 /128 不扣 —— 头尾都是可用的。
fn usable_hosts(prefix: u8, total: &str) -> String {
    use num_bigint::BigUint;
    let total = BigUint::parse_bytes(total.as_bytes(), 10).unwrap_or_default();
    let host_bits = 128 - prefix as usize;
    if host_bits < 2 {
        return total.to_str_radix(10);
    }
    (total - BigUint::from(2u8)).to_str_radix(10)
}

/// 把 `network/prefix` 切成 `target_prefix` 的子网。
fn split_subnets(
    network: &ipv6::Ipv6Addr,
    prefix: u8,
    target_prefix: u8,
) -> Result<Vec<String>, ToolError> {
    if target_prefix <= prefix {
        return Err(ToolError::invalid(
            "out.ipv6-subnet-calculator.err.prefix_not_longer",
            &[
                ("prefix", &prefix.to_string()),
                ("target", &target_prefix.to_string()),
            ],
        ));
    }
    if target_prefix > 128 {
        return Err(ToolError::invalid(
            "out.ipv6-subnet-calculator.err.prefix_too_long",
            &[],
        ));
    }
    let count = 1u64 << (target_prefix - prefix) as u32;
    if count as usize > MAX_SPLITS {
        return Err(ToolError::invalid(
            "out.ipv6-subnet-calculator.err.too_many_subnets",
            &[
                ("count", &count.to_string()),
                ("limit", &MAX_SPLITS.to_string()),
                ("prefix", &prefix.to_string()),
                ("target", &target_prefix.to_string()),
            ],
        ));
    }

    let step = 1u128 << (128 - target_prefix) as u32;
    let base = network.to_bits();
    let mut out = Vec::with_capacity(count as usize);
    for i in 0..count {
        let addr = ipv6::Ipv6Addr::from(base + i as u128 * step);
        out.push(format!("{}/{}", ipv6::compress(&addr), target_prefix));
    }
    Ok(out)
}

/// 作用域的可读写法在 [`ipv6::scope_key`] 里 —— 两个 IPv6 工具共用一份。

#[cfg(test)]
mod tests {
    use super::*;

    fn run(input: &str) -> Value {
        compute(json!({ "cidr": input })).expect("应当算出结果")
    }

    fn table_of(v: &Value) -> Map<String, Value> {
        v["table"].as_object().cloned().unwrap()
    }

    /// 行的**标题**是按语言取出来的，所以断言按语言包里的键去取标题，
    /// 而不是把标题的字面量抄一遍 —— 抄一遍的话，改一次文案就要改一次断言。
    fn label(key: &str) -> String {
        crate::i18n::t("en", key)
    }

    /// 拆出来的子网行标题带序号，序号是插值进去的。
    fn subnet_label(index: usize) -> String {
        crate::i18n::t("en", "out.ipv6-subnet-calculator.subnet").replace("{index}", &index.to_string())
    }

    /// 124 个用例是上游对着 **CPython `ipaddress` 标准库**跑出来的差分数据。
    ///
    /// 这份 fixture 是从上游 PR #1885 的仓库里收进来的（上游自己的 CI 也拿它跑）。
    /// 有了它，「我们的压缩规则和 Python 是不是一样」就不是靠眼睛看了。
    #[test]
    fn matches_the_cpython_ipaddress_differential_fixture() {
        let raw = include_str!("fixtures/ipv6_subnet.json");
        let cases: Vec<serde_json::Value> = serde_json::from_str(raw).expect("fixture 应当是合法 JSON");
        assert_eq!(cases.len(), 124, "fixture 用例数变了？");

        for case in &cases {
            let input = case["input"].as_str().unwrap();
            let (addr, prefix) = ipv6::parse_cidr(input).expect("fixture 里的地址应当合法");

            assert_eq!(
                ipv6::expand(&addr),
                case["expanded"].as_str().unwrap(),
                "{input} 的展开形式对不上"
            );
            let network = ipv6::network_addr(&addr, prefix);
            // 上游 fixture 的 `compressed` 是**网络地址**的压缩形式（不是输入地址的）——
            // 它跟 `first` 永远是同一个值。输入地址自己的压缩形式由
            // `ipv6::compress` 单独对拍 CPython 验过（124/124 一致）。
            assert_eq!(
                ipv6::compress(&network),
                case["compressed"].as_str().unwrap(),
                "{input} 的压缩形式对不上"
            );
            assert_eq!(
                format!("{}/{}", ipv6::compress(&network), prefix),
                case["network"].as_str().unwrap(),
                "{input} 的网络地址对不上"
            );
            assert_eq!(
                ipv6::compress(&network),
                case["first"].as_str().unwrap(),
                "{input} 的第一个地址对不上"
            );
            assert_eq!(
                ipv6::compress(&ipv6::broadcast_addr(&addr, prefix)),
                case["last"].as_str().unwrap(),
                "{input} 的最后一个地址对不上"
            );
            assert_eq!(
                ipv6::total_addresses(prefix),
                case["total"].as_str().unwrap(),
                "{input} 的地址总数对不上"
            );
            assert_eq!(
                ipv6::compress(&ipv6::mask_addr(prefix)),
                case["netmask"].as_str().unwrap(),
                "{input} 的掩码对不上"
            );
        }
    }

    #[test]
    fn upstream_unit_vectors() {
        let info = run("2001:db8:1234:5678::1/48");
        let table = table_of(&info);
        assert_eq!(info["output"], json!("2001:db8:1234::/48"));
        assert_eq!(table[&label("out.ipv6-subnet-calculator.first")], json!("2001:db8:1234::"));
        assert_eq!(
            table[&label("out.ipv6-subnet-calculator.last")],
            json!("2001:db8:1234:ffff:ffff:ffff:ffff:ffff")
        );
        assert_eq!(
            table[&label("out.ipv6-subnet-calculator.total")],
            json!("1208925819614629174706176")
        );
        assert_eq!(table[&label("out.ipv6-subnet-calculator.netmask")], json!("ffff:ffff:ffff::"));
    }

    #[test]
    fn whole_space_and_single_address() {
        let info = run("2001:db8::1/0");
        let table = table_of(&info);
        assert_eq!(info["output"], json!("::/0"));
        assert_eq!(table[&label("out.ipv6-subnet-calculator.first")], json!("::"));
        assert_eq!(
            table[&label("out.ipv6-subnet-calculator.last")],
            json!("ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff")
        );
        assert_eq!(
            table[&label("out.ipv6-subnet-calculator.total")],
            json!("340282366920938463463374607431768211456")
        );
        assert_eq!(table[&label("out.ipv6-subnet-calculator.usable")], json!("340282366920938463463374607431768211454"));

        let info = run("::1/128");
        let table = table_of(&info);
        assert_eq!(info["output"], json!("::1/128"));
        assert_eq!(table[&label("out.ipv6-subnet-calculator.total")], json!("1"));
        // /128 只有一个地址，头尾都是它 —— 不扣
        assert_eq!(table[&label("out.ipv6-subnet-calculator.usable")], json!("1"));
    }

    #[test]
    fn usable_hosts_subtracts_the_two_anycast_addresses() {
        let info = run("2001:db8::/64");
        let table = table_of(&info);
        assert_eq!(
            table[&label("out.ipv6-subnet-calculator.total")],
            json!("18446744073709551616")
        );
        assert_eq!(
            table[&label("out.ipv6-subnet-calculator.usable")],
            json!("18446744073709551614")
        );
    }

    #[test]
    fn splitting_lists_the_immediate_subnets() {
        let info = compute(json!({ "cidr": "2001:db8::/62", "split_prefix": 64 })).unwrap();
        let table = table_of(&info);
        assert_eq!(table[&subnet_label(0)], json!("2001:db8::/64"));
        assert_eq!(table[&subnet_label(1)], json!("2001:db8:0:1::/64"));
        assert_eq!(table[&subnet_label(2)], json!("2001:db8:0:2::/64"));
        assert_eq!(table[&subnet_label(3)], json!("2001:db8:0:3::/64"));
    }

    #[test]
    fn splitting_rejects_nonsense() {
        // 目标前缀不比当前长
        assert!(compute(json!({ "cidr": "2001:db8::/64", "split_prefix": 64 })).is_err());
        assert!(compute(json!({ "cidr": "2001:db8::/64", "split_prefix": 32 })).is_err());
        // 切太多
        assert!(compute(json!({ "cidr": "2001:db8::/32", "split_prefix": 64 })).is_err());
    }

    #[test]
    fn bad_input_is_reported() {
        assert!(compute(json!({})).is_err());
        assert!(compute(json!({ "cidr": "2001:db8::1/129" })).is_err());
        assert!(compute(json!({ "cidr": "2001::db8::1" })).is_err());
    }
}
