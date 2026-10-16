/**
 * SynthOrg - The Realtime character.
 *
 * A cartoon puppet drawn in code, no assets: a soft body in the theme's
 * colour, two eyes that blink and follow the pointer, a mouth moved by the
 * voice's loudness, and a few states — idle, listening, thinking, speaking,
 * happy, working — each with its own face and small motions. Everything is
 * one inline SVG driven by requestAnimationFrame, stopped while not shown.
 */
(function () {
  'use strict';

  const SVG = 'http://www.w3.org/2000/svg';
  const lerp = (a, b, k) => a + (b - a) * k;
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  // How the face is held. eye: openness (0 = happy arcs); brow: lift; smile:
  // mouth curve (below 0 a frown); arms / bob / hop: how much it moves;
  // mouthMin: an opening kept even in silence; blush, tear, hearts, sweat
  // (the cartoon drop of an awkward moment): extras;
  // wink: the right eye closed; lookUp: eyes to the sky; browTilt: inner
  // ends of the brows raised (worry, sadness) or lowered (anger); round: a
  // small round mouth (an "o"); typing: the arms held out to the side it
  // looks at, the hands going up and down in turn on a keyboard.
  const BASE = { eye: 1, brow: 0, smile: 0.55, arms: 0.15, bob: 1, hop: 0, mouthMin: 0, blush: 0, tear: 0, hearts: 0, sweat: 0, wink: 0, lookUp: 0, browTilt: 0, round: 0, typing: 0 };
  const FACES = {
    idle:      { ...BASE },
    listening: { ...BASE, eye: 1.12, brow: 3, smile: 0.45, arms: 0.1, bob: 0.6 },
    thinking:  { ...BASE, eye: 0.8, brow: 5, smile: 0, arms: 0.05, bob: 0.4, lookUp: 1 },
    speaking:  { ...BASE, brow: 1, smile: 0.3, arms: 0.5, bob: 1.2 },
    happy:     { ...BASE, eye: 0, brow: 2, smile: 1, arms: 1, bob: 1.6, hop: 1 },
    working:   { ...BASE, eye: 0.9, brow: -1, smile: 0.2, arms: 0.1, bob: 0.5, typing: 1 }
  };

  // Expressions laid over the state for a while, from the emoji of what it
  // says: the mouth keeps moving with the voice underneath.
  const EXPRESSIONS = {
    joy:       { eye: 0, brow: 2, smile: 1, arms: 0.8, blush: 0.3 },
    laugh:     { eye: 0, brow: 3, smile: 1, arms: 1, bob: 2, hop: 0.8, mouthMin: 0.45, blush: 0.4 },
    love:      { eye: 0, brow: 2, smile: 0.9, arms: 0.6, blush: 1, hearts: 1 },
    surprise:  { eye: 1.3, brow: 8, smile: 0, mouthMin: 0.55, round: 1, arms: 0.3 },
    sad:       { eye: 0.75, brow: 1, smile: -0.7, arms: 0.05, bob: 0.5, tear: 1, browTilt: 1 },
    thinking:  { eye: 0.85, brow: 5, smile: 0, lookUp: 1, arms: 0.1 },
    wink:      { eye: 1, brow: 2, smile: 0.9, wink: 1, blush: 0.3 },
    // The one of a blunder: a crooked half smile, pink cheeks, a drop of sweat.
    embarrassed: { eye: 0.85, brow: 3, smile: 0.35, blush: 1, sweat: 1, browTilt: 0.9, arms: 0.3 },
    worried:   { eye: 1, brow: 3, smile: -0.3, browTilt: 1 },
    angry:     { eye: 0.8, brow: -3, smile: -0.6, browTilt: -2.2, arms: 0.8 },
    party:     { eye: 0, brow: 3, smile: 1, arms: 1, bob: 2, hop: 1, blush: 0.5 }
  };

  // Which emoji means which expression. Anything else is just left out.
  const EMOJI = [
    ['laugh', /😂|🤣|😆|😹/u],
    ['love', /😍|🥰|😘|❤|💕|💖|💗|💘|💞|😻|🤗/u],
    ['party', /🥳|🎉|🎊|👏|🙌|💪|🔥|✨|🌟|⭐/u],
    ['surprise', /😮|😲|😯|😱|🤯|😳|‼|❗|❕|👀/u],
    ['sad', /😢|😭|😞|😔|😟|🥲|☹|🙁|😿|💔/u],
    ['thinking', /🤔|🧐|💭/u],
    ['wink', /😉|😜|😏|😋|😛/u],
    ['embarrassed', /😅|😓|🙈|🫣|🤭|🙃|☺/u],
    ['worried', /😬|😰|😥|😕|🫤/u],
    ['angry', /😠|😡|🤬|😤/u],
    ['joy', /😊|🙂|😀|😃|😄|😁|😎|🤩|👍|😌|🥹/u]
  ];

  function el(name, attrs, parent) {
    const node = document.createElementNS(SVG, name);
    Object.entries(attrs || {}).forEach(([k, v]) => node.setAttribute(k, v));
    if (parent) parent.appendChild(node);
    return node;
  }

  class Puppet {
    constructor(container) {
      this.container = container;
      this.state = 'idle';
      this.mouthTarget = 0;   // 0..1 from the voice
      this.hearing = 0;       // 0..1 from the microphone
      this.gazeTarget = { x: 0, y: 0 };
      this.gaze = { x: 0, y: 0 };
      this.focus = null;        // what it keeps its eyes on, whatever the pointer does: gives a point of the page
      this.face = { ...FACES.idle };
      this.expression = null;   // an expression laid over the state, until expressionUntil
      this.expressionUntil = 0;
      this.mouth = 0;
      this.shape = { round: 0, spread: 0 };        // from the voice's spectrum
      this.shapeTarget = { round: 0, spread: 0 };
      this.nod = 0;                                // a small dip at each syllable
      this.blink = 0;         // 0 open .. 1 closed
      this.nextBlink = performance.now() + 1500;
      this.running = false;
      this.frame = null;
      this.build();
      this.onPointer = (e) => this.look(e.clientX, e.clientY);
      window.addEventListener('pointermove', this.onPointer);
    }

    build() {
      const uid = ++Puppet.count;
      const id = (name) => `rt-${name}-${uid}`;
      const svg = el('svg', { viewBox: '0 0 240 260', class: 'rt-puppet-svg', role: 'img' });
      const defs = el('defs', {}, svg);
      const grad = el('radialGradient', { id: id('body-grad'), cx: '38%', cy: '30%', r: '75%' }, defs);
      el('stop', { offset: '0%', class: 'rt-body-light' }, grad);
      el('stop', { offset: '100%', class: 'rt-body-dark' }, grad);

      this.shadow = el('ellipse', { cx: 120, cy: 238, rx: 62, ry: 9, class: 'rt-shadow' }, svg);
      this.rig = el('g', { class: 'rt-rig' }, svg);

      // Arms behind the body, so they read as stubs coming out of it.
      this.armL = el('path', { d: 'M62 150 q-26 6 -30 28', class: 'rt-arm' }, this.rig);
      this.armR = el('path', { d: 'M178 150 q26 6 30 28', class: 'rt-arm' }, this.rig);

      this.body = el('path', { class: 'rt-body', fill: `url(#${id('body-grad')})` }, this.rig);
      this.belly = el('ellipse', { cx: 120, cy: 172, rx: 40, ry: 30, class: 'rt-belly' }, this.rig);
      this.tuft = el('path', { d: 'M118 44 q-6 -22 10 -30 q-4 12 6 16 q-10 2 -16 14', class: 'rt-tuft' }, this.rig);

      this.head = el('g', { class: 'rt-head' }, this.rig);
      this.cheekL = el('ellipse', { cx: 72, cy: 124, rx: 11, ry: 7, class: 'rt-cheek' }, this.head);
      this.cheekR = el('ellipse', { cx: 168, cy: 124, rx: 11, ry: 7, class: 'rt-cheek' }, this.head);
      this.tear = el('path', { d: 'M86 118 q-5 9 0 12 q5 -3 0 -12 Z', class: 'rt-tear' }, this.head);
      this.sweat = el('path', { d: 'M184 70 q-7 12 0 16 q7 -4 0 -16 Z', class: 'rt-sweat' }, this.rig);

      this.eyes = [92, 148].map((cx, i) => {
        const g = el('g', {}, this.head);
        // The lid is cut to the eye's own shape, so a blink closes a round eye.
        const clip = el('clipPath', { id: id(`eye-clip-${i}`) }, defs);
        const clipShape = el('ellipse', { cx, cy: 100, rx: 17, ry: 20 }, clip);
        const white = el('ellipse', { cx, cy: 100, rx: 17, ry: 20, class: 'rt-eye' }, g);
        const pupil = el('circle', { cx, cy: 102, r: 8.5, class: 'rt-pupil' }, g);
        const shine = el('circle', { cx: cx + 3, cy: 98, r: 2.6, class: 'rt-shine' }, g);
        const lid = el('rect', { x: cx - 19, y: 78, width: 38, height: 0, class: 'rt-lid', 'clip-path': `url(#${id(`eye-clip-${i}`)})` }, g);
        const happy = el('path', { d: `M${cx - 13} 104 q13 -14 26 0`, class: 'rt-eye-happy' }, g);
        const brow = el('path', { class: 'rt-brow' }, g);
        return { cx, white, clipShape, pupil, shine, lid, happy, brow };
      });

      this.mouthOuter = el('path', { class: 'rt-mouth' }, this.head);
      // The tongue lives inside the mouth: cut to the same outline.
      const mouthClip = el('clipPath', { id: id('mouth-clip') }, defs);
      this.mouthClipShape = el('path', {}, mouthClip);
      this.tongue = el('ellipse', { cx: 120, cy: 146, rx: 9, ry: 4, class: 'rt-tongue', 'clip-path': `url(#${id('mouth-clip')})` }, this.head);
      // The lips drawn last, over the tongue.
      this.mouthLine = el('path', { class: 'rt-mouth-line' }, this.head);

      // Props of a state: dots while thinking, a gear while the Master works,
      // sound arcs while it hears you.
      this.thinkDots = el('g', { class: 'rt-think' }, svg);
      [0, 1, 2].forEach(i => el('circle', { cx: 176 + i * 14, cy: 42 - i * 10, r: 4 + i * 1.5 }, this.thinkDots));
      this.gear = el('g', { class: 'rt-gear', transform: 'translate(196 60)' }, svg);
      el('path', { d: gearPath(13, 8, 8), class: 'rt-gear-shape' }, this.gear);
      el('circle', { r: 4, class: 'rt-gear-hole' }, this.gear);
      this.hearts = el('g', { class: 'rt-hearts' }, svg);
      [[62, 40, 1], [178, 30, 0.8], [120, 14, 0.65]].forEach(([x, y, k]) => {
        el('path', { d: 'M0 4 C -6 -3 -12 3 0 12 C 12 3 6 -3 0 4 Z', transform: `translate(${x} ${y}) scale(${k * 1.4})` }, this.hearts);
      });
      this.waves = el('g', { class: 'rt-waves' }, svg);
      [0, 1, 2].forEach(i => el('path', { d: `M${28 - i * 9} ${96 - i * 8} q-${8 + i * 4} ${18 + i * 8} 0 ${36 + i * 16}` }, this.waves));

      this.svg = svg;
      this.container.appendChild(svg);
    }

    setState(state) {
      if (FACES[state]) this.state = state;
    }

    /** An expression over the state for `ms` milliseconds (a sentence, usually). */
    setExpression(name, ms = 2500) {
      if (!EXPRESSIONS[name]) return;
      this.expression = name;
      this.expressionUntil = performance.now() + ms;
    }

    /** The expression the emoji of a text stand for (the last one wins), or null. */
    static expressionOf(text) {
      let found = null;
      let at = -1;
      EMOJI.forEach(([name, re]) => {
        const all = [...String(text || '').matchAll(new RegExp(re.source, 'gu'))];
        const last = all.length ? all[all.length - 1].index : -1;
        if (last > at) { at = last; found = name; }
      });
      return found;
    }
    setMouth(level) { this.setMouthShape({ open: level }); }

    /**
     * The mouth from the voice: open (loudness), round ("o", "u": energy in
     * the low formants), spread ("e", "i", "s": energy up high); onset, the
     * start of a syllable, gives the head a small nod.
     */
    setMouthShape({ open = 0, round = 0, spread = 0, onset = 0 } = {}) {
      this.mouthTarget = clamp(open, 0, 1);
      this.shapeTarget.round = clamp(round, 0, 1);
      this.shapeTarget.spread = clamp(spread, 0, 1);
      if (onset > this.nod) this.nod = clamp(onset, 0, 1);
    }
    setHearing(level) { this.hearing = clamp(level, 0, 1); }

    look(x, y) {
      const r = this.svg.getBoundingClientRect();
      if (!r.width) return;
      const dx = (x - (r.left + r.width / 2)) / (r.width * 1.2);
      const dy = (y - (r.top + r.height * 0.4)) / (r.height * 1.2);
      this.gazeTarget = { x: clamp(dx, -1, 1), y: clamp(dy, -1, 1) };
      this.lastLook = performance.now();
    }

    /** What it keeps its eyes on while it has something to do there: a function giving a point of the page, or null to follow the pointer again. */
    setFocus(point) { this.focus = typeof point === 'function' ? point : null; }

    start() {
      if (this.running) return;
      this.running = true;
      const loop = (now) => {
        if (!this.running) return;
        this.draw(now);
        this.frame = requestAnimationFrame(loop);
      };
      this.frame = requestAnimationFrame(loop);
    }
    stop() {
      this.running = false;
      if (this.frame) cancelAnimationFrame(this.frame);
      this.frame = null;
    }
    destroy() {
      this.stop();
      window.removeEventListener('pointermove', this.onPointer);
      this.svg.remove();
    }

    draw(now) {
      const t = now / 1000;
      if (this.expression && now > this.expressionUntil) this.expression = null;
      const target = this.expression ? { ...FACES[this.state], ...EXPRESSIONS[this.expression] } : FACES[this.state];
      Object.keys(this.face).forEach(k => { this.face[k] = lerp(this.face[k], target[k], 0.12); });
      const f = this.face;

      // Breathing, and a bounce that follows the voice.
      // Opens fast, closes a little slower: how a jaw moves.
      const jaw = Math.max(this.mouthTarget, f.mouthMin);
      this.mouth = lerp(this.mouth, jaw, jaw > this.mouth ? 0.55 : 0.28);
      this.shape.round = lerp(this.shape.round, this.shapeTarget.round * (this.mouth > 0.05 ? 1 : 0), 0.3);
      this.shape.spread = lerp(this.shape.spread, this.shapeTarget.spread * (this.mouth > 0.05 ? 1 : 0), 0.3);
      this.nod *= 0.86;
      const breathe = Math.sin(t * 2.1) * 2.2 * f.bob;
      const hop = Math.abs(Math.sin(t * 6)) * -8 * f.hop;
      const talk = this.mouth * 3;
      const lift = breathe + hop - talk;
      const squash = 1 + Math.sin(t * 2.1) * 0.012 * f.bob + this.mouth * 0.02;
      const tilt = this.state === 'thinking' ? Math.sin(t * 0.9) * 3 - 4 : (this.state === 'listening' ? 4 : Math.sin(t * 0.7) * 1.2);
      this.rig.setAttribute('transform', `translate(120 ${230 + lift}) rotate(${tilt}) scale(${2 - squash} ${squash}) translate(-120 -230)`);
      this.shadow.setAttribute('rx', String(62 - lift * 0.8));
      this.shadow.setAttribute('opacity', String(0.28 + lift * 0.01));

      // A body a little wider at the bottom, like a gumdrop.
      const w = 70 + this.mouth * 2;
      this.body.setAttribute('d',
        `M120 40 C ${120 + w} 40 ${120 + w + 14} 120 ${120 + w + 10} 170 ` +
        `C ${120 + w + 6} 215 ${160} 230 120 230 C ${80} 230 ${120 - w - 6} 215 ${120 - w - 10} 170 ` +
        `C ${120 - w - 14} 120 ${120 - w} 40 120 40 Z`);

      // What it keeps its eyes on, when there is something: the pointer does not take them away.
      const held = this.focus ? this.focus() : null;
      if (held) this.look(held.x, held.y);

      // Arms: a slow wave, faster and wider when speaking or happy. Typing, the
      // arm on the side it looks at is held out, and the two hands tap in turn.
      const swing = Math.sin(t * (f.hop > 0.3 ? 9 : 3)) * 10 * f.arms;
      const side = this.gaze.x < 0 ? -1 : 1;
      const tapL = Math.max(0, Math.sin(t * 13)) * 7 * f.typing;
      const tapR = Math.max(0, Math.sin(t * 13 + Math.PI)) * 7 * f.typing;
      const reachL = f.typing * (side < 0 ? 1 : 0.35);
      const reachR = f.typing * (side > 0 ? 1 : 0.35);
      this.armL.setAttribute('d', `M62 150 q${-26 - reachL * 12} ${6 - swing - reachL * 2} ${-30 - reachL * 20} ${28 - swing * 1.6 + reachL * 18 - tapL}`);
      this.armR.setAttribute('d', `M178 150 q${26 + reachR * 12} ${6 + swing - reachR * 2} ${30 + reachR * 20} ${28 + swing * 1.6 + reachR * 18 - tapR}`);

      // Gaze: the pointer, drifting back to the middle when it stops moving.
      const idleFor = now - (this.lastLook || 0);
      const wander = idleFor > 2500 ? { x: Math.sin(t * 0.5) * 0.3, y: Math.sin(t * 0.37) * 0.15 } : this.gazeTarget;
      const aim = { x: lerp(wander.x, 0.45, f.lookUp), y: lerp(wander.y, -0.75, f.lookUp) };
      this.gaze.x = lerp(this.gaze.x, aim.x, 0.1);
      this.gaze.y = lerp(this.gaze.y, aim.y, 0.1);
      this.head.setAttribute('transform', `translate(${this.gaze.x * 4} ${this.gaze.y * 3 + this.nod * 2.5})`);

      // Blinks, now and then; never while happy (eyes are arcs then).
      if (now > this.nextBlink) {
        this.blinkStart = now;
        this.nextBlink = now + 2200 + Math.random() * 3800;
      }
      const since = now - (this.blinkStart || -1e9);
      this.blink = since < 140 ? Math.sin((since / 140) * Math.PI) : 0;

      this.eyes.forEach((e, i) => {
        // A wink closes the right eye only.
        const open = i === 1 ? f.eye * (1 - clamp(f.wink, 0, 1)) : f.eye;
        const ry = 20 * clamp(open, 0.05, 1.2);
        e.white.setAttribute('ry', String(ry));
        e.clipShape.setAttribute('ry', String(ry));
        e.white.setAttribute('opacity', String(clamp(open * 3, 0, 1)));
        e.pupil.setAttribute('cx', String(e.cx + this.gaze.x * 7));
        e.pupil.setAttribute('cy', String(102 + this.gaze.y * 7));
        e.pupil.setAttribute('opacity', String(clamp(open * 3, 0, 1)));
        e.shine.setAttribute('cx', String(e.cx + 3 + this.gaze.x * 7));
        e.shine.setAttribute('cy', String(98 + this.gaze.y * 7));
        e.shine.setAttribute('opacity', String(clamp(open * 3, 0, 1)));
        e.lid.setAttribute('height', String(44 * this.blink * clamp(open * 2, 0, 1)));
        e.happy.setAttribute('opacity', String(clamp(1 - open * 3, 0, 1)));
        const side = i === 0 ? -1 : 1;
        const raise = f.brow + (f.lookUp > 0.5 && i === 1 ? 4 : 0);
        // Inner ends a little higher: a kind face, not a cross one; more with
        // worry or sadness, lower with anger.
        const tilt = 2.5 + f.browTilt * 5;
        const inner = i === 0 ? side * tilt : 0;
        e.brow.setAttribute('d', `M${e.cx - 12} ${74 - raise - (i === 1 ? f.browTilt * 5 : 0)} q12 ${-6 - raise * 0.4} 24 ${i === 0 ? inner : side * tilt}`);
      });

      // The mouth: a smile that opens with the voice.
      const m = this.mouth;
      // Narrow and round for an "o"; a frown bends much more than a smile.
      const rounded = Math.max(clamp(f.round, 0, 1), this.shape.round * 0.75);
      const wide = (22 + m * 6 + Math.max(0, f.smile) * 6) * (1 - 0.6 * rounded) * (1 + 0.28 * this.shape.spread);
      const curve = f.smile >= 0 ? f.smile * 10 : f.smile * 22;
      const drop = 3 + m * 20 * (1 - 0.35 * this.shape.spread) * (1 + 0.15 * this.shape.round);
      const mouthPath = `M${120 - wide} 138 Q120 ${138 + curve * 0.6} ${120 + wide} 138 ` +
        `Q120 ${138 + curve + drop} ${120 - wide} 138 Z`;
      this.mouthOuter.setAttribute('d', mouthPath);
      this.mouthClipShape.setAttribute('d', mouthPath);
      this.mouthLine.setAttribute('d', mouthPath);
      // At the bottom of the opening, where a tongue sits.
      this.tongue.setAttribute('opacity', String(clamp((m - 0.3) * 3, 0, 1)));
      this.tongue.setAttribute('rx', String(6 + m * 6));
      this.tongue.setAttribute('ry', String(3 + m * 3));
      this.tongue.setAttribute('cy', String(138 + curve * 0.3 + (curve + drop) * 0.5));

      const cheek = clamp(0.35 + Math.max(0, f.smile) * 0.4 + f.blush * 0.45, 0, 1);
      this.cheekL.setAttribute('opacity', String(cheek));
      this.cheekR.setAttribute('opacity', String(cheek));

      // A tear that runs down, hearts that float up.
      const fall = (t % 1.6) / 1.6;
      this.tear.setAttribute('transform', `translate(0 ${fall * 14})`);
      this.tear.setAttribute('opacity', String(clamp(f.tear, 0, 1) * (1 - fall * 0.6)));
      const rise = (t % 2.4) / 2.4;
      this.hearts.setAttribute('transform', `translate(0 ${-rise * 18})`);
      this.hearts.setAttribute('opacity', String(clamp(f.hearts, 0, 1) * (1 - rise * 0.7)));

      // The sweat drop slides a little down the side of the head.
      const slide = (t % 2) / 2;
      this.sweat.setAttribute('transform', `translate(0 ${slide * 6})`);
      this.sweat.setAttribute('opacity', String(clamp(f.sweat, 0, 1) * (1 - slide * 0.3)));

      // State props.
      this.thinkDots.setAttribute('opacity', String(this.state === 'thinking' ? 0.5 + Math.sin(t * 4) * 0.3 : 0));
      this.gear.setAttribute('opacity', this.state === 'working' ? '1' : '0');
      this.gear.setAttribute('transform', `translate(196 60) rotate(${(t * 90) % 360})`);
      const hearing = this.state === 'listening' ? 0.25 + this.hearing * 0.75 : 0;
      this.waves.setAttribute('opacity', String(hearing));
    }
  }

  function gearPath(outer, inner, teeth) {
    let d = '';
    const step = Math.PI / teeth;
    for (let i = 0; i < teeth * 2; i++) {
      const r = i % 2 === 0 ? outer : inner;
      const a = i * step;
      d += `${i ? 'L' : 'M'}${(Math.cos(a) * r).toFixed(2)} ${(Math.sin(a) * r).toFixed(2)} `;
    }
    return d + 'Z';
  }

  Puppet.count = 0;
  window.RealtimePuppet = Puppet;
})();
