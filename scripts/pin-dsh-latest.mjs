#!/usr/bin/env node
/**
 * Pin the whole `@deepseek-ai` harness family to the npm `@latest` CLI.
 *
 * The canary and release-compat workflows both need this, and both used to do
 * it with a copy-pasted snippet that wrote `^<latest>` for EVERY family
 * package. That assumed the family publishes every package at every CLI
 * release — which it does not: 0.2.1-rc.2 shipped without
 * `@deepseek-ai/dsh-invariants` (stuck at 0.2.0-rc.2), so the blanket rewrite
 * asked for a version nobody had published and the install failed before a
 * single test ran, making both workflows red for reasons unrelated to our code.
 *
 * It also does not use carets on the rc line: `^0.2.1-rc.2` accepts
 * 0.2.1-rc.3, and upstream published rc.3 sub-packages (client-connection
 * among them) that require `dsh-scope@0.2.1-rc.3` exactly while the CLI's
 * `latest` tag was still rc.2 — the profile then resolved those bundles and
 * dsh's gate rejected them ("requirements {...}"). Pinning EXACTLY keeps the
 * whole family on the tracked CLI version. The one exception is a package the
 * family has not published at that version (0.2.1-rc.2 shipped without
 * `@deepseek-ai/dsh-invariants`): it falls back to a caret on its highest
 * published version, which a `0.x` caret still accepts for the newer runtime,
 * and that is what dsh's gate checks. Every fallback is logged.
 *
 * Usage: node scripts/pin-dsh-latest.mjs [--dry-run]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const SKIP = new Set(['@deepseek-ai/cordis', '@deepseek-ai/schemastery']);
const REGISTRY = process.env.DSH_REGISTRY ?? 'https://registry.npmjs.org';

/** Compare two semver versions (prerelease aware, enough for `x.y.z[-pre]`). */
function compare(a, b) {
  const parse = (v) => {
    const [core, pre] = v.split('-');
    return { nums: core.split('.').map(Number), pre: pre ?? null };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < 3; i += 1) {
    if (x.nums[i] !== y.nums[i]) return x.nums[i] - y.nums[i];
  }
  if (x.pre === y.pre) return 0;
  if (x.pre === null) return 1; // a stable release sorts after its prereleases
  if (y.pre === null) return -1;
  return x.pre.localeCompare(y.pre, 'en', { numeric: true });
}

/** Published versions of one package, or `undefined` when it is not on npm. */
async function publishedVersions(name) {
  const response = await fetch(`${REGISTRY}/${name.replace('/', '%2F')}`, {
    headers: { accept: 'application/vnd.npm.install-v1+json' },
  });
  if (!response.ok) return undefined;
  const body = await response.json();
  return Object.keys(body.versions ?? {});
}

const llm = await fetch(`${REGISTRY}/@deepseek-ai%2Fdsh`, {
  headers: { accept: 'application/vnd.npm.install-v1+json' },
});
if (!llm.ok) throw new Error(`registry: cannot read @deepseek-ai/dsh (${llm.status})`);
const latest = (await llm.json())['dist-tags']?.latest;
if (typeof latest !== 'string') throw new Error('registry: @deepseek-ai/dsh has no latest tag');
console.log(`dsh @latest = ${latest}`);

const pkgPath = join(ROOT, 'package.json');
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
const lagging = new Set();
for (const section of ['devDependencies', 'peerDependencies']) {
  for (const name of Object.keys(pkg[section] ?? {})) {
    if (!name.startsWith('@deepseek-ai/') || SKIP.has(name)) continue;
    if (name === '@deepseek-ai/dsh') {
      pkg[section][name] = latest;
      continue;
    }
    const versions = await publishedVersions(name);
    if (versions === undefined || versions.length === 0) {
      throw new Error(`registry: ${name} has no published versions`);
    }
    const has = versions.includes(latest);
    const pick = has
      ? latest
      : versions.reduce((best, candidate) => (compare(candidate, best) > 0 ? candidate : best));
    if (!has && !lagging.has(name)) {
      lagging.add(name);
      console.log(`  ${name}: ${latest} not published, pinning ^${pick} (highest available)`);
    }
    // Exact on the tracked line; a caret only where the family skipped this
    // version, because then it must still ACCEPT the runtime version.
    pkg[section][name] = has ? pick : `^${pick}`;
  }
}
if (process.argv.includes('--dry-run')) {
  console.log(JSON.stringify({ devDependencies: pkg.devDependencies, peerDependencies: pkg.peerDependencies }, null, 2));
} else {
  writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
  console.log(
    `pinned @deepseek-ai/dsh@${latest}${lagging.size ? ` with ${lagging.size} lagging package(s)` : ''}`,
  );
}
