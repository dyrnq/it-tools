//! 走服务端实现的工具（_docs/arch.md 第 6 条：JS 做不了的部分）。
//!
//! 新增一个 API 工具的完整步骤：
//! 1. 在 `src/registry/tools.rs` 里把该工具的 `impl_kind` 设为 `ImplKind::Api(...)`
//! 2. 在 `src/tools/` 下新建同名模块，实现 [`handle`]
//! 3. 在 [`dispatch`] 里注册一行
//!
//! 前端不需要写任何代码 —— `tool.html` 会依据注册表里的字段描述渲染通用表单。
//!
//! ## handler 的形状约定
//!
//! 每个模块对外只暴露一个
//! `pub async fn handle(payload: Value) -> ToolResult`，`dispatch` 里一律 `.await`。
//! 于是「要不要丢 blocking 线程池」是模块内部的事，`dispatch` 保持一行一个工具、
//! 没有分支。CPU 密集的实现用 [`util::blocking`] 包一层；纯字符串/查表类直接算。
//!
//! 每个模块内部再拆出一个私有的同步 `compute`，单测直接测它 —— 否则每个测试都得
//! 挂一个 actix runtime，纯逻辑测试会被无谓地拖慢。

pub mod argon2;
pub mod bcrypt;
pub mod csr_generator;
pub mod date_time_converter;
pub mod dns_query;
pub mod encryption;
pub mod hash_text;
pub mod hmac_generator;
pub mod htpasswd;
pub mod iana_timezone_index;
pub mod ipv6;
pub mod ipv6_address_converter;
pub mod ipv6_subnet_calculator;
pub mod jasypt;
pub mod jwt;
pub mod mac_address_lookup;
pub mod otp_generator;
pub mod pdf_signature_checker;
pub mod pki;
pub mod rsa_formats;
pub mod rsa_key_pair_generator;
pub mod ssh_key;
pub mod ssh_key_pair_generator;
pub mod ssl_certificate_decoder;
pub mod util;
pub mod week_number_converter;
pub mod x509_certificate_generator;

use serde_json::Value;

/// 工具执行失败。`message` 会原样展示给用户。
///
/// ## 两种「不合法」
///
/// - [`ToolError::InvalidKeyed`]：**给用户看的一句话**，文案在语言包里，
///   由 API 层按请求语言渲染。**新代码一律用这个。**
/// - [`ToolError::Internal`]：给开发者看的（panic 信息、库返回的原始错误），
///   同时会写进日志。里面可以有中文 —— 它不是给人看的文案。
#[derive(Debug, thiserror::Error)]
pub enum ToolError {
    /// 一条语言包里的键 + 插值参数。
    ///
    /// `key` 是 `out.<路由>.<名字>` 形式的语言包键，`args` 是模板里
    /// `{名字}` 占位符对应的值 —— **按名字**对应，因为两种语言的语序不同。
    ///
    /// 之所以不直接存一句话：存了就等于把文案钉死在 Rust 代码里，
    /// 英文界面下会露出中文 —— 而这个站的默认语言就是英文。
    #[error("{key}")]
    InvalidKeyed {
        key: &'static str,
        args: Vec<(String, String)>,
    },
    /// 内部错误：只写日志，同时会回给调用方（500）。
    #[error("internal error: {0}")]
    Internal(String),
}

impl ToolError {
    /// 「输入不合法」的错误，文案在语言包里。
    ///
    /// ```ignore
    /// return Err(ToolError::invalid("out.bcrypt.err.bad_cost", &[("cost", &cost)]));
    /// ```
    pub fn invalid(key: &'static str, args: &[(&str, &str)]) -> Self {
        ToolError::InvalidKeyed {
            key,
            args: args
                .iter()
                .map(|(name, value)| ((*name).to_string(), (*value).to_string()))
                .collect(),
        }
    }

    /// 把错误渲染成给用户看的一句话，按请求语言取文案。
    ///
    /// 键在语言包里找不到时退回键本身 —— 一个显眼的 `out.foo.err.bar`
    /// 比一句悄悄消失的错误更容易看出哪里漏了翻译。
    pub fn localize(&self, lang: &str) -> String {
        match self {
            ToolError::InvalidKeyed { key, args } => {
                let borrowed: Vec<(&str, &str)> =
                    args.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect();
                crate::i18n::t_args(lang, key, &borrowed)
            }
            ToolError::Internal(msg) => msg.clone(),
        }
    }
}

pub type ToolResult = Result<Value, ToolError>;

/// 按 endpoint 分发到具体工具实现。
///
/// 是 `async fn` 而不是同步 `fn`，因为有几个工具是 CPU 密集的
/// （16384 位 RSA 密钥生成要几十秒，bcrypt 高 cost 要几百毫秒，
/// PDF 解析走 lopdf + ASN.1）—— 直接在 actix 的 worker 上算会把整个
/// runtime 卡住。CPU 密集的实现内部用 [`util::blocking`] 丢到 blocking 线程池，
/// 本函数保持 async 纯粹是为了能 await 它们。
pub async fn dispatch(endpoint: &str, payload: Value) -> Option<ToolResult> {
    match endpoint {
        "hash-text" => Some(hash_text::handle(payload).await),
        "hmac-generator" => Some(hmac_generator::handle(payload).await),
        "htpasswd" => Some(htpasswd::handle(payload).await),
        "jasypt" => Some(jasypt::handle(payload).await),
        "bcrypt" => Some(bcrypt::handle(payload).await),
        "argon2" => Some(argon2::handle(payload).await),
        "date-time-converter" => Some(date_time_converter::handle(payload).await),
        "encryption" => Some(encryption::handle(payload).await),
        "otp-code-generator-and-validator" => Some(otp_generator::handle(payload).await),
        "rsa-key-pair-generator" => Some(rsa_key_pair_generator::handle(payload).await),
        "pdf-signature-checker" => Some(pdf_signature_checker::handle(payload).await),
        "mac-address-lookup" => Some(mac_address_lookup::handle(payload).await),
        "ssl-certificate-decoder" => Some(ssl_certificate_decoder::handle(payload).await),
        "iana-timezone-index" => Some(iana_timezone_index::handle(payload).await),
        "ipv6-address-converter" => Some(ipv6_address_converter::handle(payload).await),
        "ipv6-subnet-calculator" => Some(ipv6_subnet_calculator::handle(payload).await),
        "ssh-key-pair-generator" => Some(ssh_key_pair_generator::handle(payload).await),
        "week-number-converter" => Some(week_number_converter::handle(payload).await),
        "x509-certificate-generator" => Some(x509_certificate_generator::handle(payload).await),
        "csr-generator" => Some(csr_generator::handle(payload).await),
        "dns-query" => Some(dns_query::handle(payload).await),
        _ => None,
    }
}

/// 已实现的 API 工具 endpoint 集合，用于单测比对注册表。
///
/// 只有 `src/main.rs` 的注册表完整性测试读它，所以非测试构建里是死的。
#[allow(dead_code)]
pub const IMPLEMENTED: &[&str] = &[
    "hash-text",
    "hmac-generator",
    "htpasswd",
    "bcrypt",
    "argon2",
    "date-time-converter",
    "encryption",
    "otp-code-generator-and-validator",
    "rsa-key-pair-generator",
    "pdf-signature-checker",
    "mac-address-lookup",
    "ssl-certificate-decoder",
    "iana-timezone-index",
    "jasypt",
    "ipv6-address-converter",
    "ipv6-subnet-calculator",
    "ssh-key-pair-generator",
    "week-number-converter",
    "x509-certificate-generator",
    "csr-generator",
    "dns-query",
];
