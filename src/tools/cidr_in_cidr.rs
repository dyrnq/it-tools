//! 一个网段是不是完全落在另一个网段里。
//!
//! 参考实现：/data/work/it-tools2/src/tools/cidr-in-cidr/
//! （sharevb/it-tools 的 fork）。它用 `ip-matching` 把两边的输入都拆成
//! 掩码，再逐个判断「测试的那段是不是基段的子集」。
//!
//! ## 与上游的差别
//!
//! 1. **两边各只吃一种写法**。上游的 `getMatch` 认掩码、通配符、
//!    区间、CIDR 好几种写法；这里统一成「一段地址」：
//!    `10.0.0.0/8`、`10.0.0.1-10.0.255.255`、`10.0.0.1` 都认。
//! 2. **判断是「完全包含」**。上游的判据是「测试段的每一个掩码都是
//!    基段某个掩码的子集」—— 与「测试段整体落在基段里」是一回事，
//!    但上游在两边版本不一致时会静悄悄地给出 false。
//!    这里版本不一致直接报错。
//! 3. 结果给的是 **true / false**（脚本好读），页面上另有一行
//!    翻好的「包含 / 不包含」。

use serde_json::{json, Map, Value};

use super::cidr;
use super::util;
use super::{ToolError, ToolResult};

/// 与注册表 `ApiSpec.fields` 保持一致。
pub async fn handle(payload: Value) -> ToolResult {
    compute(payload)
}

fn compute(payload: Value) -> ToolResult {
    let base_input = util::req_str(&payload, "base_block")?;
    let test_input = util::req_str(&payload, "test_block")?;

    let base = cidr::parse_span(base_input).map_err(|e| cidr::span_error(e, base_input))?;
    let test = cidr::parse_span(test_input).map_err(|e| cidr::span_error(e, test_input))?;

    if base.v6 != test.v6 {
        return Err(ToolError::invalid(
            "out.common.cidr.err.different_families",
            &[("base", base_input), ("test", test_input)],
        ));
    }

    let included = cidr::contains(&base, &test);
    let lang = util::lang(&payload);

    let mut table = Map::new();
    util::row_str(
        &mut table,
        &payload,
        "out.cidr-in-cidr.base",
        &cidr::fmt_span(&base),
    );
    util::row_str(
        &mut table,
        &payload,
        "out.cidr-in-cidr.test",
        &cidr::fmt_span(&test),
    );
    let verdict = if included {
        crate::i18n::t(lang, "out.cidr-in-cidr.included")
    } else {
        crate::i18n::t(lang, "out.cidr-in-cidr.not_included")
    };
    util::row_str(
        &mut table,
        &payload,
        "out.cidr-in-cidr.result",
        &verdict,
    );

    Ok(json!({
        "output": if included { "true" } else { "false" },
        "table": table,
        "rows": [],
        "meta": { "included": included },
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(base: &str, test: &str) -> Value {
        compute(json!({ "base_block": base, "test_block": test }))
            .expect("应当算出结果")
    }

    fn table_of(v: &Value) -> Map<String, Value> {
        v["table"].as_object().cloned().unwrap()
    }

    fn label(key: &str) -> String {
        crate::i18n::t("en", key)
    }

    #[test]
    fn a_block_inside_another_is_included() {
        let out = run("192.168.0.0/16", "192.168.1.0/24");
        assert_eq!(out["output"], json!("true"));
        let table = table_of(&out);
        assert_eq!(
            table[&label("out.cidr-in-cidr.base")],
            json!("192.168.0.0 - 192.168.255.255")
        );
        assert_eq!(
            table[&label("out.cidr-in-cidr.test")],
            json!("192.168.1.0 - 192.168.1.255")
        );
        assert_eq!(
            table[&label("out.cidr-in-cidr.result")],
            json!(crate::i18n::t("en", "out.cidr-in-cidr.included"))
        );
    }

    #[test]
    fn a_single_address_inside_is_included() {
        let out = run("192.168.0.0/16", "192.168.1.1");
        assert_eq!(out["output"], json!("true"));
    }

    #[test]
    fn a_block_outside_is_not_included() {
        let out = run("192.168.0.0/16", "10.0.0.0/8");
        assert_eq!(out["output"], json!("false"));
        assert_eq!(
            table_of(&out)[&label("out.cidr-in-cidr.result")],
            json!(crate::i18n::t("en", "out.cidr-in-cidr.not_included"))
        );
    }

    #[test]
    fn a_block_that_sticks_out_is_not_included() {
        // 192.168.0.0/16 是基段，但 192.168.0.0/15 更大 —— 有一部分在外面
        let out = run("192.168.0.0/16", "192.168.0.0/15");
        assert_eq!(out["output"], json!("false"));
    }

    #[test]
    fn an_identical_block_is_included() {
        let out = run("10.0.0.0/8", "10.0.0.0/8");
        assert_eq!(out["output"], json!("true"));
    }

    #[test]
    fn a_range_works_as_well_as_a_block() {
        let out = run("10.0.0.0-10.255.255.255", "10.1.0.0-10.1.255.255");
        assert_eq!(out["output"], json!("true"));
    }

    #[test]
    fn nonsense_is_reported() {
        assert!(compute(json!({})).is_err());
        assert!(compute(json!({ "base_block": "192.168.0.0/16" })).is_err());
        assert!(compute(json!({ "base_block": "x", "test_block": "y" })).is_err());
        // 两边版本不一样
        assert!(compute(json!({
            "base_block": "192.168.0.0/16",
            "test_block": "2001:db8::/32"
        }))
        .is_err());
    }
}
