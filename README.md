# library

A document register (`cc-docs`) plus a small site that files against it and serves it, deployed as a
Cloudflare Pages project with a D1 database behind Cloudflare Access. This repo is the standalone export: clone
it, fill in your own config, and you have your own copy — nothing here points at anyone else's account, domain
or documents.

Three pieces:
- **`cc-docs`** — the register and filing command. It lives in [ihsan-sa/autobox](https://github.com/ihsan-sa/autobox)
  (`core/bin/cc-docs`), not in this repo, so you always get the current one.
- **`pages/`** — the site: three kinds of link (a signed-in reader's own view, a token link you mint for someone
  without an account, and a public link), plus an optional in-browser LaTeX editor.
- **`bin/library-mirror`** — the publish step. It reads what `cc-docs` has filed and pushes the site's static
  files plus the register and the PDFs to a git repo, which Cloudflare Pages deploys from.

## Try it locally first (no Cloudflare account needed)

This walks through filing a document and seeing it on the site, entirely on your own machine.

1. **Get `cc-docs`.**
   ```
   git clone https://github.com/ihsan-sa/autobox
   export PATH="$PWD/autobox/core/bin:$PATH"
   ```
2. **File a PDF into a scratch register.**
   ```
   export CC_DOCS_ROOT=/tmp/my-library-docs
   cc-docs file some.pdf --project mylib --title "My First Document" --kind work
   ```
3. **Push it into a local git remote** (standing in for the real Pages-connected repo) **and check it out.**
   ```
   git init --bare /tmp/my-library-site.git
   export LIBRARY_MIRROR_SRC="$PWD"          # this cloned repo (bin/library-mirror reads pages/ from its git history)
   export LIBRARY_MIRROR_REMOTE=/tmp/my-library-site.git
   export LIBRARY_MIRROR_DIR=/tmp/my-library-mirror-clone
   bin/library-mirror sync
   git clone /tmp/my-library-site.git /tmp/my-library-dist
   ```
4. **Mint a local sign-in** (swaps in a throwaway key pair instead of real Cloudflare Access — see
   `bin/dev-login.mjs` for how).
   ```
   node bin/dev-login.mjs init                       # writes .dev-login/ here, prints ACCESS_JWKS etc.
   ```
   Copy the three lines it prints (`ACCESS_JWKS=...`, `ACCESS_TEAM=...`, `ACCESS_AUD=...`) into a `.dev.vars`
   file **inside `/tmp/my-library-dist`** (not this repo), alongside `CF_PAGES_BRANCH=local` and:
   ```
   OWNER_EMAILS=owner@example.test
   OWNER_NAME=Owner
   ```
   (`.dev.vars.example` in this repo has the full list of optional variables.)
5. **Serve it.** `wrangler pages dev` only finds `functions/` when it's run *from inside* the directory it's
   serving — running it one level up and passing the directory as an argument silently drops your API routes:
   ```
   cd /tmp/my-library-dist
   npx wrangler pages dev . --d1=DB=testdb --compatibility-date=2024-09-23
   ```
6. **Sign in and look.** `node bin/dev-login.mjs token owner@example.test` (run from this repo, where
   `.dev-login/` lives) prints a JWT — set it as a cookie:
   ```
   node bin/dev-login.mjs token owner@example.test
   # in the browser devtools console on http://localhost:8788:
   # document.cookie = "CF_Authorization=<the printed token>; path=/"
   ```
   Reload `http://localhost:8788` and your filed document is there, with the PDF viewable.

Re-run steps 2 and part of 3 (`cc-docs file` another PDF, then `bin/library-mirror sync` and re-clone
`/tmp/my-library-dist`) to see a new filing show up.

## Running it for real

1. **Create a Cloudflare Pages project** connected to your own fork/clone of this repo (or deploy `pages/`
   directly with `wrangler pages deploy` from CI — either way, `pages_build_output_dir` in `wrangler.toml` is
   `pages`).
2. **Create a D1 database** — `wrangler d1 create your-library-db` — and put the id it prints into
   `wrangler.toml`'s `database_id`.
3. **Put a Cloudflare Access application in front of the Pages project** (Zero Trust → Access → Applications),
   and set, as Pages environment variables (dashboard, not `.dev.vars`):
   - `ACCESS_TEAM` — your Cloudflare Access team name (the `<team>` in `<team>.cloudflareaccess.com`)
   - `ACCESS_AUD` — the Access application's Audience tag
   - `OWNER_EMAILS` — comma-separated emails treated as the library's owner
   - `OWNER_NAME` — display name for the owner
   - optionally `SEED_READERS_JSON`, `CF_API_TOKEN`/`CF_ACCOUNT_ID`/`CF_ACCESS_POLICY_ID`/`CF_ACCESS_APP_ID`
     (only if you want group membership changes on the site to push back into your Access policy),
     `FEEDBACK_TOKENS`/`LINK_MINT_TOKENS`/`READER_EXPORT_TOKENS` (bearer tokens gating those optional APIs)
4. **Point your domain at the Pages project** (Pages → Custom domains), if you want one.
5. **Run `bin/library-mirror sync` on a timer** (cron, systemd, anything that fires once a minute) somewhere
   that has `cc-docs` on `PATH`, `CC_DOCS_ROOT` set to where you file documents, and
   `LIBRARY_MIRROR_REMOTE` set to the git URL of the repo your Pages project deploys from (with a credential
   helper already configured — the script reads no credential itself). It picks up newly filed documents and
   site changes and pushes them; `library-mirror --help` (or read the top of the script) has the rest of the
   env vars.

## Optional pieces (not in this export)

The in-browser LaTeX editor (compiling drafts server-side) and a feedback-notification poller exist as
separate add-ons on top of this site's `/api/editor/*` and `/api/feedback` routes. Neither is required for
filing and reading documents; wiring them up is a follow-up, not part of this walkthrough.

## Selfchecks

```
CC_DOCS_BIN=/path/to/autobox/core/bin/cc-docs python3 bin/library-mirror selfcheck
node pages/selfcheck.mjs
```
