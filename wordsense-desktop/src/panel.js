import { invoke } from '@tauri-apps/api/core';

// ── DOM references ──────────────────────────────────────────────────────────

const badgeEl  = document.querySelector('.ws-badge');
const queryEl  = document.querySelector('.ws-query');
const metaEl   = document.querySelector('.ws-meta');
const bodyEl   = document.querySelector('.ws-body');

let lastData = null;

export function getLastData() { return lastData; }
export function setLastData(d) { lastData = d; }

// ── Helpers ─────────────────────────────────────────────────────────────────

function escapeHtml(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const TYPE_MAP = {
  word:   ['单词',     'word'],
  phrase: ['固定搭配', 'phrase'],
  idiom:  ['习语',     'idiom'],
  other:  ['其他',     'other'],
};

// ── Render functions ────────────────────────────────────────────────────────

export function renderLoading(text) {
  badgeEl.textContent = '分析中';
  badgeEl.className   = 'ws-badge word';
  queryEl.textContent = text;
  metaEl.innerHTML    = '';
  bodyEl.innerHTML    =
    '<div class="ws-loading"><div class="ws-spinner"></div><span>正在结合上下文分析…</span></div>';
  lastData = null;
}

export function renderResult(data, fallbackText) {
  const type     = TYPE_MAP[data.type] ? data.type : 'other';
  const [label, cls] = TYPE_MAP[type];
  badgeEl.textContent = label;
  badgeEl.className   = 'ws-badge ' + cls;

  queryEl.textContent = data.query || fallbackText;

  metaEl.innerHTML = '';
  if (data.phonetic) {
    const ph = document.createElement('span');
    ph.className   = 'phonetic';
    ph.textContent = data.phonetic;
    metaEl.appendChild(ph);
  }
  if (data.pos) {
    const p = document.createElement('span');
    p.className   = 'pos';
    p.textContent = data.pos;
    metaEl.appendChild(p);
  }

  let html = '';

  if (data.meaningInContext) {
    html += `<div class="ws-section-title">在此语境中的含义</div><div class="ws-meaning">${escapeHtml(
      data.meaningInContext
    )}`;
    if (data.meaningEn) {
      html += `<div class="ws-meaning-en">${escapeHtml(data.meaningEn)}</div>`;
    }
    html += '</div>';
  }

  if (data.phraseInfo && (data.phraseInfo.phrase || data.phraseInfo.explanation)) {
    html += `<div class="ws-phrase"><span class="p">${escapeHtml(
      data.phraseInfo.phrase || ''
    )}</span><div class="e">${escapeHtml(data.phraseInfo.explanation || '')}</div></div>`;
  }

  if (Array.isArray(data.otherMeanings) && data.otherMeanings.length) {
    html +=
      '<div class="ws-section-title">其他常见含义</div><ul class="ws-list">' +
      data.otherMeanings.map((m) => `<li>${escapeHtml(m)}</li>`).join('') +
      '</ul>';
  }

  if (Array.isArray(data.collocations) && data.collocations.length) {
    html +=
      '<div class="ws-section-title">常用搭配</div><ul class="ws-list">' +
      data.collocations.map((c) => `<li>${escapeHtml(c)}</li>`).join('') +
      '</ul>';
  }

  if (Array.isArray(data.examples) && data.examples.length) {
    html += '<div class="ws-section-title">例句</div>';
    data.examples.forEach((ex) => {
      if (!ex) return;
      const en = typeof ex === 'string' ? ex : ex.en || '';
      const zh = typeof ex === 'string' ? '' : ex.zh || '';
      html += `<div class="ws-example"><div class="en">${escapeHtml(en)}</div>${
        zh ? `<div class="zh">${escapeHtml(zh)}</div>` : ''
      }</div>`;
    });
  }

  if (data.usageNote) {
    html += `<div class="ws-note">💡 ${escapeHtml(data.usageNote)}</div>`;
  }

  bodyEl.innerHTML = html || '<div class="ws-meaning">（没有返回可显示的内容）</div>';
  lastData = data;
}

export function renderNoKey() {
  badgeEl.textContent = '未配置';
  badgeEl.className   = 'ws-badge other';
  queryEl.textContent = '词境';
  metaEl.innerHTML    = '';
  bodyEl.innerHTML    =
    '<div class="ws-error">还没有配置 API Key。请先在设置中填入 API 地址和 Key，才能调用 AI 理解语境。</div>' +
    '<button class="ws-link-btn" type="button">打开设置</button>';
  bodyEl.querySelector('.ws-link-btn').addEventListener('click', () => {
    invoke('open_settings');
  });
  lastData = null;
}

export function renderError(message, raw) {
  badgeEl.textContent = '出错了';
  badgeEl.className   = 'ws-badge other';
  queryEl.textContent = '词境';
  metaEl.innerHTML    = '';
  let html = `<div class="ws-error">${escapeHtml(message || '查询失败')}</div>`;
  if (raw) {
    html +=
      '<details class="ws-details"><summary>查看原始返回</summary><div class="ws-raw">' +
      escapeHtml(raw) +
      '</div></details>';
  }
  bodyEl.innerHTML = html;
  lastData = null;
}
