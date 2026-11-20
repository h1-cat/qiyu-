import crypto from 'node:crypto';

const TEXT_KEYS = ['content', 'msg', 'message', 'text', 'body'];
const SESSION_KEYS = ['sessionId', 'session_id', 'sid', 'session'];
const ID_KEYS = ['msgIdClient', 'msgId', 'messageId', 'msg_id', 'message_id', 'id'];
const TIME_KEYS = ['sendTime', 'send_time', 'timestamp', 'createTime', 'create_time', 'time', 'ts'];
const VISITOR_NAME_KEYS = ['visitorName', 'visitor_name', 'userName', 'user_name', 'nickName', 'nickname', 'customerName'];
const AGENT_NAME_KEYS = ['staffName', 'staff_name', 'agentName', 'agent_name', 'serviceName', 'service_name'];
const STAFF_IDS = ['staffId', 'staff_id', 'agentId', 'agent_id', 'serviceId'];
const VISITOR_IDS = ['visitorId', 'visitor_id', 'userId', 'user_id', 'uid', 'customerId'];

const SKIP_TEXT = /^\s*(\[图片\]|\[表情\]|\[语音\]|\[视频\]|\[文件\]|\[链接\]|\[商品\]|\[订单\])?\s*$/;

function parseMaybeJson(value) {
  if (value == null) return null;
  if (typeof value === 'object') return value;
  if (typeof value !== 'string') return null;
  const s = value.trim();
  if (!s) return null;
  if (s[0] !== '{' && s[0] !== '[') return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function cleanText(value) {
  let text = String(value || '');
  if (!text) return '';
  const trimmed = text.trim();
  if (trimmed.startsWith('{') && trimmed.includes('"content"')) {
    try {
      const parsed = JSON.parse(trimmed);
      const inner = parsed.content ?? parsed.text ?? parsed.msg;
      if (typeof inner === 'string') text = inner;
    } catch {}
  }
  text = text.replace(/<[^>]*>/g, ' ');
  text = text.replace(/&nbsp;/gi, ' ').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&amp;/gi, '&');
  return text.replace(/\s+/g, ' ').trim();
}

function guessRole(text) {
  if (!text) return '';
  if (/(欢迎咨询|温馨提醒|账号安全|自动回复|系统消息|工单已|请勿|不要向任何人提供|感谢您的咨询)/.test(text) && !/(我要|你们|投诉|退款)/.test(text)) return 'agent';
  if (/(我要|你们|投诉|举报|差评|封号|弄死|起诉|骗子|垃圾|退款|退钱)/.test(text)) return 'visitor';
  return '';
}

function textOf(obj) {
  for (const key of TEXT_KEYS) {
    const v = obj[key];
    if (typeof v === 'string') {
      const cleaned = cleanText(v);
      if (cleaned) return cleaned;
    }
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const inner = textOf(v);
      if (inner) return inner;
    }
  }
  return '';
}

function firstDefined(obj, keys) {
  for (const key of keys) {
    const v = obj[key];
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return undefined;
}

function sessionOf(obj) {
  const v = firstDefined(obj, SESSION_KEYS);
  if (v === undefined) return '';
  return String(v);
}

function tsOf(obj) {
  const v = firstDefined(obj, TIME_KEYS);
  if (v === undefined) return Date.now();
  if (typeof v === 'number' || /^\d+$/.test(String(v))) {
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) return Date.now();
    return n < 1e12 ? n * 1000 : n;
  }
  const parsed = Date.parse(String(v).replace(' ', 'T'));
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function roleOf(obj) {
  // 七鱼监控端消息：fromUser=0 表示客服，fromUser=1 表示访客
  if (obj.fromUser !== undefined && obj.fromUser !== null && obj.fromUser !== '') {
    return Number(obj.fromUser) === 0 ? 'agent' : 'visitor';
  }
  const staffId = firstDefined(obj, STAFF_IDS);
  if (staffId !== undefined && Number(staffId) > 0 && firstDefined(obj, VISITOR_IDS) === undefined) return 'agent';

  const raw = firstDefined(obj, ['direction', 'from', 'sender', 'role', 'senderType', 'sender_type', 'fromType', 'from_type', 'userType', 'user_type']);
  if (raw !== undefined) {
    const s = String(raw).toLowerCase();
    if (['staff', 'agent', 'service', 'kefu', '客服', '1'].includes(s)) {
      if (s === '1' && firstDefined(obj, VISITOR_IDS) !== undefined) return 'visitor';
      return 'agent';
    }
    if (['visitor', 'user', 'customer', 'client', '访客', '用户', '0'].includes(s)) return 'visitor';
  }
  if (firstDefined(obj, VISITOR_IDS) !== undefined) return 'visitor';
  if (staffId !== undefined) return 'agent';
  return 'system';
}

function nameOf(obj, keys) {
  const v = firstDefined(obj, keys);
  return v === undefined ? '' : String(v).slice(0, 60);
}

function makeId(obj, sessionId, direction, text, ts) {
  const raw = firstDefined(obj, ID_KEYS);
  if (raw !== undefined) return String(raw);
  return crypto.createHash('sha1').update(`${sessionId}|${direction}|${ts}|${text}`).digest('hex').slice(0, 20);
}

function looksLikeMessage(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
  if (!sessionOf(obj)) return false;
  const type = String(obj.type || obj.msgType || '').toLowerCase();
  if (type && type !== 'text') return false;
  const text = textOf(obj);
  if (!text || SKIP_TEXT.test(text)) return false;
  if (text.length > 4000) return false;
  if (text.startsWith('{"ext"') || text.startsWith('{"type"')) return false;
  return true;
}

function toMessage(obj, meta) {
  const sessionId = sessionOf(obj);
  const text = textOf(obj);
  let direction = roleOf(obj);
  if (direction === 'system') {
    const guessed = guessRole(text);
    if (guessed) direction = guessed;
  }
  const ts = tsOf(obj);
  const id = makeId(obj, sessionId, direction, text, ts);
  const visitorName =
    nameOf(obj, VISITOR_NAME_KEYS) ||
    nameOf(obj.user || {}, ['realname', 'username', 'nickname']) ||
    '';
  const agentName =
    nameOf(obj, AGENT_NAME_KEYS) ||
    nameOf(obj.kefu || {}, ['realname', 'username', 'nickname']) ||
    '';
  return {
    id,
    sessionId,
    direction,
    text,
    ts,
    visitorName,
    agentName,
    pageUrl: meta?.pageUrl || '',
    rawType: obj.msgType ?? obj.type ?? obj.contentType ?? '',
    source: 'extension'
  };
}

function walk(node, out, depth = 0) {
  if (!node || depth > 10) return;
  if (Array.isArray(node)) {
    for (const item of node) walk(item, out, depth + 1);
    return;
  }
  if (typeof node !== 'object') return;
  if (looksLikeMessage(node)) {
    out.push(toMessage(node, {}));
    return;
  }
  for (const key of Object.keys(node)) {
    walk(node[key], out, depth + 1);
  }
}

export function normalizeFrames(frames, meta = {}) {
  const out = [];
  for (const frame of frames || []) {
    const payload = frame?.data ?? frame?.text ?? frame?.payload ?? frame?.body;
    const parsed = parseMaybeJson(payload);
    if (parsed == null) continue;
    const found = [];
    walk(parsed, found);
    for (const msg of found) {
      msg.pageUrl = msg.pageUrl || meta.pageUrl || frame.pageUrl || '';
      msg.transport = frame.transport || frame.type || 'unknown';
      out.push(msg);
    }
  }
  const seen = new Set();
  return out.filter((m) => {
    if (seen.has(m.id)) return false;
    seen.add(m.id);
    return true;
  });
}

export function summarizeFrame(frame, maxLen = 4000) {
  const payload = frame?.data ?? frame?.text ?? frame?.payload ?? '';
  let text = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const limit = String(frame?.url || '').includes('new/msg') ? 200000 : maxLen;
  if (text.length > limit) text = text.slice(0, limit) + '…';
  return {
    ts: Date.now(),
    transport: frame?.transport || frame?.type || 'unknown',
    url: frame?.url || '',
    pageUrl: frame?.pageUrl || '',
    length: typeof payload === 'string' ? payload.length : -1,
    sample: text
  };
}

export function isDebugCandidate(frame, messages) {
  if (messages.length > 0) return false;
  const payload = frame?.data ?? frame?.text ?? frame?.payload ?? '';
  const len = typeof payload === 'string' ? payload.length : JSON.stringify(payload).length;
  return len > 0 && len <= 200000;
}
