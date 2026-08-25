// INIT-006/SPEC-007: YARG-style damped in-play auto-trim (opt-in, default off).
// Collects SPEC-003 signed errors (t_hit − t_note), 1.5×IQR fence, median,
// applies DAMPING 0.5 to the active profile's offset_ms via writeTiming.
// One composite offset. Never writes av_offset_ms. Buffer capped at SAMPLE_SIZE.
(function (root) {
'use strict';

var SAMPLE_SIZE = 20;
var DAMPING = 0.5;
var STABLE_THRESHOLD_MS = 5.0;
var IQR_FENCE = 1.5;
var OFFSET_MAX_MS = 250;
var VERSION = 1;

var _enabled = false;
var _samples = [];
var _stable = false;
var _runInvalidated = false;
var _lastDecision = null;
var _lastWrite = null;

function _fb() {
    if (typeof window === 'undefined') return null;
    return window.feedBack || window.feedback || window.slopsmith || null;
}

function midiDevices() {
    var fb = _fb();
    var api = fb && fb.midiDevices;
    if (!api || typeof api !== 'object') return null;
    return api;
}

function currentOrigin() {
    try {
        var loc = (typeof window !== 'undefined' && window.location) ? window.location : (typeof location !== 'undefined' ? location : null);
        var h = loc && loc.hostname != null ? String(loc.hostname) : '';
        if (!h || h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h === '::1') return 'localhost';
        return h;
    } catch (_) {
        return 'localhost';
    }
}

function currentAudioBackend() {
    try {
        if (typeof window !== 'undefined' && window._juceMode === true) return 'juce';
    } catch (_) { /* private-mode / missing window */ }
    return 'html5';
}

function hasDangerousKeys(obj) {
    if (!obj || typeof obj !== 'object') return false;
    return Object.prototype.hasOwnProperty.call(obj, '__proto__')
        || Object.prototype.hasOwnProperty.call(obj, 'constructor')
        || Object.prototype.hasOwnProperty.call(obj, 'prototype');
}

function clampOffset(n) {
    var v = Number(n);
    if (!Number.isFinite(v)) return 0;
    if (v > OFFSET_MAX_MS) return OFFSET_MAX_MS;
    if (v < -OFFSET_MAX_MS) return -OFFSET_MAX_MS;
    return v;
}

function finiteNumbers(values) {
    var nums = [];
    if (!values) return nums;
    for (var i = 0; i < values.length; i += 1) {
        var n = Number(values[i]);
        if (Number.isFinite(n)) nums.push(n);
    }
    return nums;
}

function calculateMedian(values) {
    var sorted = finiteNumbers(values).sort(function (a, b) { return a - b; });
    var count = sorted.length;
    if (!count) return null;
    var middleIndex = Math.floor(count / 2);
    if (count % 2 === 0) {
        return (sorted[middleIndex - 1] + sorted[middleIndex]) / 2;
    }
    return sorted[middleIndex];
}

// YARG AutoCalibrator.RemoveOutliers: q1 = sorted[count/4], q3 = sorted[count*3/4],
// then drop values outside [q1 − 1.5×IQR, q3 + 1.5×IQR]. Integer index, no interpolation.
function removeOutliers(values) {
    var sorted = finiteNumbers(values).sort(function (a, b) { return a - b; });
    var count = sorted.length;
    if (!count) return [];
    var q1 = sorted[Math.floor(count / 4)];
    var q3 = sorted[Math.floor(count * 3 / 4)];
    var iqr = q3 - q1;
    var lowerBound = q1 - IQR_FENCE * iqr;
    var upperBound = q3 + IQR_FENCE * iqr;
    var out = [];
    for (var i = 0; i < sorted.length; i += 1) {
        if (sorted[i] >= lowerBound && sorted[i] <= upperBound) out.push(sorted[i]);
    }
    return out;
}

function considerBatch(values) {
    var nums = finiteNumbers(values);
    if (nums.length < SAMPLE_SIZE) {
        return { apply: false, stable: false, reason: 'short', count: nums.length, median: null, deltaMs: 0 };
    }
    var filtered = removeOutliers(nums);
    if (!filtered.length) {
        return { apply: false, stable: false, reason: 'empty-filter', count: nums.length, median: null, deltaMs: 0 };
    }
    var med = calculateMedian(filtered);
    if (!Number.isFinite(med)) {
        return { apply: false, stable: false, reason: 'no-median', count: nums.length, median: null, deltaMs: 0 };
    }
    // Inclusive YARG <= STABLE_THRESHOLD_MS: exact |median| 5.0 ms is stable (HITL 2026-08-25).
    if (Math.abs(med) <= STABLE_THRESHOLD_MS) {
        return { apply: false, stable: true, reason: 'stable', count: nums.length, median: med, deltaMs: 0 };
    }
    var delta = Math.round(med * DAMPING);
    if (!Number.isFinite(delta) || delta === 0) {
        return { apply: false, stable: false, reason: 'zero-delta', count: nums.length, median: med, deltaMs: 0 };
    }
    return { apply: true, stable: false, reason: 'apply', count: nums.length, median: med, deltaMs: delta };
}

function pushSample(buffer, errorMs) {
    if (!Array.isArray(buffer)) buffer = [];
    var n = Number(errorMs);
    if (!Number.isFinite(n)) return buffer;
    buffer.push(n);
    while (buffer.length > SAMPLE_SIZE) buffer.shift();
    return buffer;
}

function readActiveTiming() {
    var api = midiDevices();
    if (!api || typeof api.getActive !== 'function') return null;
    var device = null;
    try { device = api.getActive.call(api) || null; } catch (_) { return null; }
    if (!device || typeof device !== 'object') return null;
    var t = device.timing;
    if (t == null || typeof t !== 'object' || Array.isArray(t)) {
        return { offset_ms: 0, origin: currentOrigin(), audio_backend: currentAudioBackend() };
    }
    if (hasDangerousKeys(t)) return null;
    var off = Number(t.offset_ms);
    return {
        offset_ms: Number.isFinite(off) ? off : 0,
        origin: t.origin != null ? String(t.origin) : currentOrigin(),
        audio_backend: t.audio_backend != null ? String(t.audio_backend) : currentAudioBackend(),
    };
}

function persistDelta(deltaMs) {
    var api = midiDevices();
    if (!api || typeof api.writeTiming !== 'function') {
        return { ok: false, reason: 'no-accessor' };
    }
    var delta = Number(deltaMs);
    if (!Number.isFinite(delta) || delta === 0) {
        return { ok: false, reason: 'no-delta' };
    }
    var current = readActiveTiming();
    if (!current) return { ok: false, reason: 'no-timing' };
    var body = {
        offset_ms: clampOffset(current.offset_ms + delta),
        origin: current.origin,
        audio_backend: current.audio_backend,
    };
    _lastWrite = body;
    try {
        var ret = api.writeTiming.call(api, body);
        return { ok: true, payload: body, ret: ret };
    } catch (_) {
        return { ok: false, reason: 'write-failed' };
    }
}

function setEnabled(on) {
    var next = !!on;
    _enabled = next;
    _samples = [];
    _stable = false;
    _lastDecision = null;
    if (next) _runInvalidated = true;
}

function isEnabled() {
    return _enabled;
}

function isScoring() {
    return !_enabled;
}

function isRunInvalidated() {
    return _runInvalidated;
}

function isStable() {
    return _stable;
}

function onNewRun() {
    _samples = [];
    _stable = false;
    _lastDecision = null;
    _runInvalidated = _enabled;
}

function recordHit(errorMs) {
    if (!_enabled) {
        return { applied: false, persisted: false, reason: 'disabled' };
    }
    var n = Number(errorMs);
    if (!Number.isFinite(n)) {
        return { applied: false, persisted: false, reason: 'non-finite' };
    }
    pushSample(_samples, n);
    if (_samples.length < SAMPLE_SIZE) {
        return {
            applied: false,
            persisted: false,
            reason: 'collecting',
            count: _samples.length,
            sampleSize: SAMPLE_SIZE,
        };
    }
    var batch = _samples.slice();
    _samples.length = 0;
    var decision = considerBatch(batch);
    _lastDecision = decision;
    if (decision.stable) {
        _stable = true;
        return {
            applied: false,
            persisted: false,
            stable: true,
            reason: 'stable',
            median: decision.median,
            deltaMs: 0,
        };
    }
    _stable = false;
    if (!decision.apply) {
        return {
            applied: false,
            persisted: false,
            reason: decision.reason,
            median: decision.median,
            deltaMs: 0,
        };
    }
    var persisted = persistDelta(decision.deltaMs);
    return {
        applied: true,
        persisted: !!(persisted && persisted.ok),
        reason: 'apply',
        median: decision.median,
        deltaMs: decision.deltaMs,
        payload: persisted && persisted.payload,
        persist: persisted,
    };
}

function uiModel() {
    var count = _samples.length;
    var status;
    if (!_enabled) {
        status = _runInvalidated
            ? 'Auto-trim off. This run stays practice (not ranked).'
            : 'Auto-trim off';
    } else if (_stable) {
        status = 'Stable (|median| ≤ ' + STABLE_THRESHOLD_MS + ' ms) — not applying';
    } else if (count > 0) {
        status = 'Collecting ' + count + '/' + SAMPLE_SIZE;
    } else if (_lastDecision && _lastDecision.apply) {
        status = 'Applied ' + (_lastDecision.deltaMs > 0 ? '+' : '') + _lastDecision.deltaMs + ' ms';
    } else {
        status = 'Collecting 0/' + SAMPLE_SIZE;
    }
    return {
        enabled: _enabled,
        stable: _stable,
        runInvalidated: _runInvalidated,
        scoring: !_enabled,
        count: count,
        sampleSize: SAMPLE_SIZE,
        statusLabel: status,
        lastDecision: _lastDecision,
    };
}

function sampleCount() {
    return _samples.length;
}

function resetForTests() {
    _enabled = false;
    _samples = [];
    _stable = false;
    _runInvalidated = false;
    _lastDecision = null;
    _lastWrite = null;
}

var api = {
    version: VERSION,
    SAMPLE_SIZE: SAMPLE_SIZE,
    DAMPING: DAMPING,
    STABLE_THRESHOLD_MS: STABLE_THRESHOLD_MS,
    IQR_FENCE: IQR_FENCE,
    OFFSET_MAX_MS: OFFSET_MAX_MS,
    calculateMedian: calculateMedian,
    removeOutliers: removeOutliers,
    considerBatch: considerBatch,
    pushSample: pushSample,
    setEnabled: setEnabled,
    isEnabled: isEnabled,
    isScoring: isScoring,
    isRunInvalidated: isRunInvalidated,
    isStable: isStable,
    onNewRun: onNewRun,
    recordHit: recordHit,
    persistDelta: persistDelta,
    uiModel: uiModel,
    sampleCount: sampleCount,
    resetForTests: resetForTests,
    _lastWrite: function () { return _lastWrite; },
    _samples: function () { return _samples; },
};

function publish() {
    var fb = _fb();
    if (!fb) {
        if (typeof window !== 'undefined') {
            window.feedBack = window.feedBack || {};
            fb = window.feedBack;
        }
    }
    if (fb) {
        fb.drumAutoTrim = {
            version: VERSION,
            setEnabled: setEnabled,
            isEnabled: isEnabled,
            isScoring: isScoring,
            isRunInvalidated: isRunInvalidated,
            isStable: isStable,
            onNewRun: onNewRun,
            recordHit: recordHit,
            uiModel: uiModel,
        };
        if (window.slopsmith && window.slopsmith !== fb) {
            window.slopsmith.drumAutoTrim = fb.drumAutoTrim;
        }
        if (window.feedback && window.feedback !== fb) {
            window.feedback.drumAutoTrim = fb.drumAutoTrim;
        }
    }
    if (typeof window !== 'undefined') window.feedBackDrumsAutoTrim = api;
}

publish();

if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
}

})(typeof window !== 'undefined' ? window : this);
