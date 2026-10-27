#!/usr/bin/env python3
"""把 worker 交上来的表单字段文案并进语言包。

`integrate.py` 负责注册表条目与 `tools.<slug>.title/description`，
但 **API 工具的表单字段**还有两类键要加：

    field.<字段名>            —— 字段的标签（输入框左边那行字）
    opt.<字段>.<取值>         —— 下拉项的显示文案

这两类键散在 `field:` / `opt:` 两段里，多个 worker 同时改语言包会互相覆盖，
所以 worker 交 `new-tool/<slug>.fields.txt`，由这个脚本统一改。

还有第三类：**服务端工具结果区里的文案**：

    out.<slug>.<名字>         —— 结果表的表头，以及结果区里的整句话

它在 `out:` 段里。跟上面两类放一起是因为规则完全一样：代码里只出现键，
文案在这里 —— 两边各写各的必然漂移。

## fields.txt 的格式

每行一条，`#` 开头是注释：

    field.cidr: CIDR prefix | CIDR 网段
    opt.algorithm.rsa2048: RSA 2048 bits | RSA 2048 位
    out.cidr.network: Network | 网段

**竖线左边是英文，右边是中文**（`|` 前后各留一个空格）。
竖线右边可以省略 —— 省略时中英文用同一句话。

## 用法

    python3 scripts/new-tool/merge-fields.py           # 写文件
    python3 scripts/new-tool/merge-fields.py --check   # 只检查不写

重复跑是幂等的：已经在语言包里的键会被就地改写，不会重复追加。
"""
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
NEWT = os.path.join(ROOT, "new-tool")
LOCALES = [("en", os.path.join(ROOT, "locales/en.yml")),
           ("zh-CN", os.path.join(ROOT, "locales/zh-CN.yml"))]

RESERVED = {"y", "n", "yes", "no", "true", "false", "on", "off", "null", "~"}


def yaml_scalar(value, force_quote=False):
    """按需加引号的 YAML 标量。风格跟现有的 locales/*.yml 保持一致。

    `force_quote` 用来对齐语言包里 `field:` / `opt:` 两段的写法 ——
    那两段的**值一律加引号**（`text: 'Input text'`），而 `tools:` 段不是。
    """
    s = str(value)
    if s == "":
        return "''"
    low = s.lower()
    if force_quote or low in RESERVED:
        return "'" + s.replace("'", "''") + "'"
    if re.fullmatch(r"[-+]?[0-9.]+([eE][-+]?[0-9]+)?", s):
        return "'" + s + "'"
    if s != s.strip():
        return "'" + s.replace("'", "''") + "'"
    if s[0] in "-?:,[]{}#&*!|>'\"%@`" or ": " in s or " #" in s or s.endswith(":"):
        return "'" + s.replace("'", "''") + "'"
    # 花括号是 YAML 的流映射指示符 —— 占位符 `{count}` 出现在任何位置都要加引号，
    # 否则语言包会被解析成嵌套映射而不是一句话。
    if "{" in s or "}" in s:
        return "'" + s.replace("'", "''") + "'"
    return s


def parse_fields(path):
    """读 <slug>.fields.txt，返回 [(键路径, 英文, 中文)]。

    键路径是列表：`field.cidr` → `["field", "cidr"]`，
    `opt.algorithm.rsa2048` → `["opt", "algorithm", "rsa2048"]`。
    """
    out = []
    with open(path, encoding="utf-8") as f:
        for raw in f:
            line = raw.strip()
            if not line or line.startswith("#"):
                continue
            if ":" not in line:
                raise SystemExit(f"{path}: 行里没有冒号 —— {line!r}")
            key, _, value = line.partition(":")
            key = key.strip()
            if " | " in value:
                en, _, zh = value.partition(" | ")
                en, zh = en.strip(), zh.strip()
            else:
                en = zh = value.strip()
            if not key or not en:
                raise SystemExit(f"{path}: 键或英文为空 —— {line!r}")
            out.append((key.split("."), en, zh))
    return out


def _key_of(line):
    """取一行 YAML 的键名（去掉引号）。不是键行时返回 None。"""
    body = line.strip()
    if not body or body.startswith("#") or body.startswith("-"):
        return None
    if ":" not in body:
        return None
    key = body.split(":", 1)[0].strip()
    if len(key) >= 2 and key[0] == key[-1] and key[0] in "'\"":
        key = key[1:-1]
    return key


def _section(lines, name):
    """找顶层段 `name:`，返回 (起始行号, 结束行号)。结束行号是段后第一行的下标。"""
    start = None
    for i, line in enumerate(lines):
        if line.rstrip() == f"{name}:":
            start = i
            break
    if start is None:
        raise SystemExit(f"语言包里没有 {name}: 段")
    end = len(lines)
    for i in range(start + 1, len(lines)):
        line = lines[i]
        if line.strip() and not line[0].isspace():
            end = i
            break
    return start, end


def _find_child(lines, start, end, indent, name):
    """在 [start, end) 里找缩进恰好为 indent、键名是 name 的行。找不到返回 None。"""
    prefix = " " * indent
    for i in range(start, end):
        line = lines[i]
        if not line.startswith(prefix):
            continue
        rest = line[len(prefix):]
        if not rest or rest[0].isspace():
            continue
        if _key_of(line) == name:
            return i
    return None


def _block_end(lines, start, end, indent):
    """[start, end) 里，属于 `indent` 这一层的块的结束下标。

    行是空的或缩进大于 indent 的都算块内；缩进小于等于 indent 的非空行算块外。
    """
    for i in range(start, end):
        line = lines[i]
        if not line.strip():
            continue
        cur = len(line) - len(line.lstrip(" "))
        if cur <= indent:
            return i
    return end


def _insert_path(lines, start, end, indent, path, value, quote_leaf):
    """把 `path`（相对当前层）指向的键设成 `value`。返回 True 表示有改动。

    `quote_leaf` 决定叶子键要不要加引号 —— 语言包里的 `opt:` 段叶子键是
    加引号的（`'md5': 'MD5'`），`field:` 段的不是（`text: 'Input text'`）。
    """

    def leaf_name(name):
        return f"'{name}'" if quote_leaf else name

    def rec(start, end, indent, path):
        name = path[0]
        idx = _find_child(lines, start, end, indent, name)
        if idx is None:
            if len(path) == 1:
                block = [" " * indent + leaf_name(name) + ": " + value]
            else:
                # 新建一段：中间层是只有子键的映射，逐层缩进
                block = [" " * indent + name + ":"]
                depth = indent + 2
                for part in path[1:-1]:
                    block.append(" " * depth + part + ":")
                    depth += 2
                block.append(" " * depth + leaf_name(path[-1]) + ": " + value)
            # 插到容器末尾（跳过尾部空行）
            at = end
            while at > start and not lines[at - 1].strip():
                at -= 1
            lines[at:at] = block
            return True
        if len(path) == 1:
            want = " " * indent + leaf_name(name) + ": " + value
            if lines[idx] != want:
                lines[idx] = want
                return True
            return False
        child_end = _block_end(lines, idx + 1, end, indent)
        return rec(idx + 1, child_end, indent + 2, path[1:])

    return rec(start, end, indent, path)


def merge(lang, path, entries):
    """把 entries 并进某一个语言包。entries = [(路径, 英文, 中文)]。"""
    text = open(path, encoding="utf-8").read()
    lines = text.split("\n")
    changed = []
    for keypath, en, zh in entries:
        value = en if lang == "en" else zh
        top = keypath[0]
        start, end = _section(lines, top)
        quote_leaf = top in ("opt", "out")
        # field: / opt: / out: 三段的值一律加引号 —— 跟语言包里原有的写法一致
        scalar = yaml_scalar(value, force_quote=True)
        if _insert_path(lines, start, end, 2, keypath[1:], scalar, quote_leaf):
            changed.append(".".join(keypath))
    if changed:
        open(path, "w", encoding="utf-8").write("\n".join(lines))
    return changed


def main():
    check = "--check" in sys.argv
    files = sorted(f for f in os.listdir(NEWT) if f.endswith(".fields.txt"))
    if not files:
        print("没有可并入的 fields.txt")
        return 0

    entries = []
    for name in files:
        entries.extend(parse_fields(os.path.join(NEWT, name)))

    for lang, path in LOCALES:
        if check:
            before = open(path, encoding="utf-8").read()
            changed = merge(lang, path, entries)
            after = open(path, encoding="utf-8").read()
            open(path, "w", encoding="utf-8").write(before)
            if changed:
                print(f"{lang}.yml 与预期不一致：{', '.join(changed)}")
                return 1
            print(f"{lang}.yml 一致")
        else:
            changed = merge(lang, path, entries)
            print(f"{lang}.yml：写入 {len(changed)} 条 —— {', '.join(changed)}")

    print("done")
    return 0


sys.exit(main())
