//! API handler 之间的公共零件：取字段、跑阻塞任务。
//!
//! 单独一个模块而不是让每个 handler 各写一份，是因为这些坑每个都会踩一遍：
//! - `Value` 里数字可能是 JSON number 也可能是表单过来的字符串（`app.js` 对
//!   `FieldKind::Number` 提交的是字符串），`as_u64()` 会对 `"30"` 返回 `None`；
//! - `select` 的默认值在注册表里给全了，但 `urlencoded` 提交时缺字段就是空串，
//!   空串要退回默认值而不是当成用户选了空算法；
//! - CPU 密集的工具不丢到 blocking 线程池会把 actix 的 worker 卡住。

use actix_web::web;
use serde_json::{Map, Value};

use super::{ToolError, ToolResult};

/// 请求语言在 payload 里的键名。
///
/// 由 `/api/tools/{endpoint}` 的 handler 塞进去 —— 工具实现自己拿不到
/// `HttpRequest`，读不到 `Accept-Language` 与 Cookie，只能靠这个键。
/// 键名带下划线前缀，跟用户填的字段名（注册表里都是小写连字符）不会撞。
pub const LANG_KEY: &str = "__lang";

/// 取当前请求的语言。
///
/// 没有这个键（单测直接调 `compute`、内部直接调 `handle`）时按英文兜底 ——
/// 英文是语言包的兜底语言，缺词时 [`crate::i18n::t`] 也会退回它。
pub fn lang(payload: &Value) -> &str {
    payload
        .get(LANG_KEY)
        .and_then(Value::as_str)
        .filter(|l| crate::i18n::is_available(l))
        .unwrap_or(crate::i18n::FALLBACK)
}

/// 往结果表里放一行，**键按当前语言取**。
///
/// `key` 是语言包里的键（`out.<slug>.<名字>`），不是给人看的字。
/// 文案全在语言包里，代码里只出现键 —— 这样加语言时不用再动 Rust 代码，
/// 而且 [`crate::i18n`] 的两个对账测试（键在用 / 键有人读）能把漏掉的文案揪出来。
///
/// 找不到就退回英文，再找不到就退回键本身（`i18n::t` 的行为）——
/// 于是一个漏翻的键在页面上是显眼的 `out.foo.bar`，而不是安静地少一行。
pub fn row(table: &mut Map<String, Value>, payload: &Value, key: &str, value: Value) {
    table.insert(crate::i18n::t(lang(payload), key), value);
}

/// [`row`] 的字符串值版本，省掉调用点的 `json!()` 噪音。
pub fn row_str(table: &mut Map<String, Value>, payload: &Value, key: &str, value: &str) {
    row(table, payload, key, Value::String(value.to_string()));
}

/// 取字符串字段；缺字段或不是字符串时给 `None`（空串算 `Some("")`，由调用方决定）。
pub fn opt_str<'a>(payload: &'a Value, name: &str) -> Option<&'a str> {
    payload.get(name).and_then(Value::as_str)
}

/// 取字符串字段，空串/缺字段一律退回 `default`。
///
/// 注册表里每个 `ApiField` 都带 `default`，表单一定会填上；但
/// `POST /api/tools/<x>` 是公开接口，手写请求可以什么都不给 —— 那时应该用默认值，
/// 不是报「缺少字段」。
pub fn str_or<'a>(payload: &'a Value, name: &str, default: &'a str) -> &'a str {
    opt_str(payload, name)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(default)
}

/// 取必填字符串字段。缺失或只有空白时报错而不是悄悄用空串。
pub fn req_str<'a>(payload: &'a Value, name: &str) -> Result<&'a str, ToolError> {
    match opt_str(payload, name) {
        Some(s) if !s.trim().is_empty() => Ok(s),
        // 文案在语言包里 —— 这条错误是给用户看的，英文界面下不能是中文。
        // `out.common.*` 是给跨工具共用的辅助函数留的（这里只此一条）。
        _ => Err(ToolError::invalid("out.common.missing_field", &[("field", name)])),
    }
}

/// 取整数，兼容 JSON number 与表单字符串。
pub fn opt_u64(payload: &Value, name: &str) -> Option<u64> {
    match payload.get(name) {
        Some(Value::Number(n)) => n.as_u64(),
        Some(Value::String(s)) => s.trim().parse().ok(),
        _ => None,
    }
}

/// 取整数并夹在 `[min, max]` 里，缺字段/解析失败用 `default`。
///
/// 夹取而不是报错：比如 RSA 的位长、bcrypt 的 cost，表单给的值只可能是注册表
/// 里那几个 select 选项之一（整数框则可能被手改成 0 或 10^12）。夹取能让异常输入
/// 落到「仍然是个合理值」而不是 500。
pub fn bounded_u64(payload: &Value, name: &str, default: u64, min: u64, max: u64) -> u64 {
    opt_u64(payload, name).unwrap_or(default).clamp(min, max)
}

/// 把 CPU 密集的计算丢到 actix 的 blocking 线程池。
///
/// 直接在 handler 里算会占住 worker 线程：16384 位 RSA 密钥生成要几十秒，
/// 高 cost 的 bcrypt 要几百毫秒，期间这个 worker 上所有请求都排队。
///
/// `f` 必须是 `Send + 'static`，因为要跨线程 —— 所以 `f` 只能 `move` 住
/// `payload`，别在闭包里借用外部数据。
///
/// 泛型只留 `F`：`F` 的返回类型已经把 `ToolResult` 钉死了，多写一个 `T`
/// 它在签名里无处出现，调用点推不出来（E0283）。
pub async fn blocking<F>(f: F) -> ToolResult
where
    F: FnOnce() -> ToolResult + Send + 'static,
{
    web::block(f)
        .await
        .map_err(|e| ToolError::Internal(format!("worker 崩了: {e}")))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn numbers_arrive_as_json_number_or_string() {
        // app.js 对 FieldKind::Number 提交的是字符串；直接 curl 给的是 JSON number
        assert_eq!(opt_u64(&json!({ "n": 30 }), "n"), Some(30));
        assert_eq!(opt_u64(&json!({ "n": "30" }), "n"), Some(30));
        assert_eq!(opt_u64(&json!({ "n": " 30 " }), "n"), Some(30));
        assert_eq!(opt_u64(&json!({ "n": "abc" }), "n"), None);
        assert_eq!(opt_u64(&json!({}), "n"), None);
        // 负数 / 小数不是合法的 u64
        assert_eq!(opt_u64(&json!({ "n": -1 }), "n"), None);
        assert_eq!(opt_u64(&json!({ "n": 1.5 }), "n"), None);
    }

    #[test]
    fn empty_string_falls_back_to_the_registry_default() {
        assert_eq!(str_or(&json!({ "a": "x" }), "a", "sha256"), "x");
        assert_eq!(str_or(&json!({ "a": "  " }), "a", "sha256"), "sha256");
        assert_eq!(str_or(&json!({}), "a", "sha256"), "sha256");
    }

    #[test]
    fn required_field_rejects_blank() {
        assert!(req_str(&json!({ "k": "v" }), "k").is_ok());
        assert!(req_str(&json!({ "k": "   " }), "k").is_err());
        assert!(req_str(&json!({}), "k").is_err());
    }

    #[test]
    fn out_of_range_numbers_are_clamped_not_rejected() {
        assert_eq!(bounded_u64(&json!({ "c": 99 }), "c", 10, 4, 31), 31);
        assert_eq!(bounded_u64(&json!({ "c": 0 }), "c", 10, 4, 31), 4);
        assert_eq!(bounded_u64(&json!({}), "c", 10, 4, 31), 10);
        assert_eq!(bounded_u64(&json!({ "c": "junk" }), "c", 10, 4, 31), 10);
    }

    #[test]
    fn required_string_names_the_missing_field() {
        let err = req_str(&json!({}), "key").unwrap_err();
        // 错误是「带键」的：键在语言包里，文案由 API 层按请求语言渲染。
        // 所以这里断言的是**渲染后**的句子，而不是键本身。
        let msg = err.localize("en");
        assert!(msg.contains("`key`"), "{msg}");
    }
}
