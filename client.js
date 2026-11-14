// @wtywtykk/dsh-export-viewer — Client half.
//
// Adds one compact Session-header utility that downloads the current Session
// (and its subagents) as a single self-contained HTML page. The page itself is
// produced by the Host route `/api/session.viewer`; all of its templates live
// inside this package.
window.__ModuleLoader__.load({
  id: '@wtywtykk/dsh-export-viewer',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const NS = 'dsh-export-viewer';

    /** Session-header dictionary, Simplified Chinese. */
    const zh = {
      'action.label': '导出对话（HTML）',
      'action.busy': '正在生成导出页面…',
      'action.done': '导出已开始下载',
      'action.error': '导出失败',
      'action.retry': '重试',
    };
    /** Session-header dictionary, English. */
    const en = {
      'action.label': 'Export conversation (HTML)',
      'action.busy': 'Preparing the exported page…',
      'action.done': 'Export download started',
      'action.error': 'Export failed',
      'action.retry': 'Retry',
    };

    const CSS = `
.dshx-export {
  box-sizing: border-box;
  width: 28px;
  height: 28px;
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  cursor: pointer;
  transition: background-color 0.12s, color 0.12s;
}
.dshx-export:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-2));
  color: var(--dsw-alias-label-primary);
}
.dshx-export:focus-visible {
  outline: 2px solid var(--dsw-focus-ring-color, var(--dsw-alias-brand-primary));
  outline-offset: 1px;
}
.dshx-export:disabled { opacity: 0.55; cursor: default; }
.dshx-export svg { width: 15px; height: 15px; }
.dshx-export[data-state="done"] { color: var(--dsw-alias-state-success-primary); }
.dshx-export[data-state="error"] { color: var(--dsw-alias-state-error-primary); }
.dshx-spin { animation: dshx-export-spin 0.9s linear infinite; transform-origin: 50% 50%; }
@keyframes dshx-export-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .dshx-spin { animation: none; } }
.dshx-sr {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  padding: 0;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
  border: 0;
}
`;

    const iconExport = h(
      'svg',
      { viewBox: '0 0 24 24', 'aria-hidden': true, fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round' },
      h('path', { d: 'M12 3v11' }),
      h('path', { d: 'M8 10l4 4 4-4' }),
      h('path', { d: 'M5 16v3a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-3' }),
    );
    const iconSpinner = h(
      'svg',
      { viewBox: '0 0 24 24', 'aria-hidden': true, className: 'dshx-spin', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' },
      h('path', { d: 'M12 3a9 9 0 1 0 9 9' }),
    );
    const iconDone = h(
      'svg',
      { viewBox: '0 0 24 24', 'aria-hidden': true, fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round' },
      h('path', { d: 'M20 6L9 17l-5-5' }),
    );
    const iconError = h(
      'svg',
      { viewBox: '0 0 24 24', 'aria-hidden': true, fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round' },
      h('circle', { cx: 12, cy: 12, r: 9 }),
      h('path', { d: 'M12 7v6' }),
      h('path', { d: 'M12 17h.01' }),
    );

    /** Fetch the Host export route and hand the resulting HTML to the browser. */
    async function downloadExport(sessionId) {
      const url = `api/session.viewer?sessionId=${encodeURIComponent(String(sessionId))}&includeDescendants=true`;
      const response = await fetch(url, { credentials: 'same-origin' });
      if (!response.ok) {
        const detail = (await response.text().catch(() => '')).trim();
        throw new Error(detail || `HTTP ${response.status}`);
      }
      const blob = await response.blob();
      const href = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = href;
      anchor.download = `dsh-session-${String(sessionId)}.html`;
      anchor.style.display = 'none';
      document.body.appendChild(anchor);
      try {
        anchor.click();
      } finally {
        anchor.remove();
        setTimeout(() => URL.revokeObjectURL(href), 15000);
      }
    }

    /**
     * Session-header utility: export this conversation as a standalone page.
     * @param props - Session props plus the injected translator.
     */
    function ExportViewerButton(props) {
      const sessionId = props.sessionId;
      const t = props.t;
      const [state, setState] = React.useState('idle');
      const [detail, setDetail] = React.useState('');
      const timer = React.useRef(null);

      React.useEffect(() => () => { if (timer.current !== null) clearTimeout(timer.current); }, []);

      const settle = () => {
        if (timer.current !== null) clearTimeout(timer.current);
        timer.current = setTimeout(() => {
          timer.current = null;
          setState('idle');
          setDetail('');
        }, 2600);
      };

      const run = async () => {
        if (state === 'busy') return;
        if (timer.current !== null) { clearTimeout(timer.current); timer.current = null; }
        setState('busy');
        setDetail('');
        try {
          await downloadExport(sessionId);
          setState('done');
          settle();
        } catch (error) {
          setDetail(error instanceof Error && error.message ? error.message : String(error));
          setState('error');
          if (timer.current !== null) clearTimeout(timer.current);
          timer.current = setTimeout(() => {
            timer.current = null;
            setState('idle');
            setDetail('');
          }, 7000);
        }
      };

      const busy = state === 'busy';
      const label = busy ? t('action.busy') : state === 'error' ? `${t('action.error')}${detail ? ': ' + detail : ''}` : state === 'done' ? t('action.done') : t('action.label');
      return h(
        React.Fragment,
        null,
        h(
          'button',
          {
            type: 'button',
            className: 'dshx-export',
            'data-state': state,
            'aria-label': label,
            'aria-busy': busy ? 'true' : undefined,
            title: label,
            disabled: busy,
            onClick: run,
          },
          busy ? iconSpinner : state === 'done' ? iconDone : state === 'error' ? iconError : iconExport,
        ),
        h('span', { className: 'dshx-sr', role: 'status', 'aria-live': 'polite' }, state === 'idle' ? '' : label),
      );
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => {
          const tag = document.createElement('style');
          tag.dataset.pluginCss = 'dsh-export-viewer';
          tag.textContent = CSS;
          document.head.appendChild(tag);
          return () => tag.remove();
        }, 'dsh-export-viewer: styles');

        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-export-viewer: dictionaries');

        ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
          name: 'conversation.session.header.utilities',
          id: 'export-viewer',
          locale: NS,
          order: 5,
        }, ExportViewerButton));
      },
    };
  },
});
