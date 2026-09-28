#!/usr/bin/env node
/* library/pages/selfcheck.mjs — the Cloudflare library's own cases: the Access JWT, who sees what (groups, private
links, guests, and what a non-owner is never told), managed links and packages, folders, descriptions, Access sync,
the migrations and moved_from, and the editing mode (drafts, the box's compile queue, SyncTeX, sending).
`node library/pages/selfcheck.mjs`.

Every case runs lib/library.js's handle() in this process against a register and PDFs this file writes to a
temporary directory, a D1 stand-in over node:sqlite, and Access signing keys it generates, so nothing reaches
Cloudflare: fetch itself is replaced by one that throws, and a case that needs the Cloudflare API stands it in.
Each case builds on the fixture below, not on what an earlier case left, and asserts both the request let through
and the one refused. */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { execFileSync } from 'node:child_process';
import { handle, configure, AUD, TEAM, OWNERS, SEED_READERS, untar, gunzip, diffLines } from './lib/library.js';

// Fixture identity for this run only — arbitrary strings, not a real team/app/owner. configure() is what a real
// deployment calls from its Pages env vars (see README.md); the selfcheck exercises the exact same path.
configure({
  ACCESS_TEAM: 'selfcheck-team', ACCESS_AUD: 'selfcheck-aud', OWNER_NAME: 'Owner',
  OWNER_EMAILS: 'owner@example.test',
  SEED_READERS_JSON: JSON.stringify([
    { email: 'alice@example.test', name: 'Alice', projects: ['901'], wid: 'w1' },
    { email: 'bob@example.test', name: 'Bob', projects: ['105'], wid: null },
  ]),
});

const HERE = dirname(fileURLToPath(import.meta.url));
const ORIGIN = 'https://lib.example';
const OWNER = OWNERS[0];
const ALICE = SEED_READERS.find((r) => r.projects.includes('901'));
const BOB = SEED_READERS.find((r) => r.projects.includes('105'));
const PDF = '%PDF-1.4\n% fixture ';
// no case may reach the network: one that needs a remote answer stands fetch in itself
globalThis.fetch = async (u) => { throw new Error(`selfcheck made a network call: ${u}`); };

// ── stand-ins ──
class Stmt {
  constructor(db, sql, args = []) { this.db = db; this.sql = sql; this.args = args; }
  // D1 takes an ArrayBuffer for a BLOB; node:sqlite a Uint8Array
  bind(...a) { return new Stmt(this.db, this.sql, a.map((x) => (x instanceof ArrayBuffer ? new Uint8Array(x) : x))); }
  async first() { return this.db.prepare(this.sql).get(...this.args) ?? null; }
  async all() { return { results: this.db.prepare(this.sql).all(...this.args) }; }
  async run() { return { meta: { changes: Number(this.db.prepare(this.sql).run(...this.args).changes) } }; }
}
function fakeD1() {
  const db = new DatabaseSync(':memory:');
  return {
    raw: db,
    prepare: (sql) => new Stmt(db, sql),
    batch: async (stmts) => {
      db.exec('BEGIN');
      try { const out = []; for (const s of stmts) out.push(await s.run()); db.exec('COMMIT'); return out; }
      catch (e) { db.exec('ROLLBACK'); throw e; }
    },
  };
}
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.pdf': 'application/pdf', '.otf': 'font/otf' };
function fakeAssets(root) {
  return {
    fetch: async (req) => {
      let p = decodeURIComponent(new URL(req.url).pathname);
      if (p === '/') p = '/index.html';
      const f = join(root, p);
      if (p.includes('..') || !existsSync(f)) return new Response('nope', { status: 404 });
      return new Response(readFileSync(f), { headers: { 'Content-Type': TYPES[extname(f)] || 'application/octet-stream' } });
    },
  };
}

// ── fixture: a site root with the page, a register and its PDFs ──
const T = mkdtempSync(join(tmpdir(), 'library-pages-sc-'));
for (const f of ['index.html', 'app.js', 'style.css']) writeFileSync(join(T, f), readFileSync(join(HERE, f)));
const reg = { version: 1, projects: {}, documents: {} };
function doc(num, title, vis, revs, extra = {}) {
  const p = num.slice(0, 3);
  reg.projects[p] = { name: 'P' + p, kind: 'work' };
  mkdirSync(join(T, 'data', 'files', p), { recursive: true });
  reg.documents[num] = { number: num, project: p, title, visibility: vis, ...extra, revisions: revs.map((r, i) => {
    const file = `files/${p}/${num}-${r.rev}_x.pdf`;
    writeFileSync(join(T, 'data', file), PDF + `${num}-${r.rev}`);
    return { rev: r.rev, file, date: `2026-09-2${i}`, ...r };
  }) };
}
doc('001-0001', 'Owner memo', ['owner'], [{ rev: 'A', public_token: 'seededtoken0000000000000000000000' }, { rev: 'B', note: 'second draft' }]);
doc('105-0001', 'Course notes', ['owner'], [{ rev: 'A' }]);
doc('901-0001', 'Kid notes', ['owner', ALICE.wid], [{ rev: 'A' }], { starred_by: [ALICE.wid] });
doc('901-0002', 'Kept from kid', ['owner'], [{ rev: 'A' }]);
doc('002-0001', 'Shared with kid', ['owner', ALICE.wid], [{ rev: 'A' }]);
doc('003-0001', 'Cover letter, Arista', ['owner'], [{ rev: 'A' }]);
doc('003-0002', 'Plain title', ['owner'], [{ rev: 'A' }]);
doc('007-0001', 'Resume, AI', ['owner'], [{ rev: 'A' }]);
doc('106-0001', 'Other course notes', ['owner'], [{ rev: 'A' }]);
reg.projects['105'].name = 'ECE298A';
reg.projects['106'].name = 'ECE205';
reg.projects['006'] = { name: 'Career', kind: 'work' };
reg.projects['007'].parent = '006';
writeFileSync(join(T, 'data', 'register.json'), JSON.stringify(reg));

// ── the Access keys: one the certs endpoint publishes, one a forger holds under the same kid ──
const alg = { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' };
const good = await crypto.subtle.generateKey(alg, true, ['sign', 'verify']);
const forged = await crypto.subtle.generateKey(alg, true, ['sign', 'verify']);
const jwk = { ...(await crypto.subtle.exportKey('jwk', good.publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
async function jwt(email, { key = good.privateKey, aud = AUD, iss = `https://${TEAM}.cloudflareaccess.com`,
  exp = Date.now() / 1000 + 600, alg: a = 'RS256', extra = {} } = {}) {
  const head = enc({ alg: a, kid: 'k1', typ: 'JWT' }) + '.' + enc({ email, aud: [aud], iss, exp, iat: Date.now() / 1000 - 5, ...extra });
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(head));
  return head + '.' + Buffer.from(sig).toString('base64url');
}

let env;
function freshEnv() {
  env = { DB: fakeD1(), ASSETS: fakeAssets(T), ACCESS_JWKS: JSON.stringify({ keys: [jwk] }), CF_PAGES_BRANCH: 'local' };
}
async function req(path, { as, token, method = 'GET', body, headers = {}, cookie } = {}) {
  const h = { ...headers };
  if (as) h['Cf-Access-Jwt-Assertion'] = await jwt(as);
  if (token) h['Cf-Access-Jwt-Assertion'] = token;
  if (cookie) h.Cookie = cookie;
  if (body !== undefined) h['Content-Type'] = h['Content-Type'] || 'application/json';
  const res = await handle(new Request(ORIGIN + path, { method, headers: h,
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) }), env);
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch (e) { /* not JSON */ }
  return { status: res.status, text, data, headers: res.headers };
}
// the signed-in address of a revision, ending in its name "PPP-NNNN-R Title"
const named = (num, rev) => `/files/${num}-${rev}/${encodeURIComponent(`${num}-${rev} ${reg.documents[num].title}`)}.pdf`;
const nums = (r) => (r.data && r.data.documents || []).map((d) => d.number).sort().join(' ');

const n = [0, 0];
function ok(name, cond) {
  n[cond ? 0 : 1]++;
  console.log((cond ? '  ok   ' : '  FAIL ') + name);
}
async function kase(name, fn) {
  freshEnv();
  try { await fn(); } catch (e) { ok(`${name}: threw ${e.stack}`, false); }
}

await kase('jwt', async () => {
  ok('a verified owner JWT gets the page', (await req('/', { as: OWNER })).status === 200);
  ok('the same JWT in the CF_Authorization cookie gets the library',
    (await req('/api/library', { cookie: 'x=1; CF_Authorization=' + await jwt(OWNER) })).status === 200);
  ok('no JWT is refused', (await req('/api/library')).status === 403);
  ok('an email header without a JWT is refused',
    (await req('/api/library', { headers: { 'Cf-Access-Authenticated-User-Email': OWNER } })).status === 403);
  ok('a JWT signed by another key is refused', (await req('/api/library', { token: await jwt(OWNER, { key: forged.privateKey }) })).status === 403);
  ok('a JWT for another application is refused', (await req('/api/library', { token: await jwt(OWNER, { aud: 'other' }) })).status === 403);
  ok('a JWT from another team is refused',
    (await req('/api/library', { token: await jwt(OWNER, { iss: 'https://evil.cloudflareaccess.com' }) })).status === 403);
  ok('an expired JWT is refused', (await req('/api/library', { token: await jwt(OWNER, { exp: Date.now() / 1000 - 5 }) })).status === 403);
  const t = (await jwt(OWNER)).split('.');
  ok('an alg=none JWT is refused', (await req('/api/library', { token: enc({ alg: 'none', kid: 'k1' }) + '.' + t[1] + '.' })).status === 403);
  ok('a JWT whose claims were edited is refused',
    (await req('/api/library', { token: [t[0], enc({ ...JSON.parse(Buffer.from(t[1], 'base64url')), email: 'x@y.z' }), t[2]].join('.') })).status === 403);
  ok('a verified stranger is refused', (await req('/api/library', { as: 'stranger@example.com' })).status === 403);
  ok('a PDF with no JWT is refused', (await req('/files/001-0001-A.pdf')).status === 403);
  // off a local run the keys come from the team's certs endpoint, stood in for here by one publishing another key
  const live = env, realFetch = globalThis.fetch;
  let asked = '';
  globalThis.fetch = async (u) => { asked = String(u); return Response.json({ keys: [{ ...jwk, kid: 'other' }] }); };
  env = { ...env, CF_PAGES_BRANCH: 'main' };
  const off = await req('/api/library', { as: OWNER });
  globalThis.fetch = realFetch;
  env = live;
  ok('off a local run ACCESS_JWKS is ignored: the team\'s certs are asked, and a JWT the test key signed is refused',
    off.status === 403 && asked === `https://${TEAM}.cloudflareaccess.com/cdn-cgi/access/certs`);
});

// ── helpers for the cases below ──
const post = (path, body, as = OWNER) => req(path, { as, method: 'POST', body });
const cd = (r) => r.headers.get('Content-Disposition') || '';
const pathOf = (r) => new URL(r.data.url).pathname;
const ownerLib = async () => (await req('/api/library', { as: OWNER })).data;
const mkLink = (target, extra = {}) => post('/api/links', { target, ...extra });
const setLink = (id, body, as = OWNER) => post(`/api/links/${id}`, body, as);
async function newPackage(name = 'Pack') {
  const p = (await post('/api/packages', { name })).data;
  const l = await mkLink({ package: p.id });
  return { id: p.id, link: l.data, path: pathOf(l) };
}
const ownerPkg = async (id) => (await ownerLib()).packages.find((p) => p.id === id);
const groupOf = async (email) => (await ownerLib()).groups.find((g) => g.members.some((m) => m.email === email));
/** A new deployment: the register copied, changed by `change`, and each new revision's PDF written. */
function republish(change) {
  const T2 = mkdtempSync(join(tmpdir(), 'library-pages-sc-next-'));
  cpSync(T, T2, { recursive: true });
  const next = JSON.parse(readFileSync(join(T2, 'data', 'register.json')));
  change(next, T2);
  for (const d of Object.values(next.documents)) {
    for (const r of d.revisions) {
      const f = join(T2, 'data', r.file);
      if (!existsSync(f)) { mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, PDF + `${d.number}-${r.rev}`); }
    }
  }
  writeFileSync(join(T2, 'data', 'register.json'), JSON.stringify(next));
  env.ASSETS = fakeAssets(T2);
  return T2;
}

await kase('who sees what', async () => {
  const o = await req('/api/library', { as: OWNER });
  ok('the owner sees every document', nums(o) === '001-0001 002-0001 003-0001 003-0002 007-0001 105-0001 106-0001 901-0001 901-0002');
  const i = await req('/api/library', { as: ALICE.email });
  ok('Alice sees her project and the one shared with her, not the one kept from her', nums(i) === '002-0001 901-0001');
  ok('Alice gets no links, groups or packages', i.data.packages.length === 0 && !i.data.links && !i.data.groups &&
    i.data.documents.every((d) => d.revisions.every((r) => !r.links && r.public === undefined)));
  ok('Alice\'s seeded star is hers', i.data.documents.find((d) => d.number === '901-0001').starred === true);
  const d = await req('/api/library', { as: BOB.email.toUpperCase() });
  ok('Bob sees project 105 only, as a member', nums(d) === '105-0001' && d.data.viewer.role === 'member');
  ok('Bob opens his PDF', (await req('/files/105-0001-A.pdf', { as: BOB.email })).status === 200);
  ok('Bob gets 404 for another project\'s PDF', (await req('/files/901-0001-A.pdf', { as: BOB.email })).status === 404);
  ok('Alice gets 404 for the document kept from her', (await req('/files/901-0002-A.pdf', { as: ALICE.email })).status === 404);
  const g = await groupOf(BOB.email);
  ok('a reader cannot change a group', (await post(`/api/groups/${g.id}`, { revoke: 'project:105' }, BOB.email)).status === 403);
  ok('the owner takes 105 from Bob\'s group', (await post(`/api/groups/${g.id}`, { revoke: 'project:105' })).status === 200);
  ok('then Bob sees nothing and gets 404 for it', nums(await req('/api/library', { as: BOB.email })) === '' &&
    (await req('/files/105-0001-A.pdf', { as: BOB.email })).status === 404);
});

await kase('22: a non-owner is told nobody else\'s name', async () => {
  // Bob and a stranger both reach 105-0001 (a group grant, a private link); a package of it is shared with both
  const pal = 'pal@example.com';
  const g = (await post('/api/groups', { name: 'Course pals' })).data;
  await post(`/api/groups/${g.id}`, { add: { email: 'other.member@example.com', name: 'Other Member' } });
  await post(`/api/groups/${g.id}`, { grant: 'project:105' });
  await mkLink({ number: '105-0001', rev: null }, { kind: 'private', people: [pal, BOB.email] });
  const p = await newPackage('Course pack');
  await post(`/api/packages/${p.id}/documents`, { number: '105-0001', add: true });
  await mkLink({ package: p.id }, { kind: 'private', people: [BOB.email, pal], groups: [g.id] });
  const own = await ownerLib();
  ok('the owner is told who: groups, the directory, people on links',
    own.groups.some((x) => x.name === 'Course pals') && own.directory.some((x) => x.email === pal) &&
    own.links.some((l) => l.people.includes(pal)) && own.access && Array.isArray(own.access.manual));
  const r = await req('/api/library', { as: BOB.email });
  const text = r.text.toLowerCase();
  ok('Bob reaches the document and the package', nums(r) === '105-0001' && r.data.packages.map((x) => x.id).join() === p.id);
  ok('his answer names nobody else: no other email or name, not the owner\'s', !text.includes(pal) && !text.includes('other.member') &&
    !text.includes('other member') && !text.includes('alice') && !text.includes(OWNER) && !text.includes('"owner"'));
  const bad = ['access', 'readers', 'links', 'groups', 'directory', 'history', 'people_list', 'members', 'grants'];
  const keys = new Set();
  const walk = (v) => { if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { keys.add(k); walk(x); } };
  walk({ ...r.data, people: null });
  ok('and carries no access, readers, links, groups, directory or history key at any depth', bad.every((k) => !keys.has(k)));
  ok('people holds himself alone', JSON.stringify(r.data.people) === JSON.stringify({ [BOB.email]: 'Bob' }));
  const guest = await req('/api/library', { as: pal });
  ok('the stranger on the links is a guest told nothing of Bob or the group', guest.status === 200 && guest.data.viewer.role === 'guest' &&
    !guest.text.toLowerCase().includes('bob') && !guest.text.includes('Course pals') && !('links' in guest.data));
  ok('a reader\'s write answers nothing either: refused', (await post('/api/links', { target: { number: '105-0001' } }, BOB.email)).status === 403);
  ok('the removed sharing endpoints are gone', (await post('/api/documents/105-0001/visibility', { reader: pal, visible: true })).status === 404 &&
    (await post(`/api/packages/${p.id}/share`, { reader: pal, visible: true })).status === 404 &&
    (await post('/api/readers', { email: pal, name: 'x', projects: [] })).status === 404);
});

await kase('raw data is never served', async () => {
  for (const p of ['/data/register.json', '/data/files/001/001-0001-A_x.pdf', '/lib/library.js', '/selfcheck.mjs', '/functions/[[path]].js']) {
    ok(`${p} is 404 for the owner`, (await req(p, { as: OWNER })).status === 404);
    ok(`${p} is refused signed out`, (await req(p)).status === 403);
  }
});

await kase('migrate3: the seed readers keep exactly their access', async () => {
  const own = await ownerLib();
  const dg = own.groups.find((g) => g.members.some((m) => m.email === BOB.email));
  const ig = own.groups.find((g) => g.members.some((m) => m.email === ALICE.email));
  ok('Bob becomes a group of one named after him, granted project 105', dg && dg.name === 'Bob' && dg.members.length === 1 &&
    JSON.stringify(dg.grants) === JSON.stringify(['project:105']));
  ok('Alice\'s 901 had a document hidden from her, so it becomes grants of the ones she saw, plus the one shared',
    ig && JSON.stringify(ig.grants) === JSON.stringify(['doc:002-0001', 'doc:901-0001']));
  ok('the schema is 7 (3, the editor columns, locks, anchored feedback, then notes)', env.DB.raw.prepare("SELECT v FROM meta WHERE k = 'schema'").get().v === '7');
  ok('each sees what they saw before', nums(await req('/api/library', { as: ALICE.email })) === '002-0001 901-0001' &&
    nums(await req('/api/library', { as: BOB.email })) === '105-0001');
  ok('a stranger is still refused', (await req('/api/library', { as: 'stranger@example.com' })).status === 403);
});

await kase('migrate3: an older database with readers and a shared package', async () => {
  env.DB.raw.exec(`CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT); INSERT INTO meta VALUES ('seeded', '2026-09-01'), ('schema', '2');
    CREATE TABLE readers (email TEXT PRIMARY KEY, name TEXT NOT NULL, projects TEXT NOT NULL DEFAULT '');
    CREATE TABLE visibility (number TEXT, email TEXT, visible INTEGER, PRIMARY KEY (number, email));
    CREATE TABLE links (token TEXT PRIMARY KEY, id TEXT UNIQUE, number TEXT, rev TEXT, name TEXT, created TEXT, package TEXT);
    CREATE TABLE packages (id TEXT PRIMARY KEY, token TEXT UNIQUE, name TEXT, created TEXT, settings TEXT);
    CREATE TABLE package_docs (package TEXT, number TEXT, rev TEXT, PRIMARY KEY (package, number));
    CREATE TABLE package_readers (package TEXT, email TEXT, PRIMARY KEY (package, email));
    INSERT INTO readers VALUES ('carol@example.com', 'Carol', '105'), ('career@example.com', 'Career', '006'),
      ('bank@example.com', 'The bank', ''), ('pal@example.com', 'Pal', '');
    INSERT INTO visibility VALUES ('003-0001', 'pal@example.com', 1);
    INSERT INTO packages VALUES ('0000beef', NULL, 'For the bank', '2026-09-01', NULL);
    INSERT INTO package_docs VALUES ('0000beef', '001-0001', 'A');
    INSERT INTO package_readers VALUES ('0000beef', 'bank@example.com');`);
  ok('carol keeps project 105', nums(await req('/api/library', { as: 'carol@example.com' })) === '105-0001');
  ok('a reader of project 006 does not gain its sub-project 007 (grants of 006\'s own documents, which are none)',
    (await req('/api/library', { as: 'career@example.com' })).status === 403);
  ok('a reader granted one document keeps that one', nums(await req('/api/library', { as: 'pal@example.com' })) === '003-0001');
  const bank = await req('/api/library', { as: 'bank@example.com' });
  ok('the package\'s reader becomes a guest of a private link on it, at its pin', bank.data.viewer.role === 'guest' &&
    nums(bank) === '001-0001' && bank.data.documents[0].revisions.map((r) => r.rev).join() === 'A' &&
    bank.data.packages.map((x) => x.name).join() === 'For the bank');
  const l = (await ownerLib()).links.find((x) => x.target.package === '0000beef');
  ok('the owner sees that link as private-link-1 naming the bank', l && l.kind === 'private' && l.name === 'private-link-1' &&
    l.people.join() === 'bank@example.com');
  ok('it opens /s/ for the bank and not for carol', (await req(new URL(l.url).pathname, { as: 'bank@example.com' })).status === 200 &&
    (await req(new URL(l.url).pathname, { as: 'carol@example.com' })).status === 404);
  const count = () => env.DB.raw.prepare('SELECT (SELECT count(*) FROM groups) + (SELECT count(*) FROM links) AS c').get().c;
  const before = count();
  env.DB.raw.prepare("UPDATE meta SET v = '2' WHERE k = 'schema'").run();
  env = { ...env, DB: { ...env.DB } };   // a second run, as a racing isolate would make
  await req('/api/library', { as: OWNER });
  ok('a second run adds no group or link', count() === before);
});

await kase('11-13: a managed link of each kind, disabled, archived and restored', async () => {
  const pub = await mkLink({ number: '001-0001', rev: null });
  const priv = await mkLink({ number: '001-0001', rev: 'A' }, { kind: 'private', people: [BOB.email] });
  const si = await mkLink({ number: '105-0001', rev: null }, { kind: 'signed-in' });
  ok('each kind has its own URL shape and auto-name', pathOf(pub).startsWith('/p/') && pathOf(priv).startsWith('/s/') &&
    pathOf(si).startsWith('/l/') && pub.data.name === 'public-link-1' && priv.data.name === 'private-link-1' && si.data.name === 'link-1');
  ok('a public link serves signed out', (await req(pathOf(pub))).text.endsWith('001-0001-B'));
  ok('a private link is refused signed out and 404 on /p/', (await req(pathOf(priv))).status === 403 &&
    (await req(pathOf(priv).replace('/s/', '/p/'))).status === 404);
  ok('a public token is 404 under /s/ and /l/', (await req(pathOf(pub).replace('/p/', '/s/'), { as: OWNER })).status === 404 &&
    (await req(pathOf(pub).replace('/p/', '/l/'), { as: OWNER })).status === 404);
  const l = await req(pathOf(si), { as: BOB.email });
  ok('a signed-in link sends a reader who may open it to the file\'s own address, uncached', l.status === 302 &&
    l.headers.get('Location') === named('105-0001', 'A') && l.headers.get('Cache-Control') === 'no-store');
  ok('it is 404 for a known viewer who may not open it, and refused signed out', (await req(pathOf(si), { as: ALICE.email })).status === 404 &&
    (await req(pathOf(si))).status === 403);
  ok('a signed-in link cannot target a package', (await mkLink({ package: (await post('/api/packages', { name: 'x' })).data.id },
    { kind: 'signed-in' })).status === 400);
  ok('an unknown kind is refused', (await mkLink({ number: '001-0001' }, { kind: 'secret' })).status === 400);
  ok('a reader cannot make or change one', (await post('/api/links', { target: { number: '105-0001' } }, BOB.email)).status === 403 &&
    (await setLink(pub.data.id, { state: 'disabled' }, BOB.email)).status === 403);
  const url = pathOf(pub);
  ok('disabling it: 404 at once, like an unknown token', (await setLink(pub.data.id, { state: 'disabled' })).data.state === 'disabled' &&
    (await req(url)).status === 404 && (await req(url)).text === (await req('/p/unknowntoken00000000000')).text);
  ok('enabling it: back on the same URL', (await setLink(pub.data.id, { state: 'live' })).status === 200 && (await req(url)).status === 200);
  ok('archiving the signed-in one: 404', (await setLink(si.data.id, { state: 'archived' })).status === 200 &&
    (await req(pathOf(si), { as: BOB.email })).status === 404);
  ok('restoring it: back on the same URL', (await setLink(si.data.id, { state: 'live' })).status === 200 &&
    (await req(pathOf(si), { as: BOB.email })).status === 302);
  await setLink(pub.data.id, { state: 'archived' });
  const own = await ownerLib();
  const a = own.links.find((x) => x.id === pub.data.id);
  ok('the owner still lists an archived link with its URL, target, kind and history', a.state === 'archived' && a.url.endsWith(url) &&
    JSON.stringify(a.target) === JSON.stringify({ number: '001-0001', rev: null }) && a.kind === 'public' &&
    a.history.map((h) => h.what.split(' ')[0]).join() === 'made,disabled,enabled,archived');
  ok('one list holds every link (the seeded one too), and no document carries links of its own', own.links.length === 4 &&
    own.documents.every((d) => d.links === undefined && d.revisions.every((r) => r.links === undefined)));
  ok('revisions[].public says a live public link reaches it: A (the seeded link), not B any more',
    own.documents.find((d) => d.number === '001-0001').revisions.map((r) => r.public).join() === 'true,false');
  ok('an unknown state is refused', (await setLink(pub.data.id, { state: 'gone' })).status === 400);
  ok('the removed per-document link endpoints are 404', (await post('/api/documents/001-0001/links', {})).status === 404 &&
    (await post('/api/documents/001-0001/revisions/A/links', {})).status === 404);
});

await kase('10-11: a link is repointed', async () => {
  const made = await mkLink({ number: '001-0001', rev: null }, { name: 'on the website' });
  const path = pathOf(made), id = made.data.id;
  ok('a new link follows the newest revision', made.data.target.rev === null && (await req(path)).text.endsWith('001-0001-B'));
  ok('a reader cannot repoint it', (await setLink(id, { target: { number: '105-0001', rev: null } }, BOB.email)).status === 403);
  ok('the owner pins it to revision A', (await setLink(id, { target: { number: '001-0001', rev: 'A' } })).status === 200 &&
    (await req(path)).text.endsWith('001-0001-A'));
  ok('then points it at another document', (await setLink(id, { target: { number: '003-0001', rev: null } })).status === 200 &&
    (await req(path)).text.endsWith('003-0001-A'));
  ok('the owner sees its new target and a history line per move', (await ownerLib()).links.find((l) => l.id === id).history.length === 3);
  ok('a document that does not exist is refused, and the link stays', (await setLink(id, { target: { number: '999-9999', rev: null } })).status === 400 &&
    (await req(path)).text.endsWith('003-0001-A'));
  ok('a revision the document does not have is refused', (await setLink(id, { target: { number: '003-0001', rev: 'Z' } })).status === 400);
  ok('an empty change is refused', (await setLink(id, {})).status === 400);
  ok('an unknown link is 404', (await setLink('00000000', { name: 'x' })).status === 404);
  const p = await newPackage('Pack one'), q = await newPackage('Pack two');
  await post(`/api/packages/${q.id}/documents`, { number: '003-0002', add: true });
  ok('a package link is repointed to another package', (await setLink(p.link.id, { target: { package: q.id } })).status === 200 &&
    (await req(p.path)).text.includes('Plain title'));
  ok('the old /p/<t>/<N-R>.pdf shape of a repointed link answers with the link itself',
    (await req(`${path}/001-0001-A.pdf`)).headers.get('Location') === path);
});

await kase('17-19: a private link names people', async () => {
  const pal = 'pal@example.com';
  const made = await mkLink({ number: '003-0001', rev: null }, { kind: 'private', people: ['Pal <Pal@Example.com>'] });
  const s = pathOf(made);
  ok('it is made with the person, lower-cased, and an access answer', made.data.people.join() === pal && made.data.access &&
    made.data.access.sync === false && made.data.access.manual.includes(pal));
  const got = await req(s, { as: pal });
  ok('the named person opens it, named by its title', got.status === 200 && got.text.endsWith('003-0001-A') && cd(got).includes('Cover letter, Arista'));
  ok('another signed-in viewer gets 404', (await req(s, { as: BOB.email })).status === 404);
  ok('an unknown signed-in email is refused, on it and on the library', (await req(s, { as: 'nobody@example.com' })).status === 403 &&
    (await req('/api/library', { as: 'nobody@example.com' })).status === 403);
  ok('signed out it is refused', (await req(s)).status === 403);
  ok('the owner may open it too', (await req(s, { as: OWNER })).status === 200);
  const g = (await post('/api/groups', { name: 'Readers of letters' })).data;
  await setLink(made.data.id, { groups: [g.id] });
  ok('a member of a group the link names opens it once added to the group',
    (await req(s, { as: BOB.email })).status === 404 && (await post(`/api/groups/${g.id}`, { add: BOB.email })).status === 200 &&
    (await req(s, { as: BOB.email })).status === 200);
  ok('a group that does not exist is refused', (await setLink(made.data.id, { groups: ['00000000'] })).status === 400);
  ok('an entry that is not an email is refused', (await setLink(made.data.id, { people: ['not an email'] })).status === 400);
  ok('taking the person off: they are refused, since no link names them any more',
    (await setLink(made.data.id, { people: [] })).status === 200 && (await req('/api/library', { as: pal })).status === 403);
  const p = await newPackage('Private pack');
  await post(`/api/packages/${p.id}/documents`, { number: '001-0001', add: true, rev: 'A' });
  const pk = await mkLink({ package: p.id }, { kind: 'private', people: [pal] });
  const page = await req(pathOf(pk), { as: pal });
  ok('a private package link: its page links under /s/, and serves its pinned revision', page.status === 200 &&
    page.text.includes(`${pathOf(pk)}/001-0001/`) && (await req(`${pathOf(pk)}/001-0001`, { as: pal })).text.endsWith('001-0001-A'));
  ok('a document not in it is 404 there', (await req(`${pathOf(pk)}/003-0001`, { as: pal })).status === 404);
});

await kase('17: a guest sees only what their links reach', async () => {
  const pal = 'pal@example.com';
  await mkLink({ number: '001-0001', rev: 'A' }, { kind: 'private', people: [pal] });
  const p = await newPackage('Guest pack');
  await post(`/api/packages/${p.id}/documents`, { number: '003-0002', add: true });
  await mkLink({ package: p.id }, { kind: 'private', people: [pal] });
  const lib = await req('/api/library', { as: pal });
  ok('the guest\'s library is the link targets and nothing else', lib.data.viewer.role === 'guest' && nums(lib) === '001-0001 003-0002' &&
    lib.data.documents.find((d) => d.number === '001-0001').revisions.map((r) => r.rev).join() === 'A');
  ok('with the package they reach', lib.data.packages.map((x) => x.name).join() === 'Guest pack');
  ok('they open the pinned revision, not the other, nor another document',
    (await req('/files/001-0001-A.pdf', { as: pal })).status === 200 && (await req('/files/001-0001-B.pdf', { as: pal })).status === 404 &&
    (await req('/files/105-0001-A.pdf', { as: pal })).status === 404);
  ok('they get the site page, and may star what they see but nothing else', (await req('/', { as: pal })).status === 200 &&
    (await post('/api/documents/003-0002/star', { starred: true }, pal)).status === 200 &&
    (await post('/api/documents/105-0001/star', { starred: true }, pal)).status === 404);
  ok('archiving the package takes it from them', (await post(`/api/packages/${p.id}`, { archived: true })).status === 200 &&
    nums(await req('/api/library', { as: pal })) === '001-0001');
});

await kase('20-21: groups are granted tree nodes', async () => {
  const fam = 'fam@example.com';
  const g = (await post('/api/groups', { name: 'Example Fine Carpets' })).data;
  ok('a reader cannot make a group', (await post('/api/groups', { name: 'x' }, BOB.email)).status === 403);
  const added = await post(`/api/groups/${g.id}`, { add: { email: 'Fam@Example.com', name: 'Fam' } });
  ok('adding a person answers the members and the access state', added.data.members[0].email === fam &&
    added.data.members[0].name === 'Fam' && added.data.access.manual.includes(fam));
  ok('a member with no grant sees an empty library, not a refusal', nums(await req('/api/library', { as: fam })) === '');
  ok('a node the register does not have is refused', (await post(`/api/groups/${g.id}`, { grant: 'project:555' })).status === 400 &&
    (await post(`/api/groups/${g.id}`, { grant: 'group:Nope' })).status === 400);
  await post(`/api/groups/${g.id}`, { grant: 'group:Career' });
  ok('a group node covers every project under it', nums(await req('/api/library', { as: fam })) === '007-0001');
  await post(`/api/groups/${g.id}`, { grant: 'doc:003-0002' });
  ok('a leaf grants one document', nums(await req('/api/library', { as: fam })) === '003-0002 007-0001' &&
    (await req('/files/003-0001-A.pdf', { as: fam })).status === 404);
  await post(`/api/groups/${g.id}`, { revoke: 'group:Career' });
  await post(`/api/groups/${g.id}`, { grant: 'project:006' });
  ok('a project node covers its sub-projects', nums(await req('/api/library', { as: fam })) === '003-0002 007-0001');
  // the box files a new document under 007 and a new sub-project 008 of Career
  republish((next) => {
    next.projects['008'] = { name: 'Cover letters', kind: 'work', parent: 'Career' };
    next.documents['007-0002'] = { number: '007-0002', project: '007', title: 'Resume, new', revisions: [{ rev: 'A', file: 'files/007/007-0002-A_x.pdf', date: '2026-09-26' }] };
    next.documents['008-0001'] = { number: '008-0001', project: '008', title: 'Letter', revisions: [{ rev: 'A', file: 'files/008/008-0001-A_x.pdf', date: '2026-09-26' }] };
  });
  ok('a document filed later under a granted project is seen, as is a sub-project named by the group\'s name',
    nums(await req('/api/library', { as: fam })) === '003-0002 007-0001 007-0002 008-0001' &&
    (await req('/files/007-0002-A.pdf', { as: fam })).status === 200);
  const own = await ownerLib();
  ok('the owner sees the group with its members and grants, and projects with their parent',
    JSON.stringify(own.groups.find((x) => x.id === g.id).grants) === JSON.stringify(['doc:003-0002', 'project:006']) &&
    own.projects.find((p) => p.number === '007').parent === '006' && own.projects.find((p) => p.number === '008').parent === null);
  ok('the course list reads groups: a group granted 105 lists its members', (await post(`/api/groups/${g.id}`, { grant: 'project:105' })).status === 200 &&
    (await req('/api/courses/readers', { as: OWNER })).data.ece298a.join() === `${BOB.email},${fam}`);
  ok('removing the person refuses them', (await post(`/api/groups/${g.id}`, { remove: fam })).status === 200 &&
    (await req('/api/library', { as: fam })).status === 403);
  await post(`/api/groups/${g.id}`, { add: fam });
  ok('deleting the group refuses them too', (await post(`/api/groups/${g.id}`, { delete: true })).status === 200 &&
    (await req('/api/library', { as: fam })).status === 403 && !(await ownerLib()).groups.some((x) => x.id === g.id));
  ok('the owner cannot be a member', (await post(`/api/groups/${(await groupOf(BOB.email)).id}`, { add: OWNER })).status === 400);
});

await kase('18: Access sync, with the Cloudflare API stood in for', async () => {
  const pal = 'pal@example.com', fam = 'fam@example.com';
  // no variables: nothing is called, and the owner is told whom to add by hand
  const made = await mkLink({ number: '003-0001', rev: null }, { kind: 'private', people: [pal] });
  ok('without the variables: sync false, manual names the person, not the owner', made.data.access.sync === false &&
    made.data.access.manual.includes(pal) && !made.data.access.manual.includes(OWNER));
  ok('the owner page says the same', JSON.stringify((await ownerLib()).access.manual) === JSON.stringify([BOB.email, ALICE.email, pal].sort()));
  ok('it names the variables it cannot see, and no value', JSON.stringify(made.data.access.missing) === JSON.stringify(['CF_API_TOKEN', 'CF_ACCOUNT_ID', 'CF_ACCESS_POLICY_ID']));
  Object.assign(env, { CF_API_TOKEN: 'tok', CF_ACCOUNT_ID: ' ' });
  const part = await ownerLib();
  ok('a blank or absent one is still named; a set one is not', JSON.stringify(part.access.missing) === JSON.stringify(['CF_ACCOUNT_ID', 'CF_ACCESS_POLICY_ID']) &&
    !JSON.stringify(part.access).includes('tok'));
  // with the variables: a policy holding the owner, someone added by hand, and the seed readers
  Object.assign(env, { CF_API_TOKEN: 'tok', CF_ACCOUNT_ID: 'acct', CF_ACCESS_POLICY_ID: 'pol' });
  let policy = { id: 'pol', name: 'allow-library', decision: 'allow', created_at: 'x',
    include: [{ email: { email: OWNER } }, { email: { email: 'byhand@example.com' } }, { email: { email: BOB.email } },
      { email: { email: ALICE.email } }, { email_domain: { domain: 'example.org' } }] };
  const calls = [];
  const realFetch = globalThis.fetch;
  let fail = false, lastPut = null;
  globalThis.fetch = async (u, o = {}) => {
    calls.push([o.method || 'GET', String(u), o.headers && o.headers.Authorization]);
    if (fail) return new Response('no', { status: 500 });
    if ((o.method || 'GET') === 'PUT') { lastPut = JSON.parse(o.body); policy = { ...policy, ...lastPut }; return Response.json({ result: policy }); }
    return Response.json({ result: policy });
  };
  const emails = () => policy.include.map((r) => r.email && r.email.email).filter(Boolean).sort().join(' ');
  try {
    const g = (await post('/api/groups', { name: 'Fam' })).data;
    const r = await post(`/api/groups/${g.id}`, { add: fam });
    ok('adding a group member adds them to the policy, and the link\'s person too', r.data.access.sync === true &&
      r.data.access.manual.length === 0 && emails().includes(fam) && emails().includes(pal));
    ok('the call goes to the reusable policy with the token', calls.some(([m, u, a]) => m === 'PUT' &&
      u === 'https://api.cloudflare.com/client/v4/accounts/acct/access/policies/pol' && a === 'Bearer tok'));
    ok('the write keeps the policy\'s other fields and rules, and sends no read-only field', lastPut.name === 'allow-library' &&
      lastPut.decision === 'allow' && lastPut.include.some((x) => x.email_domain) && !('id' in lastPut) && !('created_at' in lastPut));
    await post(`/api/groups/${g.id}`, { remove: fam });
    ok('removing them takes them off, since nothing else needs them', !emails().includes(fam));
    await setLink(made.data.id, { state: 'archived' });
    ok('archiving the last link naming pal takes pal off', !emails().includes(pal));
    await setLink(made.data.id, { state: 'live' });
    ok('restoring it puts pal back', emails().includes(pal));
    await post(`/api/groups/${(await groupOf(BOB.email)).id}`, { delete: true });
    ok('an email the site did not add is never removed (Bob, byhand)', emails().includes(BOB.email) && emails().includes('byhand@example.com'));
    env.CF_ACCESS_APP_ID = 'app';
    calls.length = 0;
    await setLink(made.data.id, { people: [pal, 'two@example.com'] });
    ok('with an app id the app-scoped policy is used', calls.every(([, u]) => u === 'https://api.cloudflare.com/client/v4/accounts/acct/access/apps/app/policies/pol') &&
      emails().includes('two@example.com'));
    fail = true;
    const f = await setLink(made.data.id, { people: [pal, 'three@example.com'] });
    ok('a failing API never fails the change: it lands, and says sync false with the error and who to add by hand',
      f.status === 200 && f.data.people.includes('three@example.com') && f.data.access.sync === false &&
      /answered 500/.test(f.data.access.error) && f.data.access.manual.includes('three@example.com'));
    ok('and the owner page says so until a sync succeeds', (await ownerLib()).access.sync === false);
    const n = calls.length;
    await ownerLib();
    ok('reading the library calls nothing', calls.length === n);
  } finally {
    globalThis.fetch = realFetch;
  }
});

await kase('public link', async () => {
  ok('the register\'s public token was seeded as a link',
    (await req('/p/seededtoken0000000000000000000000/001-0001-A.pdf')).status === 200);
  ok('a form post is refused', (await req('/api/links',
    { as: OWNER, method: 'POST', body: 'name=x', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } })).status === 415);
  const made = await mkLink({ number: '001-0001', rev: 'B' }, { name: 'tutor' });
  ok('the owner makes a named link', made.status === 200 && made.data.name === 'tutor');
  const path = pathOf(made);
  const got = await req(path);
  ok('it serves signed out, named by its title alone', got.status === 200 && got.text.startsWith('%PDF') &&
    cd(got).includes('filename="Owner memo.pdf"'));
  ok('its address is /p/<token> alone', /^\/p\/[A-Za-z0-9_-]{16,64}$/.test(path));
  ok('the older /p/<token>/<N-R>.pdf shape of it still serves', (await req(`${path}/001-0001-B.pdf`)).text.endsWith('001-0001-B'));
  const other = await req(`${path}/001-0001-A.pdf`);
  ok('its token does not reach another revision: that shape answers with the link itself',
    other.status === 302 && other.headers.get('Location') === path && !other.text.includes('%PDF'));
  ok('revisions[].public marks B', (await ownerLib()).documents[0].revisions.map((r) => r.public).join() === 'true,true');
});

await kase('package', async () => {
  const made = await post('/api/packages', { name: 'For the bank' });
  ok('the owner makes a package, with no link yet', made.status === 200 && made.data.documents.length === 0 &&
    made.data.url === undefined && made.data.archived === null);
  ok('a reader cannot', (await post('/api/packages', { name: 'x' }, ALICE.email)).status === 403);
  const link = await mkLink({ package: made.data.id });
  const path = pathOf(link);
  ok('the empty package serves signed out', (await req(path)).status === 200);
  ok('adding 001-0001', (await post(`/api/packages/${made.data.id}/documents`, { number: '001-0001', add: true })).status === 200);
  const page = await req(path);
  ok('the page lists its newest revision and nothing else', page.text.includes(`${path}/001-0001/`) &&
    !page.text.includes('105-0001') && !page.text.includes('newest revision'));
  ok('its PDF is the newest revision', (await req(`${path}/001-0001`)).text.endsWith('001-0001-B'));
  ok('a document not in it is 404', (await req(`${path}/105-0001`)).status === 404 &&
    (await req(`${path}/105-0001/Course%20notes.pdf`)).status === 404);
  const k = path.replace('/p/', '/k/');
  ok('the older /k/ shape still serves the package and its PDF', (await req(k)).text.includes(`${k}/001-0001.pdf`) &&
    (await req(`${k}/001-0001.pdf`)).text.endsWith('001-0001-B'));
  ok('removing 001-0001', (await post(`/api/packages/${made.data.id}/documents`, { number: '001-0001', add: false })).status === 200);
  ok('then its PDF is 404', (await req(`${path}/001-0001`)).status === 404);
  ok('a made-up package token is 404', (await req('/k/aaaaaaaaaaaaaaaaaaaaaaaa')).status === 404);
});

await kase('12: a package is archived and restored', async () => {
  const p = await newPackage('Normal AI');
  await post(`/api/packages/${p.id}/documents`, { number: '003-0001', add: true });
  const two = await mkLink({ package: p.id }, { name: 'second' });
  ok('a reader cannot archive it', (await post(`/api/packages/${p.id}`, { archived: true }, BOB.email)).status === 403);
  const a = await post(`/api/packages/${p.id}`, { archived: true });
  ok('archiving it: its page and every link to it are 404 at once', a.status === 200 && a.data.archived &&
    (await req(p.path)).status === 404 && (await req(`${p.path}/003-0001`)).status === 404 && (await req(pathOf(two))).status === 404 &&
    (await req(p.path.replace('/p/', '/k/'))).status === 404);
  const pk = await ownerPkg(p.id);
  ok('the owner still has it, its documents and its history', pk.archived && pk.documents.length === 1 &&
    pk.history.map((h) => h.what).join('|') === 'made Normal AI|archived');
  ok('restoring it: both links answer on the same URLs', (await post(`/api/packages/${p.id}`, { archived: false })).status === 200 &&
    (await req(p.path)).status === 200 && (await req(pathOf(two))).status === 200);
  ok('delete is not a thing any more: refused, and the package is still there', (await post(`/api/packages/${p.id}`, { delete: true })).status === 400 &&
    (await req(p.path)).status === 200);
});

await kase('groups and stars', async () => {
  const g = (await post('/api/groups', { name: 'New' })).data;
  await post(`/api/groups/${g.id}`, { add: { email: 'New@Example.com', name: 'New' } });
  await post(`/api/groups/${g.id}`, { grant: 'project:002' });
  ok('a new member sees project 002', nums(await req('/api/library', { as: 'new@example.com' })) === '002-0001');
  ok('Bob stars his document', (await post('/api/documents/105-0001/star', { starred: true }, BOB.email)).data.starred === true);
  ok('the star is his, not the owner\'s', (await ownerLib()).documents.find((d) => d.number === '105-0001').starred === false);
  ok('Bob cannot star a document he cannot see', (await post('/api/documents/901-0001/star', { starred: true }, BOB.email)).status === 404);
});

await kase('a reader reaches only their course', async () => {
  const d = await req('/d/105-0001', { as: BOB.email });
  ok('Bob\'s /d link to his course document sends him to its newest revision, uncached',
    d.status === 302 && d.headers.get('Location') === named('105-0001', 'A') && d.headers.get('Cache-Control') === 'no-store');
  ok('and that file opens for him', (await req(d.headers.get('Location'), { as: BOB.email })).status === 200);
  ok('another course\'s /d link is 404 for him', (await req('/d/106-0001', { as: BOB.email })).status === 404);
  ok('a member project\'s /d link is 404 for him', (await req('/d/901-0001', { as: BOB.email })).status === 404);
  ok('a number that does not exist answers the same 404', (await req('/d/999-9999', { as: BOB.email })).status === 404);
  ok('the owner\'s /d link reaches the other course', (await req('/d/106-0001', { as: OWNER })).status === 302);
  ok('signed out a /d link is refused', (await req('/d/105-0001')).status === 403);
  const list = await req('/api/courses/readers', { as: OWNER });
  ok('the one reader list names each course by its code, with the members of the groups granted it',
    list.status === 200 && JSON.stringify(list.data) === JSON.stringify({ ece298a: [BOB.email], ece205: [] }));
  ok('a reader cannot read the list', (await req('/api/courses/readers', { as: BOB.email })).status === 403);
  env.READER_EXPORT_TOKENS = 'lessons-id.access, other-id.access';
  const svc = (cn) => jwt(undefined, { extra: { common_name: cn } });
  ok('the lessons service token reads it', (await req('/api/courses/readers', { token: await svc('lessons-id.access') })).status === 200);
  ok('a service token not named is refused', (await req('/api/courses/readers', { token: await svc('stray.access') })).status === 403);
  ok('a named service token reaches nothing else', (await req('/api/library', { token: await svc('lessons-id.access') })).status === 403 &&
    (await req('/d/105-0001', { token: await svc('lessons-id.access') })).status === 403);
  ok('the owner grants Bob\'s group ECE205', (await post(`/api/groups/${(await groupOf(BOB.email)).id}`, { grant: 'project:106' })).status === 200);
  ok('then the list and his /d link both say so', (await req('/api/courses/readers', { as: OWNER })).data.ece205[0] === BOB.email &&
    (await req('/d/106-0001', { as: BOB.email })).status === 302);
  ok('a doc grant alone does not make a course reader', (await post(`/api/groups/${(await groupOf(ALICE.email)).id}`, { grant: 'doc:105-0001' })).status === 200 &&
    (await req('/api/courses/readers', { as: OWNER })).data.ece298a.join() === BOB.email);
});

await kase('the lessons build makes its own signed-in links', async () => {
  env.LINK_MINT_TOKENS = 'lessons-id.access, spare-id.access';
  env.FEEDBACK_TOKENS = 'box-id.access';
  env.READER_EXPORT_TOKENS = 'reader-id.access';
  const svc = (cn) => jwt(undefined, { extra: { common_name: cn } });
  const as = async (cn, path, body, method = 'POST') => req(path, { token: await svc(cn), method, body });
  const mint = (body, cn = 'lessons-id.access') => as(cn, '/api/links', body);
  const want = { target: { number: '001-0001', rev: null }, kind: 'signed-in', name: 'lessons-site' };
  const a = await mint(want);
  ok('the minting token makes a following signed-in document link, with the usual fields and no access sync',
    a.status === 200 && pathOf(a).startsWith('/l/') && a.data.kind === 'signed-in' && a.data.state === 'live' &&
    a.data.name === 'lessons-site' && a.data.target.number === '001-0001' && a.data.target.rev === null &&
    !('access' in a.data) && /^[0-9a-f]{8}$/.test(a.data.id));
  const b = await mint({ ...want, target: { number: '001-0001' } });
  ok('a second call answers the same link', b.status === 200 && b.data.id === a.data.id && b.data.url === a.data.url &&
    env.DB.raw.prepare("SELECT count(*) AS c FROM links WHERE name = 'lessons-site'").get().c === 1);
  ok('the owner sees it, made by the token', (await ownerLib()).links.some((l) => l.id === a.data.id) &&
    env.DB.raw.prepare("SELECT what FROM history WHERE id = ?").get(a.data.id).what.includes('service token lessons-id.access'));
  ok('once disabled, the next call makes a new one', (await setLink(a.data.id, { state: 'disabled' })).status === 200 &&
    (await mint(want)).data.id !== a.data.id);
  const pkg = (await post('/api/packages', { name: 'p' })).data.id;
  ok('it is refused kind public, kind private, no kind, a package, a pinned rev, people or groups',
    (await Promise.all([
      mint({ ...want, kind: 'public' }), mint({ ...want, kind: 'private' }), mint({ target: want.target, name: 'x' }),
      mint({ ...want, target: { package: pkg } }), mint({ ...want, target: { number: '001-0001', rev: 'A' } }),
      mint({ ...want, people: [] }), mint({ ...want, groups: [] }),
    ])).every((r) => r.status === 403));
  ok('an unknown document is 404', (await mint({ ...want, target: { number: '001-0999', rev: null } })).status === 404);
  ok('it cannot repoint, disable, archive or rename the link, or delete a group',
    (await Promise.all([
      as('lessons-id.access', `/api/links/${a.data.id}`, { state: 'live' }), as('lessons-id.access', `/api/links/${a.data.id}`, { state: 'archived' }),
      as('lessons-id.access', `/api/links/${a.data.id}`, { target: { number: '105-0001', rev: null } }),
      as('lessons-id.access', '/api/groups', { name: 'g' }), as('lessons-id.access', '/api/packages', { name: 'p' }),
    ])).every((r) => r.status === 403) &&
    (await as('lessons-id.access', `/api/links/${a.data.id}`, undefined, 'DELETE')).status === 405 &&
    (await ownerLib()).links.find((l) => l.id === a.data.id).state === 'disabled');
  ok('it reads nothing: GET /api/library, a /d link, a file and its own /l/ link are refused',
    (await Promise.all([as('lessons-id.access', '/api/library', undefined, 'GET'), as('lessons-id.access', '/d/001-0001', undefined, 'GET'),
      as('lessons-id.access', '/files/001-0001-A.pdf', undefined, 'GET'), as('lessons-id.access', pathOf(b), undefined, 'GET'),
      as('lessons-id.access', '/api/courses/readers', undefined, 'GET')])).every((r) => r.status === 403));
  ok('a feedback-only or reader-list-only token, or one not named, is refused minting',
    (await mint(want, 'box-id.access')).status === 403 && (await mint(want, 'reader-id.access')).status === 403 &&
    (await mint(want, 'stray.access')).status === 403);
  ok('a mismatched client-id header is refused', (await req('/api/links', { token: await svc('lessons-id.access'), method: 'POST',
    body: want, headers: { 'Cf-Access-Client-Id': 'spare-id.access' } })).status === 403);
  const c = await mint({ ...want, name: 'lesson 4' });
  ok('the minted /l/ sends the owner to the file and is 404 to a signed-in viewer who cannot open the document',
    (await req(pathOf(c), { as: OWNER })).status === 302 && (await req(pathOf(c), { as: BOB.email })).status === 404);
  ok('the owner still makes every kind', (await mkLink({ number: '001-0001' }, { kind: 'private', people: [BOB.email] })).status === 200 &&
    (await mkLink({ package: pkg })).status === 200);
});

await kase('a /d link and links follow a new revision', async () => {
  const made = await mkLink({ number: '105-0001', rev: null }, { name: 'syllabus page' });
  const pinned = await mkLink({ number: '105-0001', rev: 'A' }, { name: 'kept on A' });
  const lesson = await mkLink({ number: '105-0001', rev: null }, { kind: 'signed-in', name: 'lesson 3' });
  const follow = pathOf(made), onA = pathOf(pinned);
  ok('before: /d, the following links and the pinned one all give A',
    (await req('/d/105-0001', { as: BOB.email })).headers.get('Location') === named('105-0001', 'A') &&
    (await req(follow)).text.endsWith('105-0001-A') && (await req(onA)).text.endsWith('105-0001-A') &&
    (await req(pathOf(lesson), { as: BOB.email })).headers.get('Location') === named('105-0001', 'A'));
  // the box files revision B and the mirror publishes it: a new deployment, which is a new ASSETS binding
  const T2 = republish((next) => {
    next.documents['105-0001'].revisions.push({ rev: 'B', file: 'files/105/105-0001-B_x.pdf', date: '2026-09-26', note: 'typo' });
  });
  writeFileSync(join(T2, 'data', 'links.json'), JSON.stringify({ '105-0001': [{ site: 'lessons', path: '/ece298a/' }, { bad: 1 }] }));
  env.ASSETS = fakeAssets(T2);
  const d = await req('/d/105-0001', { as: BOB.email });
  ok('after: the same /d link sends Bob to B', d.status === 302 && d.headers.get('Location') === named('105-0001', 'A').replace(/-A/g, '-B'));
  ok('and B opens for him', (await req('/files/105-0001-B.pdf', { as: BOB.email })).text.endsWith('105-0001-B'));
  ok('/d/105-0001-A still gives A', (await req('/d/105-0001-A', { as: BOB.email })).headers.get('Location') === named('105-0001', 'A'));
  ok('the following public link and the signed-in lessons link now give B', (await req(follow)).text.endsWith('105-0001-B') &&
    (await req(pathOf(lesson), { as: BOB.email })).headers.get('Location').startsWith('/files/105-0001-B/'));
  ok('the pinned one stays on A', (await req(onA)).text.endsWith('105-0001-A'));
  const lib = (await ownerLib()).documents.find((x) => x.number === '105-0001');
  ok('the owner sees the page that links it', JSON.stringify(lib.linked_from) === JSON.stringify([{ site: 'lessons', path: '/ece298a/' }]));
  const mine = (await req('/api/library', { as: BOB.email })).data.documents.find((x) => x.number === '105-0001');
  ok('Bob sees no linked_from', mine.linked_from === undefined && mine.links === undefined);
});

await kase('1: a package is renamed', async () => {
  const p = await newPackage('Old name');
  ok('a reader cannot rename it', (await post(`/api/packages/${p.id}`, { name: 'Mine' }, BOB.email)).status === 403);
  ok('the owner renames it', (await post(`/api/packages/${p.id}`, { name: '  New   name ' })).data.name === 'New name' &&
    (await ownerPkg(p.id)).name === 'New name' && (await req(p.path)).text.includes('<h1>New name</h1>'));
  ok('a name of control characters is refused, and the name stays', (await post(`/api/packages/${p.id}`, { name: '\u0001' })).status === 400 &&
    (await ownerPkg(p.id)).name === 'New name');
  ok('a body with neither name, settings nor archived is refused', (await post(`/api/packages/${p.id}`, {})).status === 400);
  ok('an unknown package is 404', (await post('/api/packages/00000000', { name: 'x' })).status === 404);
});

await kase('2: a link made with no name is named on its own', async () => {
  const a = await mkLink({ number: '001-0001', rev: null });
  const b = await mkLink({ number: '001-0001', rev: 'A' }, { name: '' });
  const c = await mkLink({ number: '001-0001', rev: null }, { name: 'tutor' });
  ok('the first is public-link-1, a pinned one public-link-2, a named one keeps its name',
    a.data.name === 'public-link-1' && b.data.name === 'public-link-2' && c.data.name === 'tutor');
  await setLink(a.data.id, { state: 'archived' });
  ok('after archiving public-link-1 the next is public-link-3, not a reused 1',
    (await mkLink({ number: '001-0001', rev: 'B' })).data.name === 'public-link-3');
  ok('private and signed-in links count on their own', (await mkLink({ number: '001-0001' }, { kind: 'private' })).data.name === 'private-link-1' &&
    (await mkLink({ number: '001-0001' }, { kind: 'signed-in' })).data.name === 'link-1');
  ok('another document counts from 1', (await mkLink({ number: '003-0001' })).data.name === 'public-link-1');
  const p = (await post('/api/packages', { name: 'P' })).data;
  const l1 = await mkLink({ package: p.id }), l2 = await mkLink({ package: p.id }, { name: '' });
  ok('a package counts its own links', l1.data.name === 'public-link-1' && l2.data.name === 'public-link-2');
  ok('a name of control characters is refused', (await mkLink({ number: '001-0001' }, { name: '\u0001' })).status === 400);
});

await kase('5: package display settings', async () => {
  const p = await newPackage();
  await post(`/api/packages/${p.id}/documents`, { number: '001-0001', add: true });
  ok('by default the date is on and the rest off', JSON.stringify((await ownerPkg(p.id)).settings) ===
    JSON.stringify({ number: false, rev: false, date: true, note: false, collapsed: false }));
  let page = (await req(p.path)).text;
  ok('the default page shows the title and date, not the number, revision or note', page.includes('>Owner memo</a>') &&
    page.includes('2026-09-21') && !page.includes('001-0001-B') && !page.includes('>001-0001 ') && !page.includes('second draft'));
  ok('a partial change keeps the rest', (await post(`/api/packages/${p.id}`, { settings: { number: true, note: true } })).status === 200 &&
    JSON.stringify((await ownerPkg(p.id)).settings) === JSON.stringify({ number: true, rev: false, date: true, note: true, collapsed: false }));
  page = (await req(p.path)).text;
  ok('then the page shows the number and note', page.includes('<span class="n">001-0001</span> Owner memo</a>') && page.includes('second draft'));
  ok('date off hides the date', (await post(`/api/packages/${p.id}`, { settings: { date: false } })).status === 200 &&
    !(await req(p.path)).text.includes('2026-09-21'));
  ok('a setting that is not a boolean is refused', (await post(`/api/packages/${p.id}`, { settings: { number: 'yes' } })).status === 400);
  ok('an unknown setting is refused', (await post(`/api/packages/${p.id}`, { settings: { secret: true } })).status === 400);
  ok('a reader cannot change them', (await post(`/api/packages/${p.id}`, { settings: { number: false } }, BOB.email)).status === 403);
});

await kase('6: a package pins a revision', async () => {
  const p = await newPackage();
  ok('a revision the document does not have is refused', (await post(`/api/packages/${p.id}/documents`,
    { number: '001-0001', add: true, rev: 'Z' })).status === 400);
  ok('adding 001-0001 pinned to A', (await post(`/api/packages/${p.id}/documents`, { number: '001-0001', add: true, rev: 'A' })).status === 200);
  ok('the owner sees the pin', JSON.stringify((await ownerPkg(p.id)).documents) ===
    JSON.stringify([{ number: '001-0001', rev: 'A', folder: null, desc_mode: 'doc', description: null }]));
  ok('/p/<t>/<N> gives A, not the newest B', (await req(`${p.path}/001-0001`)).text.endsWith('001-0001-A'));
  ok('the package token reaches no other revision: the older link shape is 404 for A and B',
    (await req(`${p.path}/001-0001-A.pdf`)).status === 404 && (await req(`${p.path}/001-0001-B.pdf`)).status === 404);
  ok('/files/ needs sign-in even with the token known', (await req('/files/001-0001-B.pdf')).status === 403);
  ok('a change that sends no rev keeps the pin', (await post(`/api/packages/${p.id}/documents`,
    { number: '001-0001', add: true, desc_mode: 'none' })).status === 200 && (await ownerPkg(p.id)).documents[0].rev === 'A');
  ok('adding it again with rev null re-pins it to the newest', (await post(`/api/packages/${p.id}/documents`,
    { number: '001-0001', add: true, rev: null })).status === 200 && (await req(`${p.path}/001-0001`)).text.endsWith('001-0001-B') &&
    (await ownerPkg(p.id)).documents.length === 1 && (await ownerPkg(p.id)).documents[0].rev === null);
  ok('the page no longer says each document is its newest revision', !(await req(p.path)).text.includes('newest revision'));
});

await kase('7: one naming rule', async () => {
  const f = await req('/files/001-0001-B.pdf', { as: OWNER });
  ok('signed in: "PPP-NNNN-R Title"', cd(f).includes('filename="001-0001-B Owner memo.pdf"'));
  const lib = (await ownerLib()).documents.find((d) => d.number === '001-0001');
  ok('the library gives each revision that name and a file address ending in it',
    lib.revisions[1].name === '001-0001-B Owner memo' && lib.revisions[1].file === named('001-0001', 'B'));
  ok('the named address opens, and the name segment is decoration', (await req(named('001-0001', 'B'), { as: OWNER })).text.endsWith('001-0001-B') &&
    (await req('/files/001-0001-B/anything.pdf', { as: OWNER })).text.endsWith('001-0001-B'));
  ok('the named address is still refused to someone who cannot see it', (await req(named('001-0001', 'B'), { as: BOB.email })).status === 404 &&
    (await req(named('001-0001', 'B'))).status === 403);
  const p = await newPackage();
  await post(`/api/packages/${p.id}/documents`, { number: '001-0001', add: true });
  const name = async () => cd(await req(`${p.path}/001-0001`));
  ok('a package by default: "Title"', (await name()).includes('filename="Owner memo.pdf"') &&
    (await req(p.path)).text.includes(`${p.path}/001-0001/Owner%20memo.pdf`));
  ok('the package\'s named address opens the same PDF', (await req(`${p.path}/001-0001/Owner%20memo.pdf`)).text.endsWith('001-0001-B'));
  await post(`/api/packages/${p.id}`, { settings: { number: true } });
  ok('number on: "PPP-NNNN Title"', (await name()).includes('filename="001-0001 Owner memo.pdf"'));
  await post(`/api/packages/${p.id}`, { settings: { rev: true } });
  ok('number and rev on: "PPP-NNNN-R Title"', (await name()).includes('filename="001-0001-B Owner memo.pdf"'));
  await post(`/api/packages/${p.id}`, { settings: { number: false } });
  ok('rev alone: "Title (rev R)"', (await name()).includes('filename="Owner memo (rev B).pdf"') &&
    (await req(p.path)).text.includes('>Owner memo (rev B)</a>'));
  const l = await mkLink({ number: '001-0001' });
  ok('a single public link: "Title"', cd(await req(pathOf(l))).includes('filename="Owner memo.pdf"'));
});

await kase('8: a package has several links', async () => {
  const p = await newPackage();
  await post(`/api/packages/${p.id}/documents`, { number: '003-0001', add: true });
  const two = await mkLink({ package: p.id }, { name: 'for the bank' });
  const path2 = pathOf(two);
  const mine = (await ownerLib()).links.filter((l) => l.target.package === p.id);
  ok('the owner sees both links, targeting the package', mine.map((l) => l.name).join() === 'public-link-1,for the bank' &&
    mine.every((l) => /^[0-9a-f]{8}$/.test(l.id) && l.url.startsWith(`${ORIGIN}/p/`)));
  ok('both serve the page and its document', (await req(p.path)).text.includes('Cover letter') &&
    (await req(`${path2}/003-0001`)).text.endsWith('003-0001-A') && (await req(path2.replace('/p/', '/k/'))).status === 200);
  ok('a package link can be repointed at a document, and then is one', (await setLink(two.data.id, { target: { number: '001-0001', rev: null } })).status === 200 &&
    (await req(path2)).text.endsWith('001-0001-B') && (await req(`${path2}/003-0001`)).status === 404);
  ok('a reader cannot make one', (await post('/api/links', { target: { package: p.id } }, BOB.email)).status === 403);
  ok('archiving one leaves the other', (await setLink(two.data.id, { state: 'archived' })).status === 200 &&
    (await req(path2)).status === 404 && (await req(p.path)).status === 200);
  const doc = await mkLink({ number: '003-0001' });
  const dpath = pathOf(doc);
  ok('a document\'s link token is not a package: /p/<it>/<N> and /k/<it> are 404', (await req(dpath)).text.endsWith('003-0001-A') &&
    (await req(`${dpath}/003-0001`)).status === 404 && (await req(dpath.replace('/p/', '/k/'))).status === 404 &&
    (await req(`${dpath.replace('/p/', '/k/')}/003-0001.pdf`)).status === 404);
});

await kase('14: package folders', async () => {
  const p = await newPackage('Foldered');
  const mk = (body) => post(`/api/packages/${p.id}/folders`, body);
  const letters = (await mk({ name: 'Letters' })).data;
  const refs = (await mk({ name: 'References', parent: letters.id })).data;
  const deep = (await mk({ name: 'Deep', parent: refs.id })).data;
  ok('folders nest', letters.parent === null && refs.parent === letters.id && deep.parent === refs.id);
  ok('a parent from nowhere is refused', (await mk({ name: 'x', parent: '00000000' })).status === 400);
  ok('a reader cannot make one', (await post(`/api/packages/${p.id}/folders`, { name: 'x' }, BOB.email)).status === 403);
  await post(`/api/packages/${p.id}/documents`, { number: '003-0001', add: true, folder: deep.id });
  await post(`/api/packages/${p.id}/documents`, { number: '003-0002', add: true });
  ok('a folder of another package is refused for a document', (await post(`/api/packages/${(await newPackage()).id}/documents`,
    { number: '003-0001', add: true, folder: letters.id })).status === 400);
  const page = (await req(p.path)).text;
  const at = (s) => page.indexOf(s);
  ok('the visitor page shows the tree: Letters > References > Deep > the letter, the plain one at the top',
    at('<summary>Letters</summary>') < at('<summary>References</summary>') && at('<summary>References</summary>') < at('<summary>Deep</summary>') &&
    at('<summary>Deep</summary>') < at('Cover letter') && at('Plain title') < at('<summary>Letters</summary>') && page.includes('<details open>'));
  ok('moving Letters under Deep is a cycle, refused', (await post(`/api/packages/${p.id}/folders/${letters.id}`, { parent: deep.id })).status === 400);
  ok('a folder under itself is refused', (await post(`/api/packages/${p.id}/folders/${refs.id}`, { parent: refs.id })).status === 400);
  ok('renaming works', (await post(`/api/packages/${p.id}/folders/${deep.id}`, { name: 'Deeper' })).data.name === 'Deeper');
  ok('deleting References lifts Deeper up to Letters', (await post(`/api/packages/${p.id}/folders/${refs.id}`, { delete: true })).status === 200 &&
    (await ownerPkg(p.id)).folders.find((x) => x.id === deep.id).parent === letters.id);
  ok('a deleted folder is refused for a document', (await post(`/api/packages/${p.id}/documents`,
    { number: '003-0002', add: true, folder: refs.id })).status === 400);
  ok('moving Deeper to the top works', (await post(`/api/packages/${p.id}/folders/${deep.id}`, { parent: null })).data.parent === null);
  await post(`/api/packages/${p.id}/folders/${deep.id}`, { parent: letters.id });
  await post(`/api/packages/${p.id}/folders/${deep.id}`, { delete: true });
  const pk = await ownerPkg(p.id);
  ok('deleting Deeper lifts the letter to Letters; nothing is lost', JSON.stringify(pk.folders) ===
    JSON.stringify([{ id: letters.id, parent: null, name: 'Letters' }]) && pk.documents.find((x) => x.number === '003-0001').folder === letters.id);
  const pal = 'pal@example.com';
  await mkLink({ package: p.id }, { kind: 'private', people: [pal] });
  const g = (await req('/api/library', { as: pal })).data.packages[0];
  ok('a guest\'s package carries the folders and each document\'s folder', JSON.stringify(g.folders) === JSON.stringify(pk.folders) &&
    g.documents.find((x) => x.number === '003-0001').folder === letters.id);
});

await kase('15: document descriptions', async () => {
  const set = (num, description, as = OWNER) => post(`/api/documents/${num}/description`, { description }, as);
  ok('the owner sets a one-line description, whitespace folded', (await set('003-0001', '  Autobox   working\nprinciple ')).data.description ===
    'Autobox working principle');
  ok('a reader cannot', (await set('105-0001', 'mine', BOB.email)).status === 403);
  ok('over 200 characters is refused', (await set('003-0001', 'x'.repeat(201))).status === 400);
  ok('an unknown document is 404', (await set('999-9999', 'x')).status === 404);
  ok('every viewer who sees it is shown it', (await ownerLib()).documents.find((d) => d.number === '003-0001').description === 'Autobox working principle');
  await set('105-0001', 'Course outline');
  ok('Bob sees his document\'s description', (await req('/api/library', { as: BOB.email })).data.documents[0].description === 'Course outline');
  const p = await newPackage('Described');
  await post(`/api/packages/${p.id}/documents`, { number: '003-0001', add: true });
  await post(`/api/packages/${p.id}/documents`, { number: '003-0002', add: true, desc_mode: 'custom', description: 'Just for this pack' });
  await post(`/api/packages/${p.id}/documents`, { number: '105-0001', add: true, desc_mode: 'none' });
  const page = (await req(p.path)).text;
  ok('the package page shows the document\'s own, the override, and none', page.includes('Autobox working principle') &&
    page.includes('Just for this pack') && !page.includes('Course outline'));
  ok('an unknown mode is refused', (await post(`/api/packages/${p.id}/documents`, { number: '003-0001', add: true, desc_mode: 'loud' })).status === 400);
  const pal = 'pal@example.com';
  await mkLink({ package: p.id }, { kind: 'private', people: [pal] });
  const g = (await req('/api/library', { as: pal })).data.packages[0];
  ok('a guest gets each description resolved, and no mode', JSON.stringify(g.documents.map((x) => x.description)) ===
    JSON.stringify(['Autobox working principle', 'Just for this pack', null]) && g.documents.every((x) => !('desc_mode' in x)));
  ok('"" clears it', (await set('003-0001', '')).data.description === null &&
    !(await req(p.path)).text.includes('Autobox working principle'));
});

await kase('4: no categories, groups stay', async () => {
  const l = await ownerLib();
  ok('a sub-project carries its parent group by name', l.projects.find((p) => p.number === '007').group === 'Career' &&
    l.projects.find((p) => p.number === '003').group === null);
  ok('no document carries a category, not even a title with a comma',
    l.documents.every((d) => !('category' in d)) && l.documents.some((d) => d.title === 'Cover letter, Arista'));
  ok('the category endpoint is gone', (await post('/api/documents/003-0001/category', { category: 'Letters' })).status === 404);
});

await kase('requests: a new section or folder is asked for, never made', async () => {
  const before = JSON.stringify(reg.projects);
  const sec = await post('/api/requests', { kind: 'section', name: 'Taxes', note: 'Somewhere in the 200s.' });
  const fol = await post('/api/requests', { kind: 'folder', parent: '105', name: 'Labs' });
  ok('the owner asks for a section and for a folder in a project', sec.status === 200 && sec.data.status === 'new' &&
    sec.data.kind === 'section' && sec.data.parent === null && sec.data.note === 'Somewhere in the 200s.' &&
    fol.status === 200 && fol.data.parent === '105' && fol.data.note === null && /^[0-9a-f]{8}$/.test(fol.data.id));
  ok('a wrong kind, no name, a folder with no or an unknown project, or a section with a parent is 400',
    (await post('/api/requests', { kind: 'shelf', name: 'x' })).status === 400 &&
    (await post('/api/requests', { kind: 'section', name: ' ' })).status === 400 &&
    (await post('/api/requests', { kind: 'folder', name: 'x' })).status === 400 &&
    (await post('/api/requests', { kind: 'folder', name: 'x', parent: '777' })).status === 400 &&
    (await post('/api/requests', { kind: 'section', name: 'x', parent: '105' })).status === 400);
  const own = await ownerLib();
  ok('his library lists both and the register is untouched: nothing was made or renumbered',
    own.requests.map((x) => x.id).join() === [sec.data.id, fol.data.id].join() && JSON.stringify(reg.projects) === before &&
    own.projects.every((p) => p.name !== 'Taxes' && p.name !== 'Labs'));
  const lib = await req('/api/library', { as: BOB.email });
  ok('a member may not ask, and is told nothing of it', (await post('/api/requests', { kind: 'section', name: 'Mine' }, BOB.email)).status === 403 &&
    !lib.text.includes('Taxes') && !('requests' in lib.data) && (await req('/api/feedback/requests', { as: BOB.email })).status === 403);
  env.FEEDBACK_TOKENS = 'box-id.access';
  const tok = await jwt(undefined, { extra: { common_name: 'box-id.access' } });
  const box = (path, body) => req(path, { token: tok, ...(body === undefined ? {} : { method: 'POST', body }) });
  const got = await box('/api/feedback/requests?status=new');
  ok('the feedback token reads new requests with the fields the poller uses', got.status === 200 &&
    got.data.requests.length === 2 && ['id', 'kind', 'parent', 'name', 'note', 'created', 'status'].every((k) => k in got.data.requests[0]));
  ok('the owner\'s browser and an unnamed token are refused there',
    (await req('/api/feedback/requests', { as: OWNER })).status === 403 &&
    (await post(`/api/feedback/requests/${sec.data.id}`, { status: 'done' })).status === 403 &&
    (await req('/api/feedback/requests', { token: await jwt(undefined, { extra: { common_name: 'stray.access' } }) })).status === 403);
  const dl = await box(`/api/feedback/requests/${sec.data.id}`, { status: 'delivered' });
  ok('the box marks one delivered and it leaves the new list', dl.status === 200 && dl.data.status === 'delivered' &&
    (await box('/api/feedback/requests?status=new')).data.requests.map((x) => x.id).join() === fol.data.id);
  await box(`/api/feedback/requests/${sec.data.id}`, { status: 'done', reply: 'made 210' });
  const late = await box(`/api/feedback/requests/${sec.data.id}`, { status: 'delivered' });
  ok('done keeps its reply and a late delivered never moves it back', late.data.status === 'done' && late.data.reply === 'made 210' &&
    (await box(`/api/feedback/requests/${sec.data.id}`, { status: 'gone' })).status === 400 &&
    (await box('/api/feedback/requests/00000000', { status: 'done' })).status === 404);
  ok('the feedback list is not mixed with requests', (await box('/api/feedback')).data.feedback.length === 0);
});

await kase('locks: a locked package, link or group refuses every change but unlocking', async () => {
  const p = await newPackage('Locked pack');
  await post(`/api/packages/${p.id}/documents`, { number: '001-0001', add: true, rev: 'A' });
  const f = (await post(`/api/packages/${p.id}/folders`, { name: 'Top' })).data;
  const pl = (await mkLink({ package: p.id })).data;
  const dl = (await mkLink({ number: '002-0001', rev: null }, { kind: 'private', people: ['pal@example.com'] })).data;
  const g = (await post('/api/groups', { name: 'Crew' })).data;
  await post(`/api/groups/${g.id}`, { add: { email: 'crew@example.com' } });
  ok('lock must be sent on its own, as a boolean', (await post(`/api/packages/${p.id}`, { locked: true, name: 'x' })).status === 400 &&
    (await setLink(dl.id, { locked: 'yes' })).status === 400);
  ok('each kind locks', (await post(`/api/packages/${p.id}`, { locked: true })).data.locked === true &&
    (await setLink(dl.id, { locked: true })).data.locked === true && (await post(`/api/groups/${g.id}`, { locked: true })).data.locked === true);
  const refused = [
    ['package rename', `/api/packages/${p.id}`, { name: 'Other' }], ['package settings', `/api/packages/${p.id}`, { settings: { rev: true } }],
    ['package archive', `/api/packages/${p.id}`, { archived: true }],
    ['package add', `/api/packages/${p.id}/documents`, { number: '002-0001', add: true }],
    ['package remove', `/api/packages/${p.id}/documents`, { number: '001-0001', add: false }],
    ['package rev pick', `/api/packages/${p.id}/documents`, { number: '001-0001', add: true, rev: 'B' }],
    ['package new folder', `/api/packages/${p.id}/folders`, { name: 'New' }],
    ['package folder rename', `/api/packages/${p.id}/folders/${f.id}`, { name: 'Renamed' }],
    ['package folder delete', `/api/packages/${p.id}/folders/${f.id}`, { delete: true }],
    ['link rename', `/api/links/${dl.id}`, { name: 'n' }], ['link repoint', `/api/links/${dl.id}`, { target: { number: '001-0001', rev: 'A' } }],
    ['link kind', `/api/links/${dl.id}`, { kind: 'public' }], ['link disable', `/api/links/${dl.id}`, { state: 'disabled' }],
    ['link people', `/api/links/${dl.id}`, { people: [] }], ['link groups', `/api/links/${dl.id}`, { groups: [g.id] }],
    ['group rename', `/api/groups/${g.id}`, { name: 'Other' }], ['group add', `/api/groups/${g.id}`, { add: { email: 'new@example.com' } }],
    ['group remove', `/api/groups/${g.id}`, { remove: 'crew@example.com' }], ['group grant', `/api/groups/${g.id}`, { grant: 'project:105' }],
    ['group delete', `/api/groups/${g.id}`, { delete: true }],
  ];
  const got = [];
  for (const [what, path, body] of refused) {
    const r = await post(path, body);
    if (r.status !== 409 || !/locked/.test(r.text)) got.push(`${what} ${r.status}`);
  }
  ok('every other change to a locked item is 409 with a short message' + (got.length ? `: ${got.join(', ')}` : ''), !got.length);
  const own = await ownerLib();
  const op = own.packages.find((x) => x.id === p.id), ol = own.links.find((x) => x.id === dl.id), og = own.groups.find((x) => x.id === g.id);
  ok('nothing changed, each says locked, and the lock is in its history', op.locked && op.name === 'Locked pack' && op.documents.length === 1 &&
    op.documents[0].rev === 'A' && op.folders.length === 1 && ol.locked && ol.state === 'live' && ol.people.join() === 'pal@example.com' &&
    og.locked && og.members.length === 1 && og.grants.length === 0 && op.history.at(-1).what === 'locked' &&
    ol.history.at(-1).what === 'locked' && og.history.map((x) => x.what).join() === 'locked');
  ok('a locked package still opens, still takes new links, and its link can still be locked apart',
    (await req(pathOf({ data: pl }))).status === 200 && (await mkLink({ package: p.id })).status === 200 &&
    (await req(`${pathOf({ data: pl })}/001-0001`)).text.endsWith('001-0001-A'));
  ok('a locked private link still opens for its person', (await req(pathOf({ data: dl }), { as: 'pal@example.com' })).status === 200);
  const g2 = (await post('/api/groups', { name: 'Named' })).data;
  const l2 = (await mkLink({ number: '002-0001', rev: null }, { kind: 'private', groups: [g2.id] })).data;
  await setLink(l2.id, { locked: true });
  ok('an unlocked group a locked link names cannot be deleted from under it',
    (await post(`/api/groups/${g2.id}`, { delete: true })).status === 409 && (await post(`/api/groups/${g2.id}`, { name: 'Renamed' })).status === 200);
  ok('unlocking needs only {locked: false}, then changes go through', (await post(`/api/packages/${p.id}`, { locked: false })).status === 200 &&
    (await post(`/api/packages/${p.id}`, { name: 'Other' })).status === 200 && (await setLink(dl.id, { locked: false })).status === 200 &&
    (await setLink(dl.id, { name: 'renamed' })).status === 200 && (await post(`/api/groups/${g.id}`, { locked: false })).status === 200 &&
    (await post(`/api/groups/${g.id}`, { name: 'Crew 2' })).status === 200 &&
    (await ownerLib()).groups.find((x) => x.id === g.id).history.map((x) => x.what).join() === 'locked,unlocked');
  ok('an unlocked item was never refused: a fresh package takes a folder', (await post(`/api/packages/${(await newPackage('Free')).id}/folders`, { name: 'F' })).status === 200);
  ok('only the owner locks', (await post(`/api/packages/${p.id}`, { locked: true }, BOB.email)).status === 403 &&
    !(await ownerLib()).packages.find((x) => x.id === p.id).locked);
});

await kase('a database made by the older schema migrates', async () => {
  env.DB.raw.exec(`CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT); INSERT INTO meta VALUES ('seeded', '2026-09-01');
    CREATE TABLE links (token TEXT PRIMARY KEY, id TEXT UNIQUE, number TEXT, rev TEXT, name TEXT, created TEXT);
    CREATE TABLE packages (id TEXT PRIMARY KEY, token TEXT UNIQUE, name TEXT, created TEXT);
    CREATE TABLE package_docs (package TEXT, number TEXT, PRIMARY KEY (package, number));
    CREATE TABLE categories (number TEXT PRIMARY KEY, category TEXT NOT NULL);
    INSERT INTO packages VALUES ('0000abcd', 'oldpackagetoken000000000', 'Normal AI', '2026-09-01');
    INSERT INTO package_docs VALUES ('0000abcd', '001-0001');
    INSERT INTO categories VALUES ('003-0001', 'Letters');`);
  const page = await req('/p/oldpackagetoken000000000');
  ok('the old package token still serves its page and its document at the newest revision', page.status === 200 &&
    page.text.includes('Owner memo') && (await req('/p/oldpackagetoken000000000/001-0001')).text.endsWith('001-0001-B') &&
    (await req('/k/oldpackagetoken000000000/001-0001.pdf')).status === 200);
  const own = await ownerLib();
  const pk = own.packages.find((p) => p.id === '0000abcd');
  const ls = own.links.filter((l) => l.target.package === '0000abcd');
  ok('the owner sees it as link public-link-1, the document following the newest, default settings',
    JSON.stringify(ls.map((l) => [l.name, l.url, l.kind, l.state])) ===
      JSON.stringify([['public-link-1', `${ORIGIN}/p/oldpackagetoken000000000`, 'public', 'live']]) &&
    pk.documents.length === 1 && pk.documents[0].rev === null && pk.settings.date === true && pk.archived === null);
  env = { ...env, DB: { ...env.DB } };   // a new isolate on the same database
  await req('/p/oldpackagetoken000000000');
  ok('a second request does not duplicate the link, and the schema is recorded',
    env.DB.raw.prepare('SELECT count(*) AS c FROM links').get().c === 1 &&
    env.DB.raw.prepare("SELECT v FROM meta WHERE k = 'schema'").get().v === '7');
  ok('the migrated package and its old link take a lock, and the link still opens locked',
    (await post('/api/packages/0000abcd', { locked: true })).status === 200 &&
    (await setLink((await ownerLib()).links[0].id, { locked: true })).status === 200 &&
    (await req('/p/oldpackagetoken000000000/001-0001')).status === 200 &&
    (await post('/api/packages/0000abcd', { locked: false })).status === 200 &&
    (await setLink((await ownerLib()).links[0].id, { locked: false })).status === 200);
  ok('the migrated package takes a pin, a folder and a second link', (await post('/api/packages/0000abcd/documents',
    { number: '001-0001', add: true, rev: 'A' })).status === 200 && (await req('/p/oldpackagetoken000000000/001-0001')).text.endsWith('001-0001-A') &&
    (await post('/api/packages/0000abcd/folders', { name: 'F' })).status === 200 &&
    (await mkLink({ package: '0000abcd' })).data.name === 'public-link-2');
  ok('the old categories table is left alone and unread', env.DB.raw.prepare('SELECT count(*) AS c FROM categories').get().c === 1 &&
    (await ownerLib()).documents.every((d) => !('category' in d)));
  env.DB.raw.prepare("DELETE FROM links WHERE name = 'public-link-1'").run();
  ok('packages.token is not read for access: with its link gone, the old token is 404',
    (await req('/p/oldpackagetoken000000000')).status === 404 && (await req('/k/oldpackagetoken000000000')).status === 404);
});

await kase('moved_from: a renumbered document keeps its place', async () => {
  // before the move, on 001-0001: a doc grant to Bob's group, stars, a description, links of each kind, and a
  // package row pinned to A in a folder with its own description
  const dg = await groupOf(BOB.email);
  await post(`/api/groups/${dg.id}`, { grant: 'doc:001-0001' });
  await post('/api/documents/001-0001/star', { starred: true }, BOB.email);
  await post('/api/documents/001-0001/star', { starred: true });
  await post('/api/documents/001-0001/description', { description: 'The memo' });
  const follow = pathOf(await mkLink({ number: '001-0001', rev: null }, { name: 'follows' }));
  const onA = pathOf(await mkLink({ number: '001-0001', rev: 'A' }, { name: 'on A' }));
  const priv = await mkLink({ number: '001-0001', rev: 'A' }, { kind: 'private', people: ['pal@example.com'] });
  const p = await newPackage('Normal AI');
  const f = (await post(`/api/packages/${p.id}/folders`, { name: 'Letters' })).data;
  await post(`/api/packages/${p.id}/documents`, { number: '001-0001', add: true, rev: 'A', folder: f.id, desc_mode: 'custom', description: 'Pack line' });
  // cc-docs move 001-0001 -> 003-0009, and the mirror publishes it
  republish((moved) => {
    moved.documents['003-0009'] = { ...moved.documents['001-0001'], number: '003-0009', project: '003', moved_from: ['001-0001'] };
    delete moved.documents['001-0001'];
  });
  const dh = await req('/api/library', { as: BOB.email });
  ok('Bob\'s grant and star follow the new number', nums(dh) === '003-0009 105-0001' &&
    dh.data.documents.find((d) => d.number === '003-0009').starred === true);
  const own = await ownerLib();
  const doc = own.documents.find((d) => d.number === '003-0009');
  ok('the owner\'s star and the description are on the new number', doc.starred === true && doc.description === 'The memo' &&
    !own.documents.some((d) => d.number === '001-0001'));
  ok('every link targets the new number', ['follows', 'on A', 'Public link', 'private-link-1'].every((n) =>
    own.links.find((l) => l.name === n).target.number === '003-0009'));
  ok('both public links still serve, the pinned one on A', (await req(follow)).text.endsWith('001-0001-B') && (await req(onA)).text.endsWith('001-0001-A'));
  ok('the private link still serves its person', (await req(pathOf(priv), { as: 'pal@example.com' })).text.endsWith('001-0001-A'));
  ok('the owner\'s package still lists it, pinned to A, in its folder, with its line', JSON.stringify((await ownerPkg(p.id)).documents) ===
    JSON.stringify([{ number: '003-0009', rev: 'A', folder: f.id, desc_mode: 'custom', description: 'Pack line' }]) &&
    (await req(`${p.path}/003-0009`)).text.endsWith('001-0001-A') && (await req(`${p.path}/001-0001`)).status === 404);
  ok('the group grant is rekeyed', (await groupOf(BOB.email)).grants.includes('doc:003-0009'));
  ok('no row is left on the old number', ['visibility', 'stars', 'links', 'package_docs', 'doc_meta'].every((t) =>
    env.DB.raw.prepare(`SELECT count(*) AS c FROM ${t} WHERE number = '001-0001'`).get().c === 0) &&
    env.DB.raw.prepare("SELECT count(*) AS c FROM grants WHERE node = 'doc:001-0001'").get().c === 0);
  const d = await req('/d/001-0001', { as: BOB.email });
  ok('/d/<old> sends Bob to the new number\'s newest file, /d/<old>-A to A', d.status === 302 &&
    d.headers.get('Location') === `/files/003-0009-B/${encodeURIComponent('003-0009-B Owner memo')}.pdf` &&
    (await req('/d/001-0001-A', { as: BOB.email })).headers.get('Location').startsWith('/files/003-0009-A/'));
  ok('/d/<old> is 404 for Alice, who cannot see it, and refused signed out', (await req('/d/001-0001', { as: ALICE.email })).status === 404 &&
    (await req('/d/001-0001')).status === 403);
  ok('the old number\'s file address is gone', (await req('/files/001-0001-B.pdf', { as: OWNER })).status === 404);
});

await kase('24: a revision\'s source, to the owner alone', async () => {
  const TGZ = '\x1f\x8b fixture source 105-0001-A';
  republish((next, T2) => {
    next.documents['105-0001'].revisions[0].sources = 'sources/105/105-0001-A.tar.gz';
    next.documents['001-0001'].revisions[0].sources = 'sources/../../register.json';
    mkdirSync(join(T2, 'data', 'sources', '105'), { recursive: true });
    writeFileSync(join(T2, 'data', 'sources', '105', '105-0001-A.tar.gz'), TGZ);
  });
  const src = '/api/documents/105-0001/revisions/A/source';
  const o = await req(src, { as: OWNER });
  ok('the owner downloads it, as an attachment named for the revision', o.status === 200 && o.text === TGZ &&
    o.headers.get('Content-Type') === 'application/gzip' && cd(o) === 'attachment; filename="105-0001-A-source.tar.gz"');
  const own = await ownerLib();
  const revs = (num) => own.documents.find((d) => d.number === num).revisions;
  ok('the owner\'s library points at it, and at nothing for a revision with none or a path out of sources/',
    revs('105-0001')[0].source === src && revs('001-0001').every((r) => r.source === null) &&
    (await req('/api/documents/001-0001/revisions/A/source', { as: OWNER })).status === 404);
  // a reader in a group granted 105, a person on a private link to it, a public link and a package reaching it
  const pal = 'pal@example.com';
  const priv = await mkLink({ number: '105-0001', rev: null }, { kind: 'private', people: [pal] });
  const pub = await mkLink({ number: '105-0001', rev: 'A' });
  const pk = await newPackage('Course pack');
  await post(`/api/packages/${pk.id}/documents`, { number: '105-0001', add: true });
  const dh = await req('/api/library', { as: BOB.email });
  ok('a group member sees the document but gets 404 for its source, and his library never names it',
    nums(dh) === '105-0001' && (await req(src, { as: BOB.email })).status === 404 &&
    !dh.text.includes('.tar.gz') && !dh.text.includes('/source') && dh.data.documents[0].revisions.every((r) => !('source' in r)));
  const pl = await req('/api/library', { as: pal });
  ok('a private-link person gets 404 for it, and their library never names it', nums(pl) === '105-0001' &&
    (await req(src, { as: pal })).status === 404 && !pl.text.includes('.tar.gz'));
  ok('signed out it is refused', (await req(src)).status === 403);
  // each answers as it would for any path it does not know: 404, or 403 signed out; never the archive
  const tries = [[pathOf(pub) + '/source'], [pathOf(pub) + '/105-0001-A.tar.gz'], [`${pk.path}/105-0001/source`],
    [`${pk.path}/105-0001-A.tar.gz`], [pathOf(priv) + '/105-0001-A.tar.gz', pal], ['/k/' + pk.path.slice(3) + '/105-0001-A.tar.gz'],
    ['/d/105-0001-A/source', OWNER], ['/files/105-0001-A.tar.gz', OWNER], ['/files/105-0001-A/source.tar.gz', OWNER],
    ['/data/sources/105/105-0001-A.tar.gz', OWNER], ['/data/sources/105/105-0001-A.tar.gz'], ['/sources/105/105-0001-A.tar.gz', OWNER]];
  const lesson = pathOf(await mkLink({ number: '105-0001', rev: null }, { kind: 'signed-in' }));
  tries.push([lesson + '/source', OWNER], [lesson + '/105-0001-A.tar.gz', OWNER]);
  const got = await Promise.all(tries.map(([u, as]) => req(u, as ? { as } : {})));
  ok('a signed-in /l/ link still sends the owner to the PDF', (await req(lesson, { as: OWNER })).headers.get('Location') === named('105-0001', 'A'));
  ok('no /p/, /s/, /k/, /l/, /d/, /files/ or bare path serves it', got.every((r) => [403, 404].includes(r.status) && !r.text.includes('fixture source')));
});

await kase('25: feedback, the owner\'s and the box\'s alone', async () => {
  const fb = '/api/documents/105-0001/feedback';
  const words = 'My own words for the intro.\nSecond line, kept.';
  const a = await post(fb, { rev: 'A', section: '1 Introduction', kind: 'text', text: words });
  ok('the owner writes his own text for a section', a.status === 200 && a.data.status === 'new' &&
    a.data.section === '1 Introduction' && a.data.text === words && a.data.rev === 'A' && /^[0-9a-f]{8}$/.test(a.data.id));
  const b = await post(fb, { kind: 'request', text: 'Shorten it. '.repeat(900) });
  ok('a request on the whole document, longer than 8 KB, lands on the newest revision with no section',
    b.status === 200 && b.data.section === null && b.data.rev === 'A' && b.data.kind === 'request');
  ok('a wrong kind, revision, empty text or an unknown document is refused', (await post(fb, { kind: 'rant', text: 'x' })).status === 400 &&
    (await post(fb, { kind: 'text', text: 'x', rev: 'Z' })).status === 400 && (await post(fb, { kind: 'text', text: '  ' })).status === 400 &&
    (await post('/api/documents/105-0099/feedback', { kind: 'text', text: 'x' })).status === 404);
  const list = await req(fb, { as: OWNER });
  ok('the owner lists it per document, and his library carries it', list.status === 200 &&
    list.data.feedback.map((x) => x.id).join() === [a.data.id, b.data.id].join() &&
    (await ownerLib()).documents.find((d) => d.number === '105-0001').feedback.length === 2 &&
    (await ownerLib()).documents.find((d) => d.number === '001-0001').feedback.length === 0);
  // nobody else is told it exists
  const pal = 'pal@example.com';
  const priv = await mkLink({ number: '105-0001', rev: null }, { kind: 'private', people: [pal] });
  const pub = await mkLink({ number: '105-0001', rev: null });
  for (const [who, as] of [['a group member', BOB.email], ['a private-link person', pal]]) {
    const lib = await req('/api/library', { as });
    ok(`${who}: 404 on the list, 403 on a write, and no trace in the library`, nums(lib) === '105-0001' &&
      (await req(fb, { as })).status === 404 && (await post(fb, { kind: 'request', text: 'mine' }, as)).status === 403 &&
      !lib.text.includes('feedback') && !lib.text.includes('My own words') &&
      (await req('/api/feedback?status=new', { as })).status === 403);
  }
  ok('the private and public link pages carry none of it', !(await req(pathOf(priv), { as: pal })).text.includes('My own words') &&
    !(await req(pathOf(pub))).text.includes('My own words'));
  ok('signed out it is refused', (await req(fb)).status === 403 && (await req('/api/feedback?status=new')).status === 403);
  ok('only the owner\'s count moved: nothing was made by the refused writes',
    env.DB.raw.prepare('SELECT count(*) AS c FROM feedback').get().c === 2);
  // the box's poller: an Access service token FEEDBACK_TOKENS names, and nobody else
  env.FEEDBACK_TOKENS = 'box-id.access, spare.access';
  const svc = async (cn) => jwt(undefined, { extra: { common_name: cn } });
  const box = async (path, body, headers = {}) => req(path, { token: await svc('box-id.access'), headers,
    ...(body === undefined ? {} : { method: 'POST', body }) });
  const got = await box('/api/feedback?status=new');
  ok('the box reads new feedback with the fields its poller uses', got.status === 200 && got.data.feedback.length === 2 &&
    ['id', 'number', 'rev', 'section', 'kind', 'text', 'created', 'status'].every((k) => k in got.data.feedback[0]) &&
    got.data.feedback[0].number === '105-0001' && got.data.feedback[0].section === '1 Introduction');
  ok('the owner\'s own browser is refused there', (await req('/api/feedback?status=new', { as: OWNER })).status === 403 &&
    (await post(`/api/feedback/${a.data.id}`, { status: 'done' })).status === 403);
  ok('a service token not named, a mismatched client-id header or a header alone is refused',
    (await req('/api/feedback?status=new', { token: await svc('stray.access') })).status === 403 &&
    (await box('/api/feedback?status=new', undefined, { 'Cf-Access-Client-Id': 'spare.access' })).status === 403 &&
    (await req('/api/feedback?status=new', { headers: { 'Cf-Access-Client-Id': 'box-id.access' } })).status === 403 &&
    (await box('/api/feedback?status=new', undefined, { 'Cf-Access-Client-Id': 'box-id.access' })).status === 200);
  ok('the named token reaches nothing else', (await req('/api/library', { token: await svc('box-id.access') })).status === 403 &&
    (await req(fb, { token: await svc('box-id.access') })).status === 403);
  ok('a bad status filter or answer is 400, an unknown id 404', (await box('/api/feedback?status=odd')).status === 400 &&
    (await box(`/api/feedback/${a.data.id}`, { status: 'lost' })).status === 400 &&
    (await box('/api/feedback/00000000', { status: 'delivered' })).status === 404);
  const dl = await box(`/api/feedback/${a.data.id}`, { status: 'delivered' });
  ok('the box marks one delivered; it leaves the new list', dl.status === 200 && dl.data.status === 'delivered' &&
    (await box('/api/feedback?status=new')).data.feedback.map((x) => x.id).join() === b.data.id);
  const done = await box(`/api/feedback/${a.data.id}`, { status: 'done', reply: 'answered by rev B' });
  ok('done with the reply cc-docs writes: answered_rev read from it', done.data.status === 'done' && done.data.answered_rev === 'B' &&
    done.data.reply === 'answered by rev B');
  const late = await box(`/api/feedback/${a.data.id}`, { status: 'delivered' });
  ok('a late "delivered" never moves it back', late.data.status === 'done' && late.data.answered_rev === 'B');
  const exp = await box(`/api/feedback/${b.data.id}`, { status: 'done', reply: 'Shortened.', answered_rev: 'C' });
  ok('an explicit answered_rev is kept', exp.data.answered_rev === 'C');
  const mine = (await req(fb, { as: OWNER })).data.feedback;
  ok('the owner sees each status, reply and answering revision', mine[0].status === 'done' && mine[0].reply === 'answered by rev B' &&
    mine[0].answered_rev === 'B' && mine[1].answered_rev === 'C');
  ok('still nothing for the member', !(await req('/api/library', { as: BOB.email })).text.includes('answered by'));
  // cc-docs move: the feedback follows the document
  republish((moved) => {
    moved.documents['105-0009'] = { ...moved.documents['105-0001'], number: '105-0009', moved_from: ['105-0001'] };
    delete moved.documents['105-0001'];
  });
  ok('a moved document keeps its feedback under the new number',
    (await req('/api/documents/105-0009/feedback', { as: OWNER })).data.feedback.length === 2 &&
    env.DB.raw.prepare("SELECT count(*) AS c FROM feedback WHERE number = '105-0001'").get().c === 0 &&
    (await box('/api/feedback')).data.feedback.every((x) => x.number === '105-0009'));
});

// ── the editing mode (EDITOR in lib/library.js, docs/library-editor.md) ──

const MAIN_TEX = ['\\documentclass{article}', '\\usepackage{amsmath}', '\\begin{document}', '\\section{Introduction}',
  'Intro line one.', 'Intro line two.', '\\input{sections/method}', '\\section*{Results}', 'Result line.', '\\end{document}', ''].join('\n');
const METHOD_TEX = ['\\subsection{Method}', 'Method line one.', '% \\section{Commented out}', 'Method line two.', ''].join('\n');
const LONG_PATH = `deep/${'x'.repeat(60)}/${'y'.repeat(60)}.tex`;
/** A real .tar.gz made by GNU tar in `format` (gnu, pax or ustar) from {path: text | Buffer}, with a symlink. */
function makeTgz(files, format = 'gnu') {
  const dir = mkdtempSync(join(tmpdir(), 'library-pages-sc-src-'));
  for (const [p, v] of Object.entries(files)) { mkdirSync(dirname(join(dir, p)), { recursive: true }); writeFileSync(join(dir, p), v); }
  execFileSync('ln', ['-s', '/etc/passwd', join(dir, 'link.tex')]);
  const out = join(dir, '..', `${dir.split('/').pop()}.tar.gz`);
  execFileSync('tar', [`--format=${format}`, '-czf', out, '-C', dir, ...Object.keys(files).sort(), 'link.tex']);
  return readFileSync(out);
}
const SOURCE = { 'main.tex': MAIN_TEX, 'sections/method.tex': METHOD_TEX, 'refs.bib': '@book{k, title={T}}\n',
  'figure.png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 1, 2]), 'latin1.txt': Buffer.from([0x63, 0x61, 0x66, 0xe9]),
  [LONG_PATH]: '% deep\n' };
/** 105-0001 rev A keeps SOURCE as its source; 001-0001 keeps none. */
function withSource(files = SOURCE, format = 'gnu') {
  return republish((next, T2) => {
    next.documents['105-0001'].revisions[0].sources = 'sources/105/105-0001-A.tar.gz';
    mkdirSync(join(T2, 'data', 'sources', '105'), { recursive: true });
    writeFileSync(join(T2, 'data', 'sources', '105', '105-0001-A.tar.gz'), makeTgz(files, format));
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const svcJwt = (cn) => jwt(undefined, { extra: { common_name: cn } });
/** A request as the box's service token (FEEDBACK_TOKENS names it). */
async function box(path, body, headers = {}) {
  env.FEEDBACK_TOKENS = 'box-id.access';
  return req(path, { token: await svcJwt('box-id.access'), headers, ...(body === undefined ? {} : { method: 'POST', body }) });
}
async function openDraft() {
  const r = await post('/api/documents/105-0001/drafts', {});
  if (r.status !== 200) throw new Error(`opening a draft: ${r.status} ${r.text}`);
  return r.data;
}
const b64 = (u8) => Buffer.from(u8).toString('base64');
const fakePdf = (tag, size = 0) => {
  const head = Buffer.from(`%PDF-1.4\n% draft ${tag}\n`);
  return size ? Buffer.concat([head, Buffer.from(Array.from({ length: size }, (_, i) => (i * 7 + 3) & 255))]) : head;
};
const MAP = { files: ['main.tex', 'sections/method.tex'], boxes: [
  [1, 0, 4, 72, 100, 400, 14], [1, 0, 5, 72, 120, 400, 12], [1, 0, 5, 72, 132, 200, 12],
  [1, 1, 2, 72, 160, 400, 12], [1, 1, 1, 100, 162, 50, 8], [2, 0, 9, 72, 100, 400, 12]] };
/** The box takes every queued job and answers the one for `id` with `result`. */
async function compileWith(id, result) {
  const jobs = (await box('/api/editor/jobs')).data.jobs;
  const j = jobs.find((x) => x.draft === id);
  return { job: j, res: await box(`/api/editor/jobs/${id}`, { seq: j ? j.seq : result.seq, ...result }) };
}
const blobCount = (id, kind) => env.DB.raw.prepare('SELECT count(*) AS c FROM draft_blobs WHERE draft = ? AND kind = ?').get(id, kind).c;

await kase('editor: the kept source is untarred here, in each format tar writes', async () => {
  for (const format of ['gnu', 'pax', 'ustar']) {
    const got = untar(await gunzip(new Uint8Array(makeTgz(SOURCE, format))));
    const names = got.map((e) => e.path).sort();
    ok(`${format}: every regular file with its full path (a ${LONG_PATH.length}-character one too), the symlink skipped`,
      JSON.stringify(names) === JSON.stringify(Object.keys(SOURCE).sort()) &&
      Buffer.from(got.find((e) => e.path === 'main.tex').data).toString() === MAIN_TEX &&
      Buffer.from(got.find((e) => e.path === LONG_PATH).data).toString() === '% deep\n');
  }
  let threw = false;
  try { untar((await gunzip(new Uint8Array(makeTgz(SOURCE)))).slice(0, 1024 + 512 + 3)); } catch (e) { threw = true; }
  ok('a truncated archive is refused, not half read', threw);
  const ops = diffLines(['a', 'b', 'c', 'd'], ['a', 'x', 'c', 'd', 'e']);
  ok('the line diff keeps the common lines and marks the rest', ops.map((o) => o[0]).sort().join('') === '++-===' && ops[0][0] === '=' && ops[5][0] === '+' &&
    diffLines(['same'], ['same']).every((o) => o[0] === '='));
  ok('within a run the deleted lines come before the added ones', diffLines(['k', 'a', 'b', 'c', 'k'], ['k', 'x', 'b', 'y', 'z', 'k'])
    .map((o) => o[0]).join('') === '=-+=-++=' && diffLines(['a', 'b'], ['x', 'y']).map((o) => o[0]).join('') === '--++');
});

await kase('editor: a draft is opened from the kept source', async () => {
  const none = await post('/api/documents/001-0001/drafts', {});
  ok('a revision that kept no source is 409', none.status === 409 && /kept no source/.test(none.text));
  withSource();
  const d = await openDraft();
  ok('a draft of the newest revision, with an 8-hex id, in state draft', /^[0-9a-f]{8}$/.test(d.id) && d.number === '105-0001' &&
    d.base_rev === 'A' && d.state === 'draft' && d.main === 'main.tex' && d.default_marking === 'adapt');
  const paths = d.files.map((f) => f.path);
  ok('its text files are kept, main first; the binary, the non-UTF-8 file and the symlink are not',
    JSON.stringify(paths) === JSON.stringify(['main.tex', LONG_PATH, 'refs.bib', 'sections/method.tex']) &&
    d.files.every((f) => f.changed === false) && d.files[0].text === MAIN_TEX);
  ok('nothing is changed yet, and its first compile is queued', d.changes.length === 0 && d.compile.status === 'queued' &&
    d.compile.seq === 1 && d.pdf === null && d.items.length === 0 && d.comments.length === 0);
  const again = await openDraft();
  ok('opening it again gives the same draft, not a second one', again.id === d.id &&
    env.DB.raw.prepare('SELECT count(*) AS c FROM drafts').get().c === 1);
  const list = await req('/api/documents/105-0001/drafts', { as: OWNER });
  ok('the document lists it', list.status === 200 && list.data.drafts.map((x) => x.id).join() === d.id && list.data.drafts[0].state === 'draft');
  ok('an unknown revision is 400, an unknown document 404', (await post('/api/documents/105-0001/drafts', { rev: 'Z' })).status === 400 &&
    (await post('/api/documents/105-0999/drafts', {})).status === 404 && (await req('/api/documents/105-0999/drafts', { as: OWNER })).status === 404);
  ok('the outline follows \\input, skips a commented heading and counts the preamble',
    JSON.stringify(d.outline.map((e) => [e.id, e.path, e.level, e.title, e.from, e.to])) === JSON.stringify([
      ['s1', 'main.tex', 0, 'Preamble', 1, 2], ['s2', 'main.tex', 1, 'Introduction', 4, 7],
      ['s3', 'sections/method.tex', 2, 'Method', 1, 5], ['s4', 'main.tex', 1, 'Results', 8, 11]]));
  // pick main: with no main.tex, the .tex with \documentclass
  freshEnv();
  withSource({ 'body.tex': 'Just text.\n', 'paper.tex': '\\documentclass{article}\n\\begin{document}\n\\input{body}\n\\end{document}\n' }, 'pax');
  const p = await openDraft();
  ok('with no main.tex, main is the .tex that has \\documentclass', p.main === 'paper.tex');
  // .source.json names the main: it wins over the guess, and is not one of the files he edits
  const two = { 'preamble-template.tex': '\\documentclass{article}\n\\begin{document}\nT\n\\end{document}\n',
    'report/007-0001.tex': '\\documentclass{article}\n\\begin{document}\nR\n\\end{document}\n' };
  freshEnv();
  withSource({ ...two, '.source.json': JSON.stringify({ main: 'report/007-0001.tex', engine: 'lualatex' }) });
  const mm = await openDraft();
  ok('.source.json\'s main is the main, and .source.json is not among the files', mm.main === 'report/007-0001.tex' &&
    !mm.files.some((f) => f.path === '.source.json') && mm.files.length === 2);
  freshEnv();
  withSource({ ...two, '.source.json': JSON.stringify({ main: 'nothere.tex' }) });
  const mg = await openDraft();
  freshEnv();
  withSource({ ...two, '.source.json': '{not json' });
  const mb = await openDraft();
  ok('…a main that is not one of the files, or bad JSON, falls back to the guess', mg.main === 'preamble-template.tex' &&
    mb.main === 'preamble-template.tex' && !mb.files.some((f) => f.path === '.source.json'));
  freshEnv();
  withSource({ 'notes.txt': 'no tex here\n' });
  ok('a source with no .tex to compile is 409', (await post('/api/documents/105-0001/drafts', {})).status === 409);
});

await kase('editor: a save, its changes and their markings', async () => {
  withSource();
  const d = await openDraft();
  const edited = MAIN_TEX.replace('Intro line one.', 'Intro line ONE.').replace('Result line.\n', 'Result line.\nNew result.\n');
  const methodEdited = METHOD_TEX.replace('Method line two.\n', '');
  const s = await post(`/api/drafts/${d.id}`, { files: { 'main.tex': edited, 'sections/method.tex': methodEdited },
    markings: [{ path: 'main.tex', from: 4, to: 6, marking: 'adapt' }, { path: 'main.tex', from: 5, to: 5, marking: 'og' },
      { path: 'main.tex', from: 10, to: 10, marking: 'adapt' }] });
  const c = s.data.changes;
  ok('a save answers the draft, the files marked changed', s.status === 200 &&
    s.data.files.filter((f) => f.changed).map((f) => f.path).join() === 'main.tex,sections/method.tex');
  ok('one change per run, refs c1.. main first, each with its section and both sides',
    JSON.stringify(c.map((x) => [x.ref, x.path, x.section, x.base_from, x.base_to, x.from, x.to, x.before, x.after])) === JSON.stringify([
      ['c1', 'main.tex', 'Introduction', 5, 5, 5, 5, 'Intro line one.', 'Intro line ONE.'],
      ['c2', 'main.tex', 'Results', 10, 9, 10, 10, '', 'New result.'],
      ['c3', 'sections/method.tex', 'Method', 4, 4, 4, 3, 'Method line two.', '']]));
  ok('OG wins where OG and Adapt overlap, Adapt where only it covers, the default elsewhere',
    c.map((x) => x.marking).join() === 'og,adapt,adapt');
  const s2 = await post(`/api/drafts/${d.id}`, { markings: [{ path: 'sections/method.tex', from: 3, to: 3, marking: 'og' }], compile: false });
  ok('markings replace the list; a deletion takes the marking of the line beside it; compile false queues nothing',
    s2.data.changes.map((x) => x.marking).join() === 'adapt,adapt,og' && s2.data.markings.length === 1 && s2.data.compile.seq === 2);
  ok('the save queued compile 2', s.data.compile.seq === 2 && s.data.compile.status === 'queued');
  const added = await post(`/api/drafts/${d.id}`, { files: { 'notes/extra.tex': 'An added file.\n' } });
  ok('a file he adds is a change from nothing', added.data.changes.some((x) => x.path === 'notes/extra.tex' && x.base_to === 0 && x.after === 'An added file.'));
  const bad400 = await Promise.all([{ files: { '../etc/passwd': 'x' } }, { files: { '/abs.tex': 'x' } }, { files: { 'main.tex': 5 } },
    { markings: [{ path: 'nope.tex', from: 1, to: 1, marking: 'og' }] }, { markings: [{ path: 'main.tex', from: 3, to: 2, marking: 'og' }] },
    { markings: [{ path: 'main.tex', from: 1, to: 2, marking: 'keep' }] }, { compile: 'yes' }].map((b) => post(`/api/drafts/${d.id}`, b)));
  ok('a path that climbs or is absolute, a bad marking or compile is 400, and changes nothing', bad400.every((r) => r.status === 400) &&
    (await req(`/api/drafts/${d.id}`, { as: OWNER })).data.files.find((f) => f.path === 'main.tex').text === edited);
});

await kase('editor: the compile queue, results and the last good PDF', async () => {
  withSource();
  const d = await openDraft();
  const j1 = await box('/api/editor/jobs');
  const job = j1.data.jobs[0];
  ok('the box gets the queued compile with what it needs to build it', j1.status === 200 && j1.data.jobs.length === 1 &&
    job.draft === d.id && job.seq === 1 && job.main === 'main.tex' && job.number === '105-0001' && job.base_rev === 'A' &&
    job.source === 'sources/105/105-0001-A.tar.gz' && job.files['main.tex'] === MAIN_TEX && !('figure.png' in job.files));
  ok('it is handed out once, and is now running', (await box('/api/editor/jobs')).data.jobs.length === 0 &&
    (await req(`/api/drafts/${d.id}`, { as: OWNER })).data.compile.status === 'running');
  env.DB.raw.prepare('UPDATE drafts SET claimed = ? WHERE id = ?').run(new Date(Date.now() - 119e3).toISOString(), d.id);
  ok('a compile running under 2 minutes is not handed out again', (await box('/api/editor/jobs')).data.jobs.length === 0);
  env.DB.raw.prepare('UPDATE drafts SET claimed = ? WHERE id = ?').run(new Date(Date.now() - 121e3).toISOString(), d.id);
  ok('one running over 2 minutes is', (await box('/api/editor/jobs')).data.jobs.map((x) => x.seq).join() === '1');
  const pdf1 = fakePdf('one');
  const r1 = await box(`/api/editor/jobs/${d.id}`, { seq: 1, ok: true, errors: [], log_tail: 'Output written', pages: 2, pdf: b64(pdf1), map: MAP });
  const after1 = (await req(`/api/drafts/${d.id}`, { as: OWNER })).data;
  ok('a good result is the PDF, served to the owner', r1.status === 200 && after1.compile.status === 'ok' && after1.compile.ok === true &&
    after1.compile.done_seq === 1 && after1.pdf.seq === 1 && after1.pdf.pages === 2 && after1.pdf.bytes === pdf1.length &&
    (await req(`/api/drafts/${d.id}/pdf`, { as: OWNER })).text === pdf1.toString() &&
    (await req(after1.pdf.url, { as: OWNER })).headers.get('Content-Type') === 'application/pdf');
  // a failed compile keeps the last good PDF
  await post(`/api/drafts/${d.id}`, { files: { 'main.tex': MAIN_TEX.replace('Intro', '\\oops Intro') } });
  const e2 = await compileWith(d.id, { ok: false, errors: [{ path: 'main.tex', line: 5, message: 'Undefined control sequence.' }], log_tail: '! Undefined' });
  const after2 = (await req(`/api/drafts/${d.id}`, { as: OWNER })).data;
  ok('a failed compile records its errors with file and line, and keeps the last good PDF', e2.res.status === 200 && e2.job.seq === 2 &&
    after2.compile.status === 'error' && after2.compile.ok === false && after2.compile.errors[0].path === 'main.tex' &&
    after2.compile.errors[0].line === 5 && after2.compile.log_tail === '! Undefined' && after2.pdf.seq === 1 &&
    (await req(`/api/drafts/${d.id}/pdf`, { as: OWNER })).text === pdf1.toString());
  // an older result never replaces a newer PDF
  await post(`/api/drafts/${d.id}`, { files: { 'main.tex': MAIN_TEX } });
  const pdf3 = fakePdf('three');
  await compileWith(d.id, { ok: true, errors: [], pdf: b64(pdf3), map: MAP });
  const stale = await box(`/api/editor/jobs/${d.id}`, { seq: 2, ok: true, errors: [], pdf: b64(fakePdf('two')), map: MAP });
  const after3 = (await req(`/api/drafts/${d.id}`, { as: OWNER })).data;
  ok('a result for an older save than the stored PDF changes nothing', stale.status === 200 && stale.data.stale === true &&
    after3.pdf.seq === 3 && after3.compile.done_seq === 3 && (await req(`/api/drafts/${d.id}/pdf`, { as: OWNER })).text === pdf3.toString());
  // a save while a compile runs: the older result lands but the newer compile stays queued
  await post(`/api/drafts/${d.id}`, { files: { 'main.tex': MAIN_TEX + '% 4\n' } });
  const j4 = (await box('/api/editor/jobs')).data.jobs[0];
  await post(`/api/drafts/${d.id}`, { files: { 'main.tex': MAIN_TEX + '% 5\n' } });
  await box(`/api/editor/jobs/${d.id}`, { seq: j4.seq, ok: true, errors: [], pdf: b64(fakePdf('four')), map: MAP });
  const after4 = (await req(`/api/drafts/${d.id}`, { as: OWNER })).data;
  ok('a result while a newer save waits: its PDF shows, and the newer compile stays queued', after4.pdf.seq === 4 &&
    after4.compile.status === 'queued' && after4.compile.seq === 5 && (await box('/api/editor/jobs')).data.jobs[0].seq === 5);
  const bads = await Promise.all([{ seq: 9, ok: true, pdf: b64(pdf1) }, { seq: 5, ok: true }, { seq: 5, ok: true, pdf: b64(Buffer.from('not a pdf')) },
    { seq: 5, ok: 'yes' }, { seq: 5, ok: true, pdf: b64(pdf1), map: { files: ['a'], boxes: [[1, 3, 1, 0, 0, 1, 1]] } },
    { seq: 5, ok: false, errors: 'x' }].map((b) => box(`/api/editor/jobs/${d.id}`, b)));
  ok('a result for a compile never asked for, a PDF missing or not a PDF, or a bad map is 400', bads.every((r) => r.status === 400));
  ok('a result for an unknown draft is 404', (await box('/api/editor/jobs/00000000', { seq: 1, ok: false })).status === 404);
});

await kase('editor: a PDF over 1.5 MB is stored in chunks', async () => {
  withSource();
  const d = await openDraft();
  const big = fakePdf('big', 3_200_000);
  const r = await compileWith(d.id, { ok: true, errors: [], pdf: b64(big), map: MAP, pages: 40 });
  const got = await handle(new Request(`${ORIGIN}/api/drafts/${d.id}/pdf`, { headers: { 'Cf-Access-Jwt-Assertion': await jwt(OWNER) } }), env);
  const bytes = Buffer.from(await got.arrayBuffer());
  ok('three chunks of at most 1.5 MB, read back byte for byte', r.res.status === 200 && blobCount(d.id, 'pdf') === 3 &&
    env.DB.raw.prepare("SELECT max(length(data)) AS m FROM draft_blobs WHERE kind = 'pdf'").get().m === 1_500_000 &&
    bytes.equals(big) && (await req(`/api/drafts/${d.id}`, { as: OWNER })).data.pdf.bytes === big.length);
  const small = fakePdf('small');
  await post(`/api/drafts/${d.id}`, {});
  await compileWith(d.id, { ok: true, errors: [], pdf: b64(small), map: MAP });
  ok('a new good PDF replaces every chunk of the old', blobCount(d.id, 'pdf') === 1 &&
    (await req(`/api/drafts/${d.id}/pdf`, { as: OWNER })).text === small.toString());
});

await kase('editor: the job poll is held open and answers as soon as a save lands', async () => {
  withSource();
  env.EDITOR_POLL_MS = 20;
  const d = await openDraft();
  await box('/api/editor/jobs');                        // the first compile, taken
  let t = Date.now();
  const idle = await box('/api/editor/jobs?wait=1');
  ok('with nothing queued it waits the time asked, then answers none, active after an open', idle.data.jobs.length === 0 &&
    Date.now() - t >= 950 && idle.data.active === true);
  t = Date.now();
  const held = box('/api/editor/jobs?wait=20');
  await sleep(100);
  await post(`/api/drafts/${d.id}`, { files: { 'main.tex': MAIN_TEX + '% held\n' } });
  const got = await held;
  ok('a save while the poll is held is answered at once', got.data.jobs.length === 1 && got.data.jobs[0].seq === 2 && Date.now() - t < 2000);
  env.DB.raw.prepare("UPDATE drafts SET touched = ?, cstatus = 'ok'").run(new Date(Date.now() - 16 * 60e3).toISOString());
  ok('no draft touched in 15 minutes and none queued: not active', (await box('/api/editor/jobs')).data.active === false);
  await req(`/api/drafts/${d.id}`, { as: OWNER });
  ok('the owner opening it makes it active again', (await box('/api/editor/jobs')).data.active === true);
  ok('a wait that is not a number is 400', (await box('/api/editor/jobs?wait=soon')).status === 400);
  env.EDITOR_POLL_MS = undefined;
});
await kase('editor: SyncTeX both ways', async () => {
  withSource();
  const d = await openDraft();
  ok('before a good compile there is nothing to look up', (await req(`/api/drafts/${d.id}/synctex?page=1&x=1&y=1`, { as: OWNER })).status === 404);
  await compileWith(d.id, { ok: true, errors: [], pdf: b64(fakePdf('s')), map: MAP });
  const st = (q) => req(`/api/drafts/${d.id}/synctex?${q}`, { as: OWNER });
  const inner = await st('page=1&x=110&y=165');
  ok('a point in two boxes answers the smaller, with its section', inner.status === 200 && inner.data.path === 'sections/method.tex' &&
    inner.data.line === 1 && inner.data.section === 'Method');
  const near = await st('page=1&x=500&y=125');
  ok('a point in no box answers the nearest on that page', near.data.path === 'main.tex' && near.data.line === 5 && near.data.section === 'Introduction');
  ok('a page with no boxes is 404, a bad query 400', (await st('page=3&x=1&y=1')).status === 404 && (await st('page=0&x=1&y=1')).status === 400 &&
    (await st('x=1&y=1')).status === 400);
  const sel = await st('page=1&x=300&y=140&x1=80&y1=95');
  ok('a selection answers the line range of the file with the most boxes in it', sel.data.path === 'main.tex' && sel.data.from === 4 &&
    sel.data.to === 5 && sel.data.section === 'Introduction');
  const sel2 = await st('page=1&x=80&y=158&x1=300&y1=175');
  ok('a selection over the included file answers there', sel2.data.path === 'sections/method.tex' && sel2.data.from === 1 && sel2.data.to === 2);
  const l5 = await st('path=main.tex&line=5');
  ok('a line answers each box it made', l5.data.boxes.length === 2 && l5.data.boxes[0].page === 1 && l5.data.boxes[0].x === 72 &&
    l5.data.boxes[1].y === 132 && l5.data.boxes[1].w === 200);
  const l6 = await st('path=main.tex&line=6');
  ok('a line that made none answers the nearest line that did', JSON.stringify(l6.data.boxes) === JSON.stringify(l5.data.boxes));
  ok('a file the map lacks answers no boxes; a bad line is 400', (await st('path=refs.bib&line=1')).data.boxes.length === 0 &&
    (await st('path=main.tex&line=x')).status === 400);
});

await kase('editor: comments', async () => {
  withSource();
  const d = await openDraft();
  const pdfC = await post(`/api/drafts/${d.id}/comments`, { anchor: { in: 'pdf', page: 1, rect: [10, 20, 110, 40], quote: 'Intro' }, text: 'Tighten this.' });
  const texC = await post(`/api/drafts/${d.id}/comments`, { anchor: { in: 'tex', path: 'sections/method.tex', from: 1, to: 2 }, text: 'Expand the method.' });
  const genC = await post(`/api/drafts/${d.id}/comments`, { anchor: null, text: 'Overall too long.' });
  ok('a comment on the PDF, on the source and on the whole document, refs m1..', [pdfC, texC, genC].every((r) => r.status === 200) &&
    pdfC.data.ref === 'm1' && texC.data.ref === 'm2' && genC.data.ref === 'm3' && pdfC.data.anchor.quote === 'Intro' &&
    texC.data.anchor.path === 'sections/method.tex' && genC.data.anchor === null && /^[0-9a-f]{8}$/.test(genC.data.id));
  const bads = await Promise.all([{ anchor: { in: 'pdf', page: 0, rect: [0, 0, 1, 1] }, text: 'x' },
    { anchor: { in: 'pdf', page: 1, rect: [0, 0, 1] }, text: 'x' }, { anchor: { in: 'tex', path: 'nope.tex', from: 1, to: 1 }, text: 'x' },
    { anchor: { in: 'tex', path: 'main.tex', from: 3, to: 1 }, text: 'x' }, { anchor: { in: 'web' }, text: 'x' }, { anchor: 'p1', text: 'x' },
    { anchor: null, text: '   ' }].map((b) => post(`/api/drafts/${d.id}/comments`, b)));
  ok('a bad anchor or empty text is 400, and adds nothing', bads.every((r) => r.status === 400) &&
    (await req(`/api/drafts/${d.id}`, { as: OWNER })).data.comments.length === 3);
  const ed = await post(`/api/drafts/${d.id}/comments/${texC.data.id}`, { text: 'Expand the method, with an example.' });
  const del = await post(`/api/drafts/${d.id}/comments/${genC.data.id}`, { delete: true });
  const next = await post(`/api/drafts/${d.id}/comments`, { anchor: null, text: 'A new general one.' });
  const cs = (await req(`/api/drafts/${d.id}`, { as: OWNER })).data.comments;
  ok('one is edited and one removed; a ref is never reused', ed.data.text === 'Expand the method, with an example.' && del.status === 200 &&
    cs.map((c) => c.ref).join() === 'm1,m2,m4' && next.data.ref === 'm4');
  ok('an unknown comment is 404', (await post(`/api/drafts/${d.id}/comments/00000000`, { text: 'x' })).status === 404);
});

await kase('editor: package, send, and the box\'s news', async () => {
  withSource();
  const d = await openDraft();
  ok('with nothing changed or said there is nothing to send', (await post(`/api/drafts/${d.id}/send`, {})).status === 409);
  await post(`/api/drafts/${d.id}`, { files: { 'main.tex': MAIN_TEX.replace('Intro line one.', 'Intro line ONE.') },
    markings: [{ path: 'main.tex', from: 5, to: 5, marking: 'og' }] });
  await post(`/api/drafts/${d.id}/comments`, { anchor: null, text: 'Overall too long.' });
  await compileWith(d.id, { ok: true, errors: [], pdf: b64(fakePdf('p')), map: MAP });
  const pre = await req(`/api/drafts/${d.id}/package`, { as: OWNER });
  ok('the preview is the package: every file, the unified diff, changes, comments, markings; not yet sent', pre.status === 200 &&
    pre.data.id === d.id && pre.data.sent === null && pre.data.main === 'main.tex' && pre.data.files['sections/method.tex'] === METHOD_TEX &&
    pre.data.diff.startsWith('--- a/main.tex\n+++ b/main.tex\n@@ -2,7 +2,7 @@\n') && pre.data.diff.includes('\n-Intro line one.\n+Intro line ONE.\n') &&
    pre.data.changes.length === 1 && pre.data.changes[0].marking === 'og' && pre.data.comments.length === 1 && pre.data.markings.length === 1);
  ok('the box sees nothing to deliver before it is sent', (await box('/api/editor/outbox')).data.edits.length === 0);
  const sent = await post(`/api/drafts/${d.id}/send`, {});
  ok('send: state sent, an item per change and comment, each new', sent.status === 200 && sent.data.state === 'sent' && !!sent.data.sent &&
    JSON.stringify(sent.data.items) === JSON.stringify([{ ref: 'c1', kind: 'change', status: 'new', reply: null },
      { ref: 'm1', kind: 'comment', status: 'new', reply: null }]));
  const out = (await box('/api/editor/outbox')).data.edits;
  const { sent: at, ...frozen } = out[0];
  const { sent: none, ...shown } = pre.data;
  ok('what send froze is exactly what the preview showed', out.length === 1 && at === sent.data.sent && none === null &&
    JSON.stringify(frozen) === JSON.stringify(shown) && JSON.stringify((await req(`/api/drafts/${d.id}/package`, { as: OWNER })).data) === JSON.stringify(out[0]));
  ok('a sent draft no longer saves, takes comments, sends or is discarded', (await Promise.all([post(`/api/drafts/${d.id}`, {}),
    post(`/api/drafts/${d.id}/comments`, { anchor: null, text: 'late' }), post(`/api/drafts/${d.id}/send`, {}),
    post(`/api/drafts/${d.id}/discard`, {})])).every((r) => r.status === 409));
  const d2 = await openDraft();
  ok('and a new draft of the document may be opened', d2.id !== d.id && d2.state === 'draft');
  const got = await box(`/api/editor/edits/${d.id}`, { state: 'received' });
  ok('the box says received; it leaves the outbox', got.status === 200 && got.data.state === 'received' &&
    (await box('/api/editor/outbox')).data.edits.length === 0);
  const rep = await box(`/api/editor/edits/${d.id}`, { items: [{ ref: 'c1', status: 'delivered', reply: 'Kept his words.' }] });
  ok('a reply per item', rep.data.items[0].status === 'delivered' && rep.data.items[0].reply === 'Kept his words.' && rep.data.items[1].status === 'new');
  ok('an unknown ref or state is 400', (await box(`/api/editor/edits/${d.id}`, { items: [{ ref: 'c9', status: 'done' }] })).status === 400 &&
    (await box(`/api/editor/edits/${d.id}`, { state: 'draft' })).status === 400 &&
    (await box(`/api/editor/edits/${d.id}`, { state: 'answered' })).status === 400);
  const ans = await box(`/api/editor/edits/${d.id}`, { state: 'answered', answered_rev: 'B' });
  ok('answered with its revision closes every item and drops the PDF and map', ans.data.state === 'answered' && ans.data.answered_rev === 'B' &&
    ans.data.items.every((i) => i.status === 'done') && blobCount(d.id, 'pdf') === 0 && blobCount(d.id, 'map') === 0 &&
    (await req(`/api/drafts/${d.id}/pdf`, { as: OWNER })).status === 404);
  const back = await box(`/api/editor/edits/${d.id}`, { state: 'received', items: [{ ref: 'm1', status: 'new' }] });
  const own = (await req(`/api/drafts/${d.id}`, { as: OWNER })).data;
  ok('neither the state nor an item ever moves back', back.data.state === 'answered' && back.data.items[1].status === 'done' &&
    own.state === 'answered' && own.answered_rev === 'B' && own.items[0].reply === 'Kept his words.');
  ok('the box cannot report on a draft never sent', (await box(`/api/editor/edits/${d2.id}`, { state: 'received' })).status === 409);
});

await kase('editor: discard drops the PDF', async () => {
  withSource();
  const d = await openDraft();
  await compileWith(d.id, { ok: true, errors: [], pdf: b64(fakePdf('x', 2_000_000)), map: MAP });
  ok('a compiled draft holds its chunks', blobCount(d.id, 'pdf') === 2 && blobCount(d.id, 'map') === 1);
  const r = await post(`/api/drafts/${d.id}/discard`, {});
  ok('discarded: state discarded, chunks and PDF gone, no more saves or jobs', r.status === 200 && r.data.state === 'discarded' &&
    blobCount(d.id, 'pdf') === 0 && blobCount(d.id, 'map') === 0 && (await req(`/api/drafts/${d.id}/pdf`, { as: OWNER })).status === 404 &&
    (await post(`/api/drafts/${d.id}`, {})).status === 409 && (await box(`/api/editor/jobs/${d.id}`, { seq: 1, ok: false })).status === 409);
  ok('the document lists it discarded, and a new draft opens', (await req('/api/documents/105-0001/drafts', { as: OWNER })).data.drafts[0].state === 'discarded' &&
    (await openDraft()).id !== d.id);
});

await kase('editor: past feedback reads as OG or comment', async () => {
  await post('/api/documents/105-0001/feedback', { kind: 'text', text: 'His words.' });
  await post('/api/documents/105-0001/feedback', { kind: 'request', text: 'Shorter.' });
  const per = (await req('/api/documents/105-0001/feedback', { as: OWNER })).data.feedback;
  const lib = (await ownerLib()).documents.find((x) => x.number === '105-0001').feedback;
  ok('text is og and request is comment, on the document and in the library', per.map((x) => x.as).join() === 'og,comment' &&
    lib.map((x) => x.as).join() === 'og,comment');
});

await kase('editor: owner-only, and the box\'s routes the box\'s alone', async () => {
  withSource();
  const d = await openDraft();
  const c = await post(`/api/drafts/${d.id}/comments`, { anchor: null, text: 'Secret owner note.' });
  await compileWith(d.id, { ok: true, errors: [], pdf: b64(fakePdf('secret')), map: MAP });
  const pal = 'pal@example.com';
  const priv = pathOf(await mkLink({ number: '105-0001', rev: null }, { kind: 'private', people: [pal] }));
  const pub = pathOf(await mkLink({ number: '105-0001', rev: null }));
  const lesson = pathOf(await mkLink({ number: '105-0001', rev: null }, { kind: 'signed-in' }));
  const pk = await newPackage('Course pack');
  await post(`/api/packages/${pk.id}/documents`, { number: '105-0001', add: true });
  const gets = ['/api/documents/105-0001/drafts', `/api/drafts/${d.id}`, `/api/drafts/${d.id}/pdf`, `/api/drafts/${d.id}/package`,
    `/api/drafts/${d.id}/synctex?page=1&x=100&y=120`, `/api/drafts/${d.id}/synctex?path=main.tex&line=5`];
  const posts = [['/api/documents/105-0001/drafts', {}], [`/api/drafts/${d.id}`, { files: { 'main.tex': 'hijacked' } }],
    [`/api/drafts/${d.id}/comments`, { anchor: null, text: 'x' }], [`/api/drafts/${d.id}/comments/${c.data.id}`, { delete: true }],
    [`/api/drafts/${d.id}/send`, {}], [`/api/drafts/${d.id}/discard`, {}]];
  ok('the owner reaches every one of them', (await Promise.all(gets.map((g) => req(g, { as: OWNER })))).every((r) => r.status === 200));
  const secret = (r) => /Secret owner note|draft secret|hijacked|\\documentclass/.test(r.text);
  for (const [who, as] of [['a group member', BOB.email], ['a guest on a private link', pal]]) {
    const g = await Promise.all(gets.map((p) => req(p, { as })));
    const p = await Promise.all(posts.map(([u, b]) => post(u, b, as)));
    const lib = await req('/api/library', { as });
    ok(`${who}: 404 on every GET, the generic 403 on every POST, nothing in the library`, nums(lib) === '105-0001' &&
      g.every((r) => r.status === 404 && !secret(r)) && p.every((r) => r.status === 403 && r.text === 'only the owner can change this\n') &&
      !secret(lib) && !lib.text.includes(d.id));
  }
  const unsigned = await Promise.all([...gets.map((p) => req(p)), ...posts.map(([u, b]) => req(u, { method: 'POST', body: b }))]);
  ok('unsigned: refused on every one', unsigned.every((r) => r.status === 403 && !secret(r)));
  const svc = await svcJwt('box-id.access');
  env.FEEDBACK_TOKENS = 'box-id.access';
  const bySvc = await Promise.all([...gets.map((p) => req(p, { token: svc })), ...posts.map(([u, b]) => req(u, { token: svc, method: 'POST', body: b }))]);
  ok('the box\'s own token is refused on every owner route', bySvc.every((r) => r.status === 403 && !secret(r)));
  // a link token reaches its PDF, and nothing of a draft under any prefix
  const tok = (p) => p.split('/')[2];
  const tries = [[`${pub}/drafts`], [`${pub}/${d.id}`], [`${pub}/105-0001/${d.id}.pdf`], [`/k/${tok(pk.path)}/${d.id}.pdf`], [`${pk.path}/105-0001/pdf`],
    [`${priv}/${d.id}`, pal], [`${priv}/105-0001/draft.pdf`, pal], [`${lesson}/${d.id}`, OWNER], [`/d/105-0001/drafts`, OWNER],
    [`/files/105-0001-A/draft-${d.id}.pdf`, OWNER], [`/files/${d.id}.pdf`, OWNER], [`/p/${tok(pub)}/api/drafts/${d.id}/pdf`]];
  const got = await Promise.all(tries.map(([u, as]) => req(u, as ? { as } : {})));
  // /files/<N-R>/<anything>.pdf is the filed revision's own PDF (the last segment is decoration), never the draft's
  ok('no /p/ /k/ /s/ /l/ /d/ /files/ path serves a draft or its PDF', got.every((r) => !r.text.includes('draft secret') &&
    ([403, 404].includes(r.status) || r.text === PDF + '105-0001-A')));
  ok('the owner is not locked out of his own draft by them', (await req(`/api/drafts/${d.id}`, { as: OWNER })).data.comments.length === 1 &&
    (await req(`/api/drafts/${d.id}`, { as: OWNER })).data.files[0].text === MAIN_TEX && (await req(`/api/drafts/${d.id}`, { as: OWNER })).data.state === 'draft');
  // the box's routes: only the named service token
  const boxRoutes = [['/api/editor/jobs'], ['/api/editor/outbox'], [`/api/editor/jobs/${d.id}`, { seq: 1, ok: false }],
    [`/api/editor/edits/${d.id}`, { state: 'received' }]];
  const as = (who) => Promise.all(boxRoutes.map(([u, b]) => req(u, { ...who, ...(b ? { method: 'POST', body: b } : {}) })));
  ok('the owner\'s browser gets 403 on every box route', (await as({ as: OWNER })).every((r) => r.status === 403));
  ok('a member, a guest or nobody gets 403 there', [...await as({ as: BOB.email }), ...await as({ as: pal }), ...await as({})].every((r) => r.status === 403));
  ok('another service token, or a client-id header naming another, gets 403', (await as({ token: await svcJwt('stray.access') })).every((r) => r.status === 403) &&
    (await as({ token: svc, headers: { 'Cf-Access-Client-Id': 'other.access' } })).every((r) => r.status === 403));
  ok('the named token gets through', (await box('/api/editor/outbox')).status === 200 &&
    (await box('/api/editor/jobs', undefined, { 'Cf-Access-Client-Id': 'box-id.access' })).status === 200);
  ok('an unknown box route is 404 to the token', (await box('/api/editor/nothing')).status === 404);
});

// ── the editor's additions for the full UI: new documents, UI state, scope, OG-only compiles, direct filing ──

const job4 = async (id) => (await box('/api/editor/jobs')).data.jobs.find((j) => j.draft === id);

await kase('editor: a new blank document', async () => {
  const r = await post('/api/drafts', { project: '105', title: 'Fresh & new_notes' });
  const d = r.data;
  const main = d && d.files[0];
  ok('a draft under the next free number of the project, rev A, with no base revision', r.status === 200 && d.number === '105-0002' &&
    d.base_rev === null && JSON.stringify(d.new) === JSON.stringify({ number: '105-0002', rev: 'A', project: '105', title: 'Fresh & new_notes' }));
  ok('its main.tex is generated: the title escaped, \\docnumber{N}{A}, one Introduction', d.main === 'main.tex' && d.files.length === 1 &&
    main.text.includes('\\docnumber{105-0002}{A}') && main.text.includes('\\title{Fresh \\& new\\_notes}') &&
    JSON.stringify(d.outline.map((e) => [e.level, e.title])) === JSON.stringify([[0, 'Preamble'], [1, 'Introduction']]));
  ok('its base is empty, so the whole file is one change, OG by default, and it may be filed straight away',
    d.changes.length === 1 && d.changes[0].base_to === 0 && d.changes[0].marking === 'og' && d.default_marking === 'og' && d.direct === true);
  const j = await job4(d.id);
  ok('its compile is queued with no source to build on and the file itself', j && j.new === true && j.source === null && j.base_rev === null &&
    j.files['main.tex'] === main.text);
  const two = await post('/api/drafts', { project: '105', title: 'Second' });
  const lib = await ownerLib();
  ok('a second new document takes the next number; the library says which comes after', two.data.number === '105-0003' &&
    lib.projects.find((p) => p.number === '105').next === '105-0004');
  await post(`/api/drafts/${two.data.id}/discard`, {});
  ok('a discarded one lets its number go', (await ownerLib()).projects.find((p) => p.number === '105').next === '105-0003');
  const [a, b] = await Promise.all([post('/api/drafts', { project: '106', title: 'Race A' }), post('/api/drafts', { project: '106', title: 'Race B' })]);
  ok('two at once never share a number', a.status === 200 && b.status === 200 && a.data.number !== b.data.number &&
    [a.data.number, b.data.number].sort().join() === '106-0002,106-0003');
  const bad = await Promise.all([{ project: '999', title: 'x' }, { project: '105' }, { project: '105', title: '' }, { project: 105, title: 'x' },
    { project: '105', title: 'x', from: 'doc' }].map((x) => post('/api/drafts', x)));
  ok('an unknown project, no title or a bad from is 400', bad.every((x) => x.status === 400));
  ok('a reader gets the generic 403 on it, and GET /api/drafts is 404', (await post('/api/drafts', { project: '105', title: 'x' }, BOB.email)).status === 403 &&
    (await req('/api/drafts', { as: OWNER })).status === 404 && (await req('/api/drafts', { as: BOB.email })).status === 404);
});

await kase('editor: a new document copied from another', async () => {
  ok('a copy of a revision that kept no source is 409', (await post('/api/drafts', { project: '105', title: 'C', from: { number: '001-0001' } })).status === 409);
  ok('a copy of an unknown document is 404, of an unknown revision 400',
    (await post('/api/drafts', { project: '105', title: 'C', from: { number: '105-0999' } })).status === 404 &&
    (await post('/api/drafts', { project: '105', title: 'C', from: { number: '105-0001', rev: 'Z' } })).status === 400);
  withSource();
  const plain = (await post('/api/drafts', { project: '001', title: 'Copy of notes', from: { number: '105-0001' } })).data;
  const pm = plain.files.find((f) => f.path === 'main.tex');
  ok('a source with no \\title gets one before \\begin{document}, as one OG change', plain.number === '001-0002' &&
    JSON.stringify(plain.new.from) === JSON.stringify({ number: '105-0001', rev: 'A' }) &&
    pm.text === MAIN_TEX.replace('\\begin{document}', '\\title{Copy of notes}\n\\begin{document}') &&
    plain.changes.length === 1 && plain.changes[0].marking === 'og' && plain.direct === true && plain.default_marking === 'adapt');
  const j = await job4(plain.id);
  ok('its compile builds on the copied revision\'s kept source', j && j.new === true && j.source === 'sources/105/105-0001-A.tar.gz' &&
    j.files['sections/method.tex'] === METHOD_TEX);
  freshEnv();
  withSource({ 'main.tex': '\\documentclass{article}\n\\title{Old {title}}\n\\docnumber{105-0001}{A}\n\\begin{document}\nSee 105-0001-A, not 105-0001-AB.\n\\end{document}\n',
    'num.tex': '\\def\\docnumber{105-0001-A}\n' });
  const c = (await post('/api/drafts', { project: '105', title: 'New title', from: { number: '105-0001', rev: 'A' } })).data;
  const t = (p) => c.files.find((f) => f.path === p).text;
  ok('the title and number are made the new ones, in every file, and nothing else',
    t('main.tex') === '\\documentclass{article}\n\\title{New title}\n\\docnumber{105-0002}{A}\n\\begin{document}\nSee 105-0002-A, not 105-0001-AB.\n\\end{document}\n' &&
    t('num.tex') === '\\def\\docnumber{105-0002-A}\n' && c.changes.every((x) => x.marking === 'og') && c.direct === true);
});

await kase('editor: the UI state rides on the draft', async () => {
  withSource();
  const d = await openDraft();
  const ui = { open: ['s2'], showLatex: true, split: [0.4, 0.6] };
  const s = await post(`/api/drafts/${d.id}`, { ui });
  ok('a save of ui alone stores it and queues no compile', s.status === 200 && JSON.stringify(s.data.ui) === JSON.stringify(ui) &&
    s.data.compile.seq === 1 && JSON.stringify((await req(`/api/drafts/${d.id}`, { as: OWNER })).data.ui) === JSON.stringify(ui));
  const both = await post(`/api/drafts/${d.id}`, { ui: { open: [] }, files: { 'main.tex': MAIN_TEX + '% x\n' } });
  ok('with files it is saved beside them, and the save compiles', both.data.ui.open.length === 0 && both.data.compile.seq === 2);
  const bad = await Promise.all([{ ui: [1, 2] }, { ui: 'x' }, { ui: { big: 'x'.repeat(8200) } }, { ui: {}, compile: 'no' }]
    .map((b) => post(`/api/drafts/${d.id}`, b)));
  ok('an array, a string, more than 8 KB or a bad compile is 400, and leaves it', bad.every((x) => x.status === 400) &&
    (await req(`/api/drafts/${d.id}`, { as: OWNER })).data.ui.open.length === 0);
  ok('a reader cannot set it', (await post(`/api/drafts/${d.id}`, { ui }, BOB.email)).status === 403);
});

await kase('editor: a marking\'s scope, and when a draft is direct', async () => {
  withSource();
  const d = await openDraft();
  const edited = MAIN_TEX.replace('Intro line one.', 'Intro line ONE.');
  const og = await post(`/api/drafts/${d.id}`, { files: { 'main.tex': edited }, markings: [{ path: 'main.tex', from: 5, to: 5, marking: 'og', scope: 'doc' }] });
  ok('every change OG, no comment: direct; the marking keeps its scope', og.data.direct === true && og.data.markings[0].scope === 'doc' &&
    og.data.changes[0].scope === 'doc');
  const tpl = await post(`/api/drafts/${d.id}`, { markings: [{ path: 'main.tex', from: 5, to: 5, marking: 'og', scope: 'template' }] });
  ok('scoped to the template: the change says so, and it is not direct', tpl.data.changes[0].scope === 'template' && tpl.data.direct === false);
  const ad = await post(`/api/drafts/${d.id}`, { markings: [{ path: 'main.tex', from: 5, to: 5, marking: 'adapt' }] });
  ok('an Adapt change: not direct', ad.data.direct === false);
  await post(`/api/drafts/${d.id}`, { markings: [{ path: 'main.tex', from: 5, to: 5, marking: 'og' }] });
  await post(`/api/drafts/${d.id}/comments`, { anchor: null, text: 'One note.' });
  const withC = (await req(`/api/drafts/${d.id}`, { as: OWNER })).data;
  ok('an OG change with a comment: not direct, and the package says the same', withC.direct === false &&
    (await req(`/api/drafts/${d.id}/package`, { as: OWNER })).data.direct === false);
  ok('a scope other than doc or template is 400', (await post(`/api/drafts/${d.id}`,
    { markings: [{ path: 'main.tex', from: 5, to: 5, marking: 'og', scope: 'all' }] })).status === 400);
});

await kase('editor: the compile builds the OG-only source', async () => {
  withSource();
  const d = await openDraft();
  await job4(d.id);   // the first compile, taken
  const edited = MAIN_TEX.replace('Intro line one.', 'Intro line ONE.').replace('Result line.', 'Result line, rewritten.');
  const methodEdited = METHOD_TEX.replace('Method line two.\n', '');
  await post(`/api/drafts/${d.id}`, { files: { 'main.tex': edited, 'sections/method.tex': methodEdited, 'og.tex': 'Mine.\n', 'notes.tex': 'Guidance.\n' },
    markings: [{ path: 'main.tex', from: 5, to: 5, marking: 'og' }, { path: 'og.tex', from: 1, to: 1, marking: 'og' }] });
  const j = await job4(d.id);
  ok('an OG change is in the compile, an Adapt one is not: the base stands there',
    j.files['main.tex'] === MAIN_TEX.replace('Intro line one.', 'Intro line ONE.') && j.files['sections/method.tex'] === METHOD_TEX);
  ok('a file he added goes in when OG and stays out when not', j.files['og.tex'] === 'Mine.\n' && !('notes.tex' in j.files));
  ok('the draft itself keeps every edit', (await req(`/api/drafts/${d.id}`, { as: OWNER })).data.files.find((f) => f.path === 'main.tex').text === edited);
});

await kase('editor: who files for each project, and the next number', async () => {
  republish((next) => {
    next.documents['001-0001'].revisions[0].filer = { session: 'old-track', channel: 'C1', thread: '1.1' };
    next.documents['001-0001'].revisions[0].filed_at = '2026-09-01T00:00:00Z';
    next.documents['001-0001'].revisions[1].filer = { session: 'memo-track', channel: 'C2', thread: '2.2' };
    next.documents['001-0001'].revisions[1].filed_at = '2026-09-10T00:00:00Z';
    next.documents['003-0001'].revisions[0].filer = { repo: 'career' };   // no channel: never routed to
    next.retired = { '003-0007': { number: '003-0007' } };
  });
  const own = (await ownerLib()).projects;
  const p = (n) => own.find((x) => x.number === n);
  ok('the session that filed last in the project, else null', p('001').session === 'memo-track' && p('003').session === null &&
    p('105').session === null);
  ok('the next free number, past every document and retired number', p('001').next === '001-0002' && p('003').next === '003-0008' &&
    p('006').next === '006-0001');
  const reader = await req('/api/library', { as: BOB.email });
  ok('a reader is told neither', reader.data.projects.every((x) => !('session' in x) && !('next' in x)) && !reader.text.includes('memo-track'));
});

await kase('editor: files from a shared template', async () => {
  republish((next, T2) => {
    next.documents['105-0001'].revisions[0].sources = 'sources/105/105-0001-A.tar.gz';
    mkdirSync(join(T2, 'data', 'sources', '105'), { recursive: true });
    writeFileSync(join(T2, 'data', 'sources', '105', '105-0001-A.tar.gz'), makeTgz({ ...SOURCE, '_ext/dev/templates/house.sty': '\\ProvidesPackage{house}\n' }));
    next.documents['105-0001'].revisions[0].source_files = ['main.tex', '_ext/dev/templates/house.sty'];
    next.documents['106-0001'].revisions[0].source_files = ['x.tex', '_ext/dev/templates/house.sty'];
  });
  const d = await openDraft();
  ok('a file kept from outside the document\'s folder lists every document that keeps it',
    JSON.stringify(d.shared) === JSON.stringify([{ path: '_ext/dev/templates/house.sty', used_by: ['105-0001', '106-0001'] }]));
  freshEnv();
  withSource();
  ok('a source with none: []', JSON.stringify((await openDraft()).shared) === '[]');
});

await kase('editor: a direct send, filed by the box', async () => {
  const d = (await post('/api/drafts', { project: '105', title: 'Direct one' })).data;
  const sent = await post(`/api/drafts/${d.id}/send`, {});
  const pkg = (await box('/api/editor/outbox')).data.edits[0];
  ok('the package says direct, and which new document it is', sent.status === 200 && pkg.direct === true && pkg.new.number === '105-0002' &&
    pkg.base_rev === null && pkg.files['main.tex'].includes('\\docnumber{105-0002}{A}'));
  const ans = await box(`/api/editor/edits/${d.id}`, { state: 'answered', answered_rev: 'A', answered_number: '105-0002' });
  const own = (await req(`/api/drafts/${d.id}`, { as: OWNER })).data;
  ok('the box answers it straight from sent: answered, rev A, the number it was filed under', ans.status === 200 &&
    ans.data.answered_number === '105-0002' && own.state === 'answered' && own.answered_rev === 'A' && own.answered_number === '105-0002' &&
    own.items.every((i) => i.status === 'done'));
  withSource();
  const e = await openDraft();
  await post(`/api/drafts/${e.id}`, { files: { 'main.tex': MAIN_TEX + '% more\n' } });
  await post(`/api/drafts/${e.id}/send`, {});
  ok('answered_number on an existing document\'s draft is 400', (await box(`/api/editor/edits/${e.id}`,
    { state: 'answered', answered_rev: 'B', answered_number: '105-0001' })).status === 400);
});

await kase('editor: the box reads a sent draft\'s PDF to crop from', async () => {
  withSource();
  const d = await openDraft();
  await post(`/api/drafts/${d.id}/comments`, { anchor: { in: 'pdf', page: 1, rect: [72, 100, 300, 160] }, text: 'This box.' });
  await compileWith(d.id, { ok: true, errors: [], pdf: b64(fakePdf('crop')), map: MAP });
  ok('not while it is still a draft', (await box(`/api/editor/edits/${d.id}/pdf`)).status === 404);
  await post(`/api/drafts/${d.id}/send`, {});
  const got = await box(`/api/editor/edits/${d.id}/pdf`);
  ok('once sent, the box gets the PDF the box was drawn on', got.status === 200 && got.text.includes('draft crop') &&
    got.headers.get('Content-Type') === 'application/pdf');
  ok('the owner, a reader and nobody get 403 there', (await Promise.all([req(`/api/editor/edits/${d.id}/pdf`, { as: OWNER }),
    req(`/api/editor/edits/${d.id}/pdf`, { as: BOB.email }), req(`/api/editor/edits/${d.id}/pdf`)])).every((r) => r.status === 403));
});

await kase('editor: a job waits for the deployment whose register has its revision', async () => {
  const old = env.ASSETS;   // the deployment built before B was filed: 105-0001 has rev A alone, with no source
  republish((next, T2) => {
    next.documents['105-0001'].revisions.push({ rev: 'B', file: 'files/105/105-0001-B_x.pdf', date: '2026-09-27',
      sources: 'sources/105/105-0001-B.tar.gz' });
    mkdirSync(join(T2, 'data', 'sources', '105'), { recursive: true });
    writeFileSync(join(T2, 'data', 'sources', '105', '105-0001-B.tar.gz'), makeTgz(SOURCE));
  });
  const d = await openDraft();
  const fresh = env.ASSETS;
  env.ASSETS = old;   // the box's poll, held open on the old deployment
  const blank = (await post('/api/drafts', { project: '106', title: 'Blank' })).data;
  const early = (await box('/api/editor/jobs')).data.jobs;
  ok('the old deployment does not hand out the draft on B, which stays queued', d.base_rev === 'B' &&
    !early.some((j) => j.draft === d.id) && env.DB.raw.prepare('SELECT cstatus FROM drafts WHERE id = ?').get(d.id).cstatus === 'queued');
  ok('…while a blank new document, which builds on nothing, is handed out there with no source',
    early.length === 1 && early[0].draft === blank.id && early[0].source === null);
  env.ASSETS = fresh;
  const late = (await box('/api/editor/jobs')).data.jobs;
  ok('the next poll, on the new deployment, hands it out with its source', late.length === 1 && late[0].draft === d.id &&
    late[0].base_rev === 'B' && late[0].source === 'sources/105/105-0001-B.tar.gz');
});

await kase('a current revision with no kept source offers nothing to edit', async () => {
  withSource();
  const own = await ownerLib();
  const cur = (num) => { const x = own.documents.find((y) => y.number === num); return x.revisions.find((r) => r.rev === x.current); };
  ok('the owner\'s library points the current revision of a document that kept one at its source',
    cur('105-0001').source === '/api/documents/105-0001/revisions/A/source');
  ok('…and gives null for one that kept none, and opening a draft there is 409, not a draft',
    cur('001-0001').source === null && (await post('/api/documents/001-0001/drafts', {})).status === 409);
  ok('the page shows Edit source only where the current revision has one',
    /owner && cur\.source \? h\('a', \{ class: 'btn btn-primary', href: '#\/edit\/'/.test(readFileSync(join(HERE, 'app.js'), 'utf8')));
});

await kase('the register is never cached: every answer carries no-store, and a new deployment is read at once', async () => {
  for (const p of ['/api/library', '/', '/app.js', '/style.css', named('105-0001', 'A')]) {
    const r = await req(p, { as: OWNER });
    ok(`${p} is 200 with Cache-Control: no-store`, r.status === 200 && r.headers.get('Cache-Control') === 'no-store');
  }
  const raw = await req('/data/register.json', { as: OWNER });
  ok('data/register.json itself is never served, and its 404 is not cached either', raw.status === 404 &&
    raw.headers.get('Cache-Control') === 'no-store');
  const before = (await ownerLib()).documents.find((x) => x.number === '105-0001').revisions.map((r) => r.rev).join();
  republish((next) => { next.documents['105-0001'].revisions.push({ rev: 'B', file: 'files/105/105-0001-B_x.pdf', date: '2026-09-27' }); });
  const after = (await ownerLib()).documents.find((x) => x.number === '105-0001').revisions.map((r) => r.rev).join();
  ok('the first answer from a new deployment has its new revision; the old one had not', before === 'A' && after === 'A,B');
  ok('the page asks for the library with cache: no-store, and polls it',
    /cache: 'no-store'/.test(readFileSync(join(HERE, 'app.js'), 'utf8')) && /POLL_MS/.test(readFileSync(join(HERE, 'app.js'), 'utf8')));
});

await kase('source_nearest: a nearest source is said so, never passed off as exact', async () => {
  republish((next, T2) => {
    const a = next.documents['105-0001'].revisions[0], b = next.documents['106-0001'].revisions[0], c = next.documents['001-0001'].revisions[1];
    Object.assign(a, { sources: 'sources/105/105-0001-A.tar.gz', source_nearest: true });
    Object.assign(b, { sources: 'sources/106/106-0001-A.tar.gz' });
    Object.assign(c, { source_nearest: true });   // no source kept: nothing to call nearest
    for (const p of ['105', '106']) {
      mkdirSync(join(T2, 'data', 'sources', p), { recursive: true });
      writeFileSync(join(T2, 'data', 'sources', p, `${p}-0001-A.tar.gz`), makeTgz(SOURCE));
    }
  });
  const own = await ownerLib();
  const rev = (num, r) => own.documents.find((x) => x.number === num).revisions.find((x) => x.rev === r);
  ok('the owner\'s revision JSON carries source_nearest: true for a nearest source', rev('105-0001', 'A').source_nearest === true);
  ok('…and nothing for an exact source, or a revision that kept none', !('source_nearest' in rev('106-0001', 'A')) &&
    !('source_nearest' in rev('001-0001', 'B')) && rev('001-0001', 'B').source === null);
  const near = await openDraft();
  const exact = (await post('/api/documents/106-0001/drafts', {})).data;
  ok('a draft on the nearest source says so; a draft on an exact one does not', near.source_nearest === true &&
    exact && exact.base_rev === 'A' && !('source_nearest' in exact));
  const dh = await req('/api/library', { as: BOB.email });
  ok('a reader is never told of it', dh.status === 200 && !dh.text.includes('source_nearest'));
});

await kase('the editor\'s code is served, and nothing else under its names', async () => {
  republish((next, T2) => {
    writeFileSync(join(T2, 'editor.js'), 'window.LibraryEditor = {};\n');
    writeFileSync(join(T2, 'editor.css'), '.editing {}\n');
    mkdirSync(join(T2, 'vendor', 'sub'), { recursive: true });
    writeFileSync(join(T2, 'vendor', 'pdf.worker.mjs'), 'export {};\n');
    writeFileSync(join(T2, 'vendor', 'codemirror.js'), 'var cm;\n');
    writeFileSync(join(T2, 'vendor', 'codemirror.css'), '.cm {}\n');
    writeFileSync(join(T2, 'vendor', 'notes.json'), '{}');
    writeFileSync(join(T2, 'vendor', 'sub', 'x.js'), 'var x;\n');
  });
  const get = (p, as = OWNER) => req(p, { as });
  const [js, css, mjs, cm, cmcss] = await Promise.all(['/editor.js', '/editor.css', '/vendor/pdf.worker.mjs', '/vendor/codemirror.js',
    '/vendor/codemirror.css'].map((p) => get(p)));
  ok('editor.js, editor.css and vendor .js/.mjs/.css are served, a module as JavaScript',
    [js, mjs, cm].every((r) => r.status === 200 && r.headers.get('Content-Type') === 'text/javascript; charset=utf-8') &&
    [css, cmcss].every((r) => r.status === 200 && r.headers.get('Content-Type') === 'text/css; charset=utf-8') && mjs.text === 'export {};\n');
  const no = await Promise.all(['/vendor/notes.json', '/vendor/sub/x.js', '/vendor/.hidden.js', '/vendor/%2e%2e/data/register.json', '/editor.html']
    .map((p) => get(p)));
  ok('another type, a subfolder, a dot name or a climb is 404', no.every((r) => r.status === 404));
  ok('unsigned, they are refused like the page', (await req('/editor.js')).status === 403 && (await req('/vendor/pdf.worker.mjs')).status === 403);
});

await kase('14b: the public package page, layout 4e', async () => {
  const p = await newPackage('Layout');
  const f = (await post(`/api/packages/${p.id}/folders`, { name: 'Letters' })).data;
  await post(`/api/packages/${p.id}/documents`, { number: '003-0001', add: true, folder: f.id });
  await post(`/api/packages/${p.id}/documents`, { number: '003-0002', add: true });
  let page = (await req(p.path)).text;
  const at = (s) => page.indexOf(s);
  ok('it counts documents and folders under the title', page.includes('<h1>Layout</h1>') && page.includes('>2 documents in 1 folder<'));
  ok('the unfiled document sits under Standalone, before the folders', at('<h2 class="sa">Standalone</h2>') >= 0 &&
    at('<h2 class="sa">Standalone</h2>') < at('Plain title') && at('Plain title') < at('<summary>Letters</summary>'));
  ok('folders start open by default, with no script and no counts on the headings', page.includes('<details open><summary>Letters</summary>') &&
    !/<script/i.test(page) && !page.includes('Letters (1)'));
  ok('the setting "collapsed" is kept and shuts every folder', (await post(`/api/packages/${p.id}`, { settings: { collapsed: true } })).status === 200 &&
    (await ownerPkg(p.id)).settings.collapsed === true && (page = (await req(p.path)).text).includes('<details><summary>Letters</summary>') &&
    !page.includes('<details open>'));
  ok('a setting that is not true or false, or not known, is refused', (await post(`/api/packages/${p.id}`, { settings: { collapsed: 'yes' } })).status === 400 &&
    (await post(`/api/packages/${p.id}`, { settings: { folders: 'open' } })).status === 400);
  await post(`/api/packages/${p.id}`, { settings: { number: true } });
  page = (await req(p.path)).text;
  ok('with the number shown it comes first, in its own span, inside the link', /<a href="[^"]+"><span class="n">003-0002<\/span> Plain title<\/a>/.test(page));
  await post(`/api/packages/${p.id}/documents`, { number: '003-0002', add: false });
  page = (await req(p.path)).text;
  ok('with every document in folders there is no Standalone heading', !page.includes('Standalone') && page.includes('>1 document in 1 folder<'));
});

// ── LIBRARY CHAT: questions about a document (docs/library-chat/api.md) ──

const QS = '/api/documents/105-0001/questions';
const ask = (body, as = OWNER, num = '105-0001') => post(`/api/documents/${num}/questions`, body, as);
const qget = (id, as = OWNER, q = '') => req(`/api/questions/${id}${q}`, { as });
const qrow = (id) => env.DB.raw.prepare('SELECT * FROM questions WHERE id = ?').get(id);
const qcount = (t = 'questions') => env.DB.raw.prepare(`SELECT count(*) AS c FROM ${t}`).get().c;
const ANCHOR = { in: 'pdf', page: 2, rect: [72, 100, 300, 120], quote: 'The widget runs at 42 hertz.' };
let seeded = 0;
/** count questions already asked today by asker; `handed` makes each a hand-on made today. */
function seedQuestions(asker, count, route = 'quick', handed = false) {
  const at = new Date().toISOString();
  const st = env.DB.raw.prepare('INSERT INTO questions (id, number, rev, asker, text, thread, route, model, status, created, updated, handed_at) ' +
    "VALUES (?, '105-0001', 'A', ?, 'seed', 'aaaaaaaa', ?, 'quick', 'answered', ?, ?, ?)");
  for (let i = 0; i < count; i++) st.run(`s${String(seeded++).padStart(7, '0')}`, asker, route, at, at, handed ? at : null);
}
const answerQ = (id, extra = {}) => box(`/api/editor/questions/${id}`, { answer: 'Because.', pages: [1], hand_on: null, why: null,
  model: 'sonnet', ...extra });

await kase('chat: who may ask, and a thread is its asker\'s', async () => {
  const q = await ask({ text: 'How fast does the widget run?', anchor: ANCHOR });
  ok('the owner asks a quick question: queued, model quick, the newest revision, a new thread, no asker or cost', q.status === 200 &&
    q.data.route === 'quick' && q.data.status === 'queued' && q.data.model === 'quick' && q.data.rev === 'A' &&
    /^[0-9a-f]{8}$/.test(q.data.thread) && q.data.anchor.quote === ANCHOR.quote && q.data.edit === null &&
    !('asker' in q.data) && !('cost' in q.data) && !q.text.includes(OWNER));
  const s = await ask({ text: 'Why 42?', route: 'session', thread: q.data.thread });
  ok('the owner asks the session in the same thread: with_session', s.status === 200 && s.data.status === 'with_session' &&
    s.data.thread === q.data.thread && s.data.model === 'session');
  const m = await ask({ text: 'What is a widget?' }, BOB.email);
  ok('a member asks a quick question about a document he opens', m.status === 200 && m.data.status === 'queued' && m.data.route === 'quick');
  ok('a member\'s session question is 403, and nothing is made', (await ask({ text: 'x', route: 'session' }, BOB.email)).status === 403 &&
    qcount() === 3);
  const pal = 'pal@example.com';
  await mkLink({ number: '105-0001', rev: null }, { kind: 'private', people: [pal] });
  const g = await ask({ text: 'x' }, pal);
  ok('a guest on a private link gets the generic 403 on a POST and 404 on the GETs', g.status === 403 &&
    g.text === 'only the owner can change this\n' && (await req(QS, { as: pal })).status === 404 && (await qget(q.data.id, pal)).status === 404);
  ok('a stranger and nobody are refused', (await ask({ text: 'x' }, 'stranger@example.com')).status === 403 &&
    (await req(QS, { as: 'stranger@example.com' })).status === 403 && (await req(QS, { method: 'POST', body: { text: 'x' } })).status === 403 &&
    qcount() === 3);
  ok('a member asking about a document he cannot open is 404', (await ask({ text: 'x' }, BOB.email, '901-0001')).status === 404 &&
    (await req('/api/documents/901-0001/questions', { as: BOB.email })).status === 404);
  ok('a member cannot read the owner\'s question, nor the owner the member\'s', (await qget(q.data.id, BOB.email)).status === 404 &&
    (await qget(m.data.id, OWNER)).status === 404 && (await qget(q.data.id, ALICE.email)).status === 404 && (await qget(q.data.id)).status === 200);
  const ol = await req(QS, { as: OWNER }), ml = await req(QS, { as: BOB.email });
  ok('each lists only his own, oldest first', ol.data.questions.map((x) => x.id).join() === [q.data.id, s.data.id].join() &&
    ml.data.questions.map((x) => x.id).join() === m.data.id && !ol.text.includes('What is a widget'));
  ok('a thread of someone else\'s is 404, an unknown one too',
    (await ask({ text: 'x', thread: q.data.thread }, BOB.email)).status === 404 && (await ask({ text: 'x', thread: m.data.thread })).status === 404 &&
    (await ask({ text: 'x', thread: 'abcdef01' })).status === 404);
  ok('again on someone else\'s question is 404', (await ask({ text: 'x', again: q.data.id }, BOB.email)).status === 404);
  ok('neither library carries a question', !(await req('/api/library', { as: OWNER })).text.includes('How fast') &&
    !(await req('/api/library', { as: BOB.email })).text.includes('What is a widget'));
  ok('a text over 2000 characters, an empty one, a bad route, anchor or rev is 400', (await ask({ text: 'x'.repeat(2001) })).status === 400 &&
    (await ask({ text: 'x'.repeat(2000) })).status === 200 && (await ask({ text: '  ' })).status === 400 &&
    (await ask({ text: 'x', route: 'slack' })).status === 400 && (await ask({ text: 'x', anchor: { in: 'tex', path: 'main.tex', from: 1, to: 2 } })).status === 400 &&
    (await ask({ text: 'x', anchor: { in: 'pdf', page: 0, rect: [0, 0, 1, 1] } })).status === 400 && (await ask({ text: 'x', rev: 'Z' })).status === 404 &&
    (await ask({ text: 'x', rev: 'a1' })).status === 400);
  ok('an unknown document is 404', (await ask({ text: 'x' }, OWNER, '105-0099')).status === 404);
  ok('the owner\'s browser cannot answer through the box\'s route', (await post(`/api/editor/questions/${q.data.id}`, { failed: 'error' })).status === 403 &&
    qrow(q.data.id).status === 'queued');
});

await kase('chat: a member asks only about a revision he opens', async () => {
  // Bob is a member (105); a private link naming him reaches 001-0001 at rev A only
  await mkLink({ number: '001-0001', rev: 'A' }, { kind: 'private', people: [BOB.email] });
  const a = await ask({ text: 'What is this memo?' }, BOB.email, '001-0001');
  ok('no rev: the newest he opens (A, not B)', a.status === 200 && a.data.rev === 'A');
  ok('rev B, which he cannot open, is 404; the owner may', (await ask({ text: 'x', rev: 'B' }, BOB.email, '001-0001')).status === 404 &&
    (await ask({ text: 'x', rev: 'B' }, OWNER, '001-0001')).data.rev === 'B');
  ok('his list filters by rev', (await req('/api/documents/001-0001/questions?rev=A', { as: BOB.email })).data.questions.length === 1 &&
    (await req('/api/documents/001-0001/questions?rev=B', { as: BOB.email })).data.questions.length === 0 &&
    (await req('/api/documents/001-0001/questions?rev=b', { as: BOB.email })).status === 400);
});

await kase('chat: daily caps', async () => {
  await req('/api/library', { as: OWNER });   // the tables, made on the first request
  seedQuestions(OWNER, 200);
  const o = await ask({ text: 'one more' });
  ok('the owner\'s 201st question today is 429, saying so and when it resets', o.status === 429 && /200 questions today/.test(o.text) &&
    /midnight UTC/.test(o.text));
  env.DB.raw.prepare('UPDATE questions SET created = ?').run(new Date(Date.now() - 86400e3).toISOString().slice(0, 10) + 'T23:59:00.000Z');
  ok('yesterday\'s do not count', (await ask({ text: 'one more' })).status === 200);
  seedQuestions(BOB.email, 30);
  const m = await ask({ text: 'mine' }, BOB.email);
  ok('a member\'s 31st is 429 with his cap', m.status === 429 && /30 questions today/.test(m.text) && /midnight UTC/.test(m.text));
  ok('another member is not held by it', (await ask({ text: 'mine' }, ALICE.email, '901-0001')).status === 200);
  env.DB.raw.prepare('DELETE FROM questions').run();
  seedQuestions(OWNER, 19, 'session');
  ok('the owner\'s 20th session question goes', (await ask({ text: 's', route: 'session' })).status === 200);
  const s = await ask({ text: 's', route: 'session' });
  ok('the 21st is 429, and a quick one still goes', s.status === 429 && /library session/.test(s.text) && /midnight UTC/.test(s.text) &&
    (await ask({ text: 'q' })).status === 200);
  env.DB.raw.prepare('DELETE FROM questions').run();
  seedQuestions(OWNER, 20, 'quick', true);
  ok('twenty hand-ons today count toward the session cap', (await ask({ text: 's', route: 'session' })).status === 429);
});

await kase('chat: which model', async () => {
  const m = async (body) => (await ask(body)).data.model;
  ok('short, anchored, plain: quick', await m({ text: 'What is this?', anchor: ANCHOR }) === 'quick');
  ok('over 300 characters: strong', await m({ text: 'x'.repeat(301) }) === 'strong' && await m({ text: 'x'.repeat(300) }) === 'quick');
  let all = true;
  for (const quote of ['\\frac{a}{b}', 'x^2', 'a_i', '∑ x', '∫ f', '√2', 'a ≤ b', 'a ≥ b', 'a ≠ b', 'a = b + c']) {
    all = all && await m({ text: 'Why?', anchor: { ...ANCHOR, quote } }) === 'strong';
  }
  ok('maths in the quote: strong, for each sign', all);
  ok('a plain quote: quick', await m({ text: 'Why?', anchor: { ...ANCHOR, quote: 'It is 42 hertz.' } }) === 'quick');
  const a = await ask({ text: 'Why?' });
  await box('/api/editor/jobs');
  await answerQ(a.data.id);
  const again = await ask({ text: 'Why, more carefully?', again: a.data.id });
  ok('an again: strong, in the same thread', again.data.model === 'strong' && again.data.thread === a.data.thread);
  ok('again on an unanswered question is 400', (await ask({ text: 'x', again: again.data.id })).status === 400);
});

await kase('chat: the box takes quick questions, with the source for the owner alone', async () => {
  withSource();
  const o1 = await ask({ text: 'First?' });
  await box('/api/editor/jobs');
  await answerQ(o1.data.id, { answer: 'One.' });
  const o2 = await ask({ text: 'Second?', thread: o1.data.thread, anchor: ANCHOR });
  const m = await ask({ text: 'Member asks?' }, BOB.email);
  const s = await ask({ text: 'For the session', route: 'session' });
  const j = await box('/api/editor/jobs');
  const jo = j.data.questions.find((x) => x.id === o2.data.id), jm = j.data.questions.find((x) => x.id === m.data.id);
  ok('the job poll hands out the queued quick ones, not the session one', j.status === 200 && j.data.questions.length === 2 &&
    !j.data.questions.some((x) => x.id === s.data.id) && Array.isArray(j.data.jobs));
  ok('the owner\'s: owner true, the kept source, its anchor and the thread before it', jo.owner === true &&
    jo.source === 'sources/105/105-0001-A.tar.gz' && jo.number === '105-0001' && jo.rev === 'A' && jo.model === 'quick' &&
    jo.anchor.page === 2 && JSON.stringify(jo.history) === JSON.stringify([{ text: 'First?', answer: 'One.' }]));
  ok('the member\'s: owner false and no source', jm.owner === false && !('source' in jm) && jm.history.length === 0 &&
    !j.text.includes(BOB.email));
  ok('they are answering now, and not handed out again', (await qget(o2.data.id)).data.status === 'answering' &&
    (await box('/api/editor/jobs')).data.questions.length === 0);
  env.DB.raw.prepare('UPDATE questions SET claimed = ? WHERE id = ?').run(new Date(Date.now() - 119e3).toISOString(), m.data.id);
  ok('one answering under 2 minutes is not handed out again', (await box('/api/editor/jobs')).data.questions.length === 0);
  env.DB.raw.prepare('UPDATE questions SET claimed = ? WHERE id = ?').run(new Date(Date.now() - 121e3).toISOString(), m.data.id);
  ok('one answering over 2 minutes is', (await box('/api/editor/jobs')).data.questions.map((x) => x.id).join() === m.data.id);
  const ins = env.DB.raw.prepare("INSERT INTO questions (id, number, rev, asker, text, thread, route, model, status, answer, created, updated) " +
    "VALUES (?, '105-0001', 'A', ?, ?, ?, 'quick', 'quick', 'answered', 'a', ?, ?)");
  for (let i = 0; i < 7; i++) ins.run(`h000000${i}`, OWNER, `t${i}`, o1.data.thread, new Date(Date.now() - 60e3 + i).toISOString(), new Date().toISOString());
  const h = await ask({ text: 'Tenth?', thread: o1.data.thread });
  const hj = (await box('/api/editor/jobs')).data.questions.find((x) => x.id === h.data.id);
  ok('history is the six turns before it, oldest first', hj.history.length === 6 && hj.history[5].text === 'Second?' &&
    hj.history[0].text === 't3');
});

await kase('chat: the outbox, answers and the session\'s answer', async () => {
  const s = await ask({ text: 'For the session', route: 'session', anchor: ANCHOR });
  const h = await ask({ text: 'Hand me on' });
  const mh = await ask({ text: 'Member hand on' }, BOB.email);
  await box('/api/editor/jobs');
  const hr = await answerQ(h.data.id, { answer: 'Not in here.', pages: [], hand_on: 'about rev B', model: 'opus', cost: 0.2 });
  const mr = await answerQ(mh.data.id, { answer: 'Not in here.', pages: [], hand_on: 'about rev B' });
  const hq = (await qget(h.data.id)).data, mq = (await qget(mh.data.id, BOB.email)).data;
  ok('the owner\'s hand-on: handed_on, the quick answer stands, the model and cost recorded', hr.status === 200 && hq.status === 'handed_on' &&
    hq.answer === 'Not in here.' && hq.handed === 'about rev B' && hq.model === 'opus' && qrow(h.data.id).cost === 0.2);
  ok('a member\'s hand-on is ignored: answered, not handed', mr.status === 200 && mq.status === 'answered' && mq.handed === null);
  const out = await box('/api/editor/outbox');
  const os = out.data.questions.find((x) => x.id === s.data.id), oh = out.data.questions.find((x) => x.id === h.data.id);
  ok('the outbox lists the owner\'s session and handed-on questions, never a member\'s', out.status === 200 &&
    out.data.questions.length === 2 && os && oh && Array.isArray(out.data.edits) && !out.text.includes('Member hand on') &&
    os.anchor.quote === ANCHOR.quote && os.route === 'session' && !('answer' in os) && oh.handed === 'about rev B' && oh.answer === 'Not in here.');
  ok('posted takes it off the outbox; a second posted is harmless', (await box(`/api/editor/questions/${s.data.id}`, { posted: true })).status === 200 &&
    (await box(`/api/editor/questions/${s.data.id}`, { posted: true })).status === 200 &&
    (await box('/api/editor/outbox')).data.questions.map((x) => x.id).join() === h.data.id && (await qget(s.data.id)).data.status === 'with_session');
  ok('session_answer or posted on a member\'s question is 409, and changes nothing',
    (await box(`/api/editor/questions/${mh.data.id}`, { session_answer: 'x' })).status === 409 &&
    (await box(`/api/editor/questions/${mh.data.id}`, { posted: true })).status === 409 && qrow(mh.data.id).session_answer === null &&
    qrow(mh.data.id).posted === null);
  const sa = await box(`/api/editor/questions/${s.data.id}`, { session_answer: 'Because the motor stalls.' });
  const sq = (await qget(s.data.id)).data;
  ok('the session\'s answer lands: answered', sa.status === 200 && sq.status === 'answered' && sq.session_answer === 'Because the motor stalls.' &&
    !!sq.answered);
  ok('a second session answer, or a quick answer to it, is 409', (await box(`/api/editor/questions/${s.data.id}`, { session_answer: 'again' })).status === 409 &&
    (await answerQ(s.data.id)).status === 409 && qrow(s.data.id).session_answer === 'Because the motor stalls.');
  ok('the handed-on one takes the session\'s answer too, the quick answer kept',
    (await box(`/api/editor/questions/${h.data.id}`, { session_answer: 'Rev B adds a table.' })).status === 200 &&
    (await qget(h.data.id)).data.status === 'answered' && (await qget(h.data.id)).data.answer === 'Not in here.');
  const f = await ask({ text: 'Fail me' });
  const bads = await Promise.all([{}, { answer: 'x' }, { answer: 'x', pages: [], model: 'gpt' }, { answer: 'x', pages: [0], model: 'sonnet' },
    { answer: 'x', pages: [], model: 'sonnet', hand_on: 'two\nlines' }, { failed: 'bored' }, { posted: 'yes' }, { session_answer: 'x'.repeat(4001) },
    { failed: 'error', posted: true }, { failed: 'error', cost: -1 }].map((b) => box(`/api/editor/questions/${f.data.id}`, b)));
  ok('a bad body is 400 and changes nothing', bads.every((r) => r.status === 400) && qrow(f.data.id).status === 'queued');
  ok('failed: stored with its error, and it never moves back', (await box(`/api/editor/questions/${f.data.id}`, { failed: 'day_limit', cost: 0 })).status === 200 &&
    (await qget(f.data.id)).data.status === 'failed' && (await qget(f.data.id)).data.error === 'day_limit' &&
    (await box(`/api/editor/questions/${f.data.id}`, { failed: 'error' })).status === 409 && (await answerQ(f.data.id)).status === 409);
  ok('an unknown question is 404 to the box', (await box('/api/editor/questions/00000000', { posted: true })).status === 404);
  seedQuestions(OWNER, 20, 'session');
  const c = await ask({ text: 'Hand me on again' });
  await box('/api/editor/jobs');
  await answerQ(c.data.id, { hand_on: 'needs the session' });
  const cq = (await qget(c.data.id)).data;
  ok('past the session cap a hand-on is not made: answered, why says so', cq.status === 'answered' && cq.handed === null && /limit/.test(cq.why) &&
    !(await box('/api/editor/outbox')).data.questions.some((x) => x.id === c.data.id));
});

await kase('chat: a quick question times out after 3 minutes; a session one never', async () => {
  const q = await ask({ text: 'Slow?' });
  const s = await ask({ text: 'Session', route: 'session' });
  const old = new Date(Date.now() - 181e3).toISOString();
  env.DB.raw.prepare('UPDATE questions SET created = ?').run(old);
  const r = (await qget(q.data.id)).data;
  ok('it reads as failed, error timeout, and is stored so', r.status === 'failed' && r.error === 'timeout' && qrow(q.data.id).status === 'failed');
  ok('the session question does not', (await qget(s.data.id)).data.status === 'with_session');
  ok('the box is not handed it, and a late answer is 409', (await box('/api/editor/jobs')).data.questions.length === 0 &&
    (await answerQ(q.data.id)).status === 409);
  const a = await ask({ text: 'Answering too long?' });
  await box('/api/editor/jobs');
  env.DB.raw.prepare('UPDATE questions SET created = ? WHERE id = ?').run(new Date(Date.now() - 170e3).toISOString(), a.data.id);
  ok('one answering under 3 minutes stands', (await qget(a.data.id)).data.status === 'answering');
  env.DB.raw.prepare('UPDATE questions SET created = ? WHERE id = ?').run(old, a.data.id);
  ok('over 3 minutes it fails too, in the list as well', (await req(QS, { as: OWNER })).data.questions.find((x) => x.id === a.data.id).error === 'timeout');
});

await kase('chat: the long poll returns on a change, and opening the chat holds the box\'s poll', async () => {
  env.EDITOR_POLL_MS = 20;
  const q = await ask({ text: 'Held?' });
  let t = Date.now();
  const idle = await qget(q.data.id, OWNER, '?wait=1');
  ok('with no change it waits the time asked', idle.data.status === 'queued' && Date.now() - t >= 950);
  ok('a wait that is not a number is 400', (await qget(q.data.id, OWNER, '?wait=soon')).status === 400);
  t = Date.now();
  const held = qget(q.data.id, OWNER, '?wait=20');
  await sleep(100);
  await box('/api/editor/jobs');
  const got = await held;
  ok('the box taking it answers the held poll at once', got.data.status === 'answering' && Date.now() - t < 2000);
  t = Date.now();
  const held2 = qget(q.data.id, OWNER, '?wait=20');
  await sleep(100);
  await answerQ(q.data.id, { answer: 'Yes.' });
  const got2 = await held2;
  ok('its answer does too', got2.data.status === 'answered' && got2.data.answer === 'Yes.' && Date.now() - t < 2000);
  t = Date.now();
  ok('an answered one comes back at once', (await qget(q.data.id, OWNER, '?wait=20')).data.status === 'answered' && Date.now() - t < 1000);
  ok('someone else\'s held poll is 404 at once', (await qget(q.data.id, BOB.email, '?wait=20')).status === 404);
  ok('before the chat is opened the box is idle', (await box('/api/editor/jobs')).data.active === false);
  await req(QS, { as: BOB.email });
  ok('a member opening the chat makes the box\'s poll active', (await box('/api/editor/jobs')).data.active === true);
  env.DB.raw.prepare("UPDATE meta SET v = ? WHERE k = 'chat_active'").run(new Date(Date.now() - 16 * 60e3).toISOString());
  ok('16 minutes later it is not', (await box('/api/editor/jobs')).data.active === false);
  t = Date.now();
  const jp = box('/api/editor/jobs?wait=20');
  await sleep(100);
  await ask({ text: 'Answer me now' }, BOB.email);
  const jg = await jp;
  ok('a question asked while the job poll is held is handed out at once', jg.data.questions.some((x) => x.text === 'Answer me now') &&
    jg.data.jobs.length === 0 && Date.now() - t < 2000);
  env.EDITOR_POLL_MS = undefined;
});

await kase('chat: Make this an edit, and anchored feedback', async () => {
  const q = await ask({ text: 'Does section 3 contradict the table?', anchor: ANCHOR });
  ok('before it has an answer it is 409', (await post(`/api/questions/${q.data.id}/edit`, {})).status === 409);
  await box('/api/editor/jobs');
  await answerQ(q.data.id, { answer: 'Yes: the table says 40.', pages: [2] });
  const e = await post(`/api/questions/${q.data.id}/edit`, {});
  ok('the owner makes it an edit: a request item at the question\'s anchor holding question, quote and answer', e.status === 200 &&
    e.data.kind === 'request' && e.data.rev === 'A' && e.data.status === 'new' && e.data.anchor.page === 2 && e.data.section === null &&
    e.data.text.includes('section 3 contradict') && e.data.text.includes(ANCHOR.quote) && e.data.text.includes('the table says 40'));
  const e2 = await post(`/api/questions/${q.data.id}/edit`, {});
  ok('a second tap answers the same item', e2.status === 200 && e2.data.id === e.data.id && qcount('feedback') === 1);
  const qq = (await qget(q.data.id)).data;
  ok('the question carries the edit with its status', qq.edit && qq.edit.id === e.data.id && qq.edit.status === 'new' && qq.edit.reply === null);
  const fb = await req('/api/documents/105-0001/feedback', { as: OWNER });
  ok('it is in the owner\'s feedback with its anchor', fb.data.feedback[0].id === e.data.id && fb.data.feedback[0].anchor.quote === ANCHOR.quote);
  const m = await ask({ text: 'Member?' }, BOB.email);
  await box('/api/editor/jobs');
  await answerQ(m.data.id);
  ok('a member cannot make one (the generic 403); the owner on a member\'s is 404',
    (await post(`/api/questions/${m.data.id}/edit`, {}, BOB.email)).status === 403 &&
    (await post(`/api/questions/${m.data.id}/edit`, {})).status === 404 && qcount('feedback') === 1 && qrow(m.data.id).edit === null);
  const c = await post('/api/documents/105-0001/feedback', { kind: 'request', text: 'Fix this sentence.', anchor: ANCHOR });
  ok('feedback takes an anchor and gives it back', c.status === 200 && c.data.anchor.page === 2 && c.data.anchor.quote === ANCHOR.quote);
  ok('a bad anchor is 400', (await post('/api/documents/105-0001/feedback', { kind: 'request', text: 'x', anchor: { in: 'pdf', page: 1 } })).status === 400 &&
    (await post('/api/documents/105-0001/feedback', { kind: 'request', text: 'x', anchor: { ...ANCHOR, quote: 'q'.repeat(2001) } })).status === 400);
  ok('the box\'s feedback export carries the anchor', (await box('/api/feedback?status=new')).data.feedback.find((x) => x.id === c.data.id).anchor.rect[2] === 300);
  ok('feedback with none reads anchor null', (await post('/api/documents/105-0001/feedback', { kind: 'text', text: 'x' })).data.anchor === null);
});

// ── NOTES on the PDF (docs/library-chat/api.md, Notes on the PDF) ──

const mkNote = (body, as = OWNER, num = '105-0001') => post(`/api/documents/${num}/notes`, body, as);
const notesOf = async (as = OWNER, q = '', num = '105-0001') => req(`/api/documents/${num}/notes${q}`, { as });
const noteAt = (id, body = {}, as = OWNER, sub = '') => post(`/api/notes/${id}${sub}`, body, as);
const nrow = (id) => env.DB.raw.prepare('SELECT * FROM notes WHERE id = ?').get(id);
const frow = (id) => env.DB.raw.prepare('SELECT * FROM feedback WHERE id = ?').get(id);
const makingOf = (as = OWNER, num = '105-0001') => req(`/api/documents/${num}/making`, { as });
const TEXT_AT = { p: 2, quote: 'The widget runs at 42 hertz.' };
const BOX_AT = { p: 3, rect: [72, 100, 200, 50], boxText: 'Figure 2' };
/** A new deployment where num has one more revision, rev. */
const addRev = (num, rev) => republish((next) => {
  const d = next.documents[num];
  d.revisions.push({ rev, file: `files/${num.slice(0, 3)}/${num}-${rev}_x.pdf`, date: '2026-09-27' });
});

await kase('notes: each kind and anchor is made, and the list is the viewer\'s own', async () => {
  const c = await mkNote({ kind: 'comment', ...TEXT_AT, text: 'Say which widget.' });
  ok('the owner makes a text comment: 201, n 1, a feedback item at its page and quote, status new, no items', c.status === 201 &&
    c.data.kind === 'comment' && c.data.route === null && c.data.n === 1 && c.data.p === 2 && c.data.quote === TEXT_AT.quote &&
    c.data.rect === null && c.data.general === false && c.data.status === 'new' && c.data.items.length === 0 && c.data.unread === false &&
    /^[0-9a-f]{8}$/.test(c.data.fid) && c.data.qid === null && !Number.isNaN(Date.parse(c.data.time)) &&
    JSON.stringify(JSON.parse(frow(c.data.fid).anchor)) === JSON.stringify({ in: 'pdf', page: 2, rect: [0, 0, 0, 0], quote: TEXT_AT.quote }) &&
    frow(c.data.fid).kind === 'request' && frow(c.data.fid).rev === 'A');
  const b = await mkNote({ kind: 'ask', route: 'session', ...BOX_AT, text: 'What does this figure show?' });
  ok('a box ask for the session: its question carries the box as [x0, y0, x1, y1] with box: true', b.status === 201 && b.data.n === 2 &&
    b.data.route === 'session' && JSON.stringify(b.data.rect) === JSON.stringify(BOX_AT.rect) && b.data.boxText === 'Figure 2' &&
    b.data.status === 'with_session' && b.data.qid === qrow(b.data.qid).id && b.data.thread === qrow(b.data.qid).thread &&
    JSON.stringify(JSON.parse(qrow(b.data.qid).anchor)) === JSON.stringify({ in: 'pdf', page: 3, rect: [72, 100, 272, 150], quote: 'Figure 2', box: true }) &&
    JSON.stringify(b.data.items) === JSON.stringify([{ t: 'wait', id: b.data.qid, route: 'session', since: qrow(b.data.qid).created }]));
  const bc = await mkNote({ kind: 'comment', p: 1, rect: [0, 0, 12, 12], text: 'Crop me.' });
  ok('a box comment with no text: box: true and no quote on its feedback item', bc.status === 201 && bc.data.boxText === null &&
    JSON.stringify(JSON.parse(frow(bc.data.fid).anchor)) === JSON.stringify({ in: 'pdf', page: 1, rect: [0, 0, 12, 12], box: true }));
  const g = await mkNote({ kind: 'ask', general: true, text: 'Summarise it.' });
  ok('a whole-document ask: quick, no anchor on its question, p null', g.status === 201 && g.data.general === true && g.data.p === null &&
    g.data.route === 'quick' && g.data.status === 'queued' && qrow(g.data.qid).anchor === null && g.data.n === 4);
  const m = await mkNote({ kind: 'ask', ...TEXT_AT, block: 7, text: 'What is a hertz?' }, BOB.email);
  ok('a member makes an ask: numbered among his own', m.status === 201 && m.data.n === 1 && m.data.block === 7 && m.data.route === 'quick');
  const ol = await notesOf(), ml = await notesOf(BOB.email);
  ok('each lists only his own, by n, on the newest revision', ol.status === 200 && ol.data.rev === 'A' && ol.data.number === '105-0001' &&
    ol.data.notes.map((x) => x.id).join() === [c, b, bc, g].map((x) => x.data.id).join() && ml.data.notes.map((x) => x.id).join() === m.data.id &&
    !ol.text.includes('What is a hertz') && !ml.text.includes('Summarise'));
  ok('a note carries no viewer and no deleted field', !('viewer' in c.data) && !('deleted' in c.data) && !ol.text.includes(OWNER));
  ok('rev is a letter the viewer opens: ?rev=A lists, ?rev=Z 404, ?rev=a 400', (await notesOf(OWNER, '?rev=A')).data.notes.length === 4 &&
    (await notesOf(OWNER, '?rev=Z')).status === 404 && (await notesOf(OWNER, '?rev=a')).status === 400 &&
    (await mkNote({ kind: 'ask', general: true, text: 'x', rev: 'Z' })).status === 404);
  const before = [qcount(), qcount('feedback'), qcount('notes')];
  const bads = await Promise.all([{ kind: 'memo', general: true, text: 'x' }, { kind: 'ask', text: 'x' }, { kind: 'ask', p: 2, text: 'x' },
    { kind: 'ask', ...TEXT_AT, text: '' }, { kind: 'ask', ...TEXT_AT, text: 'x'.repeat(2001) }, { kind: 'ask', p: 2, quote: 'q'.repeat(2001), text: 'x' },
    { kind: 'ask', p: 1, rect: [0, 0, 11, 20], text: 'x' }, { kind: 'ask', p: 1, rect: [1990, 0, 20, 20], text: 'x' },
    { kind: 'ask', p: 1, rect: [0, 0, 20], text: 'x' }, { kind: 'ask', p: 1, rect: [0, 0, 20, 20], quote: 'q', text: 'x' },
    { kind: 'ask', general: true, p: 1, text: 'x' }, { kind: 'ask', p: 0, quote: 'q', text: 'x' }, { kind: 'comment', route: 'quick', general: true, text: 'x' },
    { kind: 'ask', route: 'slack', general: true, text: 'x' }, { kind: 'ask', p: 1, quote: 'q', boxText: 'b', text: 'x' },
    { kind: 'ask', general: true, text: 'x', rev: 'a1' }].map((x) => mkNote(x)));
  ok('a bad kind, anchor, text, route or rev is 400, and makes nothing', bads.every((r) => r.status === 400) &&
    JSON.stringify([qcount(), qcount('feedback'), qcount('notes')]) === JSON.stringify(before));
  ok('the bounds themselves are allowed: w and h 12, a box to 2000, a 2000-character text',
    (await mkNote({ kind: 'ask', p: 1, rect: [1988, 1988, 12, 12], text: 'x'.repeat(2000) })).status === 201);
});

await kase('notes: a member asks only, and a note is its viewer\'s', async () => {
  const counts = () => JSON.stringify([qcount(), qcount('feedback'), qcount('notes')]);
  await req('/api/library', { as: OWNER });
  const zero = counts();
  ok('a member\'s comment is 403, and makes nothing', (await mkNote({ kind: 'comment', general: true, text: 'x' }, BOB.email)).status === 403 &&
    counts() === zero);
  ok('a member\'s session ask is 403, and makes nothing', (await mkNote({ kind: 'ask', route: 'session', general: true, text: 'x' }, BOB.email)).status === 403 &&
    counts() === zero);
  const pal = 'pal@example.com';
  await mkLink({ number: '105-0001', rev: null }, { kind: 'private', people: [pal] });
  const gp = await mkNote({ kind: 'ask', general: true, text: 'x' }, pal);
  ok('a guest: the generic 403 on a POST, 404 on the GETs', gp.status === 403 && gp.text === 'only the owner can change this\n' &&
    (await notesOf(pal)).status === 404 && (await makingOf(pal)).status === 404);
  ok('a stranger is refused', (await mkNote({ kind: 'ask', general: true, text: 'x' }, 'stranger@example.com')).status === 403 &&
    (await notesOf('stranger@example.com')).status === 403 && counts() === zero);
  ok('a member on a document he cannot open is 404', (await mkNote({ kind: 'ask', general: true, text: 'x' }, BOB.email, '901-0001')).status === 404 &&
    (await notesOf(BOB.email, '', '901-0001')).status === 404 && counts() === zero);
  const o = await mkNote({ kind: 'comment', ...TEXT_AT, text: 'Owner only.' });
  const m = await mkNote({ kind: 'ask', ...TEXT_AT, text: 'Member asks.' }, BOB.email);
  const tries = async (id, as) => [await noteAt(id, { unread: true }, as), await noteAt(id, { text: 'more' }, as, '/reply'),
    await noteAt(id, {}, as, '/delete')];
  ok('the owner\'s note id is 404 to a member: view, reply and delete', (await tries(o.data.id, BOB.email)).every((r) => r.status === 404) &&
    nrow(o.data.id).deleted === null && nrow(o.data.id).unread === 0 && nrow(o.data.id).adds === null);
  ok('and a member\'s is 404 to the owner, and to another member', (await tries(m.data.id, OWNER)).every((r) => r.status === 404) &&
    (await tries(m.data.id, ALICE.email)).every((r) => r.status === 404) && nrow(m.data.id).deleted === null && qcount() === 1);
  ok('the member still reaches his own', (await noteAt(m.data.id, { unread: false }, BOB.email)).status === 200);
  // his ask never reaches the session: no hand-on, nothing in the outbox, no feedback item, no extra
  await box('/api/editor/jobs');
  await answerQ(m.data.qid, { hand_on: 'needs the session' });
  const mm = (await notesOf(BOB.email)).data.notes[0];
  ok('a member\'s note never reaches the session: no hand-on, not in the outbox, no comment, no extra', mm.status === 'answered' &&
    !mm.items.some((x) => x.t === 'hand') && mm.extra === null && !(await box('/api/editor/outbox')).text.includes('Member asks') &&
    qcount('feedback') === 1 && (await box('/api/feedback')).data.feedback.every((f) => !f.text.includes('Member asks')));
  ok('his making is null while the owner\'s round works', (await makingOf(BOB.email)).data.making === null &&
    (await makingOf()).data.making.phase === 'working');
  // a private link reaching 001-0001 at A only: a note there, then the link disabled
  const l = await mkLink({ number: '001-0001', rev: 'A' }, { kind: 'private', people: [BOB.email] });
  const onA = await mkNote({ kind: 'ask', general: true, text: 'On the memo.' }, BOB.email, '001-0001');
  ok('a member\'s note on a revision he opens; B, which he cannot, is 404', onA.status === 201 &&
    (await mkNote({ kind: 'ask', general: true, text: 'x', rev: 'B' }, BOB.email, '001-0001')).status === 404);
  await setLink(l.data.id, { state: 'disabled' });
  ok('once he cannot open it, its list and its id are 404', (await notesOf(BOB.email, '?rev=A', '001-0001')).status === 404 &&
    (await noteAt(onA.data.id, { unread: false }, BOB.email)).status === 404);
  seedQuestions(BOB.email, 30);
  const n0 = qcount('notes'), capped = await mkNote({ kind: 'ask', general: true, text: 'one more' }, BOB.email);
  ok('past his daily cap the ask is 429 and no note is made', capped.status === 429 && /30 questions today/.test(capped.text) &&
    qcount('notes') === n0);
});

await kase('notes: an ask\'s items follow its questions, and a session answer marks it unread', async () => {
  const q = await mkNote({ kind: 'ask', ...TEXT_AT, text: 'Quick one?' });
  const h = await mkNote({ kind: 'ask', general: true, text: 'Hand me on.' });
  const s = await mkNote({ kind: 'ask', route: 'session', general: true, text: 'For the session.' });
  const f = await mkNote({ kind: 'ask', general: true, text: 'Fail me.' });
  await box('/api/editor/jobs');
  await answerQ(q.data.qid, { answer: 'Yes, quickly.', pages: [2], model: 'opus' });
  await answerQ(h.data.qid, { answer: 'Not in here.', pages: [], hand_on: 'about rev B' });
  await box(`/api/editor/questions/${f.data.qid}`, { failed: 'error' });
  const byId = async () => Object.fromEntries((await notesOf()).data.notes.map((x) => [x.id, x]));
  let all = await byId();
  const qa = all[q.data.id], hq = qrow(h.data.qid);
  ok('quick answered: one answer item with its model, text, pages and time', qa.status === 'answered' &&
    JSON.stringify(qa.items) === JSON.stringify([{ t: 'a', id: q.data.qid, model: 'opus', text: 'Yes, quickly.', pages: [2], time: qrow(q.data.qid).answered }]));
  ok('handed on: the quick answer, the hand-on, then a wait on the session', all[h.data.id].status === 'handed_on' &&
    JSON.stringify(all[h.data.id].items) === JSON.stringify([{ t: 'a', id: hq.id, model: 'sonnet', text: 'Not in here.', pages: [], time: hq.handed_at },
      { t: 'hand', id: hq.id, why: 'about rev B', time: hq.handed_at }, { t: 'wait', id: hq.id, route: 'session', since: hq.handed_at }]));
  ok('with the session: a wait', JSON.stringify(all[s.data.id].items.map((x) => [x.t, x.route])) === JSON.stringify([['wait', 'session']]));
  ok('failed: a fail item with its error', all[f.data.id].status === 'failed' &&
    JSON.stringify(all[f.data.id].items) === JSON.stringify([{ t: 'fail', id: f.data.qid, error: 'error' }]));
  ok('nothing is unread before a session answer', Object.values(all).every((x) => x.unread === false));
  await box(`/api/editor/questions/${s.data.qid}`, { session_answer: 'The session says so.' });
  await box(`/api/editor/questions/${h.data.qid}`, { session_answer: 'Rev B adds a table.' });
  all = await byId();
  ok('the session\'s answer lands as an answer, model session', JSON.stringify(all[s.data.id].items) ===
    JSON.stringify([{ t: 'a', id: s.data.qid, model: 'session', text: 'The session says so.', pages: [], time: qrow(s.data.qid).answered }]) &&
    all[s.data.id].status === 'answered');
  ok('the hand-on\'s answer follows the hand-on', JSON.stringify(all[h.data.id].items.map((x) => [x.t, x.model || null])) ===
    JSON.stringify([['a', 'sonnet'], ['hand', null], ['a', 'session']]) && all[h.data.id].items[2].text === 'Rev B adds a table.');
  ok('both are unread now; the quick and failed ones are not', all[s.data.id].unread && all[h.data.id].unread &&
    !all[q.data.id].unread && !all[f.data.id].unread);
  const cleared = await noteAt(s.data.id, { unread: false });
  ok('the page clears it on opening', cleared.status === 200 && cleared.data.unread === false && (await byId())[s.data.id].unread === false &&
    (await byId())[h.data.id].unread === true);
  const again = await noteAt(f.data.id, { text: 'Fail me.' }, OWNER, '/reply');
  const fq = qrow(again.data.items[1].id);
  ok('Try again is a reply: the follow-up and its wait follow the failure, in the note\'s thread and anchor', again.status === 200 &&
    JSON.stringify(again.data.items.map((x) => x.t)) === JSON.stringify(['fail', 'q', 'wait']) && again.data.items[1].text === 'Fail me.' &&
    fq.thread === f.data.thread && fq.anchor === null && again.data.status === 'failed');
  const qr = await noteAt(q.data.id, { text: 'And the table?', route: 'session' }, OWNER, '/reply');
  ok('the owner\'s follow-up may go to the session, with the note\'s anchor', qr.status === 200 && qr.data.items[1].route === 'session' &&
    JSON.parse(qrow(qr.data.items[1].id).anchor).quote === TEXT_AT.quote && qrow(qr.data.items[1].id).status === 'with_session');
  const m = await mkNote({ kind: 'ask', general: true, text: 'Member asks.' }, BOB.email);
  const n0 = qcount();
  ok('a member\'s follow-up to the session is 403 and makes nothing',
    (await noteAt(m.data.id, { text: 'x', route: 'session' }, BOB.email, '/reply')).status === 403 && qcount() === n0 &&
    (await noteAt(m.data.id, { text: 'Quick more.' }, BOB.email, '/reply')).data.items.map((x) => x.t).join() === 'wait,q,wait');
});

await kase('notes: a comment\'s additions, the view state and delete', async () => {
  const c = await mkNote({ kind: 'comment', ...BOX_AT, text: 'Redraw this.' });
  const add = await noteAt(c.data.id, { text: 'In colour.' }, OWNER, '/reply');
  const it = add.data.items[0];
  ok('an addition: an add item, and a feedback item of its own at the note\'s anchor', add.status === 200 && add.data.items.length === 1 &&
    it.t === 'add' && it.text === 'In colour.' && it.fid !== c.data.fid && frow(it.fid).kind === 'request' &&
    frow(it.fid).anchor === frow(c.data.fid).anchor && JSON.parse(frow(it.fid).anchor).box === true);
  ok('a route on a comment\'s reply, or no text, is 400', (await noteAt(c.data.id, { text: 'x', route: 'quick' }, OWNER, '/reply')).status === 400 &&
    (await noteAt(c.data.id, { text: ' ' }, OWNER, '/reply')).status === 400 && qcount('feedback') === 2);
  await env.DB.raw.prepare("UPDATE feedback SET status = 'delivered' WHERE id = ?").run(c.data.fid);
  ok('its status is its feedback item\'s', (await notesOf()).data.notes[0].status === 'delivered');
  const v = await noteAt(c.data.id, { cardPos: { x: 10, y: -4.5 }, cardSize: { w: 320, h: 180 }, rect: [80, 110, 100, 40], boxText: 'Fig 2' });
  ok('view state: the card, and a box moved, change the note', v.status === 200 && v.data.cardPos.x === 10 && v.data.cardSize.h === 180 &&
    JSON.stringify(v.data.rect) === '[80,110,100,40]' && v.data.boxText === 'Fig 2');
  ok('a comment already sent keeps what it sent', JSON.parse(frow(c.data.fid).anchor).rect.join() === '72,100,272,150' &&
    JSON.parse(frow(c.data.fid).anchor).quote === 'Figure 2');
  ok('null clears the card', (await noteAt(c.data.id, { cardPos: null, cardSize: null })).data.cardPos === null && nrow(c.data.id).card_size === null);
  const t = await mkNote({ kind: 'ask', ...TEXT_AT, text: 'Where?' });
  ok('a text note takes a block', (await noteAt(t.data.id, { block: 'p2-b4' })).data.block === 'p2-b4');
  const bads = await Promise.all([{}, { unread: 'no' }, { cardPos: { x: 1 } }, { cardSize: { w: 0, h: 5 } }, { rect: [0, 0, 5, 5] },
    { block: 3 }, { boxText: 'x'.repeat(2001) }].map((b) => noteAt(c.data.id, b)).concat([noteAt(t.data.id, { rect: [0, 0, 20, 20] }),
    noteAt(t.data.id, { boxText: 'x' })]));
  ok('nothing, a bad field, a block on a box or a rect on a text note is 400', bads.every((r) => r.status === 400) &&
    nrow(c.data.id).rect === '[80,110,100,40]');
  const d = await noteAt(t.data.id, {}, OWNER, '/delete');
  ok('delete: {id, deleted: true}, gone from the list, and 404 after', d.status === 200 && d.data.deleted === true && d.data.id === t.data.id &&
    !(await notesOf()).data.notes.some((x) => x.id === t.data.id) && (await noteAt(t.data.id, {}, OWNER, '/delete')).status === 404 &&
    (await noteAt(t.data.id, { unread: false })).status === 404);
  ok('its question stands and still counts', qrow(t.data.qid).status === 'queued' &&
    (await req(QS, { as: OWNER })).data.questions.some((x) => x.id === t.data.qid));
  ok('the next note is numbered after the deleted one', (await mkNote({ kind: 'ask', general: true, text: 'Next.' })).data.n === 3);
});

await kase('notes: the round, working -> extra -> ready', async () => {
  ok('no round at first', (await makingOf()).data.making === null && (await makingOf()).data.number === '105-0001');
  const a = await mkNote({ kind: 'ask', general: true, text: 'Asks start nothing.' });
  ok('an ask starts no round', a.data.extra === null && (await makingOf()).data.making === null);
  const c1 = await mkNote({ kind: 'comment', general: true, text: 'Shorter.' });
  const mk = (await makingOf()).data.making;
  ok('the first comment starts one: from its revision, to the next letter, working, not extra', c1.data.extra === null &&
    frow(c1.data.fid).extra === null && mk.from === 'A' && mk.to === 'B' && mk.phase === 'working' && mk.carried === false &&
    !Number.isNaN(Date.parse(mk.sentAt)));
  const c2 = await mkNote({ kind: 'comment', ...TEXT_AT, text: 'And this.' });
  const add = await noteAt(c1.data.id, { text: 'Much shorter.' }, OWNER, '/reply');
  const fb = await post('/api/documents/105-0001/feedback', { kind: 'request', text: 'By the feedback route.' });
  ok('comments while it works are extra: B, on the note and its feedback item', c2.data.extra === 'B' && frow(c2.data.fid).extra === 'B' &&
    frow(add.data.items[0].fid).extra === 'B' && fb.data.extra === 'B');
  ok('the box\'s feedback export carries extra', (await box('/api/feedback')).data.feedback.filter((x) => x.extra === 'B').length === 3);
  ok('the round is unchanged by them', JSON.stringify((await makingOf()).data.making) === JSON.stringify(mk));
  addRev('105-0001', 'B');
  ok('once the register holds B it is ready', (await makingOf()).data.making.phase === 'ready');
  const c3 = await mkNote({ kind: 'comment', general: true, text: 'Next round.', rev: 'B' });
  const mk2 = (await makingOf()).data.making;
  ok('the next comment starts a new round, B to C', c3.data.extra === null && mk2.from === 'B' && mk2.to === 'C' && mk2.phase === 'working');
  addRev('003-0001', 'H');
  await post('/api/documents/003-0001/feedback', { kind: 'text', text: 'Mine.' });
  addRev('003-0002', 'Z');
  await post('/api/documents/003-0002/feedback', { kind: 'request', text: 'x' });
  ok('the letters skip I and O and carry past Z', (await makingOf(OWNER, '003-0001')).data.making.to === 'J' &&
    (await makingOf(OWNER, '003-0002')).data.making.to === 'AA');
  ok('a member\'s making is always null', (await makingOf(BOB.email)).data.making === null);
});

await kase('notes: a sent draft starts a round', async () => {
  withSource();
  const d = await openDraft();
  await post(`/api/drafts/${d.id}/comments`, { anchor: null, text: 'Overall too long.' });
  ok('before the send there is no round', (await makingOf()).data.making === null);
  ok('the send starts one, A to B', (await post(`/api/drafts/${d.id}/send`, {})).status === 200 &&
    JSON.stringify(Object.values((await makingOf()).data.making).slice(0, 3)) === JSON.stringify(['A', 'B', 'working']));
  ok('a comment after it is extra', (await mkNote({ kind: 'comment', general: true, text: 'Also.' })).data.extra === 'B');
});

await kase('notes: carrying a ready round onto its new revision', async () => {
  const ot = await mkNote({ kind: 'ask', ...TEXT_AT, block: 3, text: 'Where is it?' });
  const ob = await mkNote({ kind: 'ask', ...BOX_AT, text: 'This box?' });
  const oc = await mkNote({ kind: 'comment', general: true, text: 'Tighten it.' });
  const gone = await mkNote({ kind: 'ask', p: 4, quote: 'Deleted quote.', text: 'Gone.' });
  await noteAt(gone.data.id, {}, OWNER, '/delete');
  await noteAt(ot.data.id, { cardPos: { x: 1, y: 2 }, cardSize: { w: 300, h: 100 } });
  const mt = await mkNote({ kind: 'ask', p: 5, quote: 'A member quote.', text: 'Member here.' }, BOB.email);
  ok('the owner\'s browser cannot reach the carry routes', (await req('/api/editor/carry', { as: OWNER })).status === 403 &&
    (await post('/api/editor/carry/105-0001/B', { found: {} })).status === 403);
  ok('while the round works nothing is listed, and a carry is 409', (await box('/api/editor/carry')).data.rounds.length === 0 &&
    (await box('/api/editor/carry/105-0001/B', { found: {} })).status === 409 && qcount('notes') === 5);
  ok('a round the site does not have is 404', (await box('/api/editor/carry/105-0001/C', { found: {} })).status === 404 &&
    (await box('/api/editor/carry/106-0001/B', { found: {} })).status === 404);
  addRev('105-0001', 'B');
  const list = (await box('/api/editor/carry')).data.rounds;
  ok('ready: the round, and only its live text notes, every viewer\'s', list.length === 1 && list[0].number === '105-0001' &&
    list[0].from === 'A' && list[0].to === 'B' && list[0].notes.map((x) => x.id).sort().join() === [ot.data.id, mt.data.id].sort().join() &&
    list[0].notes.find((x) => x.id === ot.data.id).quote === TEXT_AT.quote && list[0].notes.find((x) => x.id === ot.data.id).p === 2 &&
    !JSON.stringify(list).includes('Member here'));
  ok('a bad found is 400', (await box('/api/editor/carry/105-0001/B', { found: [] })).status === 400 &&
    (await box('/api/editor/carry/105-0001/B', { found: { nope: 1 } })).status === 400 &&
    (await box('/api/editor/carry/105-0001/B', { found: { [ot.data.id]: 0 } })).status === 400 && qcount('notes') === 5);
  const c = await box('/api/editor/carry/105-0001/B', { found: { [ot.data.id]: 6, [mt.data.id]: null } });
  ok('carried: every live note of every viewer', c.status === 200 && JSON.stringify(c.data) === JSON.stringify({ number: '105-0001', to: 'B', carried: 4 }));
  const on = (await notesOf(OWNER, '?rev=B')).data.notes, mn = (await notesOf(BOB.email, '?rev=B')).data.notes;
  const [t2, b2, c2] = on;
  ok('the owner\'s three on B, renumbered in order, from A, the cards cleared', on.length === 3 && on.map((x) => x.n).join() === '1,2,3' &&
    on.every((x) => x.carriedFrom === 'A' && x.cardPos === null && x.cardSize === null) && t2.text === 'Where is it?');
  ok('a found text note moves to its page, block null for the page', t2.p === 6 && t2.block === null && t2.passageChanged === false);
  ok('the same qid, thread and fid, so its history shows', t2.qid === ot.data.qid && t2.thread === ot.data.thread && c2.fid === oc.data.fid &&
    t2.items.length === 1 && t2.items[0].t === 'wait');
  ok('the box keeps its place, the comment is answered by B', JSON.stringify(b2.rect) === JSON.stringify(BOX_AT.rect) && b2.p === 3 &&
    b2.answeredBy === null && c2.answeredBy === 'B' && c2.general === true);
  ok('the member\'s, to him alone: not found, it keeps its page, passage changed', mn.length === 1 && mn[0].p === 5 && mn[0].passageChanged === true &&
    mn[0].carriedFrom === 'A' && !on.some((x) => x.text === 'Member here.'));
  ok('the notes on A stay, and the deleted one is not carried', (await notesOf(OWNER, '?rev=A')).data.notes.length === 3 &&
    !on.some((x) => x.text === 'Gone.'));
  ok('making says carried, and the round is no longer listed', (await makingOf()).data.making.carried === true &&
    (await box('/api/editor/carry')).data.rounds.length === 0);
  const again = await box('/api/editor/carry/105-0001/B', { found: { [ot.data.id]: 1 } });
  ok('a second carry is 200, says the same, and changes nothing', again.status === 200 && again.data.carried === 4 && qcount('notes') === 9 &&
    (await notesOf(OWNER, '?rev=B')).data.notes[0].p === 6);
  const late = await mkNote({ kind: 'ask', general: true, text: 'Late on A.', rev: 'A' });
  ok('a note made on A after the carry stays on A', late.status === 201 &&
    (await notesOf(OWNER, '?rev=A')).data.notes.some((x) => x.id === late.data.id) &&
    !(await notesOf(OWNER, '?rev=B')).data.notes.some((x) => x.text === 'Late on A.'));
  // a session answer on the carried thread lands on both
  const s = await noteAt(t2.id, { text: 'Session, please.', route: 'session' }, OWNER, '/reply');
  await box(`/api/editor/questions/${s.data.items[1].id}`, { session_answer: 'Here.' });
  ok('a session answer in the thread marks the carried note unread', (await notesOf(OWNER, '?rev=B')).data.notes[0].unread === true);
});

await kase('notes: the page\'s scripts are served, and a feedback table from schema 6 takes extra', async () => {
  republish((next, T2) => {
    writeFileSync(join(T2, 'notes.js'), 'window.LibraryNotes = {};\n');
    writeFileSync(join(T2, 'notes-api.js'), 'window.LibraryNotesApi = {};\n');
    writeFileSync(join(T2, 'notes.css'), '.n {}\n');
  });
  const [js, api] = await Promise.all(['/notes.js', '/notes-api.js'].map((p) => req(p, { as: BOB.email })));
  ok('notes.js and notes-api.js are served as JavaScript to a signed-in viewer', [js, api].every((r) => r.status === 200 &&
    r.headers.get('Content-Type') === 'text/javascript; charset=utf-8') && api.text === 'window.LibraryNotesApi = {};\n');
  ok('unsigned they are refused; a name not listed is 404', (await req('/notes.js')).status === 403 &&
    (await req('/notes.css', { as: OWNER })).status === 404);
  freshEnv();
  env.DB.raw.exec(`CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT); INSERT INTO meta VALUES ('seeded', '2026-09-01'), ('schema', '6');
    CREATE TABLE feedback (id TEXT PRIMARY KEY, number TEXT, rev TEXT, section TEXT, kind TEXT, text TEXT, created TEXT, status TEXT,
      reply TEXT, answered_rev TEXT, anchor TEXT);
    INSERT INTO feedback (id, number, rev, kind, text, created, status) VALUES ('0000f00d', '105-0001', 'A', 'request', 'old', '2026-09-01', 'new');`);
  const f = await post('/api/documents/105-0001/feedback', { kind: 'request', text: 'new' });
  ok('schema 7 adds feedback.extra: the old item reads extra null, a new one is filed', f.status === 200 && f.data.extra === null &&
    (await box('/api/feedback')).data.feedback.find((x) => x.id === '0000f00d').extra === null &&
    env.DB.raw.prepare("SELECT v FROM meta WHERE k = 'schema'").get().v === '7');
});

await kase('seed runs once', async () => {
  await req('/api/library', { as: OWNER });
  await env.DB.prepare('DELETE FROM links').run();
  env = { ...env, DB: { ...env.DB } };   // a new binding object, as a new isolate has: ensure() looks again
  ok('a new isolate on the same database serves', (await req('/api/library', { as: OWNER })).status === 200);
  ok('a second request does not reseed a deleted link',
    (await req('/p/seededtoken0000000000000000000000/001-0001-A.pdf')).status === 404);
});

console.log(`library/pages selfcheck: ${n[0]} ok, ${n[1]} failed`);
process.exit(n[1] ? 1 : 0);
