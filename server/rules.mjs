export const RULE_VERSION = '0.1.0';

export const DEFAULT_RULES = {
  high: [
    { id: 'threat', label: '人身威胁/约架', re: /(弄死你|打死你|砍死你|杀了你|揍死你|找人弄你|找人收拾|上门找你|上门堵|堵你|人肉你|报复你|等着瞧|削你)/i },
    { id: 'self-harm', label: '自杀/自残倾向', re: /(喝农药|买个?农药|农药.{0,4}喝|跳楼|跳下去|我去跳了|我跳了|想跳了|去跳了|割腕|自杀|轻生|不想活|活不下去|不活了|安眠药|上吊|烧炭|寻死|结束生命|死了算了|一了百了)/i },
    { id: 'regulator', label: '监管/媒体投诉', re: /((?<!\d)12315(?!\d)|(?<!\d)12345(?!\d)|市场监管局|市场监督|工商局|消协|消费者协会|媒体曝光|找记者|曝光你们|抖音曝光|微博曝光|小红书曝光|报警抓|报警处理|报警举报|我就报警|我要报警|再不.{0,8}报警|不处理.{0,8}报警|起诉你们|法院见|律师函)/i },
    { id: 'fraud', label: '诈骗/退款勒索', re: /(仅退款|退款不退货|白嫖.{0,6}(退款|赔偿|不付钱)|讹你|讹诈|十倍赔偿|假一赔十|精神损失费|不赔就)/i },
    { id: 'privacy', label: '索要敏感信息', re: /((验证码|短信验证码|身份证号?|银行卡号|支付密码|登录密码|家庭住址|手持身份证).{0,8}(发我|给我|提供|报一下|说一下))|((发我|给我|提供|发送|报一下).{0,8}(验证码|身份证|银行卡|密码))/i },
    { id: 'illegal', label: '违法/色情内容', re: /(色情|裸聊|约炮|毒品|赌博|洗钱|刷单|博彩)/i },
    { id: 'agent-violation', label: '客服违规承诺/导流', re: /(保证100%|100%能|绝对能(赔|退|到账|解封|解决|恢复)|肯定能(赔|退|到账|解封|解决|恢复)|私下转|加我微信转|支付宝转你|线下交易|给你返现|内部渠道|包过)/i }
  ],
  medium: [
    { id: 'escalation', label: '投诉升级', re: /(投诉你们|我要投诉|举报你们|给差评|曝光你们|没人管|没人处理|管不管|没人回|没看见.{0,4}处理|不处理|没人解决|处理不了|找你们领导|叫你们领导|你们领导|上级|经理|主管|负责人|给个说法)/i },
    { id: 'negative-buzz', label: '唱衰/负面舆情', re: /(倒闭|关服|停服|跑路|黄了|要凉|没人玩|游戏要没|这游戏完了|快凉了)/i },
    { id: 'anger', label: '强烈不满情绪', re: /(垃圾服务|垃圾游戏|垃圾客服|垃圾公司|恶心死|气死我|什么破游戏|破游戏|滚开|滚蛋|滚出去|闭嘴|废物|智障|脑残|坑人|骗钱)/i },
    { id: 'agent-attitude', label: '客服态度问题', re: /(你什么态度|爱玩不玩|自己看|别问了|爱要不要|随便你)/i }
  ]
};

export const NEGATIVE_RE = /(垃圾|恶心|气死|什么破|破游戏|垃圾服务|滚|闭嘴|废物|智障|脑残|坑人|骗钱|投诉|举报|差评|退款|退钱|没人管|曝光|起诉|报警|生气|失望|无语|离谱|恶心死|受不了)/i;

const SUGGESTIONS = {
  threat: '立即升级主管/安保并保留证据，评估是否报警；避免与访客对骂。',
  'self-harm': '立即升级主管并安排专人安抚，评估是否需要报警/联系急救，保留证据，优先保障访客生命安全。',
  regulator: '24 小时内由客诉/法务负责人介入，统一口径，避免二次激化。',
  fraud: '核实订单与退款记录，按平台规则处理，拒绝私下赔付或脱离平台交易。',
  privacy: '停止索要敏感信息，引导官方渠道；排查是否存在信息泄露。',
  illegal: '保留证据并升级合规/法务，必要时上报平台与公安机关。',
  'agent-violation': '复核客服话术，撤回不当承诺，主管介入纠正并留档。',
  escalation: '主管尽快介入安抚，给出明确处理时限和方案，避免升级为舆情。',
  'negative-buzz': '关注舆情走向，客服安抚并收集具体诉求，必要时上报运营/公关评估。',
  anger: '先共情安抚，确认诉求，必要时转主管；避免机械话术。',
  'agent-attitude': '提醒客服规范用语，主管复核服务态度并安排复盘。',
  default: '持续关注该会话，必要时人工复核。'
};

const NOISE_RE = /(欢迎咨询|温馨提醒|账号安全|自动回复|系统消息|工单已|不要向任何人提供|感谢您的咨询|滚服|白嫖皮肤|垃圾装备|打死这个怪|跳楼机)/i;

export function matchRules(text, rules = DEFAULT_RULES) {
  const hits = [];
  if (!text || NOISE_RE.test(text)) return hits;
  for (const [level, list] of Object.entries(rules)) {
    for (const rule of list) {
      if (rule.re.test(text)) {
        const m = text.match(rule.re);
        hits.push({ level, id: rule.id, label: rule.label, m: m ? m[0] : '' });
      }
    }
  }
  return hits;
}

export function sentimentOf(text) {
  if (!text) return 'neutral';
  if (NEGATIVE_RE.test(text)) return 'negative';
  if (/(谢谢|感谢|辛苦|满意|好评|可以|好的|没问题)/.test(text)) return 'positive';
  return 'neutral';
}

export function pickLevel(hits, negativeCount) {
  if (hits.some((h) => h.level === 'high')) return 'high';
  if (hits.some((h) => h.level === 'medium')) return 'medium';
  if (negativeCount >= 3) return 'medium';
  return 'low';
}

export function buildReason(hits, level, text) {
  if (hits.length === 0) {
    return level === 'medium' ? '最近 10 分钟内负面情绪消息累计达到阈值。' : '未命中风险规则。';
  }
  const labels = [...new Set(hits.map((h) => `「${h.label}」`))].join('、');
  const excerpt = (text || '').replace(/\s+/g, ' ').slice(0, 80);
  return `命中${labels}：${excerpt}`;
}

export function suggestionFor(hits) {
  if (!hits.length) return SUGGESTIONS.default;
  const first = hits.find((h) => h.level === 'high') || hits[0];
  return SUGGESTIONS[first.id] || SUGGESTIONS.default;
}

function rulesForDirection(direction) {
  const agent = direction === 'agent';
  return {
    high: DEFAULT_RULES.high.filter((rule) =>
      agent ? ['agent-violation', 'privacy', 'threat'].includes(rule.id) : rule.id !== 'agent-violation'
    ),
    medium: DEFAULT_RULES.medium.filter((rule) =>
      agent ? ['agent-attitude'].includes(rule.id) : rule.id !== 'agent-attitude'
    )
  };
}

export function analyzeWithRules({ message, sessionMessages = [], negativeCount = 0, now = Date.now(), learned = null }) {
  let hits = matchRules(message.text, rulesForDirection(message.direction));
  // 模型多次判为误判的短语，不再按规则命中（可在监控台撤销）
  if (learned) hits = hits.filter((h) => !learned.isWhitelisted(h.id, message.text));
  // 访客替客服打抱不平/调侃（如“你老板不给你发工资，必须举报”），不按投诉升级处理
  if (message.direction === 'visitor' &&
      /((你|你们)?老板.{0,10}工资|工资.{0,10}老板|同事|朋友).{0,20}(举报|投诉)|(举报|投诉).{0,20}(老板|工资|同事|朋友)/.test(message.text)) {
    hits = hits.filter((h) => h.id !== 'escalation');
  }
  // 客服在账号申诉/实名认证/账号找回等业务场景索要身份信息，属于正常核验流程
  if (message.direction === 'agent' &&
      /(申诉|实名|认证|找回|退款|未成年|绑定|核验|验证身份|工单|账号安全)/.test(message.text)) {
    hits = hits.filter((h) => h.id !== 'privacy');
  }
  // 客服在“不支持/禁止/谨防/避免”等否定语境下提到线下交易、私下转账，是在提醒，不是违规承诺
  if (message.direction === 'agent' &&
      /(不支持|禁止|不要|谨防|避免|切勿|不能|无法|请勿)/.test(message.text)) {
    hits = hits.filter((h) => h.id !== 'agent-violation');
  }
  // 访客主动提供姓名/身份证/手机号用于账号找回、换绑、实名核验，属于正常业务流程
  if (message.direction === 'visitor' &&
      /(我可以提供|我能提供|我会提供|主动提供|我的身份证|实名姓名|身份证号[:：]|换绑|账号找回|自助找回)/.test(message.text)) {
    hits = hits.filter((h) => h.id !== 'privacy');
  }
  // 访客表示“无法提供/不能提供”身份证，是在解释，不是索要
  if (message.direction === 'visitor' &&
      /(无法提供|没有办法提供|不能提供|不方便提供|不想提供|拒绝提供)/.test(message.text)) {
    hits = hits.filter((h) => h.id !== 'privacy');
  }
  const level = message.direction === 'visitor' ? pickLevel(hits, negativeCount) : pickLevel(hits, 0);
  const tags = [...new Set(hits.map((h) => h.label))];
  if (level === 'medium' && hits.length === 0) tags.push('情绪升级');

  const window = sessionMessages.filter((m) => m.ts >= now - 30 * 60 * 1000);
  const related = window
    .filter((m) => m.direction !== 'system')
    .slice(-6)
    .map((m) => ({ direction: m.direction, text: m.text.slice(0, 200), ts: m.ts }));
  // 窗口内没有历史消息时，至少把当前消息作为证据，避免卡片缺少原文
  if (!related.length) {
    related.push({ direction: message.direction, text: String(message.text || '').slice(0, 200), ts: message.ts || now });
  }

  const score = level === 'high' ? 90 + Math.min(9, hits.length) : level === 'medium' ? 60 + Math.min(19, hits.length * 5) : 10 + hits.length * 5;

  return {
    level,
    score,
    tags,
    hits,
    reason: buildReason(hits, level, message.text),
    suggestion: suggestionFor(hits),
    evidence: related,
    source: 'rules',
    ruleVersion: RULE_VERSION
  };
}
