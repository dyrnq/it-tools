//! 隐私守门人：仓库里不许留下「这是谁在哪台机器上编的」这类痕迹。
//!
//! 真实翻过的例子：六个 JS 工具的注释里写着「参考实现：〈某台内网机器上的
//! 绝对路径〉/src/tools/xxx/」。那些注释随静态资源发给了**每一个访问者**
//! （view-source 就看得见），源码又进了公开的仓库。路径本身不算秘密，
//! 但它把内网的目录结构和构建机的用户名一起带出去了。
//!
//! 这里盯的是**要发出去的文件**（进仓库的源码 + 随二进制发给访客的静态资源）。
//! 二进制里嵌的构建机路径（`~/.cargo/registry/…`）不在这一条的范围里 ——
//! 那不是秘密，也没人能从它推出什么。

use std::path::{Component, PathBuf};

/// 仓库根目录（编译期就知道的绝对路径）。
fn project_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

/// 本机路径的标志：**仓库的各级祖先目录** + **构建者的家目录**。
///
/// 只认这两样，是因为它们在任何正常内容里都不会出现 ——
/// 文档里的 `/etc/resolv.conf`、`C:\path\File.cs` 那些都不沾边。
/// 祖先目录是从 `CARGO_MANIFEST_DIR` 现场算出来的，所以这个测试
/// **不写死任何路径** —— 换台机器、换个 CI runner 照样成立。
fn markers() -> Vec<String> {
    let root = project_dir();
    let mut out: Vec<String> = Vec::new();
    let mut cur = Some(root.as_path());
    while let Some(dir) = cur {
        // 只数「有名字」的那几层：单个名字的顶层目录（/data、/home）
        // 太常见，拿来当标志会误伤正常的文档内容。
        let named = dir
            .components()
            .filter(|c| !matches!(c, Component::RootDir | Component::Prefix(_)))
            .count();
        if named < 2 {
            break;
        }
        out.push(dir.to_string_lossy().into_owned());
        cur = dir.parent();
    }
    for key in ["HOME", "USERPROFILE"] {
        if let Ok(home) = std::env::var(key) {
            if !home.is_empty() {
                out.push(home);
            }
        }
    }
    out.sort();
    out.dedup();
    out
}

/// 本机路径不能出现在任何**要发出去**的文件里。
///
/// 「要发出去」= 进仓库的源码 + 随二进制发给访问者的静态资源。
/// 第三方库（`static/lib`）与工具用的静态数据（`data/`）不算 ——
/// 那是别人的东西，改不动也不该改。
#[test]
fn no_local_paths_leak_into_published_files() {
    /// 这些目录不进仓库、也不是我们写的 —— 里面有什么都不归这条管。
    const SKIP_DIRS: &[&str] = &[
        ".git",
        "target",
        "node_modules",
        // 第三方库（layui / figlet / elheif / turndown …）
        "static/lib",
        // 工具用的静态数据（OUI 表）：纯数据，不是人写的内容
        "data",
        // 本地笔记与新工具的暂存区：都不进仓库
        "_docs",
        "new-tool",
        "dist",
    ];

    let marks = markers();
    assert!(!marks.is_empty(), "算不出本机路径的标志，这条测试等于没跑");

    let root = project_dir();
    let mut hits: Vec<String> = Vec::new();
    let mut stack = vec![root.clone()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let rel = path.strip_prefix(&root).unwrap_or(&path);
            let rel_text = rel.to_string_lossy().replace('\\', "/");

            if path.is_dir() {
                if SKIP_DIRS
                    .iter()
                    .any(|skip| rel_text == *skip || rel_text.starts_with(&format!("{skip}/")))
                {
                    continue;
                }
                stack.push(path);
                continue;
            }

            // 二进制文件（图片、字体、压缩包）读不成 UTF-8 —— 自然被跳过。
            let Ok(bytes) = std::fs::read(&path) else {
                continue;
            };
            let Ok(text) = String::from_utf8(bytes) else {
                continue;
            };
            for (i, line) in text.lines().enumerate() {
                for mark in &marks {
                    if line.contains(mark.as_str()) {
                        hits.push(format!(
                            "{rel_text}:{} 里有本机路径 {mark}\n      {}",
                            i + 1,
                            line.trim()
                        ));
                    }
                }
            }
        }
    }

    assert!(
        hits.is_empty(),
        "这些文件里有本机的路径 —— 它们会跟着静态资源发给每一个访问者，\
         也会跟着源码进公开的仓库：\n  {}",
        hits.join("\n  ")
    );
}
