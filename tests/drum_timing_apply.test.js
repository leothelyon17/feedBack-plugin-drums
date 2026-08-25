'use strict';
// INIT-004/SPEC-003: apply MIDI timeStamp + device offset on the 2D highway.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SCREEN_JS = path.join(__dirname, '..', 'screen.js');
const SCREEN_SRC = fs.readFileSync(SCREEN_JS, 'utf8');

function freshPlugin() {
    global.window = {};
    global.localStorage = { getItem: () => null, setItem: () => {} };
    global.document = {
        addEventListener: () => {},
        querySelectorAll: () => [],
    };
    global.fetch = async () => ({ ok: true, json: async () => ({}) });
    delete require.cache[require.resolve(SCREEN_JS)];
    return require(SCREEN_JS);
}

function mappedSnare(mod) {
    mod._applyLanePreset('phase_shift_8');
    mod._setAttachedDevice('pad-1', { notes: { '38': 'snare' } });
    return mod._drumTabHitsToNotes([{ p: 'snare', t: 1.0, v: 100 }]);
}

function mockTap() {
    return {
        convert(midiTimeStamp, opts) {
            const now = Number(opts && opts.now);
            const chartT = Number(typeof (opts && opts.getTime) === 'function' ? opts.getTime() : 0);
            const base = Number.isFinite(chartT) ? chartT : 0;
            let ts = Number(midiTimeStamp);
            let lowConfidence = false;
            if (!Number.isFinite(ts) || ts === 0) {
                ts = now;
                lowConfidence = true;
            }
            const tChart = base + (ts - now) / 1000;
            return {
                tChart: Number.isFinite(tChart) ? tChart : base,
                lowConfidence,
            };
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

test('ac-1: _checkHit judges via MIDI timeStamp → getTime → effective_t, not visual clock', () => {
    const checkHit = SCREEN_SRC.match(/function _checkHit\([\s\S]*?\n    function _updateMissedNotes/);
    assert.ok(checkHit, '_checkHit source not found');
    const body = checkHit[0];
    assert.match(body, /_judgeDrumHit/);
    assert.doesNotMatch(body, /void timeStamp/);
    assert.doesNotMatch(body, /const t = _latestTime/);
    assert.doesNotMatch(body, /bundle\.currentTime/);

    const mod = freshPlugin();
    const notes = mappedSnare(mod);
    const hit = mod._judgeDrumHit(38, 1000, {
        notes,
        chords: [],
        hitKeys: new Set(),
        getTime: () => 1.0,
        now: 1000,
        offsetMs: 0,
        currentTime: 99,
    });
    assert.equal(hit.kind, 'hit');
    assert.equal(hit.t, 1.0);
});

test('ac-2: three consumers share one signed offset; A/V stays on the visual plane', () => {
    const mod = freshPlugin();
    const tChart = 10;
    const avMs = 80;
    const offsetMs = 40;
    const now = 5000;
    const midiTimeStamp = 5000;
    const currentTime = tChart + avMs / 1000;
    let getTimeCalls = 0;
    const clocks = mod._clocksForApply({
        midiTimeStamp,
        now,
        currentTime,
        offsetMs,
        getTime() {
            getTimeCalls += 1;
            return tChart;
        },
    });
    assert.equal(clocks.judgeT, tChart - offsetMs / 1000);
    assert.equal(clocks.drawClock, currentTime - offsetMs / 1000);
    assert.equal(clocks.audioClock, tChart - offsetMs / 1000);
    assert.ok(Math.abs((clocks.drawClock - clocks.audioClock) - avMs / 1000) < 1e-12);
    assert.equal(clocks.judgeT, clocks.audioClock);
    assert.notEqual(clocks.drawClock, clocks.judgeT);
    assert.ok(getTimeCalls >= 1);
    assert.equal(mod._highwayGetTime(), 0);
});

test('ac-2: applying offset does not change a stubbed getTime()', () => {
    const mod = freshPlugin();
    let chart = 5;
    global.window.highway = {
        getTime() { return chart; },
        getAvOffset() { return 0.08; },
    };
    const before = window.highway.getTime();
    const av = window.highway.getAvOffset();
    mod._judgeTimeFromMidi(100, { getTime: () => window.highway.getTime(), now: 100, offsetMs: 40 });
    mod._applyDrumOffsetSec(before + 0.08, 40);
    mod._audioScheduleWhen(before, 40);
    assert.equal(window.highway.getTime(), before);
    assert.equal(window.highway.getAvOffset(), av);
    assert.equal(chart, 5);
});

test('ac-3: a tape that still scores on currentTime fails (double-apply detector)', () => {
    const mod = freshPlugin();
    const tChart = 10;
    const avMs = 80;
    const drumMs = 40;
    const currentTime = tChart + avMs / 1000;
    const correct = mod._judgeTimeFromMidi(1000, {
        getTime: () => tChart,
        now: 1000,
        offsetMs: drumMs,
    });
    const doubleApplied = mod._applyDrumOffsetSec(currentTime, drumMs);
    assert.notEqual(doubleApplied, correct);
    assert.equal(correct, tChart - drumMs / 1000);
    assert.equal(doubleApplied, currentTime - drumMs / 1000);
    assert.notEqual(doubleApplied, tChart - drumMs / 1000);
});

test('ac-4: discarded timeStamp vs consumed timeStamp disagree when A/V is non-zero', () => {
    const mod = freshPlugin();
    const tChart = 5;
    const avMs = 80;
    const now = 2000;
    const midiTimeStamp = 2000;
    const currentTime = tChart + avMs / 1000;
    const discarded = currentTime;
    const consumed = mod._judgeTimeFromMidi(midiTimeStamp, {
        getTime: () => tChart,
        now,
        offsetMs: 0,
    });
    assert.notEqual(discarded, consumed);
    assert.equal(consumed, tChart);
    assert.equal(discarded, tChart + avMs / 1000);
});

test('ac-5: HIT_TOLERANCE remains 0.05 s', () => {
    const mod = freshPlugin();
    assert.equal(mod.HIT_TOLERANCE, 0.05);
    assert.match(SCREEN_SRC, /const HIT_TOLERANCE = 0\.05/);
    assert.doesNotMatch(SCREEN_SRC, /HIT_TOLERANCE\s*=\s*0\.(?!05)\d/);
});

test('ac-6: never calls setAvOffset / never writes av_offset_ms', () => {
    assert.doesNotMatch(SCREEN_SRC, /setAvOffset/);
    assert.doesNotMatch(SCREEN_SRC, /av_offset_ms/);
    const applyHelpers = SCREEN_SRC.match(/INIT-004\/SPEC-003[\s\S]*function _clocksForApply/);
    assert.ok(applyHelpers);
    assert.doesNotMatch(applyHelpers[0], /setAvOffset|av_offset_ms/);
});

test('uses tapToBeat.convert + effectiveT when present', () => {
    const mod = freshPlugin();
    const calls = [];
    window.feedBack.tapToBeat = {
        convert(ts, opts) {
            calls.push(['convert', ts, opts.now]);
            return { tChart: 7, lowConfidence: false };
        },
        effectiveT(tChart, offsetMs) {
            calls.push(['effectiveT', tChart, offsetMs]);
            return tChart - offsetMs / 1000;
        },
    };
    const t = mod._judgeTimeFromMidi(123, { getTime: () => 99, now: 50, offsetMs: 40 });
    assert.equal(t, 6.96);
    assert.equal(calls[0][0], 'convert');
    assert.equal(calls[1][0], 'effectiveT');
});

test('fallback math when tapToBeat is missing matches SPEC-001 convert', () => {
    const mod = freshPlugin();
    assert.equal(window.feedBack.tapToBeat, undefined);
    const t = mod._judgeTimeFromMidi(1500, { getTime: () => 10, now: 2000, offsetMs: 0 });
    assert.equal(t, 10 + (1500 - 2000) / 1000);
});

test('timeStamp missing/0 falls back like SPEC-001 (low-confidence now)', () => {
    const mod = freshPlugin();
    const opts = { getTime: () => 3, now: 5000, offsetMs: 0 };
    assert.equal(mod._judgeTimeFromMidi(0, opts), 3);
    assert.equal(mod._judgeTimeFromMidi(undefined, opts), 3);
    assert.equal(mod._judgeTimeFromMidi(Number.NaN, opts), 3);
    window.feedBack.tapToBeat = mockTap();
    assert.equal(mod._judgeTimeFromMidi(0, opts), 3);
});

test('missing getOffsetMs does not throw; offset is 0', () => {
    const mod = freshPlugin();
    delete window.feedBack.drumTiming;
    assert.equal(mod._readDrumOffsetMs(), 0);
    window.feedBack.drumTiming = {
        getOffsetMs() { throw new Error('boom'); },
    };
    assert.equal(mod._readDrumOffsetMs(), 0);
    assert.doesNotThrow(() => mod._judgeTimeFromMidi(100, { getTime: () => 1, now: 100 }));
});

test('non-finite judge time skips the hit (same as empty-chart guard)', () => {
    const mod = freshPlugin();
    const notes = mappedSnare(mod);
    window.feedBack.tapToBeat = {
        convert() { return { tChart: Number.NaN }; },
        effectiveT() { return Number.NaN; },
    };
    const skipT = mod._judgeDrumHit(38, 1, {
        notes, chords: [], hitKeys: new Set(), getTime: () => 1, now: 1, offsetMs: 0,
    });
    assert.equal(skipT.kind, 'skip');
    assert.equal(skipT.reason, 'non-finite-t');

    delete window.feedBack.tapToBeat;
    const skipEmpty = mod._judgeDrumHit(38, 1, {
        notes: [], chords: [], hitKeys: new Set(), getTime: () => 1, now: 1,
    });
    assert.equal(skipEmpty.kind, 'skip');
    assert.equal(skipEmpty.reason, 'empty-chart');
});

test('offset 0 is bit-identical to getTime when the stamp maps cleanly', () => {
    const mod = freshPlugin();
    const tChart = 3.5;
    assert.equal(mod._judgeTimeFromMidi(100, { getTime: () => tChart, now: 100, offsetMs: 0 }), tChart);
});

test('HIT_TOLERANCE window: on-time hits, 60 ms miss, flam _noScore skipped', () => {
    const mod = freshPlugin();
    const notes = mappedSnare(mod);
    const base = {
        notes, chords: [], getTime: () => 1.0, now: 1000, offsetMs: 0,
    };
    assert.equal(mod._judgeDrumHit(38, 1000, { ...base, hitKeys: new Set() }).kind, 'hit');
    assert.equal(mod._judgeDrumHit(38, 1000, {
        ...base, getTime: () => 1.06, hitKeys: new Set(),
    }).kind, 'miss');
    assert.equal(mod._judgeDrumHit(38, 1000, {
        ...base, getTime: () => 1.04, hitKeys: new Set(),
    }).kind, 'hit');

    const flam = mod._drumTabHitsToNotes([{ p: 'snare', t: 1.0, v: 100, f: true }]);
    assert.equal(flam.filter((n) => n._noScore).length, 1);
    const keys = new Set();
    const result = mod._judgeDrumHit(38, 1000, {
        notes: flam, chords: [], hitKeys: keys, getTime: () => 1.0, now: 1000, offsetMs: 0,
    });
    assert.equal(result.kind, 'hit');
    const mainKey = mod._drumTabHitsToNotes([{ p: 'snare', t: 1.0, v: 100 }]);
    const expected = (1).toFixed(3) + '|' + mod.noteToMidi(mainKey[0].s, mainKey[0].f);
    assert.equal(result.key, expected);
    assert.equal(keys.has(result.key), true);
});

test('late MIDI inside ±50 ms after offset; same stamp misses at offset 0', () => {
    const mod = freshPlugin();
    const notes = mappedSnare(mod);
    const late = {
        notes, chords: [], hitKeys: new Set(), getTime: () => 1.08, now: 1000,
    };
    assert.equal(mod._judgeDrumHit(38, 1000, { ...late, offsetMs: 0 }).kind, 'miss');
    assert.equal(mod._judgeDrumHit(38, 1000, { ...late, offsetMs: 80 }).kind, 'hit');
});

test('chord notes score on the same judge clock', () => {
    const mod = freshPlugin();
    mappedSnare(mod);
    const midi = 38;
    const s = (midi / 24) | 0;
    const f = midi % 24;
    const chords = [{ t: 2.0, notes: [{ s, f }] }];
    const hit = mod._judgeDrumHit(38, 500, {
        notes: [],
        chords,
        hitKeys: new Set(),
        getTime: () => 2.0,
        now: 500,
        offsetMs: 0,
    });
    assert.equal(hit.kind, 'hit');
});

test('audio schedule helper applies the same signed ms; non-finite ctx → 0', () => {
    const mod = freshPlugin();
    assert.equal(mod._audioScheduleWhen(5, 40), 4.96);
    assert.equal(mod._audioScheduleWhen(Number.NaN, 40), 0);
    assert.equal(mod._applyDrumOffsetSec(Number.NaN, 40), Number.NaN);
});

test('hit-path branches: highway clock, offset coerce, throws, unmapped, window skip', () => {
    const mod = freshPlugin();
    global.window.highway = { getTime() { return 2.5; } };
    assert.equal(mod._highwayGetTime(), 2.5);
    global.window.highway = { getTime() { return Number.NaN; } };
    assert.equal(mod._highwayGetTime(), 0);
    global.window.highway = { getTime() { throw new Error('hw'); } };
    assert.equal(mod._highwayGetTime(), 0);

    window.feedBack.drumTiming = { getOffsetMs() { return Number.NaN; } };
    assert.equal(mod._readDrumOffsetMs(), 0);
    window.feedBack.drumTiming = { getOffsetMs() { return 22; } };
    assert.equal(mod._readDrumOffsetMs(), 22);

    const viaNow = mod._judgeTimeFromMidi(100, { getTime: () => 4 });
    assert.equal(typeof viaNow, 'number');

    assert.equal(mod._judgeTimeFromMidi(100, { getTime: () => 4, now: 100, offsetMs: Number.NaN }), 4);
    assert.ok(Number.isFinite(mod._judgeTimeFromMidi(100, { getTime: () => 4, now: 100 })));

    window.feedBack.tapToBeat = {
        convert() { throw new Error('convert'); },
        effectiveT() { return 1; },
    };
    assert.ok(Number.isNaN(mod._judgeTimeFromMidi(1, { getTime: () => 1, now: 1, offsetMs: 0 })));

    window.feedBack.tapToBeat = {
        convert() { return { tChart: 8 }; },
        effectiveT() { throw new Error('effective'); },
    };
    assert.ok(Number.isNaN(mod._judgeTimeFromMidi(1, { getTime: () => 1, now: 1, offsetMs: 0 })));

    window.feedBack.tapToBeat = {
        convert() { return { tChart: 8 }; },
    };
    assert.equal(mod._judgeTimeFromMidi(1, { getTime: () => 1, now: 1, offsetMs: 40 }), 7.96);

    delete window.feedBack.tapToBeat;
    assert.equal(mod._convertMidiFallback(10, null, 10), 0);
    assert.equal(mod._convertMidiFallback(10, () => Number.NaN, 10), 0);

    const clocks = mod._clocksForApply();
    assert.equal(typeof clocks.offsetMs, 'number');
    assert.equal(mod._clocksForApply({ offsetMs: Number.NaN }).offsetMs, 0);

    const skipUnmapped = mod._judgeDrumHit(38, 1000, {
        notes: [{ t: 1, s: 1, f: 14 }],
        chords: [],
        hitKeys: new Set(),
        getTime: () => 1,
        now: 1000,
        offsetMs: 0,
    });
    assert.equal(skipUnmapped.kind, 'skip');
    assert.equal(skipUnmapped.reason, 'unmapped');

    const notes = mappedSnare(mod);
    const farFuture = notes.map((n) => ({ ...n, t: 10 }));
    assert.equal(mod._judgeDrumHit(38, 1000, {
        notes: farFuture, chords: [], hitKeys: new Set(), getTime: () => 1, now: 1000, offsetMs: 0,
    }).kind, 'miss');
    const farPast = notes.map((n) => ({ ...n, t: 0.1 }));
    assert.equal(mod._judgeDrumHit(38, 1000, {
        notes: farPast, chords: [], hitKeys: new Set(), getTime: () => 1, now: 1000, offsetMs: 0,
    }).kind, 'miss');

    const first = mod._judgeDrumHit(38, 1000, {
        notes, chords: [], hitKeys: new Set(), getTime: () => 1, now: 1000, offsetMs: 0,
    });
    const keys = new Set([first.key]);
    assert.equal(mod._judgeDrumHit(38, 1000, {
        notes, chords: [], hitKeys: keys, getTime: () => 1, now: 1000, offsetMs: 0,
    }).kind, 'miss');

    const midi = 38;
    const s = (midi / 24) | 0;
    const f = midi % 24;
    assert.equal(mod._judgeDrumHit(38, 500, {
        notes: [],
        chords: [{ t: 10, notes: [{ s, f }] }],
        hitKeys: new Set(),
        getTime: () => 2,
        now: 500,
        offsetMs: 0,
    }).kind, 'miss');
    assert.equal(mod._judgeDrumHit(38, 500, {
        notes: [],
        chords: [{ t: 0.1, notes: [{ s, f }] }],
        hitKeys: new Set(),
        getTime: () => 2,
        now: 500,
        offsetMs: 0,
    }).kind, 'miss');
    assert.equal(mod._judgeDrumHit(38, 500, {
        notes: [],
        chords: [{ t: 2.0, notes: [] }],
        hitKeys: new Set(),
        getTime: () => 2,
        now: 500,
        offsetMs: 0,
    }).kind, 'miss');

    const emptySnap = mod._judgeDrumHit(38, 1, null);
    assert.equal(emptySnap.kind, 'skip');

    const origPerf = global.performance;
    global.performance = {};
    try {
        const t = mod._judgeTimeFromMidi(0, { getTime: () => 1, offsetMs: 0 });
        assert.equal(t, 1);
    } finally {
        global.performance = origPerf;
    }

    mod._cfg.hitDetection = true;
    const inst = window.feedBackViz_drums();
    assert.doesNotThrow(() => inst._handleDrumHit(38, 100, 1000));
});
