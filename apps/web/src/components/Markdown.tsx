/**
 * 助手消息的 Markdown 渲染。
 *
 * 模型输出不可信：先 marked 解析，再 DOMPurify 消毒。
 * 代码块带语言标签和复制按钮，对齐 ZCode 的代码块外观。
 */
import { useMemo } from 'react';
import type { MouseEvent } from 'react';
import DOMPurify from 'dompurify';
import { marked } from 'marked';

function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

const renderer = new marked.Renderer();

renderer.code = ({ text, lang }) => {
  const language = (lang ?? '').trim().split(/\s+/)[0] || 'text';
  return [
    '<div class="md-code">',
    `<div class="md-code-head"><span>${escapeHtml(language)}</span>`,
    '<button class="md-copy" type="button">复制</button></div>',
    `<pre><code>${escapeHtml(text)}</code></pre>`,
    '</div>',
  ].join('');
};

let hooksInstalled = false;
function installHooks() {
  if (hooksInstalled) return;
  hooksInstalled = true;
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    if (node.tagName === 'A') {
      node.setAttribute('target', '_blank');
      node.setAttribute('rel', 'noopener noreferrer');
    }
  });
}

export function Markdown({ text }: { text: string }) {
  installHooks();
  const html = useMemo(() => {
    const raw = marked.parse(text, { async: false, gfm: true, breaks: true, renderer });
    return DOMPurify.sanitize(raw, { USE_PROFILES: { html: true } });
  }, [text]);

  const onClick = (event: MouseEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement | null;
    const button = target?.closest('.md-copy');
    if (!button) return;
    const code = button.closest('.md-code')?.querySelector('pre code')?.textContent ?? '';
    void navigator.clipboard?.writeText(code);
    button.textContent = '已复制';
    window.setTimeout(() => {
      button.textContent = '复制';
    }, 1200);
  };

  return (
    <div
      className="md-body"
      onClick={onClick}
      // 内容已通过 DOMPurify 消毒。
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
