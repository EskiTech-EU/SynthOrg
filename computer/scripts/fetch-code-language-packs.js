'use strict';
// The Code editor speaks SynthOrg's language (vendor/sidex/src/nls-loader.ts).
// Its translations are Microsoft's MIT language packs for the workbench's
// VS Code version, fetched once, checked against a pinned checksum, and reduced
// to the one file the editor reads: vendor/sidex/public/nls/<locale>.json.
// English needs no pack.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const version = '1.110.0';
// locale -> open-vsx extension and the SHA-256 of its .vsix for `version`.
// Keys are VS Code locale ids, lower case: what nls-loader.ts asks for.
// Every language Microsoft publishes for this version is here. Hungarian is not:
// its only release on open-vsx is 1.48.3 (2020), whose keys no longer match.
const PACKS = {
  'cs': { name: 'vscode-language-pack-cs', sha256: 'c5fc3105b87bd5e30a0235fc6384b7f329ca8ef7dd0e1c6c56b457e0fd9678ef' },
  'de': { name: 'vscode-language-pack-de', sha256: 'f1ec808b3ce8a7d7778e04742e7da5119d3c1d89a4e0e629c58c807d32a85a54' },
  'es': { name: 'vscode-language-pack-es', sha256: '1ff74370d23b2fff8ba25ea265f49b090de2a6b35f045acad262a3deed885fd6' },
  'fr': { name: 'vscode-language-pack-fr', sha256: '5a9d6f60d379282ea3cd4dd5cf3a9a06639c199e2d79b8109ca539edf40884ad' },
  'it': { name: 'vscode-language-pack-it', sha256: '881b03b2d0542bd18f306fca4988eb58343ffef0b4a5b1dcfed81f9c1473fd05' },
  'ja': { name: 'vscode-language-pack-ja', sha256: 'fea15fad7a43c9f47875cd0a525aadd1603f8339215712915929ad05be467425' },
  'ko': { name: 'vscode-language-pack-ko', sha256: 'f54e01c5e2f3c4910273e20ce523625d90edddc7b10412c93bb6183fecf32340' },
  'pl': { name: 'vscode-language-pack-pl', sha256: 'ca768894eab3b2bca12af76a95c6ed5958534a5cd0a43e12e5337f218356056d' },
  'pt-br': { name: 'vscode-language-pack-pt-BR', sha256: '4ee35474d3c41bd9c97c847dd0a679cfb7d37a675e6d9341bca354e3ea30b829' },
  'ru': { name: 'vscode-language-pack-ru', sha256: 'dfd00cd445803792e0aaf454fede8b52359700264ae015d7a6e3f03975fbf188' },
  'tr': { name: 'vscode-language-pack-tr', sha256: '1fbd31227746c58189162003203ed8c983a910c1addb70ab0b46e773b9db10d6' },
  'zh-cn': { name: 'vscode-language-pack-zh-hans', sha256: '7d2e4fd2d1830ec8fbfcaec42789baa496ac9c321300859a84db074dec167541' },
  'zh-tw': { name: 'vscode-language-pack-zh-hant', sha256: '7091329c8977f14995e9b35330d6fbfb6f405cc5bdbbbd2eded526070c237304' }
};
const destination = path.join(root, 'vendor', 'sidex', 'public', 'nls');
const notices = path.join(root, 'vendor', 'sidex', 'licenses', 'language-packs');
// Windows ships bsdtar, which reads zip. Named by its full path: a GNU tar earlier
// in PATH (Git Bash) takes "C:" for a remote host.
const tar = process.platform === 'linux' ? 'bsdtar'
  : process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar';

async function prepare(locale, pack) {
  const file = `MS-CEINTL.${pack.name}-${version}.vsix`;
  const url = `https://open-vsx.org/api/MS-CEINTL/${pack.name}/${version}/file/${file}`;
  const marker = path.join(destination, `${locale}.source.json`);
  const output = path.join(destination, `${locale}.json`);
  if (pack.sha256 && fs.existsSync(output) && fs.existsSync(marker) && JSON.parse(fs.readFileSync(marker)).sha256 === pack.sha256) return;

  const cache = path.join(root, '.tmp', file);
  fs.mkdirSync(path.dirname(cache), { recursive: true });
  if (!fs.existsSync(cache)) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Language pack download failed (${locale}): HTTP ${response.status}`);
    fs.writeFileSync(cache, Buffer.from(await response.arrayBuffer()));
  }
  const digest = createHash('sha256').update(fs.readFileSync(cache)).digest('hex');
  if (!pack.sha256) { unpinned.push(`  '${locale}': ${digest}  (${file}, ${fs.statSync(cache).size} bytes)`); return; }
  if (digest !== pack.sha256) throw new Error(`Language pack checksum mismatch (${locale})`);

  // A .vsix is a zip; only two entries are read and neither is written as-is.
  const read = entry => {
    const result = spawnSync(tar, ['-xOf', cache, entry], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true });
    if (result.status !== 0) throw new Error(result.stderr || `Cannot read ${entry} from ${file}`);
    return result.stdout;
  };
  const bundles = JSON.parse(read('extension/translations/main.i18n.json')).contents;
  if (!bundles || typeof bundles !== 'object') throw new Error(`Language pack without translations (${locale})`);
  // The workbench looks a message up by its key alone (nls.messages.json).
  const messages = {};
  for (const bundle of Object.values(bundles)) Object.assign(messages, bundle);

  fs.mkdirSync(destination, { recursive: true });
  fs.mkdirSync(notices, { recursive: true });
  fs.writeFileSync(output, JSON.stringify(messages));
  // The packs carry no licence file, only the declaration in their manifest.
  const manifest = JSON.parse(read('extension/package.json'));
  const repository = typeof manifest.repository === 'string' ? manifest.repository : manifest.repository?.url || '';
  fs.writeFileSync(path.join(notices, `${pack.name}.md`),
    `# ${manifest.displayName || pack.name} ${manifest.version}

Publisher: ${manifest.publisher}
License (as declared by the pack): ${manifest.license}
Source: ${repository}
Downloaded from: ${url}
SHA-256: ${digest}
`);
  fs.writeFileSync(marker, JSON.stringify({ url, sha256: digest, version }, null, 2) + '\n');
  console.log(`Code language "${locale}" prepared from ${file} (${Object.keys(messages).length} messages)`);
}

const unpinned = [];
(async () => {
  const failures = [];
  for (const [locale, pack] of Object.entries(PACKS)) {
    try { await prepare(locale, pack); } catch (error) { failures.push(error.message); }
  }
  const report = [...failures];
  if (unpinned.length) report.push('No checksum pinned yet. Verify these and pin them in PACKS:', ...unpinned);
  if (report.length) throw new Error(report.join('\n'));
})().catch(error => { console.error(error.message); process.exitCode = 1; });
