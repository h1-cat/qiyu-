import { analyzeWithRules } from './rules.mjs';

const LEVEL_RANK = { low: 0, medium: 1, high: 2 };
const LEVELS = new Set(['low', 'medium', 'high']);

function extractJson(text) {
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const raw = fenced ? fenced[1] : text;
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
}

async function callLLM({ config, message, sessionMessages, base }) {
  const history = sessionMessages
    .filter((m) => m.direction !== 'system')
    .slice(-21);
  const context = history
    .slice(0, -1)
    .map((m, i) => `${i + 1}. ${m.direction === 'agent' ? '客服' : '访客'}：${m.text.slice(0, 300)}`)
    .join('\n');

  const system = [
    '你是客服会话风险分析器。根据给出的会话上下文，判断最后一条消息的风险等级。',
    '只输出一个 JSON 对象，不要输出其他文字，格式：',
    '{"level":"low|medium|high","tags":["标签"],"reason":"判断理由","suggestion":"处置建议"}',
    '重要：必须区分访客和客服。',
    '- 必须结合上下文判断最后一条消息的真实意图，不要只看关键词。',
    '- 如果前文能解释这句话（开玩笑、求助、替客服打抱不平、转述别人的话），应降低风险等级。',
    '- 上下文里客服的解释、安抚、规则说明不能当作访客风险。',
    '- 访客风险：人身威胁、监管/媒体曝光、诈骗退款勒索、索要验证码/身份证、违法色情、投诉升级、强烈不满。',
    '- 客服风险：只有客服辱骂/歧视访客、私自承诺赔偿/返现、引导线下交易、索要验证码等敏感信息才算。',
    '- 客服的正常解释、安抚、拒绝退款、说明规则、提醒用户不要泄露验证码，都不算风险。',
    '- 客服在账号申诉、实名认证、账号找回、未成年退款等业务场景，要求访客提供姓名/身份证用于核验身份，属于正常业务流程，不算索要敏感信息风险；可建议用户通过官方渠道提交。',
    '- 客服索要短信验证码、支付密码仍算风险。',
    '- 访客主动提供姓名、身份证、手机号用于账号找回、换绑、实名核验，属于正常业务流程，不算索要敏感信息；可建议脱敏并通过官方渠道提交。',
    '- 客服说“退款/投诉/验证码”通常是在解释规则，不能按访客关键词判高危。',
    '- 客服自称“牛马”“打工人”等是团队人设/自嘲，不算不当用语；只有辱骂、贬低访客才算态度问题。',
    '- 访客替客服打抱不平、开玩笑、调侃（例如“你老板不给你发工资，必须举报”），举报对象不是平台/公司/客服，不算投诉或举报威胁，应为 low。',
    '- 只有访客明确投诉/举报平台、客服、产品或要求赔偿时，才算中风险。',
    '- 访客让官方/客服报警、求助报警（例如“官方，你快报警吧”），属于求助或紧急情况，不算监管投诉威胁；只有访客以报警威胁平台/客服时才计风险。',
    '- 游戏术语/正常咨询（滚服、白嫖皮肤、垃圾装备、打死某个怪、跳楼机）不算风险。',
    '- 只有明确指向平台、客服或访客本人安全的表达才算风险。',
    '- 拿不准时给 medium，不要轻易给 high。',
    '高风险：人身威胁、监管/媒体曝光、诈骗退款勒索、索要验证码/身份证/银行卡、违法色情、客服辱骂或私自承诺赔偿。',
    '中风险：投诉升级、要求上级/领导、律师/起诉威胁、强烈不满、客服态度问题、连续负面情绪。',
    '低风险：普通咨询、正常售后、一般抱怨、客服正常解释。'
  ].join('\n');

  const user = [
    `访客：${message.visitorName || '未知'}；客服：${message.agentName || '未分配'}`,
    `规则引擎初判：${base.level}，命中：${base.tags.join('、') || '无'}`,
    '【最近对话（按时间顺序）】',
    context || '（无）',
    '',
    '【待判断的消息（最后一条）】',
    `${message.direction === 'agent' ? '客服' : '访客'}：${message.text}`,
    '',
    '请结合上下文判断最后一条消息的真实意图；如果上下文能解释它（开玩笑、求助、转述、打抱不平），请降低等级。'
  ].join('\n');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(`${config.llmBaseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${config.llmApiKey}`
      },
      body: JSON.stringify({
        model: config.llmModel,
        temperature: 0.1,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user }
        ]
      }),
      signal: controller.signal
    });
    if (!res.ok) throw new Error(`LLM HTTP ${res.status}`);
    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content || '';
    return extractJson(content);
  } finally {
    clearTimeout(timer);
  }
}

// 同一会话同一规则十分钟内已被模型判为误判的，直接按低风险走，不再调模型
const LLM_MISS_TTL = 10 * 60 * 1000;
const missCache = new Map();

function missKey(message, base) {
  const ids = (base.hits || []).map((h) => h.id).sort().join('+');
  return `${message.sessionId}:${ids || base.level}`;
}

export async function analyzeMessage({ message, sessionMessages = [], negativeCount = 0, config, priority = false, logger = console, learned = null, onRuleMiss = null }) {
  const base = analyzeWithRules({ message, sessionMessages, negativeCount, learned });

  if (config.llmMode === 'rules') return base;
  if (!config.llmEnabled || !config.llmApiKey) return base;
  // hybrid：低风险跳过模型；重点会话或 full 模式则全部走模型
  if (config.llmMode !== 'full' && base.level === 'low' && !priority) return base;

  const key = missKey(message, base);
  const cached = missCache.get(key);
  if (cached && Date.now() - cached.at < LLM_MISS_TTL) {
    return {
      ...base,
      level: 'low',
      score: 10,
      reason: `同会话同规则 ${Math.max(1, Math.round((Date.now() - cached.at) / 60000))} 分钟前已由模型判为误判，本次不再调用模型。`,
      source: 'rules+llm-cached'
    };
  }
  if (missCache.size > 500) missCache.clear();

  try {
    const llm = await callLLM({ config, message, sessionMessages, base });
    if (!llm || !LEVELS.has(llm.level)) return base;

    let level = llm.level;
    let benign = false;
    // 规则高危但模型认为低危：有明确良性语境解释时采纳 low，否则保守降到中危
    if (base.level === 'high' && llm.level === 'low') {
      const why = String(llm.reason || '');
      const selfHarm = (base.hits || []).some((h) => h.id === 'self-harm');
      if (selfHarm) {
        // 自杀/自残类规则命中后，不允许模型降为低危
        level = 'high';
      } else {
        benign = /(游戏|玩笑|调侃|转述|求助|打抱不平|不是风险|并非|语境|术语|正常咨询|规则引擎|初判有误|误判|防诈骗|规则说明|正常解释)/.test(why);
        level = benign ? 'low' : 'medium';
      }
    } else if (base.level === 'medium' && llm.level === 'low' &&
               (base.hits || []).some((h) => h.id === 'escalation')) {
      // 规则命中投诉升级，但模型明确判断没有投诉意愿/风险较低时，允许降为低危
      const why = String(llm.reason || '');
      benign = /(风险较低|风险低|没有明确投诉|未出现投诉|没有强烈不满|无升级|只是确认|仅确认|没有投诉意愿|无投诉意愿|情绪平稳)/.test(why);
      level = benign ? 'low' : 'medium';
    }
    if (benign) {
      missCache.set(key, { at: Date.now(), reason: String(llm.reason || '').slice(0, 120) });
      onRuleMiss?.({ message, base, llm });
    }
    const merged = [...new Set([...(base.tags || []), ...(Array.isArray(llm.tags) ? llm.tags.map(String) : [])])].slice(0, 8);
    const tags = benign
      ? (Array.isArray(llm.tags) ? llm.tags.map(String).slice(0, 8) : [])
      : merged;
    return {
      ...base,
      level,
      tags,
      reason: llm.reason ? String(llm.reason).slice(0, 300) : base.reason,
      suggestion: llm.suggestion ? String(llm.suggestion).slice(0, 300) : base.suggestion,
      source: 'rules+llm'
    };
  } catch (err) {
    logger.warn?.(`[analyzer] LLM 调用失败，回落规则结果：${err?.message || err}`);
    return base;
  }
}
