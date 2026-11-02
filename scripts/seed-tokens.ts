/**
 * Mints random per-user tokens for the demo users and writes them to a non-committed file (default ./.demo-tokens.env, mode 0600).
 * The values are NEVER printed. Load the file into the server's env (GP_TOKEN_<USERNAME>=...) and into the integration test's env.
 *   npx tsx scripts/seed-tokens.ts [path]
 */
import { randomBytes } from 'node:crypto';
import { writeFileSync, chmodSync, existsSync } from 'node:fs';
const path = process.argv[2] ?? '.demo-tokens.env';
if (existsSync(path)) { console.error(`${path} already exists; delete it first to rotate`); process.exit(1); }
const users = ['family_demo', 'provider_demo', 'provider_two', 'reviewer_demo'];
const lines = users.map(u => `GP_TOKEN_${u.toUpperCase()}=gp_${randomBytes(32).toString('base64url')}`);
lines.push(`ADMIN_TOKEN=gpa_${randomBytes(32).toString('base64url')}`);
writeFileSync(path, lines.join('\n') + '\n', { mode: 0o600 }); chmodSync(path, 0o600);
console.log(`wrote ${lines.length} random tokens to ${path} (not printed, not committed)`);
