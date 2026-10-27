//! Date-time converter —— 同一时刻的多种日期格式互转（endpoint `date-time-converter`）。
//!
//! 与参考实现的差异有两处，都是有意的：
//!
//! 1. **多了一个目标时区 `timezone`**（IANA 名，如 `Asia/Shanghai`）。参考实现没有，
//!    所有格式要么是 UTC、要么保留输入自带的偏移量；这里允许把「人读的格式」
//!    （ISO 8601 / ISO 9075 / RFC 3339）换算到指定时区。
//!    但 **unix / 毫秒时间戳 / Mongo ObjectID / Excel 序列号 / RFC 7231 / UTC format
//!    这些是「时刻」或「以 UTC 为基准」的表示，换时区不会改变它们** ——
//!    一个 Unix 时间戳不管你在北京还是纽约看，它都是那个数；RFC 7231 结尾写死了
//!    `GMT`，硬塞本地时间进去反而是错的（输出的是 UTC）。
//! 2. **参考实现的第 0 项 `JS locale date string` 不在服务端的输出里**：那是
//!    `Date.prototype.toString()`，输出的是「浏览器所在时区」的表示，服务端无从得知。
//!    由前端按 `meta.utc` 自己算那一行（见 `static/js/app.js` 的 `renderRows`）——
//!    参考实现里它也是浏览器算的，行为一致。
//!    需要本地时区的用户改填 `timezone` 字段即可（登记在 meta 的 `utcOffset` 里）；
//!    前端还会把浏览器自己的 IANA 时区预填进去，所以默认就跟参考实现一样显示本地时间。
//!
//! 另外两处更细的差异记在各自的地方：日期越界（`2023-02-30`）见 [`parse_iso_date`]，
//! Mongo ObjectID 输出的补零见 [`mongo_objectid`]。
//!
//! ## 自动识别（`format: "auto"`）的优先级
//!
//! 输入的形状经常同时符合多种格式（`2022-01-01` 既是合法 ISO 8601 也是合法 ISO 9075），
//! 所以识别顺序必须写死并公开，否则同一个输入今天和明天会得到不同的解释：
//!
//! 1. **RFC 7231** —— 唯一以 `, ` + `GMT` 结尾的形状，最不容易认错；
//! 2. **ISO 8601** —— 是 RFC 3339 / ISO 9075 能表达的子集，参考实现也把它排在三者之前；
//! 3. **RFC 3339**、4. **ISO 9075** —— 实际被第 2 条吃掉了（ISO 8601 的超集包含它们），
//!    保留在列表里只是为了让人一眼看出「显式选择仍然可用」；
//! 5. **Mongo ObjectID** —— 24 位十六进制，形状独一无二；
//! 6. **Unix 秒** —— `^[0-9]{1,10}$`，**无符号**；
//! 7. **毫秒时间戳** —— `^[0-9]{1,13}$`，**无符号**；
//!    另外**正好 16 位**的纯数字按**微秒**时间戳解释（14/15 位不认 —— 那两种位数
//!    在毫秒与微秒两种解释下都越界，认它只会给出一个错答案）；
//! 8. **UTC format** —— 与 RFC 7231 同形，已被第 1 条吃掉；
//! 9. **Excel** —— `^-?\d+(\.\d+)?$`，只在前面的都不匹配时才轮到。
//!
//! 于是有两处「天然二义」，规则写死在这里：
//! - `1`~`13` 位的纯数字一律当 unix 秒或毫秒（≤10 位当秒，11~13 位当毫秒），
//!   **不是** Excel 序列号 —— 与参考实现一致；
//! - 正好 `16` 位的纯数字当**微秒**时间戳（见第 7 条）；
//! - 带符号（负数）或带小数点的纯数字落到 Excel，与参考实现的正则一致。
//!   所以 `-1` 自动识别会得到 1899-12-29（纪元前一天），而不是 1969 年的那一秒。
//!   想按另一种理解解析，就显式选 `format` —— 显式选择的优先级永远高于自动识别，
//!   而且此时解析器也严格按该格式走（不会「顺手」用别的格式兜底），
//!   显式选 `unix` 时 `-1` 就是 1969-12-31T23:59:59Z。
//!   为了不「静默」地做这种取舍，实际用到的格式始终写回 `meta.detectedFormat`。

use chrono::{
    DateTime, Datelike, FixedOffset, NaiveDate, NaiveDateTime, Offset, TimeZone, Utc, Weekday,
};
use chrono_tz::Tz;
use serde_json::{json, Value};

use super::{ToolError, ToolResult};

/// Excel 的起点：1899-12-30 与 Unix 纪元（1970-01-01）相差 25569 天。
///
/// 为什么不是 1900-01-01：Excel 沿用了 Lotus 1-2-3 把 1900 当成闰年的错误，
/// 认为 1900-02-29 存在，于是「1900-01-01 = 序列号 1」这个等式只有在把纪元
/// 定在 1899-12-30（往前推一天）时才成立。本实现与参考实现一样，**老老实实按
/// 1899-12-30 线性外推、不去模拟那个 bug**，代价是序列号 1~60 与真实 Excel 差一天
/// （真实 Excel 里 1 = 1900-01-01，这里 1 = 1899-12-31），要用就只管用 ≥ 61 的部分。
const EXCEL_EPOCH_OFFSET_DAYS: f64 = 25_569.0;

/// 超过这个秒数就直接报错：chrono 自己能表示的范围要大得多（约 ±25 万年），
/// 但 `f64 as i64` 会饱和、Excel/ObjectID 也都表达不了，逐年份校验给用户更好懂的报错。
const MAX_ABS_SECONDS: f64 = 1.0e12;
/// 同上，单位是毫秒（Excel 序列号反算走这条路）。
const MAX_ABS_MILLIS: f64 = 1.0e16;

/// 输出的年份上限。超出的时刻 `%Y` 会打成五位数、Excel 序列号也不再是「天数」，
/// 与其给一堆看不懂的东西不如直接说清楚。
const MIN_YEAR: i32 = 0;
const MAX_YEAR: i32 = 9999;

/// 与注册表 `ApiField.options` 一一对应（`auto` 不产生输出，故不在表内）。
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Format {
    Iso8601,
    Iso9075,
    Rfc3339,
    Rfc7231,
    Unix,
    Timestamp,
    Utc,
    MongoObjectId,
    Excel,
}

/// 「这个输入是按哪种单位/格式解的」。
///
/// 解析失败时的措辞按单位分：秒、毫秒、微秒的「不是合法的 XXX」是三句话，
/// ObjectID 与 Excel 序列号又是另外两句 —— 所以错误键也跟着分开，
/// 每条都能整句翻译，不用把「毫秒」这种半中半英的词塞进占位符里。
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Unit {
    Unix,
    Millis,
    Micros,
    ObjectId,
    Excel,
}

impl Unit {
    /// 「不是合法的 XXX」那条错误的键。
    fn not_a_number_key(self) -> &'static str {
        match self {
            Unit::Unix => "out.date-converter.err.not_unix",
            Unit::Millis => "out.date-converter.err.not_millis",
            Unit::Micros => "out.date-converter.err.not_micros",
            Unit::ObjectId => "out.date-converter.err.not_object_id",
            Unit::Excel => "out.date-converter.err.not_excel",
        }
    }

    /// 「超出可表示的日期范围」那条错误的键。
    fn out_of_range_key(self) -> &'static str {
        match self {
            Unit::Unix => "out.date-converter.err.unix_out_of_range",
            Unit::Millis => "out.date-converter.err.millis_out_of_range",
            Unit::Micros => "out.date-converter.err.micros_out_of_range",
            Unit::ObjectId => "out.date-converter.err.object_id_out_of_range",
            Unit::Excel => "out.date-converter.err.excel_out_of_range",
        }
    }
}

impl Format {
    fn key(self) -> &'static str {
        match self {
            Format::Iso8601 => "iso8601",
            Format::Iso9075 => "iso9075",
            Format::Rfc3339 => "rfc3339",
            Format::Rfc7231 => "rfc7231",
            Format::Unix => "unix",
            Format::Timestamp => "timestamp",
            Format::Utc => "utc",
            Format::MongoObjectId => "mongo-objectid",
            Format::Excel => "excel",
        }
    }

    /// 表格行的标题，必须与下拉框里的文案一致，否则用户对不上号。
    fn label(self) -> &'static str {
        match self {
            Format::Iso8601 => "ISO 8601",
            Format::Iso9075 => "ISO 9075",
            Format::Rfc3339 => "RFC 3339",
            Format::Rfc7231 => "RFC 7231",
            Format::Unix => "Unix timestamp (seconds)",
            Format::Timestamp => "Timestamp (milliseconds)",
            Format::Utc => "UTC format",
            Format::MongoObjectId => "Mongo ObjectID",
            Format::Excel => "Excel date/time",
        }
    }

    fn from_key(key: &str) -> Option<Format> {
        Some(match key {
            "iso8601" => Format::Iso8601,
            "iso9075" => Format::Iso9075,
            "rfc3339" => Format::Rfc3339,
            "rfc7231" => Format::Rfc7231,
            "unix" => Format::Unix,
            "timestamp" => Format::Timestamp,
            "utc" => Format::Utc,
            "mongo-objectid" => Format::MongoObjectId,
            "excel" => Format::Excel,
            _ => return None,
        })
    }
}

/// 自动识别的尝试顺序，见模块文档里的说明表。
const DETECT_ORDER: [Format; 9] = [
    Format::Rfc7231,
    Format::Iso8601,
    Format::Rfc3339,
    Format::Iso9075,
    Format::MongoObjectId,
    Format::Unix,
    Format::Timestamp,
    Format::Utc,
    Format::Excel,
];

/// 本工具是纯查表 + 字符串格式化，CPU 开销可忽略，`handle` 只是同步 `compute` 的壳。
pub async fn handle(payload: Value) -> ToolResult {
    compute(payload)
}

fn compute(payload: Value) -> ToolResult {
    // 空输入 = 「现在」：参考实现里 `inputDate` 为空就直接用 `now`，
    // 所以打开页面就有结果（时间戳、ISO 之类的都是当下这一刻）。
    // 注意只认**完全为空**的输入框 —— 只打了空格的那种在参考实现里
    // 会走 `new Date("  ")` 得到 Invalid Date，各行显示「Invalid date...」。
    let raw_field = super::util::opt_str(&payload, "date").unwrap_or_default();
    let raw = raw_field.trim().to_string();
    let is_now = raw_field.is_empty();
    let selected = super::util::str_or(&payload, "format", "auto");

    // 时区先校验：填错了要立刻报出来，不能悄悄退回 UTC —— 否则用户以为自己看的是
    // 上海时间，其实看到的是 UTC，整张表都是错的。
    let tz_name = super::util::opt_str(&payload, "timezone")
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let tz = match tz_name {
        Some(name) => Some(name.parse::<Tz>().map_err(|_| {
            // 时区名是用户自己输的，回显出来才用得上手
            ToolError::invalid(
                "out.date-converter.err.unknown_timezone",
                &[("timezone", name)],
            )
        })?),
        None => None,
    };

    // 显式 format 的优先级高于自动识别；显式时也只用该格式自己的解析器。
    let chosen = Format::from_key(selected);
    // `chosen` 是 Option：空输入时没有「按哪种格式解析」这回事（用此刻），
    // 记成 None，输出主结果退回到最通用的 ISO 8601。
    let (chosen, parsed): (Option<Format>, DateTime<FixedOffset>) = if is_now {
        (None, Utc::now().fixed_offset())
    } else {
        match chosen {
            Some(f) => (Some(f), parse_as(f, &raw, tz.as_ref())?),
            None if selected == "auto" => {
                let (f, d) = detect(&raw, tz.as_ref())?;
                (Some(f), d)
            }
            None => {
                return Err(ToolError::invalid(
                    "out.date-converter.err.bad_format",
                    &[("format", selected)],
                ))
            }
        }
    };

    let utc = parsed.with_timezone(&Utc);
    if !(MIN_YEAR..=MAX_YEAR).contains(&utc.year()) {
        return Err(ToolError::invalid(
            "out.date-converter.err.year_out_of_range",
            &[
                ("min", &format!("{MIN_YEAR:04}")),
                ("max", &format!("{MAX_YEAR:04}")),
            ],
        ));
    }

    // 「人读的格式」的基准偏移量：填了时区就用该时区此刻的偏移（注意是这一瞬间的偏移，
    // 夏令时切换前后同一个墙上时间会得到不同的 ±HH:MM），没填就用输入自带的偏移。
    let display_offset = match &tz {
        Some(t) => t.offset_from_utc_datetime(&utc.naive_utc()).fix(),
        None => parsed.offset().fix(),
    };
    let local = utc.with_timezone(&display_offset);

    // RFC 7231 与 UTC format 一律用 UTC 渲染：格式里写死了 `GMT`，
    // 换上本地时间就等于在说谎。
    let utc_str = utc.format("%a, %d %b %Y %H:%M:%S GMT").to_string();

    let table = json!({
        Format::Iso8601.label(): iso_like(&local),
        Format::Iso9075.label(): iso9075_like(&local),
        Format::Rfc3339.label(): iso_like(&local),
        Format::Rfc7231.label(): utc_str.clone(),
        // 以下四个是「时刻」，与显示时区无关
        Format::Unix.label(): utc.timestamp().to_string(),
        Format::Timestamp.label(): utc.timestamp_millis().to_string(),
        Format::Utc.label(): utc_str,
        Format::MongoObjectId.label(): mongo_objectid(utc.timestamp()),
        Format::Excel.label(): excel_serial(utc.timestamp_millis()),
    });

    let mut meta = serde_json::Map::new();
    meta.insert("format".to_string(), json!(selected));
    meta.insert(
        "detectedFormat".to_string(),
        json!(chosen.map(|f| f.key()).unwrap_or("now")),
    );
    if let Some(name) = tz_name {
        meta.insert("timezone".to_string(), json!(name));
    }
    // 跨时区换算时用户最想看到的就是这个偏移量。
    meta.insert(
        "utcOffset".to_string(),
        json!(offset_label(display_offset.local_minus_utc())),
    );
    meta.insert(
        "utc".to_string(),
        json!(iso_instant(&utc)),
    );

    // `output` 给用户选的那个格式；`auto`（或空输入）时给 ISO 8601（最通用、最少歧义）。
    // 前端会把 `output` 显示成主结果、`table` 显示成明细，所以两者都保留。
    let output = table[chosen.map(|f| f.label()).unwrap_or(Format::Iso8601.label())].clone();

    // `rows` 是给「一行一个格式」那种界面用的：参考实现的每个格式占一行
    // （标签 + 只读输入框 + 复制图标），顺序就是格式的常见顺序，不是字母序。
    // `table` 是无序映射（键是格式名），字母序；两者的内容一样，只是排法不同。
    //
    // 「JS locale date string」不在这里 —— 那是浏览器本地时区的写法，
    // 服务端不知道浏览器的时区，由前端按 `meta.utc` 自己算（见 app.js 的 renderRows）。
    let rows: Vec<Value> = [
        Format::Iso8601,
        Format::Iso9075,
        Format::Rfc3339,
        Format::Rfc7231,
        Format::Unix,
        Format::Timestamp,
        Format::Utc,
        Format::MongoObjectId,
        Format::Excel,
    ]
    .iter()
    .map(|f| {
        json!({
            "key": f.key(),
            "label": f.label(),
            "value": table[f.label()],
        })
    })
    .collect();

    Ok(json!({
        "output": output,
        "table": table,
        "rows": rows,
        "meta": Value::Object(meta),
    }))
}

// ------------------------------------------------------------------ 解析

fn detect(raw: &str, tz: Option<&Tz>) -> Result<(Format, DateTime<FixedOffset>), ToolError> {
    for fmt in DETECT_ORDER {
        if !looks(fmt, raw) {
            continue;
        }
        if let Ok(dt) = parse_as(fmt, raw, tz) {
            return Ok((fmt, dt));
        }
    }
    Err(ToolError::invalid(
        "out.date-converter.err.unrecognized_date",
        &[("value", raw)],
    ))
}

/// 各格式的「形状匹配」，对应参考实现的 `formatMatcher`。
///
/// 必须与解析器分开写：解析器要宽松（显式选 `unix` 时当然要收 `-1`、`1.5`），
/// 形状匹配器要严格 —— 否则自动识别会把 `-1` 和 `45028.88` 抢去当 Unix 秒。
fn looks(fmt: Format, raw: &str) -> bool {
    match fmt {
        // RFC 7231 与 UTC format 同形（`Wed, 12 Apr 2023 21:10:24 GMT`），只能用形状认
        Format::Rfc7231 | Format::Utc => raw.contains(", ") && raw.ends_with(" GMT"),
        // 三种 ISO 变体共用一个解析器，形状也就一起判
        Format::Iso8601 | Format::Iso9075 | Format::Rfc3339 => parse_iso8601(raw, None).is_some(),
        Format::MongoObjectId => raw.len() == 24 && raw.bytes().all(|b| b.is_ascii_hexdigit()),
        // 与参考实现一致：`^[0-9]{1,10}$` / `^[0-9]{1,13}$`，**不接受符号**
        Format::Unix => raw.len() <= 10 && is_digits(raw),
        // 毫秒时间戳 `^[0-9]{1,13}$`；**另外**接受正好 16 位的微秒时间戳。
        // 14/15 位不收 —— 那种位数在毫秒、微秒两种解释下都越界，认它只会给出错答案。
        Format::Timestamp => (raw.len() <= 13 || raw.len() == 16) && is_digits(raw),
        Format::Excel => number(raw).is_some(),
    }
}

fn parse_as(fmt: Format, raw: &str, tz: Option<&Tz>) -> Result<DateTime<FixedOffset>, ToolError> {
    match fmt {
        // 三种 ISO 变体共用一个解析器：ISO 8601 的文法是 RFC 3339 / ISO 9075 的超集，
        // 解析出来的是同一个瞬间，分开写只会让边界行为出现分歧。
        Format::Iso8601 | Format::Iso9075 | Format::Rfc3339 => {
            parse_iso8601(raw, tz).ok_or_else(|| {
                ToolError::invalid("out.date-converter.err.not_iso8601", &[("value", raw)])
            })
        }
        Format::Rfc7231 | Format::Utc => parse_rfc7231(raw),
        Format::Unix => exact_instant(raw, 1_000_000_000, Unit::Unix),
        Format::Timestamp => {
            // 单位按**有效位数**判断：正好 16 位当微秒，其余当毫秒。
            // 16 位毫秒落在公元 51xxx 年（早越过 MAX_YEAR），16 位微秒正好覆盖 2020—2280 年代。
            if significant_digits(raw) == 16 {
                exact_instant(raw, 1_000, Unit::Micros)
            } else {
                exact_instant(raw, 1_000_000, Unit::Millis)
            }
        }
        Format::MongoObjectId => {
            if raw.len() != 24 || !raw.bytes().all(|b| b.is_ascii_hexdigit()) {
                return Err(ToolError::invalid(
                    "out.date-converter.err.not_object_id",
                    &[("value", raw)],
                ));
            }
            let secs = u32::from_str_radix(&raw[..8], 16).map_err(|_| {
                ToolError::invalid(
                    "out.date-converter.err.object_id_timestamp",
                    &[("value", raw)],
                )
            })?;
            DateTime::from_timestamp(secs as i64, 0)
                .map(|dt| dt.fixed_offset())
                .ok_or_else(|| out_of_range(Unit::ObjectId, raw))
        }
        Format::Excel => {
            let days = number(raw).ok_or_else(|| {
                ToolError::invalid("out.date-converter.err.not_excel", &[("value", raw)])
            })?;
            // 表达式与参考实现逐字一致（先 ×86400 再 ×1000，两次舍入可能差最后一位）。
            // JS 的 new Date(x) 会把小数截断（向零），所以这里也 trunc 而不是 floor。
            let ms = ((days - EXCEL_EPOCH_OFFSET_DAYS) * 86_400.0) * 1000.0;
            // 先挡一道：`f64 as i64` 对溢出是饱和，会把天文数字悄悄变成 i64::MAX。
            if !ms.is_finite() || ms.abs() > MAX_ABS_MILLIS {
                return Err(out_of_range(Unit::Excel, raw));
            }
            DateTime::from_timestamp_millis(ms.trunc() as i64)
                .map(|dt| dt.fixed_offset())
                .ok_or_else(|| out_of_range(Unit::Excel, raw))
        }
    }
}

/// 「超出可表示的日期范围」的错误。
fn out_of_range(unit: Unit, raw: &str) -> ToolError {
    ToolError::invalid(unit.out_of_range_key(), &[("value", raw)])
}

/// 把「整数 + 可选小数」精确换算成时刻。
///
/// `unit_ns` 是整数部分的单位（秒 = 1e9、毫秒 = 1e6、微秒 = 1e3 纳秒）；
/// 小数部分与整数部分**同单位**，所以要按 `1e9 / unit_ns` 折算成纳秒。
///
/// 为什么全程用整数而不是 f64：f64 只有 53 位有效数字，
/// `1701227351995 / 1000.0` 在二进制里是 `1701227351.9949998865127563…`，
/// 小数部分再乘 1e9 取整就成了 994999886 纳秒 —— 与正确的 995000000 差了 114 纳秒。
/// 看着像噪声，其实是实打实的错，而且「时间戳差一点点」是最难排查的一类问题。
///
/// 负数按「向下取整」处理：`-0.5` 秒 = `-1` 秒 + `0.5` 秒（`div_euclid` / `rem_euclid`
/// 对负数也是 floor 语义，不用自己写 `if v < 0`）。
fn exact_instant(
    raw: &str,
    unit_ns: i128,
    unit: Unit,
) -> Result<DateTime<FixedOffset>, ToolError> {
    let (negative, int_val, frac9) = split_decimal(raw).ok_or_else(|| {
        ToolError::invalid(unit.not_a_number_key(), &[("value", raw)])
    })?;
    // 整数部分允许到的最大绝对值：换算成秒之后不能超过 MAX_ABS_SECONDS
    let max_int = (MAX_ABS_SECONDS as i128) * (1_000_000_000 / unit_ns);
    if int_val.abs() > max_int {
        return Err(out_of_range(unit, raw));
    }
    let frac_ns = frac9 as i128 / (1_000_000_000 / unit_ns);
    let total = int_val * unit_ns + frac_ns;
    let total = if negative { -total } else { total };
    let secs = total.div_euclid(1_000_000_000);
    let nanos = total.rem_euclid(1_000_000_000) as u32;
    DateTime::from_timestamp(secs as i64, nanos)
        .map(|dt| dt.fixed_offset())
        .ok_or_else(|| out_of_range(unit, raw))
}

/// 「十进制字符串」→ (是否负数, 整数部分, 小数部分补齐到 9 位)。
///
/// 小数部分不足 9 位补 0、超过 9 位截断（纳秒以下不保留）。
/// 语法不合法（整数部分为空、出现非数字字符、`1.` 这种尾巴带点的）返回 `None`。
fn split_decimal(raw: &str) -> Option<(bool, i128, u32)> {
    let body = raw.strip_prefix(['+', '-']).unwrap_or(raw);
    let negative = raw.starts_with('-');
    let (int_part, frac_part) = match body.split_once('.') {
        Some((i, f)) => (i, Some(f)),
        None => (body, None),
    };
    if !is_digits(int_part) {
        return None;
    }
    let mut frac9 = match frac_part {
        Some(f) if is_digits(f) => f.to_string(),
        Some(_) => return None,
        None => String::new(),
    };
    frac9.truncate(9);
    while frac9.len() < 9 {
        frac9.push('0');
    }
    // 位数多到 i128 都装不下 → 一定是越界的大数，交给调用方按「超范围」处理
    let int_val = int_part.parse::<i128>().unwrap_or(i128::MAX);
    Some((negative, int_val, frac9.parse().ok()?))
}

/// 去掉前导零后的整数位数 —— 用来判断时间戳的单位。
///
/// 用「有效位数」而不是「字符串长度」，免得 `0000001681333824000` 这种
/// 补了零的写法被误判成微秒。
fn significant_digits(raw: &str) -> usize {
    let body = raw.strip_prefix(['+', '-']).unwrap_or(raw);
    let int_part = body.split('.').next().unwrap_or("");
    int_part.trim_start_matches('0').len()
}

/// 接受 `[+-]?数字[.数字]`，不接受 `1e5`/`Infinity` 这类 Rust 也会收、但用户不会写的写法。
fn number(raw: &str) -> Option<f64> {
    let body = raw.strip_prefix(['+', '-']).unwrap_or(raw);
    let (int, frac) = match body.split_once('.') {
        Some((i, f)) => (i, Some(f)),
        None => (body, None),
    };
    if !is_digits(int) {
        return None;
    }
    if let Some(f) = frac {
        if !is_digits(f) {
            return None;
        }
    }
    raw.parse::<f64>().ok().filter(|v| v.is_finite())
}

fn is_digits(s: &str) -> bool {
    !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit())
}

/// ASCII 数字串转 i32；非数字或溢出都返回 `None`（`parse` 自己会处理溢出）。
fn atoi(s: &str) -> Option<i32> {
    if is_digits(s) {
        s.parse().ok()
    } else {
        None
    }
}

/// 同上，但给 chrono 那些要 `u32` 的参数（月份、日期、序数日、星期、ISO 周）。
/// 「999999999999」这种超长串会在这里溢出成 `None`，不会变成一个巨大的 u32。
fn atou(s: &str) -> Option<u32> {
    if is_digits(s) {
        s.parse().ok()
    } else {
        None
    }
}

/// ISO 8601（含 RFC 3339 / ISO 9075 / 各种基本格式与星期、序数日期）。
///
/// 自己按字节切而不是交给 chrono's `parse_from_str`，是因为后者的 `%m`/`%d` 会
/// 收 `2022-1-1` 这种非补零写法，自动识别就会认成参考实现认不出的东西。
///
/// `tz` 只在输入**没有自带偏移量**时有意义：此时按「本地时间」解释，
/// 优先落到用户指定的时区（参考实现是落到浏览器本地时区，服务端只能用 UTC 顶替）。
fn parse_iso8601(raw: &str, tz: Option<&Tz>) -> Option<DateTime<FixedOffset>> {
    let s = raw.trim();
    if s.is_empty() || !s.is_ascii() {
        return None;
    }

    // 找日期与时间的分隔符；只有它后面的 '+'/'-' 才是时区偏移 ——
    // 否则 `2022-01-01` 里那个 '-' 会被当成 -00:01。
    let sep = s.find(['T', 't', ' ']);
    let (body, offset) = match s.strip_suffix('Z').or_else(|| s.strip_suffix('z')) {
        Some(head) => (head, Some(FixedOffset::east_opt(0)?)),
        None => match sep.and_then(|i| s[i + 1..].rfind(['+', '-'])) {
            Some(p) => {
                let at = p + sep.unwrap_or(0) + 1;
                let (head, tail) = s.split_at(at);
                (head, Some(parse_offset(tail)?))
            }
            None => (s, None),
        },
    };
    let (date_part, time_part) = match body.find(['T', 't', ' ']) {
        Some(i) => (&body[..i], Some(&body[i + 1..])),
        None => (body, None),
    };

    let date = parse_iso_date(date_part)?;
    let (hour, min, sec, nano) = match time_part {
        Some(t) => parse_iso_time(t)?,
        None => (0, 0, 0, 0),
    };
    // ISO 允许用 24:00:00 表示「第二天的零点」。
    let (date, hour) = if hour == 24 {
        if min != 0 || sec != 0 || nano != 0 {
            return None;
        }
        (date.succ_opt()?, 0)
    } else {
        (date, hour)
    };
    let naive = date.and_hms_nano_opt(hour, min, sec, nano)?;

    match offset {
        Some(off) => at_offset(naive, off),
        None => Some(interpret_local(naive, tz)),
    }
}

/// 把「墙上时间 + 固定偏移」组装成 [`DateTime`]。
///
/// ⚠️ chrono 0.4.45 的 `DateTime` 内部存的是 **UTC**，`naive_local()` 才把偏移加回来；
/// 直接 `from_naive_utc_and_offset(naive, off)` 会多加一次偏移（写这个工具时踩过）。
fn at_offset(naive: NaiveDateTime, off: FixedOffset) -> Option<DateTime<FixedOffset>> {
    let utc_naive = naive.checked_sub_offset(off)?;
    Some(DateTime::from_naive_utc_and_offset(utc_naive, off))
}

/// 把一个不带偏移量的墙上时间落到真实时刻上。
///
/// 夏令时的「重复时段」（1:30 出现两次）取较早的那个，「不存在的时段」（春令时跳过
/// 2:00~3:00）退回 UTC —— 因为那个时刻压根没有对应瞬间，与其编一个不如老实说。
fn interpret_local(naive: NaiveDateTime, tz: Option<&Tz>) -> DateTime<FixedOffset> {
    match tz.and_then(|t| t.from_local_datetime(&naive).earliest()) {
        Some(dt) => dt.fixed_offset(),
        None => naive.and_utc().fixed_offset(),
    }
}

fn parse_offset(s: &str) -> Option<FixedOffset> {
    let (sign, digits) = match s.as_bytes().first() {
        Some(b'+') => (1, &s[1..]),
        Some(b'-') => (-1, &s[1..]),
        _ => return None,
    };
    let (h, m) = match digits.len() {
        2 => (digits, ""),
        4 => (&digits[..2], &digits[2..]),
        5 if digits.as_bytes()[2] == b':' => (&digits[..2], &digits[3..]),
        _ => return None,
    };
    let (hour, min) = (atoi(h)?, if m.is_empty() { 0 } else { atoi(m)? });
    if !(0..=23).contains(&hour) || !(0..=59).contains(&min) {
        return None;
    }
    FixedOffset::east_opt(sign * (hour * 3600 + min * 60))
}

/// 与参考实现的一处差异：**不接受的越界日期**。
///
/// 底下全用 `from_ymd_opt` / `from_yo_opt`，它们对 `2023-02-30`、`2023-13-01`
/// 这类输入返回 `None` —— 于是这里报「无法识别」，而 JS 的 `new Date("2023-02-30")`
/// 会**静默滚到 2023-03-02**（实测确认）。选择报错而不是滚进三月，是因为
/// 「日期写错」远比「工具偷偷改了我的日期」更难排查，而且滚进之后本工具自己的
/// 往返也对不上（输入 2023-02-30、输出 2023-03-02）。与 [`parse_rfc7231`]
/// 校验星期/月份名是同一个取舍。
fn parse_iso_date(d: &str) -> Option<NaiveDate> {
    if let Some(date) = parse_week_date(d) {
        return Some(date);
    }
    // 基本格式：YYYYMMDD、序数日期 YYYYDDD、只有年份 YYYY
    if is_digits(d) {
        return match d.len() {
            8 => NaiveDate::from_ymd_opt(atoi(&d[..4])?, atou(&d[4..6])?, atou(&d[6..8])?),
            7 => NaiveDate::from_yo_opt(atoi(&d[..4])?, atou(&d[4..7])?),
            4 => NaiveDate::from_ymd_opt(atoi(d)?, 1, 1),
            _ => None,
        };
    }
    let parts: Vec<&str> = d.split('-').collect();
    match parts[..] {
        [y] if y.len() == 4 => NaiveDate::from_ymd_opt(atoi(y)?, 1, 1),
        [y, a] if y.len() == 4 => {
            let year = atoi(y)?;
            match a.len() {
                // 序数日期 `2022-100` 与年月 `2022-10` 只能靠位数区分
                3 => NaiveDate::from_yo_opt(year, atou(a)?),
                2 => NaiveDate::from_ymd_opt(year, atou(a)?, 1),
                _ => None,
            }
        }
        [y, m, day] if y.len() == 4 && m.len() == 2 && day.len() == 2 => {
            NaiveDate::from_ymd_opt(atoi(y)?, atou(m)?, atou(day)?)
        }
        _ => None,
    }
}

/// 星期日期：`2021-W01`、`2021-W01-2`、`2021W01`、`2021W012`。
fn parse_week_date(d: &str) -> Option<NaiveDate> {
    let wi = d.find(['W', 'w'])?;
    let (year, rest) = d.split_at(wi);
    // 扩展格式在 W 前面还带一个分隔符：`2021-W01`，切出来是 "2021-"
    let year = year.strip_suffix('-').unwrap_or(year);
    if year.len() != 4 {
        return None;
    }
    let rest = &rest[1..];
    let (week, day) = match rest.len() {
        2 => (&rest[..2], ""),
        3 => (&rest[..2], &rest[2..]),
        4 if rest.as_bytes()[2] == b'-' => (&rest[..2], &rest[3..]),
        _ => return None,
    };
    let iso_day = if day.is_empty() { 1 } else { atou(day)? };
    if !(1..=7).contains(&iso_day) {
        return None;
    }
    // ISO 的星期几是「周一 = 1」，chrono 的 `Weekday::try_from` 是「周一 = 0」
    let weekday = Weekday::try_from(u8::try_from(iso_day).ok()? - 1).ok()?;
    NaiveDate::from_isoywd_opt(atoi(year)?, atou(week)?, weekday)
}

fn parse_iso_time(t: &str) -> Option<(u32, u32, u32, u32)> {
    if !t.is_ascii() {
        return None;
    }
    // 小数秒用 '.' 或 ',' 开头都行（ISO 两者都允许），最多 9 位
    let (hms, frac) = match t.find(['.', ',']) {
        Some(i) => (&t[..i], Some(&t[i + 1..])),
        None => (t, None),
    };
    let nanos = match frac {
        Some(f) if f.len() <= 9 => {
            let v = atoi(f)? as u32;
            v * 10u32.pow(9 - f.len() as u32)
        }
        Some(_) => return None,
        None => 0,
    };

    let (h, m, s) = match hms.len() {
        2 if is_digits(hms) => (atoi(hms)?, 0, 0),
        4 if is_digits(hms) => (atoi(&hms[..2])?, atoi(&hms[2..])?, 0),
        5 if is_digits(&hms[..2]) && hms.as_bytes()[2] == b':' && is_digits(&hms[3..]) => {
            (atoi(&hms[..2])?, atoi(&hms[3..])?, 0)
        }
        6 if is_digits(hms) => (atoi(&hms[..2])?, atoi(&hms[2..4])?, atoi(&hms[4..])?),
        8 if is_digits(&hms[..2])
            && hms.as_bytes()[2] == b':'
            && is_digits(&hms[3..5])
            && hms.as_bytes()[5] == b':'
            && is_digits(&hms[6..]) =>
        {
            (atoi(&hms[..2])?, atoi(&hms[3..5])?, atoi(&hms[6..])?)
        }
        _ => return None,
    };
    // 秒的 60（闰秒）和分/时的越界都直接拒掉，交给下一层报错
    if !(0..=24).contains(&h) || !(0..=59).contains(&m) || !(0..59).contains(&s) {
        return None;
    }
    Some((h as u32, m as u32, s as u32, nanos))
}

const WEEKDAYS: [&str; 7] = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS: [&str; 12] = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/// RFC 7231 / HTTP-date，同时也是 JS `Date.prototype.toUTCString()` 的形状：
/// `Sun, 06 Nov 1994 08:49:37 GMT`。参考实现的正则只查形状不查月份是否合法，
/// 这里顺手把星期/月份名校验掉，免得 `Foo, 06 Zzz 1994 …` 报一个语焉不详的错。
fn parse_rfc7231(raw: &str) -> Result<DateTime<FixedOffset>, ToolError> {
    let s = raw.trim();
    let bad = || ToolError::invalid("out.date-converter.err.not_rfc7231", &[("value", s)]);
    let (weekday, rest) = s.split_once(", ").ok_or_else(bad)?;
    if !WEEKDAYS.contains(&weekday) {
        return Err(bad());
    }
    let fields: Vec<&str> = rest.split(' ').collect();
    if fields.len() != 5 || fields[4] != "GMT" {
        return Err(bad());
    }
    let month = MONTHS
        .iter()
        .position(|m| *m == fields[1])
        .ok_or_else(bad)? as u32
        + 1;
    let day = atoi(fields[0]).ok_or_else(bad)?;
    let year = atoi(fields[2]).ok_or_else(bad)?;
    let time = parse_iso_time(fields[3]).ok_or_else(bad)?;
    let naive = NaiveDate::from_ymd_opt(year, month, day as u32)
        .ok_or_else(bad)?
        .and_hms_nano_opt(time.0, time.1, time.2, time.3)
        .ok_or_else(bad)?;
    at_offset(naive, Utc.fix()).ok_or_else(bad)
}

// ------------------------------------------------------------------ 输出

/// ISO 8601 与 RFC 3339 的输出一致（参考实现里两项输出也完全相同）：
/// 零点偏移写成 `Z`，否则 `±HH:MM`。
///
/// 小数秒最多到**毫秒**（3 位），整秒时不写。
///
/// 为什么截到毫秒就够：JavaScript 的 `Date` 只到毫秒，参考实现（date-fns 的
/// `formatISO` / `formatRFC3339`）干脆连毫秒都不写 —— `2026-10-25T20:19:21+08:00`。
/// 我们保留毫秒，输入带毫秒时这一行能原样喂回去，往返不丢信息；
/// 再往下的纳秒（`...26.546457248+08:00`）在页面上就是一串噪声，
/// 而且没有任何 JS 侧的格式能显示它。
fn iso_like(dt: &DateTime<FixedOffset>) -> String {
    let head = format!("{}{}", dt.format("%Y-%m-%dT%H:%M:%S"), frac_millis(dt));
    if dt.offset().local_minus_utc() == 0 {
        format!("{head}Z")
    } else {
        format!("{head}{}", offset_label(dt.offset().local_minus_utc()))
    }
}

/// ISO 9075：日期与时间之间是空格，没有偏移量（参考实现也一样）。
fn iso9075_like(dt: &DateTime<FixedOffset>) -> String {
    format!("{}{}", dt.format("%Y-%m-%d %H:%M:%S"), frac_millis(dt))
}

/// 小数秒：最多 3 位（毫秒），整秒时返回空串。
///
/// 用 `timestamp_subsec_millis()` 而不是 `%.f`：后者会按纳秒的实际位数
/// 输出 3/6/9 位（`.123456789`），页面上拖着一长串小数；
/// 而毫秒正好是 JavaScript `Date` 的精度上限。
fn frac_millis<Tz: TimeZone>(dt: &DateTime<Tz>) -> String {
    let ms = dt.timestamp_subsec_millis();
    if ms == 0 {
        String::new()
    } else {
        format!(".{ms:03}")
    }
}

/// 机器可读的时刻（`meta.utc`）：UTC，跟 `iso_like` 一样只到毫秒。
///
/// 毫秒够用了：浏览器那边 `new Date(...)` 最多解析到毫秒，
/// 再往下的纳秒既显示不出来，也只会让下游解析器多一层负担。
fn iso_instant(dt: &DateTime<Utc>) -> String {
    format!("{}{}Z", dt.format("%Y-%m-%dT%H:%M:%S"), frac_millis(dt))
}

/// `+08:00` / `-04:30` / `+00:00`。手写而不是用 `%:z`，是为了在没有具体时刻的
/// 情况下也能只凭偏移秒数格式化（meta 里的 `utcOffset` 就是这么来的）。
fn offset_label(secs: i32) -> String {
    let (sign, abs) = if secs < 0 { ('-', -secs) } else { ('+', secs) };
    format!("{sign}{:02}:{:02}", abs / 3600, (abs % 3600) / 60)
}

/// Mongo ObjectID 的前 4 字节是大端序的「Unix 秒」，后面 8 字节是计数器、
/// 最后 4 字节随机，这里全补 0（参考实现也这么干）。
///
/// 与参考实现的一处差异：**前 8 位补零到满宽**（`{:08x}`）。参考实现写的是
/// `${Math.floor(ms/1000).toString(16)}0000000000000000`，而 `toString(16)`
/// **不补零** —— 于是时间戳不足 8 位十六进制时它输出的根本不是 24 位：
/// `25569`（Excel 序列号 25569 = 1970-01-01T07:06:09Z）会变成 20 位的
/// `63e10000000000000000`，而且再也喂不回来（ObjectID 的解析只认 24 位）。
/// 1970-01-01 之前到 1978-08 中旬之间的时刻都落在这个坑里。
/// `{:08x}` 补齐后本工具的输出是合法 ObjectID，往返也对得上
/// （`000063e10000000000000000` → 1970-01-01T07:06:09Z）。
///
/// 代价要说清楚：ObjectID 的时间戳字段只有 4 字节**无符号**，能表示的只有
/// [1970, 2106) 的整秒。所以 ①亚秒精度必然丢失（`Date` 字段按整秒存），
/// ②1970 年之前的时刻会按 u32 环回，还原不回来。这里选择环回而不是像参考实现那样
/// 输出一个长度不对的字符串（负数会带 `-` 号，长度就不是 24 了）。
fn mongo_objectid(secs: i64) -> String {
    format!("{:08x}{}", secs as u32, "0".repeat(16))
}

/// Excel 序列号 = 自 1899-12-30 起的天数（小数部分是一天里的小时数）。
///
/// 直接拿毫秒除（而不是先取整秒）——小数的部分是当天的时间点，抹掉就等于把
/// 「09:26:06.421」写成「09:26:06.000」。毫秒值在 ±2.5e14 以内，f64 能精确表示，
/// 所以这里的舍入行为与 JS 的 `date.getTime() / 86400000 + 25569` 完全一致。
fn excel_serial(millis: i64) -> String {
    js_number(millis as f64 / 86_400_000.0 + EXCEL_EPOCH_OFFSET_DAYS)
}

/// 复刻 JS 的 `Number` → `String`：能唯一还原的最短十进制表示。
/// 与 Rust `{}` 的唯一区别是我们显式走整数分支，保证 `1970-01-01` 输出 `25569`
/// 而不是 `25569.0`。
fn js_number(v: f64) -> String {
    if v.fract() == 0.0 && v.abs() < 9.0e15 {
        format!("{}", v as i64)
    } else {
        format!("{v}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(payload: Value) -> Value {
        compute(payload).expect("不应该失败")
    }

    fn table(v: &Value, label: &str) -> String {
        v["table"][label].as_str().expect("表格项").to_string()
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

    /// 参考实现 e2e 的那组期望值：输入 `2023-04-12T23:10:24+02:00`。
    const E2E: [(&str, &str); 9] = [
        ("ISO 8601", "2023-04-12T23:10:24+02:00"),
        ("ISO 9075", "2023-04-12 23:10:24"),
        ("RFC 3339", "2023-04-12T23:10:24+02:00"),
        ("RFC 7231", "Wed, 12 Apr 2023 21:10:24 GMT"),
        ("Unix timestamp (seconds)", "1681333824"),
        ("Timestamp (milliseconds)", "1681333824000"),
        ("UTC format", "Wed, 12 Apr 2023 21:10:24 GMT"),
        ("Mongo ObjectID", "64371e400000000000000000"),
        ("Excel date/time", "45028.88222222222"),
    ];

    #[test]
    fn every_format_matches_the_reference_for_one_instant() {
        let out = run(json!({ "date": "2023-04-12T23:10:24+02:00" }));
        for (label, expected) in E2E {
            assert_eq!(table(&out, label), expected, "格式 {label}");
        }
    }

    #[test]
    fn output_is_the_selected_format_and_defaults_to_iso8601() {
        let auto = run(json!({ "date": "2023-04-12T23:10:24+02:00", "format": "auto" }));
        assert_eq!(auto["output"], "2023-04-12T23:10:24+02:00");
        let picked = run(json!({ "date": "45028.88222222222", "format": "excel" }));
        assert_eq!(picked["output"], "45028.88222222222");
    }

    /// `rows` 是「一行一个格式」那种界面用的：顺序必须是常见顺序，不是字母序。
    ///
    /// `table` 是无序映射（键 = 格式名），JSON 序列化后按字母序排；
    /// `rows` 是数组，顺序写死在代码里 —— 少了 ISO 8601、多了 Excel 都不行。
    #[test]
    fn rows_keep_the_usual_order_and_carry_the_same_values() {
        let out = run(json!({ "date": "2023-04-12T23:10:24+02:00" }));
        let rows = out["rows"].as_array().expect("rows 应当是数组");
        let keys: Vec<&str> = rows
            .iter()
            .map(|r| r["key"].as_str().expect("key"))
            .collect();
        assert_eq!(
            keys,
            vec![
                "iso8601",
                "iso9075",
                "rfc3339",
                "rfc7231",
                "unix",
                "timestamp",
                "utc",
                "mongo-objectid",
                "excel",
            ],
            "rows 的顺序不对"
        );
        // 每一行的值必须和 table 里同名的那一项一致 —— 两份数据不能各说各话。
        for row in rows {
            let label = row["label"].as_str().expect("label");
            assert_eq!(
                row["value"],
                table(&out, label),
                "rows 与 table 的值对不上：{label}"
            );
        }
    }

    /// 把格式 X 的输出再喂给格式 X，必须还是同一个瞬间（毫秒时间戳相等）。
    ///
    /// 基准时刻特意选 UTC + 整秒：ISO 9075 的输出里没有偏移量（与参考实现一致），
    /// 非 UTC 时它表示的是「目标时区的墙上时间」；RFC 7231 / Mongo ObjectID 的
    /// 时间戳字段本来也只有秒级精度。亚秒精度的部分由下面单独的用例覆盖。
    #[test]
    fn each_format_round_trips_through_itself() {
        let source = run(json!({ "date": "2023-04-12T21:10:24Z" }));
        let keys = [
            "iso8601",
            "iso9075",
            "rfc3339",
            "rfc7231",
            "unix",
            "timestamp",
            "utc",
            "mongo-objectid",
            "excel",
        ];
        for key in keys {
            let label = Format::from_key(key).unwrap().label();
            let text = table(&source, label);
            let back = run(json!({ "date": text, "format": key }));
            // ObjectID 只存整秒；Excel 是 f64，往返误差最多 1 毫秒
            let (a, b) = (
                table(&source, "Timestamp (milliseconds)"),
                table(&back, "Timestamp (milliseconds)"),
            );
            let (a, b) = (a.parse::<i64>().unwrap(), b.parse::<i64>().unwrap());
            let slack = if key == "excel" { 1 } else { 0 };
            assert!(
                (a - b).abs() <= slack,
                "格式 {key}（{text}）往返后时刻不一致：{a} vs {b}"
            );
        }
    }

    #[test]
    fn cross_format_round_trip_shares_one_instant() {
        // 每种格式的输出都能被任意另一种格式的解析器读回同一瞬间
        let source = run(json!({ "date": "1681333824", "format": "unix" }));
        let instant = table(&source, "Timestamp (milliseconds)");
        for key in [
            "iso8601",
            "rfc3339",
            "rfc7231",
            "utc",
            "mongo-objectid",
            "excel",
            "timestamp",
        ] {
            let text = table(&source, Format::from_key(key).unwrap().label());
            let back = run(json!({ "date": text, "format": key }));
            assert_eq!(
                table(&back, "Timestamp (milliseconds)"),
                instant,
                "经由 {key}"
            );
        }
    }

    #[test]
    fn auto_detect_reports_which_format_it_picked() {
        let cases = [
            ("2023-04-12T23:10:24+02:00", "iso8601"),
            ("Wed, 12 Apr 2023 21:10:24 GMT", "rfc7231"),
            ("64371e400000000000000000", "mongo-objectid"),
            ("1681333824", "unix"),
            ("1681333824000", "timestamp"),
            ("45028.88222222222", "excel"),
            ("-1000", "excel"),
        ];
        for (input, expected) in cases {
            let out = run(json!({ "date": input, "format": "auto" }));
            assert_eq!(out["meta"]["detectedFormat"], expected, "输入 {input}");
        }
    }

    #[test]
    fn date_only_string_is_midnight() {
        let out = run(json!({ "date": "2022-01-01", "format": "iso8601" }));
        assert_eq!(table(&out, "Timestamp (milliseconds)"), "1640995200000");
        assert_eq!(table(&out, "ISO 8601"), "2022-01-01T00:00:00Z");
        // 没有偏移量时按 UTC 解释（服务端没有「本地时区」这个概念）
        assert_eq!(out["meta"]["utcOffset"], "+00:00");
    }

    #[test]
    fn unix_and_milli_inputs() {
        let secs = run(json!({ "date": "1681333824" }));
        assert_eq!(table(&secs, "ISO 8601"), "2023-04-12T21:10:24Z");
        let millis = run(json!({ "date": "1681333824000" }));
        assert_eq!(table(&millis, "ISO 8601"), "2023-04-12T21:10:24Z");
    }

    #[test]
    fn negative_and_fractional_timestamps() {
        // 1970 之前：显式选 unix 才不会被当成 Excel 序列号
        let out = run(json!({ "date": "-1", "format": "unix" }));
        assert_eq!(table(&out, "ISO 8601"), "1969-12-31T23:59:59Z");
        assert_eq!(table(&out, "Timestamp (milliseconds)"), "-1000");
        let frac = run(json!({ "date": "-0.5", "format": "unix" }));
        assert_eq!(table(&frac, "Timestamp (milliseconds)"), "-500");
        let millis = run(json!({ "date": "-1500", "format": "timestamp" }));
        // 毫秒要留住：ISO 8601 那一行写到毫秒（参考实现连毫秒都不写），
        // 负数这边是向前取整的，-1500ms = 1969-12-31T23:59:58.500Z。
        assert_eq!(table(&millis, "ISO 8601"), "1969-12-31T23:59:58.500Z");
        assert_eq!(table(&millis, "Timestamp (milliseconds)"), "-1500");
        // 自动识别按形状分派：负数落到 Excel（与参考实现一致），也就是「1899-12-30 前一天」
        let auto = run(json!({ "date": "-1" }));
        assert_eq!(auto["meta"]["detectedFormat"], "excel");
        assert_eq!(table(&auto, "ISO 8601"), "1899-12-29T00:00:00Z");
    }

    #[test]
    fn dst_boundary_uses_the_offset_of_that_instant() {
        // 纽约 2023-11-05 06:00Z 结束夏令时：01:30 这一天出现两次，偏移不同
        let before = run(json!({ "date": "2023-11-05T05:30:00Z", "timezone": "America/New_York" }));
        assert_eq!(before["meta"]["utcOffset"], "-04:00");
        assert_eq!(table(&before, "ISO 8601"), "2023-11-05T01:30:00-04:00");
        let after = run(json!({ "date": "2023-11-05T06:30:00Z", "timezone": "America/New_York" }));
        assert_eq!(after["meta"]["utcOffset"], "-05:00");
        assert_eq!(table(&after, "ISO 8601"), "2023-11-05T01:30:00-05:00");
        // 但两者是同一族的时刻，unix/毫秒不受时区影响
        assert_eq!(table(&before, "Unix timestamp (seconds)"), "1699162200");
        assert_eq!(table(&after, "Unix timestamp (seconds)"), "1699165800");
    }

    #[test]
    fn timezone_moves_only_the_human_readable_formats() {
        let out = run(json!({ "date": "2023-04-12T23:10:24+02:00", "timezone": "Asia/Shanghai" }));
        assert_eq!(out["meta"]["timezone"], "Asia/Shanghai");
        assert_eq!(out["meta"]["utcOffset"], "+08:00");
        assert_eq!(table(&out, "ISO 8601"), "2023-04-13T05:10:24+08:00");
        assert_eq!(table(&out, "ISO 9075"), "2023-04-13 05:10:24");
        // 时刻类格式一个都不能变
        assert_eq!(table(&out, "Unix timestamp (seconds)"), "1681333824");
        assert_eq!(table(&out, "Timestamp (milliseconds)"), "1681333824000");
        assert_eq!(table(&out, "Mongo ObjectID"), "64371e400000000000000000");
        assert_eq!(table(&out, "Excel date/time"), "45028.88222222222");
        // RFC 7231 结尾写死了 GMT，永远是 UTC
        assert_eq!(table(&out, "RFC 7231"), "Wed, 12 Apr 2023 21:10:24 GMT");
        // meta.utc 是机器可读的时刻：ISO 8601，写到毫秒（整秒时不带小数）
        assert_eq!(out["meta"]["utc"], "2023-04-12T21:10:24Z");
    }

    #[test]
    fn offset_less_input_is_read_in_the_target_timezone() {
        let out = run(json!({ "date": "2023-04-12 23:10:24", "timezone": "Asia/Shanghai" }));
        assert_eq!(table(&out, "ISO 8601"), "2023-04-12T23:10:24+08:00");
        assert_eq!(table(&out, "Timestamp (milliseconds)"), "1681312224000");
    }

    #[test]
    fn unknown_timezone_is_reported_not_swallowed() {
        let err = compute(json!({ "date": "1681333824", "timezone": "Mars/Phobos" })).unwrap_err();
        assert_eq!(
            err_key(&err),
            "out.date-converter.err.unknown_timezone",
            "{err:?}"
        );
        // 时区名是用户自己输的，回显出来才用得上手
        assert_eq!(err_arg(&err, "timezone"), "Mars/Phobos");
        // 大小写敏感也要成立：chrono-tz 的名字是精确匹配
        assert!(compute(json!({ "date": "1", "timezone": "asia/shanghai" })).is_err());
    }

    #[test]
    fn empty_and_garbage_input_are_rejected() {
        // 空输入 = 「现在」（参考实现打开页面就显示当前时刻），不是错误。
        let now = compute(json!({ "date": "" })).expect("空输入应当按当前时刻算");
        assert_eq!(
            now["meta"]["detectedFormat"],
            json!("now"),
            "空输入没有「按哪种格式解析」，记成 now"
        );
        // 只有空格不算空 —— 参考实现里它是 Invalid Date。
        assert!(compute(json!({ "date": "   " })).is_err());
        assert!(compute(json!({})).is_ok());
        let err = compute(json!({ "date": "not a date" })).unwrap_err();
        assert_eq!(
            err_key(&err),
            "out.date-converter.err.unrecognized_date",
            "{err:?}"
        );
        assert_eq!(err_arg(&err, "value"), "not a date");
        assert!(compute(json!({ "date": "2022-13-45" })).is_err());
        assert!(compute(json!({ "date": "1681333824", "format": "nope" })).is_err());
        // 超出 chrono / 年份上限的都走报错，不做饱和处理
        assert!(compute(json!({ "date": "99999999999999999999", "format": "unix" })).is_err());
        assert!(compute(json!({ "date": "99999999999999999", "format": "timestamp" })).is_err());
        // 12 位毫秒 = 2001 年，合法
        assert!(compute(json!({ "date": "999999999999", "format": "timestamp" })).is_ok());
        // 年份超过 9999 也要报错（Excel 序列号/ObjectID 都表达不了）
        assert!(compute(json!({ "date": "300000", "format": "excel" })).is_ok());
        assert!(compute(json!({ "date": "4000000", "format": "excel" })).is_err());
    }

    #[test]
    fn excel_vectors_from_the_reference_unit_tests() {
        let cases = [
            ("2016-05-20T00:00:00.000Z", "42510"),
            ("2016-05-20T12:00:00.000Z", "42510.5"),
            ("2023-10-31T09:26:06.421Z", "45230.39312987268"),
            ("1970-01-01T00:00:00.000Z", "25569"),
            ("1800-01-01T00:00:00.000Z", "-36522"),
        ];
        for (input, expected) in cases {
            let out = run(json!({ "date": input, "format": "iso8601" }));
            assert_eq!(table(&out, "Excel date/time"), expected, "输入 {input}");
        }
    }

    #[test]
    fn excel_input_vectors_from_the_reference_unit_tests() {
        let cases = [
            ("0", "1899-12-30T00:00:00Z"),
            ("1", "1899-12-31T00:00:00Z"),
            ("2", "1900-01-01T00:00:00Z"),
            ("4242.4242", "1911-08-12T10:10:50.880Z"),
            ("42738.22626859954", "2017-01-03T05:25:49.607Z"),
            ("-1000", "1897-04-04T00:00:00Z"),
        ];
        for (input, expected) in cases {
            let out = run(json!({ "date": input, "format": "excel" }));
            assert_eq!(table(&out, "ISO 8601"), expected, "输入 {input}");
        }
    }

    #[test]
    fn iso8601_shapes() {
        let cases = [
            // 全零的小数秒不写出来（和参考实现在 23:10:24 上不带小数一致）
            ("2021-01-01T00:00:00.000Z", "2021-01-01T00:00:00Z"),
            // 输入自带偏移量时输出保留它（date-fns formatISO 也是这个行为）
            ("20230412T145600Z", "2023-04-12T14:56:00Z"),
            ("20230412T145600+0100", "2023-04-12T14:56:00+01:00"),
            ("2023-04-12", "2023-04-12T00:00:00Z"),
            ("2023-04", "2023-04-01T00:00:00Z"),
            ("2023104", "2023-04-14T00:00:00Z"),
            ("2021-W01", "2021-01-04T00:00:00Z"),
            ("2021-W01-2", "2021-01-05T00:00:00Z"),
            ("2021W012", "2021-01-05T00:00:00Z"),
            ("2023-04-12T24:00:00", "2023-04-13T00:00:00Z"),
            (
                // 纳秒只到毫秒：JS 的 Date 就是这个精度，
                // 页面上的 ISO 8601 也就写到毫秒（参考实现连毫秒都不写）。
                "2023-04-12T23:10:24.123456789Z",
                "2023-04-12T23:10:24.123Z",
            ),
        ];
        for (input, expected) in cases {
            let out = run(json!({ "date": input, "format": "iso8601" }));
            assert_eq!(table(&out, "ISO 8601"), expected, "输入 {input}");
        }
    }

    #[test]
    fn rfc7231_input() {
        let out = run(json!({ "date": "Sun, 06 Nov 1994 08:49:37 GMT" }));
        assert_eq!(out["meta"]["detectedFormat"], "rfc7231");
        assert_eq!(table(&out, "Timestamp (milliseconds)"), "784111777000");
        assert!(
            compute(json!({ "date": "06 Nov 1994 08:49:37 GMT", "format": "rfc7231" })).is_err()
        );
        assert!(
            compute(json!({ "date": "Sun, 06 Zzz 1994 08:49:37 GMT", "format": "rfc7231" }))
                .is_err()
        );
    }

    #[test]
    fn mongo_object_id_keeps_the_24_hex_shape_before_1970() {
        // ObjectID 只有 4 字节无符号秒，1970 之前只能环回（参考实现会输出 -1 那种
        // 长度不对的字符串）。这里至少保证还是 24 位十六进制。
        let out = run(json!({ "date": "-1", "format": "unix" }));
        let oid = table(&out, "Mongo ObjectID");
        assert_eq!(oid.len(), 24);
        assert!(oid.bytes().all(|b| b.is_ascii_hexdigit()));
        assert_eq!(oid, "ffffffff0000000000000000");
    }

    #[test]
    fn mongo_object_id_zero_pads_the_timestamp_field() {
        // 上一条测的是 1970 之前（环回成 ffffffff，凑巧已经是 8 位，补不补看不出来）。
        // 这里测**位数不够**的那种：25569 秒的十六进制只有 4 位，不补零的话
        // 输出只有 20 位、而且喂不回来。参考实现在这个区间（1970-01 ~ 1978-08）
        // 输出的 ObjectID 全是坏的。
        let oid = table(
            &run(json!({ "date": "25569", "format": "unix" })),
            "Mongo ObjectID",
        );
        assert_eq!(oid, "000063e10000000000000000");
        assert_eq!(oid.len(), 24);

        // 往返：把刚生成的串再喂回去，必须还原成同一个瞬时
        let back = run(json!({ "date": oid, "format": "mongo-objectid" }));
        assert_eq!(back["meta"]["utc"], "1970-01-01T07:06:09Z");

        // 边界两侧各看一眼，确认补的是零而不是别的
        assert_eq!(mongo_objectid(0), "000000000000000000000000");
        assert_eq!(mongo_objectid(0x63E1), "000063e10000000000000000");
        assert_eq!(mongo_objectid(0x1234_5678), "123456780000000000000000");
    }

    #[test]
    fn out_of_range_calendar_dates_are_rejected_not_rolled_over() {
        // JS 的 new Date("2023-02-30") 会静默滚到 2023-03-02；这里报错。
        // 理由见 parse_iso_date 的注释。
        assert!(compute(json!({ "date": "2023-02-30" })).is_err());
        assert!(compute(json!({ "date": "2023-13-01", "format": "iso8601" })).is_err());
        assert!(compute(json!({ "date": "2023-04-31", "format": "iso8601" })).is_err());
        // 合法的那一天照常能用，别把这个用例写过头了
        assert!(compute(json!({ "date": "2024-02-29", "format": "iso8601" })).is_ok());
    }

    #[test]
    fn sub_second_precision_is_kept_where_it_fits() {
        let out = run(json!({ "date": "2023-04-12T23:10:24.5+02:00" }));
        assert_eq!(table(&out, "ISO 8601"), "2023-04-12T23:10:24.500+02:00");
        assert_eq!(table(&out, "Timestamp (milliseconds)"), "1681333824500");
    }

    /// 毫秒时间戳的小数部分必须**精确**到毫秒。
    ///
    /// 曾经的 bug：`1701227351995 / 1000.0` 在 f64 里是 `1701227351.9949998865127563…`，
    /// 小数部分再乘 1e9 取整就成了 994999886 纳秒 —— 差 114 纳秒。
    /// 错得很轻，但「时间戳差一点点」是最难排查的一类问题。
    #[test]
    fn millisecond_timestamps_keep_exact_milliseconds() {
        let out = run(json!({ "date": "1701227351995", "format": "timestamp" }));
        assert_eq!(table(&out, "ISO 8601"), "2023-11-29T03:09:11.995Z");
        assert_eq!(table(&out, "Timestamp (milliseconds)"), "1701227351995");
        // 自动识别也要走到同一套精确算法上
        let auto = run(json!({ "date": "1701227351995" }));
        assert_eq!(auto["meta"]["detectedFormat"], "timestamp");
        assert_eq!(table(&auto, "ISO 8601"), "2023-11-29T03:09:11.995Z");
    }

    /// 正好 16 位按**微秒**解释（上游 #1893 提的能力）。
    #[test]
    fn sixteen_digit_numbers_are_microsecond_timestamps() {
        let out = run(json!({ "date": "1701227351995845" }));
        assert_eq!(out["meta"]["detectedFormat"], "timestamp");
        // 微秒的尾巴显示不出来（显示只到毫秒），但毫秒必须是对的
        assert_eq!(table(&out, "ISO 8601"), "2023-11-29T03:09:11.995Z");
        assert_eq!(table(&out, "Timestamp (milliseconds)"), "1701227351995");
    }

    /// 14/15 位不认：按毫秒解释落在公元 2500 年前后，按微秒解释落在 1970 年，
    /// 两种都说不通 —— 与其给一个看着能用的错答案，不如明确报错。
    #[test]
    fn fourteen_and_fifteen_digit_numbers_are_not_guessed() {
        for input in ["17012273519958", "170122735199584"] {
            assert!(
                compute(json!({ "date": input })).is_err(),
                "输入 {input} 不该被自动识别"
            );
        }
    }

    /// 负的时间戳也要精确：`-1500` 毫秒 = 1969-12-31T23:59:58.500Z。
    #[test]
    fn negative_timestamps_stay_exact() {
        let out = run(json!({ "date": "-1500", "format": "timestamp" }));
        assert_eq!(table(&out, "ISO 8601"), "1969-12-31T23:59:58.500Z");
        assert_eq!(table(&out, "Timestamp (milliseconds)"), "-1500");
        // 微秒同理（16 位有效数字才按微秒解释）
        let us = run(json!({ "date": "-1500000000000001", "format": "timestamp" }));
        assert_eq!(table(&us, "ISO 8601"), "1922-06-20T21:19:59.999Z");
    }

    /// Unix 秒带小数时同样不能被 f64 截断。
    ///
    /// 纳秒的尾巴在显示里看不到（只到毫秒），但它**不能把毫秒带歪** ——
    /// 曾经的 bug 是 f64 的表示误差把 `.123456789` 算成了 `.123456666`，
    /// 差 123 纳秒；显示截到毫秒之后看不出来，但时刻本身仍然是错的
    /// （Excel 那一行的 f64 会带着这个偏差）。
    #[test]
    fn fractional_unix_seconds_keep_nanoseconds() {
        let out = run(json!({ "date": "1681333824.123456789", "format": "unix" }));
        assert_eq!(table(&out, "ISO 8601"), "2023-04-12T21:10:24.123Z");
        assert_eq!(table(&out, "Timestamp (milliseconds)"), "1681333824123");
        // 纳秒没有把毫秒带歪：与直接给毫秒的结果完全一致
        let ms = run(json!({ "date": "1681333824.123", "format": "unix" }));
        assert_eq!(table(&out, "Excel date/time"), table(&ms, "Excel date/time"));
    }

    #[test]
    fn utc_timezone_name_is_accepted() {
        let out = run(json!({ "date": "1681333824", "timezone": "UTC" }));
        assert_eq!(out["meta"]["utcOffset"], "+00:00");
        assert_eq!(table(&out, "ISO 8601"), "2023-04-12T21:10:24Z");
    }

    /// 错误信息也按请求语言渲染 —— 语言不是工具决定的，是 API 层调
    /// `localize` 时按请求语言渲染的。
    #[test]
    fn the_error_message_follows_the_requested_language() {
        let err = compute(json!({ "date": "1681333824", "timezone": "Mars/Phobos" })).unwrap_err();
        // 语言包里还没并进来时，localize 退回键本身 —— 这时断言跳过
        if !crate::i18n::has("zh-CN", "out.date-converter.err.unknown_timezone") {
            return;
        }
        let en = err.localize("en");
        let zh = err.localize("zh-CN");
        assert_ne!(en, zh, "两种语言不该是同一句");
        assert!(!en.contains("out.date-converter"), "英文界面不该露出键：{en}");
        // 用户自己填的时区名要回显出来
        assert!(en.contains("Mars/Phobos"), "{en}");
        assert!(zh.contains("Mars/Phobos"), "{zh}");
    }
}
