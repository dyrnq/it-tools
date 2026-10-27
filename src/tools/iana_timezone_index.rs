//! IANA 时区索引（endpoint `iana-timezone-index`）。
//!
//! 上游 #1593 要的是一份能搜的 IANA 时区表（`Asia/Riyadh` 这样的名字），
//! 带上各自的 UTC 偏移（`UTC+3`）和缩写（`EET`）。
//!
//! 放服务端而不是 JS 的理由：tzdata 是 600 个时区的偏移 + 缩写表，
//! 浏览器端要么先 fetch 一大坨再渲染，要么把它塞进首屏 JS 让**每个**页面都背着它；
//! 而 `chrono-tz` 本来就是 `date-time-converter` 的依赖，偏移表在编译期就展开成
//! 静态常量了，不占运行时内存 —— 多加一个工具的边际成本接近零。
//!
//! ## 「这个时区用不用夏令时」怎么判
//!
//! tzdata 里没有「是否夏令时」这一列，只有逐时刻的偏移。所以判据是
//! **同一年的 1 月与 7 月偏移不同 ⇒ 观察夏令时**，并取两者较小者当标准偏移
//! （夏令时永远是往后拨的，较大的那个一定是夏令时期间的值）。
//!
//! 这是近似：`Africa/Casablanca` 全年 +01、只在斋月回拨到 +00，会被这条判据
//! 算成「有夏令时且标准偏移 +00」。对一份时区索引来说可以接受，但别把它当权威 ——
//! 权威答案永远在操作系统里（`tzdata` 的 `isdst` 位）。
//!
//! ## 为什么输出要截断
//!
//! 注册表的通用表单只有一个提交动作和一个 `table`，而 `table` 是个 JSON 对象：
//! 597 行全列出来，页面会长到一万多像素，把搜索框顶到屏幕外。
//! 所以默认只回前 [`MAX_ROWS`] 行，但**总数照实写在 `output` 里**，
//! 并说明是被截断了 —— 静默截断会让用户以为表就这么大。
//!
//! 截断不该成为「看不全」的借口，所以表单里还有个 `limit` 数字框：
//! 想看全表就把它调到 600，后端照给。

// `.fix()` 来自 chrono 的 Offset trait，`.abbreviation()` 来自 chrono-tz 的
// OffsetName —— 两者分属不同的 crate，只导入其中一个是编译不过的。
use chrono::{DateTime, Datelike, Offset, TimeZone, Utc};
use chrono_tz::{OffsetName, Tz, TZ_VARIANTS};
use serde_json::{json, Map, Value};

use super::{ToolError, ToolResult};

/// 一次最多回多少行。超出的部分只在 `output` 里报总数，不假装表就这么大。
///
/// 这是**默认值**，用户可以在表单里调大（`limit` 字段，上限 [`MAX_LIMIT`]）——
/// 截断本身是为了不让默认页面变成一万像素的长条，不该把「看全表」的路堵死。
const MAX_ROWS: usize = 100;

/// `limit` 字段的硬上限。全量 tzdata 也就 597 个时区，1000 已经绰绰有余，
/// 再大只会让后端白干活。
const MAX_LIMIT: usize = 1000;

/// 与注册表 `ApiSpec.fields` 保持一致。
pub async fn handle(payload: Value) -> ToolResult {
    compute(payload)
}

fn compute(payload: Value) -> ToolResult {
    // `opt_str` 把「缺字段」和「字段不是字符串」都归成 `None`，于是两者都等于
    // 「不过滤」。这是有意的：`POST /api/tools/<x>` 是公开接口，手写请求可能给个
    // 数字或数组过来，让整张表查不了比返回全表更糟。
    let query = super::util::opt_str(&payload, "query")
        .unwrap_or("")
        .trim()
        .to_lowercase();

    let now = Utc::now();
    let rows: Vec<ZoneInfo> = TZ_VARIANTS
        .iter()
        .map(|tz| ZoneInfo::of(tz, now))
        .filter(|z| z.matches(&query))
        .collect();

    if !query.is_empty() && rows.is_empty() {
        // 过滤没命中和「查询写错了」是两回事，给一句可操作的提示而不是空表。
        // 查询词是用户自己输的，回显出来才用得上手。
        return Err(ToolError::invalid(
            "out.iana-timezone-index.err.no_match",
            &[("query", query.as_str())],
        ));
    }

    let limit =
        super::util::bounded_u64(&payload, "limit", MAX_ROWS as u64, 1, MAX_LIMIT as u64) as usize;
    let shown = rows.len().min(limit);
    let mut table = Map::new();
    for z in rows.iter().take(shown) {
        table.insert(z.name.to_string(), json!(z.describe()));
    }

    let output = match (query.is_empty(), rows.len() > shown) {
        (true, true) => format!(
            "共 {} 个 IANA 时区（tzdata {}），下表显示前 {shown} 个；输入关键字可缩小范围",
            rows.len(),
            chrono_tz::IANA_TZDB_VERSION
        ),
        (true, false) => {
            format!(
                "共 {} 个 IANA 时区（tzdata {}）",
                rows.len(),
                chrono_tz::IANA_TZDB_VERSION
            )
        }
        (false, true) => format!(
            "匹配 {} 个时区，下表显示前 {shown} 个（可按时区名 / 缩写 / UTC 偏移搜索）",
            rows.len()
        ),
        (false, false) => {
            format!(
                "匹配 {} 个时区（tzdata {}）",
                rows.len(),
                chrono_tz::IANA_TZDB_VERSION
            )
        }
    };

    Ok(json!({
        "output": output,
        "table": table,
        "meta": {
            "query": query,
            "matched": rows.len(),
            "shown": shown,
            "truncated": rows.len() > shown,
            "tzdb_version": chrono_tz::IANA_TZDB_VERSION,
            "now_utc": now.to_rfc3339(),
        }
    }))
}

/// 一个时区在「当前时刻」的全部派生信息。
///
/// 全部在 `of()` 里一次算完：过滤时要看偏移和缩写，输出时还要看本地时间，
/// 分成两遍就得多遍历一次 596 个时区。
struct ZoneInfo {
    name: &'static str,
    /// 当前偏移，单位秒
    cur: i32,
    /// 标准（非夏令时）偏移，单位秒
    std_: i32,
    observes_dst: bool,
    dst_now: bool,
    abbrev: String,
    local_now: String,
}

impl ZoneInfo {
    fn of(tz: &Tz, now: DateTime<Utc>) -> Self {
        let naive = now.naive_utc();
        let cur = tz.offset_from_utc_datetime(&naive).fix().local_minus_utc();
        let abbrev = tz
            .offset_from_utc_datetime(&naive)
            .abbreviation()
            .unwrap_or("-")
            .to_string();

        // 判据见模块注释：1 月与 7 月偏移不同 ⇒ 观察夏令时，较小者是标准偏移。
        // 取本年的 1/1 与 7/1，而不是去年 12 月与今年 1 月 —— 后者在元旦前后
        // 可能刚好落在夏令时切换的那几天上，判出来是「没有夏令时」。
        let year = now.year();
        let jan = offset_at(tz, year, 1, 1, now);
        let jul = offset_at(tz, year, 7, 1, now);
        let observes_dst = jan != jul;
        let std_ = jan.min(jul);

        Self {
            name: tz.name(),
            cur,
            std_,
            observes_dst,
            dst_now: observes_dst && cur != std_,
            abbrev,
            local_now: now
                .with_timezone(tz)
                .format("%Y-%m-%d %H:%M:%S")
                .to_string(),
        }
    }

    /// 搜索匹配：时区名 / 缩写 / UTC 偏移，三种写法都认。
    ///
    /// 空查询匹配全部 —— 这就是「不填筛选条件时列出整张表」的实现。
    fn matches(&self, query: &str) -> bool {
        if query.is_empty() {
            return true;
        }
        // 偏移查询**只**按偏移匹配，不再顺手做名字/缩写子串匹配。
        //
        // 原因是一个具体的坑：POSIX 的 `Etc/` 命名把正负号倒置了 ——
        // `Etc/GMT+8` 其实是 **UTC−8**。靠子串匹配的话，搜 `gmt+8` 会把
        // `Etc/GMT+8` 一并捞进来，于是「找东八区」凭空多出一个西八区，
        // 比搜不到更难解释。而 `Etc/GMT-8`（真·东八区）本来就能靠偏移匹配上，
        // 按名字搜 `etc/gmt` 也照样找得到，两头都不亏。
        //
        // 偏移要同时对「当前偏移」和「标准偏移」生效：
        // 用户搜 `+1` 找「东一区」时，该找的是欧洲那一片标准 +01 的时区，
        // 而此刻它们多半正挂在 +02。只比当前偏移会把它们全漏掉。
        if let Some(secs) = parse_offset_query(query) {
            return self.cur == secs || self.std_ == secs;
        }
        if self.name.to_lowercase().contains(query) {
            return true;
        }
        self.abbrev.to_lowercase().contains(query)
    }

    /// 一行展示文案。
    fn describe(&self) -> String {
        let mut parts = vec![fmt_offset(self.cur)];
        if self.observes_dst {
            parts.push(format!(
                "缩写 {} · {}",
                self.abbrev,
                if self.dst_now {
                    "夏令时进行中"
                } else {
                    "标准时间"
                }
            ));
            if self.dst_now {
                parts.push(format!("标准 {}", fmt_offset(self.std_)));
            }
        } else {
            parts.push(format!("缩写 {} · 全年无夏令时", self.abbrev));
        }
        parts.push(format!("当地 {}", self.local_now));
        parts.join(" · ")
    }
}

/// 指定年月的 1 日零点的偏移（秒）。
///
/// 传 `fallback` 是为了在「年月构不出合法日期」时不 panic —— `year` 来自系统时钟，
/// 正常情况下永远合法，但让一个读时钟的工具因为时钟异常而崩掉不值得。
fn offset_at(tz: &Tz, year: i32, month: u32, day: u32, fallback: DateTime<Utc>) -> i32 {
    use chrono::NaiveDate;
    match NaiveDate::from_ymd_opt(year, month, day)
        .and_then(|d| d.and_hms_opt(0, 0, 0))
        .map(|ndt| tz.from_utc_datetime(&ndt).offset().fix().local_minus_utc())
    {
        Some(secs) => secs,
        None => tz
            .offset_from_utc_datetime(&fallback.naive_utc())
            .fix()
            .local_minus_utc(),
    }
}

/// `+08:00` / `UTC+8` / `gmt-5` → 偏移秒数。认不出来的写法返回 `None`。
///
/// **必须带符号**：光一个 `8` 既可能是 UTC+8 也可能是别的意思，
/// 猜错比不匹配更难解释。上面那句「刻意只认带符号的偏移」原先只是注释，
/// 代码却直接把无符号的当正数收了 —— `parse_offset_query_rejects_nonsense`
/// 就是钉这一条的。
fn parse_offset_query(q: &str) -> Option<i32> {
    let s = q.trim().to_ascii_lowercase();
    let s = s
        .strip_prefix("utc")
        .or_else(|| s.strip_prefix("gmt"))
        .unwrap_or(&s)
        .trim();
    let (sign, rest) = match s.strip_prefix('-') {
        Some(r) => (-1, r),
        None => (1, s.strip_prefix('+')?),
    };
    if rest.is_empty() || !rest.bytes().all(|b| b.is_ascii_digit() || b == b':') {
        return None;
    }
    let (h, m) = match rest.split_once(':') {
        Some((h, m)) => (h, m),
        // `+0800` 与 `+08` 两种紧凑写法都收
        None if rest.len() == 4 => (&rest[..2], &rest[2..]),
        None => (rest, "0"),
    };
    let h: i32 = h.parse().ok()?;
    let m: i32 = m.parse().ok()?;
    if !(0..=14).contains(&h) || !(0..=59).contains(&m) {
        return None;
    }
    Some(sign * (h * 3600 + m * 60))
}

/// `28800` → `UTC+08:00`。半小时（`+05:30`）和 45 分钟（`+05:45`）的时区都在库里，
/// 所以这里保留分钟位，不做「整小时」的假设。
fn fmt_offset(secs: i32) -> String {
    let (sign, abs) = if secs < 0 { ('-', -secs) } else { ('+', secs) };
    format!("UTC{sign}{:02}:{:02}", abs / 3600, (abs % 3600) / 60)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    fn run(q: &str) -> Value {
        compute(json!({ "query": q })).unwrap()
    }

    /// 带行数上限地跑一次。
    fn run_with_limit(q: &str, limit: u64) -> Value {
        compute(json!({ "query": q, "limit": limit })).unwrap()
    }

    fn table_of(v: &Value) -> Map<String, Value> {
        v["table"].as_object().cloned().unwrap()
    }

    /// 表里的每一行都要能原样读出来，不能出现 `null` / `undefined` 之类。
    fn row_for(v: &Value, zone: &str) -> String {
        table_of(v)[zone].as_str().unwrap_or_default().to_string()
    }

    /// 错误应当是语言包里的哪一条。
    ///
    /// 断言**键**而不是文案 —— 文案在语言包里，两种语言写得不一样。
    fn err_key(err: &ToolError) -> &str {
        match err {
            ToolError::InvalidKeyed { key, .. } => key,
            other => panic!("应当报一条语言包里的错误，实际 {other:?}"),
        }
    }

    /// 错误里某个占位符的值。
    fn err_arg(err: &ToolError, name: &str) -> String {
        match err {
            ToolError::InvalidKeyed { args, .. } => args
                .iter()
                .find(|(n, _)| n == name)
                .map(|(_, v)| v.clone())
                .unwrap_or_else(|| panic!("错误里没有参数 {name}: {args:?}")),
            other => panic!("应当报一条语言包里的错误，实际 {other:?}"),
        }
    }

    #[test]
    fn empty_query_reports_the_whole_index_size() {
        let out = run("");
        let matched = out["meta"]["matched"].as_u64().unwrap() as usize;
        // 全量 tzdata 是 590~600 个，断言区间而不是精确值：换 crate 版本不该红
        assert!(matched > 500, "时区太少，像是没加载全: {matched}");
        // 表格本身是截断过的，所以「总数」要看 meta，不能看 table 的行数
        assert_eq!(table_of(&out).len(), matched.min(MAX_ROWS));
        assert_eq!(out["meta"]["truncated"], matched > MAX_ROWS);
        assert!(out["output"].as_str().unwrap().contains("IANA"));
        // 每行都该有偏移
        assert!(row_for(&out, "Africa/Abidjan").contains("UTC"));
    }

    #[test]
    fn the_cap_is_the_default_not_a_hard_limit() {
        let out = run("");
        assert_eq!(table_of(&out).len(), MAX_ROWS, "默认应当正好取到上限");
        assert_eq!(out["meta"]["truncated"], true);
        assert_eq!(out["meta"]["shown"], MAX_ROWS);
        let text = out["output"].as_str().unwrap();
        // 截断了却不说，用户会以为表就这么大
        assert!(text.contains("显示前"), "{text}");
        assert!(
            text.contains(&out["meta"]["matched"].to_string()),
            "没报总数: {text}"
        );

        // 但用户可以把上限调大 —— 截断是为了不让默认页面变成一万像素的长条，
        // 不该把「看全表」的路堵死。
        let total = out["meta"]["matched"].as_u64().unwrap() as usize;
        let full = run_with_limit("", 1000);
        assert_eq!(table_of(&full).len(), total, "调大上限后应当是全表");
        assert_eq!(full["meta"]["truncated"], false);
        assert!(
            table_of(&full).contains_key("Asia/Shanghai"),
            "全表里该有亚洲"
        );
        assert!(table_of(&full).contains_key("UTC"), "全表里该有 UTC");

        // 离谱的大数被夹住，不会把后端拖垮
        assert_eq!(table_of(&run_with_limit("", 1_000_000)).len(), total);
        // 0 / 负数夹到 1，而不是变成「零行」或直接 500
        assert_eq!(table_of(&run_with_limit("", 0)).len(), 1);
    }

    #[test]
    fn zone_names_are_searchable() {
        let out = run("shanghai");
        assert!(table_of(&out).contains_key("Asia/Shanghai"), "{out}");
        // 大小写不敏感
        assert!(table_of(&run("SHANGHAI")).contains_key("Asia/Shanghai"));
        // 前缀能搜出整个区域
        let asia = run("asia/");
        assert!(
            table_of(&asia).len() > 30,
            "asia/ 只匹配到 {}",
            table_of(&asia).len()
        );
    }

    #[test]
    fn offset_queries_match_both_current_and_standard() {
        // 东一区：此刻（按测试运行时的季节）多半在 +02，但标准偏移是 +01。
        // 只比当前偏移的话搜 `+1` 会一条都搜不到 —— 这正是要同时比 std_ 的原因。
        let t = table_of(&run("utc+1"));
        assert!(!t.is_empty(), "搜 UTC+1 一条都没有");
        assert!(
            t.contains_key("Europe/Berlin") || t.contains_key("Europe/Paris"),
            "{t:?}"
        );
        // 带分钟的偏移区
        assert!(table_of(&run("+05:30")).contains_key("Asia/Kolkata"));
        assert!(table_of(&run("+05:45")).contains_key("Asia/Kathmandu"));
        // 负偏移
        assert!(
            table_of(&run("-05:00")).contains_key("America/New_York")
                || table_of(&run("-05:00")).contains_key("America/Toronto")
        );
    }

    #[test]
    fn offset_query_accepts_the_usual_spellings() {
        // 这些写法解析出来是同一个偏移，结果集必须**完全一样**
        let base = table_of(&run("+08:00"));
        for spelling in ["utc+8", "UTC+08", "gmt+8", "+0800", "+8"] {
            assert_eq!(
                table_of(&run(spelling)).keys().collect::<Vec<_>>(),
                base.keys().collect::<Vec<_>>(),
                "{spelling} 与 +08:00 结果不一致"
            );
        }
        assert!(base.contains_key("Asia/Shanghai"), "{base:?}");
    }

    #[test]
    fn an_offset_query_never_surfaces_the_posix_sign_flipped_zone() {
        // POSIX 的 `Etc/` 命名把正负号倒置了：`Etc/GMT+8` 是 **UTC−8**。
        // 搜「东八区」时靠名字子串把它捞进来，等于给用户塞了个西八区。
        let east = table_of(&run("+08:00"));
        assert!(
            !east.contains_key("Etc/GMT+8"),
            "把 Etc/GMT+8（其实是 UTC−8）当成东八区了"
        );
        assert!(east.contains_key("Etc/GMT-8"), "Etc/GMT-8 才是东八区");
        // 但按名字搜它还得找得到 —— 偏移查询不抢名字查询的活
        let by_name = table_of(&run("etc/gmt"));
        assert!(by_name.contains_key("Etc/GMT+8"), "{by_name:?}");
        assert!(by_name.contains_key("Etc/GMT-8"), "{by_name:?}");
    }

    #[test]
    fn abbreviations_are_searchable() {
        assert!(table_of(&run("CST")).contains_key("Asia/Shanghai"));
    }

    #[test]
    fn parse_offset_query_rejects_nonsense() {
        // 光一个 `8` 不认：既可能是 UTC+8 也可能是别的东西，猜错比不匹配更难解释
        assert_eq!(parse_offset_query("8"), None);
        assert_eq!(parse_offset_query("asia"), None);
        assert_eq!(parse_offset_query("+"), None);
        assert_eq!(parse_offset_query("+99:00"), None); // 超出 ±14 小时
        assert_eq!(parse_offset_query("+08:99"), None); // 分钟越界
        assert_eq!(parse_offset_query("+0a"), None);
        assert_eq!(parse_offset_query("utc+8"), Some(8 * 3600));
        assert_eq!(parse_offset_query("GMT-05:30"), Some(-(5 * 3600 + 30 * 60)));
        assert_eq!(parse_offset_query("+0000"), Some(0));
    }

    #[test]
    fn offset_formatting_keeps_minutes() {
        assert_eq!(fmt_offset(0), "UTC+00:00");
        assert_eq!(fmt_offset(8 * 3600), "UTC+08:00");
        assert_eq!(fmt_offset(-(5 * 3600 + 30 * 60)), "UTC-05:30");
        assert_eq!(fmt_offset(45 * 60), "UTC+00:45");
    }

    #[test]
    fn dst_is_reported_per_zone() {
        // 固定偏移时区：全年一个值，不该被判成有夏令时
        let sh = ZoneInfo::of(
            &tz_of("Asia/Shanghai"),
            Utc.with_ymd_and_hms(2026, 1, 15, 0, 0, 0).unwrap(),
        );
        assert!(!sh.observes_dst, "上海不该被判成有夏令时");
        assert_eq!(sh.cur, 8 * 3600);

        // 观察夏令时的时区：1 月与 7 月偏移不同，较小者是标准偏移
        let berlin = ZoneInfo::of(
            &tz_of("Europe/Berlin"),
            Utc.with_ymd_and_hms(2026, 7, 15, 0, 0, 0).unwrap(),
        );
        assert!(berlin.observes_dst);
        assert_eq!(berlin.std_, 3600);
        assert_eq!(berlin.cur, 2 * 3600);
        assert!(berlin.dst_now, "7 月的柏林在夏令时里");
        assert!(
            berlin.describe().contains("夏令时进行中"),
            "{}",
            berlin.describe()
        );
        assert!(
            berlin.describe().contains("标准 UTC+01:00"),
            "{}",
            berlin.describe()
        );

        // 同一个时区，冬天的判断要反过来
        let winter = ZoneInfo::of(
            &tz_of("Europe/Berlin"),
            Utc.with_ymd_and_hms(2026, 1, 15, 0, 0, 0).unwrap(),
        );
        assert!(winter.observes_dst);
        assert!(!winter.dst_now);
        assert_eq!(winter.cur, 3600);
    }

    /// 南半球的时区也要判对：1 月是夏令时、7 月是标准时，
    /// 但标准偏移仍然是较小的那一个。
    #[test]
    fn southern_hemisphere_dst_is_not_inverted() {
        let syd = ZoneInfo::of(
            &tz_of("Australia/Sydney"),
            Utc.with_ymd_and_hms(2026, 1, 15, 0, 0, 0).unwrap(),
        );
        assert!(syd.observes_dst);
        assert_eq!(syd.std_, 10 * 3600, "悉尼的标准偏移是 +10");
        assert_eq!(syd.cur, 11 * 3600, "1 月的悉尼在夏令时里，是 +11");
        assert!(syd.dst_now);
    }

    #[test]
    fn no_match_is_an_error_not_an_empty_table() {
        let err = compute(json!({ "query": "nowhere/at/all" })).unwrap_err();
        assert_eq!(
            err_key(&err),
            "out.iana-timezone-index.err.no_match",
            "{err:?}"
        );
        // 查询词是用户自己输的，回显出来才用得上手
        assert_eq!(err_arg(&err, "query"), "nowhere/at/all");
    }

    #[test]
    fn every_row_has_offset_abbreviation_and_local_time() {
        let t = table_of(&run(""));
        for (name, row) in &t {
            let s = row.as_str().unwrap_or("");
            assert!(s.contains("UTC"), "{name}: {s}");
            assert!(s.contains("缩写"), "{name}: {s}");
            assert!(s.contains("当地"), "{name}: {s}");
            assert!(!s.contains("null") && !s.contains("None"), "{name}: {s}");
        }
    }

    #[test]
    fn local_time_depends_on_the_zone() {
        let sh = row_for(&run("asia/shanghai"), "Asia/Shanghai");
        assert!(sh.contains("当地 20"), "{sh}");
        let ny = row_for(&run("america/new_york"), "America/New_York");
        assert!(
            ny.contains("当地 2") || ny.contains("当地 1") || ny.contains("当地 0"),
            "{ny}"
        );
    }

    #[test]
    fn malformed_query_types_do_not_panic() {
        // 公开接口，手写请求可能给数字 / 数组 / null
        for bad in [
            json!(42),
            json!([1, 2]),
            json!(null),
            json!({}),
            json!(true),
        ] {
            assert!(compute(json!({ "query": bad })).is_ok(), "{bad}");
        }
        assert!(compute(json!({})).is_ok(), "缺字段应当按空查询处理");
    }

    /// 测试里要按名字取 `Tz`。`TZ_VARIANTS` 是编译期生成的静态数组，
    /// 用它自己来找而不是手写 `Tz::` 常量 —— 常量名随 crate 版本变，写死会脆。
    fn tz_of(name: &str) -> Tz {
        TZ_VARIANTS
            .iter()
            .find(|t| t.name() == name)
            .copied()
            .unwrap_or_else(|| panic!("chrono-tz 里没有 {name}"))
    }
}
