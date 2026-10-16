'use strict';
// The global dossier's Code projects: worked out from the projects at every
// request, split by the last time they were opened, and stable text-wise.
const test = require('node:test');
const assert = require('node:assert/strict');
const { Store } = require('../server/database');

function project(store, id, name, { kind = 'local', repo = null, branch = null, created, opened }) {
  store.db.prepare(`INSERT INTO projects(id,name,kind,path,container_name,created_at,updated_at,opened_at,repo,work_branch)
    VALUES(?,?,?,?,?,?,?,?,?,?)`).run(id, name, kind, '/tmp/' + id, kind === 'podman' ? 'synthorg-code-' + id : null, created, created, opened || null, repo, branch);
}

test('Code projects in the dossier: active if opened within the days set, past otherwise, in creation order', t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const today = new Date('2026-09-24T12:00:00Z');
  project(store, 'b', 'Beta', { kind: 'podman', repo: 'samu/beta', branch: 'synthorg/lavoro', created: '2026-09-01T10:00:00Z', opened: '2026-09-23T09:00:00Z' });
  project(store, 'a', 'Alfa', { created: '2026-05-01T10:00:00Z', opened: '2026-06-01T09:00:00Z' });
  project(store, 'c', 'Gamma', { created: '2026-09-20T10:00:00Z' });

  const d = store.dossierProjects(today);
  assert.equal(d.activeDays, 30);
  assert.deepEqual(d.active.map(p => p.name), ['Beta', 'Gamma'], 'opened (or created) in the last 30 days, oldest first');
  assert.deepEqual(d.past.map(p => p.name), ['Alfa']);
  assert.deepEqual(d.active[0], { id: 'b', name: 'Beta', kind: 'container', repo: 'samu/beta', branch: 'synthorg/lavoro', lastOpened: '2026-09-23' });
  assert.equal(d.active[1].lastOpened, '2026-09-20', 'never opened: its creation day');

  store.setSetting('dossier_active_days', '200');
  assert.deepEqual(store.dossierProjects(today).past, [], 'a longer window keeps Alfa active');

  // they come with the context only when the dossier does
  const chat = store.createConversation('x');
  assert.ok(store.context(chat.id, 'q', { includeGlobal: true }).dossierProjects.active.length === 3);
  assert.equal(store.context(chat.id, 'q', { includeGlobal: false }).dossierProjects, null);

  // the dossier's global switch, on the server, wins over what the chat asks
  store.setSetting('global_memory_enabled', 'false');
  assert.equal(store.context(chat.id, 'q', { includeGlobal: true }).dossierProjects, null);
  store.setSetting('global_memory_enabled', 'true');
  assert.ok(store.context(chat.id, 'q', { includeGlobal: true }).dossierProjects);
});
