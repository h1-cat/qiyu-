const http = require('http');
function getJson(url) { return new Promise((resolve, reject) => { http.get(url, (r) => { let d=''; r.on('data',c=>d+=c); r.on('end',()=>resolve(JSON.parse(d))); }).on('error', reject); }); }
(async () => {
  const tabs = await getJson('http://127.0.0.1:9222/json');
  const tab = tabs.find((t) => t.type === 'page' && t.url.includes('onsite/monitor'));
  if (!tab) { console.log('no tab'); return; }
  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  let id = 0; const pending = new Map();
  ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
  const send = (method, params) => new Promise((resolve) => { const mid = ++id; pending.set(mid, resolve); ws.send(JSON.stringify({ id: mid, method, params })); });
  await new Promise((r) => ws.addEventListener('open', r));
  await send('Page.enable', {});
  await send('Page.reload', { ignoreCache: true });
  console.log('reloaded');
  ws.close();
})();
