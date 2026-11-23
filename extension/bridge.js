// 运行在隔离世界：注入 MAIN world 脚本、转发帧、心跳。
(function () {
  var TAG = '[qiyu-risk]';
  var MAX_QUEUE = 200;
  var FLUSH_MS = 400;
  var queue = [];
  var flushTimer = null;
  var lastToken = '';

  function inject() {
    try {
      var src = chrome.runtime.getURL('inject.js');
      var s = document.createElement('script');
      s.src = src;
      s.async = false;
      s.dataset.qiyuRisk = '1';
      (document.head || document.documentElement).appendChild(s);
      s.onload = function () { try { s.remove(); } catch (e) {} };
    } catch (e) {
      console.warn(TAG, '注入失败', e);
    }
  }
  var injected = false;
  // 只在七鱼监控页注入采集脚本，其他七鱼标签页保持原样，避免影响页面加载。
  // 七鱼是单页应用，打开时可能先落在别的页面，路由变化时还会再调一次。
  function ensureInject() {
    if (injected || !isMonitorPage()) return;
    injected = true;
    inject();
  }
  ensureInject();

  // 带超时：MV3 下 background 没响应时消息回调可能永远不回来，
  // 不设超时会让浮层状态一直停在「检测中」。
  function send(message, timeoutMs) {
    return new Promise(function (resolve) {
      var done = false;
      var timer = setTimeout(function () {
        if (done) return;
        done = true;
        resolve(null);
      }, timeoutMs || 8000);
      function finish(resp) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(resp);
      }
      try {
        chrome.runtime.sendMessage(message, function (resp) {
          void chrome.runtime.lastError;
          finish(resp);
        });
      } catch (e) {
        finish(null);
      }
    });
  }

  function flush() {
    flushTimer = null;
    if (!queue.length) return;
    var batch = queue.splice(0, 20);
    send({ type: 'frames', frames: batch, pageUrl: location.href });
    if (queue.length) schedule();
  }

  function schedule() {
    if (flushTimer) return;
    flushTimer = setTimeout(flush, FLUSH_MS);
  }

  window.addEventListener('message', function (ev) {
    if (ev.source !== window) return;
    var data = ev.data;
    if (data && data.__qrmToken) {
      lastToken = data.__qrmToken;
      send({ type: 'monitor-token', token: data.__qrmToken, origin: data.origin });
      return;
    }
    if (!data || data.__qrm !== 1 || !Array.isArray(data.frames)) return;
    for (var i = 0; i < data.frames.length; i++) {
      var frame = data.frames[i];
      if (!frame || typeof frame.data !== 'string') continue;
      queue.push(frame);
      if (queue.length > MAX_QUEUE) queue.shift();
    }
    schedule();
  }, false);

  // 后台轮询需要 token 时，从页面缓存里取
  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (msg && msg.type === 'get-token') {
      sendResponse({ token: lastToken, origin: location.origin });
      return true;
    }
    return false;
  });

  // 从七鱼页面尽量读取当前登录的客服账号（localStorage / DOM / 标题）
  function clean(v) {
    if (typeof v !== 'string') return '';
    var s = v.replace(/\s+/g, ' ').trim();
    return s.length >= 1 && s.length <= 30 ? s : '';
  }

  // 页面标题、存储里常出现这些词，不是采集人名字，别当成账号
  var BAD_ACCOUNT = /^(web|login|home|index|default|网易七鱼|七鱼|登录|客服系统|工作台|客服中心|退出|退出登录|个人信息|账号|设置|消息|会话)$/i;
  function goodName(v) {
    var s = clean(v);
    return s && !BAD_ACCOUNT.test(s) ? s : '';
  }

  function pickAccount(obj, depth) {
    if (!obj || typeof obj !== 'object' || depth > 3) return null;
    var nameKeys = ['staffName', 'staff_name', 'nickName', 'nickname', 'displayName', 'name', 'userName', 'user_name'];
    var accKeys = ['staffAccount', 'staff_account', 'account', 'email', 'mobile', 'username'];
    var name = '', account = '';
    for (var i = 0; i < nameKeys.length; i++) { var nv = goodName(obj[nameKeys[i]]); if (nv) { name = nv; break; } }
    for (var j = 0; j < accKeys.length; j++) { var av = goodName(obj[accKeys[j]]); if (av) { account = av; break; } }
    if (name || account) return { name: name, account: account };
    var values = [];
    try { values = Object.keys(obj).slice(0, 40).map(function (k) { return obj[k]; }); } catch (e) {}
    for (var k = 0; k < values.length; k++) {
      var v = values[k];
      if (v && typeof v === 'object') {
        var hit = pickAccount(v, depth + 1);
        if (hit) return hit;
      }
    }
    return null;
  }

  function detectFromMenu() {
    try {
      var all = document.querySelectorAll('div,span,a,li,button');
      for (var i = 0; i < all.length; i++) {
        var el = all[i];
        var t = (el.textContent || '').replace(/\s+/g, ' ').trim();
        if (t !== '退出登录' && t !== '退出') continue;
        var p = el.parentElement;
        for (var d = 0; d < 3 && p; d++, p = p.parentElement) {
          var pt = (p.textContent || '').replace(/\s+/g, ' ').trim();
          var m = pt.match(/^(.{1,16}?)\s+(个人信息|退出登录)/);
          if (m && m[1] && m[1].length >= 2 && !/登录|退出|个人/.test(m[1]) && !BAD_ACCOUNT.test(m[1])) {
            return { name: m[1], account: '', source: 'dom-menu' };
          }
        }
      }
    } catch (e) {}
    return null;
  }

  function detectAccount() {
    // 登录页没有账号，直接跳过，避免把页面标题误当账号
    if (/\/login/i.test(location.pathname) || /\/login/i.test(location.href)) return null;
    var menu = detectFromMenu();
    if (menu) return menu;
    var stores = [];
    try { stores.push(window.localStorage); } catch (e) {}
    try { stores.push(window.sessionStorage); } catch (e) {}
    for (var s = 0; s < stores.length; s++) {
      var store = stores[s];
      if (!store) continue;
      try {
        for (var i = 0; i < store.length; i++) {
          var key = store.key(i) || '';
          if (!/staff|user|account|login|profile|agent/i.test(key)) continue;
          var raw = store.getItem(key);
          if (!raw || raw.length > 50000) continue;
          try {
            var hit = pickAccount(JSON.parse(raw), 0);
            if (hit) return { name: hit.name, account: hit.account, source: 'storage:' + key };
          } catch (e) {}
        }
      } catch (e) {}
    }
    var nodes = [];
    try {
      nodes = document.querySelectorAll('img[class*="avatar"],img[class*="staff"],[class*="staff-name"],[class*="nickname"]');
    } catch (e) {}
    for (var n = 0; n < nodes.length && n < 20; n++) {
      var el = nodes[n];
      var t = goodName(el.getAttribute && (el.getAttribute('title') || el.getAttribute('alt') || ''));
      if (t) return { name: t, account: '', source: 'dom' };
      if (/staff-name|nickname/.test(el.className || '')) {
        var text = goodName(el.textContent || '');
        if (text && text.length >= 2) return { name: text, account: '', source: 'dom' };
      }
    }
    var title = clean(document.title || '');
    var badTitle = /网易七鱼|七鱼|登录|客服系统|工作台|客服中心/;
    if (title && !badTitle.test(title)) {
      var parts = title.split(/[-|]/).map(function (x) { return x.trim(); }).filter(Boolean);
      if (parts.length >= 2 && parts[0].length <= 20 && !BAD_ACCOUNT.test(parts[0])) return { name: parts[0], account: '', source: 'title' };
    }
    return null;
  }

  function isMonitorPage() {
    return /\/monitor/i.test(location.pathname) || /\/osm\/page\/monitor/i.test(location.pathname);
  }

  var toastStart = 0;
  var toastTimer = null;

  function setToastStatus(mode) {
    var el = document.getElementById('qrm-toast-status');
    if (!el) return;
    if (mode === 'online') {
      el.textContent = '采集中 · 已同步服务器';
      el.style.color = '#37d39a';
    } else if (mode === 'local') {
      el.textContent = '连不上服务器 · 数据暂存';
      el.style.color = '#ffa940';
    } else if (mode === 'timeout') {
      el.textContent = '扩展没响应 · 刷新页面重试';
      el.style.color = '#ff5c5c';
    } else {
      el.textContent = '采集离线';
      el.style.color = '#ff5c5c';
    }
  }

  function showMonitorToast() {
    if (!isMonitorPage() || window.top !== window || document.getElementById('qrm-monitor-toast') || !document.body) return;
    var el = document.createElement('div');
    el.id = 'qrm-monitor-toast';
    el.style.cssText = 'position:fixed;right:24px;bottom:24px;z-index:2147483647;display:flex;gap:10px;align-items:flex-start;padding:12px 16px;border-radius:12px;background:#0f172a;color:#e8eefc;border:1px solid #37d39a;box-shadow:0 12px 32px rgba(0,0,0,.4);font:13px/1.5 system-ui,-apple-system,"Microsoft YaHei",sans-serif;opacity:0;transform:translateY(8px);transition:opacity .3s,transform .3s;';
    el.innerHTML = '<span style="width:9px;height:9px;margin-top:6px;border-radius:50%;background:#37d39a;box-shadow:0 0 8px #37d39a;flex:0 0 auto"></span><span><b style="display:block;margin-bottom:2px">七鱼会话监控已开始</b><span style="font-size:12px;opacity:.75"><span id="qrm-toast-status" style="color:#8fa1c7">检测中</span> · <span id="qrm-toast-time">已采集 0 秒</span></span></span><span id="qrm-toast-close" title="关闭提示" style="cursor:pointer;margin-left:6px;opacity:.55;font-size:16px;line-height:1;padding:0 2px">×</span>';
    document.body.appendChild(el);
    requestAnimationFrame(function () {
      el.style.opacity = '1';
      el.style.transform = 'translateY(0)';
    });
    toastStart = Date.now();
    if (toastTimer) clearInterval(toastTimer);
    toastTimer = setInterval(function () {
      var timeEl = document.getElementById('qrm-toast-time');
      var rootEl = document.getElementById('qrm-monitor-toast');
      if (!rootEl || !timeEl) {
        clearInterval(toastTimer);
        toastTimer = null;
        return;
      }
      var sec = Math.floor((Date.now() - toastStart) / 1000);
      timeEl.textContent = sec < 60
        ? '已采集 ' + sec + ' 秒'
        : '已采集 ' + Math.floor(sec / 60) + ' 分 ' + (sec % 60) + ' 秒';
    }, 1000);
    var close = el.querySelector('#qrm-toast-close');
    if (close) close.addEventListener('click', function () {
      if (toastTimer) {
        clearInterval(toastTimer);
        toastTimer = null;
      }
      el.remove();
    });
  }

  if (isMonitorPage()) setTimeout(showMonitorToast, 1200);
  var lastUrl = location.href;
  setInterval(function () {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      ensureInject();
      if (isMonitorPage()) startHeartbeat();
      showMonitorToast();
    }
  }, 1200);

  // 账号探测要扫全页 DOM，重页面上很慢，缓存 5 分钟，别每 20 秒扫一遍
  var cachedAccount = null;
  var accountAt = 0;
  function currentAccount() {
    var now = Date.now();
    if (cachedAccount && now - accountAt < 5 * 60 * 1000) return cachedAccount;
    try { cachedAccount = detectAccount(); } catch (e) { cachedAccount = null; }
    accountAt = now;
    return cachedAccount;
  }

  // 心跳：让监控台显示“采集在线”+ 当前七鱼账号
  async function heartbeat() {
    const resp = await send({ type: 'heartbeat', pageUrl: location.href, account: currentAccount() });
    if (resp) {
      setToastStatus(resp.local ? 'local' : 'online');
    } else if (document.getElementById('qrm-toast-status')) {
      // 只有浮层还在时才改状态，避免关掉提示后无谓报错
      setToastStatus('timeout');
    }
  }

  // 心跳不能只在脚本启动时注册一次：七鱼打开时可能先落在别的页面，
  // 等切到监控页才需要开始，用 flag 保证只注册一次。
  var heartbeatStarted = false;
  function startHeartbeat() {
    if (heartbeatStarted) return;
    heartbeatStarted = true;
    setTimeout(heartbeat, 1200);
    setInterval(heartbeat, 20000);
  }
  if (isMonitorPage()) startHeartbeat();
})();
