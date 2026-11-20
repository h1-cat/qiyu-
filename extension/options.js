const DEFAULT_ENDPOINT = 'http://127.0.0.1:8787';
const $ = (sel) => document.querySelector(sel);
const escapeHtml = (s) => String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function load() {
  const cfg = await chrome.storage.local.get({ endpoint: DEFAULT_ENDPOINT, dashboardUrl: '', alertGroups: [], groupOptions: [] });
  $('#endpoint').value = cfg.endpoint || DEFAULT_ENDPOINT;
  $('#dashboardUrl').value = cfg.dashboardUrl || '';
  const groups = Array.isArray(cfg.groupOptions) ? cfg.groupOptions : [];
  const selected = new Set((cfg.alertGroups || []).map((s) => String(s).trim()));
  const list = $('#groupList');
  if (!groups.length) {
    list.innerHTML = '<p class="hint">还没有采集到客服组，请先打开并登录七鱼监控页，扩展拉到组列表后这里会自动出现。</p>';
  } else {
    list.innerHTML = [...groups].sort((a, b) => a.localeCompare(b, 'zh-CN')).map((name) => `
      <label><input type="checkbox" value="${escapeHtml(name)}" ${selected.has(String(name).trim()) ? 'checked' : ''}> ${escapeHtml(name)}</label>`).join('');
  }
}

function endpointValue() {
  return $('#endpoint').value.trim().replace(/\/+$/, '') || DEFAULT_ENDPOINT;
}

async function save() {
  const endpoint = endpointValue();
  const dashboardUrl = $('#dashboardUrl').value.trim().replace(/\/+$/, '');
  const alertGroups = [...document.querySelectorAll('#groupList input:checked')].map((el) => el.value);
  await chrome.storage.local.set({ endpoint, dashboardUrl, alertGroups });
  $('#status').textContent = alertGroups.length ? `已保存：只采集 ${alertGroups.length} 个组` : '已保存：采集全部组';
}

async function testConnection() {
  const endpoint = endpointValue();
  $('#status').textContent = '连接中…';
  try {
    const res = await fetch(endpoint + '/api/health', { cache: 'no-store' });
    $('#status').textContent = res.ok ? '连接成功，服务器在线' : '连接失败：HTTP ' + res.status;
  } catch (err) {
    $('#status').textContent = '连接失败：' + (err?.message || err);
  }
}

$('#saveBtn').addEventListener('click', save);
$('#testBtn').addEventListener('click', testConnection);
load();
