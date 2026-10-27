#!/usr/bin/env python3
"""把 worker 交上来的新工具并进注册表与语言包。

worker 只交三个文件（JS 模块 / 中文文案 json / 注册表片段），注册表与
locales 由这个脚本统一改 —— 多个 worker 同时改那两个文件会互相覆盖。

用法：
    python3 scripts/new-tool/integrate.py            # 写文件
    python3 scripts/new-tool/integrate.py --check    # 只检查不写
"""
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
NEWT = os.path.join(ROOT, "new-tool")
TOOLS_RS = os.path.join(ROOT, "src/registry/tools.rs")
LOCALES = [("en", os.path.join(ROOT, "locales/en.yml")),
           ("zh-CN", os.path.join(ROOT, "locales/zh-CN.yml"))]

RESERVED = {"y", "n", "yes", "no", "true", "false", "on", "off", "null", "~"}


def yaml_scalar(value):
    """按需加引号的 YAML 标量。风格跟现有的 locales/*.yml 保持一致。"""
    s = str(value)
    if s == "":
        return "''"
    low = s.lower()
    if low in RESERVED:
        return "'" + s + "'"
    if re.fullmatch(r"[-+]?[0-9.]+([eE][-+]?[0-9]+)?", s):
        return "'" + s + "'"
    if s != s.strip():
        return "'" + s.replace("'", "''") + "'"
    if s[0] in "-?:,[]{}#&*!|>'\"%@`" or ": " in s or " #" in s or s.endswith(":"):
        return "'" + s.replace("'", "''") + "'"
    return s


def read_meta(path):
    """读 <slug>.meta.txt，返回 {title, description, title_zh, description_zh}。"""
    out = {}
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            if ":" not in line:
                continue
            key, _, value = line.partition(":")
            out[key.strip()] = value.strip()
    return out


def read_registry(path):
    """读 <slug>.registry.txt，归一化成一段完整的 Tool { … }, 源码。

    worker 交上来的片段有两种写法：带 `Tool { … },` 外壳的，和只有字段的。
    两种都要能接上 —— 少了外壳的，光补开头不补结尾会拼出一段语法错误的 Rust。

    缩进也一并归一化：注册表里的house style是 `Tool {` 在 4 空格、字段在 8 空格、
    数组元素再往里 4 空格。worker 各自的缩进五花八门，直接拼进去文件就没法看了。
    """
    with open(path, encoding="utf-8") as f:
        snippet = f.read()
    # 去掉可能的 ```rust 围栏
    snippet = re.sub(r"^```[a-z]*\n", "", snippet.strip())
    snippet = re.sub(r"\n```$", "", snippet.strip())

    lines = [l for l in snippet.split("\n") if l.strip()]
    # 剥掉外层包装（如果有）
    if lines and lines[0].strip() == "Tool {":
        lines = lines[1:]
    if lines and lines[-1].strip() in ("},", "}"):
        lines = lines[:-1]
    if not lines:
        raise SystemExit(f"{path}: 片段是空的")

    out = ["    Tool {"]
    depth = 0
    for line in lines:
        text = line.strip()
        # 以闭合符开头的行属于内层，打印完再退一层
        closer = text.startswith("]") or text.startswith("}")
        print_depth = depth - 1 if closer else depth
        out.append("        " + "    " * max(0, print_depth) + text)
        if closer:
            depth -= 1
        else:
            depth += (text.count("[") + text.count("{")
                      - text.count("]") - text.count("}"))
    out.append("    },")
    return "\n".join(out)


def insert_registry(snippets):
    src = open(TOOLS_RS, encoding="utf-8").read()
    marker = "\n];\n"
    at = src.rindex(marker)
    block = "\n" + "\n".join(snippets) + "\n"
    return src[:at] + block + src[at + 1:]


def insert_locale(text, slug, meta):
    """把 tools.<path>.title / .description 插进 tools: 段末尾。"""
    if "tools:" not in text:
        raise SystemExit("语言包里没有 tools: 段")
    # 找到 tools: 段的结束（下一个顶层键）
    lines = text.split("\n")
    start = None
    for i, line in enumerate(lines):
        if line == "tools:":
            start = i
            break
    end = len(lines)
    for i in range(start + 1, len(lines)):
        line = lines[i]
        if line and not line[0].isspace():
            end = i
            break
    block = [f"  {slug}:"]
    for key in ("title", "description"):
        value = meta.get(key)
        block.append(f"    {key}: {yaml_scalar(value)}")
    head = lines[:end]
    # 段末尾原有的空行去掉，换成我们自己加的那个，免得空两行
    while head and head[-1].strip() == "":
        head.pop()
    return "\n".join(head + [""] + block + lines[end:])


def main():
    check = "--check" in sys.argv
    slugs = sorted(
        f[:-len(".registry.txt")]
        for f in os.listdir(NEWT)
        if f.endswith(".registry.txt")
    )
    if not slugs:
        print("没有可并入的新工具")
        return 0

    snippets, metas = [], []
    for slug in slugs:
        reg = os.path.join(NEWT, f"{slug}.registry.txt")
        metap = os.path.join(NEWT, f"{slug}.meta.txt")
        if not os.path.exists(metap):
            raise SystemExit(f"{slug}: 缺 {metap}")
        snippets.append(read_registry(reg))
        metas.append((slug, read_meta(metap)))

    # --- 注册表 ---
    src = open(TOOLS_RS, encoding="utf-8").read()
    for slug, snippet in zip(slugs, snippets):
        if f'slug: "{slug}"' in src:
            print(f"{slug}: 注册表里已经有了，跳过")
            snippets[slugs.index(slug)] = None
            continue
    todo = [(s, sn) for s, sn in zip(slugs, snippets) if sn is not None]
    if todo:
        new_src = insert_registry([sn for _, sn in todo])
        if check:
            if new_src != src:
                print("注册表与预期不一致")
                return 1
        else:
            open(TOOLS_RS, "w", encoding="utf-8").write(new_src)
            print(f"注册表：并入 {len(todo)} 条 -> {', '.join(s for s, _ in todo)}")

    # --- 语言包 ---
    for lang, path in LOCALES:
        text = open(path, encoding="utf-8").read()
        chunks = []
        changed = False
        for slug, meta in metas:
            key = f"tools.{slug}.title"
            if f"\n  {slug}:\n" in text:
                print(f"{lang}: {slug} 已在语言包里，跳过")
                continue
            m = dict(meta)
            if lang != "en":
                m["title"] = meta.get("title_zh", meta.get("title"))
                m["description"] = meta.get("description_zh", meta.get("description"))
            chunks.append((slug, m))
            changed = True
        if not changed:
            continue
        new_text = text
        for slug, m in chunks:
            new_text = insert_locale(new_text, slug, m)
        if check:
            if new_text != text:
                print(f"{lang}.yml 与预期不一致")
                return 1
        else:
            open(path, "w", encoding="utf-8").write(new_text)
            print(f"{lang}.yml：并入 {len(chunks)} 条")

    print("done")
    return 0


sys.exit(main())
