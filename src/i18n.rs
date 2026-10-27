//! 多语言支持。
//!
//! 语言包为 YAML 嵌套结构，启动时拍平成 `a.b.c` 形式的扁平键。
//! 查不到时回退到英文，英文也没有时返回键本身，方便发现遗漏。

use std::collections::HashMap;

use once_cell::sync::Lazy;
use serde_yaml::Value;

use crate::embed::Locales;

/// 兜底语言
pub const FALLBACK: &str = "en";

/// 已提供的语言。新增语言只需往 `locales/` 放一个 `<code>.yml` 并在此登记。
///
/// 语言包不必译全 —— `t()` 是**逐键**回退到英文的，缺的那条显示英文，
/// 不会露出键名。所以新语言可以先上框架与常用词，再一点点补。
pub const AVAILABLE: &[(&str, &str)] = &[
    ("en", "English"),
    ("zh-CN", "简体中文"),
    ("de", "Deutsch"),
    ("fr", "Français"),
    ("ja", "日本語"),
    ("es", "Español"),
    ("ko", "한국어"),
];

static CATALOGS: Lazy<HashMap<String, HashMap<String, String>>> = Lazy::new(load_all);

fn load_all() -> HashMap<String, HashMap<String, String>> {
    AVAILABLE
        .iter()
        .map(|(code, _)| {
            let flat = load_one(code).unwrap_or_default();
            (code.to_string(), flat)
        })
        .collect()
}

fn load_one(lang: &str) -> Option<HashMap<String, String>> {
    let raw = Locales::get(&format!("{lang}.yml"))?;
    let text = std::str::from_utf8(&raw.data).ok()?;
    // YAML 解析失败（比如同一个映射里有两个同名键）必须报出来 —— 静默当成空语言包的话，
    // 整站会退回英文，而日志里什么都看不见，最难查的就是这种。
    let value: Value = match serde_yaml::from_str(text) {
        Ok(v) => v,
        Err(e) => {
            log::error!("语言包 {lang}.yml 解析失败: {e}");
            return None;
        }
    };
    let mut flat = HashMap::new();
    flatten(&value, "", &mut flat);
    Some(flat)
}

/// 把嵌套 YAML 递归拍平成 `a.b.c -> 值`
fn flatten(value: &Value, prefix: &str, out: &mut HashMap<String, String>) {
    match value {
        Value::Mapping(map) => {
            for (k, v) in map {
                // 顶层节点的 prefix 为空，否则会拼出 `.404.backHome` 这种带前导点的键
                let key = if prefix.is_empty() {
                    scalar_key(k)
                } else {
                    format!("{prefix}.{}", scalar_key(k))
                };
                flatten(v, &key, out);
            }
        }
        Value::Sequence(seq) => {
            // 语言包里少用数组，这里统一转成逗号分隔
            let joined = seq.iter().map(scalar_key).collect::<Vec<_>>().join(", ");
            out.insert(prefix.to_string(), joined);
        }
        Value::String(s) => {
            out.insert(prefix.to_string(), s.clone());
        }
        Value::Number(n) => {
            out.insert(prefix.to_string(), n.to_string());
        }
        Value::Bool(b) => {
            out.insert(prefix.to_string(), b.to_string());
        }
        _ => {}
    }
}

fn scalar_key(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        other => serde_yaml::to_string(other)
            .unwrap_or_default()
            .trim()
            .to_string(),
    }
}

/// 按语言取文案；该语言缺失时回退英文，都缺失时返回键本身。
pub fn t(lang: &str, key: &str) -> String {
    CATALOGS
        .get(lang)
        .and_then(|c| c.get(key))
        .or_else(|| CATALOGS.get(FALLBACK).and_then(|c| c.get(key)))
        .cloned()
        .unwrap_or_else(|| key.to_string())
}

/// 按语言取文案，并把模板里的 `{名字}` 占位符换掉。
///
/// 占位符按**名字**而不是按位置 —— 两种语言的语序不同，
/// 位置参数（`{0}`、`{1}`）在翻译里没法用。
/// 换不掉的占位符原样留着：模板与参数对不上时不该静默吞掉，
/// 让页面上露出一个 `{count}` 比整句消失更容易看出哪里错了。
pub fn t_args(lang: &str, key: &str, args: &[(&str, &str)]) -> String {
    let mut s = t(lang, key);
    for (name, value) in args {
        s = s.replace(&format!("{{{name}}}"), value);
    }
    s
}

/// 供前端使用的界面文案：把语言包里 `ui.*` 那一节去掉前缀后返回。
///
/// 前端 `ItTools.i18n('copy', 'Copy')` 按裸键查找，所以这里不能带 `ui.` 前缀。
/// 只下发 `ui.` 段，避免把每个工具的标题/描述也塞进每个页面。
pub fn ui_bundle(lang: &str) -> serde_json::Map<String, serde_json::Value> {
    let Some(catalog) = CATALOGS.get(lang) else {
        return serde_json::Map::new();
    };
    catalog
        .iter()
        .filter_map(|(k, v)| {
            k.strip_prefix("ui.")
                .map(|k| (k.to_string(), serde_json::Value::from(v.as_str())))
        })
        .collect()
}

/// 该语言下是否有这条文案（用于测试断言语言包完整性）
#[allow(dead_code)] // 仅单测使用
pub fn has(lang: &str, key: &str) -> bool {
    CATALOGS.get(lang).is_some_and(|c| c.contains_key(key))
}

/// 解析请求语言：`?lang=` > Cookie > `Accept-Language` > 默认语言
pub fn negotiate(
    query: Option<&str>,
    cookie: Option<&str>,
    accept_language: Option<&str>,
    default: &str,
) -> String {
    if let Some(l) = query.filter(|l| is_available(l)) {
        return l.to_string();
    }
    if let Some(l) = cookie.filter(|l| is_available(l)) {
        return l.to_string();
    }
    if let Some(header) = accept_language {
        // 取权重最高的第一个语言标签
        for part in header.split(',') {
            let tag = part.split(';').next().unwrap_or("").trim();
            if tag.is_empty() {
                continue;
            }
            if is_available(tag) {
                return tag.to_string();
            }
            // `zh-CN` 这类带区域标签：退到基础标签再试一次（`zh` 本身并不是可用语言）
            if let Some((base, _)) = tag.split_once('-') {
                if is_available(base) {
                    return base.to_string();
                }
            }
            // `zh` 这类无区域标签：接受第一个以它开头的可用语言（zh → zh-CN）
            if let Some((code, _)) = AVAILABLE.iter().find(|(c, _)| c.starts_with(tag)) {
                return (*code).to_string();
            }
        }
    }
    default.to_string()
}

pub fn is_available(code: &str) -> bool {
    AVAILABLE.iter().any(|(c, _)| *c == code)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_registered_language_loads() {
        for (code, name) in AVAILABLE {
            let catalog = CATALOGS
                .get(*code)
                .unwrap_or_else(|| panic!("语言 {code}（{name}）没加载上"));
            assert!(
                !catalog.is_empty(),
                "语言 {code}（{name}）的语言包是空的 —— locales/{code}.yml 没解析出内容"
            );
        }
    }

    #[test]
    fn known_keys_resolve() {
        assert_eq!(t("en", "ui.tagline"), "Handy tools for developers");
        assert_eq!(t("zh-CN", "tools.hash-text.title"), "Hash 文本");
    }

    #[test]
    fn falls_back_to_english() {
        // 没登记的语言（CATALOGS 里没有）整个落到英文兜底，这里测的正是这个分支。
        assert_eq!(t("ru", "ui.tagline"), "Handy tools for developers");
        // 登记了的语言用自己的翻译，不该被英文覆盖
        assert_eq!(t("zh-CN", "ui.tagline"), "开发者 handy 工具箱");
    }

    /// 别的语言**只能用**英文语言包里有的键。
    ///
    /// 键是英文语言包的超集才安全 —— 反过来（英文有、新语言没有）是允许的：
    /// `t()` 会逐键回退到英文。新语言有、英文没有的键则是拼错了或者
    /// 键改名了没同步，页面上会露出一个没人认得的键名。
    #[test]
    fn other_languages_only_use_keys_english_knows() {
        let en = CATALOGS.get(FALLBACK).expect("英文语言包应当加载了");
        for (code, _) in AVAILABLE.iter().filter(|(c, _)| *c != FALLBACK) {
            let catalog = CATALOGS.get(*code).expect("语言应当加载了");
            let unknown: Vec<&String> = catalog.keys().filter(|k| !en.contains_key(*k)).collect();
            assert!(
                unknown.is_empty(),
                "{code}.yml 里有英文语言包没有的键（{} 条）：\n  {}",
                unknown.len(),
                unknown
                    .iter()
                    .map(|k| k.as_str())
                    .collect::<Vec<_>>()
                    .join("\n  ")
            );
        }
    }

    #[test]
    fn unknown_key_returns_itself() {
        assert_eq!(t("en", "tools.nope.title"), "tools.nope.title");
    }

    #[test]
    fn placeholders_are_substituted_by_name() {
        // 占位符按名字换 —— 两种语言的语序不同，位置参数没法用
        assert_eq!(
            t_args("en", "out.common.missing_field", &[("field", "text")]),
            "Missing field `text`"
        );
        assert_eq!(
            t_args("zh-CN", "out.common.missing_field", &[("field", "text")]),
            "缺少字段 `text`"
        );
    }

    #[test]
    fn an_unmatched_placeholder_is_left_alone() {
        // 模板与参数对不上时不该静默吞掉 —— 露出 `{count}` 比整句消失好看出错
        assert_eq!(
            t_args("en", "out.common.missing_field", &[("nope", "x")]),
            "Missing field `{field}`"
        );
    }

    #[test]
    fn negotiation_precedence() {
        assert_eq!(negotiate(Some("zh-CN"), Some("en"), None, "en"), "zh-CN");
        assert_eq!(negotiate(None, Some("zh-CN"), None, "en"), "zh-CN");
        assert_eq!(negotiate(None, None, Some("zh-CN,zh;q=0.9"), "en"), "zh-CN");
        assert_eq!(negotiate(None, None, Some("zh"), "en"), "zh-CN");
        // 地区标签退到基础语言
        assert_eq!(negotiate(None, None, Some("fr-FR"), "en"), "fr");
        assert_eq!(negotiate(None, None, Some("de-AT"), "en"), "de");
        // 没有的语言落到默认语言
        assert_eq!(negotiate(None, None, Some("ru-RU"), "en"), "en");
        assert_eq!(negotiate(None, None, None, "en"), "en");
    }
}

/// 语言包里不该有「谁都不读」的键。
///
/// 语言包是从参考实现整份搬过来的，里面混着一批上游自己用的键
/// （`home.*`、`about.content`、`404.*` …）—— 本移植版根本没有对应的界面。
/// 留着它们有两个坏处：一是内容对不上（上游 `about.content` 里写的是原作者的
/// 域名与赞助链接，`home.follow` 里写的是上游的仓库），二是有歧义 ——
/// 看语言包的人以为这些键背后有界面，其实没有。
///
/// 所以这里反过来盯：语言包里每一条键，都得有代码真的去读它。
/// 少一条说明有人加了键却没接上，多一条说明有人删了界面却忘了删键。
#[cfg(test)]
mod dead_keys {
    use super::*;
    use std::collections::BTreeSet;

    /// 代码里真正会去读的键全集
    fn keys_in_use() -> BTreeSet<String> {
        let mut known: BTreeSet<String> = BTreeSet::new();

        // 1. ui.<key> —— UiStrings 的字段名就是语言包里的键
        let ui = serde_json::to_value(crate::handlers::view::UiStrings::for_lang("en"))
            .expect("UiStrings 应当能序列化");
        for k in ui.as_object().expect("UiStrings 应当是个对象").keys() {
            known.insert(format!("ui.{k}"));
        }

        // 2. ui.tool.<slug>.<key> —— JS 工具的界面文案
        for (slug, texts) in super::js_text::used_texts() {
            for key in texts.keys() {
                known.insert(format!("ui.tool.{slug}.{key}"));
            }
        }

        // 3. tools.<路由>.title / .description 与 tools.categories.* —— 注册表
        for tool in crate::registry::TOOLS.iter() {
            known.insert(tool.name_key.to_string());
            known.insert(tool.desc_key.to_string());
        }
        for cat in crate::registry::Category::ALL {
            known.insert(cat.name_key().to_string());
        }

        // 4. field.<name> 与 opt.<字段>.<取值> —— 表单字段与下拉项
        //    （opt 的键怎么拼，见 handlers::view 里取下拉文案的那段）
        for tool in crate::registry::TOOLS.iter() {
            let Some(spec) = tool.impl_kind.api_spec() else {
                continue;
            };
            for f in spec.fields {
                known.insert(f.label_key.to_string());
                let base = format!("opt.{}", f.name.replace(['-', '_'], "."));
                for (v, _) in f.options {
                    known.insert(format!("{base}.{v}"));
                }
            }
        }

        // 5. out.* —— 服务端 API 工具结果区里的文案
        //
        // 这些键在 Rust 源码里以字符串字面量的形式出现
        // （`util::row(&mut table, &payload, "out.foo.bar", …)`），
        // 没有单独的注册表 —— 所以只能扫源码，思路跟上面扫 JS 工具一样。
        for key in api_output_keys() {
            known.insert(key);
        }

        // 6. result.* —— API 工具结果区的标题
        //
        // 参考实现里每个工具的结果区各有各的名字（「HMAC of your text」
        // 「Your text encrypted」「Vendor info」…），不是笼统的「Output」。
        // 键名登记在注册表的 Tool::api_result_labels 里，
        // 渲染时由 handlers::view 翻译成对应语言的文案。
        for tool in crate::registry::TOOLS.iter() {
            for key in tool.api_result_labels() {
                known.insert(key.to_string());
            }
        }

        known
    }

    /// `src/tools/` 下所有 `"out.…"` 字符串字面量 —— 即服务端工具真正会读的键。
    ///
    /// 扫的是**字符串字面量**，不是裸文本：注释里提到一个键不算「代码在用」，
    /// 否则一行注释就能让语言包里的键看起来有人读，那条对账测试就白做了。
    fn api_output_keys() -> BTreeSet<String> {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/tools");
        let mut out = BTreeSet::new();
        let Ok(entries) = std::fs::read_dir(&dir) else {
            return out;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("rs") {
                continue;
            }
            let Ok(src) = std::fs::read_to_string(&path) else {
                continue;
            };
            for key in scan_out_keys(&src) {
                out.insert(key);
            }
        }
        out
    }

    /// 扫出源码里的 `"out.…"` 字符串字面量。
    ///
    /// Rust 的词法比 JS 复杂（字符字面量、生命周期、宏），这里只认四件事：
    /// 普通字符串、`//` 行注释、`/* */` 块注释、`'x'` 字符字面量。
    /// 够用 —— 关键是别把注释里的字当代码，也别把生命周期 `'a` 当成字符字面量
    /// （那会把后面一整段源码里的引号都错位）。
    fn scan_out_keys(src: &str) -> Vec<String> {
        let b = src.as_bytes();
        let mut i = 0;
        let mut out = Vec::new();
        while i < b.len() {
            match b[i] {
                b'/' if b.get(i + 1) == Some(&b'/') => {
                    while i < b.len() && b[i] != b'\n' {
                        i += 1;
                    }
                }
                b'/' if b.get(i + 1) == Some(&b'*') => {
                    i += 2;
                    while i < b.len() && !(b[i] == b'*' && b.get(i + 1) == Some(&b'/')) {
                        i += 1;
                    }
                    i = (i + 2).min(b.len());
                }
                b'\'' => {
                    // 只有 `'x'` / `'\n'` 这种**一个字符**的才是字符字面量；
                    // `'a`（生命周期）不是 —— 判错了会把后面的引号全带偏。
                    let mut j = i + 1;
                    if b.get(j) == Some(&b'\\') {
                        j += 2;
                    } else {
                        j += 1;
                    }
                    i = if b.get(j) == Some(&b'\'') { j + 1 } else { i + 1 };
                }
                b'"' => {
                    let start = i + 1;
                    let mut j = start;
                    while j < b.len() {
                        if b[j] == b'\\' {
                            j += 2;
                            continue;
                        }
                        if b[j] == b'"' {
                            break;
                        }
                        j += 1;
                    }
                    if j >= b.len() {
                        break;
                    }
                    let lit = &src[start..j];
                    if is_out_key(lit) {
                        out.push(lit.to_string());
                    }
                    i = j + 1;
                }
                _ => i += 1,
            }
        }
        out
    }

    /// `out.<段>.<名字>` 形式的键才算数 —— 至少两段，字符集也有限。
    ///
    /// 字符集是「字母数字 + `-` + `.` + `_`」：**下划线必须在内** ——
    /// 键名的约定是 snake_case（`out.week-number-converter.day_label.monday`），
    /// 少了下划线的话，这些键会被**静默漏掉**，于是语言包里明明有的键
    /// 在「谁在读」的对账里被判成没人读（反之代码在用的键会被判成不存在）。
    fn is_out_key(lit: &str) -> bool {
        if !lit
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'.' || c == b'_')
        {
            return false;
        }
        let mut it = lit.split('.');
        if it.next() != Some("out") {
            return false;
        }
        let mut segments = 0;
        for seg in it {
            if seg.is_empty() {
                return false;
            }
            segments += 1;
        }
        segments >= 2
    }

    /// 扫描器本身也得有人盯着 —— 它判错了，对账测试就跟着一起失效。
    #[test]
    fn the_out_key_scanner_only_sees_real_string_literals() {
        let src = r#"
            // 注释里的 "out.commented.label" 不算数
            /* 块注释里的 "out.blocked.label" 也不算 */
            fn f<'a>(x: &'a str) -> &'static str {
                let s = "out.kept.label";
                let c = 'x';
                let u = "https://example.com/out.not.a.key";
                let _ = (c, u);
                s
            }
        "#;
        let keys = scan_out_keys(src);
        assert!(keys.contains(&"out.kept.label".to_string()), "{keys:?}");
        assert!(!keys.iter().any(|k| k.contains("commented")), "{keys:?}");
        assert!(!keys.iter().any(|k| k.contains("blocked")), "{keys:?}");
        assert!(!keys.iter().any(|k| k.contains("not.a.key")), "{keys:?}");
    }

    /// 键名是 snake_case —— **下划线必须在字符集里**。
    ///
    /// 这条单测是补上一个真 bug 的回归：字符集原本只放行了「字母数字 + `-` + `.`」，
    /// 于是 `out.week-number-converter.day_label.monday` 这种带下划线的键
    /// **一个都扫不到** —— 语言包里明明有，扫描器却说没人读；
    /// 反过来代码里在用的键又会被判成「语言包里没有」。
    #[test]
    fn the_out_key_scanner_keeps_snake_case_keys() {
        let src = r#"
            let a = "out.week-number-converter.day_label.monday";
            let b = "out.pdf-signature-checker.reason_byte_range_count";
            let c = "out.ipv6.kind.ipv4_mapped";
        "#;
        let keys = scan_out_keys(src);
        assert!(keys.contains(&"out.week-number-converter.day_label.monday".to_string()), "{keys:?}");
        assert!(keys.contains(&"out.pdf-signature-checker.reason_byte_range_count".to_string()), "{keys:?}");
        assert!(keys.contains(&"out.ipv6.kind.ipv4_mapped".to_string()), "{keys:?}");
    }

    #[test]
    fn every_locale_key_is_read_by_somebody() {
        let known = keys_in_use();
        let dead: Vec<&String> = CATALOGS
            .get("en")
            .expect("英文语言包应当加载了")
            .keys()
            .filter(|k| !known.contains(*k))
            .collect();
        assert!(
            dead.is_empty(),
            "语言包里有没人读的键（{} 条）：\n  {}\n\
             要么删掉这些键，要么把对应的界面接上",
            dead.len(),
            dead.iter()
                .map(|k| k.as_str())
                .collect::<Vec<_>>()
                .join("\n  ")
        );
    }

    /// 反过来也要盯：代码里要用的键，语言包里不能没有。
    ///
    /// 少了会**静默**退回英文兜底 —— 页面照渲染，只是文案变成了另一种语言，
    /// 肉眼看截图很难发现。
    #[test]
    fn every_key_in_use_exists_in_the_locale() {
        let catalog = CATALOGS.get("en").expect("英文语言包应当加载了");
        let missing: Vec<String> = keys_in_use()
            .iter()
            .filter(|k| !catalog.contains_key(*k))
            .cloned()
            .collect();
        assert!(
            missing.is_empty(),
            "代码在用但语言包里没有的键：\n  {}",
            missing.join("\n  ")
        );
    }
}

/// JS 工具的界面文案与语言包的对账。
///
/// 工具模块里所有**用户能看到的字**都走 `ItTools.t('<slug>')('key', 'English')`，
/// 语言包里对应 `ui.tool.<slug>.<key>`。两边各写各的必然漂移 ——
/// 语言包漏一条，前端就悄悄退回英文；英文改了而语言包没改，中文界面就一直显示旧文案。
/// 这里的三个单测把这种漂移钉死。
#[cfg(test)]
mod js_text {
    use super::*;
    use crate::embed::StaticAsset;
    use std::collections::{BTreeMap, BTreeSet};

    /// 读一个 JS 单引号字符串字面量，返回 (内容, 结束位置)。
    fn read_js_string(src: &str, at: usize) -> Option<(String, usize)> {
        let b = src.as_bytes();
        if b.get(at) != Some(&b'\'') {
            return None;
        }
        let mut out = String::new();
        let mut i = at + 1;
        while i < b.len() {
            match b[i] {
                b'\\' => {
                    let n = *b.get(i + 1)?;
                    out.push(match n {
                        b'n' => '\n',
                        b't' => '\t',
                        b'r' => '\r',
                        // 其余只可能是 \' 与 \\（这些文件的文案里没别的转义）
                        other => other as char,
                    });
                    i += 2;
                }
                b'\'' => return Some((out, i + 1)),
                _ => {
                    let ch = src[i..].chars().next()?;
                    out.push(ch);
                    i += ch.len_utf8();
                }
            }
        }
        None
    }

    /// 扫出 `t('key', 'English')` 形式的调用。
    ///
    /// 只认**两个字面量**的调用：键是拼出来的（`'a.' + x`）就跳过 ——
    /// 那种键没法跟语言包逐条对账，所以约定是**键必须写字面量**。
    fn scan_text_calls(src: &str) -> Vec<(String, String)> {
        let b = src.as_bytes();
        let mut out = Vec::new();
        let mut i = 0;
        while let Some(rel) = src[i..].find("t(") {
            let at = i + rel;
            i = at + 2;
            // `t(` 前面紧挨着标识符字符就跳过，否则命中的是 `split(`、`format(` 这种
            if at > 0 {
                let prev = b[at - 1];
                if prev.is_ascii_alphanumeric() || prev == b'_' || prev == b'$' {
                    continue;
                }
            }
            let mut p = at + 2;
            while p < b.len() && b[p].is_ascii_whitespace() {
                p += 1;
            }
            let Some((key, next)) = read_js_string(src, p) else {
                continue;
            };
            p = next;
            while p < b.len() && b[p].is_ascii_whitespace() {
                p += 1;
            }
            if b.get(p) != Some(&b',') {
                continue;
            }
            p += 1;
            while p < b.len() && b[p].is_ascii_whitespace() {
                p += 1;
            }
            let Some((text, _)) = read_js_string(src, p) else {
                continue;
            };
            out.push((key, text));
        }
        out
    }

    /// slug → 该工具用到的所有文案键（键 → 英文兜底）
    pub(super) fn used_texts() -> BTreeMap<String, BTreeMap<String, String>> {
        let mut map: BTreeMap<String, BTreeMap<String, String>> = BTreeMap::new();
        for name in StaticAsset::iter() {
            if !name.starts_with("js/tools/") || !name.ends_with(".js") {
                continue;
            }
            let slug = name
                .trim_start_matches("js/tools/")
                .trim_end_matches(".js")
                .to_string();
            let raw = StaticAsset::get(&name).expect("嵌入资源里没有该工具");
            let src = String::from_utf8(raw.data.into_owned()).expect("工具源码不是 UTF-8");
            let entries = map.entry(slug).or_default();
            for (key, text) in scan_text_calls(&src) {
                entries.insert(key, text);
            }
        }
        map
    }

    /// 语言包里 `ui.tool.*` 那一段的键 → 值
    fn locale_tool_texts(lang: &str) -> BTreeMap<String, String> {
        CATALOGS
            .get(lang)
            .expect("语言包没加载")
            .iter()
            .filter_map(|(k, v)| {
                k.strip_prefix("ui.tool.")
                    .map(|rest| (rest.to_string(), v.clone()))
            })
            .collect()
    }

    #[test]
    fn js_tool_texts_have_locale_entries() {
        let en = locale_tool_texts("en");
        let zh = locale_tool_texts("zh-CN");
        let used = used_texts();
        let mut problems = Vec::new();
        let mut total = 0;
        for (slug, entries) in &used {
            for (key, text) in entries {
                total += 1;
                let full = format!("{slug}.{key}");
                match en.get(&full) {
                    Some(v) if v == text => {}
                    Some(v) => problems.push(format!(
                        "en.yml 的 ui.tool.{full} 是 {v:?}，但 {slug}.js 里的英文兜底是 {text:?}"
                    )),
                    None => problems.push(format!("en.yml 缺 ui.tool.{full}（{text:?}）")),
                }
                match zh.get(&full) {
                    Some(v) if v.trim().is_empty() => {
                        problems.push(format!("zh-CN.yml 的 ui.tool.{full} 是空的"))
                    }
                    Some(_) => {}
                    None => problems.push(format!("zh-CN.yml 缺 ui.tool.{full}")),
                }
            }
        }
        // 先报对不上的，再报「扫得太少」—— 后者会让前者根本没机会显示
        assert!(problems.is_empty(), "{}", problems.join("\n"));
        assert!(
            total > 1500,
            "只扫到 {total} 条文案 —— 扫描规则多半跟代码里的写法脱节了"
        );
    }

    #[test]
    fn locale_tool_texts_are_all_used() {
        let used = used_texts();
        let en = locale_tool_texts("en");
        let mut problems = Vec::new();
        for (full, _) in &en {
            let Some((slug, key)) = full.split_once('.') else {
                problems.push(format!("ui.tool.{full} 的键里没有点号"));
                continue;
            };
            match used.get(slug) {
                None => problems.push(format!("ui.tool.{full}：没有对应的 {slug}.js")),
                Some(entries) => {
                    if !entries.contains_key(key) {
                        problems.push(format!("ui.tool.{full}：{slug}.js 里没用到这个键"));
                    }
                }
            }
        }
        assert!(problems.is_empty(), "{}", problems.join("\n"));
    }

    #[test]
    fn en_and_zh_cover_the_same_tool_texts() {
        let en: BTreeSet<String> = locale_tool_texts("en").into_keys().collect();
        let zh: BTreeSet<String> = locale_tool_texts("zh-CN").into_keys().collect();
        let missing: Vec<&String> = en.difference(&zh).collect();
        let extra: Vec<&String> = zh.difference(&en).collect();
        assert!(
            missing.is_empty() && extra.is_empty(),
            "中文缺这些：{missing:?}\n中文多这些：{extra:?}"
        );
    }

    /// 任何语言包里 `ui.tool.*` 的键，都得是**工具代码真的在用**的键。
    ///
    /// 这条是给「键名写错了」兜底的。语言包少一条，页面会退回英文
    /// （逐键回退）—— 不好看但不致命；多一条则是**彻底没人看**：
    /// 前端查的是另一个键名，这份译文永远不会被取出来。
    ///
    /// 真实踩过的坑：YAML 1.1 把 `yes:` / `no:` 当布尔值，1.2 当字符串，
    /// 两边读出来的键名不一样（`True` vs `yes`）。工单按其中一种发，
    /// 译文就落在了另一种的键上 —— 页面看着好好的，只是那几条一直是英文。
    /// 所以这里不只查英文包：**每个**语言包都查。
    #[test]
    fn no_language_pack_has_tool_keys_the_code_never_asks_for() {
        let used = used_texts();
        for &(code, _) in AVAILABLE.iter() {
            let catalog = locale_tool_texts(code);
            let mut orphans = Vec::new();
            for (full, _) in &catalog {
                let Some((slug, key)) = full.split_once('.') else {
                    orphans.push(format!("{full}（键里没有点号）"));
                    continue;
                };
                match used.get(slug) {
                    None => orphans.push(format!("{full}：没有对应的 {slug}.js")),
                    Some(entries) => {
                        if !entries.contains_key(key) {
                            orphans.push(format!("{full}：{slug}.js 里没用到这个键"));
                        }
                    }
                }
            }
            assert!(
                orphans.is_empty(),
                "{code} 的语言包里有 {} 条没人会读的键：\n  {}\n\
                 键名多半跟工具代码对不上（YAML 的键名有历史坑，见本测试的说明）",
                orphans.len(),
                orphans.join("\n  ")
            );
        }
    }
}
