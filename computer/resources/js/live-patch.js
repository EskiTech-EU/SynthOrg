/**
 * A message being written, told as it grows.
 *
 * The device where a model answers tells the other what changed in the
 * message since the last time, not the message again: a few bytes for a few
 * words. `diff` gives the changes between two states of a message (plain
 * JSON), `apply` makes them on a copy of the first.
 *
 * A change is one of:
 *   { p, o, t }   the text at path `p` keeps its first `o` characters and goes on with `t`
 *   { p, v }      what is at path `p` becomes `v`
 *   { p, d: 1 }   what is at path `p` is taken off
 * Positions are from the start of the text, so a change made twice, or on a
 * text that is already further on, gives the same text.
 */
(function () {
  'use strict';

  const plain = (value) => value !== null && typeof value === 'object';

  function diff(before, after, path = [], out = []) {
    if (before === after) return out;
    if (typeof before === 'string' && typeof after === 'string') {
      let kept = 0;
      if (after.startsWith(before)) kept = before.length;
      else {
        const most = Math.min(before.length, after.length);
        while (kept < most && before.charCodeAt(kept) === after.charCodeAt(kept)) kept += 1;
      }
      // Never between the two halves of one character.
      if (kept > 0) { const code = after.charCodeAt(kept - 1); if (code >= 0xD800 && code <= 0xDBFF) kept -= 1; }
      out.push({ p: path, o: kept, t: after.slice(kept) });
      return out;
    }
    const list = Array.isArray(after);
    if (plain(before) && plain(after) && Array.isArray(before) === list && !(list && after.length < before.length)) {
      for (const key of Object.keys(after)) diff(before[key], after[key], [...path, key], out);
      if (!list) for (const key of Object.keys(before)) if (!(key in after)) out.push({ p: [...path, key], d: 1 });
      return out;
    }
    out.push({ p: path, v: after });
    return out;
  }

  /** Makes the changes on `target`; false when one does not fit what is there (the whole message is to be asked again). */
  function apply(target, changes) {
    for (const change of changes || []) {
      const path = Array.isArray(change.p) ? change.p : [];
      if (!path.length) {
        if (!plain(change.v)) return false;
        for (const key of Object.keys(target)) delete target[key];
        Object.assign(target, change.v);
        continue;
      }
      let at = target;
      for (let i = 0; i < path.length - 1; i += 1) at = plain(at) ? at[path[i]] : undefined;
      if (!plain(at)) return false;
      const key = path[path.length - 1];
      if (change.d) delete at[key];
      else if ('v' in change) at[key] = change.v;
      else {
        const text = at[key];
        if (typeof text !== 'string' || text.length < change.o) return false;
        at[key] = text.slice(0, change.o) + change.t;
      }
    }
    return true;
  }

  const api = { diff, apply };
  if (typeof window !== 'undefined') window.livePatch = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
