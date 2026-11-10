//! RSA 公钥的位长上限 —— 本工具的口径比 `rsa` 的默认值宽。
//!
//! `rsa` 0.10 起，公钥的**构造**（`PublicKey::new`）与**解码**（PEM / DER）
//! 默认只接受 **1024..=8192** 位的模数（`PublicKey::MIN_SIZE` /
//! `PublicKey::MAX_SIZE`）。但本工具的密钥对生成器明确支持到 **16384** 位
//! （见 `rsa_key_pair_generator` 的 `ALLOWED_BITS`）—— 公钥这边若跟着 `rsa`
//! 的默认值走，就会出现「生成器能出 16384 位的公钥，但加密工具读不回来」
//! 的自相矛盾。
//!
//! 所以公钥一律走本模块：上限放宽到 [`MAX_BITS`]，下限仍留 1024
//! （低于 1024 位的 RSA 密钥本来就不该被接受）。
//!
//! 私钥没有这个问题 —— `rsa` 对私钥只卡下限，不卡上限。
//!
//! ## 为什么不直接用 `rsa` 自己的解码
//!
//! `rsa` 的解码路径最后一步是 `PublicKey::new`，卡死在 8192 位；它给超大公钥
//! 留的口子是「自己用 `pkcs1` 解出分量，再传给 `new_with_size_limits`」
//! （见 `rsa` 0.10 的 `PublicKey::new_with_size_limits` 文档）。本模块就是
//! 照这个路子写的：先剥出 `n` / `e`，再按放宽后的上限构造。

use rsa::pkcs1::{DecodeRsaPublicKey, RsaPublicKeyOwned};
use rsa::pkcs8::der::{Decode, Document};
use rsa::pkcs8::SubjectPublicKeyInfoRef;
use rsa::{BoxedUint, PublicKey};

/// 本工具接受的 RSA 公钥最大位长。
///
/// 与 `rsa_key_pair_generator` 的 `ALLOWED_BITS` 对齐 —— 生成器能出的，
/// 这边就得能读回来。
pub const MAX_BITS: usize = 16384;

/// 用放宽后的上限构造公钥。
///
/// 跟 `PublicKey::new` 的区别只有上限：下限仍是 `PublicKey::MIN_SIZE`（1024），
/// 其余检查（模数必须为奇数、指数范围）照旧。
pub fn public_key(n: BoxedUint, e: BoxedUint) -> Result<PublicKey, rsa::Error> {
    PublicKey::new_with_size_limits(n, e, PublicKey::MIN_SIZE..=MAX_BITS)
}

/// 从 DER 解出公钥：SPKI（`PUBLIC KEY`）与 PKCS#1（`RSA PUBLIC KEY`）都收。
///
/// 与 `rsa` 自己的 `DecodePublicKey::from_public_key_der` 的区别只有上限。
pub fn decode_public_key_der(der: &[u8]) -> Result<PublicKey, rsa::Error> {
    // SPKI：外层是「算法标识 + 位串」，位串里头就是 PKCS#1 的 RSAPublicKey。
    if let Ok(spki) = SubjectPublicKeyInfoRef::from_der(der) {
        if let Some(inner) = spki.subject_public_key.as_bytes() {
            if let Ok(key) = RsaPublicKeyOwned::from_pkcs1_der(inner) {
                return from_components(&key);
            }
        }
    }
    // PKCS#1：直接就是 RSAPublicKey。
    let key = RsaPublicKeyOwned::from_pkcs1_der(der).map_err(rsa::Error::Pkcs1)?;
    from_components(&key)
}

/// 从 PEM 解出公钥：SPKI（`PUBLIC KEY`）与 PKCS#1（`RSA PUBLIC KEY`）都收。
///
/// 与 `rsa` 自己的 `DecodePublicKey::from_public_key_pem` 的区别只有上限。
pub fn decode_public_key_pem(pem: &str) -> Result<PublicKey, rsa::Error> {
    let (label, doc) = Document::from_pem(pem).map_err(asn1_error)?;
    let der = doc.as_bytes();
    match label {
        "PUBLIC KEY" => decode_public_key_der(der),
        "RSA PUBLIC KEY" => {
            let key = RsaPublicKeyOwned::from_pkcs1_der(der).map_err(rsa::Error::Pkcs1)?;
            from_components(&key)
        }
        _ => Err(rsa::Error::Pkcs8(rsa::pkcs8::Error::KeyMalformed(
            rsa::pkcs8::KeyError::Invalid,
        ))),
    }
}

/// 用分量（`n` / `e`）构造公钥。
fn from_components(key: &RsaPublicKeyOwned) -> Result<PublicKey, rsa::Error> {
    public_key(
        uint(key.modulus.as_bytes()),
        uint(key.public_exponent.as_bytes()),
    )
}

/// 大端字节 → `BoxedUint`。
///
/// 空字节是零：ASN.1 的 `INTEGER` 理论上不会给空串，但真给了也不能 panic。
fn uint(bytes: &[u8]) -> BoxedUint {
    if bytes.is_empty() {
        BoxedUint::from(0u32)
    } else {
        BoxedUint::from_be_slice_vartime(bytes)
    }
}

/// DER 层的错 → `rsa::Error`。
fn asn1_error(err: rsa::pkcs8::der::Error) -> rsa::Error {
    rsa::Error::Pkcs8(rsa::pkcs8::Error::PublicKey(rsa::pkcs8::spki::Error::Asn1(err)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use rsa::pkcs8::{DecodePublicKey, EncodePublicKey, LineEnding};
    use rsa::traits::PublicKeyParts;

    /// 造一个 `bits` 位的奇数模数。
    ///
    /// 不需要真是两个质数的乘积 —— 公钥的构造不查这一条，
    /// 只有私钥的运算才会用到因子的性质。
    fn fake_modulus(bits: usize) -> BoxedUint {
        let mut bytes = vec![0xffu8; bits / 8];
        bytes[0] |= 0x80; // 保证正好 `bits` 位
        let last = bytes.len() - 1;
        bytes[last] |= 1; // 奇数
        BoxedUint::from_be_slice_vartime(&bytes)
    }

    fn fake_public_key(bits: usize) -> PublicKey {
        public_key(fake_modulus(bits), BoxedUint::from(65537u32)).expect("放宽后的上限应当接受")
    }

    #[test]
    fn oversized_key_is_accepted_by_this_module() {
        let key = fake_public_key(16384);
        assert_eq!(key.size(), 16384 / 8);
    }

    #[test]
    fn rsa_default_limit_rejects_what_this_module_accepts() {
        // 这条锁的是「为什么需要本模块」：`rsa` 自己的构造走 8192 上限，
        // 16384 位会被拒掉。
        let n = fake_modulus(16384);
        let e = BoxedUint::from(65537u32);
        assert!(PublicKey::new(n, e).is_err());
    }

    #[test]
    fn too_small_key_is_still_rejected() {
        // 下限不放宽：512 位的 RSA 密钥本来就不该被接受。
        let n = fake_modulus(512);
        let e = BoxedUint::from(65537u32);
        assert!(public_key(n, e).is_err());
    }

    #[test]
    fn spki_pem_roundtrips_through_the_widened_path() {
        let key = fake_public_key(16384);
        let pem = key.to_public_key_pem(LineEnding::LF).expect("编码应当成功");

        // `rsa` 自己的解码读不回来（8192 上限）
        assert!(PublicKey::from_public_key_pem(&pem).is_err());

        // 本模块读得回来
        let decoded = decode_public_key_pem(&pem).expect("放宽后应当能解出来");
        assert_eq!(decoded.n(), key.n());
        assert_eq!(decoded.e(), key.e());
    }

    #[test]
    fn pkcs1_pem_roundtrips_through_the_widened_path() {
        use rsa::pkcs1::EncodeRsaPublicKey;

        let key = fake_public_key(16384);
        let pem = key.to_pkcs1_pem(LineEnding::LF).expect("编码应当成功");

        assert!(PublicKey::from_pkcs1_pem(&pem).is_err());

        let decoded = decode_public_key_pem(&pem).expect("放宽后应当能解出来");
        assert_eq!(decoded.n(), key.n());
        assert_eq!(decoded.e(), key.e());
    }

    #[test]
    fn der_roundtrips_through_the_widened_path() {
        use rsa::pkcs8::EncodePublicKey;

        let key = fake_public_key(16384);
        let der = key.to_public_key_der().expect("编码应当成功");

        let decoded = decode_public_key_der(der.as_bytes()).expect("放宽后应当能解出来");
        assert_eq!(decoded.n(), key.n());
        assert_eq!(decoded.e(), key.e());
    }

    #[test]
    fn garbage_is_rejected() {
        assert!(decode_public_key_der(b"not a key").is_err());
        assert!(decode_public_key_pem("-----BEGIN PUBLIC KEY-----\nnope\n-----END PUBLIC KEY-----").is_err());
        // 标签不对
        assert!(decode_public_key_pem("-----BEGIN CERTIFICATE-----\nnope\n-----END CERTIFICATE-----").is_err());
    }
}
