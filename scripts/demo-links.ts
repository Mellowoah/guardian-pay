/**
 * Writes one-click demo login links (family, provider, reviewer) to a file (mode 0600). Tokens are derived exactly as the server derives them
 * (GP_TOKEN_<USER> env, else GP_TOKEN_SECRET / PAYPAL_CLIENT_SECRET) and are NEVER printed. The link puts the token in the URL #fragment (never sent to the server);
 * the UI stores it for the tab only and removes it from the address bar.
 *   PAYPAL_CLIENT_SECRET=... npx tsx scripts/demo-links.ts https://guardian-pay.onrender.com ./demo_login_links.txt
 */
import { writeFileSync, chmodSync } from 'node:fs';
import { authConfigFromEnv, tokenFor } from '../src/auth.js';
const base = (process.argv[2] ?? 'http://localhost:3000').replace(/\/$/, ''); const out = process.argv[3] ?? 'demo_login_links.txt';
const cfg = authConfigFromEnv(process.env);
const users: [string, string][] = [['Payer / family', 'family_demo'], ['Provider', 'provider_demo'], ['Reviewer', 'reviewer_demo']];
writeFileSync(out, '# Guardian Pay demo logins (SANDBOX, synthetic actors). Treat as secrets; do not commit or share.\n' + users.map(([l, u]) => `${l}: ${base}/#login=${tokenFor(cfg, u, 0)}`).join('\n') + '\n', { mode: 0o600 }); chmodSync(out, 0o600);
console.log(`wrote ${users.length} login links to ${out} (not printed)`);
