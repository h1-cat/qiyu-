// 后台：只做只读采集，把七鱼会话帧上报到监控服务。
// 分析、LLM 复核、飞书推送全在服务端；扩展只按本机勾选的客服组决定采集哪些会话。
import { SERVER_BASE } from './env.js';
const MAX_QUEUE = 500;
let queue = [];
const endpoint = SERVER_BASE;
let flushing = false;
let flushTimer = null;
let qiyuToken = '';
let qiyuOrigin = 'https://example.qiyukf.com';
let accountName = '';
let alertGroups = [];
const sessionGroups = new Map();
const lastCt = {};
const lastRound = {};
const debugSent = new Set();

chrome.storage.local.get({ alertGroups: [] }, (cfg) => {
  alertGroups = normalizeGroups(cfg.alertGroups);
});
chrome.storage.local.get({ qiyuToken: '', qiyuOrigin: 'https://example.qiyukf.com' }, (cfg) => {
  qiyuToken = cfg.qiyuToken || '';
  if (cfg.qiyuOrigin) qiyuOrigin = cfg.qiyuOrigin;
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.alertGroups) alertGroups = normalizeGroups(changes.alertGroups.newValue);
});

function normalizeGroups(value) {
  return Array.isArray(value) ? value.map((g) => String(g).trim()).filter(Boolean) : [];
}

function mergeGroupOptions(names) {
  if (!names || !names.length) return;
  chrome.storage.local.get({ groupOptions: [] }, (cfg) => {
    const merged = new Set([...(cfg.groupOptions || []), ...names.filter(Boolean)]);
    chrome.storage.local.set({ groupOptions: [...merged] }).catch(() => {});
  });
}

// 没勾任何组 = 采集全部；组名未知时不丢，交给服务端判断
function collectGroup(group) {
  if (!alertGroups.length) return true;
  const g = String(group || '').trim();
  if (!g) return true;
  return alertGroups.includes(g);
}

function schedule(delay = 800) {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flush();
  }, delay);
}

async function flush() {
  if (flushing || queue.length === 0) return;
  flushing = true;
  const batch = queue.splice(0, 50);
  try {
    const res = await fetch(endpoint + '/api/ingest', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        source: 'extension',
        collector: accountName || '',
        frames: batch,
        pageUrl: batch[0]?.pageUrl || ''
      })
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
  } catch (err) {
    queue = batch.concat(queue).slice(0, MAX_QUEUE);
    console.warn('[qiyu-risk] 上报失败，稍后重试：', err?.message || err);
    schedule(2500);
  } finally {
    flushing = false;
    if (queue.length) schedule(600);
  }
}

async function heartbeat(account) {
  try {
    const res = await fetch(endpoint + '/api/heartbeat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ account: account || null })
    });
    return res.ok;
  } catch {
    return false;
  }
}

function cleanMessageText(raw) {
  let text = String(raw || '').replace(/<[^>]+>/g, ' ').trim();
  if (!text) return '';
  if (text.startsWith('{') && text.endsWith('}')) {
    try {
      const j = JSON.parse(text);
      if (j && (j.ext || j.thumb || j.url || j.size || j.fileName)) {
        return j.fileName ? `[文件] ${j.fileName}` : '[图片]';
      }
      if (typeof j.text === 'string') return j.text.trim();
      if (typeof j.content === 'string') return j.content.replace(/<[^>]+>/g, ' ').trim();
      return '';
    } catch {}
  }
  return text;
}

// 解析一帧：更新会话→客服组映射，返回这帧消息所属的会话和组
function handleFrame(frame) {
  const empty = { sessionId: '', group: '' };
  if (!frame || typeof frame.data !== 'string') return empty;
  let j;
  try { j = JSON.parse(frame.data); } catch { return empty; }

  const sessions = j?.result?.sessions;
  if (Array.isArray(sessions)) {
    const found = new Set();
    for (const s of sessions) {
      if (!s.sessionId) continue;
      const name = String(s.fromStaffOrGroup || s.groupName || '').trim();
      if (!name) continue;
      sessionGroups.set(String(s.sessionId), name);
      found.add(name);
    }
    if (found.size) mergeGroupOptions([...found]);
    return empty;
  }

  const msgs = j?.result?.msgs;
  if (!Array.isArray(msgs)) return empty;
  let sessionId = '';
  for (const m of msgs) {
    const direction = m.fromUser === 1 ? 'visitor' : 'agent';
    const sid = String(m.sessionId || m.sid || '');
    if (!sid) continue;
    sessionId = sid;
    // 客服消息首条留样，方便排查字段结构
    if (direction === 'agent' && !debugSent.has(sid)) {
      debugSent.add(sid);
      fetch(endpoint + '/api/debug-msg', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: sid, frameUrl: frame.url || '', msg: m })
      }).catch(() => {});
    }
    const text = cleanMessageText(m.content || m.msg || m.text || '');
    if (!text || text.length > 2000) continue;
  }
  return { sessionId, group: sessionGroups.get(sessionId) || '' };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message !== 'object') return;
  if (message.type === 'frames' && Array.isArray(message.frames)) {
    for (const frame of message.frames) {
      frame.pageUrl = frame.pageUrl || message.pageUrl || sender?.tab?.url || '';
      const info = handleFrame(frame);
      // 消息帧按本机勾选的组过滤；会话总览帧始终上报
      if (info.group && !collectGroup(info.group)) continue;
      queue.push(frame);
    }
    if (queue.length > MAX_QUEUE) queue = queue.slice(-MAX_QUEUE);
    schedule(500);
    sendResponse?.({ ok: true, queued: queue.length });
  } else if (message.type === 'monitor-token' && message.token) {
    qiyuToken = message.token;
    if (message.origin) qiyuOrigin = message.origin;
    chrome.storage.local.set({ qiyuToken, qiyuOrigin }).catch(() => {});
    pollQiyu().catch(() => {});
    sendResponse?.({ ok: true });
  } else if (message.type === 'heartbeat') {
    const acc = message.account;
    if (acc && typeof acc === 'object') accountName = String(acc.name || acc.account || '').trim();
    else if (acc) accountName = String(acc).trim();
    heartbeat(acc).then((ok) => sendResponse?.({ ok: true, local: !ok }));
    return true;
  }
  return true;
});

chrome.runtime.onInstalled.addListener(() => {
  // 扩展更新/重载后，页面里旧的注入脚本会失效；自动刷新七鱼页让它重新注入
  reloadQiyuTabs();
});

async function reloadQiyuTabs() {
  try {
    const tabs = await chrome.tabs.query({ url: 'https://*.qiyukf.com/*' });
    for (const tab of tabs) {
      try { await chrome.tabs.reload(tab.id); } catch {}
    }
  } catch {}
}

// ---- 保持七鱼标签不被浏览器自动丢弃，避免锁屏后采集停止 ----
async function keepQiyuTabsAlive() {
  try {
    const tabs = await chrome.tabs.query({ url: 'https://*.qiyukf.com/*' });
    for (const tab of tabs) {
      try { await chrome.tabs.update(tab.id, { autoDiscardable: false }); } catch {}
    }
  } catch {}
}
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && /qiyukf\.com/.test(tab?.url || '')) {
    chrome.tabs.update(tabId, { autoDiscardable: false }).catch(() => {});
  }
});
keepQiyuTabsAlive();

// ---- 后台只读轮询：脱离页面定时器节流，监控端标签放后台也能采集 ----
chrome.alarms.create('qiyu-poll', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'qiyu-poll') pollQiyu().catch(() => {});
});

async function ensureToken() {
  if (qiyuToken) return true;
  try {
    const tabs = await chrome.tabs.query({ url: 'https://*.qiyukf.com/*' });
    for (const tab of tabs) {
      try {
        const resp = await chrome.tabs.sendMessage(tab.id, { type: 'get-token' });
        if (resp && resp.token) {
          qiyuToken = resp.token;
          if (resp.origin) qiyuOrigin = resp.origin;
          return true;
        }
      } catch {}
    }
  } catch {}
  return false;
}

// 拉客服组列表：一份存本地给设置页勾选，一份上报服务端填「告警组」弹窗
async function fetchQiyuGroups() {
  if (!qiyuToken) return;
  const base = qiyuOrigin.replace(/\/+$/, '');
  try {
    const res = await fetch(
      `${base}/api/kefuGroup/privilege?limit=100&offset=0&type=12&isInit=true&token=${encodeURIComponent(qiyuToken)}`,
      { credentials: 'include' }
    );
    const text = await res.text();
    if (!text || !text.includes('{')) return;
    queue.push({
      transport: 'monitor',
      url: '/api/kefuGroup/privilege',
      data: text,
      pageUrl: `${base}/onsite/monitor`
    });
    if (queue.length > MAX_QUEUE) queue = queue.slice(-MAX_QUEUE);
    schedule(300);

    try {
      const data = JSON.parse(text);
      const names = new Set();
      // 只收客服组节点：有 groupName 的才是组；只有 name 且没有 groupId 的是客服/人员节点
      const walk = (arr) => {
        for (const g of arr || []) {
          if (!g) continue;
          // 组节点带 staffCount/path/pinyin；纯 name 是人员节点，跳过
          const isGroup = g.groupName || g.staffCount !== undefined || g.path || g.pinyin;
          if (isGroup) {
            const name = g.groupName || g.name;
            if (name) names.add(String(name).trim());
          }
          if (Array.isArray(g.children)) walk(g.children);
        }
      };
      const result = data?.result;
      if (Array.isArray(result)) walk(result);
      else if (result && Array.isArray(result.groupList)) walk(result.groupList);
      // 接口一次返回全量组，直接覆盖，顺便清掉旧的脏列表
      if (names.size) chrome.storage.local.set({ groupOptions: [...names] }).catch(() => {});
    } catch {}
  } catch {}
}

async function pollQiyu() {
  if (!(await ensureToken())) return;
  const base = qiyuOrigin.replace(/\/+$/, '');
  let sessions = [];
  try {
    const res = await fetch(`${base}/api/monitor/overview?token=${encodeURIComponent(qiyuToken)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'include',
      body: '{}'
    });
    const data = await res.json();
    sessions = data?.result?.sessions || [];
  } catch {
    return;
  }
  if (!Array.isArray(sessions) || !sessions.length) return;

  const slim = sessions.map((s) => ({
    sessionId: s.sessionId, staffId: s.staffId, staffName: s.staffName,
    fromStaffOrGroup: s.fromStaffOrGroup, user: s.user, userId: s.userId,
    groupId: s.groupId, groupName: s.groupName, staffGroupId: s.staffGroupId,
    status: s.status, sessionTime: s.sessionTime, roundNumber: s.roundNumber,
    alerts: s.alerts || [], userSensitiveWords: s.userSensitiveWords || [],
    staffSensitiveWords: s.staffSensitiveWords || []
  }));

  // 先更新会话→组映射，后面消息帧才能按组过滤
  handleFrame({ data: JSON.stringify({ result: { sessions: slim } }) });

  const pageUrl = `${base}/onsite/monitor`;
  for (let i = 0; i < slim.length; i += 80) {
    queue.push({
      transport: 'monitor',
      url: '/api/monitor/overview',
      data: JSON.stringify({ result: { sessions: slim.slice(i, i + 80) } }),
      pageUrl
    });
  }

  const targets = slim
    .filter((s) => {
      if (s.status !== 1) return false;
      if (!collectGroup(s.fromStaffOrGroup || s.groupName || '')) return false;
      const key = String(s.sessionId);
      const changed = lastRound[key] === undefined || lastRound[key] !== s.roundNumber;
      return changed ||
        (s.userSensitiveWords && s.userSensitiveWords.length) ||
        (s.staffSensitiveWords && s.staffSensitiveWords.length);
    })
    .slice(0, 20);

  for (const s of targets) {
    lastRound[String(s.sessionId)] = s.roundNumber;
    try {
      const ct = lastCt[s.sessionId] || 0;
      const r = await fetch(
        `${base}/chat/api/message/list/new/msg?sid=${encodeURIComponent(s.sessionId)}&ct=${ct}&token=${encodeURIComponent(qiyuToken)}`,
        { credentials: 'include' }
      );
      const text = await r.text();
      if (!text || !text.includes('"msgs"')) continue;
      handleFrame({ data: text, sessionId: s.sessionId });
      queue.push({
        transport: 'monitor',
        url: `/chat/api/message/list/new/msg?sid=${s.sessionId}`,
        data: text,
        pageUrl
      });
      try {
        const j = JSON.parse(text);
        const msgs = j?.result?.msgs || [];
        if (msgs.length) lastCt[s.sessionId] = Math.max(...msgs.map((m) => m.time || 0)) + 1;
      } catch {}
    } catch {}
  }

  if (queue.length > MAX_QUEUE) queue = queue.slice(-MAX_QUEUE);
  schedule(300);

  // 后台轮询成功也上报心跳，监控台才能准确显示“采集在线”
  try {
    await fetch(endpoint + '/api/heartbeat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source: 'background', account: accountName ? { name: accountName } : null })
    });
  } catch {}

  fetchQiyuGroups().catch(() => {});
}
