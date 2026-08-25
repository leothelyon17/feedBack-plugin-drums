'use strict';
// INIT-004/SPEC-002: Calibration module — persist, gate, remasure, mounts.
const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const TIMING_JS = path.join(__dirname, '..', 'assets', 'drum-timing.js');
const SCREEN_JS = path.join(__dirname, '..', 'screen.js');
const TIMING_SRC = fs.readFileSync(TIMING_JS, 'utf8');
const SCREEN_SRC = fs.readFileSync(SCREEN_JS, 'utf8');

function el(tag) {
    const node = {
        tagName: String(tag).toUpperCase(),
        className: '',
        id: '',
        style: { cssText: '', left: '' },
        dataset: {},
        children: [],
        attributes: {},
        parentNode: null,
        hidden: false,
        disabled: false,
        value: '',
        tabIndex: 0,
        _listeners: {},
        setAttribute(k, v) {
            this.attributes[k] = String(v);
            if (k === 'class') this.className = v;
            if (k === 'id') this.id = String(v);
            if (k === 'data-dt') this.dataset.dt = String(v);
        },
        getAttribute(k) {
            if (k === 'id') return this.id || null;
            if (k === 'class') return this.className || null;
            return Object.prototype.hasOwnProperty.call(this.attributes, k) ? this.attributes[k] : null;
        },
        removeAttribute(k) { delete this.attributes[k]; },
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
        addEventListener(type, fn) {
            (this._listeners[type] = this._listeners[type] || []).push(fn);
        },
        removeEventListener(type, fn) {
            this._listeners[type] = (this._listeners[type] || []).filter((f) => f !== fn);
        },
        click() {
            const ev = { target: this, preventDefault() {} };
            (this._listeners.click || []).forEach((fn) => fn(ev));
            if (typeof this.onclick === 'function') this.onclick(ev);
        },
        focus() {},
        querySelector(sel) { return queryAll(this, sel)[0] || null; },
        querySelectorAll(sel) { return queryAll(this, sel); },
    };
    let _text = '';
    Object.defineProperty(node, 'textContent', {
        get() { return _text; },
        set(v) {
            _text = String(v);
            if (v === '') node.children = [];
        },
        configurable: true,
        enumerable: true,
    });
    return node;
}

function queryAll(root, sel) {
    const out = [];
    function match(n) {
        if (!n) return false;
        if (sel.startsWith('[data-dt="') && sel.endsWith('"]')) {
            return n.getAttribute('data-dt') === sel.slice(10, -2);
        }
        if (sel.startsWith('#')) return n.id === sel.slice(1);
        if (sel.startsWith('.')) {
            return (' ' + (n.className || '') + ' ').indexOf(' ' + sel.slice(1) + ' ') !== -1;
        }
        return false;
    }
    function walk(n) {
        if (match(n)) out.push(n);
        (n.children || []).forEach(walk);
    }
    walk(root);
    return out;
}

function makeDocument() {
    const body = el('body');
    const nodesById = new Map();
    const doc = {
        body,
        documentElement: body,
        createElement(tag) { return el(tag); },
        addEventListener() {},
        removeEventListener() {},
        dispatchEvent() { return true; },
        getElementById(id) { return nodesById.get(id) || null; },
        querySelector(sel) { return queryAll(body, sel)[0] || null; },
        querySelectorAll(sel) { return queryAll(body, sel); },
        _register(node) {
            if (node && node.id) nodesById.set(node.id, node);
        },
    };
    return doc;
}

function hook(root, name) {
    return queryAll(root, '[data-dt="' + name + '"]')[0] || null;
}

function mockTap(reduceFn) {
    return {
        version: 1,
        N_MIN: 16,
        N_VERIFY: 8,
        OFFSET_MAX_MS: 250,
        convert() { return { tChart: 1, lowConfidence: false }; },
        nearestBeat() { return { residualMs: 4, beatT: 1, beatIndex: 1 }; },
        session: {
            create() { return { taps: [] }; },
            add(session, tap) {
                session.taps.push({ residualMs: Number(tap.residualMs) || 0 });
                return session;
            },
            record(session) {
                session.taps.push({ residualMs: 4, tChart: 1, beatT: 1 });
                return session;
            },
            reduce: reduceFn || function (session) {
                if (!session.taps || session.taps.length < 24) {
                    return { ok: false, code: 'fail_n', n: session.taps ? session.taps.length : 0 };
                }
                return { ok: true, offsetMs: 12, n: session.taps.length, mad: 2, heldOutMedianAbs: 3 };
            },
        },
    };
}

function fresh(opts) {
    opts = opts || {};
    const writes = [];
    const devices = Object.assign({
        'kit-a': {
            id: 'kit-a',
            name: 'Kit A',
            notes: { 38: 'snare' },
            timing: opts.timingA,
        },
        'kit-b': {
            id: 'kit-b',
            name: 'Kit B',
            notes: {},
            timing: opts.timingB,
        },
        'kit-c': {
            id: 'kit-c',
            name: 'Kit C',
            notes: { 36: 'kick' },
        },
    }, opts.devices || {});
    let activeId = opts.activeId || 'kit-a';
    const doc = makeDocument();
    const loc = opts.location || { hostname: 'localhost' };
    global.window = {
        feedBack: {},
        location: loc,
        _juceMode: opts.juce === true,
        playSong: opts.playSong || function () { global.window._played = (global.window._played || []).concat([arguments[0]]); },
    };
    global.window.window = global.window;
    global.location = loc;
    global.document = doc;
    global.fetch = opts.fetch || (async () => ({
        ok: true,
        json: async () => ({ songs: opts.library || [] }),
    }));
    global.AudioContext = undefined;
    global.webkitAudioContext = undefined;

    window.feedBack.tapToBeat = opts.tap || mockTap();
    window.feedBack.midiDevices = {
        getActive() { return devices[activeId] || { id: activeId }; },
        hasActive() { return !!activeId; },
        subscribe() {},
        writeTiming(payload) {
            writes.push(payload);
            const cur = devices[activeId] || { id: activeId };
            cur.timing = Object.assign({}, payload);
            devices[activeId] = cur;
            return Promise.resolve(cur);
        },
        _activate(id) { activeId = id; },
        _devices: devices,
    };
    window.feedBack.midiInput = {
        watchMessages(fn) {
            window.feedBack._midiWatch = fn;
            return function () { window.feedBack._midiWatch = null; };
        },
        discover() { window.feedBack._discovered = true; },
    };
    window.feedBack.on = function () {};
    window.feedBack.emit = function () {};

    const file = TIMING_JS;
    delete require.cache[require.resolve(file)];
    const mod = require(file);
    mod.resetForTests();
    mod._writes = writes;
    mod._doc = doc;
    mod._devices = devices;
    return mod;
}

afterEach(() => {
    try {
        const file = TIMING_JS;
        const cached = require.cache[require.resolve(file)];
        if (cached && cached.exports && typeof cached.exports.resetForTests === 'function') {
            cached.exports.resetForTests();
        }
    } catch (_) { /* ignore */ }
});

function panel(mod) {
    const host = el('div');
    host.id = 'midi-calibration-panel';
    mod._doc._register(host);
    mod._doc.body.appendChild(host);
    return host;
}

test('ac-1: mount fills #midi-calibration-panel; run overlay uses the same render entry', () => {
    const mod = fresh();
    const host = panel(mod);
    const mounted = mod.mount(host);
    assert.equal(mounted.ok, true);
    assert.equal(hook(host, 'root').getAttribute('data-dt'), 'root');
    assert.equal(hook(host, 'title').textContent, 'Measure pad timing');
    assert.equal(hook(host, 'start').textContent, 'Start');

    const overlay = mod.run({ requester: 'onboarding', mode: 'overlay' });
    assert.equal(overlay.ok, true);
    assert.equal(overlay.requester, 'onboarding');
    const overlayRoot = hook(mod._doc.body, 'overlay');
    assert.ok(overlayRoot);
    assert.equal(overlayRoot.getAttribute('role'), 'dialog');
    const titles = queryAll(mod._doc.body, '[data-dt="title"]');
    assert.ok(titles.length >= 2);
    assert.ok(titles.every((t) => t.textContent === 'Measure pad timing'));
    assert.equal(window.feedBack.drumTiming.mount, mod.mount);
    assert.equal(window.feedBack.drumTiming.run, mod.run);
});

test('ac-2: beat marker encodes early/late by position, shape, and aria-live text', () => {
    const early = modBeat();
    assert.equal(early.dir, 'early');
    assert.ok(early.pct < 50);
    assert.equal(early.shape, '◀');
    assert.match(early.text, /ms early/);

    const late = modFreshBeat(40);
    assert.equal(late.dir, 'late');
    assert.ok(late.pct > 50);
    assert.equal(late.shape, '▶');
    assert.match(late.text, /ms late/);

    const on = modFreshBeat(0);
    assert.equal(on.dir, 'on');
    assert.equal(on.shape, '◆');
    assert.equal(on.text, 'On beat');

    const mod = fresh();
    const host = panel(mod);
    mod.mount(host);
    mod.startMeasure();
    mod.handleNoteOn(38, 10);
    const live = hook(host, 'beat-live');
    assert.equal(live.getAttribute('aria-live'), 'polite');
    assert.ok(live.textContent);
    const marker = hook(host, 'beat-marker');
    assert.ok(marker.getAttribute('data-dir'));
    assert.match(marker.className, /drums-timing-marker--/);
});

function modBeat() {
    delete require.cache[require.resolve(TIMING_JS)];
    global.window = { feedBack: {} };
    global.document = makeDocument();
    const m = require(TIMING_JS);
    return m.beatMarkerModel(-24);
}

function modFreshBeat(ms) {
    delete require.cache[require.resolve(TIMING_JS)];
    global.window = { feedBack: {} };
    global.document = makeDocument();
    const m = require(TIMING_JS);
    return m.beatMarkerModel(ms);
}

test('ac-3: persist goes through writeTiming; no _saveCfg timing key', async () => {
    const mod = fresh();
    const summary = { accepted: true, ok: true, offsetMs: 18, n: 24, heldOutMedianAbs: 4, mad: 2 };
    const res = await mod.persistIfAccepted(summary);
    assert.equal(res.ok, true);
    assert.equal(mod._writes.length, 1);
    assert.equal(mod._writes[0].offset_ms, 18);
    assert.equal(mod._writes[0].origin, 'localhost');
    assert.equal(mod._writes[0].audio_backend, 'html5');
    assert.equal(mod._writes[0].n, 24);
    assert.ok(mod._writes[0].measured_at);
    assert.doesNotMatch(TIMING_SRC, /_saveCfg\s*\(/);
    assert.doesNotMatch(TIMING_SRC, /drums_timing_offset_ms/);
    assert.doesNotMatch(TIMING_SRC, /localStorage\.setItem/);
});

test('ac-4: auto-save only when accepted; fail_* is rejected; last-good survives', async () => {
    const mod = fresh({
        timingA: { offset_ms: 18, origin: 'localhost', audio_backend: 'html5' },
    });
    const fail = await mod.persistIfAccepted({ accepted: false, ok: false, code: 'fail_verify', offsetMs: 99, n: 24 });
    assert.equal(fail.ok, false);
    assert.equal(fail.code, 'fail_verify');
    assert.equal(mod._writes.length, 0);
    assert.equal(mod.getOffsetMs(), 18);

    const mad = await mod.persistIfAccepted({ accepted: false, ok: false, code: 'fail_mad', offsetMs: 40, n: 24 });
    assert.equal(mad.ok, false);
    assert.equal(mod.getOffsetMs(), 18);

    const ok = await mod.persistIfAccepted({ accepted: true, ok: true, offsetMs: 12, n: 24, heldOutMedianAbs: 3 });
    assert.equal(ok.ok, true);
    assert.equal(mod._writes.length, 1);
    assert.equal(mod.getOffsetMs(), 12);
});

test('ac-4/ac-5: a failed gate paints Hits were too scattered and Retry; Save anyway is secondary', async () => {
    const mod = fresh({
        tap: mockTap(() => ({ ok: false, code: 'fail_verify', offsetMs: 14, n: 24, mad: 3 })),
        timingA: { offset_ms: 18, origin: 'localhost', audio_backend: 'html5' },
    });
    const host = panel(mod);
    mod.mount(host);
    mod.startMeasure();
    for (let i = 0; i < 24; i += 1) mod.handleNoteOn(38, 10);
    await new Promise((r) => setImmediate(r));
    assert.equal(hook(host, 'gate-msg').textContent, 'Hits were too scattered');
    assert.equal(hook(host, 'gate').hidden, false);
    assert.equal(hook(host, 'retry').textContent, 'Retry');
    assert.equal(hook(host, 'retry').hidden, false);
    assert.equal(hook(host, 'save-anyway').textContent, 'Save anyway');
    assert.equal(hook(host, 'save-anyway').hidden, false);
    assert.equal(mod._writes.length, 0);
    assert.equal(mod.getOffsetMs(), 18);

    await mod.saveAnyway();
    assert.equal(mod._writes.length, 1);
    assert.equal(mod._writes[0].offset_ms, 14);
});

test('ac-5: empty state is Not set, never +0 ms', () => {
    const mod = fresh({ activeId: 'kit-c' });
    const host = panel(mod);
    mod.mount(host);
    assert.equal(hook(host, 'offset').textContent, 'Not set');
    assert.notEqual(hook(host, 'offset').textContent, '+0 ms');
    assert.equal(mod.formatOffsetLabel(null), 'Not set');
    assert.equal(mod.getOffsetMs(), 0);
});

test('ac-6: remasure on origin/backend mismatch; never-set device is not forced', () => {
    const tagged = { offset_ms: 20, origin: 'localhost', audio_backend: 'html5' };
    const mod = fresh({ timingA: tagged, activeId: 'kit-a' });
    assert.equal(mod.shouldPromptRemeasure(mod._devices['kit-a']), false);

    window._juceMode = true;
    assert.equal(mod.currentAudioBackend(), 'juce');
    assert.equal(mod.shouldPromptRemeasure(mod._devices['kit-a']), true);
    assert.equal(mod.getOffsetMs(), 0);

    window._juceMode = false;
    window.feedBack.midiDevices._activate('kit-c');
    assert.equal(mod.shouldPromptRemeasure(mod._devices['kit-c']), false);
    assert.equal(mod.getOffsetMs(), 0);

    mod._devices['kit-b'].timing = { offset_ms: 9, origin: 'nas.local', audio_backend: 'html5' };
    window.feedBack.midiDevices._activate('kit-b');
    assert.equal(mod.shouldPromptRemeasure(mod._devices['kit-b']), true);
    assert.equal(mod.getOffsetMs(), 0);
});

test('ac-6: save tagged then origin flip prompts remasure and does not apply stale', async () => {
    const mod = fresh();
    await mod.persistIfAccepted({ accepted: true, ok: true, offsetMs: 22, n: 24, heldOutMedianAbs: 2 });
    assert.equal(mod.getOffsetMs(), 22);
    global.window.location = { hostname: 'nas.example' };
    global.location = global.window.location;
    assert.equal(mod.shouldPromptRemeasure(window.feedBack.midiDevices.getActive()), true);
    assert.equal(mod.getOffsetMs(), 0);
});

test('ac-7: getOffsetMs returns clamped number or 0; never writes av_offset_ms', () => {
    const mod = fresh({
        timingA: { offset_ms: 1e9, origin: 'localhost', audio_backend: 'html5' },
    });
    assert.equal(mod.getOffsetMs(), 250);
    assert.equal(mod.clampOffset(Number.NaN), 0);
    assert.equal(mod.clampOffset(-900), -250);
    assert.doesNotMatch(TIMING_SRC, /av_offset_ms\s*=/);
    assert.doesNotMatch(TIMING_SRC, /setAvOffset\s*\(/);
    assert.equal(window.feedBack.drumTiming.getOffsetMs(), 250);
});

test('ac-7: __proto__ and non-finite offsets are rejected on load', () => {
    const poisoned = JSON.parse('{"offset_ms": 12, "__proto__": {"x": 1}}');
    const mod = fresh({ timingA: poisoned });
    // JSON.parse of __proto__ may become a real own key or pollute; either way readTiming must refuse.
    const protoOwn = { offset_ms: 12 };
    Object.defineProperty(protoOwn, '__proto__', { value: { hacked: true }, enumerable: true, configurable: true });
    assert.equal(mod.readTiming({ timing: protoOwn }), null);
    assert.equal(mod.readTiming({ timing: { offset_ms: Number.NaN } }), null);
    assert.equal(mod.readTiming({ timing: { offset_ms: Infinity } }), null);
    assert.equal(mod.getOffsetMs(), 0);
});

test('ac-8: one offset per MIDI device; no per-lane UI; no drum profile write', () => {
    assert.doesNotMatch(TIMING_SRC, /per-lane|perLane|laneOffset/);
    assert.doesNotMatch(TIMING_SRC, /drumProfiles|writeProfile|_saveCfg\s*\(/);
    const mod = fresh({
        timingA: { offset_ms: 11, origin: 'localhost', audio_backend: 'html5' },
        timingB: { offset_ms: -7, origin: 'localhost', audio_backend: 'html5' },
    });
    assert.equal(mod.getOffsetMs(), 11);
    window.feedBack.midiDevices._activate('kit-b');
    assert.equal(mod.getOffsetMs(), -7);
});

test('ac-9: suggested-chart button hides when pack is missing; playing it does not write', async () => {
    const mod = fresh({ library: [] });
    const host = panel(mod);
    mod.mount(host);
    await new Promise((r) => setImmediate(r));
    await mod.probeSuggestedChart();
    const btn = hook(host, 'suggested');
    assert.equal(btn.hidden, true);

    const present = fresh({
        library: [{ filename: 'starter/feedBack-diagnostic-basic-drums.feedpak' }],
    });
    present._suggestedAvailable = null;
    const host2 = panel(present);
    present.mount(host2);
    await present.probeSuggestedChart();
    const btn2 = hook(host2, 'suggested');
    assert.equal(btn2.hidden, false);
    const writesBefore = present._writes.length;
    present.openSuggestedChart();
    assert.deepEqual(window._played, ['starter/feedBack-diagnostic-basic-drums.feedpak']);
    assert.equal(present._writes.length, writesBefore);
});

test('ac-10: mapped notes only; empty notes map accepts any note-on', () => {
    const mod = fresh();
    const mapped = { id: 'kit-a', notes: { 38: 'snare', 36: 'kick' } };
    assert.equal(mod.noteAllowed(38, mapped), true);
    assert.equal(mod.noteAllowed(40, mapped), false);
    const empty = { id: 'kit-b', notes: {} };
    assert.equal(mod.noteAllowed(91, empty), true);
    assert.equal(mod.noteAllowed(0, { notes: null }), true);
});

test('ac-11: overlay Skip/Continue do not require a passed save', () => {
    const mod = fresh();
    const overlay = mod.run({ requester: 'onboarding', mode: 'overlay' });
    assert.equal(overlay.ok, true);
    const skip = hook(mod._doc.body, 'skip');
    const cont = hook(mod._doc.body, 'continue');
    assert.equal(skip.hidden, false);
    assert.equal(cont.hidden, false);
    skip.click();
    assert.equal(mod._writes.length, 0);
    assert.equal(queryAll(mod._doc.body, '[data-dt="overlay"]').length, 0);

    mod.run({ requester: 'onboarding', mode: 'overlay' });
    hook(mod._doc.body, 'continue').click();
    assert.equal(mod._writes.length, 0);
});

test('auto-save path writes only after an accepted session', async () => {
    const mod = fresh();
    const host = panel(mod);
    mod.mount(host);
    mod.startMeasure();
    for (let i = 0; i < 23; i += 1) mod.handleNoteOn(38, 10);
    await new Promise((r) => setImmediate(r));
    assert.equal(mod._writes.length, 0);
    mod.handleNoteOn(38, 10);
    await new Promise((r) => setImmediate(r));
    assert.equal(mod._writes.length, 1);
    assert.equal(mod._writes[0].offset_ms, 12);
    assert.equal(mod._writes[0].audio_backend, 'html5');
});

test('unmapped pad is ignored when notes is populated', () => {
    const mod = fresh();
    mod.startMeasure();
    const skipped = mod.handleNoteOn(99, 10);
    assert.equal(skipped.ok, false);
    assert.equal(skipped.reason, 'unmapped');
});

test('contract: window.feedBack.drumTiming.getOffsetMs is a number', () => {
    const mod = fresh({ activeId: 'kit-c' });
    const n = window.feedBack.drumTiming.getOffsetMs();
    assert.equal(typeof n, 'number');
    assert.equal(n, 0);
    assert.equal(mod.getOffsetMs(), n);
});

test('missing tapToBeat / midiDevices degrades: getter 0, persist no-ops', async () => {
    delete require.cache[require.resolve(TIMING_JS)];
    global.window = { feedBack: {} };
    global.document = makeDocument();
    const mod = require(TIMING_JS);
    mod.resetForTests();
    assert.equal(mod.getOffsetMs(), 0);
    const res = await mod.persistIfAccepted({ accepted: true, ok: true, offsetMs: 10, n: 24 });
    assert.equal(res.ok, false);
});

test('juce backend is tagged on save', async () => {
    const mod = fresh({ juce: true });
    await mod.persistIfAccepted({ accepted: true, ok: true, offsetMs: 5, n: 24, heldOutMedianAbs: 1 });
    assert.equal(mod._writes[0].audio_backend, 'juce');
});

test('source: no innerHTML of interpolated names; no av_offset leak in screen boot', () => {
    assert.doesNotMatch(TIMING_SRC, /innerHTML\s*\+/);
    assert.doesNotMatch(TIMING_SRC, /innerHTML\s*=/);
    assert.doesNotMatch(SCREEN_SRC, /drums_timing_offset_ms/);
    assert.doesNotMatch(SCREEN_SRC, /av_offset_ms/);
    assert.match(SCREEN_SRC, /midi-calibration-panel/);
    assert.match(SCREEN_SRC, /drum-timing\.js/);
});
