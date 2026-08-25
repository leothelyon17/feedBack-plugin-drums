// INIT-004/SPEC-002: Calibration module (inline MIDI panel + overlay).
// One render entry, two mounts. Persist only via midiDevices.writeTiming.
// Getter clamps |offset| to 250. Never writes the visual A/V offset or plugin store keys.
(function (root) {
'use strict';

var OFFSET_MAX_MS = 250;
var SUGGESTED_CHART_ID = 'starter/feedBack-diagnostic-basic-drums.feedpak';
var FAIL_COPY = 'Hits were too scattered';
var EMPTY_COPY = 'Not set';
var BPM = 120;
var VERSION = 1;

var _inlineHost = null;
var _overlay = null;
var _views = [];
var _session = null;
var _measuring = false;
var _lastSummary = null;
var _unwatchMidi = null;
var _clickTimer = null;
var _clickCtx = null;
var _clickStartedAt = 0;
var _clickStartedMs = 0;
var _listenersBound = false;
var _remeasureOpen = false;
var _suggestedAvailable = null;
var _lastWrite = null;

function _fb() {
    if (typeof window === 'undefined') return null;
    return window.feedBack || window.feedback || window.slopsmith || null;
}

function _doc() {
    return typeof document !== 'undefined' ? document : null;
}

function midiDevices() {
    var fb = _fb();
    var api = fb && fb.midiDevices;
    if (!api || typeof api !== 'object') return null;
    return api;
}

function tapToBeat() {
    var fb = _fb();
    var api = fb && fb.tapToBeat;
    return (api && typeof api === 'object') ? api : null;
}

function clampOffset(n) {
    var v = Number(n);
    if (!Number.isFinite(v)) return 0;
    if (v > OFFSET_MAX_MS) return OFFSET_MAX_MS;
    if (v < -OFFSET_MAX_MS) return -OFFSET_MAX_MS;
    return v;
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

function currentTag() {
    return { origin: currentOrigin(), audio_backend: currentAudioBackend() };
}

function hasDangerousKeys(obj) {
    if (!obj || typeof obj !== 'object') return false;
    return Object.prototype.hasOwnProperty.call(obj, '__proto__')
        || Object.prototype.hasOwnProperty.call(obj, 'constructor')
        || Object.prototype.hasOwnProperty.call(obj, 'prototype');
}

function readTiming(device) {
    if (!device || typeof device !== 'object' || Array.isArray(device)) return null;
    var t = device.timing;
    if (t == null || typeof t !== 'object' || Array.isArray(t)) return null;
    if (hasDangerousKeys(t)) return null;
    var off = Number(t.offset_ms);
    if (!Number.isFinite(off)) return null;
    return t;
}

function tagMatches(timing, tag) {
    if (!timing || typeof timing !== 'object') return false;
    var pair = tag || currentTag();
    var origin = timing.origin != null ? String(timing.origin) : '';
    var backend = timing.audio_backend != null ? String(timing.audio_backend) : '';
    return origin === String(pair.origin || '') && backend === String(pair.audio_backend || '');
}

function shouldPromptRemeasure(device, tag) {
    var t = readTiming(device);
    if (!t) return false;
    return !tagMatches(t, tag || currentTag());
}

function activeDevice() {
    var api = midiDevices();
    if (!api || typeof api.getActive !== 'function') return null;
    try { return api.getActive.call(api) || null; } catch (_) { return null; }
}

function noteAllowed(note, device) {
    var n = Math.round(Number(note));
    if (!Number.isInteger(n) || n < 0 || n > 127) return false;
    var notes = device && device.notes;
    if (!notes || typeof notes !== 'object' || Array.isArray(notes)) return true;
    var keys = Object.keys(notes).filter(function (k) {
        return k !== '__proto__' && k !== 'constructor' && k !== 'prototype';
    });
    if (keys.length === 0) return true;
    return Object.prototype.hasOwnProperty.call(notes, String(n))
        || Object.prototype.hasOwnProperty.call(notes, n);
}

function sessionSummary(session) {
    var tap = tapToBeat();
    if (!tap || !tap.session) return { accepted: false, code: 'unavailable' };
    if (typeof tap.session.summary === 'function') {
        var s = tap.session.summary(session);
        if (s && typeof s === 'object') {
            if (s.accepted == null && s.ok != null) s.accepted = !!s.ok;
            return s;
        }
    }
    if (typeof tap.session.reduce !== 'function') return { accepted: false, code: 'unavailable' };
    var r = tap.session.reduce(session);
    if (!r || typeof r !== 'object') return { accepted: false, code: 'unavailable' };
    return {
        accepted: !!r.ok,
        ok: !!r.ok,
        code: r.code,
        offsetMs: r.offsetMs,
        n: r.n,
        mad: r.mad,
        heldOutMedianAbs: r.heldOutMedianAbs,
    };
}

function isFailCode(code) {
    return typeof code === 'string' && code.indexOf('fail_') === 0;
}

function formatOffsetLabel(timing) {
    if (!timing) return EMPTY_COPY;
    var n = clampOffset(timing.offset_ms);
    var rounded = Math.round(n);
    if (rounded > 0) return '+' + rounded + ' ms';
    return String(rounded) + ' ms';
}

function beatMarkerModel(residualMs) {
    var r = Number(residualMs);
    if (!Number.isFinite(r)) r = 0;
    var clamped = Math.max(-OFFSET_MAX_MS, Math.min(OFFSET_MAX_MS, r));
    var pct = 50 + (clamped / OFFSET_MAX_MS) * 45;
    var dir = r < -2 ? 'early' : (r > 2 ? 'late' : 'on');
    var abs = Math.abs(Math.round(r));
    var text = dir === 'on' ? 'On beat' : (abs + ' ms ' + dir);
    var shape = dir === 'early' ? '◀' : (dir === 'late' ? '▶' : '◆');
    return { pct: pct, dir: dir, text: text, shape: shape, residualMs: r };
}

function buildTimingPayload(summary, extra) {
    extra = extra || {};
    var tag = currentTag();
    var offset = clampOffset(summary && summary.offsetMs != null ? summary.offsetMs : extra.offset_ms);
    var n = extra.n != null ? extra.n : (summary && summary.n);
    var mae = extra.median_abs_error_ms;
    if (mae == null && summary) {
        mae = summary.heldOutMedianAbs != null ? summary.heldOutMedianAbs : summary.mad;
    }
    var payload = {
        offset_ms: offset,
        measured_at: extra.measured_at || (new Date()).toISOString(),
        origin: tag.origin,
        audio_backend: tag.audio_backend,
    };
    if (n != null && Number.isFinite(Number(n))) payload.n = Math.max(0, Math.round(Number(n)));
    if (mae != null && Number.isFinite(Number(mae))) payload.median_abs_error_ms = Number(mae);
    return payload;
}

function persistTiming(payload) {
    var api = midiDevices();
    if (!api || typeof api.writeTiming !== 'function') {
        return Promise.resolve({ ok: false, reason: 'no-accessor' });
    }
    if (!payload || typeof payload !== 'object' || hasDangerousKeys(payload)) {
        return Promise.resolve({ ok: false, reason: 'invalid' });
    }
    if (!Number.isFinite(Number(payload.offset_ms))) {
        return Promise.resolve({ ok: false, reason: 'non-finite' });
    }
    var body = {
        offset_ms: clampOffset(payload.offset_ms),
        measured_at: payload.measured_at,
        n: payload.n,
        median_abs_error_ms: payload.median_abs_error_ms,
        origin: payload.origin != null ? String(payload.origin) : currentOrigin(),
        audio_backend: payload.audio_backend != null ? String(payload.audio_backend) : currentAudioBackend(),
    };
    _lastWrite = body;
    try {
        var ret = api.writeTiming.call(api, body);
        return Promise.resolve(ret).then(function (device) {
            return { ok: true, device: device, payload: body };
        }).catch(function () {
            return { ok: false, reason: 'write-failed' };
        });
    } catch (_) {
        return Promise.resolve({ ok: false, reason: 'write-failed' });
    }
}

function persistIfAccepted(summary) {
    if (!summary || !summary.accepted) {
        return Promise.resolve({ ok: false, reason: 'rejected', code: summary && summary.code });
    }
    if (isFailCode(summary.code)) {
        return Promise.resolve({ ok: false, reason: 'rejected', code: summary.code });
    }
    return persistTiming(buildTimingPayload(summary));
}

function getOffsetMs() {
    var device = activeDevice();
    var t = readTiming(device);
    if (!t) return 0;
    if (!tagMatches(t)) return 0;
    return clampOffset(t.offset_ms);
}

function _el(tag, attrs) {
    var d = _doc();
    var n = d.createElement(tag);
    attrs = attrs || {};
    if (attrs.className) n.className = attrs.className;
    if (attrs.dt) n.setAttribute('data-dt', attrs.dt);
    if (attrs.text != null) n.textContent = String(attrs.text);
    if (attrs.type) n.setAttribute('type', attrs.type);
    if (attrs.role) n.setAttribute('role', attrs.role);
    if (attrs.live) n.setAttribute('aria-live', attrs.live);
    if (attrs.label) n.setAttribute('aria-label', attrs.label);
    if (attrs.hidden) n.hidden = true;
    if (attrs.modal) n.setAttribute('aria-modal', 'true');
    if (attrs.labelledBy) n.setAttribute('aria-labelledby', attrs.labelledBy);
    return n;
}

function _hook(root, name) {
    if (!root) return null;
    if (root.getAttribute && root.getAttribute('data-dt') === name) return root;
    var kids = root.children || [];
    for (var i = 0; i < kids.length; i += 1) {
        var found = _hook(kids[i], name);
        if (found) return found;
    }
    if (typeof root.querySelector === 'function') {
        return root.querySelector('[data-dt="' + name + '"]');
    }
    return null;
}

function _setText(node, text) {
    if (node) node.textContent = String(text);
}

function _setHidden(node, hide) {
    if (!node) return;
    node.hidden = !!hide;
    var cls = String(node.className || '');
    if (hide && cls.indexOf('drums-timing-hidden') === -1) {
        node.className = (cls + ' drums-timing-hidden').trim();
    } else if (!hide) {
        node.className = cls.replace(/\bdrums-timing-hidden\b/g, '').replace(/\s+/g, ' ').trim();
    }
}

function _calibClock() {
    if (_clickCtx && typeof _clickCtx.currentTime === 'number') {
        return _clickCtx.currentTime - _clickStartedAt;
    }
    var hw = typeof window !== 'undefined' ? window.highway : null;
    if (hw && typeof hw.getTime === 'function') {
        var t = Number(hw.getTime());
        if (Number.isFinite(t)) return t;
    }
    var now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    return (now - _clickStartedMs) / 1000;
}

function _stopClick() {
    if (_clickTimer != null) {
        try { clearInterval(_clickTimer); } catch (_) { /* ignore */ }
        _clickTimer = null;
    }
}

function _beep() {
    if (!_clickCtx || typeof _clickCtx.createOscillator !== 'function') return;
    try {
        var osc = _clickCtx.createOscillator();
        var gain = _clickCtx.createGain();
        osc.frequency.value = 1000;
        gain.gain.value = 0.08;
        osc.connect(gain);
        gain.connect(_clickCtx.destination);
        osc.start();
        osc.stop(_clickCtx.currentTime + 0.04);
    } catch (_) { /* audio optional */ }
}

function _startClick() {
    _stopClick();
    _clickStartedMs = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    _clickStartedAt = 0;
    try {
        var AC = (typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext)) || null;
        if (AC && !_clickCtx) _clickCtx = new AC();
        if (_clickCtx && typeof _clickCtx.currentTime === 'number') _clickStartedAt = _clickCtx.currentTime;
        if (_clickCtx && _clickCtx.state === 'suspended' && typeof _clickCtx.resume === 'function') {
            try { _clickCtx.resume(); } catch (_) { /* ignore */ }
        }
    } catch (_) {
        _clickCtx = null;
    }
    var period = 60000 / BPM;
    _beep();
    _clickTimer = setInterval(_beep, period);
}

function _minTaps() {
    var tap = tapToBeat();
    var nMin = tap && tap.N_MIN != null ? Number(tap.N_MIN) : 16;
    var nVer = tap && tap.N_VERIFY != null ? Number(tap.N_VERIFY) : 8;
    if (!Number.isFinite(nMin)) nMin = 16;
    if (!Number.isFinite(nVer)) nVer = 8;
    return nMin + nVer;
}

function _uiState() {
    var device = activeDevice();
    var timing = readTiming(device);
    var remasure = shouldPromptRemeasure(device);
    var n = (_session && _session.taps) ? _session.taps.length : 0;
    var need = _minTaps();
    return {
        device: device,
        deviceName: device && device.name ? String(device.name) : (device && device.id ? String(device.id) : ''),
        timing: timing,
        offsetLabel: formatOffsetLabel(timing),
        remasure: remasure,
        measuring: _measuring,
        tapCount: n,
        tapNeed: need,
        summary: _lastSummary,
        fail: _lastSummary && !_lastSummary.accepted && isFailCode(_lastSummary.code),
        hasDevice: !!(device && device.id),
    };
}

function _paintView(view) {
    if (!view || !view.root) return;
    var ui = _uiState();
    _setText(_hook(view.root, 'device'), ui.deviceName || 'No MIDI device');
    _setText(_hook(view.root, 'offset'), ui.offsetLabel);
    _setHidden(_hook(view.root, 'remeasure'), !ui.remasure);
    _setHidden(_hook(view.root, 'gate'), !ui.fail);
    if (ui.fail) _setText(_hook(view.root, 'gate-msg'), FAIL_COPY);
    _setHidden(_hook(view.root, 'save-anyway'), !ui.fail);
    _setText(_hook(view.root, 'progress'), ui.measuring
        ? (ui.tapCount + ' / ' + ui.tapNeed + ' hits')
        : '');
    _setHidden(_hook(view.root, 'retry'), !ui.fail);
    _setHidden(_hook(view.root, 'start'), ui.measuring || ui.fail);
    var sug = _hook(view.root, 'suggested');
    if (sug) {
        var missing = _suggestedAvailable === false;
        sug.hidden = missing;
        sug.disabled = missing || _suggestedAvailable == null;
        if (missing) sug.setAttribute('hidden', 'true');
        else sug.removeAttribute && sug.removeAttribute('hidden');
    }
    _setHidden(_hook(view.root, 'skip'), view.mode !== 'overlay');
    _setHidden(_hook(view.root, 'continue'), view.mode !== 'overlay');
}

function _paintAll() {
    for (var i = 0; i < _views.length; i += 1) _paintView(_views[i]);
}

function _paintBeat(residualMs) {
    var model = beatMarkerModel(residualMs);
    for (var i = 0; i < _views.length; i += 1) {
        var root = _views[i].root;
        var marker = _hook(root, 'beat-marker');
        var live = _hook(root, 'beat-live');
        var shape = _hook(root, 'beat-shape');
        if (marker) {
            marker.style = marker.style || {};
            marker.style.left = String(model.pct) + '%';
            marker.setAttribute('data-dir', model.dir);
            marker.className = 'drums-timing-marker drums-timing-marker--' + model.dir;
        }
        if (shape) shape.textContent = model.shape;
        if (live) live.textContent = model.text;
    }
}

function _bindView(view) {
    var root = view.root;
    function on(name, fn) {
        var node = _hook(root, name);
        if (!node) return;
        node.onclick = fn;
        if (typeof node.addEventListener === 'function') node.addEventListener('click', fn);
    }
    on('start', function () { startMeasure(); });
    on('retry', function () { startMeasure(); });
    on('save-anyway', function () { saveAnyway(); });
    on('manual-save', function () { saveManual(view); });
    on('suggested', function () { openSuggestedChart(); });
    on('skip', function () { closeOverlay(); });
    on('continue', function () { closeOverlay(); });
    on('remeasure-go', function () { startMeasure(); });
}

function renderInto(host, opts) {
    opts = opts || {};
    var d = _doc();
    if (!host || !d || typeof d.createElement !== 'function') return null;

    host.textContent = '';
    var root = _el('div', { className: 'drums-timing', dt: 'root' });
    var titleId = opts.titleId || 'drums-timing-title';
    var heading = _el('h4', { className: 'drums-timing-title', dt: 'title' });
    heading.id = titleId;
    heading.textContent = 'Measure pad timing';
    root.appendChild(heading);

    var status = _el('div', { className: 'drums-timing-status', dt: 'status' });
    var device = _el('span', { className: 'drums-timing-device', dt: 'device', text: '' });
    var offset = _el('strong', { className: 'drums-timing-offset', dt: 'offset', text: EMPTY_COPY });
    status.appendChild(device);
    status.appendChild(offset);
    root.appendChild(status);

    var remasure = _el('div', { className: 'drums-timing-remeasure', dt: 'remeasure', role: 'status' });
    remasure.appendChild(_el('p', { dt: 'remeasure-copy', text: 'This offset was saved on a different setup. Remeasure so hits stay lined up.' }));
    remasure.appendChild(_el('button', { type: 'button', className: 'drums-timing-btn', dt: 'remeasure-go', text: 'Remeasure' }));
    remasure.hidden = true;
    root.appendChild(remasure);

    var line = _el('div', { className: 'drums-timing-beat', dt: 'beat-line', label: 'Beat timing' });
    var now = _el('div', { className: 'drums-timing-now', dt: 'beat-now' });
    var marker = _el('div', { className: 'drums-timing-marker drums-timing-marker--on', dt: 'beat-marker' });
    marker.appendChild(_el('span', { className: 'drums-timing-shape', dt: 'beat-shape', text: '◆' }));
    line.appendChild(now);
    line.appendChild(marker);
    root.appendChild(line);

    var live = _el('div', { className: 'drums-timing-live', dt: 'beat-live', live: 'polite', text: 'On beat' });
    root.appendChild(live);

    var progress = _el('p', { className: 'drums-timing-progress', dt: 'progress', text: '' });
    root.appendChild(progress);

    var gate = _el('div', { className: 'drums-timing-gate', dt: 'gate', role: 'status' });
    gate.appendChild(_el('p', { dt: 'gate-msg', text: FAIL_COPY }));
    gate.hidden = true;
    root.appendChild(gate);

    var actions = _el('div', { className: 'drums-timing-actions', dt: 'actions' });
    actions.appendChild(_el('button', { type: 'button', className: 'drums-timing-btn drums-timing-btn-primary', dt: 'start', text: 'Start' }));
    actions.appendChild(_el('button', { type: 'button', className: 'drums-timing-btn drums-timing-btn-primary', dt: 'retry', text: 'Retry' }));
    actions.appendChild(_el('button', { type: 'button', className: 'drums-timing-btn drums-timing-btn-secondary', dt: 'save-anyway', text: 'Save anyway' }));
    root.appendChild(actions);

    var manual = _el('div', { className: 'drums-timing-manual', dt: 'manual' });
    var manLabel = _el('label', { text: 'Manual tune (ms)' });
    var manInput = _el('input', { type: 'number', dt: 'manual-offset', label: 'Manual offset in milliseconds' });
    manInput.min = String(-OFFSET_MAX_MS);
    manInput.max = String(OFFSET_MAX_MS);
    manInput.step = '1';
    manLabel.appendChild(manInput);
    manual.appendChild(manLabel);
    manual.appendChild(_el('button', { type: 'button', className: 'drums-timing-btn', dt: 'manual-save', text: 'Save' }));
    root.appendChild(manual);

    var hint = _el('p', { className: 'drums-timing-hint', dt: 'hint', text: 'Hit any mapped pad on the click. If the map is empty, any pad works.' });
    root.appendChild(hint);

    var suggested = _el('button', { type: 'button', className: 'drums-timing-btn drums-timing-suggested', dt: 'suggested', text: 'Open suggested chart' });
    suggested.hidden = true;
    suggested.disabled = true;
    root.appendChild(suggested);

    var foot = _el('div', { className: 'drums-timing-overlay-foot', dt: 'overlay-foot' });
    foot.appendChild(_el('button', { type: 'button', className: 'drums-timing-btn drums-timing-btn-ghost', dt: 'skip', text: 'Skip' }));
    foot.appendChild(_el('button', { type: 'button', className: 'drums-timing-btn drums-timing-btn-primary', dt: 'continue', text: 'Continue' }));
    root.appendChild(foot);

    host.appendChild(root);
    var view = { root: root, host: host, mode: opts.mode || 'inline' };
    _bindView(view);
    _views.push(view);
    _paintView(view);
    probeSuggestedChart();
    return view;
}

function _dropView(view) {
    _views = _views.filter(function (v) { return v !== view; });
}

function startMeasure() {
    var tap = tapToBeat();
    _lastSummary = null;
    _measuring = true;
    _session = tap && tap.session && typeof tap.session.create === 'function'
        ? tap.session.create()
        : { taps: [] };
    _startClick();
    _listenMidi(true);
    _paintBeat(0);
    _paintAll();
}

function stopMeasure() {
    _measuring = false;
    _stopClick();
    _listenMidi(false);
    _paintAll();
}

function handleNoteOn(note, timeStamp) {
    if (!_measuring) return { ok: false, reason: 'idle' };
    var device = activeDevice();
    if (!noteAllowed(note, device)) return { ok: false, reason: 'unmapped' };
    var tap = tapToBeat();
    if (!tap) return { ok: false, reason: 'no-tapToBeat' };
    if (!_session) _session = tap.session && tap.session.create ? tap.session.create() : { taps: [] };
    var conv = typeof tap.convert === 'function'
        ? tap.convert(timeStamp, { getTime: _calibClock })
        : { tChart: _calibClock() };
    var tChart = conv && Number.isFinite(conv.tChart) ? conv.tChart : _calibClock();
    if (tap.session && typeof tap.session.record === 'function') {
        tap.session.record(_session, tChart, { bpm: BPM, originT: 0 });
    } else if (tap.session && typeof tap.session.add === 'function') {
        var hit = typeof tap.nearestBeat === 'function'
            ? tap.nearestBeat(tChart, { bpm: BPM, originT: 0 })
            : { residualMs: 0 };
        tap.session.add(_session, hit);
    }
    var last = _session.taps && _session.taps.length
        ? _session.taps[_session.taps.length - 1]
        : null;
    var residual = last && Number.isFinite(last.residualMs) ? last.residualMs : 0;
    _paintBeat(residual);
    _maybeGate();
    _paintAll();
    return { ok: true, residualMs: residual, n: _session.taps ? _session.taps.length : 0 };
}

function _maybeGate() {
    if (!_session || !_session.taps) return;
    if (_session.taps.length < _minTaps()) return;
    var summary = sessionSummary(_session);
    _lastSummary = summary;
    if (summary.accepted) {
        persistIfAccepted(summary).then(function () {
            stopMeasure();
            _paintAll();
        });
        return;
    }
    if (isFailCode(summary.code)) {
        stopMeasure();
    }
}

function saveAnyway() {
    var summary = _lastSummary;
    if (!summary || summary.offsetMs == null || !Number.isFinite(Number(summary.offsetMs))) {
        _paintAll();
        return Promise.resolve({ ok: false, reason: 'no-offset' });
    }
    return persistTiming(buildTimingPayload(summary)).then(function (res) {
        _paintAll();
        return res;
    });
}

function saveManual(view) {
    var input = view ? _hook(view.root, 'manual-offset') : null;
    var raw = input ? input.value : '';
    var n = Number(raw);
    if (!Number.isFinite(n)) return Promise.resolve({ ok: false, reason: 'non-finite' });
    return persistTiming(buildTimingPayload({ offsetMs: n, n: 0, accepted: true }, { offset_ms: n })).then(function (res) {
        _paintAll();
        return res;
    });
}

function _onMidiWatch(payload) {
    var data = null;
    var ts = 0;
    if (payload && typeof payload === 'object' && payload.data != null && !ArrayBuffer.isView(payload)) {
        data = payload.data;
        ts = payload.timeStamp;
    } else {
        data = payload;
    }
    if (!data || data.length < 3) return;
    var status = data[0];
    var note = data[1];
    var velocity = data[2];
    var cmd = status & 0xF0;
    if (cmd === 0x90 && velocity > 0) handleNoteOn(note, ts);
}

function _listenMidi(on) {
    if (!on) {
        if (typeof _unwatchMidi === 'function') {
            try { _unwatchMidi(); } catch (_) { /* ignore */ }
        }
        _unwatchMidi = null;
        return;
    }
    if (_unwatchMidi) return;
    var fb = _fb();
    var mi = fb && fb.midiInput;
    if (mi && typeof mi.watchMessages === 'function') {
        _unwatchMidi = mi.watchMessages(_onMidiWatch);
    }
    if (mi && typeof mi.discover === 'function') {
        try { mi.discover(); } catch (_) { /* permission is best-effort */ }
    }
}

function evaluateRemeasure() {
    var device = activeDevice();
    var prompt = shouldPromptRemeasure(device);
    _remeasureOpen = prompt;
    _paintAll();
    if (prompt && !_inlineHost && !_overlay) {
        run({ requester: 'remeasure', mode: 'overlay' });
    }
    return prompt;
}

function _onDeviceChange() {
    evaluateRemeasure();
    _paintAll();
}

function _bindListeners() {
    if (_listenersBound) return;
    if (typeof window === 'undefined') return;
    _listenersBound = true;
    window.__feedBackDrumTimingHooks = true;
    var api = midiDevices();
    if (api && typeof api.subscribe === 'function') {
        api.subscribe(_onDeviceChange);
    }
    var d = _doc();
    if (d && typeof d.addEventListener === 'function') {
        d.addEventListener('feedback:midi-device-change', _onDeviceChange);
    }
    var fb = _fb();
    if (fb && typeof fb.on === 'function') {
        fb.on('feedback:midi-device-change', _onDeviceChange);
        fb.on('song:ready', evaluateRemeasure);
    }
}

function probeSuggestedChart() {
    if (_suggestedAvailable != null) {
        _paintAll();
        return Promise.resolve(_suggestedAvailable);
    }
    if (typeof fetch !== 'function') {
        _suggestedAvailable = false;
        _paintAll();
        return Promise.resolve(false);
    }
    return fetch('/api/library?size=200').then(function (res) {
        return res && typeof res.json === 'function' ? res.json() : { songs: [] };
    }).then(function (data) {
        var songs = (data && data.songs) || [];
        _suggestedAvailable = songs.some(function (s) {
            return s && s.filename === SUGGESTED_CHART_ID;
        });
        _paintAll();
        return _suggestedAvailable;
    }).catch(function () {
        _suggestedAvailable = false;
        _paintAll();
        return false;
    });
}

function openSuggestedChart() {
    if (_suggestedAvailable === false) return false;
    var play = typeof window !== 'undefined' ? window.playSong : null;
    if (typeof play !== 'function') return false;
    try { play(SUGGESTED_CHART_ID); } catch (_) { return false; }
    return true;
}

function mount(host) {
    _bindListeners();
    var target = host;
    if (!target && _doc() && typeof _doc().getElementById === 'function') {
        target = _doc().getElementById('midi-calibration-panel');
    }
    if (!target) return { ok: false, reason: 'no-host' };
    if (_inlineHost === target) {
        var existing = _views.filter(function (v) { return v.host === target && v.mode === 'inline'; })[0];
        if (existing) {
            _paintView(existing);
            return { ok: true, reused: true, root: existing.root };
        }
    }
    _inlineHost = target;
    var view = renderInto(target, { mode: 'inline', titleId: 'drums-timing-inline-title' });
    evaluateRemeasure();
    return { ok: true, root: view && view.root, view: view };
}

function closeOverlay() {
    stopMeasure();
    if (_overlay && _overlay.view) _dropView(_overlay.view);
    if (_overlay && _overlay.node && _overlay.node.parentNode) {
        try { _overlay.node.parentNode.removeChild(_overlay.node); } catch (_) { /* ignore */ }
    }
    _overlay = null;
}

function run(opts) {
    opts = opts || {};
    _bindListeners();
    var d = _doc();
    if (!d || typeof d.createElement !== 'function' || !d.body) {
        return { ok: false, reason: 'no-dom' };
    }
    if (opts.mode !== 'overlay') {
        return mount();
    }
    if (_overlay && _overlay.node) {
        _paintAll();
        return { ok: true, reused: true, requester: opts.requester || '' };
    }
    var wrap = _el('div', { className: 'drums-timing-overlay', dt: 'overlay', role: 'dialog', modal: 'true', labelledBy: 'drums-timing-overlay-title' });
    wrap.style.cssText = 'position:fixed;inset:0;z-index:80;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.6);';
    var sheet = _el('div', { className: 'drums-timing-overlay-sheet', dt: 'overlay-sheet' });
    var view = renderInto(sheet, { mode: 'overlay', titleId: 'drums-timing-overlay-title' });
    wrap.appendChild(sheet);
    d.body.appendChild(wrap);
    _overlay = { node: wrap, view: view, requester: opts.requester || '' };
    if (typeof wrap.focus === 'function') wrap.focus();
    return { ok: true, requester: _overlay.requester, root: view && view.root };
}

function resetForTests() {
    stopMeasure();
    closeOverlay();
    _views = [];
    _inlineHost = null;
    _session = null;
    _lastSummary = null;
    _remeasureOpen = false;
    _suggestedAvailable = null;
    _lastWrite = null;
    _listenersBound = false;
    _clickCtx = null;
}

var api = {
    version: VERSION,
    mount: mount,
    run: run,
    getOffsetMs: getOffsetMs,
    clampOffset: clampOffset,
    readTiming: readTiming,
    tagMatches: tagMatches,
    shouldPromptRemeasure: shouldPromptRemeasure,
    noteAllowed: noteAllowed,
    sessionSummary: sessionSummary,
    persistIfAccepted: persistIfAccepted,
    persistTiming: persistTiming,
    buildTimingPayload: buildTimingPayload,
    formatOffsetLabel: formatOffsetLabel,
    beatMarkerModel: beatMarkerModel,
    handleNoteOn: handleNoteOn,
    startMeasure: startMeasure,
    stopMeasure: stopMeasure,
    saveAnyway: saveAnyway,
    evaluateRemeasure: evaluateRemeasure,
    probeSuggestedChart: probeSuggestedChart,
    openSuggestedChart: openSuggestedChart,
    closeOverlay: closeOverlay,
    currentOrigin: currentOrigin,
    currentAudioBackend: currentAudioBackend,
    currentTag: currentTag,
    SUGGESTED_CHART_ID: SUGGESTED_CHART_ID,
    FAIL_COPY: FAIL_COPY,
    EMPTY_COPY: EMPTY_COPY,
    OFFSET_MAX_MS: OFFSET_MAX_MS,
    resetForTests: resetForTests,
    _uiState: _uiState,
    _lastWrite: function () { return _lastWrite; },
    _views: function () { return _views; },
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
        fb.drumTiming = {
            version: VERSION,
            mount: mount,
            run: run,
            getOffsetMs: getOffsetMs,
        };
        if (window.slopsmith && window.slopsmith !== fb) {
            window.slopsmith.drumTiming = fb.drumTiming;
        }
        if (window.feedback && window.feedback !== fb) {
            window.feedback.drumTiming = fb.drumTiming;
        }
    }
    if (typeof window !== 'undefined') window.feedBackDrumsTiming = api;
}

publish();

if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
}

})(typeof window !== 'undefined' ? window : this);
