//! Bcrypt —— 密码哈希与比对（endpoint `bcrypt`）。
//!
//! 放服务端而不是 JS：浏览器没有 bcrypt 原语，参考项目为此引入了 `bcryptjs`；
//! `bcrypt` crate 是 OpenBSD C 版本的直译，产出的哈希和它互相兼容。
//!
//! ## 两个方向怎么用只有两个字段的 ApiSpec 表达
//!
//! 参考实现（`src/tools/bcrypt/bcrypt.vue`）是**两张独立的卡片**：
//! Hash（明文 + saltCount）和 Compare（待校验明文 + 一条已有哈希）。
//! 而注册表给本工具的 `ApiSpec` 只有 `text` + `cost` 两个字段
//! —— `FieldKind` 没有「第二个密码框」这种类型，`tool_api_form.html` 也画不出来。
//!
//! 注册表不在本文件的改动范围内，所以这里选的是**加字段而不是加模式**：
//!
//! - 表单只提交 `text` + `cost` → 走 **hash**，与注册表描述的表单行为完全一致；
//! - 请求里多带一个 `hash`（别名 `compare_hash`）字段、或 `mode: "compare"`
//!   → 走 **compare**，明文仍然取 `text`（别名 `compare_text`）。
//!
//! 这么做的前提是 `POST /api/tools/bcrypt` 是公开接口：
//! `handlers/api.rs` 会把整个 body 原样交给 `dispatch`，多带的字段不会报错。
//! 代价是页面上暂时只有 hash 一个方向 —— 要在 UI 上也暴露 compare，
//! 得往注册表加 `mode` / `compare_hash` 两个字段，那是另一次改动。
//!
//! 没有采用「`text` 长得像 `$2a$…` 就当成 compare」那种嗅探方案：compare 天然需要
//! 明文和哈希两份输入，只看 `text` 最多认出其中一份，另一份仍然无处可取；
//! 而且误判方向比缺功能更糟（有人想哈希一条恰好长得像哈希的密码时会被静默改语义）。
//!
//! ## 性能与安全
//!
//! - bcrypt 是纯 CPU 密集（cost 10 ≈ 几十毫秒，cost 14 ≈ 几百毫秒），
//!   所以 `handle` 一律丢 [`util::blocking`]，不占 actix 的 worker 线程。
//! - 比对走 `bcrypt::verify`，它内部用 `subtle::ConstantTimeEq` 比较摘要，
//!   不能自己写 `==` —— 哪怕只是比对哈希字符串。
//! - 任何错误信息都不回显 `text`（那可能是真密码），只说哪个字段有问题。

use bcrypt::{BcryptError, HashParts};
use serde_json::{json, Value};

use super::util;
use super::{ToolError, ToolResult};

/// bcrypt 只消费口令的前 72 字节（规范还会在末尾补一个 NUL 终止符），
/// 第 73 字节及之后的内容直接丢弃。
const MAX_PASSWORD: usize = 72;

/// bcrypt 0.19 里 `MIN_COST` / `MAX_COST` 是私有常量，只能自己写死。
/// 这是**规范允许**的范围；本工具实际肯跑的见 [`MAX_USABLE_COST`]。
const MIN_COST: u64 = 4;
const MAX_COST: u64 = 31;
/// 与注册表 `ApiField { name: "cost", default: Some("10") }` 对齐。
const DEFAULT_COST: u64 = 10;

/// 「实际可用」的 cost 上限，hash 与 compare 两个方向共用。
///
/// crate 允许到 31，但 2^31 轮迭代等于永远跑不完 —— `POST /api/tools/bcrypt` 是公开
/// 接口，一条 `{"cost": 31}` 就能永久占住一个 blocking 线程（线程池默认 512 个，
/// 占满即全站 CPU 类工具一起卡死）。实测过：cost 99 的比对请求跑了 600 秒没结束。
/// cost 20 约 1 秒，已经是 bcrypt 的生产上限，再往上纯属自伤。
///
/// 对**客户端传来的** cost 一律夹到这里（而不是报错）：cost 只是个性能旋钮，
/// 用户手滑填了 31 不该换来一个 400，但也不能真去跑。
const MAX_USABLE_COST: u32 = 20;
/// 夹取上限在 `u64` 下的样子，给 `bounded_u64` 用。
const MAX_USABLE_COST_U64: u64 = MAX_USABLE_COST as u64;

/// 比对结果的两句文案。放在语言包里，键在 `out:` 段下。
const MATCH_KEY: &str = "out.bcrypt.match";
const MISMATCH_KEY: &str = "out.bcrypt.mismatch";

/// bcrypt 是 CPU 密集的，必须丢到 blocking 线程池，不能占住 actix worker。
pub async fn handle(payload: Value) -> ToolResult {
    util::blocking(move || compute(payload)).await
}

fn compute(payload: Value) -> ToolResult {
    let mode = util::str_or(&payload, "mode", "").to_ascii_lowercase();

    // 待比对哈希只在 compare 方向用得到。trim 是为了容忍从终端 / 网页复制时
    // 带的换行与首尾空白 —— 合法哈希首尾不可能有空白，trim 不会改变有效输入。
    let given_hash = util::opt_str(&payload, "hash")
        .or_else(|| util::opt_str(&payload, "compare_hash"))
        .map(str::trim)
        .filter(|s| !s.is_empty());

    let text = plaintext_of(&payload);
    match mode.as_str() {
        "hash" => hash(text, &payload),
        "compare" => compare(text, given_hash, util::lang(&payload)),
        // 没给 mode：表单路径（只有 text + cost）走 hash；多带了一条哈希就走 compare
        "" if given_hash.is_some() => compare(text, given_hash, util::lang(&payload)),
        "" => hash(text, &payload),
        // 文案在语言包里（`out.bcrypt.err.*`）：英文界面下不能露出中文。
        other => Err(ToolError::invalid(
            "out.bcrypt.err.unknown_mode",
            &[("mode", other)],
        )),
    }
}

/// 明文。可能被叫 `text`（注册表字段），也可能被叫 `compare_text`
/// （对齐参考实现里 `compareString` 的语义）。
///
/// 缺字段等价于空串而不是报错：空口令是合法的 bcrypt 输入，
/// 「拿空口令去比对某条哈希」本身是个合理的请求。
fn plaintext_of(payload: &Value) -> &str {
    util::opt_str(payload, "text")
        .or_else(|| util::opt_str(payload, "compare_text"))
        .unwrap_or("")
}

/// `cost` 夹取。单独抽成函数是为了让单测能在不真的跑 2^31 轮的前提下断言夹取行为。
///
/// 上限是 [`MAX_USABLE_COST`] 而不是规范里的 31，见那里的说明。
fn cost_of(payload: &Value) -> u32 {
    util::bounded_u64(payload, "cost", DEFAULT_COST, MIN_COST, MAX_USABLE_COST_U64) as u32
}

/// cost 被夹过时要补的那句提示。
///
/// 单独抽出来是因为它是个纯函数：真跑一次 cost 20 的 bcrypt 在 debug 构建下要一分多钟，
/// 而这里要验的只是「该说的说了、不该说的没说」。
fn cost_clamp_warning(requested: Option<u64>) -> Option<String> {
    let requested = requested?;
    (requested > MAX_USABLE_COST_U64).then(|| {
        format!(
            "cost 已从 {requested} 夹到 {MAX_USABLE_COST}：更高档会让单次请求跑上几分钟，公开接口上等于自伤"
        )
    })
}

fn hash(text: &str, payload: &Value) -> ToolResult {
    // 先看用户要了多少，再夹 —— 夹过的值和原值不一样时得说一声，
    // 否则「我填了 31，结果这条哈希居然是 20 轮算的」会很难排查。
    let requested = util::opt_u64(payload, "cost");
    let cost = cost_of(payload);
    // 盐由 crate 内部用系统随机数生成（`rand` 依赖不需要在这里出现）。
    let digest = bcrypt::hash(text, cost).map_err(|e| match e {
        // 已经夹到 4..=20 了，走不到这个分支；留着是为了将来改夹取范围时不至于 panic。
        // 走得到的话就是「cost 越界」—— 属于输入不合法，不是服务端的问题。
        BcryptError::CostNotAllowed(c) => {
            let cost = c.to_string();
            let min = MIN_COST.to_string();
            let max = MAX_COST.to_string();
            ToolError::invalid(
                "out.bcrypt.err.cost_not_allowed",
                &[("cost", &cost), ("min", &min), ("max", &max)],
            )
        }
        // 多半是系统随机数不可用，那是服务端的问题，不是用户的输入问题
        other => ToolError::Internal(format!("bcrypt 计算失败: {other}")),
    })?;

    let truncated = text.len() > MAX_PASSWORD;
    let mut meta = serde_json::Map::new();
    meta.insert("cost".into(), json!(cost));
    // rust-bcrypt 固定输出 $2b$，参考实现（bcryptjs）输出 $2a$。
    // 两者能互相 verify：cost 与 salt 都编码在哈希串里，版本前缀只影响 >255 字节
    // 口令的兼容处理，这个工具用不到。
    meta.insert("version".into(), json!("$2b$"));
    meta.insert("length".into(), json!(digest.len()));
    meta.insert("truncated".into(), json!(truncated));

    let mut warnings: Vec<String> = Vec::new();
    if truncated {
        // 沿用参考实现的静默截断（bcryptjs 也这么干），但至少告诉调用方一声，
        // 因为「密码长了 3 个字符却能登录」是很典型的线上事故。
        warnings.push(format!(
            "bcrypt 最多只用前 {MAX_PASSWORD} 字节，超出部分已被丢弃"
        ));
    }
    warnings.extend(cost_clamp_warning(requested));
    if !warnings.is_empty() {
        meta.insert("warnings".into(), json!(warnings));
    }

    Ok(json!({ "output": digest, "meta": meta }))
}

fn compare(text: &str, given_hash: Option<&str>, lang: &str) -> ToolResult {
    let Some(hash) = given_hash else {
        return Err(ToolError::invalid("out.bcrypt.err.missing_hash", &[]));
    };

    // 先解析再算：解析是纯字符串操作（微秒级），可以在烧 CPU 之前就把
    // 「不是 bcrypt」和「cost 太贵」这两类输入挡掉。
    //
    // 解析失败时不带 crate 的原文 —— 那句原文里可能夹着用户哈希里的字符，
    // 等于把哈希回显出去。只说「格式不对」。
    let parts = hash
        .parse::<HashParts>()
        .map_err(|_| ToolError::invalid("out.bcrypt.err.bad_hash", &[]))?;

    let cost = parts.get_cost();
    if u64::from(cost) > MAX_COST {
        let cost = cost.to_string();
        let min = MIN_COST.to_string();
        let max = MAX_COST.to_string();
        return Err(ToolError::invalid(
            "out.bcrypt.err.bad_cost",
            &[("cost", &cost), ("min", &min), ("max", &max)],
        ));
    }
    // 这里的 cost 来自攻击者可控的哈希串：一条 `$2b$31$…` 能让一次请求
    // 永久占住一个 blocking 线程，所以要比 hash 方向夹得更紧 —— 直接拒绝，
    // 因为没法「夹」：哈希串里的 cost 改了就对不上这条哈希了。
    if cost > MAX_USABLE_COST {
        let cost = cost.to_string();
        let max = MAX_USABLE_COST.to_string();
        return Err(ToolError::invalid(
            "out.bcrypt.err.cost_too_high",
            &[("cost", &cost), ("max", &max)],
        ));
    }

    // `verify` 内部用常量时间比较重算出来的摘要，不能自己写 `==`。
    let matched = bcrypt::verify(text, hash)
        .map_err(|e| ToolError::Internal(format!("bcrypt 校验失败: {e}")))?;

    let mut meta = serde_json::Map::new();
    meta.insert("match".into(), json!(matched));
    meta.insert("cost".into(), json!(cost));
    Ok(json!({
        "output": crate::i18n::t(lang, if matched { MATCH_KEY } else { MISMATCH_KEY }),
        "meta": meta,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::collections::BTreeMap;

    /// py-bcrypt / OpenBSD 官方的定值测试向量（`bcrypt/tests/test_bcrypt.py`），
    /// 这里用 Python 的 `bcrypt` 4.2.0（同一份 OpenBSD C 代码）逐条复算过。
    /// `(明文, cost, 官方向量哈希)`，盐已经编码在哈希串里。
    const VECTORS: &[(&str, u32, &str)] = &[
        (
            "",
            6,
            "$2a$06$DCq7YPn5Rq63x1Lad4cll.TV4S6ytwfsfvkgY8jIucDrjc8deX1s.",
        ),
        (
            "a",
            6,
            "$2a$06$m0CrhHm10qJ3lXRY.5zDGO3rS2KdeeWLuGmsfGlMfOxih58VYVfxe",
        ),
        (
            "abc",
            6,
            "$2a$06$If6bvum7DFjUnE9p2uDeDu0YHzrHM6tf.iqN8.yx.jNN1ILEf7h0i",
        ),
        (
            "abcdefghijklmnopqrstuvwxyz",
            6,
            "$2a$06$.rCVZVOThsIa97pEDOxvGuRRgzG64bvtJ0938xuqzv18d3ZpQhstC",
        ),
        (
            "~!@#$%^&*()      ~!@#$%^&*()PNBFRD",
            6,
            "$2a$06$fPIsBO8qRqkjj273rfaOI.HtSV9jLDpTbZn782DC6/t7qT67P6FfO",
        ),
    ];

    /// 从一条完整的官方向量哈希里取出 16 字节的原始盐。
    ///
    /// 走 crate 自己的解析器而不是手搓 bcrypt base64：`bcrypt::BASE_64` 建的
    /// `GeneralPurpose` 默认 `RequireCanonical`，拿它直接解 22 字符的盐会因为
    /// 「尾部填充位非零」而报错。
    fn salt_of(hash: &str) -> [u8; 16] {
        hash.parse::<HashParts>()
            .expect("向量里的哈希是合法 bcrypt 哈希")
            .get_salt_raw()
    }

    /// 错误的键与插值参数。
    ///
    /// 断言**键**而不是文案：文案在语言包里，改文案不该把单测改红。
    /// 但参数还是要看一眼 —— 「cost 超限」这条错误里带着超了多少、上限是多少，
    /// 那是给用户看的关键信息。
    fn keyed(err: &ToolError) -> (&'static str, BTreeMap<String, String>) {
        match err {
            ToolError::InvalidKeyed { key, args } => (
                key,
                args.iter().cloned().collect::<BTreeMap<_, _>>(),
            ),
            other => panic!("应当是 InvalidKeyed 而不是 {other:?}"),
        }
    }

    /// 错误里有没有漏出明文。
    ///
    /// 键是语言包里的固定串，参数是有限的几个数字 —— 但这条断言守着的是
    /// 「万一哪天有人把明文塞进参数里」，所以键和参数一起查。
    fn leaks(err: &ToolError, secret: &str) -> bool {
        let (key, args) = keyed(err);
        key.contains(secret) || args.values().any(|v| v.contains(secret))
    }

    #[test]
    fn known_answer_vectors_match_the_reference_implementation() {
        // 盐是写死的，所以 `hash_with_salt` 的输出是确定的 —— 这才叫
        // known-answer test；拿自己 `hash()` 出来的值当期望值是循环论证。
        for (password, cost, expected) in VECTORS {
            let parts =
                bcrypt::hash_with_salt(password, *cost, salt_of(expected)).expect("cost 合法");
            assert_eq!(
                parts.format_for_version(bcrypt::Version::TwoA),
                *expected,
                "明文 {password:?} 与官方向量对不上"
            );
        }
    }

    #[test]
    fn reference_2a_hashes_verify_true_and_wrong_passwords_verify_false() {
        for (password, _, expected) in VECTORS {
            let out = compute(json!({
                "mode": "compare",
                "text": password,
                "hash": expected,
            }))
            .expect("合法输入不该报错");
            assert_eq!(out["output"], crate::i18n::t("en", MATCH_KEY));
            assert_eq!(out["meta"]["match"], true);

            let wrong = format!("{password}x");
            let out = compute(json!({
                "mode": "compare",
                "text": wrong,
                "hash": expected,
            }))
            .expect("合法输入不该报错");
            assert_eq!(out["output"], crate::i18n::t("en", MISMATCH_KEY));
            assert_eq!(out["meta"]["match"], false);
        }
    }

    #[test]
    fn hash_then_compare_round_trips() {
        let out = compute(json!({ "text": "s3cr3t", "cost": "4" })).unwrap();
        let digest = out["output"].as_str().expect("output 是字符串").to_string();
        assert!(digest.starts_with("$2b$04$"), "{digest}");
        assert_eq!(digest.len(), 60);
        assert_eq!(out["meta"]["cost"], 4);
        assert_eq!(out["meta"]["truncated"], false);

        let out = compute(json!({ "text": "s3cr3t", "hash": digest.clone() })).unwrap();
        assert_eq!(out["output"], crate::i18n::t("en", MATCH_KEY));
        assert_eq!(out["meta"]["match"], true);
        // cost 报的是哈希自带的那一档，不是表单里带的那个
        assert_eq!(out["meta"]["cost"], 4);
    }

    #[test]
    fn compare_direction_is_selected_by_the_hash_field_without_an_explicit_mode() {
        let digest = compute(json!({ "text": "abc", "cost": 4 })).unwrap()["output"]
            .as_str()
            .unwrap()
            .to_string();

        for payload in [
            json!({ "text": "abc", "hash": digest.clone() }),
            json!({ "text": "abc", "compare_hash": digest.clone() }),
            json!({ "text": "abc", "hash": digest.clone(), "cost": "10" }),
            json!({ "compare_text": "abc", "hash": digest.clone() }),
            json!({ "text": "abc", "hash": format!("{digest}\n") }),
            json!({ "mode": "compare", "text": "abc", "hash": digest }),
        ] {
            let out = compute(payload.clone()).expect("合法输入不该报错");
            assert_eq!(out["output"], crate::i18n::t("en", MATCH_KEY), "{payload}");
        }
    }

    #[test]
    fn explicit_hash_mode_ignores_a_stray_hash_field() {
        let digest = compute(json!({ "text": "abc", "cost": 4 })).unwrap()["output"]
            .as_str()
            .unwrap()
            .to_string();
        let out = compute(json!({ "mode": "hash", "text": "abc", "cost": "4", "hash": digest }))
            .expect("合法输入不该报错");
        assert!(out["output"].as_str().unwrap().starts_with("$2b$04$"));
    }

    #[test]
    fn malformed_hashes_are_rejected_without_panicking() {
        // 合法哈希恒为 60 个 ASCII 字节：$2b$ + 2 位 cost + $ + 22 盐 + 31 摘要
        let body = |cost: &str| format!("$2b${cost}${}", "a".repeat(53));
        let bad: Vec<String> = vec![
            // 完全不像哈希 / 长度不对
            "not-a-hash".into(),
            String::new(),
            "$2b$04$".into(),
            "$2b$04$short".into(),
            // 60 字节但前缀 / cost 位不是合法值
            "$2z$04$".to_string() + &"a".repeat(53),
            "$2b$xx$".to_string() + &"a".repeat(53),
            "$2b$4$".to_string() + &"a".repeat(53),
            // 长度对、字符却不在 bcrypt 的 base64 表（`.` `/` A-Z a-z 0-9）里
            format!("$2b$04${}", "!".repeat(53)),
            // cost 合法但跑不动 / 越界
            body(&format!("{:02}", MAX_USABLE_COST + 1)),
            body("99"),
            // 60 字节的非 ASCII：crate 的 split_hash 专门防了这种切穿 UTF-8 的情况
            "é".repeat(30),
        ];

        for h in bad {
            let err = compute(json!({ "mode": "compare", "text": "abc", "hash": &h }))
                .err()
                .unwrap_or_else(|| panic!("{h:?} 应当报错而不是被当成合法哈希"));
            let (key, _) = keyed(&err);
            assert!(
                key.starts_with("out.bcrypt.err."),
                "{h:?} 的错误键不对：{key}"
            );
            // 错误里不能有明文
            assert!(!leaks(&err, "abc"), "错误信息泄露了明文：{key}");
        }
    }

    #[test]
    fn the_error_never_echoes_the_hash_back() {
        // 一条带明显标记的坏哈希：错误里既不能出现标记，也不能出现整条哈希。
        const MARK: &str = "CANARYMARKER";
        let bad = format!("{MARK}");
        let err = compute(json!({ "mode": "compare", "text": "x", "hash": &bad })).unwrap_err();
        let (key, args) = keyed(&err);
        assert_eq!(key, "out.bcrypt.err.bad_hash");
        assert!(!key.contains(MARK), "{key}");
        assert!(!args.values().any(|v| v.contains(MARK)), "{args:?}");
        assert!(!args.values().any(|v| v.contains(&bad)), "{args:?}");
    }

    #[test]
    fn a_hash_whose_cost_is_out_of_range_is_refused() {
        // 拿一条**真的** bcrypt 哈希当底板，只把 cost 两位换掉 ——
        // 哈希的盐与摘要部分是 bcrypt 自带的 base64 变体，
        // 随手编一串 'a' 解不开，会被当成「格式不对」而不是「cost 越界」。
        let base = bcrypt::hash("x", 4).expect("生成一条基准哈希");
        let body = |cost: &str| {
            let mut s = base.clone();
            s.replace_range(4..6, cost);
            s
        };
        // cost 99：超出 bcrypt 规范允许的 4..=31
        let err = compute(json!({ "mode": "compare", "text": "x", "hash": body("99") })).unwrap_err();
        let (key, args) = keyed(&err);
        assert_eq!(key, "out.bcrypt.err.bad_cost");
        assert_eq!(args["cost"], "99");
        assert_eq!(args["min"], "4");
        assert_eq!(args["max"], "31");

        // cost 21：bcrypt 允许，但本工具不肯跑（公开接口上会占死 blocking 线程）
        let err = compute(json!({ "mode": "compare", "text": "x", "hash": body("21") })).unwrap_err();
        let (key, args) = keyed(&err);
        assert_eq!(key, "out.bcrypt.err.cost_too_high");
        assert_eq!(args["cost"], "21");
        assert_eq!(args["max"], "20");
    }

    #[test]
    fn a_well_formed_but_bogus_hash_is_a_mismatch_not_an_error() {
        // 60 字节、全是合法字符 —— 语法合法但不可能匹配任何口令，
        // 这时应当安静地回答「不匹配」，而不是报错
        let mut digest = compute(json!({ "text": "abc", "cost": "4" })).unwrap()["output"]
            .as_str()
            .unwrap()
            .to_string();
        // 把摘要末位换掉，这样长度 / 字符集 / 末位填充位都还合法，只有摘要本身变了。
        //
        // 不能无脑写成 `.`：bcrypt 的 23 字节摘要编成 31 个字符，末位只有 4 位有效
        // （实测共 16 种合法取值：`. 2 6 C G K O S W a e i m q u y`），随机摘要本来
        // 就落在 `.` 上的概率约 1/16。那样这次替换是空操作 —— 哈希没变，而口令
        // 「abc」本来就是对的，于是这条断言偶尔会测成「匹配」。实测 400 次里翻车
        // 26 次，按这个概率跑 CI 迟早红一次。所以按原字符二选一。
        let last = digest.as_bytes()[59] as char;
        let replacement = if last == '.' { 'e' } else { '.' };
        digest.replace_range(59..60, &replacement.to_string());
        assert_ne!(digest.as_bytes()[59] as char, last, "替换必须是有效改动");

        let out =
            compute(json!({ "text": "abc", "hash": digest })).expect("语法合法的哈希不该报错");
        assert_eq!(out["output"], crate::i18n::t("en", MISMATCH_KEY));
        assert_eq!(out["meta"]["match"], false);
        assert_eq!(out["meta"]["cost"], 4);
    }

    #[test]
    fn cost_is_clamped_not_rejected() {
        // 直接测夹取函数：真跑 cost 31 会永远跑不完。
        // 上限是 MAX_USABLE_COST 而不是规范的 31 —— 公开接口不能让人把
        // blocking 线程钉死，见 MAX_USABLE_COST 的说明。
        assert_eq!(cost_of(&json!({ "cost": 99 })), MAX_USABLE_COST);
        assert_eq!(cost_of(&json!({ "cost": "99" })), MAX_USABLE_COST);
        assert_eq!(cost_of(&json!({ "cost": 31 })), MAX_USABLE_COST);
        assert_eq!(cost_of(&json!({ "cost": "junk" })), 10);
        assert_eq!(cost_of(&json!({})), 10);
        assert_eq!(cost_of(&json!({ "cost": 0 })), 4);
        assert_eq!(cost_of(&json!({ "cost": -3 })), 10);
        assert_eq!(cost_of(&json!({ "cost": 12 })), 12);

        // 端到端：Number 字段在 app.js 里提交成 JSON number，在表单提交里是字符串
        let out = compute(json!({ "text": "x", "cost": 2 })).unwrap();
        assert_eq!(out["meta"]["cost"], 4);
        let out = compute(json!({ "text": "x", "cost": "4" })).unwrap();
        assert_eq!(out["meta"]["cost"], 4);
    }

    #[test]
    fn clamping_the_cost_is_reported_not_silent() {
        // 填了 31 却拿到一条 20 轮的哈希，不说一声的话会很难排查。
        // 这里只测纯函数：端到端那条要真跑 cost 20 的 bcrypt，debug 下得一分多钟。
        let w = cost_clamp_warning(Some(31)).expect("夹过了就该有提示");
        assert!(w.contains("31") && w.contains("20"), "{w}");
        assert!(cost_clamp_warning(Some(99)).is_some());
        // 没夹的时候不要平白多一条
        assert_eq!(cost_clamp_warning(Some(20)), None);
        assert_eq!(cost_clamp_warning(Some(4)), None);
        assert_eq!(cost_clamp_warning(None), None);

        // 端到端只确认「夹完的 cost 写进 meta」，跑最低档
        let out = compute(json!({ "text": "x", "cost": 2 })).unwrap();
        assert_eq!(out["meta"]["cost"], 4);
        assert!(out["meta"].get("warnings").is_none(), "{:?}", out["meta"]);
    }

    #[test]
    fn empty_text_is_allowed() {
        let out = compute(json!({ "text": "", "cost": "4" })).unwrap();
        let digest = out["output"].as_str().unwrap().to_string();
        assert_eq!(digest.len(), 60);
        assert!(digest.starts_with("$2b$04$"), "{digest}");

        // 必须是空串的真实哈希，不是别的什么东西
        assert!(bcrypt::verify("", &digest).unwrap());
        assert!(!bcrypt::verify("x", &digest).unwrap());
    }

    #[test]
    fn passwords_over_72_bytes_are_truncated_and_flagged() {
        let long = "a".repeat(100);
        let out = compute(json!({ "text": long, "cost": "4" })).unwrap();
        assert_eq!(out["meta"]["truncated"], true);
        assert!(out["meta"]["warnings"].is_array());

        // 截断到 72 字节后与 72 字节的原文等价（bcrypt 规范如此）
        let short = "a".repeat(72);
        let out = compute(json!({ "text": short, "cost": "4" })).unwrap();
        assert_eq!(out["meta"]["truncated"], false);
        let out = compute(json!({
            "text": long,
            "hash": out["output"].as_str().unwrap(),
        }))
        .unwrap();
        assert_eq!(out["output"], crate::i18n::t("en", MATCH_KEY));
    }

    #[test]
    fn unknown_mode_names_the_accepted_values() {
        let err = compute(json!({ "text": "abc", "mode": "sign" })).unwrap_err();
        let (key, args) = keyed(&err);
        assert_eq!(key, "out.bcrypt.err.unknown_mode");
        assert_eq!(args["mode"], "sign");
    }

    #[test]
    fn compare_without_a_hash_field_reports_the_missing_field() {
        let err = compute(json!({ "mode": "compare", "text": "abc" })).unwrap_err();
        let (key, _) = keyed(&err);
        assert_eq!(key, "out.bcrypt.err.missing_hash");
        assert!(!leaks(&err, "abc"), "错误信息泄露了明文：{key}");
    }

    #[test]
    fn errors_name_the_bad_field_and_never_the_plaintext() {
        for (payload, expected) in [
            (json!({ "text": "abc", "hash": "0" }), "out.bcrypt.err.bad_hash"),
            (
                json!({ "text": "abc", "hash": "not-a-hash" }),
                "out.bcrypt.err.bad_hash",
            ),
            (
                json!({ "text": "abc", "mode": "sign" }),
                "out.bcrypt.err.unknown_mode",
            ),
            (
                json!({ "text": "abc", "mode": "compare" }),
                "out.bcrypt.err.missing_hash",
            ),
        ] {
            let err = compute(payload).unwrap_err();
            let (key, _) = keyed(&err);
            assert_eq!(key, expected);
            assert!(!leaks(&err, "abc"), "错误信息泄露了明文：{key}");
        }
    }

    #[test]
    fn the_error_message_follows_the_requested_language() {
        // 语言不是工具决定的：工具只给出键，API 层按请求语言渲染。
        let err = compute(json!({ "mode": "compare", "text": "abc" })).unwrap_err();
        // 语言包里还没并进来时，localize 退回键本身 —— 这时断言跳过
        if !crate::i18n::has("zh-CN", "out.bcrypt.err.missing_hash") {
            return;
        }
        let en = err.localize("en");
        let zh = err.localize("zh-CN");
        assert_ne!(en, zh, "两种语言不该是同一句");
        assert!(!en.contains("out.bcrypt"), "英文界面不该露出键：{en}");
        assert!(!en.contains("缺少"), "英文界面不该露出中文：{en}");
    }
}
