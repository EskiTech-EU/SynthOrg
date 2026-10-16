'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const M = require('../resources/js/realtime-mascot.js');

const view = { width: 1400, height: 900 };
const rect = (left, top, width, height) => ({ left, top, width, height });
const round = (box) => ({ left: Math.round(box.left), top: Math.round(box.top), width: Math.round(box.width), height: Math.round(box.height) });
const inView = (box) => box.left >= 0 && box.top >= 0 && box.left + box.width <= view.width && box.top + box.height <= view.height;

test('it stands on the top edge of what it lands on, its feet a little into it', () => {
  const card = rect(1080, 300, 140, 140);
  const place = M.standOn(card, 52, view);
  assert.equal(place.side, 'top');
  const feet = M.feet(place.box);
  assert.equal(Math.round(feet.x), 1150, 'in the middle of it');
  assert.equal(Math.round(feet.y), 308, 'eight pixels into it');
  assert.equal(Math.round(place.box.height), Math.round(52 * 260 / 240));
  const thin = M.standOn(rect(500, 400, 80, 12), 52, view);
  assert.equal(Math.round(M.feet(thin.box).y), 404, 'a third into what is thin');
});

test('with no room above it stands beside, then below; never out of the window, never over the tour\'s card', () => {
  const tab = rect(400, 14, 110, 36);              // a button of the bar at the top
  const beside = M.standOn(tab, 52, view);
  assert.equal(beside.side, 'right');
  assert.ok(inView(beside.box));
  assert.equal(Math.round(M.feet(beside.box).y), 58, 'its feet as near the button\'s bottom as the window lets');
  const corner = M.standOn(rect(1300, 10, 96, 30), 52, view);
  assert.equal(corner.side, 'left', 'at the right edge of the window it goes to the left of it');
  const wide = M.standOn(rect(0, 10, 1400, 40), 52, view);
  assert.equal(wide.side, 'bottom');
  const card = rect(560, 200, 300, 180);           // the tour's card, above the element
  const under = M.standOn(rect(660, 392, 100, 40), 52, view, card);
  assert.notEqual(under.side, 'top', 'on top of the element it would be over the card');
  assert.equal(M.overlaps(under.box, card), false);
  const huge = M.standOn(rect(0, 0, 1400, 900), 52, view, rect(900, 600, 300, 200));
  assert.equal(huge.side, 'avoid', 'nowhere around it: on the card');
  assert.ok(inView(huge.box));
  const lost = M.standOn(rect(0, 0, 1400, 900), 52, view);
  assert.ok(inView(lost.box));
});

test('in a place made for it, it is as big as the place, with its feet on its bottom', () => {
  assert.deepEqual(round(M.inSlot(rect(20, 120, 40, 43.3))), { left: 20, top: 120, width: 40, height: 43 });
  const tall = M.inSlot(rect(100, 100, 56, 200));
  assert.deepEqual([Math.round(tall.width), Math.round(tall.top + tall.height)], [56, 300]);
  const wide = M.inSlot(rect(100, 100, 400, 130));
  assert.deepEqual([Math.round(wide.width), Math.round(wide.left + wide.width / 2)], [120, 300], 'in the middle of a wide one');
});

test('the way is made of hops of a bounded length, and changes size little by little', () => {
  const perch = M.boxOf(430, 12, 30);
  const near = M.boxOf(20, 118, 40);
  const one = M.wayTo(perch, near);
  assert.equal(one.length, 2, 'four hundred and some pixels: two hops');
  assert.deepEqual(round(one[one.length - 1]), round(near));
  const stage = M.boxOf(350, 250, 360);
  const card = M.boxOf(1120, 250, 52);
  const way = M.wayTo(stage, card);
  assert.equal(way.length, 2);
  assert.ok(way[0].width < 360 && way[0].width > 52, 'half way it is between the two sizes');
  for (let i = 0; i < way.length; i++) {
    const from = i ? M.feet(way[i - 1]) : M.feet(stage);
    const to = M.feet(way[i]);
    assert.ok(Math.hypot(to.x - from.x, to.y - from.y) <= M.HOP_MOST + 1);
  }
  assert.equal(M.wayTo(stage, card, null, { single: true }).length, 1, 'the user is waiting: one hop');
  assert.equal(M.wayTo(M.boxOf(0, 0, 40), M.boxOf(1300, 800, 40)).length, 4);
  assert.equal(M.wayTo(near, near).length, 1);
});

test('it goes round the editor of a project, which is painted over the page: above it, then down beside it', () => {
  const editor = rect(0, 188, 1020, 712);
  const perch = M.boxOf(430, 12, 30);              // on its button, in the bar at the top
  const strip = M.boxOf(20, 125, 40);              // the notice, above the editor
  const chat = M.boxOf(1040, 700, 40);             // the advice, in the panel beside the editor
  const toast = M.boxOf(1090, 760, 52);            // a reminder, at the bottom right
  const through = (from, way) => way.some((box, i) => {
    const a = M.feet(i ? way[i - 1] : from);
    const b = M.feet(box);
    // the feet, all along the hop on the ground
    for (let k = 0; k <= 20; k++) {
      const x = a.x + (b.x - a.x) * k / 20;
      const y = a.y + (b.y - a.y) * k / 20;
      if (x > editor.left && x < editor.left + editor.width && y > editor.top + 2 && y < editor.top + editor.height) return true;
    }
    return false;
  });
  assert.equal(through(perch, M.wayTo(perch, strip, editor)), false, 'to the strip it never goes over the editor');
  assert.equal(M.wayTo(perch, strip, editor).length, M.wayTo(perch, strip).length, 'nothing to go round: the straight way');
  assert.equal(through(perch, M.wayTo(perch, chat)), true, 'the straight way to the panel goes over it');
  const round1 = M.wayTo(perch, chat, editor);
  assert.equal(through(perch, round1), false);
  assert.deepEqual(round(round1[round1.length - 1]), round(chat));
  assert.ok(round1.length >= 3, 'along the top, then down');
  assert.equal(through(perch, M.wayTo(perch, toast, editor)), false);
  assert.equal(through(chat, M.wayTo(chat, perch, editor)), false, 'and back');
  assert.equal(through(strip, M.wayTo(strip, chat, editor)), false);
});

test('a hop: a crouch, an arc, a landing that flattens it and lets it up again', () => {
  const from = M.boxOf(100, 400, 50);
  const to = M.boxOf(400, 400, 50);
  const hop = M.hopOf(from, to);
  assert.ok(hop.ms >= 300 && hop.ms <= 560);
  assert.ok(hop.height >= 26 && hop.height <= 170);
  const start = M.hopAt(from, to, hop, 0);
  assert.deepEqual([start.left, start.top, start.scaleX, start.scaleY], [100, 400, 1, 1]);
  const crouch = M.hopAt(from, to, hop, 0.13);
  assert.equal(crouch.left, 100, 'it has not left yet');
  assert.ok(crouch.scaleY < 0.9 && crouch.scaleX > 1.05);
  const top = M.hopAt(from, to, hop, 0.5);
  assert.ok(Math.abs(M.feet(top).x - 275) < 1, 'half way across');
  assert.ok(Math.abs(M.feet(top).y - (M.feet(from).y - hop.height)) < 1, 'at the top of the arc');
  const touch = M.hopAt(from, to, hop, 0.87);
  assert.equal(touch.left, 400);
  assert.ok(touch.scaleY < 0.85 && touch.scaleX > 1.1, 'flat as it touches');
  const end = M.hopAt(from, to, hop, 1);
  assert.ok(Math.abs(end.scaleX - 1) < 0.001 && Math.abs(end.scaleY - 1) < 0.001);
  assert.deepEqual([end.left, end.top, end.width], [400, 400, 50]);
  // never below the ground it goes between, never anything but a number
  for (let p = 0; p <= 1.0001; p += 0.02) {
    const at = M.hopAt(from, to, hop, p);
    assert.ok(M.feet(at).y <= M.feet(from).y + 0.001);
    assert.ok([at.left, at.top, at.width, at.scaleX, at.scaleY].every(Number.isFinite));
  }
  const quick = M.hopOf(M.boxOf(350, 250, 360), M.boxOf(1120, 250, 52), true);
  assert.ok(quick.ms <= 340, 'the user does not wait more than a third of a second');
  const down = M.hopOf(M.boxOf(430, 12, 30), M.boxOf(430, 500, 30));
  const up = M.hopOf(M.boxOf(430, 500, 30), M.boxOf(430, 12, 30));
  assert.ok(down.height < up.height, 'going down it needs less of a leap');
  // along the bar at the top of the window its head stays in the window
  const bar = [M.boxOf(399, 9, 30), M.boxOf(760, 9, 30)];
  const low = M.hopOf(bar[0], bar[1]);
  for (let p = 0; p <= 1.0001; p += 0.02) assert.ok(M.hopAt(bar[0], bar[1], low, p).top >= 0, `out of the window at ${p}`);
  assert.ok(low.height >= 4, 'still a hop');
  assert.deepEqual(M.hopAt(from, to, hop, -3).left, 100);
  assert.deepEqual(M.hopAt(from, to, hop, 7).left, 400);
});

test('there is one character: nothing in the app draws one of its own but the stage', () => {
  const root = path.join(__dirname, '../resources/js');
  const makers = fs.readdirSync(root).filter(name => name.endsWith('.js'))
    .filter(name => /new (window\.)?RealtimePuppet\(/.test(fs.readFileSync(path.join(root, name), 'utf8')));
  assert.deepEqual(makers.sort(), ['realtime-mascot.js', 'realtime.js']);
});
