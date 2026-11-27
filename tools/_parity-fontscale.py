"""One-shot mechanical transform: scale UI text font sizes by --font-scale.

Decorative glyph/icon/dot/ring sizes are intentionally left untouched.
"""
import re

PATH = 'apps/web/src/styles.css'
SKIP = (
    'glyph', 'chev', 'icon', 'mark', 'watermark', 'dot', 'ring', 'check',
    'plus', 'topbar-menu', 'tool-btn', 'session-more', 'send-btn', 'topbar-sep',
    'error-banner button', ':root',
)

lines = open(PATH, encoding='utf-8').read().split('\n')
changed = []
for i, line in enumerate(lines):
    m = re.search(r'(font-size:\s*)(\d+(?:\.\d+)?)px(\s*;)', line)
    if not m:
        continue
    selector = ''
    j = i - 1
    while j >= 0 and '{' not in lines[j]:
        j -= 1
    if j >= 0:
        selector = lines[j].split('{')[0].strip()
        k = j - 1
        while k >= 0 and lines[k].strip() and '{' not in lines[k] and '}' not in lines[k]:
            selector = lines[k].strip() + ' ' + selector
            k -= 1
    if any(token in selector.lower() for token in SKIP):
        continue
    value = m.group(2)
    lines[i] = line[:m.start(2)] + f'calc({value}px * var(--font-scale, 1))' + line[m.end(2):]
    changed.append((i + 1, value, selector[:80]))

open(PATH, 'w', encoding='utf-8', newline='\n').write('\n'.join(lines))
print(f'converted {len(changed)} declarations')
for line_no, value, selector in changed:
    print(f'  {line_no:5d} {value:6s} {selector}')
