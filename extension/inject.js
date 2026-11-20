// 运行在七鱼页面 MAIN world：只读 hook，不修改任何业务数据。
(function () {
  if (window.__QIYU_RISK_INJECTED__) return;
  window.__QIYU_RISK_INJECTED__ = true;

  var MAX_FRAME = 300000;
  var MAX_PER_SECOND = 40;
  var queue = [];
  var sentThisSecond = 0;
  var secondStart = Date.now();
  var timer = null;

  function post(frames) {
    try {
      window.postMessage({ __qrm: 1, frames: frames }, '*');
    } catch (e) {}
  }

  function flush() {
    timer = null;
    if (!queue.length) return;
    var batch = queue;
    queue = [];
    post(batch);
  }

  function push(frame) {
    var now = Date.now();
    if (now - secondStart >= 1000) {
      secondStart = now;
      sentThisSecond = 0;
    }
    if (sentThisSecond >= MAX_PER_SECOND) return;
    if (!frame || typeof frame.data !== 'string') return;
    if (frame.data.length > MAX_FRAME) frame.data = frame.data.slice(0, MAX_FRAME);
    if (!frame.data) return;
    sentThisSecond++;
    frame.ts = now;
    queue.push(frame);
    if (queue.length >= 20) {
      if (timer) { clearTimeout(timer); timer = null; }
      flush();
    } else if (!timer) {
      timer = setTimeout(flush, 120);
    }
  }

  function classify(url) {
    try {
      var host = new URL(url, location.href).hostname;
      return /qiyukf\.com$/.test(host);
    } catch (e) {
      return false;
    }
  }

  // ---- WebSocket（七鱼实时消息主通道）----
  var NativeWS = window.WebSocket;
  if (NativeWS) {
    var WrappedWS = new Proxy(NativeWS, {
      construct: function (target, args) {
        var ws = new target(args[0], args[1]);
        try {
          ws.addEventListener('message', function (ev) {
            var url = String(args[0] || '');
            if (!classify(url)) return;
            if (typeof ev.data === 'string') {
              push({ transport: 'ws', url: url, data: ev.data });
            } else if (ev.data && typeof ev.data.text === 'function') {
              try {
                ev.data.text().then(function (text) {
                  if (text) push({ transport: 'ws', url: url, data: text });
                }).catch(function () {});
              } catch (e) {}
            }
          });
        } catch (e) {}
        return ws;
      }
    });
    try {
      Object.defineProperty(window, 'WebSocket', {
        configurable: true,
        enumerable: true,
        get: function () { return WrappedWS; },
        set: function () {}
      });
    } catch (e) {}
  }

  // ---- fetch（轮询/接口兜底）----
  var nativeFetch = window.fetch;
  if (nativeFetch) {
    window.fetch = function (input, init) {
      var url = typeof input === 'string' ? input : (input && input.url) || '';
      var promise = nativeFetch.apply(this, arguments);
      if (classify(url)) {
        promise.then(function (res) {
          try {
            res.clone().text().then(function (text) {
              if (text) push({ transport: 'fetch', url: url, data: text });
            }).catch(function () {});
          } catch (e) {}
        }).catch(function () {});
      }
      return promise;
    };
  }

  // ---- XMLHttpRequest（老接口兜底）----
  var NativeXHR = window.XMLHttpRequest;
  if (NativeXHR && NativeXHR.prototype) {
    var nativeOpen = NativeXHR.prototype.open;
    var nativeSend = NativeXHR.prototype.send;
    NativeXHR.prototype.open = function (method, url) {
      try { this.__qrmUrl = String(url || ''); } catch (e) {}
      return nativeOpen.apply(this, arguments);
    };
    NativeXHR.prototype.send = function () {
      var xhr = this;
      try {
        xhr.addEventListener('load', function () {
          try {
            var url = xhr.__qrmUrl || '';
            if (!classify(url)) return;
            var text = xhr.responseText;
            if (typeof text === 'string') push({ transport: 'xhr', url: url, data: text });
          } catch (e) {}
        });
      } catch (e) {}
      return nativeSend.apply(this, arguments);
    };
  }

  // ---- 监控端主动轮询：全量会话 + 重点会话消息 ----
  var lastCt = {};
  var lastRound = {};

  function isMonitorPage() {
    return /\/monitor/i.test(location.pathname) || /\/osm\/page\/monitor/i.test(location.pathname);
  }

  function findToken() {
    var fallback = '';
    try {
      var urls = performance.getEntriesByType('resource').map(function (e) { return e.name; });
      for (var i = urls.length - 1; i >= 0; i--) {
        if (urls[i].indexOf('token=') < 0) continue;
        try {
          var u = new URL(urls[i]);
          var t = u.searchParams.get('token');
          if (!t) continue;
          if (u.hostname.indexOf('qiyukf.com') >= 0) {
            if (u.pathname.indexOf('/api/') === 0) return t;
            if (!fallback) fallback = t;
          }
        } catch (e) {}
      }
    } catch (e) {}
    if (fallback) return fallback;
    try {
      var q = new URL(location.href).searchParams.get('token');
      if (q) return q;
    } catch (e) {}
    return '';
  }

  function pushSessions(sessions) {
    for (var i = 0; i < sessions.length; i += 80) {
      push({
        transport: 'monitor',
        url: '/api/monitor/overview',
        data: JSON.stringify({ result: { sessions: sessions.slice(i, i + 80) } })
      });
    }
  }

  async function pollMessages(sid, token) {
    try {
      var ct = lastCt[sid] || 0;
      var res = await fetch('/chat/api/message/list/new/msg?sid=' + encodeURIComponent(sid) + '&ct=' + ct + '&token=' + encodeURIComponent(token), { credentials: 'include' });
      var text = await res.text();
      if (!text || text.indexOf('"msgs"') < 0) return;
      push({ transport: 'monitor', url: '/chat/api/message/list/new/msg?sid=' + sid, data: text });
      try {
        var j = JSON.parse(text);
        var msgs = (j && j.result && j.result.msgs) || [];
        if (msgs.length) {
          var maxTime = 0;
          for (var i = 0; i < msgs.length; i++) {
            if (msgs[i].time > maxTime) maxTime = msgs[i].time;
          }
          if (maxTime) lastCt[sid] = maxTime + 1;
        }
      } catch (e) {}
    } catch (e) {}
  }

  async function pollGroups(token) {
    try {
      var res = await fetch('/api/kefuGroup/privilege?limit=100&offset=0&type=12&isInit=true&token=' + encodeURIComponent(token), { credentials: 'include' });
      var text = await res.text();
      push({ transport: 'monitor', url: '/api/kefuGroup/privilege?status=' + res.status, data: text || '(empty)' });
    } catch (e) {
      push({ transport: 'monitor', url: '/api/kefuGroup/privilege?error=1', data: String((e && e.message) || e) });
    }
    // 组列表已由 type=12 获取；客服→组映射通过 config/agent-groups.json 维护。
  }

  async function pollOverview() {
    if (!isMonitorPage()) return;
    var token = findToken();
    if (!token) return;
    try { window.postMessage({ __qrmToken: token, origin: location.origin }, '*'); } catch (e) {}
    pollGroups(token);
    try {
      var res = await fetch('/api/monitor/overview?token=' + encodeURIComponent(token), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'include',
        body: '{}'
      });
      var data = await res.json();
      var sessions = data && data.result && data.result.sessions;
      if (!Array.isArray(sessions)) return;
      var slim = sessions.map(function (s) {
        return {
          sessionId: s.sessionId, staffId: s.staffId, staffName: s.staffName,
          fromStaffOrGroup: s.fromStaffOrGroup, user: s.user, userId: s.userId,
          groupId: s.groupId, groupName: s.groupName, staffGroupId: s.staffGroupId,
          staffGroupName: s.staffGroupName, staffGroup: s.staffGroup,
          status: s.status, sessionTime: s.sessionTime, roundNumber: s.roundNumber,
          alerts: s.alerts || [], userSensitiveWords: s.userSensitiveWords || [],
          staffSensitiveWords: s.staffSensitiveWords || []
        };
      });
      pushSessions(slim);
      var targets = slim.filter(function (s) {
        if (s.status !== 1) return false;
        var key = String(s.sessionId);
        var changed = lastRound[key] === undefined || lastRound[key] !== s.roundNumber;
        return changed ||
          (s.userSensitiveWords && s.userSensitiveWords.length) ||
          (s.staffSensitiveWords && s.staffSensitiveWords.length);
      }).slice(0, 20);
      for (var t = 0; t < targets.length; t++) {
        lastRound[String(targets[t].sessionId)] = targets[t].roundNumber;
        await pollMessages(targets[t].sessionId, token);
      }
    } catch (e) {}
  }

  // 只读轮询：只查询会话总览与消息，不发送消息、不改会话状态。
  // 10 秒一轮；后台标签由 background alarms 兜底。
  if (isMonitorPage()) {
    setTimeout(pollOverview, 3000);
    setInterval(pollOverview, 10000);
  }

  // 页面卸载前尽量把队列发出去
  window.addEventListener('pagehide', function () {
    if (queue.length) flush();
  });
})();
