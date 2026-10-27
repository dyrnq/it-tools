//! JS 工具要用到的第三方库 —— 读 `static/lib/manifest.tsv`。
//!
//! 为什么不直接把 `libs` 写成注册表里的一个字段：node 侧的 `test/js/harness.js`
//! 也得知道每个模块要预加载哪些库，否则 jsdom 里 `window.YAML` 全是 undefined，
//! 报出来的错跟真实故障长得一模一样。把清单落成一个两边都读的文件，
//! 就不会出现「页面加了新库、测试忘了加」这种只有一边生效的状态。

use std::collections::BTreeMap;
use std::sync::OnceLock;

use crate::embed::StaticAsset;

/// slug → 产物路径（相对 `static/lib/`）
fn table() -> &'static BTreeMap<String, Vec<String>> {
    static TABLE: OnceLock<BTreeMap<String, Vec<String>>> = OnceLock::new();
    TABLE.get_or_init(|| {
        let raw = match StaticAsset::get("lib/manifest.tsv") {
            Some(f) => String::from_utf8(f.data.to_vec()).unwrap_or_default(),
            None => return BTreeMap::new(),
        };
        let mut map: BTreeMap<String, Vec<String>> = BTreeMap::new();
        for line in raw.lines() {
            let line = line.trim();
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            let Some((slug, files)) = line.split_once('\t') else {
                continue;
            };
            let paths = files
                .split(',')
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string)
                .collect();
            map.insert(slug.trim().to_string(), paths);
        }
        map
    })
}

/// 某个工具要加载的 `<script src>` 列表，路径以 `/assets/` 开头。
pub fn lib_urls(slug: &str) -> Vec<String> {
    table()
        .get(slug)
        .map(|paths| paths.iter().map(|p| format!("/assets/lib/{p}")).collect())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::registry::{by_slug, TOOLS};

    #[test]
    fn manifest_is_embedded() {
        assert!(
            StaticAsset::get("lib/manifest.tsv").is_some(),
            "缺少 lib/manifest.tsv"
        );
        assert!(!table().is_empty(), "manifest.tsv 解析出 0 条");
    }

    /// 清单里的 slug 必须是真存在的 JS 工具，否则是写错了条目或工具被改名了
    #[test]
    fn manifest_slugs_exist() {
        for slug in table().keys() {
            assert!(
                by_slug(slug).is_some_and(|t| matches!(t.impl_kind, crate::registry::ImplKind::Js)),
                "manifest.tsv 里的 {slug} 不是已注册的 JS 工具"
            );
        }
    }

    /// 清单里的每个产物都真的被打进了二进制，否则工具页会静默少一个库
    #[test]
    fn manifest_files_are_embedded() {
        for (slug, paths) in table() {
            for p in paths {
                assert!(
                    StaticAsset::get(&format!("lib/{p}")).is_some(),
                    "{slug} 依赖的 lib/{p} 不在 static/lib/ 下"
                );
            }
        }
    }

    /// 反过来：S3 剩下的 JS 工具里，凡是需要库的都要在清单里点名。
    /// 手工维护的列表正需要一个反向校验 —— 漏一个就是页面白屏。
    #[test]
    fn no_js_tool_needs_a_lib_undeclared() {
        // 这些工具全程只用浏览器原生 API，不需要任何第三方库
        const NO_LIB: &[&str] = &["mime-types", "emoji-picker", "html-wysiwyg-editor"];
        let declared = table().keys().map(String::as_str).collect::<Vec<_>>();

        let mut undeclared = TOOLS
            .iter()
            .filter(|t| matches!(t.impl_kind, crate::registry::ImplKind::Js))
            .map(|t| t.slug)
            .filter(|s| !declared.contains(s) && !NO_LIB.contains(s))
            // 已完成的 S2 工具本来就用不到库，跳过
            .filter(|s| crate::embed::StaticAsset::get(&format!("js/tools/{s}.js")).is_none())
            .collect::<Vec<_>>();
        undeclared.sort_unstable();
        assert!(
            undeclared.is_empty(),
            "这些 JS 工具还没实现，且未在 manifest.tsv 里声明依赖: {undeclared:?}"
        );
    }
}
