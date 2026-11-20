const $ = (sel) => document.querySelector(sel);
const state = { paused: false, filter: 'all', groups: [], monitorGroups: [], groupList: [], alerts: [], online: false, stats: null, qiyuWorkspaceUrl: '' };

const LEVEL_LABEL = { high: '高危', medium: '中危', low: '低危' };
const NOTIFY_LABEL = {
  sent: '飞书已发送',
  dry_run: '飞书 dry-run',
  failed: '飞书发送失败',
  cooldown: '冷却中，未重复通知'
};

function fmtTime(ts) {
  const d = new Date(ts || Date.now());
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function setStatus(kind, text) {
  const dot = $('#statusDot');
  dot.className = 'dot ' + kind;
  $('#statusText').textContent = text;
}

function renderAccount(account) {
  const chip = $('#accountChip');
  const value = $('#accountValue');
  if (!chip || !value) return;
  if (account && (account.name || account.account)) {
    value.textContent = account.name || account.account;
    chip.classList.add('known');
    chip.title = account.account ? `七鱼账号：${account.account}` : '由扩展从七鱼页面读取';
  } else {
    value.textContent = '未识别';
    chip.classList.remove('known');
    chip.title = '安装扩展并登录七鱼后自动显示';
  }
}

function renderGroupOptions(groups) {
  const panel = $('#groupFilterPanel');
  if (!panel || !Array.isArray(groups)) return;
  const sorted = [...groups].sort((a, b) => (a.group || '未分组').localeCompare(b.group || '未分组', 'zh-CN'));
  const signature = sorted.map((g) => g.group || '未分组').join('|');
  if (renderGroupOptions.last === signature) return;
  renderGroupOptions.last = signature;
  state.groupList = sorted.map((g) => g.group || '未分组');
  const list = sorted.filter((g) => g.count > 0 || state.groups.includes(g.group || '未分组'));
  panel.innerHTML = list.map((g) => {
    const name = g.group || '未分组';
    const checked = state.groups.includes(name) ? ' checked' : '';
    return `<label><input type="checkbox" value="${escapeHtml(name)}"${checked}> <span>${escapeHtml(name)}（${g.count}）</span></label>`;
  }).join('');
  updateGroupButton();
}

function updateGroupButton() {
  const btn = $('#groupFilterBtn');
  if (!btn) return;
  btn.textContent = state.groups.length ? `已选 ${state.groups.length} 个组 ▾` : '全部客服组 ▾';
}

function updateStats(snapshot) {
  if (!snapshot) return;
  const stats = snapshot.stats || state.stats || {};
  state.stats = stats;
  renderAccount(snapshot.qiyuAccount);
  renderGroupOptions(snapshot.groups);
  $('#statHigh').textContent = stats.high ?? 0;
  $('#statMedium').textContent = stats.medium ?? 0;
  $('#statAlerts').textContent = stats.alerts ?? 0;
  $('#statSessions').textContent = snapshot.sessions ?? stats.sessions ?? 0;
  $('#statMessages').textContent = stats.messages ?? 0;
  state.online = Boolean(snapshot.extensionOnline);
  if (snapshot.extensionOnline) setStatus('online', '采集在线');
  else setStatus('offline', '采集离线');
}

async function loadConfig() {
  try {
    const res = await fetch('/api/config');
    const cfg = await res.json();
    const frame = $('#qiyuFrame');
    state.qiyuWorkspaceUrl = cfg.qiyuWorkspaceUrl || '';
    if (cfg.embedWorkspace) {
      if (cfg.qiyuWorkspaceUrl) frame.src = cfg.qiyuWorkspaceUrl;
    } else {
      frame.src = 'about:blank';
      document.querySelector('#layout').classList.add('risk-only');
      $('#toggleIframe').textContent = '显示工作台';
    }
    $('#openWorkspace').href = cfg.qiyuWorkspaceUrl || '#';
    state.monitorGroups = Array.isArray(cfg.monitorGroups) ? cfg.monitorGroups : [];
    updateAlertGroupsBtn();
    $('#subtitle').textContent = `${cfg.qiyuDomain} · 告警阈值 ${cfg.alertMinLevel}${cfg.llmEnabled ? ' · LLM 已启用' : ' · 规则引擎'}`;
  } catch (err) {
    $('#subtitle').textContent = '读取配置失败：' + err.message;
  }
}

async function loadHealth() {
  try {
    const res = await fetch('/api/health');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    updateStats(await res.json());
  } catch {
    setStatus('offline', '服务未连接');
  }
}

function alertVisible(level, group) {
  const levelOk = state.filter === 'all' || state.filter === level;
  const groupName = group || '';
  const groupOk = state.groups.length === 0 || state.groups.includes(groupName);
  return levelOk && groupOk;
}

function applyFilter() {
  for (const el of document.querySelectorAll('.alert')) {
    el.classList.toggle('hidden', !alertVisible(el.dataset.level, el.dataset.group));
  }
  for (const chip of document.querySelectorAll('#filters .chip')) {
    chip.classList.toggle('active', chip.dataset.level === state.filter);
  }
}

function renderAlert(alert) {
  const el = document.createElement('article');
  el.className = `alert ${alert.level}`;
  el.dataset.level = alert.level;
  el.dataset.group = alert.groupName || '';

  const tags = (alert.tags || []).map((t) => `<span class="tag">${escapeHtml(t)}</span>`).join('');
  const evidence = (alert.evidence || [])
    .slice(-3)
    .map((e) => `<div class="alert-quote"><span class="who">${e.direction === 'agent' ? '客服' : '访客'}：</span>${escapeHtml(e.text)}</div>`)
    .join('');
  const notify = alert.notify || '';
  const notifyText = NOTIFY_LABEL[notify] || notify;

  el.innerHTML = `
    <div class="alert-top">
      <span class="badge ${alert.level}">${LEVEL_LABEL[alert.level] || alert.level}</span>
      <span class="alert-time">${fmtTime(alert.ts)}</span>
    </div>
    <div class="alert-title">${escapeHtml(alert.reason || '风险事件')}</div>
    <div class="alert-meta">
      <span>会话 ${escapeHtml(String(alert.sessionId || '-'))}</span>
      <span>访客 ${escapeHtml(alert.visitorName || '未知')}</span>
      <span>客服 ${escapeHtml(alert.agentName || '未分配')}</span>
      <span>客服组 ${escapeHtml(alert.groupName || '未分组')}</span>
      <span>评分 ${alert.score ?? '-'}</span>
    </div>
    ${tags ? `<div class="alert-tags">${tags}</div>` : ''}
    ${evidence}
    <div class="alert-reason"><strong>建议：</strong>${escapeHtml(alert.suggestion || '')}</div>
    <div class="alert-foot">
      <span>来源 ${escapeHtml(alert.source || 'rules')}</span>
      ${notifyText ? `<span class="notify ${notify}">${notifyText}</span>` : ''}
      <span>#${escapeHtml(String(alert.id || '').slice(-6))}</span>
    </div>
  `;
  return el;
}

function escapeHtml(text) {
  return String(text ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function addAlert(alert, prepend = true) {
  state.alerts.unshift(alert);
  if (state.alerts.length > 120) state.alerts.pop();
  if (state.paused) {
    updateBadge();
    return;
  }
  const empty = $('#emptyState');
  if (empty) empty.remove();
  const el = renderAlert(alert);
  const list = $('#alertList');
  if (prepend) list.prepend(el);
  else list.append(el);
  if (!alertVisible(alert.level, alert.groupName)) el.classList.add('hidden');
  updateBadge();
}

function updateBadge() {
  if (state.paused) setStatus('offline', `已暂停 · 新增 ${state.alerts.length} 条`);
  else if (state.online) setStatus('online', '采集在线');
}

async function loadRecentAlerts() {
  try {
    const res = await fetch('/api/alerts?limit=40');
    const data = await res.json();
    for (const alert of (data.alerts || []).reverse()) {
      const el = renderAlert(alert);
      if (!alertVisible(alert.level, alert.groupName)) el.classList.add('hidden');
      const empty = $('#emptyState');
      if (empty) empty.remove();
      $('#alertList').append(el);
    }
  } catch {}
}

function connectSSE() {
  const es = new EventSource('/api/events');
  es.onopen = () => setStatus('online', '服务已连接');
  es.onerror = () => setStatus('offline', '服务断开，重连中…');
  es.addEventListener('hello', (ev) => {
    try { updateStats(JSON.parse(ev.data)); } catch {}
  });
  es.addEventListener('alert', (ev) => {
    try { addAlert(JSON.parse(ev.data)); } catch {}
  });
  es.addEventListener('account', (ev) => {
    try { renderAccount(JSON.parse(ev.data)); } catch {}
  });

}

async function simulate() {
  const btn = $('#simulateBtn');
  btn.disabled = true;
  btn.textContent = '已发送…';
  try {
    await fetch('/api/simulate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ preset: 'high', sessionId: 'demo-' + Date.now() })
    });
  } finally {
    setTimeout(() => { btn.disabled = false; btn.textContent = '模拟高危告警'; }, 1200);
  }
}

function bind() {
  $('#toggleIframe').addEventListener('click', (ev) => {
    const layout = $('#layout');
    layout.classList.toggle('risk-only');
    const hidden = layout.classList.contains('risk-only');
    ev.target.textContent = hidden ? '显示工作台' : '隐藏工作台';
    const frame = $('#qiyuFrame');
    if (!hidden && state.qiyuWorkspaceUrl && (!frame.src || frame.src === 'about:blank')) {
      frame.src = state.qiyuWorkspaceUrl;
    }
  });

  $('#resetFrame').addEventListener('click', () => {
    const frame = $('#qiyuFrame');
    const url = state.qiyuWorkspaceUrl || frame.src;
    frame.src = 'about:blank';
    setTimeout(() => { frame.src = url; }, 60);
  });

  $('#toggleWorkspace').addEventListener('click', (ev) => {
    const layout = $('#layout');
    layout.classList.toggle('workspace-only');
    ev.target.textContent = layout.classList.contains('workspace-only') ? '恢复双栏' : '全屏工作台';
  });

  $('#pauseBtn').addEventListener('click', (ev) => {
    state.paused = !state.paused;
    ev.target.textContent = state.paused ? '继续监控' : '暂停监控';
    if (!state.paused) setStatus(state.online ? 'online' : 'offline', state.online ? '采集在线' : '采集离线');
  });

  $('#simulateBtn').addEventListener('click', simulate);

  $('#llmBtn').addEventListener('click', openLlmModal);
  $('#llmClose').addEventListener('click', () => { $('#llmModal').hidden = true; });
  $('#llmModal').addEventListener('click', (ev) => {
    if (ev.target === $('#llmModal')) $('#llmModal').hidden = true;
  });
  $('#llmSave').addEventListener('click', saveLlm);
  $('#llmTest').addEventListener('click', testLlm);

  $('#sessionClose').addEventListener('click', () => { $('#sessionModal').hidden = true; });
  $('#sessionCloseBtn').addEventListener('click', () => { $('#sessionModal').hidden = true; });
  $('#sessionModal').addEventListener('click', (ev) => {
    if (ev.target === $('#sessionModal')) $('#sessionModal').hidden = true;
  });

  const groupBtn = $('#groupFilterBtn');
  if (groupBtn) {
    groupBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const panel = $('#groupFilterPanel');
      if (panel) panel.hidden = !panel.hidden;
    });
  }
  const groupPanel = $('#groupFilterPanel');
  if (groupPanel) {
    groupPanel.addEventListener('change', (ev) => {
      const cb = ev.target.closest('input[type=checkbox]');
      if (!cb) return;
      const name = cb.value;
      if (cb.checked) {
        if (!state.groups.includes(name)) state.groups.push(name);
      } else {
        state.groups = state.groups.filter((g) => g !== name);
      }
      updateGroupButton();
      applyFilter();
    });
  }
  document.addEventListener('click', (ev) => {
    const wrap = $('#groupFilterWrap');
    if (!wrap || wrap.contains(ev.target)) return;
    const panel = $('#groupFilterPanel');
    if (panel) panel.hidden = true;
  });

  $('#filters').addEventListener('click', (ev) => {
    const chip = ev.target.closest('.chip');
    if (!chip) return;
    state.filter = chip.dataset.level;
    applyFilter();
  });
}

async function openLlmModal() {
  const modal = $('#llmModal');
  modal.hidden = false;
  $('#llmStatus').textContent = '';
  try {
    const res = await fetch('/api/settings/llm');
    const cfg = await res.json();
    $('#llmEnabled').checked = Boolean(cfg.enabled);
    $('#llmBaseUrl').value = cfg.baseUrl || '';
    $('#llmModel').value = cfg.model || '';
    $('#llmApiKey').value = '';
    $('#llmKeyHint').textContent = cfg.hasKey ? `已配置：${cfg.keyMasked}` : '未配置 Key';
  } catch (err) {
    $('#llmStatus').textContent = '读取配置失败：' + err.message;
  }
}

async function saveLlm() {
  const status = $('#llmStatus');
  status.textContent = '保存中…';
  try {
    const res = await fetch('/api/settings/llm', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        enabled: $('#llmEnabled').checked,
        baseUrl: $('#llmBaseUrl').value.trim(),
        model: $('#llmModel').value.trim(),
        apiKey: $('#llmApiKey').value
      })
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || '保存失败');
    status.textContent = '已保存并生效';
    $('#llmApiKey').value = '';
    $('#llmKeyHint').textContent = data.hasKey ? '已配置（重启后仍保留）' : '未配置 Key';
    await loadConfig();
  } catch (err) {
    status.textContent = '保存失败：' + err.message;
  }
}

async function testLlm() {
  const status = $('#llmStatus');
  status.textContent = '测试中…';
  try {
    const res = await fetch('/api/settings/llm/test', { method: 'POST' });
    const data = await res.json();
    status.textContent = data.ok ? '连接成功' : `连接失败：${data.error || data.status}`;
  } catch (err) {
    status.textContent = '测试失败：' + err.message;
  }
}

function updateAlertGroupsBtn() {
  const btn = $('#alertGroupsBtn');
  if (!btn) return;
  btn.textContent = state.monitorGroups.length ? `告警组：${state.monitorGroups.length} 个` : '告警组：全部';
}

function openAlertGroupsModal() {
  const list = $('#alertGroupsList');
  const groups = [...(state.groupList || [])].sort((a, b) => a.localeCompare(b, 'zh-CN'));
  list.innerHTML = groups.length
    ? groups.map((name) => `<label><input type="checkbox" value="${escapeHtml(name)}" ${state.monitorGroups.includes(name) ? 'checked' : ''}> <span>${escapeHtml(name)}</span></label>`).join('')
    : '<p class="modal-hint">暂未获取到客服组，请稍后再试。</p>';
  $('#alertGroupsModal').hidden = false;
}

async function saveAlertGroups() {
  const checked = [...document.querySelectorAll('#alertGroupsList input:checked')].map((el) => el.value);
  const btn = $('#alertGroupsSave');
  btn.disabled = true;
  btn.textContent = '保存中…';
  try {
    const res = await fetch('/api/monitor-groups', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ groups: checked })
    });
    const data = await res.json();
    if (!data.ok) throw new Error('保存失败');
    state.monitorGroups = data.monitorGroups || [];
    updateAlertGroupsBtn();
    $('#alertGroupsModal').hidden = true;
  } catch (err) {
    const list = $('#alertGroupsList');
    list.insertAdjacentHTML('afterbegin', `<p class="modal-status">保存失败：${escapeHtml(err.message)}</p>`);
  } finally {
    btn.disabled = false;
    btn.textContent = '保存';
  }
}

async function openSessionModal(sessionId) {
  const modal = $('#sessionModal');
  modal.hidden = false;
  $('#sessionTitle').textContent = `会话 ${sessionId}`;
  $('#sessionMeta').textContent = '加载中…';
  $('#sessionMessages').innerHTML = '';
  const openBtn = $('#sessionOpenQiyu');
  if (openBtn) openBtn.href = state.qiyuWorkspaceUrl || '#';
  try {
    const res = await fetch('/api/session?id=' + encodeURIComponent(sessionId));
    const data = await res.json();
    const session = data.session;
    if (!session) {
      $('#sessionMeta').textContent = '未找到该会话（可能已结束或未被采集）';
      return;
    }
    $('#sessionMeta').textContent = `访客 ${session.meta.visitorName || '未知'} · 客服 ${session.meta.agentName || '未分配'}`;
    const msgs = (session.messages || []).slice(-60);
    $('#sessionMessages').innerHTML = msgs.map((m) => `
      <div class="chat-row ${m.direction === 'agent' ? 'agent' : 'visitor'}">
        <span class="chat-who">${m.direction === 'agent' ? '客服' : '访客'}</span>
        <span class="chat-text">${escapeHtml(m.text)}</span>
        <span class="chat-time">${fmtTime(m.ts)}</span>
      </div>`).join('');
  } catch (err) {
    $('#sessionMeta').textContent = '加载失败：' + err.message;
  }
}

async function main() {
  bind();
  await loadConfig();
  await loadHealth();
  await loadRecentAlerts();
  connectSSE();
  setInterval(loadHealth, 5000);
  const params = new URLSearchParams(location.search);
  const sid = params.get('session');
  if (sid) openSessionModal(sid);
}

main();
