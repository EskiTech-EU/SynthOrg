/**
 * SynthOrg - the character, as one that goes from place to place.
 *
 * There is one character. In its own section it stands at the centre of the
 * stage; on the other tabs it sits on its button in the bar at the top. When
 * it is needed somewhere — a step of the tour, a notice, a reminder, a
 * question, something it opens itself, something the user opens in its
 * section — it goes there hopping, lands, and what it lands on gives way
 * under it for a moment. It never shows up somewhere out of nothing, and
 * it never hops for what the user opens on the other tabs.
 *
 * How it is made:
 *   - one puppet drawn over the page, which takes no clicks; it is raised
 *     above a window opened over the page when there is one;
 *   - the stage keeps its own puppet, the big one the voice moves: when the
 *     character lands on the stage the two change places, and what is told
 *     to one (face, mouth) is told to the other, so they are always alike;
 *   - the way from a place to the next is made of hops of a bounded length;
 *     it goes round the editor of a Code project, which is painted over the
 *     page and would hide it;
 *   - with "reduce motion" set on the computer it changes place at once.
 *
 * The geometry (where to stand on an element, the way, the hops) is a set of
 * functions of numbers alone, kept apart from the page.
 */
(function () {
  'use strict';

  const RATIO = 260 / 240;          // the puppet's height for its width
  const HOP_MOST = 420;             // the longest hop, in pixels: a longer way is more hops
  const HOPS_MOST = 4;
  const SIZES = { perch: 30, stand: 52, slot: 48 };

  const clamp = (v, low, high) => Math.min(high, Math.max(low, v));
  const boxOf = (left, top, width) => ({ left, top, width, height: width * RATIO });
  const feet = (box) => ({ x: box.left + box.width / 2, y: box.top + box.height });
  const overlaps = (a, b) => Boolean(a && b) && a.left < b.left + b.width && a.left + a.width > b.left && a.top < b.top + b.height && a.top + a.height > b.top;

  /**
   * Where the character stands on an element: on its top edge when there is
   * room above, else beside it, else below; never out of the window, never
   * over what must stay in view (`avoid`: the tour's card).
   * rect, avoid: { left, top, width, height }; view: { width, height }.
   */
  function standOn(rect, size, view, avoid = null) {
    const height = size * RATIO;
    const inside = (box) => box.left >= 2 && box.top >= 2 && box.left + box.width <= view.width - 2 && box.top + box.height <= view.height - 2;
    const centre = clamp(rect.left + rect.width / 2 - size / 2, 4, Math.max(4, view.width - size - 4));
    const sink = Math.min(8, rect.height / 3);   // the feet go a little into what they stand on
    // Beside it, its feet at the element's bottom, or as near to it as the window lets.
    const level = clamp(rect.top + rect.height - height, 2, Math.max(2, view.height - height - 2));
    const tries = [
      { side: 'top', box: boxOf(centre, rect.top - height + sink, size) },
      { side: 'right', box: boxOf(rect.left + rect.width + 4, level, size) },
      { side: 'left', box: boxOf(rect.left - size - 4, level, size) },
      { side: 'bottom', box: boxOf(centre, rect.top + rect.height - sink, size) }
    ];
    const found = tries.find(place => inside(place.box) && !overlaps(place.box, avoid));
    if (found) return found;
    // No room anywhere around it: on what must stay in view, or in the window's corner.
    if (avoid) {
      const onIt = boxOf(clamp(avoid.left + 12, 4, view.width - size - 4), avoid.top - height + 8, size);
      if (inside(onIt)) return { side: 'avoid', box: onIt };
    }
    return { side: 'corner', box: boxOf(clamp(centre, 4, view.width - size - 4), clamp(rect.top, 4, Math.max(4, view.height - height - 4)), size) };
  }

  /** The place of the character in a slot made for it: as wide as the slot, its feet on the slot's bottom. */
  function inSlot(rect) {
    const width = Math.min(rect.width, rect.height / RATIO);
    return boxOf(rect.left + (rect.width - width) / 2, rect.top + rect.height - width * RATIO, width);
  }

  /** Whether the straight way between two points goes through a rectangle. */
  function crosses(a, b, rect) {
    if (!rect) return false;
    const steps = Math.max(8, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 24));
    for (let i = 0; i <= steps; i++) {
      const x = a.x + (b.x - a.x) * i / steps;
      const y = a.y + (b.y - a.y) * i / steps;
      if (x > rect.left && x < rect.left + rect.width && y > rect.top && y < rect.top + rect.height) return true;
    }
    return false;
  }

  /**
   * The way from a place to another, as the places to land on one after the
   * other (the last is the end). `covered`: what is painted over the page,
   * to go round: above it, along its top, then down beside it. `single`:
   * each stretch in one hop, however long (the user is waiting).
   */
  function wayTo(from, to, covered = null, { single = false } = {}) {
    const a = feet(from);
    const b = feet(to);
    const stops = [];
    const room = covered ? { left: covered.left - to.width / 2, top: covered.top - 2, width: covered.width + to.width, height: covered.height + to.height } : null;
    if (room && crosses(a, b, room)) {
      // Up to the top of what is covered (when not there already), along it, then down where the end is.
      const above = Math.max(to.height + 2, room.top - 4);
      if (a.y > above + 1) stops.push({ x: a.x, y: above });
      if (b.y > above + 1 && Math.abs(b.x - a.x) > 1) stops.push({ x: b.x, y: above });
    }
    stops.push(b);
    // Each stretch in hops of a bounded length.
    const places = [];
    let at = a;
    const whole = stops.reduce((sum, stop, i) => sum + Math.hypot(stop.x - (i ? stops[i - 1].x : a.x), stop.y - (i ? stops[i - 1].y : a.y)), 0) || 1;
    let done = 0;
    stops.forEach(stop => {
      const length = Math.hypot(stop.x - at.x, stop.y - at.y);
      const hops = single ? 1 : clamp(Math.ceil(length / HOP_MOST), 1, HOPS_MOST);
      for (let i = 1; i <= hops; i++) {
        const share = (done + length * i / hops) / whole;
        const w = from.width + (to.width - from.width) * share;
        const x = at.x + (stop.x - at.x) * i / hops;
        const y = at.y + (stop.y - at.y) * i / hops;
        places.push(boxOf(x - w / 2, y - w * RATIO, w));
      }
      done += length;
      at = stop;
    });
    places[places.length - 1] = { ...to };
    return places;
  }

  /** How long a hop takes and how high it goes, from how far it goes. `quick`: the user is waiting for what it opens. */
  function hopOf(from, to, quick = false) {
    const a = feet(from);
    const b = feet(to);
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    const size = (from.width + to.width) / 2;
    return {
      length,
      ms: Math.round(quick ? clamp(180 + length * 0.22, 200, 340) : clamp(260 + length * 0.55, 300, 560)),
      // Higher for a longer hop and for a bigger character; going down it needs less. Never so high
      // that its head leaves the window: near the top of it the hops are low.
      height: Math.max(4, Math.min(clamp(length * 0.32 + size * 0.5, 26, 170) * (b.y > a.y + 40 ? 0.7 : 1), (a.y + b.y) / 2 - (from.height + to.height) / 2 - 2))
    };
  }

  /**
   * The character at a moment of a hop (0 to 1): where it is and how it is
   * squeezed. It crouches before leaving, stretches as it goes up, and is
   * flattened as it lands.
   */
  function hopAt(from, to, hop, moment) {
    const p = clamp(moment, 0, 1);
    const crouch = 0.14;
    const land = 0.86;
    if (p < crouch) {
      const k = p / crouch;
      return { ...from, scaleX: 1 + 0.12 * k, scaleY: 1 - 0.18 * k };
    }
    const flown = clamp((p - crouch) / (land - crouch), 0, 1);
    const a = feet(from);
    const b = feet(to);
    const width = from.width + (to.width - from.width) * flown;
    const x = a.x + (b.x - a.x) * flown;
    const y = a.y + (b.y - a.y) * flown - hop.height * 4 * flown * (1 - flown);
    const box = boxOf(x - width / 2, y - width * RATIO, width);
    if (p >= land) {
      const k = (p - land) / (1 - land);
      // Flat as it touches, then up again a little past its shape, then itself.
      const flat = k < 0.5 ? 1 - k * 2 : 0;
      const over = k >= 0.5 ? Math.sin((k - 0.5) * 2 * Math.PI) * 0.05 : 0;
      return { ...to, scaleX: 1 + 0.16 * flat - over, scaleY: 1 - 0.22 * flat + over };
    }
    const stretch = Math.sin(flown * Math.PI);
    return { ...box, scaleX: 1 - 0.06 * (1 - stretch), scaleY: 1 + 0.1 * (1 - stretch) };
  }

  const geometry = { RATIO, HOP_MOST, SIZES, standOn, inSlot, wayTo, hopOf, hopAt, crosses, overlaps, boxOf, feet };
  if (typeof module !== 'undefined' && module.exports) module.exports = geometry;
  if (typeof window === 'undefined' || typeof document === 'undefined') return;

  /* ---------------------------------------------------------------- */
  /* On the page                                                        */
  /* ---------------------------------------------------------------- */

  const rectOf = (el) => {
    if (!el || !el.isConnected) return null;
    const r = el.getBoundingClientRect();
    return r.width < 2 || r.height < 2 ? null : { left: r.left, top: r.top, width: r.width, height: r.height };
  };
  const viewSize = () => ({ width: window.innerWidth, height: window.innerHeight });
  const still = () => { try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; } };
  const activeView = () => ['realtime', 'chat', 'code', 'studio', 'settings'].find(name => document.getElementById(`tab-btn-${name}`)?.classList.contains('active')) || 'chat';

  const mascot = {
    geometry,
    el: null,
    puppet: null,
    box: null,           // where it is drawn now
    place: null,         // where it belongs: { kind: 'perch' | 'stage' | 'slot' | 'stand', el, rect, size, avoid }
    moving: null,        // the move under way: a promise
    wanted: 0,           // the last move asked for: an older one gives way to it
    heading: null,       // the place it was last sent to
    ready: false,

    /** What is painted over the page and would hide the character: the editor of the project open in the Code tab. */
    covered() {
      if (activeView() !== 'code') return null;
      const shell = document.getElementById('code-editor-shell');
      if (!shell || shell.hidden) return null;
      return rectOf(document.getElementById('code-container'));
    },

    build() {
      if (this.el || !window.RealtimePuppet) return;
      const el = document.createElement('div');
      el.className = 'mo';
      el.setAttribute('aria-hidden', 'true');
      if ('popover' in HTMLElement.prototype) el.setAttribute('popover', 'manual');
      el.hidden = true;
      document.body.appendChild(el);
      this.el = el;
      this.puppet = new window.RealtimePuppet(el);
      // A window opened over the page goes above everything drawn before it: the character is raised again.
      new MutationObserver((changes) => { if (changes.some(change => change.target.tagName === 'DIALOG')) this.raise(); })
        .observe(document.body, { subtree: true, attributes: true, attributeFilter: ['open'] });
      const follow = () => { this.follow(); requestAnimationFrame(follow); };
      requestAnimationFrame(follow);
    },

    raise() {
      const el = this.el;
      if (!el || el.hidden || typeof el.showPopover !== 'function') return;
      try { if (el.matches(':popover-open')) el.hidePopover(); el.showPopover(); } catch {}
    },

    show(on) {
      const el = this.el;
      if (!el || el.hidden === !on) return;
      el.hidden = !on;
      if (on) { this.puppet.start(); this.raise(); } else {
        this.puppet.stop();
        try { if (el.matches(':popover-open')) el.hidePopover(); } catch {}
      }
    },

    draw(state) {
      const el = this.el;
      this.box = { left: state.left, top: state.top, width: state.width, height: state.height };
      el.style.width = `${state.width}px`;
      el.style.height = `${state.height}px`;
      el.style.transform = `translate(${Math.round(state.left * 10) / 10}px, ${Math.round(state.top * 10) / 10}px) scale(${state.scaleX || 1}, ${state.scaleY || 1})`;
    },

    /* ------------------------------ places -------------------------- */

    stagePuppet() { return window.realtime?._state?.ui?.puppet || null; },

    /** The character's seat on the other tabs: the icon of its own button, which it takes the place of. */
    perch() {
      const button = document.getElementById('tab-btn-realtime');
      const icon = button?.querySelector('i');
      const rect = rectOf(icon) || rectOf(button);
      if (!rect) return null;
      const size = SIZES.perch;
      return { kind: 'perch', el: button, box: boxOf(rect.left + rect.width / 2 - size / 2, rect.top + rect.height + 3 - size * RATIO, size) };
    },

    /** Where a place is on the page now; null when it is not there any more. */
    boxFor(place) {
      if (!place) return null;
      if (place.kind === 'perch') return this.perch()?.box || null;
      if (place.kind === 'stage') { const rect = rectOf(this.stagePuppet()); return rect ? inSlot(rect) : null; }
      // A slot is an element, or what finds it: a window drawn again has a new one in the same place.
      if (place.kind === 'slot') { const rect = rectOf(typeof place.el === 'function' ? place.el() : place.el); return rect ? inSlot(rect) : null; }
      const rect = place.rect ? place.rect() : rectOf(place.el);
      if (!rect) return null;
      return standOn(rect, place.size || SIZES.stand, viewSize(), place.avoid ? place.avoid() : null).box;
    },

    /** Where it belongs with nothing to do: the centre of its own section, its button on the other tabs. */
    idlePlace() {
      if (activeView() === 'realtime' && rectOf(this.stagePuppet())) return { kind: 'stage' };
      return { kind: 'perch' };
    },

    /** The stage's own puppet and the one that travels change places: one is seen at a time. */
    settle() {
      const onStage = this.place?.kind === 'stage' && !this.moving;
      const stage = this.stagePuppet();
      if (stage) stage.classList.toggle('is-away', !onStage);
      document.getElementById('tab-btn-realtime')?.classList.toggle('has-mo', this.place?.kind === 'perch' && !this.moving);
      this.show(!onStage);
    },

    /** Every frame, while it stays somewhere: it keeps to its place as the page moves under it. */
    follow() {
      // From a tab to another the page is being drawn: where it goes is said when that is done.
      if (!this.ready || this.moving || this.switching || !this.place) return;
      const box = this.boxFor(this.place);
      if (!box) {
        // What it stood on is gone: back where it belongs.
        if (!['perch', 'stage'].includes(this.place.kind)) this.home();
        else if (this.place.kind === 'stage') this.go(this.idlePlace());
        return;
      }
      if (this.place.kind === 'stage') return;
      const b = this.box;
      if (!b || Math.abs(b.left - box.left) > 0.5 || Math.abs(b.top - box.top) > 0.5 || Math.abs(b.width - box.width) > 0.5) this.draw(box);
    },

    /* ------------------------------ moving -------------------------- */

    /**
     * To a place, hopping. `press`: what gives way under it as it lands;
     * `quick`: the user is waiting for what it opens. Resolves as it lands
     * (false when a later move took its place).
     */
    go(place, { press = null, quick = false, from = null } = {}) {
      if (!this.ready) return Promise.resolve(false);
      const turn = ++this.wanted;
      this.heading = place;   // where it was last sent, known at once: the move itself waits for the one before it
      const run = async () => {
        if (turn !== this.wanted) return false;
        const to = this.boxFor(place);
        if (!to) return false;
        // From the stage it leaves from where the stage's own puppet stands.
        const start = from || (this.place?.kind === 'stage' ? this.boxFor(this.place) : null) || this.box || this.boxFor(this.place) || this.perch()?.box || to;
        const same = this.place && this.place.kind === place.kind && this.place.el === place.el && !place.rect && !from;
        this.moving = true;
        this.place = place;
        this.settle();
        this.draw(start);
        this.raise();
        if (!same && !still() && Math.hypot(feet(start).x - feet(to).x, feet(start).y - feet(to).y) > 6) {
          const stops = wayTo(start, to, this.covered(), { single: quick });
          this.puppet.setExpression('joy', 1200);
          let at = start;
          for (let i = 0; i < stops.length; i++) {
            const last = i === stops.length - 1;
            // The end may have moved while it was on its way.
            const end = last ? (this.boxFor(place) || stops[i]) : stops[i];
            this.puppet.look(feet(end).x, feet(end).y - end.height / 2);
            await this.hop(at, end, hopOf(at, end, quick), last ? press : null);
            at = end;
            if (turn !== this.wanted) break;
          }
        } else {
          this.draw(to);
          if (press) this.press(press);
        }
        this.moving = null;
        this.settle();
        return turn === this.wanted;
      };
      const chained = (this.queue || Promise.resolve()).then(run, run);
      this.queue = chained.catch(() => {});
      return chained;
    },

    hop(from, to, hop, press) {
      return new Promise(resolve => {
        const started = performance.now();
        let pressed = false;
        const frame = (now) => {
          const moment = (now - started) / hop.ms;
          this.draw(hopAt(from, to, hop, moment));
          if (!pressed && press && moment >= 0.86) { pressed = true; this.press(press); }
          if (moment >= 1) { this.draw(to); resolve(); } else requestAnimationFrame(frame);
        };
        requestAnimationFrame(frame);
      });
    },

    /** What the character landed on gives way under it, and comes back. */
    press(el) {
      if (!el?.classList || still()) return;
      el.classList.remove('mo-landed');
      void el.offsetWidth;
      el.classList.add('mo-landed');
      setTimeout(() => el.classList.remove('mo-landed'), 520);
    },

    /* ------------------------------ what it is asked ----------------- */

    /** Back where it belongs with nothing to do. */
    home() { return this.go(this.idlePlace()); },

    /** Into a slot made for it (a notice, a question), where it stays until it is let go. */
    dock(slot) {
      if (!slot) return Promise.resolve(false);
      if (this.place?.kind === 'slot' && this.place.el === slot) return Promise.resolve(true);
      return this.go({ kind: 'slot', el: slot });
    },

    /** It stays on an element (or on what `rect` gives), which gives way under it as it lands. */
    stand(el, { rect = null, avoid = null, size = SIZES.stand, press = null, quick = false } = {}) {
      return this.go({ kind: 'stand', el, rect, avoid, size }, { press: press === null ? pressable(el) : press, quick });
    },

    /** Let go of what it was on, when it is still there. */
    release(el) {
      if (el && this.place?.el !== el) return Promise.resolve(false);
      return this.home();
    },

    /** Onto an element and back: what it does when something is opened. */
    async visit(el, options = {}) {
      if (!rectOf(el)) return false;
      const landed = await this.stand(el, options);
      if (landed) setTimeout(() => { if (this.place?.el === el) this.home(); }, options.stay ?? 350);
      return landed;
    }
  };

  /** What gives way under the character: a button, a card, a link; not a field, a list or a panel. */
  function pressable(el) {
    if (!el?.matches) return null;
    if (el.matches('button, [role="button"], a, .nav-tab, .rt-home-card, .rt-toast, .btn')) return el;
    const r = el.getBoundingClientRect();
    return r.width <= 260 && r.height <= 80 && !el.matches('input, textarea, select') ? el : null;
  }

  /** What is said to the stage's puppet is said to the one that travels too: the same face, the same mouth. */
  function mirror() {
    const stage = window.realtime?._state?.puppet;
    if (!stage || stage.mirrored || !mascot.puppet) return;
    stage.mirrored = true;
    ['setState', 'setExpression', 'setHearing'].forEach(name => {
      const own = stage[name].bind(stage);
      stage[name] = (...args) => { try { mascot.puppet[name](...args); } catch {} return own(...args); };
    });
    // The mouth is told at every frame, closed when the stage's voice is silent: said to the other only
    // while that voice speaks and as it stops, or it would shut the mouth of a voice that is not the stage's.
    const mouth = stage.setMouthShape.bind(stage);
    let open = 0;
    stage.setMouthShape = (shape = {}) => {
      const now = shape.open || 0;
      if (now > 0 || open > 0) { try { mascot.puppet.setMouthShape(shape); } catch {} }
      open = now;
      return mouth(shape);
    };
  }

  function start() {
    if (mascot.ready || !window.RealtimePuppet) return;
    mascot.build();
    mascot.ready = true;
    mascot.place = mascot.idlePlace();
    const box = mascot.boxFor(mascot.place);
    if (box) mascot.draw(box);
    mirror();
    mascot.settle();
    // From a tab to the other: out of its section it goes to sit on its button, into it to the centre.
    const switched = window.switchView;
    if (typeof switched === 'function' && !switched.withMascot) {
      const wrapped = (name) => {
        const before = mascot.place?.kind === 'stage' ? mascot.boxFor({ kind: 'stage' }) : null;
        mascot.switching = true;
        const result = switched(name);
        // Its section is drawn when it is first opened: a frame, and the stage is there.
        requestAnimationFrame(() => requestAnimationFrame(() => {
          mascot.switching = false;
          mirror();
          // On an element the tour or a notice put it on, it stays: they say when it may go.
          if (['slot', 'stand'].includes(mascot.place?.kind) && mascot.boxFor(mascot.place)) return;
          mascot.go(mascot.idlePlace(), { from: before });
        }));
        return result;
      };
      Object.assign(wrapped, switched, { withMascot: true });
      window.switchView = wrapped;
    }
    window.addEventListener('resize', () => mascot.follow());
  }

  window.mascot = mascot;
  const later = () => setTimeout(start, 1200);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', later);
  else later();
})();
