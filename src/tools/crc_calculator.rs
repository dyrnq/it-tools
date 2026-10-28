//! CRC calculator —— 一段文本的各个 CRC 变体（endpoint `crc-calculator`）。
//!
//! 参考实现是 it-tools2 的 `crc-calculator`：它在浏览器里用 npm 的 `crc` 包
//! （4.3.2）一次算出 13 个变体，界面上一行一个。
//!
//! 变体的名字（`crc1` / `crc8` / `crc81wire` / …）沿用参考实现的叫法 ——
//! 协议文档里说的就是这些名字，翻译成中文只会让人对不上文档。
//! 每个名字背后是 reveng 目录里的哪一个算法，写在下面的注释里。
//!
//! ## 三处跟参考实现不一样的地方
//!
//! 1. **`crc1` 不是 CRC-1/ISO。** npm 的 `crc1` 算的是「所有字节加起来
//!    mod 256」（一个加法校验和），不是逐位奇偶校验；而 `crc-catalog` 2.5.0
//!    里**根本没有宽度 1 的条目**（最窄的是 CRC-3/GSM），所以
//!    `crc::CRC_1_ISO` 这个常量不存在 —— 名字是照 npm 的语义实现的，
//!    见 [`crc1_hex`]。
//! 2. **十六进制补齐前导零。** npm 直接 `toString(16)`，不补零：
//!    CRC-32/MPEG-2 对 "123456789" 是 `0x0376e6e7`，npm 给 "376e6e7"（7 位）。
//!    这里按宽度补成 "0376e6e7" —— 少一位就看不出这个 CRC 是 32 位的。
//!    本仓库的 `hash-text` 也是这么做的（crc32 的空串摘要 "00000000"）。
//! 3. **文本按 UTF-8 编码。** npm 的 `crc` 包用 `Buffer.from(str)`，也就是
//!    UTF-8。同一串文本换个编码，CRC 就变了 —— "日本語" 是 9 个字节
//!    （3 个字符 × 3 字节），不是 3 个字节。
//!
//! ## 值的来源
//!
//! 每个变体都跟三套**互不相干**的外部实现对过：
//!
//! * npm 的 `crc` 4.3.2（参考实现自己用的那个包），在 node 里跑出来的；
//! * 一份按 reveng 目录的参数手写的 Python 实现（不看 npm 的源码，
//!   只按目录里的 poly/init/refin/refout/xorout 算）；
//! * python 的 `zlib.crc32`（= CRC-32/ISO-HDLC）与
//!   `binascii.crc_hqx(data, 0xffff)`（= CRC-16/CCITT-FALSE）。
//!
//! 注意 `crc_hqx` 验的是 **CCITT-FALSE**（不反射的那个），**不是** MODBUS ——
//! MODBUS 是反射的，`crc_hqx` 给不出它的值。

use crc::Crc;
use serde_json::{json, Map, Value};

use super::ToolResult;

/// 一个 CRC 变体。
struct Variant {
    /// 界面上显示的名字（沿用参考实现的叫法）。
    name: &'static str,
    /// 算这个变体，返回**补齐前导零**的小写十六进制。
    value: fn(&[u8]) -> String,
}

/// 目录里那些算法共用同一个骨架，用宏生成，免得抄 12 遍。
///
/// `$digits` 是十六进制的位数（8 位 → 2、16 位 → 4、24 位 → 6、32 位 → 8）。
macro_rules! catalog_variants {
    ($( $fn_name:ident => $algo:ident, $ty:ty, $digits:literal );* $(;)?) => {
        $(
            /// 见 [`VARIANTS`] 里对应的那一行（算法、宽度、参数）。
            fn $fn_name(data: &[u8]) -> String {
                format!(
                    concat!("{:0", $digits, "x}"),
                    Crc::<$ty>::new(&crc::$algo).checksum(data)
                )
            }
        )*
    };
}

catalog_variants! {
    crc8_hex         => CRC_8_SMBUS,    u8,  2;
    crc81wire_hex    => CRC_8_MAXIM_DOW, u8,  2;
    crc8dvbs2_hex    => CRC_8_DVB_S2,   u8,  2;
    crc16_hex        => CRC_16_ARC,     u16, 4;
    crc16ccitt_hex   => CRC_16_IBM_3740, u16, 4;
    crc16modbus_hex  => CRC_16_MODBUS,  u16, 4;
    crc16kermit_hex  => CRC_16_KERMIT,  u16, 4;
    crc16xmodem_hex  => CRC_16_XMODEM,  u16, 4;
    crc24_hex        => CRC_24_OPENPGP, u32, 6;
    crc32_hex        => CRC_32_ISO_HDLC, u32, 8;
    crc32mpeg_hex    => CRC_32_MPEG_2,  u32, 8;
    crcjam_hex       => CRC_32_JAMCRC,  u32, 8;
}

/// 全部变体。顺序跟参考实现一致（`defaultCRCValues` 里的顺序）。
const VARIANTS: &[Variant] = &[
    // npm 的 crc1：见下面 crc1_hex 的注释。
    Variant {
        name: "crc1",
        value: crc1_hex,
    },
    // CRC-8/SMBUS —— 目录里叫 SMBUS，npm 叫 crc8。
    Variant {
        name: "crc8",
        value: crc8_hex,
    },
    // CRC-8/MAXIM-DOW —— Dallas 1-Wire 总线上用的那个，npm 叫 crc81wire。
    Variant {
        name: "crc81wire",
        value: crc81wire_hex,
    },
    // CRC-8/DVB-S2 —— 数字电视用的那个。
    Variant {
        name: "crc8dvbs2",
        value: crc8dvbs2_hex,
    },
    // CRC-16/ARC（ARC 协议）。
    Variant {
        name: "crc16",
        value: crc16_hex,
    },
    // CRC-16/CCITT-FALSE —— 目录里的名字是 CRC-16/IBM-3740（同一组参数）。
    Variant {
        name: "crc16ccitt",
        value: crc16ccitt_hex,
    },
    // CRC-16/MODBUS —— 工业总线用的，**反射**的那个。
    Variant {
        name: "crc16modbus",
        value: crc16modbus_hex,
    },
    // CRC-16/KERMIT。
    Variant {
        name: "crc16kermit",
        value: crc16kermit_hex,
    },
    // CRC-16/XMODEM。
    Variant {
        name: "crc16xmodem",
        value: crc16xmodem_hex,
    },
    // CRC-24/OPENPGP。
    Variant {
        name: "crc24",
        value: crc24_hex,
    },
    // CRC-32/ISO-HDLC —— python 的 zlib.crc32 就是它。
    Variant {
        name: "crc32",
        value: crc32_hex,
    },
    // CRC-32/MPEG-2 —— 目录里叫 MPEG-2，npm 叫 crc32mpeg2。
    Variant {
        name: "crc32mpeg",
        value: crc32mpeg_hex,
    },
    // CRC-32/JAMCRC。
    Variant {
        name: "crcjam",
        value: crcjam_hex,
    },
];

/// npm 的 `crc1`：**所有字节加起来 mod 256**，一个加法校验和。
///
/// 名字像 CRC-1/ISO（逐位奇偶校验），但 npm 的实现根本不是那么算的 ——
/// 它的源码是 `accum += current[index]; return crc % 256`。
/// 这里照 npm 的语义写，因为跟参考实现对得上比跟名字对得上重要。
///
/// 另外，`crc-catalog` 2.5.0 里**没有**宽度 1 的条目（最窄的是 CRC-3/GSM），
/// 所以 `crc::CRC_1_ISO` 这个常量压根不存在 —— 想用目录的话只能拿
/// CRC-3/GSM 顶替，那算出来的是另一个东西。
fn crc1_hex(data: &[u8]) -> String {
    let sum: u64 = data.iter().map(|b| u64::from(*b)).sum();
    format!("{:02x}", (sum % 256) as u8)
}

/// 纯查表式计算，没有 CPU 密集部分，所以 `handle` 只是同步 `compute` 的壳。
pub async fn handle(payload: Value) -> ToolResult {
    compute(payload)
}

fn compute(payload: Value) -> ToolResult {
    // 空文本是合法输入：空串的 CRC 有确定的值（CRC-32 是 00000000）。
    // 文本按 **UTF-8** 编码（见模块头的说明）。
    let text = super::util::opt_str(&payload, "text").unwrap_or_default();
    let data = text.as_bytes();

    let mut table = Map::new();
    let mut rows: Vec<Value> = Vec::new();
    for variant in VARIANTS {
        let value = (variant.value)(data);
        table.insert(variant.name.to_string(), json!(value));
        // `rows` 是给「一行一个格式」那种界面用的 —— 参考实现的 crc-calculator
        // 就是一列「名字 + 只读框 + 复制图标」，前端按 rows 渲染。
        // 标签是算法名本身（md5 / crc16ccitt 这种通用标识符），不翻译。
        rows.push(json!({ "key": variant.name, "label": variant.name, "value": value }));
    }

    Ok(json!({
        "output": "",
        "table": table,
        "rows": rows,
        "meta": { "count": rows.len() },
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// 算一串文本，返回「变体名 → 十六进制」的那张表。
    fn table_of(text: &str) -> serde_json::Map<String, Value> {
        let out = compute(json!({ "text": text })).unwrap();
        out["table"].as_object().unwrap().clone()
    }

    /// 标准里的公开向量：CRC-32/ISO-HDLC、CRC-16/ARC、CRC-16/MODBUS、
    /// CRC-8/SMBUS 对 "123456789" 的值。
    ///
    /// 这些是**外部参照**，不是本实现自己算出来的：
    ///   · CRC-32/ISO-HDLC("123456789") = 0xCBF43926 —— reveng 目录里
    ///     CRC-32/ISO-HDLC 那条的 check 值，也是 python `zlib.crc32` 的输出；
    ///   · CRC-16/ARC = 0xBB3D、CRC-16/MODBUS = 0x4B37、CRC-8/SMBUS = 0xF4 ——
    ///     同上，目录里的 check 值。
    #[test]
    fn the_standard_check_values_are_right() {
        let table = table_of("123456789");
        assert_eq!(table["crc32"], "cbf43926");
        assert_eq!(table["crc16"], "bb3d");
        assert_eq!(table["crc16modbus"], "4b37");
        assert_eq!(table["crc8"], "f4");
        assert_eq!(table["crc16ccitt"], "29b1");
        assert_eq!(table["crc16kermit"], "2189");
        assert_eq!(table["crc16xmodem"], "31c3");
        assert_eq!(table["crc8dvbs2"], "bc");
        assert_eq!(table["crc81wire"], "a1");
        assert_eq!(table["crc24"], "21cf02");
        assert_eq!(table["crc32mpeg"], "0376e6e7");
        assert_eq!(table["crcjam"], "340bc6d9");
    }

    /// 目录（`crc-catalog`）给每个算法都写好了 "123456789" 的 CRC ——
    /// 那是 reveng 目录的公开值，跟本实现的计算是两条独立的路。
    ///
    /// 这条单测的价值在于：常量与算出来的值要是对不上，说明**映射**错了
    /// （比如把 MODBUS 接到 CCITT 上），而不只是「算错了」。
    #[test]
    fn every_variant_matches_the_catalogue_check_value() {
        let table = table_of("123456789");
        assert_eq!(table["crc8"], format!("{:02x}", crc::CRC_8_SMBUS.check));
        assert_eq!(
            table["crc81wire"],
            format!("{:02x}", crc::CRC_8_MAXIM_DOW.check)
        );
        assert_eq!(
            table["crc8dvbs2"],
            format!("{:02x}", crc::CRC_8_DVB_S2.check)
        );
        assert_eq!(table["crc16"], format!("{:04x}", crc::CRC_16_ARC.check));
        assert_eq!(
            table["crc16ccitt"],
            format!("{:04x}", crc::CRC_16_IBM_3740.check)
        );
        assert_eq!(
            table["crc16modbus"],
            format!("{:04x}", crc::CRC_16_MODBUS.check)
        );
        assert_eq!(
            table["crc16kermit"],
            format!("{:04x}", crc::CRC_16_KERMIT.check)
        );
        assert_eq!(
            table["crc16xmodem"],
            format!("{:04x}", crc::CRC_16_XMODEM.check)
        );
        assert_eq!(table["crc24"], format!("{:06x}", crc::CRC_24_OPENPGP.check));
        assert_eq!(
            table["crc32"],
            format!("{:08x}", crc::CRC_32_ISO_HDLC.check)
        );
        assert_eq!(
            table["crc32mpeg"],
            format!("{:08x}", crc::CRC_32_MPEG_2.check)
        );
        assert_eq!(table["crcjam"], format!("{:08x}", crc::CRC_32_JAMCRC.check));
    }

    /// 跟参考实现（npm 的 `crc` 4.3.2）的输出逐条比对。
    ///
    /// 期望值是在 node 里跑参考实现用的那个包得到的（`crc@4.3.2`，
    /// 参考项目 `package.json` 里锁的就是这个版本）。
    /// 差异只有一处：npm 不补前导零，这里补 ——
    /// 期望值按本实现的口径（补零）写，括号里是 npm 的原样输出。
    #[test]
    fn the_values_match_the_npm_reference_package() {
        // "123456789"
        let table = table_of("123456789");
        assert_eq!(table["crc1"], "dd");
        assert_eq!(table["crc8"], "f4");
        assert_eq!(table["crc81wire"], "a1");
        assert_eq!(table["crc8dvbs2"], "bc");
        assert_eq!(table["crc16"], "bb3d");
        assert_eq!(table["crc16ccitt"], "29b1");
        assert_eq!(table["crc16modbus"], "4b37");
        assert_eq!(table["crc16kermit"], "2189");
        assert_eq!(table["crc16xmodem"], "31c3");
        assert_eq!(table["crc24"], "21cf02");
        assert_eq!(table["crc32"], "cbf43926");
        // npm 给 "376e6e7"（7 位），这里补成 8 位
        assert_eq!(table["crc32mpeg"], "0376e6e7");
        assert_eq!(table["crcjam"], "340bc6d9");

        // "abc"
        let table = table_of("abc");
        assert_eq!(table["crc1"], "26");
        assert_eq!(table["crc8"], "5f");
        assert_eq!(table["crc81wire"], "42");
        assert_eq!(table["crc8dvbs2"], "5a");
        assert_eq!(table["crc16"], "9738");
        assert_eq!(table["crc16ccitt"], "514a");
        assert_eq!(table["crc16modbus"], "5749");
        assert_eq!(table["crc16kermit"], "58e9");
        assert_eq!(table["crc16xmodem"], "9dd6");
        assert_eq!(table["crc24"], "ba1c7b");
        assert_eq!(table["crc32"], "352441c2");
        assert_eq!(table["crc32mpeg"], "9b73448c");
        assert_eq!(table["crcjam"], "cadbbe3d");

        // "hello"
        let table = table_of("hello");
        assert_eq!(table["crc1"], "14");
        assert_eq!(table["crc8"], "92");
        assert_eq!(table["crc81wire"], "13");
        assert_eq!(table["crc8dvbs2"], "9d");
        assert_eq!(table["crc16"], "34d2");
        assert_eq!(table["crc16ccitt"], "d26e");
        assert_eq!(table["crc16modbus"], "34f6");
        assert_eq!(table["crc16kermit"], "fbca");
        assert_eq!(table["crc16xmodem"], "c362");
        assert_eq!(table["crc24"], "47f58a");
        assert_eq!(table["crc32"], "3610a686");
        assert_eq!(table["crc32mpeg"], "e6ce9ac2");
        assert_eq!(table["crcjam"], "c9ef5979");
    }

    /// 外部参照：python 的 `zlib.crc32` 与 `binascii.crc_hqx`。
    ///
    /// * `zlib.crc32(data)` 就是 CRC-32/ISO-HDLC；
    /// * `binascii.crc_hqx(data, 0xffff)` 是**不反射**的 CRC-16 ——
    ///   它对应的是 CRC-16/CCITT-FALSE（目录里的 CRC-16/IBM-3740），
    ///   **不是** MODBUS：MODBUS 是反射的，crc_hqx 验不了它。
    ///
    /// （这一点跟常见的说法相反，所以单测里分开写，别让下一个人以为
    /// crc_hqx 能验 MODBUS。）
    #[test]
    fn the_crc32_and_the_ccitt_match_pythons_zlib_and_binascii() {
        // python3 -c "import zlib;print('%08x'%zlib.crc32(b'123456789'))"  → cbf43926
        let table = table_of("123456789");
        assert_eq!(table["crc32"], "cbf43926");
        // python3 -c "import binascii;print('%04x'%binascii.crc_hqx(b'123456789',0xffff))" → 29b1
        assert_eq!(table["crc16ccitt"], "29b1");
        // 另一段文本再验一次，免得「碰巧」对了
        // python3 -c "import zlib;print('%08x'%zlib.crc32(b'hello'))" → 3610a686
        let table = table_of("hello");
        assert_eq!(table["crc32"], "3610a686");
        // python3 -c "import binascii;print('%04x'%binascii.crc_hqx(b'hello',0xffff))" → d26e
        assert_eq!(table["crc16ccitt"], "d26e");
    }

    /// 文本按 **UTF-8** 字节算。
    ///
    /// "日本語" 是 3 个字符、**9 个字节**（每个汉字 3 字节）；
    /// 要是错按字符数或按 Latin-1 算，值就全不一样了。
    /// 期望值跟 npm 的 `crc` 包一致（它用 `Buffer.from(str)`，也就是 UTF-8）。
    #[test]
    fn the_text_is_hashed_as_utf8_bytes() {
        let table = table_of("日本語");
        assert_eq!(table["crc32"], "a80b52e5");
        assert_eq!(table["crc16modbus"], "62cd");
        assert_eq!(table["crc16ccitt"], "2986");
        assert_eq!(table["crc24"], "c721f7");
        // "héllo"：é 是 2 字节 → 整串 6 字节
        let table = table_of("héllo");
        assert_eq!(table["crc32"], "9e3b8236");
        assert_eq!(table["crc16modbus"], "4fc0");
    }

    /// 空串是合法输入，值也确定。
    #[test]
    fn an_empty_text_is_allowed() {
        let table = table_of("");
        assert_eq!(table["crc32"], "00000000");
        assert_eq!(table["crc32mpeg"], "ffffffff");
        assert_eq!(table["crc16ccitt"], "ffff");
        assert_eq!(table["crc16modbus"], "ffff");
        assert_eq!(table["crc24"], "b704ce");
        assert_eq!(table["crc1"], "00");
    }

    /// 缺 `text` 字段时按空串算，而不是报错 ——
    /// `POST /api/tools/crc-calculator` 是公开接口，手写请求可以什么都不给。
    #[test]
    fn a_missing_text_field_is_treated_as_empty() {
        let out = compute(json!({})).unwrap();
        let table = out["table"].as_object().unwrap();
        assert_eq!(table["crc32"], "00000000");
        assert_eq!(out["meta"]["count"], VARIANTS.len());
    }

    /// 变体清单跟参考实现一样 —— 少一个就是「原版能算、这边算不了」。
    #[test]
    fn the_variant_list_matches_the_reference() {
        let names: Vec<&str> = VARIANTS.iter().map(|v| v.name).collect();
        assert_eq!(
            names,
            vec![
                "crc1",
                "crc8",
                "crc81wire",
                "crc8dvbs2",
                "crc16",
                "crc16ccitt",
                "crc16modbus",
                "crc16kermit",
                "crc16xmodem",
                "crc24",
                "crc32",
                "crc32mpeg",
                "crcjam",
            ]
        );
    }

    /// 每个变体的十六进制长度得对得上它的宽度 —— 少一位就是宽度错了。
    #[test]
    fn the_values_keep_their_width() {
        for (name, width) in [
            ("crc1", 2),
            ("crc8", 2),
            ("crc81wire", 2),
            ("crc8dvbs2", 2),
            ("crc16", 4),
            ("crc16ccitt", 4),
            ("crc16modbus", 4),
            ("crc16kermit", 4),
            ("crc16xmodem", 4),
            ("crc24", 6),
            ("crc32", 8),
            ("crc32mpeg", 8),
            ("crcjam", 8),
        ] {
            let table = table_of("123456789");
            let value = table[name].as_str().unwrap();
            assert_eq!(value.len(), width, "{name} 的十六进制长度应当是 {width}");
            assert!(
                value
                    .chars()
                    .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()),
                "{name} 的输出不是小写十六进制：{value}"
            );
        }
    }

    /// `rows` 一行一个变体，标签就是变体名。
    #[test]
    fn the_rows_carry_the_variant_name() {
        let out = compute(json!({ "text": "abc" })).unwrap();
        let rows = out["rows"].as_array().unwrap();
        assert_eq!(rows.len(), VARIANTS.len());
        for (row, variant) in rows.iter().zip(VARIANTS.iter()) {
            assert_eq!(row["key"], variant.name);
            assert_eq!(row["label"], variant.name);
            assert!(row["value"].as_str().unwrap().len() >= 2);
        }
        // 并排视图没有单一主结果
        assert_eq!(out["output"], "");
    }
}
