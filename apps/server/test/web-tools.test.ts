import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ToolContext, ToolDefinition } from '@witcode/protocol';
import {
  createWebTools,
  htmlToReadableText,
  isBlockedAddress,
  parseDuckDuckGo,
} from '../src/web-tools.ts';

const ctx: ToolContext = { workspace: '/tmp' };
// 公网 IP 字面量：跳过 DNS，便于用注入的 fetchImpl 做离线测试。
const PUBLIC_IP = '93.184.216.34';

function getTool(name: string): ToolDefinition {
  const found = createWebTools().find((tool) => tool.name === name);
  assert.ok(found, `找不到工具 ${name}`);
  return found;
}

const denyAllFetch: typeof fetch = () => {
  throw new Error('不应发起真实请求');
};

const ddgLookup = async (): Promise<Array<{ address: string; family: number }>> => [
  { address: PUBLIC_IP, family: 4 },
];

const DDG_FIXTURE = `
<div class="result results_links results_links_deep web-result">
  <div class="result__body">
    <h2 class="result__title">
      <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fdocs&amp;rut=abc">Example <b>Docs</b></a>
    </h2>
    <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fdocs">Read the <b>docs</b> &amp; guides.</a>
  </div>
</div>
<div class="result results_links results_links_deep web-result">
  <div class="result__body">
    <h2 class="result__title"><a class="result__a" href="https://nodejs.org/api/">Node API</a></h2>
    <a class="result__snippet">Node.js <i>API</i> reference</a>
  </div>
</div>
`;

test('工具元数据：名称、只读/低风险/可并行、描述含使用边界', () => {
  const tools = createWebTools();
  assert.deepEqual(
    tools.map((tool) => tool.name),
    ['web_fetch', 'web_search'],
  );
  for (const tool of tools) {
    assert.equal(tool.readOnly, true, tool.name);
    assert.equal(tool.riskLevel, 'low', tool.name);
    assert.equal(tool.concurrentSafe, true, tool.name);
    assert.match(tool.description, /什么时候用/, tool.name);
    assert.match(tool.description, /不用|不要/, tool.name);
    assert.match(tool.description, /本机文件/, tool.name);
  }
});

test('isBlockedAddress：覆盖私网/回环边界', () => {
  for (const address of [
    '127.0.0.1',
    '10.0.0.1',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254',
    '0.0.0.0',
    '::1',
    '::',
    '::ffff:127.0.0.1',
    'fe80::1',
    'fd00::1',
  ]) {
    assert.equal(isBlockedAddress(address), true, address);
  }
  assert.equal(isBlockedAddress('172.32.0.1'), false);
  assert.equal(isBlockedAddress(PUBLIC_IP), false);
});

test('web_fetch：拒绝 localhost / 私网 / IPv6 回环字面量（不发请求）', async () => {
  const tool = createWebTools({ fetchImpl: denyAllFetch }).find((t) => t.name === 'web_fetch')!;
  const urls = [
    'http://localhost/',
    'http://foo.localhost/',
    'http://127.0.0.1/',
    'http://10.1.2.3/',
    'http://172.16.0.1/',
    'http://192.168.1.1/',
    'http://169.254.169.254/latest/meta-data',
    'http://0.0.0.0/',
    'http://[::1]/',
    'http://[::ffff:127.0.0.1]/',
  ];
  for (const url of urls) {
    const result = await tool.execute({ url }, ctx);
    assert.equal(result.ok, false, url);
    assert.match(result.error ?? '', /禁止|拒绝/, url);
  }
});

test('web_fetch：拒绝非 http/https 协议', async () => {
  const tool = createWebTools({ fetchImpl: denyAllFetch }).find((t) => t.name === 'web_fetch')!;
  for (const url of ['file:///etc/passwd', 'ftp://example.com/x', 'data:text/plain,hello']) {
    const result = await tool.execute({ url }, ctx);
    assert.equal(result.ok, false, url);
    assert.match(result.error ?? '', /仅允许 http\/https/, url);
  }
});

test('web_fetch：DNS 解析到私网地址时拒绝访问', async () => {
  const lookupImpl = async (): Promise<Array<{ address: string; family: number }>> => [
    { address: '10.2.3.4', family: 4 },
  ];
  const tool = createWebTools({ fetchImpl: denyAllFetch, lookupImpl }).find(
    (t) => t.name === 'web_fetch',
  )!;
  const result = await tool.execute({ url: 'http://public.example/page' }, ctx);
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /DNS.*私网/);
});

test('web_fetch：DNS 解析失败时按 fail-closed 拒绝', async () => {
  const lookupImpl = async (): Promise<Array<{ address: string; family: number }>> => {
    throw new Error('ENOTFOUND');
  };
  const tool = createWebTools({ fetchImpl: denyAllFetch, lookupImpl }).find(
    (t) => t.name === 'web_fetch',
  )!;
  const result = await tool.execute({ url: 'http://missing.example/page' }, ctx);
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /DNS/);
});

test('web_fetch：请求超时返回 ok:false', async () => {
  const fetchImpl: typeof fetch = (_input, init) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
    });
  const tool = createWebTools({ fetchImpl, timeoutMs: 20 }).find((t) => t.name === 'web_fetch')!;
  const result = await tool.execute({ url: `http://${PUBLIC_IP}/slow` }, ctx);
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /超时/);
});

test('web_fetch：按 maxBytes 截断响应体', async () => {
  const fetchImpl: typeof fetch = async () =>
    new Response('A'.repeat(5000), { headers: { 'content-type': 'text/plain' } });
  const tool = createWebTools({ fetchImpl, maxBytes: 100 }).find((t) => t.name === 'web_fetch')!;
  const result = await tool.execute({ url: `http://${PUBLIC_IP}/big` }, ctx);
  assert.equal(result.ok, true);
  const body = result.content.split('\n\n')[1];
  assert.equal(body.length, 100);
  assert.match(result.content, /^\(无标题\)\nhttp:/);
});

test('web_fetch：HTML 转为可读文本（标题/段落/列表，去脚本与实体解码）', async () => {
  const html = [
    '<!doctype html><html><head>',
    '<title>Hello &amp; World</title>',
    '<style>.x { color: red; }</style>',
    '</head><body>',
    '<p>First <b>paragraph</b>.</p>',
    '<ul><li>One</li><li>Two</li></ul>',
    '<script>alert(1)</script>',
    '</body></html>',
  ].join('');
  const fetchImpl: typeof fetch = async () =>
    new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } });
  const tool = createWebTools({ fetchImpl }).find((t) => t.name === 'web_fetch')!;
  const result = await tool.execute({ url: `http://${PUBLIC_IP}/page` }, ctx);
  assert.equal(result.ok, true);
  assert.match(result.content, /^Hello & World\nhttp:/);
  assert.match(result.content, /First paragraph\./);
  assert.match(result.content, /- One\n- Two$/);
  assert.doesNotMatch(result.content, /alert\(1\)|color: red/);
});

test('htmlToReadableText：保留标题与列表并解码基础实体', () => {
  const parsed = htmlToReadableText(
    '<title>A &quot;B&quot; &#39;C&#39;</title><p>x&nbsp;y</p><ol><li>&lt;tag&gt;</li></ol>',
  );
  assert.equal(parsed.title, 'A "B" \'C\'');
  assert.equal(parsed.text, 'x y\n- <tag>');
});

test('fetchImpl 注入：公网地址正常抓取且不发起真实请求', async () => {
  let calls = 0;
  const fetchImpl: typeof fetch = async (input) => {
    calls += 1;
    assert.equal(String(input), `http://${PUBLIC_IP}/ok`);
    return new Response('plain text body', { headers: { 'content-type': 'text/plain' } });
  };
  const tool = createWebTools({ fetchImpl }).find((t) => t.name === 'web_fetch')!;
  const result = await tool.execute({ url: `http://${PUBLIC_IP}/ok` }, ctx);
  assert.equal(result.ok, true);
  assert.equal(calls, 1);
  assert.match(result.content, /plain text body/);
});

test('parseDuckDuckGo：解析标题/链接/摘要并解码 uddg 跳转链接', () => {
  const results = parseDuckDuckGo(DDG_FIXTURE);
  assert.equal(results.length, 2);
  assert.equal(results[0].title, 'Example Docs');
  assert.equal(results[0].url, 'https://example.com/docs');
  assert.equal(results[0].snippet, 'Read the docs & guides.');
  assert.equal(results[1].title, 'Node API');
  assert.equal(results[1].url, 'https://nodejs.org/api/');
  assert.equal(results[1].snippet, 'Node.js API reference');
});

test('web_search：用注入的 fetch 返回编号列表，respect limit', async () => {
  const fetchImpl: typeof fetch = async (input) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    assert.equal(url.hostname, 'html.duckduckgo.com');
    assert.equal(url.searchParams.get('q'), 'hello world');
    return new Response(DDG_FIXTURE, { headers: { 'content-type': 'text/html' } });
  };
  const tool = createWebTools({ fetchImpl, lookupImpl: ddgLookup }).find(
    (t) => t.name === 'web_search',
  )!;
  const result = await tool.execute({ query: 'hello world', limit: 1 }, ctx);
  assert.equal(result.ok, true);
  assert.match(result.content, /^1\. Example Docs/);
  assert.match(result.content, /https:\/\/example\.com\/docs/);
  assert.doesNotMatch(result.content, /Node API/);
});

test('web_search：失败时返回 ok:false 并提示改用 web_fetch', async () => {
  const fetchImpl: typeof fetch = async () => {
    throw new Error('network down');
  };
  const tool = createWebTools({ fetchImpl, lookupImpl: ddgLookup }).find(
    (t) => t.name === 'web_search',
  )!;
  const result = await tool.execute({ query: 'anything' }, ctx);
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /web_fetch/);
});

test('web_fetch：重定向每一跳都重新校验（本地 http server）', async () => {
  const server = createServer((req, res) => {
    if (req.url === '/start') {
      res.writeHead(302, { location: '/final' });
      res.end();
    } else if (req.url === '/final') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<title>Redirected</title><p>arrived</p>');
    } else if (req.url === '/to-private') {
      res.writeHead(302, { location: 'http://127.0.0.1:9/secret' });
      res.end();
    } else if (req.url === '/loop') {
      res.writeHead(302, { location: '/loop' });
      res.end();
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;

  // 把公网字面量请求改写到本地 server；web_fetch 侧仍按原 URL 做安全校验。
  const rewriteFetch: typeof fetch = (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    url.host = `127.0.0.1:${port}`;
    return globalThis.fetch(url, init);
  };

  try {
    const tools = createWebTools({ fetchImpl: rewriteFetch });
    const fetchTool = tools.find((t) => t.name === 'web_fetch')!;

    const ok = await fetchTool.execute({ url: `http://${PUBLIC_IP}/start` }, ctx);
    assert.equal(ok.ok, true);
    assert.match(ok.content, /^Redirected\nhttp:/);
    assert.match(ok.content, /arrived$/);

    const blocked = await fetchTool.execute({ url: `http://${PUBLIC_IP}/to-private` }, ctx);
    assert.equal(blocked.ok, false);
    assert.match(blocked.error ?? '', /禁止|拒绝/);

    const loop = await fetchTool.execute({ url: `http://${PUBLIC_IP}/loop` }, ctx);
    assert.equal(loop.ok, false);
    assert.match(loop.error ?? '', /重定向/);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
