//! IPv6 地址与子网的公共算法。
//!
//! 单独一个模块是因为两个工具（地址转换器、子网计算器）要用同一套
//! 展开 / 压缩 / 掩码算法 —— 两边各写一份，迟早会算出不一样的结果。
//!
//! ## 口径
//!
//! - **展开**（RFC 5952 §5.2.1）：8 组，每组 4 位十六进制、小写、不足补零。
//!   这与 Python `ipaddress.IPv6Address.exploded` 一致。
//! - **压缩**（RFC 5952 §4.2）：把**最长**的一段连续零组换成 `::`；
//!   长度相同时取**最左**的一段；**只压一段**（不是每段都压）；
//!   **单个零组不压**（`2001:db8:0:1::2` 里的那个 `0` 要留着）。
//!   这与 Python `ipaddress.IPv6Address.compressed` 一致。
//! - **区域 ID**（`%eth0`）在解析时剥掉，但要单独报给用户 ——
//!   它是本机接口的名字，不是地址的一部分。
//!
//! 上游的对应实现（PR #1885）是 TypeScript 的 `BigInt` 版本，
//! 它的 `expandIpv6` 自己拆 `::`，跟 Python 的口径一致但边界情况多。
//! 我们直接用 `std::net::Ipv6Addr` 解析 —— 标准库已经处理了
//! `::` 压缩、前导零、IPv4 混合写法（`::ffff:1.2.3.4`）与各种畸形输入。

use std::net::Ipv4Addr;
use std::str::FromStr;

use super::ToolError;

/// 重导出给同模块的兄弟用（子网计算器要把地址转成 u128 再转回来）。
pub use std::net::Ipv6Addr;

/// IANA「特殊用途地址」登记表里与日常用得上的那几段。
///
/// 数据来自 <https://www.iana.org/assignments/iana-ipv6-special-registry/>。
/// **不是完整的表** —— 只收了做地址类型判断真正用得上的那些；
/// 完整表有几十条，对这个工具没有增量价值。
///
/// 匹配用**最长前缀匹配**：一个地址可能同时落在好几段里
/// （`2001:db8::1` 既在 `2001::/23` 里也在 `2001:db8::/32` 里），
/// 要报最具体的那一段。
///
/// 第二列是**语言包里的键**，不是文案本身 —— 文案在 `locales/*.yml` 的
/// `out.ipv6.*` 段里。同一段可以有多条共用一个键（两处都是「文档专用段」）。
const IANA_RANGES: &[(&str, &str, &str)] = &[
    ("::ffff:0:0/96", "out.ipv6.kind.ipv4_mapped", "global"),
    ("64:ff9b::/96", "out.ipv6.kind.ipv4_ipv6_translation", "global"),
    ("100::/64", "out.ipv6.kind.discard_only", "global"),
    ("2001::/23", "out.ipv6.kind.ietf_protocol_assignments", "global"),
    ("2001:db8::/32", "out.ipv6.kind.documentation", "global"),
    ("2002::/16", "out.ipv6.kind.sixtofour", "global"),
    ("3fff::/20", "out.ipv6.kind.documentation", "global"),
    ("fc00::/7", "out.ipv6.kind.unique_local", "organization"),
    ("fe80::/10", "out.ipv6.kind.link_local_unicast", "link"),
    ("ff00::/8", "out.ipv6.kind.multicast", "multicast"),
];

/// 解析出来的地址 + 区域 ID。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Parsed {
    pub addr: Ipv6Addr,
    /// `%eth0` 里的接口名。剥掉了，但没丢 —— 它是用户输入的一部分。
    pub zone: Option<String>,
    /// 输入其实是 IPv4（我们把它当成 IPv4 映射地址处理）。
    pub was_ipv4: bool,
}

/// 解析一个 IPv6 地址。
///
/// 接受 `::ffff:192.168.1.1` 这种 IPv4 混合写法（标准库支持），
/// 也接受裸 IPv4（`192.168.1.1`）—— 那按 IPv4 映射地址处理，
/// 与 `inet_ntop(AF_INET6, ...)` 的行为一致。
pub fn parse(input: &str) -> Result<Parsed, ToolError> {
    let text = input.trim();
    if text.is_empty() {
        // 这两个键是给两个 IPv6 工具共用的，所以放在 `out.common.*` 段里。
        return Err(ToolError::invalid("out.common.ipv6_empty", &[]));
    }

    // 区域 ID：`%` 之后到结尾。IPv6 地址本身不含 `%`，
    // 所以第一个 `%` 就是分隔点。
    let (addr_part, zone) = match text.split_once('%') {
        Some((head, tail)) => (head, Some(tail.trim().to_string())),
        None => (text, None),
    };

    if let Ok(v4) = Ipv4Addr::from_str(addr_part) {
        return Ok(Parsed {
            addr: v4.to_ipv6_mapped(),
            zone,
            was_ipv4: true,
        });
    }

    match Ipv6Addr::from_str(addr_part) {
        Ok(addr) => Ok(Parsed {
            addr,
            zone,
            was_ipv4: false,
        }),
        Err(_) => Err(ToolError::invalid(
            "out.common.ipv6_bad_address",
            &[("address", text)],
        )),
    }
}

/// 展开形式：`2001:0db8:0000:0000:0000:0000:0000:0001`。
pub fn expand(addr: &Ipv6Addr) -> String {
    addr.segments()
        .iter()
        .map(|s| format!("{s:04x}"))
        .collect::<Vec<_>>()
        .join(":")
}

/// 压缩形式：`2001:db8::1`。
///
/// 规则见模块文档：最长零串、平局取最左、只压一段、单零组不压。
pub fn compress(addr: &Ipv6Addr) -> String {
    let seg = addr.segments();

    // 找最长的零串；长度相同时**不**替换，于是留下的是最左的那一段。
    let mut best_start = usize::MAX;
    let mut best_len = 0usize;
    let mut i = 0;
    while i < seg.len() {
        if seg[i] == 0 {
            let start = i;
            while i < seg.len() && seg[i] == 0 {
                i += 1;
            }
            let len = i - start;
            if len > best_len {
                best_len = len;
                best_start = start;
            }
        } else {
            i += 1;
        }
    }

    // 只有一个零组时不压缩 —— RFC 5952 §4.2.2
    if best_len < 2 {
        return seg
            .iter()
            .map(|s| format!("{s:x}"))
            .collect::<Vec<_>>()
            .join(":");
    }

    let head = seg[..best_start]
        .iter()
        .map(|s| format!("{s:x}"))
        .collect::<Vec<_>>()
        .join(":");
    let tail = seg[best_start + best_len..]
        .iter()
        .map(|s| format!("{s:x}"))
        .collect::<Vec<_>>()
        .join(":");
    format!("{head}::{tail}")
}

/// 十进制形式（128 位无符号整数的十进制写法）。
pub fn to_decimal(addr: &Ipv6Addr) -> String {
    addr.to_bits().to_string()
}

/// 十六进制形式：`0x20010db8...`。
pub fn to_hex(addr: &Ipv6Addr) -> String {
    format!("0x{:032x}", addr.to_bits())
}

/// 二进制形式（128 位，高位在前）。
pub fn to_binary(addr: &Ipv6Addr) -> String {
    let mut out = String::with_capacity(128);
    for byte in addr.octets() {
        for bit in (0..8).rev() {
            out.push(if byte & (1 << bit) != 0 { '1' } else { '0' });
        }
    }
    out
}

/// 反向 DNS 名（ARPA 形式）：`1.0.0.0.…ip6.arpa`。
///
/// 做法是把 32 个半字节**倒着**写出来，每个后面跟一个点。
pub fn to_arpa(addr: &Ipv6Addr) -> String {
    let mut nibbles: Vec<String> = Vec::with_capacity(32);
    for byte in addr.octets() {
        nibbles.push(format!("{:x}", byte >> 4));
        nibbles.push(format!("{:x}", byte & 0x0f));
    }
    nibbles.reverse();
    format!("{}.ip6.arpa", nibbles.join("."))
}

/// 末 64 位的接口标识（十六进制）。
pub fn interface_id(addr: &Ipv6Addr) -> String {
    let octets = addr.octets();
    let tail = &octets[8..];
    let mut out = String::with_capacity(17);
    for (i, byte) in tail.iter().enumerate() {
        if i > 0 && i % 2 == 0 {
            out.push(':');
        }
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

/// 地址类型与作用域。
pub struct Classification {
    /// 类型名（已按请求语言取好文案）
    pub kind: String,
    /// 作用域：`host` / `link` / `organization` / `site` / `global` / `multicast`
    pub scope: &'static str,
    /// 命中的前缀（`2001:db8::/32`），没有对应段时是 `None`
    pub prefix: Option<String>,
}

/// 判断地址类型。
///
/// 判定顺序是「先特例、再最长前缀匹配」：
/// `::` 与 `::1` 有专门的名字（未指定 / 回环），
/// 它们同时落在 `::/0` 这样的段里，用前缀匹配是认不出来的。
///
/// `lang` 是当前请求的语言 —— 类型名是给人看的文案，得按语言取。
pub fn classify(addr: &Ipv6Addr, lang: &str) -> Classification {
    if addr.is_unspecified() {
        return Classification {
            kind: crate::i18n::t(lang, "out.ipv6.kind.unspecified"),
            scope: "host",
            prefix: Some("::/128".to_string()),
        };
    }
    if addr.is_loopback() {
        return Classification {
            kind: crate::i18n::t(lang, "out.ipv6.kind.loopback"),
            scope: "host",
            prefix: Some("::1/128".to_string()),
        };
    }
    if addr.is_multicast() {
        let scope = crate::i18n::t(lang, multicast_scope(addr));
        return Classification {
            kind: crate::i18n::t(lang, "out.ipv6.kind.multicast").replace("{scope}", &scope),
            scope: "multicast",
            prefix: Some("ff00::/8".to_string()),
        };
    }

    // 最长前缀匹配
    //
    // 记的是**下标**而不是名字：几段共用同一个语言包键（两处都是
    // 「文档专用段」），按名字回查会永远查到第一段，报出错的网段。
    let mut best: Option<(u8, usize)> = None;
    for (index, (cidr, _key, _scope)) in IANA_RANGES.iter().enumerate() {
        let Some((net, prefix_len)) = parse_cidr(cidr) else {
            continue;
        };
        if !in_network(&addr, &net, prefix_len) {
            continue;
        }
        match best {
            Some((len, _)) if len >= prefix_len => {}
            _ => best = Some((prefix_len, index)),
        }
    }

    match best {
        Some((_, index)) => {
            let (cidr, key, scope) = IANA_RANGES[index];
            Classification {
                kind: crate::i18n::t(lang, key),
                scope,
                prefix: Some(cidr.to_string()),
            }
        }
        None => Classification {
            kind: crate::i18n::t(lang, "out.ipv6.kind.global_unicast"),
            scope: "global",
            prefix: None,
        },
    }
}

/// 组播地址的作用域（RFC 3306 第 4 位半字节）。返回**语言包里的键**。
fn multicast_scope(addr: &Ipv6Addr) -> &'static str {
    match addr.octets()[1] & 0x0f {
        0x0 | 0xe => "out.ipv6.multicast_scope.global",
        0x1 => "out.ipv6.multicast_scope.link_local",
        0x2 => "out.ipv6.multicast_scope.node_local",
        0x3 | 0x6 | 0x8 => "out.ipv6.multicast_scope.organization",
        0x5 => "out.ipv6.multicast_scope.site_local",
        0x4 | 0x7 | 0x9..=0xd | 0xf => "out.ipv6.multicast_scope.reserved",
        _ => "out.ipv6.multicast_scope.unknown",
    }
}

/// 地址作用域的语言包键。
///
/// `Classification.scope` 给的是机器可读的作用域名（`host` / `link` / …），
/// 这里把它翻成语言包里的键 —— 好几个工具都要用，放在这儿省得各写一份。
pub fn scope_key(scope: &str) -> &'static str {
    match scope {
        "host" => "out.ipv6.scope.host",
        "link" => "out.ipv6.scope.link",
        "organization" => "out.ipv6.scope.organization",
        "site" => "out.ipv6.scope.site",
        "multicast" => "out.ipv6.scope.multicast",
        _ => "out.ipv6.scope.global",
    }
}

/// 掩码（前 `prefix` 位为 1）。
///
/// `prefix == 0` 要单独处理：`u128::MAX << 128` 会溢出。
pub fn mask_bits(prefix: u8) -> u128 {
    if prefix == 0 {
        0
    } else {
        u128::MAX << (128 - prefix)
    }
}

/// 掩码的地址形式（`ffff:ffff:ffff::`）。
pub fn mask_addr(prefix: u8) -> Ipv6Addr {
    Ipv6Addr::from(mask_bits(prefix))
}

/// 地址是否落在 `net/prefix` 里。
pub fn in_network(addr: &Ipv6Addr, net: &Ipv6Addr, prefix: u8) -> bool {
    let mask = mask_bits(prefix);
    (addr.to_bits() & mask) == (net.to_bits() & mask)
}

/// 网络地址（把主机位清零）。
pub fn network_addr(addr: &Ipv6Addr, prefix: u8) -> Ipv6Addr {
    Ipv6Addr::from(addr.to_bits() & mask_bits(prefix))
}

/// 广播地址（把主机位全置一）。
///
/// IPv6 严格说**没有广播地址**（RFC 4291 取消了），
/// 这里算的是「网段内最大的地址」—— 也就是最后一个可用地址。
pub fn broadcast_addr(addr: &Ipv6Addr, prefix: u8) -> Ipv6Addr {
    Ipv6Addr::from(addr.to_bits() | !mask_bits(prefix))
}

/// 该前缀下的地址总数（十进制字符串）。
///
/// `/0` 是 2^128，**放不进 u128** —— 所以用 BigUint。
/// 少用一个大整数比在别处手工进位划算。
pub fn total_addresses(prefix: u8) -> String {
    use num_bigint::BigUint;
    let total = BigUint::from(1u8) << (128 - prefix as usize);
    total.to_str_radix(10)
}

/// 解析 `地址/前缀`。前缀省略时按 128 算（就是这一个地址）。
pub fn parse_cidr(input: &str) -> Option<(Ipv6Addr, u8)> {
    let text = input.trim();
    let (addr_part, prefix_part) = match text.split_once('/') {
        Some((a, p)) => (a, Some(p)),
        None => (text, None),
    };
    let addr = Ipv6Addr::from_str(addr_part.trim()).ok()?;
    let prefix = match prefix_part {
        None => 128u8,
        Some(p) => {
            let n: u32 = p.trim().parse().ok()?;
            if n > 128 {
                return None;
            }
            n as u8
        }
    };
    Some((addr, prefix))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn c(text: &str) -> String {
        compress(&parse(text).unwrap().addr)
    }

    fn e(text: &str) -> String {
        expand(&parse(text).unwrap().addr)
    }

    #[test]
    fn expansion_matches_python_ipaddress() {
        assert_eq!(e("2001:db8::1"), "2001:0db8:0000:0000:0000:0000:0000:0001");
        assert_eq!(e("::1"), "0000:0000:0000:0000:0000:0000:0000:0001");
        assert_eq!(e("::"), "0000:0000:0000:0000:0000:0000:0000:0000");
        assert_eq!(e("fe80::1%eth0"), "fe80:0000:0000:0000:0000:0000:0000:0001");
        assert_eq!(e("2001:0DB8:0:0:0:0:0:1"), "2001:0db8:0000:0000:0000:0000:0000:0001");
    }

    #[test]
    fn compression_matches_python_ipaddress() {
        assert_eq!(c("2001:db8::1"), "2001:db8::1");
        assert_eq!(c("::1"), "::1");
        assert_eq!(c("::"), "::");
        // 两段等长时取最左；但这里末尾的 4 个零更长，压的是末尾
        assert_eq!(c("0:0:1:2:0:0:0:0"), "0:0:1:2::");
        // 单个零组不压
        assert_eq!(c("2001:db8:0:a:b:c:d:e"), "2001:db8:0:a:b:c:d:e");
        // 只压一段：两段等长时取最左
        assert_eq!(c("0:0:0:0:0:0:1:1"), "::1:1");
    }

    #[test]
    fn malformed_addresses_are_rejected() {
        for bad in [
            "2001::db8::1",
            "12345::",
            "2001:db8:0:0:0:0:0",
            "not-an-address",
            "",
            "2001:db8::1::2",
        ] {
            assert!(parse(bad).is_err(), "{bad} 不该被接受");
        }
    }

    #[test]
    fn a_bad_address_reports_a_language_pack_key() {
        // 错误不是一句写死的中文，而是语言包里的键 —— API 层按请求语言渲染。
        match parse("not-an-address") {
            Err(ToolError::InvalidKeyed { key, .. }) => {
                assert_eq!(key, "out.common.ipv6_bad_address");
            }
            other => panic!("应当报 bad_address，实际 {other:?}"),
        }
        match parse("  ") {
            Err(ToolError::InvalidKeyed { key, .. }) => {
                assert_eq!(key, "out.common.ipv6_empty");
            }
            other => panic!("应当报 ipv6_empty，实际 {other:?}"),
        }
    }

    #[test]
    fn ipv4_input_becomes_the_mapped_address() {
        let parsed = parse("192.168.1.1").unwrap();
        assert!(parsed.was_ipv4);
        assert_eq!(parsed.addr.to_ipv4_mapped(), Some(Ipv4Addr::new(192, 168, 1, 1)));
        assert_eq!(compress(&parsed.addr), "::ffff:c0a8:101");
    }

    #[test]
    fn zone_id_is_kept_but_stripped_from_the_address() {
        let parsed = parse("fe80::1%eth0").unwrap();
        assert_eq!(parsed.zone.as_deref(), Some("eth0"));
        assert_eq!(parsed.addr, Ipv6Addr::new(0xfe80, 0, 0, 0, 0, 0, 0, 1));
    }

    #[test]
    fn subnet_math_matches_the_upstream_vectors() {
        let (addr, prefix) = parse_cidr("2001:db8:1234:5678::1/48").unwrap();
        let net = network_addr(&addr, prefix);
        assert_eq!(compress(&net), "2001:db8:1234::");
        assert_eq!(compress(&broadcast_addr(&addr, prefix)), "2001:db8:1234:ffff:ffff:ffff:ffff:ffff");
        assert_eq!(total_addresses(prefix), "1208925819614629174706176");
        assert_eq!(compress(&mask_addr(prefix)), "ffff:ffff:ffff::");
    }

    #[test]
    fn edge_prefixes() {
        let (addr, prefix) = parse_cidr("2001:db8::1/0").unwrap();
        assert_eq!(compress(&network_addr(&addr, prefix)), "::");
        assert_eq!(
            compress(&broadcast_addr(&addr, prefix)),
            "ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff"
        );
        // 2^128 放不进 u128
        assert_eq!(total_addresses(0), "340282366920938463463374607431768211456");

        let (addr, prefix) = parse_cidr("::1/128").unwrap();
        assert_eq!(compress(&network_addr(&addr, prefix)), "::1");
        assert_eq!(total_addresses(prefix), "1");
        assert_eq!(
            compress(&mask_addr(prefix)),
            "ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff"
        );
    }

    #[test]
    fn arpa_form_reverses_the_nibbles() {
        let parsed = parse("2001:db8::1").unwrap();
        assert_eq!(
            to_arpa(&parsed.addr),
            "1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.8.b.d.0.1.0.0.2.ip6.arpa"
        );
    }

    #[test]
    fn classification_picks_the_most_specific_range() {
        let kind = |t: &str| classify(&parse(t).unwrap().addr, "en").kind;
        assert!(kind("2001:db8::1").contains("Documentation"));
        assert!(kind("fe80::1").contains("Link-Local"));
        assert!(kind("::1").contains("Loopback"));
        assert!(kind("::").contains("Unspecified"));
        assert!(kind("ff02::1").contains("Multicast"));
        assert!(kind("fd00::1").contains("Unique Local"));
        assert!(kind("2606:4700::1111").contains("Global unicast"));
    }

    /// 类型名按语言取 —— 英文界面不该看到中文的「文档专用段」。
    #[test]
    fn the_kind_follows_the_requested_language() {
        let addr = parse("2001:db8::1").unwrap().addr;
        let en = classify(&addr, "en").kind;
        let zh = classify(&addr, "zh-CN").kind;
        assert_ne!(en, zh, "两种语言不该给出一模一样的类型名");
        assert_eq!(en, crate::i18n::t("en", "out.ipv6.kind.documentation"));
        assert_eq!(zh, crate::i18n::t("zh-CN", "out.ipv6.kind.documentation"));
    }

    /// 两段 IANA 登记都叫「文档专用段」，共用一个语言包键；
    /// 命中的**网段**必须是对的那一段，不能因为名字一样就查错。
    #[test]
    fn the_matched_prefix_is_not_confused_by_a_shared_label() {
        // 3fff::/20 是另一段「文档专用段」
        let class = classify(&parse("3fff::1").unwrap().addr, "en");
        assert_eq!(class.prefix.as_deref(), Some("3fff::/20"));
        let class = classify(&parse("2001:db8::1").unwrap().addr, "en");
        assert_eq!(class.prefix.as_deref(), Some("2001:db8::/32"));
    }

    #[test]
    fn invalid_prefix_lengths_are_rejected() {
        assert!(parse_cidr("2001:db8::1/129").is_none());
        assert!(parse_cidr("2001:db8::1/-1").is_none());
        assert!(parse_cidr("2001:db8::1/abc").is_none());
    }
}
