//! WPA-PSK 原始密钥（256 位）派生。
//!
//! 参考实现：/data/work/it-tools2/src/tools/wpa-psk-generator/
//! （sharevb/it-tools 的 fork）。它用 `crypto-es` 的 `PBKDF2` 算一把
//! 256 位的原始密钥：**口令是密码，SSID 是盐**，迭代 4096 轮，
//! 伪随机函数是 HMAC-SHA1 —— 就是 IEEE 802.11i 规定的那个算法。
//!
//! ## 与上游的差别
//!
//! 1. **口令不回到结果里**。上游把口令与 SSID 一起显示在结果区。
//!    这里只给 SSID 与派生出来的密钥 —— 口令是用户自己刚输进去的，
//!    回显一遍没有用处，却会把它带进响应体（可能被代理记进日志）。
//! 2. **空输入会报错**。上游的页面上有「SSID 不能为空」的校验，
//!    但那只是前端的；直接打接口时空值会算出一个看起来正常的密钥。
//!    这里空 SSID 与空口令都明确报错。
//! 3. **多给一行提醒**：口令长度不在 8 到 63 之间时，WPA-PSK 的
//!    「口令形式」是不合法的（IEEE 802.11i §11.7.3）——
//!    密钥算得出来，但设备不会接受这个口令。
//!
//! ## 口令不出现在错误消息里
//!
//! 派生的密钥是敏感材料，口令更甚。错误消息只说「哪个字段没填」，
//! 不带用户输入的任何字符 —— 错误消息会进日志。

use serde_json::{json, Map, Value};
use sha1::Sha1;

use super::util;
use super::ToolResult;

/// IEEE 802.11i 规定的迭代次数（Annex H.4）。
const ITERATIONS: u32 = 4096;

/// 派生出来的密钥长度：256 位 = 32 字节。
const KEY_LEN: usize = 32;

/// WPA-PSK 口令形式要求的长度（IEEE 802.11i §11.7.3）。
const MIN_PASSPHRASE: usize = 8;
const MAX_PASSPHRASE: usize = 63;

/// 与注册表 `ApiSpec.fields` 保持一致。
pub async fn handle(payload: Value) -> ToolResult {
    compute(payload)
}

fn compute(payload: Value) -> ToolResult {
    let ssid = util::req_str(&payload, "ssid")?;
    let passphrase = util::req_str(&payload, "passphrase")?;

    let psk = derive_psk(ssid, passphrase);
    let lang = util::lang(&payload);

    let mut table = Map::new();
    util::row_str(&mut table, &payload, "out.wpa-psk-generator.ssid", ssid);
    util::row_str(&mut table, &payload, "out.wpa-psk-generator.psk", &psk);
    util::row_str(
        &mut table,
        &payload,
        "out.wpa-psk-generator.key_length",
        &(KEY_LEN * 8).to_string(),
    );
    util::row_str(
        &mut table,
        &payload,
        "out.wpa-psk-generator.algorithm",
        "PBKDF2-HMAC-SHA1",
    );
    util::row_str(
        &mut table,
        &payload,
        "out.wpa-psk-generator.iterations",
        &ITERATIONS.to_string(),
    );
    // 盐就是 SSID —— 换个 SSID，同一句口令会派生出另一把密钥
    util::row_str(
        &mut table,
        &payload,
        "out.wpa-psk-generator.salt",
        ssid,
    );

    // 口令长度不合法时给一行提醒（不是错误 —— 密钥照样算得出来）
    let len = passphrase.chars().count();
    if !(MIN_PASSPHRASE..=MAX_PASSPHRASE).contains(&len) {
        let warning = crate::i18n::t_args(
            lang,
            "out.wpa-psk-generator.warn.passphrase_length",
            &[("length", &len.to_string())],
        );
        util::row(
            &mut table,
            &payload,
            "out.wpa-psk-generator.passphrase_length",
            json!(warning),
        );
    }

    Ok(json!({
        "output": psk,
        "table": table,
        "rows": [],
        "meta": { "iterations": ITERATIONS, "key_bits": KEY_LEN * 8 },
    }))
}

/// 派生出 256 位的原始密钥（十六进制）。
///
/// 口令是密码，SSID 是盐 —— 顺序不能反：反了算出来的是另一把密钥。
fn derive_psk(ssid: &str, passphrase: &str) -> String {
    let mut out = [0u8; KEY_LEN];
    pbkdf2::pbkdf2_hmac::<Sha1>(
        passphrase.as_bytes(),
        ssid.as_bytes(),
        ITERATIONS,
        &mut out,
    );
    hex::encode(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(ssid: &str, passphrase: &str) -> Value {
        compute(json!({ "ssid": ssid, "passphrase": passphrase })).expect("应当算出结果")
    }

    fn table_of(v: &Value) -> Map<String, Value> {
        v["table"].as_object().cloned().unwrap()
    }

    fn label(key: &str) -> String {
        crate::i18n::t("en", key)
    }

    /// IEEE 802.11i-2004 Annex H.4 给出的标准测试向量。
    #[test]
    fn the_ieee_test_vector_matches() {
        assert_eq!(
            derive_psk("IEEE", "password"),
            "f42c6fc52df0ebef9ebb4b90b38a5f902e83fe1b135a70e23aed762e9710a12e"
        );
    }

    /// 参考实现自己的测试向量（crypto-es 的 PBKDF2）。
    #[test]
    fn the_reference_vectors_match() {
        assert_eq!(
            derive_psk("test", "test"),
            "d630c5513becfd3952432bd7fcf098b7a40907f3214cf43551f1b8cfda873ecc"
        );
        assert_eq!(
            derive_psk("MyNetwork", "SuperSecret123"),
            "667d7ea7ef34fd9468f4a5ca7ff69cb8bdc05980dee5ba784dfc70e65f70f51a"
        );
        assert_eq!(
            derive_psk("", ""),
            "5c622913020b8e2ddd9a58552396ccebd10eb57121a346f127d13c9006434cc0"
        );
    }

    #[test]
    fn the_key_is_256_bits_of_hex() {
        let out = run("MyNetwork", "SuperSecret123");
        let psk = out["output"].as_str().unwrap();
        assert_eq!(psk.len(), 64);
        assert!(psk.chars().all(|c| c.is_ascii_hexdigit()));
        assert_eq!(
            table_of(&out)[&label("out.wpa-psk-generator.key_length")],
            json!("256")
        );
    }

    #[test]
    fn the_ssid_is_the_salt() {
        // 换个 SSID，同一句口令会派生出另一把密钥
        assert_ne!(derive_psk("alice", "bob"), derive_psk("bob", "alice"));
    }

    #[test]
    fn the_result_is_deterministic() {
        assert_eq!(derive_psk("ssid", "passphrase"), derive_psk("ssid", "passphrase"));
    }

    #[test]
    fn the_passphrase_never_comes_back() {
        let out = run("MyNetwork", "SuperSecret123");
        let text = out.to_string();
        assert!(!text.contains("SuperSecret123"), "{text}");
    }

    #[test]
    fn a_short_passphrase_gets_a_warning() {
        let out = run("MyNetwork", "short");
        let table = table_of(&out);
        let warning = table
            .get(&label("out.wpa-psk-generator.passphrase_length"))
            .expect("应当有一行提醒");
        // 语言包里还没有这条文案时，t_args 退回键本身 —— 那时只查「有这一行」
        if crate::i18n::has("en", "out.wpa-psk-generator.warn.passphrase_length") {
            assert!(
                warning.as_str().unwrap().contains('5'),
                "提醒里应当写明口令的长度: {warning}"
            );
        }
    }

    #[test]
    fn a_proper_passphrase_gets_no_warning() {
        let out = run("MyNetwork", "SuperSecret123");
        let table = table_of(&out);
        assert!(!table.contains_key(&label("out.wpa-psk-generator.passphrase_length")));
    }

    #[test]
    fn missing_input_is_reported_without_leaking_anything() {
        assert!(compute(json!({})).is_err());
        assert!(compute(json!({ "ssid": "x" })).is_err());
        assert!(compute(json!({ "passphrase": "x" })).is_err());
        assert!(compute(json!({ "ssid": " ", "passphrase": "x" })).is_err());
    }
}
