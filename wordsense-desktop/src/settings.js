import { load as loadStore } from '@tauri-apps/plugin-store';
import { fetch } from '@tauri-apps/plugin-http';
import { normalizeBaseUrl } from './lib/core.js';

const $ = (id) => document.getElementById(id);
let store = null;

async function initStore() {
  if (!store) {
    store = await loadStore('settings.json');
  }
}

async function load() {
  await initStore();
  $('baseUrl').value = (await store.get('baseUrl')) || '';
  $('apiKey').value = (await store.get('apiKey')) || '';
  $('model').value = (await store.get('model')) || '';
  $('temperature').value = (await store.get('temperature')) ?? 0.1;
  $('maxTokens').value = (await store.get('maxTokens')) || 700;
  $('autoExpand').checked = (await store.get('autoExpand')) !== false;
  $('disableThinking').checked = (await store.get('disableThinking')) !== false;
}

function collect() {
  return {
    baseUrl: $('baseUrl').value.trim(),
    apiKey: $('apiKey').value.trim(),
    model: $('model').value.trim(),
    temperature: parseFloat($('temperature').value) || 0.1,
    maxTokens: parseInt($('maxTokens').value, 10) || 700,
    autoExpand: $('autoExpand').checked,
    disableThinking: $('disableThinking').checked,
  };
}

function setStatus(text, cls) {
  const el = $('status');
  el.textContent = text;
  el.className = cls || '';
}

$('save').addEventListener('click', async () => {
  await initStore();
  const s = collect();
  if (!s.apiKey) {
    setStatus('⚠️ API Key 未填写（可先保存）', 'warn');
  }
  for (const [key, val] of Object.entries(s)) {
    await store.set(key, val);
  }
  await store.save();
  if (s.apiKey) setStatus('✅ 已保存', 'ok');
  setTimeout(() => {
    if ($('status').textContent.startsWith('✅')) setStatus('', '');
  }, 2000);
});

$('test').addEventListener('click', async () => {
  await initStore();
  const s = collect();
  // 先保存当前输入
  for (const [key, val] of Object.entries(s)) {
    await store.set(key, val);
  }
  await store.save();
  
  if (!s.apiKey) {
    setStatus('❌ 请先填写 API Key', 'err');
    return;
  }
  
  setStatus('⏳ 正在测试连接…');
  const url = normalizeBaseUrl(s.baseUrl);
  try {
    const body = {
      model: s.model,
      messages: [{ role: 'user', content: '回复 OK' }],
      max_tokens: 5,
    };
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${s.apiKey}`,
      },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => null);
    if (!res.ok) {
      const detail = (json && json.error && json.error.message) || res.statusText || res.status;
      setStatus(`❌ 连接失败：${detail}`, 'err');
    } else {
      setStatus('✅ 连接成功，可以开始查词了', 'ok');
    }
  } catch (err) {
    setStatus(`❌ 网络错误：${(err && err.message) || err}`, 'err');
  }
});

$('toggleKey').addEventListener('click', () => {
  const el = $('apiKey');
  el.type = el.type === 'password' ? 'text' : 'password';
  $('toggleKey').textContent = el.type === 'password' ? '显示' : '隐藏';
});

load();
