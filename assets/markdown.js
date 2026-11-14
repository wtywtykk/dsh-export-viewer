/* markdown.js — lightweight, self-contained Markdown renderer for the
   DSH session viewer. Supports: headings, bold/italic/strikethrough,
   inline code, fenced code blocks (with language banner), lists, tables,
   blockquotes, links, hr, paragraphs. All output is HTML-escaped. */
(function () {
  'use strict';

  const esc = (s) =>
    String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');

  // inline tokens: code, image, bold, italic, strike, link, autolink
  // NOTE: the regex is created fresh per call — renderInline recurses, and a
  // shared `g` regex would have lastIndex clobbered by the nested call.
  // The image alternative must precede the link alternative, otherwise the
  // link rule would eat `[alt](src)` and leave a leading `!` as text.
  const INLINE_SRC =
    '(`+)([\\s\\S]*?)\\1' +
    '|!\\[([^\\]]*)\\]\\(([^)\\s]+)\\)' +
    '|(\\*\\*|__)([\\s\\S]*?)\\5' +
    '|(\\*|_)([\\s\\S]*?)\\7' +
    '|~~([\\s\\S]*?)~~' +
    '|\\[([^\\]]+)\\]\\(([^)\\s]+)\\)';

  // The host page can install a resolver so `![alt](local/path.png)` points at
  // an embedded copy (data URL) instead of a path the standalone page cannot read.
  let resolveImage = (src) => src;

  function renderImage(alt, src) {
    const safe = src.replace(/^javascript:/i, '');
    let resolved = safe;
    try {
      resolved = resolveImage(safe) || safe;
    } catch {
      resolved = safe;
    }
    return (
      '<a class="md-image-link" href="' + esc(resolved) + '" target="_blank" rel="noopener">' +
      '<img class="md-image" src="' + esc(resolved) + '" alt="' + esc(alt == null ? '' : alt) + '" loading="lazy" />' +
      '</a>'
    );
  }

  function renderInline(text) {
    const INLINE_RE = new RegExp(INLINE_SRC, 'g');
    let out = '';
    let last = 0;
    let m;
    let guard = 0;
    while ((m = INLINE_RE.exec(text)) !== null) {
      if (++guard > 100000) break; // defensive: never loop forever
      if (m.index < last) {
        last = m.index + m[0].length;
        continue;
      }
      out += esc(text.slice(last, m.index));
      if (m[1] !== undefined) {
        out += '<code>' + esc(m[2]) + '</code>';
      } else if (m[4] !== undefined) {
        out += renderImage(m[3], m[4]);
      } else if (m[5] !== undefined) {
        out += '<strong>' + renderInline(m[6]) + '</strong>';
      } else if (m[7] !== undefined) {
        out += '<em>' + renderInline(m[8]) + '</em>';
      } else if (m[9] !== undefined) {
        out += '<del>' + renderInline(m[9]) + '</del>';
      } else if (m[10] !== undefined) {
        const href = m[11];
        const safe = href.startsWith('#') ? href : href.replace(/^javascript:/i, '');
        out += '<a href="' + esc(safe) + '" target="_blank" rel="noopener">' + renderInline(m[10]) + '</a>';
      }
      last = INLINE_RE.lastIndex;
    }
    out += esc(text.slice(last));
    return out;
  }

  const fenceRE = /^\s*```([\w+-]*)\s*$/;
  const headRE = /^(#{1,6})\s+(.*)$/;
  const ulRE = /^\s*[-*+]\s+(.*)$/;
  const olRE = /^\s*\d+[.)]\s+(.*)$/;
  const quoteRE = /^\s*>\s?(.*)$/;
  const hrRE = /^\s*([-*_])\s*(\1\s*){2,}$/;
  const tableSepRE = /^\s*\|?[\s:|-]+\|?\s*$/;

  function renderTable(rows) {
    if (rows.length < 2) return '';
    const split = (r) => {
      const t = r.trim().replace(/^\||\|$/g, '');
      return t.split('|').map((c) => c.trim());
    };
    const header = split(rows[0]);
    const aligns = split(rows[1]).map((c) => {
      const l = /^\s*:/.test(c);
      const r = /:\s*$/.test(c);
      return l && r ? ' style="text-align:center"' : r ? ' style="text-align:right"' : l ? ' style="text-align:left"' : '';
    });
    let h = '<table><thead><tr>';
    header.forEach((c, i) => (h += '<th' + (aligns[i] || '') + '>' + renderInline(c) + '</th>'));
    h += '</tr></thead><tbody>';
    for (let i = 2; i < rows.length; i++) {
      const cells = split(rows[i]);
      h += '<tr>';
      cells.forEach((c, j) => (h += '<td' + (aligns[j] || '') + '>' + renderInline(c) + '</td>'));
      h += '</tr>';
    }
    return h + '</tbody></table>';
  }

  function render(src) {
    if (src == null) return '';
    const lines = String(src).replace(/\r\n/g, '\n').split('\n');
    const out = [];
    let i = 0;
    let para = [];
    let listStack = []; // {type:'ul'|'ol', tag}
    let tableRows = null;

    const flushPara = () => {
      if (para.length) {
        out.push('<p>' + para.map(renderInline).join('<br />') + '</p>');
        para = [];
      }
    };
    const flushTable = () => {
      if (tableRows) {
        out.push(renderTable(tableRows));
        tableRows = null;
      }
    };
    const closeListTo = (level) => {
      while (listStack.length > level) {
        const t = listStack.pop().tag;
        out.push('</' + t + '>');
      }
    };

    while (i < lines.length) {
      const line = lines[i];
      const trimmed = line.trim();

      // fenced code
      const fm = line.match(fenceRE);
      if (fm) {
        flushPara(); flushTable(); closeListTo(0);
        const lang = fm[1] || '';
        const buf = [];
        i++;
        while (i < lines.length && !fenceRE.test(lines[i])) {
          buf.push(lines[i]);
          i++;
        }
        i++; // skip closing fence
        const code = buf.join('\n');
        out.push(
          '<pre><div class="code-banner"><span class="lang">' +
            (lang ? esc(lang) : 'code') +
            '</span><span>' + esc(code.length + ' chars') + '</span></div><code>' + esc(code) + '</code></pre>'
        );
        continue;
      }

      // table
      if (line.includes('|') && i + 1 < lines.length && tableSepRE.test(lines[i + 1])) {
        flushPara(); closeListTo(0);
        tableRows = [];
        while (i < lines.length && lines[i].includes('|')) {
          tableRows.push(lines[i]);
          i++;
        }
        flushTable();
        continue;
      }
      flushTable();

      // heading
      const hm = line.match(headRE);
      if (hm) {
        flushPara(); closeListTo(0);
        const level = hm[1].length;
        out.push('<h' + level + '>' + renderInline(hm[2]) + '</h' + level + '>');
        i++;
        continue;
      }

      // hr
      if (hrRE.test(trimmed)) {
        flushPara(); closeListTo(0);
        out.push('<hr />');
        i++;
        continue;
      }

      // blockquote
      if (quoteRE.test(line)) {
        flushPara(); closeListTo(0);
        const buf = [];
        while (i < lines.length && quoteRE.test(lines[i])) {
          buf.push(line.replace(quoteRE, '$1'));
          i++;
        }
        out.push('<blockquote>' + buf.map(renderInline).join('<br />') + '</blockquote>');
        continue;
      }

      // unordered list
      const um = line.match(ulRE);
      if (um) {
        flushPara();
        if (!listStack.length || listStack[listStack.length - 1].type !== 'ul') {
          closeListTo(0);
          listStack.push({ type: 'ul', tag: 'ul' });
          out.push('<ul>');
        }
        out.push('<li>' + renderInline(um[1]) + '</li>');
        i++;
        continue;
      }

      // ordered list
      const om = line.match(olRE);
      if (om) {
        flushPara();
        if (!listStack.length || listStack[listStack.length - 1].type !== 'ol') {
          closeListTo(0);
          listStack.push({ type: 'ol', tag: 'ol' });
          out.push('<ol>');
        }
        out.push('<li>' + renderInline(om[1]) + '</li>');
        i++;
        continue;
      }

      // plain line — end of list context
      if (trimmed === '') {
        flushPara(); closeListTo(0);
        i++;
        continue;
      }
      closeListTo(0);
      para.push(trimmed);
      i++;
    }

    flushPara(); flushTable(); closeListTo(0);
    return out.join('\n');
  }

  window.DSHMarkdown = {
    render,
    /** Install a `src -> display src` resolver for Markdown images. */
    setImageResolver(fn) {
      resolveImage = typeof fn === 'function' ? fn : (src) => src;
    },
  };
})();
