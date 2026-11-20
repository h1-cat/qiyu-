import crypto from 'node:crypto';

const LEVEL_META = {
  high: { label: '高危', template: 'red', emoji: '🔴' },
  medium: { label: '中危', template: 'orange', emoji: '🟠' },
  low: { label: '低危', template: 'blue', emoji: '🔵' }
};

function truncate(text, max = 120) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max) + '…' : s;
}

function formatTime(ts) {
  const d = new Date(ts || Date.now());
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function buildCard(alert, config) {
  const meta = LEVEL_META[alert.level] || LEVEL_META.medium;
  const queueHint = /(正在努力接待|客服咨询量过大|请耐心等待|排队中|正快马加鞭)/;
  const visitorLine = (alert.evidence || []).filter((e) => e.direction === 'visitor').slice(-1)[0];
  const agentLine = (alert.evidence || [])
    .filter((e) => e.direction === 'agent' && !queueHint.test(e.text))
    .slice(-1)[0];
  const quote = [
    visitorLine ? `访客：${truncate(visitorLine.text)}` : '',
    agentLine ? `客服：${truncate(agentLine.text)}` : ''
  ].filter(Boolean).join('\n');

  const context = (alert.context || [])
    .map((m) => {
      const t = String(m.text || '');
      const safe = /^\s*\{[\s\S]*\}\s*$/.test(t) && /"ext"|"thumb"|"url"|"size"/.test(t) ? '[图片/文件]' : t;
      return `${m.direction === 'agent' ? '客服' : '访客'}：${safe.slice(0, 200)}`;
    })
    .join('\n');
  const summary = `**风险等级**：${meta.label}（${alert.score} 分）　**会话 ID**：${alert.sessionId}\n**访客**：${alert.visitorName || '未知'}　**客服**：${alert.agentName || '未分配（排队中）'}\n**客服组**：${alert.groupName || '未分组'}　**消息时间**：${formatTime(alert.messageTime || alert.ts)}\n**采集账号**：${alert.collector || config.qiyuAccountName || '-'}`;
  const elements = [
    { tag: 'markdown', content: summary },
    { tag: 'markdown', content: `**命中规则**\n${(alert.tags || []).join('、') || '无'}` },
    quote ? { tag: 'markdown', content: `**原文摘录**\n${quote}` } : null,
    { tag: 'markdown', content: `**判断理由**\n${truncate(alert.reason, 200)}` },
    { tag: 'markdown', content: `**处置建议**\n${truncate(alert.suggestion, 200)}` }
  ].filter(Boolean);

  if (context) {
    elements.push({
      tag: 'collapsible_panel',
      expanded: false,
      header: {
        title: { tag: 'markdown', content: '**查看完整会话**' },
        vertical_align: 'center',
        icon: { tag: 'standard_icon', token: 'down-small-ccm_outlined', size: '16px 16px' },
        icon_position: 'right',
        icon_expanded_angle: -180
      },
      border: { color: 'grey', corner_radius: '5px' },
      elements: [{ tag: 'markdown', content: context }]
    });
  }

  elements.push({
    tag: 'column_set',
    flex_mode: 'flow',
    horizontal_spacing: 'default',
    columns: [
      {
        tag: 'column',
        width: 'auto',
        elements: [{
          tag: 'button',
          text: { tag: 'plain_text', content: '查看会话详情' },
          url: `${config.publicBaseUrl}/?session=${encodeURIComponent(alert.sessionId)}`,
          type: 'primary'
        }]
      },
      {
        tag: 'column',
        width: 'auto',
        elements: [{
          tag: 'button',
          text: { tag: 'plain_text', content: '打开七鱼监控端' },
          url: config.qiyuWorkspaceUrl,
          type: 'default'
        }]
      }
    ]
  });
  elements.push({
    tag: 'markdown',
    content: `<font color='grey'>七鱼会话监控 server · ${formatTime(alert.ts)} · 来源：${alert.source || 'rules'}</font>`
  });

  return {
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: {
      template: meta.template,
      title: { tag: 'plain_text', content: `${meta.emoji}【${meta.label}】${alert.groupName || '未分组'}会话预警${alert.alertCount > 1 ? `（第${alert.alertCount}次）` : ''}` }
    },
    body: { elements }
  };
}

function sign(secret, timestamp) {
  const stringToSign = `${timestamp}\n${secret}`;
  return crypto.createHmac('sha256', stringToSign).update('').digest('base64');
}

export async function sendFeishu(config, alert, logger = console) {
  const card = buildCard(alert, config);
  const payload = { msg_type: 'interactive', card };

  if (!config.feishuWebhook) {
    logger.info?.('[feishu] dry-run（未配置 FEISHU_WEBHOOK），卡片 JSON：');
    logger.info?.(JSON.stringify(payload, null, 2));
    return { status: 'dry_run', card };
  }

  const body = { ...payload };
  if (config.feishuSecret) {
    const timestamp = Math.floor(Date.now() / 1000);
    body.timestamp = String(timestamp);
    body.sign = sign(config.feishuSecret, timestamp);
  }

  let lastError = '';
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10000);
      const res = await fetch(config.feishuWebhook, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal
      });
      clearTimeout(timer);
      const text = await res.text();
      let data = null;
      try { data = JSON.parse(text); } catch {}
      const ok = res.ok && (data?.code === 0 || data?.StatusCode === 0 || data?.status === 'ok' || data?.code === undefined);
      if (ok) return { status: 'sent', response: data ?? text };
      lastError = `HTTP ${res.status}: ${text.slice(0, 200)}`;
    } catch (err) {
      lastError = err?.message || String(err);
    }
    await new Promise((r) => setTimeout(r, attempt * 800));
  }
  logger.warn?.(`[feishu] 发送失败：${lastError}`);
  return { status: 'failed', error: lastError, card };
}

// 纯文本消息（用于采集离线提醒等系统通知）
export async function sendFeishuText(config, text, logger = console) {
  if (!config.feishuWebhook) {
    logger.info?.('[feishu] dry-run（未配置 FEISHU_WEBHOOK）');
    return { status: 'dry_run' };
  }
  const body = { msg_type: 'text', content: { text: String(text || '') } };
  if (config.feishuSecret) {
    const timestamp = Math.floor(Date.now() / 1000);
    body.timestamp = String(timestamp);
    body.sign = sign(config.feishuSecret, timestamp);
  }
  try {
    const res = await fetch(config.feishuWebhook, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    });
    const data = await res.json().catch(() => null);
    return { status: 'sent', response: data };
  } catch (err) {
    return { status: 'failed', error: err?.message || String(err) };
  }
}

// 质检/告警标签的简短描述
const TAG_DESC = {
  '投诉升级': '访客明确投诉或要求升级处理',
  '监管/媒体投诉': '提到 12315/12345/媒体曝光等监管渠道',
  '强烈不满': '访客情绪激烈、连续表达不满',
  '情绪升级': '负面情绪持续升级',
  '索要敏感信息': '涉及验证码/身份证等敏感信息',
  '自杀/自残倾向': '出现自杀/自残相关表达',
  '人身威胁/约架': '出现人身威胁或约架表达',
  '诈骗/退款勒索': '涉及退款勒索/诈骗类诉求',
  '客服违规承诺/导流': '客服违规承诺或引导线下交易',
  '客服态度问题': '客服表达不专业或态度问题',
  '唱衰/负面舆情': '出现唱衰/负面舆情表达',
  '客服正常解释': '客服在解释规则',
  '规则说明': '客服在说明规则',
  '防诈骗提醒': '客服做防诈骗提醒'
};

function shortDesc(tag, reason) {
  if (TAG_DESC[tag]) return TAG_DESC[tag];
  const s = String(reason || '').replace(/\s+/g, ' ').trim();
  const first = s.split(/[。！？；]/)[0] || s;
  return first.slice(0, 30);
}

// 每日监控日报卡片（蓝色）
export async function sendFeishuDaily(config, summary, logger = console) {
  if (!config.feishuWebhook) {
    logger.info?.('[feishu] dry-run（未配置 FEISHU_WEBHOOK）');
    return { status: 'dry_run' };
  }
  const medals = ['🥇', '🥈', '🥉', '4️⃣', '5️⃣'];
  const totalCount = (summary.topTags || []).reduce((sum, x) => sum + x.count, 0) || 1;
  const top = (summary.topTags || []).map((item, i) => {
    const desc = shortDesc(item.name, item.reason);
    const pct = Math.round((item.count / totalCount) * 100);
    return `${medals[i] || i + 1} **${item.name}**　<font color='red'>${item.count} 次</font> · 占比 ${pct}%${desc ? `\n　${desc}` : ''}`;
  }).join('\n\n') || '今日无告警';
  const pieValues = [
    { type: '高危', value: Number(summary.high) || 0 },
    { type: '中危', value: Number(summary.medium) || 0 }
  ].filter((x) => x.value > 0);
  const elements = [
    {
      tag: 'markdown',
      content: `📊 **今日概览**\n📨 消息 **${summary.messages}** 条　💬 会话 **${summary.sessions}** 个\n⚠️ 告警 **${summary.alerts}** 条（🔴 高危 ${summary.high} / 🟠 中危 ${summary.medium}）`
    }
  ];
  if (pieValues.length) {
    elements.push({ tag: 'hr' });
    elements.push({
      tag: 'chart',
      aspect_ratio: '2:1',
      height: '180px',
      chart_spec: {
        type: 'pie',
        title: { text: '告警等级占比' },
        color: ['#F54A45', '#FF8800', '#3370FF', '#34C724'],
        data: { values: pieValues },
        valueField: 'value',
        categoryField: 'type',
        outerRadius: 0.85,
        legends: { visible: true, orient: 'right' },
        label: { visible: true }
      }
    });
  }
  elements.push({ tag: 'hr' });
  elements.push({ tag: 'markdown', content: `🔝 **告警问题 TOP5**\n${top}` });
  elements.push({ tag: 'hr' });
  elements.push({ tag: 'markdown', content: `📡 **采集状态**：${summary.online ? '在线' : '离线'}` });
  const card = {
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: { template: 'turquoise', title: { tag: 'plain_text', content: `【七鱼监控日报】${summary.day}` } },
    body: { elements }
  };
  const body = { msg_type: 'interactive', card };
  if (config.feishuSecret) {
    const timestamp = Math.floor(Date.now() / 1000);
    body.timestamp = String(timestamp);
    body.sign = sign(config.feishuSecret, timestamp);
  }
  try {
    const res = await fetch(config.feishuWebhook, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    });
    const data = await res.json().catch(() => null);
    return { status: 'sent', response: data };
  } catch (err) {
    return { status: 'failed', error: err?.message || String(err) };
  }
}
