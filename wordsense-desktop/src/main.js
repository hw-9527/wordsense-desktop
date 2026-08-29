import { listen } from '@tauri-apps/api/event';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import { LogicalSize, PhysicalPosition } from '@tauri-apps/api/dpi';
import { invoke } from '@tauri-apps/api/core';
import { renderResult, renderError, renderLoading, renderNoKey, getLastData } from './panel.js';
import { lookupWord } from './lookup.js';

const btnWrapEl = document.getElementById('ws-btn-wrap');
const btnEl = document.getElementById('ws-btn');
const panelEl = document.getElementById('ws-panel');
const panelHeadEl = panelEl.querySelector('.ws-panel-head');
const pronBrowserBtn = panelEl.querySelector('.ws-pron-browser');
const pronYoudaoBtn = panelEl.querySelector('.ws-pron-youdao');
const appWindow = getCurrentWebviewWindow();

let currentSelection = null;
let buttonTimer = null;
let currentMode = 'hidden'; // 'button' | 'panel' | 'hidden'
let youdaoAudio = null;

function hideAll() {
  clearTimeout(buttonTimer);
  stopSpeak();
  stopYoudao();
  btnWrapEl.hidden = true;
  panelEl.hidden = true;
  currentMode = 'hidden';
  invoke('hide_panel').catch(() => {});
}

// ── 拖拽面板支持（针对 macOS Retina 缩放比做精准 1:1 换算，彻底跟手） ──
let isDragging = false;
let dragStartX = 0;
let dragStartY = 0;
let windowStartPos = null;

panelHeadEl.addEventListener('mousedown', async (e) => {
  // 排除点击关闭、发音等功能按钮时的拖拽
  if (e.target.closest('button')) return;
  if (e.button !== 0) return;

  isDragging = true;
  dragStartX = e.screenX;
  dragStartY = e.screenY;
  try {
    windowStartPos = await appWindow.outerPosition();
  } catch {}
});

window.addEventListener('mousemove', async (e) => {
  if (!isDragging || !windowStartPos) return;
  const dpr = window.devicePixelRatio || 1;
  const dx = (e.screenX - dragStartX) * dpr;
  const dy = (e.screenY - dragStartY) * dpr;
  try {
    await appWindow.setPosition(
      new PhysicalPosition(Math.round(windowStartPos.x + dx), Math.round(windowStartPos.y + dy))
    );
  } catch {}
});

window.addEventListener('mouseup', () => {
  isDragging = false;
  windowStartPos = null;
});

// 获取当前显示器的逻辑像素可用边界（支持多显示器）
async function getMonitorBounds() {
  try {
    const monitor = await appWindow.currentMonitor();
    if (monitor) {
      const scale = monitor.scaleFactor || window.devicePixelRatio || 1;
      const left = monitor.position.x / scale;
      const top = monitor.position.y / scale;
      const width = monitor.size.width / scale;
      const height = monitor.size.height / scale;
      return {
        left,
        top,
        right: left + width,
        bottom: top + height,
        width,
        height,
      };
    }
  } catch (err) {
    console.warn('Failed to get monitor bounds:', err);
  }
  return {
    left: 0,
    top: 0,
    right: window.screen.availWidth || 1920,
    bottom: window.screen.availHeight || 1080,
    width: window.screen.availWidth || 1920,
    height: window.screen.availHeight || 1080,
  };
}

// 监听 Rust 后端发送的划词检测事件
listen('selection-detected', async (event) => {
  const { text, context, mouse_x, mouse_y, bounds_x, bounds_y, bounds_w, bounds_h } = event.payload;
  const trimmed = String(text || '').trim();
  // 前端严格校验有效文本，防止空串、纯标点、空白符误弹出
  if (!trimmed || !/[a-zA-Z0-9\u4e00-\u9fa5]/.test(trimmed)) {
    return;
  }
  currentSelection = {
    text: trimmed,
    context,
    mouse_x,
    mouse_y,
    bounds_x,
    bounds_y,
    bounds_w,
    bounds_h,
  };
  await showButton();
});

// 监听选区清空/空白点击事件：立即隐藏浮动按钮
listen('selection-cleared', () => {
  if (currentMode === 'button') {
    hideAll();
  }
});

// 监听 Rust 层检测到的按钮区域点击（绕过 macOS NSNonactivatingPanel 第一次点击被吞的问题）
listen('trigger-lookup', async () => {
  if (currentMode === 'button' && currentSelection) {
    await triggerLookup();
  }
});

async function showButton() {
  clearTimeout(buttonTimer);
  currentMode = 'button';
  btnWrapEl.hidden = false;
  panelEl.hidden = true;

  const btnWidth = 110;
  const btnHeight = 52;
  const screen = await getMonitorBounds();

  let targetX = 0;
  let targetY = 0;

  const { bounds_x, bounds_y, bounds_w, bounds_h, mouse_x, mouse_y } = currentSelection || {};

  // 1. 优先根据选中文本的屏幕真实位置，精确放置在选中文本的正下方
  if (bounds_x != null && bounds_y != null && bounds_w != null && bounds_h != null && bounds_w > 0 && bounds_h > 0) {
    targetX = bounds_x + (bounds_w / 2) - (btnWidth / 2);
    targetY = bounds_y + bounds_h + 4;

    // 若下方空间不足，则翻转显示在选中文本正上方
    if (targetY + btnHeight > screen.bottom - 10) {
      targetY = bounds_y - btnHeight - 4;
    }
  } else {
    // 回退到鼠标光标位置下方
    targetX = mouse_x + 8;
    targetY = mouse_y + 12;

    if (targetY + btnHeight > screen.bottom - 10) {
      targetY = mouse_y - btnHeight - 8;
    }
  }

  // 屏幕四周边界防溢出保护
  if (targetX + btnWidth > screen.right - 10) {
    targetX = screen.right - btnWidth - 10;
  }
  if (targetX < screen.left + 10) {
    targetX = screen.left + 10;
  }
  if (targetY < screen.top + 10) {
    targetY = screen.top + 10;
  }

  try {
    await appWindow.setSize(new LogicalSize(btnWidth, btnHeight));
    await invoke('show_panel_at', {
      x: Math.round(targetX),
      y: Math.round(targetY),
    });
  } catch (err) {
    console.error('Failed to show button:', err);
  }

  // 6 秒内没有点击则自动隐藏
  buttonTimer = setTimeout(() => {
    if (currentMode === 'button') {
      hideAll();
    }
  }, 6000);
}

async function showPanel() {
  clearTimeout(buttonTimer);
  currentMode = 'panel';
  btnWrapEl.hidden = true;
  panelEl.hidden = false;

  const panelWidth = 380;
  const panelHeight = 480;
  const screen = await getMonitorBounds();

  let targetX = 0;
  let targetY = 0;

  const { bounds_x, bounds_y, bounds_w, bounds_h, mouse_x, mouse_y } = currentSelection || {};

  const anchorLeft = (bounds_x != null && bounds_x > 0) ? bounds_x : (mouse_x || 100);
  const anchorTop = (bounds_y != null && bounds_y > 0) ? bounds_y : (mouse_y || 100);
  const anchorBottom = (bounds_y != null && bounds_h != null && bounds_h > 0) ? (bounds_y + bounds_h) : (anchorTop + 20);

  // 1. 水平起始位置：与文本左侧或鼠标对齐
  targetX = anchorLeft - 10;

  // 2. 垂直起始位置：优先显示在文本正下方
  targetY = anchorBottom + 6;

  // 3. 屏幕边界与遮挡智能碰撞检测（四向自适应）：
  // 底部溢出检查：若面板超出屏幕底部
  if (targetY + panelHeight > screen.bottom - 15) {
    // 检查上方是否有足够空间容纳面板
    if (anchorTop - panelHeight - 6 >= screen.top + 15) {
      // 翻转到选区正上方显示
      targetY = anchorTop - panelHeight - 6;
    } else {
      // 若上下空间都紧张，贴近屏幕底部安全区域显示
      targetY = Math.max(screen.top + 15, screen.bottom - panelHeight - 15);
    }
  }

  // 顶部溢出检查
  if (targetY < screen.top + 15) {
    targetY = screen.top + 15;
  }

  // 右侧溢出检查：若面板超出屏幕右边缘，向左平移
  if (targetX + panelWidth > screen.right - 15) {
    targetX = screen.right - panelWidth - 15;
  }

  // 左侧溢出检查：若面板超出屏幕左边缘，向右平移
  if (targetX < screen.left + 15) {
    targetX = screen.left + 15;
  }

  try {
    await appWindow.setSize(new LogicalSize(panelWidth, panelHeight));
    await invoke('show_panel_at', {
      x: Math.round(targetX),
      y: Math.round(targetY),
    });
  } catch (err) {
    console.error('Failed to show panel:', err);
  }
}

async function triggerLookup() {
  if (!currentSelection) return;
  await showPanel();
  renderLoading(currentSelection.text);

  const result = await lookupWord(currentSelection.text, currentSelection.context);
  if (result.ok) {
    renderResult(result.data, currentSelection.text);
  } else if (result.error === 'no-api-key') {
    renderNoKey();
  } else {
    renderError(result.message, result.raw);
  }
}

// 既支持单击 click，也支持 mousedown / pointerdown 立即触发查词
btnEl.addEventListener('mousedown', async (e) => {
  e.stopPropagation();
  e.preventDefault();
  await triggerLookup();
});

btnEl.addEventListener('click', async (e) => {
  e.stopPropagation();
  if (currentMode !== 'panel') {
    await triggerLookup();
  }
});

// 关闭面板按钮
panelEl.querySelector('.ws-close').addEventListener('click', (e) => {
  e.stopPropagation();
  hideAll();
});

// 按 Esc 键隐藏
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    hideAll();
  }
});

// 复制结果
panelEl.querySelector('.ws-copy').addEventListener('click', async () => {
  const data = getLastData();
  if (!data) return;
  const txt = summaryText(data);
  try {
    await navigator.clipboard.writeText(txt);
    panelEl.querySelector('.ws-copy').textContent = '✅ 已复制';
  } catch {
    const ta = document.createElement('textarea');
    ta.value = txt;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
    panelEl.querySelector('.ws-copy').textContent = '✅ 已复制';
  }
  setTimeout(() => {
    panelEl.querySelector('.ws-copy').textContent = '📋 复制';
  }, 1600);
});

function stopSpeak() {
  if ('speechSynthesis' in window) {
    try {
      window.speechSynthesis.cancel();
    } catch {}
  }
  if (pronBrowserBtn) pronBrowserBtn.classList.remove('playing');
}

function stopYoudao() {
  if (youdaoAudio) {
    try {
      youdaoAudio.pause();
    } catch {}
    youdaoAudio = null;
  }
  if (pronYoudaoBtn) pronYoudaoBtn.classList.remove('playing');
}

function speakWord(text, onEnd) {
  if (!text || !('speechSynthesis' in window)) {
    if (onEnd) onEnd();
    return null;
  }
  try {
    stopYoudao();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'en-US';
    u.rate = 0.9;
    const voices = window.speechSynthesis.getVoices();
    const voice =
      voices.find((v) => v.lang && v.lang.toLowerCase().startsWith('en-us')) ||
      voices.find((v) => v.lang && v.lang.toLowerCase().startsWith('en'));
    if (voice) u.voice = voice;
    if (onEnd) {
      u.onend = onEnd;
      u.onerror = onEnd;
    }
    window.speechSynthesis.speak(u);
    return u;
  } catch (err) {
    if (onEnd) onEnd();
    return null;
  }
}

function playYoudao(text) {
  if (!text) return;
  stopSpeak();
  stopYoudao();
  const url = 'https://dict.youdao.com/dictvoice?audio=' + encodeURIComponent(text) + '&type=2';
  const a = new Audio(url);
  youdaoAudio = a;
  if (pronYoudaoBtn) pronYoudaoBtn.classList.add('playing');
  a.onended = stopYoudao;
  a.onerror = () => {
    stopYoudao();
    speakWord(text);
  };
  a.play().catch(() => {
    stopYoudao();
    speakWord(text);
  });
}

function currentWord() {
  const d = getLastData();
  return (d && d.query) || (currentSelection && currentSelection.text) || '';
}

// 朗读例句 / 释义
panelEl.querySelector('.ws-speak').addEventListener('click', () => {
  const data = getLastData();
  if (!data) return;
  const ex = Array.isArray(data.examples) && data.examples[0]
    ? (typeof data.examples[0] === 'string' ? data.examples[0] : data.examples[0].en || '')
    : '';
  const text = ex || data.query || '';
  if (text && 'speechSynthesis' in window) {
    stopYoudao();
    stopSpeak();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'en-US';
    u.rate = 0.95;
    window.speechSynthesis.speak(u);
  }
});

// 浏览器合成发音
if (pronBrowserBtn) {
  pronBrowserBtn.addEventListener('click', () => {
    const w = currentWord();
    if (!w) return;
    pronBrowserBtn.classList.add('playing');
    speakWord(w, () => pronBrowserBtn.classList.remove('playing'));
  });
}

// 有道词典真人发音
if (pronYoudaoBtn) {
  pronYoudaoBtn.addEventListener('click', () => {
    playYoudao(currentWord());
  });
}

function summaryText(d) {
  if (!d) return '';
  const lines = [];
  lines.push(`${d.query || ''}${d.pos ? ' [' + d.pos + ']' : ''}${d.phonetic ? ' ' + d.phonetic : ''}`);
  if (d.meaningInContext) lines.push('含义：' + d.meaningInContext);
  if (d.phraseInfo && d.phraseInfo.phrase) {
    lines.push(`搭配/习语：${d.phraseInfo.phrase} —— ${d.phraseInfo.explanation || ''}`);
  }
  if (Array.isArray(d.examples) && d.examples.length) {
    lines.push('例句：');
    d.examples.forEach(ex => {
      const en = typeof ex === 'string' ? ex : ex.en || '';
      const zh = typeof ex === 'string' ? '' : ex.zh || '';
      lines.push(`  ${en}${zh ? ' / ' + zh : ''}`);
    });
  }
  return lines.join('\n');
}
