(() => {
  if (window.__WORDSENSE_INSTALLED__) return;
  window.__WORDSENSE_INSTALLED__ = true;

  const STYLES = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    .ws-btn[hidden], .ws-panel[hidden] { display: none !important; }
    .ws-btn {
      position: fixed; z-index: 2147483647; display: flex; align-items: center; gap: 5px;
      padding: 6px 12px; border-radius: 999px; background: #4f6bed; color: #fff;
      font: 500 13px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
      cursor: pointer; box-shadow: 0 4px 14px rgba(30, 40, 90, .28); user-select: none;
      transform: translateY(2px);
    }
    .ws-btn:hover { background: #4159d8; }
    .ws-btn svg { width: 14px; height: 14px; }
    .ws-panel {
      position: fixed; z-index: 2147483647; width: 370px; max-width: min(92vw, 380px);
      max-height: min(72vh, 540px); display: flex; flex-direction: column; overflow: hidden;
      background: #ffffff; color: #1f2937; border-radius: 14px;
      box-shadow: 0 12px 40px rgba(15, 23, 42, .28), 0 2px 8px rgba(15, 23, 42, .12);
      font: 14px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
      border: 1px solid rgba(15, 23, 42, .08);
    }
    .ws-panel-head { display: flex; flex-direction: column; padding: 10px 12px 8px; border-bottom: 1px solid #eef0f4; cursor: move; touch-action: none; }
    .ws-head-row { display: flex; align-items: center; gap: 8px; min-width: 0; }
    .ws-panel.ws-dragging { user-select: none; }
    .ws-panel.ws-dragging .ws-panel-head { cursor: grabbing; }
    .ws-badge { font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: 999px; color: #fff; flex-shrink: 0; }
    .ws-badge.word { background: #4f6bed; }
    .ws-badge.phrase { background: #0e9f6e; }
    .ws-badge.idiom { background: #d97706; }
    .ws-badge.other { background: #6b7280; }
    .ws-query { font-weight: 700; font-size: 15px; flex: 1; min-width: 0; overflow-wrap: anywhere; }
    .ws-meta { display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px 12px; margin-top: 4px; font-size: 13px; color: #6b7280; }
    .ws-meta .phonetic { font-weight: 400; color: #6b7280; font-size: 13px; }
    .ws-meta .pos { font-weight: 400; color: #4f6bed; font-size: 12px; }
    .ws-meta:empty { display: none; }
    .ws-pron { display: inline-flex; gap: 4px; flex-shrink: 0; margin-left: 2px; }
    .ws-pron-btn { width: 24px; height: 24px; padding: 0; border: 1px solid #d1d5db; background: #fff; color: #4f6bed; border-radius: 6px; font-size: 12px; line-height: 1; cursor: pointer; display: inline-flex; align-items: center; justify-content: center; }
    .ws-pron-btn:hover { background: #eef2ff; border-color: #a5b4fc; }
    .ws-pron-btn.playing { background: #4f6bed; color: #fff; border-color: #4f6bed; }
    .ws-close { border: 0; background: transparent; color: #9ca3af; font-size: 18px; line-height: 1; cursor: pointer; padding: 2px 6px; border-radius: 6px; }
    .ws-close:hover { background: #f3f4f6; color: #374151; }
    .ws-body { padding: 12px; overflow-y: auto; overscroll-behavior: contain; }
    .ws-section-title { font-size: 11px; font-weight: 700; letter-spacing: .05em; color: #9ca3af; text-transform: uppercase; margin: 12px 0 4px; }
    .ws-section-title:first-child { margin-top: 0; }
    .ws-meaning { background: #f0f4ff; border: 1px solid #dbe4ff; border-radius: 10px; padding: 10px 12px; color: #1e293b; font-size: 14.5px; }
    .ws-meaning-en { color: #475569; margin-top: 6px; font-size: 13px; }
    .ws-quick-bar { background: #fffbeb; border: 1px solid #fde68a; color: #92400e; border-radius: 8px; padding: 6px 10px; font-size: 12.5px; margin-bottom: 10px; }
    .ws-phrase { background: #ecfdf5; border: 1px solid #a7f3d0; border-radius: 10px; padding: 10px 12px; margin-top: 10px; }
    .ws-phrase .p { font-weight: 700; color: #065f46; }
    .ws-phrase .e { color: #374151; margin-top: 3px; font-size: 13.5px; }
    .ws-list { margin: 0; padding-left: 18px; color: #374151; }
    .ws-list li { margin: 3px 0; }
    .ws-example { margin: 8px 0; padding: 8px 10px; background: #f9fafb; border-radius: 8px; }
    .ws-example .en { font-weight: 600; color: #111827; }
    .ws-example .zh { color: #6b7280; font-size: 13px; }
    .ws-note { color: #6b7280; font-size: 12.5px; font-style: italic; margin-top: 10px; }
    .ws-foot { display: flex; gap: 8px; padding: 8px 12px 10px; border-top: 1px solid #eef0f4; }
    .ws-btn-sm { border: 1px solid #d1d5db; background: #fff; color: #374151; border-radius: 8px; padding: 5px 10px; font-size: 12.5px; cursor: pointer; }
    .ws-btn-sm:hover { background: #f3f4f6; }
    .ws-loading { display: flex; align-items: center; gap: 10px; color: #6b7280; padding: 8px 2px; }
    .ws-spinner { width: 18px; height: 18px; border: 2px solid #dbe4ff; border-top-color: #4f6bed; border-radius: 50%; animation: ws-spin .8s linear infinite; }
    @keyframes ws-spin { to { transform: rotate(360deg); } }
    .ws-error { color: #b91c1c; background: #fef2f2; border: 1px solid #fecaca; border-radius: 10px; padding: 10px 12px; white-space: pre-wrap; word-break: break-word; }
    .ws-link-btn { margin-top: 10px; display: inline-block; border: 0; background: #4f6bed; color: #fff; border-radius: 8px; padding: 6px 14px; cursor: pointer; font-size: 13px; }
    .ws-raw { color: #6b7280; font-size: 12px; margin-top: 8px; word-break: break-word; }
    details.ws-details { margin-top: 8px; }
    details.ws-details summary { cursor: pointer; color: #6b7280; font-size: 12px; }
    @media (prefers-color-scheme: dark) {
      .ws-panel { background: #111827; color: #e5e7eb; border-color: rgba(255, 255, 255, .08); }
      .ws-panel-head, .ws-foot { border-color: #1f2937; }
      .ws-close { color: #6b7280; }
      .ws-close:hover { background: #1f2937; color: #e5e7eb; }
      .ws-pron-btn { background: #1f2937; border-color: #374151; color: #a5b4fc; }
      .ws-pron-btn:hover { background: #374151; border-color: #6366f1; }
      .ws-pron-btn.playing { background: #4f6bed; color: #fff; border-color: #4f6bed; }
      .ws-meaning { background: #172554; border-color: #1e3a8a; color: #dbeafe; }
      .ws-meaning-en { color: #93c5fd; }
      .ws-meta { color: #9ca3af; }
      .ws-meta .pos { color: #a5b4fc; }
      .ws-quick-bar { background: #422006; border-color: #78350f; color: #fde68a; }
      .ws-phrase { background: #064e3b; border-color: #065f46; }
      .ws-phrase .p { color: #a7f3d0; }
      .ws-phrase .e { color: #d1fae5; }
      .ws-list { color: #d1d5db; }
      .ws-example { background: #1f2937; }
      .ws-example .en { color: #f9fafb; }
      .ws-example .zh { color: #9ca3af; }
      .ws-note { color: #9ca3af; }
      .ws-btn-sm { background: #1f2937; border-color: #374151; color: #e5e7eb; }
      .ws-btn-sm:hover { background: #374151; }
      .ws-error { background: #450a0a; border-color: #7f1d1d; color: #fecaca; }
      .ws-section-title { color: #6b7280; }
    }
  `;

  const host = document.createElement("div");
  host.id = "wordsense-host";
  document.documentElement.appendChild(host);
  const shadow = host.attachShadow({ mode: "open" });
  const styleEl = document.createElement("style");
  styleEl.textContent = STYLES;
  shadow.appendChild(styleEl);

  const btn = document.createElement("div");
  btn.className = "ws-btn";
  btn.setAttribute("role", "button");
  btn.innerHTML =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><circle cx="10.5" cy="10.5" r="6.2"/><line x1="15.1" y1="15.1" x2="20.5" y2="20.5"/></svg><span>词境</span>';
  btn.hidden = true;

  const panel = document.createElement("div");
  panel.className = "ws-panel";
  panel.hidden = true;
  panel.innerHTML = `
    <div class="ws-panel-head" title="按住拖动可移动面板">
      <div class="ws-head-row">
        <span class="ws-badge word"></span>
        <span class="ws-query"></span>
        <span class="ws-pron">
          <button class="ws-pron-btn ws-pron-browser" type="button" title="浏览器发音">🔊</button>
          <button class="ws-pron-btn ws-pron-youdao" type="button" title="有道词典发音">有</button>
        </span>
        <button class="ws-close" type="button" title="关闭">×</button>
      </div>
      <div class="ws-meta"></div>
    </div>
    <div class="ws-body"></div>
    <div class="ws-foot">
      <button class="ws-btn-sm ws-speak" type="button">🔊 朗读</button>
      <button class="ws-btn-sm ws-copy" type="button">📋 复制</button>
    </div>`;
  shadow.append(btn, panel);

  const badgeEl = panel.querySelector(".ws-badge");
  const queryEl = panel.querySelector(".ws-query");
  const metaEl = panel.querySelector(".ws-meta");
  const bodyEl = panel.querySelector(".ws-body");
  const speakBtn = panel.querySelector(".ws-speak");
  const copyBtn = panel.querySelector(".ws-copy");
  const pronBrowserBtn = panel.querySelector(".ws-pron-browser");
  const pronYoudaoBtn = panel.querySelector(".ws-pron-youdao");

  let current = null; // { text, range, rect }
  let lastData = null;
  let lookupSeq = 0; // 每次查询递增，用于丢弃过期的结果
  let currentRequestId = null;
  let panelPinned = false; // 用户手动拖动过面板后，不再自动改变位置
  let dragState = null;
  let youdaoAudio = null;

  function isEditable(node) {
    if (!node || !node.closest) return false;
    return !!node.closest('input, textarea, select, [contenteditable="true"], [contenteditable=""]');
  }

  function eventInsideHost(e) {
    if (e.composedPath) return e.composedPath().includes(host);
    return host.contains(e.target);
  }

  function hideFloat() {
    btn.hidden = true;
  }

  function closePanel() {
    lookupSeq += 1; // 使进行中的请求结果作废
    currentRequestId = null;
    stopSpeak();
    stopYoudao();
    panel.hidden = true;
    lastData = null;
  }

  function escapeHtml(str) {
    return String(str == null ? "" : str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function getSentenceContext(range) {
    try {
      let node = range.commonAncestorContainer;
      if (node.nodeType === Node.TEXT_NODE) node = node.parentElement;
      let el = node || document.body;
      for (let i = 0; i < 6; i++) {
        const t = el.textContent || "";
        if (t.trim().length >= 60 || el === document.body) break;
        el = el.parentElement || document.body;
      }
      const full = (el.textContent || "").replace(/\s+/g, " ").trim();
      if (!full) return "";
      const startNode = range.startContainer;
      const startOffset = range.startOffset;
      let idx = -1;
      if (startNode.nodeType === Node.TEXT_NODE) {
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        let buf = "";
        while (walker.nextNode()) {
          const t = walker.currentNode;
          if (t === startNode) {
            buf += String(t.nodeValue).slice(0, startOffset);
            idx = buf.length;
            break;
          }
          buf += String(t.nodeValue);
        }
      }
      if (idx < 0) {
        const probe = String(startNode.textContent || "")
          .slice(0, 20)
          .replace(/\s+/g, " ");
        idx = probe ? full.indexOf(probe) : -1;
      }
      if (idx < 0) idx = Math.max(0, Math.min(full.length - 1, Math.floor(full.length / 2)));
      const MAX = 320;
      let s = idx;
      let e = idx;
      while (s > 0 && !/[.!?。！？\n]/.test(full[s - 1]) && idx - s < MAX) s--;
      while (e < full.length && !/[.!?。！？\n]/.test(full[e]) && e - idx < MAX) e++;
      if (e - s < 24) {
        s = Math.max(0, idx - 90);
        e = Math.min(full.length, idx + 100);
      }
      return full.slice(s, e).trim();
    } catch {
      return "";
    }
  }

  function positionFloat(rect) {
    const bw = 78;
    let left = rect.left;
    let top = rect.bottom + 8;
    if (left + bw > innerWidth - 8) left = Math.max(8, innerWidth - bw - 8);
    if (top + 34 > innerHeight - 8) top = Math.max(8, rect.top - 40);
    btn.style.left = left + "px";
    btn.style.top = top + "px";
  }

  function positionPanel() {
    if (panelPinned) return; // 用户已手动移动面板，保持不动
    const r = current && current.rect ? current.rect : { left: innerWidth / 2 - 160, top: innerHeight / 3 };
    const pw = 370;
    const ph = Math.min(innerHeight * 0.72, 540);
    let left = r.left;
    let top = r.bottom + 10;
    if (left + pw > innerWidth - 10) left = Math.max(10, innerWidth - pw - 10);
    if (top + ph > innerHeight - 10) top = Math.max(10, r.top - ph - 10);
    panel.style.left = left + "px";
    panel.style.top = top + "px";
  }

  document.addEventListener(
    "mouseup",
    (e) => {
      if (eventInsideHost(e)) return;
      if (isEditable(e.target)) {
        hideFloat();
        closePanel();
        return;
      }
      setTimeout(() => {
        const sel = window.getSelection();
        const text = sel ? sel.toString().replace(/\s+/g, " ").trim() : "";
        if (!text || text.length > 300) {
          hideFloat();
          return;
        }
        if (sel.rangeCount === 0) {
          hideFloat();
          return;
        }
        const range = sel.getRangeAt(0);
        const rect = range.getBoundingClientRect();
        if (!rect || (rect.width === 0 && rect.height === 0)) {
          hideFloat();
          return;
        }
        current = { text, range, rect };
        positionFloat(rect);
        btn.hidden = false;
        if (!panel.hidden) closePanel();
      }, 10);
    },
    true
  );

  btn.addEventListener("mousedown", (e) => e.preventDefault());
  btn.addEventListener("click", () => {
    hideFloat();
    doLookup();
  });

  window.addEventListener(
    "scroll",
    (e) => {
      if (!eventInsideHost(e)) hideFloat(); // 面板内部滚动不隐藏浮动按钮
    },
    { capture: true, passive: true }
  );
  window.addEventListener("resize", () => {
    hideFloat();
    if (!panel.hidden) closePanel();
  });
  document.addEventListener(
    "keydown",
    (e) => {
      if (e.key === "Escape" && !panel.hidden) closePanel();
    },
    true
  );

  function showLoading(text) {
    panelPinned = false; // 新一轮查询时回到选中词附近
    badgeEl.textContent = "分析中";
    badgeEl.className = "ws-badge word";
    queryEl.innerHTML = "";
    metaEl.innerHTML = "";
    const q = document.createElement("span");
    q.textContent = text;
    queryEl.appendChild(q);
    bodyEl.innerHTML =
      '<div class="ws-loading"><div class="ws-spinner"></div><span>正在结合上下文分析…</span></div>';
    lastData = null;
    panel.hidden = false;
    positionPanel();
  }

  const TYPE_MAP = {
    word: ["单词", "word"],
    phrase: ["固定搭配", "phrase"],
    idiom: ["习语", "idiom"],
    other: ["其他", "other"],
  };

  function renderResult(data, fallbackText) {
    const type = TYPE_MAP[data.type] ? data.type : "other";
    const typeLabel = TYPE_MAP[type][0];
    const typeCls = TYPE_MAP[type][1];
    badgeEl.textContent = typeLabel;
    badgeEl.className = "ws-badge " + typeCls;

    queryEl.innerHTML = "";
    const q = document.createElement("span");
    q.textContent = data.query || fallbackText;
    queryEl.appendChild(q);
    metaEl.innerHTML = "";
    if (data.phonetic) {
      const ph = document.createElement("span");
      ph.className = "phonetic";
      ph.textContent = data.phonetic;
      metaEl.appendChild(ph);
    }
    if (data.pos) {
      const p = document.createElement("span");
      p.className = "pos";
      p.textContent = data.pos;
      metaEl.appendChild(p);
    }

    let html = "";
    if (data.quick) {
      html += '<div class="ws-quick-bar">⚡ 常用释义已显示，正在结合当前语境精读…</div>';
    }
    if (data.meaningInContext) {
      const title = data.quick ? "常用释义" : "在此语境中的含义";
      html += `<div class="ws-section-title">${title}</div><div class="ws-meaning">${escapeHtml(
        data.meaningInContext
      )}`;
      if (data.meaningEn) {
        html += `<div class="ws-meaning-en">${escapeHtml(data.meaningEn)}</div>`;
      }
      html += "</div>";
    }
    if (data.phraseInfo && (data.phraseInfo.phrase || data.phraseInfo.explanation)) {
      html += `<div class="ws-phrase"><span class="p">${escapeHtml(
        data.phraseInfo.phrase || ""
      )}</span><div class="e">${escapeHtml(data.phraseInfo.explanation || "")}</div></div>`;
    }
    if (Array.isArray(data.otherMeanings) && data.otherMeanings.length) {
      html +=
        `<div class="ws-section-title">其他常见含义</div><ul class="ws-list">` +
        data.otherMeanings.map((m) => `<li>${escapeHtml(m)}</li>`).join("") +
        `</ul>`;
    }
    if (Array.isArray(data.collocations) && data.collocations.length) {
      html +=
        `<div class="ws-section-title">常用搭配</div><ul class="ws-list">` +
        data.collocations.map((c) => `<li>${escapeHtml(c)}</li>`).join("") +
        `</ul>`;
    }
    if (Array.isArray(data.examples) && data.examples.length) {
      html += `<div class="ws-section-title">例句</div>`;
      data.examples.forEach((ex) => {
        if (!ex) return;
        const en = typeof ex === "string" ? ex : ex.en || "";
        const zh = typeof ex === "string" ? "" : ex.zh || "";
        html += `<div class="ws-example"><div class="en">${escapeHtml(en)}</div>${
          zh ? `<div class="zh">${escapeHtml(zh)}</div>` : ""
        }</div>`;
      });
    }
    if (data.usageNote) {
      html += `<div class="ws-note">💡 ${escapeHtml(data.usageNote)}</div>`;
    }
    bodyEl.innerHTML = html || '<div class="ws-meaning">（没有返回可显示的内容）</div>';
    lastData = data;
    panel.hidden = false;
    positionPanel();
  }

  function renderNoKey() {
    badgeEl.textContent = "未配置";
    badgeEl.className = "ws-badge other";
    queryEl.textContent = "词境";
    metaEl.innerHTML = "";
    bodyEl.innerHTML =
      '<div class="ws-error">还没有配置 API Key。请先在扩展设置中填入 API 地址和 Key，才能调用 AI 理解语境。</div><button class="ws-link-btn" type="button">打开设置</button>';
    bodyEl.querySelector(".ws-link-btn").addEventListener("click", () => {
      try {
        const p = chrome.runtime.openOptionsPage();
        if (p && p.catch) p.catch(() => {});
      } catch {
        // 忽略：设置页打不开时不影响使用
      }
    });
    lastData = null;
    panel.hidden = false;
    positionPanel();
  }

  function renderError(message, raw) {
    badgeEl.textContent = "出错了";
    badgeEl.className = "ws-badge other";
    queryEl.textContent = "词境";
    metaEl.innerHTML = "";
    let html = `<div class="ws-error">${escapeHtml(message || "查询失败")}</div>`;
    if (raw) {
      html +=
        '<details class="ws-details"><summary>查看原始返回</summary><div class="ws-raw">' +
        escapeHtml(raw) +
        "</div></details>";
    }
    bodyEl.innerHTML = html;
    lastData = null;
    panel.hidden = false;
    positionPanel();
  }

  function renderQuickErrorNote(message) {
    if (panel.hidden || !lastData) return;
    if (bodyEl.querySelector(".ws-quick-note")) return; // 同一次查询只提示一次
    const note = document.createElement("div");
    note.className = "ws-error ws-quick-note";
    note.style.marginBottom = "10px";
    note.textContent = "语境精读失败：" + (message || "请重试");
    bodyEl.prepend(note);
  }

  function doLookup() {
    if (!current || !current.text) return;
    const { text, range } = current;
    const context = getSentenceContext(range);
    const seq = ++lookupSeq;
    const requestId = "r" + seq + Math.random().toString(36).slice(2, 8);
    currentRequestId = requestId;
    showLoading(text);
    try {
      chrome.runtime.sendMessage({ type: "lookup", payload: { text, context, requestId } }, (res) => {
        if (seq !== lookupSeq) {
          void chrome.runtime.lastError; // 消费浏览器错误，避免控制台报 Unchecked runtime.lastError
          return; // 已关闭面板或发起了新查询，丢弃过期结果
        }
        if (chrome.runtime.lastError) {
          const errMsg = String(chrome.runtime.lastError.message || "未知错误");
          console.warn("[词境] 查询失败：", errMsg);
          renderError("扩展后台出错：" + errMsg);
          return;
        }
        if (res && res.ok) renderResult(res.data, text);
        else if (res && res.error === "no-api-key") renderNoKey();
        else renderError(res && res.message ? res.message : "查询失败，请重试。", res && res.raw);
      });
    } catch (err) {
      console.warn("[词境] 扩展上下文失效：", err);
      renderError("扩展已更新或后台未就绪，请刷新页面后重试。");
    }
  }

  function summaryText() {
    const d = lastData;
    if (!d) return "";
    const lines = [];
    lines.push(
      `${d.query || ""}${d.pos ? " [" + d.pos + "]" : ""}${d.phonetic ? " " + d.phonetic : ""}`
    );
    if (d.meaningInContext) lines.push("含义：" + d.meaningInContext);
    if (d.phraseInfo && d.phraseInfo.phrase) {
      lines.push(`搭配/习语：${d.phraseInfo.phrase} —— ${d.phraseInfo.explanation || ""}`);
    }
    if (Array.isArray(d.examples) && d.examples.length) {
      lines.push("例句：");
      d.examples.forEach((ex) => {
        const en = typeof ex === "string" ? ex : ex.en || "";
        const zh = typeof ex === "string" ? "" : ex.zh || "";
        lines.push(`  ${en}${zh ? " / " + zh : ""}`);
      });
    }
    return lines.join("\n");
  }

  copyBtn.addEventListener("click", async () => {
    const txt = summaryText();
    if (!txt) return;
    try {
      await navigator.clipboard.writeText(txt);
      copyBtn.textContent = "✅ 已复制";
    } catch {
      const ta = document.createElement("textarea");
      ta.value = txt;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
      copyBtn.textContent = "✅ 已复制";
    }
    setTimeout(() => {
      copyBtn.textContent = "📋 复制";
    }, 1600);
  });

  speakBtn.addEventListener("click", () => {
    const d = lastData;
    if (!d) return;
    const ex =
      Array.isArray(d.examples) && d.examples[0]
        ? typeof d.examples[0] === "string"
          ? d.examples[0]
          : d.examples[0].en || ""
        : "";
    const text = ex || d.query || "";
    if (!text || !("speechSynthesis" in window)) return;
    try {
      stopYoudao();
      stopSpeak();
      const u = new SpeechSynthesisUtterance(text);
      u.lang = "en-US";
      u.rate = 0.95;
      window.speechSynthesis.speak(u);
    } catch {
      // 忽略朗读失败
    }
  });

  function stopSpeak() {
    if ("speechSynthesis" in window) {
      try {
        window.speechSynthesis.cancel();
      } catch {
        // 忽略
      }
    }
    pronBrowserBtn.classList.remove("playing");
  }

  function stopYoudao() {
    if (youdaoAudio) {
      try {
        youdaoAudio.pause();
      } catch {
        // 忽略
      }
      youdaoAudio = null;
    }
    pronYoudaoBtn.classList.remove("playing");
  }

  function speakWord(text, onEnd) {
    if (!text || !("speechSynthesis" in window)) {
      if (onEnd) onEnd();
      return null;
    }
    try {
      stopYoudao();
      const u = new SpeechSynthesisUtterance(text);
      u.lang = "en-US";
      u.rate = 0.9;
      const voices = window.speechSynthesis.getVoices();
      const voice =
        voices.find((v) => v.lang && v.lang.toLowerCase().startsWith("en-us")) ||
        voices.find((v) => v.lang && v.lang.toLowerCase().startsWith("en"));
      if (voice) u.voice = voice;
      if (onEnd) {
        u.onend = onEnd;
        u.onerror = onEnd;
      }
      window.speechSynthesis.speak(u);
      return u;
    } catch (err) {
      console.warn("[词境] 浏览器发音失败：", err);
      if (onEnd) onEnd();
      return null;
    }
  }

  function playYoudao(text) {
    if (!text) return;
    stopSpeak();
    stopYoudao();
    const url = "https://dict.youdao.com/dictvoice?audio=" + encodeURIComponent(text) + "&type=2";
    const a = new Audio(url);
    youdaoAudio = a;
    pronYoudaoBtn.classList.add("playing");
    a.onended = stopYoudao;
    a.onerror = () => {
      console.warn("[词境] 有道发音失败，已退回浏览器发音");
      stopYoudao();
      speakWord(text);
    };
    a.play().catch(() => {
      console.warn("[词境] 有道发音被浏览器拦截，已退回浏览器发音");
      stopYoudao();
      speakWord(text);
    });
  }

  function currentWord() {
    const d = lastData;
    return (d && d.query) || (current && current.text) || "";
  }

  pronBrowserBtn.addEventListener("click", () => {
    const w = currentWord();
    if (!w) return;
    pronBrowserBtn.classList.add("playing");
    speakWord(w, () => pronBrowserBtn.classList.remove("playing"));
  });

  pronYoudaoBtn.addEventListener("click", () => {
    playYoudao(currentWord());
  });

  panel.querySelector(".ws-close").addEventListener("click", closePanel);

  const headEl = panel.querySelector(".ws-panel-head");
  headEl.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    if (e.target.closest && e.target.closest(".ws-close, .ws-pron-btn")) return;
    e.preventDefault();
    dragState = {
      startX: e.clientX,
      startY: e.clientY,
      left: parseInt(panel.style.left, 10) || 0,
      top: parseInt(panel.style.top, 10) || 0,
    };
    panel.classList.add("ws-dragging");
    headEl.setPointerCapture(e.pointerId);
  });

  headEl.addEventListener("pointermove", (e) => {
    if (!dragState) return;
    const dx = e.clientX - dragState.startX;
    const dy = e.clientY - dragState.startY;
    const pw = panel.offsetWidth || 370;
    const ph = panel.offsetHeight || 320;
    const left = Math.max(-pw + 80, Math.min(innerWidth - 80, dragState.left + dx));
    const top = Math.max(0, Math.min(innerHeight - 28, dragState.top + dy));
    panel.style.left = left + "px";
    panel.style.top = top + "px";
  });

  function endDrag() {
    if (!dragState) return;
    dragState = null;
    panel.classList.remove("ws-dragging");
    panelPinned = true;
  }
  headEl.addEventListener("pointerup", endDrag);
  headEl.addEventListener("pointercancel", endDrag);

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || typeof msg !== "object") return false;
    if (msg.type === "trigger-lookup") {
      if (!current || !current.text) {
        const sel = window.getSelection();
        const text = sel ? sel.toString().replace(/\s+/g, " ").trim() : "";
        if (text && text.length <= 300 && sel.rangeCount > 0) {
          const range = sel.getRangeAt(0);
          current = { text, range, rect: range.getBoundingClientRect() };
        }
      }
      if (current && current.text) doLookup();
      sendResponse({ ok: true });
      return false;
    }
    if (msg.type === "lookup-update") {
      if (!panel.hidden && msg.requestId === currentRequestId) {
        renderResult(msg.data, (msg.data && msg.data.query) || "");
      }
      sendResponse({ ok: true });
      return false;
    }
    if (msg.type === "lookup-error") {
      if (!panel.hidden && msg.requestId === currentRequestId) {
        renderQuickErrorNote(msg.message);
      }
      sendResponse({ ok: true });
      return false;
    }
    return false;
  });
})();
