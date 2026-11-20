import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeWithRules, matchRules, sentimentOf } from '../server/rules.mjs';
import { normalizeFrames } from '../server/normalize.mjs';
import { Store } from '../server/store.mjs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

function msg(text, direction = 'visitor', ts = Date.now(), sessionId = 's1') {
  return { id: 'm-' + Math.random(), sessionId, direction, text, ts };
}

test('高危：监管/媒体投诉', () => {
  const m = msg('你们再不退款我就打12315，还要找媒体曝光你们！');
  const r = analyzeWithRules({ message: m, sessionMessages: [m], negativeCount: 1 });
  assert.equal(r.level, 'high');
  assert.ok(r.tags.includes('监管/媒体投诉'));
});

test('高危：人身威胁', () => {
  const r = analyzeWithRules({ message: msg('你信不信我找人弄死你，等着瞧'), sessionMessages: [], negativeCount: 1 });
  assert.equal(r.level, 'high');
  assert.ok(r.tags.includes('人身威胁/约架'));
});

test('高危：索要验证码', () => {
  const r = analyzeWithRules({ message: msg('把验证码发我，我帮你退款'), sessionMessages: [], negativeCount: 1 });
  assert.equal(r.level, 'high');
  assert.ok(r.tags.includes('索要敏感信息'));
});

test('中危：投诉升级', () => {
  const r = analyzeWithRules({ message: msg('这什么破服务，我要投诉你们，让你们领导来'), sessionMessages: [], negativeCount: 1 });
  assert.equal(r.level, 'medium');
  assert.ok(r.tags.includes('投诉升级'));
});

test('低危：普通咨询', () => {
  const r = analyzeWithRules({ message: msg('请问这个礼包什么时候到账？谢谢'), sessionMessages: [], negativeCount: 0 });
  assert.equal(r.level, 'low');
});

test('上下文升级：负面累计 3 条触发中危', () => {
  const now = Date.now();
  const history = [
    msg('太离谱了', 'visitor', now - 20000),
    msg('真的很失望', 'visitor', now - 10000),
    msg('无语', 'visitor', now - 5000),
    msg('你们处理一下', 'visitor', now)
  ];
  const r = analyzeWithRules({ message: history[3], sessionMessages: history, negativeCount: 4 });
  assert.equal(r.level, 'medium');
  assert.ok(r.tags.includes('情绪升级'));
});

test('sentiment 识别', () => {
  assert.equal(sentimentOf('气死我了，垃圾服务'), 'negative');
  assert.equal(sentimentOf('谢谢，辛苦了'), 'positive');
  assert.equal(sentimentOf('请问订单号是多少'), 'neutral');
});

test('normalize：从七鱼风格 WS 帧解析访客与客服消息', () => {
  const frames = [
    {
      transport: 'ws',
      data: JSON.stringify({
        data: {
          list: [
            { sessionId: 123, msgId: 1, content: '我要投诉12315', staffId: 0, from: 'user', sendTime: 1700000000000 },
            { sessionId: 123, msgId: 2, content: '我帮您核实一下', staffId: 88, sendTime: 1700000001000 }
          ]
        }
      })
    }
  ];
  const out = normalizeFrames(frames, { pageUrl: 'https://example.qiyukf.com/chat/worksheet/' });
  assert.equal(out.length, 2);
  assert.equal(out[0].direction, 'visitor');
  assert.equal(out[0].sessionId, '123');
  assert.equal(out[1].direction, 'agent');
});

test('Store：消息去重与告警冷却', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'qrm-'));
  try {
    const store = new Store({ dataDir: dir });
    await store.init();
    const m = msg('测试消息');
    assert.equal(store.addMessage(m), true);
    assert.equal(store.addMessage(m), false);
    assert.equal(store.stats.messages, 1);

    assert.equal(store.cooledDown('s1', 'high', 10), true);
    store.addAlert({ sessionId: 's1', level: 'high', ts: Date.now() });
    assert.equal(store.cooledDown('s1', 'high', 10), false);
    assert.equal(store.cooledDown('s1', 'medium', 10), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('matchRules 返回全部命中规则', () => {
  const hits = matchRules('我要投诉，还要12315曝光你们，垃圾服务');
  const ids = hits.map((h) => h.id);
  assert.ok(ids.includes('regulator'));
  assert.ok(ids.includes('escalation'));
  assert.ok(ids.includes('anger'));
});
