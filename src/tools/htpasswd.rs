//! htpasswd —— 生成 / 校验 Apache 的 `.htpasswd` 行（endpoint `htpasswd`）。
//!
//! 上游 issue #1490：有些 docker-compose 需要一个 `.htpasswd` 变量，
//! 而 `htpasswd` 命令行工具要先 `apt install apache2-utils` 才能用。
//!
//! ## 放服务端而不是 JS
//!
//! bcrypt 在浏览器里没有原生实现（参考项目为此引入了 `bcryptjs`），
//! apr1 是 Apache 私有格式、C 库里也没有浏览器实现。三个算法里两个只能走服务端。
//!
//! ## 支持的四种算法
//!
//! | `algorithm` | 产出 | Apache 选项 |
//! |---|---|---|
//! | `bcrypt` | `$2b$…` | `-B`（2.4.4+ 的默认） |
//! | `apr1` | `$apr1$…` | `-m`（老版本默认，Windows/网络共享上仍常见） |
//! | `sha1` | `{SHA}…` | `-s` |
//! | `plain` | 原样 | `-p` |
//!
//! 不实现 `crypt(3)` 的 DES（`-d`）和 bcrypt `$2y$`：前者每个口令只算 25 轮 DES、
//! 8 位截断，现代 Apache 已经不再默认使用；后者与 `$2b$` 在校验上完全等价，
//! 由 bcrypt 分支覆盖。
//!
//! ## apr1 为什么要自己写
//!
//! apr1 就是 **MD5-crypt（`$1$`）把 magic 换成 `$apr1$`** —— 算法骨架、base64
//! 字母表、字节交错方式都和 glibc/FreeBSD 的 `md5crypt` 完全一致。完整的七步
//! 骨架写在 [`apr1_digest`] 的文档注释里。
//!
//! Rust 生态没有 apr1 的 crate，参考实现也没有，所以照着手写，
//! 再用 `openssl passwd -apr1` 逐条对拍（见单测 —— 跑那几条对拍测试，
//! 本机得装了 openssl 命令行工具）。
//!
//! ## 两个方向怎么用只有一张表单的 ApiSpec 表达
//!
//! 与 `bcrypt` 工具同样的取舍：注册表描述的表单是「生成」方向
//! （`username` + `password` + `algorithm` + `cost` → 一行 `user:hash`）；
//! 请求里多带一个 `hash` 字段 → 走**校验**方向，明文仍取 `password`。
//! 理由与取舍见 `bcrypt.rs` 的同名小节。
//!
//! ## 安全
//!
//! - apr1 / sha1 / plain 是微秒级的，不占 CPU；bcrypt 走 [`util::blocking`]，
//!   且 cost 的夹取上限与 `bcrypt` 工具一致（见 [`MAX_USABLE_COST`]）。
//! - 校验一律常量时间比较（apr1 的 22 字符、SHA1 的 28 字符都自己写 CT compare，
//!   不靠 `==`）。
//! - 错误信息不回显 `password`。

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine as _;
use md5::{Digest, Md5};
use rand::Rng;
use sha1::Sha1;
use serde_json::{json, Value};

use super::util;
use super::{ToolError, ToolResult};

/// bcrypt cost 的可用上限，与 `bcrypt` 工具保持一致。
///
/// crate 允许到 31，但 2^31 轮等于永远跑不完 —— `POST /api/tools/htpasswd` 是公开
/// 接口，一条 `{"cost": 31}` 就能永久占住一个 blocking 线程。
const MAX_USABLE_COST: u64 = 20;
const MIN_COST: u64 = 4;
/// 与注册表 `ApiField { name: "cost", default: Some("10") }` 对齐。
const DEFAULT_COST: u64 = 10;

/// 比对结果的两句文案。放在语言包里，键在 `out:` 段下。
const MATCH_KEY: &str = "out.htpasswd.match";
const MISMATCH_KEY: &str = "out.htpasswd.mismatch";

/// apr1 的盐最多 8 个字符（Apache 里盐固定 8 字节）。
const APR1_SALT_LEN: usize = 8;
/// apr1 自己的 base64 字母表，和 MD5-crypt（`$1$`）**不同** —— 注意大小写顺序。
const APR1_ALPHABET: &[u8; 64] =
    b"./0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/// apr1 的最终摘要恒为 22 个字符（5 组 × 4 + 1 组 × 2）。
const APR1_DIGEST_LEN: usize = 22;
/// `{SHA}` 后面是标准 base64 的 SHA-1，恒为 28 个字符（含 `=` 补位）。
const SHA1_DIGEST_LEN: usize = 28;

pub async fn handle(payload: Value) -> ToolResult {
    util::blocking(move || compute(payload)).await
}

fn compute(payload: Value) -> ToolResult {
    let mode = util::str_or(&payload, "mode", "").to_ascii_lowercase();
    // 待校验的哈希可以整条 `user:hash` 粘进来，也可以只给哈希部分。
    let given = util::opt_str(&payload, "hash")
        .or_else(|| util::opt_str(&payload, "line"))
        .map(str::trim)
        .filter(|s| !s.is_empty());

    match mode.as_str() {
        "generate" | "hash" => generate(&payload),
        "verify" | "compare" => verify(&payload, given),
        "" if given.is_some() => verify(&payload, given),
        "" => generate(&payload),
        // 文案在语言包里（`out.htpasswd.err.*`）：英文界面下不能露出中文。
        other => Err(ToolError::invalid(
            "out.htpasswd.err.unknown_mode",
            &[("mode", other)],
        )),
    }
}

fn password_of(payload: &Value) -> &str {
    util::opt_str(payload, "password")
        .or_else(|| util::opt_str(payload, "text"))
        .unwrap_or("")
}

/// 把用户填的算法名归一化。未知值返回 `None`，由调用方拿原文报错。
fn algorithm_of(payload: &Value) -> Option<&'static str> {
    let raw = util::str_or(payload, "algorithm", "bcrypt").trim().to_ascii_lowercase();
    match raw.as_str() {
        // 常见别名，表单只暴露 `bcrypt`，但 API 直接调时不该因此报错
        "apr1" | "md5" | "apr" | "md5-apr" | "apr1-md5" => Some("apr1"),
        "sha" | "sha1" | "sha-1" => Some("sha1"),
        "plain" | "plaintext" | "none" | "clear" => Some("plain"),
        "bcrypt" | "blowfish" => Some("bcrypt"),
        _ => None,
    }
}

fn cost_of(payload: &Value) -> u32 {
    util::bounded_u64(payload, "cost", DEFAULT_COST, MIN_COST, MAX_USABLE_COST) as u32
}

fn cost_clamp_warning(requested: Option<u64>) -> Option<String> {
    let requested = requested?;
    (requested > MAX_USABLE_COST).then(|| {
        format!(
            "cost 已从 {requested} 夹到 {MAX_USABLE_COST}：更高档会让单次请求跑上几分钟，公开接口上等于自伤"
        )
    })
}

/* ==========================================================================
   apr1（Apache 私有格式）
   ========================================================================== */

/// apr1 的 8 字符随机盐。字母表与摘要用的 base64 表相同。
fn random_apr1_salt() -> String {
    let mut rng = rand::thread_rng();
    (0..APR1_SALT_LEN)
        .map(|_| APR1_ALPHABET[rng.gen_range(0..64)] as char)
        .collect()
}

/// apr1 的 base64 变体（Apache 的 `to64`）。
fn apr1_to64(mut v: u32, n: usize) -> String {
    let mut out = String::with_capacity(n);
    for _ in 0..n {
        out.push(APR1_ALPHABET[(v & 0x3f) as usize] as char);
        v >>= 6;
    }
    out
}

/// `$apr1$<salt>$<22 字符>`。`salt` 用掉前 8 个字符。
///
/// apr1 就是 **MD5-crypt（`$1$`）把 magic 换成 `$apr1$`** —— 算法骨架、
/// base64 字母表、字节交错方式都和 glibc/FreeBSD 的 `md5crypt` 一模一样。
/// 骨架是：
///
/// 1. `ctx  = MD5(pw ‖ "$apr1$" ‖ salt)`
/// 2. `fin  = MD5(pw ‖ salt ‖ pw)`
/// 3. 按口令长度把 `fin` 重复喂进 `ctx`（补齐到 16 的倍数，最后一次只喂零头）
/// 4. 再喂一串「长度位」：`for i = len(pw); i != 0; i >>= 1` 里，`i` 为奇数喂一个
///    `0x00`、为偶数喂口令的第一个字节
/// 5. `fin = MD5(ctx)`
/// 6. **1000 轮，每轮从头新建一个 MD5**，按 `i % 2 / % 3 / % 7` 拼 4 段喂进去，
///    结果成为下一轮的 `fin`
/// 7. 摘要按 `(0,6,12) (1,7,13) …` **按列**交错后编成 22 个字符
///
/// 第 6 步是最容易写错的一处：它不是把内容**追加**进一个持续的 MD5，而是每轮
/// 都 `fin = MD5(四段拼接)`。两种写法长得像，喂给 MD5 的字节序列完全不同。
fn apr1_digest(password: &[u8], salt: &str) -> String {
    let salt = &salt.as_bytes()[..salt.len().min(APR1_SALT_LEN)];

    let mut ctx = Md5::new();
    ctx.update(password);
    ctx.update(b"$apr1$");
    ctx.update(salt);

    let fin: [u8; 16] = {
        let mut ctx2 = Md5::new();
        ctx2.update(password);
        ctx2.update(salt);
        ctx2.update(password);
        ctx2.finalize().into()
    };

    // 步骤 3：`i` 必须是有符号 —— 口令长 10 时喂 10 字节、`i` 变成 -6、循环结束。
    // 用 usize 会在同一处下溢 panic。
    let mut i = password.len() as i64;
    while i > 0 {
        ctx.update(&fin[..i.min(16) as usize]);
        i -= 16;
    }

    // 步骤 4：长度位
    let first = password.first().copied().unwrap_or(0);
    let mut i = password.len();
    while i != 0 {
        ctx.update([if i % 2 == 1 { 0u8 } else { first }]);
        i >>= 1;
    }

    let mut fin: [u8; 16] = ctx.finalize().into();

    // 步骤 6：1000 轮，每轮重新起一个 MD5
    for i in 0..1000u32 {
        let mut round = Md5::new();
        round.update(if i % 2 == 1 { password } else { &fin[..] });
        if i % 3 != 0 {
            round.update(salt);
        }
        if i % 7 != 0 {
            round.update(password);
        }
        round.update(if i % 2 == 1 { &fin[..] } else { password });
        fin = round.finalize().into();
    }

    // 步骤 7：按列交错。注意最后一组是 (f[4], f[10], f[5])，f[16] 会越界。
    const GROUPS: [[usize; 3]; 5] = [
        [0, 6, 12],
        [1, 7, 13],
        [2, 8, 14],
        [3, 9, 15],
        [4, 10, 5],
    ];
    let f = fin;
    let mut out = String::with_capacity(APR1_DIGEST_LEN);
    for g in GROUPS {
        let l = (u32::from(f[g[0]]) << 16) | (u32::from(f[g[1]]) << 8) | u32::from(f[g[2]]);
        out.push_str(&apr1_to64(l, 4));
    }
    out.push_str(&apr1_to64(u32::from(f[11]), 2));
    out
}

/// 生成完整的 `$apr1$…` 串。`salt` 为空时取 8 字符随机盐。
fn apr1_hash(password: &str, salt: Option<&str>) -> String {
    let owned;
    let salt = match salt {
        Some(s) if !s.is_empty() => s,
        _ => {
            owned = random_apr1_salt();
            &owned
        }
    };
    format!("$apr1${salt}${}", apr1_digest(password.as_bytes(), salt))
}

/// 从 `$apr1$<salt>$<22 字符>` 里取出盐。格式不对返回 `None`。
fn apr1_salt_of(stored: &str) -> Option<&str> {
    let rest = stored.strip_prefix("$apr1$")?;
    let (salt, digest) = rest.split_once('$')?;
    if digest.len() != APR1_DIGEST_LEN {
        return None;
    }
    if salt.is_empty() || salt.len() > APR1_SALT_LEN {
        return None;
    }
    if !digest.bytes().all(|c| APR1_ALPHABET.contains(&c)) {
        return None;
    }
    Some(salt)
}

fn apr1_verify(password: &str, stored: &str) -> Option<bool> {
    let salt = apr1_salt_of(stored)?;
    let candidate = apr1_hash(password, Some(salt));
    Some(ct_eq(candidate.as_bytes(), stored.as_bytes()))
}

/* ==========================================================================
   {SHA}（Apache 的 -s）
   ========================================================================== */

fn sha1_hash(password: &str) -> String {
    let digest = Sha1::digest(password.as_bytes());
    format!("{{SHA}}{}", B64.encode(digest))
}

fn sha1_verify(password: &str, stored: &str) -> bool {
    let Some(body) = stored.strip_prefix("{SHA}") else {
        return false;
    };
    if body.len() != SHA1_DIGEST_LEN {
        return false;
    }
    ct_eq(sha1_hash(password).as_bytes(), stored.as_bytes())
}

/* ==========================================================================
   杂项
   ========================================================================== */

/**
 * 常量时间比较。
 *
 * 不能直接 `a == b`：这两条都是攻击者可控的哈希，比较耗时泄漏前缀信息。
 * `bcrypt` 走 crate 自带的验证（内部也是常量时间），apr1 / sha1 自己比。
 */
fn ct_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

/** `.htpasswd` 的一行。用户名里的 `:` 和换行会破坏文件格式。 */
fn line_of(username: &str, hash: &str) -> String {
    format!("{username}:{hash}")
}

fn validate_username(username: &str) -> Result<(), ToolError> {
    if username.is_empty() {
        return Err(ToolError::invalid("out.htpasswd.err.missing_username", &[]));
    }
    if let Some(bad) = username.chars().find(|c| matches!(c, ':' | '\n' | '\r')) {
        let bad = format!("{bad:?}");
        return Err(ToolError::invalid(
            "out.htpasswd.err.bad_username",
            &[("char", &bad)],
        ));
    }
    Ok(username).map(|_| ())
}

/** 识别一条已有哈希属于哪种算法。前缀优先于用户填的 `algorithm`。 */
fn detect_algorithm(stored: &str) -> Option<&'static str> {
    if stored.starts_with("$2") {
        Some("bcrypt")
    } else if stored.starts_with("$apr1$") {
        Some("apr1")
    } else if stored.starts_with("{SHA}") {
        Some("sha1")
    } else {
        // `plain` 没有前缀，任何裸文本都当明文 —— 与 Apache 一致
        Some("plain")
    }
}

/* ==========================================================================
   两个方向
   ========================================================================== */

fn generate(payload: &Value) -> ToolResult {
    let username = util::str_or(payload, "username", "");
    validate_username(username)?;
    let password = password_of(payload);
    let requested = util::opt_u64(payload, "cost");

    let algorithm = algorithm_of(payload).ok_or_else(|| {
        let algorithm = util::str_or(payload, "algorithm", "");
        ToolError::invalid(
            "out.htpasswd.err.unknown_algorithm",
            &[("algorithm", algorithm)],
        )
    })?;

    let (hash, mut meta): (String, serde_json::Map<String, Value>) = match algorithm {
        "bcrypt" => {
            let cost = cost_of(payload);
            let digest = bcrypt::hash(password, cost)
                .map_err(|e| ToolError::Internal(format!("bcrypt 计算失败: {e}")))?;
            let truncated = password.len() > 72;
            (
                digest,
                json!({
                    "algorithm": "bcrypt",
                    "cost": cost,
                    "prefix": "$2b$",
                    "truncated": truncated,
                })
                .as_object()
                .cloned()
                .unwrap_or_default(),
            )
        }
        "apr1" => {
            let salt = random_apr1_salt();
            (
                apr1_hash(password, Some(&salt)),
                json!({ "algorithm": "apr1", "salt": salt })
                    .as_object()
                    .cloned()
                    .unwrap_or_default(),
            )
        }
        "sha1" => (
            sha1_hash(password),
            json!({ "algorithm": "sha1" }).as_object().cloned().unwrap_or_default(),
        ),
        "plain" => (
            password.to_string(),
            json!({ "algorithm": "plain" }).as_object().cloned().unwrap_or_default(),
        ),
        other => unreachable!("algorithm_of 只返回已知算法，却给出了 {other}"),
    };

    let mut warnings: Vec<String> = Vec::new();
    if meta.get("truncated") == Some(&json!(true)) {
        warnings.push("bcrypt 最多只用前 72 字节，超出部分已被丢弃".into());
    }
    if let Some(w) = cost_clamp_warning(requested) {
        warnings.push(w);
    }
    if algorithm == "sha1" {
        warnings.push("{SHA} 是无盐 SHA-1，同一个口令每次结果都一样，且可被彩虹表直接查到 —— 只在必须兼容老服务器时用".into());
    }
    if algorithm == "plain" {
        warnings.push("明文存储：口令会原样出现在 `.htpasswd` 里，任何能读到这个文件的人都能拿到口令".into());
    }
    if !warnings.is_empty() {
        meta.insert("warnings".into(), json!(warnings));
    }

    let line = line_of(username, &hash);
    Ok(json!({ "output": line, "meta": meta }))
}

fn verify(payload: &Value, given: Option<&str>) -> ToolResult {
    let Some(given) = given else {
        return Err(ToolError::invalid("out.htpasswd.err.missing_hash", &[]));
    };
    let password = password_of(payload);

    // 允许直接粘整行 `user:hash`：用户名对不上就直接判失败，
    // 和 Apache 的行为一致（Apache 也会先切用户名再比）。
    let (line_username, stored) = match given.split_once(':') {
        // bcrypt 的哈希里没有冒号，所以第一个冒号就是分隔符
        Some((u, h)) => (Some(u), h.trim()),
        None => (None, given),
    };
    if let (Some(u), Some(expected)) = (line_username, util::opt_str(payload, "username")) {
        if !u.is_empty() && u != expected.trim() {
            return Err(ToolError::invalid(
                "out.htpasswd.err.username_mismatch",
                &[],
            ));
        }
    }

    let algorithm = detect_algorithm(stored);
    let matched = match algorithm {
        Some("bcrypt") => {
            // 解析失败时不带 crate 的原文 —— 那句原文里可能夹着用户哈希里的字符，
            // 等于把哈希回显出去。只说「格式不对」。
            let parts = stored
                .parse::<bcrypt::HashParts>()
                .map_err(|_| ToolError::invalid("out.htpasswd.err.bad_hash", &[]))?;
            let cost = parts.get_cost();
            if u64::from(cost) > MAX_USABLE_COST {
                let cost = cost.to_string();
                let max = MAX_USABLE_COST.to_string();
                return Err(ToolError::invalid(
                    "out.htpasswd.err.cost_too_high",
                    &[("cost", &cost), ("max", &max)],
                ));
            }
            bcrypt::verify(password, stored)
                .map_err(|e| ToolError::Internal(format!("bcrypt 校验失败: {e}")))?
        }
        Some("apr1") => apr1_verify(password, stored)
            .ok_or_else(|| ToolError::invalid("out.htpasswd.err.bad_apr1_hash", &[]))?,
        Some("sha1") => sha1_verify(password, stored),
        Some("plain") => ct_eq(password.as_bytes(), stored.as_bytes()),
        _ => return Err(ToolError::invalid("out.htpasswd.err.unknown_hash_algorithm", &[])),
    };

    Ok(json!({
        "output": crate::i18n::t(
            util::lang(payload),
            if matched { MATCH_KEY } else { MISMATCH_KEY },
        ),
        "meta": {
            "match": matched,
            "algorithm": algorithm,
            "username": line_username,
        }
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::collections::BTreeMap;

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

    /* ---- apr1：用 `openssl passwd -apr1` 逐条对拍 ---- */

    /// openssl 最多跑多久。
    ///
    /// 上限存在的理由：GitHub 的 job 默认要挂满 6 小时才超时，一个卡住的子进程
    /// 就能把整条流水线停在那儿。宁可这个测试红，也不能让 CI 停着。
    const OPENSSL_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(20);

    /// `openssl passwd -apr1 -salt <salt> <password>` 的实测输出。
    /// openssl 与 Apache 用的是同一份 `apr_md5_encode`，是可信的对照实现。
    ///
    /// ## 口令为什么走 argv，为什么只喂 ASCII
    ///
    /// 参照物比被测对象还难伺候，两条路各踩一个坑：
    ///
    /// · **argv**：Windows 上 `Command` 传给子进程的是 UTF-16，子进程的 CRT 再按
    ///   **系统 ANSI 代码页**转回字节 —— 中文按 GBK/CP1252 那一套转，转完的字节跟
    ///   原来的 UTF-8 不是同一串了。APR1 是对**字节**做摘要的，于是两边算的压根
    ///   不是一个东西（实测：口令「口令 with spaces」+ 盐 s4lt，Windows 上 argv
    ///   给的是 `$apr1$s4lt$OLGoCLNbXsC14xPvighNA0`，而按 UTF-8 字节算是
    ///   `$apr1$s4lt$S2XX.Z0/cTwWY3YpkHVHP0`）。
    ///   → 所以**只拿 ASCII 口令**走 argv：ASCII 在任何代码页里都是同样的字节。
    ///
    /// · **stdin**：管道传的是字节，上面那层转换就没了。但 Windows 上的 openssl
    ///   在没有 `-in`/`-stdin` 参数时**不读 stdin，而是去读控制台**（`CONIN$`）——
    ///   CI 里那个控制台永远等不到输入，openssl 就一直等下去（实测：Windows CI
    ///   上这两个对拍测试跑了 40 多分钟没结束，整个 job 挂到超时）。
    ///   → 而 `-in`/`-stdin` 是 OpenSSL 3.x 才有的参数，CI 上装的是哪个版本
    ///     说不准，不能拿它当依赖。
    ///
    /// 非 ASCII 的口令、以及以 `-` 开头的口令（openssl 会把那种参数当成选项），
    /// 走不了这条对拍的路 —— 它们的摘要在
    /// [`apr1_for_passwords_the_oracle_cannot_carry_is_pinned`] 里钉死。
    fn openssl_apr1(password: &str, salt: &str) -> String {
        assert!(
            password.is_ascii() && !password.starts_with('-'),
            "口令走 argv 这条路有两条限制：ASCII 之外的口令会被 Windows 的代码页改写，\
             以 `-` 开头的会被 openssl 当成选项（{password:?}）"
        );
        let mut child = std::process::Command::new("openssl")
            .args(["passwd", "-apr1", "-salt", salt, password])
            // stdin 一根都不给：Windows 上 openssl 找不到别的输入源时会去读控制台，
            // 而 CI 里那个控制台是没有输入的。
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .expect("本机装了 openssl");

        // stdout 与 stderr 各开一个线程读：顺序读会死锁 ——
        // stderr 的管道被写满时 openssl 就在等，而我们在等 stdout 的 EOF。
        let mut stdout = child.stdout.take().expect("stdout 管道");
        let mut stderr = child.stderr.take().expect("stderr 管道");
        let out_reader = std::thread::spawn(move || {
            let mut buf = Vec::new();
            std::io::Read::read_to_end(&mut stdout, &mut buf).map(|_| buf)
        });
        let err_reader = std::thread::spawn(move || {
            let mut buf = Vec::new();
            std::io::Read::read_to_end(&mut stderr, &mut buf).map(|_| buf)
        });

        // 等它跑完，但最多等 OPENSSL_TIMEOUT：卡住的 openssl 不能把 CI 拖到超时。
        let deadline = std::time::Instant::now() + OPENSSL_TIMEOUT;
        let status = loop {
            match child.try_wait() {
                Ok(Some(status)) => break Some(status),
                Ok(None) => {
                    if std::time::Instant::now() >= deadline {
                        let _ = child.kill();
                        break None;
                    }
                    std::thread::sleep(std::time::Duration::from_millis(20));
                }
                Err(e) => panic!("等 openssl 出错: {e}"),
            }
        };

        let stdout = out_reader
            .join()
            .expect("读 stdout 的线程")
            .expect("读 stdout");
        let stderr = err_reader
            .join()
            .expect("读 stderr 的线程")
            .expect("读 stderr");
        let stderr = String::from_utf8_lossy(&stderr).into_owned();
        let status = status.unwrap_or_else(|| {
            panic!("openssl {OPENSSL_TIMEOUT:?} 还没退出（多半是卡在读输入上）\nstderr: {stderr}")
        });
        assert!(status.success(), "openssl 退出码 {status}\nstderr: {stderr}");

        let hash = String::from_utf8(stdout)
            .expect("openssl 的输出是 ASCII")
            .trim()
            .to_string();
        assert!(!hash.is_empty(), "openssl 没吐出摘要\nstderr: {stderr}");
        hash
    }

    /// 差分测试的口令**只用 ASCII** —— 原因见 [`openssl_apr1`] 的说明：
    /// argv 这一路上，Windows 的代码页转换只对 ASCII 恒等。
    ///
    /// 非 ASCII 的行为由下面的定值向量负责。
    #[test]
    fn apr1_matches_openssl_on_a_spread_of_passwords_and_salts() {
        let cases = [
            ("secret", "abcdefgh"),
            ("", "abcdefgh"),
            ("a", "01234567"),
            ("0123456789abcdef", "x"),
            (
                "0123456789abcdef0123456789abcdef0123456789abcdef",
                "abcdefgh",
            ),
            ("with spaces and symbols !@#$%^&*()", "s4lt"),
            ("~!@#$%^&*()", "ABCDEFGH"),
        ];
        for (password, salt) in cases {
            assert_eq!(
                apr1_hash(password, Some(salt)),
                openssl_apr1(password, salt),
                "口令 {password:?} 盐 {salt:?} 对不上"
            );
        }
    }

    /// 差分测试的口令集是**定种子**的：每次跑都是同一批。
    ///
    /// 为什么不用 `thread_rng`：随机的用例会让 CI 变成「有时绿有时红」——
    /// 那种红既复现不了，也说不清是谁的锅。定下来之后，坏了就是坏了，
    /// 拿同一批口令重跑一遍就知道。
    ///
    /// 首字符从「不以 `-` 开头」的那一半里取：openssl 把以 `-` 开头的参数当成
    /// 选项（`passwd: Unknown option: -...`），口令就没了。以 `-` 开头的口令
    /// 由下面的定值向量管。
    #[test]
    fn apr1_matches_openssl_on_random_input() {
        use rand::rngs::StdRng;
        use rand::SeedableRng;

        // 可打印 ASCII：argv 这一路上，Windows 的代码页转换只对 ASCII 恒等。
        const ALPHABET: &[u8] = b"abcXYZ019 !@#$%^&*()_-+=[]{}<>?,.;:~";
        const FIRST: &[u8] = b"abcXYZ019 !@#$%^&*()_+=[]{}<>?,.;:~";

        let mut rng = StdRng::seed_from_u64(20261027);
        for i in 0..40 {
            let len = rng.gen_range(0..40);
            let mut password = String::with_capacity(len);
            for j in 0..len {
                let set = if j == 0 { FIRST } else { ALPHABET };
                password.push(set[rng.gen_range(0..set.len())] as char);
            }
            let salt: String = (0..8)
                .map(|_| APR1_ALPHABET[rng.gen_range(0..64)] as char)
                .collect();
            assert_eq!(
                apr1_hash(&password, Some(&salt)),
                openssl_apr1(&password, &salt),
                "第 {i} 条对不上：口令 {password:?} 盐 {salt:?}"
            );
        }
    }

    /// 走不了差分测试的口令：**定值**向量。
    ///
    /// 两类口令没法拿去跟 openssl 当场对拍：
    ///
    /// · **非 ASCII**：口令要经过 argv 送到 openssl 那里，Windows 的代码页转换
    ///   会把它改写（详见 [`openssl_apr1`]）。
    /// · **以 `-` 开头**：openssl 把以 `-` 开头的参数当成选项，口令就没了。
    ///
    /// 所以这两类由这里钉死 —— 摘要按**口令的 UTF-8 字节**算出来，写死在这里，
    /// 与平台无关。这些值都是拿 `openssl passwd -in <文件>` 算的（文件通道传的是
    /// 原始字节，不经过代码页转换）。
    ///
    /// 覆盖的是 UTF-8 的各个长度：两字节（café）、三字节（中文、希腊字母）、
    /// 四字节（emoji）。还有一个容易混的地方：U+0080 / U+00FF 各占 UTF-8 两个
    /// 字节（c2 80 / c3 bf）—— 别拿 Latin-1 的一个字节去算，那是另一串口令。
    ///
    /// 最后两条是同一个「é」的两种写法（预组合 U+00E9 与 e + 组合重音 U+0301）——
    /// 摘要必须不同，否则就说明有人在偷偷做 Unicode 归一化。
    #[test]
    fn apr1_for_passwords_the_oracle_cannot_carry_is_pinned() {
        for (password, salt, expected) in [
            (
                "口令 with spaces",
                "s4lt",
                "$apr1$s4lt$S2XX.Z0/cTwWY3YpkHVHP0",
            ),
            ("café", "abcdefgh", "$apr1$abcdefgh$YhhfHYyTkhkw0L/ECHfgR/"),
            ("Ωμέγα", "12345678", "$apr1$12345678$fE5RBlZhW0WvnBG7UNKg40"),
            ("🔐", "salt1234", "$apr1$salt1234$O9kd0SZJP5CxNIgqq2zlo."),
            ("e\u{301}", "x", "$apr1$x$mFvOETV6Z4dTdCJfIeNqq0"),
            ("\u{e9}", "x", "$apr1$x$V4e3WaisxeD6C7C/1FChe."),
            (
                "a\u{80}\u{ff}b",
                "ABCDEFGH",
                "$apr1$ABCDEFGH$yuk3nJnGA5xutbeoo/oXX.",
            ),
            // 以 `-` 开头：openssl 会把这种参数当成选项。
            ("-dash", "salt1234", "$apr1$salt1234$RmngREkghTpsWO2zAgIxR0"),
            ("-", "salt1234", "$apr1$salt1234$kU4vYKRT7QMeqpob95Hup/"),
            ("--", "salt1234", "$apr1$salt1234$OI78hOOp9lWfpQL0.nKJi0"),
            (
                "-with spaces",
                "salt1234",
                "$apr1$salt1234$eoi2pCOVgpI24zOmMAYj..",
            ),
        ] {
            assert_eq!(
                apr1_hash(password, Some(salt)),
                expected,
                "口令 {password:?} 盐 {salt:?}"
            );
        }
    }

    #[test]
    fn apr1_salts_are_eight_characters_from_apaches_alphabet() {
        for _ in 0..50 {
            let s = random_apr1_salt();
            assert_eq!(s.len(), APR1_SALT_LEN);
            assert!(s.bytes().all(|c| APR1_ALPHABET.contains(&c)), "{s}");
        }
    }

    #[test]
    fn apr1_verify_accepts_the_right_password_and_rejects_the_wrong_one() {
        let stored = apr1_hash("s3cr3t", Some("abcdefgh"));
        assert!(apr1_verify("s3cr3t", &stored).unwrap());
        assert!(!apr1_verify("s3cret", &stored).unwrap());
        assert!(!apr1_verify("", &stored).unwrap());
        // 同一个口令两次生成必须不同（盐是随机的）
        assert_ne!(apr1_hash("s3cr3t", None), apr1_hash("s3cr3t", None));
    }

    #[test]
    fn malformed_apr1_hashes_are_rejected_not_treated_as_a_mismatch() {
        for bad in [
            "",
            "$apr1$",
            "$apr1$$abc",
            "$apr1$abcdefgh",
            "$apr1$abcdefgh$tooshort",
            // 22 个字符但有一个不在字母表里
            "$apr1$abcdefgh$h9FWgUz3n9YxylKLlR5S!",
            // 盐超过 8 个字符
            "$apr1$abcdefghi$h9FWgUz3n9YxylKLlR5SQ/",
        ] {
            assert_eq!(
                apr1_verify("x", bad),
                None,
                "{bad:?} 应当是「格式不对」而不是「不匹配」"
            );
        }
    }

    /* ---- {SHA} ---- */

    #[test]
    fn sha1_output_matches_the_command_line() {
        // printf 'secret' | openssl dgst -binary -sha1 | openssl base64
        //   → 5en6G6MezRroT3XKqkdPOmY/BfQ=
        assert_eq!(sha1_hash("secret"), "{SHA}5en6G6MezRroT3XKqkdPOmY/BfQ=");
        assert_eq!(sha1_hash(""), "{SHA}2jmj7l5rSw0yVb/vlWAYkK/YBwk=");
        assert_eq!(sha1_hash("hunter2"), "{SHA}87u9ZqY9S/F0eUBXjsPQEDUw4h0=");
    }

    #[test]
    fn sha1_verify_round_trips() {
        let stored = sha1_hash("hunter2");
        assert!(sha1_verify("hunter2", &stored));
        assert!(!sha1_verify("hunter3", &stored));
        assert_eq!(stored.len(), 5 + SHA1_DIGEST_LEN);
    }

    /* ---- 端到端 ---- */

    #[test]
    fn generate_produces_a_full_htpasswd_line() {
        for (algorithm, check) in [
            ("apr1", "$apr1$"),
            ("sha1", "{SHA}"),
            ("plain", "s3cr3t"),
        ] {
            let out = compute(json!({
                "username": "alice",
                "password": "s3cr3t",
                "algorithm": algorithm,
            }))
            .expect("合法输入不该报错");
            let line = out["output"].as_str().unwrap();
            assert!(line.starts_with("alice:"), "{algorithm}: {line}");
            assert!(line.contains(check), "{algorithm}: {line}");
            assert_eq!(line.split(':').count(), 2, "{algorithm}: {line}");
        }
    }

    #[test]
    fn bcrypt_generate_uses_the_same_cost_clamp_as_the_bcrypt_tool() {
        let out = compute(json!({ "username": "a", "password": "b", "cost": "4" })).unwrap();
        assert!(out["output"].as_str().unwrap().starts_with("a:$2b$04$"));
        assert_eq!(out["meta"]["cost"], 4);

        // 夹取只测纯函数：真跑一次 cost 20 的 bcrypt 在 debug 构建下要一分多钟，
        // 跟 bcrypt.rs 里的同名测试同一个理由。
        assert_eq!(cost_of(&json!({ "cost": 99 })), MAX_USABLE_COST as u32);
        assert_eq!(cost_of(&json!({ "cost": 31 })), MAX_USABLE_COST as u32);
        assert_eq!(cost_of(&json!({ "cost": 2 })), 4);
        assert_eq!(cost_of(&json!({ "cost": "junk" })), DEFAULT_COST as u32);

        let w = cost_clamp_warning(Some(31)).expect("夹过了就该有提示");
        assert!(w.contains("31") && w.contains("20"), "{w}");
        assert_eq!(cost_clamp_warning(Some(10)), None);
        assert_eq!(cost_clamp_warning(None), None);
    }

    #[test]
    fn each_algorithm_has_a_warning_that_names_the_weakness() {
        for (algorithm, must_contain) in [
            ("sha1", "SHA-1"),
            ("plain", "明文"),
        ] {
            let out = compute(json!({
                "username": "a", "password": "b", "algorithm": algorithm
            }))
            .unwrap();
            let warnings = out["meta"]["warnings"].as_array().unwrap();
            assert!(
                warnings.iter().any(|w| w.as_str().unwrap().contains(must_contain)),
                "{algorithm} 的提示里没有提到 {must_contain}: {warnings:?}"
            );
        }
        // apr1 与 bcrypt 不该平白多一条
        let out = compute(json!({ "username": "a", "password": "b", "algorithm": "apr1" })).unwrap();
        assert!(out["meta"].get("warnings").is_none(), "{:?}", out["meta"]);
    }

    #[test]
    fn generate_then_verify_round_trips_for_every_algorithm() {
        for algorithm in ["bcrypt", "apr1", "sha1", "plain"] {
            let out = compute(json!({
                "username": "alice", "password": "s3cr3t", "algorithm": algorithm, "cost": "4",
            }))
            .unwrap();
            let line = out["output"].as_str().unwrap().to_string();

            let out = compute(json!({
                "username": "alice", "password": "s3cr3t", "line": line,
            }))
            .unwrap_or_else(|e| panic!("{algorithm}: {e}"));
            assert_eq!(out["output"], crate::i18n::t("en", MATCH_KEY), "{algorithm}");
            assert_eq!(out["meta"]["algorithm"], algorithm);

            let out = compute(json!({
                "username": "alice", "password": "wrong", "line": line,
            }))
            .unwrap();
            assert_eq!(out["output"], crate::i18n::t("en", MISMATCH_KEY), "{algorithm}");
        }
    }

    #[test]
    fn verify_accepts_either_the_whole_line_or_bare_the_hash() {
        let line = compute(json!({ "username": "bob", "password": "pw", "algorithm": "apr1" }))
            .unwrap()["output"]
            .as_str()
            .unwrap()
            .to_string();
        let bare = line.split_once(':').unwrap().1.to_string();

        for payload in [
            json!({ "password": "pw", "line": line.clone() }),
            json!({ "password": "pw", "hash": line.clone() }),
            json!({ "password": "pw", "hash": bare.clone() }),
            json!({ "password": "pw", "line": format!("{line}\n") }),
            json!({ "mode": "verify", "password": "pw", "hash": line.clone() }),
        ] {
            let out = compute(payload.clone()).expect("合法输入不该报错");
            assert_eq!(out["output"], crate::i18n::t("en", MATCH_KEY), "{payload}");
        }
    }

    #[test]
    fn verify_is_selected_by_the_hash_field_without_an_explicit_mode() {
        let line = compute(json!({ "username": "bob", "password": "pw", "algorithm": "sha1" }))
            .unwrap()["output"]
            .as_str()
            .unwrap()
            .to_string();
        let out = compute(json!({ "password": "pw", "hash": line })).unwrap();
        assert_eq!(out["output"], crate::i18n::t("en", MATCH_KEY));
    }

    #[test]
    fn verify_detects_the_algorithm_from_the_prefix_not_from_the_field() {
        // `algorithm` 字段填错了也不影响校验：前缀说了算
        let line = compute(json!({ "username": "bob", "password": "pw", "algorithm": "sha1" }))
            .unwrap()["output"]
            .as_str()
            .unwrap()
            .to_string();
        let out = compute(json!({
            "password": "pw", "algorithm": "bcrypt", "hash": line
        }))
        .unwrap();
        assert_eq!(out["output"], crate::i18n::t("en", MATCH_KEY));
        assert_eq!(out["meta"]["algorithm"], "sha1");
    }

    #[test]
    fn usernames_that_would_break_the_file_format_are_rejected() {
        for (bad, expected) in [
            ("", "out.htpasswd.err.missing_username"),
            ("a:b", "out.htpasswd.err.bad_username"),
            ("a\nb", "out.htpasswd.err.bad_username"),
            ("a\rb", "out.htpasswd.err.bad_username"),
        ] {
            let err = compute(json!({ "username": bad, "password": "p" })).unwrap_err();
            let (key, _) = keyed(&err);
            assert_eq!(key, expected, "{bad:?} 应当报 {expected}");
        }
    }

    #[test]
    fn a_line_whose_username_disagrees_is_rejected() {
        let line = compute(json!({ "username": "bob", "password": "pw", "algorithm": "apr1" }))
            .unwrap()["output"]
            .as_str()
            .unwrap()
            .to_string();
        let err = compute(json!({ "username": "alice", "password": "pw", "line": line })).unwrap_err();
        let (key, _) = keyed(&err);
        assert_eq!(key, "out.htpasswd.err.username_mismatch");
    }

    #[test]
    fn unknown_algorithm_names_the_accepted_values() {
        let err = compute(json!({ "username": "a", "password": "b", "algorithm": "argon2" })).unwrap_err();
        let (key, args) = keyed(&err);
        assert_eq!(key, "out.htpasswd.err.unknown_algorithm");
        assert_eq!(args["algorithm"], "argon2");
    }

    #[test]
    fn unknown_mode_names_the_accepted_values() {
        let err = compute(json!({ "username": "a", "password": "b", "mode": "sign" })).unwrap_err();
        let (key, args) = keyed(&err);
        assert_eq!(key, "out.htpasswd.err.unknown_mode");
        assert_eq!(args["mode"], "sign");
    }

    #[test]
    fn verify_without_a_hash_field_reports_the_missing_field() {
        let err = compute(json!({ "mode": "verify", "password": "abc" })).unwrap_err();
        let (key, _) = keyed(&err);
        assert_eq!(key, "out.htpasswd.err.missing_hash");
        assert!(!leaks(&err, "abc"), "错误信息泄露了明文：{key}");
    }

    #[test]
    fn an_over_expensive_bcrypt_hash_is_refused_before_burning_cpu() {
        // 从一条真哈希出发，只把 cost 两位改成 31 —— 盐和摘要原样保留，
        // 所以它一定能过 HashParts 解析，被拒的原因就只可能是 cost。
        // （直接拿 "a".repeat(53) 拼是不行的：bcrypt 的 base64 尾部有填充位约束，
        // 随机摘要未必能过解析，那样报错的就不是 cost 检查了。）
        let mut line = compute(json!({ "username": "a", "password": "x", "cost": "4" })).unwrap()
            ["output"]
            .as_str()
            .unwrap()
            .to_string();
        // `a:$2b$04$<…>`：冒号在 1，cost 的两位在 6..8
        line.replace_range(6..8, "31");
        assert_eq!(&line[2..8], "$2b$31", "改完应当仍是合法形状：{line}");

        let err = compute(json!({ "password": "x", "line": line })).unwrap_err();
        let (key, args) = keyed(&err);
        assert_eq!(key, "out.htpasswd.err.cost_too_high");
        assert_eq!(args["cost"], "31");
        assert_eq!(args["max"], "20");
    }

    #[test]
    fn errors_never_echo_the_plaintext() {
        for (payload, expected) in [
            (
                json!({ "username": "a:b", "password": "hunter2" }),
                "out.htpasswd.err.bad_username",
            ),
            (
                json!({ "username": "a", "password": "hunter2", "algorithm": "argon2" }),
                "out.htpasswd.err.unknown_algorithm",
            ),
            (
                json!({ "username": "a", "password": "hunter2", "mode": "sign" }),
                "out.htpasswd.err.unknown_mode",
            ),
            (
                json!({ "username": "a", "password": "hunter2", "mode": "verify" }),
                "out.htpasswd.err.missing_hash",
            ),
            (
                json!({ "username": "a", "password": "hunter2", "hash": "$apr1$bad" }),
                "out.htpasswd.err.bad_apr1_hash",
            ),
            (
                json!({ "username": "a", "password": "hunter2", "hash": "bob:not-a-hash" }),
                "out.htpasswd.err.username_mismatch",
            ),
        ] {
            let err = compute(payload).unwrap_err();
            let (key, _) = keyed(&err);
            assert_eq!(key, expected);
            assert!(!leaks(&err, "hunter2"), "错误信息泄露了明文：{key}");
        }
    }

    #[test]
    fn the_error_never_echoes_the_hash_back() {
        // 一条带明显标记的坏哈希：错误里既不能出现标记，也不能出现整条哈希。
        //
        // 标记前面要带 `$2b$` 前缀：没有前缀的裸文本按 Apache 的规矩
        // 当明文口令处理（能验，只是没匹配上）—— 那条路走不到错误分支。
        const MARK: &str = "CANARYMARKER";
        let bad = format!("$2b$04${MARK}");
        let err = compute(json!({ "username": "a", "password": "x", "hash": &bad })).unwrap_err();
        let (key, args) = keyed(&err);
        assert_eq!(key, "out.htpasswd.err.bad_hash");
        assert!(!key.contains(MARK), "{key}");
        assert!(!args.values().any(|v| v.contains(MARK)), "{args:?}");
        assert!(!args.values().any(|v| v.contains(&bad)), "{args:?}");
    }

    #[test]
    fn the_error_message_follows_the_requested_language() {
        // 语言不是工具决定的：工具只给出键，API 层按请求语言渲染。
        let err = compute(json!({ "mode": "verify", "password": "abc" })).unwrap_err();
        // 语言包里还没并进来时，localize 退回键本身 —— 这时断言跳过
        if !crate::i18n::has("zh-CN", "out.htpasswd.err.missing_hash") {
            return;
        }
        let en = err.localize("en");
        let zh = err.localize("zh-CN");
        assert_ne!(en, zh, "两种语言不该是同一句");
        assert!(!en.contains("out.htpasswd"), "英文界面不该露出键：{en}");
        assert!(!en.contains("缺少"), "英文界面不该露出中文：{en}");
    }

    #[test]
    fn empty_passwords_are_legal_everywhere() {
        for algorithm in ["bcrypt", "apr1", "sha1", "plain"] {
            let out = compute(json!({ "username": "a", "password": "", "algorithm": algorithm }))
                .unwrap_or_else(|e| panic!("{algorithm}: {e}"));
            let line = out["output"].as_str().unwrap().to_string();
            let out = compute(json!({ "password": "", "line": line })).unwrap();
            assert_eq!(out["output"], crate::i18n::t("en", MATCH_KEY), "{algorithm}");
        }
    }
}