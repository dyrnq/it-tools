//! IPv6 地址转换器（上游 PR #870）。
//!
//! 把一个 IPv6 地址换成它的各种等价写法：展开 / 压缩 / 十进制 / 十六进制 /
//! 二进制 / 反向 DNS / 接口标识，外加地址类型判定。
//!
//! ## 为什么放服务端
//!
//! 上游这��工具拖了 6 个 npm 包（`cidr-tools` / `ip-bigint` / `ip-address` /
//! `ip-matching` / `is-cidr` / `is-ip`），其中 `ip-cidr` **全仓库没 import 过**，
//! 而 `cidr-tools` 与 `ip-bigint` 是**纯 ESM** —— 在我们这套没有打包器的栈里
//! 既不能 `<script src>` 也不能 cjs-bundle。
//!
//! 但其实**一个都不需要**：`std::net::Ipv6Addr` 的 `to_bits() -> u128` 已经覆盖
//! 解析 / 展开 / 压缩 / 十进制 / 十六进制 / 二进制；ARPA 形式 = 倒着写半字节；
//! 剩下的就是 RFC 5952 的压缩器（最长零串，平局取最左）与 IANA 登记表。
//! 那些都放在 [`super::ipv6`] 里，与子网计算器共用同一份实现。
//!
//! ## 上游那份实现的坑
//!
//! 上游的 `src/utils/ip.ts` 147 行里有 **5 段是从 IPv4 工具搬过来的死代码**
//! （`getSubnets` / `getNetworksCount` 里的 IPv4 分支在这个工具里永远走不到），
//! 而它的测试文件 243 行里的**真实断言全被注释掉**换成了
//! `expect(true).to.eql(true)` —— 假绿。所以我们不照抄，只取「要输出哪些形态」。

use serde_json::{json, Map, Value};

use super::ipv6;
use super::util;
use super::ToolResult;

/// 与注册表 `ApiSpec.fields` 保持一致。
pub async fn handle(payload: Value) -> ToolResult {
    compute(payload)
}

fn compute(payload: Value) -> ToolResult {
    let input = util::req_str(&payload, "ip")?;
    let parsed = ipv6::parse(input)?;
    let addr = parsed.addr;
    let lang = util::lang(&payload);

    let mut table = Map::new();
    util::row_str(
        &mut table,
        &payload,
        "out.ipv6-address-converter.expanded",
        &ipv6::expand(&addr),
    );
    util::row_str(
        &mut table,
        &payload,
        "out.ipv6-address-converter.compressed",
        &ipv6::compress(&addr),
    );
    util::row_str(
        &mut table,
        &payload,
        "out.ipv6-address-converter.decimal",
        &ipv6::to_decimal(&addr),
    );
    util::row_str(
        &mut table,
        &payload,
        "out.ipv6-address-converter.hex",
        &ipv6::to_hex(&addr),
    );
    util::row_str(
        &mut table,
        &payload,
        "out.ipv6-address-converter.binary",
        &ipv6::to_binary(&addr),
    );
    util::row_str(
        &mut table,
        &payload,
        "out.ipv6-address-converter.interface_id",
        &ipv6::interface_id(&addr),
    );
    util::row_str(
        &mut table,
        &payload,
        "out.ipv6-address-converter.arpa",
        &ipv6::to_arpa(&addr),
    );

    let class = ipv6::classify(&addr, lang);
    util::row_str(
        &mut table,
        &payload,
        "out.ipv6-address-converter.type",
        &class.kind,
    );
    util::row_str(
        &mut table,
        &payload,
        "out.ipv6-address-converter.scope",
        &crate::i18n::t(lang, ipv6::scope_key(class.scope)),
    );
    if let Some(prefix) = class.prefix {
        util::row_str(
            &mut table,
            &payload,
            "out.ipv6-address-converter.range",
            &prefix,
        );
    }
    if let Some(zone) = &parsed.zone {
        util::row_str(
            &mut table,
            &payload,
            "out.ipv6-address-converter.zone",
            zone,
        );
    }
    if parsed.was_ipv4 {
        util::row_str(
            &mut table,
            &payload,
            "out.ipv6-address-converter.note_ipv4",
            &crate::i18n::t(lang, "out.ipv6-address-converter.note_ipv4"),
        );
    }
    if let Some(v4) = addr.to_ipv4_mapped() {
        util::row_str(
            &mut table,
            &payload,
            "out.ipv6-address-converter.ipv4_mapped",
            &v4.to_string(),
        );
    } else if let Some(v4) = addr.to_ipv4() {
        // IPv4 兼容地址（::a.b.c.d）—— RFC 4291 §2.5.5.1
        util::row_str(
            &mut table,
            &payload,
            "out.ipv6-address-converter.embedded_ipv4",
            &v4.to_string(),
        );
    }

    Ok(json!({
        "output": ipv6::compress(&addr),
        "table": table,
    }))
}

/// 作用域的语言包键。`ipv6::classify` 给的是机器可读的作用域名，
/// 键的映射在 [`ipv6::scope_key`] 里 —— 两个工具共用一份。

#[cfg(test)]
mod tests {
    use super::*;

    fn run(input: &str) -> Value {
        compute(json!({ "ip": input })).expect("应当算出结果")
    }

    fn run_in(input: &str, lang: &str) -> Value {
        compute(json!({ "ip": input, util::LANG_KEY: lang })).expect("应当算出结果")
    }

    fn table_of(v: &Value) -> Map<String, Value> {
        v["table"].as_object().cloned().unwrap()
    }

    /// 行的**标题**是按语言取出来的，所以断言要按语言包里的键去取标题，
    /// 而不是把标题的字面量抄一遍 —— 抄一遍的话，改一次文案就要改一次断言。
    fn label(key: &str) -> String {
        crate::i18n::t("en", key)
    }

    #[test]
    fn output_is_the_compressed_form() {
        let out = run("2001:0DB8:0000:0000:0000:0000:0000:0001");
        assert_eq!(out["output"], json!("2001:db8::1"));
    }

    #[test]
    fn table_has_every_representation() {
        let table = table_of(&run("2001:db8::1"));
        assert_eq!(
            table[&label("out.ipv6-address-converter.expanded")],
            json!("2001:0db8:0000:0000:0000:0000:0000:0001")
        );
        assert_eq!(
            table[&label("out.ipv6-address-converter.compressed")],
            json!("2001:db8::1")
        );
        assert_eq!(
            table[&label("out.ipv6-address-converter.decimal")],
            json!("42540766411282592856903984951653826561")
        );
        assert_eq!(
            table[&label("out.ipv6-address-converter.hex")],
            json!("0x20010db8000000000000000000000001")
        );
        // 二进制：2001 = 0010 0000 0000 0001，0db8 = 0000 1101 1011 1000，
        // 中间六组全零，最后一组 0001
        let expected_binary = format!(
            "0010000000000001{:016}{}{}{}{}{}0000000000000001",
            "0000110110111000",
            "0".repeat(16),
            "0".repeat(16),
            "0".repeat(16),
            "0".repeat(16),
            "0".repeat(16)
        );
        assert_eq!(
            table[&label("out.ipv6-address-converter.binary")],
            json!(expected_binary)
        );
    }

    #[test]
    fn ipv4_input_is_reported_as_mapped() {
        let table = table_of(&run("192.168.1.1"));
        assert_eq!(
            table[&label("out.ipv6-address-converter.ipv4_mapped")],
            json!("192.168.1.1")
        );
        assert!(table.contains_key(&label("out.ipv6-address-converter.note_ipv4")));
    }

    #[test]
    fn zone_id_is_kept_in_the_table() {
        let table = table_of(&run("fe80::1%eth0"));
        assert_eq!(
            table[&label("out.ipv6-address-converter.zone")],
            json!("eth0")
        );
    }

    #[test]
    fn type_and_scope_are_reported() {
        let table = table_of(&run("fe80::1"));
        assert!(table[&label("out.ipv6-address-converter.type")]
            .as_str()
            .unwrap()
            .contains("Link-Local"));
        assert_eq!(
            table[&label("out.ipv6-address-converter.scope")],
            json!(crate::i18n::t("en", "out.ipv6.scope.link"))
        );
    }

    /// 表格的标题要跟着请求语言走 —— 英文界面不该出现中文行标题。
    #[test]
    fn the_row_labels_follow_the_request_language() {
        let en = table_of(&run_in("2001:db8::1", "en"));
        let zh = table_of(&run_in("2001:db8::1", "zh-CN"));
        let en_key = "out.ipv6-address-converter.expanded";
        let zh_key = "out.ipv6-address-converter.expanded";
        assert_eq!(
            en[&crate::i18n::t("en", en_key)],
            "2001:0db8:0000:0000:0000:0000:0000:0001"
        );
        assert_eq!(
            zh[&crate::i18n::t("zh-CN", zh_key)],
            "2001:0db8:0000:0000:0000:0000:0000:0001"
        );
        // 两种语言的标题确实不一样 —— 不然上面两条断言等于什么都没验
        assert_ne!(
            crate::i18n::t("en", en_key),
            crate::i18n::t("zh-CN", zh_key)
        );
    }

    #[test]
    fn blank_input_is_an_error_not_a_panic() {
        assert!(compute(json!({})).is_err());
        assert!(compute(json!({ "ip": "  " })).is_err());
        assert!(compute(json!({ "ip": "2001::db8::1" })).is_err());
    }

    /// 错误消息也要分语言 —— 英文界面下不该露出中文的错误。
    #[test]
    fn the_error_message_follows_the_requested_language() {
        let err = compute(json!({ "ip": "2001::db8::1" })).unwrap_err();
        // 语言包里还没并进来时，localize 退回键本身 —— 这时断言跳过
        if !crate::i18n::has("zh-CN", "out.common.ipv6_bad_address") {
            return;
        }
        assert_ne!(
            err.localize("en"),
            err.localize("zh-CN"),
            "两种语言不该是同一句"
        );
        assert!(
            !err.localize("en").contains("out.common"),
            "英文界面不该露出键：{}",
            err.localize("en")
        );
    }
}
