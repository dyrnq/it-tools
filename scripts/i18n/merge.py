#!/usr/bin/env python3
"""把翻译片段并进 `locales/<code>.yml`。

翻译片段是**暂存区**里的 json，一个文件一个工具（`new-tool/i18n/<code>/<slug>.json`），
键是完整的点号键：

    {
      "ui.tool.case-converter.input": "Eingabe",
      "tools.case-converter.title": "Groß-/Kleinschreibung"
    }

合并是**增量**的：语言包里已有的键原样留着，片段里的键覆盖上去。
所以一批一批地译不会把前面译好的弄丢。

片段合并完就可以删掉了 —— 真正入库的是 `locales/<code>.yml`，
跟 `locales/{en,zh-CN}.yml` 一样是语言包本身。

用法：
    python3 scripts/i18n/merge.py                 # 合并全部语言
    python3 scripts/i18n/merge.py --lang de       # 只合并德语
    python3 scripts/i18n/merge.py --rebuild       # 丢弃旧文件，只按片段重建
    python3 scripts/i18n/merge.py --check         # 只检查不写
    python3 scripts/i18n/merge.py --coverage      # 看每个语言的覆盖率
    python3 scripts/i18n/merge.py --missing de    # 看德语还差哪些键
"""
import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common as C  # noqa: E402

# 语言包里每条键的归属：顶层段 -> 该段的总键数（算覆盖率用）
SECTION_ORDER = C.SECTIONS

HEADER = """\
{lang} 语言包。

英文从 `locales/en.yml` 来，这个文件是同结构的其他语言。
键没译到的会**逐条**回退到英文（见 src/i18n.rs 的 t()），
所以这个文件可以只写一部分 —— 缺的那条显示英文，不会露出键名。

由 scripts/i18n/merge.py 从 new-tool/i18n/{lang}/ 下的翻译片段合并而成。
"""


def fragments(lang):
    """读某个语言的翻译片段：{点号键: 译文}。"""
    directory = os.path.join(C.SRC_DIR, lang)
    out = {}
    if not os.path.isdir(directory):
        return out
    for name in sorted(os.listdir(directory)):
        if not name.endswith('.json'):
            continue
        path = os.path.join(directory, name)
        try:
            with open(path, encoding='utf-8') as fh:
                data = json.load(fh)
        except json.JSONDecodeError as e:
            raise SystemExit(f'{path} 不是合法的 JSON：{e}') from e
        if not isinstance(data, dict):
            raise SystemExit(f'{path} 不是对象')
        for key, value in data.items():
            if key in out and out[key] != value:
                raise SystemExit(f'{path}: 键 {key} 跟别的片段对不上')
            out[key] = value
    return out


def managed_languages():
    """这个脚本管的语言：`new-tool/i18n/` 下有目录的。

    中文包**不归这里管** —— 它的来源是 `new-tool/i18n/<slug>.json`（每个工具一份），
    由 `gen-locales.py` 并进语言包的 `ui.tool` 段，语言包其余部分是手工维护的。
    两个脚本抢同一个文件会互相覆盖，分工得清楚。
    英文包同理：它就是事实来源。
    """
    out = []
    for code, _ in C.available_languages():
        if code == 'en':
            continue
        if os.path.isdir(os.path.join(C.SRC_DIR, code)):
            out.append(code)
    return out


def section_of(key):
    return key.split('.', 1)[0]


def coverage(en, flat):
    """按顶层段统计：英文一共多少键、这个语言译了多少。"""
    total, done = {}, {}
    for key in en:
        sec = section_of(key)
        total[sec] = total.get(sec, 0) + 1
        if key in flat:
            done[sec] = done.get(sec, 0) + 1
    return total, done


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--lang', action='append', help='只处理这个语言（可重复）')
    parser.add_argument(
        '--rebuild',
        action='store_true',
        help='丢弃现有的语言包，只按片段重建（键名改过时用）',
    )
    parser.add_argument('--check', action='store_true', help='只检查不写')
    parser.add_argument('--coverage', action='store_true', help='打印覆盖率')
    parser.add_argument('--missing', help='列出这个语言还差哪些键')
    args = parser.parse_args()

    en = C.load_locale('en')
    if not en:
        raise SystemExit('locales/en.yml 是空的或读不了')

    languages = args.lang or managed_languages()
    if args.lang:
        unknown = [l for l in args.lang if l not in managed_languages()]
        if unknown:
            raise SystemExit(
                f'{", ".join(unknown)} 不归这个脚本管 —— '
                '中文包由 gen-locales.py 管（它的来源是 new-tool/i18n/<slug>.json），'
                '英文包是手工维护的。'
            )

    for lang in languages:
        # 重建时**不看**现有的语言包 —— 否则改过键名的旧条目会赖在那儿，
        # 新的键又加上去，一份语言包里同时有两种写法的同一个键。
        base = {} if args.rebuild else dict(C.load_locale(lang))
        frag = fragments(lang)

        # 片段里的键必须是真的键 —— 拼错一个字母，页面上就会露出键名
        unknown = sorted(k for k in frag if k not in en)
        if unknown:
            print(f'{lang}: 片段里有 {len(unknown)} 个键在英文语言包里不存在：')
            for key in unknown[:20]:
                print(f'  {key}')
            if len(unknown) > 20:
                print(f'  …… 还有 {len(unknown) - 20} 个')
            return 1
        empty = sorted(k for k, v in frag.items() if not str(v).strip())
        if empty:
            print(f'{lang}: 片段里有 {len(empty)} 个空译文：{empty[:10]}')
            return 1

        merged = dict(base)
        merged.update(frag)

        total, done = coverage(en, merged)
        pct = sum(done.values()) / sum(total.values()) * 100
        if args.coverage:
            print(f'{lang}: {sum(done.values())}/{sum(total.values())} 键（{pct:.1f}%）')
            for sec in SECTION_ORDER:
                if total.get(sec):
                    print(f'    {sec:8} {done.get(sec, 0):5}/{total[sec]:<5}')

        if args.missing:
            missing = sorted(k for k in en if k not in merged)
            print(f'{lang}: 还差 {len(missing)} 条')
            for key in missing:
                print(f'  {key}')
            continue

        if not args.check and not args.coverage:
            text = C.dump_locale(merged, HEADER.format(lang=lang))
            path = os.path.join(C.LOCALES_DIR, f'{lang}.yml')
            with open(path, 'w', encoding='utf-8') as fh:
                fh.write(text)
            print(f'{path}: 已写入 {len(merged)} 条（{pct:.1f}%）')

        if args.check:
            text = C.dump_locale(merged, HEADER.format(lang=lang))
            path = os.path.join(C.LOCALES_DIR, f'{lang}.yml')
            current = open(path, encoding='utf-8').read() if os.path.exists(path) else ''
            if current != text:
                print(f'{lang}.yml 跟合并结果不一致')
                return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
