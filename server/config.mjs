import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = path.resolve(__dirname, '..');

function parseEnvFile(file) {
  const out = {};
  if (!existsSync(file)) return out;
  const text = readFileSync(file, 'utf8');
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

export function loadConfig(env = process.env) {
  const fileEnv = parseEnvFile(path.join(PROJECT_ROOT, '.env'));
  const get = (key, fallback = '') => {
    if (env[key] !== undefined && env[key] !== '') return String(env[key]);
    if (fileEnv[key] !== undefined && fileEnv[key] !== '') return String(fileEnv[key]);
    return fallback;
  };
  const num = (key, fallback) => {
    const n = Number(get(key, ''));
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };
  const bool = (key, fallback = false) => {
    const v = get(key, '').toLowerCase();
    if (!v) return fallback;
    return ['1', 'true', 'yes', 'on'].includes(v);
  };
  const dataDirRaw = get('DATA_DIR', './data');
  const dataDir = path.isAbsolute(dataDirRaw) ? dataDirRaw : path.resolve(PROJECT_ROOT, dataDirRaw);

  return {
    projectRoot: PROJECT_ROOT,
    port: num('PORT', 8787),
    host: get('HOST', '127.0.0.1'),
    qiyuWorkspaceUrl: get('QIYU_WORKSPACE_URL', 'https://example.qiyukf.com/onsite/monitor'),
    qiyuDomain: get('QIYU_DOMAIN', 'example.qiyukf.com'),
    embedWorkspace: bool('EMBED_WORKSPACE', false),
    qiyuAccountName: get('QIYU_ACCOUNT_NAME', ''),
    publicBaseUrl: get('PUBLIC_BASE_URL', 'http://127.0.0.1:8787').replace(/\/+$/, ''),
    dailySummaryTime: get('DAILY_SUMMARY_TIME', '23:59'),
    ignoreAgents: get('IGNORE_AGENTS', '').split(',').map((s) => s.trim()).filter(Boolean),
    feishuWebhook: get('FEISHU_WEBHOOK', ''),
    feishuSecret: get('FEISHU_SECRET', ''),
    monitorGroups: get('MONITOR_GROUPS', '').split(',').map((s) => s.trim()).filter(Boolean),
    alertMinLevel: (get('ALERT_MIN_LEVEL', 'medium') || 'medium').toLowerCase(),
    alertCooldownMin: num('ALERT_COOLDOWN_MIN', 10),
    llmEnabled: bool('LLM_ENABLED', false),
    llmBaseUrl: get('LLM_BASE_URL', 'https://api.deepseek.com').replace(/\/+$/, ''),
    llmApiKey: get('LLM_API_KEY', ''),
    llmModel: get('LLM_MODEL', 'deepseek-chat'),
    llmMode: (get('LLM_MODE', 'hybrid') || 'hybrid').toLowerCase(),
    dataDir
  };
}
