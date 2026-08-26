// INIT-006: Opt-in local timing debug (calibration + in-play judges).
// Default off; in-memory only. Never stores device names, MIDI bytes, or chart paths.
(function (root) {
'use strict';

var SCHEMA = 'drums.timing_debug.v1';
var CALIB_CAP = 10;
var JUDGE_CAP = 200;
var RESIDUAL_CAP = 24;

var _enabled = false;
var _calibration = [];
var _inPlay = [];
var _sessionCtx = {
    origin: 'localhost',
    audio_backend: 'html5',
    offset_ms_applied: 0,
    hit_detection: true,
    clock_play: 'performance',
};

function _fb() {
    if (typeof window === 'undefined') return null;
    return window.feedBack || window.feedback || window.slopsmith || null;
}

function _safeStr(v) {
    if (v == null) return undefined;
    var s = String(v);
    if (/Yamaha|Web MIDI|\.feedpak|\.sloppak/i.test(s)) return undefined;
    return s;
}

function _finite(n) {
    var v = Number(n);
    return Number.isFinite(v) ? v : undefined;
}

function _pushCap(arr, item, cap) {
    arr.push(item);
    while (arr.length > cap) arr.shift();
}

function _sampleResiduals(session) {
    var taps = session && session.taps;
    if (!taps || !taps.length) return [];
    var out = [];
    for (var i = 0; i < taps.length && out.length < RESIDUAL_CAP; i += 1) {
        var r = _finite(taps[i].residualMs);
        if (r != null) out.push(Math.round(r));
    }
    return out;
}

function _contribute(payload) {
    try {
        var fb = _fb();
        if (fb && fb.diagnostics && typeof fb.diagnostics.contribute === 'function') {
            fb.diagnostics.contribute('drums', payload);
        }
    } catch (_) { /* diagnostics optional */ }
}

function _updateSession(meta) {
    meta = meta && typeof meta === 'object' ? meta : {};
    if (_safeStr(meta.origin)) _sessionCtx.origin = _safeStr(meta.origin);
    if (_safeStr(meta.audio_backend)) _sessionCtx.audio_backend = _safeStr(meta.audio_backend);
    var off = _finite(meta.offsetMs);
    if (off != null) _sessionCtx.offset_ms_applied = off;
    if (meta.hitDetection != null) _sessionCtx.hit_detection = !!meta.hitDetection;
    if (_safeStr(meta.clock_source)) _sessionCtx.clock_play = _safeStr(meta.clock_source);
}

function setEnabled(on) {
    _enabled = !!on;
    if (!_enabled) {
        _calibration = [];
        _inPlay = [];
        _contribute({ schema: SCHEMA, enabled: false });
        return;
    }
    _contribute(snapshot());
}

function isEnabled() {
    return _enabled;
}

function recordCalibration(summary, session, meta) {
    if (!_enabled) return;
    meta = meta && typeof meta === 'object' ? meta : {};
    summary = summary && typeof summary === 'object' ? summary : {};
    _updateSession(Object.assign({}, meta, { offsetMs: summary.offsetMs }));

    var src = _safeStr(meta.source);
    if (src !== 'auto' && src !== 'manual' && src !== 'save_anyway') src = 'auto';

    var evt = {
        kind: 'calibration',
        ts: Date.now(),
        accepted: summary.accepted != null ? !!summary.accepted : !!summary.ok,
        code: _safeStr(summary.code),
        offsetMs: _finite(summary.offsetMs),
        mad: _finite(summary.mad),
        n: _finite(summary.n),
        n_raw: session && session.taps ? session.taps.length : undefined,
        heldOutMedianAbs: _finite(summary.heldOutMedianAbs),
        residuals_sample_ms: _sampleResiduals(session),
        origin: _safeStr(meta.origin) || _sessionCtx.origin,
        audio_backend: _safeStr(meta.audio_backend) || _sessionCtx.audio_backend,
        clock_source: _safeStr(meta.clock_source) || _sessionCtx.clock_play,
        bpm: 120,
        source: src,
    };
    _pushCap(_calibration, evt, CALIB_CAP);
    _contribute(snapshot());
}

function recordJudge(result, ctx) {
    if (!_enabled) return;
    ctx = ctx && typeof ctx === 'object' ? ctx : {};
    result = result && typeof result === 'object' ? result : {};
    // Scoring-off pad flashes still log as skip so a dump explains 0/0 HUD.
    if (ctx.hitDetection === false && result.kind !== 'skip') return;

    var kind = result.kind === 'hit' || result.kind === 'miss' || result.kind === 'skip'
        ? result.kind
        : 'skip';

    _updateSession(ctx);

    var evt = {
        kind: 'judge',
        ts: Date.now(),
        result: kind,
        offsetMs: _finite(ctx.offsetMs),
        hitDetection: ctx.hitDetection !== false,
    };

    var t = _finite(result.t);
    if (t != null) evt.t = t;

    if (kind === 'skip') {
        evt.skip_reason = _safeStr(result.reason);
    } else if (kind === 'miss') {
        var lane = _finite(ctx.playedLane != null ? ctx.playedLane : result.playedLane);
        if (lane != null) evt.playedLane = lane;
    } else if (kind === 'hit') {
        var noteT = _finite(result.noteT);
        if (noteT != null) evt.noteT = noteT;
        var err = _finite(result.errorMs);
        if (err != null) evt.errorMs = err;
        var pl = _finite(ctx.playedLane != null ? ctx.playedLane : result.playedLane);
        if (pl != null) evt.playedLane = pl;
    }

    _pushCap(_inPlay, evt, JUDGE_CAP);
    _contribute(snapshot());
}

function _summaryCounts() {
    var hits = 0;
    var misses = 0;
    var skips = 0;
    for (var i = 0; i < _inPlay.length; i += 1) {
        var r = _inPlay[i].result;
        if (r === 'hit') hits += 1;
        else if (r === 'miss') misses += 1;
        else if (r === 'skip') skips += 1;
    }
    return {
        calibration_count: _calibration.length,
        in_play_count: _inPlay.length,
        in_play_hits: hits,
        in_play_misses: misses,
        in_play_skips: skips,
    };
}

function snapshot() {
    return {
        schema: SCHEMA,
        enabled: _enabled,
        captured_at: (new Date()).toISOString(),
        session: {
            origin: _sessionCtx.origin,
            audio_backend: _sessionCtx.audio_backend,
            offset_ms_applied: _sessionCtx.offset_ms_applied,
            hit_detection: _sessionCtx.hit_detection,
            clock_play: _sessionCtx.clock_play,
        },
        calibration: _calibration.slice(),
        in_play: _inPlay.slice(),
        summary: _summaryCounts(),
    };
}

function clear() {
    _calibration = [];
    _inPlay = [];
    if (_enabled) _contribute(snapshot());
}

function resetForTests() {
    _enabled = false;
    _calibration = [];
    _inPlay = [];
    _sessionCtx = {
        origin: 'localhost',
        audio_backend: 'html5',
        offset_ms_applied: 0,
        hit_detection: true,
        clock_play: 'performance',
    };
}

var api = {
    setEnabled: setEnabled,
    isEnabled: isEnabled,
    recordCalibration: recordCalibration,
    recordJudge: recordJudge,
    snapshot: snapshot,
    clear: clear,
    resetForTests: resetForTests,
    SCHEMA: SCHEMA,
    CALIB_CAP: CALIB_CAP,
    JUDGE_CAP: JUDGE_CAP,
};

if (typeof window !== 'undefined') {
    window.feedBackDrumDebug = api;
    window.feedBackDrumsTimingDebug = api;
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
}

})(typeof window !== 'undefined' ? window : this);
