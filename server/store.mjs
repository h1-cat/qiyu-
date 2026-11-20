import { appendFile, mkdir } from 'node:fs/promises';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const MAX_SEEN = 20000;
const MAX_SESSION_MESSAGES = 60;

function dayKey(ts = Date.now()) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export class Store {
  constructor({ dataDir }) {
    this.dataDir = dataDir;
    this.sessions = new Map();
    this.seen = new Set();
    this.alerts = [];
    this.alertsByKey = new Map();
    this.alertCounts = new Map();
    this.lastExtensionHeartbeat = 0;
    this.qiyuAccount = null;
    this.monitorSessions = new Map();
    this.lastOverviewAt = 0;
    this.qiyuGroups = null;
    this.agentGroups = {};
    this.ignoreAgents = [];
    this.stats = { messages: 0, alerts: 0, high: 0, medium: 0, low: 0, sessions: 0, dryRun: 0 };
    this.daily = { date: dayKey(), messages: 0, alerts: 0, high: 0, medium: 0 };
    this.startedAt = Date.now();
    this._pending = [];
  }

  async init() {
    await mkdir(this.dataDir, { recursive: true });
    this.restoreRecent();
  }

  // 启动时恢复最近 24 小时的消息 ID 和告警冷却，避免重启后重复分析/重复告警
  restoreRecent(hours = 24) {
    const cutoff = Date.now() - hours * 3600 * 1000;
    try {
      const files = readdirSync(this.dataDir).filter((f) => f.startsWith('messages-')).sort().slice(-2);
      for (const f of files) {
        const text = readFileSync(path.join(this.dataDir, f), 'utf8');
        for (const line of text.split('\n')) {
          if (!line) continue;
          try {
            const row = JSON.parse(line);
            if (row.id && (row.ts || 0) >= cutoff) this.seen.add(row.id);
          } catch {}
        }
      }
    } catch (err) {
      console.error('[store] 恢复消息去重表失败', err?.message || err);
    }
    try {
      const files = readdirSync(this.dataDir).filter((f) => f.startsWith('alerts-')).sort().slice(-2);
      for (const f of files) {
        const text = readFileSync(path.join(this.dataDir, f), 'utf8');
        for (const line of text.split('\n')) {
          if (!line) continue;
          try {
            const row = JSON.parse(line);
            if (!row.sessionId || (row.ts || 0) < cutoff) continue;
            this.markAlert(row.sessionId, row.level, row.ts);
            this.alertCounts.set(row.sessionId, (this.alertCounts.get(row.sessionId) || 0) + 1);
          } catch {}
        }
      }
    } catch (err) {
      console.error('[store] 恢复告警冷却失败', err?.message || err);
    }
  }

  async append(kind, row) {
    try {
      const file = path.join(this.dataDir, `${kind}-${dayKey(row.ts || Date.now())}.jsonl`);
      await appendFile(file, JSON.stringify(row) + '\n', 'utf8');
    } catch (err) {
      console.error('[store] append failed', kind, err?.message || err);
    }
  }

  addMessage(msg) {
    if (!msg || !msg.id) return false;
    if (this.seen.has(msg.id)) return false;
    this.seen.add(msg.id);
    const today = dayKey();
    if (this.daily.date !== today) this.daily = { date: today, messages: 0, alerts: 0, high: 0, medium: 0 };
    this.daily.messages++;
    if (this.seen.size > MAX_SEEN) {
      const drop = this.seen.size - MAX_SEEN;
      let i = 0;
      for (const id of this.seen) {
        this.seen.delete(id);
        if (++i >= drop) break;
      }
    }

    let session = this.sessions.get(msg.sessionId);
    if (!session) {
      session = {
        id: msg.sessionId,
        messages: [],
        firstSeen: msg.ts,
        lastSeen: msg.ts,
        meta: {}
      };
      this.sessions.set(msg.sessionId, session);
      this.stats.sessions++;
    }
    session.messages.push(msg);
    // 按消息时间排序：多台采集、增量拉取时到达顺序可能是乱的，卡片和 LLM 上下文要按真实时间排
    if (session.messages.length > 1) {
      session.messages.sort((a, b) => ((a.ts || 0) - (b.ts || 0)) || String(a.id || '').localeCompare(String(b.id || '')));
    }
    if (session.messages.length > MAX_SESSION_MESSAGES) session.messages.shift();
    session.lastSeen = msg.ts;
    if (msg.visitorName) session.meta.visitorName = msg.visitorName;
    if (msg.agentName) session.meta.agentName = msg.agentName;
    if (msg.pageUrl) session.meta.pageUrl = msg.pageUrl;

    this.stats.messages++;
    this.append('messages', msg).catch(() => {});
    return true;
  }

  getSession(sessionId) {
    return this.sessions.get(sessionId);
  }

  sessionWindow(sessionId, minutes = 30, now = Date.now()) {
    const s = this.sessions.get(sessionId);
    if (!s) return [];
    const since = now - minutes * 60 * 1000;
    return s.messages.filter((m) => m.ts >= since);
  }

  countNegative(sessionId, minutes = 10, now = Date.now()) {
    const s = this.sessions.get(sessionId);
    if (!s) return 0;
    const since = now - minutes * 60 * 1000;
    return s.messages.filter((m) => m.ts >= since && m.sentiment === 'negative' && m.direction === 'visitor').length;
  }

  cooledDown(sessionId, level, minutes) {
    const key = `${sessionId}:${level}`;
    const last = this.alertsByKey.get(key) || 0;
    return Date.now() - last >= minutes * 60 * 1000;
  }

  markAlert(sessionId, level, ts = Date.now()) {
    this.alertsByKey.set(`${sessionId}:${level}`, ts);
  }

  addAlert(alert) {
    const count = (this.alertCounts.get(alert.sessionId) || 0) + 1;
    this.alertCounts.set(alert.sessionId, count);
    alert.alertCount = count;
    this.alerts.unshift(alert);
    if (this.alerts.length > 300) this.alerts.pop();
    this.stats.alerts++;
    const today = dayKey();
    if (this.daily.date !== today) this.daily = { date: today, messages: 0, alerts: 0, high: 0, medium: 0 };
    this.daily.alerts++;
    if (alert.level === 'high') {
      this.stats.high++;
      this.daily.high++;
    } else if (alert.level === 'medium') {
      this.stats.medium++;
      this.daily.medium++;
    } else {
      this.stats.low++;
    }
    this.markAlert(alert.sessionId, alert.level, alert.ts || Date.now());
    this.append('alerts', alert).catch(() => {});
    return alert;
  }

  updateMonitorSessions(sessions) {
    this.lastOverviewAt = Date.now();
    const names = this.groupNames();
    for (const s of sessions || []) {
      if (!s || !s.sessionId) continue;
      if (this.ignoreAgents.includes(String(s.staffName || ''))) continue;
      const id = String(s.sessionId);
      const prev = this.monitorSessions.get(id);
      const rawGroup = String(s.fromStaffOrGroup || s.groupName || s.staffGroupName || '');
      const staff = String(s.staffName || '');
      let group;
      if (!names.length) {
        group = this.agentGroups[rawGroup] || this.agentGroups[staff] || rawGroup || '未匹配组';
      } else if (names.includes(rawGroup)) {
        group = rawGroup;
      } else if (this.agentGroups[rawGroup]) {
        group = this.agentGroups[rawGroup];
      } else if (this.agentGroups[staff]) {
        group = this.agentGroups[staff];
      } else if (names.includes(staff)) {
        group = staff;
      } else {
        group = '未匹配组';
      }
      this.monitorSessions.set(id, {
        sessionId: id,
        staffId: s.staffId,
        staffName: s.staffName || '',
        group,
        groupId: s.groupId || s.staffGroupId || s.staffGroup || '',
        groupName: s.groupName || s.staffGroupName || '',
        user: s.user || '',
        userId: s.userId,
        status: s.status,
        sessionTime: s.sessionTime,
        roundNumber: s.roundNumber,
        alerts: s.alerts || [],
        userSensitiveWords: s.userSensitiveWords || [],
        staffSensitiveWords: s.staffSensitiveWords || [],
        updatedAt: Date.now(),
        seenAt: prev?.seenAt || Date.now()
      });
    }
    const cutoff = Date.now() - 10 * 60 * 1000;
    for (const [id, s] of this.monitorSessions) {
      if (s.updatedAt < cutoff) this.monitorSessions.delete(id);
    }
  }

  groupNames() {
    const result = this.qiyuGroups?.result;
    if (Array.isArray(result)) return result.map((g) => g.name).filter(Boolean);
    const list = result?.groupList;
    if (!Array.isArray(list)) return [];
    const names = [];
    const walk = (arr) => {
      for (const g of arr) {
        if (g.groupName && g.groupName !== '所有客服组合计') names.push(g.groupName);
        if (Array.isArray(g.children)) walk(g.children);
      }
    };
    walk(list);
    return names;
  }

  groupStats() {
    const counts = new Map();
    for (const s of this.monitorSessions.values()) {
      const group = s.group || '未分组';
      counts.set(group, (counts.get(group) || 0) + 1);
    }
    const namesList = this.groupNames();
    if (namesList.length) {
      const names = new Set(namesList);
      const list = namesList.map((name) => ({ group: name, count: counts.get(name) || 0 }));
      let unmatched = 0;
      for (const [name, count] of counts) {
        if (!names.has(name)) unmatched += count;
      }
      if (unmatched) list.push({ group: '未匹配组', count: unmatched });
      return list.sort((a, b) => b.count - a.count);
    }
    return [...counts.entries()]
      .map(([group, count]) => ({ group, count }))
      .sort((a, b) => b.count - a.count);
  }

  recentAlerts(limit = 50) {
    return this.alerts.slice(0, Math.max(1, Math.min(200, limit)));
  }

  snapshot() {
    return {
      ok: true,
      uptimeSec: Math.floor((Date.now() - this.startedAt) / 1000),
      stats: this.stats,
      sessions: this.sessions.size,
      extensionOnline: Date.now() - this.lastExtensionHeartbeat < 45000,
      lastExtensionHeartbeat: this.lastExtensionHeartbeat,
      qiyuAccount: this.qiyuAccount,
      monitorSessions: this.monitorSessions.size,
      groups: this.groupStats(),
      recentAlerts: this.alerts.slice(0, 20)
    };
  }
}
