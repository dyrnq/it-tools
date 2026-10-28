//! IP 网段的公共算法：地址 ↔ 大整数、网段 ↔ 地址区间、区间减法。
//!
//! 五个网段工具共用这里的一套算术：
//! `ip-cidr-to-range`、`ip-range-to-cidr`、`ipv4-subnets-list`、
//! `cidr-in-cidr`、`ip-include-exclude`。
//!
//! 单独一个模块是因为它们问的其实是同一件事 —— 把一段地址表示成
//! 「闭区间 [start, end]」之后，上面五个问题全都变成区间上的加减与切分。
//! 各写一份的话，五个工具迟早给出不一样的答案。
//!
//! ## 为什么用 BigUint 而不是 u32 / u128
//!
//! - IPv6 的 `/0` 有 2^128 个地址 —— 「最后一个地址 + 1」在 u128 里会溢出，
//!   而这个 +1 在「相邻区间合并」「区间减法」里是家常便饭。
//! - 「这段区间里有多少个地址」在 `/0` 时是 2^128，u128 装不下（最大 2^128-1）。
//! - 减法只在能减的时候才做，中间结果不用到处判溢出。
//!
//! BigUint 让「加一」永远不溢出，「减一」只在能减的时候才做。
//!
//! ## 解析交给 ipnet
//!
//! 地址的**写法**千奇百怪（IPv4 的十进制点分、IPv6 的 `::` 压缩、
//! 前缀写成点分掩码……），自己 `split('/')` 会漏掉一堆非法输入。
//! `ipnet` 的解析器校验得严 —— 非法输入在这里就拒掉，工具层只管算。
//!
//! ## 跟参考实现的差别
//!
//! 参考实现（/data/work/it-tools2，sharevb/it-tools 的 fork）把网段
//! **展开成每一个地址**再取头尾（`cidr-tools` 的 `expandCidr`）。
//! `10.0.0.0/8` 要生成 1600 万个地址字符串，`0.0.0.0/0` 更是 4 亿个 ——
//! 页面上根本出不来。这里直接用算术取头尾，结果一致但快几个数量级。

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
use std::str::FromStr;

use ipnet::IpNet;
use num_bigint::BigUint;

use super::ipv6;

/// 一个地址区间（闭区间，两端都算在内）。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Span {
    /// 是不是 IPv6。IPv4 与 IPv6 的地址空间不能混算。
    pub v6: bool,
    /// 区间的第一个地址（整数值）。
    pub start: BigUint,
    /// 区间的最后一个地址（整数值）。
    pub end: BigUint,
}

/// IPv4 的特殊用途网段。
///
/// 数据来自 IANA 的 IPv4 Special-Purpose Address Registry
/// <https://www.iana.org/assignments/iana-ipv4-special-registry/>。
/// **不是完整的表** —— 只收了日常判断用得上的十几条，
/// 完整表有几十条，对这个工具没有增量价值。
///
/// 记的是**语言包里的键**，不是文案本身 —— 文案在 `out.common.cidr.kind.*`。
/// 匹配用最长前缀：255.255.255.255 既是广播地址，也落在 240.0.0.0/4 里，
/// 报「保留」就对了。
const V4_SPECIAL: &[(&str, &str)] = &[
    ("0.0.0.0/8", "out.common.cidr.kind.this_network"),
    ("10.0.0.0/8", "out.common.cidr.kind.private"),
    ("100.64.0.0/10", "out.common.cidr.kind.shared"),
    ("127.0.0.0/8", "out.common.cidr.kind.loopback"),
    ("169.254.0.0/16", "out.common.cidr.kind.link_local"),
    ("172.16.0.0/12", "out.common.cidr.kind.private"),
    ("192.0.2.0/24", "out.common.cidr.kind.documentation"),
    ("192.88.99.0/24", "out.common.cidr.kind.sixtofour_relay"),
    ("192.168.0.0/16", "out.common.cidr.kind.private"),
    ("198.18.0.0/15", "out.common.cidr.kind.benchmark"),
    ("198.51.100.0/24", "out.common.cidr.kind.documentation"),
    ("203.0.113.0/24", "out.common.cidr.kind.documentation"),
    ("224.0.0.0/4", "out.common.cidr.kind.multicast"),
    ("240.0.0.0/4", "out.common.cidr.kind.reserved"),
    ("255.255.255.255/32", "out.common.cidr.kind.broadcast"),
];

/// 这个地址空间的位数：IPv4 是 32，IPv6 是 128。
pub fn bits(v6: bool) -> u8 {
    if v6 {
        128
    } else {
        32
    }
}

/// 地址 → 整数（IPv4 是 32 位无符号，IPv6 是 128 位无符号）。
pub fn ip_to_big(addr: &IpAddr) -> BigUint {
    match addr {
        IpAddr::V4(v4) => BigUint::from(u32::from(*v4)),
        IpAddr::V6(v6) => BigUint::from(u128::from(*v6)),
    }
}

/// 整数 → 地址。超出该地址空间的值返回 None（不该发生，但别 panic）。
///
/// 自己拼字节而不用 `ToPrimitive`：那个方法是 `num-traits` 的 trait 方法，
/// 用它就得把 `num-traits` 也列进依赖 —— 为了两个转换不值得。
pub fn big_to_ip(v: &BigUint, v6: bool) -> Option<IpAddr> {
    let bytes = v.to_bytes_be();
    if v6 {
        if bytes.len() > 16 {
            return None;
        }
        let mut buf = [0u8; 16];
        buf[16 - bytes.len()..].copy_from_slice(&bytes);
        Some(IpAddr::V6(Ipv6Addr::from(buf)))
    } else {
        if bytes.len() > 4 {
            return None;
        }
        let mut buf = [0u8; 4];
        buf[4 - bytes.len()..].copy_from_slice(&bytes);
        Some(IpAddr::V4(Ipv4Addr::from(buf)))
    }
}

/// 地址 → 字符串（IPv6 用仓库里统一的压缩写法，见 [`super::ipv6`]）。
pub fn fmt_addr(addr: &IpAddr) -> String {
    match addr {
        IpAddr::V4(v4) => v4.to_string(),
        IpAddr::V6(v6) => ipv6::compress(v6),
    }
}

/// 网段 → "10.0.0.0/24"
pub fn fmt_cidr(addr: &IpAddr, prefix: u8) -> String {
    format!("{}/{}", fmt_addr(addr), prefix)
}

/// 区间 → "10.0.0.1 - 10.0.0.10"
pub fn fmt_span(span: &Span) -> String {
    let first = big_to_ip(&span.start, span.v6)
        .map(|ip| fmt_addr(&ip))
        .unwrap_or_default();
    let last = big_to_ip(&span.end, span.v6)
        .map(|ip| fmt_addr(&ip))
        .unwrap_or_default();
    format!("{first} - {last}")
}

/// 解析 "10.0.0.0/24" 或 "10.0.0.1"（省略前缀时按 /32 或 /128）。
///
/// 返回 (网络地址, 前缀长度)。给了前缀时按**网络地址**算 ——
/// "10.0.0.5/24" 的网段是 10.0.0.0/24（路由表里就是这么写的）。
pub fn parse_network(text: &str) -> Option<(IpAddr, u8)> {
    let t = text.trim();
    if t.is_empty() {
        return None;
    }
    if t.contains('/') {
        let net = IpNet::from_str(t).ok()?;
        return Some((net.network(), net.prefix_len()));
    }
    let addr = IpAddr::from_str(t).ok()?;
    let prefix = if addr.is_ipv4() { 32 } else { 128 };
    Some((addr, prefix))
}

/// 解析一段地址：
///
/// - "10.0.0.1-10.0.0.10" → 闭区间
/// - "10.0.0.0/24" → 该网段覆盖的全部地址
/// - "10.0.0.1" → 单个地址
///
/// 区间里两个地址的版本必须一致（IPv4 配 IPv6 是没有意义的），
/// 起始大于结束也���拒绝 —— 这两种情况调用方要分开报错。
pub fn parse_span(text: &str) -> Result<Span, SpanError> {
    let t = text.trim();
    if t.is_empty() {
        return Err(SpanError::BadSyntax);
    }
    // IPv6 里没有 '-'，所以 '-' 一定是区间的分隔符
    if let Some((a, b)) = t.split_once('-') {
        let start = IpAddr::from_str(a.trim()).map_err(|_| SpanError::BadSyntax)?;
        let end = IpAddr::from_str(b.trim()).map_err(|_| SpanError::BadSyntax)?;
        if start.is_ipv4() != end.is_ipv4() {
            return Err(SpanError::MixedFamily);
        }
        let s = ip_to_big(&start);
        let e = ip_to_big(&end);
        if s > e {
            return Err(SpanError::Reversed);
        }
        return Ok(Span {
            v6: start.is_ipv6(),
            start: s,
            end: e,
        });
    }
    let (net, prefix) = parse_network(t).ok_or(SpanError::BadSyntax)?;
    span_of_network(&net, prefix).ok_or(SpanError::BadSyntax)
}

/// 解析一段地址时可能出的错。
///
/// 分开是因为调用方要给**不同的提示**：
/// 「版本不一致」要用户检查两端，「起始大于结束」要用户把两头换一下。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SpanError {
    /// 根本不是合法的地址 / 网段。
    BadSyntax,
    /// 区间两头的 IP 版本不一致。
    MixedFamily,
    /// 区间的结束地址比起始地址还小。
    Reversed,
}

/// 网段覆盖的地址区间（网络地址 ~ 最后一个地址）。
pub fn span_of_network(network: &IpAddr, prefix: u8) -> Option<Span> {
    let v6 = network.is_ipv6();
    let bits = bits(v6);
    if prefix > bits {
        return None;
    }
    let size = BigUint::from(1u8) << (bits - prefix) as usize;
    let start = ip_to_big(network);
    let end = &start + &size - 1u8;
    Some(Span { v6, start, end })
}

/// 把地址按前缀长度对齐成网络地址（主机位清零）。
pub fn network_of(addr: &IpAddr, prefix: u8) -> Option<IpAddr> {
    let v6 = addr.is_ipv6();
    let bits = bits(v6);
    if prefix > bits {
        return None;
    }
    let host_bits = (bits - prefix) as usize;
    let value = ip_to_big(addr);
    let masked = (value >> host_bits) << host_bits;
    big_to_ip(&masked, v6)
}

/// 地址是不是落在 `net/prefix` 里。
///
/// 比的是**高位**（前缀那几位），不是低位 —— 掩码是「前 prefix 位为 1」，
/// 拿低位去比会把 255.255.255.255 判成不在 240.0.0.0/4 里。
pub fn in_network(addr: &IpAddr, net: &IpAddr, prefix: u8) -> bool {
    if addr.is_ipv4() != net.is_ipv4() {
        return false;
    }
    let bits = bits(addr.is_ipv6());
    if prefix > bits {
        return false;
    }
    let host_bits = (bits - prefix) as usize;
    let value = ip_to_big(addr);
    let base = ip_to_big(net);
    (value >> host_bits) == (base >> host_bits)
}

/// 区间里有多少个地址（含两端）。
pub fn span_len(span: &Span) -> BigUint {
    &span.end - &span.start + 1u8
}

/// 网段里的可用主机数（十进制字符串）。
///
/// 主机位 ≥ 2 时扣掉头尾两个地址：
/// - IPv4：网络地址与广播地址；
/// - IPv6：subnet-router anycast 与 subnet anycast（RFC 4291 §2.6.1）。
///
/// 主机位不足 2 个（/31、/32）时一个都不扣 —— 头尾都是能用的。
/// IPv6 的这个口径与仓库里已有的 IPv6 子网计算器一致。
pub fn usable_hosts(span: &Span, prefix: u8) -> String {
    let total = span_len(span);
    let host_bits = bits(span.v6) - prefix;
    if host_bits < 2 {
        return total.to_str_radix(10);
    }
    (total - BigUint::from(2u8)).to_str_radix(10)
}

/// 把一段地址切成**数量最少**的 CIDR 网段。
///
/// 贪心：以当前地址为起点取能对齐的最大块（低位连续零的个数决定块大小），
/// 装不下就折半，直到装得下 —— 这是把区间拆成 CIDR 的标准做法，
/// 结果的网段数是最少的。
///
/// 复杂度是 O(结果的网段数)，**不是** O(区间里的地址数** ——
/// 一个 `/0` 也是一个网段，不用展开那 4 亿个地址。
pub fn span_to_cidrs(span: &Span) -> Vec<(IpAddr, u8)> {
    let bits = bits(span.v6);
    let mut out = Vec::new();
    let mut cur = span.start.clone();
    while cur <= span.end {
        // 以 cur 为起点能对齐的最大块是 2^k
        let mut k = align_bits(&cur, bits);
        // 折到装得下为止：cur + 2^k - 1 <= end
        while (&span.end - &cur) < (BigUint::from(1u8) << k) - 1u8 {
            k -= 1;
        }
        let prefix = bits - k as u8;
        if let Some(addr) = big_to_ip(&cur, span.v6) {
            out.push((addr, prefix));
        }
        cur += BigUint::from(1u8) << k;
    }
    out
}

/// cur 的低位有多少个连续的零 —— 以它为起点能对齐的最大块是 2^这个数。
///
/// `trailing_zeros` 对 0 返回 None —— 那正好是「整个地址空间都对齐」的意思。
fn align_bits(cur: &BigUint, bits: u8) -> usize {
    match cur.trailing_zeros() {
        None => bits as usize,
        Some(zeros) => std::cmp::min(zeros as usize, bits as usize),
    }
}

/// 把重叠或相邻的区间合并成最少的几段。
///
/// 「相邻」也算 —— [10.0.0.1, 10.0.0.5] 与 [10.0.0.6, 10.0.0.9]
/// 合起来是一整段，拆成两个 CIDR 反而不是最少的。
pub fn merge_spans(spans: Vec<Span>) -> Vec<Span> {
    let mut spans = spans;
    // 先按版本再按起点排 —— IPv4 的整数值都小于 IPv6 的（0.0.0.0-255.255.255.255
    // 对应 0 - 2^32-1），但 ::0 也是 0，所以光按起点排会让两个版本交错，
    // 合并时就会漏掉本来该并在一起的两段。
    spans.sort_by(|a, b| a.v6.cmp(&b.v6).then(a.start.cmp(&b.start)));
    let mut out: Vec<Span> = Vec::new();
    for s in spans {
        let merged = match out.last_mut() {
            Some(last) if last.v6 == s.v6 && s.start <= last.end.clone() + 1u8 => {
                if s.end > last.end.clone() {
                    last.end = s.end.clone();
                }
                true
            }
            _ => false,
        };
        if !merged {
            out.push(s);
        }
    }
    out
}

/// 区间减法：a 去掉 b 之后剩下什么。
///
/// 不相交时原样返回；b 整个盖住 a 时返回空。
pub fn subtract_span(a: &Span, b: &Span) -> Vec<Span> {
    if a.v6 != b.v6 {
        return vec![a.clone()];
    }
    if b.start > a.end || b.end < a.start {
        return vec![a.clone()];
    }
    let mut out = Vec::new();
    if a.start < b.start {
        out.push(Span {
            v6: a.v6,
            start: a.start.clone(),
            end: b.start.clone() - 1u8,
        });
    }
    if b.end < a.end {
        out.push(Span {
            v6: a.v6,
            start: b.end.clone() + 1u8,
            end: a.end.clone(),
        });
    }
    out
}

/// b 是不是完全落在 a 里面。
pub fn contains(a: &Span, b: &Span) -> bool {
    a.v6 == b.v6 && a.start <= b.start && b.end <= a.end
}

/// 掩码的地址形式：IPv4 给 "255.255.255.0"，IPv6 给 "ffff:ffff:ffff::"。
pub fn fmt_netmask(v6: bool, prefix: u8) -> String {
    if v6 {
        ipv6::compress(&ipv6::mask_addr(prefix))
    } else {
        Ipv4Addr::from(v4_mask_bits(prefix)).to_string()
    }
}

/// 反掩码（通配符掩码）：IPv4 给 "0.0.0.255"，IPv6 给 "::ffff:ffff:ffff:ffff"。
pub fn fmt_wildcard(v6: bool, prefix: u8) -> String {
    if v6 {
        ipv6::compress(&Ipv6Addr::from(!ipv6::mask_bits(prefix)))
    } else {
        Ipv4Addr::from(!v4_mask_bits(prefix)).to_string()
    }
}

/// IPv4 的掩码（前 prefix 位为 1）。
///
/// `prefix == 0` 要单独处理：`u32::MAX << 32` 会溢出。
fn v4_mask_bits(prefix: u8) -> u32 {
    if prefix == 0 {
        0
    } else {
        u32::MAX << (32 - prefix as u32)
    }
}

/// 这个地址属于哪一类特殊用途网段。
///
/// 返回**语言包里的键**，不是文案本身 —— 文案在 `out.common.cidr.kind.*`。
pub fn classify_v4(addr: &IpAddr) -> &'static str {
    let mut best: Option<(u8, &'static str)> = None;
    for (cidr, key) in V4_SPECIAL {
        let Some((net, prefix)) = parse_network(cidr) else {
            continue;
        };
        if !in_network(addr, &net, prefix) {
            continue;
        }
        match best {
            Some((len, _)) if len >= prefix => {}
            _ => best = Some((prefix, key)),
        }
    }
    best.map(|(_, key)| key)
        .unwrap_or("out.common.cidr.kind.public")
}

/// IPv6 地址的类别 —— 复用 [`super::ipv6`] 里那份 IANA 表。
///
/// 那边存的是**文案**（按语言取过了），这里要的是键 ——
/// 所以走 `ipv6::classify` 拿不到键，只能拿文案。
/// 想要键的话用 `ipv6::scope_key` 那套；这里为了少一张表，
/// 直接用它的文案（`Classification.kind` 已经是翻好的）。
pub fn classify_text(addr: &IpAddr, lang: &str) -> String {
    match addr {
        IpAddr::V6(v6) => ipv6::classify(v6, lang).kind,
        IpAddr::V4(v4) => crate::i18n::t(lang, classify_v4(&IpAddr::V4(*v4))),
    }
}

/// 区间的第一个 / 最后一个地址。
///
/// 值一定在地址空间内 —— [`span_of_network`] 与 [`parse_span`] 都保证了。
/// 越界只可能来自手工构造的 Span，那种情况下给 0.0.0.0 而不是 panic
/// （这个模块是给公网接口用的，panic 会被 actix 记成 500）。
pub fn span_first(span: &Span) -> IpAddr {
    big_to_ip(&span.start, span.v6).unwrap_or(IpAddr::V4(Ipv4Addr::UNSPECIFIED))
}

/// 区间最后一个地址。见 [`span_first`]。
pub fn span_last(span: &Span) -> IpAddr {
    big_to_ip(&span.end, span.v6).unwrap_or(IpAddr::V4(Ipv4Addr::UNSPECIFIED))
}

/// 把解析错误翻成给用户看的一句话。
///
/// 三种错误要三种提示：「不是合法地址」「两端版本不一样」「起始比结束大」——
/// 用户照着提示知道该改什么，所以不能合成一句话。
pub fn span_error(err: SpanError, value: &str) -> super::ToolError {
    let key = match err {
        SpanError::BadSyntax => "out.common.cidr.err.bad_value",
        SpanError::MixedFamily => "out.common.cidr.err.mixed_family",
        SpanError::Reversed => "out.common.cidr.err.reversed",
    };
    super::ToolError::invalid(key, &[("value", value)])
}

#[cfg(test)]
mod tests {
    use super::*;

    fn span_of(text: &str) -> Span {
        parse_span(text).expect("应当能解析")
    }

    fn cidrs(text: &str) -> Vec<String> {
        let span = span_of(text);
        span_to_cidrs(&span)
            .into_iter()
            .map(|(ip, p)| fmt_cidr(&ip, p))
            .collect()
    }

    #[test]
    fn a_plain_address_is_a_single_host() {
        let span = span_of("192.168.1.1");
        assert_eq!(fmt_span(&span), "192.168.1.1 - 192.168.1.1");
        assert_eq!(span_len(&span), BigUint::from(1u8));
    }

    #[test]
    fn a_cidr_covers_the_whole_block() {
        let span = span_of("192.168.1.0/24");
        assert_eq!(fmt_span(&span), "192.168.1.0 - 192.168.1.255");
        assert_eq!(span_len(&span), BigUint::from(256u32));
    }

    #[test]
    fn a_host_address_inside_a_block_becomes_the_block() {
        // 路由表里的写法：10.0.0.5/24 是 10.0.0.0/24
        let span = span_of("10.0.0.5/24");
        assert_eq!(fmt_span(&span), "10.0.0.0 - 10.0.0.255");
    }

    #[test]
    fn ipv6_blocks_use_the_compressed_form() {
        let span = span_of("2001:db8::/32");
        assert_eq!(fmt_span(&span), "2001:db8:: - 2001:db8:ffff:ffff:ffff:ffff:ffff:ffff");
        assert_eq!(
            span_len(&span),
            BigUint::from(1u8) << 96u32
        );
    }

    #[test]
    fn ranges_split_into_the_fewest_cidrs() {
        // 这些是 Python `ipaddress.summarize_address_range` 的答案
        assert_eq!(
            cidrs("192.168.1.1-192.168.1.10"),
            vec![
                "192.168.1.1/32",
                "192.168.1.2/31",
                "192.168.1.4/30",
                "192.168.1.8/31",
                "192.168.1.10/32",
            ]
        );
        assert_eq!(
            cidrs("192.168.1.1-192.168.1.255"),
            vec![
                "192.168.1.1/32",
                "192.168.1.2/31",
                "192.168.1.4/30",
                "192.168.1.8/29",
                "192.168.1.16/28",
                "192.168.1.32/27",
                "192.168.1.64/26",
                "192.168.1.128/25",
            ]
        );
        assert_eq!(cidrs("10.0.0.0-10.0.0.255"), vec!["10.0.0.0/24"]);
        assert_eq!(cidrs("10.0.0.0-10.0.1.255"), vec!["10.0.0.0/23"]);
    }

    #[test]
    fn the_whole_ipv4_space_is_one_cidr() {
        assert_eq!(cidrs("0.0.0.0-255.255.255.255"), vec!["0.0.0.0/0"]);
    }

    #[test]
    fn the_whole_ipv6_space_is_one_cidr() {
        assert_eq!(cidrs("::-ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff"), vec!["::/0"]);
    }

    #[test]
    fn adjacent_spans_merge() {
        let merged = merge_spans(vec![
            span_of("10.0.0.0/25"),
            span_of("10.0.0.128/25"),
            span_of("10.0.1.0/24"),
        ]);
        assert_eq!(merged.len(), 1);
        assert_eq!(fmt_span(&merged[0]), "10.0.0.0 - 10.0.1.255");
    }

    #[test]
    fn overlapping_spans_merge() {
        let merged = merge_spans(vec![span_of("10.0.0.0/24"), span_of("10.0.0.128/25")]);
        assert_eq!(merged.len(), 1);
        assert_eq!(fmt_span(&merged[0]), "10.0.0.0 - 10.0.0.255");
    }

    #[test]
    fn subtracting_a_middle_piece_leaves_two_pieces() {
        let a = span_of("10.0.0.0/24");
        let b = span_of("10.0.0.64/26");
        let left = subtract_span(&a, &b);
        assert_eq!(left.len(), 2);
        assert_eq!(fmt_span(&left[0]), "10.0.0.0 - 10.0.0.63");
        assert_eq!(fmt_span(&left[1]), "10.0.0.128 - 10.0.0.255");
    }

    #[test]
    fn subtracting_a_disjoint_piece_changes_nothing() {
        let a = span_of("10.0.0.0/24");
        let b = span_of("10.0.1.0/24");
        let left = subtract_span(&a, &b);
        assert_eq!(left.len(), 1);
        assert_eq!(fmt_span(&left[0]), "10.0.0.0 - 10.0.0.255");
    }

    #[test]
    fn subtracting_everything_leaves_nothing() {
        let a = span_of("10.0.0.0/24");
        let b = span_of("10.0.0.0/24");
        assert!(subtract_span(&a, &b).is_empty());
    }

    #[test]
    fn containment_is_inclusive() {
        let base = span_of("10.0.0.0/8");
        assert!(contains(&base, &span_of("10.1.2.3")));
        assert!(contains(&base, &span_of("10.0.0.0/16")));
        assert!(!contains(&base, &span_of("11.0.0.0/16")));
        assert!(!contains(&base, &span_of("10.0.0.0/7")));
    }

    #[test]
    fn bad_input_is_reported() {
        assert_eq!(parse_span(""), Err(SpanError::BadSyntax));
        assert_eq!(parse_span("hello"), Err(SpanError::BadSyntax));
        assert_eq!(parse_span("10.0.0.0/33"), Err(SpanError::BadSyntax));
        assert_eq!(parse_span("10.0.0.1-2001:db8::1"), Err(SpanError::MixedFamily));
        assert_eq!(parse_span("10.0.0.9-10.0.0.1"), Err(SpanError::Reversed));
    }

    #[test]
    fn masks_are_right() {
        assert_eq!(fmt_netmask(false, 24), "255.255.255.0");
        assert_eq!(fmt_netmask(false, 0), "0.0.0.0");
        assert_eq!(fmt_netmask(false, 32), "255.255.255.255");
        assert_eq!(fmt_wildcard(false, 24), "0.0.0.255");
        assert_eq!(fmt_wildcard(false, 0), "255.255.255.255");
        assert_eq!(fmt_wildcard(false, 32), "0.0.0.0");
        assert_eq!(fmt_netmask(true, 64), "ffff:ffff:ffff:ffff::");
        assert_eq!(fmt_wildcard(true, 64), "::ffff:ffff:ffff:ffff");
    }

    #[test]
    fn ipv4_kinds_use_the_longest_prefix() {
        let v4 = |s: &str| -> IpAddr { s.parse().unwrap() };
        assert_eq!(classify_v4(&v4("10.1.2.3")), "out.common.cidr.kind.private");
        assert_eq!(classify_v4(&v4("192.168.1.1")), "out.common.cidr.kind.private");
        assert_eq!(classify_v4(&v4("127.0.0.1")), "out.common.cidr.kind.loopback");
        assert_eq!(classify_v4(&v4("169.254.1.1")), "out.common.cidr.kind.link_local");
        assert_eq!(classify_v4(&v4("8.8.8.8")), "out.common.cidr.kind.public");
        // 广播地址同时落在 240.0.0.0/4 里，最长前缀要选 /32
        assert_eq!(
            classify_v4(&v4("255.255.255.255")),
            "out.common.cidr.kind.broadcast"
        );
    }
}
