export function normalizeEndpoint(input: string): string {
  const url = new URL(input);
  if (url.username || url.password || url.search || url.hash)
    throw new Error('地址中不能包含凭证、查询参数或片段');
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (
    !['https:', 'wss:'].includes(url.protocol) &&
    !(local && ['http:', 'ws:'].includes(url.protocol))
  )
    throw new Error('远程 Agent 必须使用 HTTPS；本地可使用 HTTP');
  url.protocol = ['https:', 'wss:'].includes(url.protocol) ? 'wss:' : 'ws:';
  const pathname = url.pathname.replace(/\/$/, '');
  url.pathname = pathname.endsWith('/browser-control/ws')
    ? pathname
    : pathname + '/browser-control/ws';
  return url.href;
}
