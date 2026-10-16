'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { LocalModelManager } = require('../server/local-models');

test('the header’s manager is told what is in memory and the last models loaded that are not', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'synthorg-loaded-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const models = path.join(root, 'data', 'models');
  fs.mkdirSync(models, { recursive: true });
  const entry = (name, loadedAt, extra = {}) => ({ info: { name, sizeLabel: '4B', quantization: 'Q4_K_M', ...extra }, ...(loadedAt ? { loadedAt } : {}) });
  const files = {
    'in-memory.gguf': entry('In memoria', 500),
    'newest.gguf': entry('Più recente', 400),
    'older.gguf': entry('Meno recente', 300),
    'oldest.gguf': entry('Vecchio', 200),
    'forgotten.gguf': entry('Più vecchio ancora', 100),
    'never.gguf': entry('Mai caricato', 0),
    'deleted.gguf': entry('Cancellato dal disco', 450),
    'mmproj.gguf': entry('Proiettore', 460, { projector: true })
  };
  for (const file of Object.keys(files)) if (file !== 'deleted.gguf') fs.writeFileSync(path.join(models, file), 'gguf');
  fs.writeFileSync(path.join(models, 'index.json'), JSON.stringify({ files, downloads: {} }));

  const manager = new LocalModelManager({ root });
  manager.engines.set('local/in-memory.gguf', { id: 'local/in-memory.gguf', placement: 'auto', gpuLayers: { onGpu: 33, total: 33 }, memory: { gpu: 3 * 1024 ** 3, ram: 0 }, context: 8192, startedAt: 10 });
  manager.starting.set('local/older.gguf', Promise.resolve());

  const said = manager.loaded();
  assert.deepEqual(said.loaded.map(model => [model.id, model.name, model.memory.gpu, model.context]), [['local/in-memory.gguf', 'In memoria', 3 * 1024 ** 3, 8192]]);
  assert.deepEqual(said.loading, [{ id: 'local/older.gguf', name: 'Meno recente' }]);
  // The last three loaded, the latest first: not what is in memory or being loaded, not a file that is gone,
  // not what is loaded only with a model, not what was never loaded.
  assert.deepEqual(said.recent.map(model => model.id), ['local/newest.gguf', 'local/oldest.gguf', 'local/forgotten.gguf']);
  assert.deepEqual([said.recent[0].name, said.recent[0].sizeLabel, said.recent[0].quantization], ['Più recente', '4B', 'Q4_K_M']);
  assert.equal(manager.loaded(1).recent.length, 1);
});
