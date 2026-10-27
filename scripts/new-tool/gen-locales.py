#!/usr/bin/env python3
"""从 JS 工具源码 + new-tool/i18n/<slug>.json 生成 locales/{en,zh-CN}.yml 的 ui.tool 段。

英文**从代码里读**（t() 的第二个参数），中文从新工具目录里交的 json 读 ——
英文不经过人手转录，就不会出现「代码改了、语言包没改」的漂移。

用法：
    python3 scripts/new-tool/gen-locales.py            # 写文件
    python3 scripts/new-tool/gen-locales.py --check    # 只检查不写
"""
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
TOOLS = os.path.join(ROOT, 'static/js/tools')
OUT = os.path.join(ROOT, 'new-tool', 'i18n')
LOCALES = [('en', os.path.join(ROOT, 'locales/en.yml')),
           ('zh-CN', os.path.join(ROOT, 'locales/zh-CN.yml'))]
WS = ' \t\n\r'

# 键要不要加引号的规矩放在 scripts/i18n/common.py 里 —— 两边各写一份，
# 早晚会写出不一样的两份，而 YAML 1.1 与 1.2 对 `yes` / `no` / `on` / `off`
# 的看法不一样，键名因此会变，译了也显示不出来。
sys.path.insert(0, os.path.join(ROOT, 'scripts', 'i18n'))
import common as I18N_COMMON  # noqa: E402


def read_js_string(src, at):
    """读一个 JS 单引号字符串字面量，返回 (内容, 结束位置)。与 Rust 侧同一个算法。"""
    if at >= len(src) or src[at] != "'":
        return None
    out = []
    i = at + 1
    n = len(src)
    while i < n:
        c = src[i]
        if c == '\\':
            nxt = src[i + 1] if i + 1 < n else ''
            out.append({'n': '\n', 't': '\t', 'r': '\r'}.get(nxt, nxt))
            i += 2
        elif c == "'":
            return ''.join(out), i + 1
        else:
            out.append(c)
            i += 1
    return None


def scan_text_calls(src):
    """扫出 t('key', 'English') 调用。"""
    out = []
    i = 0
    n = len(src)
    while True:
        at = src.find('t(', i)
        if at < 0:
            break
        i = at + 2
        if at > 0:
            prev = src[at - 1]
            if prev.isalnum() or prev in '_$':
                continue
        p = at + 2
        while p < n and src[p] in WS:
            p += 1
        got = read_js_string(src, p)
        if not got:
            continue
        key, p = got
        while p < n and src[p] in WS:
            p += 1
        if p >= n or src[p] != ',':
            continue
        p += 1
        while p < n and src[p] in WS:
            p += 1
        got = read_js_string(src, p)
        if not got:
            continue
        text, _ = got
        out.append((key, text))
    return out


def tool_texts():
    """slug → {key: english}"""
    result = {}
    for name in sorted(os.listdir(TOOLS)):
        if not name.endswith('.js'):
            continue
        slug = name[:-3]
        src = open(os.path.join(TOOLS, name), encoding='utf-8').read()
        entries = {}
        for key, text in scan_text_calls(src):
            if key in entries and entries[key] != text:
                raise SystemExit(f'{name}: 键 {key} 对应了两个不同的英文：{entries[key]!r} / {text!r}')
            entries[key] = text
        if entries:
            result[slug] = entries
    return result


def nested(flat):
    """{key: value} → 嵌套字典；'a.b' 变成 {'a': {'b': value}}。"""
    root = {}
    for key, value in flat.items():
        parts = key.split('.')
        node = root
        for part in parts[:-1]:
            nxt = node.setdefault(part, {})
            if not isinstance(nxt, dict):
                raise SystemExit(f'键冲突：{key} —— {part} 既是值又是命名空间')
            node = nxt
        last = parts[-1]
        if last in node:
            raise SystemExit(f'键冲突：{key}')
        node[last] = value
    return root


def yaml_scalar(value):
    """单引号标量；单引号本身要写成两个。"""
    return "'" + str(value).replace("'", "''") + "'"


def dump_block(node, indent):
    """嵌套字典 → YAML 文本行。"""
    lines = []
    pad = ' ' * indent
    for key in sorted(node):
        value = node[key]
        if isinstance(value, dict):
            lines.append(f'{pad}{I18N_COMMON.yaml_key(key)}:')
            lines.extend(dump_block(value, indent + 2))
        else:
            lines.append(f'{pad}{I18N_COMMON.yaml_key(key)}: {yaml_scalar(value)}')
    return lines


def main():
    check = '--check' in sys.argv
    texts = tool_texts()
    zh_by_slug = {}
    broken = []
    for slug, entries in texts.items():
        path = os.path.join(OUT, f'{slug}.json')
        if not os.path.exists(path):
            broken.append((slug, '没有中文表'))
            continue
        zh = json.load(open(path, encoding='utf-8'))
        absent = sorted(set(entries) - set(zh))
        extra = sorted(set(zh) - set(entries))
        if absent:
            print(f'  {slug}: 中文表缺 {absent}')
        if extra:
            print(f'  {slug}: 中文表多 {extra}')
        if absent or extra:
            broken.append((slug, '键对不上'))
            continue
        zh_by_slug[slug] = zh
    if broken:
        print(f'\n还有 {len(broken)} 个工具没准备好：{broken}')
        return 1

    # 一份扁平的 key → (英文, 中文)，en / zh 两边共用同一套键
    en_flat, zh_flat = {}, {}
    for slug, entries in texts.items():
        for key, english in entries.items():
            en_flat[f'{slug}.{key}'] = english
            zh_flat[f'{slug}.{key}'] = zh_by_slug[slug][key]

    head = ("  # JS 工具自己的界面文案。键的约定是 ui.tool.<slug>.<用途>，\n"
            "  # 前端用 ItTools.t('<slug>')('<用途>', '英文兜底') 取。")
    header_lines = set(head.split('\n'))
    for lang, path in LOCALES:
        flat = en_flat if lang == 'en' else zh_flat
        block = head + '\n  tool:\n' + '\n'.join(dump_block(nested(flat), 4)) + '\n'
        src = open(path, encoding='utf-8').read()
        lines = src.split('\n')
        # 找到 ui: 段里的 `  tool:`，一直换到下一个顶层键
        start = None
        in_ui = False
        for idx, line in enumerate(lines):
            if line == 'ui:':
                in_ui = True
                continue
            if in_ui and line == '  tool:':
                start = idx
                break
        if start is None:
            raise SystemExit(f'{path} 里找不到 ui.tool 段')
        # 生成的块自带两行说明注释，而这两行在 `  tool:` **之前** ——
        # 不把它们算进替换范围的话，每跑一次就多一份注释。
        while start > 0 and lines[start - 1] in header_lines:
            start -= 1
        end = len(lines)
        for idx in range(start + 1, len(lines)):
            line = lines[idx]
            if line and not line[0].isspace():
                end = idx
                break
        new_lines = lines[:start] + block.rstrip('\n').split('\n') + lines[end:]
        new_src = '\n'.join(new_lines)
        if check:
            if new_src != src:
                print(f'{lang}.yml 的 ui.tool 段跟生成结果不一致')
                return 1
            continue
        open(path, 'w', encoding='utf-8').write(new_src)
        print(f'{path}: 已写入 {len(texts)} 个工具的文案')
    return 0


if __name__ == '__main__':
    sys.exit(main())
