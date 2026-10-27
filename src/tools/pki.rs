//! 自签 X.509 证书与 CSR 都要先生成一对密钥 —— 单独一个模块，因为这里有个坑。
//!
//! ## 为什么不能直接用 `rcgen::KeyPair::generate_for`
//!
//! `rcgen` 0.14 的默认后端是 `ring`（`aws-lc-rs` 那条路走不通：它要 cmake 与 nasm，
//! 离线环境里编不出来）。而 **ring 只会做 RSA 签名，不会生成 RSA 密钥** ——
//! `KeyPair::generate_for(&PKCS_RSA_SHA256)` 直接返回
//! `Error::KeyGenerationUnavailable`（rcgen 源码里就写着这条注释：
//! "Ring doesn't have RSA key generation yet"）。
//!
//! 所以 RSA 走另一条路：用 `rsa` crate 自己生成密钥对，转成 **PKCS#8 PEM**，
//! 再交给 `rcgen::KeyPair::from_pkcs8_pem_and_sign_algo` ——
//! 这条路 rcgen 只用它「签名」，正好是 ring 会做的部分。
//!
//! ## 为什么私钥统一输出 PKCS#8
//!
//! PKCS#8（`-----BEGIN PRIVATE KEY-----`）是**通用**的私钥格式，
//! RSA / ECDSA / Ed25519 三种都用它。PKCS#1（`-----BEGIN RSA PRIVATE KEY-----`）
//! 只装 RSA，混着给会让用户以为「这就是那个格式」。
//! `rsa` crate 的 `to_pkcs8_pem` 出来的就是 PKCS#8，不会错。

use rsa::pkcs8::EncodePrivateKey;
use rcgen::{
    KeyPair, PKCS_ECDSA_P256_SHA256, PKCS_ECDSA_P384_SHA384, PKCS_ED25519, PKCS_RSA_SHA256,
};

/// 证书 / CSR 支持的密钥算法。
///
/// 取值就是注册表里下拉框提交上来的字符串，好几个工具共用这一套。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeyAlgorithm {
    Rsa2048,
    Rsa3072,
    Rsa4096,
    EcdsaP256,
    EcdsaP384,
    Ed25519,
}

impl KeyAlgorithm {
    /// 从注册表下拉框的值解析。认不出来就返回 `None` ——
    /// 下拉框的值是外部输入，不该由它决定「用哪个算法」。
    pub fn from_value(value: &str) -> Option<Self> {
        Some(match value {
            "rsa2048" => KeyAlgorithm::Rsa2048,
            "rsa3072" => KeyAlgorithm::Rsa3072,
            "rsa4096" => KeyAlgorithm::Rsa4096,
            "ecdsa-p256" => KeyAlgorithm::EcdsaP256,
            "ecdsa-p384" => KeyAlgorithm::EcdsaP384,
            "ed25519" => KeyAlgorithm::Ed25519,
            _ => return None,
        })
    }

    /// 给人看的算法名。
    pub fn label(self) -> &'static str {
        match self {
            KeyAlgorithm::Rsa2048 => "RSA 2048",
            KeyAlgorithm::Rsa3072 => "RSA 3072",
            KeyAlgorithm::Rsa4096 => "RSA 4096",
            KeyAlgorithm::EcdsaP256 => "ECDSA P-256",
            KeyAlgorithm::EcdsaP384 => "ECDSA P-384",
            KeyAlgorithm::Ed25519 => "Ed25519",
        }
    }

    /// 密钥位数。只有 RSA 有「位数」这个概念，其余算法是固定的。
    pub fn rsa_bits(self) -> Option<u32> {
        match self {
            KeyAlgorithm::Rsa2048 => Some(2048),
            KeyAlgorithm::Rsa3072 => Some(3072),
            KeyAlgorithm::Rsa4096 => Some(4096),
            _ => None,
        }
    }
}

/// 生成出来的密钥对。
pub struct GeneratedKey {
    /// 交给 rcgen 签名的密钥对
    pub key_pair: KeyPair,
    /// 私钥的 PKCS#8 PEM（`-----BEGIN PRIVATE KEY-----`）
    pub private_key_pem: String,
}

/// 按算法生成密钥对。
///
/// 返回 `Err(String)` 是给人看的错误信息（会被包进 `ToolError::InvalidKeyed`）。
pub fn generate(alg: KeyAlgorithm) -> Result<GeneratedKey, String> {
    if let Some(bits) = alg.rsa_bits() {
        return generate_rsa(bits);
    }
    let signature_alg = match alg {
        KeyAlgorithm::EcdsaP256 => &PKCS_ECDSA_P256_SHA256,
        KeyAlgorithm::EcdsaP384 => &PKCS_ECDSA_P384_SHA384,
        KeyAlgorithm::Ed25519 => &PKCS_ED25519,
        // 上面已经处理过 RSA，这里不该再走到
        _ => return Err("不支持的密钥算法".to_string()),
    };
    let key_pair = KeyPair::generate_for(signature_alg)
        .map_err(|e| format!("生成 {} 密钥失败: {e}", alg.label()))?;
    let private_key_pem = key_pair.serialize_pem();
    Ok(GeneratedKey {
        key_pair,
        private_key_pem,
    })
}

/// RSA 密钥：自己生成，再转成 PKCS#8 交给 rcgen。
///
/// `rsa` crate 生成的是 PKCS#1 的 `RSAPrivateKey`，`to_pkcs8_pem` 会把它包成
/// PKCS#8 —— rcgen 与 `openssl` 认的都是后者。
fn generate_rsa(bits: u32) -> Result<GeneratedKey, String> {
    let mut rng = rand_core::OsRng;
    let private_key = rsa::RsaPrivateKey::new(&mut rng, bits as usize)
        .map_err(|e| format!("生成 {bits} 位 RSA 密钥失败: {e}"))?;
    let pem = private_key
        .to_pkcs8_pem(rsa::pkcs8::LineEnding::LF)
        .map_err(|e| format!("序列化 RSA 私钥失败: {e}"))?;
    let key_pair = KeyPair::from_pkcs8_pem_and_sign_algo(&pem, &PKCS_RSA_SHA256)
        .map_err(|e| format!("rcgen 接管 RSA 私钥失败: {e}"))?;
    Ok(GeneratedKey {
        key_pair,
        // `Zeroizing<String>` 是 zeroize 用来「用完就擦」的包装，
        // 转成普通 String 是因为这份私钥本来就是要交给用户的
        private_key_pem: pem.to_string(),
    })
}

/// 把一行文本按逗号 / 分号 / 空白切开，去掉空项。
///
/// 证书的「备用名称」是用户一口气敲好几个域名进来的，
/// 分隔符给全（逗号、分号、换行、空格）比只认一种友好。
pub fn split_list(input: &str) -> Vec<String> {
    input
        .split(|c: char| c == ',' || c == ';' || c == '\n' || c == '\r' || c.is_whitespace())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn algorithm_values_round_trip() {
        for alg in [
            KeyAlgorithm::Rsa2048,
            KeyAlgorithm::Rsa3072,
            KeyAlgorithm::Rsa4096,
            KeyAlgorithm::EcdsaP256,
            KeyAlgorithm::EcdsaP384,
            KeyAlgorithm::Ed25519,
        ] {
            assert_eq!(KeyAlgorithm::from_value(alg.label()), None); // 标签不是取值
        }
        assert_eq!(KeyAlgorithm::from_value("rsa2048"), Some(KeyAlgorithm::Rsa2048));
        assert_eq!(KeyAlgorithm::from_value("ed25519"), Some(KeyAlgorithm::Ed25519));
        assert_eq!(KeyAlgorithm::from_value("dsa"), None);
    }

    #[test]
    fn ecdsa_and_ed25519_keys_are_pkcs8_pem() {
        for alg in [
            KeyAlgorithm::EcdsaP256,
            KeyAlgorithm::EcdsaP384,
            KeyAlgorithm::Ed25519,
        ] {
            let key = generate(alg).expect("生成密钥");
            assert!(
                key.private_key_pem.starts_with("-----BEGIN PRIVATE KEY-----"),
                "{} 的私钥不是 PKCS#8: {}",
                alg.label(),
                key.private_key_pem.lines().next().unwrap_or("")
            );
            assert!(key.private_key_pem.contains("-----END PRIVATE KEY-----"));
        }
    }

    #[test]
    fn rsa_key_is_pkcs8_pem_not_pkcs1() {
        // RSA 走的是「自己生成再交给 rcgen」那条路，最容易出的错就是
        // 私钥又变回 PKCS#1（`BEGIN RSA PRIVATE KEY`）—— 那种 PEM 装不了
        // ECDSA/Ed25519，用户会以为格式统一了。
        let key = generate(KeyAlgorithm::Rsa2048).expect("生成 RSA 密钥");
        assert!(
            key.private_key_pem.starts_with("-----BEGIN PRIVATE KEY-----"),
            "RSA 私钥应当也是 PKCS#8: {}",
            key.private_key_pem.lines().next().unwrap_or("")
        );
        assert!(!key.private_key_pem.contains("BEGIN RSA PRIVATE KEY"));
    }

    #[test]
    fn list_splitting_handles_mixed_separators() {
        assert_eq!(
            split_list("a.com, b.com;c.com\nd.com  e.com"),
            vec!["a.com", "b.com", "c.com", "d.com", "e.com"]
        );
        assert!(split_list("  ,,  ").is_empty());
        assert_eq!(split_list("single.com"), vec!["single.com"]);
    }
}
