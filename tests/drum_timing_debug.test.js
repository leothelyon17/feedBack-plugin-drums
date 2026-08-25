'use strict';
// INIT-006: Opt-in local timing debug module.
const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const DEBUG_JS = path.join(__dirname, '..', 'assets', 'drum-timing-debug.js');

function freshDebug() {
    global.window = {
        feedBack: {
            diagnostics: {
                contributions: [],
                contribute(id, payload) {
                    this.contributions.push({ id, payload });
                },
            },
        },
    };
    delete require.cache[require.resolve(DEBUG_JS)];
    const mod = require(DEBUG_JS);
    mod.resetForTests();
    return mod;
}

afterEach(() => {
    try {
        const cached = require.cache[require.resolve(DEBUG_JS)];
        if (cached && cached.exports && typeof cached.exports.resetForTests === 'function') {
            cached.exports.resetForTests();
        }
    } catch (_) { /* ignore */ }
});

test('default off: recordCalibration does not grow calibration[]', () => {
    const dbg = freshDebug();
    assert.equal(dbg.isEnabled(), false);
    dbg.recordCalibration({ accepted: true, code: 'ok', offsetMs: 10, n: 24 }, { taps: [] }, {
        origin: 'localhost',
        audio_backend: 'html5',
        source: 'auto',
    });
    assert.equal(dbg.snapshot().calibration.length, 0);
});

test('enable then record pass + fail_verify preserves codes', () => {
    const dbg = freshDebug();
    dbg.setEnabled(true);
    dbg.recordCalibration({ accepted: true, code: 'ok', offsetMs: 12, n: 24, mad: 2 }, { taps: [{ residualMs: 3 }] }, {
        origin: 'localhost',
        audio_backend: 'html5',
        clock_source: 'audioctx',
        source: 'auto',
    });
    dbg.recordCalibration({ accepted: false, code: 'fail_verify', offsetMs: 14, n: 24, mad: 5 }, { taps: [{ residualMs: -2 }] }, {
        origin: 'localhost',
        audio_backend: 'html5',
        source: 'auto',
    });
    const snap = dbg.snapshot();
    assert.equal(snap.calibration.length, 2);
    assert.equal(snap.calibration[0].accepted, true);
    assert.equal(snap.calibration[0].code, 'ok');
    assert.equal(snap.calibration[1].code, 'fail_verify');
    assert.equal(snap.calibration[1].accepted, false);
});

test('11 calibration attempts evicts oldest (cap 10)', () => {
    const dbg = freshDebug();
    dbg.setEnabled(true);
    for (let i = 0; i < 11; i += 1) {
        dbg.recordCalibration({ accepted: false, code: 'fail_n', offsetMs: i, n: i }, { taps: [] }, { source: 'auto' });
    }
    assert.equal(dbg.snapshot().calibration.length, 10);
    assert.equal(dbg.snapshot().calibration[0].offsetMs, 1);
    assert.equal(dbg.snapshot().calibration[9].offsetMs, 10);
});

test('201 judges evicts oldest (cap 200)', () => {
    const dbg = freshDebug();
    dbg.setEnabled(true);
    for (let i = 0; i < 201; i += 1) {
        dbg.recordJudge({ kind: 'hit', t: 1, noteT: 1, errorMs: i }, { offsetMs: 0, hitDetection: true, playedLane: 2 });
    }
    assert.equal(dbg.snapshot().in_play.length, 200);
    assert.equal(dbg.snapshot().in_play[0].errorMs, 1);
    assert.equal(dbg.snapshot().in_play[199].errorMs, 200);
});

test('snapshot JSON omits sensitive strings passed in meta', () => {
    const dbg = freshDebug();
    dbg.setEnabled(true);
    dbg.recordCalibration({ accepted: true, offsetMs: 5, n: 24 }, { taps: [] }, {
        origin: 'localhost',
        audio_backend: 'html5',
        deviceName: 'Yamaha DTX',
        chart: 'song.feedpak',
        note: 'Web MIDI API',
        source_id: 'abc',
        source: 'manual',
    });
    const json = JSON.stringify(dbg.snapshot());
    assert.doesNotMatch(json, /Yamaha|Web MIDI|\.feedpak|\.sloppak/i);
});

test('toggle off yields enabled false and empty arrays', () => {
    const dbg = freshDebug();
    dbg.setEnabled(true);
    dbg.recordCalibration({ accepted: true, offsetMs: 1, n: 24 }, { taps: [] }, { source: 'auto' });
    dbg.recordJudge({ kind: 'hit', t: 1, noteT: 1, errorMs: 2 }, { offsetMs: 0, hitDetection: true });
    dbg.setEnabled(false);
    const snap = dbg.snapshot();
    assert.equal(snap.enabled, false);
    assert.equal(snap.calibration.length, 0);
    assert.equal(snap.in_play.length, 0);
    const last = window.feedBack.diagnostics.contributions.slice(-1)[0];
    assert.equal(last.payload.enabled, false);
    assert.equal(last.payload.schema, 'drums.timing_debug.v1');
});

test('judge shapes: hit includes errorMs+noteT; skip has skip_reason; miss omits noteT', () => {
    const dbg = freshDebug();
    dbg.setEnabled(true);
    dbg.recordJudge({ kind: 'hit', t: 1.02, noteT: 1, errorMs: 20, playedLane: 3 }, { offsetMs: 40, hitDetection: true, playedLane: 3 });
    dbg.recordJudge({ kind: 'skip', reason: 'unmapped' }, { offsetMs: 0, hitDetection: true });
    dbg.recordJudge({ kind: 'miss', t: 2.5, playedLane: 1 }, { offsetMs: 0, hitDetection: true, playedLane: 1 });
    const events = dbg.snapshot().in_play;
    assert.equal(events[0].result, 'hit');
    assert.equal(events[0].errorMs, 20);
    assert.equal(events[0].noteT, 1);
    assert.equal(events[1].result, 'skip');
    assert.equal(events[1].skip_reason, 'unmapped');
    assert.equal(events[1].noteT, undefined);
    assert.equal(events[2].result, 'miss');
    assert.equal(events[2].noteT, undefined);
    assert.equal(events[2].errorMs, undefined);
    assert.equal(events[2].playedLane, 1);
});

test('recordJudge with hitDetection false ignores hits but logs skip', () => {
    const dbg = freshDebug();
    dbg.setEnabled(true);
    dbg.recordJudge({ kind: 'hit', t: 1, noteT: 1, errorMs: 1 }, { hitDetection: false });
    assert.equal(dbg.snapshot().in_play.length, 0);
    dbg.recordJudge({ kind: 'skip', reason: 'hit-detection-off' }, { hitDetection: false });
    assert.equal(dbg.snapshot().in_play.length, 1);
    assert.equal(dbg.snapshot().in_play[0].skip_reason, 'hit-detection-off');
    assert.equal(dbg.snapshot().in_play[0].hitDetection, false);
});

test('residuals sample caps at 24 rounded ms values', () => {
    const dbg = freshDebug();
    dbg.setEnabled(true);
    const taps = [];
    for (let i = 0; i < 30; i += 1) taps.push({ residualMs: i + 0.6 });
    dbg.recordCalibration({ accepted: true, offsetMs: 0, n: 30 }, { taps }, { source: 'auto' });
    const sample = dbg.snapshot().calibration[0].residuals_sample_ms;
    assert.equal(sample.length, 24);
    assert.deepEqual(sample.slice(0, 3), [1, 2, 3]);
});

test('window exposes feedBackDrumDebug and feedBackDrumsTimingDebug', () => {
    freshDebug();
    assert.equal(typeof window.feedBackDrumDebug.snapshot, 'function');
    assert.equal(window.feedBackDrumsTimingDebug, window.feedBackDrumDebug);
});
