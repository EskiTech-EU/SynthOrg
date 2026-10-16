'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { diff, apply } = require('../resources/js/live-patch.js');

const copy = (value) => JSON.parse(JSON.stringify(value));

test('an answer that grows is told in a few bytes, and the other side has the same answer', () => {
  const steps = [
    { id: 'm1', role: 'assistant', content: '', isStreaming: true, turns: [], reasoning: '' },
    { id: 'm1', role: 'assistant', content: '', isStreaming: true, turns: [{ reasoning: 'Penso', toolCalls: [] }], reasoning: 'Penso' },
    { id: 'm1', role: 'assistant', content: 'Ciao', isStreaming: true, turns: [{ reasoning: 'Penso a lungo', toolCalls: [] }], reasoning: 'Penso a lungo' },
    { id: 'm1', role: 'assistant', content: 'Ciao 😀 a te', isStreaming: true, turns: [{ reasoning: 'Penso a lungo', toolCalls: [{ id: 'c1', name: 'write_file', args: '{"path":', status: 'executing' }] }], reasoning: 'Penso a lungo' },
    { id: 'm1', role: 'assistant', content: 'Ciao 😀 a te', isStreaming: true, turns: [{ reasoning: 'Penso a lungo', toolCalls: [{ id: 'c1', name: 'write_file', args: '{"path":"a.js"}', status: 'awaiting', approval: { id: 'a1', kind: 'code' } }] }], reasoning: 'Penso a lungo' },
    { id: 'm1', role: 'assistant', content: 'Ciao 😁 a te, fatto.', isStreaming: false, status: 'complete', turns: [{ reasoning: 'Penso a lungo', toolCalls: [{ id: 'c1', name: 'write_file', args: '{"path":"a.js"}', status: 'completed', result: 'ok' }] }], reasoning: 'Penso a lungo' }
  ];
  const there = copy(steps[0]);
  for (let i = 1; i < steps.length; i += 1) {
    const changes = copy(diff(steps[i - 1], steps[i]));
    assert.equal(apply(there, changes), true);
    assert.deepEqual(there, steps[i]);
    // Told twice, the same answer.
    assert.equal(apply(there, changes), true);
    assert.deepEqual(there, steps[i]);
  }
  // A few words more are a few bytes, however long the answer is.
  const long = { content: 'parola '.repeat(5000) };
  const changes = diff(long, { content: long.content + 'ancora' });
  assert.deepEqual(changes, [{ p: ['content'], o: long.content.length, t: 'ancora' }]);
  assert.deepEqual(diff(long, copy(long)), []);
  // Two characters that share their first half are never cut between the halves.
  const cut = diff({ c: 'a😀' }, { c: 'a😁' });
  assert.deepEqual(cut, [{ p: ['c'], o: 1, t: '😁' }]);
});

test('a change that does not fit what is there is refused, so that the whole is asked again', () => {
  assert.equal(apply({ content: 'Ciao' }, [{ p: ['content'], o: 10, t: '!' }]), false);
  assert.equal(apply({ content: 'Ciao' }, [{ p: ['turns', '0', 'reasoning'], o: 0, t: 'x' }]), false);
  assert.equal(apply({ turns: [] }, [{ p: ['turns', '0'], v: { reasoning: '' } }, { p: ['turns', '0', 'reasoning'], o: 0, t: 'x' }]), true);
  // A list that became shorter is given whole.
  assert.deepEqual(diff({ l: [1, 2, 3] }, { l: [1] }), [{ p: ['l'], v: [1] }]);
});
