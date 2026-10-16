/**
 * SynthOrg - where the numbers shared by the users arrive.
 *
 * A Cloudflare Worker. It takes a package of numbers (what the models cost
 * and how they did, by model and role: see server/usage.js in the app),
 * checks that it holds numbers and nothing else, and writes it as a file in
 * a private GitHub repository.
 *
 * What it keeps of who sent it: nothing. No address, no header, no moment
 * finer than the day the file is written on. A package that holds anything
 * but what is expected — a field more, a text that is not one of the names
 * allowed — is refused whole: what is stored is rebuilt field by field from
 * what was checked, never copied from what arrived.
 *
 * Settings (wrangler.toml and secrets):
 *   GITHUB_REPO   "owner/name" of the private repository
 *   GITHUB_TOKEN  a token that can write the contents of that repository only
 *   GITHUB_BRANCH the branch written to (default: main)
 *   LIMITER       optional rate limiting binding
 */

const MAX_BYTES = 256 * 1024;
const MAX_GROUPS = 500;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const WEEK = /^\d{4}-W\d{2}$/;
const VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,4}$/;
const MODEL = /^[a-z0-9][a-z0-9._-]{0,60}\/[a-z0-9][a-z0-9._:-]{0,100}$/;
export const ROLES = ['master', 'microtask', 'compaction', 'realtime', 'speech', 'transcription', 'image', 'video', 'music', 'computer_use', 'tour', 'other'];
export const TOOLS = ['text_to_image', 'image_to_image', 'text_to_video', 'image_to_video', 'image_inspection', 'video_inspection',
  'audio_transcription', 'voice_synthesis', 'music_generation', 'pdf_parser', 'thinking_solver', 'web_search', 'web_browse', 'model_search', 'other'];
export const JOBS = ['page', 'analysis', 'study', 'tidy', 'data', 'review', 'advice', 'other'];
export const LANGUAGES = ['javascript', 'typescript', 'python', 'rust', 'go', 'java', 'kotlin', 'swift', 'c', 'cpp', 'csharp', 'ruby', 'php', 'lua', 'shell',
  'sql', 'r', 'dart', 'scala', 'html', 'css', 'vue', 'svelte', 'markdown', 'data', 'notebook'];
const PLACES = ['chat', 'project', 'realtime', 'tasks', 'other'];
const SIZES = ['S', 'M', 'L', 'XL', 'unknown'];
const COUNTS = ['runs', 'ok', 'stopped', 'turns', 'corrected', 'reverted', 'unpriced', 'prompt_tokens', 'completion_tokens', 'cached_tokens', 'reasoning_tokens'];
const TIMES = ['ms_p50', 'ms_p90', 'first_ms_p50', 'first_ms_p90', 'tokens_per_second_p50'];

class Refused extends Error {}
const refuse = (why) => { throw new Refused(why); };

/** An object with these keys and no other. */
function only(value, keys, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) refuse(`${name}: not an object`);
  const extra = Object.keys(value).filter(key => !keys.includes(key));
  if (extra.length) refuse(`${name}: unexpected field`);
  const missing = keys.filter(key => !(key in value));
  if (missing.length) refuse(`${name}: missing ${missing[0]}`);
  return value;
}

function role(value) {
  if (typeof value !== 'string') refuse('role');
  const [kind, name, more] = value.split(':');
  if (more !== undefined) refuse('role');
  if (name === undefined) return ROLES.includes(kind) ? kind : refuse('role');
  if (kind === 'tool' && TOOLS.includes(name)) return value;
  if (kind === 'job' && JOBS.includes(name)) return value;
  return refuse('role');
}

function number(value, name, { whole = false, most = 1e12, empty = false } = {}) {
  if (value === null && empty) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > most || (whole && !Number.isInteger(value))) refuse(name);
  return value;
}

/** The package, rebuilt from what was checked. Anything unexpected refuses it whole. */
export function clean(input) {
  const p = only(input, ['schema', 'id', 'app', 'weeks', 'groups'], 'package');
  if (p.schema !== 1) refuse('schema');
  if (typeof p.id !== 'string' || !UUID.test(p.id)) refuse('id');
  if (typeof p.app !== 'string' || (p.app !== '' && !VERSION.test(p.app))) refuse('app');
  const weeks = only(p.weeks, ['from', 'to'], 'weeks');
  if (typeof weeks.from !== 'string' || typeof weeks.to !== 'string' || !WEEK.test(weeks.from) || !WEEK.test(weeks.to) || weeks.from > weeks.to) refuse('weeks');
  if (!Array.isArray(p.groups) || !p.groups.length || p.groups.length > MAX_GROUPS) refuse('groups');
  const groups = p.groups.map(input => {
    const g = only(input, ['model', 'role', 'place', 'project', 'queued', ...COUNTS, 'cost', ...TIMES], 'group');
    if (typeof g.model !== 'string' || !(g.model === 'local' || g.model === 'other' || MODEL.test(g.model))) refuse('model');
    if (!PLACES.includes(g.place)) refuse('place');
    if (typeof g.queued !== 'boolean') refuse('queued');
    let project = null;
    if (g.project !== null) {
      const kind = only(g.project, ['languages', 'size'], 'project');
      if (!Array.isArray(kind.languages) || kind.languages.length > 3 || kind.languages.some(l => !LANGUAGES.includes(l))) refuse('languages');
      if (!SIZES.includes(kind.size)) refuse('size');
      project = { languages: [...kind.languages], size: kind.size };
    }
    const out = { model: g.model, role: role(g.role), place: g.place, project, queued: g.queued };
    COUNTS.forEach(key => { out[key] = number(g[key], key, { whole: true }); });
    out.cost = number(g.cost, 'cost', { most: 1e6 });
    TIMES.forEach(key => { out[key] = number(g[key], key, { most: 1e8, empty: true }); });
    if (out.ok > out.runs || out.turns > out.runs || out.corrected > out.turns || out.reverted > out.turns) refuse('counts');
    return out;
  });
  return { schema: 1, id: p.id, app: p.app, weeks: { from: weeks.from, to: weeks.to }, groups };
}

const answer = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });

/** Text as base64, whatever its letters. */
function base64(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

export default {
  async fetch(request, env) {
    if (request.method !== 'POST') return answer(405, { error: 'POST only' });
    if (!env.GITHUB_REPO || !env.GITHUB_TOKEN || !/^[\w.-]+\/[\w.-]+$/.test(env.GITHUB_REPO)) return answer(503, { error: 'not set up' });
    // Too many from one place in a short time are turned away; the place is looked at, never written down.
    if (env.LIMITER) {
      const { success } = await env.LIMITER.limit({ key: request.headers.get('cf-connecting-ip') || 'unknown' });
      if (!success) return answer(429, { error: 'too many' });
    }
    if (Number(request.headers.get('content-length')) > MAX_BYTES) return answer(413, { error: 'too large' });
    const text = await request.text();
    if (text.length > MAX_BYTES) return answer(413, { error: 'too large' });
    let shared;
    try {
      shared = clean(JSON.parse(text));
    } catch (error) {
      return answer(400, { error: error instanceof Refused ? `refused: ${error.message}` : 'not JSON' });
    }
    const file = `packages/${shared.weeks.to}/${shared.id}.json`;
    const stored = await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}/contents/${file}`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${env.GITHUB_TOKEN}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'synthorg-share-worker',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ message: `numbers ${shared.weeks.from} to ${shared.weeks.to}`, content: base64(JSON.stringify(shared, null, 2) + '\n'), branch: env.GITHUB_BRANCH || 'main' })
    });
    // The same package sent twice is there already: nothing to do, and nothing wrong.
    if (stored.status === 422) return answer(200, { stored: true, already: true });
    if (!stored.ok) return answer(502, { error: 'not stored' });
    return answer(200, { stored: true });
  }
};
