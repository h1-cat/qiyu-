import http from 'node:http';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import crypto from 'node:crypto';
import { loadConfig, PROJECT_ROOT } from './config.mjs';
import { Store } from './store.mjs';
import { normalizeFrames, summarizeFrame, isDebugCandidate } from './normalize.mjs';
import { analyzeMessage } from './analyzer.mjs';
import { sendFeishu, sendFeishuText, sendFeishuDaily } from './notify/feishu.mjs';
import { sentimentOf } from './rules.mjs';
import { createLearner } from './learning.mjs';

const config = loadConfig();
const store = new Store({ dataDir: config.dataDir });
await store.init();

const learner = createLearner({ file: path.join(config.dataDir, 'rule-learning.json') });

if (config.qiyuAccountName) {
  store.qiyuAccount = { name: config.qiyuAccountName, account: '', source: 'config', ts: Date.now() };
}

store.ignoreAgents = config.ignoreAgents;

const agentGroupsFile = path.join(PROJECT_ROOT, 'config/agent-groups.json');
if (existsSync(agentGroupsFile)) {
  try {
    store.agentGroups = JSON.parse(readFileSync(agentGroupsFile, 'utf8'));
    console.log('[config] 已加载客服→组映射', Object.keys(store.agentGroups).length, '条');
  } catch (err) {
    console.error('[config] agent-groups.json 解析失败', err?.message || err);
  }
}

const LEVEL_RANK = { low: 0, medium: 1, high: 2 };
const sseClients = new Set();
const rawFrames = [];
const frameIndex = new Map();

function persistEnv(updates) {
  try {
    const file = path.join(PROJECT_ROOT, '.env');
    let text = existsSync(file) ? readFileSync(file, 'utf8') : '';
    for (const [key, value] of Object.entries(updates)) {
      const line = `${key}=${value}`;
      const re = new RegExp(`^${key}=.*$`, 'm');
      if (re.test(text)) text = text.replace(re, line);
      else text += `${text.endsWith('\n') ? '' : '\n'}${line}\n`;
    }
    writeFileSync(file, text, 'utf8');
  } catch (err) {
    console.error('[config] 写入 .env 失败', err?.message || err);
  }
}

function json(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(data),
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'content-type',
    'access-control-allow-methods': 'GET,POST,OPTIONS'
  });
  res.end(data);
}

function sseSend(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function broadcast(event, data) {
  for (const res of sseClients) {
    try {
      sseSend(res, event, data);
    } catch {
      sseClients.delete(res);
    }
  }
}

async function readBody(req, limit = 2 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('body too large');
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return {};
  return JSON.parse(text);
}

function extractOverviewSessions(frame) {
  const data = frame?.data;
  if (typeof data !== 'string' || !data.includes('"sessions"')) return null;
  try {
    const parsed = JSON.parse(data);
    const sessions = parsed?.result?.sessions;
    return Array.isArray(sessions) ? sessions : null;
  } catch {
    return null;
  }
}

function extractGroupData(frame) {
  const url = frame?.url || '';
  if (!url.includes('kefuGroup') && !url.includes('get7ShuntGroup')) return null;
  const data = frame?.data;
  if (typeof data !== 'string' || !data.includes('{')) return null;
  try {
    return JSON.parse(data);
  } catch {
    return null;
  }
}

function makeAlert(msg, analysis, session) {
  const meta = store.monitorSessions.get(String(msg.sessionId));
  const queueHint = /(正在努力接待|客服咨询量过大|请耐心等待|排队中|正快马加鞭|稍等片刻)/;
  const agentMessages = (session?.messages || []).filter((m) => m.direction === 'agent');
  const humanReplied = agentMessages.some((m) => !queueHint.test(m.text));
  const agentName = humanReplied
    ? (msg.agentName || session?.meta?.agentName || meta?.staffName || '')
    : '';
  return {
    id: `alert-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`,
    ts: Date.now(),
    sessionId: msg.sessionId,
    level: analysis.level,
    score: analysis.score,
    tags: analysis.tags,
    reason: analysis.reason,
    suggestion: analysis.suggestion,
    evidence: analysis.evidence,
    context: [...(session?.messages || [])]
      .sort((a, b) => (a.ts || 0) - (b.ts || 0))
      .slice(-20)
      .map((m) => ({ direction: m.direction, text: String(m.text || '').slice(0, 200) })),
    visitorName: msg.visitorName || session?.meta?.visitorName || '',
    agentName,
    groupName: humanReplied ? (meta?.group || '') : '排队中',
    pageUrl: msg.pageUrl || session?.meta?.pageUrl || '',
    messageTime: msg.ts || Date.now(),
    collector: msg.collector || '',
    source: analysis.source,
    messageId: msg.id
  };
}

async function processMessage(msg) {
  if (!msg || !msg.text || !msg.sessionId) return null;
  if (config.ignoreAgents.includes(String(msg.agentName || ''))) return null;
  const ignoredMeta = store.monitorSessions.get(String(msg.sessionId));
  if (ignoredMeta && config.ignoreAgents.includes(String(ignoredMeta.staffName || ''))) return null;
  msg.sentiment = sentimentOf(msg.text);
  const added = store.addMessage(msg);
  if (!added) return null;

  // 不再逐条广播 message，减少 SSE 负载；前端只关心告警

  const session = store.getSession(msg.sessionId);
  const meta = store.monitorSessions.get(String(msg.sessionId));
  const group = meta?.group || '';
  const priority = Boolean(meta && (
    (meta.userSensitiveWords && meta.userSensitiveWords.length) ||
    (meta.staffSensitiveWords && meta.staffSensitiveWords.length)
  ));
  const negativeCount = store.countNegative(msg.sessionId, 10);
  const analysis = await analyzeMessage({
    message: msg,
    sessionMessages: session?.messages || [],
    negativeCount,
    priority,
    config,
    learned: learner,
    onRuleMiss: ({ base }) => {
      for (const hit of base.hits || []) {
        if (!hit.m || hit.id === 'self-harm') continue;
        learner.record({ ruleId: hit.id, phrase: hit.m });
      }
    }
  });

  // 自杀/自残等高危不按告警组过滤，安全优先
  const safety = analysis.level === 'high' || (analysis.tags || []).some((t) => /自杀|自残/.test(t));
  if (!safety && config.monitorGroups.length && !config.monitorGroups.includes(group)) {
    return null;
  }
  // 分析结果不再逐条广播，告警时才推送

  const threshold = LEVEL_RANK[config.alertMinLevel] ?? 1;
  if (LEVEL_RANK[analysis.level] >= threshold) {
    if (!store.cooledDown(msg.sessionId, analysis.level, config.alertCooldownMin)) {
      return { ...makeAlert(msg, analysis, session), notify: 'cooldown' };
    }
    const alert = makeAlert(msg, analysis, session);
    store.addAlert(alert);
    const result = await sendFeishu(config, alert);
    alert.notify = result.status;
    broadcast('alert', alert);
    return alert;
  }
  return null;
}

async function handleIngest(payload) {
  const frames = Array.isArray(payload.frames) ? payload.frames : [];
  const incoming = Array.isArray(payload.messages) ? payload.messages : [];
  const meta = { pageUrl: payload.pageUrl || '' };

  const fromFrames = normalizeFrames(frames, meta);
  for (const frame of frames) {
    const overviewSessions = extractOverviewSessions(frame);
    if (overviewSessions) {
      store.updateMonitorSessions(overviewSessions);
      broadcast('sessions', { count: overviewSessions.length, groups: store.groupStats(), updatedAt: store.lastOverviewAt });
    }
    const groupData = extractGroupData(frame);
    if (groupData) {
      store.qiyuGroups = groupData;
      broadcast('groups', { updatedAt: Date.now() });
    }
    const url = frame?.url || '';
    if (url) {
      frameIndex.set(url, {
        ts: Date.now(),
        transport: frame.transport || 'unknown',
        url,
        pageUrl: frame.pageUrl || meta.pageUrl || '',
        length: typeof frame.data === 'string' ? frame.data.length : -1
      });
      if (frameIndex.size > 300) {
        const first = frameIndex.keys().next().value;
        frameIndex.delete(first);
      }
    }
    if ((frame?.url || '').includes('/api/debug/') || (frame?.url || '').includes('new/msg') || /appInfo|corporation\/user|corp\/user|staffCenter/i.test(frame?.url || '')) {
      const summary = summarizeFrame(frame);
      rawFrames.push(summary);
      if (rawFrames.length > 200) rawFrames.shift();
      store.append('raw', summary).catch(() => {});
    }
    if (isDebugCandidate(frame, fromFrames)) {
      const summary = summarizeFrame(frame);
      rawFrames.push(summary);
      if (rawFrames.length > 200) rawFrames.shift();
      store.append('raw', summary).catch(() => {});
    }
  }

  const rawCollector = typeof payload.collector === 'string' ? payload.collector.trim().slice(0, 40) : '';
  const badCollector = /^(web|login|home|index|default|网易七鱼|七鱼|登录|客服系统|工作台|客服中心|退出|退出登录|个人信息|账号|设置|消息|会话)$/i;
  const collector = rawCollector && !badCollector.test(rawCollector) ? rawCollector : '';
  const messages = [...incoming, ...fromFrames].filter((m) => m && m.text && m.sessionId);
  for (const msg of messages) {
    if (collector) msg.collector = collector;
    enqueueMessage(msg);
  }
  return { received: messages.length, queued: analysisQueue.length };
}

const analysisQueue = [];
let analysisRunning = 0;
const MAX_ANALYSIS_CONCURRENCY = 4;

function enqueueMessage(msg) {
  analysisQueue.push(msg);
  if (analysisQueue.length > 200) analysisQueue.splice(0, analysisQueue.length - 200);
  drainAnalysisQueue();
}

function drainAnalysisQueue() {
  while (analysisRunning < MAX_ANALYSIS_CONCURRENCY && analysisQueue.length) {
    const msg = analysisQueue.shift();
    analysisRunning++;
    processMessage(msg)
      .catch((err) => console.error('[analysis]', err?.message || err))
      .finally(() => {
        analysisRunning--;
        drainAnalysisQueue();
      });
  }
}

function makeSimulatedMessage({ text, direction = 'visitor', sessionId = 'demo-session', visitorName = '演示访客', agentName = '演示客服' }) {
  return {
    id: `sim-${crypto.randomUUID()}`,
    sessionId,
    direction,
    text: String(text || '').slice(0, 2000),
    ts: Date.now(),
    visitorName,
    agentName,
    source: 'simulate'
  };
}

const PRESETS = {
  high: '你们再不给我退款，我就打12315投诉，还要找媒体曝光你们！',
  'high-threat': '你信不信我找人弄死你，等着瞧。',
  medium: '这什么破服务，我要投诉你们，让你们领导来跟我说！',
  low: '请问这个礼包什么时候能到账？谢谢。'
};

async function serveStatic(req, res, pathname) {
  const map = {
    '/': ['web/index.html', 'text/html; charset=utf-8'],
    '/index.html': ['web/index.html', 'text/html; charset=utf-8'],
    '/app.js': ['web/app.js', 'text/javascript; charset=utf-8'],
    '/style.css': ['web/style.css', 'text/css; charset=utf-8']
  };
  const entry = map[pathname];
  if (!entry) return false;
  try {
    const data = await readFile(path.join(PROJECT_ROOT, entry[0]));
    res.writeHead(200, { 'content-type': entry[1], 'cache-control': 'no-store, no-cache, must-revalidate', pragma: 'no-cache' });
    res.end(data);
    return true;
  } catch {
    json(res, 404, { ok: false, error: 'not found' });
    return true;
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
  const pathname = url.pathname;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-headers': 'content-type',
      'access-control-allow-methods': 'GET,POST,OPTIONS'
    });
    res.end();
    return;
  }

  try {
    if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html' || pathname === '/app.js' || pathname === '/style.css')) {
      if (await serveStatic(req, res, pathname)) return;
    }

    if (req.method === 'GET' && pathname === '/api/health') {
      const snapshot = store.snapshot();
      json(res, 200, {
        ...snapshot,
        qiyuAccount: store.qiyuAccount,
        llmEnabled: config.llmEnabled && Boolean(config.llmApiKey) && Boolean(config.llmBaseUrl),
        feishuConfigured: Boolean(config.feishuWebhook),
        alertMinLevel: config.alertMinLevel,
        cooldownMin: config.alertCooldownMin
      });
      return;
    }

    if (req.method === 'GET' && pathname === '/api/config') {
      json(res, 200, {
        ok: true,
        qiyuWorkspaceUrl: config.qiyuWorkspaceUrl,
        qiyuDomain: config.qiyuDomain,
        embedWorkspace: config.embedWorkspace,
        monitorGroups: config.monitorGroups,
        alertMinLevel: config.alertMinLevel,
        cooldownMin: config.alertCooldownMin,
        feishuConfigured: Boolean(config.feishuWebhook),
        llmEnabled: config.llmEnabled && Boolean(config.llmApiKey) && Boolean(config.llmBaseUrl),
        llmMode: config.llmMode
      });
      return;
    }

    if (req.method === 'GET' && pathname === '/api/settings/llm') {
      json(res, 200, {
        ok: true,
        enabled: config.llmEnabled,
        baseUrl: config.llmBaseUrl,
        model: config.llmModel,
        hasKey: Boolean(config.llmApiKey),
        keyMasked: config.llmApiKey ? config.llmApiKey.slice(0, 4) + '****' + config.llmApiKey.slice(-4) : ''
      });
      return;
    }

    if (req.method === 'POST' && pathname === '/api/settings/llm') {
      const body = await readBody(req).catch(() => ({}));
      if (typeof body.enabled === 'boolean') config.llmEnabled = body.enabled;
      if (body.baseUrl) config.llmBaseUrl = String(body.baseUrl).trim().replace(/\/+$/, '');
      if (body.model) config.llmModel = String(body.model).trim();
      if (body.clearKey) config.llmApiKey = '';
      else if (typeof body.apiKey === 'string' && body.apiKey.trim()) config.llmApiKey = body.apiKey.trim();
      persistEnv({
        LLM_ENABLED: config.llmEnabled ? 'true' : 'false',
        LLM_BASE_URL: config.llmBaseUrl,
        LLM_MODEL: config.llmModel,
        LLM_API_KEY: config.llmApiKey
      });
      broadcast('llm-settings', { enabled: config.llmEnabled, model: config.llmModel });
      json(res, 200, {
        ok: true,
        enabled: config.llmEnabled,
        baseUrl: config.llmBaseUrl,
        model: config.llmModel,
        hasKey: Boolean(config.llmApiKey)
      });
      return;
    }

    if (req.method === 'POST' && pathname === '/api/settings/llm/test') {
      if (!config.llmApiKey || !config.llmBaseUrl) {
        json(res, 400, { ok: false, error: config.llmApiKey ? '请先填写接口地址' : '请先填写 API Key' });
        return;
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 12000);
      try {
        const resp = await fetch(`${config.llmBaseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${config.llmApiKey}`
          },
          body: JSON.stringify({
            model: config.llmModel,
            messages: [{ role: 'user', content: 'ping' }],
            max_tokens: 1
          }),
          signal: controller.signal
        });
        const text = await resp.text();
        json(res, 200, { ok: resp.ok, status: resp.status, sample: text.slice(0, 300) });
      } catch (err) {
        json(res, 200, { ok: false, error: err?.name === 'AbortError' ? '请求超时' : String(err?.message || err) });
      } finally {
        clearTimeout(timer);
      }
      return;
    }

    if (req.method === 'GET' && pathname === '/api/alerts') {
      json(res, 200, { ok: true, alerts: store.recentAlerts(Number(url.searchParams.get('limit')) || 50) });
      return;
    }

    if (req.method === 'GET' && pathname === '/api/raw') {
      json(res, 200, { ok: true, frames: rawFrames.slice(-50) });
      return;
    }

    if (req.method === 'GET' && pathname === '/api/frames') {
      json(res, 200, { ok: true, frames: [...frameIndex.values()].slice(-150) });
      return;
    }

    if (req.method === 'POST' && pathname === '/api/monitor-groups') {
      const body = await readBody(req).catch(() => ({}));
      const groups = Array.isArray(body.groups)
        ? body.groups.map((g) => String(g).trim()).filter(Boolean)
        : [];
      config.monitorGroups = groups;
      persistEnv({ MONITOR_GROUPS: groups.join(',') });
      broadcast('monitor-groups', { groups });
      json(res, 200, { ok: true, monitorGroups: config.monitorGroups });
      return;
    }

    if (req.method === 'POST' && pathname === '/api/daily-summary') {
      const result = await sendDailySummary();
      json(res, 200, { ok: true, result });
      return;
    }

    if (req.method === 'POST' && pathname === '/api/debug-msg') {
      const body = await readBody(req).catch(() => ({}));
      store.append('debug-msg', body).catch(() => {});
      json(res, 200, { ok: true });
      return;
    }

    if (req.method === 'GET' && pathname === '/api/rule-learning') {
      json(res, 200, { ok: true, learned: learner.list() });
      return;
    }

    if (req.method === 'POST' && pathname === '/api/rule-learning/remove') {
      const body = await readBody(req).catch(() => ({}));
      const removed = learner.remove(String(body.ruleId || ''), String(body.phrase || ''));
      json(res, 200, { ok: true, removed });
      return;
    }

    if (req.method === 'GET' && pathname === '/api/groups') {
      json(res, 200, { ok: true, groups: store.qiyuGroups });
      return;
    }

    if (req.method === 'GET' && pathname === '/api/unmatched') {
      const names = new Set(store.groupNames());
      const counts = new Map();
      for (const s of store.monitorSessions.values()) {
        if (s.group && !names.has(s.group)) counts.set(s.group, (counts.get(s.group) || 0) + 1);
      }
      json(res, 200, {
        ok: true,
        items: [...counts.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count)
      });
      return;
    }

    if (req.method === 'GET' && pathname === '/api/sessions') {
      const group = url.searchParams.get('group') || '';
      const limit = Math.max(1, Math.min(500, Number(url.searchParams.get('limit')) || 200));
      let list = [...store.monitorSessions.values()];
      if (group) list = list.filter((s) => s.group === group);
      list.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
      json(res, 200, {
        ok: true,
        updatedAt: store.lastOverviewAt,
        total: store.monitorSessions.size,
        groups: store.groupStats(),
        filtered: list.length,
        sessions: list.slice(0, limit)
      });
      return;
    }

    if (req.method === 'GET' && pathname === '/api/session') {
      const id = url.searchParams.get('id');
      const session = id ? store.getSession(id) : null;
      json(res, 200, { ok: true, session: session ? { id: session.id, meta: session.meta, messages: session.messages.slice(-30) } : null });
      return;
    }

    if (req.method === 'GET' && pathname === '/api/events') {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'access-control-allow-origin': '*',
        'x-accel-buffering': 'no'
      });
      res.write('retry: 3000\n\n');
      sseClients.add(res);
      sseSend(res, 'hello', store.snapshot());
      req.on('close', () => sseClients.delete(res));
      return;
    }

    if (req.method === 'POST' && pathname === '/api/heartbeat') {
      const body = await readBody(req).catch(() => ({}));
      store.lastExtensionHeartbeat = Date.now();
      const accName = String(body.account?.name || '').trim();
      const accAccount = String(body.account?.account || '').trim();
      const badName = /^(网易七鱼|七鱼|登录|客服系统|工作台|客服中心|web|login|home|index)$/i;
      if ((accName || accAccount) && !badName.test(accName)) {
        store.qiyuAccount = {
          name: accName.slice(0, 40),
          account: accAccount.slice(0, 60),
          source: String(body.account?.source || 'extension').slice(0, 80),
          ts: Date.now()
        };
        broadcast('account', store.qiyuAccount);
      }
      json(res, 200, { ok: true, ts: store.lastExtensionHeartbeat, qiyuAccount: store.qiyuAccount });
      return;
    }

    if (req.method === 'POST' && pathname === '/api/ingest') {
      const payload = await readBody(req);
      const result = await handleIngest(payload || {});
      json(res, 200, { ok: true, ...result });
      return;
    }

    if (req.method === 'POST' && pathname === '/api/simulate') {
      const body = await readBody(req);
      const text = body.text || PRESETS[body.preset] || PRESETS.high;
      const msg = makeSimulatedMessage({
        text,
        direction: body.direction === 'agent' ? 'agent' : 'visitor',
        sessionId: body.sessionId || 'demo-session',
        visitorName: body.visitorName || '演示访客',
        agentName: body.agentName || '演示客服'
      });
      const alert = await processMessage(msg);
      json(res, 200, { ok: true, message: msg, alert });
      return;
    }

    if (req.method === 'POST' && pathname === '/api/test-feishu') {
      const alert = {
        id: `test-${Date.now()}`,
        ts: Date.now(),
        sessionId: 'test-session',
        level: 'high',
        score: 95,
        tags: ['人身威胁/约架', '监管/媒体投诉'],
        reason: '这是测试卡片，用于验证飞书机器人配置。',
        suggestion: '收到后请确认卡片样式与按钮跳转正常。',
        evidence: [
          { direction: 'visitor', text: '你们再不退款我就打12315，还要曝光你们！', ts: Date.now() },
          { direction: 'agent', text: '您先别激动，我马上帮您核实。', ts: Date.now() }
        ],
        visitorName: '测试访客',
        agentName: '测试客服',
        source: 'test'
      };
      const result = await sendFeishu(config, alert);
      json(res, 200, { ok: true, result });
      return;
    }

    json(res, 404, { ok: false, error: 'not found' });
  } catch (err) {
    console.error('[server]', err);
    if (!res.headersSent) json(res, 500, { ok: false, error: err?.message || String(err) });
    else res.end();
  }
});

const pingTimer = setInterval(() => {
  for (const res of sseClients) {
    try { res.write(': ping\n\n'); } catch { sseClients.delete(res); }
  }
}, 15000);

server.listen(config.port, config.host, () => {
  const url = `http://${config.host === '0.0.0.0' ? '127.0.0.1' : config.host}:${config.port}`;
  console.log(`[qiyu-risk-monitor] 监控台已启动：${url}`);
  console.log(`[qiyu-risk-monitor] 七鱼工作台：${config.qiyuWorkspaceUrl}`);
  console.log(`[qiyu-risk-monitor] 飞书：${config.feishuWebhook ? '已配置' : 'dry-run（未配置 webhook）'}`);
  const llmDesc = !config.llmEnabled ? '未启用（规则引擎）'
    : !config.llmApiKey ? '已开启但缺 API Key（退回规则引擎）'
      : !config.llmBaseUrl ? '已开启但缺接口地址（退回规则引擎）'
        : (config.llmModel || '已开启（模型名未填）');
  console.log(`[qiyu-risk-monitor] LLM：${llmDesc}`);
});

// 采集离线提醒：离线满 30 分钟推一次飞书；一直没恢复就每 2 小时再推一次；恢复在线后重新计时
const OFFLINE_FIRST_MS = 30 * 60 * 1000;
const OFFLINE_REPEAT_MS = 2 * 60 * 60 * 1000;
const startedAt = Date.now();
let offlineAlertedAt = 0;
setInterval(async () => {
  if (!config.feishuWebhook) return;
  if (Date.now() - startedAt < OFFLINE_FIRST_MS) return;
  const ts = store.lastExtensionHeartbeat || 0;
  const offlineMs = ts ? Date.now() - ts : Number.POSITIVE_INFINITY;
  if (offlineMs < OFFLINE_FIRST_MS) {
    offlineAlertedAt = 0;
    return;
  }
  const due = offlineAlertedAt === 0 || Date.now() - offlineAlertedAt >= OFFLINE_REPEAT_MS;
  if (!due) return;
  offlineAlertedAt = Date.now();
  const minutes = Number.isFinite(offlineMs) ? Math.floor(offlineMs / 60000) : null;
  await sendFeishuText(
    config,
    `【采集离线】七鱼监控扩展${minutes ? `已离线约 ${minutes} 分钟` : '还没有上报过心跳'}，请检查监控页标签、浏览器和本机服务。\n时间：${new Date().toLocaleString('zh-CN')}`
  );
}, 60 * 1000);

// ---- 每日监控总结 ----
function dayKeyStr(ts = Date.now()) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function collectDailyStats(day) {
  const start = new Date(`${day}T00:00:00+08:00`).getTime();
  const end = start + 24 * 3600 * 1000;
  const msgFile = path.join(PROJECT_ROOT, 'data', `messages-${day}.jsonl`);
  const alertFile = path.join(PROJECT_ROOT, 'data', `alerts-${day}.jsonl`);

  const groupBySession = new Map();
  for (const [id, meta] of store.monitorSessions) groupBySession.set(String(id), meta.group || '');

  const seenAlert = new Set();
  const tagCount = new Map();
  let alerts = 0, high = 0, medium = 0;
  if (existsSync(alertFile)) {
    for (const line of readFileSync(alertFile, 'utf8').split('\n')) {
      if (!line) continue;
      try {
        const a = JSON.parse(line);
        if (!a.ts || a.ts < start || a.ts >= end) continue;
        if (a.id && seenAlert.has(a.id)) continue;
        if (a.id) seenAlert.add(a.id);
        const g = a.groupName || '';
        if (!groupBySession.has(String(a.sessionId))) groupBySession.set(String(a.sessionId), g);
        if (config.monitorGroups.length && !config.monitorGroups.includes(g)) continue;
        alerts++;
        if (a.level === 'high') high++;
        else if (a.level === 'medium') medium++;
        for (const t of a.tags || []) {
          const e = tagCount.get(t) || { count: 0, reason: '' };
          e.count++;
          if (!e.reason && a.reason) e.reason = String(a.reason);
          tagCount.set(t, e);
        }
      } catch {}
    }
  }

  const seenMsg = new Set();
  const sessions = new Set();
  let messages = 0;
  if (existsSync(msgFile)) {
    for (const line of readFileSync(msgFile, 'utf8').split('\n')) {
      if (!line) continue;
      try {
        const j = JSON.parse(line);
        if (!j.ts || j.ts < start || j.ts >= end) continue;
        if (j.id && seenMsg.has(j.id)) continue;
        if (j.id) seenMsg.add(j.id);
        const g = groupBySession.get(String(j.sessionId)) || '';
        if (config.monitorGroups.length && !config.monitorGroups.includes(g)) continue;
        messages++;
        if (j.sessionId) sessions.add(j.sessionId);
      } catch {}
    }
  }

  const topTags = [...tagCount.entries()]
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 5)
    .map(([name, e]) => ({ name, count: e.count, reason: e.reason }));
  return { day, messages, sessions: sessions.size, alerts, high, medium, topTags };
}

async function sendDailySummary(day = dayKeyStr()) {
  const d = collectDailyStats(day);
  d.online = Boolean(store.lastExtensionHeartbeat && Date.now() - store.lastExtensionHeartbeat < 5 * 60 * 1000);
  return sendFeishuDaily(config, d);
}

let lastSummaryDate = '';
setInterval(async () => {
  if (!config.feishuWebhook) return;
  const now = new Date();
  const hm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  const today = dayKeyStr(now.getTime());
  if (hm !== config.dailySummaryTime || lastSummaryDate === today) return;
  lastSummaryDate = today;
  try { await sendDailySummary(); } catch {}
}, 60 * 1000);

function shutdown() {
  clearInterval(pingTimer);
  for (const res of sseClients) {
    try { res.end(); } catch {}
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1000);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
