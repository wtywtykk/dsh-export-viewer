/* app.js — DSH session viewer: chat, trajectory ledger, overview.
   支持主会话 + 子代理会话切换；子代理调用处显示跳转链接。
   界面按当前 DSH Web 聊天界面重做：
     · 每个轮次的工作过程（推理 / 工具调用 / 中间回复）折叠在“已完成，用时 …”一行后面
     · 右侧轮次快速跳转条（悬停预览提问与最终回复，点击跳转） */
(function () {
  'use strict';

  const D = window.__DSH_VIEWER__;
  if (!D || !D.main) {
    document.body.innerHTML = '<p style="padding:40px;font-family:monospace">数据未加载</p>';
    return;
  }

  /* ---------------- markdown image sources ----------------
     Local image paths in assistant Markdown are embedded by the build/host as
     data URLs under `D.media`; resolve them so a standalone page can show them. */
  const MEDIA = D.media || {};
  const mediaSrc = (src) => {
    const s = String(src);
    const has = (key) => Object.prototype.hasOwnProperty.call(MEDIA, key);
    if (has(s)) return MEDIA[s];
    const clean = s.replace(/^\.\//, '').replace(/\\/g, '/');
    if (has(clean)) return MEDIA[clean];
    let decoded = clean;
    try {
      decoded = decodeURIComponent(clean);
    } catch {
      /* keep clean */
    }
    if (has(decoded)) return MEDIA[decoded];
    return s;
  };
  if (window.DSHMarkdown && window.DSHMarkdown.setImageResolver) {
    window.DSHMarkdown.setImageResolver(mediaSrc);
  }

  /* ---------------- session state ---------------- */
  const SUBAGENTS = D.subagents || [];
  const SUBAGENT_BY_ID = new Map(SUBAGENTS.map((s) => [s.id, s]));
  let current = D.main; // current session model {meta, turns, ledger}
  let currentSub = null; // {id, description, ...} or null for main session
  let META = current.meta;
  let sessionKey = 'main';

  let assistantMap = new Map();
  let toolMap = new Map();
  let turnInfo = []; // enriched turns (answer index, process runs, previews)
  let railItems = [];
  const foldState = new Map(); // `${sessionKey}:${turn}` -> open
  const answerTexts = new Map(); // `${ti}:${turn}` -> answer text

  const shortId = (id) => (id ? String(id).slice(0, 8) : '');
  const stateKey = (turn) => sessionKey + ':' + turn;

  function indexSession() {
    assistantMap = new Map();
    toolMap = new Map();
    for (const t of current.turns) {
      for (const n of t.nodes) {
        if (n.kind === 'assistant') assistantMap.set(n.turn + '/' + n.step + '/' + n.time, n);
        else if (n.kind === 'tool-call') toolMap.set(n.callId, n);
      }
    }
    buildTurnInfo();
  }

  /* ---------------- helpers ---------------- */
  const esc = (s) =>
    String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');

  const fmtDur = (ms) => {
    if (ms == null || !isFinite(ms) || ms < 0) return '';
    if (ms < 1000) return Math.round(ms) + 'ms';
    const s = ms / 1000;
    if (s < 60) return (s >= 10 ? s.toFixed(0) : s.toFixed(1)) + 's';
    if (s < 3600) {
      const m = Math.floor(s / 60);
      const r = Math.round(s % 60);
      return m + 'm' + (r < 10 ? '0' : '') + r + 's';
    }
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const r = Math.round(s % 60);
    return h + 'h' + (m < 10 ? '0' : '') + m + 'm' + (r < 10 ? '0' : '') + r + 's';
  };

  /** Duration wording used by the current DSH work-details row. */
  const fmtDurZh = (ms) => {
    if (ms == null || !isFinite(ms) || ms < 0) return '';
    const total = Math.max(1, Math.round(ms / 1000));
    if (total < 60) return total + '秒';
    if (total < 3600) {
      const m = Math.floor(total / 60);
      const s = total % 60;
      return s ? m + '分' + s + '秒' : m + '分';
    }
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    return m ? h + '小时' + m + '分' : h + '小时';
  };

  const fmtTokens = (n) => {
    if (n == null) return '0';
    if (n < 1000) return String(n);
    if (n < 1e6) return (n / 1e3).toFixed(1) + 'K';
    return (n / 1e6).toFixed(2) + 'M';
  };

  const fmtTime = (t) => {
    if (!t) return '';
    const d = new Date(t);
    const p = (x) => String(x).padStart(2, '0');
    return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  };

  const fmtDateTime = (t) => {
    if (!t) return '';
    const d = new Date(t);
    const p = (x) => String(x).padStart(2, '0');
    return (
      d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
      ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds())
    );
  };

  const truncate = (s, n) => (s && s.length > n ? s.slice(0, n) : s);

  const normalizePreview = (s, cap) => {
    const t = String(s || '').replace(/\s+/g, ' ').trim();
    return t.length > cap ? t.slice(0, cap) + '…' : t;
  };

  const prettyJSON = (s) => {
    if (s == null || s === '') return '';
    try {
      return JSON.stringify(JSON.parse(s), null, 2);
    } catch {
      return String(s);
    }
  };

  const textBlocks = (blocks) =>
    (blocks || []).filter((b) => b.type === 'text' && b.text && b.text.trim()).map((b) => b.text);

  /** Inline image gallery; `images` carries `{ src, name, width, height }` entries. */
  const imagesHTML = (images, cls) => {
    if (!Array.isArray(images) || !images.length) return '';
    return (
      '<div class="msg-images' + (cls ? ' ' + cls : '') + '">' +
      images
        .filter((im) => im && im.src)
        .map(
          (im) =>
            '<a class="msg-image" href="' + esc(im.src) + '" target="_blank" rel="noopener" title="' + esc(im.name || '图片') + '">' +
            '<img src="' + esc(im.src) + '" alt="' + esc(im.name || '图片') + '"' +
            (im.width ? ' width="' + Number(im.width) + '"' : '') +
            (im.height ? ' height="' + Number(im.height) + '"' : '') +
            ' loading="lazy" /></a>',
        )
        .join('') +
      '</div>'
    );
  };

  /* ---------------- icons (inline SVG) ---------------- */
  const I = {
    wrench: '<svg viewBox="0 0 24 24"><path d="M14.7 6.3a4.5 4.5 0 0 0-6 6L3 18l3 3 5.7-5.7a4.5 4.5 0 0 0 6-6L14 13l-3-3 3.7-3.7z"/></svg>',
    think: '<svg viewBox="0 0 24 24"><path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/><path d="M18 15l.8 2.2L21 18l-2.2.8L18 21l-.8-2.2L15 18l2.2-.8z"/></svg>',
    terminal: '<svg viewBox="0 0 24 24"><path d="M4 17l6-5-6-5M12 19h8"/></svg>',
    check: '<svg viewBox="0 0 24 24"><path d="M20 6L9 17l-5-5"/></svg>',
    x: '<svg viewBox="0 0 24 24"><path d="M18 6L6 18M6 6l12 12"/></svg>',
    clock: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/></svg>',
    chev: '<svg viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg>',
    chevDown: '<svg viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg>',
    copy: '<svg viewBox="0 0 24 24"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>',
    flag: '<svg viewBox="0 0 24 24"><path d="M4 22V4a1 1 0 0 1 1-1h10.5a1 1 0 0 1 .94.66L17.5 6l1.06 2.34A1 1 0 0 1 17.62 10H5"/></svg>',
    bot: '<svg viewBox="0 0 24 24"><rect x="4" y="8" width="16" height="12" rx="2"/><path d="M12 8V4M9 4h6"/><circle cx="9" cy="14" r="1"/><circle cx="15" cy="14" r="1"/></svg>',
    file: '<svg viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>',
    arrowUp: '<svg viewBox="0 0 24 24"><path d="M12 19V5M5 12l7-7 7 7"/></svg>',
  };

  /* ============================================================
     Turn model
     ============================================================ */
  function buildTurnInfo() {
    turnInfo = current.turns.map((t) => {
      const nodes = t.nodes;
      const head = nodes.find((n) => n.kind === 'turn-head') || null;

      // The turn's answer is its last assistant message when that message has
      // text and no tool call (the rule the DSH chat view uses).
      let lastAssistant = -1;
      for (let i = 0; i < nodes.length; i++) if (nodes[i].kind === 'assistant') lastAssistant = i;
      let answerIdx = -1;
      if (lastAssistant >= 0) {
        const a = nodes[lastAssistant];
        const hasText = a.blocks.some((b) => b.type === 'text' && b.text.trim());
        const hasTool = a.blocks.some((b) => b.type === 'tool');
        if (hasText && !hasTool) answerIdx = lastAssistant;
      }

      // Contiguous runs of process nodes: reasoning, tool calls, interim
      // commentary, and the system cards (goal / todo / command / retry).
      const isProcessNode = (n, i) => {
        if (n.kind === 'turn-head' || n.kind === 'tool-call') return false;
        if (n.kind === 'user' || n.kind === 'inject') return false;
        if (i === answerIdx) return false;
        return true;
      };
      const runs = [];
      let cur = null;
      for (let i = 0; i < nodes.length; i++) {
        if (isProcessNode(nodes[i], i)) {
          if (!cur) cur = [];
          cur.push(i);
        } else if (cur) {
          runs.push(cur);
          cur = null;
        }
      }
      if (cur) runs.push(cur);

      let stepCount = 0;
      let toolCount = 0;
      for (const run of runs) {
        for (const i of run) {
          const n = nodes[i];
          if (n.kind === 'assistant') {
            stepCount++;
            toolCount += n.blocks.filter((b) => b.type === 'tool').length;
          }
        }
      }

      const userNode = nodes.find((n) => n.kind === 'user' && n.text.trim());
      const prompt = normalizePreview(userNode ? userNode.text : '', 50);
      const response = answerIdx >= 0 ? normalizePreview(textBlocks(nodes[answerIdx].blocks).join(' '), 120) : '';

      return { turn: t.turn, nodes, head, answerIdx, runs, stepCount, toolCount, prompt, response };
    });

    // Default: every turn starts folded, so the reasoning and tool process stays
    // out of the way until the reader expands it.
    turnInfo.forEach((info) => {
      if (!foldState.has(stateKey(info.turn))) {
        foldState.set(stateKey(info.turn), false);
      }
    });
  }

  const isTurnOpen = (turn) => foldState.get(stateKey(turn)) !== false;

  /* ============================================================
     Sidebar + header
     ============================================================ */
  function fillSidebar() {
    document.getElementById('sidebar-model').textContent = META.model + ' · ' + META.provider;

    const list = document.getElementById('session-list');
    const isMain = !currentSub;
    const mainMeta = D.main.meta; // 主会话条目始终显示主会话的元信息，不随 current 变化
    document.getElementById('session-section-label').textContent =
      '会话' + (SUBAGENTS.length ? ' · 子代理 ' + SUBAGENTS.length : '');

    let html =
      '<button class="session-item' + (isMain ? ' active' : '') + '" data-session="main">' +
      '<span class="session-item-head"><span class="session-item-ico">' + I.file + '</span>' +
      '<span class="session-item-title">' + esc(mainMeta.title || '主会话') + '</span></span>' +
      '<span class="session-item-meta">主会话 · ' + mainMeta.turnsCount + ' 轮 · ' + mainMeta.toolCount + ' 工具</span>' +
      '</button>';
    for (const s of SUBAGENTS) {
      const active = currentSub && currentSub.id === s.id;
      const depth = Math.max(1, (s.depth || 1) - 1);
      const title = s.label || s.description || '子代理 ' + shortId(s.id);
      html +=
        '<button class="session-item sub depth-' + Math.min(depth, 3) + (active ? ' active' : '') + '" data-session="' + esc(s.id) + '">' +
        '<span class="session-item-head"><span class="session-item-ico">' + I.bot + '</span>' +
        '<span class="session-item-title">' + esc(title) + '</span></span>' +
        '<span class="session-item-meta">' + shortId(s.id) + ' · ' + (s.meta ? s.meta.turnsCount : 0) + ' 轮 · ' + (s.meta ? s.meta.toolCount : 0) + ' 工具</span>' +
        '</button>';
    }
    list.innerHTML = html;
  }

  function fillHeader() {
    const backBtn = document.getElementById('back-main');
    if (currentSub) {
      backBtn.classList.remove('hidden');
      document.getElementById('conv-title').textContent =
        '子代理 · ' + truncate(currentSub.label || currentSub.description || shortId(currentSub.id), 46);
      const badge = document.getElementById('conv-status');
      badge.textContent = 'subagent';
      badge.classList.remove('done');
      document.getElementById('conv-subtitle').textContent =
        '会话 ' + shortId(currentSub.id) + ' · ' + currentSub.meta.turnsCount + ' 轮 / ' +
        currentSub.meta.stepsCount + ' 步 / ' + currentSub.meta.toolCount + ' 次工具调用 · 共 ' +
        currentSub.meta.eventCount + ' 条事件';
    } else {
      backBtn.classList.add('hidden');
      document.getElementById('conv-title').textContent = META.title;
      const last = turnInfo[turnInfo.length - 1];
      const running = last && last.head && last.head.endTime == null;
      const failed = last && last.head && last.head.reason && last.head.reason.kind === 'error';
      const badge = document.getElementById('conv-status');
      badge.textContent = running ? '进行中' : failed ? '出错' : '已结束';
      badge.classList.toggle('done', !running && !failed);
      document.getElementById('conv-subtitle').textContent =
        'format v' + (META.version ?? '?') +
        ' · 会话 ' + shortId(META.id || '') +
        ' · 创建于 ' + fmtDateTime(META.createdAt) +
        ' · ' + META.turnsCount + ' 轮 / ' + META.stepsCount + ' 步 / ' + META.toolCount + ' 次工具调用' +
        ' · 共 ' + META.eventCount + ' 条事件' +
        (SUBAGENTS.length ? ' · 子代理 ' + SUBAGENTS.length + ' 个' : '');
    }
  }

  /* ============================================================
     Chat view
     ============================================================ */
  function subJumpHTML(subId, label) {
    const s = SUBAGENT_BY_ID.get(subId);
    if (!s) return '';
    return '<button class="sub-jump" data-jump-sub="' + esc(subId) + '">' + esc(label || '查看子代理会话') + ' ↗</button>';
  }

  /** One-line target summary for a tool call, mirroring the chat row in DSH. */
  function toolTarget(name, argsText) {
    let a = {};
    try {
      a = JSON.parse(argsText);
    } catch {
      return truncate(argsText, 80);
    }
    if (!a || typeof a !== 'object') return truncate(String(argsText), 80);
    const pick = (...keys) => {
      for (const k of keys) {
        const v = a[k];
        if (typeof v === 'string' && v.trim()) return v;
      }
      return '';
    };
    let v = '';
    switch (name) {
      case 'read':
      case 'write':
      case 'edit':
      case 'str_replace_editor':
        v = pick('file_path', 'path');
        break;
      case 'glob':
      case 'grep':
        v = pick('pattern');
        break;
      case 'pwsh':
      case 'bash':
        v = pick('command');
        break;
      case 'subagent':
      case 'subagent_fork':
        v = pick('description');
        break;
      case 'web_search':
        v = Array.isArray(a.queries) ? a.queries.join(' | ') : pick('query');
        break;
      case 'web_fetch':
        v = pick('url');
        break;
      case 'ask_user_question':
        v = (a.questions && a.questions[0] && a.questions[0].question) || '';
        break;
      case 'present':
        v = Array.isArray(a.files) ? a.files.map((f) => f.path || f.label || f).join(', ') : '';
        break;
      default: {
        for (const key of Object.keys(a)) {
          if (typeof a[key] === 'string' && a[key].trim()) {
            v = a[key];
            break;
          }
        }
      }
    }
    return truncate(v.replace(/\s+/g, ' '), 96);
  }

  function toolCardHTML(callId) {
    const rec = toolMap.get(callId);
    const name = rec ? rec.name : 'tool';
    const isError = rec ? rec.isError : false;
    const dur = rec ? rec.durationMs : null;
    const argsPretty = prettyJSON(rec ? rec.argsText : '');
    const argsFull = rec ? rec.argsText : '';
    const resultText = rec ? rec.resultText : '';
    const resultImages = rec && Array.isArray(rec.images) ? rec.images : [];
    const errorInfo = rec && rec.error ? rec.error : null;
    const subId = rec ? rec.subId : null;
    const target = rec ? toolTarget(rec.name, rec.argsText) : '';

    const argsShort = truncate(argsPretty || argsFull, 2400);
    const argsLonger = (argsPretty || argsFull).length > (argsShort || argsFull).length;
    const resShort = truncate(resultText, 6000);
    const resLonger = resultText.length > resShort.length;

    let h =
      '<div class="tool-card' + (isError ? ' error' : '') + '" data-call="' + esc(callId) + '">' +
      '<div class="tool-card-head" data-action="toggle-tool" data-call="' + esc(callId) + '">' +
      '<span class="tool-icon">' + I.wrench + '</span>' +
      '<span class="tool-name">' + esc(name) + '</span>' +
      (target ? '<span class="tool-target">' + esc(target) + '</span>' : '') +
      (dur != null ? '<span class="tool-duration">' + fmtDur(dur) + '</span>' : '') +
      '<span class="tool-status">' + (isError ? '<span class="err">' + I.x + '</span>' : '<span class="ok">' + I.check + '</span>') + '</span>' +
      '<span class="tool-chev">' + I.chev + '</span>' +
      '</div>' +
      '<div class="tool-card-body">';

    if (subId) {
      const s = SUBAGENT_BY_ID.get(subId);
      h += '<div class="sub-jump-row">' +
        subJumpHTML(subId, '查看子代理会话 ' + shortId(subId) + (s && (s.label || s.description) ? ' · ' + truncate(s.label || s.description, 40) : '')) +
        '</div>';
    }

    h += '<div class="tool-section" data-section="args">' +
      '<div class="tool-section-label" data-action="toggle-section"><span class="chev">' + I.chev + '</span>参数 (arguments)' +
      '<span class="tool-callid">' + esc(String(callId || '').slice(0, 24)) + '</span></div>' +
      '<div class="tool-section-content"><pre>' + esc(argsShort) + '</pre>' +
      (argsLonger ? '<button class="expand-btn" data-action="expand-args" data-call="' + esc(callId) + '">展开全部</button>' : '') +
      '</div></div>';

    const resCls = isError ? 'tool-result-text err' : 'tool-result-text';
    h += '<div class="tool-section' + (isError || resultImages.length ? ' open' : '') + '" data-section="result">' +
      '<div class="tool-section-label" data-action="toggle-section"><span class="chev">' + I.chev + '</span>结果 (result)' +
      (resultImages.length ? '<span class="tool-callid">' + resultImages.length + ' 张图片</span>' : '') + '</div>' +
      '<div class="tool-section-content">' + imagesHTML(resultImages, 'tool-images') +
      '<pre class="' + resCls + '">' + esc(resShort) + '</pre>' +
      (resLonger ? '<button class="expand-btn" data-action="expand-result" data-call="' + esc(callId) + '">展开全部</button>' : '') +
      '</div></div>';

    if (errorInfo) {
      h += '<div class="tool-error-banner">' + esc(errorInfo.name + ': ' + (errorInfo.code || '')) + '</div>';
    }
    h += '</div></div>';
    return h;
  }

  function reasoningHTML(text) {
    const first = String(text || '')
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.length) || '';
    return (
      '<div class="reasoning" data-reasoning>' +
      '<div class="reasoning-head" data-action="toggle-reasoning">' +
      '<span class="reasoning-ico">' + I.think + '</span>' +
      '<span class="reasoning-title">思考</span>' +
      (first ? '<span class="reasoning-sep">·</span><span class="reasoning-summary">' + esc(normalizePreview(first, 160)) + '</span>' : '') +
      '<span class="chev">' + I.chevDown + '</span>' +
      '</div>' +
      '<div class="reasoning-body"><pre>' + esc(text) + '</pre></div>' +
      '</div>'
    );
  }

  /** Process row: one assistant step's reasoning, commentary and tool calls. */
  function processStepHTML(n) {
    let blocks = '';
    for (const b of n.blocks) {
      if (b.type === 'reasoning') {
        if (b.text && b.text.trim()) blocks += reasoningHTML(b.text);
      } else if (b.type === 'text' && b.text && b.text.trim()) {
        blocks += '<div class="md process-text">' + window.DSHMarkdown.render(b.text) + '</div>';
      } else if (b.type === 'image') {
        blocks += imagesHTML([b], 'process-image');
      } else if (b.type === 'tool') {
        blocks += toolCardHTML(b.callId);
      }
    }
    if (!blocks) return '';
    return (
      '<div class="process-step">' +
      '<div class="step-line">Step ' + n.step +
      (n.time ? ' · ' + fmtTime(n.time) : '') +
      (n.stepMs != null ? ' · ' + fmtDur(n.stepMs) : '') +
      '</div>' + blocks + '</div>'
    );
  }

  function injectHTML(n, idx) {
    const label = n.sourceLabel || '系统注入';
    const preview = n.summary ? truncate(String(n.summary), 110) : truncate(normalizePreview(n.text, 110), 110);
    let h =
      '<div class="inject-row">' +
      '<button class="inject-chip' + (n.isSystem ? ' system' : '') + '" data-action="toggle-inject" data-idx="' + idx + '">' +
      '<span class="dot"></span><span class="inject-label">' + esc(label) + '</span>' +
      (preview ? '<span class="inject-preview">' + esc(preview) + '</span>' : '') +
      '</button>' +
      (n.subId ? subJumpHTML(n.subId, '查看子代理 ' + shortId(n.subId)) : '') +
      '</div>';
    if (n.text && n.text.length > 0) {
      h += '<div class="inject-detail hidden" data-inject-detail="' + idx + '"><pre>' + esc(n.text) + '</pre></div>';
    }
    return h;
  }

  function userHTML(n) {
    return (
      '<div class="user-row"><div class="user-bubble">' +
      (n.text ? '<div class="user-text">' + esc(n.text) + '</div>' : '') +
      imagesHTML(n.images) +
      '</div></div>' +
      '<div class="user-meta">' + fmtTime(n.time) + '</div>'
    );
  }

  function goalHTML(n) {
    const opClass = n.op === 'complete' ? 'tag-green' : n.op === 'create' ? 'tag-blue' : n.op === 'pause' ? 'tag-amber' : 'tag-blue';
    return (
      '<div class="sys-card open">' +
      '<div class="sys-card-head" data-action="toggle-card">' +
      '<span class="sys-ico">' + I.flag + '</span>' +
      '<span>目标 · ' + esc(n.op) + '</span>' +
      '<span class="tag ' + opClass + '">' + esc(n.phase || '') + '</span>' +
      (n.revision != null ? '<span class="tag">rev ' + n.revision + '</span>' : '') +
      (n.roundsStarted != null ? '<span class="tag">' + n.roundsStarted + ' 轮</span>' : '') +
      '<span class="chev">' + I.chev + '</span>' +
      '</div>' +
      '<div class="sys-card-body"><div class="goal-objective">' + esc(n.objective || '') + '</div></div>' +
      '</div>'
    );
  }

  function todoHTML(n) {
    const items = n.items || [];
    const visible = items.slice(0, 12);
    const more = items.length - visible.length;
    const dotCls = (s) => (s === 'done' ? 'done' : s === 'in_progress' ? 'in_progress' : s === 'cancelled' ? 'cancelled' : 'pending');
    let list = '';
    for (const it of visible) {
      list +=
        '<div class="todo-item"><span class="todo-status ' + dotCls(it.status) + '"></span>' +
        '<span class="todo-text' + (it.status === 'done' ? ' done' : '') + '">' + esc(it.content) + '</span></div>';
    }
    if (more > 0) list += '<div class="todo-item"><span class="todo-status pending"></span><span class="todo-text">… 其余 ' + more + ' 项</span></div>';
    return (
      '<div class="sys-card">' +
      '<div class="sys-card-head" data-action="toggle-card">' +
      '<span class="sys-ico">' + I.check + '</span>' +
      '<span>待办清单 · ' + items.length + ' 项</span>' +
      '<span class="tag">' + fmtTime(n.time) + '</span>' +
      '<span class="chev">' + I.chev + '</span>' +
      '</div>' +
      '<div class="sys-card-body">' + list + '</div>' +
      '</div>'
    );
  }

  function commandHTML(n) {
    return (
      '<div class="sys-card">' +
      '<div class="sys-card-head" data-action="toggle-card">' +
      '<span class="sys-ico">' + I.terminal + '</span>' +
      '<span>命令 ' + esc(n.op) + ' · ' + esc(n.name) + '</span>' +
      (n.args ? '<span class="tag">' + esc(truncate(n.args, 60)) + '</span>' : '') +
      '<span class="chev">' + I.chev + '</span>' +
      '</div>' +
      '<div class="sys-card-body"><pre>' + esc(n.name + ' ' + (n.args || '')) + '</pre></div>' +
      '</div>'
    );
  }

  function retryHTML(n) {
    return (
      '<div class="sys-card">' +
      '<div class="sys-card-head" data-action="toggle-card">' +
      '<span class="sys-ico">' + I.clock + '</span>' +
      '<span>LLM 重试 · ' + esc(n.op) + '</span>' +
      '<span class="chev">' + I.chev + '</span>' +
      '</div>' +
      '<div class="sys-card-body"><pre>' + esc(JSON.stringify(n.data, null, 1)) + '</pre></div>' +
      '</div>'
    );
  }

  function developerHTML(n) {
    const items = n.items || [];
    const text = items.map((it) => (it.op === 'remove' ? '− ' : '+ ') + it.name).join('  ');
    return (
      '<div class="sys-card">' +
      '<div class="sys-card-head" data-action="toggle-card">' +
      '<span class="sys-ico">' + I.wrench + '</span>' +
      '<span>工具定义变更 · ' + items.length + ' 项</span>' +
      '<span class="chev">' + I.chev + '</span>' +
      '</div>' +
      '<div class="sys-card-body"><pre>' + esc(text) + '</pre></div>' +
      '</div>'
    );
  }

  function usageLine(u, tokens) {
    if (!u) return '';
    const bits = [];
    if (tokens) bits.push('<span class="u"><b>in</b> ' + fmtTokens(u.inputTokens || 0) + '</span>');
    bits.push('<span class="u"><b>out</b> ' + fmtTokens(u.outputTokens || 0) + '</span>');
    if (u.reasoningTokens) bits.push('<span class="u"><b>推理</b> ' + fmtTokens(u.reasoningTokens) + '</span>');
    if (u.cacheReadTokens) bits.push('<span class="u"><b>缓存</b> ' + fmtTokens(u.cacheReadTokens) + '</span>');
    return bits.join('');
  }

  function foldHeaderHTML(info, open) {
    const head = info.head;
    const running = head && head.endTime == null;
    const reason = head && head.reason ? head.reason.kind : null;
    const stopped = reason === 'aborted' || reason === 'interrupted';
    const failed = reason === 'error';
    const dur = head && head.durationMs != null ? fmtDurZh(head.durationMs) : '';
    let label = '已完成';
    if (running) label = '进行中';
    else if (stopped) label = '已停止';
    else if (failed) label = '处理失败';
    else if (dur) label = '已完成，用时 ' + dur;
    const detail = [];
    if (info.stepCount) detail.push(info.stepCount + ' 步');
    if (info.toolCount) detail.push(info.toolCount + ' 次工具');
    return (
      '<button class="process-fold" data-action="toggle-turn" data-turn="' + info.turn + '" data-open="' + (open ? '1' : '') + '"' +
      ' aria-expanded="' + (open ? 'true' : 'false') + '">' +
      (running ? '<span class="fold-dot"></span>' : '') +
      '<span class="fold-label">' + esc(label) + (detail.length ? ' · ' + detail.join(' · ') : '') + '</span>' +
      '<span class="chev">' + I.chevDown + '</span>' +
      '</button>'
    );
  }

  function answerHTML(info, n) {
    const text = textBlocks(n.blocks).join('\n\n');
    const key = String(info.turn);
    answerTexts.set(key, text);
    const lead = n.blocks.filter((b) => b.type === 'reasoning' && b.text && b.text.trim());
    const answerImages = n.blocks.filter((b) => b.type === 'image');
    const u = n.usage || null;
    const usage = usageLine(u, true);
    const footer =
      '<div class="answer-footer">' +
      '<button class="ans-btn" data-action="copy-answer" data-answer="' + key + '" title="复制回复">' + I.copy + '<span>复制</span></button>' +
      (n.model ? '<span class="ans-meta">' + esc(n.model) + '</span>' : '') +
      (usage ? '<span class="ans-usage">' + usage + '</span>' : '') +
      (n.stepMs != null ? '<span class="ans-meta">步骤 ' + fmtDur(n.stepMs) + '</span>' : '') +
      '<span class="ans-time">' + fmtTime(n.time) + '</span>' +
      '</div>';
    let leadHtml = '';
    if (lead.length) {
      leadHtml = '<div class="process-run answer-lead">' + lead.map((b) => reasoningHTML(b.text)).join('') + '</div>';
    }
    return (
      '<div class="answer-block">' + leadHtml +
      '<div class="md answer-md">' + window.DSHMarkdown.render(text) + '</div>' +
      imagesHTML(answerImages, 'answer-images') +
      footer +
      '</div>'
    );
  }

  function renderProcessNode(n) {
    switch (n.kind) {
      case 'assistant':
        return processStepHTML(n);
      case 'goal':
        return goalHTML(n);
      case 'todo':
        return todoHTML(n);
      case 'command':
        return commandHTML(n);
      case 'retry':
        return retryHTML(n);
      case 'developer':
        return developerHTML(n);
      default:
        return '';
    }
  }

  function fillRuns(info) {
    const block = document.getElementById('turn-' + info.turn);
    if (!block) return;
    for (const el of block.querySelectorAll('.process-run[data-run]')) {
      const ri = Number(el.dataset.run);
      if (el.dataset.filled === '1') continue;
      const run = info.runs[ri];
      if (!run) continue;
      el.innerHTML = run.map((i) => renderProcessNode(info.nodes[i])).join('');
      el.dataset.filled = '1';
    }
  }

  function renderChat() {
    const stream = document.getElementById('chat-stream');
    answerTexts.clear();
    let injectIdx = 0;
    const parts = [];

    for (let ti = 0; ti < turnInfo.length; ti++) {
      const info = turnInfo[ti];
      const open = isTurnOpen(info.turn);
      parts.push(
        '<div class="turn-block' + (open ? '' : ' folded') + '" data-turn="' + info.turn + '" data-ti="' + ti + '" id="turn-' + info.turn + '">',
      );
      const headDur = info.head && info.head.durationMs != null ? fmtDur(info.head.durationMs) : null;
      parts.push(
        '<div class="turn-separator"><span class="turn-sep-label">第 ' + info.turn + ' 轮' +
        (info.head ? ' · ' + fmtTime(info.head.time) : '') +
        (headDur ? ' · ' + headDur : '') +
        '</span></div>',
      );

      const runOf = new Map();
      info.runs.forEach((nodes, ri) => nodes.forEach((ni) => runOf.set(ni, ri)));
      let openRun = -1;

      for (let i = 0; i < info.nodes.length; i++) {
        const n = info.nodes[i];
        if (n.kind === 'turn-head' || n.kind === 'tool-call') continue;
        if (runOf.has(i)) {
          const ri = runOf.get(i);
          if (ri === openRun) continue;
          openRun = ri;
          if (ri === 0) parts.push(foldHeaderHTML(info, open));
          parts.push('<div class="process-run" data-run="' + ri + '"></div>');
          continue;
        }
        if (i === info.answerIdx) {
          parts.push(answerHTML(info, n));
          continue;
        }
        if (n.kind === 'user') parts.push(userHTML(n));
        else if (n.kind === 'inject') parts.push(injectHTML(n, injectIdx++));
      }

      parts.push('</div>');
    }
    stream.innerHTML = parts.join('');

    // Render the open turn's process rows now; folded turns render on demand.
    for (const info of turnInfo) {
      if (isTurnOpen(info.turn)) fillRuns(info);
    }
    updateProcessToggle();
    updateRailActive();
  }

  function setTurnOpen(turn, open) {
    foldState.set(stateKey(turn), open);
    const el = document.getElementById('turn-' + turn);
    if (!el) return;
    el.classList.toggle('folded', !open);
    const head = el.querySelector('.process-fold');
    if (head) {
      head.dataset.open = open ? '1' : '';
      head.setAttribute('aria-expanded', open ? 'true' : 'false');
    }
    if (open) {
      const ti = Number(el.dataset.ti);
      if (turnInfo[ti]) fillRuns(turnInfo[ti]);
    }
    updateProcessToggle();
    updateRailActive();
  }

  function updateProcessToggle() {
    const label = document.getElementById('process-toggle-label');
    if (!label) return;
    const btn = document.getElementById('process-toggle');
    const anyRuns = turnInfo.some((info) => info.runs.length);
    btn.disabled = !anyRuns;
    const anyClosed = turnInfo.some((info) => info.runs.length && !isTurnOpen(info.turn));
    label.textContent = anyClosed ? '展开过程' : '折叠过程';
    btn.classList.toggle('all-open', !anyClosed);
  }

  /* ---------- chat event delegation ---------- */
  function onChatClick(e) {
    const t = e.target.closest('[data-action]');
    if (t) {
      const action = t.dataset.action;
      if (action === 'toggle-turn') {
        setTurnOpen(Number(t.dataset.turn), !isTurnOpen(Number(t.dataset.turn)));
        return;
      }
      if (action === 'toggle-reasoning') {
        t.closest('.reasoning').classList.toggle('open');
      } else if (action === 'toggle-tool') {
        t.closest('.tool-card').classList.toggle('open');
      } else if (action === 'toggle-section') {
        t.parentElement.classList.toggle('open');
      } else if (action === 'toggle-card') {
        t.closest('.sys-card').classList.toggle('open');
      } else if (action === 'toggle-inject') {
        const detail = document.querySelector('[data-inject-detail="' + t.dataset.idx + '"]');
        if (detail) detail.classList.toggle('hidden');
      } else if (action === 'expand-args' || action === 'expand-result') {
        const rec = toolMap.get(t.dataset.call);
        if (!rec) return;
        t.previousElementSibling.textContent = action === 'expand-args' ? (prettyJSON(rec.argsText) || rec.argsText) : rec.resultText;
        t.remove();
      } else if (action === 'copy-answer') {
        const text = answerTexts.get(t.dataset.answer) || '';
        const done = () => {
          const span = t.querySelector('span');
          const old = span.textContent;
          span.textContent = '已复制';
          setTimeout(() => { span.textContent = old; }, 1200);
        };
        const fallback = () => {
          try {
            const ta = document.createElement('textarea');
            ta.value = text;
            ta.style.position = 'fixed';
            ta.style.opacity = '0';
            document.body.appendChild(ta);
            ta.select();
            document.execCommand('copy');
            ta.remove();
            done();
          } catch { /* clipboard unavailable */ }
        };
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).then(done, fallback);
        } else {
          fallback();
        }
      }
    }
    const j = e.target.closest('[data-jump-sub]');
    if (j) {
      activateSession(SUBAGENT_BY_ID.get(j.dataset.jumpSub));
    }
  }

  /* ============================================================
     Turn rail (右侧快速跳转)
     ============================================================ */
  let railActiveTurn = null;
  let railRaf = null;

  function buildRail() {
    const rail = document.getElementById('turn-rail');
    const marks = document.getElementById('turn-rail-marks');
    railItems = turnInfo.map((info) => ({ turn: info.turn, prompt: info.prompt, response: info.response }));
    if (turnInfo.length < 2) {
      rail.classList.add('hidden');
      marks.innerHTML = '';
      return;
    }
    rail.classList.remove('hidden');
    railActiveTurn = null;
    marks.innerHTML = railItems
      .map((it) => '<button class="turn-rail-mark" data-turn="' + it.turn + '" aria-label="第 ' + it.turn + ' 轮"><i></i></button>')
      .join('');
    updateRailActive();
  }

  function turnTop(el) {
    const wrap = document.getElementById('chat-scroll');
    const wrapRect = wrap.getBoundingClientRect();
    return el.getBoundingClientRect().top - wrapRect.top + wrap.scrollTop;
  }

  function updateRailActive() {
    const rail = document.getElementById('turn-rail');
    if (rail.classList.contains('hidden') || !turnInfo.length) return;
    const wrap = document.getElementById('chat-scroll');
    const y = wrap.scrollTop + Math.min(160, wrap.clientHeight * 0.25);
    let active = turnInfo[0].turn;
    for (const info of turnInfo) {
      const el = document.getElementById('turn-' + info.turn);
      if (el && turnTop(el) <= y) active = info.turn;
      else break;
    }
    if (active === railActiveTurn) return;
    railActiveTurn = active;
    const marks = document.getElementById('turn-rail-marks');
    for (const b of marks.querySelectorAll('.turn-rail-mark')) {
      b.classList.toggle('active', Number(b.dataset.turn) === active);
    }
    const activeEl = marks.querySelector('.turn-rail-mark.active');
    if (activeEl) {
      const scroller = rail.querySelector('.turn-rail-scroller');
      const top = activeEl.offsetTop;
      if (top < scroller.scrollTop) scroller.scrollTop = Math.max(0, top - 20);
      else if (top + activeEl.offsetHeight > scroller.scrollTop + scroller.clientHeight) {
        scroller.scrollTop = top + activeEl.offsetHeight - scroller.clientHeight + 20;
      }
    }
  }

  function scheduleRailActive() {
    if (railRaf) return;
    railRaf = requestAnimationFrame(() => {
      railRaf = null;
      updateRailActive();
    });
  }

  function scrollToTurn(turn) {
    const el = document.getElementById('turn-' + turn);
    if (!el) return;
    const wrap = document.getElementById('chat-scroll');
    wrap.scrollTo({ top: Math.max(0, turnTop(el) - 8), behavior: 'smooth' });
  }

  function showRailPreview(turn, markEl) {
    const rail = document.getElementById('turn-rail');
    const p = document.getElementById('turn-rail-preview');
    const item = railItems.find((it) => it.turn === turn);
    if (!item) return;
    const prompt = item.prompt || '第 ' + turn + ' 轮';
    p.innerHTML =
      '<div class="rail-preview-prompt">' + esc(prompt) + '</div>' +
      (item.response ? '<div class="rail-preview-response">' + esc(item.response) + '</div>' : '');
    p.classList.remove('hidden');
    for (const m of document.querySelectorAll('.turn-rail-mark.preview')) m.classList.remove('preview');
    markEl.classList.add('preview');
    const frameRect = rail.getBoundingClientRect();
    const markRect = markEl.getBoundingClientRect();
    const center = markRect.top + markRect.height / 2 - frameRect.top;
    const h = p.offsetHeight;
    const top = Math.max(0, Math.min(rail.clientHeight - h, center - h / 2));
    p.style.top = top + 'px';
  }

  function hideRailPreview() {
    document.getElementById('turn-rail-preview').classList.add('hidden');
    for (const m of document.querySelectorAll('.turn-rail-mark.preview')) m.classList.remove('preview');
  }

  function initRail() {
    const rail = document.getElementById('turn-rail');
    const marks = document.getElementById('turn-rail-marks');
    marks.addEventListener('mouseover', (e) => {
      const m = e.target.closest('.turn-rail-mark');
      if (m) showRailPreview(Number(m.dataset.turn), m);
    });
    marks.addEventListener('focusin', (e) => {
      const m = e.target.closest('.turn-rail-mark');
      if (m) showRailPreview(Number(m.dataset.turn), m);
    });
    rail.addEventListener('mouseleave', hideRailPreview);
    marks.addEventListener('focusout', (e) => {
      if (!rail.contains(e.relatedTarget)) hideRailPreview();
    });
    marks.addEventListener('click', (e) => {
      const m = e.target.closest('.turn-rail-mark');
      if (m) scrollToTurn(Number(m.dataset.turn));
    });
  }

  /* ============================================================
     Trajectory view
     ============================================================ */
  const ROW_H = 40;
  let ledgerAll = [];
  let ledgerFiltered = [];
  let selectedRow = null;

  const CAT = (row) => {
    if (row.isError) return 'error';
    if (row.type === 'user/message' && row.isUser) return 'user';
    if (row.type === 'assistant/message') return 'assistant';
    if (row.type === 'tool/call' || row.type === 'tool/result') return 'tool';
    return 'system';
  };

  const BADGE = { user: '用户', assistant: '助手', tool: '工具', error: '错误', system: '系统' };

  function buildLedger() {
    ledgerAll = (current.ledger || []).map((r) => Object.assign({}, r, { cat: CAT(r) }));
    selectedRow = null;
  }

  function applyFilters(search, filter) {
    const q = (search || '').toLowerCase();
    ledgerFiltered = ledgerAll.filter((r) => {
      if (filter !== 'all' && r.cat !== filter) return false;
      if (!q) return true;
      const hay = ((r.summary || '') + ' ' + (r.type || '') + ' ' + (r.detail || '') + ' ' + (r.seq || '')).toLowerCase();
      return hay.includes(q);
    });
    document.getElementById('traj-count').textContent = ledgerFiltered.length + ' / ' + ledgerAll.length + ' 条';
  }

  function drawOverview() {
    const canvas = document.getElementById('traj-overview');
    if (!canvas.querySelector('canvas')) {
      const c = document.createElement('canvas');
      c.className = 'overview-canvas';
      c.width = 1200;
      c.height = 40;
      canvas.appendChild(c);
    }
    const c = canvas.querySelector('canvas');
    const ctx = c.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, c.width, c.height);
    const t0 = META.createdAt;
    const t1 = META.updatedAt;
    const span = Math.max(1, t1 - t0);
    const colors = {
      user: '#5686FE', assistant: '#22C55E', tool: '#F59E0B',
      error: '#F25A5A', system: 'rgba(151,157,166,0.55)',
    };
    const step = Math.max(1, Math.floor(ledgerAll.length / 1400));
    for (let i = 0; i < ledgerAll.length; i += step) {
      const r = ledgerAll[i];
      if (r.time == null) continue;
      const x = ((r.time - t0) / span) * c.width;
      ctx.fillStyle = colors[r.cat] || colors.system;
      ctx.fillRect(x, r.cat === 'system' ? 16 : 8, 2, r.cat === 'system' ? 8 : 24);
    }
    for (const turn of current.turns) {
      const head = turn.nodes.find((n) => n.kind === 'turn-head');
      if (!head || !head.time) continue;
      const x = ((head.time - t0) / span) * c.width;
      ctx.strokeStyle = 'rgba(255,255,255,0.35)';
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, c.height);
      ctx.stroke();
    }
  }

  function renderLedgerWindow() {
    try {
      const wrap = document.getElementById('traj-ledger-wrap');
      const el = document.getElementById('traj-ledger');
      const n = ledgerFiltered.length;
      el.style.height = n * ROW_H + 'px';
      const scrollTop = wrap.scrollTop;
      const viewH = wrap.clientHeight || 600;
      const start = Math.max(0, Math.floor(scrollTop / ROW_H) - 6);
      const end = Math.min(n, Math.ceil((scrollTop + viewH) / ROW_H) + 6);

      let html = '';
      if (n === 0) {
        html = '<div class="ledger-empty">没有匹配的事件</div>';
        el.style.height = 'auto';
      } else {
        for (let i = start; i < end; i++) {
          const r = ledgerFiltered[i];
          const cls = [
            'ledger-row',
            r.cat,
            r.type === 'turn/start' ? 'turn-boundary' : '',
            selectedRow === r ? 'selected' : '',
          ].join(' ');
          html +=
            '<div class="' + cls + '" data-ledger-idx="' + i + '" style="top:' + i * ROW_H + 'px;height:' + ROW_H + 'px">' +
            '<span class="ledger-seq">' + (r.seq != null ? '#' + r.seq : '') + '</span>' +
            '<span class="ledger-time">' + fmtTime(r.time) + '</span>' +
            '<span class="ledger-badge ' + r.cat + '">' + (BADGE[r.cat] || r.cat) + '</span>' +
            '<span class="ledger-summary">' + esc(r.summary || r.type) + '</span>' +
            (r.durationMs != null ? '<span class="ledger-dur">' + fmtDur(r.durationMs) + '</span>' : '') +
            '</div>';
        }
      }
      el.innerHTML = html;
    } catch (err) {
      console.error('renderLedgerWindow failed:', err);
      const el = document.getElementById('traj-ledger');
      if (el) el.innerHTML = '<div class="ledger-empty">渲染失败: ' + esc(String(err && err.message || err)) + '</div>';
    }
  }

  let ledgerRaf = null;
  function scheduleLedgerRender() {
    if (ledgerRaf) return;
    ledgerRaf = requestAnimationFrame(() => {
      ledgerRaf = null;
      renderLedgerWindow();
    });
  }

  /* ---------- inspector ---------- */
  function showInspector(row) {
    const details = document.getElementById('details');
    details.classList.remove('hidden');
    const body = document.getElementById('details-body');
    const block = (label, value, plain) =>
      '<div class="detail-block"><div class="detail-block-label">' + esc(label) + '</div>' +
      '<div class="detail-block-value' + (plain ? ' plain' : '') + '">' + esc(value == null ? '' : value) + '</div></div>';

    let h = block('事件类型', row.type, true) + block('seq / 时间', (row.seq != null ? '#' + row.seq + ' · ' : '') + fmtDateTime(row.time), true);

    if (row.ref && row.ref.t === 'assistant') {
      const a = assistantMap.get(row.ref.key);
      if (a) {
        h += block('轮次 / 步骤', 'Turn ' + a.turn + ' · Step ' + a.step, true);
        h += block('模型', (a.provider ? a.provider + ' / ' : '') + (a.model || ''), true);
        if (a.usage) h += block('Token 用量', JSON.stringify(a.usage, null, 2));
        if (a.stepMs != null) h += block('步骤耗时', fmtDur(a.stepMs), true);
        for (const b of a.blocks) {
          if (b.type === 'reasoning') h += block('思考 (reasoning)', b.text);
          else if (b.type === 'text') h += block('文本 (text)', b.text);
          else if (b.type === 'tool') h += block('工具调用 ' + b.name, b.callId + '\n' + b.argsText);
        }
      } else {
        h += block('数据', '未找到对应消息');
      }
    } else if (row.ref && row.ref.t === 'tool') {
      const rec = toolMap.get(row.ref.key);
      if (rec) {
        h += block('工具', rec.name, true);
        h += block('callId', rec.callId, true);
        h += block('轮次 / 步骤', 'Turn ' + rec.turn + ' · Step ' + rec.step, true);
        h += block('调用时间', fmtDateTime(rec.callTime), true);
        h += block('耗时', rec.durationMs != null ? fmtDur(rec.durationMs) : '', true);
        h += block('状态', rec.isError ? '错误 (error)' : '成功', true);
        if (rec.error) h += block('错误信息', JSON.stringify(rec.error, null, 2));
        h += block('参数 (arguments)', prettyJSON(rec.argsText) || rec.argsText);
        h += block('结果 (result)', rec.resultText || '');
        if (rec.subId) {
          const s = SUBAGENT_BY_ID.get(rec.subId);
          h += block('子代理会话', rec.subId + (s ? ' — ' + (s.label || s.description || '') : ''), true);
        }
      } else {
        h += block('数据', '未找到对应调用');
      }
    } else {
      h += block('详情 (detail)', row.detail || '');
    }
    body.innerHTML = h;
  }

  /* ============================================================
     Overview view
     ============================================================ */
  function renderOverview() {
    const root = document.getElementById('overview-root');
    const u = META.usageTotals || {};
    const maxTok = Math.max(u.inputTokens || 0, u.outputTokens || 0, u.reasoningTokens || 0, u.cacheReadTokens || 0, 1);

    const toolCounts = {};
    for (const t of toolMap.values()) toolCounts[t.name] = (toolCounts[t.name] || 0) + 1;
    const toolSorted = Object.entries(toolCounts).sort((a, b) => b[1] - a[1]);
    const maxTool = Math.max(1, ...toolSorted.map((x) => x[1]));

    const typeSorted = Object.entries(META.typeCounts || {}).sort((a, b) => b[1] - a[1]).slice(0, 16);
    const maxType = Math.max(1, ...typeSorted.map((x) => x[1]));

    const cards =
      '<div class="ov-grid">' +
      card(META.turnsCount, '轮次 turns') +
      card(META.stepsCount, '步骤 steps') +
      card(META.toolCount, '工具调用') +
      card(META.eventCount, '事件数 events') +
      card(fmtDur(META.durationMs), '会话时长') +
      card((META.usageSteps || 0), '带用量回复', true) +
      '</div>';

    const usage =
      '<div class="ov-section"><div class="ov-section-title">Token 用量</div>' +
      bar('输入 inputTokens', u.inputTokens || 0, maxTok, 'blue') +
      bar('输出 outputTokens', u.outputTokens || 0, maxTok, 'green') +
      bar('推理 reasoningTokens', u.reasoningTokens || 0, maxTok, 'amber') +
      bar('缓存读取 cacheReadTokens', u.cacheReadTokens || 0, maxTok, 'gray') +
      (u.cacheWriteTokens ? bar('缓存写入 cacheWriteTokens', u.cacheWriteTokens, maxTok, 'gray') : '') +
      '</div>';

    let tools = '<div class="ov-section"><div class="ov-section-title">工具使用分布</div>';
    for (const [name, cnt] of toolSorted) {
      const pct = (cnt / maxTool) * 100;
      tools +=
        '<div class="ov-tool-row"><span class="ov-tool-name">' + esc(name) + '</span>' +
        '<span class="ov-tool-bar"><i style="width:' + pct + '%"></i></span>' +
        '<span class="ov-tool-count">' + cnt + '</span></div>';
    }
    tools += '</div>';

    let types = '<div class="ov-section"><div class="ov-section-title">事件类型分布</div>';
    for (const [name, cnt] of typeSorted) {
      const pct = (cnt / maxType) * 100;
      types +=
        '<div class="ov-type-row"><span class="ov-type-name">' + esc(name) + '</span>' +
        '<span class="ov-type-bar"><i style="width:' + pct + '%"></i></span>' +
        '<span class="ov-type-count">' + cnt + '</span></div>';
    }
    types += '</div>';

    const metaRows = [
      ['会话 ID', META.id || ''],
      ['格式版本', 'v' + (META.version ?? '?')],
      ['标题', META.title || ''],
      ['标题来源', JSON.stringify(META.titleSource || null)],
      ['工作目录', META.cwd || ''],
      ['Agent 预设', META.agentPreset || ''],
      ['委托深度', String(META.delegationDepth)],
      ['父会话', META.parentSession || '—'],
      ['来源', META.origin || '普通会话'],
      ['继承历史', META.isSeeded ? '是' : '否'],
      ['模型', META.provider + ' / ' + META.model],
    ];
    if (META.maxTokens) metaRows.push(['Max Tokens', String(META.maxTokens)]);
    if (META.reasoningEffort) metaRows.push(['推理强度', String(META.reasoningEffort)]);
    metaRows.push(['创建时间', fmtDateTime(META.createdAt)], ['最后事件', fmtDateTime(META.updatedAt)], ['事件行数', String(META.lineCount)]);

    const meta =
      '<div class="ov-section"><div class="ov-section-title">会话元信息</div><dl class="ov-meta">' +
      metaRows.map(([k, v]) => '<dt>' + esc(k) + '</dt><dd>' + esc(v) + '</dd>').join('') +
      '</dl></div>';

    root.innerHTML = cards + usage + tools + types + meta;
  }

  function card(num, label, small) {
    return (
      '<div class="ov-card">' +
      '<div class="ov-num" style="' + (small ? 'font-size:18px' : '') + '">' + esc(num) + '</div>' +
      '<div class="ov-label">' + esc(label) + '</div>' +
      '</div>'
    );
  }

  function bar(label, val, max, cls) {
    const pct = Math.max(0.5, (val / max) * 100);
    return (
      '<div class="ov-token-row">' +
      '<div class="ov-token-label"><span>' + esc(label) + '</span><span class="val">' + fmtTokens(val) + ' (' + val.toLocaleString() + ')</span></div>' +
      '<div class="ov-bar ' + cls + '"><i style="width:' + pct + '%"></i></div>' +
      '</div>'
    );
  }

  /* ============================================================
     Session switching
     ============================================================ */
  function activateSession(subInfo) {
    currentSub = subInfo || null;
    sessionKey = subInfo ? subInfo.id : 'main';
    current = subInfo ? SUBAGENT_BY_ID.get(subInfo.id) : D.main;
    if (!current) { current = D.main; currentSub = null; sessionKey = 'main'; }
    META = current.meta;
    indexSession();
    fillSidebar();
    fillHeader();
    renderChat();
    buildRail();
    renderOverview();
    buildLedger();
    applyFilters(searchInput.value, activeFilter);
    renderLedgerWindow();
    const trajVisible = !document.getElementById('view-trajectory').classList.contains('hidden');
    if (trajVisible) drawOverview();
    document.getElementById('chat-scroll').scrollTop = 0;
    updateRailActive();
  }

  /* ============================================================
     View switching
     ============================================================ */
  const VIEWS = ['chat', 'trajectory', 'overview'];
  function switchView(v) {
    for (const name of VIEWS) {
      document.getElementById('view-' + name).classList.toggle('hidden', name !== v);
    }
    document.querySelectorAll('.view-tab').forEach((b) => b.classList.toggle('active', b.dataset.view === v));
    if (v === 'trajectory') {
      applyFilters(searchInput.value, activeFilter);
      drawOverview();
      renderLedgerWindow(); // synchronous first paint; rAF only for scroll updates
    }
    if (v === 'chat') updateRailActive();
  }

  /* ============================================================
     Init
     ============================================================ */
  const searchInput = document.getElementById('traj-search-input');
  let activeFilter = 'all';
  let searchTimer = null;

  document.getElementById('traj-ledger-wrap').addEventListener('scroll', scheduleLedgerRender);
  document.getElementById('chat-scroll').addEventListener('scroll', scheduleRailActive);

  document.getElementById('traj-filters').addEventListener('click', (e) => {
    const chip = e.target.closest('.filter-chip');
    if (!chip) return;
    activeFilter = chip.dataset.filter;
    document.querySelectorAll('.filter-chip').forEach((c) => c.classList.toggle('active', c === chip));
    applyFilters(searchInput.value, activeFilter);
    scheduleLedgerRender();
  });

  searchInput.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      applyFilters(searchInput.value, activeFilter);
      scheduleLedgerRender();
    }, 120);
  });

  document.getElementById('traj-ledger').addEventListener('click', (e) => {
    const rowEl = e.target.closest('.ledger-row');
    if (!rowEl) return;
    const idx = Number(rowEl.dataset.ledgerIdx);
    const row = ledgerFiltered[idx];
    if (!row) return;
    selectedRow = row;
    document.querySelectorAll('.ledger-row.selected').forEach((r) => r.classList.remove('selected'));
    rowEl.classList.add('selected');
    showInspector(row);
  });

  document.getElementById('details-close').addEventListener('click', () => {
    document.getElementById('details').classList.add('hidden');
  });

  document.getElementById('theme-toggle').addEventListener('click', () => {
    const dark = document.body.hasAttribute('data-ds-dark-theme');
    if (dark) document.body.removeAttribute('data-ds-dark-theme');
    else document.body.setAttribute('data-ds-dark-theme', '');
  });

  document.getElementById('back-main').addEventListener('click', () => activateSession(null));

  document.getElementById('session-list').addEventListener('click', (e) => {
    const item = e.target.closest('.session-item');
    if (!item) return;
    const id = item.dataset.session;
    if (id === 'main') activateSession(null);
    else activateSession(SUBAGENT_BY_ID.get(id));
  });

  document.getElementById('chat-stream').addEventListener('click', onChatClick);

  document.getElementById('process-toggle').addEventListener('click', () => {
    const anyClosed = turnInfo.some((info) => info.runs.length && !isTurnOpen(info.turn));
    for (const info of turnInfo) if (info.runs.length) setTurnOpen(info.turn, anyClosed);
  });

  document.querySelectorAll('.view-tab').forEach((b) => {
    b.addEventListener('click', () => switchView(b.dataset.view));
  });

  window.addEventListener('resize', () => {
    scheduleLedgerRender();
    scheduleRailActive();
  });

  initRail();

  /* ---------- go ---------- */
  indexSession();
  fillSidebar();
  fillHeader();
  renderChat();
  buildRail();
  buildLedger();
  applyFilters('', 'all');
  renderOverview();
  switchView('chat');
})();
