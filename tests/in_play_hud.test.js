'use strict';
// INIT-006/SPEC-003: in-play signed-error HUD — injected timestamps (REQ-010).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SCREEN_JS = path.join(__dirname, '..', 'screen.js');
const SCREEN_SRC = fs.readFileSync(SCREEN_JS, 'utf8');
const PLUGIN_JSON = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'plugin.json'), 'utf8'));

function freshPlugin() {
    global.window = {};
    global.localStorage = { getItem: () => null, setItem: () => {} };
    global.document = {
        addEventListener: () => {},
        querySelectorAll: () => [],
        createElement: (tag) => el(tag),
    };
    global.fetch = async () => ({ ok: true, json: async () => ({}) });
    delete require.cache[require.resolve(SCREEN_JS)];
    return require(SCREEN_JS);
}

function el(tag) {
    const node = {
        tagName: String(tag).toUpperCase(),
        className: '',
        hidden: false,
        style: { position: '', cssText: '' },
        dataset: {},
        children: [],
        attributes: {},
        parentNode: null,
        textContent: '',
        setAttribute(k, v) {
            this.attributes[k] = String(v);
            if (k === 'class') this.className = v;
            if (k === 'data-drums-inplay') this.dataset.drumsInplay = String(v);
            if (k === 'hidden') this.hidden = true;
        },
        getAttribute(k) {
            if (Object.prototype.hasOwnProperty.call(this.attributes, k)) return this.attributes[k];
            return null;
        },
        removeAttribute(k) {
            delete this.attributes[k];
            if (k === 'hidden') this.hidden = false;
        },
        appendChild(child) {
            child.parentNode = this;
            this.children.push(child);
            return child;
        },
        removeChild(child) {
            this.children = this.children.filter((c) => c !== child);
            child.parentNode = null;
            return child;
        },
    };
    return node;
}

function mappedSnare(mod, t) {
    mod._applyLanePreset('phase_shift_8');
    mod._setAttachedDevice('pad-1', { notes: { '38': 'snare' } });
    return mod._drumTabHitsToNotes([{ p: 'snare', t: t, v: 100 }]);
}

function mockTap() {
    return {
        convert(midiTimeStamp, opts) {
            const now = Number(opts && opts.now);
            const chartT = Number(typeof (opts && opts.getTime) === 'function' ? opts.getTime() : 0);
            const base = Number.isFinite(chartT) ? chartT : 0;
            let ts = Number(midiTimeStamp);
            if (!Number.isFinite(ts) || ts === 0) ts = now;
            const tChart = base + (ts - now) / 1000;
            return { tChart: Number.isFinite(tChart) ? tChart : base, lowConfidence: false };
        },
        effectiveT(tChart, offsetMs) {
            const t = Number(tChart);
            if (!Number.isFinite(t)) return 0;
            const off = Number(offsetMs);
            const safeOff = Number.isFinite(off) ? off : 0;
            return t - safeOff / 1000;
        },
    };
}

test('ac-4: manifest id is lowercase and equals drums', () => {
    assert.equal(PLUGIN_JSON.id, 'drums');
    assert.equal(PLUGIN_JSON.id, PLUGIN_JSON.id.toLowerCase());
    assert.equal(typeof PLUGIN_JSON.styles, 'string');
    assert.match(PLUGIN_JSON.styles, /^assets\//);
    assert.doesNotMatch(PLUGIN_JSON.styles, /\.\.|\\|\?|#/);
});

test('in-play HUD is display-only (no writeTiming / offset_ms writes)', () => {
    const start = SCREEN_SRC.indexOf('const IN_PLAY_ERROR_WINDOW');
    const end = SCREEN_SRC.indexOf('function _syncAllInPlayHuds');
    assert.ok(start > 0 && end > start, 'helper block not found');
    const block = SCREEN_SRC.slice(start, end);
    assert.doesNotMatch(block, /writeTiming/);
    assert.doesNotMatch(block, /timing\.offset_ms/);
    assert.doesNotMatch(SCREEN_SRC, /_latestTime\s*=\s*bundle\.currentTime/);
    const checkHit = SCREEN_SRC.match(/function _checkHit\([\s\S]*?\n    function _updateMissedNotes/);
    assert.ok(checkHit);
    assert.doesNotMatch(checkHit[0], /writeTiming/);
    assert.doesNotMatch(checkHit[0], /const t = _latestTime/);
});

test('prefers highway.getJudgeTime() and falls back to getTime()', () => {
    const mod = freshPlugin();
    global.window.highway = { getTime: () => 99, getJudgeTime: () => 1.5 };
    assert.equal(mod._highwayGetTime(), 1.5);

    const mod2 = freshPlugin();
    global.window.highway = { getTime: () => 2 };
    assert.equal(mod2._highwayGetTime(), 2);

    const mod3 = freshPlugin();
    global.window.highway = {};
    assert.equal(mod3._highwayGetTime(), 0);
});

test('ac-1: signed error is t_hit − t_note ms (negative=early, positive=late)', () => {
    const mod = freshPlugin();
    global.window.feedBack = { tapToBeat: mockTap() };
    assert.equal(mod._signedErrorMs(0.98, 1.0), -20);
    assert.equal(mod._signedErrorMs(1.02, 1.0), 20);
    assert.equal(mod._signedErrorMs(1.0, 1.0), 0);
    assert.ok(Number.isNaN(mod._signedErrorMs(NaN, 1.0)));

    const notes = mappedSnare(mod, 1.0);
    const early = mod._judgeDrumHit(38, 980, {
        notes, chords: [], hitKeys: new Set(),
        getTime: () => 1.0, now: 1000, offsetMs: 0, currentTime: 99,
    });
    assert.equal(early.kind, 'hit');
    assert.equal(early.t, 0.98);
    assert.equal(early.noteT, 1.0);
    assert.equal(early.errorMs, -20);

    const late = mod._judgeDrumHit(38, 1020, {
        notes: mappedSnare(mod, 1.0), chords: [], hitKeys: new Set(),
        getTime: () => 1.0, now: 1000, offsetMs: 0, currentTime: 99,
    });
    assert.equal(late.kind, 'hit');
    assert.equal(late.errorMs, 20);

    const model = mod._inPlayHudModel([-20]);
    assert.match(model.signDoc, /t_hit/);
    assert.match(model.signDoc, /early/);
    assert.match(model.signDoc, /late/);
    assert.match(model.signDoc, /judge plane/);
});

test('ac-2: running median of last 16; empty state explicit; first hit = median', () => {
    const mod = freshPlugin();
    assert.equal(mod.IN_PLAY_ERROR_WINDOW, 16);
    const empty = mod._inPlayHudModel([]);
    assert.equal(empty.empty, true);
    assert.equal(empty.latestLabel, 'No hits yet');
    assert.match(empty.medianLabel, /no hits yet/);
    assert.match(empty.medianLabel, /16/);

    const first = mod._inPlayHudModel([-12]);
    assert.equal(first.empty, false);
    assert.equal(first.medianMs, -12);
    assert.equal(first.count, 1);

    const series = [-40, -20, 0, 20, 40];
    assert.equal(mod._medianMs(series), 0);

    const even = [1, 3, 5, 7];
    assert.equal(mod._medianMs(even), 4);

    const ring = [];
    for (let i = 0; i < 20; i++) {
        mod._pushInPlaySample(ring, i, i, 16);
    }
    assert.equal(ring.length, 16);
    assert.equal(ring[0].errorMs, 4);
    assert.equal(ring[15].errorMs, 19);
    const med = mod._medianMs(ring.map((s) => s.errorMs));
    assert.equal(med, (11 + 12) / 2);
});

test('miss is not sampled; clock going backward drops the sample', () => {
    const mod = freshPlugin();
    const samples = [];
    assert.equal(mod._recordInPlayFromJudge(samples, { kind: 'miss', t: 1 }, 16), samples);
    assert.equal(samples.length, 0);
    assert.equal(mod._recordInPlayFromJudge(samples, { kind: 'skip' }, 16), samples);

    mod._pushInPlaySample(samples, -10, 1.0, 16);
    mod._pushInPlaySample(samples, 5, 0.5, 16);
    assert.equal(samples.length, 1);
    assert.equal(samples[0].errorMs, -10);

    mod._recordInPlayFromJudge(samples, { kind: 'hit', errorMs: 8, t: 1.2 }, 16);
    assert.equal(samples.length, 2);
    assert.equal(samples[1].errorMs, 8);
});

test('ac-3: early/late is text + icon shape, not color-only; aria-live polite', () => {
    const mod = freshPlugin();
    const early = mod._inPlayHudModel([-12]);
    assert.equal(early.latestDir, 'early');
    assert.equal(early.latestShape, '▲');
    assert.match(early.latestLabel, /EARLY/);
    assert.match(early.latestLabel, /-12/);
    assert.doesNotMatch(early.latestLabel, /^#[0-9a-f]+$/i);

    const late = mod._inPlayHudModel([8]);
    assert.equal(late.latestDir, 'late');
    assert.equal(late.latestShape, '▼');
    assert.match(late.latestLabel, /LATE/);
    assert.notEqual(early.latestShape, late.latestShape);

    const on = mod._inPlayHudModel([0]);
    assert.equal(on.latestDir, 'on');
    assert.equal(on.latestShape, '●');
    assert.match(on.latestLabel, /ON TIME/);

    const host = el('div');
    mod._fillInPlayHudDom(host, global.document);
    mod._paintInPlayHud(host, early);
    const live = mod._hudChild(host, 'live');
    assert.ok(live);
    assert.equal(live.getAttribute('aria-live'), 'polite');
    assert.equal(live.getAttribute('role'), 'status');
    const icon = mod._hudChild(host, 'icon');
    assert.equal(icon.textContent, '▲');
    assert.equal(icon.getAttribute('data-dir'), 'early');
    const text = mod._hudChild(host, 'latest-text');
    assert.match(text.textContent, /EARLY/);
    const sign = mod._hudChild(host, 'sign');
    assert.match(sign.textContent, /t_hit/);
    const median = mod._hudChild(host, 'median');
    assert.match(median.textContent, /Median last 16/);
});

test('ritual Calibration overlay is not reused as the in-play HUD', () => {
    assert.doesNotMatch(SCREEN_SRC, /drums-timing-overlay/);
    assert.match(SCREEN_SRC, /drums-inplay-hud/);
    assert.match(SCREEN_SRC, /IN_PLAY_SIGN_DOC/);
});
