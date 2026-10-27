//! MAC address lookup —— 按 OUI 前缀查厂商（endpoint `mac-address-lookup`）。
//!
//! 逻辑与参考实现一致：把分隔符去掉、转大写、取前 6 位（24 bit OUI）查表。
//!
//! 放服务端而不是 JS 的理由：OUI 表有 3.5 万条、0.86 MiB，放服务端只需打进二进制一次，
//! 浏览器端则要等一次几百 KB 的 fetch；而且查询只是一次 HashMap 查找，
//! 服务端做没有任何 CPU 开销，**不需要**丢 `web::block`（丢进去反而多一次线程切换）。
//!
//! 数据文件 `data/oui.txt` 由 `scripts/build-oui.sh` 从 nmap 的 OUI 库生成，
//! 经 `crate::embed::Data` 打进二进制。与参考实现的一处已知差异：
//! nmap 的厂商名是**单行**的，而参考实现用的 `oui-data` 是多行详情（厂商 + 地址 + 国家），
//! 这里只输出一行厂商名。

use std::collections::HashMap;

use once_cell::sync::Lazy;
use serde_json::{json, Value};

use crate::embed::Data;

use super::{ToolError, ToolResult};

/// OUI 表在嵌入资源里的路径。
const DATA_FILE: &str = "oui.txt";

/// OUI 是 24 bit，即 6 位十六进制。
const OUI_LEN: usize = 6;

/// 允许的十六进制位数：6 = 裸 OUI，8 = EUI-64，12 = 完整 MAC。
const VALID_LENS: &[usize] = &[6, 8, 12];

/// 没查到厂商时的提示。
const UNKNOWN: &str = "未知厂商：该 OUI 未在 IEEE 注册表中登记";

/// 全进程一份的 OUI 查表。
///
/// 3.5 万行解析一次十几毫秒，用 `Lazy` 保证全进程只付这一次，之后每次查询都是微秒级的
/// 字典查找（所以 `handle` 里没有 blocking）。
static OUI_DB: Lazy<HashMap<u32, String>> = Lazy::new(load_oui_db);

/// 解析嵌入的 OUI 表。
///
/// 键用 `u32` 而不是 `String`：查询时只要把输入的前 6 位解析成 `u32`，
/// 省掉每次查询构造/哈希一个短字符串的开销；值保留 `String` 是因为嵌入的字节是
/// `Cow<'static, [u8]>`，想零拷贝地借用需要 `Box::leak` + 自引用结构，
/// 为了省下 0.8 MiB 常驻内存去和生命周期较劲不划算（进程本来就把这份数据读进内存了）。
fn load_oui_db() -> HashMap<u32, String> {
    let Some(file) = Data::get(DATA_FILE) else {
        // 缺文件是打包事故（忘了跑 scripts/build-oui.sh），不是用户输入的问题，
        // 所以只记日志、退化成「全部查不到」，不把整个工具变成 500。
        log::error!("嵌入资源缺少 {DATA_FILE}，请重新执行 scripts/build-oui.sh");
        return HashMap::new();
    };
    let Ok(text) = std::str::from_utf8(&file.data) else {
        log::error!("嵌入资源 {DATA_FILE} 不是合法的 UTF-8");
        return HashMap::new();
    };

    let mut db = HashMap::with_capacity(40_000);
    for line in text.lines() {
        // 生成脚本写了几行 `#` 头部注释，跳过；顺带也把将来可能的脏行挡掉。
        let Some((prefix, vendor)) = line.split_once('\t') else {
            continue;
        };
        if let Some(key) = parse_oui(prefix) {
            db.insert(key, vendor.to_owned());
        }
    }
    db
}

/// 把 6 位十六进制 OUI 解析成 `u32`。位数不对或含非十六进制字符时返回 `None`。
fn parse_oui(prefix: &str) -> Option<u32> {
    if prefix.len() != OUI_LEN {
        return None;
    }
    u32::from_str_radix(prefix, 16).ok()
}

/// 归一化输入：去掉分隔符并转大写。
///
/// 参考实现是 `address.trim().replace(/[.:-]/g, '').toUpperCase()`：
/// 字符类里的 `.` 意味着 Cisco 那种点分三段式（`0100.0a.c0.8b`）本来就自动支持，
/// 这里额外把各种空白也去掉 —— 从终端/网页复制来的地址常带首尾空格或 tab，
/// 而 trim() 只管得了一部分。
///
/// 只去分隔符、不去别的字符：留下的非十六进制字符要报错给用户看，
/// 悄悄丢掉的输入只会变成一句莫名其妙的「前缀查不到」。
fn normalize(input: &str) -> String {
    input
        .chars()
        .filter(|c| !matches!(c, '-' | ':' | '.' | '_' | '/') && !c.is_whitespace())
        .map(|c| c.to_ascii_uppercase())
        .collect()
}

/// 把归一化后的十六进制串还原成冒号分隔的形式，仅用于回显。
fn colon_form(hex: &str) -> String {
    hex.as_bytes()
        .chunks(2)
        .map(|pair| String::from_utf8_lossy(pair).into_owned())
        .collect::<Vec<_>>()
        .join(":")
}

/// 与注册表 `ApiSpec.fields` 保持一致。
pub async fn handle(payload: Value) -> ToolResult {
    compute(payload)
}

fn compute(payload: Value) -> ToolResult {
    let raw = super::util::opt_str(&payload, "mac").unwrap_or_default();
    let hex = normalize(raw);

    // ── 这里是「不是 MAC 地址」和「查不到厂商」的分界线 ──
    // 长度不对、含非十六进制字符 —— 用户根本没给一个 MAC，报错让用户去改；
    // 长度对但是 IEEE 没登记过 —— 这是合法答案，正常返回「未知」，不是错误。
    if hex.is_empty() {
        return Err(ToolError::invalid("out.mac-address-lookup.err.empty", &[]));
    }
    if let Some(bad) = hex.chars().find(|c| !c.is_ascii_hexdigit()) {
        return Err(ToolError::invalid(
            "out.mac-address-lookup.err.not_hex",
            &[("character", &bad.to_string())],
        ));
    }
    if !VALID_LENS.contains(&hex.len()) {
        return Err(ToolError::invalid(
            "out.mac-address-lookup.err.bad_length",
            &[("length", &hex.len().to_string())],
        ));
    }

    // OUI 永远是前 3 个字节，后面的部分（EUI-48 的厂商扩展位、或 EUI-64 的后半段）不参与判断。
    let oui = &hex[..OUI_LEN];
    // 上面已经保证了「非空 + 全十六进制 + 位数合法」，所以这里必然解析得出来；
    // 万一解析不了只能是数据自相矛盾，记 Internal 而不是默默当成 000000（那是 Xerox）。
    let oui_key = u32::from_str_radix(oui, 16)
        .map_err(|_| ToolError::Internal(format!("OUI 前缀解析失败: {oui}")))?;
    let first_octet = (oui_key >> 16) as u8;

    // 第一字节的 bit1（0x02）= 本地管理：厂商自己随机分配，不可能有 IEEE 登记；
    // bit0（0x01）= 组播：组播地址走 IANA 的范围划分，不走 OUI 登记。
    // 这两种情况的「查不到」是必然的，说清楚原因比干巴巴一句 unknown 有用 ——
    // 这是相对参考实现的增强，参考实现一律显示同一句 "Unknown vendor for this address"。
    let locally_administered = first_octet & 0x02 != 0;
    let multicast = first_octet & 0x01 != 0;

    let vendor = OUI_DB.get(&oui_key).map(String::as_str);

    let output = match vendor {
        Some(name) => name.to_string(),
        None if locally_administered => {
            "未知厂商：该地址是本地管理（locally administered）地址，没有 OUI 登记".into()
        }
        None if multicast => "未知厂商：组播地址不使用 IEEE 的 OUI 登记".into(),
        None => UNKNOWN.into(),
    };

    Ok(json!({
        "output": output,
        "meta": {
            "input": raw.trim(),
            "normalized": colon_form(&hex),
            "oui": oui,
            "found": vendor.is_some(),
            "vendor": vendor,
            "locally_administered": locally_administered,
            "multicast": multicast,
            "entries": OUI_DB.len(),
        }
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// 下面的期望值都从 `data/oui.txt` 里 grep 出来的，不是凭记忆写的，
    /// 换数据源时改期望值即可（重新跑一遍 scripts/build-oui.sh）。
    fn vendor_of(mac: &str) -> String {
        let out = compute(json!({ "mac": mac })).unwrap();
        out["output"].as_str().unwrap().to_string()
    }

    fn meta_of(mac: &str) -> Value {
        compute(json!({ "mac": mac })).unwrap()["meta"].clone()
    }

    #[test]
    fn reference_example_resolves() {
        // 参考实现输入框的默认值
        assert_eq!(vendor_of("20:37:06:12:34:56"), "Cisco Systems");
    }

    #[test]
    fn known_ouis_match_the_table() {
        assert_eq!(vendor_of("00:00:0C:11:22:33"), "Cisco Systems");
        assert_eq!(vendor_of("B8:27:EB:11:22:33"), "Raspberry Pi Foundation");
        assert_eq!(vendor_of("00:1A:11:11:22:33"), "Google");
        // 任务里点名的 F0189E 在 IEEE 库里不存在（Apple 那一段是 F01898），换成真实存在的
        assert_eq!(vendor_of("F0:18:98:11:22:33"), "Apple");
        assert_eq!(vendor_of("3C:5A:37:11:22:33"), "Samsung Electronics");
        assert_eq!(vendor_of("00:00:00:11:22:33"), "Xerox");
    }

    #[test]
    fn separators_and_case_do_not_matter() {
        for form in [
            "20:37:06:12:34:56",
            "20-37-06-12-34-56",
            "203706123456",
            "20.37.06.12.34.56", // Cisco 点分三段式
            "2037.0612.3456",    // 同上，只是第一段写法不同
            "20:37:06:12:34:56 ",
            "  20-37-06-12-34-56  ",
        ] {
            assert_eq!(vendor_of(form), "Cisco Systems", "{form}");
        }
        assert_eq!(vendor_of("b8:27:eb:00:00:01"), "Raspberry Pi Foundation");
        assert_eq!(vendor_of("f0-18-98-00-00-01"), "Apple");
    }

    #[test]
    fn bare_oui_and_eui64_forms_work() {
        // 6 位：裸 OUI
        assert_eq!(vendor_of("B827EB"), "Raspberry Pi Foundation");
        // 8 位：EUI-64，仍按前 3 字节判定
        assert_eq!(vendor_of("B827EB01"), "Raspberry Pi Foundation");
    }

    #[test]
    fn unknown_but_valid_prefix_is_not_an_error() {
        // 第一字节 0x0C：bit0（组播）和 bit1（本地管理）都是 0，
        // 所以「查不到」只能是真的没登记，用它来验证通用的 unknown 分支
        let out = compute(json!({ "mac": "0C:34:56:78:9A:BC" })).unwrap();
        assert_eq!(out["output"], UNKNOWN);
        assert_eq!(out["meta"]["found"], false);
        assert_eq!(out["meta"]["vendor"], Value::Null);
        // 也是正常结果，不是错误
        assert_eq!(out["meta"]["oui"], "0C3456");
    }

    #[test]
    fn locally_administered_address_explains_itself() {
        // 第一字节 0x02 → bit1 置位 = 本地管理
        let out = compute(json!({ "mac": "02:11:22:33:44:55" })).unwrap();
        assert_eq!(out["meta"]["locally_administered"], true);
        assert_eq!(out["meta"]["found"], false);
        assert!(out["output"].as_str().unwrap().contains("本地管理"));
    }

    #[test]
    fn multicast_address_explains_itself() {
        let out = compute(json!({ "mac": "01:00:5E:00:00:01" })).unwrap();
        assert_eq!(out["meta"]["multicast"], true);
        assert_eq!(out["meta"]["found"], false);
        assert!(out["output"].as_str().unwrap().contains("组播"));
    }

    #[test]
    fn invalid_input_errors_without_panicking() {
        for bad in [
            "",
            "   ",
            "20:37",                   // 2 字节，既不是 OUI 也不是 EUI-64
            "20:37:06:12:34:56:78:90", // 8 字节
            "ZZ:11:22:33:44:55",       // 非十六进制
            "hello world",
        ] {
            assert!(compute(json!({ "mac": bad })).is_err(), "应该报错: {bad:?}");
        }
        // 缺字段也当空串处理，不 panic
        assert!(compute(json!({})).is_err());
        assert!(compute(json!({ "mac": 42 })).is_err());
    }

    #[test]
    fn embedded_table_parses_with_plausible_entry_count() {
        // 断言区间而不是精确条数：换数据源刷新 CI 不该红。
        let n = OUI_DB.len();
        assert!(n > 30_000, "OUI 条目太少: {n}");
        assert!(n < 60_000, "OUI 条目异常多，多半是解析错了: {n}");
    }

    #[test]
    fn meta_reports_normalized_form() {
        let meta = meta_of("20-37-06-12-34-56");
        assert_eq!(meta["normalized"], "20:37:06:12:34:56");
        assert_eq!(meta["oui"], "203706");
        assert_eq!(meta["locally_administered"], false);
        assert_eq!(meta["multicast"], false);
    }
}
