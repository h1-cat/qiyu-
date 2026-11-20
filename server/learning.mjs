import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';

const MIN_COUNT = 2;      // 同一规则同一短语，模型判误判 2 次后才生效
const MAX_PHRASE = 20;
const NEVER_LEARN = new Set(['self-harm']); // 自残/自杀规则永不学习，宁可误报

// 规则学习：模型把某条规则判成误判时，把命中的短语记下来；
// 同一短语达到次数阈值后，该规则在这句话上不再命中，避免反复误报和重复调模型。
export function createLearner({ file }) {
  let data = {};
  try {
    if (existsSync(file)) data = JSON.parse(readFileSync(file, 'utf8')) || {};
  } catch {}
  let timer = null;
  function flush() {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      try {
        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
      } catch {}
    }, 1500);
  }
  function record({ ruleId, phrase }) {
    const id = String(ruleId || '');
    const p = String(phrase || '').trim().slice(0, MAX_PHRASE);
    if (!id || NEVER_LEARN.has(id) || p.length < 2) return;
    const bucket = data[id] || (data[id] = {});
    const item = bucket[p] || (bucket[p] = { count: 0, at: 0 });
    item.count += 1;
    item.at = Date.now();
    flush();
  }
  function isWhitelisted(ruleId, text) {
    const bucket = data[ruleId];
    if (!bucket) return false;
    const t = String(text || '');
    for (const [phrase, item] of Object.entries(bucket)) {
      if (item.count >= MIN_COUNT && t.includes(phrase)) return true;
    }
    return false;
  }
  function list() {
    return data;
  }
  function remove(ruleId, phrase) {
    const bucket = data[ruleId];
    if (!bucket || !bucket[phrase]) return false;
    delete bucket[phrase];
    if (!Object.keys(bucket).length) delete data[ruleId];
    flush();
    return true;
  }
  return { record, isWhitelisted, list, remove };
}
