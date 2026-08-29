// 词境 WordSense 核心逻辑（纯函数，方便测试）
// 此文件从浏览器扩展 lib/core.js 复制，桌面端与扩展共用

export const DEFAULT_SETTINGS = Object.freeze({
  apiKey: "",
  baseUrl: "https://api.openai.com/v1",
  model: "gpt-4.1-nano",
  temperature: 0.1,
  maxTokens: 700,
  autoExpand: true,
  disableThinking: true,
});

export function normalizeBaseUrl(baseUrl) {
  let url = String(baseUrl || "").trim().replace(/\/+$/, "");
  if (!url) url = DEFAULT_SETTINGS.baseUrl;
  if (/\/chat\/completions$/i.test(url)) return url;
  return url + "/chat/completions";
}

export function buildPrompt(selection, context, settings) {
  const autoExpand = settings.autoExpand !== false;
  const parts = [
    "你是顶尖的英语语言与语境分析专家。用户在阅读中选中了一个词或短语，需要你给出精准深刻的语境解释（以中文为主）。",
    "",
    `【上下文】${context || "（未提供独立上下文）"}`,
    `【选中词句】${selection}`,
    "",
    "核心要求：",
    "1. 判断类型：word | phrase | idiom | other；",
    "2. 若提供了【上下文】，必须深度结合所在句子的背景、语气和逻辑关系，给出该词在该处的具体精准含义，切忌机械罗列不相关的通用义项；",
    "3. 若未提供上下文，请基于常见权威用法给出最标准地道的含义，并在 meaningInContext 中自然解释，严禁出现“由于无上下文”、“无上下文时默认指”这类生硬的机械提示文字；",
  ];
  if (autoExpand) {
    parts.push("4. 若选中是单词且属于某个固定搭配或习语，用 phraseInfo 解释整个短语；");
  } else {
    parts.push("4. 若是单词，给出该语境含义；");
  }
  parts.push(
    "4. 其他常见含义最多 3 条，常用搭配最多 4 条，例句最多 2 条（含中文翻译）。",
    "",
    "只输出以下 JSON（不要代码块、不要多余文字）：",
    "{",
    '  "type": "word|phrase|idiom|other",',
    '  "query": "选中的原文本",',
    '  "phonetic": "音标（可选）",',
    '  "pos": "词性",',
    '  "meaningInContext": "结合上下文的确切含义（中文为主）",',
    '  "meaningEn": "简短英文释义",',
    '  "phraseInfo": {"phrase": "搭配/习语原文", "explanation": "中文解释"},',
    '  "otherMeanings": ["其他含义1", "其他含义2"],',
    '  "collocations": ["搭配：解释"],',
    '  "examples": [{"en": "例句", "zh": "翻译"}],',
    '  "usageNote": "用法/语气提示（可选）"',
    "}",
  );
  return parts.join("\n");
}

export function parseLlmJson(raw) {
  if (!raw || typeof raw !== "string") return null;
  let text = raw.trim();
  // 去掉 BOM
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1).trim();
  // 去掉代码块围栏
  text = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  // 去掉常见的尾随逗号（模型偶尔会输出 {"a":1,}）
  text = text.replace(/,\s*([}\]])/g, "$1");

  const normalize = (obj) => {
    if (!obj || typeof obj !== "object") return null;
    if (Array.isArray(obj)) return obj.length && typeof obj[0] === "object" ? obj[0] : null;
    return obj;
  };
  const tryParse = (s) => {
    try {
      return normalize(JSON.parse(s));
    } catch {
      return null;
    }
  };

  // 1) 直接解析
  let obj = tryParse(text);
  if (obj) return obj;

  // 2) 双重编码：内容是 JSON 字符串套 JSON
  try {
    const first = JSON.parse(text);
    if (typeof first === "string") {
      const inner = tryParse(first);
      if (inner) return inner;
    }
  } catch {
    // 继续
  }

  // 3) 从大括号区间提取
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) {
    obj = tryParse(text.slice(start, end + 1));
    if (obj) return obj;
  }
  return null;
}

export function extractMessageContent(message) {
  const c = message && message.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    return c
      .map((p) => {
        if (typeof p === "string") return p;
        if (p && typeof p === "object") return p.text || p.content || "";
        return "";
      })
      .join("")
      .trim();
  }
  return "";
}

export function hashString(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) + h + str.charCodeAt(i)) >>> 0;
  }
  return h.toString(36);
}

export function cacheKey(text, context) {
  return hashString(`${text}\u0000${context || ""}`);
}

export function wordCacheKey(text) {
  return "w:" + hashString(String(text).toLowerCase().trim());
}
