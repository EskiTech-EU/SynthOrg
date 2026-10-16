'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { fail, projectEnvs } = require('./database');
const { DATA_DIR } = require('./paths');
const tex = require('./studio-tex');

/**
 * The Studio: long texts — novels, screenplays, essays — written in a folder
 * of the user's, read and typeset by SynthOrg.
 *
 * A Studio project is a Code project of another section: the same folder,
 * the same git record, the same project chats. What differs is what is in
 * the folder: not code but chapters, and each chapter is two sheets.
 *
 *   draft  what the author types, as they like, one paragraph per blank line;
 *   clean  the same paragraphs set right by the model — spelling, grammar,
 *          punctuation, formatting — keeping the author's style and meaning.
 *
 * The two sheets are one list of paragraphs: every paragraph has its draft
 * and its clean text, and remembers which draft its clean text was made
 * from. When the draft changes, the clean text is stale and is made again;
 * when the author corrects the clean text by hand it is theirs and stays
 * until the draft changes; when the model rewrites it from the chat (asked
 * to add, remove, change more heavily) the draft stays as the author wrote
 * it and the clean text is the model's.
 *
 * The chapters live as JSON files in the folder, one per chapter, with the
 * project's manifest beside them; everything the model does to them goes
 * through the record like a Code project's tools. The typeset document is
 * generated from the clean sheets and compiled in a container (studio-tex.js);
 * the PDF stays in SynthOrg's data folder until the user exports it.
 *
 * The model is given the text the way the chats' level memory gives a long
 * conversation: a map of nodes with titles — parts, chapters, scenes — within
 * a cap, finer around the chapter being worked on, and a tool to open any
 * node down to the paragraphs themselves (studio_open), plus one to read any
 * range of a chapter as numbered paragraphs (studio_read). The summaries are
 * written by a model from the page, in the background; this module says
 * which are missing and keeps the ones that come back.
 */

const TYPES = ['romanzo', 'copione', 'saggio'];
const LANGUAGES = ['it', 'en'];
const MANIFEST = 'studio.json';
const CHAPTERS_DIR = 'capitoli';
const EXPORT_DIR = 'esportazioni';
const MANIFEST_VERSION = 1;
const MAX_PARAGRAPH_CHARS = 20000;
const MAX_CHAPTER_CHARS = 2 * 1024 * 1024;
const MAX_CHAPTERS = 500;
const STUDIO_BLOCK_TITLE = '[STUDIO]';

const DEFAULT_SETTINGS = Object.freeze({ auto: true, pauseMs: 4000, cap: 32000, share: 0.3 });
const LIMITS = Object.freeze({ capMin: 4000, capMax: 2000000, shareMax: 0.9, pauseMin: 1000, pauseMax: 120000 });
// A level-1 node covers about this much text: a scene's worth.
const CHUNK_TOKENS = 1200;
// Chapters per part (level 3). Below twice this many chapters no part is made: the chapters alone are the map.
const PART_FAN = 6;
// A token is about four characters: the same rule as the chats' memory.
const tokens = text => Math.ceil(String(text || '').length / 4);
const words = text => (String(text || '').match(/[\p{L}\p{N}’'-]+/gu) || []).length;
const now = () => new Date().toISOString();
const shortId = () => crypto.randomBytes(5).toString('hex');
const hashOf = text => crypto.createHash('sha1').update(String(text || '').trim()).digest('hex').slice(0, 12);

function isDirectory(value) {
  try { return fs.statSync(value).isDirectory(); } catch { return false; }
}

/** Paragraphs as the author separates them: blank lines. Line breaks inside stay (a verse, a list). */
function splitParagraphs(text) {
  return String(text || '').replace(/\r\n?/g, '\n').split(/\n[ \t]*\n+/).map(p => p.replace(/^\n+|\n+$/g, '').replace(/[ \t]+$/gm, '')).filter(p => p.trim());
}

function joinParagraphs(list) {
  return list.join('\n\n');
}

function normalizeSettings(input, fallback) {
  const out = {};
  const num = v => (v === undefined || v === null || v === '' ? NaN : Number(v));
  if (input && typeof input === 'object') {
    if (typeof input.auto === 'boolean') out.auto = input.auto;
    const pause = num(input.pauseMs);
    if (Number.isFinite(pause)) out.pauseMs = Math.min(LIMITS.pauseMax, Math.max(LIMITS.pauseMin, Math.round(pause)));
    const cap = num(input.cap);
    if (Number.isFinite(cap)) out.cap = Math.min(LIMITS.capMax, Math.max(LIMITS.capMin, Math.round(cap)));
    const share = num(input.share);
    if (Number.isFinite(share)) out.share = Math.min(LIMITS.shareMax, Math.max(0, share));
  }
  return { ...fallback, ...out };
}

/**
 * The author's new draft laid over the paragraphs as they were, so that a
 * paragraph keeps its identity (and its clean text) when it is untouched,
 * is the same paragraph when its words changed in place, and is new or gone
 * when it was added or removed. Decided by text and position, never by a
 * model.
 */
function mergeDraft(existing, texts) {
  const taken = new Array(existing.length).fill(false);
  const byText = new Map();
  existing.forEach((p, i) => {
    const key = p.draft.trim();
    if (!byText.has(key)) byText.set(key, []);
    byText.get(key).push(i);
  });
  // Exact matches first: the anchors.
  const matched = texts.map(text => {
    const queue = byText.get(text.trim());
    while (queue && queue.length) {
      const i = queue.shift();
      if (!taken[i]) { taken[i] = true; return i; }
    }
    return -1;
  });
  // The rest in order, each between its neighbouring anchors.
  const result = [];
  for (let n = 0; n < texts.length; n++) {
    if (matched[n] !== -1) { result.push({ ...existing[matched[n]], draft: texts[n] }); continue; }
    let lo = 0, hi = existing.length - 1;
    for (let k = n - 1; k >= 0; k--) if (matched[k] !== -1) { lo = matched[k] + 1; break; }
    for (let k = n + 1; k < texts.length; k++) if (matched[k] !== -1) { hi = matched[k] - 1; break; }
    let found = -1;
    for (let i = lo; i <= hi; i++) if (!taken[i]) { found = i; break; }
    if (found !== -1) {
      taken[found] = true;
      matched[n] = found;
      result.push({ ...existing[found], draft: texts[n] });
    } else {
      result.push({ id: shortId(), draft: texts[n], clean: '', cleanOf: null, own: false });
    }
  }
  return result;
}

/** The text a paragraph is read by: the clean one, or the draft while there is none. */
function textOf(p) {
  return p.clean && p.clean.trim() ? p.clean : p.draft;
}

/** Whether a paragraph's clean text is from its current draft. */
function isClean(p) {
  return Boolean(p.clean && p.clean.trim()) && p.cleanOf === hashOf(p.draft);
}

// --- LaTeX --------------------------------------------------------------------

function escapeTex(text) {
  return String(text)
    .replace(/\\/g, '\u0000')
    .replace(/([{}$&#_%])/g, '\\$1')
    .replace(/~/g, '\\textasciitilde{}')
    .replace(/\^/g, '\\textasciicircum{}')
    .replace(/\u0000/g, '\\textbackslash{}');
}

/** *italic* and **bold** as the sheets use them, after escaping; straight quotes become typographic ones. */
function inlineTex(text, language) {
  let out = escapeTex(text);
  out = out.replace(/\*\*([^*\n]+?)\*\*/g, '\\textbf{$1}').replace(/(^|[^*\\])\*([^*\n]+?)\*/g, '$1\\emph{$2}');
  // "…" → «…» in Italian, “…” in English; '…' stays as typed.
  const open = language === 'it' ? '«' : '“', close = language === 'it' ? '»' : '”';
  let quoted = false;
  out = out.replace(/"/g, () => { quoted = !quoted; return quoted ? open : close; });
  out = out.replace(/ -- /g, ' – ').replace(/\.\.\./g, '…');
  return out;
}

/** A prose paragraph as a block: heading, quotation, list, scene break, or a plain paragraph. */
function proseBlock(text, language, type) {
  const lines = text.split('\n');
  const first = lines[0];
  if (/^(\*\s*\*\s*\*|-{3,}|\*{3,})\s*$/.test(first) && lines.length === 1) return '\\scenebreak';
  if (/^#{1,3}\s+/.test(first) && lines.length === 1) {
    const depth = first.match(/^(#+)/)[1].length;
    const title = inlineTex(first.replace(/^#+\s+/, ''), language);
    if (type === 'saggio') return depth === 1 ? `\\subsection{${title}}` : `\\subsubsection{${title}}`;
    return depth === 1 ? `\\innerheading{${title}}` : `\\innersubheading{${title}}`;
  }
  if (lines.every(line => /^>\s?/.test(line))) {
    return `\\begin{quote}\n${lines.map(line => inlineTex(line.replace(/^>\s?/, ''), language)).join('\\\\\n')}\n\\end{quote}`;
  }
  if (lines.every(line => /^(-|\*|•)\s+/.test(line))) {
    return `\\begin{itemize}\n${lines.map(line => `\\item ${inlineTex(line.replace(/^(-|\*|•)\s+/, ''), language)}`).join('\n')}\n\\end{itemize}`;
  }
  if (lines.every(line => /^\d+[.)]\s+/.test(line))) {
    return `\\begin{enumerate}\n${lines.map(line => `\\item ${inlineTex(line.replace(/^\d+[.)]\s+/, ''), language)}`).join('\n')}\n\\end{enumerate}`;
  }
  return lines.map(line => inlineTex(line, language)).join('\\\\\n');
}

/**
 * Fountain, the plain-text screenplay format, read block by block: a scene
 * heading, a character with what they say, a transition, a centred line,
 * or action.
 */
function screenplayBlock(text, language) {
  const lines = text.split('\n');
  const first = lines[0].trim();
  const upper = s => s === s.toUpperCase() && /[A-ZÀ-Ý]/.test(s);
  if (lines.length === 1 && /^\.(?!\.)/.test(first)) return `\\slug{${inlineTex(first.slice(1).trim(), language)}}`;
  if (lines.length === 1 && /^(INT|EXT|EST|INT\.?\/EXT|I\/E)[\s./-]/i.test(first) && upper(first)) return `\\slug{${inlineTex(first, language)}}`;
  if (lines.length === 1 && /^>\s*.+\s*<$/.test(first)) return `\\centered{${inlineTex(first.replace(/^>\s*|\s*<$/g, ''), language)}}`;
  if (lines.length === 1 && (/^>\s*/.test(first) || (upper(first) && /(TO|A|:)\s*:?$/.test(first) && /:$/.test(first)))) {
    return `\\transition{${inlineTex(first.replace(/^>\s*/, ''), language)}}`;
  }
  if (lines.length === 1 && /^(===+|---+)$/.test(first)) return '\\newpage';
  const cue = first.replace(/^@/, '');
  if (lines.length > 1 && (first.startsWith('@') || upper(cue.replace(/\(.*?\)/g, '').trim()))) {
    const out = [`\\cue{${inlineTex(cue, language)}}`];
    for (const line of lines.slice(1)) {
      const t = line.trim();
      if (!t) continue;
      if (/^\(.*\)$/.test(t)) out.push(`\\paren{${inlineTex(t.slice(1, -1), language)}}`);
      else out.push(`\\dialogue{${inlineTex(t, language)}}`);
    }
    return out.join('\n');
  }
  return `\\action{${lines.map(line => inlineTex(line, language)).join('\\\\\n')}}`;
}

const PREAMBLES = {
  romanzo: ({ language }) => `\\documentclass[11pt,openany,twoside]{book}
\\usepackage{fontspec}
\\usepackage{polyglossia}
\\setdefaultlanguage{${language === 'it' ? 'italian' : 'english'}}
\\usepackage[a5paper,inner=20mm,outer=16mm,top=20mm,bottom=22mm]{geometry}
\\usepackage{setspace}
\\usepackage{titlesec}
\\setstretch{1.12}
\\setlength{\\parindent}{1.2em}
\\setlength{\\parskip}{0pt}
\\titleformat{\\chapter}[display]{\\normalfont\\large\\centering}{\\chaptertitlename\\ \\thechapter}{6pt}{\\Large\\bfseries}
\\titlespacing*{\\chapter}{0pt}{30pt}{28pt}
\\newcommand{\\scenebreak}{\\par\\vspace{1.2em}\\noindent\\centerline{*\\quad*\\quad*}\\vspace{1.2em}\\par\\noindent}
\\newcommand{\\innerheading}[1]{\\par\\vspace{1.4em}\\noindent{\\large\\bfseries #1}\\par\\vspace{0.6em}\\noindent}
\\newcommand{\\innersubheading}[1]{\\par\\vspace{1em}\\noindent{\\bfseries #1}\\par\\vspace{0.4em}\\noindent}
\\pagestyle{plain}`,
  saggio: ({ language }) => `\\documentclass[11pt]{article}
\\usepackage{fontspec}
\\usepackage{polyglossia}
\\setdefaultlanguage{${language === 'it' ? 'italian' : 'english'}}
\\usepackage[a4paper,margin=25mm]{geometry}
\\usepackage{setspace}
\\setstretch{1.15}
\\setlength{\\parindent}{0pt}
\\setlength{\\parskip}{0.6em}
\\newcommand{\\scenebreak}{\\par\\vspace{1em}\\noindent\\centerline{*\\quad*\\quad*}\\vspace{1em}\\par}
\\newcommand{\\innerheading}[1]{\\subsection*{#1}}
\\newcommand{\\innersubheading}[1]{\\subsubsection*{#1}}`,
  copione: ({ language }) => `\\documentclass[12pt]{article}
\\usepackage{fontspec}
\\setmainfont{texgyrecursor-regular.otf}[BoldFont=texgyrecursor-bold.otf,ItalicFont=texgyrecursor-italic.otf,BoldItalicFont=texgyrecursor-bolditalic.otf]
\\usepackage{polyglossia}
\\setdefaultlanguage{${language === 'it' ? 'italian' : 'english'}}
\\usepackage[a4paper,left=38mm,right=25mm,top=25mm,bottom=25mm]{geometry}
\\setlength{\\parindent}{0pt}
\\setlength{\\parskip}{0pt}
\\raggedright
\\newcommand{\\slug}[1]{\\par\\vspace{1.4em}\\noindent\\textbf{#1}\\par\\vspace{0.8em}}
\\newcommand{\\action}[1]{\\par\\noindent #1\\par\\vspace{0.8em}}
\\newcommand{\\cue}[1]{\\par\\vspace{0.3em}\\noindent\\hspace*{0.36\\textwidth}#1\\par}
\\newcommand{\\paren}[1]{\\noindent\\hspace*{0.28\\textwidth}\\parbox{0.4\\textwidth}{\\raggedright(#1)}\\par}
\\newcommand{\\dialogue}[1]{\\noindent\\hspace*{0.18\\textwidth}\\parbox{0.6\\textwidth}{\\raggedright #1}\\par\\vspace{0.8em}}
\\newcommand{\\transition}[1]{\\par\\vspace{0.5em}\\noindent\\hfill #1\\par\\vspace{1em}}
\\newcommand{\\centered}[1]{\\par\\begin{center}#1\\end{center}}
\\newcommand{\\sequence}[1]{\\clearpage\\par\\noindent\\centerline{\\textbf{\\MakeUppercase{#1}}}\\par\\vspace{1.5em}}`
};

function chapterHeading(type, title, index) {
  const safe = inlineTex(title, 'it');
  if (type === 'romanzo') return `\\chapter{${safe}}`;
  if (type === 'saggio') return `\\section{${safe}}`;
  return `\\sequence{${safe}}`;
}

/** The whole document from the clean sheets: what the compile container receives. */
function latexDocument(manifest, chapters) {
  const type = TYPES.includes(manifest.type) ? manifest.type : 'romanzo';
  const language = LANGUAGES.includes(manifest.language) ? manifest.language : 'it';
  const out = [PREAMBLES[type]({ language })];
  out.push(`\\title{${inlineTex(manifest.title || '', language)}}`);
  out.push(`\\author{${inlineTex(manifest.author || '', language)}}`);
  out.push('\\date{}');
  out.push('\\begin{document}');
  if (type === 'romanzo') out.push('\\frontmatter');
  out.push('\\maketitle');
  if (type === 'saggio') out.push('\\tableofcontents\\clearpage');
  if (type === 'romanzo') out.push('\\mainmatter');
  chapters.forEach((chapter, index) => {
    out.push('');
    out.push(`% --- ${index + 1}. ${chapter.title}`);
    out.push(chapterHeading(type, chapter.title, index));
    for (const p of chapter.paragraphs) {
      const text = textOf(p);
      if (!text || !text.trim()) continue;
      out.push('');
      out.push(type === 'copione' ? screenplayBlock(text, language) : proseBlock(text, language, type));
    }
  });
  out.push('');
  out.push('\\end{document}');
  return out.join('\n') + '\n';
}

/** Sample documents with every construct the templates can produce: what the cache is warmed with. Not a word of the user's. */
function warmDocuments() {
  const files = {};
  const prose = [
    'Prima riga del capitolo, con *corsivo*, **grassetto** e "virgolette" -- e un trattino lungo... così.',
    '# Un titolo interno\n\nSecondo paragrafo\ncon un a capo dentro.',
    '> Una citazione\n> su due righe.',
    '- un elenco\n- di tre\n- voci',
    '1. primo\n2. secondo',
    '---',
    'Caratteri speciali: & % $ # _ { } ~ ^ \\ e àèìòù ÀÈÌÒÙ.'
  ];
  const script = [
    'INT. CUCINA - GIORNO',
    'Una stanza piena di luce. Qualcuno apre la finestra.',
    'MARIA\n(sottovoce)\nNon dirlo a nessuno.',
    '@Voce fuori campo (V.O.)\nLo sapevano tutti.',
    '> TAGLIO SU:',
    '> FINE <',
    '.PIAZZA, NOTTE'
  ];
  for (const type of TYPES) {
    for (const language of LANGUAGES) {
      const blocks = (type === 'copione' ? script : prose).map(draft => ({ id: shortId(), draft, clean: draft, cleanOf: hashOf(draft), own: false }));
      const manifest = { type, language, title: 'Documento di prova', author: 'SynthOrg' };
      files[`warm-${type}-${language}.tex`] = latexDocument(manifest, [
        { title: 'Primo', paragraphs: blocks },
        { title: 'Secondo', paragraphs: blocks.slice(0, 2) }
      ]);
    }
  }
  return files;
}

/** Markdown of the clean sheets, for an export that is plain text. */
function markdownDocument(manifest, chapters) {
  const out = [`# ${manifest.title || ''}`, manifest.author ? `*${manifest.author}*` : '', ''];
  chapters.forEach((chapter, index) => {
    out.push(`## ${index + 1}. ${chapter.title}`, '');
    for (const p of chapter.paragraphs) { const text = textOf(p); if (text && text.trim()) out.push(text, ''); }
  });
  return out.join('\n');
}

// --- the manager ----------------------------------------------------------------

class StudioManager {
  constructor({ store, projects, permissions = null, sandbox = null, dataDir = null }) {
    this.store = store;
    this.projects = projects;
    this.permissions = permissions;
    this.sandbox = sandbox;
    this.dataDir = dataDir || DATA_DIR;
    // Compiles and the cache warm-up in flight: the page polls them.
    this.jobs = new Map();
    this.warm = null;
    this.ensureTables();
  }

  ensureTables() {
    const store = this.store();
    if (!store) return;
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS studio_nodes (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        key TEXT NOT NULL,
        level INTEGER NOT NULL CHECK(level >= 1),
        chapter_id TEXT,
        first_idx INTEGER NOT NULL,
        last_idx INTEGER NOT NULL,
        title TEXT NOT NULL DEFAULT '',
        content TEXT NOT NULL,
        facts_json TEXT NOT NULL DEFAULT '[]',
        tokens INTEGER NOT NULL,
        hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(project_id, key)
      );
    `);
  }

  // --- files -----------------------------------------------------------------

  project(id) {
    const project = this.store().project(id);
    if (!projectEnvs(project).includes('writing')) fail('Non è un progetto di Studio.', 400);
    return project;
  }

  /**
   * Where the project's files of this kind are, on this computer: the project's
   * own folder, or — for a project that is in a pod — the folder of its
   * artifacts, kept here (projects.js, `artifactsDir`). The editor runs at this
   * computer either way, and works on files of this computer.
   */
  folderOf(project) {
    if (project.kind !== 'local') return this.projects.artifactsDir(project);
    if (!isDirectory(project.path)) fail(`La cartella del progetto non è più disponibile: ${project.path}`, 410);
    return project.path;
  }

  manifestPath(project) { return path.join(this.folderOf(project), MANIFEST); }
  chapterPath(project, chapterId) {
    if (!/^[a-f0-9]{10}$/.test(String(chapterId))) fail('Capitolo non valido.');
    return path.join(this.folderOf(project), CHAPTERS_DIR, `${chapterId}.json`);
  }

  readManifest(project) {
    const file = this.manifestPath(project);
    if (!fs.existsSync(file)) fail('Questa cartella non contiene ancora un progetto di Studio.', 409);
    let data;
    try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { fail(`Il file ${MANIFEST} non si legge.`, 500); }
    if (!data || typeof data !== 'object' || !Array.isArray(data.chapters)) fail(`Il file ${MANIFEST} non ha la forma attesa.`, 500);
    data.settings = normalizeSettings(data.settings, DEFAULT_SETTINGS);
    return data;
  }

  writeManifest(project, manifest) {
    manifest.updatedAt = now();
    fs.writeFileSync(this.manifestPath(project), JSON.stringify(manifest, null, 2) + '\n', 'utf8');
    return manifest;
  }

  readChapter(project, chapterId) {
    const file = this.chapterPath(project, chapterId);
    if (!fs.existsSync(file)) fail('Capitolo non trovato.', 404);
    let data;
    try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { fail('Il file del capitolo non si legge.', 500); }
    if (!data || !Array.isArray(data.paragraphs)) fail('Il file del capitolo non ha la forma attesa.', 500);
    data.paragraphs = data.paragraphs.map(p => ({
      id: typeof p.id === 'string' && /^[a-f0-9]{10}$/.test(p.id) ? p.id : shortId(),
      draft: String(p.draft || ''), clean: String(p.clean || ''),
      cleanOf: typeof p.cleanOf === 'string' ? p.cleanOf : null, own: Boolean(p.own)
    }));
    return data;
  }

  writeChapter(project, chapter) {
    const file = this.chapterPath(project, chapter.id);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    chapter.updatedAt = now();
    const json = JSON.stringify(chapter, null, 2) + '\n';
    if (json.length > MAX_CHAPTER_CHARS) fail('Il capitolo è troppo grande: dividilo.', 413);
    fs.writeFileSync(file, json, 'utf8');
    return chapter;
  }

  /** The folder becomes a Studio project: the manifest and a first chapter, both recorded. */
  async init(project, input = {}) {
    const folder = this.folderOf(project);
    if (fs.existsSync(path.join(folder, MANIFEST))) return this.readManifest(project);
    const type = TYPES.includes(input.type) ? input.type : 'romanzo';
    const language = LANGUAGES.includes(input.language) ? input.language : 'it';
    const title = typeof input.title === 'string' && input.title.trim() ? input.title.trim().slice(0, 200) : project.name;
    const author = typeof input.author === 'string' ? input.author.trim().slice(0, 200) : '';
    const chapter = { id: shortId(), title: type === 'copione' ? 'Sequenza 1' : type === 'saggio' ? 'Introduzione' : 'Capitolo 1', paragraphs: [], createdAt: now() };
    this.writeChapter(project, chapter);
    const manifest = { version: MANIFEST_VERSION, type, language, title, author, settings: { ...DEFAULT_SETTINGS }, chapters: [{ id: chapter.id, title: chapter.title }], createdAt: now() };
    this.writeManifest(project, manifest);
    await this.record(project, 'Nuovo progetto di Studio', 'user');
    return manifest;
  }

  async record(project, message, source = 'user', tool = null) {
    try {
      return await this.projects.recordArtifacts(project, { message, source, tool });
    } catch (error) {
      return { ready: false, error: error.message };
    }
  }

  // --- what the page reads and writes --------------------------------------

  chapterEntries(project, manifest) {
    return manifest.chapters.map((entry, index) => {
      let chapter;
      try { chapter = this.readChapter(project, entry.id); } catch { chapter = { id: entry.id, title: entry.title, paragraphs: [], missing: true }; }
      const text = chapter.paragraphs.map(textOf).join('\n\n');
      return {
        id: entry.id, number: index + 1, title: entry.title || chapter.title || `${index + 1}`,
        paragraphs: chapter.paragraphs.length, words: words(text), tokens: tokens(text),
        pending: chapter.paragraphs.filter(p => p.draft.trim() && !isClean(p)).length,
        missing: Boolean(chapter.missing)
      };
    });
  }

  overview(id) {
    const project = this.project(id);
    const manifest = this.readManifest(project);
    const chapters = this.chapterEntries(project, manifest);
    const fallback = this.store().getSetting('studio_perm_text');
    return {
      id: project.id,
      project: { id: project.id, name: project.name, path: project.path },
      // What the model may change without asking: the project's own mode, or the Studio's default (automatic).
      perm: { text: ['manual', 'semi', 'auto'].includes(project.perm_code) ? project.perm_code : ['manual', 'semi', 'auto'].includes(fallback) ? fallback : 'auto' },
      type: manifest.type, language: manifest.language, title: manifest.title, author: manifest.author,
      settings: manifest.settings, focus: manifest.focus || (chapters[0] ? chapters[0].id : null),
      chapters, words: chapters.reduce((a, c) => a + c.words, 0),
      compile: this.compileStatus(id)
    };
  }

  chapter(id, chapterId) {
    const project = this.project(id);
    const manifest = this.readManifest(project);
    const entry = manifest.chapters.find(c => c.id === chapterId);
    if (!entry) fail('Capitolo non trovato.', 404);
    const chapter = this.readChapter(project, chapterId);
    return this.describeChapter(manifest, entry, chapter);
  }

  describeChapter(manifest, entry, chapter) {
    return {
      id: chapter.id, number: manifest.chapters.findIndex(c => c.id === chapter.id) + 1, title: entry?.title || chapter.title,
      draft: joinParagraphs(chapter.paragraphs.map(p => p.draft)),
      paragraphs: chapter.paragraphs.map((p, index) => ({ id: p.id, index: index + 1, draft: p.draft, clean: p.clean, own: p.own, stale: !isClean(p) })),
      words: words(chapter.paragraphs.map(textOf).join('\n'))
    };
  }

  /** The draft sheet as the author left it, laid over the chapter; recorded as the author's step. */
  async saveDraft(id, chapterId, input = {}) {
    const project = this.project(id);
    const manifest = this.readManifest(project);
    const entry = manifest.chapters.find(c => c.id === chapterId);
    if (!entry) fail('Capitolo non trovato.', 404);
    if (typeof input.draft !== 'string') fail('Testo mancante.');
    if (input.draft.length > MAX_CHAPTER_CHARS) fail('Il capitolo è troppo grande: dividilo.', 413);
    const chapter = this.readChapter(project, chapterId);
    const before = JSON.stringify(chapter.paragraphs);
    chapter.paragraphs = mergeDraft(chapter.paragraphs, splitParagraphs(input.draft));
    let git = null;
    if (JSON.stringify(chapter.paragraphs) !== before) {
      this.writeChapter(project, chapter);
      git = await this.record(project, `scrive ${entry.title}`, 'user');
    }
    return { ...this.describeChapter(manifest, entry, chapter), git };
  }

  /** The author's own correction of a clean paragraph: theirs, until the draft changes. */
  async editClean(id, chapterId, input = {}) {
    const project = this.project(id);
    const manifest = this.readManifest(project);
    const entry = manifest.chapters.find(c => c.id === chapterId);
    if (!entry) fail('Capitolo non trovato.', 404);
    const chapter = this.readChapter(project, chapterId);
    const p = chapter.paragraphs.find(x => x.id === input.id);
    if (!p) fail('Paragrafo non trovato.', 404);
    if (typeof input.clean !== 'string' || input.clean.length > MAX_PARAGRAPH_CHARS) fail('Testo non valido.');
    p.clean = input.clean.replace(/\r\n?/g, '\n').trim();
    p.cleanOf = hashOf(p.draft);
    p.own = true;
    this.writeChapter(project, chapter);
    const git = await this.record(project, `corregge ${entry.title}`, 'user');
    return { ...this.describeChapter(manifest, entry, chapter), git };
  }

  /**
   * What the correcting model is asked for a chapter: the paragraphs whose
   * draft changed since their clean text was made, with their neighbours as
   * context. Null when there is nothing to do.
   */
  cleanupRequest(id, chapterId, { limit = 12 } = {}) {
    const project = this.project(id);
    const manifest = this.readManifest(project);
    const entry = manifest.chapters.find(c => c.id === chapterId);
    if (!entry) fail('Capitolo non trovato.', 404);
    const chapter = this.readChapter(project, chapterId);
    const stale = chapter.paragraphs.map((p, index) => ({ p, index })).filter(({ p }) => p.draft.trim() && !isClean(p)).slice(0, limit);
    if (!stale.length) return null;
    const type = manifest.type;
    const lang = manifest.language === 'en' ? 'English' : 'italiano';
    const format = type === 'copione'
      ? 'Il testo è un copione in formato Fountain: INTESTAZIONE DI SCENA in maiuscolo (INT./EST.), NOME DEL PERSONAGGIO in maiuscolo da solo su una riga seguito dalle sue battute, (indicazioni) tra parentesi su una riga propria, le azioni in prosa normale, le transizioni in maiuscolo che finiscono con due punti precedute da >. Rispetta e correggi questa forma.'
      : 'Testo semplice con a capo tra i paragrafi; *corsivo* e **grassetto** come in Markdown; una riga che inizia con # è un titolo interno al capitolo, > una citazione, - una voce di elenco, --- da solo uno stacco di scena. Non aggiungere formattazione che l’autore non ha messo.';
    const system = [
      `Sei il correttore di bozze di un ${type === 'copione' ? 'copione' : type === 'saggio' ? 'saggio' : 'romanzo'} scritto in ${lang}.`,
      'Ricevi dei paragrafi come li ha scritti l’autore. Per ognuno restituisci la versione sistemata: ortografia, grammatica, punteggiatura, accordi, ripetizioni involontarie, spaziatura e formattazione.',
      'Mantieni il più possibile lo stile, il ritmo, il lessico, la voce e il significato dell’autore: non riscrivere, non aggiungere e non togliere contenuto, non cambiare punto di vista, tempo verbale o registro. Rendi il testo ben scritto, non diverso.',
      'Se un paragrafo è già a posto restituiscilo uguale. Se qualcosa è incomprensibile lascialo com’è.',
      format,
      'Rispondi solo con un oggetto JSON: {"paragraphs":[{"id":"…","text":"…"}]}, nello stesso ordine e con gli stessi id ricevuti, nessun altro testo.'
    ].join(' ');
    const lines = [];
    const first = stale[0].index, last = stale[stale.length - 1].index;
    const before = chapter.paragraphs[first - 1];
    const after = chapter.paragraphs[last + 1];
    if (before) lines.push(`Paragrafo precedente (già sistemato, non restituirlo):\n${textOf(before)}\n`);
    lines.push('Paragrafi da sistemare:');
    for (const { p } of stale) lines.push(`[${p.id}]\n${p.draft}\n`);
    if (after) lines.push(`Paragrafo seguente (non restituirlo):\n${textOf(after)}`);
    return {
      chapter: chapterId, ids: stale.map(({ p }) => p.id), hashes: Object.fromEntries(stale.map(({ p }) => [p.id, hashOf(p.draft)])),
      messages: [{ role: 'system', content: system }, { role: 'user', content: lines.join('\n') }],
      maxTokens: Math.min(16000, 400 + stale.reduce((a, { p }) => a + tokens(p.draft) * 2, 0))
    };
  }

  /** The model's answer to a cleanup request, kept for the paragraphs whose draft is still the one it saw. */
  async applyCleanup(id, chapterId, input = {}) {
    const project = this.project(id);
    const manifest = this.readManifest(project);
    const entry = manifest.chapters.find(c => c.id === chapterId);
    if (!entry) fail('Capitolo non trovato.', 404);
    const parsed = parseCleanup(input.text);
    if (!parsed) fail('La risposta del modello non è nel formato atteso.', 422);
    const hashes = input.hashes && typeof input.hashes === 'object' ? input.hashes : {};
    const chapter = this.readChapter(project, chapterId);
    let applied = 0;
    for (const item of parsed) {
      const p = chapter.paragraphs.find(x => x.id === item.id);
      if (!p || !item.text.trim()) continue;
      // The author kept typing meanwhile: this answer is about an older draft, the next run makes a new one.
      if (hashes[item.id] && hashes[item.id] !== hashOf(p.draft)) continue;
      p.clean = item.text.slice(0, MAX_PARAGRAPH_CHARS);
      p.cleanOf = hashOf(p.draft);
      p.own = false;
      applied++;
    }
    let git = null;
    if (applied) {
      this.writeChapter(project, chapter);
      git = await this.record(project, `sistema ${entry.title}`, 'agent', 'studio_clean');
    }
    return { applied, ...this.describeChapter(manifest, entry, chapter), git };
  }

  async setSettings(id, input = {}) {
    const project = this.project(id);
    const manifest = this.readManifest(project);
    manifest.settings = normalizeSettings(input, manifest.settings);
    if (typeof input.title === 'string') manifest.title = input.title.trim().slice(0, 200);
    if (typeof input.author === 'string') manifest.author = input.author.trim().slice(0, 200);
    if (input.type !== undefined) { if (!TYPES.includes(input.type)) fail('Tipo non valido.'); manifest.type = input.type; }
    if (input.language !== undefined) { if (!LANGUAGES.includes(input.language)) fail('Lingua non valida.'); manifest.language = input.language; }
    this.writeManifest(project, manifest);
    await this.record(project, 'impostazioni del progetto', 'user');
    return this.overview(id);
  }

  setFocus(id, chapterId) {
    const project = this.project(id);
    const manifest = this.readManifest(project);
    if (!manifest.chapters.some(c => c.id === chapterId)) fail('Capitolo non trovato.', 404);
    manifest.focus = chapterId;
    // Not a change to the text: written without a step of the record.
    fs.writeFileSync(this.manifestPath(project), JSON.stringify(manifest, null, 2) + '\n', 'utf8');
    return { focus: chapterId };
  }

  // --- chapters ------------------------------------------------------------------

  async chapterAction(id, input = {}, source = 'user', tool = null) {
    const project = this.project(id);
    const manifest = this.readManifest(project);
    const action = String(input.action || '');
    const titleOf = value => { const t = String(value ?? '').trim().slice(0, 200); if (!t) fail('Titolo mancante.'); return t; };
    const find = () => {
      const index = this.chapterIndex(manifest, input.chapter);
      return { index, entry: manifest.chapters[index] };
    };
    let message;
    if (action === 'add') {
      if (manifest.chapters.length >= MAX_CHAPTERS) fail('Troppi capitoli.', 413);
      const chapter = { id: shortId(), title: titleOf(input.title), paragraphs: [], createdAt: now() };
      if (typeof input.text === 'string' && input.text.trim()) chapter.paragraphs = splitParagraphs(input.text).map(text => ({ id: shortId(), draft: text, clean: text, cleanOf: hashOf(text), own: false }));
      this.writeChapter(project, chapter);
      const after = input.after === undefined || input.after === null ? manifest.chapters.length : Math.max(0, Math.min(manifest.chapters.length, Number(input.after) || 0));
      manifest.chapters.splice(after, 0, { id: chapter.id, title: chapter.title });
      manifest.focus = chapter.id;
      message = `nuovo capitolo ${chapter.title}`;
    } else if (action === 'rename') {
      const { entry } = find();
      const title = titleOf(input.title);
      message = `rinomina ${entry.title} in ${title}`;
      entry.title = title;
      const chapter = this.readChapter(project, entry.id);
      chapter.title = title;
      this.writeChapter(project, chapter);
    } else if (action === 'remove') {
      if (manifest.chapters.length <= 1) fail('Un progetto ha almeno un capitolo.', 409);
      const { index, entry } = find();
      manifest.chapters.splice(index, 1);
      // The file stays in the record: it is recoverable from the history.
      try { fs.rmSync(this.chapterPath(project, entry.id)); } catch {}
      if (manifest.focus === entry.id) manifest.focus = manifest.chapters[Math.min(index, manifest.chapters.length - 1)].id;
      message = `elimina ${entry.title}`;
    } else if (action === 'move') {
      const { index, entry } = find();
      const to = Math.max(0, Math.min(manifest.chapters.length - 1, (Number(input.to) || 1) - 1));
      manifest.chapters.splice(index, 1);
      manifest.chapters.splice(to, 0, entry);
      message = `sposta ${entry.title} al posto ${to + 1}`;
    } else fail('Azione non valida: add, rename, remove o move.');
    this.writeManifest(project, manifest);
    const git = await this.record(project, message, source, tool);
    return { ...this.overview(id), git };
  }

  /** A chapter as the model or the page names it: its number, its id or its title. */
  chapterIndex(manifest, value) {
    if (value === undefined || value === null || value === '') fail('Capitolo mancante.');
    const asNumber = Number(value);
    if (Number.isInteger(asNumber) && asNumber >= 1 && asNumber <= manifest.chapters.length && String(value).trim() === String(asNumber)) return asNumber - 1;
    const text = String(value).trim();
    let index = manifest.chapters.findIndex(c => c.id === text);
    if (index === -1) index = manifest.chapters.findIndex(c => c.title.toLowerCase() === text.toLowerCase());
    if (index === -1) fail(`Capitolo non trovato: ${text}. Indicalo col suo numero.`, 404);
    return index;
  }

  // --- the model's hands ---------------------------------------------------------

  async readRange(id, input = {}) {
    const project = this.project(id);
    const manifest = this.readManifest(project);
    const index = this.chapterIndex(manifest, input.chapter);
    const entry = manifest.chapters[index];
    const chapter = this.readChapter(project, entry.id);
    const total = chapter.paragraphs.length;
    const from = Math.max(1, Number(input.from) || 1);
    const to = Math.min(total, Number(input.to) || Math.min(total, from + 59));
    const lines = [];
    for (let i = from; i <= to; i++) {
      const p = chapter.paragraphs[i - 1];
      const mark = isClean(p) ? '' : p.clean && p.clean.trim() ? ' (brutta cambiata, bella da rifare)' : ' (solo brutta)';
      lines.push(`${i}|${mark} ${textOf(p).replace(/\n/g, '\n   ')}`);
    }
    return { chapter: index + 1, title: entry.title, from, to, total, text: lines.join('\n\n') || '(capitolo vuoto)' };
  }

  async replaceRange(id, input = {}, tool = 'studio_replace') {
    const project = this.project(id);
    const manifest = this.readManifest(project);
    const index = this.chapterIndex(manifest, input.chapter);
    const entry = manifest.chapters[index];
    const chapter = this.readChapter(project, entry.id);
    const total = chapter.paragraphs.length;
    const from = Number(input.from), to = input.to === undefined ? from : Number(input.to);
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to < from || to > total) fail(`Intervallo non valido: il capitolo ha ${total} paragrafi.`);
    if (typeof input.text !== 'string') fail('Testo mancante.');
    const texts = splitParagraphs(input.text);
    const olds = chapter.paragraphs.slice(from - 1, to);
    const news = texts.map((text, i) => {
      const old = olds.length === texts.length ? olds[i] : null;
      // Same count: each paragraph keeps its identity and the author's draft; the clean text is the model's.
      if (old) return { ...old, clean: text, cleanOf: hashOf(old.draft), own: false };
      return { id: shortId(), draft: text, clean: text, cleanOf: hashOf(text), own: false };
    });
    chapter.paragraphs.splice(from - 1, to - from + 1, ...news);
    this.writeChapter(project, chapter);
    const git = await this.record(project, `riscrive ${entry.title} ${from}${to > from ? `-${to}` : ''}`, 'agent', tool);
    return { chapter: index + 1, replaced: to - from + 1, with: news.length, total: chapter.paragraphs.length, git };
  }

  async insertAt(id, input = {}, tool = 'studio_insert') {
    const project = this.project(id);
    const manifest = this.readManifest(project);
    const index = this.chapterIndex(manifest, input.chapter);
    const entry = manifest.chapters[index];
    const chapter = this.readChapter(project, entry.id);
    const total = chapter.paragraphs.length;
    const after = input.after === undefined || input.after === null ? total : Number(input.after);
    if (!Number.isInteger(after) || after < 0 || after > total) fail(`Posizione non valida: il capitolo ha ${total} paragrafi (after da 0 a ${total}).`);
    if (typeof input.text !== 'string' || !input.text.trim()) fail('Testo mancante.');
    const news = splitParagraphs(input.text).map(text => ({ id: shortId(), draft: text, clean: text, cleanOf: hashOf(text), own: false }));
    chapter.paragraphs.splice(after, 0, ...news);
    this.writeChapter(project, chapter);
    const git = await this.record(project, `aggiunge a ${entry.title} dopo ${after}`, 'agent', tool);
    return { chapter: index + 1, inserted: news.length, from: after + 1, to: after + news.length, total: chapter.paragraphs.length, git };
  }

  async deleteRange(id, input = {}, tool = 'studio_delete') {
    const project = this.project(id);
    const manifest = this.readManifest(project);
    const index = this.chapterIndex(manifest, input.chapter);
    const entry = manifest.chapters[index];
    const chapter = this.readChapter(project, entry.id);
    const total = chapter.paragraphs.length;
    const from = Number(input.from), to = input.to === undefined ? from : Number(input.to);
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to < from || to > total) fail(`Intervallo non valido: il capitolo ha ${total} paragrafi.`);
    chapter.paragraphs.splice(from - 1, to - from + 1);
    this.writeChapter(project, chapter);
    const git = await this.record(project, `toglie da ${entry.title} ${from}${to > from ? `-${to}` : ''}`, 'agent', tool);
    return { chapter: index + 1, deleted: to - from + 1, total: chapter.paragraphs.length, git };
  }

  async run(id, name, input = {}) {
    switch (name) {
      case 'studio_read': return this.readRange(id, input);
      case 'studio_open': return this.open(id, input.node);
      case 'studio_replace': return this.replaceRange(id, input);
      case 'studio_insert': return this.insertAt(id, input);
      case 'studio_delete': return this.deleteRange(id, input);
      case 'studio_chapter': return this.chapterAction(id, input, 'agent', 'studio_chapter');
      default: fail('Strumento non trovato.', 404);
    }
  }

  // --- the map of the text: nodes with titles, like the chats' level memory ----------

  /** The nodes the text should have now, from its current sheets: what is compared with what is stored. */
  expectedNodes(project, manifest) {
    const expected = [];
    const chapters = manifest.chapters.map((entry, index) => {
      let chapter;
      try { chapter = this.readChapter(project, entry.id); } catch { chapter = { id: entry.id, paragraphs: [] }; }
      return { entry, index, chapter };
    });
    const chapterKeys = [];
    for (const { entry, index, chapter } of chapters) {
      const chunks = [];
      let current = null;
      chapter.paragraphs.forEach((p, i) => {
        const text = textOf(p);
        if (!text.trim()) return;
        const size = tokens(text);
        if (!current || current.tokens + size > CHUNK_TOKENS) {
          current = { first: i + 1, last: i + 1, tokens: size, texts: [text] };
          chunks.push(current);
        } else { current.last = i + 1; current.tokens += size; current.texts.push(text); }
      });
      const childKeys = [];
      for (const chunk of chunks) {
        const key = `1:${entry.id}:${chunk.first}-${chunk.last}`;
        expected.push({ key, level: 1, chapterId: entry.id, chapterNumber: index + 1, chapterTitle: entry.title, first: chunk.first, last: chunk.last, hash: hashOf(chunk.texts.join('\n')), text: chunk.texts.map((t, k) => `${chunk.first + k}| ${t}`).join('\n\n'), childKeys: [] });
        childKeys.push(key);
      }
      const key = `2:${entry.id}`;
      expected.push({ key, level: 2, chapterId: entry.id, chapterNumber: index + 1, chapterTitle: entry.title, first: 1, last: chapter.paragraphs.length, hash: hashOf(chunks.map(c => hashOf(c.texts.join('\n'))).join(',') + '|' + entry.title), childKeys, empty: !chunks.length });
      chapterKeys.push(key);
    }
    if (manifest.chapters.length >= 2 * PART_FAN) {
      for (let start = 0; start < manifest.chapters.length; start += PART_FAN) {
        const group = chapterKeys.slice(start, start + PART_FAN);
        const first = start + 1, last = start + group.length;
        expected.push({ key: `3:${first}-${last}`, level: 3, chapterId: null, first, last, chapterNumber: first, chapterTitle: `${manifest.chapters[start].title} … ${manifest.chapters[last - 1].title}`, hash: hashOf(group.map(k => expected.find(e => e.key === k).hash).join(',')), childKeys: group });
      }
    }
    return expected;
  }

  storedNodes(projectId) {
    return this.store().db.prepare('SELECT * FROM studio_nodes WHERE project_id=? ORDER BY level, first_idx').all(projectId);
  }

  /**
   * What is still to summarize, lowest level first: a level-1 node from its
   * paragraphs; a chapter or a part from its children's summaries, once they
   * are all current. The page asks a model and brings the answers to addNode.
   */
  pending(id, { limit = 8 } = {}) {
    const project = this.project(id);
    const manifest = this.readManifest(project);
    const expected = this.expectedNodes(project, manifest);
    const stored = new Map(this.storedNodes(id).map(n => [n.key, n]));
    const current = e => stored.get(e.key) && stored.get(e.key).hash === e.hash;
    const out = [];
    for (const e of expected.sort((a, b) => a.level - b.level || a.chapterNumber - b.chapterNumber || a.first - b.first)) {
      if (current(e) || e.empty) continue;
      if (e.level === 1) out.push({ key: e.key, level: 1, chapter: e.chapterNumber, chapterTitle: e.chapterTitle, first: e.first, last: e.last, hash: e.hash, text: e.text });
      else {
        const children = e.childKeys.map(k => expected.find(x => x.key === k));
        if (!children.every(current)) continue;
        const text = children.map(c => { const n = stored.get(c.key); return `[${n.title || (c.level === 1 ? `paragrafi ${c.first}-${c.last}` : c.chapterTitle)}]\n${n.content}${JSON.parse(n.facts_json || '[]').length ? `\nFatti: ${JSON.parse(n.facts_json).join('; ')}` : ''}`; }).join('\n\n');
        out.push({ key: e.key, level: e.level, chapter: e.chapterNumber, chapterTitle: e.chapterTitle, first: e.first, last: e.last, hash: e.hash, text });
      }
      if (out.length >= limit) break;
    }
    return out;
  }

  addNode(id, input = {}) {
    this.project(id);
    const key = String(input.key || '');
    const m = /^([123]):(.*)$/.exec(key);
    if (!m) fail('Chiave del nodo non valida.');
    const level = Number(m[1]);
    const content = String(input.content || '').trim();
    if (!content) fail('Riassunto mancante.');
    const title = String(input.title || '').trim().slice(0, 200);
    const facts = Array.isArray(input.facts) ? input.facts.map(String).filter(Boolean).slice(0, 20) : [];
    const hash = String(input.hash || '');
    if (!/^[a-f0-9]{12}$/.test(hash)) fail('Impronta del nodo mancante.');
    let chapterId = null, first = 0, last = 0;
    if (level === 3) { const r = /^(\d+)-(\d+)$/.exec(m[2]); if (!r) fail('Chiave del nodo non valida.'); first = Number(r[1]); last = Number(r[2]); }
    else if (level === 2) { chapterId = m[2]; }
    else { const r = /^([a-f0-9]{10}):(\d+)-(\d+)$/.exec(m[2]); if (!r) fail('Chiave del nodo non valida.'); chapterId = r[1]; first = Number(r[2]); last = Number(r[3]); }
    const db = this.store().db;
    const nodeId = crypto.randomBytes(5).toString('hex');
    db.prepare('DELETE FROM studio_nodes WHERE project_id=? AND key=?').run(id, key);
    db.prepare('INSERT INTO studio_nodes(id,project_id,key,level,chapter_id,first_idx,last_idx,title,content,facts_json,tokens,hash,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(nodeId, id, key, level, chapterId, first, last, title, content, JSON.stringify(facts), tokens(content) + tokens(title) + 8, hash, now());
    return { id: nodeId, key, level };
  }

  /** The tree as the page shows it: every node with its state. */
  tree(id) {
    const project = this.project(id);
    const manifest = this.readManifest(project);
    const expected = this.expectedNodes(project, manifest);
    const stored = new Map(this.storedNodes(id).map(n => [n.key, n]));
    return {
      settings: manifest.settings,
      nodes: expected.filter(e => !e.empty).map(e => {
        const n = stored.get(e.key);
        return { key: e.key, level: e.level, chapter: e.chapterNumber, chapterTitle: e.chapterTitle, first: e.first, last: e.last, id: n?.id || null, title: n?.title || '', content: n?.content || '', facts: n ? JSON.parse(n.facts_json || '[]') : [], state: !n ? 'missing' : n.hash === e.hash ? 'current' : 'stale' };
      })
    };
  }

  /** A node opened by the model: the summaries inside it, or, for a scene, its paragraphs numbered. */
  open(id, nodeId) {
    const project = this.project(id);
    const node = this.store().db.prepare('SELECT * FROM studio_nodes WHERE project_id=? AND id=?').get(id, String(nodeId || ''));
    if (!node) fail('Voce non trovata: usa un codice della mappa.', 404);
    const manifest = this.readManifest(project);
    const expected = this.expectedNodes(project, manifest);
    const e = expected.find(x => x.key === node.key);
    const label = this.labelOf(node, manifest);
    if (node.level === 1) {
      const index = manifest.chapters.findIndex(c => c.id === node.chapter_id);
      if (index === -1) fail('Il capitolo di questa voce non esiste più.', 410);
      const chapter = this.readChapter(project, node.chapter_id);
      const lines = [];
      for (let i = node.first_idx; i <= Math.min(node.last_idx, chapter.paragraphs.length); i++) lines.push(`${i}| ${textOf(chapter.paragraphs[i - 1])}`);
      return { node: node.id, label, stale: !e || e.hash !== node.hash, text: lines.join('\n\n') };
    }
    const stored = new Map(this.storedNodes(id).map(n => [n.key, n]));
    const children = (e ? e.childKeys : []).map(k => stored.get(k)).filter(Boolean);
    return {
      node: node.id, label, stale: !e || e.hash !== node.hash,
      children: children.map(c => ({ node: c.id, label: this.labelOf(c, manifest), summary: c.content, facts: JSON.parse(c.facts_json || '[]') })),
      text: children.map(c => `[${c.id}] ${this.labelOf(c, manifest)}\n${c.content}`).join('\n\n') || 'Le parti di questa voce non sono ancora riassunte: leggi il testo con studio_read.'
    };
  }

  labelOf(node, manifest) {
    if (node.level === 3) return `Parte: capitoli ${node.first_idx}-${node.last_idx}${node.title ? ` «${node.title}»` : ''}`;
    const index = manifest.chapters.findIndex(c => c.id === node.chapter_id);
    const chapterTitle = index === -1 ? '?' : manifest.chapters[index].title;
    if (node.level === 2) return `Capitolo ${index + 1} «${chapterTitle}»`;
    return `Capitolo ${index + 1}, paragrafi ${node.first_idx}-${node.last_idx}${node.title ? ` «${node.title}»` : ''}`;
  }

  /**
   * The map the model is given with every turn of a project chat: within the
   * share of the cap, the coarsest nodes, refined around the chapter in focus.
   * Chapters not summarized yet are named with their size.
   */
  view(id) {
    const project = this.project(id);
    const manifest = this.readManifest(project);
    const expected = this.expectedNodes(project, manifest);
    const stored = new Map(this.storedNodes(id).map(n => [n.key, n]));
    const focusIndex = Math.max(0, manifest.chapters.findIndex(c => c.id === manifest.focus));
    // Share 0: the coarsest nodes alone, as in the chats' memory.
    const budget = manifest.settings.cap * manifest.settings.share;
    const byKey = new Map(expected.map(e => [e.key, e]));
    // The coarsest cover: parts where they exist, chapters elsewhere.
    const parts = expected.filter(e => e.level === 3);
    let cover = parts.length ? parts.slice() : expected.filter(e => e.level === 2);
    const size = list => list.reduce((a, e) => a + (stored.get(e.key) ? stored.get(e.key).tokens : 24), 0);
    const distance = e => {
      if (e.level === 3) return Math.min(Math.abs(e.first - 1 - focusIndex), Math.abs(e.last - 1 - focusIndex));
      return Math.abs(e.chapterNumber - 1 - focusIndex);
    };
    let total = size(cover);
    let changed = true;
    while (changed) {
      changed = false;
      const candidates = cover.filter(e => e.childKeys.length && e.childKeys.every(k => stored.get(k))).sort((a, b) => distance(a) - distance(b) || b.level - a.level);
      for (const e of candidates) {
        const kids = e.childKeys.map(k => byKey.get(k)).filter(Boolean);
        const grow = size(kids) - size([e]);
        if (total + grow <= budget) {
          cover.splice(cover.indexOf(e), 1, ...kids);
          total += grow;
          changed = true;
          break;
        }
      }
    }
    cover.sort((a, b) => (a.level === 3 ? a.first : a.chapterNumber) - (b.level === 3 ? b.first : b.chapterNumber) || a.level - b.level || a.first - b.first);
    const chapters = this.chapterEntries(project, manifest);
    const lines = [
      STUDIO_BLOCK_TITLE,
      `Progetto di Studio «${manifest.title}»${manifest.author ? ` di ${manifest.author}` : ''}: ${manifest.type === 'copione' ? 'un copione' : manifest.type === 'saggio' ? 'un saggio' : 'un romanzo'} in ${manifest.language === 'en' ? 'inglese' : 'italiano'}, ${chapters.length} capitoli, ${chapters.reduce((a, c) => a + c.words, 0)} parole. Capitolo in lavorazione: ${focusIndex + 1} «${manifest.chapters[focusIndex]?.title || ''}».`,
      'Ogni capitolo è una lista di paragrafi numerati. Qui sotto la mappa del testo: parti, capitoli e scene riassunti, più in dettaglio vicino al capitolo in lavorazione. Ogni voce ha un codice tra parentesi quadre: con studio_open la apri (di una parte o di un capitolo vedi i riassunti dentro, di una scena i paragrafi originali). Con studio_read leggi qualunque intervallo di paragrafi di un capitolo, numerati. Per il testo esatto leggi, non indovinare.',
      'Modifiche: studio_replace sostituisce un intervallo di paragrafi, studio_insert ne aggiunge dopo una posizione, studio_delete li toglie, studio_chapter aggiunge, rinomina, sposta o elimina un capitolo. Scrivi nel formato del testo (prosa con *corsivo* e **grassetto**, oppure Fountain per un copione) e nella lingua del progetto; i paragrafi si separano con una riga vuota. Ogni modifica finisce nello storico ed è annullabile.',
      ''
    ];
    for (const e of cover) {
      const n = stored.get(e.key);
      const title = e.level === 3 ? `Parte: capitoli ${e.first}-${e.last}` : e.level === 2 ? `Capitolo ${e.chapterNumber} «${e.chapterTitle}» (${chapters[e.chapterNumber - 1]?.paragraphs || 0} paragrafi)` : `Capitolo ${e.chapterNumber} «${e.chapterTitle}», paragrafi ${e.first}-${e.last}`;
      if (!n) { lines.push(`[—] ${title}: non ancora riassunto.`); lines.push(''); continue; }
      const facts = JSON.parse(n.facts_json || '[]');
      lines.push(`[${n.id}] ${title}${n.title ? ` «${n.title}»` : ''}${n.hash !== e.hash ? ' (riassunto non aggiornato)' : ''}`);
      lines.push(n.content);
      if (facts.length) lines.push('Fatti: ' + facts.join('; '));
      lines.push('');
    }
    return { system: lines.join('\n').trim(), nodes: cover.length, tokens: total, focus: focusIndex + 1 };
  }

  /** What a project chat gets with every turn: the map and the tools. */
  context(id) {
    const view = this.view(id);
    return { studio: true, system: view.system, tools: toolSpecs(), nodes: view.nodes, tokens: view.tokens };
  }

  // --- the typeset document ------------------------------------------------------

  buildDir(id) {
    const dir = path.join(this.dataDir, 'studio', String(id).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 36));
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  document(id) {
    const project = this.project(id);
    const manifest = this.readManifest(project);
    const chapters = manifest.chapters.map(entry => { const c = this.readChapter(project, entry.id); return { ...c, title: entry.title }; });
    return { project, manifest, chapters, tex: latexDocument(manifest, chapters) };
  }

  pdfPath(id) {
    const file = path.join(this.buildDir(id), 'main.pdf');
    return fs.existsSync(file) ? file : null;
  }

  compileStatus(id) {
    this.project(id);
    const job = this.jobs.get(String(id));
    const pdf = this.pdfPath(id);
    const stat = pdf ? fs.statSync(pdf) : null;
    return {
      state: job ? job.state : 'idle', phase: job?.phase || null, startedAt: job?.startedAt || null, finishedAt: job?.finishedAt || null,
      error: job?.error || null, needsCache: Boolean(job?.needsCache), warnings: job?.warnings || [],
      pdf: stat ? { bytes: stat.size, at: stat.mtime.toISOString() } : null,
      texCache: this.warm ? { state: this.warm.state, phase: this.warm.phase, error: this.warm.error || null } : null
    };
  }

  /** Starts a compile of the whole document in the background; the page polls compileStatus. */
  startCompile(id) {
    const key = String(id);
    const running = this.jobs.get(key);
    if (running && running.state === 'running') return this.compileStatus(id);
    const { tex: source } = this.document(id);
    fs.writeFileSync(path.join(this.buildDir(id), 'main.tex'), source, 'utf8');
    const job = { state: 'running', phase: 'starting', startedAt: now(), finishedAt: null, error: null, needsCache: false, warnings: [] };
    this.jobs.set(key, job);
    const outDir = this.buildDir(id);
    const baseImages = this.sandbox?.baseImages;
    (async () => {
      try {
        const result = await tex.compile({ files: { 'main.tex': source }, main: 'main.tex', outDir, baseImages, onPhase: phase => { job.phase = phase; } });
        if (result.ok) { job.state = 'done'; job.warnings = result.warnings; job.log = result.log; }
        else { job.state = 'failed'; job.error = result.error; job.needsCache = result.needsCache; job.log = result.log; }
      } catch (error) {
        job.state = 'failed';
        job.error = error.message;
      } finally {
        job.finishedAt = now();
        job.phase = null;
      }
    })();
    return this.compileStatus(id);
  }

  compileLog(id) {
    const job = this.jobs.get(String(id));
    return { log: job?.log || '', error: job?.error || null };
  }

  /** The TeX packages: whether they are there, and the one-time download the user starts. */
  async texStatus() {
    const status = await tex.cacheStatus().catch(error => ({ engine: false, warmed: false, error: error.message }));
    return { ...status, warm: this.warm ? { state: this.warm.state, phase: this.warm.phase, error: this.warm.error || null, startedAt: this.warm.startedAt, finishedAt: this.warm.finishedAt } : null };
  }

  startWarm() {
    if (this.warm && this.warm.state === 'running') return this.texStatus();
    const warm = { state: 'running', phase: 'starting', startedAt: now(), finishedAt: null, error: null, log: '' };
    this.warm = warm;
    const baseImages = this.sandbox?.baseImages;
    (async () => {
      try {
        const result = await tex.warmCache({ files: warmDocuments(), baseImages, onPhase: phase => { warm.phase = phase; } });
        warm.log = result.log;
        if (result.ok) warm.state = 'done';
        else { warm.state = 'failed'; warm.error = result.error; }
      } catch (error) {
        warm.state = 'failed';
        warm.error = error.message;
      } finally {
        warm.finishedAt = now();
        warm.phase = null;
      }
    })();
    return this.texStatus();
  }

  /** What leaves SynthOrg's folder for the user's: only when they ask, into the project's own export folder. */
  async exportDocument(id, input = {}) {
    const { project, manifest, chapters, tex: source } = this.document(id);
    const what = ['pdf', 'tex', 'md'].includes(input.what) ? input.what : 'pdf';
    const dir = path.join(this.folderOf(project), EXPORT_DIR);
    fs.mkdirSync(dir, { recursive: true });
    const base = String(manifest.title || project.name).replace(/[\\/:*?"<>|]+/g, ' ').trim().slice(0, 80) || 'documento';
    const target = path.join(dir, `${base}.${what}`);
    if (what === 'pdf') {
      const pdf = this.pdfPath(id);
      if (!pdf) fail('Nessun PDF: impagina prima il documento.', 409);
      fs.copyFileSync(pdf, target);
    } else if (what === 'tex') fs.writeFileSync(target, source, 'utf8');
    else fs.writeFileSync(target, markdownDocument(manifest, chapters), 'utf8');
    await this.record(project, `esporta ${path.basename(target)}`, 'user');
    return { path: target };
  }
}

/** The model's answer to a cleanup request: JSON, or JSON in a fence; null if it is neither. */
function parseCleanup(text) {
  const body = String(text || '').replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
  const start = body.indexOf('{'), end = body.lastIndexOf('}');
  if (start === -1 || end === -1) return null;
  try {
    const parsed = JSON.parse(body.slice(start, end + 1));
    if (!Array.isArray(parsed.paragraphs)) return null;
    return parsed.paragraphs.filter(p => p && typeof p.id === 'string' && typeof p.text === 'string').map(p => ({ id: p.id, text: p.text.replace(/\r\n?/g, '\n').trim() }));
  } catch { return null; }
}

/** What the model is told it can do in a Studio project. */
const TOOLS = {
  studio_read: {
    description: 'Legge un intervallo di paragrafi di un capitolo del progetto di Studio, numerati. Usa i numeri per studio_replace, studio_insert e studio_delete.',
    parameters: { type: 'object', properties: {
      chapter: { type: 'integer', description: 'Numero del capitolo (1 = il primo), come nella mappa [STUDIO].' },
      from: { type: 'integer', description: 'Primo paragrafo (1 se omesso).' },
      to: { type: 'integer', description: 'Ultimo paragrafo (fino a 60 paragrafi per volta se omesso).' }
    }, required: ['chapter'] }
  },
  studio_open: {
    description: 'Apre una voce della mappa [STUDIO] (il codice tra parentesi quadre): di una parte o di un capitolo restituisce i riassunti che contiene, di una scena i paragrafi originali numerati.',
    parameters: { type: 'object', properties: { node: { type: 'string', description: 'Il codice della voce, es. 3f9a0c1b2d.' } }, required: ['node'] }
  },
  studio_replace: {
    description: 'Sostituisce i paragrafi da `from` a `to` (inclusi) di un capitolo con il testo dato: più paragrafi separati da una riga vuota. Con lo stesso numero di paragrafi ognuno tiene la brutta dell’autore e riceve la nuova bella. Leggi prima con studio_read.',
    parameters: { type: 'object', properties: {
      chapter: { type: 'integer', description: 'Numero del capitolo.' },
      from: { type: 'integer', description: 'Primo paragrafo da sostituire.' },
      to: { type: 'integer', description: 'Ultimo paragrafo da sostituire (= from se omesso).' },
      text: { type: 'string', description: 'Il testo nuovo, nel formato del progetto.' }
    }, required: ['chapter', 'from', 'text'] }
  },
  studio_insert: {
    description: 'Aggiunge paragrafi a un capitolo dopo la posizione `after` (0 = all’inizio, omesso = alla fine).',
    parameters: { type: 'object', properties: {
      chapter: { type: 'integer', description: 'Numero del capitolo.' },
      after: { type: 'integer', description: 'Il paragrafo dopo cui inserire; 0 per l’inizio.' },
      text: { type: 'string', description: 'Il testo nuovo, uno o più paragrafi separati da una riga vuota.' }
    }, required: ['chapter', 'text'] }
  },
  studio_delete: {
    description: 'Toglie i paragrafi da `from` a `to` (inclusi) di un capitolo. Restano nello storico.',
    parameters: { type: 'object', properties: {
      chapter: { type: 'integer', description: 'Numero del capitolo.' },
      from: { type: 'integer', description: 'Primo paragrafo da togliere.' },
      to: { type: 'integer', description: 'Ultimo paragrafo da togliere (= from se omesso).' }
    }, required: ['chapter', 'from'] }
  },
  studio_chapter: {
    description: 'Capitoli del progetto: add (nuovo capitolo, con `title` e, se vuoi, `text` e `after` = posizione 0..N), rename (`chapter`, `title`), remove (`chapter`), move (`chapter`, `to` = nuovo numero).',
    parameters: { type: 'object', properties: {
      action: { type: 'string', enum: ['add', 'rename', 'remove', 'move'] },
      chapter: { type: 'integer', description: 'Numero del capitolo (per rename, remove, move).' },
      title: { type: 'string', description: 'Titolo (per add e rename).' },
      text: { type: 'string', description: 'Testo iniziale del capitolo nuovo (per add).' },
      after: { type: 'integer', description: 'Dopo quale capitolo mettere il nuovo (per add; omesso = in fondo).' },
      to: { type: 'integer', description: 'Nuova posizione (per move).' }
    }, required: ['action'] }
  }
};

function toolSpecs() {
  return Object.entries(TOOLS).map(([name, spec]) => ({ type: 'function', function: { name, description: spec.description, parameters: spec.parameters } }));
}

module.exports = {
  StudioManager, TOOLS, toolSpecs, TYPES, LANGUAGES, MANIFEST, CHAPTERS_DIR, EXPORT_DIR, DEFAULT_SETTINGS, LIMITS, STUDIO_BLOCK_TITLE,
  splitParagraphs, joinParagraphs, mergeDraft, latexDocument, markdownDocument, warmDocuments, proseBlock, screenplayBlock, inlineTex, escapeTex, parseCleanup, hashOf, isClean, textOf, tokens, words
};
