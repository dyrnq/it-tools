//! Hash text —— 文本摘要（MD5 / SHA1 / SHA2 / SHA3 / RIPEMD160 / BLAKE / Keccak / xxHash / 校验和）。
//!
//! 放服务端的原因：WebCrypto 原生只支持 SHA-1/SHA-2，缺 SHA3 与 RIPEMD160，
//! 参考项目为此引入了整个 `crypto-js`；这里用 RustCrypto 的实现更快也更干净。
//!
//! 算法清单对齐上游 PR #986（它用 `hash-wasm` 一口气补了 13 种）。有两处不一样，
//! 都写在下面，免得以后有人以为漏了：
//!
//! * **加盐的算法不进这个工具** —— pbkdf2 / argon2 同一段文本每次结果都不同，
//!   放进「把所有摘要并排列出来」的视图里会误导人（看着像算错了）。
//!   它们有自己的工具：`argon2-hash-generator`。
//! * **sm3 / whirlpool 没收录** —— 这台机器不能联网拉 crate，
//!   而本机 cargo 缓存里没有这两个包。将来能联网时补进去是纯加法，
//!   参考值已经算好放在 `sm3` / `whirlpool` 那条单测的注释里。
//!
//! 下拉里的 `all` 是**伪算法**：一次算完所有摘要，跟上游「全部列出来」一个意思。
//! 它不在 [`ALL`] 里（那是指真算法），但下拉里必须有它，否则并排视图没法用。

use blake2::{Blake2b512, Blake2s256};
use md5::{Digest, Md5};
use ripemd::Ripemd160;
use serde_json::{json, Value};
use sha1::Sha1;
use sha2::{Sha224, Sha256, Sha384, Sha512};
use sha3::{Keccak256, Keccak512, Sha3_224, Sha3_256, Sha3_384, Sha3_512};

use super::{ToolError, ToolResult};

/// 输入文本
const MAX_INPUT: usize = 32 * 1024 * 1024;

/// 下拉里的「一次算完所有」这一项。
const ALL_PSEUDO: &str = "all";

/// 不指定算法时并排展示的算法列表。
///
/// 刻意和注册表 `ApiSpec` 里 `algorithm` 下拉的取值保持一一对应：下拉里有、
/// 这里没有的话，用户能单独选到某个算法，却在默认的并排视图里找不到它
/// （sha3-224 / sha3-384 就这样漏过一次）。`all_algorithms_match_the_registry`
/// 这条单测盯着这件事。
pub(crate) const ALL: &[&str] = &[
    "md5",
    "sha1",
    "sha224",
    "sha256",
    "sha384",
    "sha512",
    "sha3-224",
    "sha3-256",
    "sha3-384",
    "sha3-512",
    "ripemd160",
    "blake2b-512",
    "blake2s-256",
    "blake3",
    // Keccak 是**旧填充**（不是 NIST 的 SHA-3）：以太坊那条链用的就是它。
    // 跟 sha3-256 的结果不一样，两边混用会出事，所以单列。
    "keccak-256",
    "keccak-512",
    "xxhash32",
    "xxhash64",
    "xxh3-64",
    "xxh3-128",
    // 校验和那一类：不是密码学摘要，但排查文件/网络问题时常要用。
    "adler32",
    "crc32",
    "crc32c",
];

pub(crate) fn hex(algorithm: &str, data: &[u8]) -> Option<String> {
    let out = match algorithm {
        "md5" => hex::encode(Md5::digest(data)),
        "sha1" => hex::encode(Sha1::digest(data)),
        "sha224" => hex::encode(Sha224::digest(data)),
        "sha256" => hex::encode(Sha256::digest(data)),
        "sha384" => hex::encode(Sha384::digest(data)),
        "sha512" => hex::encode(Sha512::digest(data)),
        "sha3-224" => hex::encode(Sha3_224::digest(data)),
        "sha3-256" => hex::encode(Sha3_256::digest(data)),
        "sha3-384" => hex::encode(Sha3_384::digest(data)),
        "sha3-512" => hex::encode(Sha3_512::digest(data)),
        "ripemd160" => hex::encode(Ripemd160::digest(data)),
        "blake2b-512" => hex::encode(Blake2b512::digest(data)),
        "blake2s-256" => hex::encode(Blake2s256::digest(data)),
        "blake3" => blake3::hash(data).to_hex().to_string(),
        "keccak-256" => hex::encode(Keccak256::digest(data)),
        "keccak-512" => hex::encode(Keccak512::digest(data)),
        // xxHash 系列的**字节序是定死的**：官方规定哈希值按大端写。
        // `oneshot` 返回的是数值，所以要先转成大端字节再 hex ——
        // 直接 `format!("{:x}", v)` 会丢掉前导 0，长度也跟着不对。
        "xxhash32" => hex::encode(twox_hash::XxHash32::oneshot(0, data).to_be_bytes()),
        "xxhash64" => hex::encode(twox_hash::XxHash64::oneshot(0, data).to_be_bytes()),
        "xxh3-64" => hex::encode(twox_hash::XxHash3_64::oneshot(data).to_be_bytes()),
        "xxh3-128" => hex::encode(twox_hash::XxHash3_128::oneshot(data).to_be_bytes()),
        // 校验和同样是定长大端。
        "adler32" => hex::encode(adler32::RollingAdler32::from_buffer(data).hash().to_be_bytes()),
        "crc32" => hex::encode(crc32fast::hash(data).to_be_bytes()),
        "crc32c" => hex::encode(crc32c::crc32c(data).to_be_bytes()),
        _ => return None,
    };
    Some(out)
}

/// 与注册表 `ApiSpec.fields` 保持一致。
///
/// 本工具纯查表式计算，没有 CPU 密集部分，所以 `handle` 只是同步 `compute` 的壳。
pub async fn handle(payload: Value) -> ToolResult {
    compute(payload)
}

fn compute(payload: Value) -> ToolResult {
    let text = payload
        .get("text")
        .and_then(Value::as_str)
        .unwrap_or_default();

    if text.len() > MAX_INPUT {
        let size = text.len().to_string();
        let max = MAX_INPUT.to_string();
        return Err(ToolError::invalid(
            "out.hash-text.err.input_too_long",
            &[("size", &size), ("max", &max)],
        ));
    }

    // 未指定算法时返回全部摘要，对齐参考项目的多算法并排展示
    let single = super::util::opt_str(&payload, "algorithm").filter(|a| !a.is_empty());

    if let Some(algorithm) = single {
        if algorithm != ALL_PSEUDO {
            let digest = hex(algorithm, text.as_bytes()).ok_or_else(|| {
                ToolError::invalid(
                    "out.hash-text.err.unknown_algorithm",
                    &[("algorithm", algorithm)],
                )
            })?;
            return Ok(json!({
                "output": digest,
                "meta": { "algorithm": algorithm, "length": digest.len() },
            }));
        }
    }

    let mut results = serde_json::Map::new();
    let mut rows: Vec<Value> = Vec::new();
    for algorithm in ALL {
        if let Some(digest) = hex(algorithm, text.as_bytes()) {
            results.insert((*algorithm).to_string(), json!(digest));
            // `rows` 是给「一行一个格式」那种界面用的：参考实现的 hash-text
            // 就是一列 n-input-group（算法名 + 只读框 + 复制图标），
            // 前端按 rows 渲染，标签优先取下拉里的算法名。
            rows.push(json!({ "key": algorithm, "label": algorithm, "value": digest }));
        }
    }
    Ok(json!({
        "output": "",
        "table": results,
        "rows": rows,
        "meta": { "count": rows.len() },
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn md5_of_abc_is_known_value() {
        let out = compute(json!({ "text": "abc", "algorithm": "md5" })).unwrap();
        assert_eq!(out["output"], "900150983cd24fb0d6963f7d28e17f72");
    }

    #[test]
    fn sha256_of_abc_is_known_value() {
        let out = compute(json!({ "text": "abc", "algorithm": "sha256" })).unwrap();
        assert_eq!(
            out["output"],
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn sha3_and_ripemd_available() {
        let out = compute(json!({ "text": "abc", "algorithm": "sha3-256" })).unwrap();
        assert_eq!(out["output"].as_str().unwrap().len(), 64);
        let out = compute(json!({ "text": "abc", "algorithm": "ripemd160" })).unwrap();
        assert_eq!(out["output"].as_str().unwrap().len(), 40);
    }

    #[test]
    fn ripemd160_known_value() {
        let out = compute(json!({ "text": "abc", "algorithm": "ripemd160" })).unwrap();
        assert_eq!(out["output"], "8eb208f7e05d987a9b044a8e98c6b087f15a0bfc");
    }

    #[test]
    fn no_algorithm_returns_all() {
        let out = compute(json!({ "text": "abc" })).unwrap();
        let table = out["table"].as_object().unwrap();
        assert!(table.contains_key("md5"));
        assert!(table.contains_key("ripemd160"));
    }

    #[test]
    fn unknown_algorithm_errors() {
        match compute(json!({ "text": "x", "algorithm": "nope" })).unwrap_err() {
            ToolError::InvalidKeyed { key, args } => {
                assert_eq!(key, "out.hash-text.err.unknown_algorithm");
                assert!(args.iter().any(|(name, value)| name == "algorithm" && value == "nope"));
            }
            other => panic!("应当报 unknown_algorithm，实际 {other:?}"),
        }
    }

    #[test]
    fn empty_text_is_allowed() {
        let out = compute(json!({ "text": "", "algorithm": "sha256" })).unwrap();
        assert_eq!(
            out["output"],
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
    }

    /// 下拉里的每个算法都必须在并排视图里出现，反之亦然。
    /// 缺一个的症状很隐蔽：单选能算出来，默认视图却少一行，看着像 bug 又不像。
    #[test]
    fn all_algorithms_match_the_registry() {
        use crate::registry::{ImplKind, TOOLS};
        let tool = TOOLS.iter().find(|t| t.slug == "hash-text").unwrap();
        let ImplKind::Api(spec) = tool.impl_kind else {
            panic!("hash-text 不该是 Api 工具")
        };
        let field = spec
            .fields
            .iter()
            .find(|f| f.name == "algorithm")
            .expect("没有 algorithm 字段");
        let dropdown: Vec<&str> = field.options.iter().map(|(v, _)| *v).collect();

        // 下拉第一项是「一次算完所有」那个伪算法，它不在 ALL 里（ALL 只列真算法）。
        assert_eq!(
            dropdown.first().copied(),
            Some(ALL_PSEUDO),
            "下拉第一项应当是 {ALL_PSEUDO:?}（并排视图的入口）"
        );
        let real: Vec<&str> = dropdown
            .iter()
            .copied()
            .filter(|v| *v != ALL_PSEUDO)
            .collect();

        assert_eq!(
            real, ALL,
            "并排视图的算法列表和下拉对不上：下拉 {real:?}，并排 {ALL:?}"
        );
    }

    /// 「一次算完所有」这一项走的是并排视图，不是单值视图。
    #[test]
    fn the_all_option_returns_the_parallel_view() {
        let out = compute(json!({ "text": "abc", "algorithm": "all" })).unwrap();
        assert_eq!(out["output"], "", "并排视图没有单一主结果");
        let table = out["table"].as_object().unwrap();
        assert_eq!(table.len(), ALL.len());
        assert_eq!(table["md5"], "900150983cd24fb0d6963f7d28e17f72");
    }

    #[test]
    fn sha3_224_and_384_are_reachable() {
        // 这两个只在下拉和 ALL 里出现过，所以单选的已知值直接写死 NIST 的
        // SHA-3 标准向量（空串与 "abc" 的摘要），而不是拿长度公式推 ——
        // 公式推不出「算错了但长度照样对」这类错误。
        // 向量用 Python hashlib 独立复算过。
        for (algo, digest) in [
            ("sha3-224", "e642824c3f8cf24ad09234ee7d3c766fc9a3a5168d0c94ad73b46fdf"),
            ("sha3-384", "ec01498288516fc926459f58e2c6ad8df9b473cb0fc08c2596da7cf0e49be4b298d88cea927ac7f539f1edf228376d25"),
        ] {
            let out = compute(json!({ "text": "abc", "algorithm": algo })).unwrap();
            assert_eq!(out["output"], digest, "{algo} 的摘要对不上 NIST 向量");
        }
        // 并排视图里也得有这两行
        let table = compute(json!({ "text": "abc" })).unwrap();
        let table = table["table"].as_object().unwrap();
        assert_eq!(
            table["sha3-224"],
            "e642824c3f8cf24ad09234ee7d3c766fc9a3a5168d0c94ad73b46fdf"
        );
        assert_eq!(table["sha3-384"], "ec01498288516fc926459f58e2c6ad8df9b473cb0fc08c2596da7cf0e49be4b298d88cea927ac7f539f1edf228376d25");
    }

    // -- 上游 PR #986 补的那些算法 -------------------------------------------
    //
    // 期望值**不是**从本实现里抄出来的，是用两套互不相干的外部实现算出来的：
    //   · hash-wasm（上游 it-tools 自己用的那个库）
    //   · @noble/hashes / xxhash-wasm / node 的 zlib / fast-crc32c
    // 两套对不上时生成脚本会直接报错，所以这些值是**外部参照**而不是自我印证。
    // 公开的测试向量也一致（blake3 空串、keccak-256 空串 = 以太坊那个空代码哈希、
    // crc32c("abc") = 364b3fb7）。

    #[test]
    fn the_new_algorithms_match_the_reference_values() {
        for (algo, digest) in [
            // 空串
            ("blake2b-512", "786a02f742015903c6c6fd852552d272912f4740e15847618a86e217f71f5419d25e1031afee585313896444934eb04b903a685b1448b755d56f701afe9be2ce"),
            ("blake2s-256", "69217a3079908094e11121d042354a7c1f55b6482ca1a51e1b250dfd1ed0eef9"),
            ("blake3", "af1349b9f5f9a1a6a0404dea36dcc9499bcb25c9adc112b7cc9a93cae41f3262"),
            ("keccak-256", "c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470"),
            ("keccak-512", "0eab42de4c3ceb9235fc91acffe746b29c29a8c366b7c60e4e67c466f36a4304c00fa9caf9d87976ba469bcbe06713b435f091ef2769fb160cdab33d3670680e"),
            ("xxhash32", "02cc5d05"),
            ("xxhash64", "ef46db3751d8e999"),
            ("xxh3-64", "2d06800538d394c2"),
            ("xxh3-128", "99aa06d3014798d86001c324468d497f"),
            ("adler32", "00000001"),
            ("crc32", "00000000"),
            ("crc32c", "00000000"),
        ] {
            let out = compute(json!({ "text": "", "algorithm": algo })).unwrap();
            assert_eq!(out["output"], digest, "{algo} 的空串摘要对不上参考值");
        }
    }

    #[test]
    fn the_new_algorithms_match_the_reference_values_for_abc() {
        for (algo, digest) in [
            ("blake2b-512", "ba80a53f981c4d0d6a2797b69f12f6e94c212f14685ac4b74b12bb6fdbffa2d17d87c5392aab792dc252d5de4533cc9518d38aa8dbf1925ab92386edd4009923"),
            ("blake2s-256", "508c5e8c327c14e2e1a72ba34eeb452f37458b209ed63a294d999b4c86675982"),
            ("blake3", "6437b3ac38465133ffb63b75273a8db548c558465d79db03fd359c6cd5bd9d85"),
            ("keccak-256", "4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45"),
            ("keccak-512", "18587dc2ea106b9a1563e32b3312421ca164c7f1f07bc922a9c83d77cea3a1e5d0c69910739025372dc14ac9642629379540c17e2a65b19d77aa511a9d00bb96"),
            ("xxhash32", "32d153ff"),
            ("xxhash64", "44bc2cf5ad770999"),
            ("xxh3-64", "78af5f94892f3950"),
            ("xxh3-128", "06b05ab6733a618578af5f94892f3950"),
            ("adler32", "024d0127"),
            ("crc32", "352441c2"),
            ("crc32c", "364b3fb7"),
        ] {
            let out = compute(json!({ "text": "abc", "algorithm": algo })).unwrap();
            assert_eq!(out["output"], digest, "{algo} 对 abc 的摘要对不上参考值");
        }
    }

    /// 定长的那几个：宽度错了（少了前导 0）一眼就能看出来。
    #[test]
    fn the_fixed_width_algorithms_keep_their_width() {
        for (algo, width) in [
            ("adler32", 8),
            ("crc32", 8),
            ("crc32c", 8),
            ("xxhash32", 8),
            ("xxhash64", 16),
            ("xxh3-64", 16),
            ("xxh3-128", 32),
            ("blake2s-256", 64),
            ("blake3", 64),
            ("keccak-256", 64),
            ("blake2b-512", 128),
            ("keccak-512", 128),
        ] {
            let out = compute(json!({ "text": "abc", "algorithm": algo })).unwrap();
            let got = out["output"].as_str().unwrap();
            assert_eq!(got.len(), width, "{algo} 的十六进制长度应当是 {width}");
            assert!(
                got.chars().all(|c| c.is_ascii_hexdigit()),
                "{algo} 的输出里有非十六进制字符：{got}"
            );
        }
    }

    /// 还没收录的两个算法，先把参考值记在这儿 —— 等哪天能拉 crate 了直接用。
    ///
    /// · sm3("abc")      = 66c7f0f462eeedd9d1f2d46bdc10e4e24167c4875cf2f7a2297da02b8f4ba8e0
    /// · whirlpool("abc") = 4e2448a4c6f486bb16b6562c73b4020bf3043e3a731bce721ae1b303d97e6d4c
    ///                       7181eebdb6c57e277d0e34957114cbd6c797fc9d95d8b582d225292076d4eef5
    #[test]
    fn the_two_missing_algorithms_are_not_silently_accepted() {
        // 没实现就该报「不认识这个算法」，不能给个空串或半个哈希蒙混过去。
        for algo in ["sm3", "whirlpool"] {
            let err = compute(json!({ "text": "abc", "algorithm": algo })).unwrap_err();
            assert!(
                matches!(&err, ToolError::InvalidKeyed { key, .. } if *key == "out.hash-text.err.unknown_algorithm"),
                "{algo} 还没实现，应当报 unknown_algorithm"
            );
        }
    }

    // -- 错误跟着语言走 -------------------------------------------------------

    /// 错误文案在语言包里，按请求语言渲染 —— 英文界面下不该露出中文。
    #[test]
    fn the_error_message_follows_the_requested_language() {
        let err = compute(json!({ "text": "x", "algorithm": "nope" })).unwrap_err();
        // 语言包里还没并进来时，localize 退回键本身 —— 这时断言跳过
        if !crate::i18n::has("zh-CN", "out.hash-text.err.unknown_algorithm") {
            return;
        }
        let en = err.localize("en");
        let zh = err.localize("zh-CN");
        assert_ne!(en, zh, "两种语言不该是同一句");
        assert!(!en.contains("out.hash-text"), "英文界面不该露出键：{en}");
    }
}
