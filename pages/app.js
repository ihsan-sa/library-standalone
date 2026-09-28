/* library-export/pages/app.js — the register's front end. Plain JS, no framework, no build step.
   Data: GET /api/library. Writes (POST JSON): /api/documents/{PPP-NNNN}/star {starred}, and the owner's own:
   links (/api/links {target, kind, name?, people?, groups?} makes one, blank name auto-named; /api/links/{id}
   {name?, target?, kind?, state?, people?, groups?} renames, repoints, switches, disables, archives or restores it),
   packages (/api/packages {name}; /api/packages/{id} {name?, settings?, archived?}, settings {number, rev, date, note,
   collapsed}; .../documents {number, add, rev, folder, desc_mode, description}; .../folders {name, parent} and
   .../folders/{fid} {name?, parent?, delete?}), groups (/api/groups {name}; /api/groups/{gid} {name?, add?, remove?,
   grant?, revoke?, delete?}) and a document's one-line description (/api/documents/{PPP-NNNN}/description
   {description}), and the owner's feedback on a revision (/api/documents/{PPP-NNNN}/feedback {rev, section, kind,
   text}; documents[].feedback lists it, and revisions[].source is where he downloads a revision's kept source).
   Editing: GET /api/documents/{PPP-NNNN}/drafts lists a document's drafts; POST /api/drafts {project, title,
   from?: {number, rev}} makes a new document's draft; #/edit/<PPP-NNNN> and #/edit/draft/<id> hand the page to
   window.LibraryEditor (editor.js). Locks: {locked} sent alone to a package, link or group; while it holds, any
   other write to that item is 409, and its controls are frozen here too. Requests: /api/requests {kind: section |
   folder, name, parent?, note?} asks the box, in the library channel, for a new project or a sub-project; the site
   makes nothing, and his open ones come back as requests[]. A write's answer may carry access {sync, manual}: emails Cloudflare Access still
   needs by hand. lib/library.js scopes everything to the viewer; a non-owner's answer carries no people, links,
   groups or access at all. */
(function () {
  'use strict';

  // ---- Theme: follow the system, or a stored override ('light' | 'dark') ----
  var THEME_KEY = 'library-theme';
  var darkQuery = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  function applyTheme() {
    var stored = null;
    try { stored = localStorage.getItem(THEME_KEY); } catch (e) { /* storage blocked */ }
    var dark = stored ? stored === 'dark' : !!(darkQuery && darkQuery.matches);
    if (dark) document.documentElement.setAttribute('data-theme', 'dark');
    else document.documentElement.removeAttribute('data-theme');
  }
  applyTheme();
  if (darkQuery) {
    if (darkQuery.addEventListener) darkQuery.addEventListener('change', applyTheme);
    else if (darkQuery.addListener) darkQuery.addListener(applyTheme);
  }

  // ---- Remembered choices: a key in localStorage, for this browser only ----
  function stored(key, fallback) {
    try { var v = localStorage.getItem(key); return v == null ? fallback : v; } catch (e) { return fallback; }
  }
  function store(key, v) { try { localStorage.setItem(key, v); } catch (e) { /* for this visit only */ } }

  var state = {
    data: null, loadError: null,
    route: { name: 'home' }, q: '', sort: 'number',
    narrow: false,        // the page is under 760px wide: the phone layout
    copied: null,         // the text last copied, for a second
    confirmDel: null,     // what an Archive / Delete is being confirmed for: 'link:<id>', 'pkg:<id>', 'grp:<id>', …
    dlg: null,            // the open dialog: { type: 'share', … } or { type: 'new', … }
    editing: null,        // the one inline editor open: 'pkg:<id>', 'grp:<id>', 'desc:<N>', 'move:<link>', 'folder:…'
    linkOpen: null,       // the link whose editor is open
    unlockAsk: null,      // the locked item asking "Unlock this …?": 'pkg:<id>', 'link:<id>' or 'grp:<id>'
    reqForm: null,        // the request form open: 'section' or 'folder:<PPP>'
    reqSent: null,        // the request just sent, from that form: its confirmation shows there
    docTab: stored('library-doctab', 'revisions'),
    shTab: stored('library-shtab', 'links'),
    draftsOf: {},         // number -> { loading } | { list } | { error }: that document's drafts, for the Edits tab
    accessShown: false,   // a write answered with emails Access still needs: say so on this page
    accessFromWrite: null, // that answer's access {sync, manual, error?}
    full: false,          // the document viewer fills the screen, its controls kept
    pending: {},          // "star:001-0001" / "link:<id>" while a POST is in flight
    error: null           // { key, text } — caption-sized, shown next to the control that failed
  };
  var drafts = {};        // what was typed into an inline input, so a re-render doesn't lose it
  var copiedTimer = null;
  var keepY = null;       // a change of revision's scroll position, put back when the new PDF's viewer has loaded
  var main, input, dlgRoot, navEl;
  var drag = null;        // { kind: 'doc' | 'folder', id, pkg } while a package row is dragged

  // ---- Small DOM helper ----
  function h(tag, attrs) {
    var el = document.createElement(tag);
    if (attrs) {
      for (var k in attrs) {
        var v = attrs[k];
        if (v == null || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k === 'text') el.textContent = v;
        else if (k.slice(0, 2) === 'on') el.addEventListener(k.slice(2), v);
        else el.setAttribute(k, v === true ? '' : v);
      }
    }
    for (var i = 2; i < arguments.length; i++) add(el, arguments[i]);
    return el;
  }
  function add(el, c) {
    if (c == null || c === false) return;
    if (Array.isArray(c)) { c.forEach(function (x) { add(el, x); }); return; }
    el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  // CSS custom properties set through the CSSOM: the CSP allows these, and forbids style="" attributes
  function vars(el, o) { for (var k in o) el.style.setProperty(k, String(o[k])); return el; }
  // A text input whose value lives in drafts[id] until it is sent; data-k lets a re-render give it back its focus.
  function draft(id, attrs) {
    var a = { class: 'input', type: 'text', autocomplete: 'off', 'data-k': id };
    for (var k in attrs || {}) a[k] = attrs[k];
    var init = a.value; delete a.value;
    var el = h('input', a);
    el.value = drafts[id] != null ? drafts[id] : (init || '');
    el.addEventListener('input', function () { drafts[id] = el.value; });
    return el;
  }
  function focusSoon(el) {
    setTimeout(function () { if (document.activeElement !== el && el.isConnected && !el.disabled) el.focus(); }, 0);
  }
  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : (many || one + 's')); }
  var SVG = 'http://www.w3.org/2000/svg';
  // the stroke icons of the design, on a 16-unit box: a file with a plus, two files, and the lock's padlock
  var ICONS = {
    newdoc: ['M9 1.5H4a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V5.5z', 'M9 1.5v4h4', 'M8 8.5v4M6 10.5h4'],
    dup: ['M6.5 4h5l2 2v7.5a1 1 0 0 1-1 1h-6a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z', 'M3.5 11.5V2.5a1 1 0 0 1 1-1h5'],
    lock: ['M4.2 7h7.6a1.2 1.2 0 0 1 1.2 1.2v5.1a1.2 1.2 0 0 1-1.2 1.2H4.2A1.2 1.2 0 0 1 3 13.3V8.2A1.2 1.2 0 0 1 4.2 7z',
      'M5.5 7V4.8a2.5 2.5 0 0 1 5 0V7']
  };
  function icon(name, px, sw) {
    var s = document.createElementNS(SVG, 'svg');
    [['width', px || '16'], ['height', px || '16'], ['viewBox', '0 0 16 16'], ['fill', 'none'], ['stroke', 'currentColor'],
      ['stroke-width', sw || '1.4'], ['stroke-linecap', 'round'], ['stroke-linejoin', 'round'], ['aria-hidden', 'true']]
      .forEach(function (a) { s.setAttribute(a[0], a[1]); });
    ICONS[name].forEach(function (d) { var p = document.createElementNS(SVG, 'path'); p.setAttribute('d', d); s.appendChild(p); });
    return s;
  }

  // ---- Data helpers ----
  function last(d) { return d.revisions[d.revisions.length - 1]; }
  function lastDate(d) { return last(d).date; }
  function docByNum(num) { return state.data.documents.find(function (d) { return d.number === num; }); }
  function projByNum(num) { return state.data.projects.find(function (p) { return p.number === num; }); }
  function isOwner() { return state.data && state.data.viewer && state.data.viewer.role === 'owner'; }
  function person(id) { return (state.data.people && state.data.people[id]) || id; }
  function publicRevs(d) {
    if (!isOwner()) return [];
    return d.revisions.filter(function (r) { return r.public; }).map(function (r) { return r.rev; });
  }
  function byNumber(a, b) { return a.number.localeCompare(b.number); }
  function byDateDesc(a, b) { return lastDate(b).localeCompare(lastDate(a)) || a.number.localeCompare(b.number); }
  function byName(a, b) { return a.name.localeCompare(b.name); }
  function size(bytes) {
    if (bytes == null) return null;
    return bytes >= 1e6 ? (bytes / 1e6).toFixed(1) + ' MB' : Math.round(bytes / 1e3) + ' KB';
  }
  function usd(n) { return '$' + Number(n).toFixed(2); }
  function when(at) { return at ? String(at).slice(0, 16).replace('T', ' ') : ''; }
  // A document's name when signed in: "105-0009-A tdc proposal". The download is saved under it plus .pdf, the
  // server sends the same in its header, and the file URL ends in it so a browser's PDF tab shows it too.
  function docName(d, r) {
    return (d.number + '-' + r.rev + ' ' + d.title).replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_').replace(/\s+/g, ' ');
  }
  function saveName(d, r) { return docName(d, r) + '.pdf'; }
  function fileUrl(d, r) { return '/files/' + d.number + '-' + r.rev + '/' + encodeURIComponent(docName(d, r)) + '.pdf'; }
  function revOf(d, rev) { return (rev && d.revisions.find(function (x) { return x.rev === rev; })) || last(d); }

  // Projects as a tree: a project's parent is its `parent` (PPP) when the server gives one, else the project its
  // group name names. A sub-project sits indented under its parent.
  function parentNum(p) {
    if (p.parent && projByNum(p.parent) && p.parent !== p.number) return p.parent;
    if (!p.group) return null;
    var q = state.data.projects.find(function (x) { return x.name === p.group && x.number !== p.number; });
    return q ? q.number : null;
  }
  function kidsOf(num) {
    return state.data.projects.filter(function (x) { return x.number !== num && parentNum(x) === num; }).sort(byNumber);
  }
  function docsOf(num) { return state.data.documents.filter(function (d) { return d.project === num; }); }
  function deepDocs(num) {
    return kidsOf(num).reduce(function (a, k) { return a.concat(docsOf(k.number)); }, docsOf(num));
  }
  // The next free number in a project: the server's projects[].next, else one past the highest filed there.
  function nextNumber(pnum) {
    var p = projByNum(pnum);
    if (p && p.next && /^\d{3}-\d{4}$/.test(p.next)) return p.next;
    var top = 0;
    state.data.documents.forEach(function (d) { if (d.project === pnum) top = Math.max(top, +d.number.slice(4)); });
    return pnum + '-' + String(top + 1).padStart(4, '0');
  }

  // The owner's sharing data. Every list is the server's; a write reloads it rather than patching a copy.
  function packages() { return state.data.packages || []; }
  function livePackages() { return packages().filter(function (pk) { return !pk.archived; }); }
  function pkgById(id) { return packages().find(function (pk) { return pk.id === id; }) || null; }
  function allLinks() { return state.data.links || []; }
  function groups() { return state.data.groups || []; }
  function groupById(id) { return groups().find(function (g) { return g.id === id; }) || null; }
  function directory() { return state.data.directory || []; }
  function nameOf(email) {
    var p = directory().find(function (x) { return x.email === email; });
    return (p && p.name) || email;
  }
  function kindOf(l) { return l.kind || 'public'; }
  function stateOf(l) { return l.state || 'live'; }
  // live links first, then disabled, then archived; newest first within each
  var STATE_ORDER = { live: 0, disabled: 1, archived: 2 };
  function linkOrder(a, b) {
    return STATE_ORDER[stateOf(a)] - STATE_ORDER[stateOf(b)] || String(b.created || '').localeCompare(String(a.created || ''));
  }
  function linksTo(pred) { return allLinks().filter(function (l) { return l.target && pred(l.target); }).sort(linkOrder); }
  function docLinks(num) { return linksTo(function (t) { return t.number === num; }); }
  function pkgLinks(id) { return linksTo(function (t) { return t.package === id; }); }
  function pkgEntry(pk, num) { return (pk.documents || []).find(function (x) { return x.number === num; }) || null; }
  function accessManual() {
    var a = state.data.access;
    return a && Array.isArray(a.manual) ? a.manual : [];
  }

  // What a person box was given: a pick from its list or "Name <email>", a bare email, or a known person's name.
  function parsePerson(v) {
    v = (v || '').trim();
    var m = /^(.*?)\s*<\s*([^<>\s]+@[^<>\s]+)\s*>$/.exec(v);
    if (m) return { email: m[2].toLowerCase(), name: m[1].trim() || null };
    if (/^[^<>\s@]+@[^<>\s@]+\.[^<>\s@]+$/.test(v)) return { email: v.toLowerCase(), name: null };
    var p = directory().find(function (x) { return x.name && x.name.toLowerCase() === v.toLowerCase(); });
    return p ? { email: p.email, name: null } : null;
  }

  // ---- Sections that open and shut, remembered per section across reloads ----
  var OPEN_KEY = 'library-open';
  var openMap = null;
  function opened() {
    if (!openMap) {
      try { openMap = JSON.parse(localStorage.getItem(OPEN_KEY) || '{}'); } catch (e) { openMap = {}; }
      if (!openMap || typeof openMap !== 'object' || Array.isArray(openMap)) openMap = {};
    }
    return openMap;
  }
  function isOpen(key) { return !!opened()[key]; }
  function setOpen(key, on) {
    var m = opened();
    if (on) m[key] = 1; else delete m[key];
    store(OPEN_KEY, JSON.stringify(m));
  }
  function toggleOpen(key) { setOpen(key, !isOpen(key)); render(); }

  // ---- Routing ----
  function parseHash() {
    var hsh = location.hash.replace(/^#/, '') || '/';
    var m;
    if (hsh === '/' || hsh === '') return { name: 'home' };
    if ((m = hsh.match(/^\/p\/(\d{3})$/))) return { name: 'project', num: m[1] };
    if ((m = hsh.match(/^\/d\/(\d{3}-\d{4})(?:-([A-Z]{1,2}))?$/))) return { name: 'doc', num: m[1], rev: m[2] || null };
    if ((m = hsh.match(/^\/edit\/(\d{3}-\d{4})$/))) return { name: 'edit', num: m[1] };
    if ((m = hsh.match(/^\/edit\/draft\/([A-Za-z0-9_-]{1,64})$/))) return { name: 'edit', draft: m[1] };
    if ((m = hsh.match(/^\/k(?:\/([A-Za-z0-9_-]{1,64}))?$/))) return { name: 'packages', pkg: m[1] || null };
    if (hsh === '/sharing' || hsh === '/people') return { name: 'sharing' };
    if ((m = hsh.match(/^\/s(?:\?(.*))?$/))) {
      var q = '';
      (m[1] || '').split('&').forEach(function (kv) {
        var p = kv.split('=');
        if (p[0] === 'q') { try { q = decodeURIComponent((p[1] || '').replace(/\+/g, ' ')); } catch (e) { q = p[1] || ''; } }
      });
      return q.trim() ? { name: 'search', q: q } : { name: 'home' };
    }
    return { name: 'missing' };
  }
  function hashFor(route) {
    if (route.name === 'project') return '#/p/' + route.num;
    if (route.name === 'doc') return '#/d/' + route.num + (route.rev ? '-' + route.rev : '');
    if (route.name === 'search') return '#/s?q=' + encodeURIComponent(route.q);
    if (route.name === 'packages') return '#/k' + (route.pkg ? '/' + route.pkg : '');
    if (route.name === 'sharing') return '#/sharing';
    if (route.name === 'edit') return route.draft ? '#/edit/draft/' + route.draft : '#/edit/' + route.num;
    return '#/';
  }
  function go(route) {
    var target = hashFor(route);
    if (location.hash === target || (target === '#/' && !location.hash)) onRoute();
    else location.hash = target;
  }
  function docRoute(d, rev) {
    return { name: 'doc', num: d.number, rev: rev && rev !== last(d).rev ? rev : null };
  }
  function editKey(rt) { return rt && rt.name === 'edit' ? (rt.draft ? 'draft:' + rt.draft : 'num:' + rt.num) : null; }
  function onRoute() {
    var prev = state.route;
    state.route = parseHash();
    waiting = null;       // a new wait for each visit to an address still publishing
    if (editKey(prev) !== editKey(state.route)) unmountEditor();
    // a change of revision on the same document keeps the page where it is: scroll, open editors, typed text
    var sameDoc = state.route.name === 'doc' && prev.name === 'doc' && prev.num === state.route.num;
    state.copied = null;
    state.confirmDel = null;
    state.unlockAsk = null;
    state.reqForm = null;
    state.reqSent = null;
    state.error = null;
    state.accessShown = false;
    if (!sameDoc) {
      state.dlg = null;
      state.editing = null;
      state.linkOpen = null;
      drafts = {};
      state.full = false;   // full screen outlives a change of revision, not a move to another page
      if (state.route.name === 'doc') delete state.draftsOf[state.route.num];
    }
    if (copiedTimer) { clearTimeout(copiedTimer); copiedTimer = null; }
    if (state.route.name === 'search') {
      state.q = state.route.q;
      if (input.value !== state.q) input.value = state.q;
    } else if (state.route.name === 'home') {
      state.q = '';
      input.value = '';
    }
    var y = window.scrollY;
    keepY = sameDoc ? y : null;
    render();
    if (sameDoc) window.scrollTo(0, y);
    else if (!(prev.name === 'search' && state.route.name === 'search')) window.scrollTo(0, 0);
    syncFull();
  }

  // Typing drives the route: the first keystroke pushes Search, later ones replace it, so Back leaves search.
  function onQueryInput() {
    var v = input.value;
    state.q = v;
    if (!v.trim()) {
      if (state.route.name === 'search') { history.replaceState(null, '', '#/'); onRoute(); }
      return;
    }
    var target = hashFor({ name: 'search', q: v });
    if (state.route.name === 'search') {
      history.replaceState(null, '', target);
      state.route = { name: 'search', q: v };
      render();
    } else {
      location.hash = target;
    }
  }
  function onQueryKey(e) {
    if (e.key === 'Escape') {
      input.value = '';
      state.q = '';
      if (state.route.name === 'search') history.replaceState(null, '', '#/');
      go({ name: 'home' });
    } else if (e.key === 'Enter' && state.data && state.q.trim()) {
      var res = search(state.q);
      if (res.length === 1) go(docRoute(res[0].d, res[0].rev));
    }
  }

  // ---- API ----
  // A refusal carries the server's short text (a 409 says what is locked) as err.text.
  function post(path, body) {
    return fetch(path, {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify(body)
    }).then(function (res) {
      if (res.ok) return res.json();
      var err = new Error('HTTP ' + res.status);
      err.status = res.status;
      return res.text().catch(function () { return ''; }).then(function (t) { err.text = String(t || '').trim(); throw err; });
    });
  }
  function getJson(path) {
    // no-store: every answer is the deployment's register as it is now, never one the browser kept
    return fetch(path, { credentials: 'same-origin', cache: 'no-store', headers: { 'Accept': 'application/json' } }).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    });
  }

  function toggleStar(d) {
    var key = 'star:' + d.number;
    if (state.pending[key]) return;
    var was = d.starred;
    d.starred = !was;
    state.pending[key] = true;
    if (state.error && state.error.key === key) state.error = null;
    render();
    post('/api/documents/' + d.number + '/star', { starred: d.starred }).then(function (res) {
      if (res && typeof res.starred === 'boolean') d.starred = res.starred;
    }).catch(function () {
      d.starred = was;
      state.error = { key: key, text: was ? 'Couldn’t remove the star. Try again.' : 'Couldn’t star it. Try again.' };
    }).then(function () {
      delete state.pending[key];
      render();
    });
  }

  // One owner write: mark it pending under key, post, note what it says about Access, then reload the register so
  // every list shows what the server now holds; or say what failed next to the control.
  function noteAccess(res) {
    if (res && res.access && typeof res.access === 'object') {
      state.accessFromWrite = res.access;
      state.accessShown = true;
    }
  }
  function mutate(key, path, body, failText, onOk) {
    if (state.pending[key]) return;
    state.pending[key] = true;
    state.confirmDel = null;
    if (state.error && state.error.key === key) state.error = null;
    render();
    post(path, body).then(function (res) {
      noteAccess(res);
      if (onOk) onOk(res);
      return load(true);
    }).catch(function (e) {
      state.error = { key: key, text: lockedText(e) || failText };
    }).then(function () {
      delete state.pending[key];
      render();
    });
  }
  // A 409 on a locked item, in the server's words as a sentence ("This package is locked; unlock it …."); else null.
  function lockedText(e) {
    var t = e && e.status === 409 && e.text && /locked/i.test(e.text) ? e.text.slice(0, 200) : '';
    return t ? t.charAt(0).toUpperCase() + t.slice(1).replace(/[.\s]*$/, '.') : null;
  }

  // Full screen: a thin bar of the document's controls, and the PDF fills the rest of the window.
  function syncFull() {
    var on = state.full && state.route.name === 'doc';
    document.body.classList.toggle('fs', on);
  }
  function setFull(on) {
    state.full = on;
    render();
    syncFull();
  }

  function copyUrl(url) {
    function done() {
      state.copied = url;
      render();
      if (copiedTimer) clearTimeout(copiedTimer);
      copiedTimer = setTimeout(function () { state.copied = null; copiedTimer = null; render(); }, 1500);
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(done, function () { fallbackCopy(url); done(); });
    } else { fallbackCopy(url); done(); }
  }
  function fallbackCopy(text) {
    var ta = h('textarea', { readonly: true, 'aria-hidden': 'true', class: 'offscreen' });
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch (e) { /* nothing more to try */ }
    document.body.removeChild(ta);
  }

  // ---- Search: every hit says why it matched ----
  var NUM_LIKE = /^\d{1,3}(-\d{0,4}(-[A-Z]{0,2})?)?$/;
  function search(q) {
    var data = state.data;
    var s = q.trim().toUpperCase();
    if (!s) return [];
    var out = [];
    if (NUM_LIKE.test(s)) {
      data.documents.forEach(function (d) {
        var hit = d.revisions.slice().reverse().find(function (r) { return (d.number + '-' + r.rev).indexOf(s) === 0; });
        if (hit) out.push({ d: d, rev: hit.rev, why: hit.rev !== last(d).rev ? 'Earlier revision ' + hit.rev : 'Number' });
      });
      return out;
    }
    var words = s.toLowerCase().split(/\s+/).filter(Boolean);
    function hasAll(text) { text = text.toLowerCase(); return words.every(function (w) { return text.indexOf(w) >= 0; }); }
    data.documents.forEach(function (d) {
      var p = projByNum(d.project);
      var head = (d.title + ' ' + (p ? p.name : '') + ' ' + d.number + ' ' + (d.description || '')).toLowerCase();
      var notes = d.revisions.map(function (r) { return r.note || ''; }).join(' ').toLowerCase();
      if (!words.every(function (w) { return head.indexOf(w) >= 0 || notes.indexOf(w) >= 0; })) return;
      var why;
      var noteWords = words.filter(function (w) { return head.indexOf(w) < 0; });
      if (noteWords.length) {
        // some word is only in a note: show the newest note that has it
        var nr = d.revisions.slice().reverse().find(function (r) {
          return r.note && noteWords.some(function (w) { return r.note.toLowerCase().indexOf(w) >= 0; });
        });
        why = nr ? 'Rev ' + nr.rev + ' note: ' + nr.note : 'A revision note';
      } else if (hasAll(d.title)) why = 'Title';
      else if (d.description && words.some(function (w) { return d.description.toLowerCase().indexOf(w) >= 0; })) why = 'Description: ' + d.description;
      else why = 'Project ' + (p ? p.number + ' ' + p.name : d.project);
      out.push({ d: d, rev: last(d).rev, why: why });
    });
    return out;
  }

  // ---- Shared pieces ----
  function activate(el, fn) {
    el.addEventListener('click', fn);
    el.addEventListener('keydown', function (e) {
      if (e.target !== el) return;
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') { e.preventDefault(); fn(e); }
    });
    return el;
  }
  function rowEl(cls, children, fn) {
    return activate(h('div', { class: 'row ' + cls, role: 'button', tabindex: '0' }, children), fn);
  }
  function starBtn(d) {
    return h('button', {
      type: 'button', class: 'star' + (d.starred ? ' on' : ''),
      'aria-label': d.starred ? 'Unstar' : 'Star', 'aria-pressed': d.starred ? 'true' : 'false',
      text: d.starred ? '★' : '☆',
      onclick: function (e) { e.stopPropagation(); toggleStar(d); },
      onkeydown: function (e) { e.stopPropagation(); }
    });
  }
  function errFor(key) {
    return state.error && state.error.key === key ? h('span', { class: 'err', role: 'status', text: state.error.text }) : null;
  }
  function label(text, extra) { return h('h2', { class: 'label' + (extra ? ' ' + extra : ''), text: text }); }
  function btn(text, onclick, opts) {
    opts = opts || {};
    return h('button', { type: opts.submit ? 'submit' : 'button', class: 'btn btn-sm' + (opts.cls ? ' ' + opts.cls : ''),
      text: text, disabled: !!opts.disabled, 'aria-label': opts.label || null, title: opts.title || null, onclick: onclick || null });
  }
  function textBtn(text, onclick, opts) {
    opts = opts || {};
    return h('button', { type: 'button', class: 'linkbtn' + (opts.cls ? ' ' + opts.cls : ''), text: text,
      disabled: !!opts.disabled, 'aria-label': opts.label || null, onclick: onclick });
  }
  function copyBtn(text, cls) {
    return btn(state.copied === text ? 'Copied' : 'Copy', function () { copyUrl(text); }, { cls: cls || 'btn-ghost' });
  }
  function escClose(el, fn) {
    el.addEventListener('keydown', function (e) { if (e.key === 'Escape') { e.stopPropagation(); fn(); render(); } });
    return el;
  }
  function dot(tone) { return h('span', { class: 'dot dot-' + tone, 'aria-hidden': 'true' }); }
  function caret(open) { return h('span', { class: 'caret', 'aria-hidden': 'true', text: open ? '▾' : '▸' }); }

  // A SegmentedControl: one of a few, as tabs.
  function seg(options, value, onPick, cls, disabled) {
    var el = h('div', { class: 'seg' + (cls ? ' ' + cls : ''), role: 'tablist' }, options.map(function (o) {
      var on = o.value === value;
      return h('button', {
        type: 'button', role: 'tab', 'aria-selected': on ? 'true' : 'false', disabled: !!disabled,
        text: o.label, onclick: function () { if (!on) onPick(o.value); }
      });
    }));
    return vars(el, { '--n': options.length });
  }

  // A revision picker: the empty value (rev null) follows new revisions, a letter pins that one.
  function revSelect(d, rev, lbl, onPick, disabled, nullLabel) {
    return h('select', { class: 'input sel', 'aria-label': lbl, disabled: !!disabled,
      onchange: function (e) { onPick(e.target.value || null); } },
      h('option', { value: '', selected: !rev, text: nullLabel || 'Follow newest' }),
      d.revisions.slice().reverse().map(function (x) {
        return h('option', { value: x.rev, selected: x.rev === rev, text: 'Rev ' + x.rev });
      }));
  }

  // A header that opens and shuts what sits under it.
  function foldHead(text, extra, open, cls, fn) {
    return activate(h('div', { class: 'fold ' + cls, role: 'button', tabindex: '0', 'aria-expanded': open ? 'true' : 'false' },
      caret(open),
      h('span', { class: 'fold-name', text: text }),
      extra ? h('span', { class: 'fold-count', text: extra }) : null), fn);
  }
  // A section that can grow: its header says how many, it opens on click, and stays as the owner left it.
  // openByDefault turns the remembered key into a "closed" mark.
  function foldSection(key, title, count, body, opts) {
    opts = opts || {};
    var open = opts.openByDefault ? !isOpen(key) : isOpen(key);
    var extra = typeof count === 'number' ? '(' + count + ')' : count;
    return h('section', { class: 'foldsec' + (opts.cls ? ' ' + opts.cls : '') },
      h('div', { class: 'foldbar' }, foldHead(title, extra, open, 'sechead', function () { toggleOpen(key); }), opts.side || null),
      open ? h('div', { class: 'foldbody' }, typeof body === 'function' ? body() : body) : null);
  }
  function chip(text, title, onRemove, disabled) {
    return h('span', { class: 'chip', title: title || null }, h('span', { text: text }),
      onRemove ? h('button', { type: 'button', class: 'chip-x', text: '×', 'aria-label': 'Remove ' + text,
        disabled: !!disabled, onclick: onRemove }) : null);
  }
  // A box that takes a known person from its list, a bare email or "Name <email>".
  function personForm(id, busy, exclude, onPerson, placeholder) {
    var listId = 'dir-' + id.replace(/[^a-z0-9]+/gi, '-');
    var inp = draft(id, { list: listId, placeholder: placeholder || 'Email, or pick someone', 'aria-label': 'Person to add' });
    var ekey = 'person:' + id;
    return [h('form', { class: 'line', onsubmit: function (e) {
      e.preventDefault();
      var p = parsePerson(inp.value);
      if (!p) { state.error = { key: ekey, text: 'Type an email, or pick someone from the list.' }; render(); return; }
      if (state.error && state.error.key === ekey) state.error = null;
      onPerson(p, function () { delete drafts[id]; });
    } }, inp,
      h('datalist', { id: listId }, directory().filter(function (x) { return (exclude || []).indexOf(x.email) < 0; })
        .map(function (x) { return h('option', { value: x.name && x.name !== x.email ? x.name + ' <' + x.email + '>' : x.email }); })),
      btn('Add', null, { submit: true, disabled: busy })), errFor(ekey)];
  }
  function historyList(hist) {
    hist = hist || [];
    return hist.length ? h('ul', { class: 'history' }, hist.slice().reverse().map(function (x) {
      return h('li', null, h('span', { class: 'mono date', text: when(x.at).slice(0, 10) }), ' ', x.what);
    })) : h('p', { class: 'empty', text: 'Nothing recorded yet.' });
  }
  function confirmBox(lbl, body, yes, onYes) {
    return [h('aside', { class: 'callout' },
      h('span', { class: 'callout-label', text: lbl }), h('div', { class: 'callout-body', text: body })),
      h('div', { class: 'btnrow' },
        btn(yes, onYes, { cls: 'btn-accent' }),
        btn('Keep it', function () { state.confirmDel = null; render(); }, { cls: 'btn-ghost' }))];
  }
  // ---- Locks: the owner freezes a package, a link or a group; unlocking asks once more, so a stray click can't ----
  function padlock() { return icon('lock', '13', '1.5'); }
  function lockedMark() { return h('span', { class: 'lockedmark' }, padlock(), 'Locked'); }
  // The control, the same in all three places: Lock; or the padlock, Locked and Unlock; or the question.
  // key is the item's pending/error key ('pkg:<id>', 'link:<id>', 'grp:<id>'), path its route, what its kind.
  function lockCtl(it, key, path, what) {
    var busy = !!state.pending[key];
    var set = function (on) {
      state.unlockAsk = null;
      mutate(key, path, { locked: on }, on ? 'Couldn’t lock it. Nothing changed.' : 'Couldn’t unlock it. It’s still locked.');
    };
    if (!it.locked) return h('span', { class: 'lockctl' }, btn('Lock', function () { set(true); }, { cls: 'btn-ghost', disabled: busy, label: 'Lock this ' + what }));
    if (state.unlockAsk === key) {
      return h('span', { class: 'lockctl' }, h('span', { class: 'lockask', text: 'Unlock this ' + what + '? It can be changed again.' }),
        btn('Yes, unlock', function () { set(false); }, { cls: 'btn-accent', disabled: busy }),
        btn('Cancel', function () { state.unlockAsk = null; render(); }, { cls: 'btn-ghost' }));
    }
    return h('span', { class: 'lockctl' }, lockedMark(),
      btn('Unlock', function () { state.unlockAsk = key; state.confirmDel = null; render(); }, { cls: 'btn-ghost', disabled: busy, label: 'Unlock this ' + what }));
  }
  // What a lock freezes stays in view, faded, and can't be clicked or tabbed into.
  function frozen(on, cls, children) {
    return h('div', { class: cls + (on ? ' frozen' : ''), inert: !!on, 'aria-disabled': on ? 'true' : null }, children);
  }

  function crumbs(parts) {
    var out = [h('a', { href: '#/', text: 'Library' })];
    parts.forEach(function (p) { out.push(h('span', { 'aria-hidden': 'true', text: '/' }), p); });
    return h('nav', { class: 'crumbs', 'aria-label': 'Breadcrumb' }, out);
  }
  function pageHead(title, intro) {
    return h('div', { class: 'pagehead' }, h('h1', { class: 'h1', text: title }), intro ? h('p', { class: 'intro', text: intro }) : null);
  }

  // Emails Cloudflare Access still needs. Shown on the Sharing page, and on any page right after a write says so.
  function accessNotice(always) {
    if (!isOwner() || state.full) return null;
    var a = (state.accessShown && state.accessFromWrite) || state.data.access;
    if (!a || !Array.isArray(a.manual) || !a.manual.length || (a.sync && !a.error)) return null;
    if (!always && !state.accessShown) return null;
    var list = a.manual.join(', ');
    return h('aside', { class: 'notice' },
      h('span', { class: 'notice-label', text: 'Cloudflare Access' }),
      h('span', { class: 'notice-body' },
        a.sync ? 'The last change to the Access policy failed' + (a.error ? ' (' + a.error + ')' : '') + '. '
          : 'The site can’t change the Access policy yet' +
            (Array.isArray(a.missing) && a.missing.length ? ': this deployment can’t see ' + a.missing.join(', ') + '. ' : '. '),
        'Add ' + (a.manual.length === 1 ? 'this email' : 'these emails') + ' to allow-library by hand, or they can’t sign in: ',
        h('span', { class: 'mono', text: list })),
      copyBtn(list, ' '));
  }

  // ---- Links ----
  var KIND = { 'public': 'Public', 'private': 'Private', 'signed-in': 'Signed-in' };
  var KIND_NOTE = {
    'public': 'Anyone with it opens the file, signed in or not.',
    'private': 'Only the people and groups on it, signed in as themselves.',
    'signed-in': 'Library readers only. For lessons pages: move it here and every page carrying it follows.'
  };
  var STATE_LABEL = { live: 'Live', disabled: 'Disabled', archived: 'Archived' };
  var TONE = { 'public': 'sage', 'private': 'plum', 'signed-in': 'slate' };
  function targetText(t) {
    if (!t) return '—';
    if (t.package) { var pk = pkgById(t.package); return 'Package ' + (pk ? pk.name : t.package); }
    var d = docByNum(t.number);
    return t.number + (t.rev ? '-' + t.rev : '') + (d ? ' ' + d.title : '') + (t.rev ? '' : ', following the newest');
  }
  function tag(text, tone) { return h('span', { class: 'tag' + (tone ? ' tag-' + tone : ''), text: text }); }
  function linkTags(l) {
    var k = kindOf(l), st = stateOf(l), t = l.target || {}, pk = t.package ? pkgById(t.package) : null;
    return h('span', { class: 'tags' },
      tag(KIND[k] || k, TONE[k]),
      t.number ? tag(t.rev ? 'Rev ' + t.rev : 'Follows newest') : null,
      st !== 'live' ? tag(STATE_LABEL[st] || st, st === 'archived' ? 'accent' : 'ochre') : null,
      pk && pk.archived ? tag('Package archived', 'accent') : null,
      l.locked ? tag('locked') : null);
  }
  function linkName(n) {
    return (n === 'signed-in' ? 'link' : n + '-link');
  }

  // One link as a line (name, tags, what it opens, its address) that opens in place to every way to change it.
  // ctx 'doc' | 'pkg' | 'sharing': where the list sits.
  function linkRow(l, ctx) {
    var key = 'link:' + l.id, busy = !!state.pending[key];
    var k = kindOf(l), st = stateOf(l), t = l.target || {};
    var open = state.linkOpen === l.id;
    // a locked link changes nothing but its lock (lockCtl), so every other write stops here
    var set = function (body, fail) {
      if (l.locked) return;
      mutate(key, '/api/links/' + l.id, body, fail || 'Couldn’t change “' + l.name + '”. Nothing changed.');
    };
    var lockBtn = lockCtl(l, key, '/api/links/' + l.id, 'link');
    var pk = t.package ? pkgById(t.package) : null;
    var d = t.number ? docByNum(t.number) : null;
    var who = k === 'private' ? (l.people || []).map(nameOf).concat((l.groups || []).map(function (gid) {
      var g = groupById(gid); return (g ? g.name : gid) + ' (group)';
    })) : [];
    var head = h('button', { type: 'button', class: 'linkhead', 'aria-expanded': open ? 'true' : 'false',
      onclick: function () { state.linkOpen = open ? null : l.id; state.confirmDel = null; render(); } },
      h('span', { class: 'linkline' }, caret(open),
        h('span', { class: 'linkname' + (st === 'live' ? '' : ' dead'), text: l.name }), linkTags(l),
        ctx === 'sharing' ? h('span', { class: 'opens', text: targetText(t) }) : null),
      who.length && ctx !== 'sharing' ? h('span', { class: 'sub linkwho', text: 'For ' + who.join(', ') }) : null);
    var out = [head];
    if (ctx !== 'sharing' || open) {
      out.push(h('div', { class: 'urlline' }, h('span', { class: 'url' + (st === 'live' ? '' : ' dead'), text: l.url }),
        st === 'live' ? copyBtn(l.url) : null));
    }
    if (!open) return h('div', { class: 'link' + (st === 'live' ? '' : ' off') + (open ? ' open' : '') }, out, errFor(key));

    var body = [];
    if (st === 'archived') {
      body.push(h('p', { class: 'note', text: 'Pointed at ' + targetText(t) + '. It answers “not found” until restored, at the same address.' }));
      // an archived link that is locked is unlocked before Restore, which the server would refuse
      body.push(h('div', { class: 'btnrow' }, l.locked ? lockBtn
        : btn('Restore', function () { set({ state: 'live' }, 'Couldn’t restore it. It’s still archived.'); }, { disabled: busy })));
    } else {
      // name, what it opens, its kind and who: frozen while it is locked
      var grid = frozen(l.locked, 'kv');
      // its name: blank is not allowed, so a blank box puts the old name back
      var nid = 'lname:' + l.id;
      var nameIn = draft(nid, { value: l.name, maxlength: '80', 'aria-label': 'Name of ' + l.name, disabled: busy });
      var saveName = function () {
        var v = nameIn.value.trim();
        delete drafts[nid];
        if (!v || v === l.name) { nameIn.value = l.name; return; }
        set({ name: v }, 'Couldn’t rename it. Nothing changed.');
      };
      nameIn.addEventListener('change', saveName);
      nameIn.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); nameIn.blur(); } });
      add(grid, [h('span', { class: 'k', text: 'Name' }), nameIn]);

      // where it points: a revision of this document or the newest, another document, another package
      var target;
      if (t.package) {
        target = h('select', { class: 'input sel', 'aria-label': 'Package ' + l.name + ' opens', disabled: busy,
          onchange: function (e) { set({ target: { package: e.target.value } }, 'Couldn’t move it. It still opens ' + (pk ? pk.name : 'the same package') + '.'); } },
          livePackages().concat(pk && pk.archived ? [pk] : []).map(function (x) {
            return h('option', { value: x.id, selected: x.id === t.package, text: x.name });
          }));
      } else {
        target = h('span', { class: 'line' },
          h('a', { class: 'mono', href: d ? hashFor(docRoute(d, t.rev)) : null, text: t.number }),
          d ? revSelect(d, t.rev, 'Revision ' + l.name + ' opens', function (rev) {
            set({ target: { number: t.number, rev: rev } }, 'Couldn’t switch it. It still opens ' + targetText(t) + '.');
          }, busy) : h('span', { class: 'sub', text: t.rev ? 'rev ' + t.rev : 'newest' }),
          state.editing === 'move:' + l.id ? null
            : btn('Move…', function () { state.editing = 'move:' + l.id; render(); }, { cls: 'btn-ghost', disabled: busy, label: 'Point ' + l.name + ' at another document' }));
      }
      add(grid, [h('span', { class: 'k', text: 'Opens' }), target]);
      if (state.editing === 'move:' + l.id) {
        var to = escClose(draft('move:' + l.id, { maxlength: '14', placeholder: 'PPP-NNNN or PPP-NNNN-R', 'aria-label': 'Point ' + l.name + ' at' }),
          function () { state.editing = null; });
        focusSoon(to);
        add(grid, [h('span'), h('form', { class: 'line', onsubmit: function (e) {
          e.preventDefault();
          var mm = /^(\d{3}-\d{4})(?:-([A-Z]{1,2}))?$/.exec(to.value.trim().toUpperCase());
          var nd = mm && docByNum(mm[1]);
          if (!nd || (mm[2] && !nd.revisions.some(function (r) { return r.rev === mm[2]; }))) {
            state.error = { key: key, text: 'No filed document at that number.' }; render(); return;
          }
          if (l.locked) return;
          mutate(key, '/api/links/' + l.id, { target: { number: mm[1], rev: mm[2] || null } },
            'Couldn’t move “' + l.name + '”. It still opens ' + targetText(t) + '.',
            function () { state.editing = null; delete drafts['move:' + l.id]; });
        } }, to, btn('Move', null, { submit: true, disabled: busy }),
          btn('Cancel', function () { state.editing = null; render(); }, { cls: 'btn-ghost' }))]);
      }

      // the kind: public, private (named people and groups), signed-in (documents only)
      var kinds = t.package ? ['public', 'private'] : ['public', 'private', 'signed-in'];
      add(grid, [h('span', { class: 'k', text: 'Kind' }), h('span', { class: 'line wrap' },
        h('select', { class: 'input sel', 'aria-label': 'Kind of ' + l.name, disabled: busy,
          onchange: function (e) { set({ kind: e.target.value }); } },
          kinds.map(function (x) { return h('option', { value: x, selected: x === k, text: KIND[x] }); })),
        h('span', { class: 'sub', text: KIND_NOTE[k] || '' }))]);

      if (k === 'private') {
        var people = l.people || [], gs = l.groups || [];
        var free = groups().filter(function (g) { return gs.indexOf(g.id) < 0; });
        add(grid, [h('span', { class: 'k', text: 'Who' }), h('div', { class: 'stack-s' },
          h('div', { class: 'chips' },
            people.map(function (em) {
              return chip(nameOf(em), em, function () { set({ people: people.filter(function (x) { return x !== em; }) }); }, busy);
            }),
            gs.map(function (gid) {
              var g = groupById(gid);
              return chip((g ? g.name : gid) + ' (group)', null, function () { set({ groups: gs.filter(function (x) { return x !== gid; }) }); }, busy);
            }),
            people.length || gs.length ? null : h('span', { class: 'sub', text: 'Nobody yet. Add people or a group.' })),
          personForm('lp:' + l.id, busy, people, function (p, done) {
            if (l.locked) return;
            mutate(key, '/api/links/' + l.id, { people: people.concat([p.email]) }, 'Couldn’t add ' + p.email + '. Nothing changed.', done);
          }, 'Add a person by email'),
          free.length ? h('select', { class: 'input sel', 'aria-label': 'Add a group to ' + l.name, disabled: busy,
            onchange: function (e) { if (e.target.value) set({ groups: gs.concat([e.target.value]) }); } },
            h('option', { value: '', text: 'Add a group…' }),
            free.map(function (g) { return h('option', { value: g.id, text: g.name }); })) : null)]);
      }
      body.push(grid);

      // locked, Disable/Enable and Archive are hidden: only the lock control stays in the action row
      body.push(state.confirmDel === key && !l.locked
        ? confirmBox('Archive this link?', 'It stops answering at once. It stays listed under Archived with its address and history, and Restore brings it back at the same address.',
          'Archive link', function () { set({ state: 'archived' }, 'Couldn’t archive it. It still works.'); })
        : h('div', { class: 'btnrow' },
          l.locked ? null : st === 'disabled'
            ? btn('Enable', function () { set({ state: 'live' }, 'Couldn’t enable it. It’s still off.'); }, { disabled: busy })
            : btn('Disable', function () { set({ state: 'disabled' }, 'Couldn’t disable it. It still works.'); }, { disabled: busy }),
          l.locked ? null : btn('Archive', function () { state.confirmDel = key; render(); }, { disabled: busy, cls: 'btn-ghost', label: 'Archive ' + l.name }),
          lockBtn));
    }
    body.push(historyList(l.history));
    out.push(h('div', { class: 'linkbody' }, body));
    out.push(errFor(key));
    return h('div', { class: 'link open' + (st === 'live' ? '' : ' off') }, out);
  }

  // ---- The Share dialog: make a link to a document (the revision being viewed, or following the newest) or a
  // package, then show its address ----
  var SHARE_NOTE = {
    'public': 'Anyone with it opens the file, signed in or not. No sign-in, no names.',
    'private': 'Only the people and groups you add, signed in as themselves.',
    'signed-in': 'Anyone who can sign in to the library. Used by the lessons site.'
  };
  function openShare(kind, target) {
    state.dlg = { type: 'share', kind: kind, target: target, follow: 'rev', people: [], groups: [], made: null };
    Object.keys(drafts).forEach(function (k) { if (k.indexOf('dlg:') === 0) delete drafts[k]; });
    render();
  }
  function closeDialog() {
    state.dlg = null;
    Object.keys(drafts).forEach(function (k) { if (k.indexOf('dlg:') === 0) delete drafts[k]; });
    if (state.error && /^dlg/.test(state.error.key)) state.error = null;
    render();
  }
  function shareDialog(s) {
    var d = s.target.number ? docByNum(s.target.number) : null;
    var pk = s.target.package ? pkgById(s.target.package) : null;
    var busy = !!state.pending.dlg;
    var tlabel = d ? d.number + '-' + (s.target.rev || last(d).rev) + ' ' + d.title : 'Package: ' + (pk ? pk.name : '');
    if (s.made) {
      var m = s.made;
      var manual = accessManual();
      var note = kindOf(m) === 'private' && (m.people || []).some(function (e) { return manual.indexOf(e) >= 0; })
        ? 'One of these people still has to be added to Cloudflare Access by hand. The Sharing page lists who.'
        : kindOf(m) === 'private' ? 'They sign in as themselves to open it. Nobody on it sees who else is.'
          : 'You can repoint, disable or archive it later on the Sharing page.';
      return [h('div', { class: 'dlg-head' }, h('h2', { class: 'dlg-title', id: 'dlg-title', text: 'Link made' }),
        h('span', { class: 'sub', text: tlabel })),
        h('div', { class: 'line wrap' }, h('span', { class: 'linkname', text: m.name }), linkTags(m)),
        h('div', { class: 'urlline' }, h('span', { class: 'url big', text: m.url }), copyBtn(m.url, ' ')),
        h('p', { class: 'note', text: note }),
        h('div', { class: 'btnrow' }, btn('Done', closeDialog, { cls: 'btn-primary btn-md' }))];
    }
    var kinds = pk ? ['public', 'private'] : ['public', 'private', 'signed-in'];
    var same = linksTo(function (t) { return pk ? t.package === pk.id : t.number === d.number; })
      .filter(function (l) { return kindOf(l) === s.kind; }).length;
    var nameIn = draft('dlg:name', { maxlength: '80', 'aria-label': 'Name of the new link',
      placeholder: 'Left blank, it becomes ' + linkName(s.kind) + '-' + (same + 1) });
    var parts = [h('div', { class: 'dlg-head' },
      h('h2', { class: 'dlg-title', id: 'dlg-title', text: 'New ' + (KIND[s.kind] || s.kind).toLowerCase() + ' link' }),
      h('span', { class: 'sub', text: tlabel })),
      h('div', { class: 'field' },
        seg(kinds.map(function (x) { return { value: x, label: KIND[x] }; }), s.kind, function (v) { s.kind = v; render(); }, 'seg-wide'),
        h('span', { class: 'note', text: SHARE_NOTE[s.kind] }))];
    if (d) {
      var rv = s.target.rev || last(d).rev;
      parts.push(h('div', { class: 'field' }, h('span', { class: 'label', text: 'Opens' }),
        seg([{ value: 'rev', label: 'This revision (' + rv + ')' }, { value: 'newest', label: 'Follow the newest' }], s.follow,
          function (v) { s.follow = v; render(); }, 'seg-wide')));
    }
    parts.push(h('label', { class: 'field' }, h('span', { class: 'label', text: 'Name' }), nameIn));
    if (s.kind === 'private') {
      var sugg = h('div', { class: 'suggest', role: 'listbox', 'aria-label': 'People' });
      var q = draft('dlg:q', { placeholder: 'Email, or pick someone', 'aria-label': 'Person to add', role: 'combobox',
        'aria-autocomplete': 'list' });
      var pick = function (email) {
        if (s.people.indexOf(email) < 0) s.people.push(email);
        delete drafts['dlg:q'];
        if (state.error && state.error.key === 'dlg:q') state.error = null;
        render();
      };
      var fill = function () {
        var v = q.value.trim().toLowerCase();
        sugg.textContent = '';
        var hits = v ? directory().filter(function (x) {
          return s.people.indexOf(x.email) < 0 && (x.email.indexOf(v) >= 0 || (x.name || '').toLowerCase().indexOf(v) >= 0);
        }).slice(0, 8) : [];
        hits.forEach(function (x) {
          add(sugg, h('button', { type: 'button', role: 'option', class: 'suggest-item', onclick: function () { pick(x.email); } },
            h('span', { text: x.name || x.email }), x.name && x.name !== x.email ? h('span', { class: 'sub', text: x.email }) : null));
        });
        sugg.hidden = !hits.length;
      };
      q.addEventListener('input', fill);
      q.addEventListener('keydown', function (e) {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        var p = parsePerson(q.value);
        if (p) pick(p.email);
        else { state.error = { key: 'dlg:q', text: 'Type an email, or pick someone from the list.' }; render(); }
      });
      fill();
      parts.push(h('div', { class: 'field' }, h('span', { class: 'label', text: 'Who can open it' }),
        s.people.length || s.groups.length ? h('div', { class: 'chips' },
          s.people.map(function (em) { return chip(nameOf(em), em, function () { s.people = s.people.filter(function (x) { return x !== em; }); render(); }); }),
          s.groups.map(function (gid) {
            var g = groupById(gid);
            return chip((g ? g.name : gid) + ' (group)', null, function () { s.groups = s.groups.filter(function (x) { return x !== gid; }); render(); });
          })) : null,
        q, sugg, errFor('dlg:q'),
        groups().length ? h('div', { class: 'checks' }, groups().map(function (g) {
          var on = s.groups.indexOf(g.id) >= 0;
          return h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: on, onchange: function () {
            s.groups = on ? s.groups.filter(function (x) { return x !== g.id; }) : s.groups.concat([g.id]);
            render();
          } }), h('span', { text: g.name }), h('span', { class: 'sub', text: plural((g.members || []).length, 'person', 'people') }));
        })) : null));
    }
    var make = function () {
      if (state.pending.dlg) return;
      var body = { kind: s.kind, target: pk ? { package: pk.id } : { number: d.number, rev: s.follow === 'rev' ? (s.target.rev || last(d).rev) : null } };
      var v = (drafts['dlg:name'] || '').trim();
      if (v) body.name = v;
      if (s.kind === 'private') { body.people = s.people.slice(); body.groups = s.groups.slice(); }
      state.pending.dlg = true;
      if (state.error && state.error.key === 'dlg') state.error = null;
      render();
      post('/api/links', body).then(function (res) {
        noteAccess(res);
        if (state.dlg === s) s.made = res;
        return load(true);
      }).catch(function () {
        state.error = { key: 'dlg', text: 'Couldn’t make the link. Nothing changed.' };
      }).then(function () { delete state.pending.dlg; render(); });
    };
    parts.push(h('div', { class: 'btnrow' },
      btn(busy ? 'Making…' : 'Make link', make, { cls: 'btn-primary btn-md', disabled: busy }),
      btn('Cancel', closeDialog, { cls: 'btn-ghost btn-md' })), errFor('dlg'));
    if (!document.activeElement || !dlgRoot.contains(document.activeElement)) focusSoon(nameIn);
    return parts;
  }

  // ---- The New document dialog: blank or a copy, its title, project and number, and who writes it ----
  function openNewDoc(project, from, fromRev) {
    var src = from ? docByNum(from) : null;
    var pnum = project || (src && src.project) || (state.data.projects[0] || {}).number;
    state.dlg = { type: 'new', start: src ? 'dup' : 'blank', from: src ? src.number : '', fromRev: fromRev || null,
      project: pnum };
    Object.keys(drafts).forEach(function (k) { if (k.indexOf('dlg:') === 0) delete drafts[k]; });
    drafts['dlg:title'] = src ? src.title + ' (copy)' : '';
    render();
  }
  function newDocDialog(n) {
    var docs = state.data.documents.slice().sort(byNumber);
    var src = n.start === 'dup' ? docByNum(n.from) : null;
    var srcRev = src ? revOf(src, n.fromRev) : null;
    var kept = !!(srcRev && srcRev.source);
    var p = projByNum(n.project);
    var number = nextNumber(n.project);
    var session = p && p.session ? 'The ' + p.session + ' session' : 'The library’s session';
    var busy = !!state.pending.dlg;
    var title = draft('dlg:title', { maxlength: '200', placeholder: 'What the document is called', 'aria-label': 'Title' });
    var grid = h('div', { class: 'kv kv-dlg' },
      h('span', { class: 'k', text: 'Start from' }),
      seg([{ value: 'blank', label: 'Blank' }, { value: 'dup', label: 'A copy of another' }], n.start, function (v) {
        n.start = v;
        if (v === 'dup' && !n.from && docs.length) n.from = docs[0].number;
        if (v === 'dup' && !(drafts['dlg:title'] || '').trim() && docByNum(n.from)) drafts['dlg:title'] = docByNum(n.from).title + ' (copy)';
        render();
      }, 'seg-wide'),
      n.start === 'dup' ? [h('span', { class: 'k', text: 'Copy of' }),
        h('select', { class: 'input', 'aria-label': 'Copy of', 'data-k': 'dlg:from', onchange: function (e) {
          var was = docByNum(n.from), d = docByNum(e.target.value);
          var t = (drafts['dlg:title'] || '').trim();
          // the title follows the source while it is still the default one
          if (d && (!t || (was && t === was.title + ' (copy)'))) drafts['dlg:title'] = d.title + ' (copy)';
          n.from = e.target.value; n.fromRev = null;
          render();
        } }, docs.map(function (d) { return h('option', { value: d.number, selected: d.number === n.from, text: d.number + ' ' + d.title }); }))] : null,
      h('span', { class: 'k', text: 'Title' }), title,
      h('span', { class: 'k', text: 'Project' }),
      h('select', { class: 'input', 'aria-label': 'Project', 'data-k': 'dlg:project', onchange: function (e) { n.project = e.target.value; render(); } },
        state.data.projects.slice().sort(byNumber).map(function (x) {
          return h('option', { value: x.number, selected: x.number === n.project, text: x.number + ' ' + x.name });
        })),
      h('span', { class: 'k', text: 'Number' }),
      h('span', { class: 'nd-num' }, h('span', { class: 'mono', text: number + '-A' }), ' ',
        h('span', { class: 'sub inline', text: 'the next free number in ' + n.project })),
      h('span', { class: 'k', text: 'Written by' }),
      h('span', { class: 'nd-session' }, session + ' on the box, if any part is Adapt or has a comment. All OG is filed straight away.',
        src && !kept ? h('span', { class: 'nd-nokeep', text: ' No LaTeX was kept for ' + src.number + '-' + srcRev.rev +
          ', so the copy starts blank with its title.' }) : null));
    var open = function () {
      if (state.pending.dlg) return;
      var body = { project: n.project, title: (drafts['dlg:title'] || '').trim().replace(/\s+/g, ' ') || 'Untitled' };
      // a copy of a revision whose LaTeX was not kept starts blank with its title, as the dialog says
      if (src && kept) body.from = { number: src.number, rev: srcRev.rev };
      state.pending.dlg = true;
      if (state.error && state.error.key === 'dlg') state.error = null;
      render();
      post('/api/drafts', body).then(function (res) {
        if (!res || !res.id) throw new Error('no draft');
        state.dlg = null;
        Object.keys(drafts).forEach(function (k) { if (k.indexOf('dlg:') === 0) delete drafts[k]; });
        location.hash = '#/edit/draft/' + encodeURIComponent(res.id);
      }).catch(function (e) {
        state.error = { key: 'dlg', text: e && e.status === 409
          ? 'No LaTeX was kept for that revision, so it can’t be copied. Start it blank instead.'
          : 'Couldn’t open the editor. Nothing was made.' };
      }).then(function () { delete state.pending.dlg; render(); });
    };
    if (!document.activeElement || !dlgRoot.contains(document.activeElement)) focusSoon(title);
    return [h('div', { class: 'dlg-head' },
      h('h2', { class: 'dlg-title', id: 'dlg-title', text: n.start === 'dup' ? 'Duplicate a document' : 'New document' }),
      h('span', { class: 'sub', text: 'It opens in the editor. Write what you can as OG, sketch the rest as Adapt, and comment.' })),
      grid,
      h('div', { class: 'btnrow' },
        btn(busy ? 'Opening…' : 'Open the editor', open, { cls: 'btn-primary btn-md', disabled: busy }),
        btn('Cancel', closeDialog, { cls: 'btn-ghost btn-md' })), errFor('dlg')];
  }

  function renderDialog() {
    dlgRoot.textContent = '';
    var s = state.dlg;
    var on = !!(s && state.data && isOwner() && state.route.name !== 'edit');
    document.body.classList.toggle('modal', on);
    if (!on) return;
    var box = h('div', { class: 'dlg', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'dlg-title',
      'data-dialog': s.type }, s.type === 'share' ? shareDialog(s) : newDocDialog(s));
    add(dlgRoot, h('div', { class: 'dlg-back', onclick: function (e) { if (e.target === e.currentTarget) closeDialog(); } }, box));
  }

  // ---- Requests: the owner asks for a new section (a project of its own) or a folder (a sub-project inside one).
  // The site makes nothing: the box posts the ask in the library channel, and the register changes once it's agreed.
  var REQ_STATUS = { 'new': 'Waiting for the box', delivered: 'In the library channel' };
  // his open asks (new or delivered); with parent, only the folders asked for inside that project
  function openRequests(parent) {
    return (state.data.requests || []).filter(function (x) {
      return (x.status === 'new' || x.status === 'delivered') && (!parent || (x.kind === 'folder' && x.parent === parent));
    });
  }
  // k is 'section' or 'folder:<PPP>': the button opens its form, and shuts it again
  function reqButton(k, text) {
    return btn(text, function () {
      state.reqForm = state.reqForm === k ? null : k;
      state.reqSent = null;
      render();
      if (state.reqForm) { var el = document.querySelector('[data-k="req:' + k + ':name"]'); if (el) el.focus(); }
    }, { cls: 'btn-ghost', title: 'Ask the box for it in the library channel' });
  }
  function requestForm(k) {
    if (state.reqSent === k) return h('p', { class: 'note reqdone', role: 'status', text: 'Requested. It’s in the library channel.' });
    if (state.reqForm !== k) return null;
    var parent = k.indexOf('folder:') === 0 ? k.slice(7) : null, p = parent ? projByNum(parent) : null;
    var key = 'req:' + k, busy = !!state.pending[key], nkey = key + ':name', tkey = key + ':note';
    var close = function () { state.reqForm = null; delete drafts[nkey]; delete drafts[tkey]; if (state.error && state.error.key === key) state.error = null; };
    var name = escClose(draft(nkey, { maxlength: '80', 'aria-label': parent ? 'Name of the folder' : 'Name of the section',
      placeholder: parent ? 'Folder name, e.g. Cover letters' : 'Section name, e.g. Garden' }), close);
    name.addEventListener('input', function () { if (state.error && state.error.key === key) { state.error = null; render(); } });
    var ta = escClose(h('textarea', { class: 'input reqnote', rows: '3', maxlength: '2000', 'data-k': tkey, 'aria-label': 'Note',
      placeholder: 'What goes in it, or anything the box should know' }), close);
    ta.value = drafts[tkey] || '';
    ta.addEventListener('input', function () { drafts[tkey] = ta.value; });
    return h('form', { class: 'reqform', onsubmit: function (e) {
      e.preventDefault();
      var v = name.value.trim().replace(/\s+/g, ' ');
      if (!v) { state.error = { key: key, text: 'Give it a name.' }; render(); return; }
      var body = { kind: parent ? 'folder' : 'section', name: v };
      if (parent) body.parent = parent;
      if (ta.value.trim()) body.note = ta.value.trim();
      mutate(key, '/api/requests', body, 'Couldn’t send the request. Nothing was asked.', function () { close(); state.reqSent = k; });
    } },
      h('p', { class: 'note', text: (parent ? 'A folder inside ' + parent + (p ? ' ' + p.name : '') + '. ' : 'A new section of the library. ') +
        'This asks for it in the library channel; nothing moves until it’s agreed.' }),
      h('label', { class: 'field' }, h('span', { class: 'label', text: 'Name' }), name),
      h('label', { class: 'field' }, h('span', { class: 'label', text: 'Note, if any' }), ta),
      h('div', { class: 'btnrow' }, btn(busy ? 'Sending…' : 'Send request', null, { submit: true, cls: 'btn-primary', disabled: busy }),
        btn('Cancel', function () { close(); render(); }, { cls: 'btn-ghost' }), errFor(key)));
  }
  // What he asked for and the box hasn't finished: shown until it is done.
  function requestedList(list) {
    if (!list.length) return null;
    return h('section', { class: 'requested' }, label('Requested · ' + list.length, 'rule-soft'), list.map(function (x) {
      var p = x.parent ? projByNum(x.parent) : null;
      return h('div', { class: 'reqitem' },
        h('span', { class: 'cell' }, h('span', { class: 'title', text: x.name }),
          h('span', { class: 'sub', text: (x.kind === 'folder' ? 'Folder in ' + x.parent + (p ? ' ' + p.name : '') : 'New section') +
            ' · asked ' + when(x.created).slice(0, 10) + (x.note ? ' · ' + x.note : '') })),
        h('span', { class: 'line reqstatus' }, dot(x.status === 'delivered' ? 'slate' : 'faint'), REQ_STATUS[x.status] || x.status));
    }));
  }

  // ---- Home ----
  // Home / Search / rail row: full number · title + sub-line · date
  function docLine(d, rev, sub, cls) {
    return rowEl('docline' + (cls ? ' ' + cls : ''), [
      h('span', { class: 'docline-top' }, h('span', { class: 'mono', text: d.number + '-' + rev }),
        h('span', { class: 'date', text: revOf(d, rev).date })),
      h('span', { class: 'title', text: d.title }),
      sub ? h('span', { class: 'sub', text: sub }) : null,
      errFor('star:' + d.number)
    ], function () { go(docRoute(d, rev)); });
  }
  function newDocIcon(pnum) {
    return h('button', { type: 'button', class: 'iconbtn rowicon', title: 'New document in ' + pnum, 'aria-label': 'New document in ' + pnum,
      onclick: function (e) { e.stopPropagation(); openNewDoc(pnum, null); } }, icon('newdoc'));
  }

  function renderHome() {
    var docs = state.data.documents;
    var owner = isOwner();
    var starred = docs.filter(function (d) { return d.starred; }).sort(byNumber);
    var recent = [];
    docs.forEach(function (d) { d.revisions.forEach(function (r) { recent.push({ d: d, r: r }); }); });
    recent.sort(function (a, b) { return b.r.date.localeCompare(a.r.date) || a.d.number.localeCompare(b.d.number); });
    recent = recent.slice(0, 6);

    function projRow(p, sub) {
      var ds = sub ? docsOf(p.number) : deepDocs(p.number);
      var lastChange = ds.map(lastDate).sort().pop() || '—';
      var kids = sub ? [] : kidsOf(p.number);
      return h('div', { class: 'prow' + (sub ? ' sub-project' : '') },
        rowEl('cols-proj', [
          h('span', { class: 'num', text: p.number }),
          h('span', { class: 'pname' }, h('span', { text: p.name }),
            kids.length ? h('span', { class: 'sub inline', text: plural(kids.length, 'sub-project') }) : null),
          h('span', { class: 'num right', text: String(ds.length) }),
          h('span', { class: 'date right', text: lastChange })
        ], function () { go({ name: 'project', num: p.number }); }),
        owner ? newDocIcon(p.number) : null);
    }
    var projects = state.data.projects.slice().sort(byNumber);
    var tops = projects.filter(function (p) { return !parentNum(p); });
    function rowsFor(ps) {
      return ps.map(function (p) { return [projRow(p), kidsOf(p.number).map(function (k) { return projRow(k, true); })]; });
    }
    var register = h('section', { class: 'home-main' },
      owner ? h('div', { class: 'reghead' }, reqButton('section', 'New section')) : null,
      owner ? requestForm('section') : null,
      h('div', { class: 'colhead cols-proj' }, h('span', { text: 'No.' }), h('span', { text: 'Projects' }),
        h('span', { class: 'right', text: 'Docs' }), h('span', { class: 'right', text: 'Last change' })));
    if (owner) {
      [
        { label: 'The box and my work', range: '001–099', t: function (n) { return n < 100; } },
        { label: 'Courses', range: '101–199', t: function (n) { return n >= 100 && n < 200; } },
        { label: 'Other', range: '200–899', t: function (n) { return n >= 200 && n < 900; } },
        { label: 'Members', range: '900–999', t: function (n) { return n >= 900; } }
      ].forEach(function (g) {
        var ps = tops.filter(function (p) { return g.t(+p.number); });
        if (!ps.length) return;
        add(register, h('div', { class: 'band' },
          h('div', { class: 'band-head' }, h('span', { class: 'band-name', text: g.label }), h('span', { class: 'band-range', text: g.range })),
          rowsFor(ps)));
      });
    } else {
      add(register, rowsFor(tops));
    }
    if (!projects.length) add(register, h('p', { class: 'empty', text: 'Nothing filed that you can see.' }));
    if (owner) add(register, requestedList(openRequests()));

    // what the owner shared with this viewer as packages, each as its folders, each document at its pinned revision
    var shared = !owner && packages().length ? h('section', { class: 'rail-sec' }, label('Shared with you', 'rule'),
      packages().map(function (pk) {
        var tree = pkgTree(pk);
        function level(fid) {
          return [tree.entries(fid).map(function (x) {
            var d = docByNum(x.number);
            return d ? docLine(d, revOf(d, x.rev).rev, x.description || null) : null;
          }), tree.folders(fid).map(function (f) {
            var fk = 'rkf:' + pk.id + ':' + f.id, open = isOpen(fk);
            return [foldHead(f.name, '(' + tree.count(f.id) + ')', open, 'subgroup', function () { toggleOpen(fk); }),
              open ? h('div', { class: 'nest' }, level(f.id)) : null];
          })];
        }
        var n = tree.count(null);
        return foldSection('rk:' + pk.id, pk.name, n, function () {
          return h('div', null, level(null), n ? null : h('p', { class: 'empty', text: 'Nothing in it yet.' }));
        }, { openByDefault: true });
      })) : null;

    var sharing = null;
    if (owner) {
      var live = allLinks().filter(function (l) { return stateOf(l) === 'live'; }).length;
      var off = allLinks().filter(function (l) { return stateOf(l) === 'disabled'; }).length;
      var manual = accessManual();
      sharing = h('section', { class: 'rail-sec' }, label('Sharing', 'rule'),
        rowEl('navrow', [h('span', { class: 'title', text: 'Links, groups and who sees what' }),
          h('span', { class: 'sub', text: plural(live, 'live link') + (off ? ', ' + off + ' disabled' : '') + ' · ' +
            plural(groups().length, 'group') + ' · ' + plural(directory().length, 'person', 'people') })],
          function () { go({ name: 'sharing' }); }),
        rowEl('navrow', [h('span', { class: 'title', text: 'Packages' }),
          h('span', { class: 'sub', text: livePackages().length + ' live, ' + (packages().length - livePackages().length) + ' archived' })],
          function () { go({ name: 'packages' }); }),
        manual.length && !(state.data.access && state.data.access.sync && !state.data.access.error)
          ? h('a', { class: 'accent-line', href: '#/sharing', text: plural(manual.length, 'email') + ' to add to Cloudflare Access by hand' }) : null);
    }

    var rail = h('aside', { class: 'home-rail' }, shared,
      h('section', { class: 'rail-sec' }, label('Starred', 'rule'),
        starred.map(function (d) {
          var p = projByNum(d.project), pub = publicRevs(d);
          return h('div', { class: 'starrow' }, docLine(d, last(d).rev, (p ? p.name : '') + (pub.length ? ' · public link on ' + pub.join(', ') : '')), starBtn(d));
        }),
        starred.length ? null : h('p', { class: 'empty', text: 'Nothing starred. Star a document from its page to keep it here.' })),
      foldSection('home:recent-shut', 'Recently filed or revised', recent.length, function () {
        return recent.map(function (x) {
          return rowEl('recent', [h('span', { class: 'mono', text: x.d.number + '-' + x.r.rev }), h('span', { class: 'title', text: x.d.title }),
            h('span', { class: 'date', text: x.r.date }),
            h('span', { class: 'sub', text: (x.d.revisions[0] === x.r ? 'Filed' : 'Revised to ' + x.r.rev) + (x.r.note && x.d.revisions[0] !== x.r ? ' · ' + x.r.note : '') })],
          function () { go(docRoute(x.d, x.r.rev)); });
        });
      }, { openByDefault: true, cls: 'rail-sec' }),
      sharing);

    return h('div', { class: 'home' }, rail, register);
  }

  // ---- Project ----
  function renderProject(p) {
    var owner = isOwner();
    var sortFn = state.sort === 'date' ? byDateDesc : byNumber;
    var own = docsOf(p.number).sort(sortFn);
    var subs = kidsOf(p.number);
    var all = deepDocs(p.number);
    var lastChange = all.map(lastDate).sort().pop();
    var meta = plural(all.length, 'document') + (subs.length ? ' in ' + plural(subs.length, 'sub-project') : '') +
      (lastChange ? ' · last change ' + lastChange : '');
    return h('div', { class: 'page' },
      crumbs([h('span', { class: 'mono', text: p.number })]),
      h('div', { class: 'titlerow' },
        h('div', { class: 'stack-s' },
          h('h1', { class: 'projtitle' }, h('span', { class: 'pnum', text: p.number }), h('span', { class: 'pname-big', text: p.name })),
          h('span', { class: 'meta', text: meta })),
        h('div', { class: 'toolbar' },
          h('span', { class: 'label', text: 'Sort' }),
          owner ? btn('New document', function () { openNewDoc(p.number, null); }) : null,
          owner ? reqButton('folder:' + p.number, 'New folder') : null,
          seg([{ value: 'number', label: 'Number' }, { value: 'date', label: 'Date' }], state.sort,
            function (v) { state.sort = v; render(); }, 'seg-sort'))),
      owner ? requestForm('folder:' + p.number) : null,
      h('div', { class: 'ptable' },
        h('div', { class: 'colhead cols-pdoc' }, h('span', { text: 'Number' }), h('span', { text: 'Title' }),
          h('span', { class: 'wide-only', text: 'Rev' }), h('span', { class: 'wide-only', text: 'Date' }), h('span')),
        own.map(pdocRow),
        subs.map(function (sp) {
          var sd = docsOf(sp.number).sort(sortFn);
          return h('div', { class: 'subhead-block' },
            h('div', { class: 'subhead' }, h('a', { href: '#/p/' + sp.number, class: 'subhead-link' },
              h('span', { class: 'mono', text: sp.number }), h('span', { class: 'u', text: sp.name })),
              h('span', { class: 'sub inline', text: plural(sd.length, 'doc') })),
            sd.map(pdocRow));
        }),
        own.length || subs.length ? null : h('p', { class: 'empty', text: 'Nothing filed here yet.' })),
      owner ? requestedList(openRequests(p.number)) : null);
  }

  function pdocRow(d) {
    var pub = publicRevs(d);
    var sub = [d.description, pub.length ? 'Public link on ' + pub.join(', ') : null].filter(Boolean).join(' · ');
    var narrowSub = [sub, 'rev ' + last(d).rev + ' · ' + lastDate(d)].filter(Boolean).join(' · ');
    return h('div', { class: 'prow' },
      rowEl('cols-pdoc', [
        h('span', { class: 'num', text: d.number }),
        h('span', { class: 'cell' },
          h('span', { class: 'title', text: d.title }),
          sub ? h('span', { class: 'sub wide-only', text: sub }) : null,
          h('span', { class: 'sub narrow-only', text: narrowSub }),
          errFor('star:' + d.number)),
        h('span', { class: 'num wide-only', text: last(d).rev }),
        h('span', { class: 'date wide-only', text: lastDate(d) }),
        starBtn(d)
      ], function () { go(docRoute(d)); }),
      isOwner() ? h('button', { type: 'button', class: 'iconbtn rowicon dupicon', title: 'Duplicate ' + d.number, 'aria-label': 'Duplicate ' + d.number,
        onclick: function (e) { e.stopPropagation(); openNewDoc(d.project, d.number); } }, icon('dup')) : null);
  }

  // ---- Document ----
  function isIOS() {
    var ua = navigator.userAgent || '';
    return /iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  }
  // A phone shows no PDF in a frame (Android's Chrome has no viewer, iOS shows one page), so there, and wherever the
  // browser says it has no viewer, pdf.js draws the pages instead.
  function drawsPdf() { return state.narrow || isIOS() || navigator.pdfViewerEnabled === false; }
  var pdfjs = null;       // pdf.js, imported once, from the same /vendor copy the editor uses
  var sheets = null;      // { file, el, io }: the pages drawn for the PDF shown last, kept so a re-render doesn't draw again
  function drawnPdf(file, fname) {
    if (sheets && sheets.file === file) return sheets.el;
    if (sheets && sheets.io) sheets.io.disconnect();
    var el = h('div', { class: 'sheets', role: 'document', 'aria-label': fname }, h('p', { class: 'sheets-note', text: 'Loading the PDF…' }));
    // a change of revision holds the old pages' height until the new ones are laid, so the page keeps its place
    if (sheets && sheets.el.offsetHeight) el.style.minHeight = sheets.el.offsetHeight + 'px';
    sheets = { file: file, el: el };
    pdfjs = pdfjs || import('/vendor/pdf.min.mjs').then(function (m) {
      m.GlobalWorkerOptions.workerSrc = '/vendor/pdf.worker.min.mjs';
      return m;
    });
    pdfjs.then(function (P) { return P.getDocument({ url: file, isEvalSupported: false, withCredentials: true }).promise; })
      .then(function (doc) { return doc.getPage(1).then(function (first) { var s = sheets; if (s && s.el === el) s.io = layPages(el, doc, first);
        el.style.minHeight = '';
        if (keepY != null) { window.scrollTo(0, keepY); keepY = null; } }); })
      .catch(function () {
        el.style.minHeight = '';
        el.textContent = '';
        add(el, h('div', { class: 'sheet-fallback' }, h('span', { class: 'label', text: 'Open the PDF' }), h('a', { href: file, download: fname, text: fname })));
      });
    return el;
  }
  // One canvas a page, sized from page 1 until its own is drawn; a page is drawn when it comes near the screen.
  // Returns the observer, so the next PDF shown stops it.
  function layPages(el, doc, first) {
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    var cssW = function () { return el.clientWidth || 360; };
    var draw = function (cv, n) {
      if (cv.getAttribute('data-drawn')) return;
      cv.setAttribute('data-drawn', '1');
      (n === 1 ? Promise.resolve(first) : doc.getPage(n)).then(function (page) {
        var vp = page.getViewport({ scale: cssW() * dpr / page.getViewport({ scale: 1 }).width });
        cv.width = Math.floor(vp.width);
        cv.height = Math.floor(vp.height);
        return page.render({ canvasContext: cv.getContext('2d'), viewport: vp }).promise;
      }).catch(function () { /* a page that won't draw stays blank; Open still has the file */ });
    };
    var v1 = first.getViewport({ scale: 1 });
    el.textContent = '';
    var io = window.IntersectionObserver ? new IntersectionObserver(function (en) {
      en.forEach(function (e) { if (e.isIntersecting) { io.unobserve(e.target); draw(e.target, +e.target.getAttribute('data-page')); } });
    }, { rootMargin: '600px 0px' }) : null;
    for (var n = 1; n <= doc.numPages; n++) {
      var cv = h('canvas', { class: 'sheet', 'data-page': String(n), 'aria-label': 'Page ' + n });
      cv.width = Math.floor(cssW() * dpr);
      cv.height = Math.floor(cv.width * v1.height / v1.width);
      el.appendChild(cv);
      if (io) io.observe(cv); else draw(cv, n);
    }
    return io;
  }

  // A document's one-line description: everyone reads it, the owner edits it in place, up to 200 characters.
  function descLine(d) {
    var key = 'desc:' + d.number, busy = !!state.pending[key];
    if (isOwner() && state.editing === key) {
      var count = h('span', { class: 'counter' });
      var inp = escClose(draft(key, { maxlength: '200', value: d.description || '', placeholder: 'One line, e.g. Autobox working principle',
        'aria-label': 'Description of ' + d.number }), function () { state.editing = null; delete drafts[key]; });
      var upd = function () { count.textContent = inp.value.length + '/200'; };
      inp.addEventListener('input', upd);
      upd();
      focusSoon(inp);
      return h('div', null, h('form', { class: 'line desc-edit', onsubmit: function (e) {
        e.preventDefault();
        mutate(key, '/api/documents/' + d.number + '/description', { description: inp.value.trim().replace(/\s+/g, ' ') },
          'Couldn’t save the description. Nothing changed.', function () { state.editing = null; delete drafts[key]; });
      } }, inp, count, btn(busy ? 'Saving…' : 'Save', null, { submit: true, disabled: busy }),
        btn('Cancel', function () { state.editing = null; delete drafts[key]; render(); }, { cls: 'btn-ghost' })), errFor(key));
    }
    var edit = isOwner() ? textBtn(d.description ? 'Edit' : 'Add a one-line description', function () { state.editing = key; render(); }) : null;
    if (!d.description && !edit) return null;
    return h('p', { class: 'desc' }, d.description ? h('span', { text: d.description + ' ' }) : null, edit);
  }

  // brief item 25: the owner's feedback on the revision he is viewing: a section (the whole document, a heading the
  // register lists, one used before, or one he types) and a kind, "request" or "text" (his own words, used verbatim)
  var FB_STATUS = { 'new': 'Waiting for the box', delivered: 'Sent to the session that made it', done: 'Done' };
  var FB_TONE = { 'new': 'faint', delivered: 'slate', done: 'sage' };
  function feedbackForm(d, r) {
    var key = 'fb:' + d.number, busy = !!state.pending[key];
    var known = [];
    (r.sections || []).concat((d.feedback || []).map(function (x) { return x.section; })).forEach(function (x) {
      if (x && known.indexOf(x) < 0) known.push(x);
    });
    var secKey = key + ':sec', kindKey = key + ':kind', textKey = key + ':text', otherKey = key + ':other';
    var sec = drafts[secKey] || '';
    var secSel = h('select', { class: 'input', 'aria-label': 'Section',
      onchange: function (e) { drafts[secKey] = e.target.value; render(); } },
      h('option', { value: '', selected: sec === '', text: 'Whole document' }),
      known.map(function (x) { return h('option', { value: 's:' + x, selected: sec === 's:' + x, text: x }); }),
      h('option', { value: 'other', selected: sec === 'other', text: 'Another section…' }));
    var other = sec === 'other' ? draft(otherKey, { maxlength: '200', placeholder: 'Section, e.g. 2 Method', 'aria-label': 'Section name' }) : null;
    var kind = drafts[kindKey] || 'request';
    var kindSel = h('select', { class: 'input', 'aria-label': 'Kind',
      onchange: function (e) { drafts[kindKey] = e.target.value; render(); } },
      h('option', { value: 'request', selected: kind === 'request', text: 'A change to make' }),
      h('option', { value: 'text', selected: kind === 'text', text: 'My own text, used as written' }));
    var ta = h('textarea', { class: 'input fbtext', rows: '5', maxlength: '20000', 'aria-label': 'Feedback', 'data-k': textKey,
      placeholder: kind === 'text' ? 'The words for this section, exactly as they should read' : 'What should change' });
    ta.value = drafts[textKey] || '';
    ta.addEventListener('input', function () { drafts[textKey] = ta.value; });
    return h('form', { class: 'fbform', onsubmit: function (e) {
      e.preventDefault();
      var text = ta.value.trim();
      var section = sec === 'other' ? (drafts[otherKey] || '').trim().replace(/\s+/g, ' ') : sec ? sec.slice(2) : null;
      if (!text || (sec === 'other' && !section)) {
        state.error = { key: key, text: !text ? 'Write something first.' : 'Name the section, or pick Whole document.' };
        render(); return;
      }
      mutate(key, '/api/documents/' + d.number + '/feedback', { rev: r.rev, section: section, kind: kind, text: text },
        'Couldn’t send it. Nothing was saved.', function () { delete drafts[textKey]; delete drafts[otherKey]; });
    } },
      h('div', { class: 'btnrow' }, secSel, kindSel), other, ta,
      h('div', { class: 'btnrow' }, btn(busy ? 'Sending…' : 'Send on rev ' + r.rev, null, { submit: true, disabled: busy }),
        errFor(key)));
  }

  // The document's drafts, fetched when the Edits tab first shows them.
  function loadDrafts(num) {
    if (state.draftsOf[num]) return;
    state.draftsOf[num] = { loading: true };
    getJson('/api/documents/' + num + '/drafts').then(function (res) {
      state.draftsOf[num] = { list: Array.isArray(res && res.drafts) ? res.drafts : [] };
    }).catch(function () {
      state.draftsOf[num] = { error: true };
    }).then(function () { if (state.route.name === 'doc' && state.route.num === num) render(); });
  }
  var DRAFT_STATE = { sent: 'Sent to the session', answered: 'Answered', discarded: 'Discarded' };
  function editsTab(d, r) {
    var ds = state.draftsOf[d.number] || {};
    var list = ds.list || [];
    var openDrafts = list.filter(function (x) { return x.state === 'draft'; });
    var rest = list.filter(function (x) { return x.state !== 'draft'; });
    var out = [];
    if (ds.loading) out.push(h('p', { class: 'empty', text: 'Looking for drafts…' }));
    else if (ds.error) out.push(h('p', { class: 'err', text: 'Couldn’t load the drafts. Reload to try again.' }));
    openDrafts.forEach(function (x) {
      out.push(h('div', { class: 'draftcard' },
        h('span', { class: 'line' }, dot('ochre'), h('strong', { text: 'Draft on rev ' + (x.base_rev || '—') + ', not sent' })),
        h('span', { class: 'sub', text: 'Started ' + when(x.created) + (x.updated && x.updated !== x.created ? ' · saved ' + when(x.updated) : '') }),
        h('a', { class: 'textlink', href: '#/edit/draft/' + encodeURIComponent(x.id), text: 'Continue the draft' })));
    });
    if (!ds.loading && !openDrafts.length) {
      out.push(h('p', { class: 'note', text: 'Edit source opens a private copy of rev ' + r.rev + ' next to its LaTeX. You change it, comment on it, ' +
        'and file it or send the lot to the session that filed it. Nothing here changes until a new revision is filed.' }));
    }
    rest.forEach(function (x) {
      var what = x.state === 'answered' ? 'Answered' + (x.answered_rev ? ' by rev ' + x.answered_rev : '') : DRAFT_STATE[x.state] || x.state;
      out.push(h('div', { class: 'fbitem' },
        h('span', { class: 'sub', text: 'Draft on rev ' + (x.base_rev || '—') + ' · ' + when(x.sent || x.updated || x.created) }),
        h('span', { class: 'line' }, dot(x.state === 'answered' ? 'sage' : x.state === 'sent' ? 'slate' : 'faint'), what)));
    });
    var items = (d.feedback || []).slice().reverse();
    out.push(foldSection('doc:feedback', 'Send a note without editing', null, function () { return feedbackForm(d, r); }, { cls: 'minor' }));
    out.push(label('Earlier feedback · ' + items.length, 'rule-soft'));
    if (!items.length) out.push(h('p', { class: 'empty', text: 'None yet.' }));
    items.forEach(function (x) {
      var status = FB_STATUS[x.status] || x.status;
      if (x.status === 'done' && x.answered_rev) status += ', answered by rev ' + x.answered_rev;
      out.push(h('div', { class: 'fbitem' },
        h('span', { class: 'sub', text: 'Rev ' + x.rev + ' · ' + (x.section || 'Whole document') + ' · ' +
          (x.kind === 'text' ? 'his own text' : 'a change to make') + ' · ' + when(x.created).slice(0, 10) }),
        h('p', { class: 'fbbody', text: x.text }),
        h('span', { class: 'line fbstatus fb-' + x.status }, dot(FB_TONE[x.status] || 'faint'), status),
        x.reply ? h('p', { class: 'fbreply', text: x.reply }) : null));
    });
    return out;
  }

  function packagesTab(d) {
    var live = livePackages();
    if (!live.length) return [h('p', { class: 'empty', text: 'No packages yet. Make one under Packages.' }), h('a', { class: 'textlink', href: '#/k', text: 'All packages' })];
    return [live.map(function (pk) {
      var pkey = 'pkg:' + pk.id, pbusy = !!state.pending[pkey];
      var inIt = pkgEntry(pk, d.number);
      var sel = revSelect(d, inIt ? inIt.rev : null, (inIt ? 'Revision of ' + d.number + ' in ' : 'Revision to add to ') + pk.name,
        function (rev) { if (inIt) saveEntry(pk, inIt, { rev: rev }); }, pbusy || pk.locked);
      return h('div', { class: 'pkgpick' + (pk.locked ? ' locked' : '') },
        h('span', { class: 'cell' }, h('span', { class: 'title', text: pk.name }),
          h('span', { class: 'sub', text: (inIt ? 'In it, ' + (inIt.rev ? 'pinned to ' + inIt.rev : 'following the newest') : plural((pk.documents || []).length, 'document')) +
            (pk.locked ? ' · locked' : '') })),
        sel,
        // a locked package's button reads Locked and does nothing
        pk.locked ? btn('Locked', null, { cls: 'btn-ghost', disabled: true, label: pk.name + ' is locked' })
          : inIt ? btn('Remove', function () { removeEntry(pk, d.number); }, { cls: 'btn-ghost', disabled: pbusy, label: 'Remove from ' + pk.name })
          : btn('Add', function () { addEntry(pk, d.number, sel.value || null); }, { disabled: pbusy, label: 'Add to ' + pk.name }),
        errFor(pkey));
    }), h('a', { class: 'textlink', href: '#/k', text: 'All packages' })];
  }

  function renderDoc(d, r) {
    var p = projByNum(d.project) || { number: d.project, name: '' };
    var cur = last(d);
    var isCur = r.rev === cur.rev;
    var full = d.number + '-' + r.rev;
    var owner = isOwner();
    var file = fileUrl(d, r), fname = saveName(d, r);

    var drawn = drawsPdf();
    var frame = drawn ? drawnPdf(file, fname) : h('iframe', { src: file + '#view=FitH', title: fname });
    // Chrome's PDF viewer scrolls the page to itself as it loads; a change of revision keeps its place
    if (frame.tagName === 'IFRAME') frame.addEventListener('load', function () { if (keepY != null) { window.scrollTo(0, keepY); keepY = null; } });
    var meta = [r.date, r.pages != null ? r.pages + ' pp' : null, size(r.bytes)].filter(Boolean).join(' · ');
    var viewer = h('section', { class: 'pdfcol' },
      state.full ? null : h('div', { class: 'filemeta' }, h('span', { text: fname }), h('span', { text: meta })),
      h('div', { class: 'pdfbox' },
        h('div', { class: 'pdfbar' }, h('span', { text: r.pages != null ? plural(r.pages, 'page') : 'PDF' }), h('span', { class: 'grow' }),
          h('a', { href: file, target: '_blank', rel: 'noopener', text: 'Open' })),
        h('div', { class: 'pdfframe' + (drawn ? ' drawn' : '') }, frame)));

    // brief: "the private link the server already serves behind Cloudflare Access … never the public /p/ link"
    var newTab = h('a', { class: 'btn btn-ghost', href: file, target: '_blank', rel: 'noopener', text: 'Open in new tab' });
    var download = h('a', { class: 'btn ' + (owner ? '' : 'btn-primary'), href: file, download: fname, text: 'Download ' + r.rev });

    if (state.full) {
      var pick = h('select', { class: 'input sel', 'aria-label': 'Revision',
        onchange: function (e) { go(docRoute(d, e.target.value)); } },
        d.revisions.slice().reverse().map(function (x) {
          return h('option', { value: x.rev, selected: x.rev === r.rev,
            text: 'Rev ' + x.rev + ' · ' + x.date + (x.rev === cur.rev ? ' · current' : '') });
        }));
      return h('div', { class: 'fullview' },
        h('div', { class: 'fsbar' },
          h('a', { class: 'btn btn-ghost btn-sm back', href: '#/p/' + p.number, 'aria-label': 'Back to ' + p.number + ' ' + p.name, text: '←' }),
          h('span', { class: 'mono fsnum', text: full }),
          h('span', { class: 'fsname', text: d.title }),
          pick,
          h('a', { class: 'btn btn-ghost btn-sm', href: file, target: '_blank', rel: 'noopener', text: 'Open' }),
          h('a', { class: 'btn btn-sm', href: file, download: fname, text: 'Download' }),
          h('button', { type: 'button', class: 'btn btn-ghost btn-sm fullbtn', 'aria-pressed': 'true', title: 'Leave full screen (Esc)',
            text: 'Exit full screen', onclick: function () { setFull(false); } })),
        viewer);
    }

    // the side panel: tabs, each with its count; the owner's five, a reader's two
    var links = owner ? docLinks(d.number).filter(function (l) { return stateOf(l) !== 'archived'; }) : [];
    var live = livePackages();
    var ds = state.draftsOf[d.number];
    var tabs = owner ? [
      ['revisions', 'Revisions', d.revisions.length],
      ['edits', 'Edits', (d.feedback || []).length + (ds && ds.list ? ds.list.length : 0) || ''],
      ['share', 'Share', links.length],
      ['packages', 'Packages', live.filter(function (pk) { return pkgEntry(pk, d.number); }).length + '/' + live.length],
      ['record', 'Record', '']
    ] : [['revisions', 'Revisions', d.revisions.length], ['record', 'Record', '']];
    var tab = tabs.some(function (t) { return t[0] === state.docTab; }) ? state.docTab : 'revisions';
    if (tab === 'edits') loadDrafts(d.number);
    var tabBar = h('div', { class: 'tabs', role: 'tablist', 'aria-label': 'About this document' }, tabs.map(function (t) {
      return h('button', { type: 'button', role: 'tab', class: 'tab', 'aria-selected': t[0] === tab ? 'true' : 'false',
        'data-tab': t[0], onclick: function () { state.docTab = t[0]; store('library-doctab', t[0]); state.confirmDel = null; render(); } },
        t[1], t[2] !== '' ? h('span', { class: 'tab-count', text: String(t[2]) }) : null);
    }));

    var panel;
    if (tab === 'revisions') {
      // switching revision here changes the hash only; onRoute keeps the scroll where it was
      panel = h('div', { class: 'revlist' }, d.revisions.slice().reverse().map(function (x) {
        var flags = (x.rev === cur.rev ? ' · current' : '') + (owner && x.public ? ' · public' : '');
        return rowEl('cols-rev' + (x.rev === r.rev ? ' sel' : ''), [
          h('span', { class: 'num', text: x.rev }),
          h('span', { class: 'date', text: x.date }),
          h('span', { class: 'revnote' + (x.note ? '' : ' none') }, x.note || 'No note', flags ? h('span', { class: 'flags', text: flags }) : null)
        ], function () { go(docRoute(d, x.rev)); });
      }));
    } else if (tab === 'edits') {
      panel = h('div', { class: 'stack' }, editsTab(d, r));
    } else if (tab === 'share') {
      panel = h('div', { class: 'stack sharetab' },
        h('div', { class: 'btnrow' },
          btn('Public link', function () { openShare('public', { number: d.number, rev: r.rev }); }),
          btn('Private link', function () { openShare('private', { number: d.number, rev: r.rev }); }),
          btn('Signed-in link', function () { openShare('signed-in', { number: d.number, rev: r.rev }); })),
        h('div', { class: 'linklist' }, links.map(function (l) { return linkRow(l, 'doc'); }),
          links.length ? null : h('p', { class: 'empty', text: 'No links yet. Only you and whoever its groups include can open it.' })),
        h('a', { class: 'textlink', href: '#/sharing', text: 'All links on the Sharing page' }));
    } else if (tab === 'packages') {
      panel = h('div', { class: 'stack-s' }, packagesTab(d));
    } else {
      // no one but the owner is ever shown who else can open it
      var record = h('dl', { class: 'record' },
        h('dt', { text: 'Project' }), h('dd', null, h('span', { class: 'mono', text: p.number }), ' ' + p.name),
        h('dt', { text: 'Source' }), h('dd', { class: 'code', text: d.source || '' }),
        owner && d.access && d.access.length ? [h('dt', { text: 'Visible to' }), h('dd', { text: d.access.map(person).join(', ') })] : null,
        h('dt', { text: 'File' }), h('dd', { class: 'code', text: file }));
      if (r.describes) add(record, [h('dt', { text: 'Describes' }), h('dd', { class: 'code', text: r.describes })]);
      // the kept source: the owner's alone, and only where cc-docs kept one for this revision
      if (owner) {
        add(record, [h('dt', { text: 'Kept source' }), h('dd', null, r.source
          ? h('a', { href: r.source, download: full + '-source.tar.gz', text: full + '-source.tar.gz' })
          : h('span', { class: 'sub inline', text: 'None kept for rev ' + r.rev }))]);
      }
      if (r.cost && r.cost.total != null && isFinite(r.cost.total)) {
        var steps = (r.cost.steps || []).filter(function (s) { return s && s.step && s.usd != null; })
          .map(function (s) { return s.step + ' ' + usd(s.usd); }).join(' · ');
        add(record, [h('dt', { text: 'Cost to make' }),
          h('dd', null, h('span', { class: 'mono', text: usd(r.cost.total) }), steps ? h('span', { class: 'cost-steps', text: steps }) : null)]);
      }
      if (owner) {
        var pages = d.linked_from || [];
        add(record, [h('dt', { text: 'Linked from' }), h('dd', null, pages.length ? pages.map(function (pg) {
          return h('span', { class: 'code block', text: pg.site + ' ' + pg.path });
        }) : h('span', { class: 'sub inline', text: 'No site has reported a link to it.' }))]);
      }
      panel = record;
    }

    return h('div', { class: 'page' },
      h('div', { class: 'dochead' },
        crumbs([h('a', { href: '#/p/' + p.number }, h('span', { class: 'mono', text: p.number }), ' ' + p.name),
          h('span', { class: 'mono', text: d.number })]),
        h('div', { class: 'titlerow' },
          h('div', { class: 'lead' },
            h('div', { class: 'docnum', text: full + (r.describes ? ' · ' + r.describes : '') }),
            h('h1', { class: 'doc-title', text: d.title }),
            descLine(d)),
          h('div', { class: 'actions' },
            h('button', { type: 'button', class: 'btn btn-ghost', 'aria-pressed': d.starred ? 'true' : 'false',
              text: d.starred ? '★ Starred' : '☆ Star', onclick: function () { toggleStar(d); } }),
            h('button', { type: 'button', class: 'btn btn-ghost fullbtn', 'aria-pressed': 'false', title: 'Fill the screen with the PDF',
              text: 'Full screen', onclick: function () { setFull(true); } }),
            owner ? btn('Duplicate', function () { openNewDoc(d.project, d.number, r.rev); }, { cls: 'btn-ghost btn-md' }) : null,
            newTab, download,
            // the editor opens the current revision's kept source: with none kept there is nothing to open
            owner && cur.source ? h('a', { class: 'btn btn-primary', href: '#/edit/' + d.number, text: 'Edit source' }) : null,
            errFor('star:' + d.number))),
        isCur ? null : h('aside', { class: 'callout' },
          h('span', { class: 'callout-label', text: 'Superseded' }),
          h('div', { class: 'callout-body' },
            'You are reading rev ' + r.rev + '. The current revision is ' + cur.rev + ', from ' + cur.date + '. ',
            h('a', { href: hashFor(docRoute(d)), text: 'Open ' + d.number + '-' + cur.rev })))),
      h('div', { class: 'docbody' }, viewer,
        h('aside', { class: 'side' }, tabBar, h('div', { class: 'tabpanel', role: 'tabpanel' }, panel))));
  }

  // ---- Packages ----
  // pk.documents is [{number, rev, folder, desc_mode, description}]; rev null follows the newest revision. A change
  // to one entry sends the whole entry, so a new pin doesn't drop its folder or description.
  function entryBody(x, patch) {
    var e = { number: x.number, add: true, rev: x.rev || null, folder: x.folder || null,
      desc_mode: x.desc_mode || 'doc', description: x.description || '' };
    for (var k in patch || {}) e[k] = patch[k];
    return e;
  }
  // A locked package's documents and folders are frozen with it: these writes stop here (the server says 409 too).
  function saveEntry(pk, x, patch, onOk) {
    if (pk.locked) return;
    mutate('pkg:' + pk.id, '/api/packages/' + pk.id + '/documents', entryBody(x, patch),
      'Couldn’t change the package. Nothing changed.', onOk);
  }
  function addEntry(pk, num, rev, folder) {
    if (pk.locked) return;
    mutate('pkg:' + pk.id, '/api/packages/' + pk.id + '/documents', { number: num, add: true, rev: rev || null, folder: folder || null },
      'Couldn’t add it. Nothing changed.');
  }
  function removeEntry(pk, num) {
    if (pk.locked) return;
    mutate('pkg:' + pk.id, '/api/packages/' + pk.id + '/documents', { number: num, add: false },
      'Couldn’t remove it. It’s still in the package.');
  }

  // A package's folders as a tree. A folder whose parent is gone sits at the top rather than vanishing.
  function pkgTree(pk) {
    var folders = pk.folders || [], docs = pk.documents || [];
    var ids = {};
    folders.forEach(function (f) { ids[f.id] = f; });
    function parentOf(f) { return f.parent && ids[f.parent] && f.parent !== f.id ? f.parent : null; }
    function folderOf(x) { return x.folder && ids[x.folder] ? x.folder : null; }
    var t = {
      parentOf: parentOf,
      folderOf: folderOf,
      folders: function (fid) { return folders.filter(function (f) { return parentOf(f) === fid; }).sort(byName); },
      entries: function (fid) { return docs.filter(function (x) { return folderOf(x) === fid; }).sort(byNumber); },
      count: function (fid, depth) {
        depth = depth || 0;
        if (depth > 50) return 0;
        return t.entries(fid).length + t.folders(fid).reduce(function (n, f) { return n + t.count(f.id, depth + 1); }, 0);
      },
      // is folder a (or a folder inside it) folder b?
      under: function (a, b) {
        for (var i = 0, cur = a; cur && i < 60; i++) { if (cur === b) return true; cur = ids[cur] ? parentOf(ids[cur]) : null; }
        return false;
      }
    };
    return t;
  }

  // What a package page shows beside each title, when the server sends no settings of its own.
  var SHOW = [{ k: 'number', label: 'Number' }, { k: 'rev', label: 'Revision' }, { k: 'date', label: 'Date' }, { k: 'note', label: 'Note' }];
  var SHOW_DEFAULT = { number: false, rev: false, date: true, note: false, collapsed: false };
  var DESC_MODES = [{ v: 'doc', label: 'Document’s description' }, { v: 'custom', label: 'One for this package' }, { v: 'none', label: 'No description' }];
  function setting(pk, k) { var st = pk.settings || {}; return k in st ? !!st[k] : SHOW_DEFAULT[k]; }

  // Drag and drop: every row of the tree moves by dragging. Onto a folder puts it inside; onto a document puts it
  // beside that document, in the same folder; onto the dashed zone lifts it to the top level.
  // Where `drag` would land dropped on `on` ({folder: fid} or {doc: entry}); null where it can't.
  function dropTarget(pk, tree, on) {
    if (!drag || drag.pkg !== pk.id || pk.locked) return null;
    var into = on.top ? null : on.folder ? on.folder : tree.folderOf(on.doc);
    if (drag.kind === 'doc') {
      var x = pkgEntry(pk, drag.id);
      if (!x || (on.doc && on.doc.number === x.number)) return null;
      return tree.folderOf(x) === into ? null : { folder: into };
    }
    var f = (pk.folders || []).find(function (y) { return y.id === drag.id; });
    if (!f || (into && tree.under(into, f.id))) return null;   // not into itself or a folder inside it
    return tree.parentOf(f) === into ? null : { folder: into };
  }
  function dropOn(pk, tree, on) {
    var t = dropTarget(pk, tree, on);
    var d = drag;
    endDrag();
    if (!t) return;
    if (t.folder) setOpen('kfc:' + pk.id + ':' + t.folder, false);
    if (d.kind === 'doc') saveEntry(pk, pkgEntry(pk, d.id), { folder: t.folder });
    else mutate('pkg:' + pk.id, '/api/packages/' + pk.id + '/folders/' + d.id, { parent: t.folder }, 'Couldn’t move the folder. Nothing changed.');
  }
  function endDrag() {
    drag = null;
    document.querySelectorAll('.dragging, .drop-into, .drop-above, .dragsrc').forEach(function (el) {
      el.classList.remove('dragging', 'drop-into', 'drop-above', 'dragsrc');
    });
  }
  // The DOM is left alone while a drag runs (a re-render would drop the row being dragged): classes only.
  function draggable(el, pk, tree, kind, id, on) {
    el.setAttribute('draggable', pk.locked ? 'false' : 'true');
    el.addEventListener('dragstart', function (e) {
      if (pk.locked) { e.preventDefault(); return; }
      e.stopPropagation();
      drag = { kind: kind, id: id, pkg: pk.id };
      try { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', kind + ':' + id); } catch (er) { /* old browsers */ }
      el.classList.add('dragsrc');
      var tr = el.closest('.pkgtree');
      if (tr) tr.classList.add('dragging');
    });
    el.addEventListener('dragend', endDrag);
    el.addEventListener('dragover', function (e) {
      if (!drag || !dropTarget(pk, tree, on)) return;
      e.preventDefault();
      e.stopPropagation();
      try { e.dataTransfer.dropEffect = 'move'; } catch (er) { /* fine */ }
      el.classList.add(on.doc ? 'drop-above' : 'drop-into');
    });
    el.addEventListener('dragleave', function (e) {
      if (!el.contains(e.relatedTarget)) el.classList.remove('drop-above', 'drop-into');
    });
    el.addEventListener('drop', function (e) { e.preventDefault(); e.stopPropagation(); dropOn(pk, tree, on); });
    return el;
  }

  // One document in a package: its pinned revision and what description the visitor sees.
  function entryRow(pk, tree, x, depth) {
    var key = 'pkg:' + pk.id, busy = !!state.pending[key];
    var d = docByNum(x.number);
    if (!d) {
      return vars(h('div', { class: 'entry' }, h('div', { class: 'entryhead' }, h('span', { class: 'num', text: x.number }),
        h('span', { class: 'sub inline grow', text: 'Not in the register any more' }),
        textBtn('Remove', function () { removeEntry(pk, x.number); }, { disabled: busy }))), { '--depth': depth });
    }
    var mode = x.desc_mode || 'doc';
    var dkey = 'kdesc:' + pk.id + ':' + x.number;
    var shown = mode === 'doc' ? (d.description || '') : '';
    var custom = null;
    if (mode === 'custom') {
      var count = h('span', { class: 'counter' });
      var di = draft(dkey, { maxlength: '200', value: x.description || '', placeholder: 'A line for this package', draggable: 'false',
        'aria-label': 'Description of ' + d.number + ' in ' + pk.name });
      var upd = function () { count.textContent = di.value.length + '/200'; };
      di.addEventListener('input', upd);
      upd();
      di.addEventListener('dragstart', function (e) { e.preventDefault(); e.stopPropagation(); });
      custom = h('form', { class: 'line entrydesc', onsubmit: function (e) {
        e.preventDefault();
        saveEntry(pk, x, { desc_mode: 'custom', description: di.value.trim().replace(/\s+/g, ' ') }, function () { delete drafts[dkey]; });
      } }, di, count, btn('Save', null, { submit: true, disabled: busy }));
    }
    var el = h('div', { class: 'entry' },
      h('div', { class: 'entryhead' },
        h('span', { class: 'handle', 'aria-hidden': 'true', text: '⋮⋮' }),
        h('span', { class: 'num', text: d.number + '-' + revOf(d, x.rev).rev }),
        h('a', { class: 'title grow', href: hashFor(docRoute(d, x.rev)), draggable: 'false', text: d.title }),
        textBtn('Remove', function () { removeEntry(pk, d.number); }, { disabled: busy, label: 'Remove ' + d.number })),
      h('div', { class: 'entryctl' },
        revSelect(d, x.rev, 'Revision of ' + d.number + ' in ' + pk.name, function (rev) { saveEntry(pk, x, { rev: rev }); }, busy),
        h('select', { class: 'input sel', 'aria-label': 'Description of ' + d.number + ' in ' + pk.name, disabled: busy,
          onchange: function (e) { saveEntry(pk, x, { desc_mode: e.target.value }); } },
          DESC_MODES.map(function (o) { return h('option', { value: o.v, selected: o.v === mode, text: o.label }); }))),
      custom,
      mode !== 'custom' ? h('span', { class: 'sub entrydesc', text: shown || (mode === 'none' ? 'Visitors see no description.' : 'The document has no description yet.') }) : null);
    vars(el, { '--depth': depth });
    el.setAttribute('data-number', d.number);
    return draggable(el, pk, tree, 'doc', d.number, { doc: x });
  }

  // A folder: a fold with its deep count, and the owner's rename, new folder inside and delete.
  function folderRows(pk, tree, f, depth) {
    var key = 'pkg:' + pk.id, busy = !!state.pending[key];
    var fk = 'kfc:' + pk.id + ':' + f.id, open = !isOpen(fk);
    var ed = state.editing && state.editing.indexOf('folder:' + pk.id + ':' + f.id + ':') === 0 ? state.editing.split(':').pop() : null;
    var fpath = '/api/packages/' + pk.id + '/folders/' + f.id;
    var close = function () { state.editing = null; };
    var editor = null;
    if (ed === 'rename' || ed === 'new') {
      var did = 'fold:' + pk.id + ':' + f.id + ':' + ed;
      var fi = escClose(draft(did, { maxlength: '80', value: ed === 'rename' ? f.name : '',
        placeholder: ed === 'rename' ? 'Folder name' : 'New folder inside ' + f.name, 'aria-label': ed === 'rename' ? 'New name for ' + f.name : 'Name of a folder inside ' + f.name }), close);
      focusSoon(fi);
      editor = vars(h('form', { class: 'line folderedit', onsubmit: function (e) {
        e.preventDefault();
        var v = fi.value.trim();
        if (!v) { fi.focus(); return; }
        var done = function () { close(); delete drafts[did]; if (ed === 'new') setOpen(fk, false); };
        if (pk.locked) return;
        if (ed === 'rename') mutate(key, fpath, { name: v }, 'Couldn’t rename the folder. Nothing changed.', done);
        else mutate(key, '/api/packages/' + pk.id + '/folders', { name: v, parent: f.id }, 'Couldn’t make the folder. Nothing changed.', done);
      } }, fi, btn(ed === 'rename' ? 'Save' : 'Make folder', null, { submit: true, disabled: busy }),
        btn('Cancel', function () { close(); render(); }, { cls: 'btn-ghost' })), { '--depth': depth });
    }
    var cdel = 'folder:' + pk.id + ':' + f.id;
    var edit = function (op) { return function () { state.editing = 'folder:' + pk.id + ':' + f.id + ':' + op; render(); }; };
    var n = tree.count(f.id);
    var row = h('div', { class: 'folderrow' },
      h('span', { class: 'handle', 'aria-hidden': 'true', text: '⋮⋮' }),
      h('button', { type: 'button', class: 'foldbtn', 'aria-expanded': open ? 'true' : 'false', draggable: 'false',
        onclick: function () { toggleOpen(fk); } }, caret(open), h('span', { class: 'foldername', text: f.name }),
        h('span', { class: 'fold-count', text: '(' + n + ')' })),
      h('span', { class: 'grow' }),
      h('span', { class: 'folderacts' },
        textBtn('Rename', edit('rename'), { disabled: busy, label: 'Rename ' + f.name }),
        textBtn('New folder inside', edit('new'), { disabled: busy, label: 'New folder inside ' + f.name }),
        textBtn('Delete', function () { state.confirmDel = cdel; render(); }, { disabled: busy, label: 'Delete ' + f.name })));
    vars(row, { '--depth': depth });
    row.setAttribute('data-folder', f.name);
    draggable(row, pk, tree, 'folder', f.id, { folder: f.id });
    return [row, editor,
      state.confirmDel === cdel ? vars(h('div', { class: 'folderedit' }, confirmBox('Delete this folder?',
        'Its documents and folders move up into ' + (tree.parentOf(f) ? 'the folder above' : 'the top level') + '. Nothing leaves the package.',
        'Delete folder', function () { if (!pk.locked) mutate(key, fpath, { delete: true }, 'Couldn’t delete the folder. Nothing changed.'); })), { '--depth': depth }) : null,
      open ? pkgLevel(pk, tree, f.id, depth + 1) : null];
  }
  // A level of the tree: its own documents first, then its folders.
  function pkgLevel(pk, tree, fid, depth) {
    if (depth > 50) return null;
    return [tree.entries(fid).map(function (x) { return entryRow(pk, tree, x, depth); }),
      tree.folders(fid).map(function (f) { return folderRows(pk, tree, f, depth); })];
  }

  // The selected package: name, what visitors see, how its folders start, its documents, links and history.
  function pkgDetail(pk) {
    var key = 'pkg:' + pk.id, busy = !!state.pending[key];
    var tree = pkgTree(pk);
    var n = (pk.documents || []).length;
    var plinks = pkgLinks(pk.id).filter(function (l) { return stateOf(l) !== 'archived'; });
    var livePub = plinks.find(function (l) { return stateOf(l) === 'live' && kindOf(l) === 'public'; });
    var nlive = plinks.filter(function (l) { return stateOf(l) === 'live'; }).length;

    var locked = !!pk.locked;
    var head;
    if (state.editing === key && !locked) {
      var rn = escClose(draft('rn:' + key, { maxlength: '80', value: pk.name, 'aria-label': 'New name for ' + pk.name }),
        function () { state.editing = null; });
      focusSoon(rn);
      head = h('form', { class: 'line', onsubmit: function (e) {
        e.preventDefault();
        var v = rn.value.trim();
        if (!v) { rn.focus(); return; }
        mutate(key, '/api/packages/' + pk.id, { name: v }, 'Couldn’t rename it. Nothing changed.',
          function () { state.editing = null; delete drafts['rn:' + key]; });
      } }, rn, btn('Save', null, { submit: true, disabled: busy }),
        btn('Cancel', function () { state.editing = null; render(); }, { cls: 'btn-ghost' }));
    } else {
      head = h('div', { class: 'pkghead' },
        h('h2', { class: 'pkgname', text: pk.name }),
        h('span', { class: 'meta mono', text: plural(n, 'doc') + ' · ' + plural(nlive, 'live link') + (pk.created ? ' · made ' + String(pk.created).slice(0, 10) : '') }),
        h('span', { class: 'grow' }),
        locked ? null : btn('Rename', function () { state.editing = key; render(); }, { cls: 'btn-ghost', disabled: busy }),
        livePub ? h('a', { class: 'btn btn-sm btn-ghost', href: livePub.url, target: '_blank', rel: 'noopener', text: 'See the public page' })
          : h('span', { class: 'sub inline', text: 'Make a public link to see its page' }),
        lockCtl(pk, key, '/api/packages/' + pk.id, 'package'));
    }

    var shows = h('div', { class: 'line wrap' }, h('span', { class: 'label', text: 'Visitors see' }), SHOW.map(function (o) {
      var on = setting(pk, o.k);
      return h('button', { type: 'button', class: 'chipbtn', 'aria-pressed': on ? 'true' : 'false', disabled: busy, text: o.label,
        onclick: function () {
          if (locked) return;
          var body = {};
          body[o.k] = !on;
          mutate(key, '/api/packages/' + pk.id, { settings: body }, 'Couldn’t change what it shows. Nothing changed.');
        } });
    }));
    var folds = h('div', { class: 'line wrap' }, h('span', { class: 'label', text: 'Folders on the public page start' }),
      seg([{ value: 'open', label: 'Open' }, { value: 'collapsed', label: 'Collapsed' }], setting(pk, 'collapsed') ? 'collapsed' : 'open',
        function (v) { if (!locked) mutate(key, '/api/packages/' + pk.id, { settings: { collapsed: v === 'collapsed' } }, 'Couldn’t change how its folders start. Nothing changed.'); },
        'seg-fold', busy));

    var others = state.data.documents.filter(function (d) { return !pkgEntry(pk, d.number); }).sort(byNumber);
    var pick = h('select', { class: 'input', 'aria-label': 'Document to add to ' + pk.name },
      h('option', { value: '', text: 'Add a document…' }),
      others.map(function (d) { return h('option', { value: d.number, text: d.number + ' ' + d.title }); }));
    var nf = draft('nf:' + pk.id, { maxlength: '80', placeholder: 'New folder', 'aria-label': 'Name of a new folder in ' + pk.name });
    var topZone = h('div', { class: 'dropzone', text: 'Drop here to move to the top level' });
    topZone.addEventListener('dragover', function (e) {
      if (!drag || !dropTarget(pk, tree, { top: true })) return;
      e.preventDefault();
      topZone.classList.add('drop-into');
    });
    topZone.addEventListener('dragleave', function () { topZone.classList.remove('drop-into'); });
    topZone.addEventListener('drop', function (e) { e.preventDefault(); dropOn(pk, tree, { top: true }); });

    var docsSec = h('section', { class: 'stack-s' },
      label('Documents · ' + n, 'rule'),
      n || (pk.folders || []).length ? h('span', { class: 'hint', text: 'Drag a document or folder onto a folder to move it in, or onto a document to put it beside that one.' }) : null,
      h('div', { class: 'pkgtree' }, pkgLevel(pk, tree, null, 0), topZone),
      n || (pk.folders || []).length ? null : h('p', { class: 'empty', text: 'Empty. Add a document below or from its page.' }),
      h('div', { class: 'line' }, pick, btn('Add', function () { if (pick.value) addEntry(pk, pick.value, null); }, { disabled: busy })),
      h('form', { class: 'line', onsubmit: function (e) {
        e.preventDefault();
        var v = nf.value.trim();
        if (!v) { nf.focus(); return; }
        if (locked) return;
        mutate(key, '/api/packages/' + pk.id + '/folders', { name: v, parent: null }, 'Couldn’t make the folder. Nothing changed.',
          function () { delete drafts['nf:' + pk.id]; });
      } }, nf, btn('New folder', null, { submit: true, cls: 'btn-ghost', disabled: busy })));

    var linksSec = h('section', { class: 'stack-s' }, label('Links · ' + plinks.length, 'rule'),
      h('div', { class: 'linklist' }, plinks.map(function (l) { return linkRow(l, 'pkg'); })),
      h('div', { class: 'btnrow' },
        btn('Public link', function () { openShare('public', { package: pk.id }); }),
        btn('Private link', function () { openShare('private', { package: pk.id }); })));

    // locked: what visitors see, how folders start and the whole tree are frozen; links, history and the page still work
    return h('section', { class: 'pkgdetail' },
      state.narrow ? h('a', { class: 'textlink back', href: '#/k', text: '← All packages' }) : null,
      head,
      locked ? h('p', { class: 'lockline', text: 'Locked. Documents, folders, revisions, descriptions and what visitors see stay as they are until you unlock it.' }) : null,
      errFor(key),
      frozen(locked, 'pkgfrozen', [shows, folds, docsSec]),
      linksSec,
      h('section', { class: 'stack-s' }, label('History', 'rule'), historyList(pk.history)),
      locked ? null : state.confirmDel === key
        ? confirmBox('Archive this package?', 'Its page and all its links stop answering at once. It stays listed under Archived, and Restore brings it back with the same links.',
          'Archive package', function () {
            mutate(key, '/api/packages/' + pk.id, { archived: true }, 'Couldn’t archive it. Its links still work.', function () { location.hash = '#/k'; });
          })
        : h('div', { class: 'btnrow' }, btn('Archive package', function () { state.confirmDel = key; render(); }, { cls: 'btn-ghost', disabled: busy })));
  }

  // Packages: a named set of documents in folders, each its most recent revision or one pinned here, reached through
  // its own links. Two panes; on a phone the list drills down to one package.
  function renderPackages() {
    var live = livePackages().slice().sort(function (a, b) { return String(a.created || '').localeCompare(String(b.created || '')) || byName(a, b); });
    var picked = state.route.pkg ? live.find(function (pk) { return pk.id === state.route.pkg; }) : null;
    var sel = picked || (state.narrow ? null : live[0]);
    var nameIn = draft('pkg:new', { maxlength: '80', placeholder: 'Name, e.g. For the bank', 'aria-label': 'Name of the new package' });
    var list = h('section', { class: 'pkglist' },
      h('form', { class: 'line', onsubmit: function (e) {
        e.preventDefault();
        var v = nameIn.value.trim();
        if (!v) { nameIn.focus(); return; }
        mutate('pkg:new', '/api/packages', { name: v }, 'Couldn’t make the package. Nothing changed.', function (pk) {
          delete drafts['pkg:new'];
          if (pk && pk.id) location.hash = '#/k/' + pk.id;
        });
      } }, nameIn, btn(state.pending['pkg:new'] ? 'Making…' : 'New', null, { submit: true, disabled: !!state.pending['pkg:new'] })),
      errFor('pkg:new'),
      h('div', { class: 'pkgrows' }, live.map(function (pk) {
        var nl = pkgLinks(pk.id).filter(function (l) { return stateOf(l) === 'live'; }).length;
        return h('a', { class: 'pkgrow' + (sel === pk ? ' sel' : ''), href: '#/k/' + pk.id, 'aria-current': sel === pk ? 'true' : null },
          h('span', { class: 'title', text: pk.name }),
          h('span', { class: 'meta mono', text: plural((pk.documents || []).length, 'doc') + ' · ' + plural(nl, 'live link') }));
      }), live.length ? null : h('p', { class: 'empty', text: 'No packages yet.' })));
    var showList = !state.narrow || !sel;
    return h('div', { class: 'page' }, crumbs([h('span', { text: 'Packages' })]),
      pageHead('Packages', 'Whoever has one of a package’s links sees the documents in it and nothing else, each at its pinned revision or the most recent. Archived packages are on the Sharing page.'),
      h('div', { class: 'panes' }, showList ? list : null, sel ? pkgDetail(sel) : null));
  }

  // ---- Groups: who sees what, as a tree ----
  // The tree the grants are made on: group > project > sub-project > document.
  function grantTree() {
    var projs = state.data.projects.slice().sort(byNumber);
    function parentOf(p) {
      if (p.parent !== undefined) return p.parent && projByNum(p.parent) ? p.parent : null;
      if (!p.group) return null;
      var q = projs.find(function (x) { return x.name === p.group && x.number !== p.number; });
      return q ? q.number : null;
    }
    function freeGroupOf(p) { return p.group && !parentOf(p) ? p.group : null; }
    var tops = [], seen = {};
    projs.forEach(function (p) {
      var g = freeGroupOf(p);
      if (g) { if (!seen[g]) { seen[g] = true; tops.push({ node: 'group:' + g, num: '', label: g, sub: 'group' }); } }
      else if (!parentOf(p)) tops.push({ node: 'project:' + p.number, num: p.number, label: p.name });
    });
    function children(node) {
      var m = /^(group|project):(.*)$/.exec(node);
      if (!m) return [];
      if (m[1] === 'group') {
        return projs.filter(function (p) { return freeGroupOf(p) === m[2]; })
          .map(function (p) { return { node: 'project:' + p.number, num: p.number, label: p.name }; });
      }
      return projs.filter(function (p) { return parentOf(p) === m[2] && p.number !== m[2]; })
        .map(function (p) { return { node: 'project:' + p.number, num: p.number, label: p.name, sub: 'sub-project' }; })
        .concat(state.data.documents.filter(function (d) { return d.project === m[2]; }).sort(byNumber)
          .map(function (d) { return { node: 'doc:' + d.number, num: d.number, label: d.title, leaf: true }; }));
    }
    return { tops: tops, children: children };
  }

  function grantEditor(g) {
    var key = 'grp:' + g.id, busy = !!state.pending[key];
    var granted = {};
    (g.grants || []).forEach(function (n) { granted[n] = true; });
    var tree = grantTree();
    function nodeRow(n, depth, by) {
      var kids = n.leaf ? [] : tree.children(n.node);
      var tk = 'gt:' + g.id + ':' + n.node, open = isOpen(tk);
      var own = !!granted[n.node];
      var implied = !own && by;
      var row = vars(h('div', { class: 'tnode' + (n.leaf ? ' leaf' : '') },
        kids.length ? h('button', { type: 'button', class: 'tmark', 'aria-expanded': open ? 'true' : 'false',
          'aria-label': (open ? 'Close ' : 'Open ') + n.label, text: open ? '▾' : '▸', onclick: function () { toggleOpen(tk); } })
          : h('span', { class: 'tmark' }),
        h('label', { class: 'check', title: implied ? 'Included by ' + by : null },
          h('input', { type: 'checkbox', checked: own || !!implied, disabled: busy || !!implied, onchange: function () {
            if (g.locked) return;
            mutate(key, '/api/groups/' + g.id, own ? { revoke: n.node } : { grant: n.node },
              own ? 'Couldn’t take it back. They still see it.' : 'Couldn’t grant it. Nothing changed.');
          } }),
          n.num ? h('span', { class: 'mono', text: n.num }) : null,
          h('span', { text: n.label }),
          n.sub ? h('span', { class: 'sub inline', text: n.sub }) : null,
          !n.leaf && kids.length ? h('span', { class: 'sub inline', text: '(' + kids.length + ')' }) : null)), { '--depth': depth });
      return [row, open ? kids.map(function (c) { return nodeRow(c, depth + 1, by || (own ? n.label : null)); }) : null];
    }
    return h('div', { class: 'tree' },
      tree.tops.map(function (n) { return nodeRow(n, 0, null); }),
      h('p', { class: 'hint', text: 'Ticking a project gives everything under it, including documents filed later. A document gives that one.' }));
  }

  // A group: folded by default; open, its people beside what it sees.
  function groupBlock(g) {
    var key = 'grp:' + g.id, busy = !!state.pending[key];
    var okey = 'g:' + g.id, open = isOpen(okey);
    var members = g.members || [];
    var locked = !!g.locked;
    // shut, a locked group shows the padlock after its meta; open, the lock control sits where Rename · Delete group is
    var head = h('div', { class: 'grouphead' },
      h('button', { type: 'button', class: 'foldbtn', 'aria-expanded': open ? 'true' : 'false', onclick: function () { toggleOpen(okey); } },
        caret(open), h('span', { class: 'groupname', text: g.name }),
        h('span', { class: 'meta mono', text: plural(members.length, 'person', 'people') + ' · ' + plural((g.grants || []).length, 'grant') }),
        locked && !open ? h('span', { class: 'padlock', title: 'Locked' }, padlock()) : null),
      open ? h('span', { class: 'groupacts' },
        locked || state.editing === key ? null : h('span', { class: 'folderacts' },
          textBtn('Rename', function () { state.editing = key; render(); }, { disabled: busy, label: 'Rename ' + g.name }),
          textBtn('Delete group', function () { state.confirmDel = key; render(); }, { disabled: busy, label: 'Delete ' + g.name })),
        lockCtl(g, key, '/api/groups/' + g.id, 'group')) : null);
    if (!open) return h('section', { class: 'group' }, head, errFor(key));
    var rename = null;
    if (state.editing === key && !locked) {
      var rn = escClose(draft('rn:' + key, { maxlength: '80', value: g.name, 'aria-label': 'New name for ' + g.name }),
        function () { state.editing = null; });
      focusSoon(rn);
      rename = h('form', { class: 'line', onsubmit: function (e) {
        e.preventDefault();
        var v = rn.value.trim();
        if (!v) { rn.focus(); return; }
        mutate(key, '/api/groups/' + g.id, { name: v }, 'Couldn’t rename it. Nothing changed.',
          function () { state.editing = null; delete drafts['rn:' + key]; });
      } }, rn, btn('Save', null, { submit: true, disabled: busy }),
        btn('Cancel', function () { state.editing = null; render(); }, { cls: 'btn-ghost' }));
    }
    var people = h('div', { class: 'groupcol' }, label('People', 'rule-soft'),
      members.map(function (m) {
        return h('div', { class: 'member' }, h('span', { class: 'cell' }, h('span', { text: m.name || m.email }), h('span', { class: 'sub', text: m.email })),
          textBtn('Remove', function () {
            if (locked) return;
            mutate(key, '/api/groups/' + g.id, { remove: m.email }, 'Couldn’t remove ' + m.email + '. Nothing changed.');
          }, { disabled: busy, label: 'Remove ' + (m.name || m.email) + ' from ' + g.name }));
      }), members.length ? null : h('p', { class: 'empty', text: 'Nobody in it yet.' }),
      personForm('gp:' + g.id, busy, members.map(function (m) { return m.email; }), function (p, done) {
        if (locked) return;
        var body = { add: { email: p.email } };
        if (p.name) body.add.name = p.name;
        mutate(key, '/api/groups/' + g.id, body, 'Couldn’t add ' + p.email + '. Nothing changed.', done);
      }, 'Add a person by email'));
    var sees = h('div', { class: 'groupcol wide' }, label('What it sees', 'rule-soft'), grantEditor(g));
    // locked: its people and what it sees are frozen (choosing it on a private link still works: that changes the link)
    return h('section', { class: 'group open' }, head, rename,
      state.confirmDel === key && !locked
        ? confirmBox('Delete this group?', 'Its people lose what it gave them at once, unless another group or a private link still gives it.',
          'Delete group', function () { mutate(key, '/api/groups/' + g.id, { delete: true }, 'Couldn’t delete it. Nothing changed.'); })
        : null,
      frozen(locked, 'groupbody', [people, sees]), errFor(key));
  }

  function groupsBody() {
    var nameIn = draft('grp:new', { maxlength: '80', placeholder: 'Name, e.g. Garden club', 'aria-label': 'Name of the new group' });
    return [h('p', { class: 'note', text: 'A group’s people sign in to the library and see what the group is given. Adding someone puts their email on the Access list.' }),
      groups().slice().sort(byName).map(groupBlock),
      h('form', { class: 'line narrowform', onsubmit: function (e) {
        e.preventDefault();
        var v = nameIn.value.trim();
        if (!v) { nameIn.focus(); return; }
        mutate('grp:new', '/api/groups', { name: v }, 'Couldn’t make the group. Nothing changed.', function (g) {
          delete drafts['grp:new'];
          if (g && g.id) setOpen('g:' + g.id, true);
        });
      } }, nameIn, btn('New group', null, { submit: true, disabled: !!state.pending['grp:new'] })),
      errFor('grp:new')];
  }

  // Everyone the library knows, with how they get in and where Access stands for them.
  function peopleBody() {
    var dir = directory().slice().sort(function (a, b) { return (a.name || a.email).localeCompare(b.name || b.email); });
    if (!dir.length) return h('p', { class: 'empty', text: 'Nobody but you yet.' });
    var manual = accessManual();
    return h('div', { class: 'rows' }, dir.map(function (p) {
      var gs = groups().filter(function (g) { return (g.members || []).some(function (m) { return m.email === p.email; }); })
        .map(function (g) { return g.name; });
      var nl = allLinks().filter(function (l) { return stateOf(l) === 'live' && kindOf(l) === 'private' && (l.people || []).indexOf(p.email) >= 0; }).length;
      var how = [gs.length ? gs.join(', ') : null, nl ? plural(nl, 'private link') : null].filter(Boolean).join(' · ') || 'No access now';
      var byHand = manual.indexOf(p.email) >= 0;
      return h('div', { class: 'person' },
        h('span', { class: 'cell' }, h('span', { class: 'title', text: p.name || p.email }), h('span', { class: 'sub', text: p.email + ' · ' + how })),
        h('span', { class: 'line access ' + (byHand ? 'tone-accent' : 'tone-sage') }, dot(byHand ? 'accent' : 'sage'),
          byHand ? 'Add to Access by hand' : 'On the Access list'));
    }));
  }

  // Archived links and packages: nothing is lost, and Restore brings each back at the same address.
  // Each list starts folded, and stays as the owner leaves it.
  function archivedBody(links, pkgs) {
    if (!links.length && !pkgs.length) return h('p', { class: 'empty', text: 'Nothing archived.' });
    return h('div', { class: 'stack' },
      links.length ? foldSection('sh:archived-links', 'Archived links', links.length, function () { return archivedLinks(links); }) : null,
      pkgs.length ? foldSection('sh:archived-pkgs', 'Archived packages', pkgs.length, function () { return archivedPkgs(pkgs); }) : null);
  }
  function archivedPkgs(pkgs) {
    return h('div', { class: 'rows' }, pkgs.map(function (pk) {
      var key = 'pkg:' + pk.id, busy = !!state.pending[key];
      return h('div', { class: 'archived' },
        h('div', { class: 'line wrap' }, h('span', { class: 'title', text: pk.name }),
          h('span', { class: 'tags' }, tag('Package'), tag('Archived ' + when(pk.archived).slice(0, 10), 'accent')),
          h('span', { class: 'grow' }),
          btn('Restore', function () {
            mutate(key, '/api/packages/' + pk.id, { archived: false }, 'Couldn’t restore it. It’s still archived.');
          }, { disabled: busy, label: 'Restore ' + pk.name })),
        h('p', { class: 'note', text: plural((pk.documents || []).length, 'document') + ' · ' + plural(pkgLinks(pk.id).length, 'link') + '. Restore brings its page and links back.' }),
        historyList(pk.history),
        errFor(key));
    }));
  }
  function archivedLinks(links) {
    return h('div', { class: 'rows' }, links.map(function (l) {
      var key = 'link:' + l.id, busy = !!state.pending[key];
      return h('div', { class: 'archived link off' },
        h('div', { class: 'line wrap' }, h('span', { class: 'linkname dead', text: l.name }), linkTags(l), h('span', { class: 'grow' }),
          l.locked ? lockCtl(l, key, '/api/links/' + l.id, 'link') : btn('Restore', function () {
            mutate(key, '/api/links/' + l.id, { state: 'live' }, 'Couldn’t restore it. It’s still archived.');
          }, { disabled: busy, label: 'Restore ' + l.name })),
        h('p', { class: 'note', text: 'Pointed at ' + targetText(l.target) + '. It answers “not found” until restored, at the same address.' }),
        historyList(l.history),
        errFor(key));
    }));
  }

  // The owner's page for sharing: every link, groups, people, and what was archived.
  function renderSharing() {
    var links = allLinks().slice().sort(linkOrder);
    var live = links.filter(function (l) { return stateOf(l) !== 'archived'; });
    var archLinks = links.filter(function (l) { return stateOf(l) === 'archived'; });
    var archPkgs = packages().filter(function (pk) { return pk.archived; });
    var tabs = [['links', 'Links', live.length], ['groups', 'Groups', groups().length], ['people', 'People', directory().length],
      ['archived', 'Archived', archLinks.length + archPkgs.length]];
    var cur = tabs.some(function (t) { return t[0] === state.shTab; }) ? state.shTab : 'links';
    var nav = h('nav', { class: 'shnav', role: 'tablist', 'aria-label': 'Sharing' }, tabs.map(function (t) {
      return h('button', { type: 'button', role: 'tab', class: 'shtab', 'aria-selected': t[0] === cur ? 'true' : 'false',
        onclick: function () { state.shTab = t[0]; store('library-shtab', t[0]); state.linkOpen = null; render(); } },
        h('span', { text: t[1] }), h('span', { class: 'mono tab-count', text: String(t[2]) }));
    }), h('a', { class: 'shtab', href: '#/k' }, h('span', { text: 'Packages →' })));
    var body;
    if (cur === 'links') {
      body = h('div', { class: 'linklist ruled' }, live.map(function (l) { return linkRow(l, 'sharing'); }),
        live.length ? null : h('p', { class: 'empty', text: 'No links. Make one from a document or a package.' }));
    } else if (cur === 'groups') body = h('div', { class: 'stack' }, groupsBody());
    else if (cur === 'people') body = peopleBody();
    else body = archivedBody(archLinks, archPkgs);
    return h('div', { class: 'page' }, crumbs([h('span', { text: 'Sharing' })]),
      pageHead('Sharing', 'You see everything. Groups give people parts of the library. Links give one document or package to whoever holds them.'),
      accessNotice(true),
      h('div', { class: 'shlayout' }, nav, h('section', { class: 'shbody', role: 'tabpanel' }, body)));
  }

  function renderSearch() {
    var q = state.q.trim();
    var res = search(q);
    var byProj = {};
    res.forEach(function (x) { (byProj[x.d.project] = byProj[x.d.project] || []).push(x); });
    var keys = Object.keys(byProj).sort();
    var n = res.length;
    return h('div', { class: 'page searchpage' },
      h('div', { class: 'stack-s' },
        h('span', { class: 'meta', text: n ? plural(n, 'document') + ' in ' + plural(keys.length, 'project') + (n === 1 ? ' · Enter opens it' : '') : 'No documents' }),
        h('h1', { class: 'searchq', text: '“' + q + '”' })),
      keys.map(function (pn) {
        var p = projByNum(pn) || { number: pn, name: '' };
        return h('section', { class: 'stack-0' },
          h('a', { class: 'ghead', href: '#/p/' + pn }, h('span', { class: 'mono', text: pn }), h('span', { class: 'label', text: p.name })),
          byProj[pn].sort(function (a, b) { return a.d.number.localeCompare(b.d.number); }).map(function (x) {
            return rowEl('hit', [h('span', { class: 'mono', text: x.d.number + '-' + x.rev }), h('span', { class: 'title', text: x.d.title }),
              h('span'), h('span', { class: 'sub', text: x.why })], function () { go(docRoute(x.d, x.rev)); });
          }));
      }),
      n ? null : h('p', { class: 'note', text: 'Nothing matches. Try a document number such as 200-0001, or fewer words.' }));
  }

  function renderPublishing(rt) {
    return h('div', { class: 'page' },
      h('p', { class: 'meta publishing' }, h('span', { class: 'mono', text: rt.num + '-' + rt.rev }),
        ' is still publishing. It opens here as soon as the library has it, usually within a minute or two. ',
        h('a', { href: '#/', text: 'Back to the library' })));
  }

  function renderMissing() {
    return h('div', { class: 'page' },
      h('p', { class: 'meta' }, 'Nothing is filed at this address. ', h('a', { href: '#/', text: 'Back to the library' })));
  }

  // ---- The editing mode: editor.js takes over <main> while the route is #/edit/… ----
  var editorOn = null;    // the edit key mounted, or null
  function unmountEditor() {
    if (!editorOn) return;
    editorOn = null;
    var E = window.LibraryEditor;
    try { if (E && typeof E.unmount === 'function') E.unmount(); } catch (e) { /* the editor's own trouble */ }
    document.body.classList.remove('editing');
    main.textContent = '';
  }
  function renderEditor() {
    var rt = state.route, k = editKey(rt);
    if (editorOn === k) return;
    var E = window.LibraryEditor;
    main.textContent = '';
    document.title = 'Editing · Library';
    if (!E || typeof E.mount !== 'function') {
      add(main, h('div', { class: 'page' }, h('p', { class: 'meta' }, 'The editor didn’t load. Reload the page to try again, or ',
        h('a', { href: rt.num ? '#/d/' + rt.num : '#/', text: rt.num ? 'go back to ' + rt.num : 'go back to the library' }), '.')));
      return;
    }
    editorOn = k;
    try {
      E.mount(main, {
        num: rt.num || null, draftId: rt.draft || null, data: state.data,
        go: function (hash) { location.hash = String(hash).charAt(0) === '#' ? hash : '#' + hash; },
        onExit: function (to) {
          load(true);
          location.hash = typeof to === 'string' && to ? to : rt.num ? '#/d/' + rt.num : '#/';
        }
      });
    } catch (e) {
      editorOn = null;
      document.body.classList.remove('editing');
      main.textContent = '';
      add(main, h('div', { class: 'page' }, h('p', { class: 'err', text: 'The editor failed to open (' + (e && e.message || e) + ').' })));
    }
  }

  var TITLES = { home: 'Library' };
  // The field that had the focus gets it back after a re-render, with its caret where it was.
  function render() {
    var ae = document.activeElement, fk = ae && ae.getAttribute ? ae.getAttribute('data-k') : null, sel = null;
    if (fk && typeof ae.selectionStart === 'number') { try { sel = [ae.selectionStart, ae.selectionEnd]; } catch (e) { sel = null; } }
    syncNav();
    if (state.route.name === 'edit' && state.data && !state.loadError) {
      renderDialog();
      renderEditor();
      return;
    }
    main.textContent = '';
    if (state.loadError) {
      add(main, h('p', { class: 'loading', text: state.loadError }));
      renderDialog();
      return;
    }
    if (!state.data) {
      add(main, h('p', { class: 'loading', text: 'Loading the register…' }));
      return;
    }
    var rt = state.route, view, title = TITLES.home;
    if (rt.name === 'home') view = renderHome();
    else if (rt.name === 'search') { view = renderSearch(); title = 'Search · Library'; }
    else if (rt.name === 'packages' && isOwner()) { view = renderPackages(); title = 'Packages · Library'; }
    else if (rt.name === 'sharing' && isOwner()) { view = renderSharing(); title = 'Sharing · Library'; }
    else if (rt.name === 'project') {
      var p = projByNum(rt.num);
      if (p) { view = renderProject(p); title = p.number + ' ' + p.name + ' · Library'; }
    } else if (rt.name === 'doc') {
      var d = docByNum(rt.num);
      var r = d && (rt.rev ? d.revisions.find(function (x) { return x.rev === rt.rev; }) : last(d));
      if (d && r) { waiting = null; view = renderDoc(d, r); title = d.number + '-' + r.rev + ' ' + d.title + ' · Library'; }
      else if (publishing(rt, d)) { view = renderPublishing(rt); title = rt.num + '-' + rt.rev + ' · Library'; }
    }
    if (!view) view = renderMissing();
    document.title = title;
    // the Sharing page carries its own notice; elsewhere it shows only right after a write asked for it
    if (rt.name !== 'sharing') add(main, accessNotice(false));
    add(main, view);
    renderDialog();
    if (fk) {
      var back = null;
      document.querySelectorAll('[data-k]').forEach(function (el) { if (!back && el.getAttribute('data-k') === fk) back = el; });
      if (back && back !== document.activeElement && !back.disabled) {
        back.focus();
        if (sel) { try { back.setSelectionRange(sel[0], sel[1]); } catch (e) { /* not a text field */ } }
      }
    }
  }

  // The owner's two header links, and which is current.
  function syncNav() {
    if (!navEl) return;
    navEl.hidden = !isOwner();
    navEl.querySelectorAll('a').forEach(function (a) {
      var on = a.getAttribute('data-route') === state.route.name;
      if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    });
  }

  // ---- Keeping up with the register ----
  // A filed revision reaches the site as a new deployment a minute or two after it is filed. The open page asks
  // again every POLL_MS and whenever it is shown again, and re-renders only when the answer changed. An address for a
  // revision later than any the register has (the editor's "Open <rev>" right after filing) is still publishing: the
  // page asks every WAIT_POLL_MS for up to WAIT_MS, and only then says nothing is filed there.
  var POLL_MS = 60000, WAIT_POLL_MS = 4000, WAIT_MS = 5 * 60000;
  var pollTimer = null, polling = false, lastSig = null;
  var waiting = null;     // { key: 'PPP-NNNN-R', until } for the address waiting on a revision being published
  function laterRev(a, b) { return a.length !== b.length ? a.length > b.length : a > b; }
  function publishing(rt, d) {
    if (!rt.rev || (d && !laterRev(rt.rev, last(d).rev))) return false;
    var key = rt.num + '-' + rt.rev;
    if (!waiting || waiting.key !== key) { waiting = { key: key, until: Date.now() + WAIT_MS }; schedule(); }
    return Date.now() < waiting.until;
  }
  function waitingNow() {
    var rt = state.route;
    return !!(waiting && rt.name === 'doc' && rt.rev && waiting.key === rt.num + '-' + rt.rev && Date.now() < waiting.until);
  }
  function schedule() {
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = setTimeout(refresh, waitingNow() ? WAIT_POLL_MS : POLL_MS);
  }
  function refresh() {
    pollTimer = null;
    if (polling) return;
    var wasWaiting = waitingNow();
    if (document.hidden && !wasWaiting) { schedule(); return; }
    polling = true;
    getJson('/api/library').then(function (data) {
      // a wait that ran out turns into "not filed" even with nothing new
      if (JSON.stringify(data) !== lastSig) accept(data);
      else if (wasWaiting && !waitingNow()) render();
    }).catch(function () { /* the page keeps what it has; the next poll tries again */ }).then(function () {
      polling = false;
      schedule();
    });
  }
  function accept(data) {
    lastSig = JSON.stringify(data);
    data.projects = data.projects || [];
    data.documents = (data.documents || []).filter(function (d) { return d.revisions && d.revisions.length; });
    state.data = data;
    state.loadError = null;
    document.getElementById('viewer').textContent = data.viewer ? data.viewer.name : '';
    render();
  }

  // quiet: a reload after a write. If it fails the page keeps what it had rather than blanking.
  function load(quiet) {
    return getJson('/api/library')
      .then(accept)
      .catch(function (e) {
        if (quiet && state.data) return;
        state.loadError = 'Couldn’t load the register (' + e.message + '). Reload to try again.';
        render();
      });
  }

  // The phone layout below 760px, measured on the page itself.
  function watchWidth() {
    var set = function (w) {
      var narrow = w > 0 && w < 760;
      if (narrow === state.narrow) return;
      state.narrow = narrow;
      document.documentElement.classList.toggle('narrow', narrow);
      if (state.data && state.route.name !== 'edit') render();
    };
    set(document.body.getBoundingClientRect().width || window.innerWidth);
    if (window.ResizeObserver) {
      new ResizeObserver(function (en) { en.forEach(function (e) { set(Math.round(e.contentRect.width)); }); }).observe(document.body);
    } else {
      window.addEventListener('resize', function () { set(document.body.getBoundingClientRect().width); });
    }
  }

  function start() {
    main = document.getElementById('main');
    input = document.getElementById('q');
    dlgRoot = h('div', { id: 'dialogs' });
    document.body.appendChild(dlgRoot);
    var viewer = document.getElementById('viewer');
    navEl = h('nav', { class: 'topnav', 'aria-label': 'Owner', hidden: true },
      h('a', { href: '#/k', 'data-route': 'packages', text: 'Packages' }),
      h('a', { href: '#/sharing', 'data-route': 'sharing', text: 'Sharing' }));
    if (viewer && viewer.parentNode) viewer.parentNode.insertBefore(navEl, viewer);
    input.addEventListener('input', onQueryInput);
    input.addEventListener('keydown', onQueryKey);
    document.getElementById('home').addEventListener('click', function () {
      input.value = '';
      state.q = '';
      go({ name: 'home' });
    });
    window.addEventListener('hashchange', onRoute);
    document.addEventListener('visibilitychange', function () { if (!document.hidden && state.data) refresh(); });
    document.addEventListener('keydown', function (e) {
      // F toggles full screen on a document, unless the key is being typed into something.
      if ((e.key === 'f' || e.key === 'F') && !e.defaultPrevented && !e.ctrlKey && !e.metaKey && !e.altKey &&
          state.route.name === 'doc' && !state.dlg) {
        var t = e.target;
        if (!(t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)))) {
          e.preventDefault();
          setFull(!state.full);
          return;
        }
      }
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      if (state.dlg) { closeDialog(); return; }
      if (state.full) setFull(false);
    });
    watchWidth();
    state.route = parseHash();
    if (state.route.name === 'search') { state.q = state.route.q; input.value = state.q; }
    render();
    load().then(schedule);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
