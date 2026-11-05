const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const zlib = require('node:zlib');
const { test } = require('node:test');
const ts = require('typescript');
const { storedZipParts, zipCrc32 } = require('@monky/shared');

/** The desktop's real ZIP writer, which needs nothing from Electron. */
function loadZipWriter(now) {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'zipWriter.ts'), 'utf8');
  const exports = {};
  vm.runInNewContext(ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText, {
    exports, Buffer, Error,
    require: (name) => {
      if (name === '@monky/shared') {
        // The archive's timestamp comes from the shared module's clock.
        const shared = require(name);
        return { ...shared, zipDosDateTime: () => shared.zipDosDateTime(now) };
      }
      if (['node:fs', 'node:zlib'].includes(name)) return require(name);
      throw new Error(`Unexpected import: ${name}`);
    },
  });
  return exports;
}

test('the shared CRC-32 is zlib\'s, also when continued across chunks', () => {
  const data = Buffer.from(Array.from({ length: 70_000 }, (_, index) => (index * 31) & 0xff));
  assert.equal(zipCrc32(data), zlib.crc32(data));
  assert.equal(zipCrc32(data.subarray(40_000), zipCrc32(data.subarray(0, 40_000))), zlib.crc32(data));
  assert.equal(zipCrc32(new Uint8Array()), 0);
});

test('the web version builds the same ZIP the desktop streams to disk (#858)', async () => {
  const now = new Date(2026, 10, 4, 9, 30, 12);
  const files = [
    { name: 'foto.png', data: Buffer.from('not really a png') },
    { name: 'canção (1).txt', data: Buffer.from('ã é ü') },
    { name: 'vazio.bin', data: Buffer.alloc(0) },
  ];
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'monky-zip-'));
  try {
    const sources = files.map((file, index) => {
      const filePath = path.join(folder, `source-${index}`);
      fs.writeFileSync(filePath, file.data);
      return { name: file.name, filePath };
    });
    const destination = path.join(folder, 'desktop.zip');
    await loadZipWriter(now).writeStoredZip(sources, destination);
    const web = Buffer.concat(storedZipParts(files, now));
    assert.deepEqual(web, fs.readFileSync(destination));
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
});
