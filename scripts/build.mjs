#!/usr/bin/env node
// Build, sign and verify the "Google Web Results Only" extension.
//
// Usage (from the repository root):
//   node scripts/build.mjs build
//       Copy extension/ to dist/extension/, filling in the domain list from
//       extension/domains.json. Load dist/extension/ unpacked to test locally.
//
//   node scripts/build.mjs check-version <published-updates.xml | "">
//       Fail unless manifest.json's version is higher than the version in the
//       given (already downloaded) updates.xml. An empty argument means
//       "nothing published yet".
//
//   node scripts/build.mjs pack <private-key.pem> <pages-base-url>
//       Build, then sign dist/extension/ into dist/site/webonly.crx (CRX3),
//       write dist/site/updates.xml and dist/site/index.html, verify the
//       signature and extension ID, and write dist/build-info.json.
//
// The private key is only ever read from the path given on the command line.
// Nothing derived from it except the public extension ID is printed.

import { createHash, createPublicKey, createVerify } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'extension');
const DIST = join(ROOT, 'dist');
const BUILD = join(DIST, 'extension');
const SITE = join(DIST, 'site');
const CRX_NAME = 'webonly.crx';

function fail(msg) {
  console.error(`ERROR: ${msg}`);
  process.exit(1);
}

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));

// ---------------------------------------------------------------- versions --

function parseVersion(v) {
  // Chrome extension versions: 1-4 dot-separated integers, 0-65535, no leading zeros.
  if (typeof v !== 'string' || !/^(0|[1-9]\d{0,4})(\.(0|[1-9]\d{0,4})){0,3}$/.test(v)) return null;
  const parts = v.split('.').map(Number);
  return parts.every((n) => n <= 65535) ? parts : null;
}

function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  for (let i = 0; i < 4; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return Math.sign(d);
  }
  return 0;
}

// ------------------------------------------------------------------- build --

function build() {
  const { domains } = readJson(join(SRC, 'domains.json'));
  if (!Array.isArray(domains) || domains.length === 0) fail('extension/domains.json: "domains" must be a non-empty array');
  for (const d of domains) {
    if (typeof d !== 'string' || !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(d) || d.startsWith('www.')) {
      fail(`extension/domains.json: "${d}" is not a bare lowercase domain like "google.com"`);
    }
  }
  if (new Set(domains).size !== domains.length) fail('extension/domains.json: duplicate domains');

  const manifest = readJson(join(SRC, 'manifest.json'));
  if (manifest.manifest_version !== 3) fail('manifest.json: manifest_version must be 3');
  if (!parseVersion(manifest.version)) fail(`manifest.json: invalid version "${manifest.version}"`);
  if (manifest.background || manifest.content_scripts) fail('manifest.json: background/content scripts are not allowed');
  // "*://*.example.com/*" also matches example.com itself.
  manifest.host_permissions = domains.map((d) => `*://*.${d}/*`);

  const rules = readJson(join(SRC, 'rules.json'));
  const ids = new Set();
  for (const rule of rules) {
    if (ids.has(rule.id)) fail(`rules.json: duplicate rule id ${rule.id}`);
    ids.add(rule.id);
    rule.condition.requestDomains = [...domains];
  }

  rmSync(BUILD, { recursive: true, force: true });
  mkdirSync(BUILD, { recursive: true });
  cpSync(join(SRC, 'icons'), join(BUILD, 'icons'), { recursive: true });
  for (const size of Object.keys(manifest.icons)) {
    if (!existsSync(join(BUILD, manifest.icons[size]))) fail(`missing icon ${manifest.icons[size]}`);
  }
  writeFileSync(join(BUILD, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  writeFileSync(join(BUILD, 'rules.json'), JSON.stringify(rules, null, 2) + '\n');
  console.log(`Built ${BUILD} (version ${manifest.version}, domains: ${domains.join(', ')})`);
  return manifest;
}

// ----------------------------------------------------------- check-version --

function publishedVersion(xml) {
  const m = /<updatecheck\b[^>]*\bversion\s*=\s*['"]([^'"]+)['"]/.exec(xml);
  return m ? m[1] : null;
}

function checkVersion(xmlPath) {
  const { version } = readJson(join(SRC, 'manifest.json'));
  if (!parseVersion(version)) fail(`manifest.json: invalid version "${version}"`);
  if (!xmlPath || !existsSync(xmlPath) || statSync(xmlPath).size === 0) {
    console.log(`No published updates.xml found; first release will be ${version}.`);
    return;
  }
  const published = publishedVersion(readFileSync(xmlPath, 'utf8'));
  if (!published || !parseVersion(published)) fail('Could not read the version from the published updates.xml');
  if (compareVersions(version, published) <= 0) {
    fail(`manifest.json version ${version} is not higher than the published version ${published}. Bump "version" in extension/manifest.json.`);
  }
  console.log(`Version OK: ${published} -> ${version}`);
}

// ------------------------------------------------------------- CRX helpers --

// Chrome's extension ID: first 128 bits of SHA-256(DER SubjectPublicKeyInfo),
// hex digits 0-f mapped to letters a-p.
function idFromSpki(spkiDer) {
  return idFromBytes(createHash('sha256').update(spkiDer).digest().subarray(0, 16));
}

function idFromBytes(bytes) {
  return [...Buffer.from(bytes).toString('hex')].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');
}

// Minimal protobuf reader: returns [{field, wire, value}] for one message.
function readProto(buf) {
  const out = [];
  let i = 0;
  const varint = () => {
    let result = 0n;
    let shift = 0n;
    for (;;) {
      if (i >= buf.length) throw new Error('truncated varint');
      const b = buf[i++];
      result |= BigInt(b & 0x7f) << shift;
      if (!(b & 0x80)) return result;
      shift += 7n;
    }
  };
  while (i < buf.length) {
    const key = Number(varint());
    const field = key >>> 3;
    const wire = key & 7;
    if (wire === 0) out.push({ field, wire, value: varint() });
    else if (wire === 2) {
      const len = Number(varint());
      if (i + len > buf.length) throw new Error('truncated field');
      out.push({ field, wire, value: buf.subarray(i, i + len) });
      i += len;
    } else if (wire === 1) { out.push({ field, wire, value: buf.subarray(i, i + 8) }); i += 8; }
    else if (wire === 5) { out.push({ field, wire, value: buf.subarray(i, i + 4) }); i += 4; }
    else throw new Error(`unsupported wire type ${wire}`);
  }
  return out;
}

// Parse a CRX3 file and verify every RSA proof. Returns the crx_id from the
// signed header and the IDs of the keys that signed it.
function verifyCrx(crx) {
  if (crx.toString('latin1', 0, 4) !== 'Cr24') throw new Error('bad CRX magic');
  if (crx.readUInt32LE(4) !== 3) throw new Error('not a CRX3 file');
  const headerLen = crx.readUInt32LE(8);
  const header = crx.subarray(12, 12 + headerLen);
  const archive = crx.subarray(12 + headerLen);
  if (archive.toString('latin1', 0, 4) !== 'PK\x03\x04') throw new Error('payload is not a ZIP archive');

  const fields = readProto(header);
  const signedHeader = fields.find((f) => f.field === 10000)?.value;
  if (!signedHeader) throw new Error('missing signed_header_data');
  const crxIdBytes = readProto(signedHeader).find((f) => f.field === 1)?.value;
  if (!crxIdBytes || crxIdBytes.length !== 16) throw new Error('missing crx_id');

  const prefix = Buffer.from('CRX3 SignedData\x00', 'latin1');
  const len = Buffer.alloc(4);
  len.writeUInt32LE(signedHeader.length);

  const signerIds = [];
  for (const proof of fields.filter((f) => f.field === 2)) { // sha256_with_rsa
    const p = readProto(proof.value);
    const pub = p.find((f) => f.field === 1)?.value;
    const sig = p.find((f) => f.field === 2)?.value;
    const v = createVerify('sha256');
    v.update(prefix); v.update(len); v.update(signedHeader); v.update(archive);
    const key = createPublicKey({ key: Buffer.from(pub), format: 'der', type: 'spki' });
    if (!v.verify(key, Buffer.from(sig))) throw new Error('RSA signature does not verify');
    signerIds.push(idFromSpki(pub));
  }
  if (signerIds.length === 0) throw new Error('no sha256_with_rsa proof');
  return { crxId: idFromBytes(crxIdBytes), signerIds };
}

const xmlEscape = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/'/g, '&apos;').replace(/"/g, '&quot;');
const htmlEscape = xmlEscape;

// -------------------------------------------------------------------- pack --

async function pack(keyPath, baseUrl) {
  if (!keyPath || !existsSync(keyPath) || statSync(keyPath).size === 0) {
    // crx3 would silently generate a NEW key (and so a new extension ID) if
    // the file were missing, so refuse to continue.
    fail('Private key file is missing or empty. Set the EXTENSION_PEM repository secret.');
  }
  if (!/^https:\/\/[^\s'"<>]+[^/]$/.test(baseUrl || '')) fail(`Pages base URL must be https:// without a trailing slash, got "${baseUrl}"`);

  let privateKeyPem;
  let spki;
  try {
    privateKeyPem = readFileSync(keyPath);
    spki = createPublicKey(privateKeyPem).export({ type: 'spki', format: 'der' });
  } catch {
    fail('EXTENSION_PEM is not a valid PEM private key (expected "-----BEGIN PRIVATE KEY-----" or "-----BEGIN RSA PRIVATE KEY-----").');
  }
  const extensionId = idFromSpki(spki);

  const manifest = build();
  const updateUrl = `${baseUrl}/updates.xml`;
  const crxUrl = `${baseUrl}/${CRX_NAME}`;
  if (manifest.update_url !== updateUrl) {
    fail(`manifest.json update_url is "${manifest.update_url}" but this repository's Pages URL is "${updateUrl}". Fix update_url in extension/manifest.json.`);
  }

  rmSync(SITE, { recursive: true, force: true });
  mkdirSync(SITE, { recursive: true });
  const crxPath = join(SITE, CRX_NAME);

  const { default: crx3 } = await import('crx3');
  const files = ['manifest.json', 'rules.json', ...Object.values(manifest.icons)].map((f) => join(BUILD, f));
  const info = await crx3(files, { keyPath, crxPath });
  if (info.newKey) fail('crx3 generated a new key instead of using EXTENSION_PEM'); // should be impossible after the check above

  const crx = readFileSync(crxPath);
  const { crxId, signerIds } = verifyCrx(crx);
  if (crxId !== extensionId || info.appId !== extensionId || !signerIds.includes(extensionId)) {
    fail(`extension ID mismatch: key=${extensionId} crx_id=${crxId} crx3=${info.appId} signers=${signerIds.join(',')}`);
  }

  // Sanity-check the ZIP payload holds manifest.json at its root.
  const archive = crx.subarray(12 + crx.readUInt32LE(8));
  if (!archive.includes(Buffer.from('manifest.json')) || archive.includes(Buffer.from('/manifest.json'))) {
    fail('manifest.json is not at the root of the CRX archive');
  }

  const updatesXml = `<?xml version='1.0' encoding='UTF-8'?>
<gupdate xmlns='http://www.google.com/update2/response' protocol='2.0'>
  <app appid='${xmlEscape(extensionId)}'>
    <updatecheck codebase='${xmlEscape(crxUrl)}' version='${xmlEscape(manifest.version)}' />
  </app>
</gupdate>
`;
  writeFileSync(join(SITE, 'updates.xml'), updatesXml);
  if (publishedVersion(updatesXml) !== manifest.version) fail('updates.xml self-check failed');

  const forceInstall = `${extensionId};${updateUrl}`;
  writeFileSync(join(SITE, 'index.html'), `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${htmlEscape(manifest.name)}</title></head>
<body style="font-family: system-ui, sans-serif; max-width: 48rem; margin: 2rem auto; padding: 0 1rem;">
<h1>${htmlEscape(manifest.name)}</h1>
<p>Version ${htmlEscape(manifest.version)}. Self-hosted Chrome extension for managed (GPO/MDM) installation.</p>
<p>Extension ID: <code>${htmlEscape(extensionId)}</code></p>
<p>ExtensionInstallForcelist entry:<br><code>${htmlEscape(forceInstall)}</code></p>
<p><a href="updates.xml">updates.xml</a> &middot; <a href="${CRX_NAME}">${CRX_NAME}</a></p>
</body></html>
`);

  const sha256 = createHash('sha256').update(crx).digest('hex');
  const buildInfo = { name: manifest.name, version: manifest.version, extensionId, updateUrl, crxUrl, forceInstall, crxSha256: sha256 };
  writeFileSync(join(DIST, 'build-info.json'), JSON.stringify(buildInfo, null, 2) + '\n');
  console.log(`Packed ${crxPath} (${crx.length} bytes, sha256 ${sha256})`);
  console.log(`Extension ID: ${extensionId}`);
  console.log(`Force-install: ${forceInstall}`);
}

// --------------------------------------------------------------------- cli --

const [cmd, ...args] = process.argv.slice(2);
if (cmd === 'build') build();
else if (cmd === 'check-version') checkVersion(args[0]);
else if (cmd === 'pack') await pack(args[0], args[1]);
else fail('usage: build.mjs build | check-version <updates.xml> | pack <key.pem> <pages-base-url>');
