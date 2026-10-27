//! Jasypt 字符串加解密（endpoint `jasypt`）。
//!
//! 上游 issue #1738：Spring Boot 的 `jasypt-spring-boot` 从配置里读 `ENC(...)`，
//! 但要生成一个能用的密文得先在项目里搭起整个 Java 环境。
//!
//! ## 放服务端而不是 JS
//!
//! 两条算法都是 Java 的 PBE（PBES1 / PBES2）组合，浏览器里既没有 PBKDF1 也没有
//! 「从口令派生 IV」这套语义；DES 更是浏览器完全没有的分组密码。
//!
//! ## 输出长什么样
//!
//! 两种算法都是 `base64(盐 ‖ … ‖ 密文)`，**盐明文躺在密文前面** —— 所以解密时
//! 不需要用户另外提供盐，这就是 Jasypt 能做到「只配一个口令」的原因。
//!
//! | 算法 | 布局 | KDF | 密码 |
//! |---|---|---|---|
//! | `PBEWithMD5AndDES` | `盐(8) ‖ 密文` | PBKDF1-MD5 | DES-CBC，IV 取自 KDF 输出的后 8 字节 |
//! | `PBEWITHHMACSHA512ANDAES_256` | `盐 ‖ IV(16) ‖ 密文` | PBKDF2-HMAC-SHA512 | AES-256-CBC |
//!
//! 两者都用 PKCS#7 填充；DES 的块长是 8，所以 PKCS#7 在那里就是 PKCS#5。
//!
//! 注意 AES 那条：**IV 必须进载荷**，否则密文不可移植 —— Jasypt 默认配置下压根不提供
//! IV（`PBEWITHHMACSHA512ANDAES_256` 会直接抛 `EncryptionOperationNotPossibleException`），
//! 就算自己塞了个 `IvGenerator` 而忘了 `includePlainIvInEncryptionResults() == true`，
//! 加密能成功、解密时却已经没人知道 IV 是多少了。所以这里固定按「IV 明文写进结果」
//! 的形式生成，那也是唯一能跨进程解开的布局。
//!
//! ## 为什么向量是 Java 生成的
//!
//! 手写 PBE 最容易错在三个地方，且错得都很「像」：PBKDF1 到底迭代几次、
//! DES 的 IV 从哪来、以及盐是拼在密文**前面**还是后面。这些错都不会报错，
//! 只会安静地产出解不开的密文。所以单测里的向量全部由
//! `jasypt-1.9.3.jar` + `StandardPBEStringEncryptor` 实测产出（见 `tests`），
//! 而不是自己算出来再自己验 —— 那样只是循环论证。
//!
//! ## 关于 key obfuscation
//!
//! Jasypt 1.9.3 的 `PBEConfig` **已经没有** obfuscation 相关属性了
//! （`javap org.jasypt.encryption.pbe.config.PBEConfig` 只有 algorithm / password /
//! iterations / salt / iv / provider / poolSize），也就是说这一版的输出就是
//! 标准 JCE PBE 的输出，不需要任何额外处理。别被网上那些 1.6 时代的文章误导。
//!
//! ## 结果区的文案
//!
//! 结果表的行标题、表里成句的值全部走语言包（键在 `out.jasypt.*` 下面）。
//! 机器可读的部分（base64 密文、算法名、迭代数）原样保留 —— 它们是给脚本
//! 用的，不能因为界面语言变了就变形。
//!
//! 带单位的数值（盐长、明文长度）用 `{count}` 占位插进句子里 —— 这样英文界面下
//! 不会出现「3 字节」这种半中半英的混排，两种语言也可能有不同的语序。

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine as _;
use hmac::{Hmac, Mac};
use md5::{Digest, Md5};
use rand::Rng;
use serde_json::{json, Map, Value};
use sha2::Sha512;

use super::encryption::{cbc_decrypt, cbc_encrypt};
use super::util;
use super::{ToolError, ToolResult};

/// `PBEWithMD5AndDES` 的盐固定 8 字节 —— SunJCE 的 PBES1 对 DES 只接受 8，
/// 给别的长度会直接 `InvalidAlgorithmParameterException`。
const MD5DES_SALT_LEN: usize = 8;
/// `PBEWITHHMACSHA512ANDAES_256` 的 IV 固定 16 字节（AES 块长）。
const AES_IV_LEN: usize = 16;
/// 默认迭代数，与 Jasypt 的 `setKeyObtentionIterations` 默认值一致。
const DEFAULT_ITERATIONS: u64 = 1000;
/// 迭代数上限。PBKDF2 的代价是线性的，公开接口上给个天花板。
const MAX_ITERATIONS: u64 = 1_000_000;
const MIN_ITERATIONS: u64 = 1;

/// PBKDF1（RFC 8018 §5.2）：`T_1 = H(P ‖ S)`，之后 `T_i = H(T_{i-1})`。
///
/// 只用于 MD5DES —— PBKDF2 会覆盖 AES 那条路径。
fn pbkdf1_md5(password: &[u8], salt: &[u8], iterations: u32) -> [u8; 16] {
    let mut ctx = Md5::new();
    ctx.update(password);
    ctx.update(salt);
    let mut t: [u8; 16] = ctx.finalize().into();
    for _ in 1..iterations {
        let mut ctx = Md5::new();
        ctx.update(t);
        t = ctx.finalize().into();
    }
    t
}

/// PBKDF2-HMAC-SHA512（RFC 8018 §5.2）。
///
/// 没有引入 `pbkdf2` crate：这个算法本身就是十来行，
/// 而为了它多一个依赖不划算 —— 旁边 [`pbkdf1_md5`] 也是同理手写的。
fn pbkdf2_hmac_sha512(password: &[u8], salt: &[u8], iterations: u32, dk_len: usize) -> Vec<u8> {
    type HmacSha512 = Hmac<Sha512>;
    let hash_len = 64usize;
    let blocks = dk_len.div_ceil(hash_len);
    let mut out = Vec::with_capacity(blocks * hash_len);

    for block in 1..=blocks {
        let mut mac = HmacSha512::new_from_slice(password).expect("HMAC 接受任意长度的密钥");
        mac.update(salt);
        mac.update(&(block as u32).to_be_bytes());
        let mut u = mac.finalize().into_bytes();
        let mut acc: Vec<u8> = u.to_vec();

        for _ in 1..iterations {
            let mut mac = HmacSha512::new_from_slice(password).expect("同上");
            mac.update(&u);
            u = mac.finalize().into_bytes();
            for (a, b) in acc.iter_mut().zip(u.iter()) {
                *a ^= *b;
            }
        }
        out.extend_from_slice(&acc);
    }
    out.truncate(dk_len);
    out
}

/* ==========================================================================
两个算法
========================================================================== */

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Algorithm {
    Md5Des,
    HmacSha512Aes256,
}

impl Algorithm {
    fn parse(raw: &str) -> Option<Self> {
        let raw = raw.trim().to_ascii_lowercase();
        match raw.as_str() {
            "pbewithmd5anddes" | "md5des" | "md5-and-des" => Some(Self::Md5Des),
            "pbewithhmacsha512andaes_256"
            | "pbewithhmacsha512andaes256"
            | "hmacsha512andaes_256"
            | "aes256"
            | "aes-256" => Some(Self::HmacSha512Aes256),
            _ => None,
        }
    }

    fn name(self) -> &'static str {
        match self {
            Self::Md5Des => "PBEWithMD5AndDES",
            Self::HmacSha512Aes256 => "PBEWITHHMACSHA512ANDAES_256",
        }
    }

    /// 载荷里「盐之后、密文之前」那段固定内容的长度。MD5DES 没有 IV，所以是 0。
    fn fixed_header_len(self) -> usize {
        match self {
            Self::Md5Des => 0,
            Self::HmacSha512Aes256 => AES_IV_LEN,
        }
    }

    /// 密文块的字节数（PKCS#7 后密文必然是它的整数倍）。
    fn block_size(self) -> usize {
        match self {
            Self::Md5Des => 8,
            Self::HmacSha512Aes256 => 16,
        }
    }
}

/// Jasypt 默认的盐长 —— `SimpleStringPBEConfig.saltSizeBytes` 就是 8。
/// 默认值跟它一致，是为了让「只配了口令」的 Spring Boot 项目开箱即解。
const DEFAULT_SALT_LEN: usize = 8;
/// AES 的盐长下限（同 Jasypt 默认）与上限。上限只是防止密文大得离谱。
const SALT_LEN_RANGE: std::ops::RangeInclusive<u64> = 8..=64;

/// 盐长度。
///
/// MD5DES 恒为 8，不接受用户覆盖 —— SunJCE 的 PBES1 对 DES 只接受 8，
/// 传别的值只会得到一句「InvalidAlgorithmParameterException」。
///
/// AES 的盐长是**配置**而不是能从密文里读出来的东西：载荷只有 `盐 ‖ IV ‖ 密文`，
/// 没有长度字段，而 `盐长+IV+密文` 的总长度对多个盐长都成立（比如 48 字节的载荷
/// 既可以是「盐 8 + IV 16 + 密文 16 块」也可以是「盐 24 + IV 16 + 密文 8」）。
/// 靠猜的话，padding 有 1/256 概率蒙对，然后安静地吐出一段乱码 —— 比直接报错还糟。
/// 所以和迭代数一样，它只能由用户告知。
fn salt_len_for(alg: Algorithm, requested: Option<u64>) -> usize {
    match alg {
        Algorithm::Md5Des => MD5DES_SALT_LEN,
        Algorithm::HmacSha512Aes256 => requested
            .map(|n| n.clamp(*SALT_LEN_RANGE.start(), *SALT_LEN_RANGE.end()))
            .unwrap_or(DEFAULT_SALT_LEN as u64) as usize,
    }
}

/// 加密。结果是 `base64(盐 ‖ [IV ‖] 密文)`。
fn encrypt(
    alg: Algorithm,
    password: &str,
    plaintext: &str,
    salt: &[u8],
    iterations: u32,
) -> String {
    // `(载荷里要不要带 IV, 密文)`。MD5DES 的 IV 是 PBKDF1 输出的后半段，
    // 解密时能从口令重新派生，所以**不**进载荷；AES 的 IV 是独立的随机数，
    // 必须带着走。
    let (iv, ct): (Option<[u8; AES_IV_LEN]>, _) = match alg {
        Algorithm::Md5Des => {
            // PBKDF1 的 16 字节输出：前 8 是 DES 密钥，后 8 是 IV。
            let dk = pbkdf1_md5(password.as_bytes(), salt, iterations);
            let (key, iv) = dk.split_at(8);
            (
                None,
                cbc_encrypt::<cbc::Encryptor<des::Des>>(key, iv, plaintext.as_bytes()),
            )
        }
        Algorithm::HmacSha512Aes256 => {
            let key = pbkdf2_hmac_sha512(password.as_bytes(), salt, iterations, 32);
            let iv = random_iv();
            let ct = cbc_encrypt::<cbc::Encryptor<aes::Aes256>>(&key, &iv, plaintext.as_bytes());
            (Some(iv), ct)
        }
    };
    let ct = ct.expect("加密路径上的长度都由本模块自己算好，不该失败");

    let mut out = Vec::with_capacity(salt.len() + AES_IV_LEN + ct.len());
    out.extend_from_slice(salt);
    if let Some(iv) = iv {
        out.extend_from_slice(&iv);
    }
    out.extend_from_slice(&ct);
    B64.encode(out)
}

/// 随机 IV。
///
/// 刻意**不**从 KDF 派生：那样 IV 就成了口令和盐的函数，同样的输入每次都得到同一条
/// 密文，CBC 的第一块就退化成了 ECB。Jasypt 的 `RandomIvGenerator` 也是这么做的。
fn random_iv() -> [u8; AES_IV_LEN] {
    let mut iv = [0u8; AES_IV_LEN];
    rand::rng().fill_bytes(&mut iv);
    iv
}

/// 解密。输入可以是裸 base64，也可以带 `ENC(...)` 包装。
///
/// `iterations` 与 `salt_len` 必须和加密时一致 —— Jasypt **两者都不编码进载荷**，
/// 谁都得自己记着。默认值与 Jasypt 自身一致（1000 / 8），所以只配了口令的
/// Spring Boot 项目直接就能解开；改过配置的项目要把同样的数字填进来。
///
/// 错误文案全在语言包里（`out.jasypt.err.*`）。**口令绝不出现在错误里** ——
/// 它是这一整个工具最该守住的东西。
fn decrypt(
    alg: Algorithm,
    password: &str,
    encoded: &str,
    iterations: u32,
    salt_len: usize,
) -> Result<String, ToolError> {
    let raw = B64.decode(strip_enc(encoded)).map_err(|_| {
        ToolError::invalid("out.jasypt.err.not_base64", &[])
    })?;

    let body_start = salt_len + alg.fixed_header_len();
    let block = alg.block_size();
    if raw.len() < body_start + block || (raw.len() - body_start) % block != 0 {
        // MD5DES 的 IV 不进载荷，报错里就别提它 —— 「IV 0 字节」只会让人以为
        // 配置漏了。salt_size 填错时这句话本身就是唯一的线索，所以把期望布局写全。
        //
        // 布局整句在语言包里（两种算法各一条），这里只把数字递进去。
        let length = raw.len().to_string();
        let salt = salt_len.to_string();
        let block_text = block.to_string();
        return Err(match alg.fixed_header_len() {
            0 => ToolError::invalid(
                "out.jasypt.err.bad_ciphertext_length_no_iv",
                &[
                    ("length", &length),
                    ("algorithm", alg.name()),
                    ("salt", &salt),
                    ("block", &block_text),
                ],
            ),
            iv_len => {
                let iv = iv_len.to_string();
                ToolError::invalid(
                    "out.jasypt.err.bad_ciphertext_length_with_iv",
                    &[
                        ("length", &length),
                        ("algorithm", alg.name()),
                        ("salt", &salt),
                        ("iv", &iv),
                        ("block", &block_text),
                    ],
                )
            }
        });
    }

    let salt = &raw[..salt_len];
    let iv = &raw[salt_len..body_start];
    let ct = &raw[body_start..];

    let pt = match alg {
        Algorithm::Md5Des => {
            let dk = pbkdf1_md5(password.as_bytes(), salt, iterations);
            let (key, derived_iv) = dk.split_at(8);
            cbc_decrypt::<cbc::Decryptor<des::Des>>(key, derived_iv, ct)
        }
        Algorithm::HmacSha512Aes256 => {
            let key = pbkdf2_hmac_sha512(password.as_bytes(), salt, iterations, 32);
            cbc_decrypt::<cbc::Decryptor<aes::Aes256>>(&key, iv, ct)
        }
    }
    // 解不开只有两种可能：口令不对，或者迭代数 / 盐长与加密时不一致 ——
    // 后者是这个工具的固有性质（Jasypt 不把这两个数编码进载荷）。
    // 所以只给一句「解不开」的提示，具体原因让用户自己对着配置核对。
    .map_err(|_| ToolError::invalid("out.jasypt.err.decrypt_failed", &[]))?;

    String::from_utf8(pt)
        .map_err(|_| ToolError::invalid("out.jasypt.err.not_utf8", &[]))
}

/// 剥掉 `ENC(...)` 包装。`ENC(abc)`、`enc(abc)`、裸 `abc` 都能吃。
fn strip_enc(s: &str) -> &str {
    let t = s.trim();
    let lower = t.to_ascii_lowercase();
    // `lower` 与 `t` 等长（`to_ascii_lowercase` 不改 ASCII 长度），所以偏移量可以直接套用；
    // 用切片而不是 `to_string()` 是为了避免给没包 `ENC(` 的输入白白分配一次。
    if lower.starts_with("enc(") && lower.ends_with(')') && t.len() > 5 {
        &t[4..t.len() - 1]
    } else {
        t
    }
}

/* ==========================================================================
handler
========================================================================== */

pub async fn handle(payload: Value) -> ToolResult {
    util::blocking(move || compute(payload)).await
}

fn compute(payload: Value) -> ToolResult {
    let raw_alg = util::str_or(&payload, "algorithm", "PBEWithMD5AndDES");
    let alg = Algorithm::parse(raw_alg).ok_or_else(|| {
        ToolError::invalid(
            "out.jasypt.err.unknown_algorithm",
            &[
                ("algorithm", raw_alg),
                ("available", "PBEWithMD5AndDES / PBEWITHHMACSHA512ANDAES_256"),
            ],
        )
    })?;

    let mode = util::str_or(&payload, "mode", "").to_ascii_lowercase();
    let text = util::opt_str(&payload, "text").unwrap_or("");
    let password = util::opt_str(&payload, "password").unwrap_or("");

    match mode.as_str() {
        "encrypt" => run_encrypt(alg, password, text, &payload),
        "decrypt" => run_decrypt(alg, password, text, &payload),
        "" | "auto" => {
            // 没有 mode 时按「看着像不像密文」自动分一次。
            //
            // 与 bcrypt 工具刻意拒绝嗅探不同，这里嗅探是安全的：两个方向要的输入
            // 恰好是同一个字段，明文与密文互斥，且分错了会在下一步立刻报错
            // （密文解出来不是合法 UTF-8 / padding 解不开），不会静默产出错东西。
            if looks_encrypted(text) {
                run_decrypt(alg, password, text, &payload)
            } else {
                run_encrypt(alg, password, text, &payload)
            }
        }
        other => Err(ToolError::invalid(
            "out.jasypt.err.unknown_mode",
            &[
                ("mode", other),
                ("available", "encrypt / decrypt, or leave it blank to detect"),
            ],
        )),
    }
}

fn looks_encrypted(text: &str) -> bool {
    // 去掉换行/空格 —— 密文常被折行贴进配置
    let compact: String = strip_enc(text)
        .chars()
        .filter(|c| !c.is_whitespace())
        .collect();
    compact.len() >= 24 && B64.decode(&compact).is_ok()
}

fn iterations_of(payload: &Value) -> u32 {
    util::bounded_u64(
        payload,
        "iterations",
        DEFAULT_ITERATIONS,
        MIN_ITERATIONS,
        MAX_ITERATIONS,
    ) as u32
}

/* ==========================================================================
结果区的文案
========================================================================== */

/// 按语言取语言包里的文案，并把 `{name}` 占位换成给定的值。
///
/// 语言包里两种语言可以有不同的语序，所以参数是**按名字**替换的，不是按位置 ——
/// 「{count} 字节」在英文里就是「{count} bytes」。
///
/// 键找不到时 `i18n::t` 退回键本身 —— 漏翻的键在页面上是显眼的
/// `out.jasypt.xxx`，而不是安静地少一句。
fn tr(lang: &str, key: &str, args: &[(&str, String)]) -> String {
    let mut out = crate::i18n::t(lang, key);
    for (name, value) in args {
        out = out.replace(&format!("{{{name}}}"), value);
    }
    out
}

fn run_encrypt(alg: Algorithm, password: &str, plaintext: &str, payload: &Value) -> ToolResult {
    let lang = util::lang(payload);
    let iterations = iterations_of(payload);
    let salt_len = salt_len_for(alg, util::opt_u64(payload, "salt_size"));
    let mut salt = vec![0u8; salt_len];
    rand::rng().fill_bytes(&mut salt);

    let b64 = encrypt(alg, password, plaintext, &salt, iterations);
    // 主结果是机器可读的密文（带 `ENC(...)` 包装），原样输出。
    let output = format!("ENC({b64})");

    let mut table = Map::new();
    util::row(&mut table, payload, "out.jasypt.raw_base64", json!(b64));
    util::row(
        &mut table,
        payload,
        "out.jasypt.algorithm",
        json!(alg.name()),
    );
    util::row(
        &mut table,
        payload,
        "out.jasypt.iterations",
        json!(iterations.to_string()),
    );
    util::row(
        &mut table,
        payload,
        "out.jasypt.salt_length",
        json!(tr(
            lang,
            "out.jasypt.salt_length_value",
            &[("count", salt_len.to_string())],
        )),
    );
    util::row(
        &mut table,
        payload,
        "out.jasypt.plaintext_length",
        json!(tr(
            lang,
            "out.jasypt.plaintext_length_value",
            &[("count", plaintext.len().to_string())],
        )),
    );

    Ok(json!({
        "output": output,
        "table": table,
    }))
}

fn run_decrypt(alg: Algorithm, password: &str, ciphertext: &str, payload: &Value) -> ToolResult {
    let lang = util::lang(payload);
    let iterations = iterations_of(payload);
    let salt_len = salt_len_for(alg, util::opt_u64(payload, "salt_size"));
    let plaintext = decrypt(alg, password, ciphertext, iterations, salt_len)?;

    let mut table = Map::new();
    util::row(
        &mut table,
        payload,
        "out.jasypt.algorithm",
        json!(alg.name()),
    );
    util::row(
        &mut table,
        payload,
        "out.jasypt.iterations",
        json!(iterations.to_string()),
    );
    util::row(
        &mut table,
        payload,
        "out.jasypt.salt_length",
        json!(tr(
            lang,
            "out.jasypt.salt_length_value",
            &[("count", salt_len.to_string())],
        )),
    );
    // 行标题是「Note」，值是那整句提醒 —— 两者都是文案，都走语言包。
    util::row(
        &mut table,
        payload,
        "out.jasypt.note_label",
        json!(crate::i18n::t(lang, "out.jasypt.note")),
    );

    Ok(json!({
        "output": plaintext,
        "table": table,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// 结果表的行标题：键 → (英文, 中文)。
    ///
    /// 语言包还没并进去时 `i18n::t` 退回键本身 —— 单测就只断言「键在表里」，
    /// 并进去之后才断言真正的中英文行标题。
    const ROW_LABELS: [(&str, &str, &str); 6] = [
        (
            "out.jasypt.raw_base64",
            "Raw (base64)",
            "原始数据（base64）",
        ),
        ("out.jasypt.algorithm", "Algorithm", "算法"),
        ("out.jasypt.iterations", "Iterations", "迭代次数"),
        ("out.jasypt.salt_length", "Salt length", "盐长度"),
        (
            "out.jasypt.plaintext_length",
            "Plaintext length",
            "明文长度",
        ),
        ("out.jasypt.note_label", "Note", "注意"),
    ];

    /// 解密那一行「Note」的值 —— 语言包并进去之后应该长这样。
    const NOTE_EN: &str = "Jasypt does not encode the iteration count or the salt length into the ciphertext, so you must enter the same values you used when encrypting";
    const NOTE_ZH: &str = "Jasypt 不把迭代数和盐长编码进密文，解密时必须填和加密时相同的值";

    /// `org.jasypt.encryption.pbe.StandardPBEStringEncryptor`（jasypt-1.9.3.jar）
    /// 的实测输出，明文 `"hello world"`、口令 `"secret"`、盐为 `ABCDEFGH`。
    ///
    /// 生成方式见本文件顶部「为什么向量是 Java 生成的」。
    const MD5DES_VECTORS: &[(&str, u32, &str)] = &[
        ("1000", 1000, "QUJDREVGR0jVrxboF5iAb5gXmcOl/gwh"),
        ("1", 1, "QUJDREVGR0jyJqa474emZqH7PU3kdI1b"),
        ("100", 100, "QUJDREVGR0gVRLxxr5Hnz7styiVYlsIc"),
        ("2000", 2000, "QUJDREVGR0iw1m+0rt/qPz5qY9O0h6Mv"),
        ("4096", 4096, "QUJDREVGR0gjVR3zz7zv7lIAWFhCcg6j"),
    ];

    /// 同上，`PBEWITHHMACSHA512ANDAES_256`。盐长会编码在载荷里，
    /// IV 固定为 `abcdefghijklmnop`（Jasypt 的 `IvGenerator` 那次返回的值）。
    const AES_VECTORS: &[(usize, &str)] = &[
        (8, "QUJDREVGR0hhYmNkZWZnaGlqa2xtbm9wwUbNMK9uN6YhZDh2quWhdw=="),
        (
            16,
            "QUJDREVGR0hJSktMTU5PUGFiY2RlZmdoaWprbG1ub3BqAv+d/0a3ZB4naGAOtDNM",
        ),
        (
            32,
            "QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVpBQkNERUZhYmNkZWZnaGlqa2xtbm9w2oM8Zedub1uu279aaD3KBw==",
        ),
    ];

    fn salt(n: usize) -> Vec<u8> {
        (0..n).map(|i| b'A' + (i % 26) as u8).collect()
    }

    /// 行的**标题**按语言取，所以断言要按语言包里的键去取标题，
    /// 而不是把标题的字面量抄一遍 —— 抄一遍的话，改一次文案就要改一次断言。
    fn label(key: &str) -> String {
        crate::i18n::t("en", key)
    }

    /// 按语言包渲染一条文案（语言包还没并进去时退回键本身）。
    fn render(key: &str, vars: &[(&str, &str)]) -> String {
        let mut text = crate::i18n::t("en", key);
        for (name, value) in vars {
            text = text.replace(&format!("{{{name}}}"), value);
        }
        text
    }

    /// 结果表。键是语言包里的行标题。
    fn table_of(v: &Value) -> Map<String, Value> {
        v["table"].as_object().cloned().unwrap()
    }

    #[test]
    fn md5des_reproduces_the_java_vectors_byte_for_byte() {
        for (label, iterations, expected) in MD5DES_VECTORS {
            let got = encrypt(
                Algorithm::Md5Des,
                "secret",
                "hello world",
                &salt(MD5DES_SALT_LEN),
                *iterations,
            );
            assert_eq!(&got, expected, "迭代 {label} 的结果与 Jasypt 对不上");
        }
    }

    #[test]
    fn md5des_decrypts_the_java_vectors_back_to_the_plaintext() {
        for (label, iterations, expected) in MD5DES_VECTORS {
            let got = decrypt(
                Algorithm::Md5Des,
                "secret",
                expected,
                *iterations,
                MD5DES_SALT_LEN,
            )
            .unwrap_or_else(|e| panic!("迭代 {label} 解密失败: {e}"));
            assert_eq!(got, "hello world", "迭代 {label}");
        }
    }

    /// 迭代数不编码进载荷，所以换个迭代数去解同一条密文必须失败。
    /// 这条断言挡住「悄悄用默认值解开」的假成功。
    #[test]
    fn a_different_iteration_count_does_not_silently_succeed() {
        let raw = MD5DES_VECTORS[0].2;
        assert!(decrypt(Algorithm::Md5Des, "secret", raw, 1000, MD5DES_SALT_LEN).is_ok());
        assert!(decrypt(Algorithm::Md5Des, "secret", raw, 999, MD5DES_SALT_LEN).is_err());
    }

    #[test]
    fn aes256_decrypts_the_java_vectors_back_to_the_plaintext() {
        for (salt_len, expected) in AES_VECTORS {
            let got = decrypt(
                Algorithm::HmacSha512Aes256,
                "secret",
                expected,
                1000,
                *salt_len,
            )
            .unwrap_or_else(|e| panic!("盐长 {salt_len} 解密失败: {e}"));
            assert_eq!(got, "hello world", "盐长 {salt_len}");
        }
    }

    /// 载荷里没有盐长字段，所以盐长是调用方给的。这里锁住两件事：
    /// 给对了能解开；**给错了不会蒙对**。
    #[test]
    fn aes_salt_length_is_configuration_not_inferred_from_the_payload() {
        for (salt_len, encoded) in AES_VECTORS {
            let raw = B64.decode(encoded).unwrap();
            assert!(raw.len() > salt_len + AES_IV_LEN, "盐长 {salt_len}");
            assert_eq!(
                (raw.len() - salt_len - AES_IV_LEN) % 16,
                0,
                "盐长 {salt_len}"
            );
            assert_eq!(
                decrypt(
                    Algorithm::HmacSha512Aes256,
                    "secret",
                    encoded,
                    1000,
                    *salt_len
                )
                .unwrap(),
                "hello world",
                "盐长 {salt_len}"
            );
        }

        // 32 字节盐的密文按 8 字节盐去解，总长仍能凑成整数个块 ——
        // 曾经的反推逻辑就会在这里静默取到错误的切分。
        let (real_len, encoded) = AES_VECTORS[2];
        assert!(decrypt(
            Algorithm::HmacSha512Aes256,
            "secret",
            encoded,
            1000,
            real_len
        )
        .is_ok());
        assert!(decrypt(Algorithm::HmacSha512Aes256, "secret", encoded, 1000, 8).is_err());
    }

    #[test]
    fn aes_re_encrypting_the_extracted_salt_and_iv_reproduces_the_vector() {
        // AES 的 IV 进载荷，所以可以把它抠出来复用：同一 (salt, iv) 必然产出同一条密文。
        // 这条断言把「解密切分正确」和「加密实现正确」绑在一起。
        let (salt_len, expected) = AES_VECTORS[0];
        let raw = B64.decode(expected).unwrap();
        let s = &raw[..salt_len];
        let iv = &raw[salt_len..salt_len + AES_IV_LEN];
        let ct = &raw[salt_len + AES_IV_LEN..];

        let key = pbkdf2_hmac_sha512(b"secret", s, 1000, 32);
        let got = cbc_encrypt::<cbc::Encryptor<aes::Aes256>>(&key, iv, b"hello world").unwrap();
        assert_eq!(got, ct, "同 salt+iv 重新加密应当复现 Jasypt 的密文");
    }

    #[test]
    fn enc_wrapper_is_accepted_and_stripped_on_input() {
        let raw = MD5DES_VECTORS[0].2;
        for form in [
            raw.to_string(),
            format!("ENC({raw})"),
            format!("enc({raw})"),
            format!("  ENC({raw})  "),
        ] {
            assert_eq!(
                decrypt(Algorithm::Md5Des, "secret", &form, 1000, MD5DES_SALT_LEN).unwrap(),
                "hello world",
                "{form}"
            );
        }
    }

    #[test]
    fn encrypt_output_round_trips_through_the_handler_in_both_directions() {
        for algorithm in ["PBEWithMD5AndDES", "PBEWITHHMACSHA512ANDAES_256"] {
            let out = compute(json!({
                "mode": "encrypt", "algorithm": algorithm,
                "password": "secret", "text": "口令里有中文 and \"引号\"",
                "iterations": "100",
            }))
            .unwrap();
            let enc = out["output"].as_str().unwrap().to_string();
            assert!(
                enc.starts_with("ENC(") && enc.ends_with(')'),
                "{algorithm}: {enc}"
            );
            // 剥包装只能剥「ENC(」和末尾的「)」。早先这里用的是
            // trim_matches(|c| c == 'E' || c == 'N' || c == 'C' || ...)，那是剥两端的
            // 每一个 E/N/C —— 而 E、N、C 都是合法的 base64 字符，密文随机生成，
            // 一旦开头（或结尾）撞上就被吃掉一截，这条测试会随机失败。
            let raw = enc
                .strip_prefix("ENC(")
                .and_then(|s| s.strip_suffix(')'))
                .unwrap_or_else(|| panic!("{algorithm}: 加密输出应带 ENC(...) 包装，实际是 {enc}"));
            assert_eq!(
                out["table"][&label("out.jasypt.raw_base64")],
                raw,
                "{algorithm}"
            );

            let back = compute(json!({
                "mode": "decrypt", "algorithm": algorithm,
                "password": "secret", "text": enc, "iterations": "100",
            }))
            .unwrap();
            assert_eq!(back["output"], "口令里有中文 and \"引号\"", "{algorithm}");
        }
    }

    #[test]
    fn each_encryption_uses_a_fresh_salt_so_the_same_text_encrypts_differently() {
        let a = compute(
            json!({ "mode": "encrypt", "password": "p", "text": "same", "iterations": "10" }),
        )
        .unwrap()["output"]
            .as_str()
            .unwrap()
            .to_string();
        let b = compute(
            json!({ "mode": "encrypt", "password": "p", "text": "same", "iterations": "10" }),
        )
        .unwrap()["output"]
            .as_str()
            .unwrap()
            .to_string();
        assert_ne!(a, b, "两次加密用了同一个盐");
        // 但两边都还能解开
        for line in [a, b] {
            assert_eq!(
                compute(
                    json!({ "mode": "decrypt", "password": "p", "text": line, "iterations": "10" })
                )
                .unwrap()["output"],
                "same"
            );
        }
    }

    #[test]
    fn a_wrong_password_fails_loudly_instead_of_returning_garbage() {
        // padding 解不开，或者解开了不是 UTF-8 —— 两条路都必须报错而不是给一段乱码
        for algorithm in ["PBEWithMD5AndDES", "PBEWITHHMACSHA512ANDAES_256"] {
            let good = compute(json!({
                "mode": "encrypt", "algorithm": algorithm, "password": "right",
                "text": "hello world", "iterations": "100",
            }))
            .unwrap()["output"]
                .as_str()
                .unwrap()
                .to_string();

            let err = compute(json!({
                "mode": "decrypt", "algorithm": algorithm, "password": "wrong",
                "text": good, "iterations": "100",
            }))
            .unwrap_err();
            assert!(
                matches!(err, ToolError::InvalidKeyed { .. }),
                "{algorithm} 应当是 InvalidKeyed，得到 {err:?}"
            );
        }
    }

    #[test]
    fn mode_auto_picks_a_direction_from_the_shape_of_the_input() {
        // 密文 → 解密
        let line = compute(json!({
            "mode": "encrypt", "password": "p", "text": "some text", "iterations": "10"
        }))
        .unwrap()["output"]
            .as_str()
            .unwrap()
            .to_string();
        assert_eq!(
            compute(json!({ "password": "p", "text": line.clone(), "iterations": "10" })).unwrap()
                ["output"],
            "some text"
        );

        // 短明文（不够 base64 解码的形状）→ 加密
        assert_eq!(
            compute(json!({ "password": "p", "text": "hi" })).unwrap()["table"]
                [&label("out.jasypt.plaintext_length")],
            render("out.jasypt.plaintext_length_value", &[("count", "2")])
        );
    }

    #[test]
    fn plain_passwords_and_short_text_are_not_mistaken_for_ciphertext() {
        for text in ["hello", "1234567890123456789012", "not base64 !!!", "abc"] {
            assert!(!looks_encrypted(text), "{text:?} 被误判成密文");
        }
        assert!(looks_encrypted(MD5DES_VECTORS[0].2));
        assert!(looks_encrypted(&format!("ENC({})", MD5DES_VECTORS[0].2)));
        // 折行的密文也算（贴进配置文件时常被换行）
        let raw = MD5DES_VECTORS[0].2;
        assert!(looks_encrypted(&format!(
            "{}\n  {}",
            &raw[..16],
            &raw[16..]
        )));
    }

    /// `salt_size` 填错时，报错里必须给出期望布局 —— 那是用户唯一的线索。
    #[test]
    fn a_wrong_salt_size_explains_the_layout_it_expected() {
        let aes = AES_VECTORS[2]; // 32 字节盐
        let err = decrypt(Algorithm::HmacSha512Aes256, "secret", aes.1, 1000, 8).unwrap_err();
        // 键对了，参数也带上了 —— 具体的文案在语言包里
        match &err {
            ToolError::InvalidKeyed { key, args } => {
                assert_eq!(*key, "out.jasypt.err.bad_ciphertext_length_with_iv");
                let names: Vec<&str> = args.iter().map(|(n, _)| n.as_str()).collect();
                for want in ["salt", "iv", "block"] {
                    assert!(names.iter().any(|n| *n == want), "参数里该有 {want}：{names:?}");
                }
            }
            other => panic!("应当是 InvalidKeyed，得到 {other:?}"),
        }
        if crate::i18n::has("zh-CN", "out.jasypt.err.bad_ciphertext_length_with_iv") {
            let msg = err.localize("zh-CN");
            assert!(msg.contains("盐 8 字节"), "{msg}");
            assert!(msg.contains("IV 16 字节"), "{msg}");
            assert!(msg.contains("16 字节密文块"), "{msg}");
        }

        // MD5DES 的载荷里没有 IV，错误信息里也不该出现它
        let err = decrypt(Algorithm::Md5Des, "secret", "QUJD", 1000, MD5DES_SALT_LEN).unwrap_err();
        match &err {
            ToolError::InvalidKeyed { key, .. } => {
                assert_eq!(*key, "out.jasypt.err.bad_ciphertext_length_no_iv");
            }
            other => panic!("应当是 InvalidKeyed，得到 {other:?}"),
        }
        if crate::i18n::has("zh-CN", "out.jasypt.err.bad_ciphertext_length_no_iv") {
            let msg = err.localize("zh-CN");
            assert!(
                msg.contains("盐 8 字节") && msg.contains("8 字节密文块"),
                "{msg}"
            );
            assert!(!msg.contains("IV"), "{msg}");
        }
    }

    #[test]
    fn truncated_ciphertext_is_rejected_before_any_decryption() {
        let raw = MD5DES_VECTORS[0].2;
        for short in ["", "QUJD", "QUJDREVGR0jV"] {
            let err =
                decrypt(Algorithm::Md5Des, "secret", short, 1000, MD5DES_SALT_LEN).unwrap_err();
            assert!(
                matches!(err, ToolError::InvalidKeyed { .. }),
                "{short:?}: {err:?}"
            );
        }
        // 不是 base64
        assert!(decrypt(Algorithm::Md5Des, "secret", "!!!!", 1000, MD5DES_SALT_LEN).is_err());
        let _ = raw;
    }

    #[test]
    fn algorithm_names_and_aliases_both_parse() {
        for (input, want) in [
            ("PBEWithMD5AndDES", Algorithm::Md5Des),
            ("md5des", Algorithm::Md5Des),
            ("  PBEWithMD5AndDES  ", Algorithm::Md5Des),
            ("PBEWITHHMACSHA512ANDAES_256", Algorithm::HmacSha512Aes256),
            ("aes256", Algorithm::HmacSha512Aes256),
        ] {
            assert_eq!(Algorithm::parse(input), Some(want), "{input}");
        }
        assert_eq!(Algorithm::parse("argon2"), None);
    }

    #[test]
    fn unknown_algorithm_names_the_accepted_values() {
        let err =
            compute(json!({ "algorithm": "scrypt", "password": "p", "text": "x" })).unwrap_err();
        // 错误是「带键」的：文案在语言包里，键本身只有一串路径，
        // 断言消息文本要断言**渲染后**的句子。
        let msg = err.localize("en");
        assert!(msg.contains("PBEWithMD5AndDES"), "{msg}");
        assert!(msg.contains("PBEWITHHMACSHA512ANDAES_256"), "{msg}");
    }

    #[test]
    fn unknown_mode_names_the_accepted_values() {
        let err = compute(json!({ "mode": "sign", "password": "p", "text": "x" })).unwrap_err();
        let msg = err.localize("en");
        assert!(msg.contains("encrypt") && msg.contains("decrypt"), "{msg}");
    }

    #[test]
    fn iterations_are_clamped_not_rejected() {
        assert_eq!(iterations_of(&json!({ "iterations": 0 })), 1);
        assert_eq!(
            iterations_of(&json!({ "iterations": -5 })),
            DEFAULT_ITERATIONS as u32
        );
        assert_eq!(
            iterations_of(&json!({ "iterations": "junk" })),
            DEFAULT_ITERATIONS as u32
        );
        assert_eq!(iterations_of(&json!({ "iterations": 50 })), 50);
        assert_eq!(iterations_of(&json!({})), 1000);
        assert_eq!(
            iterations_of(&json!({ "iterations": 99_000_000 })),
            MAX_ITERATIONS as u32
        );
    }

    #[test]
    fn salt_size_is_pinned_for_md5des_and_clamped_for_aes() {
        // MD5DES 被 SunJCE 限死成 8，用户填什么都不影响
        for requested in [None, Some(1), Some(16), Some(999)] {
            assert_eq!(
                salt_len_for(Algorithm::Md5Des, requested),
                8,
                "{requested:?}"
            );
        }
        // AES 的盐长可调，但夹在 8..=64；默认值与 Jasypt 的 saltSizeBytes 一致
        assert_eq!(
            salt_len_for(Algorithm::HmacSha512Aes256, None),
            DEFAULT_SALT_LEN
        );
        assert_eq!(salt_len_for(Algorithm::HmacSha512Aes256, Some(1)), 8);
        assert_eq!(salt_len_for(Algorithm::HmacSha512Aes256, Some(999)), 64);
    }

    #[test]
    fn pbkdf2_matches_the_rfc_6070_style_shape() {
        // PBKDF2-HMAC-SHA512 的公开测试向量（RFC 6070 是 HMAC-SHA1；
        // 这里只验结构：长度截断与多块拼接）。
        let out = pbkdf2_hmac_sha512(b"password", b"salt", 1, 128);
        assert_eq!(out.len(), 128);
        assert_ne!(
            pbkdf2_hmac_sha512(b"password", b"salt", 1, 128),
            pbkdf2_hmac_sha512(b"password", b"salt", 2, 128),
            "迭代 1 与 2 应当不同"
        );
        // 只取前 32 字节（真正用到的 AES-256 密钥长度）时结果与 128 字节版本同前缀
        assert_eq!(pbkdf2_hmac_sha512(b"password", b"salt", 1, 32), out[..32]);
        // 前 2 块与单独算的 2 块一致（验证 block 计数器从 1 开始且逐块递增）
        let mut expect = Vec::new();
        for b in 1..=2u32 {
            let mut mac = Hmac::<Sha512>::new_from_slice(b"password").unwrap();
            mac.update(b"salt");
            mac.update(&b.to_be_bytes());
            expect.extend_from_slice(&mac.finalize().into_bytes());
        }
        assert_eq!(&out[..], &expect[..]);
    }

    #[test]
    fn empty_plaintext_round_trips() {
        for algorithm in ["PBEWithMD5AndDES", "PBEWITHHMACSHA512ANDAES_256"] {
            let enc = compute(json!({
                "mode": "encrypt", "algorithm": algorithm,
                "password": "secret", "text": "", "iterations": "10"
            }))
            .unwrap()["output"]
                .as_str()
                .unwrap()
                .to_string();
            assert_eq!(
                compute(
                    json!({ "mode": "decrypt", "algorithm": algorithm, "password": "secret",
                                "text": enc, "iterations": "10" })
                )
                .unwrap()["output"],
                ""
            );
        }
    }

    #[test]
    fn empty_password_is_allowed() {
        let enc = compute(json!({
            "mode": "encrypt", "password": "", "text": "hi", "iterations": "10"
        }))
        .unwrap()["output"]
            .as_str()
            .unwrap()
            .to_string();
        assert_eq!(
            compute(json!({ "mode": "decrypt", "password": "", "text": enc, "iterations": "10" }))
                .unwrap()["output"],
            "hi"
        );
    }

    #[test]
    fn errors_never_echo_the_password() {
        for payload in [
            json!({ "mode": "encrypt", "algorithm": "scrypt", "password": "hunter2", "text": "x" }),
            json!({ "mode": "sign", "password": "hunter2", "text": "x" }),
            json!({ "mode": "decrypt", "password": "hunter2", "text": "!!!" }),
            json!({ "mode": "decrypt", "password": "hunter2", "text": "QUJD" }),
        ] {
            let msg = compute(payload).unwrap_err().to_string();
            assert!(!msg.contains("hunter2"), "错误信息泄露了口令: {msg}");
        }
    }

    /* ---- 结果区的文案 ---- */

    /// 行标题按**请求语言**取：带 `__lang: "zh-CN"` 是中文行标题，
    /// 不带（默认英文）是英文行标题。
    #[test]
    fn the_row_title_follows_the_request_language() {
        let encrypt = |lang: Option<&str>| {
            let mut payload = json!({
                "mode": "encrypt", "password": "p", "text": "hi", "iterations": "100",
            });
            if let Some(l) = lang {
                payload[util::LANG_KEY] = json!(l);
            }
            compute(payload).unwrap()
        };
        let zh = encrypt(Some("zh-CN"));
        let en = encrypt(None);

        for (key, en_text, zh_text) in ROW_LABELS {
            // 加密那侧没有「Note」这一行 —— 提醒只在解密时给。
            if key == "out.jasypt.note_label" {
                continue;
            }
            let zh_title = crate::i18n::t("zh-CN", key);
            let en_title = crate::i18n::t("en", key);
            assert!(
                table_of(&zh).contains_key(&zh_title),
                "中文请求缺 {key} 的行标题: {zh_title}"
            );
            assert!(
                table_of(&en).contains_key(&en_title),
                "英文请求缺 {key} 的行标题: {en_title}"
            );

            // 语言包并进去之后（现在还没并），中英文的行标题必须真的不一样
            if crate::i18n::has("zh-CN", key) {
                assert_eq!(zh_title, zh_text, "{key} 的中文行标题不对");
                assert_eq!(en_title, en_text, "{key} 的英文行标题不对");
            }
        }
    }

    /// 解密那侧的「Note」行：标题是「Note」，值是那整句提醒 ——
    /// 两者都按语言取，英文界面下不能露出中文。
    #[test]
    fn the_note_row_is_localized_on_both_ends() {
        let raw = MD5DES_VECTORS[0].2;
        let decrypt = |lang: Option<&str>| {
            let mut payload = json!({ "mode": "decrypt", "password": "secret", "text": raw });
            if let Some(l) = lang {
                payload[util::LANG_KEY] = json!(l);
            }
            compute(payload).unwrap()
        };
        let zh = decrypt(Some("zh-CN"));
        let en = decrypt(None);

        let zh_title = crate::i18n::t("zh-CN", "out.jasypt.note_label");
        let en_title = crate::i18n::t("en", "out.jasypt.note_label");
        assert_eq!(
            zh["table"][zh_title.as_str()],
            json!(crate::i18n::t("zh-CN", "out.jasypt.note"))
        );
        assert_eq!(
            en["table"][en_title.as_str()],
            json!(crate::i18n::t("en", "out.jasypt.note"))
        );

        // 语言包并进去之后，提醒本身必须是翻译过的，不是键本身
        if crate::i18n::has("zh-CN", "out.jasypt.note") {
            assert_eq!(crate::i18n::t("en", "out.jasypt.note"), NOTE_EN);
            assert_eq!(crate::i18n::t("zh-CN", "out.jasypt.note"), NOTE_ZH);
        }
    }

    /// 带单位的数值（盐长、明文长度）走语言包里的句子：
    /// 英文界面下不能出现「8 字节」这种半中半英的混排。
    #[test]
    fn the_lengths_are_rendered_from_the_locale() {
        let out = compute(json!({
            "mode": "encrypt", "password": "p", "text": "hi",
            "algorithm": "PBEWITHHMACSHA512ANDAES_256", "salt_size": "16",
        }))
        .unwrap();
        let table = table_of(&out);
        assert_eq!(
            table[&label("out.jasypt.salt_length")],
            json!(render("out.jasypt.salt_length_value", &[("count", "16")]))
        );
        assert_eq!(
            table[&label("out.jasypt.plaintext_length")],
            json!(render(
                "out.jasypt.plaintext_length_value",
                &[("count", "2")]
            ))
        );

        // 语言包并进去之后，英文那格是「16 bytes」，中文那格是「16 字节」
        if crate::i18n::has("zh-CN", "out.jasypt.salt_length_value") {
            assert_eq!(
                crate::i18n::t("en", "out.jasypt.salt_length_value").replace("{count}", "16"),
                "16 bytes"
            );
            assert_eq!(
                crate::i18n::t("zh-CN", "out.jasypt.salt_length_value").replace("{count}", "16"),
                "16 字节"
            );
            assert_eq!(
                crate::i18n::t("en", "out.jasypt.plaintext_length_value").replace("{count}", "2"),
                "2 UTF-8 bytes"
            );
            assert_eq!(
                crate::i18n::t("zh-CN", "out.jasypt.plaintext_length_value")
                    .replace("{count}", "2"),
                "2 字节"
            );
        }
    }

    /// 机器可读的值（算法名、迭代数、base64 密文）不因界面语言而变。
    #[test]
    fn the_machine_readable_values_stay_the_same_in_every_language() {
        let base = json!({
            "mode": "encrypt", "password": "p", "text": "hi", "iterations": "100",
        });
        let mut zh_payload = base.clone();
        zh_payload[util::LANG_KEY] = json!("zh-CN");
        let zh = compute(zh_payload).unwrap();
        let en = compute(base).unwrap();

        // 行标题按语言取，值不变 —— 中文界面下那一行叫「算法」，值还是
        // `PBEWithMD5AndDES`（脚本要读的机器可读值）。
        assert_eq!(
            zh["table"][&crate::i18n::t("zh-CN", "out.jasypt.algorithm")],
            json!("PBEWithMD5AndDES")
        );
        assert_eq!(
            zh["table"][&crate::i18n::t("zh-CN", "out.jasypt.iterations")],
            json!("100")
        );
        assert_eq!(
            en["table"][&label("out.jasypt.algorithm")],
            json!("PBEWithMD5AndDES")
        );
        assert_eq!(en["table"][&label("out.jasypt.iterations")], json!("100"));
        // 密文本身每次都不一样（每次用新盐），但两种语言下的**形状**一样：
        // `ENC(base64)`，而 base64 是机器可读的，不该被界面语言改写。
        for out in [&zh, &en] {
            let s = out["output"].as_str().unwrap();
            assert!(s.starts_with("ENC(") && s.ends_with(')'), "{s}");
            assert!(B64.decode(&s[4..s.len() - 1]).is_ok(), "{s}");
        }
    }
}
