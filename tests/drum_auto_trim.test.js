'use strict';
// INIT-006/SPEC-007: opt-in damped auto-trim — IQR / median / damping / stable / persist.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const TRIM_JS = path.join(__dirname, '..', 'assets', 'drum-auto-trim.js');
const SCREEN_JS = path.join(__dirname, '..', 'screen.js');
const TRIM_SRC = fs.readFileSync(TRIM_JS, 'utf8');
const SCREEN_SRC = fs.readFileSync(SCREEN_JS, 'utf8');
const PLUGIN_JSON = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'plugin.json'), 'utf8'));

function freshTrim(opts) {
    opts = opts || {};
    const writes = [];
    const devices = {
        'kit-a': {
            id: 'kit-a',
            timing: {
                offset_ms: opts.offset_ms != null ? opts.offset_ms : 0,
                origin: opts.origin || 'localhost',
                audio_backend: opts.audio_backend || 'html5',
                audio_latency_hint_ms: 12,
                profiles: { keep: true },
            },
        },
    };
    global.window = {
        feedBack: {
            midiDevices: {
                getActive() { return devices['kit-a']; },
                writeTiming(payload) {
                    writes.push(payload);
                    devices['kit-a'].timing = Object.assign({}, devices['kit-a'].timing, payload);
                    return Promise.resolve(devices['kit-a']);
                },
            },
        },
        location: { hostname: 'localhost' },
    };
    delete require.cache[require.resolve(TRIM_JS)];
    const mod = require(TRIM_JS);
    mod.resetForTests();
    mod._writes = writes;
    mod._devices = devices;
    return mod;
}

function earlyFixture() {
    // 18 hits near −20 ms plus 2 IQR outliers. After YARG 1.5×IQR fence the
    // median is −20; DAMPING 0.5 → apply −10. Tolerance: ±1 ms (integer round).
    return [
        -20, -21, -19, -20, -22, -18, -20, -21, -19, -20,
        -20, -19, -21, -20, -18, -22, -20, -19, -80, 40,
    ];
}

test('constants match YARG AutoCalibrator', () => {
    const mod = freshTrim();
    assert.equal(mod.SAMPLE_SIZE, 20);
    assert.equal(mod.DAMPING, 0.5);
    assert.equal(mod.STABLE_THRESHOLD_MS, 5.0);
    assert.equal(mod.IQR_FENCE, 1.5);
    assert.doesNotMatch(TRIM_SRC, /av_offset_ms\s*=/);
});

test('ac-1: auto-trim off → no persist writes', () => {
    const mod = freshTrim();
    assert.equal(mod.isEnabled(), false);
    for (let i = 0; i < 25; i++) {
        const r = mod.recordHit(-20);
        assert.equal(r.persisted, false);
        assert.equal(r.reason, 'disabled');
    }
    assert.equal(mod._writes.length, 0);
    assert.equal(mod._lastWrite(), null);
    assert.equal(mod.sampleCount(), 0);
});

test('ac-2: 20 early hits with 2 outliers apply about −10 ms to active offset', () => {
    const mod = freshTrim({ offset_ms: 0 });
    mod.setEnabled(true);
    const fixture = earlyFixture();
    assert.equal(fixture.length, 20);

    let last = null;
    for (let i = 0; i < 19; i++) {
        last = mod.recordHit(fixture[i]);
        assert.equal(last.applied, false);
        assert.equal(mod._writes.length, 0);
    }
    last = mod.recordHit(fixture[19]);
    assert.equal(last.applied, true);
    assert.equal(last.persisted, true);
    assert.equal(last.median, -20);
    assert.equal(last.deltaMs, -10);
    assert.ok(Math.abs(last.deltaMs - (-10)) <= 1, 'damped median within ±1 ms of −10');
    assert.equal(mod._writes.length, 1);
    const body = mod._writes[0];
    assert.equal(body.offset_ms, -10);
    assert.equal(body.origin, 'localhost');
    assert.equal(body.audio_backend, 'html5');
    assert.equal(Object.prototype.hasOwnProperty.call(body, 'av_offset_ms'), false);
    // Partial PUT must still carry offset_ms (SPEC-006 sanitizer). Do not drop it.
    assert.equal(typeof body.offset_ms, 'number');
});

test('IQR fence drops the two outliers; median of remainder is −20', () => {
    const mod = freshTrim();
    const filtered = mod.removeOutliers(earlyFixture());
    assert.ok(!filtered.includes(-80));
    assert.ok(!filtered.includes(40));
    assert.equal(mod.calculateMedian(filtered), -20);
    const decision = mod.considerBatch(earlyFixture());
    assert.equal(decision.apply, true);
    assert.equal(decision.deltaMs, -10);
});

test('fewer than 20 samples: no apply, no persist', () => {
    const mod = freshTrim();
    mod.setEnabled(true);
    for (let i = 0; i < 19; i++) mod.recordHit(-20);
    assert.equal(mod.sampleCount(), 19);
    assert.equal(mod._writes.length, 0);
    const short = mod.considerBatch([-20, -20, -20]);
    assert.equal(short.apply, false);
    assert.equal(short.reason, 'short');
});

test('misses / non-finite are not sampled', () => {
    const mod = freshTrim();
    mod.setEnabled(true);
    assert.equal(mod.recordHit(NaN).reason, 'non-finite');
    assert.equal(mod.recordHit(Infinity).reason, 'non-finite');
    assert.equal(mod.sampleCount(), 0);
    assert.equal(mod._writes.length, 0);
});

test('buffer cap at SAMPLE_SIZE (DoS/memory)', () => {
    const mod = freshTrim();
    const buf = [];
    for (let i = 0; i < 40; i++) mod.pushSample(buf, i);
    assert.equal(buf.length, 20);
    assert.equal(buf[0], 20);
    assert.equal(buf[19], 39);
});

test('ac-4: |batch median| ≤ 5 ms is stable and does not persist', () => {
    const mod = freshTrim();
    mod.setEnabled(true);
    const stableBatch = [];
    for (let i = 0; i < 20; i++) stableBatch.push(i % 2 === 0 ? -3 : 2);
    const decision = mod.considerBatch(stableBatch);
    assert.equal(decision.stable, true);
    assert.equal(decision.apply, false);
    assert.ok(Math.abs(decision.median) <= mod.STABLE_THRESHOLD_MS);

    for (let i = 0; i < 20; i++) mod.recordHit(stableBatch[i]);
    assert.equal(mod.isStable(), true);
    assert.equal(mod._writes.length, 0);
    const ui = mod.uiModel();
    assert.equal(ui.stable, true);
    assert.match(ui.statusLabel, /Stable/i);
});

test('ac-3: enabled marks practice; disable restores scoring; run stays flagged', () => {
    const mod = freshTrim();
    assert.equal(mod.isScoring(), true);
    assert.equal(mod.isRunInvalidated(), false);

    mod.setEnabled(true);
    assert.equal(mod.isEnabled(), true);
    assert.equal(mod.isScoring(), false);
    assert.equal(mod.isRunInvalidated(), true);

    mod.setEnabled(false);
    assert.equal(mod.isEnabled(), false);
    assert.equal(mod.isScoring(), true);
    assert.equal(mod.isRunInvalidated(), true);
    const ui = mod.uiModel();
    assert.match(ui.statusLabel, /practice|not ranked/i);

    mod.onNewRun();
    assert.equal(mod.isRunInvalidated(), false);
    assert.equal(mod.isScoring(), true);
});

test('new run with auto-trim still on stays non-scoring', () => {
    const mod = freshTrim();
    mod.setEnabled(true);
    mod.onNewRun();
    assert.equal(mod.isRunInvalidated(), true);
    assert.equal(mod.isScoring(), false);
});

test('sign flip across batches applies the new damped median', () => {
    const mod = freshTrim({ offset_ms: 0 });
    mod.setEnabled(true);
    for (let i = 0; i < 20; i++) mod.recordHit(-20);
    assert.equal(mod._writes[0].offset_ms, -10);
    for (let i = 0; i < 20; i++) mod.recordHit(16);
    assert.equal(mod._writes.length, 2);
    assert.equal(mod._writes[1].offset_ms, -10 + 8);
});

test('empty-filter and missing accessor do not throw; no av_offset_ms', () => {
    const mod = freshTrim();
    const empty = mod.considerBatch([]);
    assert.equal(empty.apply, false);
    global.window.feedBack.midiDevices = {};
    mod.setEnabled(true);
    for (let i = 0; i < 20; i++) mod.recordHit(-20);
    assert.equal(mod._lastWrite(), null);
    assert.doesNotMatch(TRIM_SRC, /av_offset_ms\s*=/);
});

test('HUD display-only invariant holds; persist is in drum-auto-trim.js', () => {
    const start = SCREEN_SRC.indexOf('const IN_PLAY_ERROR_WINDOW');
    const end = SCREEN_SRC.indexOf('function _syncAllInPlayHuds');
    assert.ok(start > 0 && end > start);
    const block = SCREEN_SRC.slice(start, end);
    assert.doesNotMatch(block, /writeTiming/);
    assert.doesNotMatch(block, /timing\.offset_ms/);
    const checkHit = SCREEN_SRC.match(/function _checkHit\([\s\S]*?\n    function _updateMissedNotes/);
    assert.ok(checkHit);
    assert.doesNotMatch(checkHit[0], /writeTiming/);
    assert.match(checkHit[0], /_autoTrimPractice/);
    assert.match(checkHit[0], /_autoTrimRecordHit/);
    assert.match(TRIM_SRC, /writeTiming/);
    assert.match(SCREEN_SRC, /drum-auto-trim\.js/);
});

test('screen.js opt-in defaults off; plugin.json styles unchanged', () => {
    assert.match(SCREEN_SRC, /autoTrim:\s+_readStore\(STORE_KEYS\.autoTrim\) === 'true'/);
    assert.equal(PLUGIN_JSON.id, 'drums');
    assert.equal(PLUGIN_JSON.styles, 'assets/drums-editor.css');
});

test('append auto-trim controls are keyboard-labelled and aria-live', () => {
    delete require.cache[require.resolve(SCREEN_JS)];
    delete require.cache[require.resolve(TRIM_JS)];
    global.window = {};
    global.localStorage = { getItem: () => null, setItem: () => {} };
    global.document = {
        addEventListener: () => {},
        querySelectorAll: () => [],
        createElement: (tag) => {
            const node = {
                tagName: String(tag).toUpperCase(),
                className: '',
                hidden: false,
                checked: false,
                type: '',
                style: {},
                dataset: {},
                children: [],
                attributes: {},
                textContent: '',
                setAttribute(k, v) { this.attributes[k] = String(v); },
                getAttribute(k) {
                    return Object.prototype.hasOwnProperty.call(this.attributes, k) ? this.attributes[k] : null;
                },
                removeAttribute(k) { delete this.attributes[k]; },
                appendChild(child) { this.children.push(child); return child; },
                addEventListener() {},
            };
            return node;
        },
    };
    const screen = require(SCREEN_JS);
    const host = global.document.createElement('div');
    screen._fillInPlayHudDom(host, global.document);
    screen._appendAutoTrimControls(host, global.document);
    const box = screen._hudChild(host, 'autotrim-check');
    assert.ok(box);
    assert.equal(box.checked, false);
    assert.match(box.getAttribute('aria-label') || '', /practice/i);
    const status = screen._hudChild(host, 'autotrim-status');
    assert.equal(status.getAttribute('aria-live'), 'polite');
    screen._setAutoTrimEnabled(true);
    screen._paintAutoTrim(host);
    assert.equal(box.checked, true);
    const practice = screen._hudChild(host, 'autotrim-practice');
    assert.equal(practice.hidden, false);
    screen._setAutoTrimEnabled(false);
    screen._paintAutoTrim(host);
    assert.equal(box.checked, false);
    assert.equal(practice.hidden, false);
});
