// viewer-model.js — turn a logical DSH session log (plus its subagent logs) into
// the compact model the exported viewer page renders.
//
// The model keeps one vocabulary across session formats v0-v4, so an exported
// page always agrees with itself on what a turn, an answer, and a process row
// are, regardless of which Harness version wrote the log.
import { readFileSync, existsSync, statSync } from 'node:fs';
import { extname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const collectText = (content) => {
  if (!Array.isArray(content)) return '';
  const parts = [];
  const walk = (c) => {
    for (const item of c) {
      if (!item) continue;
      if (item.type === 'text' && typeof item.text === 'string') parts.push(item.text);
      else if (Array.isArray(item.content)) walk(item.content);
    }
  };
  walk(content);
  return parts.join('\n');
};

const argsOf = (e) => (typeof e.arguments === 'string' ? e.arguments : JSON.stringify(e.arguments ?? ''));

/** Direct image blocks of one content array (v3 tool-result wrappers nest one level). */
const imageBlocks = (content) => {
  const out = [];
  const walk = (c) => {
    for (const item of c) {
      if (!item || typeof item !== 'object') continue;
      if (item.type === 'image' && item.attachment) out.push(item);
      else if (Array.isArray(item.content)) walk(item.content);
    }
  };
  if (Array.isArray(content)) walk(content);
  return out;
};

/** Resolve image blocks against `attachmentId -> data URL`; unresolved images are dropped. */
const resolveImages = (content, imageMap) => {
  const out = [];
  for (const b of imageBlocks(content)) {
    const a = b.attachment;
    const src = imageMap.get(String(a.attachmentId));
    if (!src) continue;
    out.push({ src, name: a.name || '', width: a.width || 0, height: a.height || 0 });
  }
  return out;
};

/** Source kind of a message, normalized across v3 (`plugin`) and v4 (`kind`). */
const sourceKind = (source) => {
  if (!source) return undefined;
  if (typeof source.kind === 'string' && source.kind !== 'plugin') return source.kind;
  if (typeof source.plugin === 'string' && source.plugin) return 'plugin:' + source.plugin;
  if (typeof source.kind === 'string') return source.kind;
  return undefined;
};

/** Display label for an injected context source. */
const INJECT_LABELS = {
  'system-prompt': '系统提示词',
  'runtime-context': '运行时上下文',
  'agent-instructions': '工作区指令',
  'skill-catalog': '技能目录',
  'skill-invocation': '技能调用',
  'time-context': '时间上下文',
  'tmux-context': '终端上下文',
  'goal': '目标',
  'subagent-report': '子代理报告',
  'subagent-settled': '子代理完成',
  'team-message': '团队消息',
  'agent-message': '代理消息',
  'coordinator': '协调者消息',
  'session-reference': '会话引用',
  'model-selection': '模型选择',
  'plan-mode': '计划模式',
  'user-approval': '用户审批',
  'repeat-tool-reminder': '重复调用提醒',
  'compact-checkpoint': '压缩检查点',
  'compact-basic': '压缩摘要',
  'webhook': '外部事件',
  'schedule': '定时任务',
  'tool-cordis': 'Cordis 工具',
  'tool-jobs': '后台任务通知',
  'tool-goal': '目标通知',
  'tool-schedule': '定时任务通知',
};
const labelForSource = (kind) => {
  if (!kind) return '系统注入';
  const bare = kind.startsWith('plugin:') ? kind.slice(7) : kind;
  // v0-v3 recorded first-party producers as npm plugin names.
  const short = bare.replace(/^@deepseek-ai\//, '').replace(/^dsh-/, '');
  return INJECT_LABELS[bare] || INJECT_LABELS[short] || short;
};

/**
 * Build one session's chat model from its logical events.
 * @param events - events including the synthesized `session` header event.
 * @returns the session model.
 */
function buildModel(events, imageMap = new Map()) {
  let sessionMeta = null;
  const titles = [];
  const policyEvents = [];
  const requestHeaders = [];
  const catalog = new Map();
  let lastTime = 0;
  let firstTime = Infinity;
  const durableMessageIds = new Set();

  for (const e of events) {
    if (e.time != null) {
      if (e.time < firstTime) firstTime = e.time;
      if (e.time > lastTime) lastTime = e.time;
    }
    if (e.type === 'session') sessionMeta = e;
    else if (e.type === 'session/title') titles.push(e.data);
    else if (e.type === 'permission/preset' || e.type === 'sandbox/mode' || e.type === 'approval/policy') {
      policyEvents.push({ type: e.type, time: e.time, data: e.data });
    } else if (e.type === 'request/header') requestHeaders.push(e.data);
    else if (e.type === 'user/message' && e.data?.id) durableMessageIds.add(e.data.id);
    else if (e.type === 'subagent/catalog' && e.data?.childId) {
      catalog.set(e.data.childId, { label: e.data.label, mode: e.data.mode });
    }
  }

  const title = titles.length ? titles[titles.length - 1].title : '未命名会话';
  const reqHeader = requestHeaders.length ? requestHeaders[requestHeaders.length - 1]?.header : undefined;
  const model = reqHeader?.config?.model ?? sessionMeta?.model ?? 'unknown';
  const provider = reqHeader?.config?.provider ?? 'unknown';

  const stepSpans = new Map();
  const turnWindows = new Map();
  for (const e of events) {
    if (e.type === 'step/start') {
      stepSpans.set(`${e.data.turn}/${e.data.step}`, { start: e.time, end: null });
    } else if (e.type === 'step/end') {
      const s = stepSpans.get(`${e.data.turn}/${e.data.step}`);
      if (s) s.end = e.time;
    } else if (e.type === 'turn/start') {
      if (!turnWindows.has(e.data.turn)) turnWindows.set(e.data.turn, { start: e.time, end: null });
    } else if (e.type === 'turn/end') {
      const w = turnWindows.get(e.data.turn);
      if (w) w.end = e.time;
    }
  }
  const sortedTurnKeys = [...turnWindows.keys()].sort((a, b) => a - b);

  const resolveTurn = (t, explicit) => {
    if (explicit != null && turnWindows.has(explicit)) return explicit;
    if (t == null || !sortedTurnKeys.length) return explicit ?? null;
    let best = sortedTurnKeys[0];
    for (const k of sortedTurnKeys) {
      if (t >= turnWindows.get(k).start) best = k;
      else break;
    }
    return best;
  };

  const turnMap = new Map();
  const toolIndex = [];
  const assistantIndex = [];
  const toolCallsByCallId = new Map();

  const pushNode = (turnIdx, node) => {
    if (!turnMap.has(turnIdx)) turnMap.set(turnIdx, []);
    turnMap.get(turnIdx).push(node);
  };

  for (const e of events) {
    const d = e.data;
    switch (e.type) {
      case 'turn/start': {
        const idx = d.turn;
        if (!turnMap.has(idx)) turnMap.set(idx, []);
        turnMap.get(idx).unshift({ kind: 'turn-head', turn: idx, time: e.time });
        break;
      }
      case 'turn/end': {
        const head = (turnMap.get(d.turn) || []).find((n) => n.kind === 'turn-head');
        if (head) {
          head.endTime = e.time;
          head.reason = d.reason;
          head.durationMs = e.time - head.time;
        }
        break;
      }
      case 'user/message': {
        const kind = sourceKind(d.source);
        const text = collectText(d.content);
        const idx = resolveTurn(e.time, d.turn);
        if (kind === 'user') {
          pushNode(idx, {
            kind: 'user', text, time: e.time, sourceKind: kind, role: d.role, id: d.id,
            images: resolveImages(d.content, imageMap),
          });
        } else {
          pushNode(idx, {
            kind: 'inject',
            text,
            time: e.time,
            sourceKind: kind,
            sourceLabel: labelForSource(kind),
            summary: d.source?.summary,
            form: d.source?.form,
            senderSessionId: d.source?.senderSessionId,
            subId: d.source?.senderSessionId,
            id: d.id,
            images: resolveImages(d.content, imageMap),
          });
        }
        break;
      }
      case 'system/message': {
        const kind = sourceKind(d.message?.source) ?? 'system-prompt';
        pushNode(resolveTurn(e.time, d.turn), {
          kind: 'inject',
          text: collectText(d.message?.content),
          time: e.time,
          sourceKind: kind,
          sourceLabel: labelForSource(kind),
          isSystem: true,
          id: d.message?.id,
        });
        break;
      }
      case 'developer/message': {
        const items = [];
        for (const b of d.message?.content || []) {
          if (b.type === 'tool-addition') items.push({ op: 'add', name: b.toolName });
          else if (b.type === 'tool-removal') items.push({ op: 'remove', name: b.toolName });
        }
        pushNode(resolveTurn(e.time, d.turn), {
          kind: 'developer',
          items,
          time: e.time,
          sourceKind: sourceKind(d.message?.source),
        });
        break;
      }
      case 'agent/inbox/spliced': {
        const idx = resolveTurn(e.time, d.turn);
        for (const inserted of d.inserted ?? []) {
          if (inserted.id && durableMessageIds.has(inserted.id)) continue;
          const kind = sourceKind(inserted.source);
          pushNode(idx, {
            kind: 'inject',
            text: collectText(inserted.content),
            time: e.time,
            target: d.target,
            sourceKind: kind,
            sourceLabel: labelForSource(kind),
            summary: inserted.source?.summary,
            form: inserted.source?.form,
            senderSessionId: inserted.source?.senderSessionId,
            subId: inserted.source?.senderSessionId,
            id: inserted.id,
          });
        }
        break;
      }
      case 'assistant/message': {
        const idx = d.turn;
        const blocks = [];
        for (const b of d.message.content || []) {
          if (b.type === 'reasoning') {
            blocks.push({ type: 'reasoning', text: b.text ?? '' });
          } else if (b.type === 'text') {
            blocks.push({ type: 'text', text: b.text ?? '' });
          } else if (b.type === 'tool-call') {
            blocks.push({ type: 'tool', callId: b.id, name: b.name, argsText: argsOf(b) });
          } else if (b.type === 'image') {
            const a = b.attachment || {};
            const src = imageMap.get(String(a.attachmentId));
            if (src) blocks.push({ type: 'image', src, name: a.name || '', width: a.width || 0, height: a.height || 0 });
          }
        }
        const span = stepSpans.get(`${idx}/${d.step}`);
        const node = {
          kind: 'assistant',
          turn: idx,
          step: d.step,
          time: e.time,
          model: d.message?.source?.model,
          provider: d.message?.source?.provider,
          usage: d.usage || null,
          blocks,
          stepSpan: span || null,
          id: d.message?.id,
        };
        node.stepMs = span && span.end ? span.end - span.start : null;
        pushNode(idx, node);
        assistantIndex.push(node);
        break;
      }
      case 'tool/call': {
        const rec = {
          kind: 'tool-call',
          callId: d.callId,
          name: d.name,
          argsText: argsOf(d),
          turn: d.turn,
          step: d.step,
          callTime: e.time,
          seq: e.seq,
        };
        toolCallsByCallId.set(d.callId, rec);
        toolIndex.push(rec);
        pushNode(d.turn, {
          kind: 'tool-call', callId: d.callId, name: d.name, argsText: rec.argsText,
          turn: d.turn, step: d.step, time: e.time,
        });
        break;
      }
      case 'tool/result': {
        const msg = d.message;
        const callId = msg?.source?.callId;
        const rec = toolCallsByCallId.get(callId);
        const resultText = collectText(msg?.content);
        const resultImages = resolveImages(msg?.content, imageMap);
        const isError = msg?.isError === true || msg?.content?.[0]?.isError === true;
        const error = d.error || null;
        const resultTime = e.time;
        if (rec) {
          rec.resultText = resultText;
          rec.images = resultImages;
          rec.isError = isError;
          rec.error = error;
          rec.resultTime = resultTime;
          rec.durationMs = resultTime - rec.callTime;
        }
        const nodes = turnMap.get(d.turn);
        if (nodes) {
          for (let i = nodes.length - 1; i >= 0; i--) {
            const n = nodes[i];
            if (n.kind === 'tool-call' && n.callId === callId) {
              n.resultText = resultText;
              n.images = resultImages;
              n.isError = isError;
              n.error = error;
              n.resultTime = resultTime;
              n.durationMs = rec?.durationMs ?? null;
              break;
            }
          }
        }
        break;
      }
      case 'goal/change': {
        pushNode(resolveTurn(e.time, d.turn), {
          kind: 'goal', op: d.operation, phase: d.goal?.phase, revision: d.goal?.revision,
          objective: d.goal?.objective, roundsStarted: d.roundsStarted, maxGoalRounds: d.goal?.maxGoalRounds,
          time: e.time, goalId: d.goal?.id,
        });
        break;
      }
      case 'todo/write': {
        pushNode(resolveTurn(e.time, d.turn), { kind: 'todo', items: d.todos, time: e.time });
        break;
      }
      case 'command/run':
      case 'command/done': {
        pushNode(resolveTurn(e.time, d.turn), { kind: 'command', op: e.type.replace('command/', ''), name: d.name, args: d.args, time: e.time });
        break;
      }
      case 'llm/retry':
      case 'llm/retry-started': {
        pushNode(resolveTurn(e.time, d.turn), { kind: 'retry', op: e.type.replace('llm/', ''), time: e.time, data: d });
        break;
      }
      case 'assistant/attempt': {
        if (d.error) {
          pushNode(resolveTurn(e.time, d.turn), {
            kind: 'retry', op: 'attempt-failed', time: e.time, data: { error: d.error, kind: d.kind },
          });
        }
        break;
      }
      default:
        break;
    }
  }

  const usageTotals = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 };
  let usageSteps = 0;
  for (const a of assistantIndex) {
    if (a.usage) {
      usageTotals.inputTokens += a.usage.inputTokens || 0;
      usageTotals.outputTokens += a.usage.outputTokens || 0;
      usageTotals.cacheReadTokens += a.usage.cacheReadTokens || 0;
      usageTotals.cacheWriteTokens += a.usage.cacheWriteTokens || 0;
      usageTotals.reasoningTokens += a.usage.reasoningTokens || 0;
      usageSteps++;
    }
  }

  const typeCounts = {};
  for (const e of events) typeCounts[e.type] = (typeCounts[e.type] || 0) + 1;

  const LEDGER_SKIP = new Set(['session-log-deepseek/delivery-accepted', 'assistant/attempt']);
  const isStreamDelta = (type) =>
    type === 'assistant/chunk' || type.endsWith('-chunks') || type.endsWith('/chunk') || type.endsWith('/delta');

  const ledger = [];
  for (const e of events) {
    if (LEDGER_SKIP.has(e.type) || isStreamDelta(e.type)) continue;
    const row = { seq: e.seq ?? null, time: e.time ?? null, type: e.type };
    const d = e.data ?? {};
    switch (e.type) {
      case 'session':
        row.summary = `会话 ${e.id} · format v${e.version} · depth ${e.delegationDepth} · ${e.agentPreset ?? ''}`;
        row.detail = JSON.stringify(e, null, 1);
        break;
      case 'session/title':
        row.summary = `标题: ${d.title}`;
        row.detail = JSON.stringify(d, null, 1);
        break;
      case 'session/title-llm-request':
        row.summary = 'LLM 标题生成请求';
        row.detail = JSON.stringify(d, null, 1).slice(0, 2000);
        break;
      case 'session/end-seed':
        row.summary = d.inherited ? '继承历史结束（inherited）' : '种子注入结束';
        row.detail = JSON.stringify(d, null, 1).slice(0, 500);
        break;
      case 'agent-preset/selected':
        row.summary = `Agent 预设 → ${d.agentPreset}`;
        row.detail = JSON.stringify(d, null, 1);
        break;
      case 'permission/preset':
      case 'sandbox/mode':
      case 'approval/policy':
        row.summary = `${e.type} → ${JSON.stringify(d)}`;
        row.detail = JSON.stringify(d, null, 1);
        break;
      case 'request/header':
        row.summary = `模型 ${d.header?.config?.provider}/${d.header?.config?.model}${d.reason ? ' · ' + d.reason : ''} · maxTokens ${d.header?.config?.maxTokens}`;
        row.detail = JSON.stringify(
          { reason: d.reason, config: d.header?.config, adapterDefaults: d.header?.adapterDefaults, tools: (d.header?.tools ?? []).map((t) => t.name) },
          null,
          1,
        );
        break;
      case 'request/context':
        row.summary = '请求上下文记录';
        row.detail = JSON.stringify(d, null, 1).slice(0, 2000);
        break;
      case 'turn/start':
        row.summary = `第 ${d.turn} 轮开始`;
        row.detail = JSON.stringify(d, null, 1);
        break;
      case 'turn/end':
        row.summary = `第 ${d.turn} 轮结束 (${d.reason?.kind ?? ''})`;
        row.detail = JSON.stringify(d, null, 1);
        break;
      case 'step/start':
        row.summary = `Step ${d.step} 开始 (turn ${d.turn})`;
        row.detail = JSON.stringify(d, null, 1);
        break;
      case 'step/end':
        row.summary = `Step ${d.step} 结束 (turn ${d.turn})`;
        row.detail = JSON.stringify(d, null, 1);
        break;
      case 'user/message': {
        const src = sourceKind(d.source);
        row.summary = src === 'user'
          ? `用户: ${collectText(d.content).slice(0, 120)}`
          : `注入 (${src}): ${collectText(d.content).slice(0, 120)}`;
        row.detail = JSON.stringify(d, null, 1).slice(0, 4000);
        row.isUser = src === 'user';
        break;
      }
      case 'system/message': {
        const src = sourceKind(d.message?.source) ?? 'system-prompt';
        row.summary = `系统消息 (${src}) · ${collectText(d.message?.content).length} 字`;
        row.detail = JSON.stringify(d, null, 1).slice(0, 6000);
        break;
      }
      case 'developer/message': {
        const names = (d.message?.content ?? []).map((b) => (b.op === 'remove' || b.type === 'tool-removal' ? '-' : '+') + b.toolName);
        row.summary = `工具定义变更: ${names.join(' ')}`;
        row.detail = JSON.stringify(d, null, 1).slice(0, 2000);
        break;
      }
      case 'agent/inbox/spliced':
        row.summary = `收件箱拼接 (${d.target}): ${d.inserted?.length ?? 0} 条${d.removedCount ? ' · 移除 ' + d.removedCount : ''}`;
        row.detail = JSON.stringify(d, null, 1).slice(0, 4000);
        break;
      case 'assistant/message': {
        const usage = d.usage;
        const span = stepSpans.get(`${d.turn}/${d.step}`);
        if (span && span.start != null && span.end != null) row.durationMs = span.end - span.start;
        row.summary = `回复 · turn ${d.turn} step ${d.step}${usage ? ` · in ${usage.inputTokens ?? 0} / out ${usage.outputTokens ?? 0} / 推理 ${usage.reasoningTokens ?? 0} / 缓存 ${usage.cacheReadTokens ?? 0}` : ''}`;
        row.detail = null;
        row.ref = { t: 'assistant', key: `${d.turn}/${d.step}/${e.time}` };
        break;
      }
      case 'tool/call':
        row.summary = `调用 ${d.name} (turn ${d.turn} step ${d.step})`;
        row.detail = null;
        row.ref = { t: 'tool', key: d.callId };
        break;
      case 'tool/result': {
        const callId = d.message?.source?.callId;
        const isError = d.message?.isError === true || d.message?.content?.[0]?.isError === true;
        row.summary = `结果 ${callId ? callId.slice(0, 14) : ''}${isError ? ' · 错误' : ''}`;
        row.detail = null;
        row.ref = { t: 'tool', key: callId };
        row.isError = isError;
        const callRec = callId ? toolCallsByCallId.get(callId) : null;
        if (callRec && callRec.callTime != null) row.durationMs = e.time - callRec.callTime;
        break;
      }
      case 'goal/change':
        row.summary = `目标 ${d.operation} (rev ${d.goal?.revision}) · ${d.goal?.phase}`;
        row.detail = JSON.stringify({ operation: d.operation, goal: { id: d.goal?.id, phase: d.goal?.phase, revision: d.goal?.revision, objective: d.goal?.objective, maxGoalRounds: d.goal?.maxGoalRounds }, roundsStarted: d.roundsStarted }, null, 1);
        break;
      case 'todo/write':
        row.summary = `待办更新 (${d.todos?.length ?? 0} 项)`;
        row.detail = JSON.stringify(d.todos, null, 1);
        break;
      case 'command/run':
      case 'command/done':
        row.summary = `命令 ${e.type.replace('command/', '')}: ${d.name}${d.args ? ' ' + d.args : ''}`;
        row.detail = JSON.stringify(d, null, 1);
        break;
      case 'llm/retry':
      case 'llm/retry-started':
        row.summary = `LLM 重试: ${e.type.replace('llm/', '')}`;
        row.detail = JSON.stringify(d, null, 1).slice(0, 1500);
        break;
      case 'subagent/catalog':
        row.summary = `子代理目录: ${d.childId?.slice(0, 8)} · ${d.mode} · ${d.label ?? ''}`;
        row.detail = JSON.stringify(d, null, 1);
        break;
      case 'job/registered':
        row.summary = `后台任务注册: ${d.name ?? d.id ?? ''}${d.command ? ' · ' + d.command : ''}`;
        row.detail = JSON.stringify(d, null, 1).slice(0, 1500);
        break;
      case 'job/settled':
        row.summary = `后台任务结束: ${d.name ?? d.id ?? ''}${d.status ? ' · ' + d.status : ''}`;
        row.detail = JSON.stringify(d, null, 1).slice(0, 1500);
        break;
      case 'workspace/changes':
        row.summary = `工作区变更 (${(d.changes ?? d.files ?? []).length ?? 0})`;
        row.detail = JSON.stringify(d, null, 1).slice(0, 2000);
        break;
      case 'deliverables/presented':
        row.summary = `交付文件 (${(d.files ?? d.deliverables ?? []).length ?? 0})`;
        row.detail = JSON.stringify(d, null, 1).slice(0, 2000);
        break;
      case 'compaction/start':
      case 'compaction/summary':
      case 'compaction/end':
      case 'compaction/prune':
        row.summary = `压缩 ${e.type.replace('compaction/', '')}`;
        row.detail = JSON.stringify(d, null, 1).slice(0, 2000);
        break;
      case 'web/deepseek-search-llm-request':
      case 'web/llm-request':
        row.summary = 'Web 搜索 LLM 请求';
        row.detail = JSON.stringify(d, null, 1).slice(0, 1200);
        break;
      default:
        row.summary = e.type;
        row.detail = JSON.stringify(d, null, 1).slice(0, 1200);
    }
    ledger.push(row);
  }

  const meta = {
    id: sessionMeta?.id ?? null,
    version: sessionMeta?.version ?? null,
    isSeeded: sessionMeta?.isSeeded ?? false,
    parentSession: sessionMeta?.parentSession ?? null,
    origin: sessionMeta?.origin ?? null,
    createdAt: sessionMeta?.createdAt ?? firstTime,
    updatedAt: lastTime,
    cwd: sessionMeta?.cwd ?? null,
    agentPreset: sessionMeta?.agentPreset ?? null,
    delegationDepth: sessionMeta?.delegationDepth ?? null,
    title,
    titleSource: titles.length ? titles[titles.length - 1].source : null,
    model,
    provider,
    maxTokens: reqHeader?.config?.maxTokens ?? null,
    reasoningEffort: reqHeader?.config?.reasoningEffort ?? null,
    system: reqHeader?.system ?? null,
    durationMs: lastTime - firstTime,
    eventCount: events.length,
    lineCount: events.length,
    typeCounts,
    policy: policyEvents,
    usageTotals,
    usageSteps,
    turnsCount: turnMap.size,
    stepsCount: stepSpans.size,
    toolCount: toolIndex.length,
    subagentIds: [...catalog.keys()],
  };

  return {
    meta,
    turns: [...turnMap.entries()].sort((a, b) => a[0] - b[0]).map(([idx, nodes]) => ({ turn: idx, nodes })),
    ledger,
    toolIndex,
    turnMap,
    catalog,
  };
}

const asEvents = (snapshot) => {
  const header = { type: 'session', ...snapshot.session };
  return [header, ...snapshot.events];
};

/** Attach subagent ids to the root's tool-call nodes, exactly as the viewer expects. */
function linkSubagents(rootEvents, main) {
  const subIdByCallId = new Map();
  const descByCallId = new Map();
  const subDescById = new Map();

  for (const e of rootEvents) {
    if (e.type === 'tool/call' && (e.data.name === 'subagent' || String(e.data.name).startsWith('subagent_'))) {
      try {
        const a = JSON.parse(argsOf(e.data));
        if (a && a.description) descByCallId.set(e.data.callId, a.description);
      } catch { /* ignore */ }
    }
    if (e.type === 'tool/result') {
      const callId = e.data.message?.source?.callId;
      const txt = collectText(e.data.message?.content) || '';
      const m = txt.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
      if (m) {
        subIdByCallId.set(callId, m[1]);
        const desc = descByCallId.get(callId);
        if (desc && !subDescById.has(m[1])) subDescById.set(m[1], desc);
      }
    }
    if (e.type === 'user/message' && e.data.source?.senderSessionId) {
      const sid = e.data.source.senderSessionId;
      if (!subDescById.has(sid)) subDescById.set(sid, '');
    }
  }

  for (const t of main.turnMap.values()) {
    for (const n of t) {
      if (n.kind === 'tool-call' && subIdByCallId.has(n.callId)) n.subId = subIdByCallId.get(n.callId);
      if (n.kind === 'assistant') {
        for (const b of n.blocks) {
          if (b.type === 'tool' && subIdByCallId.has(b.callId)) b.subId = subIdByCallId.get(b.callId);
        }
      }
    }
  }
  return subDescById;
}

/**
 * Build the complete viewer payload for one root session and its descendants.
 * @param rootSnapshot - `{ session, events }` from session-query.
 * @param childSnapshots - descendant snapshots in discovery order.
 * @param imageMap - `attachmentId -> data URL` for images to embed.
 * @returns `{ main, subagents, formatVersion }`.
 */
export function buildViewer(rootSnapshot, childSnapshots, imageMap = new Map()) {
  const rootEvents = asEvents(rootSnapshot);
  const main = buildModel(rootEvents, imageMap);
  const subDescById = linkSubagents(rootEvents, main);

  const subagents = [];
  const seen = new Set([String(rootSnapshot.session.id)]);
  for (const snapshot of childSnapshots) {
    const id = String(snapshot.session.id);
    if (seen.has(id)) continue;
    seen.add(id);
    const model = buildModel(asEvents(snapshot), imageMap);
    const cat = main.catalog.get(id);
    const title = model.meta.title && model.meta.title !== '未命名会话' ? model.meta.title : '';
    subagents.push({
      id,
      parentId: snapshot.session.parentSession ?? null,
      depth: snapshot.session.delegationDepth ?? 1,
      description: subDescById.get(id) || '',
      label: cat?.label || title,
      meta: model.meta,
      turns: model.turns,
      ledger: model.ledger,
    });
  }
  for (const s of subagents) {
    const cat = main.catalog.get(s.id);
    if (cat?.label) s.label = cat.label;
    if (cat?.label && !s.description) s.description = cat.label;
  }
  subagents.sort((a, b) => (a.meta.createdAt ?? 0) - (b.meta.createdAt ?? 0));

  return {
    main: { meta: main.meta, turns: main.turns, ledger: main.ledger },
    subagents,
    formatVersion: main.meta.version,
  };
}

/**
 * Inline the payload and the bundled page assets into one self-contained HTML document.
 * @param viewer - `buildViewer` output.
 * @param assets - `{ page, css, app, markdown }` text assets.
 * @returns the HTML document.
 */
export function renderViewerHtml(viewer, assets) {  let json = JSON.stringify(viewer);
  json = json.replace(/<\//g, '<\\/').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  const dataJs = 'window.__DSH_VIEWER__ = ' + json + ';';

  for (const [name, src] of [['styles.css', assets.css], ['data', dataJs], ['markdown.js', assets.markdown], ['app.js', assets.app]]) {
    if (src.includes('</script')) throw new Error(`${name} contains </script>`);
  }

  return assets.page
    .replace('<link rel="stylesheet" href="styles.css" />', () => '<style>\n' + assets.css + '\n</style>')
    .replace('<script src="data.js"></script>', () => '<script>\n' + dataJs + '\n</script>')
    .replace('<script src="markdown.js"></script>', () => '<script>\n' + assets.markdown + '\n</script>')
    .replace('<script src="app.js"></script>', () => '<script>\n' + assets.app + '\n</script>');
}

const MIME_BY_EXT = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
};
const MARKDOWN_IMAGE_RE = /!\[[^\]]*\]\(([^)\s]+)\)/g;
const MAX_IMAGE_FILE_BYTES = 16 * 1024 * 1024;
const MAX_MEDIA_BYTES = 64 * 1024 * 1024;

/** Read one local image path and encode it, rejecting remote/data sources. */
function readLocalImage(src, cwd, budget) {
  if (!cwd || /^(https?:|data:|blob:)/i.test(src)) return null;
  let p = src;
  try {
    if (/^file:/i.test(p)) p = fileURLToPath(p);
  } catch {
    return null;
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(p) && !/^[a-zA-Z]:[\\/]/.test(p)) return null;
  if (!isAbsolute(p)) p = resolve(cwd, p);
  if (!existsSync(p)) {
    try {
      const decoded = decodeURIComponent(p);
      if (decoded !== p && existsSync(decoded)) p = decoded;
    } catch {
      /* keep the original path */
    }
  }
  const mime = MIME_BY_EXT[extname(p).toLowerCase()];
  if (!mime) return null;
  try {
    if (!existsSync(p)) return null;
    const size = statSync(p).size;
    if (size > MAX_IMAGE_FILE_BYTES || budget.used + size > MAX_MEDIA_BYTES) return null;
    const data = readFileSync(p);
    budget.used += size;
    return `data:${mime};base64,${data.toString('base64')}`;
  } catch {
    return null;
  }
}

/** Collect Markdown image paths from one session's assistant text blocks. */
function collectTurnsMedia(turns, cwd, media, budget) {
  if (!cwd) return;
  for (const t of turns) {
    for (const n of t.nodes) {
      if (n.kind !== 'assistant') continue;
      for (const b of n.blocks) {
        if (b.type !== 'text' || !b.text || !b.text.includes('![')) continue;
        for (const m of b.text.matchAll(MARKDOWN_IMAGE_RE)) {
          const src = m[1];
          if (Object.prototype.hasOwnProperty.call(media, src)) continue;
          const dataUrl = readLocalImage(src, cwd, budget);
          if (dataUrl) media[src] = dataUrl;
        }
      }
    }
  }
}

/**
 * Inline local images referenced from assistant Markdown as data URLs.
 * @param viewer - `buildViewer` output.
 * @param rootCwd - workspace directory of the root Session.
 * @returns `markdown src -> data URL`; assign it to `viewer.media` before rendering.
 */
export function embedMarkdownMedia(viewer, rootCwd) {
  const media = {};
  const budget = { used: 0 };
  collectTurnsMedia(viewer.main.turns, rootCwd, media, budget);
  for (const s of viewer.subagents) collectTurnsMedia(s.turns, s.meta.cwd || rootCwd, media, budget);
  return media;
}
