// 词境 WordSense 核心逻辑（纯函数，方便测试）

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
    "你是英语学习助手。用户读英文网页时选中了一个词或短语，无法确定它在句子中的确切含义。请结合上下文给出精准解释（以中文为主）。",
    "",
    `【上下文】${context || "（无）"}`,
    `【选中】${selection}`,
    "",
    "要求：",
    "1. 判断类型：word | phrase | idiom | other；",
    "2. 结合上下文给出该处确切含义，不要罗列全部意思；",
  ];
  if (autoExpand) {
    parts.push("3. 若选中是单词且属于某个固定搭配或习语，用 phraseInfo 解释整个短语；");
  } else {
    parts.push("3. 若是单词，给出该语境含义；");
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
