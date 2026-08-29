import { fetch } from '@tauri-apps/plugin-http';
import { load as loadStore } from '@tauri-apps/plugin-store';
import {
  buildPrompt,
  parseLlmJson,
  extractMessageContent,
  normalizeBaseUrl,
  cacheKey,
  wordCacheKey,
} from './lib/core.js';

const REQUEST_TIMEOUT_MS = 25000;
const CACHE_TTL_MS = 7 * 24 * 3600 * 1000; // 缓存有效期 7 天

// L1 内存缓存（瞬时读取 0ms）
const memoryCache = new Map();
// 正在并发请求的任务缓存（避免同一词句多次并发打 API）
const inFlight = new Map();

// ── Store Helper ────────────────────────────────────────────────────────────

let cacheStoreInstance = null;
async function getCacheStore() {
  if (!cacheStoreInstance) {
    try {
      cacheStoreInstance = await loadStore('cache.json');
    } catch (e) {
      console.warn('Failed to load cache.json store:', e);
    }
  }
  return cacheStoreInstance;
}

// ── Settings ────────────────────────────────────────────────────────────────

async function getSettings() {
  try {
    const store = await loadStore('settings.json');
    return {
      apiKey:          (await store.get('apiKey'))   || '',
      baseUrl:         (await store.get('baseUrl'))  || 'https://api.openai.com/v1',
      model:           (await store.get('model'))    || 'gpt-4.1-nano',
      temperature:     (await store.get('temperature'))  ?? 0.1,
      maxTokens:       (await store.get('maxTokens'))    || 700,
      autoExpand:      (await store.get('autoExpand'))   !== false,
      disableThinking: (await store.get('disableThinking')) !== false,
    };
  } catch (e) {
    console.error('Failed to load settings:', e);
    return {
      apiKey: '', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4.1-nano',
      temperature: 0.1, maxTokens: 700, autoExpand: true, disableThinking: true,
    };
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function isDeepseekV4(model) {
  return /deepseek-v4/i.test(String(model || ''));
}

function isOpenAIBase(url) {
  return /openai\.com/i.test(String(url || ''));
}

// ── Cache Store & Read ──────────────────────────────────────────────────────

async function readFromCache(fullKey) {
  // 1. 检查 L1 内存缓存
  const mem = memoryCache.get(fullKey);
  if (mem && Date.now() - mem.ts < CACHE_TTL_MS) {
    return mem.data;
  }

  // 2. 检查 L2 本地文件存储
  const store = await getCacheStore();
  if (store) {
    const disk = await store.get(fullKey);
    if (disk && disk.ts && Date.now() - disk.ts < CACHE_TTL_MS && disk.data) {
      memoryCache.set(fullKey, disk);
      return disk.data;
    }
  }
  return null;
}

async function saveToCache(fullKey, data, wKey) {
  const item = { ts: Date.now(), data };
  memoryCache.set(fullKey, item);

  const quickData = {
    query: data.query,
    type: data.type,
    phonetic: data.phonetic,
    pos: data.pos,
    meaningInContext: data.meaningInContext,
    meaningEn: data.meaningEn,
    otherMeanings: Array.isArray(data.otherMeanings)
      ? data.otherMeanings.slice(0, 3)
      : undefined,
  };
  const wItem = { ts: Date.now(), data: quickData };
  memoryCache.set(wKey, wItem);

  const store = await getCacheStore();
  if (store) {
    try {
      await store.set(fullKey, item);
      await store.set(wKey, wItem);
      await store.save();
    } catch (e) {
      console.warn('Failed to save to cache store:', e);
    }
  }
}

// ── Fetch ───────────────────────────────────────────────────────────────────

async function fetchFull(text, context, settings, strict = false) {
  const url = normalizeBaseUrl(settings.baseUrl);
  const userContent = strict
    ? buildPrompt(text, context, settings) +
      '\n\n（严格模式）直接输出 JSON 对象本身，禁止任何解释、代码块、反引号或多余字符。'
    : buildPrompt(text, context, settings);

  const body = {
    model: settings.model,
    messages: [
      { role: 'system', content: strict ? '你只输出 JSON。' : '只输出符合要求的 JSON。' },
      { role: 'user', content: userContent },
    ],
    temperature: strict ? 0 : Number(settings.temperature) || 0.1,
    max_tokens: Number(settings.maxTokens) || 700,
  };

  if (isDeepseekV4(settings.model) || (settings.disableThinking !== false && !isOpenAIBase(url))) {
    body.thinking = { type: 'disabled' };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${settings.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    return {
      ok: false,
      error: 'network',
      message: err.name === 'AbortError'
        ? '请求超时，请检查网络或更换更快的模型。'
        : `无法连接到 ${url}，请检查网络或 API 地址。`,
    };
  }
  clearTimeout(timer);

  let json;
  try {
    json = await res.json();
  } catch {
    return {
      ok: false,
      error: 'bad-response',
      message: `服务返回了无法解析的内容（HTTP ${res.status}）。`,
    };
  }

  if (!res.ok) {
    const detail =
      (json && json.error && (json.error.message || json.error.code || json.error.type)) ||
      res.statusText ||
      res.status;
    return { ok: false, error: 'api', message: `API 返回错误：${detail}` };
  }

  if (json && json.error) {
    const detail = json.error.message || json.error.code || json.error.type || '';
    return { ok: false, error: 'api', message: `API 返回错误：${detail}` };
  }

  const choice  = json && json.choices && json.choices[0];
  const message = choice && choice.message;
  const content = extractMessageContent(message);

  if (!content) {
    const finish       = choice && choice.finish_reason;
    const hasReasoning = message && message.reasoning_content;
    let hint = '';
    if (hasReasoning) {
      hint = '模型把输出都用于推理了，请在设置中改用 deepseek-v4-flash 或增大「最大输出」。';
    } else if (finish === 'length') {
      hint = '输出被截断，请在设置中增大「最大输出」。';
    } else if (finish === 'content_filter') {
      hint = '回答被内容安全过滤，请更换模型或重试。';
    } else if (!json.choices || !json.choices.length) {
      hint = '服务没有返回候选结果，请检查模型名称是否与该服务商匹配。';
    }
    return { ok: false, error: 'api', message: `API 返回中缺少回答内容。${hint}` };
  }

  const data = parseLlmJson(content);
  if (!data) {
    return {
      ok: false,
      error: 'parse',
      message:
        'AI 返回的内容无法解析为结果。请把「最大输出」调大或改用其他模型。',
      raw: String(content).slice(0, 500),
    };
  }
  return { ok: true, data };
}

async function fetchWithRetry(text, context, settings) {
  let result = await fetchFull(text, context, settings);
  if (!result.ok && result.error === 'parse') {
    const retry = await fetchFull(text, context, settings, true);
    if (retry.ok) return retry;
    if (retry.error !== 'parse') return retry;
  }
  return result;
}

// ── Public API ──────────────────────────────────────────────────────────────

export async function lookupWord(text, context) {
  const fullKey = cacheKey(text, context);
  const wKey = wordCacheKey(text);

  // 1. 命中完整上下文缓存直接 0ms 秒出
  const cached = await readFromCache(fullKey);
  if (cached) {
    return { ok: true, data: cached };
  }

  const settings = await getSettings();
  if (!settings.apiKey) {
    return { ok: false, error: 'no-api-key', message: '尚未配置 API Key' };
  }

  // 2. 避免同一词句重复发起多次相同并发请求
  if (inFlight.has(fullKey)) {
    return inFlight.get(fullKey);
  }

  const task = fetchWithRetry(text, context, settings)
    .then(async (result) => {
      if (result.ok && result.data) {
        await saveToCache(fullKey, result.data, wKey);
      }
      return result;
    })
    .finally(() => inFlight.delete(fullKey));

  inFlight.set(fullKey, task);
  return task;
}
