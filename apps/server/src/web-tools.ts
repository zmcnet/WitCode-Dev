/**
 * 公开网页抓取 / 搜索工具。
 *
 * 安全边界：只访问 http/https 的公网地址；域名先经 DNS 解析，逐条 IP 做
 * SSRF 检查（回环、私网、链路本地、IPv4 映射 IPv6 一律拒绝）。重定向采用
 * 手动跟随，每一跳都重新走同一套校验，最多 5 跳。不读取任何本机文件。
 */

import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { ToolContext, ToolDefinition, ToolResult } from '@witcode/protocol';

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_BYTES = 1_000_000;
const MAX_REDIRECTS = 5;
const MAX_BODY_CHARS = 20_000;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

type LookupFn = (
  hostname: string,
  options: { all: true },
) => Promise<Array<{ address: string; family: number }>>;

export interface WebToolsOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxBytes?: number;
  /** 仅测试注入：默认使用 node:dns/promises.lookup，便于验证 DNS 解析后的 SSRF 拦截。 */
  lookupImpl?: LookupFn;
}

export interface DuckDuckGoResult {
  title: string;
  url: string;
  snippet: string;
}

function fail(error: string): ToolResult {
  return { ok: false, content: '', error };
}

/** 判断单个 IP（v4/v6）是否属于禁止访问的地址段。 */
export function isBlockedAddress(address: string): boolean {
  const value = address.trim().toLowerCase().replace(/^\[|\]$/g, '');

  // ::ffff:127.0.0.1 这类 IPv4 映射地址，提取出 v4 再判一次。
  // WHATWG URL 会把点分形式规范化成十六进制（::ffff:7f00:1），两种都要覆盖。
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(value);
  if (mapped) return isBlockedAddress(mapped[1] ?? '');
  const mappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(value);
  if (mappedHex) {
    const high = Number.parseInt(mappedHex[1] ?? '', 16);
    const low = Number.parseInt(mappedHex[2] ?? '', 16);
    return isBlockedAddress(
      `${(high >> 8) & 0xff}.${high & 0xff}.${(low >> 8) & 0xff}.${low & 0xff}`,
    );
  }

  if (value.includes('.')) {
    const parts = value.split('.');
    if (parts.length !== 4) return true;
    const nums = parts.map(Number);
    if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
    const [a = -1, b = -1] = nums;
    if (a === 0) return true; // 0.0.0.0/8（含 0.0.0.0）
    if (a === 10) return true; // 10/8
    if (a === 127) return true; // 127/8
    if (a === 169 && b === 254) return true; // 169.254/16
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
    if (a === 192 && b === 168) return true; // 192.168/16
    return false;
  }

  if (value === '::1' || value === '::') return true;
  // fe80::/10 链路本地、fc00::/7 唯一本地地址。
  if (/^fe[89ab]/.test(value)) return true;
  if (/^f[cd]/.test(value)) return true;
  return false;
}

/** 校验并解析 URL；非 http(s)、本机名、私网地址（含 DNS 结果）一律拒绝。 */
export async function validateHttpUrl(raw: string, lookupFn: LookupFn): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('url 无效');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('仅允许 http/https 协议');
  }

  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '');
  if (host === 'localhost' || host.endsWith('.localhost')) {
    throw new Error('禁止访问 localhost');
  }

  if (isIP(host) !== 0) {
    if (isBlockedAddress(host)) throw new Error('禁止访问回环/私网地址');
    return url;
  }

  let addresses: Array<{ address: string; family: number }>;
  try {
    addresses = await lookupFn(host, { all: true });
  } catch {
    // 解析失败按 fail-closed 处理。
    throw new Error('DNS 解析失败，拒绝访问');
  }
  if (!Array.isArray(addresses) || addresses.length === 0) {
    throw new Error('DNS 无解析结果，拒绝访问');
  }
  for (const entry of addresses) {
    if (isBlockedAddress(entry.address)) {
      throw new Error('DNS 解析到回环/私网地址，拒绝访问');
    }
  }
  return url;
}

function createDeadline(timeoutMs: number, external?: AbortSignal) {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const onAbort = () => controller.abort();
  if (external) {
    if (external.aborted) controller.abort();
    else external.addEventListener('abort', onAbort, { once: true });
  }
  return {
    signal: controller.signal,
    isTimeout: () => timedOut,
    dispose: () => {
      clearTimeout(timer);
      external?.removeEventListener('abort', onAbort);
    },
  };
}

/** 按字节上限读取响应体，超限即取消流。 */
async function readLimited(res: Response, maxBytes: number): Promise<Uint8Array> {
  const reader = res.body?.getReader();
  if (!reader) {
    const buffer = new Uint8Array(await res.arrayBuffer());
    return buffer.subarray(0, maxBytes);
  }

  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      const remaining = maxBytes - total;
      const chunk = value.byteLength > remaining ? value.subarray(0, remaining) : value;
      chunks.push(chunk);
      total += chunk.byteLength;
      if (chunk.byteLength < value.byteLength) break;
    }
  } finally {
    if (total >= maxBytes) void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }

  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

interface FetchedPage {
  url: URL;
  contentType: string;
  text: string;
}

/** 手动跟随重定向；每一跳（含首跳）都重新校验 URL。 */
async function fetchPage(
  rawUrl: string,
  fetchImpl: typeof fetch,
  lookupFn: LookupFn,
  maxBytes: number,
  signal: AbortSignal,
): Promise<FetchedPage> {
  let current = await validateHttpUrl(rawUrl, lookupFn);

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const res = await fetchImpl(current.href, { redirect: 'manual', signal });
    if (REDIRECT_STATUSES.has(res.status)) {
      const location = res.headers.get('location');
      if (res.body) void res.body.cancel().catch(() => undefined);
      if (!location) throw new Error('重定向响应缺少 Location');
      if (hop === MAX_REDIRECTS) throw new Error('重定向超过 5 跳，已停止');
      current = await validateHttpUrl(new URL(location, current).href, lookupFn);
      continue;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const bytes = await readLimited(res, maxBytes);
    return {
      url: current,
      contentType: res.headers.get('content-type') ?? '',
      text: new TextDecoder('utf-8').decode(bytes),
    };
  }
  throw new Error('重定向超过 5 跳，已停止');
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  mdash: '—',
  ndash: '–',
  hellip: '…',
  copy: '©',
  reg: '®',
  trade: '™',
};

function decodeEntities(input: string): string {
  return input.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (full, token: string) => {
    if (token.startsWith('#')) {
      const hex = token[1]?.toLowerCase() === 'x';
      const code = hex
        ? Number.parseInt(token.slice(2), 16)
        : Number.parseInt(token.slice(1), 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return full;
      try {
        return String.fromCodePoint(code);
      } catch {
        return full;
      }
    }
    return NAMED_ENTITIES[token.toLowerCase()] ?? full;
  });
}

function cleanText(input: string): string {
  return decodeEntities(input.replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();
}

/** HTML 转成可读文本：保留标题、段落与列表，去掉脚本/样式与标签。 */
export function htmlToReadableText(html: string): { title: string; text: string } {
  let source = html.replace(/<!--[\s\S]*?-->/g, '');
  source = source.replace(
    /<(script|style|noscript|svg)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,
    '',
  );

  const titleMatch = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(source);
  const title = titleMatch ? cleanText(titleMatch[1] ?? '') : '';

  // 正文里排除 head/title，避免标题重复出现在正文中。
  let body = source
    .replace(/<head\b[^>]*>[\s\S]*?<\/head\s*>/gi, '')
    .replace(/<title\b[^>]*>[\s\S]*?<\/\s*title\s*>/gi, '')
    .replace(
      /<\/(p|div|li|ul|ol|h[1-6]|tr|table|section|article|header|footer|blockquote|pre)\s*>/gi,
      '\n',
    );
  body = body.replace(/<br\s*\/?\s*>/gi, '\n');
  body = body.replace(/<li\b[^>]*>/gi, '- ');
  body = body.replace(/<[^>]+>/g, '');
  body = decodeEntities(body);

  const lines = body
    .split('\n')
    .map((line) => line.replace(/[ \t\u00a0]+/g, ' ').trim())
    .filter(Boolean);
  return { title, text: lines.join('\n') };
}

function getAttr(attrs: string, name: string): string | undefined {
  const match = new RegExp(
    `\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`,
    'i',
  ).exec(attrs);
  return match ? (match[1] ?? match[2] ?? match[3]) : undefined;
}

function normalizeDuckDuckGoUrl(raw: string): string {
  let href = decodeEntities(raw).trim();
  if (!href) return '';
  if (href.startsWith('//')) href = `https:${href}`;
  try {
    const parsed = new URL(href, 'https://duckduckgo.com');
    const uddg = parsed.searchParams.get('uddg');
    if (uddg) return uddg;
    if (parsed.hostname === 'duckduckgo.com' && parsed.pathname === '/l/') return '';
    return parsed.toString();
  } catch {
    return href;
  }
}

function findSnippet(chunk: string): string {
  const elementRe = /<(a|div|span)\b([^>]*)>([\s\S]*?)<\/\1\s*>/gi;
  let match: RegExpExecArray | null;
  while ((match = elementRe.exec(chunk)) !== null) {
    const className = getAttr(match[2] ?? '', 'class') ?? '';
    if (/(^|\s)result__snippet(\s|$)/.test(className)) {
      return cleanText(match[3] ?? '');
    }
  }
  return '';
}

/** 解析 DuckDuckGo HTML 搜索结果页（纯函数，便于测试）。 */
export function parseDuckDuckGo(html: string): DuckDuckGoResult[] {
  const results: DuckDuckGoResult[] = [];
  const anchorRe = /<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi;
  let match: RegExpExecArray | null;

  while ((match = anchorRe.exec(html)) !== null) {
    const className = getAttr(match[1] ?? '', 'class') ?? '';
    if (!/(^|\s)result__a(\s|$)/.test(className)) continue;

    const title = cleanText(match[2] ?? '');
    const url = normalizeDuckDuckGoUrl(getAttr(match[1] ?? '', 'href') ?? '');
    if (!title || !url) continue;

    const end = match.index + match[0].length;
    const snippet = findSnippet(html.slice(end, end + 4000));
    results.push({ title, url, snippet });
  }
  return results;
}

function parseArgs(input: unknown): Record<string, unknown> {
  return input !== null && typeof input === 'object'
    ? (input as Record<string, unknown>)
    : {};
}

export function createWebTools(options: WebToolsOptions = {}): ToolDefinition[] {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const lookupFn: LookupFn =
    options.lookupImpl ?? ((hostname) => dnsLookup(hostname, { all: true }));
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;

  const webFetch: ToolDefinition = {
    name: 'web_fetch',
    description: [
      '抓取公开网页并转成可读文本，返回「标题 / URL / 正文」。',
      '什么时候用：已知 URL，需要读取网页正文、文档或文本接口返回。',
      '什么时候不用：访问本机、localhost、私网或回环地址（一律拒绝，本工具不会读取本机文件）；',
      '需要登录、交互或执行 JavaScript 的页面；下载大文件；只想找链接而不是读正文（用 web_search）。',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: '要抓取的公开 http/https URL',
        },
      },
      required: ['url'],
    },
    readOnly: true,
    destructive: false,
    riskLevel: 'low',
    concurrentSafe: true,
    async execute(input: unknown, ctx: ToolContext): Promise<ToolResult> {
      const args = parseArgs(input);
      const rawUrl = typeof args.url === 'string' ? args.url.trim() : '';
      if (!rawUrl) return fail('url 不能为空');

      const deadline = createDeadline(timeoutMs, ctx?.signal);
      try {
        const page = await fetchPage(rawUrl, fetchImpl, lookupFn, maxBytes, deadline.signal);
        const isHtml = /html|xhtml|xml/i.test(page.contentType) ||
          /<\s*(html|!doctype html)\b/i.test(page.text.slice(0, 2048));
        const parsed = isHtml ? htmlToReadableText(page.text) : { title: '', text: page.text };
        // HTML 已转成可读文本；非 HTML 原样保留，只做字节/字符截断。
        const body = parsed.text.slice(0, MAX_BODY_CHARS);
        const title = parsed.title || '(无标题)';
        return { ok: true, content: `${title}\n${page.url.href}\n\n${body}` };
      } catch (error) {
        if (deadline.isTimeout()) return fail('请求超时');
        return fail(error instanceof Error ? error.message : String(error));
      } finally {
        deadline.dispose();
      }
    },
  };

  const webSearch: ToolDefinition = {
    name: 'web_search',
    description: [
      '通过 DuckDuckGo 搜索公开网页，返回编号的标题、URL 与摘要。',
      '什么时候用：不知道具体 URL，需要找资料、页面链接或概览。',
      '什么时候不用：搜索本机文件或内网内容（本工具不会读取本机文件）；需要登录的站点；',
      '已知 URL 且要读正文时用 web_fetch；搜索失败时也可改用 web_fetch 直接抓取目标页面。',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: '搜索关键词',
        },
        limit: {
          type: 'number',
          description: '返回条数，1..10，默认 5',
          minimum: 1,
          maximum: 10,
        },
      },
      required: ['query'],
    },
    readOnly: true,
    destructive: false,
    riskLevel: 'low',
    concurrentSafe: true,
    async execute(input: unknown, ctx: ToolContext): Promise<ToolResult> {
      const args = parseArgs(input);
      const query = typeof args.query === 'string' ? args.query.trim() : '';
      if (!query) return fail('query 不能为空');

      const limit =
        typeof args.limit === 'number' && Number.isFinite(args.limit)
          ? Math.min(10, Math.max(1, Math.trunc(args.limit)))
          : 5;

      const url = new URL('https://html.duckduckgo.com/html/');
      url.searchParams.set('q', query);

      const deadline = createDeadline(timeoutMs, ctx?.signal);
      try {
        const page = await fetchPage(url.href, fetchImpl, lookupFn, maxBytes, deadline.signal);
        const results = parseDuckDuckGo(page.text).slice(0, limit);
        if (results.length === 0) return { ok: true, content: '未找到搜索结果。' };
        const content = results
          .map(
            (item, index) =>
              `${index + 1}. ${item.title}\n   ${item.url}${item.snippet ? `\n   ${item.snippet}` : ''}`,
          )
          .join('\n\n');
        return { ok: true, content };
      } catch (error) {
        if (deadline.isTimeout()) {
          return fail('搜索请求超时；可改用 web_fetch 抓取已知页面。');
        }
        const detail = error instanceof Error ? error.message : String(error);
        return fail(`搜索失败：${detail}。可改用 web_fetch 直接抓取目标页面。`);
      } finally {
        deadline.dispose();
      }
    },
  };

  return [webFetch, webSearch];
}
