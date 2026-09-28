/* library-export/pages/lib/library.js — the document library, as one Cloudflare Pages Function you deploy at your
   own domain. See README.md at the repo root for setup; configure() below reads your Access team, app and owners
   from the Pages project's env vars — nothing here names a particular deployment.

THE SPLIT. The box files documents and is the only writer of data/register.json and data/files/ in the repo this
directory is published to; Pages rebuilds on every push. Everything the owner edits lives in D1 (binding DB): the
people the library knows, groups and what they are granted, stars, managed links, packages, folders and document
descriptions. The tables are made, seeded and migrated on the first request (ensure() below), so a fresh or older
database needs no console step.

EVERY REQUEST COMES HERE. _routes.json sends /* to the Function, and handle() allowlists paths: the page (/,
/app.js, /style.css, /fonts/*), /api/*, /files/<PPP-NNNN-R>…, /d/…, /s/…, /l/…, and the signed-out /p/ and /k/.
Anything else is 404, so data/register.json and data/files/* are never served as bare static assets — a PDF leaves
only through pdf() after the check that decides it.

SIGN-IN. Cloudflare Access stays in front (your team, your app's AUD — set via ACCESS_TEAM/ACCESS_AUD, see
configure() below), and this code verifies the Access JWT
itself — from the Cf-Access-Jwt-Assertion header or the CF_Authorization cookie — against the team's signing keys:
RS256 signature, iss, aud, exp and nbf. No header is trusted alone (an email header without a JWT is refused).
ACCESS_JWKS replaces the team's keys only where CF_PAGES_BRANCH is "local" (wrangler pages dev, selfcheck).
Who it is decides what it sees:
  OWNERS    every document, and the only viewer who may change anything but their own stars
  a member  (in at least one group) the full site, scoped to the tree nodes their groups are granted, plus what the
            private links naming them reach
  a guest   (named on a live private link, and in no group) the site showing only what those links reach
  anyone else  403
A grant is a tree node: group:<group name> (every project under that group), project:<PPP> (it, its sub-projects,
transitively, and every document filed in them, later ones included) or doc:<PPP-NNNN> (one document, every
revision). A private link reaches its document at the link's revision (none pinned: the newest), or its package's
documents at the revisions the package pins.

PRIVACY. Only the owner is told who else sees anything. A non-owner's answers carry no other person's name or email,
no groups, grants, links, readers, history or Access state: /api/library gives them people = {their id: name}, their
documents, and the packages their private links reach (id, name, settings, folders, documents, each description
resolved).

A DOCUMENT'S NAME is its title, preceded by what the viewer is shown of its number. Signed in: "PPP-NNNN-R
Title". In a package, by its settings: "Title" (the default), "PPP-NNNN Title" (number), "PPP-NNNN-R Title"
(number and rev), "Title (rev R)" (rev alone). A single document link: "Title". That name is the page's label, the
Content-Disposition filename (+ .pdf) and the URL's last segment, so a browser's PDF tab shows it too:
/files/<PPP-NNNN-R>/<name>.pdf, /p/<token>/<PPP-NNNN>/<name>.pdf. The segment is decoration: access is decided by
the path before it, and the shapes without it work.

FIXED ADDRESSES (docs/design-site-documents-in-the-library.md). Signed in, and only for a viewer who could open the
file itself (404 for anyone else), never cached:
  /d/<PPP-NNNN>      302 to /files/ for the newest revision this viewer may open
  /d/<PPP-NNNN-R>    302 to that revision

MANAGED LINKS. Every link is a row in links with a target — a document at a pinned revision, or following the
newest, or a package — a kind and a state. The owner repoints any link (another revision, another document, rev
pinned or following, another package), renames it, changes its kind, disables it and enables it again, archives
and restores it; each change is a line in history, and nothing is ever deleted, so a restored link answers at the
same URL. A link that is disabled or archived, or whose package is archived, answers 404 exactly as an unknown
token does.
  public     /p/<token>                         signed out. A document link: the PDF its target is now. A package
             /p/<token>/<PPP-NNNN>[/<name>.pdf]  link: its page, and each document in it at the revision it pins.
             /p/<token>/<PPP-NNNN-R>.pdf          older shape of a document link: its PDF where it still points,
                                                 else 302 to /p/<token>
             /k/<token>[/<PPP-NNNN>.pdf]          older shape of a package link, served as /p/
  private    /s/<token>[/<PPP-NNNN>[/<name>.pdf]]  behind Access: the same page or PDF as /p/, only to a signed-in
             person the link names or a member of a group it names (and the owner); another known viewer 404
  signed-in  /l/<token>                         behind Access, documents only: 302 to /files/<PPP-NNNN-R>/<name>.pdf
                                                 (following: the newest at request time) when this viewer may open
                                                 it, else 404. For the lessons site: the owner repoints it here.
                                                 It is an alias that grants nothing: making one runs no syncAccess
                                                 and changes who may see anything not at all.
A token of one kind answers 404 under another kind's prefix. What needs no sign-in is /p/ and /k/ and nothing else;
no signed-out path lists or searches anything.

ACCESS SYNC. Access is a second wall: a person must be in the allow-library policy to reach /s/ or the site at all.
With CF_API_TOKEN, CF_ACCOUNT_ID and CF_ACCESS_POLICY_ID set (encrypted Pages variables the owner sets; the token
needs Account > Access: Apps and Policies > Edit and nothing else; CF_ACCESS_APP_ID set means an app-scoped policy,
unset a reusable one), every change to group members, a link's people, groups, kind or state, or a package's
archive re-runs syncAccess(): the emails needed (the owner, every group member, every person of a live private
link) that the policy lacks are added and recorded in access_managed, and an email the site added that is no longer
needed is removed. An email the site did not add is never touched. A failed call never fails the change; the answer
says access: {sync, manual, error?}, manual being the emails needed but not confirmed in the policy. Without the
variables sync is false and manual lists who must be added to Access by hand.

THE ONE READER LIST. GET /api/courses/readers answers {course code: [emails]}: each course project (101-199) by its
name lower-cased (105 ECE298A -> ece298a), with the members of every group granted that project (a project or group
node that covers it). The lessons site reads its course access from here. Only the owner, or an Access service token
whose client id (the JWT's common_name) is in READER_EXPORT_TOKENS (comma-separated), gets it; anyone else 403.

SOURCES. cc-docs keeps each revision's source as sources/PPP/PPP-NNNN-R.tar.gz beside files/, and the mirror
publishes it at data/sources/ with the revision's `sources` field naming it. Only the owner downloads it:
GET /api/documents/<PPP-NNNN>/revisions/<R>/source, an attachment named PPP-NNNN-R-source.tar.gz. Everyone else gets
404 there, and no /p/, /s/, /k/, /l/, /d/ or /files/ path ever answers a source; the owner's /api/library alone
carries revisions[].source (that URL) where a revision kept one.

FEEDBACK. The owner writes feedback against a revision: a section (null = the whole document) and a kind, "text"
(his own words for that section, used verbatim) or "request" (a change for the making session). It lives in D1
(feedback), status new -> delivered -> done, with the box's reply and answered_rev. The owner's endpoints:
  GET  /api/documents/<N>/feedback                        {number, feedback: [item]}
  POST /api/documents/<N>/feedback {rev?, section?, kind, text, anchor?}   rev absent = the newest; anchor a selection
                                                          {in: 'pdf', page, rect, quote?} (LIBRARY CHAT); -> the item
and his /api/library documents carry feedback: [item]. Nobody else is told feedback exists: 404 on the GET, the
generic 403 on the POST, and no key in any other answer. A feedback poller you run yourself reads
and answers it through two endpoints that only an Access service token FEEDBACK_TOKENS (comma-separated client ids)
names may use; everyone else, the owner's browser included, gets 403:
  GET  /api/feedback[?status=new|delivered|done]          {feedback: [item]}, oldest first
  POST /api/feedback/<id> {status, reply?, answered_rev?}  a status never moves back; answered_rev absent on done is
                                                          read from a reply "answered by rev X"
The token is the verified JWT's common_name (Access puts the client id there); a Cf-Access-Client-Id header, when
Access passes one on, must name the same id, and never counts on its own. item = {id, number, rev, section, kind,
text, created, status, reply, answered_rev, anchor}. A moved document's feedback moves with it.

EDITOR (docs/library-editor.md is the contract). The owner edits a private working copy of a revision's kept source
(a draft) beside its PDF; the box compiles it and, once he sends it, hands it to the session that filed the revision.
  POST /api/documents/<N>/drafts {rev?}   the document's open draft if it has one (one per document, an index
                                          says so), else a new one: the revision's kept source gunzipped and untarred
                                          here (ustar, GNU long names, pax paths), each file that is UTF-8 with no NUL
                                          and at most 1 MB kept in D1 (draft_files, base and text), binaries left to the
                                          box; main is the .tex with \documentclass (main.tex first, then one named like
                                          the document); its first compile is queued. 409 with no source or no main.
  GET  /api/documents/<N>/drafts          {number, drafts: [summary]}, newest first
  POST /api/drafts {project, title, from?: {number, rev?}}   a draft for a NEW document under the project's next
                                          free number: blank (one OG change), or a copy of a revision's kept source
  GET  /api/drafts/<id>                   the draft, with direct (every change OG, no comment, nothing scoped to a
                                          template: sending files it on the box with no session); counts as activity
  POST /api/drafts/<id> {files?, markings?, ui?, compile?}   saves (a new path is a file he added) and queues a
                                          compile unless compile is false or only ui (the editor's layout) changed;
                                          the outline and changes (each with its scope, doc or template) are recomputed
  GET  /api/drafts/<id>/pdf | /synctex | /package      the last good PDF; SyncTeX lookups; the send preview
  POST /api/drafts/<id>/comments[/<cid>] | /send | /discard
Only a draft in state draft saves, takes comments, sends or is discarded (409 else). The outline comes from \part,
\chapter and \section (level 1), \subsection (2), \subsubsection (3), starred too, following \input and \include
from main, with main's lines before \begin{document} as the preamble (level 0). A change is one run of a line diff
(Myers) against the base, refs c1, c2… in file order (main first); its marking is OG where an OG range of the
edited file touches it (OG wins over Adapt), else Adapt where one does, else default_marking (adapt). A comment's
ref is m1, m2…, never reused; its anchor is a PDF rectangle, a line range of one of the draft's files, or null.
Send freezes the package (what GET /package showed, with the time) and makes an item per change and comment;
nothing to send is 409. The PDF and SyncTeX map of the last good compile live in draft_blobs in 1.5 MB chunks and
go when the draft is discarded or answered. SyncTeX: a point answers the smallest box holding it, else the nearest
on that page; a selection the line range of the file with the most boxes in it; a line its boxes, or the nearest
line's that has any.
Every draft route is the owner's: anyone else gets 404 on a GET and the generic 403 on a POST, no other answer
carries a draft, and no /p/ /k/ /s/ /l/ /d/ /files/ path serves one. The box's routes take the same service token
as feedback (boxOnly: FEEDBACK_TOKENS, the verified common_name, a Cf-Access-Client-Id that agrees) and nothing
else, the owner's browser included:
  GET  /api/editor/jobs?wait=N            {active, jobs}: held up to N (at most 25) seconds, looking in D1 once a
                                          second (EDITOR_POLL_MS on a local run), answering as soon as a compile is
                                          queued; each is handed out once and marked running, again after 2 minutes.
                                          active: a draft opened or saved in the last 15 minutes, or one queued.
  POST /api/editor/jobs/<id> {seq, ok, errors, log_tail, pages?, pdf?, map?}   a result older than one recorded
                                          changes nothing; a failed one keeps the last good PDF and records errors
  GET  /api/editor/outbox                 {edits: [package]} sent, oldest first
  POST /api/editor/edits/<id> {state?, answered_rev?, answered_number?, items?}   received, replies, answered (a new
                                          document's with the number it was filed under); nothing moves back, and
                                          answered closes every open item
  GET  /api/editor/edits/<id>/pdf         a sent draft's last good PDF, for the box to crop a drawn box from
Feedback items carry as: "og" (kind text) or "comment" (kind request), how they read in the editor's terms.

LIBRARY CHAT (docs/library-chat/api.md is the contract). A reader asks about a document, or a selection in it, and
gets an answer beside it. Two routes: quick (the box's tool-less claude -p over that one revision) and session (the
library session, through the editor's outbox). The asker's routes:
  POST /api/documents/<N>/questions {text, rev?, anchor?, thread?, route?, again?}   -> the question
  GET  /api/documents/<N>/questions[?rev=R]   {number, questions}, the asker's own, oldest first; marks the chat
                                              active, which holds the box's job poll open 15 minutes
  GET  /api/questions/<id>[?wait=S]           held (at most 25 s, D1 looked in as the job poll does) until it changes;
                                              an answered or failed one at once
  POST /api/questions/<id>/edit {}            the owner's Make this an edit: a feedback item (kind request) with the
                                              question, quote and answer at its anchor; a second tap answers the same
Who: the owner both routes; a member (in a group) quick only, on a revision openable() gives them; a guest or anyone
else the generic 403 on a POST, 404 on a GET. A question or thread is its asker's: anyone else's id, the owner's
included, is 404, and the owner's answers never carry a member's. text 1-2000 characters; rev absent the newest the
asker opens; thread 8 hex of one the asker has on that document; again an own answered quick question. Per asker per
UTC day 200 questions for the owner, 30 for a member; the owner's session questions 20, a hand-on counting as one;
past a cap 429 saying which, and that it resets at midnight UTC. model: session for the session; strong for a text
over 300 characters, maths in the quote (a backslash command, ^, _, a sum, integral, root or (in)equality sign, an =
between terms) or an again; else quick. The box records sonnet or opus on answering. status queued -> answering ->
answered | failed (quick); with_session -> answered; handed_on -> answered. A quick one still queued or answering 3
minutes after it was made reads and is stored as failed, error timeout. The box's routes (boxOnly, as below):
  GET  /api/editor/jobs   also questions: [{id, number, rev, owner, anchor, text, model, history, source?}], each
                          queued quick one marked answering, again after 2 minutes; history the six turns before it
                          in its thread; source (the kept source) only when the asker is the owner
  GET  /api/editor/outbox also questions: the owner's with_session or handed_on not yet posted, a member's never
  POST /api/editor/questions/<id> {answer, pages, hand_on, why, model, cost} | {failed, cost?} | {posted: true} |
                          {session_answer}   hand_on honoured only on the owner's question while the session cap
                          allows (else answered, why says so); posted and session_answer only for the owner's; a wrong
                          state 409, a bad shape 400
Questions live in D1 (questions); asker and cost never leave it. A moved document's questions move with it.

NOTES (api.md, Notes on the PDF). What the page draws on the PDF: a comment (the owner's, a feedback item of kind
request) or an ask (a question, by the rules above), kept per viewer per revision in D1 (notes), each viewer's apart.
  GET  /api/documents/<N>/notes?rev=R   {number, rev, notes}   the viewer's own, by n; status and items derived now
                                        from the questions or feedback items the note made
  POST /api/documents/<N>/notes {rev?, kind, route?, p?, block?, quote?, rect?, boxText?, general?, text}   -> 201
  POST /api/notes/<id>/reply {text, route?}   a follow-up in the ask's thread, or an addition (its own feedback item)
  POST /api/notes/<id> {unread?, cardPos?, cardSize?, block?, rect?, boxText?}   the page's view state, the note only
  POST /api/notes/<id>/delete {}        hides it; what it made stands and counts
  GET  /api/documents/<N>/making        the owner's round, {from, to, phase, sentAt, carried}; a member's null
An ask goes through askQuestion (its checks and limits; a refusal there makes no note); a comment through the
feedback path. A box note's anchor goes out as {in: 'pdf', page, rect: [x0, y0, x1, y1], quote: boxText, box: true};
a text note's as its page and quote with a zero rect. A member makes asks only, quick only; another viewer's note
is 404, the owner's included. The owner's comment (a note, an addition, POST .../feedback) or sent draft starts a
round (making, one per document: to the letter after the newest revision) unless one is working, and then the
comment is extra: to, on its feedback item too. The round is ready once the register holds to. A session answer
marks the notes of its thread unread. The box's side (boxOnly):
  GET  /api/editor/carry                {rounds: [{number, from, to, notes: [{id, p, quote}]}]}   ready, not carried
  POST /api/editor/carry/<N>/<to> {found: {id: page | null}}   every viewer's notes on from copied to the same viewer
                                        on to, once (a second call is 200 and changes nothing)

REQUESTS. The site never makes, moves or renumbers a project: numbers should rarely change. The owner asks for one
instead: POST /api/requests {kind: section | folder, name, parent?, note?} (a section is a new project; a folder a
sub-project inside parent, a project the register has) keeps it in D1 (requests) as status new, and his /api/library
carries requests: [item]. The feedback poller reads them with the same service token, under the feedback routes,
and opens a thread for each in the library's channel, where he and the library seat talk it through and the seat
runs cc-docs:
  GET  /api/feedback/requests[?status=new|delivered|done]   {requests: [item]}, oldest first
  POST /api/feedback/requests/<id> {status, reply?}          a status never moves back
item = {id, kind, parent, name, note, created, status, reply}. Anyone but the owner: the generic 403 on the POST.

LOCKS. The owner locks a package, a link or a group so that it can't be changed by accident: {locked: true|false},
sent on its own, to the item's own route, recorded in its history as "locked" or "unlocked" (groups have a history
for this alone). While an item is locked every other write to it is 409 with a short message: a package's name,
settings, archive, documents and folders; a link's name, target, kind, state, people and groups; a group's name,
members, grants and delete, and the delete of any group a locked link names. Unlocking needs nothing more than
{locked: false}. A lock never stops a link opening, and new links to a locked package are still made. The owner's
/api/library carries locked on each.

PAGES THAT LINK. data/links.json, which the box writes beside the register, maps a document number to
[{site, path}]. The owner's view of a document shows them as linked_from; a missing file is no pages.

PROJECT GROUPS. A project in the register may name a parent (`parent`, or `group`: a name, or the parent project's
PPP), and the site lists sub-projects under it (Career > Resume, Cover letter).

PACKAGES. A package is a named set of documents, each pinned to a revision or to none (the newest), each in a
folder or at the top (folders nest to any depth), each showing the document's description, a package-only one, or
none; display settings {number, rev, date, note} (default: date only) and collapsed (its page's folders start shut) say what its page shows per row. Its
addresses are its links. Archiving it stops its page and every link to it at once; restoring brings them back.

A DOCUMENT THAT MOVES. `cc-docs move` renumbers a document and its new register entry lists the old numbers in
`moved_from`. Once per register and database, every D1 row keyed by an old number (stars, links, package_docs,
doc_meta, doc: grants, and the old visibility table) moves to the new one, keeping a row the new number already has;
revision letters survive a move, so a pinned revision stays valid. /d/<old>[-R] 302s to the new number's file for a
viewer who can see it, else 404.

THE DATABASE. SCHEMA makes the tables of a fresh database; meta 'schema' records the migrations a database has had.
Version 2 added package_docs.rev, packages.settings, links.package and turned each package's own token into a link.
Version 3 (migrate3) adds link kind/state, history, folders, descriptions, groups and grants: each old reader with
projects or per-document grants becomes a group of one with the same reach (a project with a document hidden from
them, or with sub-projects, becomes grants of its documents instead, so nobody sees more than before), and each
package shared with readers gets one private link naming them. readers stays as the directory of names;
its projects column and the visibility table are no longer read.

WRITES are POST with a JSON body (a cross-site form cannot send one without a preflight nothing here answers); all
but the star are the owner's:
  /api/documents/<N>/star         {starred}                         any viewer who can see N
  /api/documents/<N>/description  {description}                     one line, <= 200 characters; "" clears it
  /api/links                      {target, kind?, name?, people?, groups?}   target {number, rev|null} | {package};
                                  kind public (default) | private | signed-in; no name: public-link-N,
                                  private-link-N or link-N, one past the highest on that target
  /api/links/<id>                 {name?, target?, kind?, state?, people?, groups?} | {locked}   state live |
                                  disabled | archived; people and groups replace the lists
  /api/packages                   {name}
  /api/packages/<id>              {name?, settings?, archived?} | {locked}
  /api/packages/<id>/documents    {number, add, rev?, folder?, desc_mode?, description?}   add false removes it;
                                  on a document already in it only the fields sent change
  /api/packages/<id>/folders      {name, parent?}
  /api/packages/<id>/folders/<f>  {name?, parent?, delete?}          delete lifts its documents and folders to its
                                                                     parent; a parent cycle is 400
  /api/groups                     {name}
  /api/groups/<gid>               {name?, add?: {email, name?}, remove?: email, grant?: node, revoke?: node, delete?}
                                  | {locked}
  /api/requests                   {kind, name, parent?, note?}      (REQUESTS)
*/

// Your deployment's identity — set once per request from the Pages project's env vars by configure() below, never
// hardcoded here, so this file carries no particular owner, team or domain. The defaults are deliberately inert:
// an unset ACCESS_AUD never matches any real Access assertion (fail closed, not fail open), and no OWNERS means
// nobody is an owner until you configure one.
export let TEAM = '';
export let AUD = '';
// The owner is code, not data: nothing written through the site can lock them out.
export let OWNERS = [];
export let OWNER_NAME = 'Owner';
// Read once into an empty database, then turned into groups by migrate3 like any older reader. `wid` is the member
// workspace id the register's visibility names. Empty by default — your own seed readers, if any, come from
// SEED_READERS_JSON.
export let SEED_READERS = [];

/** Set this deployment's identity from the Pages project's env vars. Called once per request (functions/[[path]].js)
 * — cheap, and it keeps every value in one place instead of trusting a cold start to have run first. */
export function configure(env) {
  if (env.ACCESS_TEAM) TEAM = env.ACCESS_TEAM;
  if (env.ACCESS_AUD) AUD = env.ACCESS_AUD;
  if (env.OWNER_EMAILS) OWNERS = env.OWNER_EMAILS.split(',').map((s) => s.trim()).filter(Boolean);
  if (env.OWNER_NAME) OWNER_NAME = env.OWNER_NAME;
  if (env.SEED_READERS_JSON) {
    try { SEED_READERS = JSON.parse(env.SEED_READERS_JSON); } catch { /* left as whatever it already was */ }
  }
}

const DOC = '\\d{3}-\\d{4}';
const REV = '[A-HJ-NP-Z]{1,3}';
const TOK = '[A-Za-z0-9_-]{16,64}';
const HEX = '[0-9a-f]{8}';
// the name segment a URL may end in (rule: A DOCUMENT'S NAME); decoration, never read
const NAMED = '(?:/[^/]+\\.pdf)?';
const R = {
  pub: new RegExp(`^/p/(${TOK})/(${DOC})-(${REV})\\.pdf$`),
  tok: new RegExp(`^/([ps])/(${TOK})/?$`),
  tokDoc: new RegExp(`^/([ps])/(${TOK})/(${DOC})${NAMED}$`),
  pkg: new RegExp(`^/(k)/(${TOK})/?$`),
  pkgFile: new RegExp(`^/(k)/(${TOK})/(${DOC})\\.pdf$`),
  signed: new RegExp(`^/l/(${TOK})/?$`),
  doc: new RegExp(`^/d/(${DOC})(?:-(${REV}))?$`),
  file: new RegExp(`^/files/(${DOC})-(${REV})(?:\\.pdf|/[^/]+\\.pdf)$`),
  font: /^\/fonts\/[A-Za-z0-9-]+\.(?:otf|woff2?)$/,
  // the editor's own code: pdf.js, CodeMirror and the like, one level deep, no dot-dot
  vendor: /^\/vendor\/[A-Za-z0-9][A-Za-z0-9._-]*\.(js|mjs|css)$/,
  star: new RegExp(`^/api/documents/(${DOC})/star$`),
  desc: new RegExp(`^/api/documents/(${DOC})/description$`),
  links: /^\/api\/links$/,
  link: new RegExp(`^/api/links/(${HEX})$`),
  pkgs: /^\/api\/packages$/,
  pkgOne: new RegExp(`^/api/packages/(${HEX})$`),
  pkgDocs: new RegExp(`^/api/packages/(${HEX})/documents$`),
  folders: new RegExp(`^/api/packages/(${HEX})/folders$`),
  folder: new RegExp(`^/api/packages/(${HEX})/folders/(${HEX})$`),
  groups: /^\/api\/groups$/,
  group: new RegExp(`^/api/groups/(${HEX})$`),
  source: new RegExp(`^/api/documents/(${DOC})/revisions/(${REV})/source$`),
  fbDoc: new RegExp(`^/api/documents/(${DOC})/feedback$`),
  fbAll: /^\/api\/feedback$/,
  fbOne: new RegExp(`^/api/feedback/(${HEX})$`),
  fbAny: /^\/api\/feedback(?:\/|$)/,
  requests: /^\/api\/requests$/,
  fbReqs: /^\/api\/feedback\/requests$/,
  fbReq: new RegExp(`^/api/feedback/requests/(${HEX})$`),
  // EDITOR: the owner's draft routes, and the box's
  drafts: new RegExp(`^/api/documents/(${DOC})/drafts$`),
  draft: new RegExp(`^/api/drafts/(${HEX})(?:/(pdf|synctex|package|send|discard|comments)(?:/(${HEX}))?)?$`),
  draftAny: /^\/api\/drafts(?:\/|$)/,
  newDraft: /^\/api\/drafts$/,
  edJobs: /^\/api\/editor\/jobs$/,
  edJob: new RegExp(`^/api/editor/jobs/(${HEX})$`),
  edOutbox: /^\/api\/editor\/outbox$/,
  edEdit: new RegExp(`^/api/editor/edits/(${HEX})$`),
  edPdf: new RegExp(`^/api/editor/edits/(${HEX})/pdf$`),
  edQuestion: new RegExp(`^/api/editor/questions/(${HEX})$`),
  edAny: /^\/api\/editor(?:\/|$)/,
  // LIBRARY CHAT: the asker's routes (the box's is edQuestion above)
  qDoc: new RegExp(`^/api/documents/(${DOC})/questions$`),
  qOne: new RegExp(`^/api/questions/(${HEX})$`),
  qEdit: new RegExp(`^/api/questions/(${HEX})/edit$`),
  // NOTES: the viewer's notes and the owner's round; the box's carry
  notes: new RegExp(`^/api/documents/(${DOC})/notes$`),
  making: new RegExp(`^/api/documents/(${DOC})/making$`),
  note: new RegExp(`^/api/notes/(${HEX})(?:/(reply|delete))?$`),
  edCarry: /^\/api\/editor\/carry$/,
  edCarryOne: new RegExp(`^/api/editor/carry/(${DOC})/(${REV})$`),
};
const EMAIL = /^[^@\s<>]+@[^@\s<>]+\.[^@\s<>]+$/;
const STATIC = { '/': '/', '/index.html': '/', '/app.js': '/app.js', '/style.css': '/style.css', '/editor.js': '/editor.js',
  '/editor.css': '/editor.css', '/notes.js': '/notes.js', '/notes-api.js': '/notes-api.js' };
// what a script or style sheet is served as, whatever the asset store says: pdf.js loads its .mjs module and worker
const CODE_TYPES = { js: 'text/javascript; charset=utf-8', mjs: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8' };
const CSP = "default-src 'self'; style-src 'self'; script-src 'self'; frame-src 'self'; object-src 'self'; " +
  "img-src 'self' data:; frame-ancestors 'self'; base-uri 'none'; form-action 'none'";
const PKG_CSP = "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";
const BASE_HEADERS = {
  'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer', 'X-Robots-Tag': 'noindex, nofollow',
};
const KINDS = ['public', 'private', 'signed-in'];
const STATES = ['live', 'disabled', 'archived'];
const DESC_MODES = ['doc', 'custom', 'none'];
// a link row that answers: live, and if it is a package's, the package is there and not archived. `l` is links.
const LIVE = "(l.state IS NULL OR l.state = 'live') AND (l.package IS NULL OR l.package IN " +
  '(SELECT id FROM packages WHERE archived IS NULL))';
const LIVE_PRIVATE = `l.kind = 'private' AND ${LIVE}`;

class Denied extends Error {
  constructor(msg, status = 403) { super(msg); this.status = status; }
}

function send(status, body, type = 'text/plain; charset=utf-8', extra = {}, head = false) {
  return new Response(head ? null : body, { status, headers: { 'Content-Type': type, ...BASE_HEADERS, ...extra } });
}
const notFound = (head) => send(404, 'not found\n', undefined, {}, head);
const json = (obj, status = 200) => send(status, JSON.stringify(obj), 'application/json');
const bad = (msg) => send(400, msg + '\n');

// ── the Access JWT ────────────────────────────────────────────────────────────────────────────────────────────

function b64url(s) {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}
const utf8 = new TextDecoder();

let certCache = { at: 0, keys: null };
async function signingKeys(env, fresh) {
  // test keys count only where wrangler says the run is local (and in selfcheck, which says the same)
  if (env.ACCESS_JWKS && env.CF_PAGES_BRANCH === 'local') return JSON.parse(env.ACCESS_JWKS).keys;
  if (!fresh && certCache.keys && Date.now() - certCache.at < 600e3) return certCache.keys;
  const res = await fetch(`https://${TEAM}.cloudflareaccess.com/cdn-cgi/access/certs`);
  if (!res.ok) throw new Denied('cannot read the Access signing keys', 503);
  certCache = { at: Date.now(), keys: (await res.json()).keys || [] };
  return certCache.keys;
}

function assertion(request) {
  const h = request.headers.get('Cf-Access-Jwt-Assertion');
  if (h) return h.trim();
  const m = (request.headers.get('Cookie') || '').match(/(?:^|;\s*)CF_Authorization=([^;]+)/);
  return m ? m[1].trim() : '';
}

/** The verified email on this request's Access JWT, lower-cased, or throw Denied. */
export async function verifiedEmail(request, env, now = Date.now() / 1000) {
  const claims = await verifiedClaims(request, env, now);
  if (typeof claims.email !== 'string' || !claims.email.includes('@')) throw new Denied('an Access assertion with no email');
  return claims.email.trim().toLowerCase();
}

/** The claims of this request's Access JWT once its signature, audience, team and dates check, or throw Denied. A
 *  person's JWT carries email; a service token's carries common_name, its client id, and no email. */
async function verifiedClaims(request, env, now) {
  const jwt = assertion(request);
  const parts = jwt.split('.');
  if (parts.length !== 3) throw new Denied('no Cloudflare Access assertion on this request');
  let header, claims;
  try {
    header = JSON.parse(utf8.decode(b64url(parts[0])));
    claims = JSON.parse(utf8.decode(b64url(parts[1])));
  } catch (e) {
    throw new Denied('an unreadable Access assertion');
  }
  if (header.alg !== 'RS256') throw new Denied('an Access assertion not signed RS256');
  let jwk = (await signingKeys(env, false)).find((k) => k.kid === header.kid);
  if (!jwk) jwk = (await signingKeys(env, true)).find((k) => k.kid === header.kid);
  if (!jwk) throw new Denied('an Access assertion signed by an unknown key');
  const key = await crypto.subtle.importKey('jwk', { kty: 'RSA', n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const good = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64url(parts[2]),
    new TextEncoder().encode(parts[0] + '.' + parts[1]));
  if (!good) throw new Denied('an Access assertion whose signature does not verify');
  const aud = [].concat(claims.aud || []);
  if (!aud.includes(AUD)) throw new Denied('an Access assertion for another application');
  if (claims.iss !== `https://${TEAM}.cloudflareaccess.com`) throw new Denied('an Access assertion from another team');
  if (typeof claims.exp !== 'number' || claims.exp < now) throw new Denied('an expired Access assertion');
  if (typeof claims.nbf === 'number' && claims.nbf > now + 60) throw new Denied('an Access assertion not yet valid');
  return claims;
}

/** GET /api/courses/readers, for the owner or a service token READER_EXPORT_TOKENS names: {course code: [emails]},
 *  the members of every group whose project or group grants cover that course. */
async function courseReaders(request, env, reg) {
  const claims = await verifiedClaims(request, env, Date.now() / 1000);
  const email = typeof claims.email === 'string' ? claims.email.trim().toLowerCase() : '';
  const allowed = String(env.READER_EXPORT_TOKENS || '').split(/[\s,]+/).filter(Boolean);
  const service = !email && typeof claims.common_name === 'string' && allowed.includes(claims.common_name);
  if (!OWNERS.includes(email) && !service) throw new Denied('only the owner or a named service token reads the reader list');
  const grants = await rows(env, 'SELECT grp, node FROM grants');
  const members = await rows(env, 'SELECT grp, email FROM group_members ORDER BY email');
  const covered = {};
  for (const g of new Set(grants.map((x) => x.grp))) {
    covered[g] = coveredProjects(reg, grants.filter((x) => x.grp === g).map((x) => x.node));
  }
  const out = {};
  for (const [p, v] of Object.entries(reg.projects)) {
    if (!/^1\d\d$/.test(p) || p === '100' || typeof v.name !== 'string' || !v.name.trim()) continue;
    out[v.name.trim().toLowerCase()] = [...new Set(members.filter((m) => covered[m.grp] && covered[m.grp].has(p))
      .map((m) => m.email))];
  }
  return out;
}

// ── storage ───────────────────────────────────────────────────────────────────────────────────────────────────

const SCHEMA = [
  'CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)',
  // the directory of people the library knows by name; projects is read only by migrate3
  "CREATE TABLE IF NOT EXISTS readers (email TEXT PRIMARY KEY, name TEXT NOT NULL, projects TEXT NOT NULL DEFAULT '')",
  // read only by migrate3 (and moved by rekey): the per-document grants before groups
  'CREATE TABLE IF NOT EXISTS visibility (number TEXT, email TEXT, visible INTEGER, PRIMARY KEY (number, email))',
  'CREATE TABLE IF NOT EXISTS stars (viewer TEXT, number TEXT, PRIMARY KEY (viewer, number))',
  // target: number + rev (rev NULL follows the newest) or package; kind NULL = public, state NULL = live
  'CREATE TABLE IF NOT EXISTS links (token TEXT PRIMARY KEY, id TEXT UNIQUE, number TEXT, rev TEXT, name TEXT, created TEXT, ' +
    'package TEXT, kind TEXT, state TEXT, updated TEXT, locked INTEGER)',
  'CREATE TABLE IF NOT EXISTS link_people (link TEXT, email TEXT, PRIMARY KEY (link, email))',
  'CREATE TABLE IF NOT EXISTS link_groups (link TEXT, grp TEXT, PRIMARY KEY (link, grp))',
  "CREATE TABLE IF NOT EXISTS history (kind TEXT, id TEXT, at TEXT, what TEXT)",
  // token: a package's address before schema 2, never read; settings JSON (NULL the defaults); archived NULL = live
  'CREATE TABLE IF NOT EXISTS packages (id TEXT PRIMARY KEY, token TEXT UNIQUE, name TEXT, created TEXT, settings TEXT, archived TEXT, ' +
    'locked INTEGER)',
  // rev NULL: the newest; folder NULL: the top; desc_mode NULL = doc
  'CREATE TABLE IF NOT EXISTS package_docs (package TEXT, number TEXT, rev TEXT, folder TEXT, desc_mode TEXT, description TEXT, ' +
    'PRIMARY KEY (package, number))',
  'CREATE TABLE IF NOT EXISTS package_folders (id TEXT PRIMARY KEY, package TEXT, parent TEXT, name TEXT)',
  'CREATE TABLE IF NOT EXISTS package_readers (package TEXT, email TEXT, PRIMARY KEY (package, email))',
  'CREATE TABLE IF NOT EXISTS doc_meta (number TEXT PRIMARY KEY, description TEXT)',
  'CREATE TABLE IF NOT EXISTS groups (id TEXT PRIMARY KEY, name TEXT, created TEXT, locked INTEGER)',
  'CREATE TABLE IF NOT EXISTS group_members (grp TEXT, email TEXT, PRIMARY KEY (grp, email))',
  'CREATE TABLE IF NOT EXISTS grants (grp TEXT, node TEXT, PRIMARY KEY (grp, node))',
  'CREATE TABLE IF NOT EXISTS access_managed (email TEXT PRIMARY KEY)',
  // the owner's feedback on a revision (FEEDBACK above); section NULL = the whole document; status new|delivered|done
  // anchor: JSON {in: 'pdf', page, rect, quote?, box?} or NULL; extra the revision a round is making when it came (NOTES)
  'CREATE TABLE IF NOT EXISTS feedback (id TEXT PRIMARY KEY, number TEXT, rev TEXT, section TEXT, kind TEXT, text TEXT, ' +
    'created TEXT, status TEXT, reply TEXT, answered_rev TEXT, anchor TEXT, extra TEXT)',
  // REQUESTS: the owner's asks for a new section (a project) or folder (a sub-project of parent); status as feedback's
  'CREATE TABLE IF NOT EXISTS requests (id TEXT PRIMARY KEY, kind TEXT, parent TEXT, name TEXT, note TEXT, created TEXT, ' +
    'status TEXT, reply TEXT)',
  // EDITOR: a draft; state draft|sent|received|answered|discarded; outline and changes as computed on the last save
  // (JSON); seq the newest compile asked for, cstatus idle|queued|running|ok|error, claimed when the box took it,
  // done_seq the newest result recorded; pdf_* the last good PDF; package and items frozen at send
  'CREATE TABLE IF NOT EXISTS drafts (id TEXT PRIMARY KEY, number TEXT, base_rev TEXT, state TEXT, created TEXT, updated TEXT, ' +
    'touched TEXT, main TEXT, markings TEXT, default_marking TEXT, outline TEXT, changes TEXT, seq INTEGER, cstatus TEXT, ' +
    'claimed TEXT, done_seq INTEGER, cat TEXT, cok INTEGER, errors TEXT, log_tail TEXT, pdf_seq INTEGER, pdf_pages INTEGER, ' +
    'pdf_bytes INTEGER, pdf_at TEXT, sent TEXT, package TEXT, items TEXT, answered_rev TEXT, next_ref INTEGER, ui TEXT, new_doc TEXT, ' +
    'answered_number TEXT)',
  // one open draft per document, even with two requests at once
  "CREATE UNIQUE INDEX IF NOT EXISTS drafts_open ON drafts (number) WHERE state = 'draft'",
  // base NULL: a file the owner added
  'CREATE TABLE IF NOT EXISTS draft_files (draft TEXT, path TEXT, base TEXT, text TEXT, PRIMARY KEY (draft, path))',
  'CREATE TABLE IF NOT EXISTS draft_comments (id TEXT PRIMARY KEY, draft TEXT, ref TEXT, anchor TEXT, text TEXT, created TEXT)',
  // kind pdf|map, n the chunk; only the last good compile's
  'CREATE TABLE IF NOT EXISTS draft_blobs (draft TEXT, kind TEXT, n INTEGER, data BLOB, PRIMARY KEY (draft, kind, n))',
  // LIBRARY CHAT: a question. asker the email; anchor, pages JSON; route quick|session; model quick|strong|session as
  // asked, sonnet|opus once answered; claimed when the box took it; handed the hand-on's reason, handed_at its time;
  // posted when the box put it in the session's thread; edit the feedback id Make this an edit filed; updated moves
  // with every change (the long poll watches it); cost USD, the box's
  'CREATE TABLE IF NOT EXISTS questions (id TEXT PRIMARY KEY, number TEXT, rev TEXT, asker TEXT, anchor TEXT, text TEXT, ' +
    'thread TEXT, route TEXT, model TEXT, again TEXT, status TEXT, answer TEXT, pages TEXT, why TEXT, handed TEXT, handed_at TEXT, ' +
    'session_answer TEXT, edit TEXT, cost REAL, error TEXT, created TEXT, claimed TEXT, answered TEXT, posted TEXT, updated TEXT)',
  'CREATE INDEX IF NOT EXISTS questions_asker ON questions (asker, created)',
  // NOTES: one viewer's note on one revision. viewer the email; n its place among that viewer's on that revision;
  // kind comment|ask; route quick|session (an ask's); the anchor p, block (JSON), quote, rect (JSON [x, y, w, h]),
  // box_text, general; card_pos, card_size JSON; qid and thread an ask's first question, fid a comment's feedback
  // item and adds its additions' (JSON); carried_of the note it was carried from; deleted when its viewer deleted it
  'CREATE TABLE IF NOT EXISTS notes (id TEXT PRIMARY KEY, viewer TEXT, number TEXT, rev TEXT, n INTEGER, kind TEXT, route TEXT, ' +
    'p INTEGER, block TEXT, quote TEXT, rect TEXT, box_text TEXT, general INTEGER, text TEXT, created TEXT, unread INTEGER, ' +
    'extra TEXT, answered_by TEXT, passage_changed INTEGER, carried_from TEXT, carried_of TEXT, card_pos TEXT, card_size TEXT, ' +
    'qid TEXT, thread TEXT, fid TEXT, adds TEXT, deleted TEXT)',
  'CREATE INDEX IF NOT EXISTS notes_viewer ON notes (viewer, number, rev)',
  // a note is carried once: a second carry, or two at once, adds nothing
  'CREATE UNIQUE INDEX IF NOT EXISTS notes_carried ON notes (carried_of) WHERE carried_of IS NOT NULL',
  // NOTES: the next revision in the background, one round per document; phase working|ready; carried when the
  // box's carry landed, carried_n how many notes it copied
  'CREATE TABLE IF NOT EXISTS making (number TEXT PRIMARY KEY, from_rev TEXT, to_rev TEXT, phase TEXT, sent_at TEXT, ' +
    'carried TEXT, carried_n INTEGER)',
];
// what a database made by an older SCHEMA lacks; "duplicate column" means it has it already
const MIGRATE_2 = [
  'ALTER TABLE package_docs ADD COLUMN rev TEXT',
  'ALTER TABLE packages ADD COLUMN settings TEXT',
  'ALTER TABLE links ADD COLUMN package TEXT',
];
// schema 4: the editor's UI state, a new document's draft, and the number a new document was filed under
const MIGRATE_4 = [
  'ALTER TABLE drafts ADD COLUMN ui TEXT',
  'ALTER TABLE drafts ADD COLUMN new_doc TEXT',
  'ALTER TABLE drafts ADD COLUMN answered_number TEXT',
];
// schema 5: LOCKS (NULL or 0 = unlocked)
const MIGRATE_5 = [
  'ALTER TABLE packages ADD COLUMN locked INTEGER',
  'ALTER TABLE links ADD COLUMN locked INTEGER',
  'ALTER TABLE groups ADD COLUMN locked INTEGER',
];
// schema 6: LIBRARY CHAT's anchored comments
const MIGRATE_6 = ['ALTER TABLE feedback ADD COLUMN anchor TEXT'];
// schema 7: NOTES, a comment's extra (the notes and making tables are SCHEMA's own, made on an older database too)
const MIGRATE_7 = ['ALTER TABLE feedback ADD COLUMN extra TEXT'];
const MIGRATE_3 = [
  'ALTER TABLE links ADD COLUMN kind TEXT',
  'ALTER TABLE links ADD COLUMN state TEXT',
  'ALTER TABLE links ADD COLUMN updated TEXT',
  'ALTER TABLE packages ADD COLUMN archived TEXT',
  'ALTER TABLE package_docs ADD COLUMN folder TEXT',
  'ALTER TABLE package_docs ADD COLUMN desc_mode TEXT',
  'ALTER TABLE package_docs ADD COLUMN description TEXT',
];

function randomHex(bytes) {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, '0')).join('');
}
function randomToken() {
  const b = crypto.getRandomValues(new Uint8Array(24));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
/** Eight hex characters fixed by `text`, so a migration run twice makes the same row, not a second one. */
async function stableHex(text) {
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
  return Array.from(h.slice(0, 4), (b) => b.toString(16).padStart(2, '0')).join('');
}
function today() { return new Date().toISOString().slice(0, 10); }
const now = () => new Date().toISOString();
async function rows(env, sql, ...a) { return (await env.DB.prepare(sql).bind(...a).all()).results; }

async function alter(db, list) {
  for (const sql of list) {
    try { await db.prepare(sql).run(); } catch (e) { if (!/duplicate column/i.test(String(e && e.message))) throw e; }
  }
}

let ready = null;
async function ensure(env, reg) {
  if (ready === env.DB) return;
  await env.DB.batch(SCHEMA.map((s) => env.DB.prepare(s)));
  const done = await env.DB.prepare("SELECT v FROM meta WHERE k = 'seeded'").first();
  if (!done) await seed(env.DB, reg);
  const schema = await env.DB.prepare("SELECT v FROM meta WHERE k = 'schema'").first();
  if (!schema || Number(schema.v) < 2) await migrate2(env.DB);
  if (!schema || Number(schema.v) < 3) await migrate3(env.DB, reg);
  if (!schema || Number(schema.v) < 4) {
    await alter(env.DB, MIGRATE_4);
    await env.DB.prepare("INSERT OR REPLACE INTO meta (k, v) VALUES ('schema', '4')").run();
  }
  if (!schema || Number(schema.v) < 5) {
    await alter(env.DB, MIGRATE_5);
    await env.DB.prepare("INSERT OR REPLACE INTO meta (k, v) VALUES ('schema', '5')").run();
  }
  if (!schema || Number(schema.v) < 6) {
    await alter(env.DB, MIGRATE_6);
    await env.DB.prepare("INSERT OR REPLACE INTO meta (k, v) VALUES ('schema', '6')").run();
  }
  if (!schema || Number(schema.v) < 7) {
    await alter(env.DB, MIGRATE_7);
    await env.DB.prepare("INSERT OR REPLACE INTO meta (k, v) VALUES ('schema', '7')").run();
  }
  ready = env.DB;
}

/** Schema 2 on a database made before it: the new columns, and each package's own token as a link named
 *  public-link-1, so an address already handed out keeps working. INSERT OR IGNORE on the token makes a second run,
 *  or two isolates at once, harmless. */
async function migrate2(db) {
  await alter(db, MIGRATE_2);
  const old = (await db.prepare('SELECT id, token, created FROM packages WHERE token IS NOT NULL AND token NOT IN ' +
    '(SELECT token FROM links)').all()).results;
  const st = old.map((p) => db.prepare("INSERT OR IGNORE INTO links (token, id, package, name, created) VALUES (?, ?, ?, 'public-link-1', ?)")
    .bind(p.token, randomHex(4), p.id, p.created || now()));
  st.push(db.prepare("INSERT OR REPLACE INTO meta (k, v) VALUES ('schema', '2')"));
  await db.batch(st);
}

/** Schema 3: groups replace per-person grants, and a package's readers become a private link, with nobody's reach
 *  changing. Each reader with projects or per-document grants becomes a group named after them, holding them; a
 *  project becomes a project grant unless a document of it was hidden from them or it has sub-projects (which a
 *  project grant would add), and then grants of each of its own documents they saw. Ids come from stableHex and
 *  every insert is OR IGNORE, so a second run (two isolates) adds nothing; the meta row goes in the same batch. */
async function migrate3(db, reg) {
  await alter(db, MIGRATE_3);
  const st = [];
  const q = (sql, ...a) => st.push(db.prepare(sql).bind(...a));
  const at = now();
  const readers = (await db.prepare('SELECT email, name, projects FROM readers ORDER BY email').all()).results;
  const vis = (await db.prepare('SELECT number, email, visible FROM visibility').all()).results;
  for (const r of readers) {
    const projects = String(r.projects || '').split(/\s+/).filter(Boolean);
    const over = vis.filter((x) => x.email === r.email);
    const shown = over.filter((x) => x.visible).map((x) => x.number);
    const hidden = new Set(over.filter((x) => !x.visible).map((x) => x.number));
    const nodes = new Set();
    for (const p of projects) {
      const own = Object.keys(reg.documents).filter((n) => reg.documents[n].project === p);
      if (own.some((n) => hidden.has(n)) || coveredProjects(reg, [`project:${p}`]).size > 1) {
        for (const n of own) if (!hidden.has(n)) nodes.add(`doc:${n}`);
      } else {
        nodes.add(`project:${p}`);
      }
    }
    for (const n of shown) nodes.add(`doc:${n}`);
    if (!nodes.size) continue;
    const gid = await stableHex('group:' + r.email);
    q('INSERT OR IGNORE INTO groups (id, name, created) VALUES (?, ?, ?)', gid, r.name || r.email, at);
    q('INSERT OR IGNORE INTO group_members (grp, email) VALUES (?, ?)', gid, r.email);
    for (const node of nodes) q('INSERT OR IGNORE INTO grants (grp, node) VALUES (?, ?)', gid, node);
  }
  const shares = (await db.prepare('SELECT package, email FROM package_readers ORDER BY package, email').all()).results;
  for (const pkg of new Set(shares.map((x) => x.package))) {
    const lid = await stableHex('package-readers:' + pkg);
    q("INSERT OR IGNORE INTO links (token, id, package, name, created, kind) VALUES (?, ?, ?, 'private-link-1', ?, 'private')",
      randomToken(), lid, pkg, at);
    for (const x of shares.filter((y) => y.package === pkg)) q('INSERT OR IGNORE INTO link_people (link, email) VALUES (?, ?)', lid, x.email);
  }
  q("INSERT OR REPLACE INTO meta (k, v) VALUES ('schema', '3')");
  await db.batch(st);
}

/** Fill an empty database once from the register and SEED_READERS: readers, the visibility the register records
 *  where it differs from a reader's projects, stars, and each public token (cc-docs `public`) or named link
 *  (cc-docs `link`) as a link. migrate3 then turns the readers into groups. The meta row goes in the same batch, and
 *  INSERT OR IGNORE makes a race harmless. */
export async function seed(db, reg) {
  const st = [];
  const q = (sql, ...a) => st.push(db.prepare(sql).bind(...a));
  const byWid = {};
  for (const r of SEED_READERS) {
    q('INSERT OR IGNORE INTO readers (email, name, projects) VALUES (?, ?, ?)', r.email, r.name, r.projects.join(' '));
    if (r.wid) byWid[r.wid] = r.email;
  }
  for (const [num, d] of Object.entries(reg.documents || {})) {
    for (const r of SEED_READERS) {
      if (!r.wid) continue;
      const recorded = (d.visibility || []).includes(r.wid);
      if (recorded !== r.projects.includes(d.project)) {
        q('INSERT OR IGNORE INTO visibility (number, email, visible) VALUES (?, ?, ?)', num, r.email, recorded ? 1 : 0);
      }
    }
    const starred = d.starred_by || (d.starred ? ['owner'] : []);
    for (const v of starred) {
      const who = v === 'owner' ? 'owner' : byWid[v];
      if (who) q('INSERT OR IGNORE INTO stars (viewer, number) VALUES (?, ?)', who, num);
    }
    for (const rv of d.revisions || []) {
      if (rv.public_token) {
        q('INSERT OR IGNORE INTO links (token, id, number, rev, name, created) VALUES (?, ?, ?, ?, ?, ?)',
          rv.public_token, randomHex(4), num, rv.rev, 'Public link', rv.date || today());
      }
      for (const l of rv.links || []) {
        if (l.token) {
          q('INSERT OR IGNORE INTO links (token, id, number, rev, name, created) VALUES (?, ?, ?, ?, ?, ?)',
            l.token, /^[0-9a-f]{8}$/.test(l.id || '') ? l.id : randomHex(4), num, rv.rev, l.name || 'Public link', today());
        }
      }
    }
  }
  q("INSERT OR IGNORE INTO meta (k, v) VALUES ('seeded', ?)", now());
  await db.batch(st);
}

// ── the register ──────────────────────────────────────────────────────────────────────────────────────────────

let regCache = { assets: null, reg: null };
async function register(env, origin) {
  // a deployment's assets never change, so one read per isolate and binding
  if (regCache.assets === env.ASSETS) return regCache.reg;
  const res = await env.ASSETS.fetch(new Request(origin + '/data/register.json'));
  if (!res.ok) throw new Denied('the register is not deployed', 503);
  const reg = await res.json();
  reg.documents = reg.documents || {};
  reg.projects = reg.projects || {};
  reg.linkedFrom = await linkedFrom(env, origin);
  reg.movedTo = movedTo(reg);
  regCache = { assets: env.ASSETS, reg };
  return reg;
}

/** {old number: new number} from each document's moved_from. An old number the register still files as a document
 *  of its own is left alone: moving its rows would take them from a document that is still there. */
function movedTo(reg) {
  const out = {};
  for (const [num, d] of Object.entries(reg.documents)) {
    for (const old of Array.isArray(d.moved_from) ? d.moved_from : []) {
      if (typeof old === 'string' && new RegExp(`^${DOC}$`).test(old) && old !== num && !reg.documents[old]) out[old] = num;
    }
  }
  return out;
}

/** brief: "a moved document must keep its place in them" (packages, links, stars and share grants), and
 *  descriptions and doc: grants with them.
 *  Move every D1 row keyed by an old number to its new one, once per register and database. UPDATE OR IGNORE keeps
 *  the row the new number already has where both exist, and the DELETE drops the old one left over. */
let rekeyed = { reg: null, db: null };
async function rekey(env, reg) {
  if (rekeyed.reg === reg && rekeyed.db === env.DB) return;
  const st = [];
  for (const [old, to] of Object.entries(reg.movedTo)) {
    for (const t of ['visibility', 'stars', 'links', 'package_docs', 'doc_meta']) {
      st.push(env.DB.prepare(`UPDATE OR IGNORE ${t} SET number = ? WHERE number = ?`).bind(to, old),
        env.DB.prepare(`DELETE FROM ${t} WHERE number = ?`).bind(old));
    }
    // feedback has its own id, so every row moves and none is dropped
    st.push(env.DB.prepare('UPDATE feedback SET number = ? WHERE number = ?').bind(to, old));
    st.push(env.DB.prepare('UPDATE questions SET number = ? WHERE number = ?').bind(to, old));
    st.push(env.DB.prepare('UPDATE notes SET number = ? WHERE number = ?').bind(to, old));
    st.push(env.DB.prepare('UPDATE OR IGNORE making SET number = ? WHERE number = ?').bind(to, old),
      env.DB.prepare('DELETE FROM making WHERE number = ?').bind(old));
    // drafts too; OR IGNORE: should both numbers hold an open draft, the old one keeps its number
    st.push(env.DB.prepare('UPDATE OR IGNORE drafts SET number = ? WHERE number = ?').bind(to, old));
    st.push(env.DB.prepare('UPDATE OR IGNORE grants SET node = ? WHERE node = ?').bind(`doc:${to}`, `doc:${old}`),
      env.DB.prepare('DELETE FROM grants WHERE node = ?').bind(`doc:${old}`));
  }
  if (st.length) await env.DB.batch(st);
  rekeyed = { reg, db: env.DB };
}

/** data/links.json as {PPP-NNNN: [{site, path}]}, keeping only well-formed entries; missing or unreadable is {}. */
async function linkedFrom(env, origin) {
  const res = await env.ASSETS.fetch(new Request(origin + '/data/links.json'));
  let raw = {};
  try { if (res.ok) raw = await res.json(); } catch (e) { raw = {}; }
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [num, pages] of Object.entries(raw)) {
    if (!new RegExp(`^${DOC}$`).test(num) || !Array.isArray(pages)) continue;
    const ok = pages.filter((x) => x && typeof x.site === 'string' && typeof x.path === 'string')
      .map((x) => ({ site: x.site.slice(0, 80), path: x.path.slice(0, 300) }));
    if (ok.length) out[num] = ok;
  }
  return out;
}

function revOf(reg, num, rev) {
  const d = reg.documents[num];
  const r = d && (d.revisions || []).find((x) => x.rev === rev);
  return r ? [d, r] : [null, null];
}
function newest(d) { return d && d.revisions && d.revisions.length ? d.revisions[d.revisions.length - 1] : null; }
/** What a document target points at now: its pinned revision, or with none its document's newest. Used for a
 *  link's row and a package's row alike. */
function target(reg, l) {
  if (!l || !l.number) return [null, null];
  if (l.rev) return revOf(reg, l.number, l.rev);
  const d = reg.documents[l.number];
  const r = newest(d);
  return r ? [d, r] : [null, null];
}

// brief: "one consistent naming rule for the display name and the downloaded PDF's filename"; a package leaves the
// number out by default, since he "leans away from showing the number in a package, because it reveals re-revisions"
const SIGNED_IN = { number: true, rev: true };
const TITLE_ONLY = { number: false, rev: false };
/** A document's name for a viewer shown `show` of its number: "PPP-NNNN-R Title", "PPP-NNNN Title", "Title (rev R)"
 *  or "Title"; a document with no title falls back on its full number. */
function docName(num, d, r, show) {
  const title = String(d.title || '').split(/\s+/).join(' ').trim();
  const lead = show.number ? (show.rev ? `${num}-${r.rev}` : num) : '';
  const name = [lead, title].filter(Boolean).join(' ') + (show.rev && !show.number ? ` (rev ${r.rev})` : '');
  return name.trim() || `${num}-${r.rev}`;
}
/** The URL segment that carries a name, so a browser's PDF tab shows it. */
const seg = (name) => encodeURIComponent(name) + '.pdf';
const fileUrl = (num, d, r) => `/files/${num}-${r.rev}/${seg(docName(num, d, r, SIGNED_IN))}`;

async function pdf(env, origin, r, shown, head) {
  const path = '/data/' + r.file.split('/').map(encodeURIComponent).join('/');
  const res = await env.ASSETS.fetch(new Request(origin + path));
  if (!res.ok) return notFound(head);
  const name = shown + '.pdf';
  // an ASCII-safe quoted filename, and filename* for a title that is not ASCII
  const safe = name.replace(/[^\x20-\x7e]|["\\/:*?<>|;%]/g, '_');
  return send(200, head ? null : res.body, 'application/pdf',
    { 'Content-Disposition': `inline; filename="${safe}"; filename*=UTF-8''${encodeURIComponent(name)}` }, head);
}

// ── the project tree and what a grant covers ──────────────────────────────────────────────────────────────────

/** A project's parent as the register writes it (a name or a PPP), or null. */
function parentOf(reg, p) {
  const v = reg.projects[p];
  const g = v && (v.parent ?? v.group);
  return typeof g === 'string' && g.trim() ? g.trim() : null;
}

/** {PPP: group name} for every project the register puts under a parent. */
function groupsOf(reg) {
  const out = {};
  for (const p of Object.keys(reg.projects)) {
    const g = parentOf(reg, p);
    if (!g) continue;
    out[p] = /^\d{3}$/.test(g) && reg.projects[g] ? reg.projects[g].name || g : g;
  }
  return out;
}

/** The projects a set of grant nodes covers: each project: node and each project under a group: node, with every
 *  sub-project beneath them, transitively. A sub-project names its parent by PPP or by the parent's name. */
function coveredProjects(reg, nodes) {
  const out = new Set();
  const groups = groupsOf(reg);
  for (const node of nodes) {
    let m;
    if ((m = /^project:(\d{3})$/.exec(node)) && reg.projects[m[1]]) out.add(m[1]);
    if ((m = /^group:(.+)$/.exec(node))) {
      for (const [p, g] of Object.entries(groups)) {
        if (g !== m[1]) continue;
        out.add(p);
        const raw = parentOf(reg, p);
        if (/^\d{3}$/.test(raw) && reg.projects[raw]) out.add(raw);
      }
    }
  }
  for (let grew = true; grew;) {
    grew = false;
    for (const p of Object.keys(reg.projects)) {
      if (out.has(p)) continue;
      const raw = parentOf(reg, p);
      if (raw && [...out].some((q) => q === raw || (reg.projects[q].name || '') === raw)) { out.add(p); grew = true; }
    }
  }
  return out;
}

/** The documents a set of grant nodes covers, the ones filed later under a granted project included. */
function grantedDocs(reg, nodes) {
  const projects = coveredProjects(reg, nodes);
  const docs = new Set(nodes.filter((n) => n.startsWith('doc:')).map((n) => n.slice(4)));
  return Object.keys(reg.documents).filter((n) => docs.has(n) || projects.has(reg.documents[n].project));
}

/** A node the owner may grant: a group name the register uses, a project, or a document. */
function validNode(reg, node) {
  if (typeof node !== 'string') return false;
  let m;
  if ((m = /^group:(.+)$/.exec(node))) return Object.values(groupsOf(reg)).includes(m[1]);
  if ((m = /^project:(\d{3})$/.exec(node))) return !!reg.projects[m[1]];
  if ((m = new RegExp(`^doc:(${DOC})$`).exec(node))) return !!reg.documents[m[1]];
  return false;
}

// ── viewers ───────────────────────────────────────────────────────────────────────────────────────────────────

async function personName(env, email) {
  const r = await env.DB.prepare('SELECT name FROM readers WHERE email = ?').bind(email).first();
  return (r && r.name) || email.split('@')[0];
}

/** owner, member (in a group), guest (named on a live private link), or Denied. */
async function viewerFor(email, env) {
  if (OWNERS.includes(email)) return { id: 'owner', email, name: OWNER_NAME, owner: true, role: 'owner' };
  const base = { id: email, email, name: await personName(env, email), owner: false };
  const g = await env.DB.prepare('SELECT count(*) AS c FROM group_members WHERE email = ?').bind(email).first();
  if (g && g.c) return { ...base, role: 'member' };
  const l = await env.DB.prepare(`SELECT count(*) AS c FROM link_people p JOIN links l ON l.id = p.link WHERE p.email = ? AND ${LIVE_PRIVATE}`)
    .bind(email).first();
  if (l && l.c) return { ...base, role: 'guest' };
  throw new Denied('not an account this library knows');
}

/** May this signed-in viewer use this private link: the owner, a person it names, or a member of a group it names. */
async function onLink(env, viewer, l) {
  if (viewer.owner) return true;
  const p = await env.DB.prepare('SELECT 1 AS y FROM link_people WHERE link = ? AND email = ?').bind(l.id, viewer.email).first();
  if (p) return true;
  return !!(await env.DB.prepare('SELECT 1 AS y FROM link_groups lg JOIN group_members m ON m.grp = lg.grp ' +
    'WHERE lg.link = ? AND m.email = ?').bind(l.id, viewer.email).first());
}

/** What a viewer reaches: docs {number: true (every revision) | Set of revisions}, and the live packages their
 *  private links reach, each with its rows and folders. The owner reaches every document. */
async function reach(env, reg, viewer) {
  const docs = new Map();
  const packages = [];
  if (viewer.owner) {
    for (const num of Object.keys(reg.documents)) docs.set(num, true);
    return { docs, packages };
  }
  const nodes = (await rows(env, 'SELECT DISTINCT g.node FROM grants g JOIN group_members m ON m.grp = g.grp WHERE m.email = ?',
    viewer.email)).map((x) => x.node);
  for (const num of grantedDocs(reg, nodes)) docs.set(num, true);
  const add = (num, rev) => {
    if (docs.get(num) === true) return;
    if (!docs.has(num)) docs.set(num, new Set());
    docs.get(num).add(rev);
  };
  const links = await rows(env, `SELECT l.id, l.number, l.rev, l.package FROM links l WHERE ${LIVE_PRIVATE} AND ` +
    '(l.id IN (SELECT link FROM link_people WHERE email = ?) OR l.id IN (SELECT lg.link FROM link_groups lg ' +
    'JOIN group_members m ON m.grp = lg.grp WHERE m.email = ?)) ORDER BY l.created', viewer.email, viewer.email);
  const seen = new Set();
  for (const l of links) {
    if (!l.package) {
      const r = target(reg, l)[1];
      if (r) add(l.number, r.rev);
      continue;
    }
    if (seen.has(l.package)) continue;
    seen.add(l.package);
    const p = await env.DB.prepare('SELECT id, name, settings FROM packages WHERE id = ?').bind(l.package).first();
    if (!p) continue;
    const prow = await packageRows(env, p.id);
    for (const x of prow.docs) { const r = target(reg, x)[1]; if (r) add(x.number, r.rev); }
    packages.push({ p, ...prow });
  }
  return { docs, packages };
}

/** The revisions of num this viewer may open, oldest first. */
async function openable(env, reg, viewer, num) {
  const d = reg.documents[num];
  if (!d || !d.revisions || !d.revisions.length) return [];
  const g = (await reach(env, reg, viewer)).docs.get(num);
  if (!g) return [];
  return g === true ? d.revisions : d.revisions.filter((r) => g.has(r.rev));
}

function tidySource(src) {
  if (!src) return null;
  return src.replace(/^\/home\/[^/]+\//, '~/');
}

// ── packages ──────────────────────────────────────────────────────────────────────────────────────────────────

// brief: "toggles for what a visitor sees per row (document number, date, revision …)"; by default the date alone
const PKG_SETTINGS = { number: false, rev: false, date: true, note: false, collapsed: false };
function settingsOf(p) {
  let s = {};
  try { s = JSON.parse(p.settings || '{}') || {}; } catch (e) { s = {}; }
  const out = { ...PKG_SETTINGS };
  for (const k of Object.keys(PKG_SETTINGS)) if (typeof s[k] === 'boolean') out[k] = s[k];
  return out;
}

async function packageRows(env, id) {
  return {
    docs: await rows(env, 'SELECT number, rev, folder, desc_mode, description FROM package_docs WHERE package = ? ORDER BY number', id),
    folders: await rows(env, 'SELECT id, parent, name FROM package_folders WHERE package = ? ORDER BY name, id', id),
  };
}

async function descriptions(env) {
  return new Map((await rows(env, 'SELECT number, description FROM doc_meta')).map((x) => [x.number, x.description]));
}
/** A package row's description as a visitor sees it: the document's, the package's own, or none. */
function entryDescription(x, descs) {
  const mode = x.desc_mode || 'doc';
  if (mode === 'none') return null;
  if (mode === 'custom') return x.description || null;
  return descs.get(x.number) || null;
}

const folderOut = (f) => ({ id: f.id, parent: f.parent || null, name: f.name });

/** A package as a non-owner sees it: no links, readers or history, each description resolved. */
function packageForViewer({ p, docs, folders }, reg, descs) {
  return { id: p.id, name: p.name, settings: settingsOf(p), folders: folders.map(folderOut),
    documents: docs.filter((x) => target(reg, x)[1]).map((x) => ({ number: x.number, rev: x.rev || null,
      folder: x.folder || null, description: entryDescription(x, descs) })) };
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** A package's visitor page (/p/, /s/, /k/), layout 4e: a title and "N documents in M folders", the unfiled
 *  documents under "Standalone" (only when there are folders), then each folder as a <details> heading at any depth,
 *  open or collapsed as the package's `collapsed` setting says. Per row the document's name by the package's settings
 *  (its number first, in mono), linked at the revision it pins, its description, and the date and note where the
 *  settings say so. Inline CSS, no script. */
function packagePage(pkg, reg, { docs, folders }, descs, base, legacy) {
  const show = settingsOf(pkg);
  const ids = new Set(folders.map((f) => f.id));
  const where = (id) => (id && ids.has(id) ? id : null);
  let shown = 0;
  const item = (x) => {
    const [d, r] = target(reg, x);
    if (!r) return '';
    shown++;
    const name = docName(x.number, d, r, show);
    const title = String(d.title || '').split(/\s+/).join(' ').trim();
    const lead = show.number && title && name.endsWith(' ' + title)
      ? name.slice(0, name.length - title.length).trim() : '';
    const text = lead ? `<span class="n">${esc(lead)}</span> ${esc(title)}` : esc(name);
    const href = legacy ? `${base}/${esc(x.number)}.pdf` : `${base}/${esc(x.number)}/${esc(seg(name))}`;
    const desc = entryDescription(x, descs);
    const line = desc ? `<span class="s">${esc(desc)}</span>` : '';
    const note = show.note && r.note ? ` <span class="t">${esc(r.note)}</span>` : '';
    const date = show.date ? `<span class="d">${esc(r.date)}</span>` : '';
    return `<li><span class="c"><a href="${href}">${text}</a>${note}${line}</span>${date}</li>`;
  };
  const drawn = new Set();
  const open = show.collapsed ? '' : ' open';
  const level = (parent, depth) => {
    const here = docs.filter((x) => where(x.folder) === parent).map(item).filter(Boolean).join('\n');
    const subs = folders.filter((f) => where(f.parent) === parent && f.id !== parent && !drawn.has(f.id)).map((f) => {
      drawn.add(f.id);
      return `<li class="f${depth ? ' in' : ''}"><details${open}><summary>${esc(f.name)}</summary><ul>\n${level(f.id, depth + 1)}\n</ul></details></li>`;
    }).join('\n');
    return [here ? `<ul class="docs">\n${here}\n</ul>` : '', subs ? `<ul class="fs">\n${subs}\n</ul>` : ''].filter(Boolean).join('\n');
  };
  const top = docs.filter((x) => where(x.folder) === null).map(item).filter(Boolean).join('\n');
  shown = 0;
  const hasFolders = folders.length > 0;
  const tree = level(null, 0);
  const meta = `${shown} ${shown === 1 ? 'document' : 'documents'}` +
    (hasFolders ? ` in ${folders.length} ${folders.length === 1 ? 'folder' : 'folders'}` : '');
  const standalone = hasFolders && top ? '<h2 class="sa">Standalone</h2>\n' : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>${esc(pkg.name)}</title><style>
body{font:17px/1.5 "Source Serif 4",Georgia,serif;max-width:700px;margin:0 auto;padding:56px 24px 80px;color:#1B1A16;background:#FBFAF6}
h1{font:400 34px/1.15 "Source Serif 4 Display","Source Serif 4",Georgia,serif;margin:0}
.m{margin:6px 0 28px;font-size:14px;color:#77716A}.e{color:#77716A;margin:0}
ul{list-style:none;padding:0;margin:0}
.sa,summary{display:flex;gap:10px;align-items:baseline;margin:0;padding:0 0 8px;border-bottom:1px solid #15140F;
font:400 21px/1.3 "Source Serif 4 Subhead","Source Serif 4",Georgia,serif}
.sa{color:#A09889}.sa::before,summary::before{content:"";width:16px;flex:none;font-size:16px;line-height:1;color:#77716A}
summary{cursor:pointer;list-style:none}summary::-webkit-details-marker{display:none}
summary::before{content:"\\25B8"}details[open]>summary::before{content:"\\25BE"}
.f{margin-top:36px}.f.in{margin-top:28px}.f ul,.sa+.docs{margin-left:28px}
.docs li{display:grid;grid-template-columns:minmax(0,1fr) max-content;gap:3px 16px;align-items:baseline;padding:13px 0;border-bottom:1px solid #E9E4D8}
.c{display:flex;flex-direction:column;gap:3px;min-width:0}
a{color:inherit;text-decoration:underline;text-decoration-color:#CAC3B7;text-underline-offset:3px}a:hover{text-decoration-color:currentColor}
.n{font:14px "IBM Plex Mono",ui-monospace,monospace;color:#4A4740;margin-right:4px}
.s{font-size:14px;line-height:1.45;color:#77716A}.t{font-size:14px;color:#77716A}
.d{font:13px "IBM Plex Mono",ui-monospace,monospace;color:#77716A;white-space:nowrap}
.foot{margin:32px 0 0;font-size:13px;color:#A09889}
@media (max-width:760px){body{padding:28px 18px 48px}.sa,summary{font-size:19px}.f{margin-top:28px}.f.in{margin-top:24px}
.f ul,.sa+.docs{margin-left:16px}.docs li{grid-template-columns:minmax(0,1fr)}.d{font-size:12px}}
@media (prefers-color-scheme:dark){body{background:#15140F;color:#F2EFE6}.sa,summary{border-color:#F2EFE6}
.docs li{border-color:#2C2A23}a{text-decoration-color:#4A463C}.n{color:#C3BCAE}.m,.e,.s,.t,.d,summary::before{color:#8B8477}.sa,.foot{color:#6A645A}}
</style></head><body><h1>${esc(pkg.name)}</h1>
<p class="m">${meta}</p>${shown ? '' : '<p class="e">This package is empty.</p>'}
${standalone}${tree}
<p class="foot">Shared from a private library. Each title opens its PDF.</p></body></html>`;
}

// ── links ─────────────────────────────────────────────────────────────────────────────────────────────────────

const kindOf = (l) => l.kind || 'public';
const stateOf = (l) => l.state || 'live';
const PREFIX = { public: 'p', private: 's', 'signed-in': 'l' };
const linkUrl = (origin, l) => `${origin}/${PREFIX[kindOf(l)]}/${l.token}`;
const targetOut = (l) => (l.package ? { package: l.package } : { number: l.number, rev: l.rev || null });
const targetText = (t) => (t.package ? `package ${t.package}` : `${t.number} ${t.rev ? 'rev ' + t.rev : '(newest)'}`);

/** A link row by token with whether it answers now (live, its package there and not archived), or null. */
async function linkByToken(env, token) {
  return env.DB.prepare(`SELECT l.id, l.token, l.number, l.rev, l.package, l.kind, l.state, (${LIVE}) AS live ` +
    'FROM links l WHERE l.token = ?').bind(token).first();
}

async function history(env, kind, id, what) {
  await env.DB.prepare('INSERT INTO history (kind, id, at, what) VALUES (?, ?, ?, ?)').bind(kind, id, now(), what).run();
}

/** A link's target from a body: {number, rev|null} for a document (rev one of its revisions) or {package} for a
 *  package there; null for anything else. */
async function checkTarget(env, reg, t) {
  if (!t || typeof t !== 'object' || Array.isArray(t)) return null;
  if (typeof t.package === 'string') {
    const p = await env.DB.prepare('SELECT id FROM packages WHERE id = ?').bind(t.package).first();
    return p ? { number: null, rev: null, package: p.id } : null;
  }
  const rev = t.rev === undefined ? null : t.rev;
  if (typeof t.number !== 'string' || !(rev === null || typeof rev === 'string') || !target(reg, { number: t.number, rev })[1]) return null;
  return { number: t.number, rev, package: null };
}

/** A list of emails from a body ("Name <email>" is read as the email), lower-cased, owners left out; null if any
 *  entry is not an email or there are over 100. */
function cleanPeople(v) {
  if (!Array.isArray(v) || v.length > 100) return null;
  const out = [];
  for (const x of v) {
    if (typeof x !== 'string') return null;
    const m = /<([^<>]+)>\s*$/.exec(x);
    const e = (m ? m[1] : x).trim().toLowerCase();
    if (!EMAIL.test(e)) return null;
    if (!OWNERS.includes(e) && !out.includes(e)) out.push(e);
  }
  return out;
}
async function cleanGroups(env, v) {
  if (!Array.isArray(v) || v.length > 100 || !v.every((x) => typeof x === 'string')) return null;
  const known = new Set((await rows(env, 'SELECT id FROM groups')).map((x) => x.id));
  return v.every((x) => known.has(x)) ? [...new Set(v)] : null;
}

/** A new link's name: the one asked for, or none ("" or absent) for public-link-N, private-link-N or link-N (a
 *  signed-in link), N one past the highest such N on that target's document (any revision) or package. null for a
 *  name that is not 1-80 printable characters. */
async function linkName(env, body, kind, t) {
  if (body.name !== undefined && body.name !== null && body.name !== '') return cleanName(body.name);
  const stem = { public: 'public-link', private: 'private-link', 'signed-in': 'link' }[kind];
  const col = t.package ? 'package' : 'number';
  const re = new RegExp(`^${stem}-(\\d+)$`);
  const used = (await rows(env, `SELECT name FROM links WHERE ${col} = ?`, t.package || t.number))
    .map((x) => re.exec(x.name || '')).filter(Boolean).map((x) => Number(x[1]));
  return `${stem}-${1 + Math.max(0, ...used)}`;
}

// ── Access sync ───────────────────────────────────────────────────────────────────────────────────────────────

/** Every email Access must admit: the owner, every group member, every person of a live private link. */
async function neededEmails(env) {
  const out = new Set(OWNERS);
  for (const x of await rows(env, 'SELECT email FROM group_members')) out.add(x.email);
  for (const x of await rows(env, `SELECT p.email FROM link_people p JOIN links l ON l.id = p.link WHERE ${LIVE_PRIVATE}`)) out.add(x.email);
  return [...out].sort();
}
const ACCESS_VARS = ['CF_API_TOKEN', 'CF_ACCOUNT_ID', 'CF_ACCESS_POLICY_ID'];
/** The names (never the values) of the Access variables the running deployment cannot see. */
const accessMissing = (env) => ACCESS_VARS.filter((k) => !(env && typeof env[k] === 'string' && env[k].trim()));
const accessVars = (env) => !accessMissing(env).length;
const ruleEmail = (r) => (r && r.email && typeof r.email.email === 'string' ? r.email.email.trim().toLowerCase() : null);

async function accessState(env) {
  const row = await env.DB.prepare("SELECT v FROM meta WHERE k = 'access'").first();
  try { return row ? JSON.parse(row.v) : null; } catch (e) { return null; }
}
async function saveAccess(env, st) {
  await env.DB.prepare("INSERT OR REPLACE INTO meta (k, v) VALUES ('access', ?)").bind(JSON.stringify(st)).run();
}

/** What the owner page says about Access without asking Cloudflare: sync true when the variables are set and the
 *  last sync succeeded; manual the needed emails (bar the owner) not confirmed in the policy by it. */
async function accessSummary(env) {
  const others = (await neededEmails(env)).filter((e) => !OWNERS.includes(e));
  const st = accessVars(env) ? await accessState(env) : null;
  if (!st || !st.ok) {
    const missing = accessMissing(env);
    return { sync: false, manual: others, ...(missing.length ? { missing } : {}), ...(st && st.error ? { error: st.error } : {}) };
  }
  const confirmed = new Set(st.confirmed || []);
  return { sync: true, manual: others.filter((e) => !confirmed.has(e)) };
}

/** brief: "sharing a private link with an email makes the Pages function add that email to the allow-library Access
 *  policy … when a person has no live private link left (and is not a reader or the owner), the function removes
 *  them". Read the policy, add the needed emails it lacks, remove the ones the site added that are no longer needed,
 *  write it back. Never throws: a failure is recorded and answered as sync false with the error. */
async function syncAccess(env) {
  const needed = await neededEmails(env);
  if (!accessVars(env)) return accessSummary(env);
  const a = encodeURIComponent(env.CF_ACCOUNT_ID), p = encodeURIComponent(env.CF_ACCESS_POLICY_ID);
  const url = env.CF_ACCESS_APP_ID
    ? `https://api.cloudflare.com/client/v4/accounts/${a}/access/apps/${encodeURIComponent(env.CF_ACCESS_APP_ID)}/policies/${p}`
    : `https://api.cloudflare.com/client/v4/accounts/${a}/access/policies/${p}`;
  const headers = { Authorization: `Bearer ${env.CF_API_TOKEN}`, 'Content-Type': 'application/json' };
  try {
    const got = await fetch(url, { headers });
    if (!got.ok) throw new Error(`reading the Access policy answered ${got.status}`);
    const pol = (await got.json()).result || {};
    const include = Array.isArray(pol.include) ? pol.include : [];
    const has = new Set(include.map(ruleEmail).filter(Boolean));
    const managed = (await rows(env, 'SELECT email FROM access_managed')).map((x) => x.email);
    const add = needed.filter((e) => !has.has(e));
    const drop = managed.filter((e) => !needed.includes(e));
    let next = include;
    if (add.length || drop.some((e) => has.has(e))) {
      next = include.filter((r) => !drop.includes(ruleEmail(r))).concat(add.map((e) => ({ email: { email: e } })));
      const { id, uid, created_at, updated_at, app_count, ...rest } = pol;   // eslint-disable-line no-unused-vars
      const put = await fetch(url, { method: 'PUT', headers, body: JSON.stringify({ ...rest, include: next }) });
      if (!put.ok) throw new Error(`writing the Access policy answered ${put.status}`);
    }
    const st = add.map((e) => env.DB.prepare('INSERT OR IGNORE INTO access_managed (email) VALUES (?)').bind(e))
      .concat(drop.map((e) => env.DB.prepare('DELETE FROM access_managed WHERE email = ?').bind(e)));
    if (st.length) await env.DB.batch(st);
    await saveAccess(env, { ok: true, confirmed: [...new Set(next.map(ruleEmail).filter(Boolean))], at: now() });
  } catch (e) {
    await saveAccess(env, { ok: false, error: String((e && e.message) || e).slice(0, 200), at: now() });
  }
  return accessSummary(env);
}

// ── the library, as each viewer may see it ────────────────────────────────────────────────────────────────────

async function library(env, reg, viewer, origin) {
  const starred = new Set((await rows(env, 'SELECT number FROM stars WHERE viewer = ?', viewer.id)).map((x) => x.number));
  const mine = await reach(env, reg, viewer);
  const descs = await descriptions(env);
  const groups = groupsOf(reg);
  const links = viewer.owner ? await rows(env, 'SELECT * FROM links ORDER BY created, name') : [];
  const livePublic = links.filter((l) => kindOf(l) === 'public' && stateOf(l) === 'live' && !l.package);
  const fb = viewer.owner ? await rows(env, FB_SELECT + ' ORDER BY created, id') : [];
  const docs = [];
  for (const num of Object.keys(reg.documents).sort()) {
    const d = reg.documents[num];
    const g = mine.docs.get(num);
    if (!g || !d.revisions || !d.revisions.length) continue;
    const revs = g === true ? d.revisions : d.revisions.filter((r) => g.has(r.rev));
    if (!revs.length) continue;
    const revisions = revs.map((r) => {
      // name: what the page shows and the file downloads as; file ends in it (rule: A DOCUMENT'S NAME)
      const out = { rev: r.rev, date: r.date, note: r.note || null, name: docName(num, d, r, SIGNED_IN), file: fileUrl(num, d, r),
        pages: r.pages || null, bytes: r.bytes || null, describes: r.describes || null, cost: r.cost || null };
      // a live public link reaches this revision: pinned to it, or following the newest when this is the newest
      if (viewer.owner) {
        out.public = livePublic.some((l) => l.number === num && (l.rev === r.rev || (!l.rev && r === newest(d))));
        // SOURCES: only the owner is told a revision kept one, and where to fetch it
        out.source = sourceOf(r) ? `/api/documents/${num}/revisions/${r.rev}/source` : null;
        // the nearest source cc-docs found, not the one the PDF was made from: said so, never passed off as exact
        if (out.source && r.source_nearest === true) out.source_nearest = true;
        out.sections = sectionsOf(r);
      }
      return out;
    });
    const one = { number: num, project: d.project, title: d.title, description: descs.get(num) || null,
      current: revs[revs.length - 1].rev, starred: starred.has(num), source: tidySource(d.source), revisions };
    if (viewer.owner) {
      one.linked_from = reg.linkedFrom[num] || [];
      one.feedback = fb.filter((x) => x.number === num).map(fbOut);
    }
    docs.push(one);
  }
  const seen = new Set(docs.map((d) => d.project));
  const projs = Object.keys(reg.projects).filter((p) => viewer.owner || seen.has(p)).sort();
  for (const p of seen) if (!projs.includes(p)) projs.push(p);
  const out = {
    viewer: { id: viewer.id, name: viewer.name, role: viewer.role },
    // brief item 22: a non-owner is told no other person's name
    people: { [viewer.id]: viewer.name },
    projects: projs.map((p) => {
      const raw = parentOf(reg, p);
      return { number: p, name: (reg.projects[p] || {}).name || p, group: groups[p] || null,
        parent: /^\d{3}$/.test(raw || '') && reg.projects[raw] ? raw : null };
    }),
    documents: docs,
  };
  if (!viewer.owner) {
    out.packages = mine.packages.map((x) => packageForViewer(x, reg, descs));
    return out;
  }
  // EDITOR, the New document dialog: who files for each project, and the number a new document there would take
  const held = await heldNumbers(env);
  for (const p of out.projects) {
    p.session = projectSession(reg, p.number);
    p.next = nextNumber(reg, p.number, held);
  }
  // the owner's view: every link, package, group and person, with history
  const hist = await rows(env, 'SELECT kind, id, at, what FROM history ORDER BY at, rowid');
  const histOf = (kind, id) => hist.filter((h) => h.kind === kind && h.id === id).map((h) => ({ at: h.at, what: h.what }));
  const lpeople = await rows(env, 'SELECT link, email FROM link_people ORDER BY email');
  const lgroups = await rows(env, 'SELECT link, grp FROM link_groups ORDER BY grp');
  out.links = links.map((l) => ({ id: l.id, name: l.name, kind: kindOf(l), state: stateOf(l), url: linkUrl(origin, l),
    target: targetOut(l), people: lpeople.filter((x) => x.link === l.id).map((x) => x.email),
    groups: lgroups.filter((x) => x.link === l.id).map((x) => x.grp), created: l.created, updated: l.updated || null,
    locked: !!l.locked, history: histOf('link', l.id) }));
  const pk = await rows(env, 'SELECT id, name, created, settings, archived, locked FROM packages ORDER BY created, name');
  const pdocs = await rows(env, 'SELECT package, number, rev, folder, desc_mode, description FROM package_docs ORDER BY number');
  const pfolders = await rows(env, 'SELECT id, package, parent, name FROM package_folders ORDER BY name, id');
  out.packages = pk.map((p) => ({ ...packageOut(p, pdocs.filter((x) => x.package === p.id), pfolders.filter((f) => f.package === p.id)),
    history: histOf('package', p.id) }));
  const dir = new Map((await rows(env, 'SELECT email, name FROM readers')).map((x) => [x.email, x.name]));
  const nameOf = (e) => dir.get(e) || e.split('@')[0];
  const members = await rows(env, 'SELECT grp, email FROM group_members ORDER BY email');
  const grants = await rows(env, 'SELECT grp, node FROM grants ORDER BY node');
  out.groups = (await rows(env, 'SELECT id, name, created, locked FROM groups ORDER BY name, id')).map((g) => ({ id: g.id, name: g.name,
    members: members.filter((m) => m.grp === g.id).map((m) => ({ email: m.email, name: nameOf(m.email) })),
    grants: grants.filter((x) => x.grp === g.id).map((x) => x.node), locked: !!g.locked, history: histOf('group', g.id) }));
  out.requests = (await rows(env, REQ_SELECT + ' ORDER BY created, id')).map(reqOut);
  const everyone = new Set([...dir.keys(), ...members.map((m) => m.email), ...lpeople.map((x) => x.email)]);
  out.directory = [...everyone].filter((e) => !OWNERS.includes(e)).sort().map((e) => ({ email: e, name: nameOf(e) }));
  out.people = { owner: OWNER_NAME };
  for (const x of out.directory) out.people[x.email] = x.name;
  out.access = await accessSummary(env);
  return out;
}

/** The owner's view of a package: settings, folders, its documents with pin, folder and description mode. */
function packageOut(p, docs, folders) {
  return { id: p.id, name: p.name, created: p.created, archived: p.archived || null, locked: !!p.locked, settings: settingsOf(p),
    folders: folders.map(folderOut),
    documents: docs.map((x) => ({ number: x.number, rev: x.rev || null, folder: x.folder || null,
      desc_mode: x.desc_mode || 'doc', description: x.description || null })) };
}

// ── sources and feedback ──────────────────────────────────────────────────────────────────────────────────────

/** A revision's kept source as the register names it (sources/PPP/<name>.tar.gz), or null for none or a path that
 *  leaves sources/. */
function sourceOf(r) {
  const s = r && r.sources;
  return typeof s === 'string' && /^sources\/\d{3}\/[A-Za-z0-9][A-Za-z0-9._-]*\.tar\.gz$/.test(s) && !s.includes('..') ? s : null;
}
/** A revision's kept source archive from the deployment's assets, or null. */
async function fetchSource(env, origin, rel) {
  const res = await env.ASSETS.fetch(new Request(origin + '/data/' + rel.split('/').map(encodeURIComponent).join('/')));
  return res.ok ? res : null;
}
/** The section headings a revision lists, if the register gives them (revisions[].sections, strings); else []. */
function sectionsOf(r) {
  const s = Array.isArray(r.sections) ? r.sections : [];
  return s.map(cleanDesc).filter((x) => typeof x === 'string' && x).slice(0, 200);
}
const FB_KINDS = ['text', 'request'];
const FB_STATUS = ['new', 'delivered', 'done'];
const FB_SELECT = 'SELECT id, number, rev, section, kind, text, created, status, reply, answered_rev, anchor, extra FROM feedback';
// `as`: how the item reads in the editor's terms (EDITOR): his own words are OG, a request is a comment
const fbOut = (x) => ({ id: x.id, number: x.number, rev: x.rev, section: x.section || null, kind: x.kind, text: x.text,
  created: x.created, status: x.status || 'new', reply: x.reply || null, answered_rev: x.answered_rev || null,
  anchor: parseJSON(x.anchor, null), extra: x.extra || null, as: x.kind === 'text' ? 'og' : 'comment' });
/** Feedback's own words: lines kept, other control characters dropped, 1-20000 characters; null for none. */
function cleanText(v) {
  if (typeof v !== 'string') return null;
  const s = v.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim();
  return s && s.length <= 20000 ? s : null;
}

/** Whether these verified claims are an Access service token that `list` (comma-separated client ids) names: no
 *  email, its common_name in the list, and a Cf-Access-Client-Id header, when Access passes one on, naming the same. */
function namedToken(request, claims, list) {
  const allowed = String(list || '').split(/[\s,]+/).filter(Boolean);
  const cn = typeof claims.common_name === 'string' ? claims.common_name : '';
  const header = request.headers.get('Cf-Access-Client-Id');
  return !claims.email && !!cn && allowed.includes(cn) && !(header && header.trim() !== cn);
}

/** The box's own routes (/api/feedback, /api/editor): the verified claims of an Access service token FEEDBACK_TOKENS
 *  names, or Denied. A person's JWT, the owner's included, is 403 here. */
async function boxOnly(request, env, what) {
  const claims = await verifiedClaims(request, env, Date.now() / 1000);
  if (!namedToken(request, claims, env.FEEDBACK_TOKENS)) throw new Denied(`only a service token FEEDBACK_TOKENS names ${what}`);
  return claims;
}

/** /api/feedback and /api/feedback/<id>: the box's poller, and only an Access service token FEEDBACK_TOKENS names. */
async function feedbackExport(request, env, path, url, head) {
  await boxOnly(request, env, 'reads or answers feedback');
  let m;
  if (R.fbReqs.test(path) || R.fbReq.test(path)) return requestExport(request, env, path, url, head);
  if (R.fbAll.test(path) && request.method !== 'POST') {
    const status = url.searchParams.get('status');
    if (status !== null && !FB_STATUS.includes(status)) return bad('status: new, delivered or done');
    const list = status === null ? await rows(env, FB_SELECT + ' ORDER BY created, id')
      : await rows(env, FB_SELECT + " WHERE coalesce(status, 'new') = ? ORDER BY created, id", status);
    return head ? send(200, null, 'application/json', {}, true) : json({ feedback: list.map(fbOut) });
  }
  if (!(m = path.match(R.fbOne)) || request.method !== 'POST') return notFound(head);
  const body = await readBody(request);
  const x = await env.DB.prepare(FB_SELECT + ' WHERE id = ?').bind(m[1]).first();
  if (!x) return notFound();
  const reply = body.reply === undefined || body.reply === null ? undefined : cleanText(body.reply);
  let answered = body.answered_rev === undefined || body.answered_rev === null ? undefined : body.answered_rev;
  if (!FB_STATUS.includes(body.status) || reply === null || (reply && reply.length > 2000) ||
      (answered !== undefined && !(typeof answered === 'string' && new RegExp(`^${REV}$`).test(answered)))) {
    return bad('status: new, delivered or done; reply: at most 2000 characters; answered_rev: a revision letter');
  }
  if (answered === undefined && body.status === 'done' && reply) {
    const a = reply.match(new RegExp(`\\banswered by rev (${REV})\\b`));
    if (a) answered = a[1];
  }
  // a status never moves back: a late "delivered" after cc-docs has marked it done leaves it done
  const cur = x.status || 'new';
  const status = FB_STATUS.indexOf(body.status) >= FB_STATUS.indexOf(cur) ? body.status : cur;
  const out = { ...fbOut(x), status, reply: reply === undefined ? x.reply || null : reply,
    answered_rev: status === 'done' && answered !== undefined ? answered : x.answered_rev || null };
  await env.DB.prepare('UPDATE feedback SET status = ?, reply = ?, answered_rev = ? WHERE id = ?')
    .bind(out.status, out.reply, out.answered_rev, m[1]).run();
  return json(out);
}

// ── section and folder requests (REQUESTS above) ──

const REQ_KINDS = ['section', 'folder'];
const REQ_SELECT = 'SELECT id, kind, parent, name, note, created, status, reply FROM requests';
const reqOut = (x) => ({ id: x.id, kind: x.kind, parent: x.parent || null, name: x.name, note: x.note || null,
  created: x.created, status: x.status || 'new', reply: x.reply || null });

/** POST /api/requests: the owner's ask, kept for the box's poller. It changes nothing in the register. */
async function newRequest(env, reg, body) {
  const name = cleanName(body.name);
  const parent = body.parent === undefined || body.parent === null || body.parent === '' ? null : body.parent;
  const note = body.note === undefined || body.note === null || body.note === '' ? '' : cleanText(body.note);
  // a folder sits in a project the register has; a section is a project of its own, so it names none
  const parentOk = body.kind === 'folder' ? typeof parent === 'string' && !!reg.projects[parent] : parent === null;
  if (!REQ_KINDS.includes(body.kind) || !name || !parentOk || note === null || note.length > 2000) {
    return bad('kind: section or folder; name: 1-80 printable characters; parent: the project a folder goes in ' +
      '(none for a section); note: at most 2000 characters');
  }
  // brief: "nothing on the site renumbers or moves anything itself": this row is all a request makes
  const item = { id: randomHex(4), kind: body.kind, parent, name, note: note || null, created: now(), status: 'new', reply: null };
  await env.DB.prepare('INSERT INTO requests (id, kind, parent, name, note, created, status) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(item.id, item.kind, item.parent, item.name, item.note, item.created, item.status).run();
  return json(item);
}

/** /api/feedback/requests[/<id>]: the box's poller reads and answers requests as it does feedback. */
async function requestExport(request, env, path, url, head) {
  let m;
  if (R.fbReqs.test(path) && request.method !== 'POST') {
    const status = url.searchParams.get('status');
    if (status !== null && !FB_STATUS.includes(status)) return bad('status: new, delivered or done');
    const list = status === null ? await rows(env, REQ_SELECT + ' ORDER BY created, id')
      : await rows(env, REQ_SELECT + " WHERE coalesce(status, 'new') = ? ORDER BY created, id", status);
    return head ? send(200, null, 'application/json', {}, true) : json({ requests: list.map(reqOut) });
  }
  if (!(m = path.match(R.fbReq)) || request.method !== 'POST') return notFound(head);
  const body = await readBody(request);
  const x = await env.DB.prepare(REQ_SELECT + ' WHERE id = ?').bind(m[1]).first();
  if (!x) return notFound();
  const reply = body.reply === undefined || body.reply === null ? undefined : cleanText(body.reply);
  if (!FB_STATUS.includes(body.status) || reply === null || (reply && reply.length > 2000)) {
    return bad('status: new, delivered or done; reply: at most 2000 characters');
  }
  // a status never moves back, as feedback's
  const cur = x.status || 'new';
  const status = FB_STATUS.indexOf(body.status) >= FB_STATUS.indexOf(cur) ? body.status : cur;
  const out = { ...reqOut(x), status, reply: reply === undefined ? x.reply || null : reply };
  await env.DB.prepare('UPDATE requests SET status = ?, reply = ? WHERE id = ?').bind(out.status, out.reply, m[1]).run();
  return json(out);
}

// ── locks (LOCKS above) ──

/** A body that sets `locked`: it sets nothing else, and the lock is recorded in the item's history. Any other body
 *  on a locked item is 409. -> the answer for a lock body, or null when the write goes on as before. */
async function lockWrite(env, table, kind, item, body) {
  // brief: "any change to a locked item, except unlocking it, is refused with 409 and a short message"
  if (!has(body, 'locked')) {
    if (item.locked) throw new Denied(`this ${kind} is locked; unlock it before changing it`, 409);
    return null;
  }
  if (typeof body.locked !== 'boolean' || Object.keys(body).length !== 1) return bad('locked: true or false, sent on its own');
  if (!!item.locked !== body.locked) {
    await env.DB.prepare(`UPDATE ${table} SET locked = ? WHERE id = ?`).bind(body.locked ? 1 : 0, item.id).run();
    await history(env, kind, item.id, body.locked ? 'locked' : 'unlocked');
  }
  return json({ id: item.id, locked: body.locked });
}

// ── the editor (EDITOR above) ─────────────────────────────────────────────────────────────────────────────────

const ED_ORDER = ['draft', 'sent', 'received', 'answered'];   // a state never moves back; discarded stands apart
const ED_CHUNK = 1_500_000;          // bytes per D1 value, under its 2 MB cap
const ED_REOFFER_S = 120;            // a compile running longer is handed out again
const ED_ACTIVE_S = 15 * 60;         // a draft opened or saved this recently keeps the box's poll held open
const ED_WAIT_MAX = 25;              // seconds a job poll is held at most
const ED_TEXT_MAX = 1 << 20;         // a text file larger than this stays on the box
const ED_FILES_MAX = 400;
const ED_SOURCE_MAX = 8 << 20;       // text kept in D1 per draft
const MARKINGS = ['og', 'adapt'];
const SCOPES = ['doc', 'template'];   // a marking's scope: this document only, or the shared template it came from
const ED_UI_MAX = 8192;              // bytes of the editor's UI state kept per draft
const parseJSON = (s, dflt) => { try { return s ? JSON.parse(s) : dflt; } catch (e) { return dflt; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ago = (s) => new Date(Date.now() - s * 1000).toISOString();
/** How often a held job poll looks in D1: once a second, or EDITOR_POLL_MS where the run is local (the tests). */
const pollMs = (env) => (env.CF_PAGES_BRANCH === 'local' && Number(env.EDITOR_POLL_MS) > 0 ? Number(env.EDITOR_POLL_MS) : 1000);

// ── the kept source: gunzip, tar, text files ──

export async function gunzip(bytes) {
  const s = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(s).arrayBuffer());
}
const latin = (b) => { let s = ''; for (const c of b) s += String.fromCharCode(c); return s; };
function cstr(b, off, len) {
  const sub = b.subarray(off, off + len);
  const z = sub.indexOf(0);
  return utf8.decode(z < 0 ? sub : sub.subarray(0, z));
}
function tarNum(b, off, len) {
  if (b[off] & 0x80) { let v = 0; for (let i = off + 1; i < off + len; i++) v = v * 256 + b[i]; return v; }   // base-256
  const s = latin(b.subarray(off, off + len)).replace(/\0[\s\S]*$/, '').trim();
  return s ? parseInt(s, 8) : 0;
}
/** A pax extended header's value for key, or null. */
function paxValue(data, key) {
  for (let i = 0; i < data.length;) {
    const sp = data.indexOf(0x20, i);
    if (sp < 0) break;
    const len = parseInt(latin(data.subarray(i, sp)), 10);
    if (!(len > 0) || i + len > data.length) break;
    const rec = utf8.decode(data.subarray(sp + 1, i + len - 1));
    const eq = rec.indexOf('=');
    if (eq > 0 && rec.slice(0, eq) === key) return rec.slice(eq + 1);
    i += len;
  }
  return null;
}
/** The regular files of a tar archive (ustar with its prefix field, GNU long names, pax path records) as
 *  [{path, data}]; links, directories and devices are skipped. Throws on a truncated archive. */
export function untar(buf) {
  const out = [];
  let longName = null, paxPath = null;
  for (let off = 0; off + 512 <= buf.length;) {
    const h = buf.subarray(off, off + 512);
    if (h.every((x) => x === 0)) break;
    const size = tarNum(h, 124, 12);
    const type = h[156] ? String.fromCharCode(h[156]) : '0';
    const start = off + 512;
    if (start + size > buf.length) throw new Error('a truncated tar archive');
    const data = buf.subarray(start, start + size);
    off = start + Math.ceil(size / 512) * 512;
    if (type === 'L') { longName = cstr(data, 0, data.length); continue; }
    if (type === 'x') { paxPath = paxValue(data, 'path') || paxPath; continue; }
    if (type === 'g' || type === 'K') continue;
    let name = cstr(h, 0, 100);
    if (cstr(h, 257, 6) === 'ustar') { const pre = cstr(h, 345, 155); if (pre) name = pre + '/' + name; }
    name = paxPath || longName || name;
    paxPath = longName = null;
    if (type === '0' || type === '7') out.push({ path: name, data });
  }
  return out;
}
/** A relative path inside the draft ("./" dropped), or null for one that is absolute, climbs or is odd. */
function safePath(p) {
  if (typeof p !== 'string') return null;
  const s = p.replace(/^(\.\/)+/, '');
  if (!s || s.length > 300 || s.startsWith('/') || /[\\\u0000-\u001f\u007f]/.test(s)) return null;
  return s.split('/').every((x) => x && x !== '.' && x !== '..') ? s : null;
}
const strictUtf8 = new TextDecoder('utf-8', { fatal: true });
/** A file's text: UTF-8, no NUL, at most ED_TEXT_MAX bytes; null for a binary (the box has those). */
function textOf(data) {
  if (data.length > ED_TEXT_MAX || data.includes(0)) return null;
  try { return strictUtf8.decode(data); } catch (e) { return null; }
}
/** The .tex that is compiled: one with \documentclass, main.tex first, then one named like the document's own
 *  source or number, then the shallowest. */
function pickMain(files, num, d) {
  const stem = (p) => p.split('/').pop().replace(/\.tex$/i, '');
  const src = d && typeof d.source === 'string' ? stem(d.source) : '';
  const cands = files.filter((f) => /\.tex$/i.test(f.path) && /^[ \t]*\\documentclass\b/m.test(f.text));
  const rank = (f) => [f.path === 'main.tex' ? 0 : stem(f.path) === 'main' ? 1 : (src && stem(f.path) === src) || stem(f.path).startsWith(num) ? 2 : 3,
    f.path.split('/').length, f.path.length];
  cands.sort((a, b) => { const x = rank(a), y = rank(b); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i]; return a.path < b.path ? -1 : 1; });
  return cands.length ? cands[0].path : null;
}
/** A revision's kept source as {files: [{path, text}], main}, or a string saying why there is none. The main is
 *  the one .source.json names when it is one of the files, else pickMain's guess. */
async function keptSource(env, origin, num, d, r) {
  const rel = sourceOf(r);
  const res = rel && await fetchSource(env, origin, rel);
  if (!res) return 'this revision kept no source';
  let entries;
  try { entries = untar(await gunzip(new Uint8Array(await res.arrayBuffer()))); } catch (e) { return 'the kept source cannot be read'; }
  const files = [];
  let total = 0;
  for (const e of entries) {
    const path = safePath(e.path);
    const text = path && textOf(e.data);
    if (text === null || text === undefined || files.some((f) => f.path === path)) continue;
    if (files.length >= ED_FILES_MAX || total + text.length > ED_SOURCE_MAX) break;
    total += text.length;
    files.push({ path, text });
  }
  // .source.json (cc-docs keeps it at the tarball's root) names the main the maker compiled; it is not a file he edits,
  // and the box still reads it from the tarball a job is built on
  const mf = files.findIndex((f) => f.path === '.source.json');
  let named = null;
  if (mf >= 0) {
    try { const m = JSON.parse(files[mf].text); named = m && typeof m.main === 'string' ? safePath(m.main) : null; } catch (e) { named = null; }
    files.splice(mf, 1);
  }
  const main = named && /\.tex$/i.test(named) && files.some((f) => f.path === named) ? named : pickMain(files, num, d);
  return main ? { files, main } : 'the kept source has no .tex with \\documentclass';
}

// ── outline, diff, markings ──

const HEADS = { part: 1, chapter: 1, section: 1, subsection: 2, subsubsection: 3 };
const HEAD_RE = /\\(part|chapter|section|subsection|subsubsection)\*?\s*(?:\[[^\]]*\]\s*)?\{/g;
const INCLUDE_RE = /\\(?:input|include)\s*\{([^{}]+)\}/g;
const BEGIN_RE = /\\begin\s*\{document\}/;
const uncomment = (line) => line.replace(/(^|[^\\])%.*$/, '$1');
/** The text inside the braces opening at s[i-1], to its balancing brace or the line's end. */
function braced(s, i) {
  let depth = 1, j = i;
  for (; j < s.length && depth; j++) { if (s[j] === '{' && s[j - 1] !== '\\') depth++; else if (s[j] === '}' && s[j - 1] !== '\\') depth--; }
  return s.slice(i, depth ? j : j - 1).split(/\s+/).join(' ').trim().slice(0, 200);
}
/** The outline from main, following \input and \include: [{id, path, level, title, from, to}] in reading order,
 *  and parents {path: {path, line}} (where each included file is pulled in). */
function outlineOf(files, main) {
  const byPath = new Map(files.map((f) => [f.path, f]));
  const dir = main.includes('/') ? main.slice(0, main.lastIndexOf('/') + 1) : '';
  const resolve = (name) => {
    for (const base of [dir, '']) {
      for (const p of [safePath(base + name.trim()), safePath(base + name.trim() + '.tex')]) if (p && byPath.has(p)) return p;
    }
    return null;
  };
  const outline = [], parents = {}, seen = new Set();
  const walk = (path) => {
    if (seen.has(path)) return;
    seen.add(path);
    const lines = byPath.get(path).text.split('\n');
    const mine = [];
    let begun = path !== main;
    lines.forEach((raw, i) => {
      const line = uncomment(raw), n = i + 1;
      if (!begun && BEGIN_RE.test(line)) {
        begun = true;
        outline.push({ path, level: 0, title: 'Preamble', from: 1, to: Math.max(1, n - 1) });
      }
      const hits = [];
      for (const m of line.matchAll(HEAD_RE)) hits.push({ at: m.index, head: m });
      for (const m of line.matchAll(INCLUDE_RE)) hits.push({ at: m.index, inc: m });
      hits.sort((a, b) => a.at - b.at);
      for (const h of hits) {
        if (h.head) {
          const e = { path, level: HEADS[h.head[1]], title: braced(line, h.head.index + h.head[0].length), from: n, to: lines.length };
          outline.push(e);
          mine.push(e);
        } else {
          const p = resolve(h.inc[1]);
          if (p && !seen.has(p)) { parents[p] = { path, line: n }; walk(p); }
        }
      }
    });
    mine.forEach((e, k) => {
      const next = mine.slice(k + 1).find((x) => x.level <= e.level);
      if (next) e.to = Math.max(e.from, next.from - 1);
    });
  };
  if (byPath.has(main)) walk(main);
  return { outline: outline.map((e, i) => ({ id: `s${i + 1}`, ...e })), parents };
}
/** The title of the deepest outline entry holding path:line; a file with none answers for the line including it. */
function sectionAt(an, path, line, depth = 0) {
  let best = null;
  for (const e of an.outline) {
    if (e.path === path && e.from <= line && line <= e.to && (!best || e.level > best.level || (e.level === best.level && e.from > best.from))) best = e;
  }
  if (best) return best.title;
  const p = an.parents[path];
  return p && depth < 20 ? sectionAt(an, p.path, p.line, depth + 1) : null;
}

/** A line diff of a against b (Myers, after the common head and tail): ops ['=', i, j] | ['-', i] | ['+', j]. Past
 *  4000 edits it gives up finding the middle's common lines and replaces it whole. */
export function diffLines(a, b) {
  let s = 0;
  while (s < a.length && s < b.length && a[s] === b[s]) s++;
  let ea = a.length, eb = b.length;
  while (ea > s && eb > s && a[ea - 1] === b[eb - 1]) { ea--; eb--; }
  const A = a.slice(s, ea), B = b.slice(s, eb), N = A.length, M = B.length;
  const mid = [];
  const off = N + M + 1, v = new Int32Array(2 * off + 2), trace = [];
  let found = N === 0 && M === 0;
  for (let d = 0; !found && d <= N + M && d <= 4000; d++) {
    trace.push(v.slice(off - d - 1, off + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1;
      let y = x - k;
      while (x < N && y < M && A[x] === B[y]) { x++; y++; }
      v[off + k] = x;
      if (x >= N && y >= M) { found = true; break; }
    }
  }
  if (!found) {
    for (let i = 0; i < N; i++) mid.push(['-', s + i]);
    for (let j = 0; j < M; j++) mid.push(['+', s + j]);
  } else if (N || M) {
    let x = N, y = M;
    for (let d = trace.length - 1; d >= 0; d--) {
      const t = trace[d], at = (k) => t[k + d + 1], k = x - y;
      const pk = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
      const px = at(pk), py = px - pk;
      while (x > px && y > py) { mid.push(['=', s + x - 1, s + y - 1]); x--; y--; }
      if (d > 0) mid.push(x === px ? ['+', s + py] : ['-', s + px]);
      x = px; y = py;
    }
    mid.reverse();
  }
  const ops = [];
  for (let i = 0; i < s; i++) ops.push(['=', i, i]);
  // within each run of edits, the deleted lines before the added ones, as a unified diff shows them
  for (let i = 0; i < mid.length;) {
    if (mid[i][0] === '=') { ops.push(mid[i++]); continue; }
    const run = [];
    while (i < mid.length && mid[i][0] !== '=') run.push(mid[i++]);
    ops.push(...run.filter((o) => o[0] === '-'), ...run.filter((o) => o[0] === '+'));
  }
  for (let i = 0; i < a.length - ea; i++) ops.push(['=', ea + i, eb + i]);
  return ops;
}
// a file's lines; the newline that ends the last one does not make an empty line after it
const linesOf = (t) => (t === null || t === undefined || t === '' ? [] : t.replace(/\n$/, '').split('\n'));
/** The runs of a file's diff: [{base_from, base_to, from, to, before, after}], 1-based and inclusive, an empty side
 *  being to = from - 1. */
function hunksOf(base, text) {
  const a = linesOf(base), b = linesOf(text), ops = diffLines(a, b), out = [];
  let ai = 0, bi = 0;
  for (let i = 0; i < ops.length;) {
    if (ops[i][0] === '=') { ai++; bi++; i++; continue; }
    const sa = ai, sb = bi;
    while (i < ops.length && ops[i][0] !== '=') { if (ops[i][0] === '-') ai++; else bi++; i++; }
    out.push({ base_from: sa + 1, base_to: ai, from: sb + 1, to: bi, before: a.slice(sa, ai).join('\n'), after: b.slice(sb, bi).join('\n') });
  }
  return out;
}
/** The unified diff of one file with three lines of context. */
function unifiedOf(path, base, text) {
  const a = linesOf(base), b = linesOf(text), ops = diffLines(a, b);
  const pos = [];   // [ai, bi] before each op
  let ai = 0, bi = 0;
  for (const o of ops) { pos.push([ai, bi]); if (o[0] !== '+') ai++; if (o[0] !== '-') bi++; }
  const changed = ops.map((o, i) => (o[0] === '=' ? -1 : i)).filter((i) => i >= 0);
  if (!changed.length) return '';
  const groups = [];
  for (const i of changed) {
    const g = groups[groups.length - 1];
    if (g && i - g[1] <= 7) g[1] = i; else groups.push([i, i]);
  }
  let out = `--- ${base === null ? '/dev/null' : 'a/' + path}\n+++ b/${path}\n`;
  for (const [x, y] of groups) {
    const lo = Math.max(0, x - 3), hi = Math.min(ops.length - 1, y + 3);
    const body = [];
    let al = 0, bl = 0;
    for (let i = lo; i <= hi; i++) {
      const o = ops[i];
      if (o[0] === '=') { body.push(' ' + a[o[1]]); al++; bl++; } else if (o[0] === '-') { body.push('-' + a[o[1]]); al++; } else { body.push('+' + b[o[1]]); bl++; }
    }
    const [sa, sb] = pos[lo];
    out += `@@ -${al ? sa + 1 : sa},${al} +${bl ? sb + 1 : sb},${bl} @@\n` + body.join('\n') + '\n';
  }
  return out;
}
/** A change's marking: OG where an OG range touches it (the stricter wins a tie), else Adapt where one does, else
 *  the default. An empty side (a deletion) touches the lines either side of where it was. */
function markingOf(c, markings, dflt) {
  const lo = c.to < c.from ? c.from - 1 : c.from, hi = c.to < c.from ? c.from : c.to;
  const hit = markings.filter((m) => m.path === c.path && m.from <= hi && m.to >= lo).map((m) => m.marking);
  return hit.includes('og') ? 'og' : hit.includes('adapt') ? 'adapt' : dflt;
}
/** A change's scope: "template" where a marking scoped to the template touches it, else "doc". */
function scopeOf(c, markings) {
  const lo = c.to < c.from ? c.from - 1 : c.from, hi = c.to < c.from ? c.from : c.to;
  return markings.some((m) => m.path === c.path && m.from <= hi && m.to >= lo && m.scope === 'template') ? 'template' : 'doc';
}
/** A file as the OG-only compile sees it: its base with only the OG changes applied (an Adapt change is the owner's
 *  guidance for the session, not text). null for an added file whose one change is not OG: it is left out. */
function ogOnly(f, changes) {
  if (f.text === f.base) return f.text;
  if (f.base === null || f.base === undefined) return changes.some((c) => c.marking === 'og') ? f.text : null;
  const a = linesOf(f.base), b = linesOf(f.text), out = [];
  let ai = 0;
  for (const c of [...changes].sort((x, y) => x.base_from - y.base_from)) {
    while (ai < c.base_from - 1 && ai < a.length) out.push(a[ai++]);
    out.push(...(c.marking === 'og' ? b.slice(c.from - 1, c.to) : a.slice(c.base_from - 1, c.base_to)));
    ai = Math.max(ai, c.base_to);
  }
  while (ai < a.length) out.push(a[ai++]);
  return out.length ? out.join('\n') + '\n' : '';
}
/** Whether "Send edits" may file the draft on the box with no session: some change, every one OG, no comment, and
 *  nothing scoped to a template. */
const directOf = (changes, comments, markings) => changes.length > 0 && changes.every((c) => c.marking === 'og') &&
  !comments.length && !markings.some((m) => m.scope === 'template');
/** The main file first, then the rest by path. */
const fileOrder = (files, main) => [...files].sort((x, y) => (x.path === main ? -1 : y.path === main ? 1 : x.path < y.path ? -1 : 1));
/** The outline and the changes, refs c1, c2… in file order. */
function analyse(files, main, markings, dflt) {
  const an = outlineOf(files, main);
  const changes = [];
  for (const f of fileOrder(files, main)) {
    if (f.text === f.base) continue;
    for (const h of hunksOf(f.base, f.text)) {
      const c = { ref: '', path: f.path, section: sectionAt(an, f.path, Math.max(1, h.from)), ...h };
      changes.push({ ...c, ref: `c${changes.length + 1}`, marking: markingOf(c, markings, dflt), scope: scopeOf(c, markings) });
    }
  }
  return { an, changes };
}

// ── new documents ──

const TEX_ESC = { '\\': '\\textbackslash{}', '{': '\\{', '}': '\\}', '&': '\\&', '%': '\\%', '$': '\\$', '#': '\\#', '_': '\\_',
  '^': '\\^{}', '~': '\\~{}' };
const texEsc = (t) => t.replace(/[\\{}&%$#_^~]/g, (c) => TEX_ESC[c]);
/** A blank document's main.tex: a preamble carrying its title and number, and one empty Introduction. */
function blankTex(title, number) {
  return ['\\documentclass[11pt]{article}', '\\usepackage[T1]{fontenc}', '\\usepackage[utf8]{inputenc}',
    '\\usepackage[margin=1in]{geometry}', '\\providecommand{\\docnumber}[2]{\\def\\thedocnumber{#1-#2}}',
    `\\docnumber{${number}}{A}`, `\\title{${texEsc(title)}}`, '\\author{}', '\\date{}', '\\begin{document}', '\\maketitle', '',
    '\\section{Introduction}', '', '\\end{document}', ''].join('\n');
}
const reEsc = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** A copy's files: the source revision's text with its number (PPP-NNNN-R, and \docnumber{PPP-NNNN}{R}) made the new
 *  one's in every file, and main's \title made the new title (added before \begin{document} where it has none).
 *  Base = the source's text, so that is one change per place, each marked OG. -> {files, markings}. */
function retitle(src, from, nd) {
  const oldFull = new RegExp(`(^|[^0-9-])${reEsc(`${from.number}-${from.rev}`)}(?![A-Za-z0-9])`, 'g');
  const oldCmd = new RegExp(`\\\\docnumber\\s*\\{\\s*${reEsc(from.number)}\\s*\\}\\s*\\{\\s*${reEsc(from.rev)}\\s*\\}`, 'g');
  const files = src.files.map((f) => {
    let text = f.text.replace(oldFull, `$1${nd.number}-A`).replace(oldCmd, `\\docnumber{${nd.number}}{A}`);
    if (f.path === src.main) {
      const begin = text.search(BEGIN_RE);
      const m = /\\title\s*(?:\[[^\]]*\]\s*)?\{/.exec(text);
      if (m && (begin < 0 || m.index < begin)) {
        let depth = 1, j = m.index + m[0].length;
        for (; j < text.length && depth; j++) { if (text[j] === '{' && text[j - 1] !== '\\') depth++; else if (text[j] === '}' && text[j - 1] !== '\\') depth--; }
        if (!depth) text = text.slice(0, m.index + m[0].length) + texEsc(nd.title) + text.slice(j - 1);
      } else if (begin >= 0) {
        const at = text.lastIndexOf('\n', begin) + 1;
        text = text.slice(0, at) + `\\title{${texEsc(nd.title)}}\n` + text.slice(at);
      }
    }
    return { path: f.path, base: f.text, text };
  });
  const markings = [];
  for (const f of files) {
    if (f.text === f.base) continue;
    for (const h of hunksOf(f.base, f.text)) markings.push({ path: f.path, from: Math.max(1, h.from), to: Math.max(1, h.from, h.to), marking: 'og' });
  }
  return { files, markings };
}
/** The session that files for project p: the filer, with a Slack channel, of its most recently filed revision (the
 *  box routes a new document's package the same way), by session, alias, target or repo; null for none. */
function projectSession(reg, p) {
  let best = null;
  for (const d of Object.values(reg.documents)) {
    if (d.project !== p) continue;
    for (const r of d.revisions || []) {
      const f = r.filer;
      if (!f || typeof f !== 'object' || !f.channel) continue;
      const at = String(r.filed_at || r.date || '');
      if (!best || at > best.at) best = { at, f };
    }
  }
  const name = best && [best.f.session, best.f.alias, best.f.target, best.f.repo].find((x) => typeof x === 'string' && x.trim());
  return name ? name.trim().slice(0, 80) : null;
}
/** The numbers new-document drafts hold (any but a discarded one) and every open draft's, so two new documents never
 *  take the same one. */
async function heldNumbers(env) {
  return (await rows(env, "SELECT number FROM drafts WHERE state = 'draft' OR (new_doc IS NOT NULL AND state != 'discarded')"))
    .map((x) => x.number);
}
/** The next free PPP-NNNN in project p: past every document, retired number and held number there (cc-docs' own
 *  next_doc, plus the drafts). */
function nextNumber(reg, p, held) {
  let max = 0;
  const bump = (n) => { const m = /^(\d{3})-(\d{4})/.exec(String(n)); if (m && m[1] === p) max = Math.max(max, Number(m[2])); };
  for (const n of Object.keys(reg.documents)) bump(n);
  for (const n of Object.keys(reg.retired && typeof reg.retired === 'object' ? reg.retired : {})) bump(n);
  for (const n of held) bump(n);
  return `${p}-${String(max + 1).padStart(4, '0')}`;
}
/** Files from outside the document's own folder, which cc-docs keeps as _ext/<path under home> (a house style, a
 *  shared preamble): [{path, used_by: [numbers whose newest revision keeps the same file]}]. */
function sharedOf(reg, files) {
  const out = [];
  for (const f of files) {
    if (!f.path.startsWith('_ext/')) continue;
    const used = Object.keys(reg.documents).sort().filter((n) => {
      const r = newest(reg.documents[n]);
      return r && Array.isArray(r.source_files) && r.source_files.includes(f.path);
    });
    out.push({ path: f.path, used_by: used });
  }
  return out;
}
const NEW_400 = 'project: a PPP the library has; title: 1-200 printable characters; from: {number, rev?} or none';

// ── drafts in D1 ──

const getDraft = (env, id) => env.DB.prepare('SELECT * FROM drafts WHERE id = ?').bind(id).first();
const draftFiles = (env, id) => rows(env, 'SELECT path, base, text FROM draft_files WHERE draft = ? ORDER BY path', id);
async function commentsOf(env, id) {
  return (await rows(env, 'SELECT id, ref, anchor, text, created FROM draft_comments WHERE draft = ? ORDER BY created, rowid', id))
    .map((c) => ({ id: c.id, anchor: parseJSON(c.anchor, null), text: c.text, created: c.created, ref: c.ref }));
}
async function blobOf(env, id, kind) {
  const parts = await rows(env, 'SELECT data FROM draft_blobs WHERE draft = ? AND kind = ? ORDER BY n', id, kind);
  if (!parts.length) return null;
  // D1 answers a BLOB as an array of numbers, node:sqlite as a Uint8Array
  const arrs = parts.map((p) => new Uint8Array(p.data || []));
  const out = new Uint8Array(arrs.reduce((t, x) => t + x.length, 0));
  let at = 0;
  for (const x of arrs) { out.set(x, at); at += x.length; }
  return out;
}
function blobRows(env, id, kind, bytes) {
  const st = [];
  for (let i = 0, n = 0; i < bytes.length || n === 0; i += ED_CHUNK, n++) {
    st.push(env.DB.prepare('INSERT INTO draft_blobs (draft, kind, n, data) VALUES (?, ?, ?, ?)')
      .bind(id, kind, n, bytes.slice(i, i + ED_CHUNK).buffer));
  }
  return st;
}
const dropBlobs = (env, id) => [env.DB.prepare('DELETE FROM draft_blobs WHERE draft = ?').bind(id),
  env.DB.prepare('UPDATE drafts SET pdf_seq = NULL, pdf_pages = NULL, pdf_bytes = NULL, pdf_at = NULL WHERE id = ?').bind(id)];
const touch = (env, id) => env.DB.prepare('UPDATE drafts SET touched = ? WHERE id = ?').bind(now(), id).run();

function draftSummary(d) {
  return { id: d.id, number: d.number, base_rev: d.base_rev || null, state: d.state, created: d.created, updated: d.updated,
    sent: d.sent || null, answered_rev: d.answered_rev || null, new: parseJSON(d.new_doc, null), answered_number: d.answered_number || null };
}
/** The register's revision a draft builds on: its base, or for a new document the one it copies; null for a blank
 *  one, or where this deployment's register does not have it (yet). */
function baseOf(reg, d) {
  const nd = parseJSON(d.new_doc, null);
  return nd ? (nd.from ? revOf(reg, nd.from.number, nd.from.rev)[1] : null) : revOf(reg, d.number, d.base_rev)[1];
}
/** Whether that revision kept only the nearest source cc-docs found (source_nearest), not an exact one. */
function nearestOf(reg, d) {
  const r = baseOf(reg, d);
  return !!(sourceOf(r) && r.source_nearest === true);
}
/** The draft as the owner's routes answer it. reg gives `shared` and source_nearest; without it they are [] and absent. */
async function draftOut(env, d, reg) {
  const files = fileOrder(await draftFiles(env, d.id), d.main);
  const changes = parseJSON(d.changes, []), comments = await commentsOf(env, d.id), markings = parseJSON(d.markings, []);
  return { ...draftSummary(d), main: d.main,
    files: files.map((f) => ({ path: f.path, text: f.text, changed: f.text !== f.base })),
    outline: parseJSON(d.outline, { outline: [] }).outline, markings,
    default_marking: d.default_marking || 'adapt', changes, comments, direct: directOf(changes, comments, markings),
    shared: reg ? sharedOf(reg, files) : [], ui: parseJSON(d.ui, null), ...(reg && nearestOf(reg, d) ? { source_nearest: true } : {}),
    compile: { status: d.cstatus || 'idle', seq: d.seq || 0, done_seq: d.done_seq || 0, at: d.cat || null,
      ok: d.cok === null || d.cok === undefined ? null : !!d.cok, errors: parseJSON(d.errors, []), log_tail: d.log_tail || '' },
    pdf: d.pdf_seq ? { url: `/api/drafts/${d.id}/pdf?seq=${d.pdf_seq}`, seq: d.pdf_seq, pages: d.pdf_pages ?? null,
      bytes: d.pdf_bytes, at: d.pdf_at } : null,
    items: parseJSON(d.items, []) };
}
/** What "Send edits" sends: every text file as it is now, the unified diff of the changed ones, the changes,
 *  comments and markings. `sent` is null in the preview and the time in the frozen copy. */
async function packageOf(env, d, sent) {
  const files = fileOrder(await draftFiles(env, d.id), d.main);
  const out = {};
  for (const f of files) out[f.path] = f.text;
  const changes = parseJSON(d.changes, []), comments = await commentsOf(env, d.id), markings = parseJSON(d.markings, []);
  return { id: d.id, number: d.number, base_rev: d.base_rev || null, main: d.main, sent,
    files: out, diff: files.filter((f) => f.text !== f.base).map((f) => unifiedOf(f.path, f.base, f.text)).join(''),
    changes, comments, markings, new: parseJSON(d.new_doc, null), direct: directOf(changes, comments, markings) };
}

/** Markings from a save: [{path, from, to, marking}] on files the draft has; null for anything else. */
function cleanMarkings(v, paths) {
  if (!Array.isArray(v) || v.length > 2000) return null;
  const out = [];
  for (const m of v) {
    if (!m || typeof m !== 'object' || !paths.has(m.path) || !MARKINGS.includes(m.marking) ||
        !Number.isInteger(m.from) || !Number.isInteger(m.to) || m.from < 1 || m.to < m.from ||
        !(m.scope === undefined || SCOPES.includes(m.scope))) return null;
    out.push({ path: m.path, from: m.from, to: m.to, marking: m.marking, ...(m.scope ? { scope: m.scope } : {}) });
  }
  return out;
}
/** A comment's anchor: a rectangle on a PDF page, a line range of a file the draft has, or null (the whole
 *  document); undefined for anything else. */
function cleanAnchor(a, paths) {
  if (a === null) return null;
  if (!a || typeof a !== 'object' || Array.isArray(a)) return undefined;
  const quote = a.quote === undefined || a.quote === null ? undefined : cleanText(a.quote);
  if (quote === null || (quote && quote.length > 2000)) return undefined;
  const q = quote ? { quote } : {};
  if (a.in === 'pdf') {
    if (!Number.isInteger(a.page) || a.page < 1 || !Array.isArray(a.rect) || a.rect.length !== 4 ||
        !a.rect.every((x) => typeof x === 'number' && Number.isFinite(x))) return undefined;
    return { in: 'pdf', page: a.page, rect: a.rect, ...q };
  }
  if (a.in === 'tex') {
    if (!paths.has(a.path) || !Number.isInteger(a.from) || !Number.isInteger(a.to) || a.from < 1 || a.to < a.from) return undefined;
    return { in: 'tex', path: a.path, from: a.from, to: a.to, ...q };
  }
  return undefined;
}
const ANCHOR_400 = 'anchor: {in: "pdf", page, rect: [x0, y0, x1, y1], quote?}, {in: "tex", path, from, to, quote?} or null; ' +
  'text: 1-20000 characters';

// ── the owner's routes ──

/** GET under /api/documents/<N>/drafts and /api/drafts/: the owner's alone (handle() has checked). */
async function editorGet(env, reg, path, url, head) {
  let m;
  if ((m = path.match(R.drafts))) {
    if (!reg.documents[m[1]]) return notFound(head);
    const list = await rows(env, 'SELECT * FROM drafts WHERE number = ? ORDER BY created DESC, rowid DESC', m[1]);
    return json({ number: m[1], drafts: list.map(draftSummary) });
  }
  if (!(m = path.match(R.draft)) || m[3] || ['send', 'discard', 'comments'].includes(m[2])) return notFound(head);
  const d = await getDraft(env, m[1]);
  if (!d) return notFound(head);
  if (!m[2]) {
    await touch(env, d.id);
    return json(await draftOut(env, d, reg));
  }
  if (m[2] === 'package') return json(d.package ? parseJSON(d.package, null) : await packageOf(env, d, null));
  if (m[2] === 'pdf') {
    const bytes = d.pdf_seq ? await blobOf(env, d.id, 'pdf') : null;
    if (!bytes) return notFound(head);
    return send(200, head ? null : bytes, 'application/pdf', { 'Content-Disposition': `inline; filename="draft-${d.id}.pdf"` }, head);
  }
  return synctex(env, d, url);
}

/** The SyncTeX lookups over the stored map: a point or a selection on a page to source lines, a line to boxes. */
async function synctex(env, d, url) {
  const bytes = d.pdf_seq ? await blobOf(env, d.id, 'map') : null;
  if (!bytes) return notFound();
  const map = parseJSON(utf8.decode(bytes), null);
  if (!map) return notFound();
  const an = parseJSON(d.outline, { outline: [], parents: {} });
  const q = (k) => { const v = url.searchParams.get(k); return v !== null && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : null; };
  const box = (b) => ({ page: b[0], x: b[3], y: b[4], w: b[5], h: b[6] });
  if (url.searchParams.has('path')) {
    const line = q('line');
    const fi = map.files.indexOf(url.searchParams.get('path'));
    if (!Number.isInteger(line) || line < 1) return bad('path and line: a file and a line number');
    const mine = fi < 0 ? [] : map.boxes.filter((b) => b[1] === fi);
    if (!mine.length) return json({ boxes: [] });
    // the exact line, else the nearest line that produced boxes (the later one on a tie)
    let best = mine[0][2];
    for (const b of mine) {
      const dd = Math.abs(b[2] - line), db = Math.abs(best - line);
      if (dd < db || (dd === db && b[2] > best)) best = b[2];
    }
    return json({ boxes: mine.filter((b) => b[2] === best).map(box) });
  }
  const page = q('page'), x = q('x'), y = q('y');
  if (!Number.isInteger(page) || page < 1 || x === null || y === null) return bad('page, x and y (and x1, y1 for a selection); or path and line');
  const on = map.boxes.filter((b) => b[0] === page);
  if (!on.length) return notFound();
  const dist = (b, px, py) => Math.hypot(Math.max(b[3] - px, 0, px - (b[3] + b[5])), Math.max(b[4] - py, 0, py - (b[4] + b[6])));
  const nearest = (px, py) => on.reduce((m, b) => (dist(b, px, py) < dist(m, px, py) ? b : m), on[0]);
  const at = (b, extra) => ({ path: map.files[b[1]], ...extra, section: sectionAt(an, map.files[b[1]], extra.line || extra.from) });
  const x1 = q('x1'), y1 = q('y1');
  if (x1 !== null && y1 !== null) {
    const [lx, hx, ly, hy] = [Math.min(x, x1), Math.max(x, x1), Math.min(y, y1), Math.max(y, y1)];
    const hit = on.filter((b) => b[3] <= hx && b[3] + b[5] >= lx && b[4] <= hy && b[4] + b[6] >= ly);
    if (!hit.length) { const b = nearest((lx + hx) / 2, (ly + hy) / 2); return json(at(b, { from: b[2], to: b[2] })); }
    const count = new Map();
    for (const b of hit) count.set(b[1], (count.get(b[1]) || 0) + 1);
    const fi = [...count.entries()].sort((p, r) => r[1] - p[1] || p[0] - r[0])[0][0];
    const lines = hit.filter((b) => b[1] === fi).map((b) => b[2]);
    return json(at(hit.find((b) => b[1] === fi), { from: Math.min(...lines), to: Math.max(...lines) }));
  }
  const inside = on.filter((b) => x >= b[3] && x <= b[3] + b[5] && y >= b[4] && y <= b[4] + b[6]);
  const b = inside.length ? inside.reduce((m, c) => (c[5] * c[6] < m[5] * m[6] ? c : m), inside[0]) : nearest(x, y);
  return json(at(b, { line: b[2] }));
}

/** POST under /api/documents/<N>/drafts and /api/drafts/: the owner's alone (handle() has checked). */
async function editorWrite(env, reg, origin, path, body) {
  let m;
  if ((m = path.match(R.drafts))) return openDraft(env, reg, origin, m[1], body);
  if (R.newDraft.test(path)) return newDraft(env, reg, origin, body);
  if (!(m = path.match(R.draft)) || m[2] === 'pdf' || m[2] === 'synctex' || m[2] === 'package' || (m[3] && m[2] !== 'comments')) return notFound();
  const d = await getDraft(env, m[1]);
  if (!d) return notFound();
  if (d.state !== 'draft') return send(409, `this draft is ${d.state}; only a draft in state draft changes\n`);
  const at = now();
  if (!m[2]) return saveDraft(env, reg, d, body, at);
  if (m[2] === 'comments') {
    const paths = new Set((await draftFiles(env, d.id)).map((f) => f.path));
    if (!m[3]) {
      const anchor = cleanAnchor(body.anchor === undefined ? null : body.anchor, paths);
      const text = cleanText(body.text);
      if (anchor === undefined || !text) return bad(ANCHOR_400);
      const c = { id: randomHex(4), anchor, text, created: at, ref: `m${(d.next_ref || 0) + 1}` };
      await env.DB.batch([
        env.DB.prepare('INSERT INTO draft_comments (id, draft, ref, anchor, text, created) VALUES (?, ?, ?, ?, ?, ?)')
          .bind(c.id, d.id, c.ref, JSON.stringify(anchor), text, at),
        env.DB.prepare('UPDATE drafts SET next_ref = ?, updated = ?, touched = ? WHERE id = ?').bind((d.next_ref || 0) + 1, at, at, d.id)]);
      return json(c);
    }
    const c = await env.DB.prepare('SELECT id FROM draft_comments WHERE id = ? AND draft = ?').bind(m[3], d.id).first();
    if (!c) return notFound();
    if (body.delete === true) {
      await env.DB.prepare('DELETE FROM draft_comments WHERE id = ?').bind(c.id).run();
      return json({ deleted: c.id });
    }
    const text = cleanText(body.text);
    if (!text) return bad('text: 1-20000 characters; or delete: true');
    await env.DB.prepare('UPDATE draft_comments SET text = ? WHERE id = ?').bind(text, c.id).run();
    return json((await commentsOf(env, d.id)).find((x) => x.id === c.id));
  }
  if (m[2] === 'discard') {
    await env.DB.batch([env.DB.prepare("UPDATE drafts SET state = 'discarded', updated = ? WHERE id = ?").bind(at, d.id), ...dropBlobs(env, d.id)]);
    return json(draftSummary({ ...d, state: 'discarded', updated: at }));
  }
  // send: the package frozen as the preview shows it, and an item per change and comment
  const pkg = await packageOf(env, d, at);
  const items = pkg.changes.map((c) => ({ ref: c.ref, kind: 'change', status: 'new', reply: null }))
    .concat(pkg.comments.map((c) => ({ ref: c.ref, kind: 'comment', status: 'new', reply: null })));
  if (!items.length) return send(409, 'nothing to send: no change and no comment\n');
  await env.DB.prepare("UPDATE drafts SET state = 'sent', sent = ?, updated = ?, package = ?, items = ? WHERE id = ? AND state = 'draft'")
    .bind(at, at, JSON.stringify(pkg), JSON.stringify(items), d.id).run();
  // NOTES: api.md "A round starts when the owner ... sends an editor draft"; a new document's has no register entry yet
  if (!d.new_doc && reg.documents[d.number]) await roundStart(env, reg, d.number, d.base_rev);
  return json(await draftOut(env, await getDraft(env, d.id), reg));
}

/** POST /api/documents/<N>/drafts {rev?}: the open draft of that document, or a new one from the revision's kept
 *  source with its first compile queued. */
async function openDraft(env, reg, origin, num, body) {
  const doc = reg.documents[num];
  if (!doc) return notFound();
  const rev = body.rev === undefined || body.rev === null ? (newest(doc) || {}).rev : body.rev;
  const r = revOf(reg, num, rev)[1];
  if (!r) return bad('rev: one of its revisions, or none for the newest');
  const openSql = "SELECT * FROM drafts WHERE number = ? AND state = 'draft'";
  const open = await env.DB.prepare(openSql).bind(num).first();
  if (open) return json(await draftOut(env, open, reg));
  const src = await keptSource(env, origin, num, doc, r);
  if (typeof src === 'string') return send(409, src + '\n');
  const id = randomHex(4), at = now();
  const files = src.files.map((f) => ({ ...f, base: f.text }));
  const { an, changes } = analyse(files, src.main, [], 'adapt');
  // INSERT OR IGNORE: should another request have opened one meanwhile, drafts_open keeps that one alone
  await env.DB.batch([
    env.DB.prepare('INSERT OR IGNORE INTO drafts (id, number, base_rev, state, created, updated, touched, main, markings, default_marking, ' +
      "outline, changes, seq, cstatus, done_seq, next_ref) VALUES (?, ?, ?, 'draft', ?, ?, ?, ?, '[]', 'adapt', ?, ?, 1, 'queued', 0, 0)")
      .bind(id, num, r.rev, at, at, at, src.main, JSON.stringify(an), JSON.stringify(changes)),
    ...files.map((f) => env.DB.prepare('INSERT OR IGNORE INTO draft_files (draft, path, base, text) VALUES (?, ?, ?, ?)').bind(id, f.path, f.text, f.text)),
  ]);
  const got = await env.DB.prepare(openSql).bind(num).first();
  if (got && got.id !== id) await env.DB.prepare('DELETE FROM draft_files WHERE draft = ?').bind(id).run();
  return json(await draftOut(env, got, reg));
}

/** POST /api/drafts {project, title, from?: {number, rev?}}: a draft for a NEW document, under the next free number
 *  of that project (held by the draft until it is discarded). Blank: a generated main.tex whose base is empty, so it
 *  is one change, OG by default. A copy: the source revision's kept source as the base, its title and number made
 *  the new ones as OG changes; 409 when that revision kept no source. */
async function newDraft(env, reg, origin, body) {
  const p = body.project;
  const title = typeof body.title === 'string' ? cleanDesc(body.title) : null;
  if (typeof p !== 'string' || !/^\d{3}$/.test(p) || !reg.projects[p] || !title) return bad(NEW_400);
  let from = null, src = null;
  if (body.from !== undefined && body.from !== null) {
    const f = body.from;
    if (typeof f !== 'object' || Array.isArray(f) || typeof f.number !== 'string') return bad(NEW_400);
    const doc = reg.documents[f.number];
    if (!doc) return notFound();
    const r = revOf(reg, f.number, f.rev === undefined || f.rev === null ? (newest(doc) || {}).rev : f.rev)[1];
    if (!r) return bad('from.rev: one of its revisions, or none for the newest');
    src = await keptSource(env, origin, f.number, doc, r);
    if (typeof src === 'string') return send(409, src + '\n');
    from = { number: f.number, rev: r.rev };
  }
  // two new drafts at once may pick the same number: drafts_open keeps one, and the other takes the next
  for (let i = 0; i < 5; i++) {
    const number = nextNumber(reg, p, await heldNumbers(env));
    const nd = { number, rev: 'A', project: p, title, ...(from ? { from } : {}) };
    const { files, markings } = from ? retitle(src, from, nd)
      : { files: [{ path: 'main.tex', base: null, text: blankTex(title, number) }], markings: [] };
    const main = from ? src.main : 'main.tex', dflt = from ? 'adapt' : 'og';
    const { an, changes } = analyse(files, main, markings, dflt);
    const id = randomHex(4), at = now();
    await env.DB.batch([
      env.DB.prepare('INSERT OR IGNORE INTO drafts (id, number, base_rev, state, created, updated, touched, main, markings, default_marking, ' +
        "outline, changes, seq, cstatus, done_seq, next_ref, new_doc) VALUES (?, ?, NULL, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, 1, 'queued', 0, 0, ?)")
        .bind(id, number, at, at, at, main, JSON.stringify(markings), dflt, JSON.stringify(an), JSON.stringify(changes), JSON.stringify(nd)),
      ...files.map((f) => env.DB.prepare('INSERT OR IGNORE INTO draft_files (draft, path, base, text) VALUES (?, ?, ?, ?)').bind(id, f.path, f.base, f.text)),
    ]);
    const got = await getDraft(env, id);
    if (got) return json(await draftOut(env, got, reg));
    await env.DB.prepare('DELETE FROM draft_files WHERE draft = ?').bind(id).run();
  }
  return send(503, 'no free number could be held for the new document; try again\n');
}

/** POST /api/drafts/<id> {files?, markings?, compile?}: the files that changed, the markings list, and a compile
 *  queued unless compile is false. */
async function saveDraft(env, reg, d, body, at) {
  let ui;
  if (body.ui !== undefined) {
    const raw = body.ui === null ? null : JSON.stringify(body.ui);
    if (!(body.ui === null || (typeof body.ui === 'object' && !Array.isArray(body.ui) && new TextEncoder().encode(raw).length <= ED_UI_MAX))) {
      return bad(`ui: a JSON object of at most ${ED_UI_MAX} bytes, or null`);
    }
    ui = raw;
  }
  // the UI's own state alone changes no text: no compile unless one is asked for
  if (ui !== undefined && body.files === undefined && body.markings === undefined && body.compile !== true) {
    if (body.compile !== undefined && body.compile !== false) return bad('compile: true or false');
    await env.DB.prepare('UPDATE drafts SET ui = ?, touched = ? WHERE id = ?').bind(ui, at, d.id).run();
    return json(await draftOut(env, await getDraft(env, d.id), reg));
  }
  const files = await draftFiles(env, d.id);
  const byPath = new Map(files.map((f) => [f.path, f]));
  const upd = [];
  if (body.files !== undefined) {
    if (!body.files || typeof body.files !== 'object' || Array.isArray(body.files)) return bad('files: {path: text}');
    for (const [p, text] of Object.entries(body.files)) {
      const path = safePath(p);
      if (!path || path !== p || typeof text !== 'string' || text.length > ED_TEXT_MAX || text.includes('\u0000')) {
        return bad('files: {path: text}, each a relative path inside the draft and at most 1 MB of text');
      }
      if (!byPath.has(path)) {
        if (byPath.size >= ED_FILES_MAX) return bad(`at most ${ED_FILES_MAX} files`);
        byPath.set(path, { path, base: null, text });
      } else byPath.set(path, { ...byPath.get(path), text });
      upd.push(path);
    }
  }
  const all = [...byPath.values()];
  const markings = body.markings === undefined ? parseJSON(d.markings, []) : cleanMarkings(body.markings, new Set(byPath.keys()));
  if (!markings) return bad('markings: [{path, from, to, marking}], lines 1-based and inclusive, marking og or adapt');
  if (body.compile !== undefined && typeof body.compile !== 'boolean') return bad('compile: true or false');
  const compile = body.compile !== false;
  const { an, changes } = analyse(all, d.main, markings, d.default_marking || 'adapt');
  await env.DB.batch([
    ...upd.map((p) => env.DB.prepare('INSERT INTO draft_files (draft, path, base, text) VALUES (?, ?, ?, ?) ' +
      'ON CONFLICT (draft, path) DO UPDATE SET text = excluded.text').bind(d.id, p, byPath.get(p).base, byPath.get(p).text)),
    env.DB.prepare('UPDATE drafts SET markings = ?, outline = ?, changes = ?, updated = ?, touched = ? WHERE id = ?')
      .bind(JSON.stringify(markings), JSON.stringify(an), JSON.stringify(changes), at, at, d.id),
    ...(ui !== undefined ? [env.DB.prepare('UPDATE drafts SET ui = ? WHERE id = ?').bind(ui, d.id)] : []),
    ...(compile ? [env.DB.prepare("UPDATE drafts SET seq = coalesce(seq, 0) + 1, cstatus = 'queued', claimed = NULL WHERE id = ?").bind(d.id)] : []),
  ]);
  return json(await draftOut(env, await getDraft(env, d.id), reg));
}

// ── the box's routes ──

/** Whether the box should hold its poll open: a draft opened or saved in the last 15 minutes, or a compile queued; or
 *  a chat opened in the last 15 minutes. */
async function editorActive(env) {
  const since = ago(ED_ACTIVE_S);
  const r = await env.DB.prepare("SELECT count(*) AS c FROM drafts WHERE state = 'draft' AND (touched > ? OR cstatus = 'queued')")
    .bind(since).first();
  if (r && r.c) return true;
  return !!(await env.DB.prepare("SELECT 1 AS y FROM meta WHERE k = 'chat_active' AND v > ?").bind(since).first());
}
/** Each queued compile, and each running one the box took over two minutes ago, marked running and handed out. */
async function claimJobs(env, reg) {
  const stale = ago(ED_REOFFER_S);
  const cand = await rows(env, "SELECT * FROM drafts WHERE state = 'draft' AND (cstatus = 'queued' OR (cstatus = 'running' AND claimed < ?)) " +
    'ORDER BY updated LIMIT 8', stale);
  const jobs = [];
  for (const d of cand) {
    const nd = parseJSON(d.new_doc, null), r = baseOf(reg, d);
    // a blank new document builds on nothing, any other draft on a revision's kept source. A revision filed after
    // this deployment was built (the box's poll held open on the old one) is not in its register yet: the draft stays
    // queued, and the next poll, on the new deployment, hands it out with its source
    if ((!nd || nd.from) && !sourceOf(r)) continue;
    const took = await env.DB.prepare("UPDATE drafts SET cstatus = 'running', claimed = ? WHERE id = ? AND seq = ? AND " +
      "(cstatus = 'queued' OR (cstatus = 'running' AND claimed < ?))").bind(now(), d.id, d.seq, stale).run();
    if (!took || !took.meta || !took.meta.changes) continue;
    // the OG-only source: the base with the changes marked OG (an unmarked one follows default_marking)
    const files = {}, changes = parseJSON(d.changes, []);
    for (const f of await draftFiles(env, d.id)) {
      const t = ogOnly(f, changes.filter((c) => c.path === f.path));
      if (t !== null) files[f.path] = t;
    }
    jobs.push({ draft: d.id, number: d.number, base_rev: d.base_rev || null, source: sourceOf(r), main: d.main, seq: d.seq,
      files, ...(nd ? { new: true } : {}) });
  }
  return jobs;
}
function cleanErrors(v) {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.length > 500) return null;
  const out = [];
  for (const e of v) {
    if (!e || typeof e !== 'object' || typeof e.message !== 'string') return null;
    out.push({ path: typeof e.path === 'string' ? e.path.slice(0, 300) : null,
      line: Number.isInteger(e.line) && e.line > 0 ? e.line : null, message: e.message.slice(0, 2000) });
  }
  return out;
}
function cleanMap(v) {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'object' || !Array.isArray(v.files) || !Array.isArray(v.boxes) || v.files.length > 1000 || v.boxes.length > 500000 ||
      !v.files.every((f) => typeof f === 'string' && f.length <= 300)) return null;
  for (const b of v.boxes) {
    if (!Array.isArray(b) || b.length !== 7 || !b.every((x) => typeof x === 'number' && Number.isFinite(x)) || !Number.isInteger(b[0]) ||
        !Number.isInteger(b[1]) || b[1] < 0 || b[1] >= v.files.length || !Number.isInteger(b[2])) return null;
  }
  return { files: v.files, boxes: v.boxes };
}

/** /api/editor/*: the box's service token alone, as /api/feedback. */
async function editorBox(request, env, reg, path, url) {
  await boxOnly(request, env, 'reaches the editor queue');
  let m;
  if (request.method !== 'POST') {
    if (R.edJobs.test(path)) {
      const w = url.searchParams.get('wait');
      if (w !== null && !/^\d{1,4}$/.test(w)) return bad('wait: seconds');
      const until = Date.now() + Math.min(ED_WAIT_MAX, Number(w || 0)) * 1000, step = pollMs(env);
      for (;;) {
        const jobs = await claimJobs(env, reg), questions = await claimQuestions(env, reg);
        if (jobs.length || questions.length || Date.now() + step > until) return json({ active: await editorActive(env), jobs, questions });
        await sleep(step);
      }
    }
    if ((m = path.match(R.edPdf))) {
      // the last good PDF of a sent draft, for the box to crop a drawn box from
      const d = await getDraft(env, m[1]);
      const bytes = d && d.state !== 'draft' && d.pdf_seq ? await blobOf(env, d.id, 'pdf') : null;
      return bytes ? send(200, bytes, 'application/pdf') : notFound();
    }
    if (R.edOutbox.test(path)) {
      const sent = await rows(env, "SELECT package FROM drafts WHERE state = 'sent' ORDER BY sent, id");
      return json({ edits: sent.map((x) => parseJSON(x.package, null)).filter(Boolean), questions: await questionOutbox(env) });
    }
    if (R.edCarry.test(path)) return json({ rounds: await carryRounds(env, reg) });
    return notFound();
  }
  if ((m = path.match(R.edJob))) return compileResult(env, m[1], await readBody(request, 48 << 20));
  if ((m = path.match(R.edEdit))) return editNews(env, m[1], await readBody(request, 1 << 20));
  if ((m = path.match(R.edQuestion))) return questionNews(env, m[1], await readBody(request, 65536));
  if ((m = path.match(R.edCarryOne))) return carryNotes(env, reg, m[1], m[2], await readBody(request, 65536));
  return notFound();
}

/** POST /api/editor/jobs/<id>: a compile's result. An older result than one recorded changes nothing; a good one
 *  replaces the PDF and map; a failed one keeps the last good PDF and records its errors. */
async function compileResult(env, id, body) {
  const d = await getDraft(env, id);
  if (!d) return notFound();
  if (d.state !== 'draft') return send(409, `this draft is ${d.state}\n`);
  const errors = cleanErrors(body.errors);
  const map = cleanMap(body.map);
  const pages = body.pages === undefined || body.pages === null ? null : body.pages;
  if (!Number.isInteger(body.seq) || body.seq < 1 || body.seq > (d.seq || 0) || typeof body.ok !== 'boolean' || !errors ||
      map === null || !(pages === null || (Number.isInteger(pages) && pages >= 0)) ||
      !(body.log_tail === undefined || body.log_tail === null || typeof body.log_tail === 'string') ||
      (body.ok && typeof body.pdf !== 'string')) {
    return bad('seq: a compile handed out; ok: true or false; errors: [{path, line, message}]; log_tail: text; pages: a count; ' +
      'pdf: base64, with ok; map: {files, boxes}');
  }
  let pdf = null;
  if (body.ok) {
    try { pdf = Uint8Array.from(atob(body.pdf), (c) => c.charCodeAt(0)); } catch (e) { pdf = null; }
    if (!pdf || latin(pdf.subarray(0, 5)) !== '%PDF-') return bad('pdf: a PDF, base64');
  }
  const seq = body.seq, at = now();
  if (seq < (d.done_seq || 0)) return json({ draft: id, seq, stale: true });
  const current = seq === d.seq;
  const st = [env.DB.prepare('UPDATE drafts SET done_seq = ?, cat = ?, cok = ?, errors = ?, log_tail = ?, cstatus = ?, claimed = ? WHERE id = ?')
    .bind(seq, at, body.ok ? 1 : 0, JSON.stringify(errors), String(body.log_tail || '').slice(-20000),
      current ? (body.ok ? 'ok' : 'error') : d.cstatus, current ? null : d.claimed, id)];
  if (pdf && seq >= (d.pdf_seq || 0)) {
    st.push(env.DB.prepare('DELETE FROM draft_blobs WHERE draft = ?').bind(id), ...blobRows(env, id, 'pdf', pdf),
      ...(map ? blobRows(env, id, 'map', new TextEncoder().encode(JSON.stringify(map))) : []),
      env.DB.prepare('UPDATE drafts SET pdf_seq = ?, pdf_pages = ?, pdf_bytes = ?, pdf_at = ? WHERE id = ?').bind(seq, pages, pdf.length, at, id));
  }
  await env.DB.batch(st);
  return json({ draft: id, seq, stale: false });
}

/** POST /api/editor/edits/<id>: received, per-item replies, answered with its revision. Neither the state nor an
 *  item's status moves back; answered closes every open item and drops the PDF and map. */
async function editNews(env, id, body) {
  const d = await getDraft(env, id);
  if (!d) return notFound();
  if (!ED_ORDER.slice(1).includes(d.state)) return send(409, `this draft is ${d.state}, not sent\n`);
  const items = parseJSON(d.items, []);
  const answered = body.answered_rev === undefined || body.answered_rev === null ? null : body.answered_rev;
  const anum = body.answered_number === undefined || body.answered_number === null ? null : body.answered_number;
  const news = body.items === undefined ? [] : body.items;
  const okNews = Array.isArray(news) && news.length <= 2000 && news.every((x) => x && typeof x === 'object' &&
    items.some((i) => i.ref === x.ref) && (x.status === undefined || FB_STATUS.includes(x.status)) &&
    (x.reply === undefined || x.reply === null || (cleanText(x.reply) && cleanText(x.reply).length <= 2000)));
  if (!(body.state === undefined || ED_ORDER.slice(1).includes(body.state)) || !okNews ||
      !(answered === null || (typeof answered === 'string' && new RegExp(`^${REV}$`).test(answered))) ||
      !(anum === null || (d.new_doc && typeof anum === 'string' && new RegExp(`^${DOC}$`).test(anum)))) {
    return bad('state: received or answered; answered_rev: a revision letter; answered_number: PPP-NNNN, for a new document; ' +
      'items: [{ref, status?, reply?}] of its items');
  }
  const state = body.state && ED_ORDER.indexOf(body.state) > ED_ORDER.indexOf(d.state) ? body.state : d.state;
  const rev = answered || d.answered_rev || null;
  if (state === 'answered' && !rev) return bad('answered needs answered_rev');
  for (const x of news) {
    const it = items.find((i) => i.ref === x.ref);
    if (x.status && FB_STATUS.indexOf(x.status) > FB_STATUS.indexOf(it.status)) it.status = x.status;
    if (x.reply !== undefined && x.reply !== null) it.reply = cleanText(x.reply);
  }
  if (state === 'answered') for (const it of items) it.status = 'done';
  const at = now();
  const number = anum || d.answered_number || null;
  await env.DB.batch([env.DB.prepare('UPDATE drafts SET state = ?, answered_rev = ?, answered_number = ?, items = ?, updated = ? WHERE id = ?')
    .bind(state, rev, number, JSON.stringify(items), at, id), ...(state === 'answered' ? dropBlobs(env, id) : [])]);
  return json({ id, state, answered_rev: rev, ...(d.new_doc ? { answered_number: number } : {}), items });
}

// ── LIBRARY CHAT (docs/library-chat/api.md) ──────────────────────────────────────────────────────────────────

const Q_TEXT_MAX = 2000;
const Q_DAY = { owner: 200, member: 30 };   // questions per asker per UTC day
const Q_SESSION_DAY = 20;                   // the owner's session questions a day, a hand-on counting as one
const Q_TIMEOUT_S = 180;                    // a quick question not answered by then reads and is stored failed
const Q_REOFFER_S = 120;                    // one answering longer is handed out again
const Q_HISTORY = 6;                        // turns of the thread the answerer sees
const Q_WAIT_MAX = 25;
const Q_FAILS = ['timeout', 'day_limit', 'error'];
const Q_MODELS = ['sonnet', 'opus'];
// maths in a quote: a backslash command, ^ or _, one of these signs, or an = between terms
const MATHS = /\\[A-Za-z]+|[\^_∑∫√≤≥≠]|\S\s*=\s*\S/;

/** A comment's or question's anchor: {in: 'pdf', page, rect, quote?}; null for none; undefined for anything else. */
function pdfAnchor(a) {
  if (a === undefined || a === null) return null;
  const x = cleanAnchor(a, new Set());
  return x && x.in === 'pdf' ? x : undefined;
}
const dayStart = () => today() + 'T00:00:00.000Z';
const limitHit = (what) => send(429, `${what} It resets at midnight UTC.\n`);

/** Every quick question still queued or answering 3 minutes after it was made, stored as failed with error timeout. */
async function expireQuestions(env) {
  const at = now();
  await env.DB.prepare("UPDATE questions SET status = 'failed', error = 'timeout', updated = ? WHERE route = 'quick' AND " +
    "status IN ('queued', 'answering') AND created < ?").bind(at, ago(Q_TIMEOUT_S)).run();
}
/** The owner's session questions today: those asked for the session, and the hand-ons made today. */
async function sessionsToday(env, asker) {
  const d = dayStart();
  const r = await env.DB.prepare("SELECT count(*) AS c FROM questions WHERE asker = ? AND ((route = 'session' AND created >= ?) OR " +
    'handed_at >= ?)').bind(asker, d, d).first();
  return r ? r.c : 0;
}
async function getQuestion(env, id) { return env.DB.prepare('SELECT * FROM questions WHERE id = ?').bind(id).first(); }
/** A question as the page reads it: asker and cost stay here; edit is the feedback item it filed, or null. */
async function questionOut(env, q) {
  const f = q.edit ? await env.DB.prepare(FB_SELECT + ' WHERE id = ?').bind(q.edit).first() : null;
  return { id: q.id, number: q.number, rev: q.rev, anchor: parseJSON(q.anchor, null), text: q.text, thread: q.thread, route: q.route,
    model: q.model, status: q.status, answer: q.answer || null, pages: parseJSON(q.pages, []), why: q.why || null,
    handed: q.handed || null, session_answer: q.session_answer || null,
    edit: f ? { id: f.id, status: f.status || 'new', reply: f.reply || null, answered_rev: f.answered_rev || null } : null,
    created: q.created, answered: q.answered || null, updated: q.updated, error: q.error || null };
}
/** May this viewer ask about num at all: the owner, or a member who can open a revision of it. The revisions they may
 *  open, or null. */
async function askable(env, reg, viewer, num) {
  if (!viewer.owner && viewer.role !== 'member') return null;
  const open = await openable(env, reg, viewer, num);
  return open.length ? open : null;
}
/** The asker's own question id, or null: anyone else's, the owner's too, is not there; so is one on a revision a
 *  member can no longer open. */
async function ownQuestion(env, reg, viewer, id) {
  const q = await getQuestion(env, id);
  if (!q || q.asker !== viewer.email) return null;
  if (!viewer.owner && !((await askable(env, reg, viewer, q.number)) || []).some((r) => r.rev === q.rev)) return null;
  return q;
}

/** GET /api/documents/<N>/questions[?rev=R] and /api/questions/<id>[?wait=S]. */
async function questionsGet(env, reg, viewer, path, url) {
  let m;
  await expireQuestions(env);
  if ((m = path.match(R.qDoc))) {
    if (!(await askable(env, reg, viewer, m[1]))) return notFound();
    const rev = url.searchParams.get('rev');
    if (rev !== null && !new RegExp(`^${REV}$`).test(rev)) return bad('rev: a revision letter');
    await env.DB.prepare("INSERT OR REPLACE INTO meta (k, v) VALUES ('chat_active', ?)").bind(now()).run();
    const list = await rows(env, 'SELECT * FROM questions WHERE asker = ? AND number = ?' + (rev ? ' AND rev = ?' : '') +
      ' ORDER BY created, rowid', viewer.email, m[1], ...(rev ? [rev] : []));
    return json({ number: m[1], questions: await Promise.all(list.map((q) => questionOut(env, q))) });
  }
  if (!(m = path.match(R.qOne))) return notFound();
  let q = await ownQuestion(env, reg, viewer, m[1]);
  if (!q) return notFound();
  const w = url.searchParams.get('wait');
  if (w !== null && !/^\d{1,4}$/.test(w)) return bad('wait: seconds');
  // held while nothing changes, unless it is settled already
  const until = Date.now() + Math.min(Q_WAIT_MAX, Number(w || 0)) * 1000, step = pollMs(env), seen = q.updated;
  while (!['answered', 'failed'].includes(q.status) && Date.now() + step <= until) {
    await sleep(step);
    await expireQuestions(env);
    q = await getQuestion(env, q.id);
    if (q.updated !== seen) break;
  }
  return json(await questionOut(env, q));
}

/** POST /api/documents/<N>/questions: the owner's or a member's question, queued for the box or the session. A note
 *  (NOTES) asks through here with its own anchor already built, `noteAnchor`, which pdfAnchor would strip of box. */
async function askQuestion(env, reg, viewer, num, body, noteAnchor) {
  if (!viewer.owner && viewer.role !== 'member') return send(403, 'only the owner can change this\n');
  const open = await askable(env, reg, viewer, num);
  if (!open) return notFound();
  const route = body.route === undefined || body.route === null ? 'quick' : body.route;
  if (route === 'session' && !viewer.owner) return send(403, 'only the owner can ask the library session\n');
  const text = cleanText(body.text);
  const anchor = noteAnchor !== undefined ? noteAnchor : pdfAnchor(body.anchor);
  const thread = body.thread === undefined || body.thread === null ? null : body.thread;
  const again = body.again === undefined || body.again === null ? null : body.again;
  if (!['quick', 'session'].includes(route) || !text || text.length > Q_TEXT_MAX || anchor === undefined ||
      !(body.rev === undefined || body.rev === null || (typeof body.rev === 'string' && new RegExp(`^${REV}$`).test(body.rev))) ||
      !(thread === null || (typeof thread === 'string' && new RegExp(`^${HEX}$`).test(thread))) ||
      !(again === null || (typeof again === 'string' && new RegExp(`^${HEX}$`).test(again))) || (again && route !== 'quick')) {
    return bad(`text: 1-${Q_TEXT_MAX} characters; rev: a revision letter, or none for the newest; route: quick or session; ` +
      'anchor: {in: "pdf", page, rect: [x0, y0, x1, y1], quote?} or none; thread, again: a question\'s 8 hex, or none');
  }
  const r = body.rev ? open.find((x) => x.rev === body.rev) : open[open.length - 1];
  if (!r) return notFound();
  // thread and again: only the asker's own, on this document
  let th = thread;
  if (again) {
    const a = await getQuestion(env, again);
    if (!a || a.asker !== viewer.email || a.number !== num) return notFound();
    if (a.route !== 'quick' || !['answered', 'handed_on'].includes(a.status)) return bad('again: one of your answered quick questions');
    th = th || a.thread;
  }
  if (th && !(await env.DB.prepare('SELECT 1 AS y FROM questions WHERE asker = ? AND number = ? AND thread = ?')
    .bind(viewer.email, num, th).first())) return notFound();
  const cap = viewer.owner ? Q_DAY.owner : Q_DAY.member;
  const c = await env.DB.prepare('SELECT count(*) AS c FROM questions WHERE asker = ? AND created >= ?').bind(viewer.email, dayStart()).first();
  if (c && c.c >= cap) return limitHit(`You have asked ${cap} questions today, the most one day allows.`);
  if (route === 'session' && (await sessionsToday(env, viewer.email)) >= Q_SESSION_DAY) {
    return limitHit(`You have sent ${Q_SESSION_DAY} questions to the library session today, the most one day allows; quick answers still work.`);
  }
  const quote = anchor && anchor.quote || '';
  const model = route === 'session' ? 'session' : text.length > 300 || MATHS.test(quote) || again ? 'strong' : 'quick';
  const at = now();
  const q = { id: randomHex(4), number: num, rev: r.rev, asker: viewer.email, anchor: anchor ? JSON.stringify(anchor) : null, text,
    thread: th || randomHex(4), route, model, again, status: route === 'session' ? 'with_session' : 'queued', created: at, updated: at };
  await env.DB.prepare('INSERT INTO questions (id, number, rev, asker, anchor, text, thread, route, model, again, status, created, updated) ' +
    'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').bind(q.id, q.number, q.rev, q.asker, q.anchor, q.text, q.thread, q.route, q.model,
    q.again, q.status, q.created, q.updated).run();
  return json(await questionOut(env, q));
}

/** POST /api/questions/<id>/edit, the owner's: Make this an edit. A feedback item (kind request) holding the question,
 *  the quote and the answer, at the question's anchor; a second tap answers the same item. */
async function questionEdit(env, id) {
  const q = await getQuestion(env, id);
  if (!q || !OWNERS.includes(q.asker)) return notFound();
  if (!q.answer && !q.session_answer) return send(409, `this question is ${q.status}, with no answer to make an edit of\n`);
  if (!q.edit) {
    const anchor = parseJSON(q.anchor, null), fid = randomHex(4), at = now();
    const text = [`Question: ${q.text}`, anchor && anchor.quote ? `Quote (page ${anchor.page}): ${anchor.quote}` : '',
      q.answer ? `Answer: ${q.answer}` : '', q.session_answer ? `The session's answer: ${q.session_answer}` : '']
      .filter(Boolean).join('\n\n');
    // the claim first, so two taps at once file one item
    const took = await env.DB.prepare('UPDATE questions SET edit = ?, updated = ? WHERE id = ? AND edit IS NULL').bind(fid, at, id).run();
    if (took && took.meta && took.meta.changes) {
      await env.DB.prepare("INSERT INTO feedback (id, number, rev, section, kind, text, created, status, anchor) VALUES (?, ?, ?, NULL, 'request', ?, ?, 'new', ?)")
        .bind(fid, q.number, q.rev, text, at, q.anchor).run();
    }
  }
  const f = await env.DB.prepare(FB_SELECT + ' WHERE id = ?').bind((await getQuestion(env, id)).edit).first();
  return f ? json(fbOut(f)) : notFound();
}

// the box's side

/** Each queued quick question, and each answering one the box took over two minutes ago, marked answering and handed
 *  out: source (the revision's kept source) and the six turns before it in its thread, for the owner's only source. */
async function claimQuestions(env, reg) {
  await expireQuestions(env);
  const stale = ago(Q_REOFFER_S);
  const cand = await rows(env, "SELECT * FROM questions WHERE route = 'quick' AND (status = 'queued' OR (status = 'answering' AND claimed < ?)) " +
    'ORDER BY created LIMIT 8', stale);
  const out = [];
  for (const q of cand) {
    const at = now();
    const took = await env.DB.prepare("UPDATE questions SET status = 'answering', claimed = ?, updated = ? WHERE id = ? AND " +
      "(status = 'queued' OR (status = 'answering' AND claimed < ?))").bind(at, at, q.id, stale).run();
    if (!took || !took.meta || !took.meta.changes) continue;
    const owner = OWNERS.includes(q.asker);
    const hist = (await rows(env, 'SELECT text, answer, session_answer FROM questions WHERE asker = ? AND number = ? AND thread = ? AND ' +
      'id != ? AND created <= ? ORDER BY created DESC, rowid DESC LIMIT ?', q.asker, q.number, q.thread, q.id, q.created, Q_HISTORY))
      .reverse().map((h) => ({ text: h.text, answer: h.session_answer || h.answer || null }));
    const src = owner ? sourceOf(revOf(reg, q.number, q.rev)[1]) : null;
    out.push({ id: q.id, number: q.number, rev: q.rev, owner, anchor: parseJSON(q.anchor, null), text: q.text, model: q.model,
      history: hist, ...(owner ? { source: src } : {}) });
  }
  return out;
}
/** The owner's questions for the session, not yet posted; a member's never. */
async function questionOutbox(env) {
  const list = await rows(env, "SELECT * FROM questions WHERE status IN ('with_session', 'handed_on') AND posted IS NULL " +
    `AND asker IN (${OWNERS.map(() => '?').join(', ')}) ORDER BY created, rowid`, ...OWNERS);
  return list.map((q) => ({ id: q.id, number: q.number, rev: q.rev, anchor: parseJSON(q.anchor, null), text: q.text, route: q.route,
    ...(q.status === 'handed_on' ? { answer: q.answer, handed: q.handed } : {}) }));
}
const QNEWS_400 = 'one of {answer, pages, hand_on, why, model, cost}, {failed: timeout|day_limit|error, cost?}, {posted: true} or ' +
  '{session_answer}: answer 1-20000 characters, pages [page numbers], hand_on and why one line or null, model sonnet or opus, ' +
  'cost dollars, session_answer 1-4000 characters';
/** POST /api/editor/questions/<id>: a quick answer, a failure, posted, or the session's answer. Nothing moves back. */
async function questionNews(env, id, body) {
  const q = await getQuestion(env, id);
  if (!q) return notFound();
  const kinds = ['answer', 'failed', 'posted', 'session_answer'].filter((k) => has(body, k));
  const cost = body.cost === undefined || body.cost === null ? 0 : body.cost;
  if (kinds.length !== 1 || !(typeof cost === 'number' && Number.isFinite(cost) && cost >= 0 && cost < 100)) return bad(QNEWS_400);
  const owner = OWNERS.includes(q.asker), at = now(), kind = kinds[0];
  const wrong = () => send(409, `this question is ${q.status}\n`);
  if (kind === 'answer') {
    const answer = cleanText(body.answer), pages = body.pages === undefined || body.pages === null ? [] : body.pages;
    const line = (v) => v === undefined || v === null ? null : typeof v === 'string' && v.trim() && v.length <= 300 && !/[\n\r]/.test(v) ? v.trim() : false;
    const hand = line(body.hand_on), why0 = body.why === undefined || body.why === null ? null : cleanText(body.why);
    if (!answer || !Array.isArray(pages) || pages.length > 200 || !pages.every((p) => Number.isInteger(p) && p >= 1) || hand === false ||
        why0 === null && !(body.why === undefined || body.why === null) || (why0 && why0.length > 2000) || !Q_MODELS.includes(body.model)) {
      return bad(QNEWS_400);
    }
    if (q.route !== 'quick' || !['queued', 'answering'].includes(q.status)) return wrong();
    // a hand-on only for the owner's question and while the session limit allows
    let status = 'answered', why = why0, handed = null;
    if (hand && owner) {
      if ((await sessionsToday(env, q.asker)) < Q_SESSION_DAY) { status = 'handed_on'; handed = hand; }
      else why = `Not handed to the library session: today's limit of ${Q_SESSION_DAY} was reached.`;
    }
    await env.DB.prepare('UPDATE questions SET status = ?, answer = ?, pages = ?, why = ?, handed = ?, handed_at = ?, model = ?, ' +
      'cost = coalesce(cost, 0) + ?, answered = ?, updated = ?, error = NULL WHERE id = ?')
      .bind(status, answer, JSON.stringify(pages), why, handed, handed ? at : null, body.model, cost, at, at, id).run();
  } else if (kind === 'failed') {
    if (!Q_FAILS.includes(body.failed)) return bad(QNEWS_400);
    if (q.route !== 'quick' || !['queued', 'answering'].includes(q.status)) return wrong();
    await env.DB.prepare("UPDATE questions SET status = 'failed', error = ?, cost = coalesce(cost, 0) + ?, updated = ? WHERE id = ?")
      .bind(body.failed, cost, at, id).run();
  } else if (kind === 'posted') {
    if (body.posted !== true) return bad(QNEWS_400);
    if (!owner || !['with_session', 'handed_on'].includes(q.status)) return wrong();
    if (!q.posted) await env.DB.prepare('UPDATE questions SET posted = ?, updated = ? WHERE id = ?').bind(at, at, id).run();
  } else {
    const a = cleanText(body.session_answer);
    if (!a || a.length > 4000) return bad(QNEWS_400);
    if (!owner || !['with_session', 'handed_on'].includes(q.status)) return wrong();
    await env.DB.prepare("UPDATE questions SET status = 'answered', session_answer = ?, answered = ?, updated = ? WHERE id = ?")
      .bind(a, at, at, id).run();
    // api.md: "The site sets unread when a session answer lands on the note (a session question, or a hand-on's answer)"
    await env.DB.prepare('UPDATE notes SET unread = 1 WHERE viewer = ? AND number = ? AND thread = ? AND deleted IS NULL')
      .bind(q.asker, q.number, q.thread).run();
  }
  const x = await getQuestion(env, id);
  return json({ id, status: x.status, posted: !!x.posted });
}

// ── NOTES on the PDF (docs/library-chat/api.md, Notes on the PDF) ──────────────────────────────────────────────

const N_KINDS = ['comment', 'ask'];
const N_TEXT_MAX = 2000;
const N_RECT = { min: 12, max: 2000 };   // a box's w and h at least, and the page's extent it stays inside
// the register's revision letters, as cc-docs counts them: bijective base 24, I and O skipped
const LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const NOTE_400 = `kind: comment or ask; route: quick or session, an ask's only; text: 1-${N_TEXT_MAX} characters; rev: a revision ` +
  'letter or none; and one anchor: {p, block?, quote} (text), {p, rect: [x, y, w, h], boxText?} (a box: w and h at least 12, ' +
  'inside 0..2000) or {general: true}; quote and boxText at most 2000 characters';
const VIEW_400 = 'one or more of unread: true or false; cardPos: {x, y} or null; cardSize: {w, h} or null; block (a text note\'s); ' +
  'rect: [x, y, w, h] and boxText (a box note\'s)';

/** The letter after rev: A -> B, H -> J, Z -> AA. */
function nextRev(rev) {
  let i = 0;
  for (const c of rev) i = i * LETTERS.length + LETTERS.indexOf(c) + 1;
  let s = '';
  for (i += 1; i > 0; i = Math.floor((i - 1) / LETTERS.length)) s = LETTERS[(i - 1) % LETTERS.length] + s;
  return s;
}
/** A note's block: a whole number or a short name the page gives it; null for none; undefined for anything else. */
function noteBlock(v) {
  if (v === undefined || v === null) return null;
  if (Number.isInteger(v) && v >= 0 && v < 1e6) return v;
  return typeof v === 'string' && v.length <= 200 && v.trim() && !/[\u0000-\u001f\u007f]/.test(v) ? v : undefined;
}
/** A box: [x, y, w, h] in PDF points from the page's top left, w and h at least 12, inside 0..2000; else undefined. */
function noteRect(v) {
  if (!Array.isArray(v) || v.length !== 4 || !v.every((x) => typeof x === 'number' && Number.isFinite(x))) return undefined;
  const [x, y, w, h] = v;
  return x >= 0 && y >= 0 && w >= N_RECT.min && h >= N_RECT.min && x + w <= N_RECT.max && y + h <= N_RECT.max ? v : undefined;
}
/** A quote or a box's text: at most 2000 characters; null for none; undefined for anything else. */
function noteQuote(v) {
  if (v === undefined || v === null || v === '') return null;
  const s = cleanText(v);
  return s && s.length <= N_TEXT_MAX ? s : undefined;
}
/** The anchor a note is made with, as the handoff shapes it: text {p, block?, quote}, a box {p, rect, boxText?} or
 *  {general: true}; each field the note keeps, the absent ones null; undefined for anything else. */
function noteAnchor(body) {
  const block = noteBlock(body.block), quote = noteQuote(body.quote), boxText = noteQuote(body.boxText);
  const hasRect = body.rect !== undefined && body.rect !== null, rect = hasRect ? noteRect(body.rect) : null;
  const hasP = body.p !== undefined && body.p !== null, p = body.p;
  if (block === undefined || quote === undefined || boxText === undefined || rect === undefined ||
      !(body.general === undefined || body.general === null || typeof body.general === 'boolean')) return undefined;
  if (body.general === true) {
    return hasP || hasRect || quote || boxText || block !== null ? undefined
      : { p: null, block: null, quote: null, rect: null, boxText: null, general: true };
  }
  if (!Number.isInteger(p) || p < 1 || p > 100000) return undefined;
  if (rect) return quote || block !== null ? undefined : { p, block: null, quote: null, rect, boxText, general: false };
  return !quote || boxText ? undefined : { p, block, quote, rect: null, boxText: null, general: false };
}
/** The anchor a note's question or feedback item carries. A text note's quote places it, so its rect is all zeros. */
function anchorOfNote(x) {
  if (x.general) return null;
  const rect = parseJSON(x.rect, null);
  if (rect) {
    // api.md: "A box note's anchor goes to the question or feedback item as {in: 'pdf', page, rect: [x0, y0, x1, y1],
    // quote: boxText, box: true}"
    const [x0, y0, w, h] = rect;
    return { in: 'pdf', page: x.p, rect: [x0, y0, x0 + w, y0 + h], ...(x.box_text ? { quote: x.box_text } : {}), box: true };
  }
  return { in: 'pdf', page: x.p, rect: [0, 0, 0, 0], quote: x.quote };
}

/** What an ask came to, per api.md: each follow-up as {t: 'q'}, and per question what it came to, in order. */
function askItems(qs, qid) {
  const items = [];
  for (const q of qs) {
    if (q.id !== qid) items.push({ t: 'q', id: q.id, text: q.text, route: q.route, time: q.created });
    const quick = { t: 'a', id: q.id, model: q.model, text: q.answer, pages: parseJSON(q.pages, []), time: q.handed_at || q.answered };
    const session = { t: 'a', id: q.id, model: 'session', text: q.session_answer, pages: [], time: q.answered };
    if (q.status === 'failed') items.push({ t: 'fail', id: q.id, error: q.error || 'error' });
    else if (q.handed) {
      // the quick answer stands, the hand-on, then the session's answer when it comes
      items.push(quick, { t: 'hand', id: q.id, why: q.handed, time: q.handed_at });
      items.push(q.session_answer ? session : { t: 'wait', id: q.id, route: 'session', since: q.handed_at });
    } else if (q.status === 'answered') items.push(q.route === 'session' ? session : quick);
    else items.push({ t: 'wait', id: q.id, route: q.route, since: q.created });
  }
  return items;
}
/** A note as the page reads it: its own fields, and status and items derived now from the questions or feedback items
 *  it made. Its viewer and whether it was deleted stay here. */
async function noteOut(env, x) {
  const out = { id: x.id, n: x.n, kind: x.kind, route: x.route || null, p: x.p ?? null, block: parseJSON(x.block, null),
    quote: x.quote || null, rect: parseJSON(x.rect, null), boxText: x.box_text || null, general: !!x.general, text: x.text,
    time: x.created, unread: !!x.unread, extra: x.extra || null, answeredBy: x.answered_by || null,
    passageChanged: !!x.passage_changed, carriedFrom: x.carried_from || null, cardPos: parseJSON(x.card_pos, null),
    cardSize: parseJSON(x.card_size, null), qid: x.qid || null, thread: x.thread || null, fid: x.fid || null, status: null, items: [] };
  if (x.kind === 'ask') {
    // the viewer's own questions in the note's thread: the note's own asker is its viewer
    const qs = await rows(env, 'SELECT * FROM questions WHERE asker = ? AND number = ? AND thread = ? ORDER BY created, rowid',
      x.viewer, x.number, x.thread);
    const first = qs.find((q) => q.id === x.qid);
    out.status = first ? first.status : null;
    out.items = askItems(first ? [first, ...qs.filter((q) => q !== first)] : qs, x.qid);
  } else {
    const f = await env.DB.prepare(FB_SELECT + ' WHERE id = ?').bind(x.fid).first();
    out.status = f ? f.status || 'new' : null;
    for (const fid of parseJSON(x.adds, [])) {
      const a = await env.DB.prepare(FB_SELECT + ' WHERE id = ?').bind(fid).first();
      if (a) out.items.push({ t: 'add', fid: a.id, text: a.text, time: a.created });
    }
  }
  return out;
}
const getNote = (env, id) => env.DB.prepare('SELECT * FROM notes WHERE id = ?').bind(id).first();
/** The caller's own note, not deleted, on a revision they may still open; else null. */
async function ownNote(env, reg, viewer, id) {
  const x = await getNote(env, id);
  // api.md: "A note belongs to its viewer: another viewer's note id is 404, the owner's included"
  if (!x || x.deleted || x.viewer !== viewer.email) return null;
  // api.md: "`rev` is checked with `openable()`"
  return ((await askable(env, reg, viewer, x.number)) || []).some((r) => r.rev === x.rev) ? x : null;
}
/** A new note row on num at rev, numbered after the viewer's others there. INSERT ... SELECT takes n in one step. */
function noteInsert(env, x) {
  return env.DB.prepare('INSERT OR IGNORE INTO notes (id, viewer, number, rev, n, kind, route, p, block, quote, rect, box_text, ' +
    'general, text, created, unread, extra, answered_by, passage_changed, carried_from, carried_of, qid, thread, fid, adds) ' +
    'SELECT ?, ?, ?, ?, coalesce(max(n), 0) + 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? FROM notes ' +
    'WHERE viewer = ? AND number = ? AND rev = ?')
    .bind(x.id, x.viewer, x.number, x.rev, x.kind, x.route, x.p, x.block, x.quote, x.rect, x.box_text, x.general, x.text,
      x.created, x.unread, x.extra, x.answered_by, x.passage_changed, x.carried_from, x.carried_of, x.qid, x.thread, x.fid,
      x.adds, x.viewer, x.number, x.rev);
}

// the round: the next revision in the background

const MK_SELECT = 'SELECT number, from_rev, to_rev, phase, sent_at, carried, carried_n FROM making';
/** The document's round, a working one turned ready once the register holds its `to`, or null. */
async function roundOf(env, reg, num) {
  const m = await env.DB.prepare(MK_SELECT + ' WHERE number = ?').bind(num).first();
  // api.md: "The round is ready once the register holds to (checked on each read)"
  if (m && m.phase === 'working' && revOf(reg, num, m.to_rev)[1]) {
    await env.DB.prepare("UPDATE making SET phase = 'ready' WHERE number = ? AND to_rev = ? AND phase = 'working'").bind(num, m.to_rev).run();
    m.phase = 'ready';
  }
  return m;
}
const makingOut = (m) => (m ? { from: m.from_rev, to: m.to_rev, phase: m.phase, sentAt: m.sent_at, carried: !!m.carried } : null);
/** The owner's comment on num at rev, or his sent draft: a round starts when none is working (-> null); while one is,
 *  -> its `to`, which the comment carries as extra. The upsert changes a row only where no round is working, so two
 *  comments at once start one round. */
async function roundStart(env, reg, num, rev) {
  const d = reg.documents[num];
  if (!d || !newest(d)) return null;
  await roundOf(env, reg, num);
  // api.md: "from the comment's revision, to the letter after the register's newest revision, phase: 'working', sentAt the time"
  const took = await env.DB.prepare("INSERT INTO making (number, from_rev, to_rev, phase, sent_at) VALUES (?, ?, ?, 'working', ?) " +
    "ON CONFLICT(number) DO UPDATE SET from_rev = excluded.from_rev, to_rev = excluded.to_rev, phase = 'working', " +
    "sent_at = excluded.sent_at, carried = NULL, carried_n = NULL WHERE making.phase <> 'working'")
    .bind(num, rev, nextRev(newest(d).rev), now()).run();
  if (took && took.meta && took.meta.changes) return null;
  const m = await env.DB.prepare(MK_SELECT + ' WHERE number = ?').bind(num).first();
  return m ? m.to_rev : null;
}
/** A comment of the owner's as a feedback item: kind request for a note, or what POST .../feedback sent. */
async function fileComment(env, reg, { number, rev, section = null, kind = 'request', text, anchor }) {
  // api.md: "A comment made while a round is working is extra: to. Its feedback item carries extra too"
  const extra = await roundStart(env, reg, number, rev);
  const x = { id: randomHex(4), number, rev, section, kind, text, created: now(), status: 'new', reply: null, answered_rev: null,
    anchor: anchor ? JSON.stringify(anchor) : null, extra };
  await env.DB.prepare('INSERT INTO feedback (id, number, rev, section, kind, text, created, status, anchor, extra) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(x.id, x.number, x.rev, x.section, x.kind, x.text, x.created, x.status, x.anchor, x.extra).run();
  return fbOut(x);
}

// the page's routes

/** GET /api/documents/<N>/notes[?rev=R] and /api/documents/<N>/making. */
async function notesGet(env, reg, viewer, path, url) {
  let m;
  // api.md: "Guests and anyone else: POST the generic 403, GET 404"
  const open = await askable(env, reg, viewer, (path.match(R.notes) || path.match(R.making))[1]);
  if (!open) return notFound();
  if ((m = path.match(R.making))) {
    // api.md: "owner only; a member's making is always null"
    return json({ number: m[1], making: viewer.owner ? makingOut(await roundOf(env, reg, m[1])) : null });
  }
  m = path.match(R.notes);
  const rev = url.searchParams.get('rev');
  if (rev !== null && !new RegExp(`^${REV}$`).test(rev)) return bad('rev: a revision letter');
  const r = rev ? open.find((x) => x.rev === rev) : open[open.length - 1];
  if (!r) return notFound();
  await expireQuestions(env);
  // api.md: "the list holds only the caller's own"
  const list = await rows(env, 'SELECT * FROM notes WHERE viewer = ? AND number = ? AND rev = ? AND deleted IS NULL ORDER BY n',
    viewer.email, m[1], r.rev);
  return json({ number: m[1], rev: r.rev, notes: await Promise.all(list.map((x) => noteOut(env, x))) });
}

/** POST /api/documents/<N>/notes, /api/notes/<id>, /api/notes/<id>/reply and /delete. */
async function notesWrite(env, reg, viewer, path, body) {
  // api.md: "Guests and anyone else: POST the generic 403"
  if (!viewer.owner && viewer.role !== 'member') return send(403, 'only the owner can change this\n');
  let m;
  if ((m = path.match(R.notes))) return newNote(env, reg, viewer, m[1], body);
  m = path.match(R.note);
  const x = await ownNote(env, reg, viewer, m[1]);
  if (!x) return notFound();
  if (m[2] === 'delete') {
    // api.md: "Delete hides the note from its viewer. The feedback items and questions it made stand, and still count."
    await env.DB.prepare('UPDATE notes SET deleted = ? WHERE id = ? AND deleted IS NULL').bind(now(), x.id).run();
    return json({ id: x.id, deleted: true });
  }
  if (m[2] === 'reply') return noteReply(env, reg, viewer, x, body);
  return noteView(env, x, body);
}

async function newNote(env, reg, viewer, num, body) {
  if (!N_KINDS.includes(body.kind)) return bad(NOTE_400);
  const ask = body.kind === 'ask';
  const route = ask ? (body.route === undefined || body.route === null ? 'quick' : body.route) : body.route;
  // api.md: "a member makes asks only (a comment is 403, route: session is 403"
  if (!viewer.owner && (!ask || route === 'session')) return send(403, `only the owner can ${ask ? 'ask the library session' : 'comment'}\n`);
  const open = await askable(env, reg, viewer, num);
  if (!open) return notFound();
  const a = noteAnchor(body), text = cleanText(body.text);
  if (a === undefined || !text || text.length > N_TEXT_MAX || (ask ? !['quick', 'session'].includes(route) : !(route === undefined || route === null)) ||
      !(body.rev === undefined || body.rev === null || (typeof body.rev === 'string' && new RegExp(`^${REV}$`).test(body.rev)))) {
    return bad(NOTE_400);
  }
  // api.md: "`rev` is checked with `openable()`"
  const r = body.rev ? open.find((x) => x.rev === body.rev) : open[open.length - 1];
  if (!r) return notFound();
  const x = { id: randomHex(4), viewer: viewer.email, number: num, rev: r.rev, kind: body.kind, route: ask ? route : null, p: a.p,
    block: a.block === null ? null : JSON.stringify(a.block), quote: a.quote, rect: a.rect ? JSON.stringify(a.rect) : null,
    box_text: a.boxText, general: a.general ? 1 : 0, text, created: now(), unread: 0, extra: null, answered_by: null,
    passage_changed: 0, carried_from: null, carried_of: null, qid: null, thread: null, fid: null, adds: null };
  if (ask) {
    // the question's own checks and limits: a 403, 404 or 429 there is the answer, and no note is made
    const res = await askQuestion(env, reg, viewer, num, { text, rev: r.rev, route }, anchorOfNote(x));
    if (res.status !== 200) return res;
    const q = await res.json();
    x.qid = q.id;
    x.thread = q.thread;
  } else {
    const f = await fileComment(env, reg, { number: num, rev: r.rev, text, anchor: anchorOfNote(x) });
    x.fid = f.id;
    x.extra = f.extra;
  }
  await noteInsert(env, x).run();
  return json(await noteOut(env, await getNote(env, x.id)), 201);
}

/** An ask's follow-up question in its thread, or an addition to a comment: a feedback item of its own at the note's
 *  anchor, which starts or rides a round as a comment does. */
async function noteReply(env, reg, viewer, x, body) {
  const text = cleanText(body.text);
  if (x.kind === 'ask') {
    const route = body.route === undefined || body.route === null ? 'quick' : body.route;
    // api.md: "a reply's route: session is 403"
    if (route === 'session' && !viewer.owner) return send(403, 'only the owner can ask the library session\n');
    if (!['quick', 'session'].includes(route) || !text || text.length > N_TEXT_MAX) return bad(`text: 1-${N_TEXT_MAX} characters; route: quick or session`);
    const res = await askQuestion(env, reg, viewer, x.number, { text, rev: x.rev, route, thread: x.thread }, anchorOfNote(x));
    if (res.status !== 200) return res;
  } else {
    if (!(body.route === undefined || body.route === null) || !text || text.length > N_TEXT_MAX) return bad(`text: 1-${N_TEXT_MAX} characters, and no route`);
    const f = await fileComment(env, reg, { number: x.number, rev: x.rev, text, anchor: anchorOfNote(x) });
    // json_insert appends in one statement, so two additions at once both stay
    await env.DB.prepare("UPDATE notes SET adds = json_insert(coalesce(adds, '[]'), '$[#]', ?) WHERE id = ?").bind(f.id, x.id).run();
  }
  return json(await noteOut(env, await getNote(env, x.id)));
}

/** The page's own view state. It changes the note only: a comment already sent keeps what it sent. */
async function noteView(env, x, body) {
  const keys = ['unread', 'cardPos', 'cardSize', 'block', 'rect', 'boxText'].filter((k) => has(body, k));
  const pair = (v, a, b, pos) => v === null || (v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 2 &&
    [v[a], v[b]].every((n) => typeof n === 'number' && Number.isFinite(n) && (pos ? n > 0 : true)));
  const box = !!x.rect, text = !!x.quote && !box;
  const set = {};
  if (has(body, 'unread')) set.unread = typeof body.unread === 'boolean' ? (body.unread ? 1 : 0) : undefined;
  if (has(body, 'cardPos')) set.card_pos = pair(body.cardPos, 'x', 'y', false) ? (body.cardPos ? JSON.stringify(body.cardPos) : null) : undefined;
  if (has(body, 'cardSize')) set.card_size = pair(body.cardSize, 'w', 'h', true) ? (body.cardSize ? JSON.stringify(body.cardSize) : null) : undefined;
  if (has(body, 'block')) { const b = text ? noteBlock(body.block) : undefined; set.block = b === undefined ? undefined : b === null ? null : JSON.stringify(b); }
  if (has(body, 'rect')) { const r = box ? noteRect(body.rect) : undefined; set.rect = r ? JSON.stringify(r) : undefined; }
  if (has(body, 'boxText')) set.box_text = box ? noteQuote(body.boxText) : undefined;
  if (!keys.length || Object.values(set).some((v) => v === undefined)) return bad(VIEW_400);
  const cols = Object.keys(set);
  await env.DB.prepare(`UPDATE notes SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`).bind(...cols.map((c) => set[c]), x.id).run();
  return json(await noteOut(env, await getNote(env, x.id)));
}

// the box's side: carrying a ready round's notes onto its new revision

/** GET /api/editor/carry: each ready round not yet carried, with its text notes (a quote and no rect) to re-find. */
async function carryRounds(env, reg) {
  const out = [];
  for (const { number } of await rows(env, 'SELECT number FROM making WHERE carried IS NULL ORDER BY sent_at, number')) {
    const m = await roundOf(env, reg, number);
    if (!m || m.phase !== 'ready' || m.carried) continue;
    const notes = await rows(env, 'SELECT id, p, quote FROM notes WHERE number = ? AND rev = ? AND deleted IS NULL AND ' +
      'quote IS NOT NULL AND rect IS NULL ORDER BY viewer, n', number, m.from_rev);
    out.push({ number, from: m.from_rev, to: m.to_rev, notes });
  }
  return out;
}
/** POST /api/editor/carry/<N>/<to> {found}: every viewer's notes on `from`, each copied to the same viewer on `to`.
 *  A text note moves to the page found for it; one found nowhere, or not in `found`, keeps its page, passage changed. */
async function carryNotes(env, reg, num, to, body) {
  const m = await roundOf(env, reg, num);
  if (!m || m.to_rev !== to) return notFound();
  // api.md: "a second call is 200 and changes nothing"
  if (m.carried) return json({ number: num, to, carried: m.carried_n || 0 });
  if (m.phase !== 'ready') return send(409, `the round making ${num}-${to} is still working\n`);
  const found = body.found === undefined ? {} : body.found;
  if (!found || typeof found !== 'object' || Array.isArray(found) || !Object.entries(found).every(([k, v]) =>
    new RegExp(`^${HEX}$`).test(k) && (v === null || (Number.isInteger(v) && v >= 1 && v <= 100000)))) {
    return bad('found: {note id: a page, or null where the quote was not found}');
  }
  const src = await rows(env, 'SELECT * FROM notes WHERE number = ? AND rev = ? AND deleted IS NULL ORDER BY viewer, n', num, m.from_rev);
  const at = now(), st = [];
  for (const x of src) {
    // api.md: "Every viewer's notes are carried, each to the same viewer"; "cardPos and cardSize cleared, and the same qid/thread/fid"
    const c = { ...x, id: randomHex(4), rev: to, carried_from: m.from_rev, carried_of: x.id, passage_changed: 0 };
    if (x.kind === 'comment') c.answered_by = to;
    if (x.quote && !x.rect) {
      const page = has(found, x.id) ? found[x.id] : null;
      if (page) { c.p = page; c.block = null; } else c.passage_changed = 1;
    }
    st.push(noteInsert(env, c));
  }
  st.push(env.DB.prepare('UPDATE making SET carried = ?, carried_n = ? WHERE number = ? AND to_rev = ? AND carried IS NULL')
    .bind(at, src.length, num, to));
  await env.DB.batch(st);
  const after = await env.DB.prepare(MK_SELECT + ' WHERE number = ?').bind(num).first();
  return json({ number: num, to, carried: after ? after.carried_n || 0 : 0 });
}

// ── requests ──────────────────────────────────────────────────────────────────────────────────────────────────

async function readBody(request, limit = 8192) {
  // a JSON body only: a cross-site form cannot send one without a preflight nothing here answers
  if ((request.headers.get('Content-Type') || '').split(';')[0].trim() !== 'application/json') {
    throw new Denied('application/json only', 415);
  }
  const text = await request.text();
  if (!text || text.length > limit) throw new Denied(`a JSON body of at most ${limit >> 10} KB`, 400);
  try {
    const v = JSON.parse(text);
    if (v && typeof v === 'object' && !Array.isArray(v)) return v;
  } catch (e) { /* falls through */ }
  throw new Denied('a JSON object', 400);
}

function cleanName(v) {
  if (typeof v !== 'string') return null;
  const s = v.split(/\s+/).join(' ').trim();
  return s && s.length <= 80 && !/[\u0000-\u001f\u007f]/.test(s) ? s : null;
}
/** A one-line description: whitespace folded, at most 200 characters; '' for none; null for one that cannot be. */
function cleanDesc(v) {
  if (v === null || v === '') return '';
  if (typeof v !== 'string') return null;
  const s = v.split(/\s+/).join(' ').trim();
  return s.length <= 200 && !/[\u0000-\u001f\u007f]/.test(s) ? s : null;
}
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

const LINK_400 = 'target: {number, rev|null} or {package}; kind: public, private or signed-in (a signed-in link targets a ' +
  'document); state: live, disabled or archived; name: 1-80 printable characters, or none; people: emails; groups: group ids';

/** The signed-out and private link paths: a document link answers its PDF, a package link its page or one of its
 *  documents at the revision it pins. */
async function serveLink(env, reg, origin, l, token, prefix, sub, head) {
  const legacy = prefix === 'k';
  if (!l.package) {
    // a document's link is not a package: /p/<token>/<N> and /k/ are 404
    if (legacy || sub !== undefined) return notFound(head);
    const [d, r] = target(reg, l);
    return r ? pdf(env, origin, r, docName(l.number, d, r, TITLE_ONLY), head) : notFound(head);
  }
  const p = await env.DB.prepare('SELECT id, name, settings FROM packages WHERE id = ?').bind(l.package).first();
  if (!p) return notFound(head);
  const prow = await packageRows(env, p.id);
  if (sub === undefined) {
    return send(200, packagePage(p, reg, prow, await descriptions(env), `/${prefix}/${token}`, legacy), 'text/html; charset=utf-8',
      { 'Content-Security-Policy': PKG_CSP }, head);
  }
  // only a document in that package, and only at the revision it pins
  const x = prow.docs.find((y) => y.number === sub);
  const [d, r] = x ? target(reg, x) : [null, null];
  return r ? pdf(env, origin, r, docName(sub, d, r, settingsOf(p)), head) : notFound(head);
}

export async function handle(request, env) {
  const url = new URL(request.url);
  const origin = url.origin;
  const path = url.pathname;
  const head = request.method === 'HEAD';
  try {
    if (request.method !== 'GET' && !head && request.method !== 'POST') return send(405, 'method not allowed\n');
    const reg = await register(env, origin);
    await ensure(env, reg);
    await rekey(env, reg);

    // ── signed out: /p/ and /k/, each reaching only what its own public token was made for ──
    // brief: "No change to what signed-out paths expose: only /p/ and /k/, each reaching only what it was made for"
    let m;
    if ((m = path.match(R.pub))) {
      if (request.method === 'POST') return notFound();
      const l = await linkByToken(env, m[1]);
      if (!l || !l.live || kindOf(l) !== 'public' || l.package) return notFound(head);
      const [d, r] = target(reg, l);
      if (!r) return notFound(head);
      // a link minted before links could move: where it still points, its PDF; repointed, the link's own address
      if (l.number !== m[2] || r.rev !== m[3]) return send(302, '', undefined, { Location: `/p/${m[1]}` }, head);
      return pdf(env, origin, r, docName(m[2], d, r, TITLE_ONLY), head);
    }
    const tm = path.match(R.tok) || path.match(R.tokDoc) || path.match(R.pkg) || path.match(R.pkgFile);
    if (tm && tm[1] !== 's') {
      if (request.method === 'POST') return notFound();
      const l = await linkByToken(env, tm[2]);
      if (!l || !l.live || kindOf(l) !== 'public') return notFound(head);
      return serveLink(env, reg, origin, l, tm[2], tm[1], tm[3], head);
    }

    // ── everything else only after the JWT has said who it is ──
    if (path === '/api/courses/readers' && request.method !== 'POST') return json(await courseReaders(request, env, reg));
    if (R.fbAny.test(path)) return await feedbackExport(request, env, path, url, head);
    if (R.edAny.test(path)) return await editorBox(request, env, reg, path, url);
    const claims = await verifiedClaims(request, env, Date.now() / 1000);
    if (namedToken(request, claims, env.LINK_MINT_TOKENS)) return await mintLink(request, env, reg, origin, path, claims);
    if (typeof claims.email !== 'string' || !claims.email.includes('@')) throw new Denied('an Access assertion with no email');
    const viewer = await viewerFor(claims.email.trim().toLowerCase(), env);

    if (request.method !== 'POST') {
      if (tm) {
        // a private link: only to a person it names or a member of a group it names; to anyone else, as unknown
        const l = await linkByToken(env, tm[2]);
        if (!l || !l.live || kindOf(l) !== 'private' || !(await onLink(env, viewer, l))) return notFound(head);
        return serveLink(env, reg, origin, l, tm[2], 's', tm[3], head);
      }
      if ((m = path.match(R.signed))) {
        // a signed-in link: the file's own address, which enforces the viewer's own access; 404 where it would
        const l = await linkByToken(env, m[1]);
        if (!l || !l.live || kindOf(l) !== 'signed-in' || l.package) return notFound(head);
        const [d, r] = target(reg, l);
        if (!r || !(await openable(env, reg, viewer, l.number)).includes(r)) return notFound(head);
        return send(302, '', undefined, { Location: fileUrl(l.number, d, r) }, head);
      }
      const code = path.match(R.vendor) || path.match(/^\/(?:app|editor|notes|notes-api)\.(js)$|^\/(?:style|editor)\.(css)$/);
      if (STATIC[path] || R.font.test(path) || R.vendor.test(path)) {
        const res = await env.ASSETS.fetch(new Request(origin + (STATIC[path] || path)));
        if (!res.ok) return notFound(head);
        const type = code ? CODE_TYPES[code[1] || code[2]] : res.headers.get('Content-Type') || 'application/octet-stream';
        const extra = type.startsWith('text/html') ? { 'Content-Security-Policy': CSP, 'X-Frame-Options': 'SAMEORIGIN' } : {};
        return send(200, head ? null : res.body, type, extra, head);
      }
      if (path === '/api/library') return json(await library(env, reg, viewer, origin));
      // the owner's alone; to anyone else they answer as paths that are not there
      if ((m = path.match(R.source))) {
        const [, r] = revOf(reg, m[1], m[2]);
        const rel = r && sourceOf(r);
        if (!viewer.owner || !rel) return notFound(head);
        const res = await fetchSource(env, origin, rel);
        if (!res) return notFound(head);
        return send(200, head ? null : res.body, 'application/gzip',
          { 'Content-Disposition': `attachment; filename="${m[1]}-${m[2]}-source.tar.gz"` }, head);
      }
      // EDITOR: every draft route is the owner's; anyone else is told of none
      if (R.drafts.test(path) || R.draftAny.test(path)) {
        if (!viewer.owner) return notFound(head);
        return await editorGet(env, reg, path, url, head);
      }
      // LIBRARY CHAT: the asker's own questions; the check is askable() and the asker
      if (R.qDoc.test(path) || R.qOne.test(path)) return await questionsGet(env, reg, viewer, path, url);
      // NOTES: the viewer's own notes, and the owner's round; the check is askable() and the viewer
      if (R.notes.test(path) || R.making.test(path)) return await notesGet(env, reg, viewer, path, url);
      if ((m = path.match(R.fbDoc))) {
        if (!viewer.owner || !reg.documents[m[1]]) return notFound(head);
        return json({ number: m[1], feedback: (await rows(env, FB_SELECT + ' WHERE number = ? ORDER BY created, id', m[1])).map(fbOut) });
      }
      if ((m = path.match(R.file))) {
        const [d, r] = revOf(reg, m[1], m[2]);
        // someone else's document, or a revision their links do not reach, answers as one that is not there
        if (!r || !(await openable(env, reg, viewer, m[1])).includes(r)) return notFound(head);
        return pdf(env, origin, r, docName(m[1], d, r, SIGNED_IN), head);
      }
      if ((m = path.match(R.doc))) {
        // the link a site carries: the same check as the file, then that file's address, never cached. A number
        // that moved answers for the number it moved to, with the same revision letter.
        const num = reg.documents[m[1]] ? m[1] : reg.movedTo[m[1]] || m[1];
        const open = await openable(env, reg, viewer, num);
        const r = m[2] ? open.find((x) => x.rev === m[2]) : open[open.length - 1];
        if (!r) return notFound(head);
        return send(302, '', undefined, { Location: fileUrl(num, reg.documents[num], r) }, head);
      }
      return notFound(head);
    }

    const origin_h = request.headers.get('Origin');
    if (origin_h && origin_h !== origin) return send(403, 'cross-origin write\n');
    // feedback may carry a section's worth of the owner's own words, a draft's save its files
    const body = await readBody(request, R.fbDoc.test(path) || R.qDoc.test(path) || R.notes.test(path) || R.note.test(path) ? 65536 : R.draftAny.test(path) || R.drafts.test(path) ? 8 << 20 : 8192);

    if ((m = path.match(R.star))) {
      if (!(await openable(env, reg, viewer, m[1])).length) return notFound();
      if (typeof body.starred !== 'boolean') return bad('starred: true or false');
      await env.DB.prepare(body.starred ? 'INSERT OR IGNORE INTO stars (viewer, number) VALUES (?, ?)'
        : 'DELETE FROM stars WHERE viewer = ? AND number = ?').bind(viewer.id, m[1]).run();
      return json({ number: m[1], starred: body.starred });
    }

    // LIBRARY CHAT: a member asks too (quick only); askQuestion refuses everyone else as below
    if ((m = path.match(R.qDoc))) return await askQuestion(env, reg, viewer, m[1], body);
    // NOTES: a member makes asks too; notesWrite refuses everyone else as below
    if (R.notes.test(path) || R.note.test(path)) return await notesWrite(env, reg, viewer, path, body);

    // brief: the owner edits everything; anyone else may only star
    if (!viewer.owner) return send(403, 'only the owner can change this\n');
    return await ownerWrite(env, reg, origin, path, body);
  } catch (e) {
    if (e instanceof Denied) return send(e.status, e.message + '\n', undefined, {}, head);
    throw e;
  }
}

/** A new live link, its people and groups, and its history line; answers the link as POST /api/links does. */
async function makeLink(env, origin, t, kind, name, people, grps, by = '') {
  const id = randomHex(4), token = randomToken(), at = now();
  await env.DB.batch([
    env.DB.prepare('INSERT INTO links (token, id, number, rev, package, name, created, kind, state, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)')
      .bind(token, id, t.number, t.rev, t.package, name, at, kind, at),
    ...people.map((e) => env.DB.prepare('INSERT OR IGNORE INTO link_people (link, email) VALUES (?, ?)').bind(id, e)),
    ...grps.map((g) => env.DB.prepare('INSERT OR IGNORE INTO link_groups (link, grp) VALUES (?, ?)').bind(id, g)),
    env.DB.prepare("INSERT INTO history (kind, id, at, what) VALUES ('link', ?, ?, ?)")
      .bind(id, at, `made ${kind} link to ${targetText(t)}` + (people.length ? `; people ${people.join(', ')}` : '') + by),
  ]);
  return { id, name, kind, state: 'live', url: linkUrl(origin, { token, kind }), target: targetOut(t), people, groups: grps, created: at };
}

/** A service token LINK_MINT_TOKENS names (the lessons site's build): POST /api/links {target: {number, rev: null},
 *  kind: 'signed-in', name?} and nothing else. It makes a following signed-in link to a document, or answers the live
 *  one of that name already on that document. Anything else from it is 403, an unknown document 404. /l/ checks the
 *  viewer's own access, so the link grants nothing and nothing here touches Access or who may see what. */
async function mintLink(request, env, reg, origin, path, claims) {
  const refuse = () => send(403, 'this token makes signed-in document links and nothing else\n');
  if (request.method !== 'POST' || !R.links.test(path)) return refuse();
  const origin_h = request.headers.get('Origin');
  if (origin_h && origin_h !== origin) return send(403, 'cross-origin write\n');
  const body = await readBody(request);
  const t = body.target;
  if (body.kind !== 'signed-in' || !t || typeof t !== 'object' || Array.isArray(t) || has(t, 'package') ||
      !(t.rev === undefined || t.rev === null) || has(body, 'people') || has(body, 'groups')) return refuse();
  if (typeof t.number !== 'string' || !reg.documents[t.number]) return notFound();
  const tt = await checkTarget(env, reg, { number: t.number, rev: null });
  if (!tt) return notFound();
  const name = await linkName(env, body, 'signed-in', tt);
  if (!name) return bad('name: 1-80 printable characters, or none');
  const pick = (l) => ({ id: l.id, name: l.name, kind: l.kind, state: l.state, url: l.url, target: l.target });
  const have = await env.DB.prepare(`SELECT l.id, l.token, l.name FROM links l WHERE l.kind = 'signed-in' AND l.number = ? ` +
    `AND l.rev IS NULL AND l.package IS NULL AND l.name = ? AND ${LIVE} ORDER BY l.created LIMIT 1`).bind(tt.number, name).first();
  if (have) {
    return json(pick({ ...have, kind: 'signed-in', state: 'live', url: linkUrl(origin, { token: have.token, kind: 'signed-in' }),
      target: targetOut(tt) }));
  }
  return json(pick(await makeLink(env, origin, tt, 'signed-in', name, [], [], ` by service token ${claims.common_name}`)));
}

/** Every write but a star: the owner's alone. */
async function ownerWrite(env, reg, origin, path, body) {
  let m;
  if (R.drafts.test(path) || R.draftAny.test(path)) return editorWrite(env, reg, origin, path, body);
  if (R.requests.test(path)) return newRequest(env, reg, body);
  if ((m = path.match(R.qEdit))) return questionEdit(env, m[1]);
  if ((m = path.match(R.fbDoc))) {
    const d = reg.documents[m[1]];
    if (!d) return notFound();
    const rev = body.rev === undefined || body.rev === null ? (newest(d) || {}).rev : body.rev;
    const section = body.section === undefined || body.section === null || body.section === '' ? '' : cleanDesc(body.section);
    const text = cleanText(body.text);
    const anchor = pdfAnchor(body.anchor);
    if (!revOf(reg, m[1], rev)[1] || section === null || !FB_KINDS.includes(body.kind) || !text || anchor === undefined) {
      return bad('rev: one of its revisions, or none for the newest; section: one line of at most 200 characters, or none ' +
        'for the whole document; kind: text or request; text: 1-20000 characters; anchor: {in: "pdf", page, rect: [x0, y0, x1, y1], ' +
        'quote?} or none');
    }
    // NOTES: the owner's comment starts a round, or rides the working one as its extra
    return json(await fileComment(env, reg, { number: m[1], rev, section: section || null, kind: body.kind, text, anchor }));
  }
  if ((m = path.match(R.desc))) {
    // brief item 15: "every document has a one-line description … which the owner edits on the document page"
    if (!reg.documents[m[1]]) return notFound();
    const desc = cleanDesc(body.description);
    if (desc === null) return bad('description: one line of at most 200 printable characters, or "" for none');
    await (desc ? env.DB.prepare('INSERT OR REPLACE INTO doc_meta (number, description) VALUES (?, ?)').bind(m[1], desc)
      : env.DB.prepare('DELETE FROM doc_meta WHERE number = ?').bind(m[1])).run();
    return json({ number: m[1], description: desc || null });
  }

  if (R.links.test(path)) {
    const kind = body.kind === undefined ? 'public' : body.kind;
    const t = await checkTarget(env, reg, body.target);
    const people = body.people === undefined ? [] : cleanPeople(body.people);
    const grps = body.groups === undefined ? [] : await cleanGroups(env, body.groups);
    if (!KINDS.includes(kind) || !t || (kind === 'signed-in' && t.package) || !people || !grps) return bad(LINK_400);
    const name = await linkName(env, body, kind, t);
    if (!name) return bad(LINK_400);
    const out = await makeLink(env, origin, t, kind, name, people, grps);
    return json(kind === 'private' ? { ...out, access: await syncAccess(env) } : out);
  }

  if ((m = path.match(R.link))) {
    const l = await env.DB.prepare('SELECT * FROM links WHERE id = ?').bind(m[1]).first();
    if (!l) return notFound();
    const lk = await lockWrite(env, 'links', 'link', l, body);
    if (lk) return lk;
    const fields = ['name', 'target', 'kind', 'state', 'people', 'groups'].filter((k) => has(body, k));
    if (!fields.length) return bad(LINK_400);
    const name = has(body, 'name') ? cleanName(body.name) : l.name;
    const t = has(body, 'target') ? await checkTarget(env, reg, body.target) : { number: l.number, rev: l.rev, package: l.package };
    const kind = has(body, 'kind') ? body.kind : kindOf(l);
    const state = has(body, 'state') ? body.state : stateOf(l);
    const people = has(body, 'people') ? cleanPeople(body.people) : null;
    const grps = has(body, 'groups') ? await cleanGroups(env, body.groups) : null;
    if (!name || !t || !KINDS.includes(kind) || !STATES.includes(state) || (kind === 'signed-in' && t.package) ||
        (has(body, 'people') && !people) || (has(body, 'groups') && !grps)) return bad(LINK_400);
    const what = [];
    if (name !== l.name) what.push(`renamed ${name}`);
    if (has(body, 'target') && targetText(t) !== targetText({ number: l.number, rev: l.rev, package: l.package })) what.push(`repointed to ${targetText(t)}`);
    if (kind !== kindOf(l)) what.push(`made ${kind}`);
    if (state !== stateOf(l)) what.push({ live: stateOf(l) === 'archived' ? 'restored' : 'enabled', disabled: 'disabled', archived: 'archived' }[state]);
    if (people) what.push(`people ${people.join(', ') || 'none'}`);
    if (grps) what.push(`groups ${grps.join(', ') || 'none'}`);
    const at = now();
    const st = [env.DB.prepare('UPDATE links SET name = ?, number = ?, rev = ?, package = ?, kind = ?, state = ?, updated = ? WHERE id = ?')
      .bind(name, t.number, t.rev, t.package, kind, state === 'live' ? null : state, at, m[1])];
    if (people) {
      st.push(env.DB.prepare('DELETE FROM link_people WHERE link = ?').bind(m[1]),
        ...people.map((e) => env.DB.prepare('INSERT INTO link_people (link, email) VALUES (?, ?)').bind(m[1], e)));
    }
    if (grps) {
      st.push(env.DB.prepare('DELETE FROM link_groups WHERE link = ?').bind(m[1]),
        ...grps.map((g) => env.DB.prepare('INSERT INTO link_groups (link, grp) VALUES (?, ?)').bind(m[1], g)));
    }
    if (what.length) st.push(env.DB.prepare("INSERT INTO history (kind, id, at, what) VALUES ('link', ?, ?, ?)").bind(m[1], at, what.join('; ')));
    await env.DB.batch(st);
    const out = { id: m[1], name, kind, state, url: linkUrl(origin, { token: l.token, kind }), target: targetOut(t),
      people: people || (await rows(env, 'SELECT email FROM link_people WHERE link = ? ORDER BY email', m[1])).map((x) => x.email),
      groups: grps || (await rows(env, 'SELECT grp FROM link_groups WHERE link = ? ORDER BY grp', m[1])).map((x) => x.grp) };
    // anything that can change who a private link admits re-runs the sync (brief item 18)
    const touches = kind === 'private' || kindOf(l) === 'private';
    return json(touches ? { ...out, access: await syncAccess(env) } : out);
  }

  if (R.pkgs.test(path)) {
    const name = cleanName(body.name);
    if (!name) return bad('a package’s name is 1-80 printable characters');
    // no token of its own: a package's addresses are its links (POST /api/links {target: {package}})
    const p = { id: randomHex(4), name, created: now(), settings: null, archived: null };
    await env.DB.batch([env.DB.prepare('INSERT INTO packages (id, name, created) VALUES (?, ?, ?)').bind(p.id, p.name, p.created),
      env.DB.prepare("INSERT INTO history (kind, id, at, what) VALUES ('package', ?, ?, ?)").bind(p.id, p.created, `made ${name}`)]);
    return json({ ...packageOut(p, [], []), history: [{ at: p.created, what: `made ${name}` }] });
  }
  const pkg = (id) => env.DB.prepare('SELECT id, name, created, settings, archived, locked FROM packages WHERE id = ?').bind(id).first();
  // LOCKS: a locked package's documents and folders are frozen with it
  const openPkg = async (id) => {
    const p = await pkg(id);
    if (p && p.locked) throw new Denied('this package is locked; unlock it before changing it', 409);
    return p;
  };
  if ((m = path.match(R.pkgOne))) {
    const p = await pkg(m[1]);
    if (!p) return notFound();
    const lk = await lockWrite(env, 'packages', 'package', p, body);
    if (lk) return lk;
    // brief: "rename a package"; the display toggles, booleans only; archive and restore (item 12)
    const name = body.name === undefined ? p.name : cleanName(body.name);
    const set = body.settings;
    const setOk = set === undefined || (set && typeof set === 'object' && !Array.isArray(set) &&
      Object.entries(set).every(([k, v]) => k in PKG_SETTINGS && typeof v === 'boolean'));
    const archOk = body.archived === undefined || typeof body.archived === 'boolean';
    if (!name || !setOk || !archOk || (body.name === undefined && set === undefined && body.archived === undefined)) {
      return bad('name: 1-80 printable characters; settings: {number, rev, date, note, collapsed} true or false; archived: true or false');
    }
    const settings = { ...settingsOf(p), ...(set || {}) };
    const archived = body.archived === undefined ? p.archived || null : body.archived ? p.archived || now() : null;
    const what = [];
    if (name !== p.name) what.push(`renamed ${name}`);
    if (!!archived !== !!p.archived) what.push(archived ? 'archived' : 'restored');
    await env.DB.prepare('UPDATE packages SET name = ?, settings = ?, archived = ? WHERE id = ?')
      .bind(name, JSON.stringify(settings), archived, m[1]).run();
    if (what.length) await history(env, 'package', m[1], what.join('; '));
    const out = { id: m[1], name, settings, archived };
    return json(!!archived !== !!p.archived ? { ...out, access: await syncAccess(env) } : out);
  }
  if ((m = path.match(R.pkgDocs))) {
    if (!(await openPkg(m[1]))) return notFound();
    const number = body.number;
    if (typeof number !== 'string' || !reg.documents[number] || typeof body.add !== 'boolean') {
      return bad('number: a document; add: true or false');
    }
    if (!body.add) {
      await env.DB.prepare('DELETE FROM package_docs WHERE package = ? AND number = ?').bind(m[1], number).run();
      return json({ package: m[1], number, add: false });
    }
    // brief: "pick a revision and add it to a package, or pick "most recent" which follows new revisions"; on a
    // document already in it, only the fields sent change
    const cur = await env.DB.prepare('SELECT rev, folder, desc_mode, description FROM package_docs WHERE package = ? AND number = ?')
      .bind(m[1], number).first() || {};
    const rev = has(body, 'rev') ? body.rev : cur.rev || null;
    const folder = has(body, 'folder') ? body.folder : cur.folder || null;
    const mode = has(body, 'desc_mode') ? body.desc_mode : cur.desc_mode || null;
    const desc = has(body, 'description') ? cleanDesc(body.description) : cur.description || '';
    const folderOk = folder === null || (typeof folder === 'string' &&
      await env.DB.prepare('SELECT id FROM package_folders WHERE id = ? AND package = ?').bind(folder, m[1]).first());
    if (!(rev === null || (typeof rev === 'string' && revOf(reg, number, rev)[1])) || !folderOk ||
        !(mode === null || DESC_MODES.includes(mode)) || desc === null) {
      return bad('rev: one of its revisions or null for the newest; folder: a folder of this package or null; ' +
        'desc_mode: doc, custom or none; description: one line of at most 200 characters');
    }
    await env.DB.prepare('INSERT OR REPLACE INTO package_docs (package, number, rev, folder, desc_mode, description) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(m[1], number, rev, folder, mode, desc || null).run();
    return json({ package: m[1], number, add: true, rev, folder, desc_mode: mode || 'doc', description: desc || null });
  }
  if ((m = path.match(R.folders)) || (m = path.match(R.folder))) {
    // brief item 14: "folders (categories) nested to any depth"
    if (!(await openPkg(m[1]))) return notFound();
    const folders = await rows(env, 'SELECT id, parent, name FROM package_folders WHERE package = ?', m[1]);
    const parentOk = (v) => v === null || v === undefined || (typeof v === 'string' && folders.some((f) => f.id === v));
    if (!m[2]) {
      const name = cleanName(body.name);
      if (!name || !parentOk(body.parent)) return bad('name: 1-80 printable characters; parent: a folder of this package or none');
      const id = randomHex(4);
      await env.DB.prepare('INSERT INTO package_folders (id, package, parent, name) VALUES (?, ?, ?, ?)').bind(id, m[1], body.parent || null, name).run();
      return json({ id, parent: body.parent || null, name });
    }
    const f = folders.find((x) => x.id === m[2]);
    if (!f) return notFound();
    if (body.delete === true) {
      // its documents and folders move up to its parent, so nothing in the package is lost
      await env.DB.batch([
        env.DB.prepare('UPDATE package_docs SET folder = ? WHERE package = ? AND folder = ?').bind(f.parent || null, m[1], f.id),
        env.DB.prepare('UPDATE package_folders SET parent = ? WHERE package = ? AND parent = ?').bind(f.parent || null, m[1], f.id),
        env.DB.prepare('DELETE FROM package_folders WHERE id = ?').bind(f.id)]);
      return json({ deleted: f.id });
    }
    const name = has(body, 'name') ? cleanName(body.name) : f.name;
    const parent = has(body, 'parent') ? body.parent : f.parent || null;
    // a folder cannot sit inside itself or its own descendants
    let cycle = false;
    for (let at = parent, steps = 0; at && !cycle && steps <= folders.length; steps++) {
      if (at === f.id) cycle = true;
      at = (folders.find((x) => x.id === at) || {}).parent || null;
    }
    if (!name || !parentOk(parent) || cycle || (!has(body, 'name') && !has(body, 'parent'))) {
      return bad('name: 1-80 printable characters; parent: another folder of this package, not inside this one, or null; or delete: true');
    }
    await env.DB.prepare('UPDATE package_folders SET name = ?, parent = ? WHERE id = ?').bind(name, parent || null, f.id).run();
    return json({ id: f.id, parent: parent || null, name });
  }

  if (R.groups.test(path)) {
    const name = cleanName(body.name);
    if (!name) return bad('a group’s name is 1-80 printable characters');
    const id = randomHex(4);
    await env.DB.prepare('INSERT INTO groups (id, name, created) VALUES (?, ?, ?)').bind(id, name, now()).run();
    return json({ id, name, members: [], grants: [] });
  }
  if ((m = path.match(R.group))) {
    const g = await env.DB.prepare('SELECT id, name, locked FROM groups WHERE id = ?').bind(m[1]).first();
    if (!g) return notFound();
    const lk = await lockWrite(env, 'groups', 'group', g, body);
    if (lk) return lk;
    if (body.delete === true) {
      // deleting it would take it off a locked link's groups, which the link's lock freezes
      if (await env.DB.prepare('SELECT 1 FROM link_groups lg JOIN links l ON l.id = lg.link WHERE lg.grp = ? AND l.locked = 1')
        .bind(m[1]).first()) throw new Denied('a locked link names this group; unlock the link before deleting it', 409);
      await env.DB.batch(['groups WHERE id', 'group_members WHERE grp', 'grants WHERE grp', 'link_groups WHERE grp']
        .map((w) => env.DB.prepare(`DELETE FROM ${w} = ?`).bind(m[1])));
      return json({ deleted: m[1], access: await syncAccess(env) });
    }
    const st = [];
    const name = has(body, 'name') ? cleanName(body.name) : g.name;
    let add = null, addName = null, remove = null;
    if (has(body, 'add')) {
      const a = typeof body.add === 'string' ? { email: body.add } : body.add || {};
      add = typeof a.email === 'string' ? a.email.trim().toLowerCase() : '';
      addName = a.name === undefined ? undefined : cleanName(a.name);
      if (!EMAIL.test(add) || OWNERS.includes(add) || addName === null) return bad('add: {email, name?}, an email that is not the owner');
    }
    if (has(body, 'remove')) {
      remove = typeof body.remove === 'string' ? body.remove.trim().toLowerCase() : '';
      if (!EMAIL.test(remove)) return bad('remove: an email');
    }
    if (has(body, 'grant') && !validNode(reg, body.grant)) return bad('grant: group:<name>, project:<PPP> or doc:<PPP-NNNN> the register has');
    if (has(body, 'revoke') && typeof body.revoke !== 'string') return bad('revoke: a node');
    if (!name || !['name', 'add', 'remove', 'grant', 'revoke'].some((k) => has(body, k))) {
      return bad('name, add, remove, grant, revoke or delete: true');
    }
    st.push(env.DB.prepare('UPDATE groups SET name = ? WHERE id = ?').bind(name, m[1]));
    if (add) {
      st.push(env.DB.prepare('INSERT OR IGNORE INTO group_members (grp, email) VALUES (?, ?)').bind(m[1], add));
      st.push(addName
        ? env.DB.prepare("INSERT INTO readers (email, name, projects) VALUES (?, ?, '') ON CONFLICT(email) DO UPDATE SET name = excluded.name").bind(add, addName)
        : env.DB.prepare("INSERT OR IGNORE INTO readers (email, name, projects) VALUES (?, ?, '')").bind(add, add.split('@')[0]));
    }
    if (remove) st.push(env.DB.prepare('DELETE FROM group_members WHERE grp = ? AND email = ?').bind(m[1], remove));
    if (has(body, 'grant')) st.push(env.DB.prepare('INSERT OR IGNORE INTO grants (grp, node) VALUES (?, ?)').bind(m[1], body.grant));
    if (has(body, 'revoke')) st.push(env.DB.prepare('DELETE FROM grants WHERE grp = ? AND node = ?').bind(m[1], body.revoke));
    await env.DB.batch(st);
    const dir = new Map((await rows(env, 'SELECT email, name FROM readers')).map((x) => [x.email, x.name]));
    const out = { id: m[1], name,
      members: (await rows(env, 'SELECT email FROM group_members WHERE grp = ? ORDER BY email', m[1]))
        .map((x) => ({ email: x.email, name: dir.get(x.email) || x.email.split('@')[0] })),
      grants: (await rows(env, 'SELECT node FROM grants WHERE grp = ? ORDER BY node', m[1])).map((x) => x.node) };
    return json(add || remove ? { ...out, access: await syncAccess(env) } : out);
  }
  return notFound();
}
