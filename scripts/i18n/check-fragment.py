#!/usr/bin/env python3
"""核对翻译片段：键对不对、占位符在不在、值空没空。

翻译是并行做的，写完得有人验 —— 这个脚本就是那个「人」。

用法：
    python3 scripts/i18n/check-fragment.py --lang de --batch 01
    python3 scripts/i18n/check-fragment.py --lang de          # 全部批次
"""
import argparse
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common as C  # noqa: E402

WORK_DIR = os.path.join(C.SRC_DIR, 'work')
PLACEHOLDER = re.compile(r'\{[a-zA-Z0-9_]+\}')


def work_orders():
    """batch-NN.json -> {slug: {键: 英文}}"""
    out = {}
    for name in sorted(os.listdir(WORK_DIR)):
        if not (name.startswith('batch-') and name.endswith('.json')):
            continue
        with open(os.path.join(WORK_DIR, name), encoding='utf-8') as fh:
            data = json.load(fh)
        for tool in data['tools']:
            out[tool['slug']] = tool['keys']
    return out


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--lang', required=True)
    parser.add_argument('--batch', help='只看这一批（batch-01）')
    args = parser.parse_args()

    orders = work_orders()
    if args.batch:
        name = args.batch if args.batch.startswith('batch-') else f'batch-{args.batch}'
        with open(os.path.join(WORK_DIR, f'{name}.json'), encoding='utf-8') as fh:
            data = json.load(fh)
        slugs = [t['slug'] for t in data['tools']]
    else:
        slugs = sorted(orders)

    problems = []
    for slug in slugs:
        path = os.path.join(C.SRC_DIR, args.lang, f'{slug}.json')
        if not os.path.exists(path):
            problems.append(f'{args.lang}/{slug}.json 还没有')
            continue
        try:
            with open(path, encoding='utf-8') as fh:
                frag = json.load(fh)
        except json.JSONDecodeError as e:
            problems.append(f'{args.lang}/{slug}.json 不是合法 JSON：{e}')
            continue
        want = orders.get(slug, {})
        have = set(frag)
        need = set(want)
        for key in sorted(need - have):
            problems.append(f'{args.lang}/{slug}.json 少了 {key}（英文: {want[key]!r}）')
        for key in sorted(have - need):
            problems.append(f'{args.lang}/{slug}.json 多了 {key}（英文语言包里没有这个键）')
        for key in sorted(need & have):
            value = frag[key]
            if not isinstance(value, str) or not value.strip():
                problems.append(f'{args.lang}/{slug}.json 的 {key} 是空的')
                continue
            want_ph = sorted(PLACEHOLDER.findall(want[key]))
            have_ph = sorted(PLACEHOLDER.findall(value))
            if want_ph != have_ph:
                problems.append(
                    f'{args.lang}/{slug}.json 的 {key} 占位符对不上：'
                    f'英文 {want_ph}，译文 {have_ph}'
                )

    if problems:
        print(f'{args.lang}: {len(problems)} 处问题')
        for p in problems:
            print(f'  {p}')
        return 1
    print(f'{args.lang}: {len(slugs)} 个工具的片段都对得上')
    return 0


if __name__ == '__main__':
    sys.exit(main())
