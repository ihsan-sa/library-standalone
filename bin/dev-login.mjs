#!/usr/bin/env node
// bin/dev-login.mjs — mint a local Access identity for `wrangler pages dev`, no Cloudflare account needed.
//
// Real deployments sit behind Cloudflare Access, which the site verifies itself (see pages/lib/library.js). Locally,
// lib/library.js swaps in test signing keys whenever CF_PAGES_BRANCH=local and ACCESS_JWKS is set (the same trick
// pages/selfcheck.mjs uses for its own fixtures) — so a local run needs a JWKS to publish and a JWT signed against
// its private key, and this script is the two of those in one place.
//
//   node bin/dev-login.mjs init                  write a fresh keypair + JWKS to .dev-login/ (once)
//   node bin/dev-login.mjs token <email>          print a signed JWT for that email (paste into curl or a cookie)
//
// Wire the JWKS into `wrangler pages dev` via .dev.vars (see .dev.vars.example): ACCESS_JWKS='<contents of
// .dev-login/jwks.json>', CF_PAGES_BRANCH=local, ACCESS_TEAM and ACCESS_AUD any placeholder value — `init` picks
// one and prints it, and `token` signs against the same ACCESS_TEAM/ACCESS_AUD unless overridden.
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const DIR = '.dev-login';
const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');

async function init() {
  mkdirSync(DIR, { recursive: true });
  const alg = { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' };
  const pair = await crypto.subtle.generateKey(alg, true, ['sign', 'verify']);
  const jwk = { ...(await crypto.subtle.exportKey('jwk', pair.publicKey)), kid: 'dev1', alg: 'RS256', use: 'sig' };
  const priv = await crypto.subtle.exportKey('jwk', pair.privateKey);
  writeFileSync(join(DIR, 'jwks.json'), JSON.stringify({ keys: [jwk] }));
  writeFileSync(join(DIR, 'private.json'), JSON.stringify(priv));
  writeFileSync(join(DIR, 'team.json'), JSON.stringify({ team: 'dev-team', aud: 'dev-aud' }));
  console.log(`wrote ${DIR}/jwks.json, ${DIR}/private.json, ${DIR}/team.json`);
  console.log('put this in .dev.vars (see .dev.vars.example):');
  console.log(`  ACCESS_JWKS='${readFileSync(join(DIR, 'jwks.json'), 'utf8')}'`);
  console.log('  ACCESS_TEAM=dev-team');
  console.log('  ACCESS_AUD=dev-aud');
  console.log('  CF_PAGES_BRANCH=local');
}

async function token(email) {
  if (!existsSync(join(DIR, 'private.json'))) { console.error('run `node bin/dev-login.mjs init` first'); process.exit(1); }
  const privJwk = JSON.parse(readFileSync(join(DIR, 'private.json'), 'utf8'));
  const { team, aud } = JSON.parse(readFileSync(join(DIR, 'team.json'), 'utf8'));
  const key = await crypto.subtle.importKey('jwk', privJwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const head = enc({ alg: 'RS256', kid: 'dev1', typ: 'JWT' });
  const body = enc({ email, aud: [aud], iss: `https://${team}.cloudflareaccess.com`, exp: Date.now() / 1000 + 3600, iat: Date.now() / 1000 - 5 });
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(`${head}.${body}`));
  const jwt = `${head}.${body}.${Buffer.from(sig).toString('base64url')}`;
  console.log(jwt);
  console.error(`\n# curl:   curl -H 'Cf-Access-Jwt-Assertion: ${jwt}' http://localhost:8788/api/library`);
  console.error(`# browser: document.cookie = 'CF_Authorization=${jwt}; path=/'`);
}

const [cmd, arg] = process.argv.slice(2);
if (cmd === 'init') await init();
else if (cmd === 'token' && arg) await token(arg);
else { console.error('usage: dev-login.mjs init | dev-login.mjs token <email>'); process.exit(2); }
