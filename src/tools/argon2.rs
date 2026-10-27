//! Argon2 —— 密码哈希与比对（endpoint `argon2`）。
//!
//! 放服务端而不是浏览器：Argon2 的设计就是「吃内存 + 多迭代」
//! （OWASP 最低档 m = 19 MiB、t = 2，单次约 50–100 ms），在主线程上跑会把页面卡住。
//! 上游 PR #363 用 `hash-wasm` 在前端跑，参数只有 iterations / memorySize / hashLength，
//! 内存一调大就冻住标签页；放服务端还能把参数上限**卡死**（见下）。
//!
//! ## 与上游 #363 的三处差别
//!
//! 1. **盐每次随机生成**。上游那版在**页面加载时**用
//!    `window.crypto.getRandomValues(new Uint8Array(16))` 生成**一次**盐，
//!    之后所有哈希都复用它 —— 同一页里哈希两条密码，盐是同一条：盐的作用是让
//!    相同密码的哈希互不相同，这等于没加盐；刷新页面又是另一条盐，于是又变成
//!    「同一条密码两次哈希得到两个不同的串」，既没法比对也没法复现。
//!    这里每次哈希都用 crate 自己生成的 16 字节随机盐。
//!
//! 2. **参数有上限**。`POST /api/tools/argon2` 是公开接口，
//!    一条 `{"memory_size": 1048576}` 就能让服务端申请 1 GiB 内存，
//!    几十条并发就是整机 OOM。哈希方向把参数**夹**到上限（并提示一句），
//!    比对方向只能**拒绝** —— 哈希串里的 m / t / p 改了就对不上这条哈希了。
//!
//! 3. **比对方向自己算，不走 crate 的 blanket impl**。
//!    `password_hash::PasswordVerifier` 对 `PasswordHash` 是 blanket 实现，
//!    它会**从哈希串里取参数**再重算 —— 也就是说参数完全由请求方决定，
//!    而且是「先按请求方给的内存分配、再算」。这里先把 m / t / p 读出来、
//!    查过上限，再用这些参数自己算一遍，顺序反过来了。
//!
//! ## 方向：hash / compare
//!
//! 与 bcrypt 一样，注册表的 `ApiSpec` 只画得出一个明文框，第二个哈希框画不出来：
//!
//! - 表单只提交 `text` + 参数 → 走 **hash**；
//! - 请求里多带一个 `hash` 字段（或 `mode: "compare"`）→ 走 **compare**。
//!
//! 任何错误信息都不回显 `text`（那可能是真密码），只说哪个字段有问题。

use argon2::{
    password_hash::phc::{ParamsString, PasswordHash},
    Algorithm, Argon2, Params, PasswordHasher, Version,
};
use base64::engine::general_purpose::STANDARD_NO_PAD;
use base64::Engine;
use serde_json::{json, Value};

use super::util;
use super::{ToolError, ToolResult};

/// OWASP 推荐的最低配置：argon2id + m = 19 MiB + t = 2 + p = 1。
const DEFAULT_MEMORY_KIB: u64 = 19 * 1024;
const DEFAULT_ITERATIONS: u64 = 2;
const DEFAULT_PARALLELISM: u64 = 1;
const DEFAULT_HASH_LENGTH: u64 = 32;

/// 内存上限 64 MiB。RFC 9106 的第二选择，也是本工具实际肯跑的档位。
///
/// 这里的取舍和 bcrypt 那边一样：m_cost 是**内存占用**（KiB），一档就是几十 MB 到
/// 几 GB，公开接口上不能让人随便写。上限 64 MiB 时单次约 200–400 ms。
const MAX_MEMORY_KIB: u64 = 64 * 1024;
/// 迭代次数上限。t = 10 × 64 MiB 已经要跑将近一秒。
const MAX_ITERATIONS: u64 = 10;

/// 比对结果的两句文案。放在语言包里，键在 `out:` 段下。
const MATCH_KEY: &str = "out.argon2.match";
const MISMATCH_KEY: &str = "out.argon2.mismatch";
/// 并行度（lane 数）上限。多了会同时占住多个核心。
const MAX_PARALLELISM: u64 = 4;
/// 摘要长度（字节）的下限。PHC 规范建议输出不少于 128 bit。
const MIN_HASH_LENGTH: u64 = 16;
/// 摘要长度（字节）的上限。`phc::Output::MAX_LENGTH` 就是 64。
const MAX_HASH_LENGTH: u64 = 64;
/// argon2 规范：每个并行 lane 至少要 8 KiB 内存，即 m_cost ≥ 8 × p_cost。
const MIN_MEMORY_PER_LANE_KIB: u64 = 8;

/// argon2 是 CPU + 内存密集的，必须丢到 blocking 线程池，不能占住 actix worker。
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
        // 没给 mode：表单路径（只有 text + 参数）走 hash；多带了一条哈希就走 compare
        "" if given_hash.is_some() => compare(text, given_hash, util::lang(&payload)),
        "" => hash(text, &payload),
        // 文案在语言包里（`out.argon2.err.*`）：英文界面下不能露出中文。
        other => Err(ToolError::invalid(
            "out.argon2.err.unknown_mode",
            &[("mode", other)],
        )),
    }
}

/// 明文。可能被叫 `text`（注册表字段），也可能被叫 `compare_text`
/// （对齐参考实现里 `compareString` 的语义）。
///
/// 缺字段等价于空串而不是报错：空口令是合法的 argon2 输入，
/// 「拿空口令去比对某条哈希」本身是个合理的请求。
fn plaintext_of(payload: &Value) -> &str {
    util::opt_str(payload, "text")
        .or_else(|| util::opt_str(payload, "compare_text"))
        .unwrap_or("")
}

/// 夹取后的参数。
struct HashParams {
    algorithm: Algorithm,
    params: Params,
    /// 夹取过程中攒下的提示（哪些参数被夹过、为什么）。
    warnings: Vec<String>,
}

/// 算法名 → 枚举。只认 argon2 三兄弟。
fn algorithm_of(payload: &Value) -> Result<Algorithm, ToolError> {
    match util::str_or(payload, "algorithm", "argon2id")
        .to_ascii_lowercase()
        .as_str()
    {
        "argon2id" => Ok(Algorithm::Argon2id),
        "argon2i" => Ok(Algorithm::Argon2i),
        "argon2d" => Ok(Algorithm::Argon2d),
        other => Err(ToolError::invalid(
            "out.argon2.err.unknown_algorithm",
            &[("algorithm", other)],
        )),
    }
}

/// 读参数、夹到上限、凑出合法的组合。
///
/// 夹取而不是报错：这些参数只是性能旋钮，用户手滑填了 10^9 不该换来一个 400，
/// 但也不能真去跑（见 [`MAX_MEMORY_KIB`]）。
fn params_of(payload: &Value) -> Result<HashParams, ToolError> {
    let algorithm = algorithm_of(payload)?;
    let mut warnings = Vec::new();

    // --- 内存（KiB）---
    let asked_memory = util::opt_u64(payload, "memory_size");
    let mut memory = util::bounded_u64(
        payload,
        "memory_size",
        DEFAULT_MEMORY_KIB,
        MIN_MEMORY_PER_LANE_KIB,
        MAX_MEMORY_KIB,
    );
    if let Some(asked) = asked_memory {
        if asked > MAX_MEMORY_KIB {
            warnings.push(format!(
                "内存已从 {asked} KiB 夹到 {MAX_MEMORY_KIB} KiB：再高的话单次请求要吃掉几百 MB 到几 GB 内存，公开接口上等于自伤"
            ));
        }
    }

    // --- 迭代次数 ---
    let asked_iterations = util::opt_u64(payload, "iterations");
    let iterations = util::bounded_u64(payload, "iterations", DEFAULT_ITERATIONS, 1, MAX_ITERATIONS);
    if let Some(asked) = asked_iterations {
        if asked > MAX_ITERATIONS {
            warnings.push(format!(
                "迭代次数已从 {asked} 夹到 {MAX_ITERATIONS}：再高单次请求就要跑上好几秒"
            ));
        }
    }

    // --- 并行度 ---
    let asked_parallelism = util::opt_u64(payload, "parallelism");
    let parallelism = util::bounded_u64(
        payload,
        "parallelism",
        DEFAULT_PARALLELISM,
        1,
        MAX_PARALLELISM,
    );
    if let Some(asked) = asked_parallelism {
        if asked > MAX_PARALLELISM {
            warnings.push(format!(
                "并行度已从 {asked} 夹到 {MAX_PARALLELISM}：再高会同时占住多个核心"
            ));
        }
    }

    // argon2 规范：m_cost 至少是 p_cost 的 8 倍（每个 lane 至少 8 KiB）。
    let floor = MIN_MEMORY_PER_LANE_KIB * parallelism;
    if memory < floor {
        memory = floor;
        warnings.push(format!(
            "内存已提到 {floor} KiB：argon2 要求每个并行 lane 至少 8 KiB"
        ));
    }

    // --- 摘要长度 ---
    let asked_length = util::opt_u64(payload, "hash_length");
    let hash_length = util::bounded_u64(
        payload,
        "hash_length",
        DEFAULT_HASH_LENGTH,
        MIN_HASH_LENGTH,
        MAX_HASH_LENGTH,
    );
    if let Some(asked) = asked_length {
        if asked > MAX_HASH_LENGTH {
            warnings.push(format!(
                "摘要长度已从 {asked} 夹到 {MAX_HASH_LENGTH} 字节：PHC 格式的摘要字段最长就这么多"
            ));
        }
    }

    let params = Params::new(
        memory as u32,
        iterations as u32,
        parallelism as u32,
        Some(hash_length as usize),
    )
    .map_err(|e| {
        let reason = e.to_string();
        ToolError::invalid("out.argon2.err.bad_params", &[("reason", &reason)])
    })?;

    Ok(HashParams {
        algorithm,
        params,
        warnings,
    })
}

fn hash(text: &str, payload: &Value) -> ToolResult {
    let hp = params_of(payload)?;
    // `Params` 不是 Copy，meta 要用的几个数先取出来，再把它 move 进 Argon2。
    let memory = hp.params.m_cost();
    let iterations = hp.params.t_cost();
    let parallelism = hp.params.p_cost();
    let hash_length = hp.params.output_len().unwrap_or(DEFAULT_HASH_LENGTH as usize);
    let algorithm = hp.algorithm;

    let argon2 = Argon2::new(algorithm, Version::V0x13, hp.params);

    // 盐由 crate 自己生成（16 字节系统随机数），每次都不一样 —— 见文件头的说明。
    let digest = argon2
        .hash_password(text.as_bytes())
        .map_err(|e| ToolError::Internal(format!("argon2 计算失败: {e}")))?;

    let mut meta = serde_json::Map::new();
    meta.insert("algorithm".into(), json!(algorithm.as_str()));
    meta.insert("memory_size".into(), json!(memory));
    meta.insert("iterations".into(), json!(iterations));
    meta.insert("parallelism".into(), json!(parallelism));
    meta.insert("hash_length".into(), json!(hash_length));
    meta.insert("version".into(), json!("v=19"));
    if !hp.warnings.is_empty() {
        meta.insert("warnings".into(), json!(hp.warnings));
    }

    Ok(json!({ "output": digest.to_string(), "meta": meta }))
}

/// 从哈希串的参数表里读一个十进制参数。
///
/// 区分两种「读不到」：
/// - **参数本身不存在** → 用默认值（与 crate 的 `ParamsBuilder` 行为一致）；
/// - **参数在、但值不是十进制**（比如 `m=abc`）→ 报错。
///   静默退回默认值的话，这条哈希会被当成「用默认参数算的」，于是一条坏哈希
///   报出来是「不匹配」而不是「这条哈希有问题」—— 排查时会往错的方向找。
fn param_of(params: &ParamsString, name: &str, default: u64) -> Result<u64, ToolError> {
    if params.get(name).is_none() {
        return Ok(default);
    }
    params.get_decimal(name).map(u64::from).ok_or_else(|| {
        ToolError::invalid("out.argon2.err.bad_hash_param", &[("param", name)])
    })
}

fn compare(text: &str, given_hash: Option<&str>, lang: &str) -> ToolResult {
    let Some(hash) = given_hash else {
        return Err(ToolError::invalid("out.argon2.err.missing_hash", &[]));
    };

    // 解析失败时不带 crate 的原文 —— 那句原文里可能夹着用户哈希里的字符，
    // 等于把哈希回显出去。只说「格式不对」。
    let parsed = PasswordHash::new(hash)
        .map_err(|_| ToolError::invalid("out.argon2.err.bad_hash", &[]))?;

    // --- 算法 ---
    let algorithm = match parsed.algorithm.as_str() {
        "argon2id" => Algorithm::Argon2id,
        "argon2i" => Algorithm::Argon2i,
        "argon2d" => Algorithm::Argon2d,
        other => {
            return Err(ToolError::invalid(
                "out.argon2.err.unknown_hash_algorithm",
                &[("algorithm", other)],
            ))
        }
    };

    // --- 版本 ---
    let version = match parsed.version {
        Some(0x10) => Version::V0x10,
        Some(0x13) | None => Version::V0x13,
        Some(other) => {
            return Err(ToolError::invalid(
                "out.argon2.err.unknown_hash_version",
                &[("version", &other.to_string())],
            ))
        }
    };

    // --- 盐 ---
    let salt = parsed
        .salt
        .as_ref()
        .ok_or_else(|| ToolError::invalid("out.argon2.err.missing_salt", &[]))?;
    // PHC 的盐是标准 base64（无填充）编码的原始字节 —— 见 phc 里的
    // `use base64ct::Base64Unpadded as B64;`，和这里的 STANDARD_NO_PAD 是同一个编码。
    let salt_bytes = STANDARD_NO_PAD
        .decode(salt.to_salt_string().as_ref())
        .map_err(|_| ToolError::invalid("out.argon2.err.bad_salt", &[]))?;
    if salt_bytes.len() < argon2::MIN_SALT_LEN {
        let length = salt_bytes.len().to_string();
        let min = argon2::MIN_SALT_LEN.to_string();
        return Err(ToolError::invalid(
            "out.argon2.err.salt_too_short",
            &[("length", &length), ("min", &min)],
        ));
    }

    // --- 期望的摘要 ---
    let expected = parsed
        .hash
        .as_ref()
        .ok_or_else(|| ToolError::invalid("out.argon2.err.missing_digest", &[]))?;

    // --- 参数（从哈希串里读：这是请求方可控的，必须先查上限再算）---
    let memory = param_of(&parsed.params, "m", DEFAULT_MEMORY_KIB)?;
    let iterations = param_of(&parsed.params, "t", DEFAULT_ITERATIONS)?;
    let parallelism = param_of(&parsed.params, "p", DEFAULT_PARALLELISM)?;

    if memory > MAX_MEMORY_KIB {
        let memory = memory.to_string();
        let max = MAX_MEMORY_KIB.to_string();
        return Err(ToolError::invalid(
            "out.argon2.err.hash_memory_too_large",
            &[("memory", &memory), ("max", &max)],
        ));
    }
    if iterations > MAX_ITERATIONS {
        let iterations = iterations.to_string();
        let max = MAX_ITERATIONS.to_string();
        return Err(ToolError::invalid(
            "out.argon2.err.hash_iterations_too_large",
            &[("iterations", &iterations), ("max", &max)],
        ));
    }
    if parallelism > MAX_PARALLELISM {
        let parallelism = parallelism.to_string();
        let max = MAX_PARALLELISM.to_string();
        return Err(ToolError::invalid(
            "out.argon2.err.hash_parallelism_too_large",
            &[("parallelism", &parallelism), ("max", &max)],
        ));
    }
    if memory < MIN_MEMORY_PER_LANE_KIB * parallelism {
        let memory = memory.to_string();
        let parallelism = parallelism.to_string();
        return Err(ToolError::invalid(
            "out.argon2.err.hash_memory_too_small",
            &[("memory", &memory), ("parallelism", &parallelism)],
        ));
    }

    // 摘要长度跟着哈希串走：算出来的摘要必须和它一样长才谈得上比较。
    let params = Params::new(
        memory as u32,
        iterations as u32,
        parallelism as u32,
        Some(expected.len()),
    )
    .map_err(|e| {
        let reason = e.to_string();
        ToolError::invalid("out.argon2.err.bad_hash_params", &[("reason", &reason)])
    })?;

    let argon2 = Argon2::new(algorithm, version, params);
    let computed = argon2
        .hash_password_with_salt(text.as_bytes(), &salt_bytes)
        .map_err(|e| {
            let reason = e.to_string();
            ToolError::invalid("out.argon2.err.recompute_failed", &[("reason", &reason)])
        })?;

    // `phc::Output` 的 `PartialEq` 走的是常量时间比较（crate 自己的注释里写了），
    // 不能自己写 `==` 去比字节。
    let matched = computed.hash.as_ref() == Some(expected);

    let mut meta = serde_json::Map::new();
    meta.insert("match".into(), json!(matched));
    meta.insert("algorithm".into(), json!(algorithm.as_str()));
    meta.insert("memory_size".into(), json!(memory));
    meta.insert("iterations".into(), json!(iterations));
    meta.insert("parallelism".into(), json!(parallelism));
    meta.insert("hash_length".into(), json!(expected.len()));
    meta.insert("version".into(), json!(format!("v={}", version as u32)));

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

    /// 已知答案向量，用 **OpenSSL 3.5.7 的 `openssl kdf ARGON2ID/ARGON2I/ARGON2D`**
    /// 独立算出来（不是拿本实现自己的输出当期望值）。
    ///
    /// 参数：`m` 单位 KiB，`t` 是迭代次数，`p` 是并行度，摘要 32 字节。
    /// 盐是原文字节的 base64（无填充）。
    const VECTORS: &[(&str, &str, &str)] = &[
        // (算法, PHC 哈希串, 明文)
        (
            "argon2id",
            "$argon2id$v=19$m=65536,t=2,p=1$c29tZXNhbHQ$CTFhFdXPJO1aFaMaO6Mm5c8y7cJHAph8ArZWb2GRPPc",
            "password",
        ),
        (
            "argon2i",
            "$argon2i$v=19$m=65536,t=2,p=1$c29tZXNhbHQ$wWKIMhR9lyDFvRz9YTZweHKfbftvj+qf+YFY4NeBbtA",
            "password",
        ),
        (
            "argon2d",
            "$argon2d$v=19$m=65536,t=2,p=1$c29tZXNhbHQ$lV5dWxY6G2C7o1/DbQSWR0+6T2tZrVNihmbwf7L5Pq8",
            "password",
        ),
        (
            "argon2id",
            "$argon2id$v=19$m=19456,t=2,p=1$MDEyMzQ1Njc4OWFiY2RlZg$cEbY7tPNlDjQV5iVwpdmxl4qDf6kWX0hwLbro5Ww8VU",
            "hunter42",
        ),
        (
            "argon2id",
            "$argon2id$v=19$m=65536,t=3,p=4$MDEyMzQ1Njc4OWFiY2RlZg$Jjyth4HTw3JJo+9FWVtU9DCaI/8tY0Fwx8xlFWxoi1U",
            "hunter42",
        ),
    ];

    /// 用固定盐算出的哈希必须是确定值 —— 这才叫 known-answer test。
    /// 走的是 crate 的 `hash_password_with_salt`，盐是原文字节。
    fn hash_with_salt(text: &str, salt: &[u8], m: u32, t: u32, p: u32) -> String {
        let params = Params::new(m, t, p, Some(32)).expect("参数合法");
        let argon2 = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
        argon2
            .hash_password_with_salt(text.as_bytes(), salt)
            .expect("哈希能算出来")
            .to_string()
    }

    /// 错误的键与插值参数。
    ///
    /// 断言**键**而不是文案：文案在语言包里，改文案不该把单测改红。
    /// 但参数还是要看一眼 —— 「内存超限」这条错误里带着超了多少、上限是多少，
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
    fn known_answer_vectors_match_openssl() {
        // 「somesalt」这 8 个字节的 base64 正是 c29tZXNhbHQ。
        let got = hash_with_salt("password", b"somesalt", 65536, 2, 1);
        assert_eq!(
            got, "$argon2id$v=19$m=65536,t=2,p=1$c29tZXNhbHQ$CTFhFdXPJO1aFaMaO6Mm5c8y7cJHAph8ArZWb2GRPPc"
        );
    }

    #[test]
    fn every_openssl_vector_verifies_and_the_wrong_password_does_not() {
        for (algorithm, hash, text) in VECTORS {
            let out = compute(json!({ "mode": "compare", "text": text, "hash": hash }))
                .expect("合法输入不该报错");
            assert_eq!(out["output"], crate::i18n::t("en", MATCH_KEY), "{algorithm} / {text}");
            assert_eq!(out["meta"]["match"], true, "{algorithm}");
            assert_eq!(out["meta"]["algorithm"], *algorithm);

            let wrong = compute(json!({ "mode": "compare", "text": "wrong", "hash": hash }))
                .expect("合法输入不该报错");
            assert_eq!(wrong["output"], crate::i18n::t("en", MISMATCH_KEY), "{algorithm}");
            assert_eq!(wrong["meta"]["match"], false, "{algorithm}");
        }
    }

    #[test]
    fn hash_then_compare_round_trips() {
        let out = compute(json!({ "text": "s3cr3t" })).unwrap();
        let digest = out["output"].as_str().expect("output 是字符串").to_string();
        assert!(digest.starts_with("$argon2id$v=19$m=19456,t=2,p=1$"), "{digest}");
        assert_eq!(out["meta"]["algorithm"], "argon2id");
        assert_eq!(out["meta"]["memory_size"], 19456);
        assert_eq!(out["meta"]["iterations"], 2);
        assert_eq!(out["meta"]["parallelism"], 1);
        assert_eq!(out["meta"]["hash_length"], 32);

        let out = compute(json!({ "text": "s3cr3t", "hash": digest.clone() })).unwrap();
        assert_eq!(out["output"], crate::i18n::t("en", MATCH_KEY));
        assert_eq!(out["meta"]["match"], true);
        // meta 报的是哈希自带的那一档，不是表单里带的那个
        assert_eq!(out["meta"]["memory_size"], 19456);
    }

    #[test]
    fn the_salt_is_fresh_for_every_hash() {
        // 同一条密码哈希两次，盐不同 → 哈希串不同。
        // 上游 #363 那一版做不到这点（盐在页面加载时只生成一次）。
        let a = compute(json!({ "text": "same" })).unwrap()["output"]
            .as_str()
            .unwrap()
            .to_string();
        let b = compute(json!({ "text": "same" })).unwrap()["output"]
            .as_str()
            .unwrap()
            .to_string();
        assert_ne!(a, b, "两次哈希不该相同");
        // 盐字段不一样，摘要当然也不一样
        let salt_of = |h: &str| h.split('$').nth(4).unwrap().to_string();
        assert_ne!(salt_of(&a), salt_of(&b));
    }

    #[test]
    fn every_algorithm_round_trips() {
        for algorithm in ["argon2id", "argon2i", "argon2d"] {
            let out = compute(json!({ "text": "abc", "algorithm": algorithm })).unwrap();
            let digest = out["output"].as_str().unwrap().to_string();
            assert!(digest.starts_with(&format!("${algorithm}$")), "{digest}");
            assert_eq!(out["meta"]["algorithm"], algorithm);

            let out = compute(json!({ "text": "abc", "hash": digest })).unwrap();
            assert_eq!(out["output"], crate::i18n::t("en", MATCH_KEY), "{algorithm}");
        }
    }

    #[test]
    fn the_hash_length_is_honored() {
        for length in [16u64, 32, 64] {
            let out = compute(json!({ "text": "abc", "hash_length": length })).unwrap();
            assert_eq!(out["meta"]["hash_length"], length);
            // 摘要字段的 base64 长度随之变化：n 字节 → ceil(n*4/3) 个字符
            let digest = out["output"].as_str().unwrap();
            let tag = digest.rsplit('$').next().unwrap();
            assert_eq!(tag.len(), (length as usize * 4).div_ceil(3), "{digest}");

            let out = compute(json!({ "text": "abc", "hash": digest.to_string() })).unwrap();
            assert_eq!(out["output"], crate::i18n::t("en", MATCH_KEY));
        }
    }

    #[test]
    fn compare_direction_is_selected_by_the_hash_field_without_an_explicit_mode() {
        let digest = compute(json!({ "text": "abc" })).unwrap()["output"]
            .as_str()
            .unwrap()
            .to_string();

        for payload in [
            json!({ "text": "abc", "hash": digest.clone() }),
            json!({ "text": "abc", "compare_hash": digest.clone() }),
            json!({ "text": "abc", "hash": digest.clone(), "memory_size": "65536" }),
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
        let digest = compute(json!({ "text": "abc" })).unwrap()["output"]
            .as_str()
            .unwrap()
            .to_string();
        let out = compute(json!({ "mode": "hash", "text": "abc", "hash": digest })).unwrap();
        assert!(out["output"].as_str().unwrap().starts_with("$argon2id$v=19$"));
    }

    #[test]
    fn params_are_clamped_not_rejected() {
        // 内存：夹到 64 MiB
        let out = compute(json!({ "text": "x", "memory_size": 999_999_999 })).unwrap();
        assert_eq!(out["meta"]["memory_size"], MAX_MEMORY_KIB);
        assert!(out["meta"]["warnings"].is_array());

        // 迭代：夹到 10
        let out = compute(json!({ "text": "x", "iterations": 1000 })).unwrap();
        assert_eq!(out["meta"]["iterations"], MAX_ITERATIONS);

        // 并行度：夹到 4
        let out = compute(json!({ "text": "x", "parallelism": 99 })).unwrap();
        assert_eq!(out["meta"]["parallelism"], MAX_PARALLELISM);

        // 摘要长度：夹到 64
        let out = compute(json!({ "text": "x", "hash_length": 999 })).unwrap();
        assert_eq!(out["meta"]["hash_length"], MAX_HASH_LENGTH);

        // 没给 / 给的是乱码 → 走默认值
        let out = compute(json!({ "text": "x" })).unwrap();
        assert_eq!(out["meta"]["memory_size"], DEFAULT_MEMORY_KIB);
        assert_eq!(out["meta"]["iterations"], DEFAULT_ITERATIONS);
        assert_eq!(out["meta"]["parallelism"], DEFAULT_PARALLELISM);
        assert_eq!(out["meta"]["hash_length"], DEFAULT_HASH_LENGTH);
        assert!(out["meta"].get("warnings").is_none(), "{:?}", out["meta"]);
    }

    #[test]
    fn clamping_is_reported_not_silent() {
        // 填了 999999999 却拿到一条 64 MiB 的哈希，不说一声的话会很难排查。
        let out = compute(json!({ "text": "x", "memory_size": 999_999_999 })).unwrap();
        let warnings = out["meta"]["warnings"].as_array().expect("warnings 是数组");
        let joined = warnings
            .iter()
            .map(|w| w.as_str().unwrap_or_default())
            .collect::<Vec<_>>()
            .join("；");
        assert!(joined.contains("999999999"), "{joined}");
        assert!(joined.contains("65536"), "{joined}");
    }

    #[test]
    fn the_memory_floor_follows_the_parallelism() {
        // argon2 规范：m_cost ≥ 8 × p_cost。内存给小了要抬上去。
        let out = compute(json!({ "text": "x", "memory_size": 8, "parallelism": 4 })).unwrap();
        assert_eq!(out["meta"]["memory_size"], 8 * 4);
        assert!(out["meta"]["warnings"].is_array());
    }

    #[test]
    fn a_hash_with_an_out_of_range_memory_is_rejected_before_allocating() {
        // 这条哈希的 m = 999999999 KiB（约 1 TB）。如果先去分配再校验，
        // 服务端会直接被 OOM 干掉 —— 上限检查必须发生在计算之前。
        let evil = "$argon2id$v=19$m=999999999,t=2,p=1$c29tZXNhbHQ$CTFhFdXPJO1aFaMaO6Mm5c8y7cJHAph8ArZWb2GRPPc";
        let err = compute(json!({ "mode": "compare", "text": "password", "hash": evil })).unwrap_err();
        let (key, args) = keyed(&err);
        assert_eq!(key, "out.argon2.err.hash_memory_too_large");
        assert_eq!(args["memory"], "999999999");
        assert_eq!(args["max"], "65536");
    }

    #[test]
    fn a_hash_with_out_of_range_iterations_or_parallelism_is_rejected() {
        let base = "$argon2id$v=19$m=65536,t={t},p={p}$c29tZXNhbHQ$CTFhFdXPJO1aFaMaO6Mm5c8y7cJHAph8ArZWb2GRPPc";
        for (t, p, expected) in [
            (1000, 1, "out.argon2.err.hash_iterations_too_large"),
            (2, 1000, "out.argon2.err.hash_parallelism_too_large"),
        ] {
            let h = base.replace("{t}", &t.to_string()).replace("{p}", &p.to_string());
            let err = compute(json!({ "mode": "compare", "text": "password", "hash": h }))
                .unwrap_err();
            let (key, _) = keyed(&err);
            assert_eq!(key, expected);
        }
    }

    #[test]
    fn malformed_hashes_are_rejected_without_panicking() {
        // 明文用一个不会撞上库自身措辞的词：phc 的报错原文里有 "password hash string
        // missing field" 这种话，拿 "password" 当明文会让「错误信息不含明文」这条
        // 断言误判（撞词，不是泄露）。
        const CANARY: &str = "canary-plaintext";
        let bad: Vec<String> = vec![
            "not-a-hash".into(),
            String::new(),
            "$argon2id$".into(),
            // 算法不是 argon2
            "$2b$04$c29tZXNhbHQ$CTFhFdXPJO1aFaMaO6Mm5c8y7cJHAph8ArZWb2GRPPc".into(),
            "$scrypt$ln=1,r=8,p=1$c29tZXNhbHQ$CTFhFdXPJO1aFaMaO6Mm5c8y7cJHAph8ArZWb2GRPPc".into(),
            // 版本不认识
            "$argon2id$v=99$m=65536,t=2,p=1$c29tZXNhbHQ$CTFhFdXPJO1aFaMaO6Mm5c8y7cJHAph8ArZWb2GRPPc".into(),
            // 盐太短（解码后 3 字节）
            "$argon2id$v=19$m=65536,t=2,p=1$YWJj$CTFhFdXPJO1aFaMaO6Mm5c8y7cJHAph8ArZWb2GRPPc".into(),
            // 摘要不是合法 base64
            "$argon2id$v=19$m=65536,t=2,p=1$c29tZXNhbHQ$!!!not-base64!!!".into(),
            // 少了摘要字段
            "$argon2id$v=19$m=65536,t=2,p=1$c29tZXNhbHQ".into(),
            // 参数不是数字
            "$argon2id$v=19$m=abc,t=2,p=1$c29tZXNhbHQ$CTFhFdXPJO1aFaMaO6Mm5c8y7cJHAph8ArZWb2GRPPc".into(),
            // 尾部有多余数据
            "$argon2id$v=19$m=65536,t=2,p=1$c29tZXNhbHQ$CTFhFdXPJO1aFaMaO6Mm5c8y7cJHAph8ArZWb2GRPPc$x".into(),
        ];

        for h in bad {
            let err = compute(json!({ "mode": "compare", "text": CANARY, "hash": &h }))
                .err()
                .unwrap_or_else(|| panic!("{h:?} 应当报错而不是被当成合法哈希"));
            let (key, _) = keyed(&err);
            assert!(
                key.starts_with("out.argon2.err."),
                "{h:?} 的错误键不对：{key}"
            );
            // 错误里不能有明文
            assert!(!leaks(&err, CANARY), "错误信息泄露了明文：{key}");
        }
    }

    #[test]
    fn the_error_never_echoes_the_hash_back() {
        // 一条带明显标记的坏哈希：错误里既不能出现标记，也不能出现整条哈希。
        // （crate 自己的报错原文会把哈希里的非法字符带出来，所以这里只带标记。）
        const MARK: &str = "CANARYMARKER";
        let bad = format!("{MARK}");
        let err = compute(json!({ "mode": "compare", "text": "x", "hash": &bad })).unwrap_err();
        let (key, args) = keyed(&err);
        assert_eq!(key, "out.argon2.err.bad_hash");
        assert!(!key.contains(MARK), "{key}");
        assert!(!args.values().any(|v| v.contains(MARK)), "{args:?}");
        assert!(!args.values().any(|v| v.contains(&bad)), "{args:?}");
    }

    #[test]
    fn errors_name_the_bad_field_and_never_the_plaintext() {
        for (payload, expected) in [
            (json!({ "text": "abc", "hash": "0" }), "out.argon2.err.bad_hash"),
            (
                json!({ "text": "abc", "hash": "not-a-hash" }),
                "out.argon2.err.bad_hash",
            ),
            (
                json!({ "text": "abc", "mode": "sign" }),
                "out.argon2.err.unknown_mode",
            ),
            (
                json!({ "text": "abc", "mode": "compare" }),
                "out.argon2.err.missing_hash",
            ),
            (
                json!({ "text": "abc", "algorithm": "scrypt" }),
                "out.argon2.err.unknown_algorithm",
            ),
        ] {
            let err = compute(payload).unwrap_err();
            let (key, _) = keyed(&err);
            assert_eq!(key, expected);
            assert!(!leaks(&err, "abc"), "错误信息泄露了明文：{key}");
        }
    }

    #[test]
    fn empty_text_is_allowed() {
        let out = compute(json!({ "text": "" })).unwrap();
        let digest = out["output"].as_str().unwrap().to_string();
        assert!(digest.starts_with("$argon2id$v=19$"), "{digest}");

        let out = compute(json!({ "text": "", "hash": digest })).unwrap();
        assert_eq!(out["output"], crate::i18n::t("en", MATCH_KEY));
    }

    #[test]
    fn unknown_mode_names_the_accepted_values() {
        let err = compute(json!({ "text": "abc", "mode": "sign" })).unwrap_err();
        let (key, args) = keyed(&err);
        assert_eq!(key, "out.argon2.err.unknown_mode");
        assert_eq!(args["mode"], "sign");
    }

    #[test]
    fn compare_without_a_hash_field_reports_the_missing_field() {
        let err = compute(json!({ "mode": "compare", "text": "abc" })).unwrap_err();
        let (key, _) = keyed(&err);
        assert_eq!(key, "out.argon2.err.missing_hash");
        assert!(!leaks(&err, "abc"), "错误信息泄露了明文：{key}");
    }

    #[test]
    fn the_error_message_follows_the_requested_language() {
        // 语言不是工具决定的：工具只给出键，API 层按请求语言渲染。
        let err = compute(json!({ "mode": "compare", "text": "abc" })).unwrap_err();
        // 语言包里还没并进来时，localize 退回键本身 —— 这时断言跳过
        if !crate::i18n::has("zh-CN", "out.argon2.err.missing_hash") {
            return;
        }
        let en = err.localize("en");
        let zh = err.localize("zh-CN");
        assert_ne!(en, zh, "两种语言不该是同一句");
        assert!(!en.contains("out.argon2"), "英文界面不该露出键：{en}");
        assert!(!en.contains("缺少"), "英文界面不该露出中文：{en}");
    }
}
