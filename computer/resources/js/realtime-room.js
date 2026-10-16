/**
 * SynthOrg - the character's room.
 *
 * What the character keeps for the user is in the room it lives in, as the
 * things of a room: a calendar on the wall for the agenda, a small table with
 * the diary on it, a plant for the wellbeing, a board of notes for the tasks,
 * a piggy bank on a shelf for what the models cost. Each says in a line what
 * is inside, lights up when it is pointed at, and opens its page when
 * pressed: the page grows out of the thing itself. The computer and the table
 * of the files are the desk's (realtime-desk.js).
 *
 * These are methods of the section's object (realtime.js), kept in a file of
 * their own. The phone keeps its cards: there is no room to draw on it.
 */
(function () {
  'use strict';

  const rt = window.realtime._state;
  const { t, esc } = window.realtime._util;
  const still = () => { try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; } };

  // Each thing as it is drawn, in a box of its own.
  const DRAWINGS = {
    /** A calendar hung on the wall, open on today. */
    agenda() {
      const now = new Date();
      const locale = window.i18n?.getLocale?.() === 'en' ? 'en-GB' : 'it-IT';
      const month = now.toLocaleDateString(locale, { month: 'short' }).replace('.', '').toUpperCase();
      return `<svg class="rt-room-svg" viewBox="0 0 80 96" aria-hidden="true">
        <rect class="rt-room-paper rt-room-edge" x="6" y="12" width="68" height="80" rx="6"/>
        <path class="rt-room-accent" d="M6 18 a6 6 0 0 1 6 -6 h56 a6 6 0 0 1 6 6 v16 h-68 Z"/>
        <rect class="rt-room-dark" x="21" y="4" width="5" height="15" rx="2.5"/>
        <rect class="rt-room-dark" x="54" y="4" width="5" height="15" rx="2.5"/>
        <text class="rt-room-month" x="40" y="29" text-anchor="middle">${esc(month)}</text>
        <text class="rt-room-day" x="40" y="74" text-anchor="middle">${now.getDate()}</text>
        <path class="rt-room-fold" d="M60 92 l14 -14 v8 a6 6 0 0 1 -6 6 Z"/>
      </svg>`;
    },

    /** A small table seen from a little above, the diary lying on it with its ribbon and a pen beside it. */
    diary() {
      return `<svg class="rt-room-svg" viewBox="0 0 130 104" aria-hidden="true">
        <rect class="rt-room-dark" x="26" y="52" width="5" height="40"/>
        <rect class="rt-room-dark" x="99" y="52" width="5" height="40"/>
        <path class="rt-room-top rt-room-edge" d="M22 30 h86 l18 22 h-122 Z"/>
        <rect class="rt-room-shell rt-room-edge" x="4" y="52" width="122" height="8" rx="2"/>
        <rect class="rt-room-dark" x="9" y="60" width="6" height="42" rx="1"/>
        <rect class="rt-room-dark" x="115" y="60" width="6" height="42" rx="1"/>
        <path class="rt-room-paper" d="M40 47 h46 l1 3.5 h-48 Z"/>
        <path class="rt-room-accent rt-room-edge" d="M46 34 h34 l6 13 h-46 Z"/>
        <path class="rt-room-ribbon" d="M68 34 l2.6 13 l1.6 6 l2.4 -2 l2.8 1.4 l-3.4 -18.4 Z"/>
        <path class="rt-room-line" d="M54 39 h18 M52.5 42.5 h12"/>
        <path class="rt-room-pen" d="M95 36 l11 10"/>
      </svg>`;
    },

    /** A plant in its pot. */
    wellbeing() {
      return `<svg class="rt-room-svg" viewBox="0 0 80 104" aria-hidden="true">
        <path class="rt-room-leaf" d="M40 66 C 22 58 14 40 18 22 C 32 30 40 46 40 66 Z"/>
        <path class="rt-room-leaf is-light" d="M40 66 C 58 58 66 40 62 22 C 48 30 40 46 40 66 Z"/>
        <path class="rt-room-leaf" d="M40 66 C 33 46 34 22 40 6 C 46 22 47 46 40 66 Z"/>
        <path class="rt-room-leaf is-light" d="M40 68 C 26 68 12 60 6 48 C 22 46 34 54 40 68 Z"/>
        <path class="rt-room-leaf" d="M40 68 C 54 68 68 60 74 48 C 58 46 46 54 40 68 Z"/>
        <rect class="rt-room-shell rt-room-edge" x="19" y="64" width="42" height="9" rx="3"/>
        <path class="rt-room-top rt-room-edge" d="M23 73 h34 l-5 28 h-24 Z"/>
      </svg>`;
    },

    /** A board on the wall, notes pinned to it. */
    tasks() {
      return `<svg class="rt-room-svg" viewBox="0 0 120 88" aria-hidden="true">
        <rect class="rt-room-shell rt-room-edge" x="3" y="3" width="114" height="82" rx="6"/>
        <rect class="rt-room-cork" x="10" y="10" width="100" height="68" rx="3"/>
        <g transform="rotate(-5 34 36)"><rect class="rt-room-paper" x="18" y="18" width="32" height="34"/><path class="rt-room-line" d="M23 28 h22 M23 34 h22 M23 40 h14"/></g>
        <g transform="rotate(4 80 34)"><rect class="rt-room-paper is-tint" x="62" y="16" width="34" height="30"/><path class="rt-room-line" d="M67 26 h24 M67 32 h18"/></g>
        <g transform="rotate(3 58 62)"><rect class="rt-room-paper" x="44" y="50" width="30" height="22"/><path class="rt-room-line" d="M49 58 h20 M49 64 h12"/></g>
        <circle class="rt-room-pin" cx="34" cy="20" r="3"/><circle class="rt-room-pin" cx="80" cy="18" r="3"/><circle class="rt-room-pin" cx="59" cy="52" r="3"/>
      </svg>`;
    },

    /** A piggy bank on a shelf, a coin at its slot. */
    usage() {
      return `<svg class="rt-room-svg" viewBox="0 0 110 84" aria-hidden="true">
        <rect class="rt-room-coin" x="48" y="6" width="5" height="16" rx="2.5"/>
        <path class="rt-room-top" d="M30 32 l-4 -13 l14 7 Z"/>
        <ellipse class="rt-room-shell rt-room-edge" cx="54" cy="44" rx="34" ry="24"/>
        <rect class="rt-room-dark" x="43" y="23" width="18" height="3.6" rx="1.8"/>
        <ellipse class="rt-room-top rt-room-edge" cx="88" cy="46" rx="9" ry="8"/>
        <circle class="rt-room-dark" cx="86" cy="45" r="1.5"/><circle class="rt-room-dark" cx="91" cy="45" r="1.5"/>
        <circle class="rt-room-dark" cx="73" cy="36" r="2.4"/>
        <path class="rt-room-tail" d="M20 42 q-8 -2 -6 -8 q4 -4 6 1"/>
        <rect class="rt-room-top" x="34" y="62" width="9" height="10" rx="2"/><rect class="rt-room-top" x="66" y="62" width="9" height="10" rx="2"/>
        <rect class="rt-room-dark" x="4" y="72" width="102" height="6" rx="2"/>
        <path class="rt-room-dark" d="M18 78 h8 l-4 6 Z M84 78 h8 l-4 6 Z"/>
      </svg>`;
    }
  };

  Object.assign(rt, {
    /**
     * A thing of the room: its drawing, its name and a glimpse of what is
     * inside. Pressed, it opens its page (data-side-tab, as the cards did).
     */
    roomObject(id, big, small, extra = '') {
      return `
        <button type="button" class="rt-room-object rt-home-${id}${extra}" data-side-tab="${id}">
          ${DRAWINGS[id]()}
          <span class="rt-room-text">
            <span class="rt-room-name">${esc(t('realtime.tab_' + id))}</span>
            <span class="rt-room-big">${big}</span>
            <span class="rt-room-small">${small}</span>
          </span>
        </button>`;
    },

    /** A page comes out of the thing that was pressed: it grows from where the thing is. */
    growFrom(node, from) {
      if (!node || !from || still()) return;
      const to = node.getBoundingClientRect();
      if (!to.width || !to.height) return;
      const small = { transformOrigin: '0 0', transform: `translate(${from.left - to.left}px, ${from.top - to.top}px) scale(${from.width / to.width}, ${from.height / to.height})`, opacity: 0.25 };
      node.animate([small, { transformOrigin: '0 0', transform: 'none', opacity: 1 }], { duration: 420, easing: 'cubic-bezier(.2,.8,.3,1)' });
    }
  });
})();
