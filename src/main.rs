//! IT Tools —— 开发者工具箱的 Rust 实现（可执行文件入口）。
//!
//! 实现都在库里（`it_tools`），这个文件只负责解析命令行并把服务跑起来。
//! 拆成 lib + bin 是为了能写集成测试：`tests/` 下的测试要用 `actix_web::test`
//! 把整个 App 组装起来打请求，只有 bin target 的话那些代码引用不到。

use clap::Parser;

use it_tools::{app, settings};

#[actix_web::main]
async fn main() -> std::io::Result<()> {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();

    let cli = settings::Cli::parse();
    app::run(cli).await
}
