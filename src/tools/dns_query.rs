//! DNS 记录查询 —— A / AAAA / CNAME / MX / TXT / NS / SOA / SRV / PTR / CAA。
//!
//! ## 为什么放服务端
//!
//! 浏览器**发不出**普通的 UDP 53 查询（没有 raw socket 权限），
//! 走 DoH（DNS over HTTPS）又得过 CORS。上游 PR #1811 选的是
//! 「前端 fetch DoH + RDAP」—— 我们改成**服务端直接查 DNS**：
//! 部署目标是内网，系统自带的 `/etc/resolv.conf` 就能用，
//! 不必为了一个工具引入一整套 HTTP/TLS 依赖。
//!
//! 代价：这个工具**需要能出网**（到 DNS 服务器的 53 端口）。
//! 完全隔离的网络里它会超时 —— 那是部署环境的事，不是工具的 bug，
//! 所以超时要给出明确提示，不能只是一句「查询失败」。
//!
//! ## 依赖
//!
//! `hickory-resolver`（原 trust-dns）—— 纯 DNS 协议栈，不带 TLS，
//! 只需要 `system-config`（读 /etc/resolv.conf）与 `tokio` 两个特性。

use std::net::IpAddr;
use std::str::FromStr;
use std::time::{Duration, Instant};

use hickory_resolver::config::{ConnectionConfig, NameServerConfig, ResolverConfig};
use hickory_resolver::net::runtime::TokioRuntimeProvider;
use hickory_resolver::net::{DnsError, NetError};
use hickory_resolver::proto::op::ResponseCode;
use hickory_resolver::proto::rr::{Name, Record, RecordType};
use hickory_resolver::TokioResolver;
use serde_json::{json, Map, Value};

use super::{util, ToolError, ToolResult};

/// 支持的记录类型，与注册表下拉框一一对应。
///
/// 下拉框里的值是小写（`a` / `aaaa` / …），这里存大写 —— 收到请求后统一转大写再匹配，
/// 于是 `A`、`a`、`A` 三种写法都能用。
const RECORD_TYPES: &[(&str, RecordType)] = &[
    ("A", RecordType::A),
    ("AAAA", RecordType::AAAA),
    ("CNAME", RecordType::CNAME),
    ("MX", RecordType::MX),
    ("TXT", RecordType::TXT),
    ("NS", RecordType::NS),
    ("SOA", RecordType::SOA),
    ("SRV", RecordType::SRV),
    ("PTR", RecordType::PTR),
    ("CAA", RecordType::CAA),
    ("ANY", RecordType::ANY),
];

/// DNS 服务器端口。
const DEFAULT_PORT: u16 = 53;

/// 超时时间的上下限（秒）。
const TIMEOUT_MIN: u64 = 1;
const TIMEOUT_MAX: u64 = 30;
const TIMEOUT_DEFAULT: u64 = 5;

pub async fn handle(payload: Value) -> ToolResult {
    let lang = util::lang(&payload).to_string();

    let domain = util::req_str(&payload, "domain")?.trim().to_string();
    if domain.is_empty() {
        return Err(ToolError::invalid("out.dns-query.err.empty_domain", &[]));
    }

    let type_name = util::str_or(&payload, "record_type", "A").to_ascii_uppercase();
    let record_type = match RECORD_TYPES.iter().find(|(name, _)| *name == type_name) {
        Some((_, rt)) => *rt,
        None => {
            return Err(ToolError::invalid(
                "out.dns-query.err.bad_type",
                &[("type", &type_name)],
            ))
        }
    };

    let server = util::opt_str(&payload, "dns_server")
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let timeout = util::bounded_u64(
        &payload,
        "timeout",
        TIMEOUT_DEFAULT,
        TIMEOUT_MIN,
        TIMEOUT_MAX,
    );

    // PTR 是「按 IP 反查域名」：输入给的是 IP，查询时得换成反向的 in-addr.arpa 名字。
    // 这一步放在服务端做 —— 前端要自己拼 arpa 名字的话，每个用户都得自己写一遍。
    let (query_name, shown) = if record_type == RecordType::PTR {
        match IpAddr::from_str(&domain) {
            Ok(ip) => {
                let arpa = reverse_name(ip);
                (arpa, ip.to_string())
            }
            Err(_) => (parse_name(&domain)?, domain.clone()),
        }
    } else {
        (parse_name(&domain)?, domain.clone())
    };

    let (resolver, server_label) = build_resolver(&lang, server, timeout)?;

    let started = Instant::now();
    let lookup = resolver.lookup(query_name.clone(), record_type).await;
    let elapsed = started.elapsed();

    // hickory 把「查到了 0 条」当**错误**返回（NoRecordsFound），
    // 可对用户来说那不是失败 —— 域名可能真的没有 MX 记录。
    // map_lookup_result 把它翻回「0 条」的结果。
    let records = map_lookup_result(lookup)?;
    let lines: Vec<String> = records.iter().map(format_record).collect();

    let mut table = Map::new();
    util::row(
        &mut table,
        &payload,
        "out.dns-query.query",
        json!(format!("{shown} {}", type_name)),
    );
    util::row(
        &mut table,
        &payload,
        "out.dns-query.server",
        json!(server_label),
    );
    util::row(
        &mut table,
        &payload,
        "out.dns-query.count",
        json!(records.len()),
    );
    util::row(
        &mut table,
        &payload,
        "out.dns-query.elapsed",
        json!(format!("{} ms", elapsed.as_millis())),
    );

    // 一条都没查到不是错误 —— 域名可能真的没有 MX 记录。
    // 主结果区给一句本地化的话，别把空字符串摆在用户面前。
    let output = if lines.is_empty() {
        crate::i18n::t(&lang, "out.dns-query.no_records")
    } else {
        lines.join("\n")
    };

    Ok(json!({
        "output": output,
        "table": table,
        "meta": {
            "domain": shown,
            "record_type": type_name,
            "server": server_label,
            "count": records.len(),
            "elapsed_ms": elapsed.as_millis() as u64,
            "records": records
                .iter()
                .map(|r| json!({
                    "name": r.name.to_string(),
                    "ttl": r.ttl,
                    "type": r.record_type().to_string(),
                    "data": r.data.to_string(),
                }))
                .collect::<Vec<_>>(),
        }
    }))
}

/// 把域名解析成 DNS 名。
///
/// 先试 ASCII（`example.com`），失败再试 UTF-8（`例え.テスト` → 会被 IDNA 转成 punycode）。
/// 只走 ASCII 的话，中文域名会被判成「非法域名」—— 而它其实是合法的。
fn parse_name(domain: &str) -> Result<Name, ToolError> {
    Name::from_ascii(domain)
        .or_else(|_| Name::from_utf8(domain))
        .map_err(|_| ToolError::invalid("out.dns-query.err.bad_domain", &[("domain", domain)]))
}

/// 把 hickory 的查询结果翻译成「记录列表」或一句给用户看的话。
///
/// 分三档：
/// - **查到了 0 条**（`NoRecordsFound` + `NoError`）—— 不是失败，
///   域名可能真的没有这种记录；于是给回一个空列表，
///   结果区显示「没查到记录」而不是一句报错。
/// - **域名不存在**（`NXDOMAIN`）—— 值得单独说一句，
///   因为「没有 MX 记录」和「这个域名根本不存在」给用户的下一步完全不同。
/// - **其它**（超时、服务器不可达、格式错误）—— 把库的原话带出去，
///   这些是排查问题时唯一有用的信息。
fn map_lookup_result(
    result: Result<hickory_resolver::lookup::Lookup, NetError>,
) -> Result<Vec<Record>, ToolError> {
    match result {
        Ok(lookup) => Ok(lookup.answers().to_vec()),
        Err(NetError::Dns(DnsError::NoRecordsFound(nr)))
            if nr.response_code == ResponseCode::NXDomain =>
        {
            Err(ToolError::invalid("out.dns-query.err.nxdomain", &[]))
        }
        Err(NetError::Dns(DnsError::NoRecordsFound(_))) => Ok(Vec::new()),
        Err(NetError::Dns(DnsError::ResponseCode(code))) if code == ResponseCode::NXDomain => {
            Err(ToolError::invalid("out.dns-query.err.nxdomain", &[]))
        }
        Err(other) => Err(ToolError::invalid(
            "out.dns-query.err.lookup_failed",
            &[("reason", &other.to_string())],
        )),
    }
}

/// IP → 反向查询名（`1.2.3.4` → `4.3.2.1.in-addr.arpa`）。
fn reverse_name(ip: IpAddr) -> Name {
    let text = match ip {
        IpAddr::V4(v4) => {
            let o = v4.octets();
            format!("{}.{}.{}.{}.in-addr.arpa", o[3], o[2], o[1], o[0])
        }
        IpAddr::V6(v6) => {
            // IPv6 的反向名是 **32 个半字节**（不是字节）：每个字节倒序，
            // 且低位半字节在前 —— 少写这一步会查不到东西。
            let mut nibbles = String::with_capacity(64 + ".ip6.arpa".len());
            for b in v6.octets().iter().rev() {
                // 每个字节拆成**两个标签**：低位半字节在前，高位在后。
                // 写成 "1" + "0" 而不是 "10" —— 后者是一个标签，等于少了一半。
                nibbles.push_str(&format!("{:x}.", b & 0x0f));
                nibbles.push_str(&format!("{:x}.", b >> 4));
            }
            nibbles.push_str("ip6.arpa");
            nibbles
        }
    };
    // 末尾的根标签（那个点）不能省：反查名是**绝对**名字，
    // 少了它解析器会当成相对名、再拼上系统的 search 域去查 —— 查不到东西。
    let text = format!("{text}.");
    // 刚拼出来的名字一定是合法的，解析失败说明代码写错了 —— 退回根域。
    Name::from_ascii(&text).unwrap_or_else(|_| Name::root())
}

/// 解析用户给的 DNS 服务器地址。
///
/// 支持 `1.1.1.1`、`1.1.1.1:5353`、`::1`、`[::1]:53`。
/// 只给 IP 不给端口时用 53。
fn parse_server(text: &str) -> Result<(IpAddr, u16), ToolError> {
    let bad = || ToolError::invalid("out.dns-query.err.bad_server", &[("server", text)]);

    // 带方括号的 IPv6：`[::1]:53`
    if let Some(rest) = text.strip_prefix('[') {
        let (host, tail) = rest.split_once(']').ok_or_else(bad)?;
        let ip = IpAddr::from_str(host).map_err(|_| bad())?;
        let port = match tail.strip_prefix(':') {
            Some(p) => p.parse::<u16>().map_err(|_| bad())?,
            None => DEFAULT_PORT,
        };
        return Ok((ip, port));
    }

    // 带端口的 IPv4：`1.1.1.1:53`
    if let Some((host, port)) = text.rsplit_once(':') {
        if let Ok(ip) = IpAddr::from_str(host) {
            if ip.is_ipv4() {
                return Ok((ip, port.parse::<u16>().map_err(|_| bad())?));
            }
        }
    }

    // 纯 IP（IPv4 / IPv6）
    let ip = IpAddr::from_str(text).map_err(|_| bad())?;
    Ok((ip, DEFAULT_PORT))
}

/// 造一个 resolver，并返回一句「用的哪个服务器」给结果区显示。
///
/// 用系统配置时**保留它自己的 ndots / attempts / search 域**（`/etc/resolv.conf`
/// 里就是这些设置在起作用），只改超时；用自定义服务器时才用库的默认值。
fn build_resolver(
    lang: &str,
    server: Option<&str>,
    timeout: u64,
) -> Result<(TokioResolver, String), ToolError> {
    let timeout_dur = Duration::from_secs(timeout);

    let (config, mut opts, label) = match server {
        Some(text) => {
            let (ip, port) = parse_server(text)?;
            let mut udp = ConnectionConfig::udp();
            udp.port = port;
            let mut tcp = ConnectionConfig::tcp();
            tcp.port = port;
            // 自定义服务器时不带搜索域（from_name_servers 建出来的配置没有 search）：
            // 用户给的域名就是要查的那个，悄悄拼上 search domain 会查到另一个域名去。
            let config = ResolverConfig::from_name_servers(vec![NameServerConfig::new(
                ip,
                true,
                vec![udp, tcp],
            )]);
            let mut opts = hickory_resolver::config::ResolverOpts::default();
            // 重试 2 次就够：DNS 服务器不可达时用户等太久比查不到更让人恼火。
            opts.attempts = 2;
            (config, opts, format!("{ip}:{port}"))
        }
        None => {
            // 读系统配置（Linux/macOS 是 /etc/resolv.conf，Windows 是注册表）。
            let (config, opts) = hickory_resolver::system_conf::read_system_conf().map_err(|e| {
                ToolError::invalid(
                    "out.dns-query.err.no_system_config",
                    &[("reason", &e.to_string())],
                )
            })?;
            let servers: Vec<String> = config
                .name_servers()
                .iter()
                .map(|ns| ns.ip.to_string())
                .collect();
            let label = if servers.is_empty() {
                crate::i18n::t(lang, "out.dns-query.system_server")
            } else {
                servers.join(", ")
            };
            (config, opts, label)
        }
    };

    opts.timeout = timeout_dur;

    let resolver = TokioResolver::builder_with_config(config, TokioRuntimeProvider::default())
        .with_options(opts)
        .build()
        .map_err(|e| ToolError::Internal(format!("构造 DNS resolver 失败: {e}")))?;

    Ok((resolver, label))
}

/// 把一条记录排成 `dig` 答案段的样子：`名字 TTL 类别 类型 数据`。
///
/// 用 `dig` 的格式而不是自己发明一套：DNS 的人天天看这个格式，
/// 粘到别处也能认出来。
fn format_record(record: &Record) -> String {
    let name = record.name.to_string();
    let name = name.strip_suffix('.').unwrap_or(&name);
    format!(
        "{}\t{}\tIN\t{}\t{}",
        name,
        record.ttl,
        record.record_type(),
        record.data
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use hickory_resolver::proto::rr::{rdata::A, RData};
    use serde_json::json;

    #[test]
    fn record_types_are_recognised_case_insensitively() {
        assert_eq!(record_type_of("a"), Some(RecordType::A));
        assert_eq!(record_type_of("AAAA"), Some(RecordType::AAAA));
        assert_eq!(record_type_of("mx"), Some(RecordType::MX));
        assert_eq!(record_type_of("nosuchtype"), None);
    }

    fn record_type_of(name: &str) -> Option<RecordType> {
        let upper = name.to_ascii_uppercase();
        RECORD_TYPES
            .iter()
            .find(|(n, _)| *n == upper)
            .map(|(_, rt)| *rt)
    }

    #[test]
    fn server_addresses_accept_ip_and_ip_port() {
        assert_eq!(
            parse_server("1.1.1.1").unwrap(),
            ("1.1.1.1".parse::<IpAddr>().unwrap(), 53)
        );
        assert_eq!(
            parse_server("1.1.1.1:5353").unwrap(),
            ("1.1.1.1".parse::<IpAddr>().unwrap(), 5353)
        );
        assert_eq!(
            parse_server("::1").unwrap(),
            ("::1".parse::<IpAddr>().unwrap(), 53)
        );
        assert_eq!(
            parse_server("[::1]:5353").unwrap(),
            ("::1".parse::<IpAddr>().unwrap(), 5353)
        );
    }

    #[test]
    fn bad_server_addresses_are_rejected() {
        for bad in ["", "not-an-ip", "1.1.1.1:99999", "1.1.1.1:abc", "[::1"] {
            assert!(parse_server(bad).is_err(), "{bad} 应当被拒");
        }
    }

    #[test]
    fn reverse_names_follow_the_arpa_layout() {
        assert_eq!(
            reverse_name("1.2.3.4".parse().unwrap()).to_string(),
            "4.3.2.1.in-addr.arpa."
        );
        // IPv6 的反向名是 32 个半字节，低位在前
        let v6 = reverse_name("2001:db8::1".parse().unwrap()).to_string();
        assert!(v6.ends_with(".ip6.arpa."), "{v6}");
        // 1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.8.b.d.0.1.0.0.2.ip6.arpa
        assert_eq!(
            v6,
            "1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.8.b.d.0.1.0.0.2.ip6.arpa."
        );
    }

    #[test]
    fn records_are_formatted_like_dig() {
        let name = Name::from_ascii("example.com.").unwrap();
        let record = Record::from_rdata(name, 300, RData::A(A::new(93, 184, 216, 34)));
        assert_eq!(
            format_record(&record),
            "example.com\t300\tIN\tA\t93.184.216.34"
        );
    }

    #[actix_web::test]
    async fn an_empty_domain_is_reported_as_a_missing_field() {
        let err = handle(json!({ "domain": "  " })).await.unwrap_err();
        match err {
            ToolError::InvalidKeyed { key, .. } => {
                assert_eq!(key, "out.common.missing_field");
            }
            other => panic!("应当报缺少字段，实际 {other:?}"),
        }
    }

    #[actix_web::test]
    async fn an_unknown_record_type_is_reported() {
        let err = handle(json!({ "domain": "example.com", "record_type": "nope" }))
            .await
            .unwrap_err();
        match err {
            ToolError::InvalidKeyed { key, args } => {
                assert_eq!(key, "out.dns-query.err.bad_type");
                assert_eq!(args[0].1, "NOPE");
            }
            other => panic!("应当报未知类型，实际 {other:?}"),
        }
    }

    /// 造一个 `NoRecordsFound` 错误，模拟「服务器回了一个空答案」。
    fn no_records_error(code: ResponseCode) -> NetError {
        let name = Name::from_ascii("example.com.").unwrap();
        let query = hickory_resolver::proto::op::Query::query(name, RecordType::A);
        NetError::Dns(DnsError::NoRecordsFound(hickory_resolver::net::NoRecords::new(
            query, code,
        )))
    }

    #[test]
    fn zero_records_is_a_result_not_an_error() {
        // 「查到了 0 条」不是失败 —— 域名可能真的没有这种记录。
        let mapped = map_lookup_result(Err(no_records_error(ResponseCode::NoError)));
        assert!(mapped.is_ok(), "0 条应当是结果而不是错误");
        assert_eq!(mapped.unwrap().len(), 0);
    }

    #[test]
    fn a_missing_domain_is_reported_as_nxdomain() {
        let mapped = map_lookup_result(Err(no_records_error(ResponseCode::NXDomain)));
        match mapped {
            Err(ToolError::InvalidKeyed { key, .. }) => {
                assert_eq!(key, "out.dns-query.err.nxdomain");
            }
            other => panic!("应当报域名不存在，实际 {other:?}"),
        }
    }

    #[test]
    fn a_timeout_keeps_the_librarys_own_words() {
        // 超时这类问题排查时唯一有用的信息是库的原话，别把它吞了。
        let mapped = map_lookup_result(Err(NetError::Timeout));
        match mapped {
            Err(ToolError::InvalidKeyed { key, args }) => {
                assert_eq!(key, "out.dns-query.err.lookup_failed");
                assert!(args[0].1.contains("timed out"), "{args:?}");
            }
            other => panic!("应当报查询失败，实际 {other:?}"),
        }
    }
}
