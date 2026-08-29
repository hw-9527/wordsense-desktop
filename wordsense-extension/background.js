import {
  DEFAULT_SETTINGS,
  buildPrompt,
  parseLlmJson,
  extractMessageContent,
  cacheKey,
  wordCacheKey,
  normalizeBaseUrl,
} from "./lib/core.js";

const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 25000;
let settingsCache = null;
const inFlight = new Map();

// DeepSeek V4 系列默认开启思考模式，查词场景需要显式关闭
function isDeepseekV4(model) {
  return /deepseek-v4/i.test(String(model || ""));
}

// OpenAI 官方接口不识别 thinking 参数，跳过以避免报错
function isOpenAIBase(url) {
  return /openai\.com/i.test(String(url || ""));
}

async function getSettings() {
  if (settingsCache) return settingsCache;
  const stored = await chrome.storage.local.get("settings");
  settingsCache = { ...DEFAULT_SETTINGS, ...(stored.settings || {}) };
  return settingsCache;
}

async function saveSettings(next) {
  const merged = { ...DEFAULT_SETTINGS, ...(next || {}) };
  await chrome.storage.local.set({ settings: merged });
  settingsCache = merged;
  return merged;
}

async function fetchFull(text, context, settings, strict = false) {
  const url = normalizeBaseUrl(settings.baseUrl);
  const userContent = strict
    ? buildPrompt(text, context, settings) +
      "\n\n（严格模式）直接输出 JSON 对象本身，禁止任何解释、代码块、反引号或多余字符。"
    : buildPrompt(text, context, settings);
  const body = {
    model: settings.model,
    messages: [
      { role: "system", content: strict ? "你只输出 JSON。" : "只输出符合要求的 JSON。" },
      { role: "user", content: userContent },
    ],
    temperature: strict ? 0 : Number(settings.temperature) || 0.1,
    max_tokens: Number(settings.maxTokens) || 700,
  };
  if (isDeepseekV4(settings.model) || (settings.disableThinking !== false && !isOpenAIBase(url))) {
    body.thinking = { type: "disabled" }; // 自动关闭 DeepSeek V4 思考模式，保证查词快且输出稳定
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${settings.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    const aborted = err && err.name === "AbortError";
    return {
      ok: false,
      error: aborted ? "timeout" : "network",
      message: aborted
        ? "请求超时，请重试。"
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
      error: "bad-response",
      message: `服务返回了无法解析的内容（HTTP ${res.status}）。`,
    };
  }

  if (!res.ok) {
    const detail =
      (json &&
        json.error &&
        (json.error.message || json.error.code || json.error.type)) ||
      res.statusText ||
      res.status;
    return { ok: false, error: "api", message: `API 返回错误：${detail}` };
  }

  // 部分服务即使 HTTP 200 也会在 body 里带 error 字段
  if (json && json.error) {
    const detail = json.error.message || json.error.code || json.error.type || "";
    return { ok: false, error: "api", message: `API 返回错误：${detail}` };
  }

  const choice = json && json.choices && json.choices[0];
  const message = choice && choice.message;
  const content = extractMessageContent(message);
  if (!content) {
    const finish = choice && choice.finish_reason;
    const hasReasoning = message && message.reasoning_content;
    let hint = "";
    if (hasReasoning) {
      hint = "模型把输出都用于推理了，请在设置中改用 deepseek-v4-flash（插件会自动关闭思考模式）或增大「最大输出」。";
    } else if (finish === "length") {
      hint = "输出被截断，请在设置中增大「最大输出」。";
    } else if (finish === "content_filter") {
      hint = "回答被内容安全过滤，请更换模型或重试。";
    } else if (!json.choices || !json.choices.length) {
      hint = "服务没有返回候选结果，请检查模型名称是否与该服务商匹配。";
    }
    return { ok: false, error: "api", message: `API 返回中缺少回答内容。${hint}` };
  }

  const data = parseLlmJson(content);
  if (!data) {
    return {
      ok: false,
      error: "parse",
      message:
        "AI 返回的内容无法解析为结果。若反复出现，请把设置里的「最大输出」调大（如 1500），或改用 deepseek-v4-flash（插件会自动关闭思考模式）。",
      raw: String(content).slice(0, 500),
    };
  }
  return { ok: true, data };
}

async function fetchWithRetry(text, context, settings) {
  let full = await fetchFull(text, context, settings);
  if (!full.ok && full.error === "parse") {
    // 解析失败时用严格模式自动重试一次
    const retry = await fetchFull(text, context, settings, true);
    if (retry.ok) return retry;
    if (retry.error !== "parse") return retry;
  }
  return full;
}

async function storeResults(fullKey, data, wKey) {
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
  await chrome.storage.local.set({
    [fullKey]: { ts: Date.now(), data },
    [wKey]: { ts: Date.now(), data: quickData },
  });
}

async function lookup(text, context, requestId, senderTabId) {
  const settings = await getSettings();
  const fullKey = cacheKey(text, context);
  const stored = await chrome.storage.local.get(fullKey);
  if (stored[fullKey] && Date.now() - stored[fullKey].ts < CACHE_TTL_MS) {
    return { ok: true, data: stored[fullKey].data };
  }
  if (!settings.apiKey) {
    return { ok: false, error: "no-api-key", message: "尚未配置 API Key" };
  }

  // 常用词缓存：先秒回常用释义，同时在后台结合当前语境精读并推送更新
  const wKey = wordCacheKey(text);
  const wStored = await chrome.storage.local.get(wKey);
  const quick = wStored[wKey];
  if (quick && Date.now() - quick.ts < CACHE_TTL_MS) {
    if (senderTabId != null && !inFlight.has(fullKey)) {
      const p = fetchWithRetry(text, context, settings)
        .then(async (full) => {
          if (full.ok) {
            await storeResults(fullKey, full.data, wKey);
            chrome.tabs
              .sendMessage(senderTabId, {
                type: "lookup-update",
                requestId,
                data: full.data,
              })
              .catch(() => {});
          } else {
            chrome.tabs
              .sendMessage(senderTabId, {
                type: "lookup-error",
                requestId,
                message: full.message,
                raw: full.raw,
              })
              .catch(() => {});
          }
          return full;
        })
        .finally(() => inFlight.delete(fullKey));
      inFlight.set(fullKey, p);
    }
    return { ok: true, data: { ...quick.data, quick: true } };
  }

  if (inFlight.has(fullKey)) return inFlight.get(fullKey);
  const p = fetchWithRetry(text, context, settings)
    .then(async (full) => {
      if (full.ok) await storeResults(fullKey, full.data, wKey);
      return full;
    })
    .finally(() => inFlight.delete(fullKey));
  inFlight.set(fullKey, p);
  return p;
}

async function testConnection() {
  const settings = await getSettings();
  if (!settings.apiKey) return { ok: false, message: "请先填写 API Key" };
  const url = normalizeBaseUrl(settings.baseUrl);
  try {
    const body = {
      model: settings.model,
      messages: [{ role: "user", content: "回复 OK" }],
      max_tokens: 5,
    };
    if (isDeepseekV4(settings.model) || (settings.disableThinking !== false && !isOpenAIBase(url))) {
      body.thinking = { type: "disabled" };
    }
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${settings.apiKey}`,
      },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => null);
    if (!res.ok) {
      const detail =
        (json && json.error && json.error.message) || res.statusText || res.status;
      return { ok: false, message: `连接失败：${detail}` };
    }
    return { ok: true, message: "连接成功，可以开始查词了" };
  } catch (err) {
    return {
      ok: false,
      message: `网络错误：${(err && err.message) || err}`,
    };
  }
}

chrome.runtime.onInstalled.addListener((details) => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: "wordsense-lookup",
      title: "用「词境」理解选中内容",
      contexts: ["selection"],
    });
  });
  if (details && details.reason === "update") {
    chrome.storage.local.get("settings", (stored) => {
      const s = stored.settings;
      if (!s) return;
      const next = { ...s };
      let changed = false;
      if (!next.model) {
        next.model = DEFAULT_SETTINGS.model;
        changed = true;
      } else if (next.model === "gpt-4.1-mini") {
        next.model = DEFAULT_SETTINGS.model;
        changed = true;
      }
      if (next.maxTokens === 1200) {
        next.maxTokens = DEFAULT_SETTINGS.maxTokens;
        changed = true;
      }
      if (changed) chrome.storage.local.set({ settings: next });
    });
  }
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === "wordsense-lookup" && tab && tab.id != null) {
    chrome.tabs.sendMessage(tab.id, { type: "trigger-lookup" }).catch(() => {});
  }
});

chrome.commands.onCommand.addListener((command) => {
  if (command === "lookup-selection") {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs && tabs[0];
      if (tab && tab.id != null) {
        chrome.tabs.sendMessage(tab.id, { type: "trigger-lookup" }).catch(() => {});
      }
    });
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== "object") return;
  if (msg.type === "lookup") {
    const text = String((msg.payload && msg.payload.text) || "").slice(0, 500);
    const context = String((msg.payload && msg.payload.context) || "").slice(0, 350);
    const requestId = String((msg.payload && msg.payload.requestId) || "");
    const tabId = sender && sender.tab ? sender.tab.id : null;
    lookup(text, context, requestId, tabId).then(sendResponse);
    return true;
  }
  if (msg.type === "get-settings") {
    getSettings().then(sendResponse);
    return true;
  }
  if (msg.type === "save-settings") {
    saveSettings(msg.settings).then(sendResponse);
    return true;
  }
  if (msg.type === "test-connection") {
    testConnection().then(sendResponse);
    return true;
  }
});
