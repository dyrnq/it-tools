//! 周数转换器（endpoint `week-number-converter`）。
//!
//! 上游 PR #1336 给了两个函数：`getFirstMondayFromISOWeek` 与
//! `getFirstMondayFromMonthWeek` —— 说白了就是「日期 ↔ 周数」来回换。
//! 想法是对的，实现有坑（下面「上游的坑」逐条列），所以这里重新写一遍，
//! 并且把三个方向都补齐：日期 → 周数、ISO 周 → 日期、月内周 → 日期。
//!
//! ## 为什么放服务端
//!
//! 上游全程用 `new Date(...)` —— 那是**浏览器本地时区**的日期。
//! 同一个输入在不同时区的机器上算出的「周内第几天」可能差一天，
//! 而「这天属于第几周」恰恰是跨时区协作里最常被追问的东西。
//! 服务端一律用 `chrono::NaiveDate`（纯日期，不带时区、不带时刻），
//! 结果只由输入决定 —— 同一个请求在任何地方都得到同一个答案。
//!
//! 另一层理由是**一份实现**：ISO 周边界的规则多到容易写错
//! （有的年份只有 52 周、12 月底可能属于次年的第 1 周），
//! 网页与 HTTP API 共用同一份过了单测的实现，比两处各写一遍更容易保证一致。
//!
//! ## 口径一：ISO 周
//!
//! 照搬 ISO 8601：一周从周一开始；**第 1 周是含当年第一个星期四的那一周**
//! （等价于「含 1 月 4 日的那一周」）；一周固定 7 天。
//!
//! 于是 ISO 周的年份可能与日历年不同 —— 2021-01-01 属于 **2020 年第 53 周**，
//! 2026-12-31 属于 **2026 年第 53 周**。一个 ISO 年有 52 或 53 周，
//! 第 53 周只在部分年份存在；查一个不存在的周必须报错，不能悄悄回退到第 52 周。
//!
//! ## 口径二：月内周（本工具自己定的）
//!
//! **周一起算；月内第 1 周 = 含当月 1 号的那一周；周不按月边界裁剪。**
//!
//! - 「含 1 号的那一周」即使从上月 26 号开始，也算本月第 1 周；
//! - 本月最后一周即使跨到下月（乃至次年 1 月），仍算本月的最后一周。
//!
//! 所以某月的周数 = `ceil((1 号在周内的位置 + 当月天数) / 7)`：
//! 1 号落在周一~周四时是 4~5 周，落在周五~周日时是 5~6 周。
//!
//! 这套规则**与上游、与 date-fns 都不一样**（上游用的是「含 4 号的那一周」，
//! date-fns 的 `getWeekOfMonth` 用的是「周日起、第 1 周含 1 日」）。
//! 我们只认上面这一套，且日期 → 周数与周数 → 日期用同一套，互相可逆。
//!
//! ## 上游的坑（逐条）
//!
//! 1. **月内周的往返对不上**：上游的 `getFirstMondayFromMonthWeek` 用「周一起、
//!    第 1 周含 4 日」，它的测试却拿 date-fns 的 `getWeekOfMonth` 比
//!    （「周日起、第 1 周含 1 日」）。两套规则混用，3 个用例只有一个能对上。
//!    → 这里定一套规则并前后一致（见上）。
//! 2. **没有 ISO 年份输出**：ISO 周的年份可能与日历年不同，上游完全没这个概念。
//!    → 这里用 `iso_week_year()` / `iso_week()` 给出（chrono 直接支持）。
//! 3. **本地时区歧义**：见「为什么放服务端」。
//!    → 只用 `NaiveDate`，不碰时区。
//! 4. **默认年份取的是本地日历年**，不是 ISO 年 —— 12 月底算 ISO 周时会差一年。
//!    → ISO 方向默认取**当前日期所在的 ISO 年**。
//!
//! ## 输入
//!
//! 日期字段接受 `YYYY-MM-DD`、`YYYY/MM/DD`、`YYYYMMDD`（手打时这三种都很常见）。
//! 解析不了就报错，并把「该写成什么样」一起说出来，不静默。
//!
//! ## 结果区的文案
//!
//! 结果表的行标题、表里成句的值、主结果 `output` 全部走语言包
//! （键在 `out.week-number-converter.*` 下面）。数字、日期这类机器可读的片段
//! 用 `{占位符}` 插进句子里 —— 语言包里两种语言可以有不同的语序。

use chrono::{Datelike, Duration, NaiveDate, Weekday};
use serde_json::{json, Map, Value};

use super::util;
use super::{ToolError, ToolResult};

/// ISO 周号的上限。实际有没有第 53 周取决于年份，另行校验。
const MAX_ISO_WEEK: i64 = 53;

/// 周号的通用下限（月内周与 ISO 周都从 1 开始）。
const MIN_WEEK: i64 = 1;

/// 支持的年份范围。
///
/// 上界取 9999 是为了「1 月 4 日」「12 月 28 日」这类边界算得出来，
/// 也免得用户填一个 5 位数年份，得到一个谁也没见过的周。
const MIN_YEAR: i64 = 1;
const MAX_YEAR: i64 = 9999;

/// 一周七天的**行标题**（周一 → 周日），按当前语言取。
///
/// 键写在字面量里 —— 语言包的对账测试靠扫这些字面量，
/// 才知道「有人真的在读这条文案」。
const DAY_LABEL_KEYS: [&str; 7] = [
    "out.week-number-converter.day_label.monday",
    "out.week-number-converter.day_label.tuesday",
    "out.week-number-converter.day_label.wednesday",
    "out.week-number-converter.day_label.thursday",
    "out.week-number-converter.day_label.friday",
    "out.week-number-converter.day_label.saturday",
    "out.week-number-converter.day_label.sunday",
];

/// 星期几的**名字**（星期一 → 星期日），按当前语言取。
const WEEKDAY_KEYS: [&str; 7] = [
    "out.week-number-converter.weekday.monday",
    "out.week-number-converter.weekday.tuesday",
    "out.week-number-converter.weekday.wednesday",
    "out.week-number-converter.weekday.thursday",
    "out.week-number-converter.weekday.friday",
    "out.week-number-converter.weekday.saturday",
    "out.week-number-converter.weekday.sunday",
];

/// 与注册表 `ApiSpec.fields` 保持一致。
pub async fn handle(payload: Value) -> ToolResult {
    compute(payload)
}

fn compute(payload: Value) -> ToolResult {
    // 下划线与连字符等价，API 调用者两种写法都可能用。
    let mode = util::str_or(&payload, "mode", "date-to-week")
        .trim()
        .to_ascii_lowercase()
        .replace('_', "-");
    match mode.as_str() {
        "date-to-week" | "date" | "date2week" => date_to_week(&payload),
        "iso-week-to-date" | "iso-week" | "week-to-date" => iso_week_to_date(&payload),
        "month-week-to-date" | "month-week" => month_week_to_date(&payload),
        // 错误文案在语言包里（键是字面量，对账测试才认得出这条文案有人在读）。
        other => Err(ToolError::invalid(
            "out.week-number-converter.err.bad_mode",
            &[("mode", other)],
        )),
    }
}

/* ==========================================================================
   结果区的文案
   ========================================================================== */

/// 取一条文案（按当前语言），并把 `{占位符}` 换掉。
///
/// 语言包里两种语言可以有不同的语序，所以数字、日期、年份这类
/// **机器可读**的片段一律用占位符插进句子里，不拼死在代码里。
fn tpl(lang: &str, key: &str, vars: &[(&str, &str)]) -> String {
    let mut text = crate::i18n::t(lang, key);
    for (name, value) in vars {
        text = text.replace(&format!("{{{name}}}"), value);
    }
    text
}

/// 年份那一格。
///
/// 填了就是数字；没填就带上「取当前年」的补注 —— 默认值会随日期变
/// （今年的年份、这个月），不说一声的话，用户会以为表单里真的写着那个值。
///
/// 整格文案（含数字）都从语言包取：数字用 `{year}` 占位。
///
/// `default_key` 是「没填时用哪条文案」—— 调用点写成字面量，
/// 语言包的对账测试才认得出这条文案有人在读。
fn year_cell(lang: &str, given: bool, year: i64, default_key: &str) -> String {
    let key = if given {
        "out.week-number-converter.year_value"
    } else {
        default_key
    };
    tpl(lang, key, &[("year", &year.to_string())])
}

/// 月份那一格。同 [`year_cell`]，占位符是 `{month}`。
fn month_cell(lang: &str, given: bool, month: i64) -> String {
    let key = if given {
        "out.week-number-converter.month_value"
    } else {
        "out.week-number-converter.month_default"
    };
    tpl(lang, key, &[("month", &month.to_string())])
}

/// 月内周的口径，写进输出里 —— 上游与 date-fns 各用一套规则，
/// 用户不看到说明就不知道该拿哪个答案去对。
fn month_week_rule(lang: &str) -> String {
    crate::i18n::t(lang, "out.week-number-converter.month_week_rule")
}

/// ISO 周的口径，同样写进输出。
fn iso_week_rule(lang: &str) -> String {
    crate::i18n::t(lang, "out.week-number-converter.iso_week_rule")
}

/* ==========================================================================
   方向一：日期 → 周数
   ========================================================================== */

fn date_to_week(payload: &Value) -> ToolResult {
    let lang = util::lang(payload);
    let raw = match util::opt_str(payload, "date").map(str::trim).filter(|s| !s.is_empty()) {
        Some(s) => s,
        None => {
            return Err(ToolError::invalid(
                "out.week-number-converter.err.missing_date",
                &[],
            ))
        }
    };
    let date = parse_date(raw)?;

    let iso_year = iso_week_year(date);
    let iso_week = iso_week_no(date);
    let cal_year = date.year();
    let month = date.month();
    let dim = days_in_month(cal_year, month);
    let mweek = week_of_month(date);
    let monday = month_week_monday(cal_year, month, mweek).ok_or_else(|| {
        ToolError::Internal(format!("{cal_year} 年 {month} 月第 {mweek} 周算不出来"))
    })?;

    let weekday = weekday_name(lang, date.weekday());

    let mut table = Map::new();
    util::row(
        &mut table,
        payload,
        "out.week-number-converter.input_date",
        json!(fmt_date(date)),
    );
    util::row(
        &mut table,
        payload,
        "out.week-number-converter.iso_year",
        json!(iso_year),
    );
    util::row(
        &mut table,
        payload,
        "out.week-number-converter.iso_week",
        json!(iso_week),
    );
    util::row(
        &mut table,
        payload,
        "out.week-number-converter.weekday_number",
        json!(tpl(
            lang,
            "out.week-number-converter.weekday_number_value",
            &[
                ("number", &date.weekday().number_from_monday().to_string()),
                ("weekday", &weekday),
            ],
        )),
    );
    util::row(
        &mut table,
        payload,
        "out.week-number-converter.calendar_year",
        json!(cal_year),
    );
    util::row(
        &mut table,
        payload,
        "out.week-number-converter.day_of_year",
        json!(date.ordinal()),
    );
    util::row(
        &mut table,
        payload,
        "out.week-number-converter.month",
        json!(month_cell(lang, true, month as i64)),
    );
    util::row(
        &mut table,
        payload,
        "out.week-number-converter.days_in_month",
        json!(dim),
    );
    util::row(
        &mut table,
        payload,
        "out.week-number-converter.week_of_month",
        json!(mweek),
    );
    util::row(
        &mut table,
        payload,
        "out.week-number-converter.week_monday",
        json!(fmt_date(monday)),
    );
    util::row(
        &mut table,
        payload,
        "out.week-number-converter.week_sunday",
        json!(fmt_date(monday + Duration::days(6))),
    );
    util::row(
        &mut table,
        payload,
        "out.week-number-converter.month_week_rule_label",
        json!(month_week_rule(lang)),
    );

    let output = tpl(
        lang,
        "out.week-number-converter.date_to_week_output",
        &[
            ("date", &fmt_date(date)),
            ("weekday", &weekday),
            ("iso_year", &iso_year.to_string()),
            ("iso_week", &iso_week.to_string()),
            ("calendar_year", &cal_year.to_string()),
            ("month", &month.to_string()),
            ("week_of_month", &mweek.to_string()),
        ],
    );

    Ok(json!({
        "output": output,
        "table": table,
        "meta": {
            "date": fmt_date(date),
            "isoWeekYear": iso_year,
            "isoWeek": iso_week,
            "isoWeekday": date.weekday().number_from_monday(),
            "calendarYear": cal_year,
            "dayOfYear": date.ordinal(),
            "month": month,
            "daysInMonth": dim,
            "weekOfMonth": mweek,
            "weekOfMonthMonday": fmt_date(monday),
        }
    }))
}

/* ==========================================================================
   方向二：ISO 周 → 日期
   ========================================================================== */

fn iso_week_to_date(payload: &Value) -> ToolResult {
    let lang = util::lang(payload);
    // 默认年份取**当前日期所在的 ISO 年**（不是日历年）——
    // 12 月底算 ISO 周时会差一整年，上游就是栽在这里。
    let default_year = iso_week_year(today()) as i64;
    let year_given = is_given(payload, "year");
    let year = int_field(payload, "year", default_year)?;
    check_year(year)?;
    let week = int_field(payload, "week", 1)?;
    if !(MIN_WEEK..=MAX_ISO_WEEK).contains(&week) {
        return Err(ToolError::invalid(
            "out.week-number-converter.err.bad_iso_week",
            &[
                ("min", &MIN_WEEK.to_string()),
                ("max", &MAX_ISO_WEEK.to_string()),
                ("week", &week.to_string()),
            ],
        ));
    }

    let weeks_in_year = iso_weeks_in_year(year as i32);
    if week > weeks_in_year as i64 {
        return Err(ToolError::invalid(
            "out.week-number-converter.err.no_such_iso_week",
            &[
                ("year", &year.to_string()),
                ("weeks", &weeks_in_year.to_string()),
                ("week", &week.to_string()),
            ],
        ));
    }

    let monday = iso_week_monday(year as i32, week as u32).ok_or_else(|| {
        ToolError::invalid(
            "out.week-number-converter.err.iso_week_not_computable",
            &[("year", &year.to_string()), ("week", &week.to_string())],
        )
    })?;

    let days = week_days(monday);

    let mut table = Map::new();
    util::row(
        &mut table,
        payload,
        "out.week-number-converter.iso_year",
        json!(year_cell(
            lang,
            year_given,
            year,
            "out.week-number-converter.iso_year_default"
        )),
    );
    util::row(
        &mut table,
        payload,
        "out.week-number-converter.iso_week",
        json!(week),
    );
    util::row(
        &mut table,
        payload,
        "out.week-number-converter.weeks_in_iso_year",
        json!(weeks_in_year),
    );
    util::row(
        &mut table,
        payload,
        "out.week-number-converter.iso_week_rule_label",
        json!(iso_week_rule(lang)),
    );
    for (i, key) in DAY_LABEL_KEYS.iter().enumerate() {
        util::row(&mut table, payload, key, json!(fmt_date(days[i])));
    }

    let output = tpl(
        lang,
        "out.week-number-converter.iso_week_output",
        &[
            ("iso_year", &year.to_string()),
            ("week", &week.to_string()),
            ("monday", &fmt_date(monday)),
            ("sunday", &fmt_date(monday + Duration::days(6))),
        ],
    );

    Ok(json!({
        "output": output,
        "table": table,
        "meta": {
            "isoWeekYear": year,
            "isoWeek": week,
            "weeksInIsoYear": weeks_in_year,
            "monday": fmt_date(monday),
            "sunday": fmt_date(monday + Duration::days(6)),
            "days": days.iter().map(|d| fmt_date(*d)).collect::<Vec<_>>(),
        }
    }))
}

/* ==========================================================================
   方向三：月内周 → 日期
   ========================================================================== */

fn month_week_to_date(payload: &Value) -> ToolResult {
    let lang = util::lang(payload);
    let today = today();
    let default_year = today.year() as i64;
    let year_given = is_given(payload, "year");
    let year = int_field(payload, "year", default_year)?;
    check_year(year)?;
    let month_given = is_given(payload, "month");
    let month = int_field(payload, "month", today.month() as i64)?;
    if !(1..=12).contains(&month) {
        return Err(ToolError::invalid(
            "out.week-number-converter.err.bad_month",
            &[("month", &month.to_string())],
        ));
    }
    let week = int_field(payload, "week", 1)?;
    if week < MIN_WEEK {
        return Err(ToolError::invalid(
            "out.week-number-converter.err.week_too_small",
            &[("min", &MIN_WEEK.to_string()), ("week", &week.to_string())],
        ));
    }

    let weeks = weeks_in_month(year as i32, month as u32);
    if week > weeks as i64 {
        return Err(ToolError::invalid(
            "out.week-number-converter.err.no_such_month_week",
            &[
                ("year", &year.to_string()),
                ("month", &month.to_string()),
                ("weeks", &weeks.to_string()),
                ("week", &week.to_string()),
            ],
        ));
    }

    let monday = month_week_monday(year as i32, month as u32, week as u32).ok_or_else(|| {
        ToolError::Internal(format!("{year} 年 {month} 月第 {week} 周算不出来"))
    })?;

    let days = week_days(monday);

    let mut table = Map::new();
    util::row(
        &mut table,
        payload,
        "out.week-number-converter.calendar_year",
        json!(year_cell(
            lang,
            year_given,
            year,
            "out.week-number-converter.calendar_year_default"
        )),
    );
    util::row(
        &mut table,
        payload,
        "out.week-number-converter.month",
        json!(month_cell(lang, month_given, month)),
    );
    util::row(
        &mut table,
        payload,
        "out.week-number-converter.week_of_month",
        json!(week),
    );
    util::row(
        &mut table,
        payload,
        "out.week-number-converter.weeks_in_month",
        json!(weeks),
    );
    util::row(
        &mut table,
        payload,
        "out.week-number-converter.month_week_rule_label",
        json!(month_week_rule(lang)),
    );
    for (i, key) in DAY_LABEL_KEYS.iter().enumerate() {
        util::row(&mut table, payload, key, json!(fmt_date(days[i])));
    }

    let output = tpl(
        lang,
        "out.week-number-converter.month_week_output",
        &[
            ("year", &year.to_string()),
            ("month", &month.to_string()),
            ("week", &week.to_string()),
            ("monday", &fmt_date(monday)),
            ("sunday", &fmt_date(monday + Duration::days(6))),
        ],
    );

    Ok(json!({
        "output": output,
        "table": table,
        "meta": {
            "year": year,
            "month": month,
            "weekOfMonth": week,
            "weeksInMonth": weeks,
            "monday": fmt_date(monday),
            "sunday": fmt_date(monday + Duration::days(6)),
            "days": days.iter().map(|d| fmt_date(*d)).collect::<Vec<_>>(),
        }
    }))
}

/* ==========================================================================
   周与日期的换算
   ========================================================================== */

/// 含当月 1 号的那一周的周一 —— 即「月内第 1 周」的周一。
///
/// 1 号是周日时，这个周一会落在上月 26 号；这正是本工具的口径
/// （第 1 周含 1 号，而不是含 4 号）。
fn first_week_monday(year: i32, month: u32) -> Option<NaiveDate> {
    let first = NaiveDate::from_ymd_opt(year, month, 1)?;
    let back = first.weekday().number_from_monday() as i64 - 1;
    Some(first - Duration::days(back))
}

/// 月内第 `week` 周的周一。`week` 从 1 起。
///
/// 年月已经在入口校验过（1..=9999 / 1..=12），所以 `None` 走不到；
/// 但仍然返回 `Option` 而不是 `expect` —— 用户输入不该有机会把进程带崩。
fn month_week_monday(year: i32, month: u32, week: u32) -> Option<NaiveDate> {
    let first_monday = first_week_monday(year, month)?;
    Some(first_monday + Duration::days(7 * (week as i64 - 1)))
}

/// 给定日期落在它所在那个月的第几周。
fn week_of_month(date: NaiveDate) -> u32 {
    let Some(first_monday) = first_week_monday(date.year(), date.month()) else {
        return 1;
    };
    // date ≥ 1 号 ≥ first_monday，差值恒非负；div_euclid 只是保险。
    let diff = date.signed_duration_since(first_monday).num_days();
    (diff.div_euclid(7) + 1) as u32
}

/// 某月共有几周（按本工具的月内周口径）。
///
/// 1 号在周内的位置（周一=0 … 周日=6）决定第 1 周从哪天开始，
/// 而「当月最后一天落在第几周」决定周数：
/// `ceil((位置 + 当月天数) / 7)`。
fn weeks_in_month(year: i32, month: u32) -> u32 {
    match NaiveDate::from_ymd_opt(year, month, 1) {
        Some(first) => {
            let offset = first.weekday().number_from_monday() as i64 - 1;
            let dim = days_in_month(year, month) as i64;
            ((offset + dim + 6) / 7) as u32
        }
        // 年月已在入口校验过，走不到这里。
        None => 0,
    }
}

/// ISO 周所属的年份。
///
/// **可能与日历年不同** —— 2021-01-01 属于 ISO 2020 年，2026-12-31 属于 ISO 2026 年。
/// chrono 0.4.45 的 `Datelike::iso_week()` 返回的是 `IsoWeek` 结构体
/// （不是 `u32`），年份与周号分别从它的 `year()` / `week()` 取。
fn iso_week_year(date: NaiveDate) -> i32 {
    date.iso_week().year()
}

/// ISO 周的序号（1..=53）。
fn iso_week_no(date: NaiveDate) -> u32 {
    date.iso_week().week()
}

/// ISO 年 `year` 一共有几周（52 或 53）。
///
/// 12 月 28 日必定落在**该 ISO 年的最后一周**里（那一周的星期四最晚是 12 月 31 日，
/// 所以这一周归属的 ISO 年就是 `year`），因此它的 ISO 周号就是这一年的周数。
fn iso_weeks_in_year(year: i32) -> u32 {
    match NaiveDate::from_ymd_opt(year, 12, 28) {
        Some(dec28) => dec28.iso_week().week(),
        None => 52,
    }
}

/// ISO 年 `year` 第 `week` 周的周一。
///
/// ISO 第 1 周 = 含当年 1 月 4 日的那一周（等价于含第一个星期四的那一周）。
fn iso_week_monday(year: i32, week: u32) -> Option<NaiveDate> {
    let jan4 = NaiveDate::from_ymd_opt(year, 1, 4)?;
    let back = jan4.weekday().number_from_monday() as i64 - 1;
    Some(jan4 - Duration::days(back) + Duration::days(7 * (week as i64 - 1)))
}

/// 某个月的 1 号有几天。
///
/// 自己算而不是问 chrono：这样「2 月有多少天」在闰年判定上只有一处实现。
fn days_in_month(year: i32, month: u32) -> u32 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if is_leap_year(year) => 29,
        2 => 28,
        _ => 0,
    }
}

/// 闰年判定（格里高利历）：能被 400 整除，或能被 4 整除且不能被 100 整除。
fn is_leap_year(year: i32) -> bool {
    (year % 4 == 0 && year % 100 != 0) || year % 400 == 0
}

/// 一周的 7 天（周一 → 周日）。
///
/// 只给日期 —— 行标题（周一…周日）是语言包里的文案，由调用方拿
/// [`DAY_LABEL_KEYS`] 去取。
fn week_days(monday: NaiveDate) -> Vec<NaiveDate> {
    (0..7).map(|i| monday + Duration::days(i)).collect()
}

/* ==========================================================================
   输入解析
   ========================================================================== */

/// 解析日期。接受 `YYYY-MM-DD`、`YYYY/MM/DD`、`YYYYMMDD`。
///
/// 手打日期时 `-` 与 `/` 混用、或者干脆敲成 `20240115` 都很常见，
/// 所以三种写法都收；但**解析不了必须报错**，不能悄悄当成别的东西。
fn parse_date(raw: &str) -> Result<NaiveDate, ToolError> {
    let s = raw.trim();
    let (y, m, d) = split_date(s).ok_or_else(|| {
        ToolError::invalid("out.week-number-converter.err.bad_date", &[("date", s)])
    })?;

    if !(1..=12).contains(&m) {
        return Err(ToolError::invalid(
            "out.week-number-converter.err.bad_date_month",
            &[("date", s), ("month", &m.to_string())],
        ));
    }
    if !(1..=31).contains(&d) {
        return Err(ToolError::invalid(
            "out.week-number-converter.err.bad_date_day",
            &[("date", s), ("day", &d.to_string())],
        ));
    }
    NaiveDate::from_ymd_opt(y as i32, m, d).ok_or_else(|| {
        let dim = days_in_month(y as i32, m);
        ToolError::invalid(
            "out.week-number-converter.err.day_not_in_month",
            &[
                ("date", s),
                ("year", &y.to_string()),
                ("month", &m.to_string()),
                ("days", &dim.to_string()),
                ("day", &d.to_string()),
            ],
        )
    })
}

/// 把日期字符串拆成 (年, 月, 日)。只管形状，不管范围 ——
/// 范围留给 [`parse_date`]，好给出「月份 13 不在 1 到 12 之间」这种具体提示。
fn split_date(s: &str) -> Option<(u32, u32, u32)> {
    let parts: Vec<&str> = if s.contains('-') {
        s.split('-').collect()
    } else if s.contains('/') {
        s.split('/').collect()
    } else if s.len() == 8 && s.bytes().all(|b| b.is_ascii_digit()) {
        // `20240115` → 已确认全是 ASCII 数字，切片不会落在字符边界上。
        vec![&s[0..4], &s[4..6], &s[6..8]]
    } else {
        return None;
    };
    if parts.len() != 3 {
        return None;
    }
    let year = parts[0].trim();
    if year.len() != 4 || !year.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let month: u32 = parts[1].trim().parse().ok()?;
    let day: u32 = parts[2].trim().parse().ok()?;
    Some((year.parse().ok()?, month, day))
}

/// 字段是不是被填了。
///
/// **不区分字符串与数字** —— 表单交上来的是字符串（`app.js` 对 `Number`
/// 字段提交字符串），直接 curl 交的是 JSON 数字，两种都算「填了」。
/// 只看 `opt_str` 的话，`{"year": 2020}` 会被误判成没填，
/// 于是输出里多一句「未指定，取当前年份」，与用户明明填了 2020 打架。
fn is_given(payload: &Value, name: &str) -> bool {
    match payload.get(name) {
        None | Some(Value::Null) => false,
        Some(Value::String(s)) => !s.trim().is_empty(),
        Some(_) => true,
    }
}

/// 取整数字段：缺字段（或空串）用 `default`；给了但不是整数则报错。
///
/// 不用 [`util::bounded_u64`]：那个是**夹取**（越界夹到边界），
/// 而「第 53 周不存在」「这个月只有 5 周」是**要报错**的 ——
/// 夹掉等于悄悄给了一个错的周。
fn int_field(payload: &Value, name: &str, default: i64) -> Result<i64, ToolError> {
    match payload.get(name) {
        None | Some(Value::Null) => Ok(default),
        Some(Value::Number(n)) => n.as_i64().ok_or_else(|| {
            ToolError::invalid(
                "out.week-number-converter.err.not_an_integer",
                &[("field", name), ("value", &n.to_string())],
            )
        }),
        Some(Value::String(s)) => {
            let t = s.trim();
            if t.is_empty() {
                Ok(default)
            } else {
                t.parse::<i64>().map_err(|_| {
                    ToolError::invalid(
                        "out.week-number-converter.err.not_an_integer",
                        &[("field", name), ("value", t)],
                    )
                })
            }
        }
        Some(other) => Err(ToolError::invalid(
            "out.week-number-converter.err.not_an_integer",
            &[("field", name), ("value", &other.to_string())],
        )),
    }
}

/// 年份范围校验。
fn check_year(year: i64) -> Result<(), ToolError> {
    if !(MIN_YEAR..=MAX_YEAR).contains(&year) {
        return Err(ToolError::invalid(
            "out.week-number-converter.err.bad_year",
            &[
                ("min", &MIN_YEAR.to_string()),
                ("max", &MAX_YEAR.to_string()),
                ("year", &year.to_string()),
            ],
        ));
    }
    Ok(())
}

/* ==========================================================================
   小工具
   ========================================================================== */

/// 今天的日期（服务器本地时区）。
///
/// 只用来给「不填年份/月份」的情形兜底 —— 真正的换算全程用 `NaiveDate`，
/// 不带时区、不带时刻，所以结果与服务器在哪个时区无关。
fn today() -> NaiveDate {
    chrono::Local::now().date_naive()
}

/// `YYYY-MM-DD`。
fn fmt_date(date: NaiveDate) -> String {
    date.format("%Y-%m-%d").to_string()
}

/// 星期几的名字（星期一…星期日），按当前语言取。
fn weekday_name(lang: &str, w: Weekday) -> String {
    // `number_from_monday()` 是 1..=7（周一=1），数组下标要 0..=6。
    let idx = w.number_from_monday() as usize - 1;
    crate::i18n::t(lang, WEEKDAY_KEYS[idx])
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn run(payload: Value) -> Value {
        compute(payload).unwrap_or_else(|e| panic!("不该报错: {e}"))
    }

    fn table_of(v: &Value) -> Map<String, Value> {
        v["table"].as_object().cloned().unwrap()
    }

    fn cell(v: &Value, key: &str) -> String {
        match &v["table"][key] {
            Value::String(s) => s.clone(),
            other => other.to_string(),
        }
    }

    fn date_of(v: &Value, key: &str) -> String {
        cell(v, key)
    }

    /// 行标题：按语言包解析。
    ///
    /// 语言包还没并进去时 `t()` 退回键本身 —— 于是断言照样成立，
    /// 并进去之后断言的就是真正的行标题（中文/英文各一份）。
    fn title(key: &str) -> String {
        crate::i18n::t("en", key)
    }

    /// 按语言包渲染一条文案（语言包还没并进去时退回键本身）。
    fn render(key: &str, vars: &[(&str, &str)]) -> String {
        let mut text = crate::i18n::t("en", key);
        for (name, value) in vars {
            text = text.replace(&format!("{{{name}}}"), value);
        }
        text
    }

    /// 某条文案在指定语言下的样子。
    fn text(lang: &str, key: &str) -> String {
        crate::i18n::t(lang, key)
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

    /* ---- 方向一：日期 → 周数 ---- */

    #[test]
    fn a_plain_monday_maps_to_the_expected_week() {
        let out = run(json!({ "date": "2024-01-15" }));
        assert_eq!(cell(&out, &title("out.week-number-converter.iso_year")), "2024");
        assert_eq!(cell(&out, &title("out.week-number-converter.iso_week")), "3");
        assert_eq!(
            cell(&out, &title("out.week-number-converter.weekday_number")),
            render(
                "out.week-number-converter.weekday_number_value",
                &[
                    ("number", "1"),
                    ("weekday", &text("en", "out.week-number-converter.weekday.monday")),
                ],
            )
        );
        assert_eq!(cell(&out, &title("out.week-number-converter.calendar_year")), "2024");
        assert_eq!(cell(&out, &title("out.week-number-converter.day_of_year")), "15");
        assert_eq!(
            cell(&out, &title("out.week-number-converter.month")),
            render("out.week-number-converter.month_value", &[("month", "1")])
        );
        assert_eq!(cell(&out, &title("out.week-number-converter.days_in_month")), "31");
        assert_eq!(cell(&out, &title("out.week-number-converter.week_of_month")), "3");
        assert_eq!(date_of(&out, &title("out.week-number-converter.week_monday")), "2024-01-15");
        assert_eq!(date_of(&out, &title("out.week-number-converter.week_sunday")), "2024-01-21");
    }

    #[test]
    fn the_iso_year_is_reported_separately_from_the_calendar_year() {
        // 2021-01-01 是星期五，属于 ISO 2020 年第 53 周
        let out = run(json!({ "date": "2021-01-01" }));
        assert_eq!(cell(&out, &title("out.week-number-converter.iso_year")), "2020");
        assert_eq!(cell(&out, &title("out.week-number-converter.iso_week")), "53");
        assert_eq!(cell(&out, &title("out.week-number-converter.calendar_year")), "2021");
        assert_eq!(
            cell(&out, &title("out.week-number-converter.weekday_number")),
            render(
                "out.week-number-converter.weekday_number_value",
                &[
                    ("number", "5"),
                    ("weekday", &text("en", "out.week-number-converter.weekday.friday")),
                ],
            )
        );

        // 2026-12-31 是星期四，属于 ISO 2026 年第 53 周
        let out = run(json!({ "date": "2026-12-31" }));
        assert_eq!(cell(&out, &title("out.week-number-converter.iso_year")), "2026");
        assert_eq!(cell(&out, &title("out.week-number-converter.iso_week")), "53");
        assert_eq!(
            cell(&out, &title("out.week-number-converter.weekday_number")),
            render(
                "out.week-number-converter.weekday_number_value",
                &[
                    ("number", "4"),
                    ("weekday", &text("en", "out.week-number-converter.weekday.thursday")),
                ],
            )
        );
    }

    #[test]
    fn every_day_of_the_year_maps_to_the_same_iso_week() {
        // ISO 周边界最容易错，这里把一整年逐天过一遍：
        // ISO 年 Y 恰好覆盖 weeks * 7 天，每天都落在 Y 里，
        // 且周号从 1 连续数到 weeks。
        for year in 2015..2030 {
            let weeks = iso_weeks_in_year(year);
            assert!(weeks == 52 || weeks == 53, "{year} 年有 {weeks} 周");
            let first_monday = iso_week_monday(year, 1).unwrap();
            let last_monday = iso_week_monday(year, weeks).unwrap();
            assert_eq!(
                last_monday - first_monday,
                Duration::days(7 * (weeks as i64 - 1)),
                "{year} 年的周之间不连续"
            );

            let mut date = first_monday;
            while date <= last_monday + Duration::days(6) {
                assert_eq!(iso_week_year(date), year, "{date} 的 ISO 年不是 {year}");
                assert_eq!(
                    iso_week_no(date),
                    ((date - first_monday).num_days() / 7 + 1) as u32,
                    "{date} 的 ISO 周号不对"
                );
                // 该 ISO 周的周一必须落在同一个 ISO 年里
                let monday = iso_week_monday(year, iso_week_no(date)).unwrap();
                assert_eq!(iso_week_year(monday), year, "{date} 的周一起始年不对");
                assert!((monday..=monday + Duration::days(6)).contains(&date));
                date += Duration::days(1);
            }

            // ISO 年之间首尾相接：Y 年的最后一天的次日是 Y+1 年的第 1 周周一
            let next_first = iso_week_monday(year + 1, 1).unwrap();
            assert_eq!(last_monday + Duration::days(7), next_first, "{year} 与下一年不接上");
        }
    }

    #[test]
    fn the_three_date_spellings_mean_the_same_thing() {
        let base = run(json!({ "date": "2024-01-15" }));
        for spelling in ["2024-01-15", "2024/01/15", "20240115", " 2024-01-15 "] {
            let out = run(json!({ "date": spelling }));
            assert_eq!(out["table"], base["table"], "{spelling} 解析结果不一样");
        }
    }

    #[test]
    fn an_unparsable_date_says_what_to_type_instead() {
        let err = compute(json!({ "date": "not a date" })).unwrap_err();
        assert_eq!(
            err_key(&err),
            "out.week-number-converter.err.bad_date",
            "{err:?}"
        );
        // 用户自己输的日期回显出来 —— 他得知道是哪一个写错了
        assert_eq!(err_arg(&err, "date"), "not a date");

        // 缺字段也要说清楚要填什么
        let err = compute(json!({})).unwrap_err();
        assert_eq!(
            err_key(&err),
            "out.week-number-converter.err.missing_date",
            "{err:?}"
        );
    }

    #[test]
    fn an_impossible_date_is_rejected_with_the_reason() {
        // 任务里点名的这一条
        let err = compute(json!({ "date": "2024-13-01" })).unwrap_err();
        assert_eq!(
            err_key(&err),
            "out.week-number-converter.err.bad_date_month",
            "{err:?}"
        );
        assert_eq!(err_arg(&err, "month"), "13");

        let err = compute(json!({ "date": "2024-02-30" })).unwrap_err();
        assert_eq!(
            err_key(&err),
            "out.week-number-converter.err.day_not_in_month",
            "{err:?}"
        );
        assert_eq!(err_arg(&err, "days"), "29"); // 2024 是闰年，2 月有 29 天
        assert_eq!(err_arg(&err, "day"), "30");

        let err = compute(json!({ "date": "2023-02-29" })).unwrap_err();
        assert_eq!(err_arg(&err, "days"), "28", "{err:?}");
    }

    /* ---- 方向二：ISO 周 → 日期 ---- */

    #[test]
    fn iso_week_to_date_matches_the_upstream_expectations() {
        // 上游自己的三个用例（它们在 ISO 口径下是对的，月内周口径下不是）
        for (week, year, monday, sunday) in [
            (11, 2022, "2022-03-14", "2022-03-20"),
            (1, 2023, "2023-01-02", "2023-01-08"),
            (53, 2026, "2026-12-28", "2027-01-03"),
        ] {
            let out = run(json!({ "mode": "iso-week-to-date", "year": year, "week": week }));
            assert_eq!(
                date_of(&out, &title("out.week-number-converter.day_label.monday")),
                monday,
                "{year} 年第 {week} 周"
            );
            assert_eq!(
                date_of(&out, &title("out.week-number-converter.day_label.sunday")),
                sunday,
                "{year} 年第 {week} 周"
            );
        }
    }

    #[test]
    fn an_iso_week_spans_seven_consecutive_days_starting_on_monday() {
        let out = run(json!({ "mode": "iso-week-to-date", "year": 2024, "week": 3 }));
        let days = [
            "2024-01-15",
            "2024-01-16",
            "2024-01-17",
            "2024-01-18",
            "2024-01-19",
            "2024-01-20",
            "2024-01-21",
        ];
        for (key, expected) in DAY_LABEL_KEYS.iter().zip(days) {
            assert_eq!(date_of(&out, &title(key)), expected, "{key}");
        }
    }

    #[test]
    fn a_week_that_does_not_exist_is_an_error_not_a_silent_fallback() {
        // 2024 年只有 52 周（1 月 1 日是星期一）
        assert_eq!(iso_weeks_in_year(2024), 52);
        let err = compute(json!({ "mode": "iso-week-to-date", "year": 2024, "week": 53 }))
            .unwrap_err();
        assert_eq!(
            err_key(&err),
            "out.week-number-converter.err.no_such_iso_week",
            "{err:?}"
        );
        // 用户得知道那年一共几周、自己要的第几周不存在
        assert_eq!(err_arg(&err, "weeks"), "52");
        assert_eq!(err_arg(&err, "week"), "53");

        // 而 2026 年确实有 53 周
        assert_eq!(iso_weeks_in_year(2026), 53);
        assert!(compute(json!({ "mode": "iso-week-to-date", "year": 2026, "week": 53 })).is_ok());
    }

    #[test]
    fn an_iso_week_round_trips_through_date_to_week() {
        for year in 2019..2027 {
            let weeks = iso_weeks_in_year(year);
            for week in 1..=weeks {
                let out = run(json!({ "mode": "iso-week-to-date", "year": year, "week": week }));
                let monday = out["meta"]["monday"].as_str().unwrap().to_string();
                let back = run(json!({ "date": monday }));
                assert_eq!(
                    cell(&back, &title("out.week-number-converter.iso_year")),
                    year.to_string(),
                    "{year} 第 {week} 周"
                );
                assert_eq!(
                    cell(&back, &title("out.week-number-converter.iso_week")),
                    week.to_string(),
                    "{year} 第 {week} 周"
                );
            }
        }
    }

    #[test]
    fn a_week_number_out_of_range_is_rejected() {
        for week in [0, 54, -1, 999] {
            let err = compute(json!({ "mode": "iso-week-to-date", "year": 2024, "week": week }))
                .unwrap_err();
            assert_eq!(
                err_key(&err),
                "out.week-number-converter.err.bad_iso_week",
                "{week}: {err:?}"
            );
            assert_eq!(err_arg(&err, "week"), week.to_string());
        }
        // 非整数也要报错，不能悄悄用默认值
        let err = compute(json!({ "mode": "iso-week-to-date", "year": 2024, "week": "abc" }))
            .unwrap_err();
        assert_eq!(
            err_key(&err),
            "out.week-number-converter.err.not_an_integer",
            "{err:?}"
        );
        assert_eq!(err_arg(&err, "field"), "week");
        assert_eq!(err_arg(&err, "value"), "abc");
    }

    /* ---- 方向三：月内周 → 日期 ---- */

    #[test]
    fn the_month_week_rule_is_monday_first_and_week_one_contains_the_first() {
        // 2024-01-01 是星期一 → 1 月第 1 周从 1 月 1 日开始
        let out = run(json!({ "date": "2024-01-01" }));
        assert_eq!(cell(&out, &title("out.week-number-converter.week_of_month")), "1");
        assert_eq!(date_of(&out, &title("out.week-number-converter.week_monday")), "2024-01-01");

        // 2024-01-08 是星期一 → 第 2 周
        let out = run(json!({ "date": "2024-01-08" }));
        assert_eq!(cell(&out, &title("out.week-number-converter.week_of_month")), "2");
        assert_eq!(date_of(&out, &title("out.week-number-converter.week_monday")), "2024-01-08");

        // 2024-01-31 是星期三 → 落在从 1 月 29 日开始的那一周 = 第 5 周
        let out = run(json!({ "date": "2024-01-31" }));
        assert_eq!(cell(&out, &title("out.week-number-converter.week_of_month")), "5");
        assert_eq!(date_of(&out, &title("out.week-number-converter.week_monday")), "2024-01-29");
        assert_eq!(date_of(&out, &title("out.week-number-converter.week_sunday")), "2024-02-04");
    }

    #[test]
    fn a_week_spanning_two_months_stays_with_the_month_that_owns_the_first() {
        // 2023-01-01 是星期日 → 1 月第 1 周从 2022-12-26 开始
        let out = run(json!({ "date": "2023-01-01" }));
        assert_eq!(cell(&out, &title("out.week-number-converter.week_of_month")), "1");
        assert_eq!(date_of(&out, &title("out.week-number-converter.week_monday")), "2022-12-26");

        // 2023-01-02 是星期一 → 已经是 1 月第 2 周了
        let out = run(json!({ "date": "2023-01-02" }));
        assert_eq!(cell(&out, &title("out.week-number-converter.week_of_month")), "2");
        assert_eq!(date_of(&out, &title("out.week-number-converter.week_monday")), "2023-01-02");

        // 2026-12-28 属于 2026 年 12 月的第 5 周，尽管那一周跨到了 2027 年
        let out = run(json!({ "date": "2026-12-28" }));
        assert_eq!(cell(&out, &title("out.week-number-converter.week_of_month")), "5");
        assert_eq!(date_of(&out, &title("out.week-number-converter.week_monday")), "2026-12-28");
        assert_eq!(date_of(&out, &title("out.week-number-converter.week_sunday")), "2027-01-03");
        assert_eq!(
            cell(&out, &title("out.week-number-converter.month")),
            render("out.week-number-converter.month_value", &[("month", "12")])
        );
    }

    #[test]
    fn the_number_of_weeks_in_a_month_follows_the_documented_rule() {
        // ceil((1 号在周内的位置 + 当月天数) / 7)
        assert_eq!(weeks_in_month(2024, 1), 5); // 1 号是星期一
        assert_eq!(weeks_in_month(2023, 1), 6); // 1 号是星期日
        assert_eq!(weeks_in_month(2024, 2), 5); // 1 号是星期四，闰年 29 天
        assert_eq!(weeks_in_month(2023, 2), 5); // 1 号是星期三，28 天
        assert_eq!(weeks_in_month(2026, 12), 5); // 1 号是星期二，31 天
    }

    #[test]
    fn every_day_of_every_month_maps_to_a_week_that_contains_it() {
        // 逐日遍历 5 年，验证：
        // 1) 周号永远落在 1..=该月周数；
        // 2) 该周的周一到周日确实包含这一天；
        // 3) 往返：日期 → (年, 月, 周) → 拿回的 7 天里包含这一天。
        for year in 2021..2026 {
            for month in 1..=12 {
                let weeks = weeks_in_month(year, month);
                let mut date = NaiveDate::from_ymd_opt(year, month, 1).unwrap();
                let last_day = days_in_month(year, month);
                let last = NaiveDate::from_ymd_opt(year, month, last_day).unwrap();
                while date <= last {
                    let w = week_of_month(date);
                    assert!((1..=weeks).contains(&w), "{date} 的月内周是 {w}，超出 1..={weeks}");

                    let monday = month_week_monday(year, month, w).unwrap();
                    assert!(
                        (monday..=monday + Duration::days(6)).contains(&date),
                        "{date} 不在它自己那一周 {monday} 里"
                    );

                    // 往返
                    let out = run(json!({
                        "mode": "month-week-to-date",
                        "year": year,
                        "month": month,
                        "week": w,
                    }));
                    let days: Vec<String> = out["meta"]["days"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .map(|v| v.as_str().unwrap().to_string())
                        .collect();
                    assert_eq!(days.len(), 7);
                    assert!(days.contains(&fmt_date(date)), "{date} 往返后不见了: {days:?}");

                    date += Duration::days(1);
                }
            }
        }
    }

    #[test]
    fn month_week_to_date_returns_the_seven_days_of_that_week() {
        let out = run(json!({ "mode": "month-week-to-date", "year": 2024, "month": 1, "week": 3 }));
        assert_eq!(
            date_of(&out, &title("out.week-number-converter.day_label.monday")),
            "2024-01-15"
        );
        assert_eq!(
            date_of(&out, &title("out.week-number-converter.day_label.sunday")),
            "2024-01-21"
        );
        assert_eq!(cell(&out, &title("out.week-number-converter.weeks_in_month")), "5");
        assert_eq!(cell(&out, &title("out.week-number-converter.week_of_month")), "3");
    }

    #[test]
    fn a_week_beyond_the_month_is_an_error() {
        // 2024 年 1 月只有 5 周
        let err = compute(json!({ "mode": "month-week-to-date", "year": 2024, "month": 1, "week": 6 }))
            .unwrap_err();
        assert_eq!(
            err_key(&err),
            "out.week-number-converter.err.no_such_month_week",
            "{err:?}"
        );
        assert_eq!(err_arg(&err, "weeks"), "5");
        assert_eq!(err_arg(&err, "week"), "6");

        // 2023 年 1 月有 6 周，第 6 周存在，第 7 周不存在
        assert!(compute(json!({ "mode": "month-week-to-date", "year": 2023, "month": 1, "week": 6 })).is_ok());
        let err = compute(json!({ "mode": "month-week-to-date", "year": 2023, "month": 1, "week": 7 }))
            .unwrap_err();
        assert_eq!(err_arg(&err, "weeks"), "6", "{err:?}");
    }

    #[test]
    fn an_impossible_month_or_year_is_rejected() {
        for month in [0, 13, -1] {
            let err = compute(json!({ "mode": "month-week-to-date", "year": 2024, "month": month }))
                .unwrap_err();
            assert_eq!(
                err_key(&err),
                "out.week-number-converter.err.bad_month",
                "{month}: {err:?}"
            );
            assert_eq!(err_arg(&err, "month"), month.to_string());
        }
        for year in [0, 10000, -5] {
            let err = compute(json!({ "mode": "month-week-to-date", "year": year, "month": 1 }))
                .unwrap_err();
            assert_eq!(
                err_key(&err),
                "out.week-number-converter.err.bad_year",
                "{year}: {err:?}"
            );
            assert_eq!(err_arg(&err, "year"), year.to_string());
        }
    }

    /* ---- 通用 ---- */

    #[test]
    fn an_unknown_mode_names_the_accepted_values() {
        let err = compute(json!({ "mode": "week" })).unwrap_err();
        assert_eq!(
            err_key(&err),
            "out.week-number-converter.err.bad_mode",
            "{err:?}"
        );
        assert_eq!(err_arg(&err, "mode"), "week");
        // 可用值列表在语言包里 —— 并进来之后才断言它真的列全了
        if crate::i18n::has("zh-CN", "out.week-number-converter.err.bad_mode") {
            let msg = err.localize("zh-CN");
            for m in ["date-to-week", "iso-week-to-date", "month-week-to-date"] {
                assert!(msg.contains(m), "{msg}");
            }
        }
    }

    #[test]
    fn the_default_mode_is_date_to_week() {
        let out = run(json!({ "date": "2024-01-15" }));
        // 没给 `mode` 时走的是「日期 → 周数」：主结果是那句话，
        // ISO 年/周/日历年/周内周都该在 meta 里。
        assert_eq!(out["meta"]["isoWeek"], json!(3));
        assert_eq!(out["meta"]["calendarYear"], json!(2024));
        assert_eq!(out["meta"]["weekOfMonth"], json!(3));
        assert_eq!(
            out["output"].as_str().unwrap(),
            render(
                "out.week-number-converter.date_to_week_output",
                &[
                    ("date", "2024-01-15"),
                    ("weekday", &text("en", "out.week-number-converter.weekday.monday")),
                    ("iso_year", "2024"),
                    ("iso_week", "3"),
                    ("calendar_year", "2024"),
                    ("month", "1"),
                    ("week_of_month", "3"),
                ],
            )
        );
    }

    #[test]
    fn both_output_and_table_are_always_present() {
        for payload in [
            json!({ "date": "2024-01-15" }),
            json!({ "mode": "iso-week-to-date", "year": 2024, "week": 3 }),
            json!({ "mode": "month-week-to-date", "year": 2024, "month": 1, "week": 3 }),
        ] {
            let out = run(payload);
            assert!(!out["output"].as_str().unwrap_or("").is_empty(), "{out}");
            assert!(!table_of(&out).is_empty(), "{out}");
        }
    }

    /// 行标题按**请求语言**取：带 `__lang: zh-CN` 是中文行标题，
    /// 不带（默认英文）是英文行标题。
    #[test]
    fn the_row_title_follows_the_request_language() {
        const KEY: &str = "out.week-number-converter.iso_year";
        let zh = run(json!({ "date": "2024-01-15", "__lang": "zh-CN" }));
        let en = run(json!({ "date": "2024-01-15" }));

        let zh_title = text("zh-CN", KEY);
        let en_title = text("en", KEY);
        assert_eq!(
            zh["table"][zh_title.as_str()],
            json!(2024),
            "中文请求该用中文行标题"
        );
        assert_eq!(
            en["table"][en_title.as_str()],
            json!(2024),
            "默认请求该用英文行标题"
        );

        // 语言包并进去之后（现在还没并），中英文的行标题必须真的不一样
        if crate::i18n::has("zh-CN", KEY) {
            assert_eq!(zh_title, "ISO 年");
            assert_eq!(en_title, "ISO year");
        }
    }

    #[test]
    fn a_missing_year_falls_back_to_the_current_iso_year() {
        // 默认年份必须是**当前日期所在的 ISO 年**，不是日历年
        let out = run(json!({ "mode": "iso-week-to-date" }));
        let year = iso_week_year(today());
        assert_eq!(out["meta"]["isoWeekYear"].as_i64().unwrap(), year as i64);
        // 没填年份时那一格是「带补注」的那条文案（补注本身在语言包里）
        assert_eq!(
            cell(&out, &title("out.week-number-converter.iso_year")),
            render(
                "out.week-number-converter.iso_year_default",
                &[("year", &year.to_string())]
            ),
            "{out}"
        );
    }

    #[test]
    fn a_filled_in_year_is_never_labelled_as_a_default() {
        // 表单交的是字符串、直接 curl 交的是 JSON 数字 —— 两种都得算「填了」，
        // 否则填了 2020 却显示「未指定，取当前年份」，跟用户打架。
        for payload in [
            json!({ "mode": "iso-week-to-date", "year": 2020, "week": 53 }),
            json!({ "mode": "iso-week-to-date", "year": "2020", "week": 53 }),
            json!({ "mode": "month-week-to-date", "year": 2023, "month": 1, "week": 2 }),
            json!({ "mode": "month-week-to-date", "year": "2023", "month": "1", "week": "2" }),
        ] {
            let out = run(payload.clone());
            let (key, year) = if payload["mode"] == "iso-week-to-date" {
                ("out.week-number-converter.iso_year", "2020")
            } else {
                ("out.week-number-converter.calendar_year", "2023")
            };
            // 填了年份 → 那一格就是年份本身，不带补注
            assert_eq!(
                cell(&out, &title(key)),
                render("out.week-number-converter.year_value", &[("year", year)]),
                "{payload}"
            );
        }

        // 但真的没填时，提示必须还在
        let out = run(json!({ "mode": "month-week-to-date" }));
        assert_eq!(
            cell(&out, &title("out.week-number-converter.month")),
            render(
                "out.week-number-converter.month_default",
                &[("month", &today().month().to_string())]
            ),
            "{out}"
        );
        assert_eq!(
            cell(&out, &title("out.week-number-converter.calendar_year")),
            render(
                "out.week-number-converter.calendar_year_default",
                &[("year", &today().year().to_string())]
            ),
            "{out}"
        );
    }

    #[test]
    fn malformed_payloads_do_not_panic() {
        // 公开接口，手写请求可能给数字 / 数组 / null
        for payload in [
            json!({ "date": 42 }),
            json!({ "date": ["2024-01-15"] }),
            json!({ "date": null }),
            json!({ "mode": null }),
            json!({ "mode": ["date-to-week"] }),
            json!({ "mode": "iso-week-to-date", "year": "abc" }),
            json!({ "mode": "iso-week-to-date", "year": 1.5 }),
            json!({ "mode": "month-week-to-date", "month": "x" }),
            json!({}),
        ] {
            let _ = compute(payload);
        }
    }

    /// 错误信息也按请求语言渲染 —— 语言不是工具决定的，是 API 层调
    /// `localize` 时按请求语言渲染的。
    #[test]
    fn the_error_message_follows_the_requested_language() {
        let err = compute(json!({ "date": "not a date" })).unwrap_err();
        // 语言包里还没并进来时，localize 退回键本身 —— 这时断言跳过
        if !crate::i18n::has("zh-CN", "out.week-number-converter.err.bad_date") {
            return;
        }
        let en = err.localize("en");
        let zh = err.localize("zh-CN");
        assert_ne!(en, zh, "两种语言不该是同一句");
        assert!(
            !en.contains("out.week-number-converter"),
            "英文界面不该露出键：{en}"
        );
        // 用户自己输的日期要回显出来 —— 他得知道是哪一个写错了
        assert!(en.contains("not a date"), "{en}");
        assert!(zh.contains("not a date"), "{zh}");
    }
}
