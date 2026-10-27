//! HMAC generator —— 基于哈希的消息认证码（endpoint `hmac-generator`）。
//!
//! 放服务端的原因和 `hash-text` 一样：参考实现为了 SHA3 / RIPEMD-160 的 HMAC 把整个
//! `crypto-js` 拖进了浏览器包，而 RustCrypto 的 `hmac` 0.12 本身就覆盖了这九种算法，
//! 服务端算还能省掉「密钥和明文来回传一趟」。
//!
//! 与参考实现的差异（都记在这里，免得以后有人当成 bug 修回去）：
//! - **空密钥**：参考实现把空串交给 crypto-js，crypto-js 按 RFC 2104 补零照算，
//!   我们也照算（RFC 2104 允许零长密钥）。但要清楚：密钥一旦已知，输出就退化成一个
//!   可复算的普通哈希，不再具备 MAC 的抗伪造性质 —— 所以只是「能算」，不代表「该用」。
//! - **大小写**：crypto-js 的 `enc.Hex` 走的是 `toString(16)`，本来就是小写，
//!   我们的 `hex::encode` 同样是小写，不做任何大写转换。
//! - **输出编码**：参考实现能输出 Hex / Base64 / Bin / Base64url，我们原来只输出
//!   小写十六进制，现在注册表里加了 `output_encoding` 下拉，四种都支持。
//! - **密钥编码**（上游 #1156）：密钥可以按 UTF-8 文本，也可以按十六进制字节。
//!   参考实现用 crypto-js 的 `enc.Hex.parse()`，它会**静默丢掉**非十六进制字符 ——
//!   用户粘错一个字符，算出来的 MAC 就和对方对不上，而且界面上看不出任何异常。
//!   这里改成：奇数长度或出现非十六进制字符一律报错，绝不悄悄退回 UTF-8。
//! - **前后空白**：消息和密钥按字节原样参与计算。密钥首尾多敲一个空格就是另一个密钥，
//!   这里偷偷 `trim` 会算出一个「看起来对但验证不过」的 MAC，比报错更难查。

use hmac::{Hmac, Mac};
use md5::Md5;
use ripemd::Ripemd160;
use serde_json::{json, Value};
use sha1::Sha1;
use sha2::{Sha224, Sha256, Sha384, Sha512};
use sha3::{Sha3_256, Sha3_512};

use super::util::{opt_str, str_or};
use super::{ToolError, ToolResult};

/// 消息 / 密钥的字节上限，与 `hash-text` 保持一致。
///
/// HMAC 本身是线性时间的，几百 MB 也不会把 worker 卡住（所以 `handle` 不需要
/// `web::block`），但一次请求把几百 MB 的字符串读进内存仍然不划算，掐一道。
const MAX_INPUT: usize = 32 * 1024 * 1024;

/// 缺算法时用注册表 `ApiSpec` 里的 default
const DEFAULT_ALGORITHM: &str = "sha256";

/// 密钥的默认编码方式：按 UTF-8 文本
const DEFAULT_KEY_ENCODING: &str = "text";

/// 输出的默认编码方式：小写十六进制
const DEFAULT_OUTPUT_ENCODING: &str = "hex";

/// 九种算法全部走 `hmac` crate，没有手写分支。
///
/// `hmac` 0.12 要求摘要类型实现 `EagerHash`（digest 0.10 的 std 特性下才有），
/// 实测 `Sha3_256` / `Sha3_512` / `Ripemd160` 都满足，九种算法共用同一条代码路径，
/// 也就没有「哪个算法走了另一套实现、两边可能算出不同结果」的问题。
macro_rules! hmac_of {
    ($digest:ty, $key:expr, $message:expr) => {
        Hmac::<$digest>::new_from_slice($key).ok().map(|mut mac| {
            mac.update($message);
            mac.finalize().into_bytes().to_vec()
        })
    };
}

/// 计算 HMAC，输出原始字节；算法不在白名单里返回 `None`。
///
/// `new_from_slice` 返回 `Result` 只是因为签名和 `KeyInit` 共用，对 HMAC 来说
/// 任意长度的密钥都合法（超过分组长度会先按 RFC 2104 压一次摘要），所以这里
/// `.ok()` 丢掉错误不会掩盖用户输入问题 —— `None` 只可能来自未知的算法名。
fn hmac_bytes(algorithm: &str, key: &[u8], message: &[u8]) -> Option<Vec<u8>> {
    match algorithm {
        "md5" => hmac_of!(Md5, key, message),
        "sha1" => hmac_of!(Sha1, key, message),
        "sha224" => hmac_of!(Sha224, key, message),
        "sha256" => hmac_of!(Sha256, key, message),
        "sha384" => hmac_of!(Sha384, key, message),
        "sha512" => hmac_of!(Sha512, key, message),
        "sha3-256" => hmac_of!(Sha3_256, key, message),
        "sha3-512" => hmac_of!(Sha3_512, key, message),
        "ripemd160" => hmac_of!(Ripemd160, key, message),
        _ => None,
    }
}

/// 把密钥按指定编码解成字节。
///
/// - `text`：原样取 UTF-8 字节；
/// - `hex`：十六进制字节串，允许一个 `0x` / `0X` 前缀。
///
/// **奇数长度或出现非十六进制字符一律报错** —— 这里最怕的是「静默退回 UTF-8」：
/// 用户以为自己用的是 hex 密钥，实际算的是另一把密钥的 MAC，双方永远对不上，
/// 而界面上一点异常都看不到。
///
/// 错误文案在语言包里（`out.hmac-generator.err.*`），**不回显密钥内容** ——
/// 连那个「非法字符」也不回显：它本身就是密钥的一部分。只说字符数。
fn decode_key(key: &str, encoding: &str) -> Result<Vec<u8>, ToolError> {
    match encoding {
        "text" => Ok(key.as_bytes().to_vec()),
        "hex" => {
            let body = key
                .strip_prefix("0x")
                .or_else(|| key.strip_prefix("0X"))
                .unwrap_or(key);
            // 先看字符再看长度：粘进来一段 "hello" 时，「非法字符」比「长度必须是偶数」有用
            for ch in body.chars() {
                if !ch.is_ascii_hexdigit() {
                    let chars = body.chars().count().to_string();
                    return Err(ToolError::invalid(
                        "out.hmac-generator.err.bad_hex_key",
                        &[("chars", &chars)],
                    ));
                }
            }
            if body.len() % 2 != 0 {
                let chars = body.len().to_string();
                return Err(ToolError::invalid(
                    "out.hmac-generator.err.odd_hex_key_length",
                    &[("chars", &chars)],
                ));
            }
            // 上面已经把非法字符与奇数长度都挡住了，这里走不到 ——
            // 留着是为了「万一走到也不 panic」。
            hex::decode(body).map_err(|_| {
                let chars = body.chars().count().to_string();
                ToolError::invalid(
                    "out.hmac-generator.err.bad_hex_key",
                    &[("chars", &chars)],
                )
            })
        }
        other => Err(ToolError::invalid(
            "out.hmac-generator.err.unknown_key_encoding",
            &[("encoding", other)],
        )),
    }
}

/// 按指定编码把 MAC 字节转成输出字符串。
///
/// - `hex`：小写十六进制；
/// - `base64`：标准 base64；
/// - `base64url`：URL 安全、不带填充；
/// - `bin`：每个字节写成 8 位二进制，字节之间用空格隔开（与参考实现一致）。
fn encode_output(bytes: &[u8], encoding: &str) -> Result<String, ToolError> {
    match encoding {
        "hex" => Ok(hex::encode(bytes)),
        "base64" => {
            use base64::Engine as _;
            Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
        }
        "base64url" => {
            use base64::Engine as _;
            Ok(base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes))
        }
        "bin" => Ok(bytes
            .iter()
            .map(|b| format!("{b:08b}"))
            .collect::<Vec<_>>()
            .join(" ")),
        other => Err(ToolError::invalid(
            "out.hmac-generator.err.unknown_output_encoding",
            &[("encoding", other)],
        )),
    }
}

/// 与注册表 `ApiSpec.fields` 保持一致。
///
/// 本工具就是一次查表式摘要，没有 CPU 密集部分，所以 `handle` 只是同步 `compute` 的壳。
pub async fn handle(payload: Value) -> ToolResult {
    compute(payload)
}

fn compute(payload: Value) -> ToolResult {
    let algorithm = str_or(&payload, "algorithm", DEFAULT_ALGORITHM);
    let key_encoding = str_or(&payload, "key_encoding", DEFAULT_KEY_ENCODING);
    let output_encoding = str_or(&payload, "output_encoding", DEFAULT_OUTPUT_ENCODING);
    // 消息和密钥都不 trim：HMAC 是逐字节的，多一个空格就是另一个 MAC
    let message = opt_str(&payload, "message").unwrap_or_default();
    let key = opt_str(&payload, "key").unwrap_or_default();

    if message.len() > MAX_INPUT {
        let size = message.len().to_string();
        let max = MAX_INPUT.to_string();
        return Err(ToolError::invalid(
            "out.hmac-generator.err.message_too_long",
            &[("size", &size), ("max", &max)],
        ));
    }
    if key.len() > MAX_INPUT {
        let size = key.len().to_string();
        let max = MAX_INPUT.to_string();
        return Err(ToolError::invalid(
            "out.hmac-generator.err.key_too_long",
            &[("size", &size), ("max", &max)],
        ));
    }

    // 密钥先解成字节：hex 模式下解不出来要报错，不能悄悄退回 UTF-8
    let key_bytes = decode_key(key, key_encoding)?;

    let bytes = match hmac_bytes(algorithm, &key_bytes, message.as_bytes()) {
        Some(bytes) => bytes,
        None => {
            return Err(ToolError::invalid(
                "out.hmac-generator.err.unknown_algorithm",
                &[("algorithm", algorithm)],
            ))
        }
    };
    let output = encode_output(&bytes, output_encoding)?;

    // `length` 是输出字符串的字符数（与 hash-text 的 meta 同义）
    Ok(json!({
        "output": output,
        "meta": {
            "algorithm": algorithm,
            "length": output.len(),
            "bytes": bytes.len(),
            "key_encoding": key_encoding,
            "output_encoding": output_encoding,
        },
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// 字节级入口。RFC 向量里的密钥/数据常常不是合法 UTF-8（0xdd、0xcd…），
    /// JSON 字符串装不下，所以向量直接打到 `hmac_bytes` 上；
    /// `compute` 那一层（取字段、转字节、meta）另外用文本向量端到端测一遍。
    fn mac(algorithm: &str, key: &[u8], message: &[u8]) -> String {
        hex::encode(
            hmac_bytes(algorithm, key, message).expect("白名单里的算法应当都能算"),
        )
    }

    fn api(message: &str, key: &str, algorithm: &str) -> Value {
        compute(json!({ "message": message, "key": key, "algorithm": algorithm }))
            .expect("合法输入不该报错")
    }

    fn repeat(byte: u8, times: usize) -> Vec<u8> {
        vec![byte; times]
    }

    /// RFC 2202 / RFC 4231 测试用例 4 用的 25 字节密钥 0x01..0x19
    fn seq_key() -> Vec<u8> {
        (1u8..=25).collect()
    }

    const HI_THERE: &[u8] = b"Hi There";
    const JEFE_MSG: &[u8] = b"what do ya want for nothing?";
    const OVERSIZED_KEY_MSG: &[u8] = b"Test Using Larger Than Block-Size Key - Hash Key First";

    #[test]
    fn rfc2202_hmac_md5_vectors() {
        // RFC 2202 §2（HMAC-MD5）测试用例 1 / 2
        assert_eq!(
            mac("md5", &repeat(0x0b, 16), HI_THERE),
            "9294727a3638bb1c13f48ef8158bfc9d"
        );
        assert_eq!(
            mac("md5", b"Jefe", JEFE_MSG),
            "750c783e6ab0b503eaa86e310a5db738"
        );
        // 测试用例 3：16 字节 0xaa + 50 字节 0xdd
        assert_eq!(
            mac("md5", &repeat(0xaa, 16), &repeat(0xdd, 50)),
            "56be34521d144c88dbb8c733f0e8b3f6"
        );
        // 测试用例 4：25 字节递增密钥 + 50 字节 0xcd
        assert_eq!(
            mac("md5", &seq_key(), &repeat(0xcd, 50)),
            "697eaf0aca3a3aea3a75164746ffaa79"
        );
        // 测试用例 5：截断测试，期望值就是完整摘要
        assert_eq!(
            mac("md5", &repeat(0x0c, 16), b"Test With Truncation"),
            "56461ef2342edc00f9bab995690efd4c"
        );
    }

    #[test]
    fn rfc2202_hmac_sha1_vectors() {
        // RFC 2202 §3（HMAC-SHA-1）测试用例 1 / 2
        assert_eq!(
            mac("sha1", &repeat(0x0b, 20), HI_THERE),
            "b617318655057264e28bc0b6fb378c8ef146be00"
        );
        assert_eq!(
            mac("sha1", b"Jefe", JEFE_MSG),
            "effcdf6ae5eb2fa2d27416d5f184df9c259a7c79"
        );
        // 测试用例 3：20 字节 0xaa + 50 字节 0xdd
        assert_eq!(
            mac("sha1", &repeat(0xaa, 20), &repeat(0xdd, 50)),
            "125d7342b9ac11cd91a39af48aa17b4f63f175d3"
        );
        // 测试用例 4：25 字节递增密钥 + 50 字节 0xcd
        assert_eq!(
            mac("sha1", &seq_key(), &repeat(0xcd, 50)),
            "4c9007f4026250c6bc8414f9bf50c86c2d7235da"
        );
        // 测试用例 5：截断测试
        assert_eq!(
            mac("sha1", &repeat(0x0c, 20), b"Test With Truncation"),
            "4c1a03424b55e07fe7f27be1d58bb9324a9a5a04"
        );
    }

    #[test]
    fn rfc4231_sha256_and_sha512_vectors() {
        let k20 = repeat(0x0b, 20);
        // 测试用例 1
        assert_eq!(
            mac("sha256", &k20, HI_THERE),
            "b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7"
        );
        assert_eq!(mac("sha512", &k20, HI_THERE), "87aa7cdea5ef619d4ff0b4241a1d6cb02379f4e2ce4ec2787ad0b30545e17cdedaa833b7d6b8a702038b274eaea3f4e4be9d914eeb61f1702e696c203a126854");
        // 测试用例 2
        assert_eq!(
            mac("sha256", b"Jefe", JEFE_MSG),
            "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843"
        );
        assert_eq!(mac("sha512", b"Jefe", JEFE_MSG), "164b7a7bfcf819e2e395fbe73b56e0a387bd64222e831fd610270cd7ea2505549758bf75c05a994a6d034f65f8f0e6fdcaeab1a34d4a6b4b636e070a38bce737");
        // 测试用例 3：20 字节 0xaa + 50 字节 0xdd
        assert_eq!(
            mac("sha256", &repeat(0xaa, 20), &repeat(0xdd, 50)),
            "773ea91e36800e46854db8ebd09181a72959098b3ef8c122d9635514ced565fe"
        );
        assert_eq!(mac("sha512", &repeat(0xaa, 20), &repeat(0xdd, 50)), "fa73b0089d56a284efb0f0756c890be9b1b5dbdd8ee81a3655f83e33b2279d39bf3e848279a722c806b485a47e67c807b946a337bee8942674278859e13292fb");
        // 测试用例 4：25 字节递增密钥 + 50 字节 0xcd
        assert_eq!(
            mac("sha256", &seq_key(), &repeat(0xcd, 50)),
            "82558a389a443c0ea4cc819899f2083a85f0faa3e578f8077a2e3ff46729665b"
        );
        assert_eq!(mac("sha512", &seq_key(), &repeat(0xcd, 50)), "b0ba465637458c6990e5a8c5f61d4af7e576d97ff94b872de76f8050361ee3dba91ca5c11aa25eb4d679275cc5788063a5f19741120c4f2de2adebeb10a298dd");
    }

    #[test]
    fn rfc4231_sha224_and_sha384_vectors() {
        let k20 = repeat(0x0b, 20);
        // 测试用例 1 / 2
        assert_eq!(
            mac("sha224", &k20, HI_THERE),
            "896fb1128abbdf196832107cd49df33f47b4b1169912ba4f53684b22"
        );
        assert_eq!(
            mac("sha224", b"Jefe", JEFE_MSG),
            "a30e01098bc6dbbf45690f3a7e9e6d0f8bbea2a39e6148008fd05e44"
        );
        assert_eq!(mac("sha384", &k20, HI_THERE), "afd03944d84895626b0825f4ab46907f15f9dadbe4101ec682aa034c7cebc59cfaea9ea9076ede7f4af152e8b2fa9cb6");
        assert_eq!(mac("sha384", b"Jefe", JEFE_MSG), "af45d2e376484031617f78d2b58a6b1b9c7ef464f5a01b47e42ec3736322445e8e2240ca5e69e2c78b3239ecfab21649");
    }

    /// 密钥比分组长度还长：RFC 2104 要求先把密钥压成摘要再当密钥用，
    /// 漏掉这一步（直接截断或直接拼接）算出来的值在服务端一定对不上。
    #[test]
    fn key_longer_than_block_is_hashed_first() {
        let k131 = repeat(0xaa, 131);
        // RFC 4231 测试用例 6
        assert_eq!(
            mac("sha256", &k131, OVERSIZED_KEY_MSG),
            "60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54"
        );
        assert_eq!(mac("sha384", &k131, OVERSIZED_KEY_MSG), "4ece084485813e9088d2c63a041bc5b44f9ef1012a2b588f3cd11f05033ac4c60c2ef6ab4030fe8296248df163f44952");
        assert_eq!(mac("sha512", &k131, OVERSIZED_KEY_MSG), "80b24263c7c1a3ebb71493c1dd7be8b49b46d1f41b4aeec1121b013783f8f3526b56d037e05f2598bd0fd2215d6a1e5295e64f73f63f0aec8b915a985d786598");
        // RFC 2202 §2 / §3 测试用例 6：80 字节密钥
        let k80 = repeat(0xaa, 80);
        assert_eq!(
            mac("md5", &k80, OVERSIZED_KEY_MSG),
            "6b1ab7fe4bd7bf8f0b62e6ce61b9d0cd"
        );
        assert_eq!(
            mac("sha1", &k80, OVERSIZED_KEY_MSG),
            "aa4ae5e15272d00e95705637ce8a3b55ed402112"
        );
    }

    /// RFC 4231 测试用例 7：超长密钥 + 超长消息，消息本身也跨了多个分组。
    #[test]
    fn long_message_spans_many_blocks() {
        let k131 = repeat(0xaa, 131);
        let message = "This is a test using a larger than block-size key and a larger than \
                       block-size data. The key needs to be hashed before being used by the \
                       HMAC algorithm.";
        assert_eq!(
            mac("sha256", &k131, message.as_bytes()),
            "9b09ffa71b942fcb27635fbcd5b0e944bfdc63644f0713938a7f51535c3a35e2"
        );
        assert_eq!(mac("sha512", &k131, message.as_bytes()), "e37b6a775dc87dbaa4dfa9f96e5e3ffddebd71f8867289865df5a32d20cdc944b6022cac3c4982b10d5eeb55c3e4de15134676fb6de0446065c97440fa8c6a58");
    }

    /// 200 字节消息，把每一种分组长度都压到第二、第三个分组上
    /// （sha3-512 的分组只有 72 字节，最容易在这里露馅）。
    ///
    /// SHA3 与 RIPEMD-160 没有 RFC 的 HMAC 测试向量（RFC 只覆盖 MD5 / SHA-1 / SHA-2），
    /// 这里的期望值由 OpenSSL 3.5 与 Python `hashlib` 两个独立实现交叉验证得出。
    #[test]
    fn two_hundred_byte_message_across_all_block_sizes() {
        let k20 = repeat(0x0b, 20);
        let message = "a".repeat(200);
        assert_eq!(
            mac("md5", &k20, message.as_bytes()),
            "a0c5e72b5054a66917cf1d2e18fa04d8"
        );
        assert_eq!(
            mac("sha1", &k20, message.as_bytes()),
            "0c631000adbe9b7d95778a611e6a2db62f340bb3"
        );
        assert_eq!(
            mac("sha224", &k20, message.as_bytes()),
            "1408a246f00201ba07013c19d827de546d98dfbca60c46ae033db998"
        );
        assert_eq!(
            mac("sha256", &k20, message.as_bytes()),
            "ae696966930db1492d6e403ead3c1d937d6e277c2b948c02f25c64563edce4c0"
        );
        assert_eq!(mac("sha384", &k20, message.as_bytes()), "33b185289856dea05711a87d65967b248d34838d7625304dc3f0c11f8dec790f4f633890f0062db07f92d861a5cb8b5a");
        assert_eq!(mac("sha512", &k20, message.as_bytes()), "88bbc269841de8867faac45ee9b0b0ba0728dec9730d319656440df4b1def6beea048a96a91f84c84578466fa8ae63b9b6e55a9a3b0327945e2c691c12242a64");
        assert_eq!(
            mac("sha3-256", &k20, message.as_bytes()),
            "284751e13932cde0e540c6d1776f64f0e7a8ed5bd17cc68e2c9c554462c9ed0e"
        );
        assert_eq!(mac("sha3-512", &k20, message.as_bytes()), "b4acf3656a0fbb895586d535b0ad4b229e8fac24c3e8051607ac14c3c41012b61520bbdf9bb353dd7413e017155dad4190c5cc94b6780c21e9c5ea81a0c1dd62");
        assert_eq!(
            mac("ripemd160", &k20, message.as_bytes()),
            "06b4b9d876e0d5d74c0ffbd378038c876b9f3b1c"
        );
    }

    /// SHA3 / RIPEMD-160 的额外向量，同样来自 OpenSSL 3.5 + Python `hashlib` 交叉验证
    #[test]
    fn sha3_and_ripemd160_vectors() {
        let k20 = repeat(0x0b, 20);
        assert_eq!(
            mac("sha3-256", &k20, HI_THERE),
            "ba85192310dffa96e2a3a40e69774351140bb7185e1202cdcc917589f95e16bb"
        );
        assert_eq!(
            mac("sha3-256", b"Jefe", JEFE_MSG),
            "c7d4072e788877ae3596bbb0da73b887c9171f93095b294ae857fbe2645e1ba5"
        );
        assert_eq!(mac("sha3-512", b"Jefe", JEFE_MSG), "5a4bfeab6166427c7a3647b747292b8384537cdb89afb3bf5665e4c5e709350b287baec921fd7ca0ee7a0c31d022a95e1fc92ba9d77df883960275beb4e62024");
        assert_eq!(
            mac("ripemd160", &k20, HI_THERE),
            "24cb4bd67d20fc1a5d2ed7732dcc39377f0a5668"
        );
        assert_eq!(
            mac("ripemd160", b"Jefe", JEFE_MSG),
            "dda6c0213a485a9e24f4742064a7f033b43c4069"
        );
        // 超长密钥（131 字节）下的 SHA3-256 / RIPEMD-160，确认密钥预压缩也是对的
        let k131 = repeat(0xaa, 131);
        assert_eq!(
            mac("sha3-256", &k131, OVERSIZED_KEY_MSG),
            "ed73a374b96c005235f948032f09674a58c0ce555cfc1f223b02356560312c3b"
        );
        assert_eq!(
            mac("ripemd160", &k131, OVERSIZED_KEY_MSG),
            "71bb52d26408e5a221393d5811b03cc7f94bcd3a"
        );
    }

    #[test]
    fn empty_key_is_zero_padded() {
        // RFC 2104 允许零长密钥（补零到分组长度），与参考实现一致；
        // 顺带一提 OpenSSL 的 CLI 干脆不接受空密钥，所以这里没法直接拿它对拍。
        assert_eq!(
            mac("sha256", b"", b"abc"),
            "fd7adb152c05ef80dccf50a1fa4c05d5a3ec6da95575fc312ae7c5d091836351"
        );
        assert_eq!(mac("md5", b"", b"abc"), "dd2701993d29fdd0b032c233cec63403");
        assert_eq!(
            mac("sha3-256", b"", b"abc"),
            "776bdf4f598121a2ac38c408d375731a5681f10998e77dcb92fb474adfef8f90"
        );
        assert_eq!(
            mac("ripemd160", b"", b"abc"),
            "cf402f47ae89744c54ee3d8333677b26aaf3d8e2"
        );
        // 空密钥 + 空消息
        assert_eq!(
            mac("sha256", b"", b""),
            "b613679a0814d9ec772f95d778c35fc5ff1697c493715653c6c712144292c5ad"
        );
        assert_eq!(
            mac("ripemd160", b"", b""),
            "44d86b658a3e7cbc1a2010848b53e35c917720ca"
        );
    }

    /// 从 HTTP 入口整条链路跑一遍：字段取对了、没被 trim、meta 也齐
    #[test]
    fn compute_plumbs_a_text_vector_end_to_end() {
        let out = api("what do ya want for nothing?", "Jefe", "sha256");
        assert_eq!(
            out["output"],
            "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843"
        );
        assert_eq!(out["meta"]["algorithm"], "sha256");
        assert_eq!(out["meta"]["length"], 64);
        // 密钥首尾的空格属于密钥本身，不能被悄悄 trim 掉
        assert_ne!(
            api("abc", " key ", "sha256")["output"],
            api("abc", "key", "sha256")["output"]
        );
        // 多行消息里的换行也要原样参与计算
        assert_ne!(
            api("a\nb", "k", "sha256")["output"],
            api("ab", "k", "sha256")["output"]
        );
    }

    #[test]
    fn every_registered_algorithm_is_supported() {
        for (algorithm, hex_len) in [
            ("md5", 32),
            ("sha1", 40),
            ("sha224", 56),
            ("sha256", 64),
            ("sha384", 96),
            ("sha512", 128),
            ("sha3-256", 64),
            ("sha3-512", 128),
            ("ripemd160", 40),
        ] {
            let out = api("abc", "k", algorithm);
            assert_eq!(
                out["output"].as_str().map(str::len),
                Some(hex_len),
                "{algorithm} 的十六进制长度不对"
            );
            assert_eq!(out["meta"]["algorithm"], algorithm);
        }
    }

    #[test]
    fn unknown_algorithm_is_an_error_not_a_panic() {
        for bogus in [
            "sha3-224", "SHA256", "blake3", "sha-256", "sha3_256", "ripemd",
        ] {
            let err = compute(json!({ "message": "a", "key": "k", "algorithm": bogus }))
                .expect_err("未知算法应当报错");
            match err {
                ToolError::InvalidKeyed { key, args } => {
                    assert_eq!(key, "out.hmac-generator.err.unknown_algorithm", "{bogus}");
                    assert!(
                        args.iter().any(|(name, value)| name == "algorithm" && value == bogus),
                        "{bogus}"
                    );
                }
                other => panic!("{bogus} 应当报 unknown_algorithm，实际 {other:?}"),
            }
        }
    }

    #[test]
    fn blank_algorithm_falls_back_to_the_registry_default() {
        let expected = "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843";
        for blank in [json!(""), json!("   "), json!(null)] {
            let payload = json!({ "message": "what do ya want for nothing?", "key": "Jefe", "algorithm": blank });
            assert_eq!(compute(payload).unwrap()["output"], expected);
        }
        // 完全没给 algorithm 字段（手写 POST）也一样
        let out =
            compute(json!({ "message": "what do ya want for nothing?", "key": "Jefe" })).unwrap();
        assert_eq!(out["output"], expected);
        assert_eq!(out["meta"]["algorithm"], "sha256");
    }

    #[test]
    fn empty_message_is_allowed() {
        // 消息为空不等于「什么都不算」：HMAC 依然有值，而且这正是最容易
        // 在「忘记填消息」时悄悄算错的一种情况，所以要钉死。
        assert_eq!(
            api("", "key", "sha256")["output"],
            "5d5d139563c95b5967b9bd9a8c9b233a9dedb45072794cd232dc1b74832607d0"
        );
        // 缺 message 字段等同于空消息
        let out = compute(json!({ "key": "key", "algorithm": "sha256" })).unwrap();
        assert_eq!(
            out["output"],
            "5d5d139563c95b5967b9bd9a8c9b233a9dedb45072794cd232dc1b74832607d0"
        );
        // 缺 key 字段也等同于空密钥，照样算
        assert!(compute(json!({ "message": "abc", "algorithm": "sha256" })).is_ok());
        // 整个 payload 都是空的也不该 500
        assert!(compute(json!({})).is_ok());
    }

    #[test]
    fn unicode_is_hashed_as_utf8_bytes() {
        // 4 字节的 emoji 也在里面，能顺带挡住「按 char 而不是按字节算」的错实现
        let out = api("你好，HMAC！🔐", "密钥", "sha256");
        assert_eq!(
            out["output"],
            "55e519fda84dae3797efe2742b7fc3928e5aae2dbf036aa5a6813c4181daafda"
        );
        assert_eq!(mac("sha512", "密钥".as_bytes(), "你好，HMAC！🔐".as_bytes()), "d5af46d7ef54bc4119071c5159aad0146e1667239d429749a9276b8802a01e64388daca458332a2e45567a993924b24f467aca95aa7c880f7aa8a472e99e13d3");
        assert_eq!(
            mac("ripemd160", "密钥".as_bytes(), "你好，HMAC！🔐".as_bytes()),
            "006ee3882d2aa0ea19d40a522dda713de11b2120"
        );
        assert_eq!(mac("sha3-512", "密钥".as_bytes(), "你好，HMAC！🔐".as_bytes()), "5fd0daf0346c8a7b94f7e77a017a06070187f5281a4ec46f81760397d42f99b291e314a1b4e3a65a8664801c5907efa5813001b735375916e1c9522b56547eda");
    }

    #[test]
    fn oversized_input_is_rejected() {
        let huge = "a".repeat(MAX_INPUT + 1);
        assert!(compute(json!({ "message": huge, "key": "k", "algorithm": "sha256" })).is_err());
        assert!(compute(json!({ "message": "a", "key": huge, "algorithm": "sha256" })).is_err());
    }

    /// 密钥按十六进制字节参与计算（上游 #1156）。
    ///
    /// 用 RFC 4231 测试用例 1 的密钥 0x0b×20 对拍：同样的字节，
    /// 按 hex 读和按文本读必须算出两个不同的 MAC。
    #[test]
    fn hex_key_is_read_as_bytes() {
        let hex_key = "0b".repeat(20);
        let by_hex = compute(json!({
            "message": "Hi There",
            "key": hex_key,
            "key_encoding": "hex",
            "algorithm": "sha256",
        }))
        .unwrap();
        assert_eq!(
            by_hex["output"],
            "b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7"
        );
        // 同一个字符串按 UTF-8 文本读，结果必须不一样
        let by_text = compute(json!({
            "message": "Hi There",
            "key": hex_key,
            "key_encoding": "text",
            "algorithm": "sha256",
        }))
        .unwrap();
        assert_ne!(by_hex["output"], by_text["output"]);
        // 0x 前缀可以带
        let with_prefix = compute(json!({
            "message": "Hi There",
            "key": format!("0x{hex_key}"),
            "key_encoding": "hex",
            "algorithm": "sha256",
        }))
        .unwrap();
        assert_eq!(with_prefix["output"], by_hex["output"]);
    }

    /// 十六进制密钥写错时必须报错 —— 悄悄退回 UTF-8 是最难查的一类问题。
    #[test]
    fn invalid_hex_key_is_an_error_not_a_silent_fallback() {
        for (key, expected) in [
            ("0b0", "out.hmac-generator.err.odd_hex_key_length"),
            ("0b0z", "out.hmac-generator.err.bad_hex_key"),
            ("hello", "out.hmac-generator.err.bad_hex_key"),
            ("hell", "out.hmac-generator.err.bad_hex_key"),
            ("0b 0b", "out.hmac-generator.err.bad_hex_key"),
        ] {
            let err = compute(json!({
                "message": "a",
                "key": key,
                "key_encoding": "hex",
                "algorithm": "sha256",
            }))
            .expect_err("非法 hex 密钥应当报错");
            match err {
                ToolError::InvalidKeyed { key: err_key, args } => {
                    assert_eq!(err_key, expected, "{key}");
                    // 错误里只有长度，不能有密钥内容
                    let shown = format!("{args:?}");
                    assert!(!shown.contains(key), "{key}: {shown}");
                }
                other => panic!("{key} 应当报 {expected}，实际 {other:?}"),
            }
        }
        // 未知编码方式同样报错，不当成 text
        let err = compute(json!({
            "message": "a", "key": "k", "key_encoding": "base64", "algorithm": "sha256",
        }))
        .expect_err("未知密钥编码应当报错");
        match err {
            ToolError::InvalidKeyed { key, .. } => {
                assert_eq!(key, "out.hmac-generator.err.unknown_key_encoding")
            }
            other => panic!("应当报 unknown_key_encoding，实际 {other:?}"),
        }
    }

    /// 输出编码：hex / base64 / base64url / bin（上游参考实现那四种）。
    #[test]
    fn output_encodings() {
        let payload = |encoding: &str| {
            compute(json!({
                "message": "what do ya want for nothing?",
                "key": "Jefe",
                "algorithm": "sha256",
                "output_encoding": encoding,
            }))
            .unwrap()["output"]
                .as_str()
                .unwrap()
                .to_string()
        };
        let hex = payload("hex");
        assert_eq!(hex, "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843");
        // base64 / base64url 与 hex 说的是同一串字节
        use base64::Engine as _;
        let raw = hex::decode(&hex).unwrap();
        assert_eq!(
            payload("base64"),
            base64::engine::general_purpose::STANDARD.encode(&raw)
        );
        assert_eq!(
            payload("base64url"),
            base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(&raw)
        );
        // bin：每个字节 8 位二进制，空格隔开
        assert_eq!(payload("bin").split(' ').count(), 32, "bin 是 32 个字节");
        assert_eq!(payload("bin").split(' ').next().unwrap(), "01011011");
        // 默认就是 hex
        let default = compute(json!({
            "message": "what do ya want for nothing?", "key": "Jefe", "algorithm": "sha256",
        }))
        .unwrap();
        assert_eq!(default["output"], hex);
        assert_eq!(default["meta"]["output_encoding"], "hex");
        assert_eq!(default["meta"]["bytes"], 32, "摘要的字节数");
        // 未知输出编码报错
        let err = compute(json!({
            "message": "a", "key": "k", "algorithm": "sha256", "output_encoding": "rot13",
        }))
        .expect_err("未知输出编码应当报错");
        match err {
            ToolError::InvalidKeyed { key, .. } => {
                assert_eq!(key, "out.hmac-generator.err.unknown_output_encoding")
            }
            other => panic!("应当报 unknown_output_encoding，实际 {other:?}"),
        }
    }

    // -- 错误跟着语言走 -------------------------------------------------------

    /// 错误文案在语言包里，按请求语言渲染 —— 英文界面下不该露出中文。
    #[test]
    fn the_error_message_follows_the_requested_language() {
        let err = compute(json!({ "message": "a", "key": "k", "algorithm": "sha3-224" }))
            .unwrap_err();
        // 语言包里还没并进来时，localize 退回键本身 —— 这时断言跳过
        if !crate::i18n::has("zh-CN", "out.hmac-generator.err.unknown_algorithm") {
            return;
        }
        let en = err.localize("en");
        let zh = err.localize("zh-CN");
        assert_ne!(en, zh, "两种语言不该是同一句");
        assert!(!en.contains("out.hmac-generator"), "英文界面不该露出键：{en}");
    }
}
