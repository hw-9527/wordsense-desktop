const $ = (id) => document.getElementById(id);

async function load() {
  let settings = {};
  try {
    settings = await chrome.runtime.sendMessage({ type: "get-settings" });
  } catch {
    const stored = await chrome.storage.local.get("settings");
    settings = stored.settings || {};
  }
  $("baseUrl").value = settings.baseUrl || "";
  $("apiKey").value = settings.apiKey || "";
  $("model").value = settings.model || "";
  $("temperature").value = settings.temperature != null ? settings.temperature : 0.1;
  $("maxTokens").value = settings.maxTokens || 1200;
  $("autoExpand").checked = settings.autoExpand !== false;
  $("disableThinking").checked = settings.disableThinking !== false;
}

function collect() {
  return {
    baseUrl: $("baseUrl").value.trim(),
    apiKey: $("apiKey").value.trim(),
    model: $("model").value.trim(),
    temperature: parseFloat($("temperature").value) || 0.2,
    maxTokens: parseInt($("maxTokens").value, 10) || 1200,
    autoExpand: $("autoExpand").checked,
    disableThinking: $("disableThinking").checked,
  };
}

function setStatus(text, cls) {
  const el = $("status");
  el.textContent = text;
  el.className = cls || "";
}

$("save").addEventListener("click", async () => {
  const s = collect();
  if (!s.apiKey) {
    setStatus("⚠️ API Key 未填写（可先保存，查询时会提示）", "warn");
  }
  try {
    await chrome.runtime.sendMessage({ type: "save-settings", settings: s });
    if (s.apiKey) setStatus("✅ 已保存", "ok");
  } catch {
    await chrome.storage.local.set({ settings: s });
    if (s.apiKey) setStatus("✅ 已保存（本地）", "ok");
  }
  if (s.apiKey) {
    setTimeout(() => {
      if ($("status").textContent.startsWith("✅")) setStatus("", "");
    }, 2000);
  }
});

$("test").addEventListener("click", async () => {
  try {
    await chrome.runtime.sendMessage({ type: "save-settings", settings: collect() });
  } catch {
    // 忽略保存失败，直接尝试测试
  }
  setStatus("⏳ 正在测试连接…");
  let res;
  try {
    res = await chrome.runtime.sendMessage({ type: "test-connection" });
  } catch (err) {
    res = { ok: false, message: "无法连接后台：" + ((err && err.message) || err) };
  }
  if (res && res.ok) setStatus("✅ " + (res.message || "连接成功"), "ok");
  else setStatus("❌ " + ((res && res.message) || "连接失败"), "err");
});

$("toggleKey").addEventListener("click", () => {
  const el = $("apiKey");
  el.type = el.type === "password" ? "text" : "password";
  $("toggleKey").textContent = el.type === "password" ? "显示" : "隐藏";
});

load();
