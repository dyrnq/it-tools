//! 编译期嵌入前端资源与语言包，最终产出单个二进制。
//!
//! 开发期的实时读取来自 rust-embed 的默认行为：debug profile 下每次 `get()` 都现读磁盘，
//! 改完刷新浏览器即可见。**不要**为此打开 `--features debug-embed` —— 那个 feature 的
//! 名字是反的，开了反而强制走嵌入路径（文件清单在编译期冻结、内容打进二进制）。
//! rust-embed 8.13 的 trait 文档原话：
//!   If the feature `debug-embed` is enabled or the binary was compiled in release mode,
//!   the file information is embedded in the binary ... Otherwise, the information is
//!   read from the file system on each call.

use rust_embed::RustEmbed;

#[derive(RustEmbed)]
#[folder = "static/"]
pub struct StaticAsset;

#[derive(RustEmbed)]
#[folder = "templates/"]
pub struct Templates;

#[derive(RustEmbed)]
#[folder = "locales/"]
pub struct Locales;

/// 工具用的静态数据（如 `mac-address-lookup` 的 OUI 表）。
///
/// 必须是独立的 root，**不能**放进 `static/`：`static/` 挂在 `/assets/{tail:.*}` 上
/// （见 `handlers::assets`），放进去等于把整张 OUI 表公开可下载。
/// `Data` 没有注册任何路由，只在 handler 里 `Data::get()` 取，不经 HTTP。
#[derive(RustEmbed)]
#[folder = "data/"]
pub struct Data;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn static_asset_is_embedded() {
        assert!(StaticAsset::get("js/app.js").is_some(), "缺少 js/app.js");
        assert!(
            StaticAsset::get("css/app.css").is_some(),
            "缺少 css/app.css"
        );
    }

    #[test]
    fn layui_is_embedded() {
        assert!(
            StaticAsset::get("lib/layui/layui.js").is_some(),
            "缺少 layui，请先执行 scripts/bump-layui.sh"
        );
    }

    #[test]
    fn templates_are_embedded() {
        for t in [
            "base.html",
            "index.html",
            "tool.html",
            "about.html",
            "404.html",
        ] {
            assert!(Templates::get(t).is_some(), "缺少模板 {t}");
        }
    }

    #[test]
    fn locales_are_embedded() {
        assert!(Locales::get("en.yml").is_some());
        assert!(Locales::get("zh-CN.yml").is_some());
    }

    #[test]
    fn data_is_embedded() {
        assert!(
            Data::get("oui.txt").is_some(),
            "缺少 oui.txt，请先执行 scripts/build-oui.sh"
        );
    }

    #[test]
    fn data_is_not_served_from_static() {
        // `static/` 整棵挂在 /assets 上，data/ 必须留在外面，
        // 否则 OUI 表会被当成静态资源下载到（虽然本来也不是什么秘密，但那是 0.86 MiB 白流量）。
        assert!(StaticAsset::get("data/oui.txt").is_none());
        assert!(StaticAsset::get("../data/oui.txt").is_none());
    }

    /// 精灵里没有的 symbol，`<use href="…#i-xxx">` 会**静默地什么都不画**：
    /// 不报错、控制台干净、HTTP 200，只是那个位置空着。这个 bug 已经咬过两次
    /// （先是折叠箭头 `chevron-right`，后是顶栏一整排 `menu-2`/`home`/
    /// `brand-github`/`brand-x`/`info-circle`/`moon`/`sun`/`search`/`heart`/`eye`），
    /// 所以拿测试钉死。
    ///
    /// 扫描三个来源：模板宏 `icon_name="…"`、JS 的 `Dom.icon('…')`、注册表的
    /// `icon: "…"`（工具卡片和侧栏都靠它取 `<use>` 的 id）。少扫一个来源，那条
    /// 路径上的图标还是能悄悄消失 —— 注册表里那些正是最初漏掉的一批。
    #[test]
    fn every_referenced_icon_exists_in_the_sprite() {
        /// 取出所有 `prefix … term` 之间的片段（属性值都是单行无转义的，够用了）
        fn collect<'a>(hay: &'a str, prefix: &str, term: char) -> impl Iterator<Item = String> + 'a {
            hay.match_indices(prefix)
                .map(move |(at, m)| {
                    let rest = &hay[at + m.len()..];
                    let end = rest.find(term).expect("属性未闭合");
                    rest[..end].to_string()
                })
                .collect::<Vec<_>>()
                .into_iter()
        }

        let svg = StaticAsset::get("img/icons.svg").expect("缺少 img/icons.svg");
        let svg = String::from_utf8(svg.data.into_owned()).expect("精灵不是 UTF-8");
        let symbols: Vec<String> = collect(&svg, "<symbol id=\"i-", '"').collect();
        assert!(symbols.len() > 50, "精灵只剩 {} 个符号", symbols.len());

        let mut missing: Vec<String> = Vec::new();
        let mut check = |kind: &str, file: &str, text: &str, prefix: &str, term: char| {
            for name in collect(text, prefix, term) {
                if !symbols.contains(&name) {
                    missing.push(format!("{kind} {file}: i-{name}"));
                }
            }
        };

        for name in Templates::iter() {
            if !name.ends_with(".html") {
                continue;
            }
            let text = String::from_utf8(Templates::get(&name).unwrap().data.into_owned()).unwrap();
            check("模板", &name, &text, "icon_name=\"", '"');
        }

        for name in StaticAsset::iter() {
            if !name.ends_with(".js") {
                continue;
            }
            let text = String::from_utf8(StaticAsset::get(&name).unwrap().data.into_owned()).unwrap();
            check("JS", &name, &text, "icon('", '\'');
        }

        check("注册表", "tools.rs", include_str!("registry/tools.rs"), "icon: \"", '"');

        assert!(
            missing.is_empty(),
            "这些图标被引用了，但 static/img/icons.svg 里没有对应 symbol（页面会静默空白）：\n  {}",
            missing.join("\n  ")
        );
    }
}
