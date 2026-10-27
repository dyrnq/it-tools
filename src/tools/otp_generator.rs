//! OTP 码生成与校验（TOTP / HOTP）—— RFC 4226 / RFC 6238。
//!
//! 与参考实现最大的差别在这里：**不读系统时钟**。参考实现的 UI 用 `Date.now()`
//! 当计数器，所以同一个密钥每次刷新得到三个不同的码；本工具把计数器做成了
//! 注册表里的 `counter` 字段，于是同样的入参永远得到同样的输出 ——
//! 这既是 REST 接口该有的样子，也是能拿 RFC 官方向量做断言的前提。
//!
//! 参考实现的 UI 压根没调用它自己导出的 `verifyTOTP`/`verifyHOTP`，只是把
//! previous / current / next 三个码摆出来给人眼比对。所以「校验」在这里就实现为
//! 「把窗口内的码都列出来」；另外额外接受一个可选的 `token` 字段（见 [`compute`]），
//! 让直接打 API 的人能拿到真正的布尔校验结果。
//!
//! ## 两处刻意的限制
//!
//! **算法固定 SHA1。** pinned 的 totp-rs 5.7.2 其实支持 `SHA1` / `SHA256` / `SHA512`
//! 三种（`Steam` 要另开 feature，我们没开），RFC 6238 附录 B 的 18 个向量在
//! [`otp`] 里三种都验过了。但注册表的 `ApiSpec` 没有算法字段，通用表单也表达不出来，
//! 所以对外只暴露 SHA1 —— 它本来就是 RFC 4226 和绝大多数验证器 App 的默认值。
//! 要放开的话得先给注册表加一个 `algorithm` 的 Select 字段，`otp()` 已经是现成的入口。
//!
//! **不画二维码。** 参考实现用 `useQRCode` 把 `otpauth://` URI 渲成图，那是纯浏览器的事。
//! 这里只把 URI 本身放进 `Key URI` 那一行；要出图得在 JS 侧接
//! `static/lib/manifest.tsv` 里已 vendored 的 `qrcode` 库。本工具不产出 `json.html`，
//! 免得把不受控的内容当 innerHTML 注入。
//!
//! ## 结果区的文案
//!
//! 结果表里**给人看的字**（行标题、「是 / 否」这种成句的值）走语言包，
//! 键是 `out.otp-generator.*`；**机器可读的值**（码本身、计数器、密钥 hex、
//! 算法名 `SHA1`、Key URI）原样保留 —— 它们是给人复制走的，不该被翻译。

use data_encoding::{Encoding, Specification, BASE32_NOPAD};
use once_cell::sync::Lazy;
use serde_json::{json, Value};
use totp_rs::{Algorithm, Builder};

use super::{util, ToolError, ToolResult};

/// 宽松的 base32 解码表。
///
/// `BASE32_NOPAD` 会校验末尾那几根「补零位」必须真的是 0，于是长度不是 8 的倍数
/// 且尾部 bit 非 0 的输入会被拒 —— 实测 `"7777"`（4 字符 = 20 bit，只用掉 16 bit）
/// 报 `DecodeError { kind: Trailing }`。但参考实现的 `base32toHex` 收它，而且它自己的
/// 单测（`otp.service.test.ts`）就断言了 `base32toHex('7777') === 'ffff0f'`。
/// 所以这里关掉这项校验，只拒绝真正不在字母表 `A-Z2-7` 里的字符。
///
/// 代价：尾部 bit 打错的密钥会算出一个（错误的）码，而不是干脆报错。换来的是不把参考实现
/// 认可的输入挡在门外 —— 对一个开发者工具，这笔交易更划算。
static BASE32_LENIENT: Lazy<Encoding> = Lazy::new(|| {
    let mut spec = Specification::new();
    spec.symbols.push_str("ABCDEFGHIJKLMNOPQRSTUVWXYZ234567");
    spec.check_trailing_bits = false;
    spec.encoding().expect("base32 字母表 A-Z2-7 是合法的")
});

/// 校验窗口半径：前后各一个码。
///
/// 取 1 是因为参考实现的 UI 就展示 previous / current / next 三枚码，
/// 而它的 `verifyHOTP` 默认 `window = 0` —— 那意味着只接受「正好当前这一个」，
/// 真机上一步的网络延迟就会判失败。1 正好等于展示出来的三枚码。
const WINDOW: u64 = 1;

/// RFC 6238 §5.1 要求密钥至少 128 位。低于这个长度我们仍然放行（参考实现也放行，
/// 它自己的测试密钥 `JBSWY3DPEHPK3PXP` 只有 80 位），但要在结果里提示出来。
const RECOMMENDED_SECRET_BITS: usize = 128;

/// Key URI 里的 issuer / 账号名，沿用参考实现的默认值。
///
/// 注册表没有 issuer 字段，参考实现写死了 `IT-Tools:demo-user`；用户真正要的是
/// secret，其余部分只是个能被验证器 App 接受的固定壳子。
const KEY_URI_ISSUER: &str = "IT-Tools";
const KEY_URI_ACCOUNT: &str = "demo-user";

/// 本工具是纯查表式计算（几次 HMAC，微秒级），没有 CPU 密集部分，
/// 所以 `handle` 只是同步 `compute` 的壳，不需要丢 blocking 线程池。
pub async fn handle(payload: Value) -> ToolResult {
    compute(payload)
}

fn compute(payload: Value) -> ToolResult {
    // 「没给 secret 字段」与「给了但里面是空的」是两回事：
    // 前者是漏填（`out.common.missing_field`），后者是密钥为空
    // （`out.otp-generator.err.empty_secret`）。所以这里不能用 `req_str` ——
    // 它把两者都算成「没给」。
    let raw_secret = match util::opt_str(&payload, "secret") {
        Some(s) => s,
        None => {
            return Err(ToolError::invalid(
                "out.common.missing_field",
                &[("field", "secret")],
            ))
        }
    };
    let secret = decode_secret(raw_secret)?;

    // `kind` 之外的值一律拒绝而不是退回默认：`totp` / `hotp` 的语义完全不同，
    // 猜错会让人拿 TOTP 去比对 HOTP 的码还以为是密钥错了。
    let kind = util::str_or(&payload, "kind", "totp");
    let is_totp = match kind {
        "totp" => true,
        "hotp" => false,
        other => {
            // 文案在语言包里（`out.otp-generator.err.unknown_kind`）。
            // 用户填的类型名原样回显 —— 它不是秘密。
            return Err(ToolError::invalid(
                "out.otp-generator.err.unknown_kind",
                &[("kind", other)],
            ));
        }
    };

    // 表单里 digits 最多能给到 10，但 RFC 4226 §5.3 只定义 6~8 位，
    // 而且 totp-rs 内部算的是 `10_u32.pow(digits)`：digits 到 10 就会在 u32 上溢出。
    // 所以这里按注册表的区间收，再按 RFC 收到 8。
    let digits = util::bounded_u64(&payload, "digits", 6, 6, 10).min(8) as usize;
    let period = util::bounded_u64(&payload, "period", 30, 1, 300);
    let counter = util::bounded_u64(&payload, "counter", 0, 0, u64::MAX);

    // `counter` 的含义随 `kind` 变：
    // - hotp：RFC 4226 的计数器 C，本身就是计数器的绝对值；
    // - totp：RFC 6238 的 T（时间步序号），也就是参考实现 UI 上那个
    //   `getCounterFromTime(now, 30)` 的返回值。
    // 两者喂给同一个函数就够了 —— RFC 6238 §1.2 原文就是
    // 「TOTP 是本算法的基于时间的变体，用一个由时间基准和时间步导出的值 T
    //   替换掉 HMAC 计算里的计数器 C」。
    // `period` 因此只影响 TOTP 的「这一步从哪一秒开始」，不参与码的计算。
    let algorithm = Algorithm::SHA1; // ApiSpec 表达不出算法，见文件头的「两处刻意的限制」
    let code = otp(algorithm, &secret, counter, digits);

    let previous = counter
        .checked_sub(WINDOW)
        .map(|c| otp(algorithm, &secret, c, digits));
    let next = counter
        .checked_add(WINDOW)
        .map(|c| otp(algorithm, &secret, c, digits));

    // 可选的校验入口。通用表单永远不会发这个字段（注册表里没有），但
    // `POST /api/tools/otp-code-generator-and-validator` 是公开接口，
    // 直接打 API 的人显然想要一个布尔答案，而不是自己拿窗口里的码去比对。
    let submitted = util::opt_str(&payload, "token")
        .map(str::trim)
        .filter(|s| !s.is_empty());
    // 立刻摊平：`submitted.map(..)` 是 `Option<Option<u64>>`（外层「有没有提交码」、
    // 内层「命中哪个计数器」），摊平后两种「没有」——没提交码 / 提交了但不匹配——
    // 都统一成 `None`，下面就不会再把 `Some(None)` 误当成命中。
    let matched = submitted.and_then(|t| match_counter(&secret, t, counter, digits));

    // 结果区里**给人看的字**走语言包：行标题按当前语言取，成句的值也从语言包里拿。
    // 机器可读的值（码、计数器、密钥 hex、算法名）原样保留。
    let lang = util::lang(&payload);
    let mut table = serde_json::Map::new();
    util::row(&mut table, &payload, "out.otp-generator.code", json!(code));
    util::row(
        &mut table,
        &payload,
        "out.otp-generator.kind",
        // TOTP / HOTP 的全称跟表单下拉框里是同一句话 —— 复用 `opt.kind.*`，
        // 免得同一句话在语言包里写两遍、然后各写各的漂移。
        json!(crate::i18n::t(
            lang,
            if is_totp {
                "opt.kind.totp"
            } else {
                "opt.kind.hotp"
            }
        )),
    );
    util::row(
        &mut table,
        &payload,
        "out.otp-generator.algorithm",
        json!(algorithm.to_string()),
    );
    util::row(
        &mut table,
        &payload,
        "out.otp-generator.digits",
        json!(digits),
    );
    util::row(
        &mut table,
        &payload,
        "out.otp-generator.counter",
        json!(counter),
    );
    util::row(
        &mut table,
        &payload,
        "out.otp-generator.counter_hex",
        json!(padded_hex(counter)),
    );
    // 「这一格没有值」用破折号表示 —— 中英文一样，但也走语言包，
    // 这样语言包是这一格唯一的出处。
    let dash = crate::i18n::t(lang, "out.otp-generator.dash");
    util::row(
        &mut table,
        &payload,
        "out.otp-generator.previous",
        json!(previous.clone().unwrap_or_else(|| dash.clone())),
    );
    util::row(
        &mut table,
        &payload,
        "out.otp-generator.next",
        json!(next.clone().unwrap_or_else(|| dash.clone())),
    );
    // HOTP 没有「时间步」这回事，period 对它无意义，如实说明而不是假装生效。
    if is_totp {
        util::row(
            &mut table,
            &payload,
            "out.otp-generator.period",
            json!(period),
        );
        util::row(
            &mut table,
            &payload,
            "out.otp-generator.step_start",
            match counter.checked_mul(period) {
                Some(start) => json!(start),
                // counter 被夹到 u64::MAX，× period 会溢出；显示不了就明说。
                None => json!(crate::i18n::t(
                    lang,
                    "out.otp-generator.step_start_overflow"
                )),
            },
        );
    } else {
        util::row(
            &mut table,
            &payload,
            "out.otp-generator.period",
            json!(crate::i18n::t(lang, "out.otp-generator.no_period")),
        );
    }

    if let Some(token) = submitted {
        util::row(
            &mut table,
            &payload,
            "out.otp-generator.submitted_code",
            json!(token),
        );
        util::row(
            &mut table,
            &payload,
            "out.otp-generator.validity",
            json!(crate::i18n::t(
                lang,
                if matched.is_some() {
                    "out.otp-generator.valid"
                } else {
                    "out.otp-generator.invalid"
                }
            )),
        );
        util::row(
            &mut table,
            &payload,
            "out.otp-generator.matched_counter",
            match matched {
                Some(hit) => json!(hit),
                None => json!(crate::i18n::t(lang, "out.otp-generator.dash")),
            },
        );
    }

    if secret.len() * 8 < RECOMMENDED_SECRET_BITS {
        // 位数跟着密钥长度走 —— 语言包里留 `{bits}` / `{recommended}` 两个占位符，
        // 两种语言可以各自决定语序。
        let bits = (secret.len() * 8).to_string();
        let recommended = RECOMMENDED_SECRET_BITS.to_string();
        let note = crate::i18n::t(lang, "out.otp-generator.short_secret")
            .replace("{bits}", &bits)
            .replace("{recommended}", &recommended);
        util::row(
            &mut table,
            &payload,
            "out.otp-generator.secret_length",
            json!(note),
        );
    }
    util::row(
        &mut table,
        &payload,
        "out.otp-generator.secret_hex",
        json!(hex::encode(&secret)),
    );
    util::row(
        &mut table,
        &payload,
        "out.otp-generator.key_uri",
        json!(key_uri(
            &secret, algorithm, is_totp, counter, digits, period
        )),
    );

    let mut meta = json!({
        "code": code,
        "kind": kind,
        "algorithm": algorithm.to_string(),
        "digits": digits,
        "counter": counter,
        "counter_hex": padded_hex(counter),
        "window": WINDOW,
        "secret_bits": secret.len() * 8,
        // 「上一个 / 下一个」这两个码原版也显示（TokenDisplay 组件排成一行三个）。
        // 它们在 table 里是带标题的行，前端拿不到稳定的键名 —— 走 meta 这条
        // 固定的路。计数器在 0 的时候没有「上一个」，就是没有，不是空串。
        "previous": previous,
        "next": next,
    });
    if is_totp {
        meta["period"] = json!(period);
        if let Some(start) = counter.checked_mul(period) {
            meta["step_start"] = json!(start);
        }
    }
    if let Some(token) = submitted {
        meta["submitted"] = json!(token);
        meta["valid"] = json!(matched.is_some());
        meta["matched_counter"] = json!(matched);
    }

    Ok(json!({ "output": code, "table": table, "meta": meta }))
}

/// RFC 4226 的 HOTP(K, C)，也就是 RFC 6238 的 TOTP 本体。
///
/// 借 totp-rs 实现，但它没有「按 counter 算」的接口，只有 `generate(time)`，
/// 内部拿 `(time / step).to_be_bytes()` 当 HMAC 消息。把 `step` 设成 1，
/// `generate(counter)` 就等价于拿 `counter` 的大端 8 字节当消息 ——
/// 正是 RFC 4226 那个「counter 补零到 16 位十六进制」的计数器。
///
/// `build_noncompliant` 而不是 `build`：`build` 会按 RFC 6238 拒掉短于 128 位的密钥，
/// 而参考实现接受任意长度（它自己的测试密钥只有 80 位）。既然要兼容参考实现的
/// 合法输入，合规性检查就自己来，不依赖这个构造器。
///
/// `digits` 在这里再夹一次：这个函数会被测试直接调用，不能只依赖调用方夹过；
/// totp-rs 的 `10_u32.pow(digits)` 在 digits ≥ 10 时会溢出。
fn otp(algorithm: Algorithm, secret: &[u8], counter: u64, digits: usize) -> String {
    Builder::new()
        .with_algorithm(algorithm)
        .with_digits(digits.clamp(6, 8) as u8)
        .with_skew(0)
        .with_step_duration(1)
        .with_secret(secret.to_vec())
        .build_noncompliant()
        .generate(counter)
        .to_string()
}

/// 在 `counter ± WINDOW` 里找 `token` 属于哪个计数器；找不到返回 `None`。
///
/// 校验失败是正常结果而不是错误，所以返回 `Option` 而不是 `Result`。
fn match_counter(secret: &[u8], token: &str, counter: u64, digits: usize) -> Option<u64> {
    let algorithm = Algorithm::SHA1;
    // 下界做饱和减：counter = 0 时窗口只有 {0, 1}，而不是绕回 u64::MAX 去试一个
    // 几千年后才轮到的计数器。
    let low = counter.saturating_sub(WINDOW);
    let high = counter.saturating_add(WINDOW);
    (low..=high).find(|&c| ct_eq(&otp(algorithm, secret, c, digits), token))
}

/// 等长字符串比较，避免校验路径上的时序泄漏。
///
/// 长度不等直接返回 false —— 这泄露的信息只有「码的位数」，而位数本来就是
/// 请求方自己填的。位长相等时逐字节 XOR 累加，编译器不会把它优化成短路比较。
///
/// 没引 `subtle`：这个工具的密钥是每次请求现解的，服务端不保存跨请求状态，
/// 攻击者要利用时序差异得在同一把密钥上打几千次，实务上不可行；
/// 而为了 8 行代码给 Cargo.toml 加依赖不值当。
fn ct_eq(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// 解用户粘进来的 base32 密钥。
///
/// 三个现实中一定会遇到的细节：
/// - **去掉尾部 `=`**：RFC 3548 允许填充，但验证器 App 和参考实现的输入框
///   （`/^[A-Z234567]+$/`）都只收无填充形式。两种都得能吃，否则一半用户粘不进来。
/// - **转大写**：base32 字母表 `A-Z2-7` 大小写敏感，但人是从别处复制来的，
///   参考实现的 `base32toHex` 也 `.toUpperCase()`。
/// - **去空白**：粘贴几乎总会带上首尾空格。
fn decode_secret(raw: &str) -> Result<Vec<u8>, ToolError> {
    let mut cleaned = String::with_capacity(raw.len());
    for ch in raw.chars() {
        if ch.is_whitespace() {
            continue;
        }
        cleaned.extend(ch.to_uppercase());
    }
    // 只削尾部的 `=`（RFC 3548 的填充位）。中间的 `=` 不削 —— 那是用户打错了，
    // 应该报「不是合法 base32」而不是悄悄把它吃掉算出一个错的密钥。
    let trimmed = cleaned.trim_end_matches('=');

    if trimmed.is_empty() {
        return Err(ToolError::invalid(
            "out.otp-generator.err.empty_secret",
            &[],
        ));
    }

    // 文案在语言包里（`out.otp-generator.err.bad_base32_secret`）。
    // **密钥绝不进错误信息** —— 这里只说「不是合法的 base32」。
    // 解码库自带的英文细节（`invalid symbol at 3`）不带进来：
    // 一半英文一半中文的句子比少一条线索更难看，而且那个位置是**清理后**
    // 的字符串里的位置（空白已经被去掉了），跟用户看到的原文对不上。
    BASE32_LENIENT
        .decode(trimmed.as_bytes())
        .map_err(|_| ToolError::invalid("out.otp-generator.err.bad_base32_secret", &[]))
}

/// RFC 4226 的计数器补零到 16 位十六进制，参考实现的 `padded hex` 那一栏就是它。
fn padded_hex(counter: u64) -> String {
    format!("{counter:016x}")
}

/// 拼 `otpauth://` URI，参数顺序照抄参考实现的 `buildKeyUri`，方便互相替换。
///
/// totp-rs 的 `get_url()` 在 `otpauth` feature 后面，而我们没开这个 feature
/// （它会拖进 `url` + `urlencoding` 两个依赖），所以自己拼。
/// secret 是 base32（`A-Z2-7`），issuer / 账号名是 ASCII 字面量，数字是数字 ——
/// 拼出来的串里没有任何需要 URL 转义的字符。
fn key_uri(
    secret: &[u8],
    algorithm: Algorithm,
    is_totp: bool,
    counter: u64,
    digits: usize,
    period: u64,
) -> String {
    let host = if is_totp { "totp" } else { "hotp" };
    let b32 = BASE32_NOPAD.encode(secret);
    let mut params =
        format!("issuer={KEY_URI_ISSUER}&secret={b32}&algorithm={algorithm}&digits={digits}");
    if is_totp {
        params.push_str(&format!("&period={period}"));
    } else {
        params.push_str(&format!("&counter={counter}"));
    }
    format!("otpauth://{host}/{KEY_URI_ISSUER}:{KEY_URI_ACCOUNT}?{params}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // ---- RFC 官方测试向量 -------------------------------------------------
    //
    // 期望值一律照抄 RFC 原文，不允许用本文件的实现反推 —— 那样测试就是自证的。

    /// RFC 4226 Appendix D，Table 2 的 Secret = ASCII "12345678901234567890"。
    const RFC4226_HOTP: [(&str, &str); 10] = [
        ("0", "755224"),
        ("1", "287082"),
        ("2", "359152"),
        ("3", "969429"),
        ("4", "338314"),
        ("5", "254676"),
        ("6", "287922"),
        ("7", "162583"),
        ("8", "399871"),
        ("9", "520489"),
    ];

    /// RFC 6238 Appendix B：`(Unix 时间秒, 期望的 8 位码)`。
    /// 时间是十进制，`counter` 由调用处除以 30 得到 T。
    const RFC6238_TOTP: [(u64, &str); 6] = [
        (59, "94287082"),
        (1111111109, "07081804"),
        (1111111111, "14050471"),
        (1234567890, "89005924"),
        (2000000000, "69279037"),
        (20000000000, "65353130"),
    ];

    /// 把 ASCII 测试密钥编成 base32 —— 用来证明解码路径，而不用去编造期望值。
    fn b32(s: &str) -> String {
        BASE32_NOPAD.encode(s.as_bytes())
    }

    /// 行的**标题**是按语言取出来的，所以断言要按语言包里的键去取标题，
    /// 而不是把标题的字面量抄一遍 —— 抄一遍的话，改一次文案就要改一次断言。
    /// 这里没带 `__lang`，走英文兜底。
    fn label(key: &str) -> String {
        crate::i18n::t("en", key)
    }

    /// 断言一个结果是「带键的 Invalid」，且键就是期望的那一个 ——
    /// 错误文案在语言包里，断言消息文本只会让改文案时顺带改断言。
    fn assert_keyed(result: &ToolResult, want: &str) {
        match result {
            Err(ToolError::InvalidKeyed { key, .. }) => assert_eq!(*key, want),
            other => panic!("应当报 {want}，实际 {other:?}"),
        }
    }

    fn code_of(payload: Value) -> String {
        compute(payload).unwrap()["output"]
            .as_str()
            .unwrap()
            .to_string()
    }

    #[test]
    fn rfc4226_appendix_d_hotp_vectors() {
        let secret = b32("12345678901234567890");
        for (counter, expected) in RFC4226_HOTP {
            let out = compute(json!({
                "secret": secret, "kind": "hotp", "digits": "6", "counter": counter,
            }))
            .unwrap();
            assert_eq!(out["output"], expected, "counter = {counter}");
        }
    }

    #[test]
    fn rfc6238_appendix_b_totp_vectors_sha1() {
        let secret = b32("12345678901234567890");
        for (time, expected) in RFC6238_TOTP {
            // T = floor(time / X)，X = 30
            let out = compute(json!({
                "secret": secret, "kind": "totp", "digits": "8", "counter": (time / 30).to_string(),
            }))
            .unwrap();
            assert_eq!(out["output"], expected, "time = {time}");
        }
    }

    /// SHA256 / SHA512 的向量走私有原语，因为 ApiSpec 里没有算法字段。
    /// 密钥是 RFC 6238 附录 A 参考实现里那三行 hex 种子解开后的 ASCII。
    #[test]
    fn rfc6238_sha256_and_sha512_vectors() {
        // RFC 6238 附录 A 的参考实现把种子写成 hex：
        //   seed   = 3132…3930              → "12345678901234567890"                (20 字节, SHA1)
        //   seed32 = seed + 3132…3132       → "12345678901234567890123456789012"     (32 字节, SHA256)
        //   seed64 = seed×3 + 31323334      → "1234…1234" 共 64 字节                (SHA512)
        let s256 = BASE32_NOPAD
            .decode(b32("12345678901234567890123456789012").as_bytes())
            .unwrap();
        let s512 = BASE32_NOPAD
            .decode(
                b32("1234567890123456789012345678901234567890123456789012345678901234").as_bytes(),
            )
            .unwrap();
        assert_eq!(s256.len(), 32);
        assert_eq!(s512.len(), 64);

        for (time, sha256, sha512) in [
            (59u64, "46119246", "90693936"),
            (1111111109, "68084774", "25091201"),
            (1111111111, "67062674", "99943326"),
            (1234567890, "91819424", "93441116"),
            (2000000000, "90698825", "38618901"),
            (20000000000, "77737706", "47863826"),
        ] {
            let counter = time / 30;
            assert_eq!(
                otp(Algorithm::SHA256, &s256, counter, 8),
                sha256,
                "SHA256 t={time}"
            );
            assert_eq!(
                otp(Algorithm::SHA512, &s512, counter, 8),
                sha512,
                "SHA512 t={time}"
            );
        }
    }

    /// 顺带确认 pinned 的 totp-rs 5.7.2 确实同时提供三种算法（Steam 需 feature，未开）。
    #[test]
    fn all_three_algorithms_are_available() {
        assert_eq!(Algorithm::default(), Algorithm::SHA1);
        assert_eq!(Algorithm::SHA1.to_string(), "SHA1");
        assert_eq!(Algorithm::SHA256.to_string(), "SHA256");
        assert_eq!(Algorithm::SHA512.to_string(), "SHA512");
    }

    // ---- 参考实现自己的测试向量（otp.service.test.ts）--------------------

    #[test]
    fn reference_hotp_vectors() {
        for (counter, expected) in [
            ("0", "282760"),
            ("1", "996554"),
            ("2", "602287"),
            ("3", "143627"),
            ("4", "960129"),
        ] {
            assert_eq!(
                code_of(json!({
                    "secret": "JBSWY3DPEHPK3PXP", "kind": "hotp", "counter": counter,
                })),
                expected,
                "counter = {counter}"
            );
        }
    }

    /// 参考实现 `generateTOTP({key, now: 0})` = '282760'，也就是把 now=0 当 counter=0。
    #[test]
    fn reference_totp_vectors() {
        // 参考实现收的是毫秒，内部 floor(now/1000/timeStep)。这里照抄它的换算，
        // 免得手算计数器算错。
        for (now_ms, expected) in [
            (0u64, "282760"), // now = 0
            (1_465_324_707_000u64, "341128"),
            (1_365_324_707_000u64, "089029"),
        ] {
            let counter = now_ms / 1000 / 30;
            assert_eq!(
                code_of(json!({
                    "secret": "JBSWY3DPEHPK3PXP", "kind": "totp", "counter": counter.to_string(),
                })),
                expected,
                "now = {now_ms} (counter = {counter})"
            );
        }
    }

    // ---- 前导零：字符串格式化，不是整数格式化 ---------------------------

    /// 参考实现的 `generateTOTP({key, now: 1365324707000})` 就是 `'089029'` ——
    /// 如果有人把码当整数处理再 `to_string()`，它会变成 `'89029'`。这条断言就是防这个的。
    #[test]
    fn leading_zero_is_preserved_six_digits() {
        let counter = 1_365_324_707_000u64 / 1000 / 30;
        assert_eq!(
            code_of(json!({
                "secret": "JBSWY3DPEHPK3PXP", "kind": "totp", "counter": counter.to_string(),
            })),
            "089029"
        );
    }

    /// RFC 6238 的 `07081804` 同理：8 位码的首位是 0。
    #[test]
    fn leading_zero_is_preserved_eight_digits() {
        assert_eq!(
            code_of(json!({
                "secret": b32("12345678901234567890"),
                "kind": "totp", "digits": "8", "counter": "37037036",
            })),
            "07081804"
        );
    }

    #[test]
    fn code_is_always_exactly_as_long_as_digits() {
        // RFC 4226 前十个码全是 6 位；RFC 6238 全是 8 位。
        for (counter, _) in RFC4226_HOTP {
            assert_eq!(
                code_of(json!({ "secret": b32("12345678901234567890"), "counter": counter })).len(),
                6
            );
        }
        for (time, _) in RFC6238_TOTP {
            let out = code_of(json!({
                "secret": b32("12345678901234567890"), "digits": "8", "counter": (time/30).to_string(),
            }));
            assert_eq!(out.len(), 8, "time={time} -> {out}");
        }
    }

    // ---- base32 解码路径 -------------------------------------------------

    #[test]
    fn padding_present_or_absent_give_the_same_code() {
        // 4 字节 → 7 个 base32 字符 + 1 个 '='，是「天然带填充」的情形。
        let padded = data_encoding::BASE32.encode(b"1234"); // "GEZDGNA="
        assert_eq!(padded, "GEZDGNA=");
        assert_eq!(padded.trim_end_matches('='), "GEZDGNA");
        assert_eq!(
            code_of(json!({ "secret": padded, "counter": "0" })),
            code_of(json!({ "secret": "GEZDGNA", "counter": "0" }))
        );
    }

    #[test]
    fn padding_at_a_wider_boundary_is_stripped_too() {
        // 8 字节 → 13 字符 + 3 个 '='
        let padded = data_encoding::BASE32.encode(b"12345678");
        assert_eq!(padded.len(), 16);
        assert!(padded.ends_with("==="), "{padded}");
        assert_eq!(
            code_of(json!({ "secret": padded, "counter": "0" })),
            code_of(json!({ "secret": padded.trim_end_matches('='), "counter": "0" }))
        );
    }

    /// 宽松解码：`"7777"` 在参考实现的 `otp.service.test.ts` 里被当成合法 base32 断言过
    /// （`base32toHex('7777') === 'ffff0f'`），但 `data_encoding` 默认的尾部零位校验会拒它。
    #[test]
    fn trailing_nonzero_bits_are_tolerated_like_the_reference() {
        assert!(BASE32_NOPAD.decode(b"7777").is_err()); // kind: Trailing

        let out = compute(json!({ "secret": "7777", "counter": "0" }));
        assert!(out.is_ok(), "参考实现收 '7777'，不该报错");
        assert_eq!(out.unwrap()["output"].as_str().unwrap().len(), 6);

        // 解出来仍是「正确的」base32：'7777' → 0xFF 0xFF（20 bit 取高 16 bit），
        // 末尾 4 个 1 bit 是被丢弃的填充位 —— 而不是参考实现那个有损的 'ffff0f'
        // （它按 8 bit 一段切，末尾那 4 个 1 被当成半个字节算成了 0x0F）。
        assert_eq!(decode_secret("7777").unwrap(), vec![0xFF, 0xFF]);
    }

    /// 与参考实现的一处已知分歧：它的 `base32toHex` 没有任何长度校验，所以连
    /// 6 个字符的 `"ABCDEF"` 都收。但 base32 每 8 字符 = 40 bit = 5 字节，
    /// 合法的末段长度只有 2/4/5/7（`data_encoding` 同此），6 是非法的。
    /// 要收它就得自己手写一个不检查长度的比特累加器，不值得 —— 这里按标准拒掉。
    #[test]
    fn structurally_invalid_lengths_are_rejected() {
        for s in ["ABCDEF", "ABC", "ABCDEFGHI"] {
            let r = compute(json!({ "secret": s, "counter": "0" }));
            assert!(r.is_err(), "secret = {s:?} 长度非 8/2/4/5/7 余数，应拒绝");
            assert_keyed(&r, "out.otp-generator.err.bad_base32_secret");
        }
    }

    #[test]
    fn lowercase_and_whitespace_are_accepted() {
        let upper = code_of(json!({ "secret": "JBSWY3DPEHPK3PXP", "counter": "0" }));
        assert_eq!(
            code_of(json!({ "secret": "jbswy3dpehpk3pxp", "counter": "0" })),
            upper
        );
        assert_eq!(
            code_of(json!({ "secret": "  JBSWY3DPEHPK3PXP  ", "counter": "0" })),
            upper
        );
        assert_eq!(
            code_of(json!({ "secret": "JBSW Y3DP EHPK 3PXP", "counter": "0" })),
            upper
        );
    }

    #[test]
    fn invalid_base32_is_rejected_not_panicking() {
        for bad in ["1", "0", "8", "9", "!!!!!!!!", "ABC!DEF", "A", "ABCDEFGH1"] {
            let r = compute(json!({ "secret": bad, "counter": "0" }));
            assert!(r.is_err(), "secret = {bad:?} 不该被接受");
            assert_keyed(&r, "out.otp-generator.err.bad_base32_secret");
        }
    }

    #[test]
    fn empty_or_blank_secret_is_invalid() {
        // 空密钥 / 只有空白 / 只有填充符 —— 都是「没给密钥」
        for payload in [
            json!({ "secret": "", "counter": "0" }),
            json!({ "secret": "   ", "counter": "0" }),
            json!({ "secret": "======", "counter": "0" }),
        ] {
            let r = compute(payload);
            assert_keyed(&r, "out.otp-generator.err.empty_secret");
        }
        // 完全没给这个字段 —— 缺字段是另一回事（`out.common.missing_field`）
        assert_keyed(
            &compute(json!({ "counter": "0" })),
            "out.common.missing_field",
        );
    }

    #[test]
    fn short_secret_is_accepted_but_flagged() {
        // JBSWY3DPEHPK3PXP 只有 10 字节 = 80 位，低于 RFC 建议的 128 位。
        // 参考实现接受它，所以这里也必须接受，只提示不拦。
        let out = compute(json!({ "secret": "JBSWY3DPEHPK3PXP", "counter": "0" })).unwrap();
        assert_eq!(out["output"], "282760");
        let note = out["table"][&label("out.otp-generator.secret_length")]
            .as_str()
            .unwrap();
        // 语言包里那段提示还没并进来时，取到的就是键本身，验不了内容；
        // 并进来之后下面这两条才会真的跑。
        if crate::i18n::has("en", "out.otp-generator.short_secret") {
            assert!(note.contains("80"), "{note}");
            assert!(note.contains("128"), "{note}");
        }
        assert_eq!(out["meta"]["secret_bits"], 80);
    }

    // ---- kind ------------------------------------------------------------

    #[test]
    fn bad_kind_is_invalid() {
        for bad in ["", "TOTP", "steam", "totp2", "otp"] {
            let r = compute(json!({ "secret": "JBSWY3DPEHPK3PXP", "kind": bad }));
            // 空串走 str_or 的默认值（totp），其余拒绝
            if bad.is_empty() {
                assert!(r.is_ok());
            } else {
                assert!(r.is_err(), "kind = {bad:?} 不该被接受");
                assert_keyed(&r, "out.otp-generator.err.unknown_kind");
            }
        }
    }

    /// 错误信息跟着请求语言走 —— 语言不是工具决定的，是 API 层按请求语言
    /// 调用 `localize` 渲染的。
    #[test]
    fn the_error_message_follows_the_requested_language() {
        let err = compute(json!({ "secret": "JBSWY3DPEHPK3PXP", "kind": "steam" })).unwrap_err();
        // 语言包里还没并进来时，localize 退回键本身 —— 这时断言跳过
        if !crate::i18n::has("zh-CN", "out.otp-generator.err.unknown_kind") {
            return;
        }
        let en = err.localize("en");
        let zh = err.localize("zh-CN");
        assert_ne!(en, zh, "两种语言不该是同一句");
        assert!(!en.contains("out.otp-generator"), "英文界面不该露出键：{en}");
    }

    /// 错误信息里绝不能出现密钥本身 —— 密钥会随请求进日志。
    #[test]
    fn the_errors_never_echo_the_secret() {
        let secret = "JBSWY3DP!EHPK3PXP";
        for payload in [
            json!({ "secret": secret, "counter": "0" }),
            json!({ "secret": secret, "kind": "steam" }),
            json!({ "secret": secret, "counter": "0", "digits": "6" }),
        ] {
            let msg = compute(payload).unwrap_err().to_string();
            assert!(!msg.contains(secret), "错误信息泄露了密钥: {msg}");
        }
    }

    #[test]
    fn missing_kind_defaults_to_totp() {
        let out = compute(json!({ "secret": "JBSWY3DPEHPK3PXP", "counter": "0" })).unwrap();
        assert_eq!(out["meta"]["kind"], "totp");
    }

    /// TOTP(K, T) 定义上就等于 HOTP(K, T)，所以同一个 counter 下两个 kind 必须同码；
    /// `period` 只影响「这一步从哪一秒开始」，不参与码的计算。
    #[test]
    fn totp_is_hotp_with_the_same_counter() {
        for kind in ["totp", "hotp"] {
            for counter in ["0", "1", "12345"] {
                assert_eq!(
                    code_of(
                        json!({ "secret": "JBSWY3DPEHPK3PXP", "kind": kind, "counter": counter })
                    ),
                    code_of(json!({
                        "secret": "JBSWY3DPEHPK3PXP", "counter": counter, "digits": "6",
                    })),
                    "kind={kind} counter={counter}"
                );
            }
        }
    }

    // ---- 字段边界 --------------------------------------------------------

    #[test]
    fn digits_are_clamped_to_the_rfc_range() {
        let base = json!({ "secret": b32("12345678901234567890"), "counter": "1" });
        for (given, want) in [
            ("4", 6),
            ("5", 6),
            ("6", 6),
            ("8", 8),
            ("9", 8),
            ("99", 8),
            ("0", 6),
        ] {
            let mut p = base.clone();
            p["digits"] = json!(given);
            let out = compute(p).unwrap();
            assert_eq!(out["meta"]["digits"], want, "digits = {given}");
            assert_eq!(
                out["output"].as_str().unwrap().len(),
                want,
                "digits = {given}"
            );
        }
        // 缺字段 / 非数字 → 默认 6
        assert_eq!(compute(base.clone()).unwrap()["meta"]["digits"], 6);
        let mut p = base.clone();
        p["digits"] = json!("abc");
        assert_eq!(compute(p).unwrap()["meta"]["digits"], 6);
    }

    /// 表单交的是字符串、直接 curl 给的是 JSON number，两条路都得对 ——
    /// 而且顺带又钉了一次 RFC 6238 的向量（counter 1 / 8 位 = time 59 的 SHA1 值）。
    #[test]
    fn digits_also_accept_json_numbers() {
        let out = compute(json!({
            "secret": b32("12345678901234567890"), "counter": 1, "digits": 8,
        }))
        .unwrap();
        assert_eq!(out["output"], "94287082");
    }

    #[test]
    fn period_is_clamped_and_reported_for_totp() {
        let out = compute(json!({
            "secret": "JBSWY3DPEHPK3PXP", "kind": "totp", "counter": "100", "period": "60",
        }))
        .unwrap();
        assert_eq!(out["meta"]["period"], 60);
        assert_eq!(out["table"][&label("out.otp-generator.period")], 60);
        // 步起点 = counter × period
        assert_eq!(out["table"][&label("out.otp-generator.step_start")], 6000);

        // 夹取：0 → 1，9999 → 300
        for (given, want) in [("0", 1), ("1", 1), ("300", 300), ("9999", 300)] {
            let mut p = json!({ "secret": "JBSWY3DPEHPK3PXP", "kind": "totp", "counter": "100" });
            p["period"] = json!(given);
            assert_eq!(
                compute(p).unwrap()["meta"]["period"],
                want,
                "period = {given}"
            );
        }
    }

    #[test]
    fn period_does_not_leak_into_the_code() {
        // counter 是绝对时间步号，换 period 不该改变码本身
        let a = code_of(json!({ "secret": "JBSWY3DPEHPK3PXP", "counter": "7", "period": "30" }));
        let b = code_of(json!({ "secret": "JBSWY3DPEHPK3PXP", "counter": "7", "period": "90" }));
        assert_eq!(a, b);
    }

    #[test]
    fn hotp_ignores_period_but_says_so() {
        let out = compute(json!({
            "secret": "JBSWY3DPEHPK3PXP", "kind": "hotp", "counter": "7", "period": "90",
        }))
        .unwrap();
        assert_eq!(
            out["table"][&label("out.otp-generator.period")],
            crate::i18n::t("en", "out.otp-generator.no_period")
        );
        // 语言包还没并进来时，取到的就是键本身，验不了文案；
        // 并进来之后下面这条才会真的跑。
        if crate::i18n::has("en", "out.otp-generator.no_period") {
            let v = out["table"][&label("out.otp-generator.period")]
                .as_str()
                .unwrap();
            assert!(v.contains("HOTP"), "{v}");
        }
        assert!(out["meta"].get("period").is_none());
    }

    #[test]
    fn huge_counter_does_not_overflow() {
        let out = compute(json!({
            "secret": "JBSWY3DPEHPK3PXP", "kind": "totp", "counter": u64::MAX.to_string(),
            "period": "300",
        }))
        .unwrap();
        // counter × period 溢出时如实说明，而不是 panic 或悄悄回绕
        assert_eq!(
            out["table"][&label("out.otp-generator.step_start")],
            crate::i18n::t("en", "out.otp-generator.step_start_overflow")
        );
        assert_eq!(out["meta"]["counter"], u64::MAX);
        assert_eq!(
            out["table"][&label("out.otp-generator.next")],
            crate::i18n::t("en", "out.otp-generator.dash")
        );
    }

    // ---- 窗口与校验 ------------------------------------------------------

    #[test]
    fn window_exposes_the_neighbours() {
        let out = compute(json!({ "secret": "JBSWY3DPEHPK3PXP", "kind": "hotp", "counter": "2" }))
            .unwrap();
        assert_eq!(out["output"], "602287"); // counter 2
        assert_eq!(out["table"][&label("out.otp-generator.previous")], "996554"); // counter 1
        assert_eq!(out["table"][&label("out.otp-generator.next")], "143627"); // counter 3
    }

    #[test]
    fn window_at_counter_zero_has_no_previous() {
        let out = compute(json!({ "secret": "JBSWY3DPEHPK3PXP", "counter": "0" })).unwrap();
        assert_eq!(
            out["table"][&label("out.otp-generator.previous")],
            crate::i18n::t("en", "out.otp-generator.dash")
        );
        assert_eq!(out["table"][&label("out.otp-generator.next")], "996554");
    }

    #[test]
    fn token_validation_reports_the_matched_counter() {
        for (counter, token) in [("0", "282760"), ("1", "996554"), ("2", "602287")] {
            let out = compute(json!({
                "secret": "JBSWY3DPEHPK3PXP", "kind": "hotp", "counter": counter, "token": token,
            }))
            .unwrap();
            assert_eq!(
                out["table"][&label("out.otp-generator.validity")],
                crate::i18n::t("en", "out.otp-generator.valid"),
                "counter={counter}"
            );
            assert_eq!(
                out["meta"]["matched_counter"],
                counter.parse::<u64>().unwrap()
            );
            assert_eq!(out["meta"]["valid"], true);
        }
    }

    /// 窗口半径 1：相邻的 counter 能过，隔一个不能过。
    #[test]
    fn token_outside_the_window_is_rejected() {
        let out = compute(json!({
            "secret": "JBSWY3DPEHPK3PXP", "kind": "hotp", "counter": "5", "token": "282760",
        }))
        .unwrap();
        assert_eq!(
            out["table"][&label("out.otp-generator.validity")],
            crate::i18n::t("en", "out.otp-generator.invalid")
        );
        assert_eq!(out["meta"]["valid"], false);
        assert!(out["meta"]["matched_counter"].is_null());
    }

    #[test]
    fn token_at_the_window_edge_is_accepted() {
        // counter 5 的窗口是 {4,5,6}；counter 4 的码是 960129
        let out = compute(json!({
            "secret": "JBSWY3DPEHPK3PXP", "kind": "hotp", "counter": "5", "token": "960129",
        }))
        .unwrap();
        assert_eq!(
            out["table"][&label("out.otp-generator.validity")],
            crate::i18n::t("en", "out.otp-generator.valid")
        );
        assert_eq!(out["meta"]["matched_counter"], 4);
    }

    #[test]
    fn token_validation_uses_the_requested_digit_count() {
        // 8 位码不能拿去比 6 位窗口，反之亦然
        let out = compute(json!({
            "secret": "JBSWY3DPEHPK3PXP", "counter": "0", "digits": "6", "token": "0890290",
        }))
        .unwrap();
        assert_eq!(
            out["table"][&label("out.otp-generator.validity")],
            crate::i18n::t("en", "out.otp-generator.invalid")
        );
    }

    #[test]
    fn blank_token_is_treated_as_absent() {
        let out = compute(json!({ "secret": "JBSWY3DPEHPK3PXP", "counter": "0", "token": "  " }))
            .unwrap();
        assert!(out["table"].get("Valid").is_none());
        assert!(out["meta"].get("valid").is_none());
    }

    #[test]
    fn garbage_token_does_not_panic() {
        for bad in [
            "INVALID",
            "12345",
            "999999999999999999999999",
            "12345e67890",
        ] {
            let r = compute(json!({ "secret": "JBSWY3DPEHPK3PXP", "counter": "0", "token": bad }));
            assert!(r.is_ok(), "token = {bad:?} 应当返回 valid=false 而不是报错");
            assert_eq!(r.unwrap()["meta"]["valid"], false);
        }
    }

    // ---- 输出形状 -------------------------------------------------------

    #[test]
    fn output_shape_is_output_table_meta_only() {
        let out = compute(json!({ "secret": "JBSWY3DPEHPK3PXP", "counter": "0" })).unwrap();
        // serde_json 的 Map 是 BTreeMap（没开 preserve_order），所以键是字母序而不是
        // 插入序 —— 断言排序后的结果，顺便把这个事实钉住。
        let keys: Vec<&str> = out
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        assert_eq!(keys, vec!["meta", "output", "table"], "app.js 只认这三个键");

        // table 是 app.js 画的两列表：键 -> 可 String() 的值
        for (k, v) in out["table"].as_object().unwrap() {
            assert!(
                v.is_string() || v.is_number() || v.is_boolean(),
                "table[{k}] = {v} 会被 String() 直出，得是标量"
            );
            assert!(
                !k.contains('<') && !k.contains('>'),
                "键名会进 DOM，别放尖括号"
            );
        }
    }

    #[test]
    fn code_is_first_alphabetically_so_the_copy_button_grabs_it() {
        // app.js 优先渲染 table，复制按钮复制的是整张表的 textContent。
        // table 是 BTreeMap（按字母序），"Code" 必须排在 "Algorithm" 之后但尽量靠前，
        // 所以这里只钉住「Code 存在且是 output 的值」。
        // 注意行标题是按语言取的（中文界面下是「验证码」），所以得按键去找。
        let out = compute(json!({ "secret": "JBSWY3DPEHPK3PXP", "counter": "0" })).unwrap();
        assert_eq!(
            out["table"][&label("out.otp-generator.code")],
            out["output"]
        );
    }

    #[test]
    fn key_uri_is_usable_and_matches_the_reference_shape() {
        let out = compute(json!({ "secret": "JBSWY3DPEHPK3PXP" })).unwrap();
        let key_uri = label("out.otp-generator.key_uri");
        assert_eq!(
            out["table"][&key_uri],
            "otpauth://totp/IT-Tools:demo-user?issuer=IT-Tools&secret=JBSWY3DPEHPK3PXP\
&algorithm=SHA1&digits=6&period=30"
        );
        // HOTP 的 URI 用 hotp 主机名并带 counter 参数
        let out = compute(json!({ "secret": "JBSWY3DPEHPK3PXP", "kind": "hotp", "counter": "3" }))
            .unwrap();
        assert!(out["table"][&key_uri]
            .as_str()
            .unwrap()
            .starts_with("otpauth://hotp/IT-Tools:demo-user?"));
        assert!(out["table"][&key_uri]
            .as_str()
            .unwrap()
            .ends_with("&counter=3"));
    }

    #[test]
    fn secret_hex_and_counter_hex_round_trip() {
        let out = compute(json!({ "secret": "JBSWY3DPEHPK3PXP", "counter": "1" })).unwrap();
        // 参考实现 otp.service.test.ts: base32toHex('JBSWY3DPEHPK3PXP') = '48656c6c6f21deadbeef'
        assert_eq!(
            out["table"][&label("out.otp-generator.secret_hex")],
            "48656c6c6f21deadbeef"
        );
        assert_eq!(
            out["table"][&label("out.otp-generator.counter_hex")],
            "0000000000000001"
        );
        assert_eq!(out["meta"]["counter_hex"], "0000000000000001");
    }

    #[test]
    fn counter_hex_is_sixteen_digits() {
        let out = compute(json!({ "secret": "JBSWY3DPEHPK3PXP", "counter": "255" })).unwrap();
        let counter_hex = label("out.otp-generator.counter_hex");
        assert_eq!(out["table"][&counter_hex], "00000000000000ff");
        assert_eq!(out["table"][&counter_hex].as_str().unwrap().len(), 16);
    }

    // ---- 输出可复现 -----------------------------------------------------

    #[test]
    fn same_input_gives_the_same_output() {
        // 本工具不读系统时钟，所以同样入参必须完全可复现
        let p = json!({ "secret": "JBSWY3DPEHPK3PXP", "kind": "totp", "counter": "42" });
        assert_eq!(compute(p.clone()).unwrap(), compute(p).unwrap());
    }

    // ---- 结果区的语言 ---------------------------------------------------

    /// 表格的行标题要跟着请求语言走 —— 英文界面不该出现中文行标题，
    /// 中文界面也不该出现英文行标题。
    #[test]
    fn the_row_labels_follow_the_request_language() {
        let en = compute(json!({ "secret": "JBSWY3DPEHPK3PXP", "counter": "0" })).unwrap();
        let zh = compute(json!({
            "secret": "JBSWY3DPEHPK3PXP", "counter": "0", "__lang": "zh-CN",
        }))
        .unwrap();
        let en_table = en["table"].as_object().unwrap();
        let zh_table = zh["table"].as_object().unwrap();

        // 这几行在上面的入参下一定都在表里
        let keys = [
            "out.otp-generator.code",
            "out.otp-generator.kind",
            "out.otp-generator.algorithm",
            "out.otp-generator.digits",
            "out.otp-generator.counter",
            "out.otp-generator.counter_hex",
            "out.otp-generator.previous",
            "out.otp-generator.next",
            "out.otp-generator.period",
            "out.otp-generator.step_start",
            "out.otp-generator.secret_hex",
            "out.otp-generator.key_uri",
        ];
        for key in keys {
            let en_label = crate::i18n::t("en", key);
            let zh_label = crate::i18n::t("zh-CN", key);
            assert!(en_table.contains_key(&en_label), "{key}: {en_table:?}");
            assert!(zh_table.contains_key(&zh_label), "{key}: {zh_table:?}");
        }

        // 两种语言的标题确实不一样 —— 不然上面那两条断言等于什么都没验。
        // （`Key URI` 是协议里的名字，中英文一样，不在此列。）
        // 语言包还没并进来时，两边都退回键本身（键还没进语言包，分不出语言），
        // 这时先跳过这条；并进来之后它一定会跑。
        for key in keys.iter().filter(|k| **k != "out.otp-generator.key_uri") {
            if crate::i18n::has("en", key) && crate::i18n::has("zh-CN", key) {
                let en_label = crate::i18n::t("en", key);
                let zh_label = crate::i18n::t("zh-CN", key);
                assert_ne!(en_label, zh_label, "{key}");
                assert!(!zh_table.contains_key(&en_label), "{key}: {zh_table:?}");
                assert!(!en_table.contains_key(&zh_label), "{key}: {en_table:?}");
            }
        }

        // 中文行标题是中文，不是英文标题换个字体
        if crate::i18n::has("zh-CN", "out.otp-generator.code") {
            assert_eq!(crate::i18n::t("en", "out.otp-generator.code"), "Code");
            assert_eq!(crate::i18n::t("zh-CN", "out.otp-generator.code"), "验证码");
        }
    }

    /// 表里成句的值（「是 / 否」）也要跟着语言走 —— 中文界面不该出现 "Yes"。
    #[test]
    fn the_verdict_value_follows_the_request_language() {
        let payload = |lang: Option<&str>| {
            let mut p = json!({
                "secret": "JBSWY3DPEHPK3PXP", "kind": "hotp", "counter": "0", "token": "282760",
            });
            if let Some(l) = lang {
                p[util::LANG_KEY] = json!(l);
            }
            p
        };
        let en = compute(payload(None)).unwrap();
        let zh = compute(payload(Some("zh-CN"))).unwrap();

        assert_eq!(
            en["table"][&crate::i18n::t("en", "out.otp-generator.validity")],
            crate::i18n::t("en", "out.otp-generator.valid")
        );
        assert_eq!(
            zh["table"][&crate::i18n::t("zh-CN", "out.otp-generator.validity")],
            crate::i18n::t("zh-CN", "out.otp-generator.valid")
        );
        if crate::i18n::has("en", "out.otp-generator.valid") {
            assert_eq!(crate::i18n::t("en", "out.otp-generator.valid"), "Yes");
            assert_eq!(crate::i18n::t("zh-CN", "out.otp-generator.valid"), "是");
            assert_eq!(crate::i18n::t("en", "out.otp-generator.invalid"), "No");
            assert_eq!(crate::i18n::t("zh-CN", "out.otp-generator.invalid"), "否");
        }
    }

    /// TOTP / HOTP 的全称跟表单下拉框是同一句话 —— 复用的是 `opt.kind.*`，
    /// 不是另起一个 `out.otp-generator.kind_*`。
    #[test]
    fn the_kind_row_reuses_the_dropdown_wording() {
        for (kind, key) in [("totp", "opt.kind.totp"), ("hotp", "opt.kind.hotp")] {
            let out = compute(json!({ "secret": "JBSWY3DPEHPK3PXP", "kind": kind })).unwrap();
            assert_eq!(
                out["table"][&label("out.otp-generator.kind")],
                crate::i18n::t("en", key),
                "kind={kind}"
            );
        }
    }
}
