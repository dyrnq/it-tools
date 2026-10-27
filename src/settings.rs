//! 运行期配置。优先级：命令行参数 > 环境变量 > 默认值。

use clap::Parser;

#[derive(Parser, Debug, Clone)]
#[command(
    name = "it-tools",
    // 中英各一半：这个字符串会出现在 `--help` 顶上，跟站点自己的标语
    // （ui.tagline）说的是同一件事，用同一套措辞，别各叫各的。
    about = "IT Tools — 开发者 handy 工具箱（Rust 重写版）/ Handy tools for developers (Rust rewrite)",
    version,
    author
)]
pub struct Cli {
    /// 监听地址
    // 不给短选项：`-h` 已经被 clap 的 --help 占用了
    #[arg(long, env = "IT_TOOLS_HOST", default_value = "127.0.0.1")]
    pub host: String,

    /// 监听端口
    #[arg(short, long, env = "IT_TOOLS_PORT", default_value_t = 8080)]
    pub port: u16,

    /// 默认语言（无 `?lang=` / Cookie / Accept-Language 时使用）
    #[arg(long, env = "IT_TOOLS_LANG", default_value = "en")]
    pub lang: String,
}

impl Cli {
    pub fn addr(&self) -> String {
        format!("{}:{}", self.host, self.port)
    }
}

/// 服务运行期状态，通过 actix `app_data` 共享。
#[derive(Debug, Clone)]
pub struct Settings {
    pub default_lang: String,
}

impl From<Cli> for Settings {
    fn from(cli: Cli) -> Self {
        Self {
            default_lang: cli.lang,
        }
    }
}
