/* library-export/pages/editor.js -- the editing mode: a document's LaTeX beside its compiled PDF.

   window.LibraryEditor = {mount(el, {num, draftId, data, go, onExit}), unmount()}. app.js mounts it for
   #/edit/<PPP-NNNN> and #/edit/draft/<id>. Plain script, no framework. The source pane is a vendored CodeMirror 6
   (/vendor/codemirror.mjs), the PDF pane pdf.js (/vendor/pdf.min.mjs), both loaded on first mount. The API is
   docs/library-editor.md plus the additions in the editor contract (POST /api/drafts, draft.ui, draft.direct,
   draft.new, draft.shared, marking scope). CSP: no inline styles or scripts; positions go through
   element.style.setProperty, which the policy allows. */
(function () {
  'use strict';

  var CM = null, PDFJS = null, W = null;   // the modules, and the widget classes built on CM
  var S = null;                             // the mounted editor's state; null when unmounted

  // ── small helpers ──

  function h(tag, props) {
    var el = document.createElement(tag);
    if (props) {
      Object.keys(props).forEach(function (k) {
        var v = props[k];
        if (v === null || v === undefined || v === false) return;
        if (k === 'class') el.className = v;
        else if (k === 'text') el.textContent = v;
        else if (k.slice(0, 2) === 'on' && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
        else if (k === 'value') el.value = v;
        else if (k === 'checked') el.checked = !!v;
        else el.setAttribute(k, v === true ? '' : String(v));
      });
    }
    for (var i = 2; i < arguments.length; i++) add(el, arguments[i]);
    return el;
  }
  function add(el, c) {
    if (c === null || c === undefined || c === false) return;
    if (Array.isArray(c)) { c.forEach(function (x) { add(el, x); }); return; }
    el.appendChild(typeof c === 'object' ? c : document.createTextNode(String(c)));
  }
  function setPos(el, props) { Object.keys(props).forEach(function (k) { el.style.setProperty(k, props[k]); }); return el; }
  function btn(label, onClick, cls, attrs) {
    var b = h('button', Object.assign({ type: 'button', class: cls || 'ed-btn' }, attrs || {}), label);
    b.addEventListener('click', function (e) { onClick(e); });
    return b;
  }
  function seg(value, options, onPick, cls) {
    return h('span', { class: 'ed-seg ' + (cls || ''), role: 'group' }, options.map(function (o) {
      return btn(o.label, function () { onPick(o.value); }, 'ed-seg-b' + (o.value === value ? ' on ' + (o.on || '') : ''),
        { 'aria-pressed': o.value === value ? 'true' : 'false', 'data-v': o.value });
    }));
  }
  function dot(cls) { return h('span', { class: 'ed-dot ' + (cls || '') }); }
  function hhmm(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d)) return '';
    return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  }
  function nextRev(r) {
    if (!r) return 'A';
    var cs = r.split(''), i = cs.length - 1;
    while (i >= 0) {
      if (cs[i] !== 'Z') { cs[i] = String.fromCharCode(cs[i].charCodeAt(0) + 1); return cs.join(''); }
      cs[i] = 'A'; i--;
    }
    return 'A' + cs.join('');
  }
  function api(method, path, body) {
    return fetch(path, {
      method: method, credentials: 'same-origin', keepalive: method === 'POST' && body && JSON.stringify(body).length < 60000,
      headers: body ? { 'Content-Type': 'application/json', 'Accept': 'application/json' } : { 'Accept': 'application/json' },
      body: body ? JSON.stringify(body) : undefined
    }).then(function (res) {
      if (!res.ok) {
        return res.text().then(function (t) { var e = new Error((t || ('HTTP ' + res.status)).trim()); e.status = res.status; throw e; });
      }
      return res.json();
    });
  }
  var get = function (p) { return api('GET', p); };
  var post = function (p, b) { return api('POST', p, b || {}); };

  // ── diff: a line diff first, then a word diff inside each changed run (Editor.dc.html's wd(), on the whole file) ──

  /** Myers over two arrays of strings, after the common head and tail: ops ['=', i, j] | ['-', i] | ['+', j], each
   *  run of edits with its deletions first. Past 4000 edits the middle is replaced whole. */
  function myers(a, b) {
    var s = 0;
    while (s < a.length && s < b.length && a[s] === b[s]) s++;
    var ea = a.length, eb = b.length;
    while (ea > s && eb > s && a[ea - 1] === b[eb - 1]) { ea--; eb--; }
    var A = a.slice(s, ea), B = b.slice(s, eb), N = A.length, M = B.length, mid = [];
    var off = N + M + 1, v = new Int32Array(2 * off + 2), trace = [], found = N === 0 && M === 0;
    for (var d = 0; !found && d <= N + M && d <= 4000; d++) {
      trace.push(v.slice(off - d - 1, off + d + 2));
      for (var k = -d; k <= d; k += 2) {
        var x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1;
        var y = x - k;
        while (x < N && y < M && A[x] === B[y]) { x++; y++; }
        v[off + k] = x;
        if (x >= N && y >= M) { found = true; break; }
      }
    }
    if (!found) {
      for (var i = 0; i < N; i++) mid.push(['-', s + i]);
      for (var j = 0; j < M; j++) mid.push(['+', s + j]);
    } else if (N || M) {
      var X = N, Y = M;
      for (var dd = trace.length - 1; dd >= 0; dd--) {
        var t = trace[dd], kk = X - Y;
        var at = function (q) { return t[q + dd + 1]; };
        var pk = kk === -dd || (kk !== dd && at(kk - 1) < at(kk + 1)) ? kk + 1 : kk - 1;
        var px = at(pk), py = px - pk;
        while (X > px && Y > py) { mid.push(['=', s + X - 1, s + Y - 1]); X--; Y--; }
        if (dd > 0) mid.push(X === px ? ['+', s + py] : ['-', s + px]);
        X = px; Y = py;
      }
      mid.reverse();
    }
    var ops = [];
    for (var p = 0; p < s; p++) ops.push(['=', p, p]);
    for (var q = 0; q < mid.length;) {
      if (mid[q][0] === '=') { ops.push(mid[q++]); continue; }
      var run = [];
      while (q < mid.length && mid[q][0] !== '=') run.push(mid[q++]);
      run.forEach(function (o) { if (o[0] === '-') ops.push(o); });
      run.forEach(function (o) { if (o[0] === '+') ops.push(o); });
    }
    for (var r = 0; r < a.length - ea; r++) ops.push(['=', ea + r, eb + r]);
    return ops;
  }
  function linesKeep(t) { var m = t.match(/[^\n]*\n|[^\n]+$/g); return m || []; }
  function tokens(x) { return x.split(/(\s+|\\[a-zA-Z]+\*?|[^\sA-Za-z0-9])/).filter(function (y) { return y; }); }

  /** The word diff of a file against its base: {ops, hunks}. ops: {t: '='|'-'|'+', text, btext (for '='), a, b
   *  (new offsets), ba, bb (base offsets), h (hunk index)}. hunks: {k, key, a, b, ba, bb, add, rem}. */
  function wordDiff(base, text) {
    var la = linesKeep(base), lb = linesKeep(text), raw = [];
    var pushOp = function (t, s, bs) {
      var l = raw[raw.length - 1];
      if (l && l.t === t) { l.text += s; if (t === '=') l.btext += bs; } else raw.push(t === '=' ? { t: t, text: s, btext: bs } : { t: t, text: s });
    };
    var lops = myers(la, lb);
    for (var i = 0; i < lops.length;) {
      var o = lops[i];
      if (o[0] === '=') { pushOp('=', lb[o[2]], la[o[1]]); i++; continue; }
      var R = '', D = '';
      while (i < lops.length && lops[i][0] !== '=') { if (lops[i][0] === '-') R += la[lops[i][1]]; else D += lb[lops[i][1]]; i++; }
      var ta = tokens(R), tb = tokens(D);
      myers(ta, tb).forEach(function (w) {
        if (w[0] === '=') pushOp('=', tb[w[2]], ta[w[1]]);
        else if (w[0] === '-') pushOp('-', ta[w[1]]);
        else pushOp('+', tb[w[1]]);
      });
    }
    // fold short equal runs between changes into the change; whitespace-only differences are no change
    var ops = [], rem = '', ad = '', inRun = false;
    var flush = function () {
      if (rem.replace(/\s+/g, '') === ad.replace(/\s+/g, '')) { if (ad || rem) ops.push({ t: '=', text: ad, btext: rem }); }
      else { if (rem) ops.push({ t: '-', text: rem }); if (ad) ops.push({ t: '+', text: ad }); }
      rem = ''; ad = ''; inRun = false;
    };
    raw.forEach(function (o, k) {
      if (o.t === '=') {
        var next = raw[k + 1];
        if (inRun && next && next.t !== '=' && ((o.text.trim().length < 12 && o.text.indexOf('\n\n') < 0) || /\\sout\{[^}]*$/.test(ad))) {
          rem += o.btext; ad += o.text; return;
        }
        if (inRun) flush();
        ops.push(o); return;
      }
      inRun = true;
      if (o.t === '-') rem += o.text; else ad += o.text;
    });
    if (inRun) flush();
    var hunks = [], hi = -1, open = false, pa = 0, pb = 0;
    ops.forEach(function (o) {
      o.a = pb; o.ba = pa;
      if (o.t === '=') { pb += o.text.length; pa += o.btext.length; }
      else if (o.t === '-') pa += o.text.length;
      else pb += o.text.length;
      o.b = pb; o.bb = pa;
      if (o.t === '=') { if (!/^[ \t]*$/.test(o.text)) open = false; return; }
      if (!open) { hi++; hunks.push({ k: hi, a: o.a, b: o.b, ba: o.ba, bb: o.bb }); open = true; }
      o.h = hi;
      var hk = hunks[hi]; hk.b = o.b; hk.bb = o.bb;
    });
    hunks.forEach(function (hk) {
      hk.add = text.slice(hk.a, hk.b); hk.rem = base.slice(hk.ba, hk.bb); hk.key = hk.ba + '-' + hk.bb;
    });
    return { ops: ops, hunks: hunks };
  }

  // ── LaTeX: the outline, the hidden-markup display, plain text, the document's labels and keys ──

  var HEADS = { part: 1, chapter: 1, section: 1, subsection: 2, subsubsection: 3 };
  var HEAD_RE = /\\(part|chapter|section|subsection|subsubsection)\*?\s*(?:\[[^\]]*\]\s*)?\{/;
  var BEGIN_RE = /\\begin\s*\{document\}/;
  var uncomment = function (line) { return line.replace(/(^|[^\\])%.*$/, '$1'); };
  function braced(s, i) {
    var depth = 1, j = i;
    for (; j < s.length && depth; j++) { if (s[j] === '{' && s[j - 1] !== '\\') depth++; else if (s[j] === '}' && s[j - 1] !== '\\') depth--; }
    return s.slice(i, depth ? j : j - 1).split(/\s+/).join(' ').trim().slice(0, 200);
  }
  /** The file cut into fold blocks. The main file: the preamble (the lines before \begin{document}), the document
   *  body from that line to its first heading, then one block per heading, to the line before the next one. Headings
   *  count only after \begin{document}, so a \section inside a \newcommand of the preamble cuts nothing. Another file:
   *  the lines before its first heading, then its headings. Keys stay put while the text around them changes. */
  function blocksOf(text, path, isMain, baseLines) {
    var lines = text.split('\n'), starts = [], acc = 0, heads = [], bodyAt = -1;
    lines.forEach(function (l, i) {
      starts.push(acc); acc += l.length + 1;
      var u = uncomment(l);
      if (isMain && bodyAt < 0) { if (BEGIN_RE.test(u)) bodyAt = i; return; }
      var m = u.match(HEAD_RE);
      if (m) heads.push({ i: i, level: HEADS[m[1]], title: plain(braced(u, m.index + m[0].length)) || 'Untitled', line: l });
    });
    if (isMain && bodyAt < 0) return blocksOf(text, path, false, baseLines).map(function (b) { if (b.key === 'pre') b.title = 'Preamble'; return b; });
    var out = [], seen = {};
    var mk = function (l0, l1, level, title, head, key) {
      var base = level + ':' + title, n = seen[base] = (seen[base] || 0) + 1;
      out.push({ key: key || (l0 === 0 && !head ? 'pre' : base + '#' + n), level: level, title: title, l0: l0, l1: l1,
        from: starts[l0], to: starts[l1] + lines[l1].length, head: !!head,
        isNew: !!head && baseLines && !baseLines.has(lines[l0]) });
    };
    var first = heads.length ? heads[0].i : lines.length;
    if (bodyAt >= 0) {
      if (bodyAt > 0) mk(0, bodyAt - 1, 0, 'Preamble', false, 'pre');
      mk(bodyAt, first - 1, 0, 'Document body', false, 'body');
    } else if (first > 0) mk(0, first - 1, 0, path, false);
    heads.forEach(function (hd, k) { mk(hd.i, k + 1 < heads.length ? heads[k + 1].i - 1 : lines.length - 1, hd.level, hd.title, true); });
    return out;
  }
  var SYM = { '\\circ': '°', '\\,': ' ', '\\;': ' ', '\\:': ' ', '\\ ': ' ', '\\quad': ' ', '\\qquad': '  ', '\\ldots': '…', '\\dots': '…',
    '\\cdots': '⋯', '\\times': '×', '\\cdot': '·', '\\pm': '±', '\\le': '≤', '\\leq': '≤', '\\ge': '≥', '\\geq': '≥', '\\neq': '≠',
    '\\approx': '≈', '\\infty': '∞', '\\to': '→', '\\rightarrow': '→', '\\leftarrow': '←', '\\alpha': 'α', '\\beta': 'β',
    '\\gamma': 'γ', '\\delta': 'δ', '\\Delta': 'Δ', '\\epsilon': 'ε', '\\theta': 'θ', '\\lambda': 'λ', '\\mu': 'μ', '\\pi': 'π',
    '\\sigma': 'σ', '\\Sigma': 'Σ', '\\tau': 'τ', '\\phi': 'φ', '\\omega': 'ω', '\\Omega': 'Ω', '\\eta': 'η', '\\rho': 'ρ',
    '\\%': '%', '\\&': '&', '\\_': '_', '\\#': '#', '\\$': '$', '\\{': '{', '\\}': '}', '\\LaTeX': 'LaTeX', '\\TeX': 'TeX',
    '\\textendash': '–', '\\textemdash': '—', '\\item': '• ', '\\euro': '€', '\\pounds': '£', '\\textdegree': '°', '~': ' ', '&': ' · ' };
  var REFS = /^\\(?:ref|eqref|pageref|autoref|cref|Cref|nameref)\{/;
  var CITES = /^\\(?:cite|citep|citet|parencite|textcite|autocite)\{/;
  /** What a hidden token shows: a symbol, a label's key, a citation's keys, or nothing. */
  function tokDisplay(t) {
    if (REFS.test(t)) return { text: t.slice(t.indexOf('{') + 1, -1), cls: 'ed-tok-ref' };
    if (CITES.test(t)) return { text: '[' + t.slice(t.indexOf('{') + 1, -1) + ']', cls: 'ed-tok-ref' };
    if (Object.prototype.hasOwnProperty.call(SYM, t)) return { text: SYM[t], cls: '' };
    return null;
  }
  var TOK_RE = /\\(?:ref|eqref|pageref|autoref|cref|Cref|nameref|label|cite|citep|citet|parencite|textcite|autocite)\{[^}]*\}|\\sout\{|\\[a-zA-Z@]+\*?|\\[^a-zA-Z\s]|[{}$&~^_]|^\s*%\s?/g;
  var WHOLE_RE = /^\\(part|chapter|section|subsection|subsubsection|label|begin|end|centering|raggedright|toprule|midrule|bottomrule|hline|maketitle|tableofcontents|documentclass|usepackage|docnumber|date|newpage|clearpage|vspace|input|include|includegraphics|bibliographystyle|bibliography|newcommand|renewcommand|setlength|pagestyle|thispagestyle|def)\b/;
  /** LaTeX to the text a reader sees, for the notes and the review. */
  function plain(t) {
    return String(t || '').replace(/^\s*%\s?/gm, '')
      .replace(/\\(?:label)\{[^}]*\}/g, '')
      .replace(/\\(?:ref|eqref|pageref|autoref|cref|Cref)\{([^}]*)\}/g, '$1')
      .replace(/\\(?:cite|citep|citet|parencite|textcite)\{([^}]*)\}/g, '[$1]')
      .replace(/\\[a-zA-Z@]+\*?|\\[^a-zA-Z\s]/g, function (m) {
        if (Object.prototype.hasOwnProperty.call(SYM, m)) return SYM[m];
        return '';
      })
      .replace(/[{}$]/g, '').replace(/~/g, ' ').replace(/[ \t\r\n]+/g, ' ').trim();
  }
  var norm = function (t) { return plain(t).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); };

  // ── autocompletion: commands, environments, the document's own labels, citation keys and files ──

  // [name, template (a CM snippet: ${placeholder} is selected on insert, Tab goes to the next), description]
  var COMMANDS = [
    ['section', '\\section{${Title}}', 'New section'], ['subsection', '\\subsection{${Title}}', 'New subsection'],
    ['subsubsection', '\\subsubsection{${Title}}', 'New subsubsection'], ['paragraph', '\\paragraph{${Title}}', 'Run-in heading'],
    ['section*', '\\section*{${Title}}', 'Section, unnumbered'], ['textbf', '\\textbf{${text}}', 'Bold'],
    ['emph', '\\emph{${text}}', 'Italic'], ['textit', '\\textit{${text}}', 'Italic shape'], ['underline', '\\underline{${text}}', 'Underline'],
    ['texttt', '\\texttt{${text}}', 'Typewriter'], ['textsc', '\\textsc{${text}}', 'Small caps'],
    ['sout', '\\sout{${text}}', 'Strike through, for Adapt'], ['item', '\\item ', 'List item'],
    ['begin', null, 'Start an environment'], ['end', null, 'Close the open environment'],
    ['label', '\\label{${key}}', 'Label to refer to'], ['ref', null, 'Refer to a label'], ['eqref', null, 'Refer to an equation'],
    ['pageref', null, 'Page of a label'], ['autoref', null, 'Refer to a label, with its name'], ['cref', null, 'Refer to a label (cleveref)'],
    ['cite', null, 'Citation'], ['citep', null, 'Citation in parentheses'], ['citet', null, 'Citation in text'],
    ['footnote', '\\footnote{${note}}', 'Footnote'], ['caption', '\\caption{${Caption}}', 'Caption'],
    ['includegraphics', '\\includegraphics[width=${0.8}\\linewidth]{${file}}', 'Image'], ['centering', '\\centering', 'Centre the block'],
    ['url', '\\url{${address}}', 'Web address'], ['href', '\\href{${address}}{${text}}', 'Link with text'],
    ['input', '\\input{${file}}', 'Include a file'], ['include', '\\include{${file}}', 'Include a chapter file'],
    ['frac', '\\frac{${a}}{${b}}', 'Fraction'], ['sqrt', '\\sqrt{${x}}', 'Square root'], ['text', '\\text{${text}}', 'Text in math'],
    ['mathrm', '\\mathrm{${x}}', 'Upright math'], ['mathbf', '\\mathbf{${x}}', 'Bold math'], ['mathit', '\\mathit{${x}}', 'Italic math'],
    ['left(', '\\left( ${} \\right)', 'Sized parentheses'], ['left[', '\\left[ ${} \\right]', 'Sized brackets'],
    ['sum', '\\sum_{${i=1}}^{${n}}', 'Sum'], ['int', '\\int_{${a}}^{${b}}', 'Integral'], ['lim', '\\lim_{${x \\to 0}}', 'Limit'],
    ['circ', '^\\circ', 'Degree sign'], ['times', '\\times', 'Times ×'], ['cdot', '\\cdot', 'Centre dot ·'], ['pm', '\\pm', 'Plus-minus ±'],
    ['le', '\\le', 'Less or equal ≤'], ['ge', '\\ge', 'Greater or equal ≥'], ['neq', '\\neq', 'Not equal ≠'], ['approx', '\\approx', 'Approximately ≈'],
    ['infty', '\\infty', 'Infinity ∞'], ['to', '\\to', 'Arrow →'], ['ldots', '\\ldots', 'Ellipsis …'], ['alpha', '\\alpha', 'α'],
    ['beta', '\\beta', 'β'], ['gamma', '\\gamma', 'γ'], ['delta', '\\delta', 'δ'], ['Delta', '\\Delta', 'Δ'], ['epsilon', '\\epsilon', 'ε'],
    ['theta', '\\theta', 'θ'], ['lambda', '\\lambda', 'λ'], ['mu', '\\mu', 'μ'], ['pi', '\\pi', 'π'], ['sigma', '\\sigma', 'σ'],
    ['omega', '\\omega', 'ω'], ['quad', '\\quad', 'Space'], ['qquad', '\\qquad', 'Wide space'],
    ['hline', '\\hline', 'Table rule'], ['toprule', '\\toprule', 'Table top rule'], ['midrule', '\\midrule', 'Table middle rule'],
    ['bottomrule', '\\bottomrule', 'Table bottom rule'], ['multicolumn', '\\multicolumn{${2}}{${c}}{${text}}', 'Cell over columns'],
    ['newline', '\\newline', 'Line break'], ['newpage', '\\newpage', 'Page break'], ['clearpage', '\\clearpage', 'Page break, floats out'],
    ['noindent', '\\noindent ', 'No paragraph indent'], ['vspace', '\\vspace{${1em}}', 'Vertical space'], ['hspace', '\\hspace{${1em}}', 'Horizontal space'],
    ['small', '\\small', 'Smaller text'], ['footnotesize', '\\footnotesize', 'Footnote-size text'], ['large', '\\large', 'Larger text'],
    ['today', '\\today', 'Today’s date'], ['LaTeX', '\\LaTeX', 'The LaTeX logo'], ['maketitle', '\\maketitle', 'Title block'],
    ['tableofcontents', '\\tableofcontents', 'Contents'], ['title', '\\title{${Title}}', 'Document title'], ['author', '\\author{${Name}}', 'Author'],
    ['date', '\\date{${\\today}}', 'Date'], ['usepackage', '\\usepackage{${package}}', 'Load a package'],
    ['newcommand', '\\newcommand{\\${name}}{${definition}}', 'Define a command'], ['textsuperscript', '\\textsuperscript{${text}}', 'Superscript'],
    ['textsubscript', '\\textsubscript{${text}}', 'Subscript'], ['SI', '\\SI{${value}}{${unit}}', 'Quantity (siunitx)'],
    ['qty', '\\qty{${value}}{${unit}}', 'Quantity (siunitx)'], ['num', '\\num{${number}}', 'Number (siunitx)'], ['si', '\\si{${unit}}', 'Unit (siunitx)'],
    ['bibliography', '\\bibliography{${file}}', 'Bibliography file'], ['bibitem', '\\bibitem{${key}} ', 'Bibliography entry']
  ];
  var ENVS = {
    itemize: '  \\item ${First}', enumerate: '  \\item ${First}', description: '  \\item[${Term}] ${text}',
    figure: '  \\centering\n  \\includegraphics[width=0.8\\linewidth]{${file}}\n  \\caption{${Caption}}\n  \\label{fig:${label}}',
    table: '  \\centering\n  \\caption{${Caption}}\n  \\label{tab:${label}}\n  \\begin{tabular}{${ll}}\n    ${} \\\\\n  \\end{tabular}',
    tabular: '  ${} \\\\', equation: '  ${}', 'equation*': '  ${}', align: '  ${} \\\\', 'align*': '  ${} \\\\', gather: '  ${}',
    multline: '  ${}', center: '  ${}', flushleft: '  ${}', flushright: '  ${}', quote: '  ${}', quotation: '  ${}', verbatim: '${}',
    abstract: '  ${}', minipage: '  ${}', cases: '  ${} & ${} \\\\', matrix: '  ${}', pmatrix: '  ${}', bmatrix: '  ${}', array: '  ${}',
    proof: '  ${}', theorem: '  ${}', lemma: '  ${}', thebibliography: '  \\bibitem{${key}} ${}', document: '${}'
  };
  var ENV_ARGS = { figure: '[${htbp}]', table: '[${htbp}]', tabular: '{${ll}}', minipage: '{${0.45\\linewidth}}', array: '{${cc}}',
    thebibliography: '{${9}}' };
  var ENV_DESC = { itemize: 'Bullet list', enumerate: 'Numbered list', description: 'Term list', figure: 'Figure with caption',
    table: 'Table with caption', tabular: 'Table body', equation: 'Numbered equation', 'equation*': 'Equation, unnumbered',
    align: 'Aligned equations', 'align*': 'Aligned, unnumbered', center: 'Centred block', quote: 'Quotation', verbatim: 'Verbatim text',
    abstract: 'Abstract', minipage: 'Box of text', cases: 'Cases', thebibliography: 'Bibliography' };

  /** What the whole draft defines: labels (with where), citation keys (with a title), commands, environments. */
  function docIndex() {
    var texts = allTexts(), idx = { labels: [], keys: [], cmds: {}, envs: {} }, seenL = {}, seenK = {};
    Object.keys(texts).forEach(function (path) {
      var t = texts[path];
      if (/\.bib$/i.test(path)) {
        var re = /@(\w+)\s*\{\s*([^,\s]+)\s*,/g, m;
        while ((m = re.exec(t))) {
          if (/^(string|comment|preamble)$/i.test(m[1]) || seenK[m[2]]) continue;
          seenK[m[2]] = 1;
          var rest = t.slice(m.index, m.index + 1500), tm = rest.match(/\btitle\s*=\s*[{"]([^\n]*)/i);
          idx.keys.push({ key: m[2], detail: tm ? plain(tm[1].replace(/[}"],?\s*$/, '')).slice(0, 60) : m[1] });
        }
        return;
      }
      var lines = t.split('\n'), where = path;
      lines.forEach(function (raw) {
        var l = uncomment(raw), m2, hm = l.match(HEAD_RE);
        if (hm) where = plain(braced(l, hm.index + hm[0].length));
        var cm = l.match(/\\caption\{([^}]*)/);
        var lre = /\\label\{([^}]+)\}/g;
        while ((m2 = lre.exec(l))) {
          if (seenL[m2[1]]) continue;
          seenL[m2[1]] = 1;
          idx.labels.push({ key: m2[1], detail: cm ? plain(cm[1]).slice(0, 50) : where });
        }
        var bre = /\\bibitem(?:\[[^\]]*\])?\{([^}]+)\}(.*)/g;
        while ((m2 = bre.exec(l))) { if (!seenK[m2[1]]) { seenK[m2[1]] = 1; idx.keys.push({ key: m2[1], detail: plain(m2[2]).slice(0, 60) || 'bibitem' }); } }
        var dre = /\\(?:newcommand|renewcommand|providecommand|DeclareMathOperator)\*?\s*\{?\\([a-zA-Z@]+)\}?\s*(?:\[(\d)\])?/g;
        while ((m2 = dre.exec(l))) idx.cmds[m2[1]] = { n: m2[2] ? +m2[2] : 0, detail: 'Defined in ' + path };
        var ddre = /\\def\\([a-zA-Z@]+)/g;
        while ((m2 = ddre.exec(l))) idx.cmds[m2[1]] = { n: 0, detail: 'Defined in ' + path };
        var ere = /\\(?:begin|newenvironment|newtheorem)\{([a-zA-Z*]+)\}/g;
        while ((m2 = ere.exec(l))) idx.envs[m2[1]] = 1;
        var ure = /\\([a-zA-Z]{2,})/g;
        while ((m2 = ure.exec(l))) if (!idx.cmds[m2[1]]) idx.cmds[m2[1]] = idx.cmds[m2[1]] || { used: true, n: 0, detail: 'Used in this document' };
      });
    });
    return idx;
  }
  function envSnippet(name) {
    var body = ENVS[name] !== undefined ? ENVS[name] : '  ${}';
    return '\\begin{' + name + '}' + (ENV_ARGS[name] || '') + '\n' + body + '\n\\end{' + name + '}';
  }
  /** The innermost \begin{…} before pos that has no \end{…} yet. */
  function openEnv(text, pos) {
    var re = /\\(begin|end)\{([a-zA-Z*]+)\}/g, m, stack = [], before = text.slice(0, pos);
    while ((m = re.exec(before))) { if (m[1] === 'begin') stack.push(m[2]); else { var i = stack.lastIndexOf(m[2]); if (i >= 0) stack.splice(i, 1); } }
    return stack.length ? stack[stack.length - 1] : null;
  }
  function latexCompletions(ctx) {
    var line = ctx.state.doc.lineAt(ctx.pos), before = line.text.slice(0, ctx.pos - line.from), m;
    var close = function (from) {
      var next = ctx.state.sliceDoc(ctx.pos, ctx.pos + 1);
      return function (key) { return { label: key, apply: function (view, c, f, t) { view.dispatch({ changes: { from: f, to: t, insert: key + (next === '}' ? '' : '}') }, selection: { anchor: f + key.length + 1 } }); } }; };
    };
    // \begin{ and \end{
    if ((m = before.match(/\\begin\{([a-zA-Z*]*)$/))) {
      var idx = docIndex(), names = Object.keys(ENVS).concat(Object.keys(idx.envs)).filter(function (x, i, a) { return a.indexOf(x) === i; });
      var start = ctx.pos - m[0].length, after = ctx.state.sliceDoc(ctx.pos, line.to);
      var skipClose = /^[a-zA-Z*]*\}/.exec(after);
      return { from: ctx.pos - m[1].length, filter: true, options: names.map(function (n) {
        return { label: n, detail: ENV_DESC[n] || (idx.envs[n] ? 'In this document' : 'Environment'), type: 'env', boost: idx.envs[n] ? 1 : 0,
          apply: function (view) {
            var to = ctx.pos + (skipClose ? skipClose[0].length : 0);
            CM.snippet(envSnippet(n))(view, null, start, Math.max(to, view.state.selection.main.head));
          } };
      }) };
    }
    if ((m = before.match(/\\end\{([a-zA-Z*]*)$/))) {
      var open = openEnv(ctx.state.doc.toString(), ctx.pos - m[0].length);
      var envs = Object.keys(ENVS);
      if (open) envs = [open].concat(envs.filter(function (x) { return x !== open; }));
      var mk = close();
      return { from: ctx.pos - m[1].length, options: envs.map(function (n, i) { var o = mk(n); o.boost = i === 0 && open ? 10 : 0; o.detail = n === open ? 'Closes the open one' : ''; return o; }) };
    }
    // \ref{ \eqref{ … : the document's labels
    if ((m = before.match(/\\(?:ref|eqref|pageref|autoref|cref|Cref|nameref|vref)\{([^}\s]*)$/))) {
      var mkr = close();
      return { from: ctx.pos - m[1].length, validFor: /^[^}\s]*$/, options: docIndex().labels.map(function (l) {
        var o = mkr(l.key); o.detail = l.detail; o.type = 'label'; return o;
      }) };
    }
    // \cite{a, b — the last key
    if ((m = before.match(/\\(?:cite|citep|citet|citeauthor|citeyear|nocite|parencite|textcite|autocite)\*?(?:\[[^\]]*\]){0,2}\{((?:[^},]*,\s*)*)([^},\s]*)$/))) {
      var mkc = close();
      return { from: ctx.pos - m[2].length, validFor: /^[^},\s]*$/, options: docIndex().keys.map(function (k) {
        var o = mkc(k.key); o.detail = k.detail; o.type = 'cite'; return o;
      }) };
    }
    // \input{ \include{ \includegraphics{ : the draft's files
    if ((m = before.match(/\\(?:input|include|includegraphics(?:\[[^\]]*\])?|bibliography)\{([^}]*)$/))) {
      var mkf = close();
      return { from: ctx.pos - m[1].length, options: S.draft.files.map(function (f) { return f.path; }).filter(function (p) { return p !== S.draft.main; }).map(function (p) {
        var o = mkf(/\.tex$/.test(p) && /\\(input|include)\{/.test(m[0]) ? p.replace(/\.tex$/, '') : p.replace(/\.bib$/, '')); o.detail = 'File'; return o;
      }) };
    }
    // \command
    if ((m = before.match(/\\([a-zA-Z@]*\*?|[a-zA-Z]*\(|[a-zA-Z]*\[)$/))) {
      if (!ctx.explicit && m[1] === '' && !/\\$/.test(before)) return null;
      var di = docIndex(), known = {};
      var opts = COMMANDS.map(function (c) {
        known[c[0]] = 1;
        var base = { label: '\\' + c[0], detail: c[2], type: 'cmd' };
        if (c[1] === null) {
          base.apply = function (view, comp, f, t) {
            var ins = c[0] === 'begin' ? '\\begin{' : c[0] === 'end' ? '\\end{' : '\\' + c[0] + '{';
            view.dispatch({ changes: { from: f, to: t, insert: ins }, selection: { anchor: f + ins.length } });
            setTimeout(function () { CM.startCompletion(view); }, 0);
          };
          return base;
        }
        return c[1].indexOf('${') >= 0 ? CM.snippetCompletion(c[1], base) : Object.assign(base, { apply: c[1] });
      });
      Object.keys(di.cmds).forEach(function (name) {
        var d = di.cmds[name];
        if (known[name] || (d.used && name === m[1])) return;   // not the word being typed
        var tpl = '\\' + name;
        for (var i = 1; i <= d.n; i++) tpl += '{${arg' + i + '}}';
        var o = { label: '\\' + name, detail: d.detail, type: 'cmd', boost: d.used ? -5 : 2 };
        opts.push(d.n ? CM.snippetCompletion(tpl, o) : Object.assign(o, { apply: tpl }));
      });
      return { from: ctx.pos - m[0].length, validFor: /^\\[a-zA-Z@]*\*?$/, options: opts };
    }
    return null;
  }
  /** Typing the } of \begin{name} on an otherwise empty line puts \end{name} under it, unless it is closed already. */
  function autoEnd(view, from, to, text) {
    if (text !== '}' || !S || S.locked) return false;
    var line = view.state.doc.lineAt(from), before = line.text.slice(0, from - line.from), m = before.match(/\\begin\{([a-zA-Z*]+)$/);
    if (!m || line.text.slice(to - line.from).trim() || view.state.sliceDoc(to, to + 1) === '}') return false;
    var name = m[1], rest = view.state.sliceDoc(to, Math.min(view.state.doc.length, to + 4000));
    var e = rest.indexOf('\\end{' + name + '}'), b = rest.indexOf('\\begin{' + name + '}');
    if (e >= 0 && (b < 0 || e < b)) return false;
    var ind = (line.text.match(/^\s*/) || [''])[0], ins = '}\n' + ind + '  \n' + ind + '\\end{' + name + '}';
    view.dispatch({ changes: { from: from, to: to, insert: ins }, selection: { anchor: from + 2 + ind.length + 2 }, userEvent: 'input.type' });
    return true;
  }

  // ── CodeMirror: the widgets and the decorations ──

  function defineWidgets() {
    var Sig = class extends CM.WidgetType {
      constructor(sig, make, opts) { super(); this.sig = sig; this.make = make; this.opts = opts || {}; }
    };
    Sig.prototype.eq = function (o) { return o.sig === this.sig; };
    Sig.prototype.toDOM = function () { return this.make(); };
    Sig.prototype.ignoreEvent = function () { return true; };
    Sig.prototype.updateDOM = function (dom) {
      if (!this.opts.update) return false;
      this.opts.update(dom); return true;
    };
    Object.defineProperty(Sig.prototype, 'estimatedHeight', { get: function () { return this.opts.height || -1; } });
    return {
      w: function (sig, make, opts) { return new Sig(sig, make, opts); }
    };
  }
  var Refresh = null, PathFacet = null, decoField = null, latexComp = null, fontComp = null, editComp = null;

  function setupCM() {
    Refresh = CM.StateEffect.define();
    PathFacet = CM.Facet.define({ combine: function (v) { return v[0] || ''; } });
    W = defineWidgets();
    latexComp = new CM.Compartment(); fontComp = new CM.Compartment(); editComp = new CM.Compartment();
    decoField = CM.StateField.define({
      create: function (state) { return buildDecos(state); },
      update: function (v, tr) {
        // carry the last analysis's hunks through the edit, so the next one can tell which hunk is which by where
        // it now sits: the base offsets it is keyed by shift when the word diff re-aligns around a new edit
        var A = tr.docChanged && S && S.an[tr.state.facet(PathFacet)];
        if (A && A.at === tr.startState.doc) {
          A.hunks.forEach(function (x) { x.a = tr.changes.mapPos(x.a, -1); x.b = tr.changes.mapPos(x.b, 1); });
          A.at = tr.state.doc;
        }
        if (tr.docChanged || tr.selection || tr.effects.some(function (e) { return e.is(Refresh); })) return buildDecos(tr.state);
        return v;
      },
      provide: function (f) {
        return [CM.EditorView.decorations.from(f, function (v) { return v.all; }),
          CM.EditorView.atomicRanges.of(function (view) { return view.state.field(f).atomic; })];
      }
    });
  }
  var texHighlight = null;
  function highlightExt() {
    if (!texHighlight) {
      var t = CM.tags;
      texHighlight = CM.syntaxHighlighting(CM.HighlightStyle.define([
        { tag: [t.tagName, t.bracket, t.keyword, t.atom], class: 'ed-hl-cmd' },
        { tag: t.comment, class: 'ed-hl-comment' },
        { tag: [t.string, t.number], class: 'ed-hl-arg' }
      ]));
    }
    return [CM.StreamLanguage.define(CM.stex), texHighlight];
  }
  function makeState(path, text) {
    return CM.EditorState.create({
      doc: text,
      extensions: [
        PathFacet.of(path), decoField,
        editComp.of([CM.EditorState.readOnly.of(!!S.locked), CM.EditorView.editable.of(!S.locked)]),
        latexComp.of(S.showLatex ? highlightExt() : []),
        fontComp.of(CM.EditorView.editorAttributes.of({ class: S.showLatex ? 'ed-mono' : 'ed-serif' })),
        CM.EditorView.lineWrapping, CM.drawSelection(),
        CM.EditorView.inputHandler.of(autoEnd),
        CM.autocompletion({ override: [latexCompletions], icons: false, activateOnTyping: true, maxRenderedOptions: 60, interactionDelay: 0,
          optionClass: function () { return 'ed-ac-opt'; }, tooltipClass: function () { return 'ed-ac'; } }),
        CM.Prec.highest(CM.keymap.of([{ key: 'Tab', run: CM.acceptCompletion }])),
        CM.keymap.of(CM.completionKeymap.concat(CM.defaultKeymap, [CM.indentWithTab])),
        CM.EditorView.updateListener.of(onCmUpdate),
        CM.EditorView.domEventHandlers({
          mouseup: function (e, view) { setTimeout(function () { texSelection(view); }, 10); return false; },
          click: function (e, view) { onTexClick(e, view); return false; },
          keyup: function (e, view) { if (e.shiftKey) texSelection(view); return false; }
        })
      ]
    });
  }

  /** Every decoration of the current file: fold heads, folded bodies, hidden markup (never in the main file's
   *  preamble, which shows as written), change tints, chips, deletion
   *  bars, the struck original, comment highlights and pins, the compile error. `atomic` holds the replaced ranges,
   *  so the caret steps over hidden markup as one character. */
  function buildDecos(state) {
    var D = CM.Decoration, all = [], atomic = [];
    if (!S) return { all: D.none, atomic: D.none };
    var path = state.facet(PathFacet), an = analyse(path, state.doc), doc = state.doc;
    var head = state.selection.main.head, hideTex = !S.showLatex, open = S.open[path] || {};
    var blockOf = function (pos) { for (var i = an.blocks.length - 1; i >= 0; i--) if (an.blocks[i].from <= pos) return an.blocks[i]; return an.blocks[0]; };
    var ghostAt = {};
    an.ghosts.forEach(function (g) { (ghostAt[g.pos] = ghostAt[g.pos] || []).push(g); });
    var cms = texComments(path, an);
    var err = compileError();
    an.blocks.forEach(function (b, bi) {
      (ghostAt[b.from] || []).forEach(function (g) { all.push(D.widget({ widget: ghostWidget(path, g), block: true, side: -2 }).range(b.from)); });
      all.push(D.widget({ widget: headWidget(path, b, an, cms), block: true, side: -1 }).range(b.from));
      if (!open[b.key]) {
        var fr = D.replace({ block: true }).range(b.from, b.to);
        all.push(fr); atomic.push(fr);
        return;
      }
      // the open block's lines: hidden markup. Never in the main file's preamble: it is all markup, and hidden there
      // \moderncvstyle{banking} read as a bare "banking" and \documentclass[..]{moderncv} as "[..]moderncv}"
      if (hideTex && !(b.key === 'pre' && b.title === 'Preamble')) {
        for (var ln = b.l0; ln <= b.l1; ln++) {
          var line = doc.line(ln + 1), t = line.text, tr = t.trim();
          var onCaret = head >= line.from && head <= line.to;
          if ((ln === b.l0 && b.head) || (WHOLE_RE.test(tr) && !onCaret)) {
            if (ln === b.l0 && b.head && b.l0 === b.l1) continue;   // a section with nothing under its head yet
            var r = D.replace({ block: true }).range(line.from, line.to);
            if (line.to > line.from || ln !== b.l0) { all.push(r); atomic.push(r); }
            continue;
          }
          TOK_RE.lastIndex = 0;
          var m;
          while ((m = TOK_RE.exec(t))) {
            if (!m[0].length) { TOK_RE.lastIndex++; continue; }
            var f = line.from + m.index, e = f + m[0].length;
            if (head >= f && head <= e && (m[0].length > 1 || head === e)) { all.push(D.mark({ class: 'ed-raw' }).range(f, e)); continue; }
            var disp = tokDisplay(m[0].trim() ? m[0] : m[0]);
            var dec = D.replace(disp && disp.text ? { widget: tokWidget(disp) } : {}).range(f, e);
            all.push(dec); atomic.push(dec);
          }
          var sre = /\\sout\{([^}]*)\}/g, sm;
          while ((sm = sre.exec(t))) if (sm[1]) all.push(D.mark({ class: 'ed-strike' }).range(line.from + sm.index + 6, line.from + sm.index + 6 + sm[1].length));
          var bre = /\\(textbf|emph|textit)\{([^{}]*)\}/g, bm;
          while ((bm = bre.exec(t))) if (bm[2]) {
            var bf = line.from + bm.index + bm[1].length + 2;
            all.push(D.mark({ class: bm[1] === 'textbf' ? 'ed-bold' : 'ed-ital' }).range(bf, bf + bm[2].length));
          }
        }
      }
      // compile error under its line
      if (err && err.line && err.path === path && err.line - 1 >= b.l0 && err.line - 1 <= b.l1 && err.line <= doc.lines) {
        all.push(D.widget({ widget: errWidget(err), block: true, side: 1 }).range(doc.line(err.line).to));
      }
    });
    // changes: tints, chips, deletion bars, the struck original
    var isOpenAt = function (pos) { var b = blockOf(pos); return b && open[b.key]; };
    var tpl = S.scope[path] === 'template';
    var lastOf = {};
    an.ops.forEach(function (o, i) { if (o.h !== undefined) lastOf[o.h] = i; });
    an.ops.forEach(function (o, i) {
      if (o.h === undefined) return;
      var hk = an.hunks[o.h], mk = markOf(path, hk);
      if (o.t === '+' && o.b > o.a && isOpenAt(o.a)) all.push(D.mark({ class: 'ed-add ed-' + mk, attributes: { 'data-hunk': String(o.h) } }).range(o.a, o.b));
      if (o.t === '-' && isOpenAt(Math.min(o.a, doc.length))) {
        var hasAdd = an.ops.some(function (x) { return x.h === o.h && x.t === '+'; });
        if (S.showOriginal) all.push(D.widget({ widget: origWidget(o.text, mk), side: -1 }).range(o.a));
        else if (!hasAdd) all.push(D.widget({ widget: delWidget(path, hk, mk), side: -1 }).range(o.a));
      }
      if (lastOf[o.h] === i && isOpenAt(Math.min(hk.b, doc.length))) all.push(D.widget({ widget: chipWidget(path, hk, mk, tpl), side: 1 }).range(hk.b));
    });
    // the line Find in tex landed on
    var fd = S.found;
    if (fd && fd.path === path && fd.to <= doc.length) {
      for (var fl = doc.lineAt(fd.from).number, fe = doc.lineAt(fd.to).number; fl <= fe; fl++) {
        var fline = doc.line(fl);
        if (isOpenAt(fline.from)) all.push(D.line({ class: 'ed-found' }).range(fline.from));
      }
    }
    // comments on the source
    cms.forEach(function (c) {
      if (!isOpenAt(c.at.to)) return;
      if (c.at.hl) all.push(D.mark({ class: 'ed-cmhl' }).range(c.at.from, c.at.to));
      all.push(D.widget({ widget: pinWidget(c), side: 2 }).range(c.at.to));
    });
    return { all: D.set(all, true), atomic: D.set(atomic, true) };
  }

  function tokWidget(disp) {
    return W.w('tok|' + disp.cls + '|' + disp.text, function () { return h('span', { class: 'ed-tok ' + disp.cls, text: disp.text }); });
  }
  function origWidget(text, mk) {
    var shown = S.showLatex ? text : plain(text);
    return W.w('orig|' + mk + '|' + shown, function () { return h('span', { class: 'ed-orig ed-' + mk, text: shown }); });
  }
  function delWidget(path, hk, mk) {
    return W.w('del|' + hk.key + '|' + mk, function () {
      var el = h('span', { class: 'ed-delbar ed-' + mk, title: 'Removed: ' + plain(hk.rem).slice(0, 140), 'data-hunk-key': hk.key });
      el.addEventListener('mousedown', function (e) { e.preventDefault(); openHunkPop(path, hk.key, el); });
      return el;
    });
  }
  function chipWidget(path, hk, mk, tpl) {
    return W.w('chip|' + hk.key + '|' + mk + '|' + tpl, function () {
      var el = h('span', { class: 'ed-chip ed-' + mk, title: 'Click to switch between OG and Adapt', 'data-chip': hk.key },
        (mk === 'og' ? 'OG' : 'Adapt') + (tpl ? ' · template' : ''));
      el.addEventListener('mousedown', function (e) {
        e.preventDefault(); e.stopPropagation();
        if (S.locked) return;
        setMark(path, hk.key, markOf(path, hk) === 'og' ? 'adapt' : 'og');
      });
      return el;
    });
  }
  function pinWidget(c) {
    return W.w('pin|' + c.id + '|' + c.n + '|' + c.text, function () {
      var el = h('span', { class: 'ed-pin', title: c.text, 'data-pin': c.id }, String(c.n));
      el.addEventListener('mousedown', function (e) { e.preventDefault(); openNote(c.id); });
      return el;
    });
  }
  function errWidget(err) {
    return W.w('err|' + err.line + '|' + err.message, function () {
      return h('div', { class: 'ed-errline' }, h('span', { class: 'ed-mono-s' }, err.message || 'Error'), ' ',
        h('span', { class: 'ed-errhint', text: 'l. ' + err.line + ' · fix it and save again' }));
    });
  }
  function ghostWidget(path, g) {
    return W.w('ghost|' + g.key + '|' + g.title + '|' + S.locked, function () {
      return h('div', { class: 'ed-head ed-ghost' },
        h('span', { class: 'ed-caret', text: '▸' }), h('span', { class: 'ed-head-title ed-struck', text: g.title }),
        h('span', { class: 'ed-range', text: 'deleted' }),
        S.locked ? null : btn('Restore', function () { revertHunk(path, g.key); }, 'ed-link'));
    }, { height: 38 });
  }

  /** A fold's head: the triangle, the title (an input for a new section), its lines, its changes and comments;
   *  open, its actions and the shared-template switch. */
  function headWidget(path, b, an, cms) {
    var hs = an.hunks.filter(function (x) { return x.a >= b.from && x.a <= b.to + (b === an.blocks[an.blocks.length - 1] ? 1 : 0); });
    var ms = hs.map(function (x) { return markOf(path, x); });
    var nC = cms.filter(function (c) { return c.at.from >= b.from && c.at.from <= b.to + 1; }).length;
    var isOpen = !!(S.open[path] || {})[b.key];
    var shared = sharedOf(path), tpl = S.scope[path] === 'template';
    var dotCls = !ms.length ? '' : ms.every(function (m) { return m === 'og'; }) ? 'ed-og' : ms.every(function (m) { return m === 'adapt'; }) ? 'ed-adapt' : 'ed-mixed';
    var titleEdit = b.isNew && !S.locked;
    var sig = ['head', b.key, b.title, b.l0, b.l1, hs.length, ms.join(','), nC, isOpen, !!shared, tpl, S.locked, titleEdit, S.showLatex].join('|');
    var render = function (dom) {
      var keep = dom.querySelector('input[data-title-input]');
      var keepFocus = keep && document.activeElement === keep;
      dom.textContent = '';
      dom.className = 'ed-headblk' + (b.key === 'body' ? ' ed-body' : b.level === 0 ? ' ed-pre' : '') + (b.level >= 2 ? ' ed-sub' : '');
      dom.setAttribute('data-sec-head', b.key);
      var row = h('div', { class: 'ed-head' + (S.flashHead === b.key ? ' ed-flash' : '') });
      var tog = h('button', { type: 'button', class: 'ed-head-tog' },
        h('span', { class: 'ed-caret', text: isOpen ? '▾' : '▸' }),
        titleEdit ? null : h('span', { class: 'ed-head-title', text: b.title }),
        h('span', { class: 'ed-range', text: 'l. ' + (b.l0 + 1) + '–' + (b.l1 + 1) }),
        shared ? h('span', { class: 'ed-shared-tag', title: shared.path, text: tpl ? 'shared · updates template' : 'shared' }) : null);
      tog.addEventListener('click', function () { toggleOpen(path, b.key); });
      row.appendChild(tog);
      if (titleEdit) {
        var inp = keepFocus ? keep : h('input', { class: 'ed-title-input', 'data-title-input': b.key, value: b.title, placeholder: 'Section title', 'aria-label': 'Section title' });
        if (!keepFocus) {
          inp.addEventListener('input', function () { retitle(path, b.key, inp.value); });
          inp.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); focusBlockBody(path, b.key); } e.stopPropagation(); });
        }
        row.appendChild(inp);
      }
      if (hs.length) row.appendChild(h('span', { class: 'ed-head-ch' }, dot(dotCls), hs.length + (hs.length === 1 ? ' change' : ' changes')));
      if (nC) row.appendChild(h('span', { class: 'ed-head-cm', text: nC + (nC === 1 ? ' comment' : ' comments') }));
      dom.appendChild(row);
      if (isOpen) {
        var acts = h('div', { class: 'ed-head-acts' },
          btn('Show in PDF', function () { showInPdf(path, b.l0 + 1); }, 'ed-link'),
          !S.locked && b.level > 0 ? btn('Delete section', function () { deleteBlock(path, b.key); }, 'ed-link') : null,
          !S.locked && hs.length ? btn('Revert to ' + (S.draft.base_rev || 'the start'), function () { revertBlock(path, b.key); }, 'ed-link') : null,
          !S.locked ? btn('Add section below', function () { addSectionAfter(path, b.key); }, 'ed-link') : null,
          h('span', { class: 'ed-hint', text: S.locked ? '' : 'Type to edit · \\ for commands · select to comment' }));
        dom.appendChild(acts);
        if (shared) {
          dom.appendChild(h('div', { class: 'ed-sharedline' },
            h('span', null, 'From ', h('span', { class: 'ed-mono-s', text: shared.path }), ', also used by ' + usedBy(shared) + '.'),
            h('span', { class: 'ed-scope' }, h('span', { class: 'ed-muted', text: 'Changes here update' }),
              seg(tpl ? 'template' : 'doc', [{ value: 'doc', label: 'This document' }, { value: 'template', label: 'The template', on: 'ed-plum' }], function (v) { setScope(path, v); }))));
        }
      }
    };
    return W.w(sig, function () { var d = h('div'); render(d); return d; }, { update: render, height: isOpen ? 70 : 38 });
  }
  function usedBy(sh) {
    var u = sh.used_by || [];
    return u.length === 0 ? 'other documents' : u.length === 1 ? u[0] : u.length + ' documents (' + u.join(', ') + ')';
  }
  function sharedOf(path) { return (S.draft.shared || []).find(function (x) { return x.path === path; }) || null; }

  // ── the analysis of a file: its diff, marks, blocks and deleted sections, cached per document ──

  function analyse(path, doc) {
    var A = S.an[path];
    if (A && A.doc === doc) return A;
    var text = doc.toString(), base = S.base[path] || '';
    var d = wordDiff(base, text);
    var old = S.marks[path] || {}, nm = {};
    d.hunks.forEach(function (hk) {
      var m = old[hk.key];
      // a hunk that grew over earlier ones keeps their marking; over an OG one and an Adapt one it is Adapt, so an
      // Adapt edit never turns OG by being typed next to one
      if (!m && A) {
        var mapped = A.at === doc, pm = A.hunks.filter(function (x) { return mapped ? x.a <= hk.b && hk.a <= x.b : x.ba <= hk.bb && hk.ba <= x.bb; })
          .map(function (x) { return old[x.key] || x.mark; });
        if (pm.length) m = pm.indexOf('adapt') >= 0 ? 'adapt' : pm[0];
      }
      if (!m && S.loadMarkings) m = fromMarkings(path, text, hk);
      hk.mark = nm[hk.key] = m || S.defMark;
    });
    S.marks[path] = nm;
    if (!S.baseLines[path]) S.baseLines[path] = new Set(base.split('\n'));
    var blocks = blocksOf(text, path, path === S.draft.main, S.baseLines[path]);
    var ghosts = [];
    d.hunks.forEach(function (hk) {
      if (hk.add.trim()) return;
      var lines = hk.rem.split('\n');
      lines.forEach(function (l) {
        var m = uncomment(l).match(HEAD_RE);
        if (m && /^\s*\\/.test(l)) ghosts.push({ key: hk.key, pos: hk.a, title: plain(braced(uncomment(l), m.index + m[0].length)) || 'Section' });
      });
    });
    ghosts.forEach(function (g) {
      // a deleted section shows above the block that now starts where it was
      var nb = blocks.find(function (b) { return b.from >= g.pos; }) || blocks[blocks.length - 1];
      g.pos = nb ? nb.from : 0;
    });
    // new sections open themselves
    var known = S.known[path] = S.known[path] || {};
    var first = !S.knownInit[path];
    blocks.forEach(function (b) {
      if (!known[b.key]) { known[b.key] = true; if (!first && b.level > 0) { (S.open[path] = S.open[path] || {})[b.key] = true; } }
    });
    S.knownInit[path] = true;
    A = S.an[path] = { doc: doc, at: doc, text: text, ops: d.ops, hunks: d.hunks, blocks: blocks, ghosts: ghosts };
    return A;
  }
  function markOf(path, hk) { return (S.marks[path] || {})[hk.key] || hk.mark || S.defMark; }
  /** The server marks by line: a run of changed lines is one change, and OG wins in it. So an OG edit that shares
   *  its line, or a run of touching lines, with an Adapt edit would file the Adapt text as written. Such a run goes
   *  out as Adapt whole: it is never filed directly. {hunk key: first line of its run} for every OG hunk so moved. */
  function sharedLines(path) {
    var an = analysisOf(path), out = {};
    if (!an) return out;
    var runs = [];
    an.hunks.map(function (hk) { var r = hunkLines(an.text, hk); return { hk: hk, from: r.from, to: r.to }; })
      .sort(function (x, y) { return x.from - y.from; }).forEach(function (x) {
        var last = runs[runs.length - 1];
        if (last && x.from <= last.to + 1) { last.to = Math.max(last.to, x.to); last.hs.push(x.hk); } else runs.push({ from: x.from, to: x.to, hs: [x.hk] });
      });
    runs.forEach(function (r) {
      var ms = r.hs.map(function (hk) { return markOf(path, hk); });
      if (ms.indexOf('adapt') >= 0 && ms.indexOf('og') >= 0) r.hs.forEach(function (hk) { if (markOf(path, hk) === 'og') out[hk.key] = r.from; });
    });
    return out;
  }
  /** The marking a hunk is sent with: its own, or Adapt when it shares a line with an Adapt edit. */
  function sentMark(path, hk, shared) { return (shared || sharedLines(path))[hk.key] ? 'adapt' : markOf(path, hk); }
  /** On first load, a hunk's marking from the saved line ranges (OG wins), as the server reads them. */
  function fromMarkings(path, text, hk) {
    var r = hunkLines(text, hk), hit = (S.loadMarkings || []).filter(function (m) { return m.path === path && m.from <= r.to && m.to >= r.from; });
    if (hit.some(function (m) { return m.marking === 'og'; })) return 'og';
    if (hit.length) return 'adapt';
    return S.draft.default_marking || 'adapt';
  }
  function lineAtOffset(text, off) { var n = 1; for (var i = 0; i < off && i < text.length; i++) if (text.charCodeAt(i) === 10) n++; return n; }
  function hunkLines(text, hk) {
    var from = lineAtOffset(text, hk.a), to = hk.b > hk.a ? lineAtOffset(text, Math.max(hk.a, hk.b - 1)) : from;
    return { from: from, to: Math.max(from, to) };
  }

  // ── files: the current one lives in the view, the others as saved EditorStates ──

  function textOf(path) {
    if (S.view && path === S.cur) return S.view.state.doc.toString();
    if (S.states[path]) return S.states[path].doc.toString();
    var f = S.draft.files.find(function (x) { return x.path === path; });
    return f ? f.text : '';
  }
  function allTexts() {
    var o = {};
    // Chrome types a no-break space next to a hidden token; the source keeps a plain one
    S.draft.files.forEach(function (f) { o[f.path] = textOf(f.path).replace(/\u00a0/g, ' '); });
    return o;
  }
  function stateOf(path) {
    if (S.view && path === S.cur) return S.view.state;
    return S.states[path];
  }
  function analysisOf(path) { var st = stateOf(path); return st ? analyse(path, st.doc) : null; }
  function editable(path) { return /\.(tex|bib|sty|cls|bst|txt|cfg|def|ltx|md)$/i.test(path); }
  function switchFile(path) {
    if (!S.states[path] || path === S.cur) return;
    S.states[S.cur] = S.view.state;
    S.cur = path;
    S.view.setState(S.states[path]);
    reconfigure();
    render();
  }
  function reconfigure() {
    if (!S.view) return;
    S.view.dispatch({ effects: [
      latexComp.reconfigure(S.showLatex ? highlightExt() : []),
      fontComp.reconfigure(CM.EditorView.editorAttributes.of({ class: S.showLatex ? 'ed-mono' : 'ed-serif' })),
      editComp.reconfigure([CM.EditorState.readOnly.of(!!S.locked), CM.EditorView.editable.of(!S.locked)]),
      Refresh.of(null)] });
  }
  function refresh() { if (S && S.view) S.view.dispatch({ effects: Refresh.of(null) }); }

  // ── edits: typing, marks, sections, undo ──

  var Restoring = null;
  function onCmUpdate(u) {
    if (!S) return;
    if (u.docChanged) {
      var restoring = u.transactions.some(function (tr) { return tr.annotation(Restoring); });
      if (!restoring) pushUndo('tex', u.startState.doc, S.cur);
      S.dirty = true; S.version++;
      S.hunkPop = null; S.found = null;
      scheduleRender();
    }
    if (u.selectionSet && S.sel && S.sel.src === 'tex' && u.state.selection.main.empty) { S.sel = null; scheduleRender(); }
  }
  function snapshot(prevDoc, path) {
    var texts = {};
    S.draft.files.forEach(function (f) { if (editable(f.path) || S.states[f.path]) texts[f.path] = (prevDoc && f.path === path) ? prevDoc.toString() : textOf(f.path); });
    return { texts: texts, marks: JSON.parse(JSON.stringify(S.marks)), defMark: S.defMark, scope: Object.assign({}, S.scope) };
  }
  /** Typing within 1.2 s is one step; up to 150 steps. */
  function pushUndo(kind, prevDoc, path) {
    var now = Date.now();
    if (kind === 'tex' && S.lastKind === 'tex' && now - S.lastPush < 1200) { S.lastPush = now; return; }
    S.undo.push(snapshot(prevDoc, path));
    if (S.undo.length > 150) S.undo.shift();
    S.redo = []; S.lastPush = now; S.lastKind = kind;
  }
  function restore(snap) {
    S.marks = snap.marks; S.defMark = snap.defMark; S.scope = snap.scope;
    Object.keys(snap.texts).forEach(function (p) {
      var cur = textOf(p), want = snap.texts[p];
      if (cur === want) return;
      var a = 0; while (a < cur.length && a < want.length && cur[a] === want[a]) a++;
      var b = 0; while (b < cur.length - a && b < want.length - a && cur[cur.length - 1 - b] === want[want.length - 1 - b]) b++;
      var ch = { from: a, to: cur.length - b, insert: want.slice(a, want.length - b) };
      if (p === S.cur) S.view.dispatch({ changes: ch, selection: { anchor: a + ch.insert.length }, annotations: Restoring.of(true), scrollIntoView: true });
      else S.states[p] = S.states[p].update({ changes: ch, annotations: Restoring.of(true) }).state;
    });
    S.dirty = true; S.version++; S.lastKind = null; S.hunkPop = null; S.sel = null; S.composer = null;
    refresh(); render();
  }
  function undo() { if (S.locked || !S.undo.length) return; S.redo.push(snapshot()); restore(S.undo.pop()); }
  function redo() { if (S.locked || !S.redo.length) return; S.undo.push(snapshot()); restore(S.redo.pop()); }

  function setMark(path, key, m) {
    if (S.locked) return;
    pushUndo('other');
    (S.marks[path] = S.marks[path] || {})[key] = m;
    S.dirty = true; S.version++;
    refresh(); render();
  }
  function setScope(path, v) { if (S.locked) return; pushUndo('other'); S.scope[path] = v; S.dirty = true; S.version++; refresh(); render(); }
  function setDefMark(v) { pushUndo('other'); S.defMark = v; saveUiSoon(); render(); }
  function toggleOpen(path, key) {
    var o = S.open[path] = S.open[path] || {};
    o[key] = !o[key];
    S.hunkPop = null;
    refresh(); saveUiSoon(); render();
  }
  function dispatchTo(path, spec) {
    if (path !== S.cur) switchFile(path);
    S.view.dispatch(spec);
  }
  function blockByKey(path, key) { var an = analysisOf(path); return an && an.blocks.find(function (b) { return b.key === key; }); }
  function revertHunk(path, key) {
    var an = analysisOf(path), hk = an && an.hunks.find(function (x) { return x.key === key; });
    if (!hk || S.locked) return;
    S.hunkPop = null;
    dispatchTo(path, { changes: { from: hk.a, to: hk.b, insert: hk.rem } });
  }
  function revertBlock(path, key) {
    var an = analysisOf(path), b = blockByKey(path, key);
    if (!b || S.locked) return;
    var ch = an.hunks.filter(function (x) { return x.a >= b.from && x.a <= b.to + 1; }).map(function (x) { return { from: x.a, to: x.b, insert: x.rem }; });
    if (ch.length) dispatchTo(path, { changes: ch });
  }
  function deleteBlock(path, key) {
    var b = blockByKey(path, key), st = stateOf(path);
    if (!b || S.locked) return;
    var to = Math.min(st.doc.length, b.to + 1), from = b.from;
    if (to === st.doc.length && from > 0) from--;   // the last block takes the newline before it
    dispatchTo(path, { changes: { from: from, to: to, insert: '' } });
  }
  function addSectionAfter(path, key) {
    var b = blockByKey(path, key), st = stateOf(path);
    if (!b || S.locked) return;
    var at = b.to, ins = '\n\\section{New section}\n';
    if (at === st.doc.length) ins = (st.doc.sliceString(at - 1, at) === '\n' ? '' : '\n') + '\\section{New section}\n';
    dispatchTo(path, { changes: { from: at, insert: ins }, selection: { anchor: at + ins.length } });
    setTimeout(function () {
      var inp = S.root.querySelector('input[data-title-input]:not([data-seen])');
      var all = S.root.querySelectorAll('input[data-title-input]');
      all.forEach(function (x) { if (x.value === 'New section') inp = x; });
      if (inp) { inp.focus(); inp.select(); }
    }, 60);
  }
  function retitle(path, key, title) {
    var b = blockByKey(path, key), st = stateOf(path);
    if (!b) return;
    var line = st.doc.lineAt(b.from), m = line.text.match(/^(\s*\\(?:part|chapter|section|subsection|subsubsection)\*?\s*(?:\[[^\]]*\]\s*)?\{)([^}]*)(\}?)/);
    if (!m) return;
    var t = title.replace(/[{}\\]/g, '');
    var from = line.from + m[1].length, to = from + m[2].length;
    // the block's key follows its title; keep it open under the new one
    var lvl = b.level, o = S.open[path] = S.open[path] || {};
    dispatchTo(path, { changes: { from: from, to: to, insert: t } });
    var nb = analysisOf(path).blocks.find(function (x) { return x.from === b.from; });
    if (nb) { o[nb.key] = true; (S.known[path] = S.known[path] || {})[nb.key] = true; }
    void lvl;
  }
  function focusBlockBody(path, key) {
    var b = blockByKey(path, key), st = stateOf(path);
    if (!b) return;
    var ln = Math.min(b.l0 + 2, st.doc.lines);
    S.view.focus();
    S.view.dispatch({ selection: { anchor: st.doc.line(ln).from }, scrollIntoView: true });
  }

  // ── comments ──

  function texComments(path, an) {
    var out = [];
    S.comments.forEach(function (c, i) {
      var a = c.anchor;
      if (!a || a.in !== 'tex' || a.path !== path) return;
      out.push({ id: c.id, n: i + 1, text: c.text, at: locateTex(an, a) });
    });
    return out;
  }
  /** Where a source comment sits now: its quote nearest its saved line, else the end of its line. */
  function locateTex(an, a) {
    var text = an.text, lines = text.split('\n'), starts = [], acc = 0;
    lines.forEach(function (l) { starts.push(acc); acc += l.length + 1; });
    var li = Math.max(0, Math.min(lines.length - 1, (a.from || 1) - 1)), lt = Math.max(li, Math.min(lines.length - 1, (a.to || a.from || 1) - 1));
    var q = a.quote || '';
    if (q.length > 1) {
      var best = -1, bd = Infinity, p = text.indexOf(q);
      while (p >= 0) { var d = Math.abs(p - starts[li]); if (d < bd) { bd = d; best = p; } p = text.indexOf(q, p + 1); }
      if (best >= 0) return { from: best, to: best + q.length, hl: true };
    }
    return { from: starts[li], to: starts[lt] + lines[lt].length, hl: false };
  }
  function commentHead(c, n) {
    var a = c.anchor;
    if (!a) return 'Whole document';
    if (a.in === 'pdf' && !a.quote) return 'PDF p. ' + a.page + ' · drawn box, sent as an image';
    if (a.in === 'pdf') return 'PDF p. ' + a.page + ' · “' + a.quote.slice(0, 42) + (a.quote.length > 42 ? '…' : '') + '”';
    var an = analysisOf(a.path), line = a.from, sec = '';
    if (an) {
      var at = locateTex(an, a); line = lineAtOffset(an.text, at.from);
      var b = an.blocks.filter(function (x) { return x.from <= at.from; }).pop();
      sec = b ? ' · ' + b.title : '';
    }
    void n;
    return a.path + ' l. ' + line + sec;
  }
  function addComment(anchor, text) {
    return post('/api/drafts/' + S.draft.id + '/comments', { anchor: anchor, text: text }).then(function (c) {
      if (!S) return;
      S.comments.push(c);
      refresh(); paintOverlays(); render();
    }).catch(function (e) { flashError('The comment was not saved: ' + e.message); });
  }
  function editComment(id, text) {
    return post('/api/drafts/' + S.draft.id + '/comments/' + id, { text: text }).then(function (c) {
      if (!S) return;
      S.comments = S.comments.map(function (x) { return x.id === id ? Object.assign({}, x, c) : x; });
      refresh(); paintOverlays(); render();
    }).catch(function (e) { flashError('The comment was not saved: ' + e.message); });
  }
  function deleteComment(id) {
    return post('/api/drafts/' + S.draft.id + '/comments/' + id, { delete: true }).then(function () {
      if (!S) return;
      S.comments = S.comments.filter(function (x) { return x.id !== id; });
      if (S.cmEdit === id) S.cmEdit = null;
      refresh(); paintOverlays(); render();
    }).catch(function (e) { flashError('The comment was not deleted: ' + e.message); });
  }
  function openComposer(c) {
    S.composer = c; S.draftText = ''; S.sel = null; S.hunkPop = null;
    render();
    setTimeout(function () { var t = S && S.root.querySelector('textarea[data-keep="composer"]'); if (t) t.focus(); }, 30);
  }
  function submitComposer() {
    var c = S.composer, t = (S.draftText || '').trim();
    if (!c || !t) return;
    S.composer = null; S.draftText = '';
    var sel = window.getSelection(); if (sel) sel.removeAllRanges();
    addComment(c.anchor, t);
  }
  /** Ctrl/Cmd+Shift+M: the source selection or caret line, a PDF selection, else a general comment. */
  function quickComment() {
    if (S.locked) return;
    var v = S.view;
    if (v && v.hasFocus && S.phone !== true) { texComment(v); return; }
    var sel = window.getSelection();
    if (sel && !sel.isCollapsed && pdfSelInfo()) { pdfComment(); return; }
    openComposer({ anchor: null, label: 'General comment, for the whole document', quote: '' });
  }
  function texComment(v) {
    var r = v.state.selection.main, doc = v.state.doc;
    var l0 = doc.lineAt(r.from).number, l1 = doc.lineAt(Math.max(r.from, r.to - (r.empty ? 0 : 1))).number;
    var raw = r.empty ? '' : doc.sliceString(r.from, r.to);
    var anchor = { in: 'tex', path: S.cur, from: l0, to: l1 };
    if (raw.trim()) anchor.quote = raw.slice(0, 2000);
    var c = v.coordsAtPos(r.to) || v.coordsAtPos(r.from), rb = S.root.getBoundingClientRect();
    openComposer({ anchor: anchor, label: 'Comment on ' + S.cur + ' l. ' + l0, quote: raw ? plain(raw).slice(0, 200) : '',
      x: c ? c.left - rb.left : null, y: c ? c.bottom - rb.top : null });
  }
  function pdfComment() {
    var info = pdfSelInfo();
    if (!info) return;
    openComposer({ anchor: { in: 'pdf', page: info.page, rect: info.rect, quote: info.quote.slice(0, 2000) }, label: 'Comment on PDF p. ' + info.page,
      quote: info.quote.slice(0, 200), x: info.x, y: info.yb });
  }
  function openNote(id) {
    S.notesHidden = false; S.phoneTab = 'notes';
    if (S.notesTab !== 'all' && S.notesTab !== 'comments') S.notesTab = 'all';
    S.noteFlash = id;
    if (!S.locked) { S.cmEdit = id; S.cmText = (S.comments.find(function (c) { return c.id === id; }) || {}).text || ''; }
    applyLayout(); render();
    setTimeout(function () {
      if (!S) return;
      var el = S.root.querySelector('[data-note="' + id + '"]');
      if (el) el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      var t = S.root.querySelector('textarea[data-keep="cm-edit"]');
      if (t) { t.focus(); t.selectionStart = t.selectionEnd = t.value.length; }
    }, 40);
    clearTimeout(S.nfT); S.nfT = setTimeout(function () { if (S) { S.noteFlash = null; render(); } }, 1800);
  }

  // ── the source: selection toolbar, change popover, jumping to lines ──

  function texSelection(view) {
    if (!S || S.locked) return;
    var r = view.state.selection.main;
    if (r.empty || r.to - r.from < 2) { if (S.sel && S.sel.src === 'tex') { S.sel = null; render(); } return; }
    var c = view.coordsAtPos(r.from), rb = S.root.getBoundingClientRect();
    if (!c) return;
    S.sel = { src: 'tex', path: S.cur, from: r.from, to: r.to, x: c.left - rb.left + 40, y: c.top - rb.top };
    S.hunkPop = null;
    render();
  }
  function onTexClick(e, view) {
    if (!S || S.locked) return;
    if (!view.state.selection.main.empty) return;
    var el = e.target.closest ? e.target.closest('[data-hunk]') : null;
    if (!el) { if (S.hunkPop) { S.hunkPop = null; render(); } return; }
    var an = analyse(S.cur, view.state.doc), hk = an.hunks[+el.getAttribute('data-hunk')];
    if (hk) openHunkPop(S.cur, hk.key, el);
  }
  function openHunkPop(path, key, el) {
    if (S.locked) return;
    var r = el.getBoundingClientRect(), rb = S.root.getBoundingClientRect();
    S.hunkPop = { path: path, key: key, x: r.left - rb.left + Math.min(r.width, 200) / 2, y: r.bottom - rb.top + 8 };
    render();
  }
  /** Open the block holding a line range and select it (or the quote inside it), scrolled to the middle of the
   *  source pane; `mark` also tints the lines for a few seconds (Find in tex). Only the pane scrolls: the view is
   *  focused without scrolling, and the grid and the window stay where they are. */
  function revealLines(path, from, to, quote, mark) {
    if (path !== S.cur) switchFile(path);
    var st = S.view.state, doc = st.doc;
    from = Math.max(1, Math.min(doc.lines, from)); to = Math.max(from, Math.min(doc.lines, to || from));
    var an = analyse(path, doc), a = doc.line(from).from, b = doc.line(to).to;
    an.blocks.forEach(function (bk) { if (bk.from <= b && bk.to >= a) (S.open[path] = S.open[path] || {})[bk.key] = true; });
    if (quote) {
      var q = norm(quote).slice(0, 40), seg0 = doc.sliceString(a, b);
      if (q) {
        // find the quote's first words among the lines, as the plain text reads
        var words = q.split(' ').slice(0, 4).join(' '), lines = seg0.split('\n'), acc = a;
        for (var i = 0; i < lines.length; i++) {
          if (norm(lines[i]).indexOf(words) >= 0) { a = acc; b = acc + lines[i].length; break; }
          acc += lines[i].length + 1;
        }
      }
    }
    clearTimeout(S.foundT);
    S.found = mark ? { path: path, from: a, to: b } : null;
    S.view.dispatch({ effects: Refresh.of(null) });
    S.view.focus();
    S.view.dispatch({ selection: { anchor: a, head: b }, effects: CM.EditorView.scrollIntoView(a, { y: 'center' }) });
    if (mark) S.foundT = setTimeout(function () { if (S && S.found) { S.found = null; refresh(); } }, 6000);
    holdStill(); requestAnimationFrame(function () { if (S) holdStill(); });
    render();
  }
  /** Undo any scroll a focus or scrollIntoView gave the window or the frame around the panes: only a pane scrolls. */
  function holdStill() {
    if (window.scrollX || window.scrollY) window.scrollTo(0, 0);
    [S.root, S.el.grid, S.el.src, S.el.cm].forEach(function (x) { if (x && (x.scrollTop || x.scrollLeft)) { x.scrollTop = 0; x.scrollLeft = 0; } });
  }

  // ── saving and compiling ──

  function markingsOut() {
    var out = [];
    S.draft.files.forEach(function (f) {
      var an = analysisOf(f.path);
      if (!an) return;
      var sh = sharedLines(f.path);
      an.hunks.forEach(function (hk) {
        var r = hunkLines(an.text, hk), m = { path: f.path, from: r.from, to: r.to, marking: sentMark(f.path, hk, sh) };
        if (sharedOf(f.path)) m.scope = S.scope[f.path] === 'template' ? 'template' : 'doc';
        out.push(m);
      });
    });
    return out.slice(0, 2000);
  }
  function uiOut() {
    var open = {};
    Object.keys(S.open).forEach(function (p) { var ks = Object.keys(S.open[p]).filter(function (k) { return S.open[p][k]; }); if (ks.length) open[p] = ks; });
    var ui = { v: 2, aTex: +S.aTex.toFixed(3), aNotes: S.aNotes, notesHidden: S.notesHidden, showLatex: S.showLatex, showOriginal: S.showOriginal,
      defMark: S.defMark, zoom: S.zoom, scope: S.scope, open: open, marks: S.marks, cur: S.cur };
    if (JSON.stringify(ui).length > 8000) delete ui.marks;
    if (JSON.stringify(ui).length > 8000) delete ui.open;
    return ui;
  }
  var saveUiT = null;
  function saveUiSoon() {
    clearTimeout(saveUiT);
    saveUiT = setTimeout(function () {
      if (!S || S.locked || S.saving) return;
      post('/api/drafts/' + S.draft.id, { compile: false, ui: uiOut() }).catch(function () { /* the next save carries it */ });
    }, 1200);
  }
  /** Save and compile: the changed files, every hunk's marking, and the UI state; then poll until the compile lands. */
  function save(opts) {
    opts = opts || {};
    if (!S || S.locked) return Promise.resolve();
    if (S.saving) { S.saveAgain = true; return S.saving; }
    var compile = opts.compile !== false, files = {}, texts = allTexts(), v = S.version;
    Object.keys(texts).forEach(function (p) { if (texts[p] !== S.saved[p]) files[p] = texts[p]; });
    var body = { files: files, markings: markingsOut(), compile: compile, ui: uiOut() };
    if (compile) { S.compileT0 = Date.now(); S.compiling = true; startTick(); }
    render();
    S.saving = post('/api/drafts/' + S.draft.id, body).then(function (d) {
      if (!S) return;
      Object.keys(files).forEach(function (p) { S.saved[p] = files[p]; });
      if (S.version === v) S.dirty = false;
      S.saveError = null;
      takeDraft(d);
      if (compile) pollCompile();
    }).catch(function (e) {
      if (!S) return;
      S.compiling = false; S.saveError = 'Not saved: ' + e.message;
    }).then(function () {
      if (!S) return;
      S.saving = null; render();
      if (S.saveAgain) { S.saveAgain = false; save(); }
    });
    return S.saving;
  }
  function startTick() {
    clearInterval(S.tickT);
    S.tickT = setInterval(function () { if (!S) return; if (!S.compiling) { clearInterval(S.tickT); return; } renderStatus(); }, 1000);
  }
  function pollCompile() {
    clearTimeout(S.pollT);
    var tick = function () {
      if (!S) return;
      get('/api/drafts/' + S.draft.id).then(function (d) {
        if (!S) return;
        takeDraft(d, true);
        var c = d.compile || {};
        if (c.status === 'queued' || c.status === 'running' || (c.done_seq || 0) < (c.seq || 0)) S.pollT = setTimeout(tick, 1000);
        else { S.compiling = false; render(); }
      }).catch(function () { if (S) S.pollT = setTimeout(tick, 3000); });
    };
    S.pollT = setTimeout(tick, 800);
  }
  function compileError() {
    var c = S && S.draft && S.draft.compile;
    if (!c || S.compiling) return null;
    if (c.status !== 'error' && c.ok !== false) return null;
    // an error the log gave no line for says what it is, never "at l. 1"
    var e = (c.errors || [])[0];
    return e ? { path: e.path || S.draft.main, line: e.line > 0 ? e.line : null, message: e.message || 'Compile failed' } : { path: S.draft.main, line: null, message: 'Compile failed' };
  }
  function errText(err) { return err.line ? 'Compile failed at l. ' + err.line : 'Compile failed: ' + err.message.replace(/[.\s]+$/, ''); }
  /** The server's view of the draft; files the owner is editing are never overwritten by it. */
  function takeDraft(d, fromPoll) {
    var prevPdf = S.draft && S.draft.pdf, prevState = S.draft && S.draft.state;
    var keepFiles = S.draft.files;
    S.draft = Object.assign({}, d, { files: keepFiles.length ? keepFiles : d.files });
    if (d.comments && !fromPoll) S.comments = d.comments.slice();
    else if (d.comments && d.state !== 'draft') S.comments = d.comments.slice();
    var locked = d.state !== 'draft';
    if (locked !== S.locked) { S.locked = locked; reconfigure(); }
    if (d.state !== prevState) watchPhase();
    var c = d.compile || {};
    if (c.status === 'queued' || c.status === 'running') { if (!S.compiling) { S.compiling = true; S.compileT0 = S.compileT0 || Date.now(); startTick(); } }
    if (d.pdf && !S.filedPdf && (!prevPdf || prevPdf.seq !== d.pdf.seq || !S.pdf)) loadPdf();
    if (!d.pdf && S.pdf && !locked) { /* keep what we show */ }
    refresh(); render();
  }

  // ── sending ──

  function counts() {
    var nH = 0, nSec = 0, allOg = true, tplAny = false, shared = [];
    S.draft.files.forEach(function (f) {
      var an = analysisOf(f.path); if (!an) return;
      var secs = {}, sh = sharedLines(f.path);
      Object.keys(sh).forEach(function (k) { if (shared.indexOf(f.path + ' l. ' + sh[k]) < 0) shared.push(f.path + ' l. ' + sh[k]); });
      an.hunks.forEach(function (hk) {
        nH++;
        var b = an.blocks.filter(function (x) { return x.from <= hk.a; }).pop();
        secs[f.path + (b ? b.key : '')] = 1;
        if (sentMark(f.path, hk, sh) !== 'og') allOg = false;
        if (sharedOf(f.path) && S.scope[f.path] === 'template') tplAny = true;
      });
      nSec += Object.keys(secs).length;
    });
    var nC = S.comments.length;
    var direct = nH > 0 && nC === 0 && allOg && !tplAny;
    // a comment saved since the draft was read makes it a session job, whatever the stale draft.direct says; and
    // both sides must call it direct, so an Adapt edit is never filed because the server read its line as OG
    if (!S.dirty && S.draft.direct !== undefined && nH > 0) direct = direct && !!S.draft.direct;
    return { hunks: nH, secs: nSec, comments: nC, total: nH + nC, direct: direct, tpl: tplAny, shared: shared };
  }
  function docInfo() {
    var d = S.draft, nd = d.new, data = S.opts.data || {};
    var projects = data.projects || [];
    if (nd) {
      var p = projects.find(function (x) { return x.number === nd.project; }) || {};
      var rev = nd.rev || 'A';
      if (d.answered_number) nd = Object.assign({}, nd, { number: d.answered_number });
      return { num: nd.number, full: nd.number + '-' + rev, next: rev, nextFull: nd.number + '-' + rev, title: nd.title || 'Untitled',
        back: '← Library', label: nd.from ? 'new, from ' + nd.from.number : 'new document', session: p.session || null, isNew: true };
    }
    var doc = (data.documents || []).find(function (x) { return x.number === d.number; }) || {};
    var proj = projects.find(function (x) { return x.number === (d.number || '').slice(0, 3); }) || {};
    var next = d.answered_rev || nextRev(d.base_rev), nextFull = d.number + '-' + next;
    // once filed, the header names the new revision, not the closed working copy of the old one
    var filed = d.state === 'answered';
    return { num: d.number, full: filed ? nextFull : d.number + '-' + d.base_rev, next: next, nextFull: nextFull, title: doc.title || '',
      back: '← ' + d.number, label: filed ? (S.listed === nextFull ? 'filed' : 'filed · publishing') : 'working copy', session: proj.session || null, isNew: false, doc: doc };
  }
  function sendLabel(ct, di, short) {
    if (ct.direct) return short ? (di.isNew ? 'File' : 'Update') : di.isNew ? 'File in library' : 'Update in library';
    if (short) return 'Send · ' + ct.total;
    return 'Send to ' + (di.isNew ? (di.session || 'the library’s session') : 'session') + ' · ' + ct.total;
  }
  function openReview() {
    if (S.locked) return;
    var ct = counts();
    if (!ct.total) { flashError('Nothing to send yet: no change and no comment.'); return; }
    S.review = true; S.sel = null; render();
  }
  function send() {
    var ct = counts();
    S.review = false; S.sending = true; render();
    var before = S.dirty || compileError() ? save() : Promise.resolve();
    before.then(function () {
      if (!S) return;
      return post('/api/drafts/' + S.draft.id + '/send', {}).then(function (d) {
        if (!S) return;
        S.sentDirect = ct.direct; S.sentAt = new Date().toISOString();
        takeDraft(d);
      });
    }).catch(function (e) { if (S) flashError('Not sent: ' + e.message); }).then(function () { if (S) { S.sending = false; render(); } });
  }
  function watchPhase() {
    clearTimeout(S.phaseT);
    var st = S.draft.state;
    if (st === 'answered') { watchRegister(); return; }
    if (st !== 'sent' && st !== 'received') return;
    S.phaseT = setTimeout(function () {
      if (!S) return;
      get('/api/drafts/' + S.draft.id).then(function (d) { if (S) takeDraft(d, true); }).catch(function () { /* next time */ })
        .then(function () { if (S) watchPhase(); });
    }, S.phaseMs || (isDirect() ? 4000 : 10000));
  }
  /** Where a sent draft stands, for the bar under the toolbar (seen with the notes hidden and on the phone's Read
   *  tab too). A filing is only "in the library" once the site's register lists it: the box files, the repo is
   *  mirrored and Pages deploys, about a minute, and until then it says so. */
  function phaseView(di) {
    var d = S.draft, st = d.state, direct = isDirect(), listed = S.listed === di.nextFull;
    var publishing = ' The box has filed it; the library shows it once the site republishes, usually within a minute or two. This bar says when.';
    var moved = ' This working copy is closed. ' + (listed ? 'Edit ' + di.next + ' to go on from the new revision.' : 'Once ' + di.next + ' is in the library you can edit it from here.');
    if (st === 'answered') {
      if (direct) return { dot: listed ? 'ed-sage' : 'ed-slate', title: listed ? 'Filed as ' + di.nextFull + ', in the library' : 'Filed as ' + di.nextFull + ', still publishing',
        body: (listed ? 'Your OG text is in the library as ' + di.nextFull + '. Nothing went to a session.' : 'Your OG text was filed as ' + di.nextFull + '. Nothing went to a session.' + publishing) + moved };
      var items = d.items || [], done = items.filter(function (x) { return x.status === 'done'; }).length;
      return { dot: listed ? 'ed-sage' : 'ed-slate', title: 'Answered by ' + di.nextFull + (listed ? ', in the library' : ', still publishing'),
        body: done + ' of ' + items.length + ' items done.' + (listed ? '' : publishing) + moved };
    }
    if (st === 'sent' && direct) {
      return { dot: 'ed-slate', title: 'Filing as ' + di.nextFull, body: 'Sent at ' + hhmm(d.sent || S.sentAt) + '. No session is needed: the box files it, then the site republishes. That takes about a minute; this bar says when it is in the library.' };
    }
    if (st === 'sent') return { dot: 'ed-grey', title: 'Sent at ' + hhmm(d.sent || S.sentAt), body: 'Waiting for the box to hand it to the session; it collects within two minutes. The draft is locked until the session answers.' };
    if (st === 'received') return { dot: 'ed-slate', title: 'Picked up by the session', body: 'It is working on rev ' + di.next + ' now. Each item gets its own answer when the revision is filed.' };
    if (st === 'discarded') return { dot: 'ed-grey', title: 'Discarded', body: 'This draft was thrown away.' };
    return null;
  }
  function isDirect() { return !!(S.sentDirect || (S.draft.package && S.draft.package.direct) || S.draft.direct); }
  /** Once a sent draft is answered: ask the site's register (through /api/library, never from a cache) whether it
   *  lists the new revision yet, every few seconds until it does; then the header, the bar and the PDF move to it. */
  function watchRegister() {
    clearTimeout(S.regT);
    var di = docInfo();
    if (S.draft.state !== 'answered' || S.listed === di.nextFull) return;
    fetch('/api/library', { credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'application/json' } })
      .then(function (r) { return r.ok ? r.json() : null; }).then(function (lib) {
        if (!S || !lib) return;
        var num = S.draft.answered_number || di.num, rev = S.draft.answered_rev || di.next;
        var doc = (lib.documents || []).find(function (x) { return x.number === num; });
        var r = doc && (doc.revisions || []).find(function (x) { return x.rev === rev; });
        if (!r) return;
        S.opts.data = lib;
        S.listed = num + '-' + rev; S.filedPdf = r.file || null;
        if (S.filedPdf) loadPdf();
        render();
      }).catch(function () { /* next time */ }).then(function () {
        if (S && S.listed !== docInfo().nextFull) S.regT = setTimeout(watchRegister, S.regMs || 5000);
      });
  }
  /** A new working copy of the revision this draft was filed as. */
  function editFiled() {
    var di = docInfo(), num = S.draft.answered_number || di.num;
    if (location.hash !== '#/edit/' + num && S.opts.go) { S.opts.go('#/edit/' + num); return; }
    mount(S.host, Object.assign({}, S.opts, { num: num, draftId: null }));
  }
  function itemStatus(ref) {
    if (!S.locked || !ref) return null;
    var st = S.draft.state, it = (S.draft.items || []).find(function (x) { return x.ref === ref; });
    if (st === 'answered' && isDirect()) return { label: 'Filed in rev ' + S.draft.answered_rev, dot: 'ed-sage' };
    if (st === 'sent') return isDirect() ? { label: 'Filing', dot: 'ed-slate' } : { label: 'Sent, waiting for the box', dot: 'ed-grey' };
    if (!it) return null;
    if (it.status === 'done') return { label: 'Done, answered by rev ' + (S.draft.answered_rev || '?'), dot: 'ed-sage', reply: it.reply };
    if (it.status === 'delivered') return { label: 'Picked up by the session', dot: 'ed-slate', reply: it.reply };
    return { label: 'Picked up by the session', dot: 'ed-slate', reply: it.reply };
  }

  // ── the PDF: pdf.js into canvases, a text layer, and an overlay for highlights, pins and boxes ──

  /** The draft's last good compile; once it is filed and listed, the filed revision's PDF instead. */
  function loadPdf() {
    var d = S.draft, filed = S.filedPdf;
    if ((!d.pdf && !filed) || !PDFJS) return;
    var seq = filed ? 'filed' : d.pdf.seq, token = S.pdfToken = {};
    PDFJS.getDocument({ url: filed || d.pdf.url, isEvalSupported: false, withCredentials: true }).promise.then(function (doc) {
      if (!S || S.pdfToken !== token) { doc.destroy(); return; }
      var pages = [];
      var next = function (i) {
        if (i > doc.numPages) return Promise.resolve();
        return doc.getPage(i).then(function (p) { pages.push(p); return next(i + 1); });
      };
      return next(1).then(function () {
        if (!S || S.pdfToken !== token) { doc.destroy(); return; }
        var old = S.pdf;
        S.pdf = { doc: doc, seq: seq, pages: pages.map(function (p, k) { var vp = p.getViewport({ scale: 1 }); return { n: k + 1, page: p, w: vp.width, hPt: vp.height }; }) };
        S.pdfAt = filed ? null : d.pdf.at;
        layoutPdf(true);
        if (old) setTimeout(function () { try { old.doc.destroy(); } catch (e) { /* gone */ } }, 0);
        render();
      });
    }).catch(function (e) {
      if (!S || S.pdfToken !== token) return;
      if (filed) { S.filedPdf = null; return; }   // the working copy's PDF stays; Open shows the filed one
      S.pdfError = 'The PDF did not load: ' + (e && e.message); render();
    });
  }
  function pdfScale() {
    if (!S.pdf || !S.pdf.pages.length) return 1;
    var pane = S.el.pdfScroll, w = pane.clientWidth - (S.phone ? 24 : 48);
    var fit = Math.min(1.6, Math.max(0.35, w / S.pdf.pages[0].w));
    return +(fit * S.zoom).toFixed(3);
  }
  /** Page shells at the current scale; each paints its canvas and text layer when it scrolls near the view. */
  function layoutPdf(fresh) {
    if (!S.pdf) return;
    var scale = pdfScale();
    if (!fresh && S.pdf.scale && Math.abs(S.pdf.scale - scale) < 0.005) return;
    S.pdf.scale = scale;
    var sc = S.el.pdfScroll, ratio = sc.scrollHeight > sc.clientHeight ? sc.scrollTop / (sc.scrollHeight - sc.clientHeight) : 0;
    var box = h('div', { class: 'ed-pages' });
    if (S.io) S.io.disconnect();
    S.io = new IntersectionObserver(function (en) {
      en.forEach(function (x) { if (x.isIntersecting) paintPage(+x.target.getAttribute('data-page')); });
    }, { root: sc, rootMargin: '900px 0px' });
    S.pdf.pages.forEach(function (pg) {
      pg.el = h('div', { class: 'ed-page', 'data-page': String(pg.n) });
      pg.canvas = h('canvas', { class: 'ed-canvas' });
      pg.tl = h('div', { class: 'textLayer' });
      pg.ov = h('div', { class: 'ed-ov' });
      pg.painted = null;
      setPos(pg.el, { width: Math.round(pg.w * scale) + 'px', height: Math.round(pg.hPt * scale) + 'px', '--scale-factor': String(scale) });
      pg.el.appendChild(pg.canvas); pg.el.appendChild(pg.tl); pg.el.appendChild(pg.ov);
      box.appendChild(pg.el);
      S.io.observe(pg.el);
    });
    sc.textContent = '';
    sc.appendChild(box);
    if (ratio) sc.scrollTop = ratio * (sc.scrollHeight - sc.clientHeight);
    paintOverlays();
  }
  function paintPage(n) {
    var pg = S.pdf && S.pdf.pages[n - 1];
    if (!pg || pg.painted === S.pdf.scale) return;
    var scale = S.pdf.scale, dpr = window.devicePixelRatio || 1, vp = pg.page.getViewport({ scale: scale });
    pg.painted = scale;
    pg.canvas.width = Math.floor(vp.width * dpr); pg.canvas.height = Math.floor(vp.height * dpr);
    setPos(pg.canvas, { width: Math.floor(vp.width) + 'px', height: Math.floor(vp.height) + 'px' });
    var ctx = pg.canvas.getContext('2d');
    pg.page.render({ canvasContext: ctx, canvas: pg.canvas, viewport: vp, transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null }).promise.catch(function () { /* superseded */ });
    pg.tl.textContent = '';
    pg.page.getTextContent().then(function (tc) {
      if (!S || pg.painted !== scale) return;
      var tl = new PDFJS.TextLayer({ textContentSource: tc, container: pg.tl, viewport: vp });
      return tl.render().then(function () { pg.textReady = true; paintOverlays(n); });
    }).catch(function () { /* no text */ });
  }
  /** Comment highlights with numbered pins, drawn boxes, the box being drawn and the flash from Show in PDF. */
  function paintOverlays(only) {
    if (!S || !S.pdf || !S.pdf.scale) return;
    var scale = S.pdf.scale;
    S.pdf.pages.forEach(function (pg) {
      if (only && pg.n !== only) return;
      if (!pg.ov) return;
      pg.ov.textContent = '';
      var pinsHere = 0;
      S.comments.forEach(function (c, i) {
        var a = c.anchor;
        if (!a || a.in !== 'pdf' || a.page !== pg.n) return;
        var n = i + 1, r = a.rect || [0, 0, 0, 0];
        var box = function (x0, y0, x1, y1, cls) {
          return setPos(h('div', { class: cls }), { left: (x0 * scale) + 'px', top: (y0 * scale) + 'px', width: Math.max(2, (x1 - x0) * scale) + 'px', height: Math.max(2, (y1 - y0) * scale) + 'px' });
        };
        var pin = function (x, y) {
          var p = setPos(h('button', { type: 'button', class: 'ed-ppin', title: c.text, 'data-pin': c.id }, String(n)), { left: x + 'px', top: y + 'px' });
          p.addEventListener('mousedown', function (e) { e.preventDefault(); e.stopPropagation(); });
          p.addEventListener('click', function (e) { e.stopPropagation(); openNote(c.id); });
          pg.ov.appendChild(p);
        };
        if (!a.quote) {   // a drawn box
          var bx = box(r[0], r[1], r[2], r[3], 'ed-box');
          bx.appendChild(h('span', { class: 'ed-box-n', text: String(n) }));
          pg.ov.appendChild(bx);
          return;
        }
        var rects = pg.textReady ? quoteRects(pg, a.quote) : null;
        if (rects && rects.length) {
          var pr = pg.el.getBoundingClientRect(), last = rects[rects.length - 1];
          rects.forEach(function (q) { pg.ov.appendChild(setPos(h('div', { class: 'ed-phl' }), { left: (q.left - pr.left) + 'px', top: (q.top - pr.top) + 'px', width: q.width + 'px', height: q.height + 'px' })); });
          pin(last.right - pr.left + 2, last.top - pr.top - 4);
        } else if (a.rect) {
          pg.ov.appendChild(box(r[0], r[1], r[2], r[3], 'ed-phl'));
          pin(r[2] * scale + 2, r[1] * scale - 4);
        } else { pin(pg.w * scale - 26, 20 + pinsHere * 26); pinsHere++; }
      });
      var db = S.drawBox;
      if (db && db.page === pg.n) pg.ov.appendChild(setPos(h('div', { class: 'ed-box ed-box-live' }), { left: Math.min(db.x0, db.x1) * scale + 'px', top: Math.min(db.y0, db.y1) * scale + 'px', width: Math.abs(db.x1 - db.x0) * scale + 'px', height: Math.abs(db.y1 - db.y0) * scale + 'px' }));
      var cp = S.composer && S.composer.anchor && S.composer.anchor.in === 'pdf' && !S.composer.anchor.quote && S.composer.anchor.page === pg.n ? S.composer.anchor.rect : null;
      if (cp) pg.ov.appendChild(setPos(h('div', { class: 'ed-box ed-box-live' }), { left: cp[0] * scale + 'px', top: cp[1] * scale + 'px', width: (cp[2] - cp[0]) * scale + 'px', height: (cp[3] - cp[1]) * scale + 'px' }));
      (S.flash || []).forEach(function (f) {
        if (f.page !== pg.n) return;
        pg.ov.appendChild(setPos(h('div', { class: 'ed-flashbox' }), { left: (f.x * scale - 4) + 'px', top: (f.y * scale - 3) + 'px', width: (f.w * scale + 8) + 'px', height: (f.h * scale + 6) + 'px' }));
      });
    });
  }
  /** The client rects of a quote in a page's text layer, matched on letters and digits alone. */
  function quoteRects(pg, quote) {
    var nodes = [], flat = '', map = [];
    var walk = function (n) { if (n.nodeType === 3) nodes.push(n); else n.childNodes.forEach(walk); };
    walk(pg.tl);
    nodes.forEach(function (n, ni) {
      var t = n.nodeValue;
      for (var i = 0; i < t.length; i++) { var ch = t[i].toLowerCase(); if (/[a-z0-9]/.test(ch)) { flat += ch; map.push([ni, i]); } }
    });
    var q = quote.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (q.length < 2) return null;
    var at = flat.indexOf(q);
    if (at < 0) return null;
    var s = map[at], e = map[at + q.length - 1], range = document.createRange();
    range.setStart(nodes[s[0]], s[1]); range.setEnd(nodes[e[0]], e[1] + 1);
    return Array.prototype.filter.call(range.getClientRects(), function (r) { return r.width > 0.5 && r.height > 0.5; });
  }
  /** The PDF selection as a page, a rect in PDF points [x0, y0, x1, y1] and its text. */
  function pdfSelInfo() {
    var sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount || !S.pdf) return null;
    var r = sel.getRangeAt(0), n = r.startContainer.nodeType === 1 ? r.startContainer : r.startContainer.parentElement;
    var pageEl = n && n.closest ? n.closest('.ed-page') : null;
    if (!pageEl || !S.el.pdfScroll.contains(pageEl)) return null;
    var quote = String(sel).replace(/\s+/g, ' ').trim();
    if (quote.length < 2) return null;
    var page = +pageEl.getAttribute('data-page'), pr = pageEl.getBoundingClientRect(), sc = S.pdf.scale;
    var rs = Array.prototype.filter.call(r.getClientRects(), function (x) { return x.width > 0.5 && x.height > 0.5; });
    var b = r.getBoundingClientRect();
    if (rs.length) {
      var l = Infinity, t = Infinity, rr = -Infinity, bb = -Infinity;
      rs.forEach(function (x) { if (x.left >= pr.left - 2 && x.right <= pr.right + 2) { l = Math.min(l, x.left); t = Math.min(t, x.top); rr = Math.max(rr, x.right); bb = Math.max(bb, x.bottom); } });
      if (l !== Infinity) b = { left: l, top: t, right: rr, bottom: bb, width: rr - l, height: bb - t };
    }
    var rect = [(b.left - pr.left) / sc, (b.top - pr.top) / sc, (b.right - pr.left) / sc, (b.bottom - pr.top) / sc].map(function (v) { return Math.round(v * 10) / 10; });
    var rb = S.root.getBoundingClientRect();
    return { page: page, rect: rect, quote: quote, x: b.left - rb.left + b.width / 2, y: b.top - rb.top, yb: b.bottom - rb.top };
  }
  function onPdfUp() {
    if (!S || S.drawMode) return;
    setTimeout(function () {
      if (!S) return;
      var info = pdfSelInfo();
      if (!info) { if (S.sel && S.sel.src === 'pdf') { S.sel = null; render(); } return; }
      S.sel = Object.assign({ src: 'pdf' }, info);
      render();
    }, 10);
  }
  function onPdfDown(e) {
    if (!S.drawMode || S.locked) return;
    var pageEl = e.target.closest ? e.target.closest('.ed-page') : null;
    if (!pageEl) return;
    e.preventDefault();
    var page = +pageEl.getAttribute('data-page'), pg = S.pdf.pages[page - 1], r = pageEl.getBoundingClientRect(), sc = S.pdf.scale;
    var pt = function (ev) { return [Math.max(0, Math.min(pg.w, (ev.clientX - r.left) / sc)), Math.max(0, Math.min(pg.hPt, (ev.clientY - r.top) / sc))]; };
    var p0 = pt(e);
    S.drawBox = { page: page, x0: p0[0], y0: p0[1], x1: p0[0], y1: p0[1] }; S.sel = null; S.composer = null;
    var move = function (ev) { var p = pt(ev); S.drawBox.x1 = p[0]; S.drawBox.y1 = p[1]; paintOverlays(page); };
    var up = function (ev) {
      window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up);
      var d = S && S.drawBox; if (!d) return;
      S.drawBox = null;
      var rect = [Math.min(d.x0, d.x1), Math.min(d.y0, d.y1), Math.max(d.x0, d.x1), Math.max(d.y0, d.y1)].map(function (v) { return Math.round(v); });
      if (rect[2] - rect[0] < 8 || rect[3] - rect[1] < 8) { paintOverlays(page); return; }
      S.drawMode = false;
      var rb = S.root.getBoundingClientRect();
      openComposer({ anchor: { in: 'pdf', page: page, rect: rect }, label: 'Comment on a box, PDF p. ' + page + '. The session gets an image of this area.', quote: '',
        x: ev.clientX - rb.left, y: ev.clientY - rb.top });
      paintOverlays(page);
    };
    window.addEventListener('mousemove', move); window.addEventListener('mouseup', up);
  }
  /** Source to PDF through SyncTeX: scroll to the line's first box and flash it. */
  function showInPdf(path, line) {
    get('/api/drafts/' + S.draft.id + '/synctex?path=' + encodeURIComponent(path) + '&line=' + line).then(function (r) {
      if (!S || !r.boxes || !r.boxes.length || !S.pdf) { flashError('No place in the PDF for that line yet. Save and compile first.'); return; }
      var b = r.boxes[0], pg = S.pdf.pages[b.page - 1];
      S.phoneTab = 'read'; applyLayout();
      S.flash = r.boxes.filter(function (x) { return x.page === b.page; });
      paintOverlays();
      if (pg && pg.el) S.el.pdfScroll.scrollTo({ top: pg.el.offsetTop + b.y * S.pdf.scale - 80, behavior: 'smooth' });
      clearTimeout(S.flashT); S.flashT = setTimeout(function () { if (S) { S.flash = null; paintOverlays(); } }, 2600);
    }).catch(function () { flashError('No place in the PDF for that line yet. Save and compile first.'); });
  }
  /** PDF to source: SyncTeX on the selection, else the quote's words searched in the files. */
  function findInTex() {
    var s = S.sel; if (!s || s.src !== 'pdf') return;
    S.sel = null;
    var sel = window.getSelection(); if (sel) sel.removeAllRanges();
    var r = s.rect;
    get('/api/drafts/' + S.draft.id + '/synctex?page=' + s.page + '&x=' + r[0] + '&y=' + r[1] + '&x1=' + r[2] + '&y1=' + r[3]).then(function (res) {
      if (!S) return;
      if (res && res.path) revealLines(res.path, res.from || res.line, res.to || res.line, s.quote, true);
      else textSearch(s.quote);
    }).catch(function () { if (S) textSearch(s.quote); });
  }
  function textSearch(quote) {
    var q = norm(quote).split(' ').slice(0, 5).join(' ');
    var texts = allTexts(), hit = null;
    Object.keys(texts).some(function (p) {
      if (!/\.tex$/i.test(p)) return false;
      var lines = texts[p].split('\n');
      for (var i = 0; i < lines.length; i++) if (q && norm(lines[i]).indexOf(q) >= 0) { hit = { path: p, line: i + 1 }; return true; }
      return false;
    });
    if (hit) revealLines(hit.path, hit.line, hit.line, quote, true);
    else flashError('That text was not found in the source.');
  }

  // ── phone: fix wording ──

  function startFix() {
    var s = S.sel; if (!s || s.src !== 'pdf') return;
    S.sel = null;
    var sel = window.getSelection(); if (sel) sel.removeAllRanges();
    var r = s.rect;
    var open = function (path, line) {
      var an = analysisOf(path); if (!an) return;
      var b = an.blocks.filter(function (x) { return x.l0 <= line - 1; }).pop() || an.blocks[0];
      S.fix = { path: path, key: b.key, title: b.title, from: b.from, to: b.to, value: an.text.slice(b.from, b.to), orig: an.text.slice(b.from, b.to), mark: S.defMark };
      render();
    };
    get('/api/drafts/' + S.draft.id + '/synctex?page=' + s.page + '&x=' + r[0] + '&y=' + r[1] + '&x1=' + r[2] + '&y1=' + r[3]).then(function (res) {
      if (S && res && res.path) open(res.path, res.from || res.line);
    }).catch(function () {
      if (!S) return;
      var q = norm(s.quote).split(' ').slice(0, 5).join(' '), t = allTexts(), found = null;
      Object.keys(t).some(function (p) { var ls = t[p].split('\n'); for (var i = 0; i < ls.length; i++) if (q && norm(ls[i]).indexOf(q) >= 0) { found = [p, i + 1]; return true; } return false; });
      if (found) open(found[0], found[1]); else flashError('That text was not found in the source.');
    });
  }
  function doneFix() {
    var f = S.fix; if (!f) return;
    S.fix = null;
    if (f.value !== f.orig) {
      var prev = S.defMark;
      S.defMark = f.mark;
      dispatchTo(f.path, { changes: { from: f.from, to: f.to, insert: f.value } });
      S.defMark = prev === f.mark ? prev : f.mark;
      save();
    }
    render();
  }

  // ── layout: the grid, the dividers, the phone ──

  function applyLayout() {
    var el = S.el, w = S.root.clientWidth || 1440;
    var phone = w < 760;
    if (phone !== S.phone) { S.phone = phone; S.root.classList.toggle('ed-phone', phone); }
    var notesPx = S.aNotes || (w < 1200 ? 300 : 340);
    var grid = el.grid;
    if (phone) {
      grid.style.setProperty('grid-template-columns', 'minmax(0, 1fr)');
      el.src.hidden = true; el.pdf.hidden = S.phoneTab !== 'read'; el.notes.hidden = S.phoneTab !== 'notes';
      el.h1.hidden = true; el.h2.hidden = true;
    } else {
      var f = S.aTex;
      grid.style.setProperty('grid-template-columns', 'minmax(0, ' + f.toFixed(3) + 'fr) minmax(0, ' + (1 - f).toFixed(3) + 'fr)' + (S.notesHidden ? '' : ' ' + notesPx + 'px'));
      el.src.hidden = false; el.pdf.hidden = false; el.notes.hidden = !!S.notesHidden;
      var splitW = w - (S.notesHidden ? 0 : notesPx);
      el.h1.hidden = false; el.h2.hidden = !!S.notesHidden;
      setPos(el.h1, { left: Math.round(splitW * f - 4) + 'px' });
      setPos(el.h2, { left: Math.round(w - notesPx - 4) + 'px' });
    }
    if (S.view) S.view.requestMeasure();
  }
  function startDrag(e, which) {
    e.preventDefault();
    var x0 = e.clientX, f0 = S.aTex, w = S.root.clientWidth, n0 = S.aNotes || (w < 1200 ? 300 : 340);
    var splitW = w - (S.notesHidden ? 0 : n0);
    document.body.classList.add('ed-dragging');
    var move = function (ev) {
      var dx = ev.clientX - x0;
      if (which === 'tex') S.aTex = Math.min(0.8, Math.max(0.2, f0 + dx / splitW));
      else S.aNotes = Math.min(560, Math.max(260, n0 - dx));
      applyLayout();
    };
    var up = function () {
      window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up);
      document.body.classList.remove('ed-dragging');
      layoutPdf(); saveUiSoon();
    };
    window.addEventListener('mousemove', move); window.addEventListener('mouseup', up);
  }
  function resetSplit() { S.aTex = 0.5; S.aNotes = null; applyLayout(); layoutPdf(); saveUiSoon(); }

  // ── rendering the chrome (the CodeMirror view and the PDF pages persist between renders) ──

  var renderQueued = false;
  function scheduleRender() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(function () { renderQueued = false; if (S) render(); });
  }
  function flashError(msg) {
    if (!S) return;
    S.toast = msg; render();
    clearTimeout(S.toastT); S.toastT = setTimeout(function () { if (S) { S.toast = null; render(); } }, 5000);
  }
  function statusView() {
    var c = S.draft.compile || {}, err = compileError();
    if (S.compiling) {
      var t = Math.max(0, Math.round((Date.now() - (S.compileT0 || Date.now())) / 1000));
      return { dot: 'ed-slate', label: 'Compiling on the box · ' + t + ' s', short: 'Compiling · ' + t + ' s' };
    }
    if (S.saveError) return { dot: 'ed-accent', label: S.saveError, short: 'Not saved' };
    if (err) return { dot: 'ed-accent', label: errText(err), short: 'Compile failed' };
    if (S.dirty) return { dot: 'ed-ochre', label: 'Unsaved changes', short: 'Unsaved changes' };
    if (S.locked && S.draft.state === 'answered') return { dot: 'ed-sage', label: 'Filed as ' + docInfo().nextFull, short: 'Filed' };
    if (S.locked) return { dot: 'ed-grey', label: 'Locked while the session works on it', short: 'Sent, locked' };
    if (S.draft.pdf) {
      var n = S.pdf ? S.pdf.pages.length : S.draft.pdf.pages;
      return { dot: 'ed-sage', label: 'Compiled ' + hhmm(S.draft.pdf.at || c.at) + (n ? ' · ' + n + ' pp' : ''), short: 'Compiled ' + hhmm(S.draft.pdf.at || c.at) };
    }
    return { dot: 'ed-grey', label: 'Not compiled yet', short: 'Not compiled' };
  }
  function renderStatus() {
    var s = statusView();
    S.root.querySelectorAll('[data-status]').forEach(function (el) {
      el.textContent = '';
      el.appendChild(dot(s.dot));
      el.appendChild(document.createTextNode(el.getAttribute('data-status') === 'short' ? s.short : s.label));
    });
  }
  /** Re-render the chrome, keeping the focus and caret of any field marked data-keep. */
  function render() {
    if (!S || !S.draft) return;
    var ae = document.activeElement, keep = ae && S.root.contains(ae) && ae.getAttribute && ae.getAttribute('data-keep');
    var selA = keep ? ae.selectionStart : 0, selB = keep ? ae.selectionEnd : 0, scrollNotes = S.el.notesList ? S.el.notesList.scrollTop : 0;
    var di = docInfo(), ct = counts();
    renderToolbar(di, ct);
    renderSrcHead();
    renderPdfHead(ct);
    renderNotes(di, ct);
    renderOverlays(di, ct);
    applyLayout();
    if (S.el.notesList) S.el.notesList.scrollTop = scrollNotes;
    if (keep) {
      var n = S.root.querySelector('[data-keep="' + keep + '"]');
      if (n && n !== document.activeElement) { n.focus({ preventScroll: true }); try { n.selectionStart = selA; n.selectionEnd = selB; } catch (e) { /* not a text field */ } }
    }
  }
  function renderToolbar(di, ct) {
    var tb = S.el.tb;
    tb.textContent = '';
    var back = btn(S.phone ? '←' : di.back, exit, 'ed-back', { 'aria-label': 'Back' });
    if (S.phone) {
      tb.appendChild(h('div', { class: 'ed-tb-row' }, back,
        h('div', { class: 'ed-tb-id' }, h('span', { class: 'ed-mono-s' }, di.full, h('span', { class: 'ed-muted', text: S.draft.state === 'answered' ? ' · filed' : di.isNew ? ' · new' : ' · draft' })),
          h('span', { class: 'ed-status ed-status-s', 'data-status': 'short' })),
        !S.locked ? btn(sendLabel(ct, di, true), openReview, 'ed-btn ed-primary ed-sm') : null,
        S.locked && S.listed === di.nextFull ? btn('Open ' + di.next, openFiled, 'ed-btn ed-primary ed-sm') : null));
      tb.appendChild(seg(S.phoneTab, [{ value: 'read', label: 'Read' }, { value: 'notes', label: 'Notes · ' + ct.total }], function (v) { S.phoneTab = v; applyLayout(); render(); layoutPdf(); }, 'ed-seg-wide'));
    } else {
      tb.appendChild(back);
      tb.appendChild(h('div', { class: 'ed-tb-id' }, h('span', { class: 'ed-mono-s', text: di.full }), h('span', { class: 'ed-sc', text: di.label }),
        h('span', { class: 'ed-tb-title', text: di.title })));
      tb.appendChild(h('div', { class: 'ed-status', 'data-status': 'long' }));
      var acts = h('div', { class: 'ed-tb-acts' });
      acts.appendChild(btn(S.notesHidden ? 'Show notes · ' + ct.total : 'Hide notes', function () { S.notesHidden = !S.notesHidden; applyLayout(); layoutPdf(); saveUiSoon(); render(); }, 'ed-btn ed-ghost ed-sm'));
      if (!S.locked) {
        acts.appendChild(btn('Save and compile', function () { save(); }, 'ed-btn ed-sm', { title: '⌘S / Ctrl+S', disabled: S.saving ? true : null }));
        acts.appendChild(btn(sendLabel(ct, di, false), openReview, 'ed-btn ed-primary ed-sm', { 'data-primary': ct.direct ? 'direct' : 'send', disabled: S.sending ? true : null }));
      }
      tb.appendChild(acts);
    }
    renderStatus();
    renderFileBar(di);
  }
  /** The state of a sent draft, under the toolbar on every layout: sent, filing, picked up, answered, published. */
  function renderFileBar(di) {
    var bar = S.el.fileBar, ph = S.locked ? phaseView(di) : null, listed = S.listed === di.nextFull;
    bar.textContent = '';
    bar.hidden = !ph;
    if (!ph) return;
    bar.setAttribute('data-phase', S.draft.state);
    bar.setAttribute('data-listed', listed ? '1' : '0');
    bar.appendChild(h('div', { class: 'ed-col ed-min0 ed-grow' },
      h('span', { class: 'ed-row' }, dot(ph.dot), h('strong', { text: ph.title })), h('span', { class: 'ed-ink70 ed-s', text: ph.body })));
    if (listed) {
      bar.appendChild(h('div', { class: 'ed-row' }, btn('Open ' + di.next, openFiled, 'ed-btn ed-primary ed-sm', { 'data-open': di.nextFull }),
        S.draft.state === 'answered' ? btn('Edit ' + di.next, editFiled, 'ed-btn ed-sm', { 'data-edit-next': di.nextFull }) : null));
    }
  }
  function renderSrcHead() {
    var hd = S.el.srcHead;
    hd.textContent = '';
    var tex = S.draft.files.filter(function (f) { return S.states[f.path] || f.path === S.cur; });
    var others = S.draft.files.length - tex.length;
    if (tex.length > 1) {
      var sel = h('select', { class: 'ed-file', 'aria-label': 'File' }, tex.map(function (f) {
        var o = h('option', { value: f.path, text: f.path }); if (f.path === S.cur) o.selected = true; return o;
      }));
      sel.addEventListener('change', function () { switchFile(sel.value); });
      hd.appendChild(sel);
    } else hd.appendChild(h('span', { class: 'ed-mono-s', text: S.cur }));
    if (others > 0) hd.appendChild(h('span', { class: 'ed-faint', text: '+ ' + others + ' read-only file' + (others === 1 ? '' : 's') }));
    hd.appendChild(h('span', { class: 'ed-grow' }));
    if (!S.locked) {
      hd.appendChild(h('span', { class: 'ed-muted ed-s', text: 'New changes' }));
      hd.appendChild(seg(S.defMark, [{ value: 'og', label: 'OG', on: 'ed-slate-t' }, { value: 'adapt', label: 'Adapt', on: 'ed-ochre-t' }], setDefMark, 'ed-seg-mark'));
    }
    hd.appendChild(btn('Show original', function () { S.showOriginal = !S.showOriginal; S.hunkPop = null; refresh(); saveUiSoon(); render(); }, 'ed-tog' + (S.showOriginal ? ' on' : ''), { 'aria-pressed': S.showOriginal ? 'true' : 'false' }));
    hd.appendChild(btn('Show LaTeX', toggleLatex, 'ed-tog' + (S.showLatex ? ' on' : ''), { 'aria-pressed': S.showLatex ? 'true' : 'false', title: 'Ctrl+Shift+L' }));
    var anyOpen = Object.keys(S.open[S.cur] || {}).some(function (k) { return S.open[S.cur][k]; });
    hd.appendChild(btn(anyOpen ? 'Fold all' : 'Open all', function () {
      var an = analysisOf(S.cur), o = {};
      if (!anyOpen) an.blocks.forEach(function (b) { if (b.level || b.key === 'body') o[b.key] = true; });
      S.open[S.cur] = o; refresh(); saveUiSoon(); render();
    }, 'ed-link'));
  }
  function toggleLatex() {
    S.showLatex = !S.showLatex; S.hunkPop = null;
    reconfigure(); saveUiSoon(); render();
  }
  function renderPdfHead(ct) {
    var hd = S.el.pdfHead, n = S.pdf ? S.pdf.pages.length : 0;
    hd.textContent = '';
    var what = S.pdf && S.pdf.seq === 'filed' ? 'Rev ' + docInfo().next + ', as filed' : S.draft.new ? 'New document' : 'Working copy';
    hd.appendChild(h('span', { class: 'ed-ink70', text: what + (n ? ' · ' + n + ' pp' : '') }));
    if (!S.locked && !S.phone) hd.appendChild(btn(S.drawMode ? 'Drawing · Esc to stop' : 'Draw a box', function () { S.drawMode = !S.drawMode; S.sel = null; render(); }, 'ed-tog' + (S.drawMode ? ' ed-draw-on' : ''), { 'aria-pressed': S.drawMode ? 'true' : 'false', title: 'Draw a box on the page, then comment on it' }));
    hd.appendChild(h('span', { class: 'ed-faint ed-ellip', text: S.phone ? 'OG changes only' : 'Shows your OG changes. Adapt changes go to the session as guidance.' }));
    hd.appendChild(h('span', { class: 'ed-grow' }));
    hd.appendChild(h('span', { class: 'ed-zoom' },
      btn('−', function () { S.zoom = Math.max(0.5, +(S.zoom - 0.1).toFixed(2)); layoutPdf(); saveUiSoon(); render(); }, 'ed-zb', { 'aria-label': 'Zoom out' }),
      h('span', { class: 'ed-zl', text: Math.round((S.pdf && S.pdf.scale ? S.pdf.scale : 1) * 100) + '%' }),
      btn('+', function () { S.zoom = Math.min(2, +(S.zoom + 0.1).toFixed(2)); layoutPdf(); saveUiSoon(); render(); }, 'ed-zb', { 'aria-label': 'Zoom in' })));
    // the banner, the compile bar
    var bn = S.el.pdfBanner, err = compileError();
    bn.textContent = '';
    if (err) {
      bn.appendChild(h('div', { class: 'ed-banner', 'data-compile-error': '1' }, h('span', { text: errText(err) + '.' }),
        h('span', { class: 'ed-ink70', text: S.draft.pdf ? 'Showing the last good PDF, compiled ' + hhmm(S.draft.pdf.at) + '.' : 'There is no good PDF yet.' }),
        err.line ? btn('Go to the line', function () { revealLines(err.path, err.line, err.line); }, 'ed-link ed-accent-t') : null));
    }
    if (S.pdfError) bn.appendChild(h('div', { class: 'ed-banner', text: S.pdfError }));
    if (sourceNearest()) bn.appendChild(h('div', { class: 'ed-note', 'data-nearest': '1', text: 'This source is the nearest one found, not an exact match of the filed PDF.' }));
    if (S.compiling) bn.appendChild(h('div', { class: 'ed-cbar' }, h('div', { class: 'ed-cbar-in' })));
    S.el.pdf.classList.toggle('ed-compiling', !!S.compiling);
    S.el.pdfScroll.classList.toggle('ed-drawing', !!S.drawMode);
    if (!S.draft.pdf && !S.pdf && !S.el.pdfScroll.querySelector('.ed-pages')) {
      S.el.pdfScroll.textContent = '';
      S.el.pdfScroll.appendChild(h('p', { class: 'ed-empty', text: S.locked ? 'The PDF of the filed revision shows here once the library has it.'
        : S.compiling || S.autoCompile ? 'The box is compiling the PDF.' : 'No PDF yet. Save and compile to make one.' }));
    }
  }

  /** Whether the register says the source this draft started from is only the nearest one found for its PDF. */
  function sourceNearest() {
    var d = S.draft, num = d.new && d.new.from ? d.new.from.number : d.number, rev = d.new && d.new.from ? d.new.from.rev : d.base_rev;
    if (d.source_nearest) return true;
    var doc = ((S.opts.data || {}).documents || []).find(function (x) { return x.number === num; });
    var r = doc && (doc.revisions || []).find(function (x) { return x.rev === rev; });
    return !!(r && r.source_nearest);
  }
  function changeItems() {
    var out = [];
    S.draft.files.forEach(function (f) {
      var an = analysisOf(f.path); if (!an) return;
      var sh = sharedLines(f.path);
      an.hunks.forEach(function (hk) {
        var b = an.blocks.filter(function (x) { return x.from <= hk.a; }).pop();
        var ad = plain(hk.add), rm = plain(hk.rem), ghost = an.ghosts.find(function (g) { return g.key === hk.key; });
        out.push({ path: f.path, hk: hk, head: (ghost ? ghost.title + ' · deleted' : b ? b.title : f.path) + (sharedOf(f.path) && S.scope[f.path] === 'template' ? ' · updates the template' : ''),
          text: ad || rm || (/\\sout/.test(hk.add) ? 'Struck through' : 'LaTeX markup only'), struck: !ad, was: ad && rm ? rm : '', mark: markOf(f.path, hk),
          sent: sentMark(f.path, hk, sh) });
      });
    });
    return out;
  }
  function lockedChangeItems() {
    return (S.draft.changes || []).map(function (c) {
      var ad = plain(c.after), rm = plain(c.before);
      return { ref: c.ref, head: c.section || c.path, text: ad || rm || 'LaTeX markup only', struck: !ad, was: ad && rm ? rm : '', mark: c.marking };
    });
  }
  function earlierItems(di) {
    var fb = (di.doc && di.doc.feedback) || [];
    return fb.slice().reverse().map(function (f) {
      var og = f.as ? f.as === 'og' : f.kind === 'text';
      return { key: f.id, head: 'Rev ' + f.rev + ' · ' + (f.section || 'Whole document'), text: f.text, kind: og ? 'OG, his own text' : 'A change to make',
        dot: og ? 'ed-og' : 'ed-grey',
        status: f.status === 'done' ? { label: 'Done, answered by rev ' + f.answered_rev, dot: 'ed-sage' } : f.status === 'delivered' ? { label: 'Sent to the session that made it', dot: 'ed-slate' } : { label: 'Waiting for the box', dot: 'ed-grey' },
        reply: f.reply || '' };
    });
  }
  function markSeg(m, onPick) {
    return seg(m, [{ value: 'og', label: 'OG', on: 'ed-slate-t' }, { value: 'adapt', label: 'Adapt', on: 'ed-ochre-t' }], onPick, 'ed-seg-mark ed-seg-s');
  }
  function renderNotes(di, ct) {
    var el = S.el.notes;
    el.textContent = '';
    var chs = S.locked ? lockedChangeItems() : changeItems(), earlier = earlierItems(di);
    var head = h('div', { class: 'ed-notes-head' },
      h('div', { class: 'ed-row' }, h('span', { class: 'ed-sc ed-sc-l', text: 'Notes for the session' }),
        h('span', { class: 'ed-faint ed-s', text: chs.length + ' changes · ' + S.comments.length + ' comments' })),
      seg(S.notesTab, [{ value: 'all', label: 'All · ' + (chs.length + S.comments.length) }, { value: 'changes', label: 'Changes · ' + chs.length },
        { value: 'comments', label: 'Comments · ' + S.comments.length }, { value: 'earlier', label: 'Earlier · ' + earlier.length }],
      function (v) { S.notesTab = v; render(); }, 'ed-seg-wide ed-seg-4'));
    el.appendChild(head);
    var list = S.el.notesList = h('div', { class: 'ed-notes-list' });
    var tab = S.notesTab, n = 0;
    if (tab === 'all' || tab === 'changes') chs.forEach(function (c) { list.appendChild(changeItem(c)); n++; });
    if (tab === 'all' || tab === 'comments') S.comments.forEach(function (c, i) { list.appendChild(commentItem(c, i + 1)); n++; });
    if (tab === 'earlier') earlier.forEach(function (x) { list.appendChild(earlierItem(x)); n++; });
    if (!n) list.appendChild(h('p', { class: 'ed-empty', text: tab === 'comments' ? 'No comments yet. Select text in the PDF or the source, or press Ctrl+Shift+M.' : 'Nothing here yet.' }));
    el.appendChild(list);
    if (!S.locked) {
      var ta = h('textarea', { class: 'ed-ta', rows: '2', placeholder: 'A general note for the whole document', 'data-keep': 'general', value: S.genText || '' });
      ta.addEventListener('input', function () { S.genText = ta.value; });
      el.appendChild(h('div', { class: 'ed-notes-foot' }, ta,
        h('div', { class: 'ed-row' }, btn('Add general note', function () {
          var t = (S.genText || '').trim(); if (!t) return;
          S.genText = ''; addComment(null, t);
        }, 'ed-btn ed-sm'), S.phone ? null : h('span', { class: 'ed-faint ed-s', text: 'Ctrl+Shift+M comment · Ctrl+Shift+L show LaTeX · Ctrl+Z / Ctrl+Y undo, redo' }))));
    }
  }
  function statusLine(st) {
    if (!st) return null;
    return [h('span', { class: 'ed-item-st' }, dot(st.dot), st.label), st.reply ? h('span', { class: 'ed-item-reply', text: st.reply }) : null];
  }
  function changeItem(c) {
    var key = c.hk ? c.path + '#' + c.hk.key : c.ref;
    var go = c.hk ? function () {
      var an = analysisOf(c.path), l = lineAtOffset(an.text, c.hk.a);
      revealLines(c.path, l, lineAtOffset(an.text, Math.max(c.hk.a, c.hk.b - 1)));
    } : null;
    return h('div', { class: 'ed-item', 'data-note': key, 'data-kind': 'change', 'data-mark': c.mark },
      h('div', { class: 'ed-item-top' }, dot('ed-' + c.mark), btn(c.head, go || function () {}, 'ed-item-head'), h('span', { class: 'ed-grow' }),
        c.hk && !S.locked ? markSeg(c.mark, function (v) { setMark(c.path, c.hk.key, v); }) : h('span', { class: 'ed-tag ed-' + c.mark, text: c.mark === 'og' ? 'OG' : 'Adapt' }),
        c.hk && !S.locked ? btn('×', function () { revertHunk(c.path, c.hk.key); }, 'ed-x', { title: 'Remove this change', 'aria-label': 'Remove this change' }) : null),
      h('span', { class: 'ed-item-text' + (c.struck ? ' ed-struck' : ''), text: c.text }),
      c.was ? h('span', { class: 'ed-item-kind', text: 'Was: ' + c.was.slice(0, 100) }) : null,
      c.sent && c.sent !== c.mark ? h('span', { class: 'ed-item-kind ed-ochre-t', text: 'Goes as Adapt: it shares its line with an Adapt edit.' }) : null,
      statusLine(itemStatus(c.ref)));
  }
  function commentItem(c, n) {
    var editing = S.cmEdit === c.id && !S.locked;
    var a = c.anchor;
    var go = function () {
      if (!a) return;
      if (a.in === 'tex') { var an = analysisOf(a.path); if (!an) return; var at = locateTex(an, a); revealLines(a.path, lineAtOffset(an.text, at.from), lineAtOffset(an.text, at.to)); }
      else if (S.pdf && S.pdf.pages[a.page - 1]) { S.phoneTab = 'read'; applyLayout(); S.el.pdfScroll.scrollTo({ top: S.pdf.pages[a.page - 1].el.offsetTop + (a.rect ? a.rect[1] * S.pdf.scale : 0) - 80, behavior: 'smooth' }); }
    };
    var body;
    if (editing) {
      var ta = h('textarea', { class: 'ed-ta ed-ta-strong', rows: '3', 'data-keep': 'cm-edit', value: S.cmText || '' });
      ta.addEventListener('input', function () { S.cmText = ta.value; });
      var saveIt = function () { var t = (S.cmText || '').trim(); S.cmEdit = null; if (!t) deleteComment(c.id); else if (t !== c.text) editComment(c.id, t); else render(); };
      ta.addEventListener('keydown', function (e) {
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); S.cmEdit = null; render(); }
        else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); saveIt(); }
      });
      body = h('div', { class: 'ed-col' }, ta, h('div', { class: 'ed-row' }, btn('Save', saveIt, 'ed-btn ed-sm'),
        btn('Cancel', function () { S.cmEdit = null; render(); }, 'ed-btn ed-ghost ed-sm'), h('span', { class: 'ed-grow' }),
        btn('Delete comment', function () { deleteComment(c.id); }, 'ed-link ed-accent-t')));
    } else {
      body = h('span', { class: 'ed-item-text' + (S.locked ? '' : ' ed-editable'), text: c.text, title: S.locked ? '' : 'Click to edit' });
      if (!S.locked) body.addEventListener('click', function () { S.cmEdit = c.id; S.cmText = c.text; render(); setTimeout(function () { var t = S && S.root.querySelector('textarea[data-keep="cm-edit"]'); if (t) { t.focus(); t.selectionStart = t.selectionEnd = t.value.length; } }, 20); });
    }
    return h('div', { class: 'ed-item' + (S.noteFlash === c.id ? ' ed-noteflash' : ''), 'data-note': c.id, 'data-kind': 'comment' },
      h('div', { class: 'ed-item-top' }, h('span', { class: 'ed-num' + (a ? '' : ' ed-num-gen'), text: String(n) }),
        btn(commentHead(c, n), go, 'ed-item-head'), h('span', { class: 'ed-grow' }),
        !S.locked ? btn('×', function () { deleteComment(c.id); }, 'ed-x', { title: 'Delete comment', 'aria-label': 'Delete comment' }) : null),
      body, statusLine(itemStatus(c.ref)));
  }
  function earlierItem(x) {
    return h('div', { class: 'ed-item', 'data-note': x.key, 'data-kind': 'earlier' },
      h('div', { class: 'ed-item-top' }, dot(x.dot), h('span', { class: 'ed-item-head', text: x.head })),
      h('span', { class: 'ed-item-text', text: x.text }), h('span', { class: 'ed-item-kind', text: x.kind }), statusLine(x.status));
  }

  function place(el, x, y, w) {
    var rw = S.root.clientWidth, half = (w || 320) / 2;
    return setPos(el, { left: Math.max(half + 8, Math.min(rw - half - 8, x)) + 'px', top: y + 'px' });
  }
  function renderOverlays(di, ct) {
    var ov = S.el.ov;
    ov.textContent = '';
    if (S.toast) ov.appendChild(h('div', { class: 'ed-toast', role: 'status', text: S.toast }));
    // the change popover
    if (S.hunkPop && !S.locked) {
      var hp = S.hunkPop, an = analysisOf(hp.path), hk = an && an.hunks.find(function (x) { return x.key === hp.key; });
      if (hk) {
        var m = markOf(hp.path, hk);
        var pop = h('div', { class: 'ed-hunkpop' }, markSeg(m, function (v) { setMark(hp.path, hp.key, v); }),
          h('span', { class: 'ed-muted', text: m === 'og' ? 'OG · my words, kept as written' : 'Adapt · guidance, the session rewrites from it' }),
          btn('Undo change', function () { revertHunk(hp.path, hp.key); }, 'ed-link'));
        pop.addEventListener('mousedown', function (e) { if (e.target.tagName !== 'BUTTON') e.preventDefault(); });
        ov.appendChild(place(pop, hp.x, hp.y, 360));
      } else S.hunkPop = null;
    }
    // the selection toolbar
    if (S.sel && !S.locked) {
      var s = S.sel, bar = h('div', { class: 'ed-selbar' });
      var b = function (label, fn) { var x = btn(label, fn, 'ed-selbtn'); x.addEventListener('mousedown', function (e) { e.preventDefault(); }); return x; };
      if (s.src === 'tex') {
        bar.appendChild(b('Show in PDF', function () { var l = S.view.state.doc.lineAt(s.from).number; S.sel = null; render(); showInPdf(s.path, l); }));
        bar.appendChild(b('Comment', function () { S.sel = null; texComment(S.view); }));
      } else {
        if (!S.phone) bar.appendChild(b('Find in tex', findInTex));
        bar.appendChild(b('Comment', function () { var keep = S.sel; S.sel = null; openComposer({ anchor: { in: 'pdf', page: keep.page, rect: keep.rect, quote: keep.quote.slice(0, 2000) }, label: 'Comment on PDF p. ' + keep.page, quote: keep.quote.slice(0, 200), x: keep.x, y: keep.yb }); }));
        if (S.phone) bar.appendChild(b('Fix wording', startFix));
      }
      ov.appendChild(place(bar, s.x, Math.max(4, s.y - 46), 240));
    }
    // the comment composer
    if (S.composer) {
      var c = S.composer, ta = h('textarea', { class: 'ed-ta ed-ta-strong', rows: '3', placeholder: 'What should be different here', 'data-keep': 'composer', value: S.draftText || '' });
      ta.addEventListener('input', function () { S.draftText = ta.value; });
      ta.addEventListener('keydown', function (e) {
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); S.composer = null; paintOverlays(); render(); }
        else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submitComposer(); }
      });
      var comp = h('div', { class: 'ed-composer' + (S.phone ? ' ed-sheet' : '') }, h('span', { class: 'ed-muted ed-s', text: c.label }),
        c.quote ? h('span', { class: 'ed-quote', text: '“' + c.quote + '”' }) : null, ta,
        h('div', { class: 'ed-row' }, btn('Add comment', submitComposer, 'ed-btn ed-sm'), btn('Cancel', function () { S.composer = null; paintOverlays(); render(); }, 'ed-btn ed-ghost ed-sm')));
      if (S.phone) ov.appendChild(comp);
      else ov.appendChild(place(comp, c.x != null ? c.x : S.root.clientWidth * 0.45, Math.min((c.y != null ? c.y : 340) + 10, S.root.clientHeight - 230), 320));
    }
    // phone: fix wording
    if (S.fix) {
      var f = S.fix, fta = h('textarea', { class: 'ed-ta ed-mono-ta', rows: '9', spellcheck: 'false', 'data-keep': 'fix', value: f.value });
      fta.addEventListener('input', function () { f.value = fta.value; });
      ov.appendChild(h('div', { class: 'ed-scrim ed-scrim-end' }, h('div', { class: 'ed-sheet ed-fix' },
        h('div', { class: 'ed-row' }, h('strong', { text: 'Fix wording' }), h('span', { class: 'ed-muted ed-s', text: f.title })), fta,
        h('div', { class: 'ed-col' }, h('span', { class: 'ed-ink70 ed-s', text: 'This change is' }),
          seg(f.mark, [{ value: 'og', label: 'OG, my words', on: 'ed-slate-t' }, { value: 'adapt', label: 'Adapt, guidance', on: 'ed-ochre-t' }], function (v) { f.mark = v; render(); }, 'ed-seg-wide'),
          h('span', { class: 'ed-muted ed-s', text: f.mark === 'og' ? 'Kept as you wrote it, only escaped for LaTeX.' : 'Read as guidance. The session writes the final text from it.' })),
        h('div', { class: 'ed-row' }, btn('Save and compile', doneFix, 'ed-btn ed-primary'), btn('Cancel', function () { S.fix = null; render(); }, 'ed-btn ed-ghost')))));
    }
    if (S.review) ov.appendChild(reviewSheet(di, ct));
  }
  function reviewSheet(di, ct) {
    var rv;
    if (ct.direct) {
      rv = di.isNew ? { title: 'File in the library', intro: 'Everything is OG and there are no comments, so no session is needed. The library files this as ' + di.nextFull + ', compiled as you see it.', confirm: 'File as ' + di.nextFull }
        : { title: 'Update in the library', intro: 'Every change is OG and there are no comments, so nothing goes to the session. The library files this working copy as ' + di.nextFull + ', compiled as you see it.', confirm: 'File as rev ' + di.next };
    } else if (di.isNew) {
      var who = di.session ? 'the ' + di.session + ' session' : 'the library’s session';
      rv = { title: 'Send to ' + who, intro: who.charAt(0).toUpperCase() + who.slice(1) + ' on the box writes the Adapt parts from your notes, keeps your OG text as written, and files the result as ' + di.nextFull + '. It answers each item here.', confirm: 'Send ' + ct.total + ' items' };
    } else {
      rv = { title: 'Send to the session', intro: 'These go to the session that filed ' + di.num + ', through its Slack thread. The box collects them within two minutes. The session files a new revision and answers each item.', confirm: 'Send ' + ct.total + ' items' };
    }
    var cms = S.comments, nPdf = cms.filter(function (c) { return c.anchor && c.anchor.in === 'pdf'; }).length, nTex = cms.filter(function (c) { return c.anchor && c.anchor.in === 'tex'; }).length;
    var tplFiles = S.draft.files.filter(function (f) { return sharedOf(f.path) && S.scope[f.path] === 'template' && (analysisOf(f.path) || { hunks: [] }).hunks.length; });
    var err = compileError();
    var items = changeItems().map(function (x) { return { tag: x.sent === 'og' ? 'OG' : 'Adapt', cls: 'ed-' + x.sent, head: x.head + (x.sent !== x.mark ? ' · shares its line with an Adapt edit' : ''), text: x.text, mono: true }; })
      .concat(cms.map(function (c, i) { return { tag: 'Comment ' + (i + 1), cls: 'ed-muted', head: commentHead(c, i + 1), text: c.text }; }));
    var box = h('div', { class: 'ed-review', role: 'dialog', 'aria-modal': 'true', 'aria-label': rv.title },
      h('div', { class: 'ed-col' }, h('span', { class: 'ed-review-title', text: rv.title }), h('span', { class: 'ed-ink70', text: rv.intro }),
        tplFiles.length ? h('span', { class: 'ed-plum-t', text: 'Template: ' + tplFiles.map(function (f) { return f.path; }).join(', ') + ' changes too. The session updates the template and carries it to ' + tplFiles.map(function (f) { return usedBy(sharedOf(f.path)); }).join(' and ') + ', filing each as a new revision.' }) : null),
      h('div', { class: 'ed-review-grid' },
        h('span', { class: 'ed-sc', text: 'Source' }), h('span', { text: S.draft.main + (di.isNew ? ', a new document' : ', the working copy of rev ' + S.draft.base_rev) }),
        h('span', { class: 'ed-sc', text: 'Diff' }), h('span', { text: ct.hunks + ' changes ' + (di.isNew ? '' : 'against rev ' + S.draft.base_rev + ', ') + 'in ' + ct.secs + ' sections' }),
        h('span', { class: 'ed-sc', text: 'Comments' }), h('span', { text: ct.comments + ': ' + nPdf + ' on the PDF, ' + nTex + ' on the source, ' + (ct.comments - nPdf - nTex) + ' general' }),
        h('span', { class: 'ed-sc', text: 'PDF' }), h('span', { text: S.draft.pdf ? 'The last good compile, ' + hhmm(S.draft.pdf.at) + (S.pdf ? ', ' + S.pdf.pages.length + ' pp' : '') : 'Not compiled yet' })),
      S.dirty || err ? h('div', { class: 'ed-callout' }, h('span', { class: 'ed-sc', text: 'Note' }),
        h('span', { text: err ? 'The last compile failed. The session gets the source as it stands, with the error.' : 'You have unsaved changes. They are saved and compiled before sending.' })) : null,
      ct.shared.length ? h('div', { class: 'ed-callout', 'data-shared-lines': ct.shared.join(', ') }, h('span', { class: 'ed-sc', text: 'OG and Adapt on one line' }),
        h('span', { text: ct.shared.join(', ') + (ct.shared.length === 1 ? ' holds' : ' hold') + ' an OG edit and an Adapt edit. The library files a line whole, so ' +
          (ct.shared.length === 1 ? 'that line goes' : 'those lines go') + ' to the session as Adapt and nothing on ' + (ct.shared.length === 1 ? 'it' : 'them') + ' is filed as written.' })) : null,
      h('div', { class: 'ed-review-items' }, items.map(function (it) {
        return h('div', { class: 'ed-review-item' }, h('span', { class: 'ed-sc ' + it.cls, text: it.tag }),
          h('div', { class: 'ed-col ed-min0' }, h('span', { class: 'ed-ink70 ed-s', text: it.head }), h('span', { class: 'ed-review-text' + (it.mono ? ' ed-mono-s' : ''), text: it.text })));
      })),
      h('div', { class: 'ed-row' }, btn(rv.confirm, send, 'ed-btn ed-primary', { 'data-confirm': '1' }), btn('Keep editing', function () { S.review = false; render(); }, 'ed-btn ed-ghost')));
    var scrim = h('div', { class: 'ed-scrim' + (S.phone ? ' ed-scrim-end' : '') }, box);
    scrim.addEventListener('mousedown', function (e) { if (e.target === scrim) { S.review = false; render(); } });
    return scrim;
  }
  function exit() {
    if (S.opts.onExit) S.opts.onExit();
    else if (S.opts.go) S.opts.go(S.draft.new ? '#/' : '#/d/' + S.draft.number);
  }
  function openFiled() {
    var di = docInfo();
    if (S.opts.go) S.opts.go('#/d/' + di.nextFull);
  }

  // ── keyboard ──

  function onKey(e) {
    if (!S) return;
    var mod = e.ctrlKey || e.metaKey, k = (e.key || '').toLowerCase(), ae = document.activeElement;
    var inField = ae && (ae.tagName === 'TEXTAREA' || ae.tagName === 'INPUT' || ae.tagName === 'SELECT');
    if (mod && !e.shiftKey && k === 's') { e.preventDefault(); save(); return; }
    if (mod && e.shiftKey && k === 'm') { e.preventDefault(); quickComment(); return; }
    if (mod && e.shiftKey && k === 'l') { e.preventDefault(); toggleLatex(); return; }
    if (mod && (k === 'z' || k === 'y')) {
      if (inField) return;   // native undo inside a text field
      e.preventDefault();
      if (k === 'y' || e.shiftKey) redo(); else undo();
      return;
    }
    if (e.key === 'Escape') {
      var any = S.drawMode || S.hunkPop || S.sel || S.composer || S.review || S.fix;
      if (!any) return;
      S.drawMode = false; S.drawBox = null; S.hunkPop = null; S.sel = null; S.composer = null; S.review = false; S.fix = null;
      paintOverlays(); render();
    }
  }
  function onBeforeUnload(e) { if (S && S.dirty && !S.locked) { e.preventDefault(); e.returnValue = ''; } }

  // ── mount ──

  var vendor = null;
  function loadVendor() {
    if (!vendor) {
      vendor = Promise.all([import('/vendor/codemirror.mjs'), import('/vendor/pdf.min.mjs')]).then(function (m) {
        CM = m[0]; PDFJS = m[1];
        PDFJS.GlobalWorkerOptions.workerSrc = '/vendor/pdf.worker.min.mjs';
        Restoring = CM.Annotation.define();
        setupCM();
      });
      vendor.catch(function () { vendor = null; });
    }
    return vendor;
  }
  function openDraft(opts) {
    if (opts.draftId) return get('/api/drafts/' + encodeURIComponent(opts.draftId));
    return post('/api/documents/' + encodeURIComponent(opts.num) + '/drafts', {});
  }
  function build(root) {
    var el = {};
    el.tb = h('header', { class: 'ed-tb' });
    el.fileBar = h('div', { class: 'ed-phase ed-filebar', role: 'status', hidden: true });
    el.srcHead = h('div', { class: 'ed-pane-head' });
    el.cm = h('div', { class: 'ed-cm' });
    el.src = h('section', { class: 'ed-src', 'aria-label': 'Source' }, el.srcHead, el.cm);
    el.pdfHead = h('div', { class: 'ed-pane-head ed-pdf-head' });
    el.pdfBanner = h('div', { class: 'ed-pdf-banner' });
    el.pdfScroll = h('div', { class: 'ed-pdf-scroll' });
    el.pdf = h('section', { class: 'ed-pdf', 'aria-label': 'PDF' }, el.pdfHead, el.pdfBanner, el.pdfScroll);
    el.notes = h('aside', { class: 'ed-notes', 'aria-label': 'Notes for the session' });
    el.h1 = h('div', { class: 'ed-handle', title: 'Drag to resize · double-click to reset' });
    el.h2 = h('div', { class: 'ed-handle', title: 'Drag to resize · double-click to reset' });
    el.grid = h('div', { class: 'ed-grid' }, el.src, el.pdf, el.notes, el.h1, el.h2);
    el.ov = h('div', { class: 'ed-ovl' });
    root.appendChild(el.tb); root.appendChild(el.fileBar); root.appendChild(el.grid); root.appendChild(el.ov);
    el.h1.addEventListener('mousedown', function (e) { startDrag(e, 'tex'); });
    el.h2.addEventListener('mousedown', function (e) { startDrag(e, 'notes'); });
    el.h1.addEventListener('dblclick', resetSplit); el.h2.addEventListener('dblclick', resetSplit);
    el.pdfScroll.addEventListener('mouseup', onPdfUp);
    el.pdfScroll.addEventListener('touchend', onPdfUp);
    el.pdfScroll.addEventListener('mousedown', onPdfDown);
    return el;
  }

  function mount(host, opts) {
    unmount();
    opts = opts || {};
    var root = h('div', { class: 'ed-root' });
    host.textContent = '';
    host.appendChild(root);
    document.body.classList.add('editing');
    var st = S = {
      host: host, root: root, opts: opts, el: null, draft: null, view: null, states: {}, cur: null, an: {}, base: {}, baseLines: {}, saved: {},
      marks: {}, scope: {}, open: {}, known: {}, knownInit: {}, comments: [], defMark: 'adapt', showLatex: false, showOriginal: false,
      notesHidden: false, aTex: 0.5, aNotes: null, notesTab: 'all', phoneTab: 'read', zoom: 1, undo: [], redo: [], version: 0, dirty: false,
      locked: false, compiling: false, phone: false
    };
    root.appendChild(h('p', { class: 'ed-loading', text: 'Opening the draft…' }));
    var attempt = function () {
      Promise.all([loadVendor(), openDraft(opts)]).then(function (r) {
        if (S !== st) return;
        start(r[1]);
      }).catch(fail);
    };
    var fail = function (e) {
      if (S !== st) return;
      // 409: the revision's source is not on the site. It is published after the PDF, so it may be on its way:
      // wait for it, trying again every few seconds, and say nothing is wrong
      if (e && e.status === 409 && !opts.draftId) {
        if (!st.waiting) {
          st.waiting = true;
          root.textContent = '';
          root.appendChild(h('div', { class: 'ed-loading', 'data-waiting-source': '1' },
            h('p', { text: 'Waiting for this revision’s source to reach the library. The editor opens by itself as soon as it is there.' }),
            btn('Back', function () { if (opts.onExit) opts.onExit(); else if (opts.go) opts.go(opts.num ? '#/d/' + opts.num : '#/'); }, 'ed-btn ed-ghost ed-sm')));
        }
        st.openT = setTimeout(attempt, opts.retryMs || 5000);
        return;
      }
      root.textContent = '';
      root.appendChild(h('div', { class: 'ed-fail' }, h('p', { text: e && e.status === 409 ? 'This revision kept no LaTeX source, so it cannot be edited here.' : 'The editor did not open: ' + (e && e.message) }),
        btn('Back', function () { if (opts.onExit) opts.onExit(); else if (opts.go) opts.go(opts.num ? '#/d/' + opts.num : '#/'); }, 'ed-btn')));
    };
    attempt();
    return { unmount: unmount };
  }
  function start(d) {
    var root = S.root;
    root.textContent = '';
    S.el = build(root);
    S.draft = d;
    S.comments = (d.comments || []).slice();
    S.locked = d.state !== 'draft';
    var ui = d.ui && typeof d.ui === 'object' ? d.ui : {};
    S.defMark = ui.defMark || d.default_marking || 'adapt';
    // the notes start folded away; a layout saved since (v 2) keeps what he chose
    S.showLatex = !!ui.showLatex; S.showOriginal = !!ui.showOriginal; S.notesHidden = ui.v >= 2 ? !!ui.notesHidden : true;
    if (typeof ui.aTex === 'number') S.aTex = Math.min(0.8, Math.max(0.2, ui.aTex));
    if (typeof ui.aNotes === 'number') S.aNotes = Math.min(560, Math.max(260, ui.aNotes));
    if (typeof ui.zoom === 'number') S.zoom = Math.min(2, Math.max(0.5, ui.zoom));
    S.scope = ui.scope || {};
    (d.markings || []).forEach(function (m) { if (m.scope) S.scope[m.path] = m.scope; });
    if (ui.marks) S.marks = ui.marks;
    S.loadMarkings = d.markings || [];
    if (ui.open) Object.keys(ui.open).forEach(function (p) { S.open[p] = {}; ui.open[p].forEach(function (k) { S.open[p][k] = true; }); });
    // the base of each file: the text less its changes (the draft carries the edited text and the line hunks)
    d.files.forEach(function (f) {
      S.saved[f.path] = f.text;
      S.base[f.path] = f.base !== undefined && f.base !== null ? f.base : baseOf(f, d.changes || []);
    });
    var texFiles = d.files.filter(function (f) { return editable(f.path); });
    texFiles.forEach(function (f) { S.states[f.path] = makeState(f.path, f.text); });
    S.cur = ui.cur && S.states[ui.cur] ? ui.cur : S.states[d.main] ? d.main : (texFiles[0] || {}).path;
    if (!S.cur) { root.appendChild(h('p', { class: 'ed-fail', text: 'This draft has no text files.' })); return; }
    S.view = new CM.EditorView({ state: S.states[S.cur], parent: S.el.cm });
    delete S.states[S.cur];
    S.draft.files.forEach(function (f) { var stt = stateOf(f.path); if (stt) analyse(f.path, stt.doc); });
    S.loadMarkings = null;
    // the main file opens on its document body, the preamble folded
    if (S.states[d.main] || S.cur === d.main) { var mo = S.open[d.main] = S.open[d.main] || {}; mo.body = true; mo.pre = false; }
    // a new document opens with its first section open
    if (d.new) {
      var an = analysisOf(S.cur);
      an.blocks.forEach(function (b) { if (b.level > 0 || an.blocks.length === 1) (S.open[S.cur] = S.open[S.cur] || {})[b.key] = true; });
    }
    refresh();
    S.ro = new ResizeObserver(function () { if (!S) return; applyLayout(); clearTimeout(S.roT); S.roT = setTimeout(function () { if (S) { layoutPdf(); render(); } }, 150); });
    S.ro.observe(root);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('beforeunload', onBeforeUnload);
    applyLayout();
    render();
    if (d.pdf) loadPdf();
    var c = d.compile || {};
    if (c.status === 'queued' || c.status === 'running') { S.compiling = true; S.compileT0 = Date.now(); startTick(); pollCompile(); }
    else if (!S.locked && (!d.pdf || (c.done_seq || 0) < (c.seq || 0))) compileOnLoad();
    watchPhase();
    root.setAttribute('data-ready', '1');
  }
  /** Opening a draft with no PDF (or an older one than its source) compiles it, so the PDF shows without a save.
   *  A request that fails is tried again, quietly. */
  function compileOnLoad() {
    S.autoCompile = true; S.compiling = true; S.compileT0 = Date.now(); startTick();
    post('/api/drafts/' + S.draft.id, { compile: true }).then(function (d) {
      if (!S) return;
      S.autoCompile = false; takeDraft(d, true); pollCompile();
    }).catch(function () {
      if (!S || S.locked) return;
      S.compiling = false; render();
      clearTimeout(S.pollT); S.pollT = setTimeout(function () { if (S && !S.draft.pdf) compileOnLoad(); }, 5000);
    });
  }
  /** The base revision's text, rebuilt from the edited text and the server's line hunks. */
  function baseOf(f, changes) {
    var mine = changes.filter(function (c) { return c.path === f.path; });
    if (!mine.length) return f.text;
    var nl = /\n$/.test(f.text), lines = f.text.replace(/\n$/, '').split('\n');
    if (f.text === '') lines = [];
    mine.slice().sort(function (a, b) { return b.from - a.from; }).forEach(function (c) {
      var n = c.to >= c.from ? c.to - c.from + 1 : 0, at = c.to >= c.from ? c.from - 1 : c.from - 1;
      var before = c.base_to >= c.base_from ? String(c.before).split('\n') : [];
      lines.splice.apply(lines, [Math.max(0, at), n].concat(before));
    });
    return lines.length ? lines.join('\n') + (nl ? '\n' : '') : '';
  }
  function unmount() {
    if (!S) return;
    var st = S;
    if (st.dirty && !st.locked && st.draft && st.view) {
      try {
        var files = {}, texts = allTexts();
        Object.keys(texts).forEach(function (p) { if (texts[p] !== st.saved[p]) files[p] = texts[p]; });
        post('/api/drafts/' + st.draft.id, { files: files, markings: markingsOut(), compile: false, ui: uiOut() }).catch(function () { /* best effort */ });
      } catch (e) { /* best effort */ }
    }
    S = null;
    clearTimeout(st.pollT); clearTimeout(st.phaseT); clearTimeout(st.regT); clearTimeout(st.foundT); clearTimeout(st.openT); clearInterval(st.tickT); clearTimeout(st.flashT); clearTimeout(st.toastT); clearTimeout(st.roT); clearTimeout(saveUiT);
    if (st.ro) st.ro.disconnect();
    if (st.io) st.io.disconnect();
    if (st.view) st.view.destroy();
    if (st.pdf) { try { st.pdf.doc.destroy(); } catch (e) { /* gone */ } }
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('beforeunload', onBeforeUnload);
    document.body.classList.remove('editing');
    document.body.classList.remove('ed-dragging');
    if (st.root && st.root.parentNode) st.root.parentNode.removeChild(st.root);
  }

  window.LibraryEditor = {
    mount: mount, unmount: unmount,
    // for tests and the console: the pure pieces
    _t: { wordDiff: wordDiff, blocksOf: blocksOf, plain: plain, baseOf: baseOf, nextRev: nextRev, state: function () { return S; }, cm: function () { return CM; } }
  };
})();
