// Drum Highway visualization plugin — lane-based scrolling drum
// renderer (Rock Band-style) with MIDI drum pad input, WebAudioFont
// drum kit sounds, and accuracy scoring.
//
// Wave C (slopsmith#36): per-instance refactor. Earlier Wave B
// landed setRenderer support with an explicit single-instance
// module-state assumption. Wave C lifts that: rendering, scoring,
// held-pad state, settings UI, and listeners are now all
// per-instance (closured inside createFactory). Main-player usage
// keeps its single-instance fast path via the
// window.slopsmithSplitscreen helper surface — its absence OR
// isActive()===false means "we're the only instance, always
// focused."
//
// Under splitscreen (N panels, N simultaneous drum instances):
//   - each panel hosts its own overlay canvas, scoring, settings
//     panel + gear docked inside the panel's bar
//   - MIDI input is a browser singleton; the currently-focused
//     panel (clicked most recently) is the sole recipient of
//     drum-pad note-on events
//   - focus-change clears held-pad / lane-flash state on the
//     outgoing panel
//   - _cfg.learnLane stays module-scope (per-user-intent — clicking
//     Learn in any panel assigns the next pad-hit-from-the-focused
//     device; the lane-row UI updates everywhere via class selector)
//
// song:ready event subscription is gone: each draw() edge-detects
// bundle.isReady false→true per-instance, which is correct for N
// panels without the cross-instance fan-out of the global bus.

(function () {
'use strict';

// INIT-003/SPEC-005: shared editor lives in assets/drum-editor.js.
var _drumsEditorMod = null;
var _editorLoadPromise = null;
if (typeof require === 'function' && typeof module !== 'undefined') {
    try { _drumsEditorMod = require('./assets/drum-editor.js'); } catch (_) { _drumsEditorMod = null; }
}

// INIT-004/SPEC-002: Calibration module (inline MIDI panel + overlay).
var _drumTimingMod = null;
var _drumTimingLoadPromise = null;
if (typeof require === 'function' && typeof module !== 'undefined') {
    try { _drumTimingMod = require('./assets/drum-timing.js'); } catch (_) { _drumTimingMod = null; }
}

function _getDrumEditor() {
    if (_drumsEditorMod) return _drumsEditorMod;
    if (typeof window !== 'undefined' && window.feedBackDrumsEditor) {
        _drumsEditorMod = window.feedBackDrumsEditor;
        return _drumsEditorMod;
    }
    return null;
}

function _ensureDrumEditor(cb) {
    const existing = _getDrumEditor();
    if (existing) {
        cb(existing);
        return;
    }
    if (typeof document === 'undefined' || typeof document.createElement !== 'function') {
        cb(null);
        return;
    }
    if (!_editorLoadPromise) {
        _editorLoadPromise = new Promise(function (resolve) {
            const s = document.createElement('script');
            s.src = '/api/plugins/drums/assets/drum-editor.js?v=type-pool-1';
            s.onload = function () { resolve(window.feedBackDrumsEditor || null); };
            s.onerror = function () { resolve(null); };
            (document.head || document.documentElement).appendChild(s);
        });
    }
    _editorLoadPromise.then(function (mod) {
        if (mod) _drumsEditorMod = mod;
        cb(mod);
    });
}

function _getDrumTiming() {
    if (_drumTimingMod) return _drumTimingMod;
    if (typeof window !== 'undefined' && window.feedBackDrumsTiming) {
        _drumTimingMod = window.feedBackDrumsTiming;
        return _drumTimingMod;
    }
    return null;
}

function _ensureDrumTiming(cb) {
    const existing = _getDrumTiming();
    if (existing) {
        cb(existing);
        return;
    }
    if (typeof document === 'undefined' || typeof document.createElement !== 'function') {
        cb(null);
        return;
    }
    if (!_drumTimingLoadPromise) {
        _drumTimingLoadPromise = new Promise(function (resolve) {
            const s = document.createElement('script');
            s.src = '/api/plugins/drums/assets/drum-timing.js?v=init-004-spec-002';
            s.onload = function () { resolve(window.feedBackDrumsTiming || null); };
            s.onerror = function () { resolve(null); };
            (document.head || document.documentElement).appendChild(s);
        });
    }
    _drumTimingLoadPromise.then(function (mod) {
        if (mod) _drumTimingMod = mod;
        cb(mod);
    });
}

function _publishDrumTimingFacade() {
    if (typeof window === 'undefined') return;
    window.feedBack = window.feedBack || {};
    if (window.feedBack.drumTiming && window.feedBack.drumTiming.version === 1) return;
    const live = _getDrumTiming();
    window.feedBack.drumTiming = {
        version: live && live.version ? live.version : 0,
        mount: function (host) {
            const api = _getDrumTiming();
            if (api && typeof api.mount === 'function') return api.mount(host);
            _ensureDrumTiming(function (mod) {
                if (mod && typeof mod.mount === 'function') mod.mount(host);
            });
        },
        run: function (opts) {
            const api = _getDrumTiming();
            if (api && typeof api.run === 'function') return api.run(opts);
            _ensureDrumTiming(function (mod) {
                if (mod && typeof mod.run === 'function') mod.run(opts);
            });
        },
        getOffsetMs: function () {
            const api = _getDrumTiming();
            if (api && typeof api.getOffsetMs === 'function') return api.getOffsetMs();
            return 0;
        },
    };
}

if (typeof window !== 'undefined') _publishDrumTimingFacade();

// ═══════════════════════════════════════════════════════════════════════
// Config
// ═══════════════════════════════════════════════════════════════════════

// Word-boundary match so unrelated arrangement names don't trigger
// Auto-drums via a substring hit — e.g. "Drumstick" (hypothetical)
// must NOT match "drums". The \b anchors still catch standard
// an arrangement labels cleanly: "Drums", "Drum Kit",
// "Percussion", "Electronic Drums", etc.
const DRUMS_PATTERNS = /\b(?:drums|percussion|drum\s*kit)\b/i;
// Smaller window = more vertical pixels per second = more space between
// consecutive hits. 2.0 leaves enough lookahead for fast metal (16ths at
// 170 BPM ≈ 11.3 hits/s gives 22+ visible notes ahead) while spreading
// each hit ~50% further apart than the old 3.0 default.
const VISIBLE_SECONDS = 2.0;
const NOW_LINE_Y_FRAC = 0.85;
const LANE_PAD = 1;
const KICK_LANE_EXTRA = 20;
const HIT_TOLERANCE = 0.05;        // seconds (drums need tighter timing than piano)

// ── Persisted settings ───────────────────────────────────────────────

const STORE_KEYS = {
    midiInputId:    'drums_midi_input',
    synthVolume:    'drums_synth_vol',
    midiChannel:    'drums_midi_ch',
    hitDetection:   'drums_hit_detect',
    showLaneLabels: 'drums_lane_labels',
    customMapping:  'drums_custom_map',
    // Lane preset — chooses which DRUM_LANES table the renderer uses.
    // 'phase_shift_8' (default) matches the legacy 8-lane HH/Sn/T1/T2/T3/
    // Cr/Ri/Ki layout. 'rb4' is a denser 7-lane Rock-Band-style preset.
    // Persisted via _saveCfg below.
    lanePreset:     'drums_lane_preset_v1',
};

// Valid preset ids — kept here so _saveCfg can validate before persisting
// (drums_lane_preset_v1 is user-controlled, like every other storage key
// in this plugin).
const _VALID_LANE_PRESETS = new Set(['phase_shift_8', 'rb4']);

// Safe localStorage reader — getItem can throw SecurityError in
// sandboxed iframes, under Safari on file://, or when storage is
// disabled for the origin. An unguarded throw during the _cfg
// initialiser would abort the IIFE and the plugin would never
// register its setRenderer factory. Return null on failure so the
// `|| default` fallthrough below still produces a usable value.
function _readStore(key) {
    try { return localStorage.getItem(key); } catch (_) { return null; }
}

// Numeric cfg normaliser — parseFloat/parseInt return NaN on junk
// like "foo" or "", which would propagate into AudioParam.gain.value
// (breaks playback) or MIDI channel filtering (misroutes events).
// Clamp to [min, max] when provided and fall back to the default on
// any non-finite result.
function _readNum(key, fallback, min, max) {
    const raw = _readStore(key);
    if (raw == null) return fallback;
    const n = parseFloat(raw);
    if (!Number.isFinite(n)) return fallback;
    if (min !== undefined && n < min) return min;
    if (max !== undefined && n > max) return max;
    return n;
}

// Lane ids declared here so the customMapping validator below can
// shape-check persisted user mappings. The full DRUM_LANES table
// appears further down (with colors, symbols, MIDI-note lists); the
// ids are duplicated here once because _cfg initialises before the
// DRUM_LANES block runs.
const _VALID_LANE_IDS = new Set([
    'hihat', 'snare', 'tom1', 'tom2', 'tom3', 'crash', 'ride', 'kick',
]);

// Validate a customMapping object loaded from localStorage. Storage
// is user-controlled (manual edits, another plugin, synced profiles),
// so parsing the raw JSON is NOT enough — we need to reject
// non-object / array inputs, strip __proto__ / constructor /
// prototype keys to block prototype-pollution, and drop any
// (key, value) pair that isn't (MIDI note 0-127, known lane id).
// Returns a clean null-prototype object, or null if nothing survives.
function _validateCustomMapping(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const clean = Object.create(null);
    let hasEntries = false;
    for (const key of Object.keys(raw)) {
        if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
        const midi = parseInt(key, 10);
        if (!Number.isFinite(midi) || midi < 0 || midi > 127) continue;
        const val = raw[key];
        if (typeof val !== 'string' || !_VALID_LANE_IDS.has(val)) continue;
        clean[midi] = val;
        hasEntries = true;
    }
    return hasEntries ? clean : null;
}

// INIT-001/SPEC-005: kit JSON and vocabulary are untrusted. Piece-id maps
// live in core kit records, never in the legacy drums_custom_map store.
const _PIECE_ID_RE = /^[a-z][a-z0-9_]*$/;
const _KIT_ID_RE = /^[a-z0-9-]+$/;
const _DEVICE_ID_RE = /^[a-z0-9-]+$/;
const _DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function _isSafeKey(key) {
    return typeof key === 'string' && !_DANGEROUS_KEYS.has(key);
}

function _isPieceId(id) {
    return typeof id === 'string' && _PIECE_ID_RE.test(id) && _isSafeKey(id);
}

function _parseMidiNote(value) {
    const n = typeof value === 'number' ? value : parseInt(value, 10);
    if (!Number.isInteger(n) || n < 0 || n > 127) return null;
    return n;
}

function _escapeHtml(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function _eventTimeStamp(e) {
    const ts = e && e.timeStamp;
    return (typeof ts === 'number' && Number.isFinite(ts)) ? ts : 0;
}

// Fallback piece-id → lane-id, mirroring core PRESETS. Vocabulary presets
// overlay this when GET /api/drums/vocabulary succeeds. ekit_full is out
// of scope as a lane preset (lane-id model cannot express one-lane-per-piece).
const _FALLBACK_PIECE_TO_LANE = {
    phase_shift_8: {
        hh_closed: 'hihat', hh_open: 'hihat', hh_pedal: 'hihat',
        snare: 'snare', snare_xstick: 'snare',
        tom_hi: 'tom1', tom_mid: 'tom2', tom_low: 'tom3', tom_floor: 'tom3',
        crash_l: 'crash', crash_r: 'crash', splash: 'crash', china: 'crash', stack: 'crash',
        ride: 'ride', ride_bell: 'ride', bell: 'ride',
        kick: 'kick',
    },
    rb4: {
        hh_closed: 'hihat', hh_open: 'hihat', hh_pedal: 'hihat',
        snare: 'snare', snare_xstick: 'snare',
        tom_hi: 'tom1', tom_mid: 'tom1', tom_low: 'tom3', tom_floor: 'tom3',
        crash_l: 'crash', crash_r: 'crash', splash: 'crash', china: 'crash', stack: 'crash',
        ride: 'ride', ride_bell: 'ride', bell: 'ride',
        kick: 'kick',
    },
};

let _knownPieceIds = new Set(Object.keys(_FALLBACK_PIECE_TO_LANE.phase_shift_8));
let _pieceToLaneByPreset = {
    phase_shift_8: Object.assign(Object.create(null), _FALLBACK_PIECE_TO_LANE.phase_shift_8),
    rb4: Object.assign(Object.create(null), _FALLBACK_PIECE_TO_LANE.rb4),
};
let _vocabMidiToPiece = null;   // GM midi→piece from vocabulary (null = use PIECE_DEFAULT_MIDI)
let _kitNotes = null;           // legacy kit overlay (not scoring SoT after INIT-003/SPEC-012)
let _kitList = [];              // [{id, name, manufacturer, source, notes}]
let _activeKitId = null;
let _pendingKitId = '';
let _kitSuggestId = null;
let _pendingPieceNotes = null;  // piece-id map accumulated by Learn until PUT
// INIT-003/SPEC-012: attached MIDI device notes are the scoring overlay SoT.
let _attachedDeviceId = '';
let _deviceNotes = null;
let _deviceRefetchSeq = 0;
let _midiDeviceScoringBound = false;
// INIT-002/SPEC-003: generation tokens so a stale confirm/refetch cannot
// enable mapping controls for a newer kit selection.
let _kitConfirmSeq = 0;
let _kitRefetchSeq = 0;
let _drumInputUnsub = null;     // shared-contract subscribe cleanup
let _lastRemoval = null;        // { kitId, midiNote, pieceId, laneId } for Undo
let _mapStatusText = '';
let _mapStatusAllowUndo = false;
let _applyingSharedSettings = false;
let _midiStateHandler = null;

function _knownPieces() {
    return _knownPieceIds;
}

// Piece-id map helper. Accepts MIDI 0–127 keys whose values are known
// piece-ids. Strips prototype-pollution keys. Unknown piece-ids are skipped
// (never executed). Returns a null-prototype object, or null if empty.
function _validatePieceMapping(raw, knownIds) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const known = knownIds || _knownPieceIds;
    const clean = Object.create(null);
    let hasEntries = false;
    for (const key of Object.keys(raw)) {
        if (!_isSafeKey(key)) continue;
        const midi = _parseMidiNote(key);
        if (midi === null) continue;
        const val = raw[key];
        if (!_isPieceId(val)) continue;
        if (known && known.size && !known.has(val)) continue;
        clean[midi] = val;
        hasEntries = true;
    }
    return hasEntries ? clean : null;
}

function _parseKitNotes(kit) {
    if (!kit || typeof kit !== 'object' || Array.isArray(kit)) return null;
    return _validatePieceMapping(kit.notes, _knownPieceIds);
}

function _parseVocabulary(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const pieces = raw.pieces;
    if (!pieces || typeof pieces !== 'object' || Array.isArray(pieces)) return null;
    const ids = new Set();
    const midiMap = Object.create(null);
    const keys = Object.keys(pieces);
    const cap = Math.min(keys.length, 64);
    for (let i = 0; i < cap; i++) {
        const id = keys[i];
        if (!_isPieceId(id)) continue;
        ids.add(id);
        const spec = pieces[id];
        const midiList = spec && Array.isArray(spec.midi) ? spec.midi : [];
        const nCap = Math.min(midiList.length, 16);
        for (let j = 0; j < nCap; j++) {
            const n = _parseMidiNote(midiList[j]);
            if (n !== null && midiMap[n] === undefined) midiMap[n] = id;
        }
    }
    if (!ids.size) return null;
    const pieceToLane = {
        phase_shift_8: Object.assign(Object.create(null), _FALLBACK_PIECE_TO_LANE.phase_shift_8),
        rb4: Object.assign(Object.create(null), _FALLBACK_PIECE_TO_LANE.rb4),
    };
    const presets = raw.presets;
    if (presets && typeof presets === 'object' && !Array.isArray(presets)) {
        for (const presetName of ['phase_shift_8', 'rb4']) {
            const lanes = presets[presetName];
            if (!Array.isArray(lanes)) continue;
            const map = Object.assign(Object.create(null), pieceToLane[presetName]);
            for (const lane of lanes) {
                if (!lane || typeof lane !== 'object' || Array.isArray(lane)) continue;
                const plist = Array.isArray(lane.pieces) ? lane.pieces : [];
                const primary = plist.find(_isPieceId);
                const laneId = primary ? (pieceToLane[presetName][primary] || null) : null;
                if (!laneId || !_VALID_LANE_IDS.has(laneId)) continue;
                for (const pid of plist) {
                    if (!_isPieceId(pid)) continue;
                    map[pid] = laneId;
                }
            }
            pieceToLane[presetName] = map;
        }
    }
    return { ids, midiMap, pieceToLane };
}

function _applyVocabulary(payload) {
    const parsed = _parseVocabulary(payload);
    if (!parsed) return false;
    _knownPieceIds = parsed.ids;
    _vocabMidiToPiece = parsed.midiMap;
    _pieceToLaneByPreset = parsed.pieceToLane;
    return true;
}

function _applyActiveKitNotes(kit) {
    if (kit == null) {
        _kitNotes = null;
        return false;
    }
    const overlay = _parseKitNotes(kit);
    _kitNotes = overlay || Object.create(null);
    return overlay !== null;
}

function _midiDevicesApi() {
    const fb = (typeof window !== 'undefined')
        ? (window.feedBack || window.feedback || window.slopsmith)
        : null;
    const api = fb && fb.midiDevices;
    if (!api || typeof api !== 'object') return null;
    if (typeof api.get !== 'function' && typeof api.list !== 'function') return null;
    return api;
}

function _normalizeAttachedDeviceId(raw) {
    if (typeof raw !== 'string' || !raw) return '';
    return _DEVICE_ID_RE.test(raw) ? raw : '';
}

function _applyDeviceNotes(device) {
    if (!device || typeof device !== 'object' || Array.isArray(device)) {
        _deviceNotes = null;
        return false;
    }
    const overlay = _validatePieceMapping(device.notes, _knownPieceIds);
    _deviceNotes = overlay;
    return overlay !== null;
}

function _clearAttachedDevice() {
    _attachedDeviceId = '';
    _deviceNotes = null;
}

async function _refetchAttachedDevice(deviceId) {
    const id = _normalizeAttachedDeviceId(deviceId != null ? deviceId : _attachedDeviceId);
    if (!id) {
        _clearAttachedDevice();
        return null;
    }
    _attachedDeviceId = id;
    const myGen = ++_deviceRefetchSeq;
    const api = _midiDevicesApi();
    let device = null;
    if (api && typeof api.get === 'function') {
        try { device = await api.get.call(api, id); } catch (_) { device = null; }
    } else if (typeof fetch === 'function') {
        try {
            const res = await fetch('/api/midi/devices/' + encodeURIComponent(id));
            if (res && res.ok) {
                try { device = await res.json(); } catch (_) { device = null; }
            }
        } catch (_) { device = null; }
    }
    if (myGen !== _deviceRefetchSeq) return null;
    if (_attachedDeviceId !== id) return null;
    _applyDeviceNotes(device);
    if (device && device.input && typeof device.input === 'object') {
        const input = device.input;
        const patch = {};
        if (typeof input.midi_channel === 'number') patch.midiChannel = input.midi_channel;
        if (typeof input.hit_detection === 'boolean') patch.hitDetection = input.hit_detection;
        if (typeof input.synth_volume === 'number') patch.synthVolume = input.synth_volume;
        if (Object.keys(patch).length) _setSharedSetting(patch);
    }
    const src = device && typeof device.source_id === 'string' ? device.source_id : '';
    if (src && (!_midiInput || _midiInput.key !== src)) _midiConnect(src);
    else if (!src && _midiInput) _midiConnect('');
    return device;
}

function _onMidiDeviceChange(ev) {
    const detail = (ev && ev.detail) || ev || {};
    const eventId = _normalizeAttachedDeviceId(detail.device_id);
    if (!_attachedDeviceId) return;
    if (eventId && eventId !== _attachedDeviceId) return;
    _refetchAttachedDevice(_attachedDeviceId);
}

function _bindMidiDeviceScoring() {
    if (_midiDeviceScoringBound) return;
    if (typeof window === 'undefined') return;
    _midiDeviceScoringBound = true;
    window.__feedBackDrumsMidiDeviceHook = true;
    const api = _midiDevicesApi();
    if (api && typeof api.subscribe === 'function') {
        api.subscribe(_onMidiDeviceChange);
        return;
    }
    if (typeof document !== 'undefined' && document.addEventListener) {
        document.addEventListener('feedback:midi-device-change', _onMidiDeviceChange);
    }
    const fb = window.feedBack || window.feedback || window.slopsmith;
    if (fb && typeof fb.on === 'function') fb.on('feedback:midi-device-change', _onMidiDeviceChange);
}

function _pieceToLaneId(piece, presetName) {
    if (!_isPieceId(piece)) return null;
    const preset = presetName || _cfg.lanePreset;
    const table = _pieceToLaneByPreset[preset] || _pieceToLaneByPreset.phase_shift_8;
    const laneId = table[piece];
    return (typeof laneId === 'string' && _VALID_LANE_IDS.has(laneId)) ? laneId : null;
}

function _primaryPieceForLane(laneId, presetName) {
    const preset = presetName || _cfg.lanePreset;
    const table = _pieceToLaneByPreset[preset] || _pieceToLaneByPreset.phase_shift_8;
    for (const pid of _knownPieceIds) {
        if (table[pid] === laneId) return pid;
    }
    return null;
}

function _deriveLaneMapFromPieces(pieceMap, presetName) {
    if (!pieceMap) return null;
    const clean = Object.create(null);
    let hasEntries = false;
    for (const key of Object.keys(pieceMap)) {
        if (!_isSafeKey(key)) continue;
        const midi = _parseMidiNote(key);
        if (midi === null) continue;
        const laneId = _pieceToLaneId(pieceMap[key], presetName);
        if (!laneId) continue;
        clean[midi] = laneId;
        hasEntries = true;
    }
    return hasEntries ? clean : null;
}

function _mergeLaneMapAdditive(existing, midi, laneId) {
    const n = _parseMidiNote(midi);
    if (n === null || !_VALID_LANE_IDS.has(laneId)) return existing || null;
    const merged = Object.assign(Object.create(null), existing || {});
    merged[n] = laneId;
    return _validateCustomMapping(merged);
}

function _suggestKitsForSource(logicalSourceKey, kits) {
    // Match against logicalSourceKey only — never raw device labels.
    if (typeof logicalSourceKey !== 'string' || !logicalSourceKey) return [];
    const key = logicalSourceKey.toLowerCase();
    const list = Array.isArray(kits) ? kits : [];
    const out = [];
    for (const kit of list) {
        if (!kit || typeof kit !== 'object') continue;
        const id = typeof kit.id === 'string' ? kit.id : '';
        if (!_KIT_ID_RE.test(id)) continue;
        const manufacturer = typeof kit.manufacturer === 'string' ? kit.manufacturer : '';
        const tokens = [id, manufacturer.toLowerCase().replace(/\s+/g, '-')].filter(Boolean);
        if (tokens.some(t => t.length >= 4 && key.indexOf(t) !== -1)) out.push(id);
    }
    return out;
}

function _sanitizeKitList(raw) {
    const kits = raw && Array.isArray(raw.kits) ? raw.kits : (Array.isArray(raw) ? raw : []);
    const out = [];
    const cap = Math.min(kits.length, 64);
    for (let i = 0; i < cap; i++) {
        const kit = kits[i];
        if (!kit || typeof kit !== 'object' || Array.isArray(kit)) continue;
        const id = kit.id;
        if (typeof id !== 'string' || !_KIT_ID_RE.test(id)) continue;
        out.push({
            id,
            name: typeof kit.name === 'string' && kit.name ? kit.name : id,
            manufacturer: typeof kit.manufacturer === 'string' ? kit.manufacturer : '',
            source: kit.source === 'user' ? 'user' : 'shipped',
            notes: kit.notes,
        });
    }
    return out;
}

const _cfg = {
    midiInputId:    _readStore(STORE_KEYS.midiInputId) || '',
    synthVolume:    _readNum(STORE_KEYS.synthVolume, 0.7, 0, 1),
    // -1 = all, 0..15 are the 16 MIDI channels (9 = "ch10" Drums)
    midiChannel:    Math.round(_readNum(STORE_KEYS.midiChannel, -1, -1, 15)),
    hitDetection:   _readStore(STORE_KEYS.hitDetection) === 'true',
    showLaneLabels: _readStore(STORE_KEYS.showLaneLabels) !== 'false',
    customMapping:  (function () {
        try {
            const raw = JSON.parse(_readStore(STORE_KEYS.customMapping) || 'null');
            return _validateCustomMapping(raw);
        } catch (_) { return null; }
    })(),
    lanePreset:     (function () {
        const raw = _readStore(STORE_KEYS.lanePreset);
        return _VALID_LANE_PRESETS.has(raw) ? raw : 'phase_shift_8';
    })(),
    // Transient: which lane is in learn mode. Module-scope across
    // panels — the Learn-mode UX is "click Learn in any panel, then
    // hit a pad on the focused MIDI device." The next focused-panel
    // drum-hit consumes the sentinel and remaps. Per-panel learnLane
    // would imply N independent in-flight remap operations, which is
    // surprising when there's only one user + one MIDI kit.
    learnLane:      null,
    // INIT-001/SPEC-005: Learn-on-pieces sentinel. Hit-to-assign writes
    // a piece-id into the core kit and a derived lane id into the
    // legacy store. Keyboard is not required to assign.
    learnPiece:     null,
};

function _saveCfg(key, val) {
    // Apply the same shape validation the _cfg initialiser uses so
    // anything we write to localStorage is also trustworthy on next
    // load. Belt-and-suspenders — Learn-mode builds its map from
    // Object.assign({}, _getActiveDrumMap()) + a fresh midi+laneId
    // pair, so input is already well-formed, but routing through
    // the validator means any future caller can't accidentally
    // persist garbage.
    if (key === 'customMapping' && val !== null) {
        val = _validateCustomMapping(val);
    }
    if (key === 'lanePreset' && !_VALID_LANE_PRESETS.has(val)) {
        val = 'phase_shift_8';
    }
    _cfg[key] = val;
    const storeKey = STORE_KEYS[key];
    if (!storeKey) return;
    const serialised = typeof val === 'object' && val !== null
        ? JSON.stringify(val) : String(val);
    try { localStorage.setItem(storeKey, serialised); } catch (_) {}
}

// Host page globals. Plugins run in the core app's page context, so
// `window.feedBack` (with `window.slopsmith` / `window.feedback` aliases)
// is the existing bridge — never a cross-repo import (GR-004).
function _host() {
    return window.feedBack || window.slopsmith || window.feedback || null;
}

function _drumInput() {
    const h = _host();
    const di = h && h.drumInput;
    return (di && di.version === 1) ? di : null;
}

function _selectedKitId() {
    return _pendingKitId || _activeKitId || '';
}

function _mappingMutationsEnabled() {
    return Boolean(_activeKitId && _KIT_ID_RE.test(_activeKitId) && _selectedKitId() === _activeKitId);
}

function _pieceDisplayName(pieceId) {
    if (!_isPieceId(pieceId)) return '';
    const label = pieceId.replace(/_/g, ' ');
    return label.charAt(0).toUpperCase() + label.slice(1);
}

function _gmMidiNotesForPiece(pieceId) {
    const out = [];
    if (!_isPieceId(pieceId)) return out;
    if (_vocabMidiToPiece) {
        for (const [midi, pid] of Object.entries(_vocabMidiToPiece)) {
            if (pid !== pieceId) continue;
            const n = _parseMidiNote(midi);
            if (n !== null) out.push(n);
        }
    } else if (Object.prototype.hasOwnProperty.call(PIECE_DEFAULT_MIDI, pieceId)) {
        out.push(PIECE_DEFAULT_MIDI[pieceId]);
    }
    out.sort((a, b) => a - b);
    return out;
}

function _customMidiNotesForPiece(pieceId) {
    const out = [];
    if (!_kitNotes || !_isPieceId(pieceId)) return out;
    for (const [midi, pid] of Object.entries(_kitNotes)) {
        if (pid !== pieceId) continue;
        const n = _parseMidiNote(midi);
        if (n !== null) out.push(n);
    }
    out.sort((a, b) => a - b);
    return out;
}

function _dropLegacyNote(midiNote) {
    const n = _parseMidiNote(midiNote);
    if (n === null || !_cfg.customMapping) return;
    const next = Object.assign(Object.create(null), _cfg.customMapping);
    delete next[n];
    const cleaned = _validateCustomMapping(next);
    _saveCfg('customMapping', cleaned);
}

function _announceMapStatus(text, allowUndo) {
    _mapStatusText = typeof text === 'string' ? text : '';
    _mapStatusAllowUndo = Boolean(allowUndo) && Boolean(_lastRemoval);
    _refreshMapStatus();
}

function _notifyMappingChange(payload) {
    const di = _drumInput();
    if (!di || typeof di.notifyMappingChange !== 'function') return null;
    try { return di.notifyMappingChange(payload); } catch (_) { return null; }
}

function _setSharedSetting(partial) {
    if (!partial || typeof partial !== 'object') return;
    if (partial.synthVolume !== undefined) {
        _cfg.synthVolume = partial.synthVolume;
        if (_synthGain) _synthGain.gain.value = partial.synthVolume;
    }
    if (partial.midiChannel !== undefined) _cfg.midiChannel = partial.midiChannel;
    if (partial.hitDetection !== undefined) _cfg.hitDetection = partial.hitDetection;
    if (_applyingSharedSettings) return;
    const di = _drumInput();
    if (di && typeof di.update === 'function') {
        try { di.update(partial); } catch (_) { /* contract must not break settings */ }
        return;
    }
    if (partial.synthVolume !== undefined) _saveCfg('synthVolume', partial.synthVolume);
    if (partial.midiChannel !== undefined) _saveCfg('midiChannel', partial.midiChannel);
    if (partial.hitDetection !== undefined) _saveCfg('hitDetection', partial.hitDetection);
}

function _applySharedSettings(state) {
    if (!state || typeof state !== 'object') return;
    _applyingSharedSettings = true;
    try {
        if (typeof state.synthVolume === 'number') {
            _cfg.synthVolume = state.synthVolume;
            if (_synthGain) _synthGain.gain.value = state.synthVolume;
            if (typeof document !== 'undefined' && document.querySelectorAll) {
                document.querySelectorAll('.drums-vol-slider').forEach(el => {
                    el.value = String(Math.round(state.synthVolume * 100));
                });
            }
        }
        if (typeof state.midiChannel === 'number') {
            _cfg.midiChannel = state.midiChannel;
            if (typeof document !== 'undefined' && document.querySelectorAll) {
                document.querySelectorAll('.drums-channel-select').forEach(el => {
                    el.value = String(state.midiChannel);
                });
            }
        }
        if (typeof state.hitDetection === 'boolean') {
            _cfg.hitDetection = state.hitDetection;
            if (typeof document !== 'undefined' && document.querySelectorAll) {
                document.querySelectorAll('.drums-chk-hits').forEach(el => {
                    el.checked = state.hitDetection;
                });
            }
        }
        if (typeof state.deviceEnabled === 'boolean') {
            if (!state.deviceEnabled) {
                if (_midiInput) _midiConnect('');
            } else if (!_midiInput) {
                const mi = _mi();
                const selected = mi && typeof mi.getSelected === 'function' ? mi.getSelected() : null;
                const key = (selected && (selected.logicalSourceKey || selected.key)) || _cfg.midiInputId;
                if (key) _midiConnect(key);
            }
            if (typeof document !== 'undefined' && document.querySelectorAll && !state.deviceEnabled) {
                document.querySelectorAll('.drums-midi-select').forEach(el => { el.value = ''; });
            }
        }
    } finally {
        _applyingSharedSettings = false;
    }
}

function _onDrumInputChange(detail) {
    if (!detail || detail.version !== 1) return null;
    if (detail.mutation === 'set' || detail.mutation === 'delete') {
        return _refetchActiveKit();
    }
    const di = _drumInput();
    const state = di && typeof di.get === 'function' ? di.get() : detail;
    _applySharedSettings(state);
    return null;
}

function _bindDrumInputContract() {
    if (_drumInputUnsub) return _drumInputUnsub;
    const di = _drumInput();
    if (!di) return null;
    if (typeof di.get === 'function') {
        try { _applySharedSettings(di.get()); } catch (_) { /* degrade-noop */ }
    }
    if (typeof di.subscribe === 'function') {
        _drumInputUnsub = di.subscribe(_onDrumInputChange);
    }
    return _drumInputUnsub;
}

function _unbindDrumInputContract() {
    if (typeof _drumInputUnsub === 'function') {
        try { _drumInputUnsub(); } catch (_) { /* best-effort */ }
    }
    _drumInputUnsub = null;
}

function _drumInputSubscriberCount() {
    return _drumInputUnsub ? 1 : 0;
}

function _noteEndpoint(kitId, midiNote) {
    return '/api/drums/kits/' + encodeURIComponent(kitId) + '/notes/' + encodeURIComponent(String(midiNote));
}

// ═══════════════════════════════════════════════════════════════════════
// Module-level singletons (browser-unique resources)
// ═══════════════════════════════════════════════════════════════════════

// ── MIDI input ────────────────────────────────────────────────────────
// MIDI is sourced from the core `midi-input` capability domain
// (window.slopsmith.midiInput) rather than a private requestMIDIAccess() — one
// device-access boundary shared with piano/keys/onboarding.
let _midiReady = false;      // discover() has run
let _midiHandle = null;      // live domain session handle (addListener/removeListener)
let _midiListener = null;    // the addListener callback wrapping _midiOnMessage
let _midiStateSub = false;   // subscribed to midi-input:sources-changed
let _midiInput = null;       // selected source descriptor { id, name, key }
let _midiConnectSeq = 0;     // generation guard for async _midiConnect races
// Gates the live listener wiring. init() flips true via _midiResumeHandler
// and destroy() flips false via _midiPauseHandler. Because _midiConnect is
// async, an open() begun in init() can resolve AFTER destroy() has run — the
// resulting addListener would otherwise re-wire scoring/synth on a
// no-longer-visible renderer. Every callsite that would attach the listener
// consults this flag first.
let _midiActive = false;
// Wave C: routes incoming MIDI events to the currently-focused drum
// instance (null when no instance is active). Instances claim this
// on focus-change and release it on defocus / destroy.
let _activeInstance = null;
// Registry of live factory instances so module-level helpers (device-
// list refresh, shutdown-when-last-destroys) can iterate.
const _instances = new Set();
// Monotonic id for per-instance DOM tagging (useful for debugging).
let _nextInstanceId = 0;

// ── Synth ─────────────────────────────────────────────────────────────
let _audioCtx = null;
let _synthPlayer = null;
let _synthGain = null;
let _synthLoading = false;
let _playerScriptLoaded = false;
const _drumPresets = {};           // midiNote -> preset

// ═══════════════════════════════════════════════════════════════════════
// MIDI / Drum Mapping
// ═══════════════════════════════════════════════════════════════════════

function noteToMidi(string, fret) { return string * 24 + fret; }

// ── Piece-id ↔ MIDI (mirrors lib/drums.py::PIECES) ──────────────────
//
// Default GM MIDI for each canonical piece-id. The mapped value is the
// "preferred" MIDI we synthesize when a drum_tab.json hit names this
// piece-id — it then flows through the legacy {string, fret}
// MIDI-encoding pipeline unchanged (`midi = string * 24 + fret`).
// Hi-hat openness is preserved as distinct piece-ids (hh_closed=42,
// hh_open=46, hh_pedal=44) so the renderer's open-vs-closed visual
// dispatch keeps working from the synthesised note's MIDI alone.
const PIECE_DEFAULT_MIDI = {
    kick:         36,
    snare:        38,
    snare_xstick: 37,
    tom_hi:       50,
    tom_mid:      47,
    tom_low:      43,
    tom_floor:    41,
    hh_closed:    42,
    hh_open:      46,
    hh_pedal:     44,
    crash_l:      49,
    crash_r:      57,
    splash:       55,
    china:        52,
    ride:         51,
    ride_bell:    53,
    // Vocabulary fetch overlays these; kept here so offline drum_tab
    // hits naming stack/bell still convert. GM: 30 unused, 80 mute triangle.
    stack:        30,
    bell:         80,
};

// Convert a drum_tab.hits[] payload into the legacy {t, s, f, ac, mt}
// note objects the renderer already understands. Velocity ≥ 100 →
// accent (renders larger + brighter glow). Ghost notes carry `mt: true`
// (intent for dimming/shrinking — not yet consumed by the renderer). Flams
// emit a small leading grace note 30 ms ahead so the user sees the
// characteristic two-tap shape. Unknown piece-ids are dropped — better
// silent than a mis-rendered piece on an outdated client.
function _drumTabHitsToNotes(hits) {
    if (!Array.isArray(hits)) return [];
    const out = [];
    for (const h of hits) {
        const piece = h && h.p;
        // Use hasOwnProperty guard to prevent prototype-poisoning: if h.p is
        // '__proto__', 'constructor', etc., the plain-object lookup would
        // return an inherited value instead of undefined.
        if (!Object.prototype.hasOwnProperty.call(PIECE_DEFAULT_MIDI, piece)) continue;
        const midi = PIECE_DEFAULT_MIDI[piece];
        const v = (typeof h.v === 'number') ? h.v : 100;
        const t = +h.t;
        // Skip hits with missing or non-finite timestamps — rendering at t=0
        // by default would score bogus notes at the song start.
        if (!Number.isFinite(t) || t < 0) continue;
        const note = {
            t,
            s: (midi / 24) | 0,
            f: midi % 24,
            ac: v >= 100,
            mt: !!h.g,        // ghost — carries intent for renderer (dim/small); TODO: wire up
            _piece: piece,    // carried for future rendering/debug use
            _vel: v,
        };
        if (h.f) {
            // Leading flam grace note 30 ms ahead. mt:true and _vel carry
            // intent for a future smaller/dimmer rendering pass; currently
            // the note renders at normal size. _noScore:true is the only
            // active field — it excludes the grace from miss-counting and
            // from consuming the hit window (the player strikes the main hit).
            out.push({
                t: Math.max(0, t - 0.030),
                s: note.s, f: note.f,
                ac: false,
                mt: true,
                _piece: piece,
                _vel: Math.max(20, ((v * 0.5) | 0)),
                _noScore: true,
            });
        }
        out.push(note);
    }
    out.sort((a, b) => a.t - b.t);
    return out;
}

function _noteKey(time, midi) {
    return time.toFixed(3) + '|' + midi;
}

// Lane preset table — the user picks via the settings panel (PR6). The
// `phase_shift_8` default matches v3's legacy 8-lane HH/Sn/T1/T2/T3/Cr/
// Ri/Ki layout so existing setups are untouched. `rb4` collapses to a
// 7-lane Rock-Band-style layout that several community members asked for
// (single tom-pair lane, merged cymbals, no x-stick / pedal-hat split).
const LANE_PRESETS = {
    phase_shift_8: [
        { id: 'hihat',  label: 'HH', midiNotes: [42, 44, 46], color: [0.3, 0.6, 1.0], symbol: 'x'      },
        { id: 'snare',  label: 'Sn', midiNotes: [38, 40, 37], color: [1.0, 0.9, 0.2], symbol: 'circle' },
        { id: 'tom1',   label: 'T1', midiNotes: [48, 50],     color: [0.3, 1.0, 0.3], symbol: 'square' },
        { id: 'tom2',   label: 'T2', midiNotes: [45, 47],     color: [1.0, 0.6, 0.1], symbol: 'circle_dot' },
        { id: 'tom3',   label: 'T3', midiNotes: [41, 43, 58], color: [0.7, 0.4, 1.0], symbol: 'square_dot' },
        { id: 'crash',  label: 'Cr', midiNotes: [49, 57, 55, 52], color: [0.2, 0.9, 0.9], symbol: 'diamond' },
        { id: 'ride',   label: 'Ri', midiNotes: [51, 59, 53], color: [0.9, 0.9, 0.9], symbol: 'hexagon' },
        { id: 'kick',   label: 'Ki', midiNotes: [35, 36],     color: [1.0, 0.2, 0.3], symbol: 'bar'    },
    ],
    rb4: [
        { id: 'hihat',  label: 'HH', midiNotes: [42, 44, 46], color: [0.3, 0.6, 1.0], symbol: 'x'      },
        { id: 'snare',  label: 'Sn', midiNotes: [38, 40, 37], color: [1.0, 0.9, 0.2], symbol: 'circle' },
        { id: 'tom1',   label: 'T',  midiNotes: [48, 50, 45, 47], color: [0.3, 1.0, 0.3], symbol: 'square' },
        { id: 'tom3',   label: 'FT', midiNotes: [41, 43, 58], color: [0.7, 0.4, 1.0], symbol: 'square_dot' },
        { id: 'crash',  label: 'Cr', midiNotes: [49, 57, 55, 52], color: [0.2, 0.9, 0.9], symbol: 'diamond' },
        { id: 'ride',   label: 'Ri', midiNotes: [51, 59, 53], color: [0.9, 0.9, 0.9], symbol: 'hexagon' },
        { id: 'kick',   label: 'Ki', midiNotes: [35, 36],     color: [1.0, 0.2, 0.3], symbol: 'bar'    },
    ],
};

// Live lane table — mutated in place by _applyLanePreset so existing
// references (closures, _computeLaneLayout, _midiToLane builders) keep
// pointing at the same array object after a preset swap.
const DRUM_LANES = [];
const _midiToLane = {};

function _applyLanePreset(presetName) {
    const preset = LANE_PRESETS[presetName] || LANE_PRESETS.phase_shift_8;
    DRUM_LANES.length = 0;
    for (const lane of preset) DRUM_LANES.push(lane);
    for (const k of Object.keys(_midiToLane)) delete _midiToLane[k];
    DRUM_LANES.forEach((lane, idx) => {
        lane.midiNotes.forEach(n => { _midiToLane[n] = idx; });
    });
}
_applyLanePreset(_cfg.lanePreset);

function _getActiveDrumMap() {
    // INIT-001/SPEC-005: when a core kit is active, the settings table
    // shows the derived lane view of that piece-id map. Otherwise the
    // legacy lane-keyed customMapping (or GM default) is shown.
    const activeLaneIds = new Set(DRUM_LANES.map(l => l.id));
    if (_kitNotes) {
        const derived = _deriveLaneMapFromPieces(_kitNotes);
        const filtered = {};
        if (derived) {
            for (const [midi, laneId] of Object.entries(derived)) {
                if (activeLaneIds.has(laneId)) filtered[midi] = laneId;
            }
        }
        return filtered;
    }
    if (_cfg.customMapping) {
        const filtered = {};
        for (const [midi, laneId] of Object.entries(_cfg.customMapping)) {
            if (activeLaneIds.has(laneId)) filtered[midi] = laneId;
        }
        return filtered;
    }
    const result = {};
    for (const [midi, laneIdx] of Object.entries(_midiToLane)) {
        const lane = DRUM_LANES[laneIdx];
        if (lane) result[midi] = lane.id;
    }
    return result;
}

function _midiToLaneIdx(midiNote) {
    // INIT-003/SPEC-012: attached MIDI device notes are scoring SoT.
    // Empty device_id or empty/unmapped notes → unmapped (no GM / kit fallback).
    // Chart highway still uses _songNoteToLaneIdx / lane presets.
    if (!_attachedDeviceId || !_deviceNotes) return -1;
    const piece = _deviceNotes[midiNote];
    if (piece) {
        const laneId = _pieceToLaneId(piece);
        if (laneId) {
            const idx = DRUM_LANES.findIndex(l => l.id === laneId);
            if (idx >= 0) return idx;
        }
    }
    return -1;
}

function _songNoteToLaneIdx(midi) {
    return _midiToLane[midi] !== undefined ? _midiToLane[midi] : -1;
}

// ═══════════════════════════════════════════════════════════════════════
// Color helper
// ═══════════════════════════════════════════════════════════════════════

function _rgbStr(r, g, b, a) {
    return a !== undefined
        ? `rgba(${(r * 255) | 0},${(g * 255) | 0},${(b * 255) | 0},${a})`
        : `rgb(${(r * 255) | 0},${(g * 255) | 0},${(b * 255) | 0})`;
}

// ═══════════════════════════════════════════════════════════════════════
// Script loader
// ═══════════════════════════════════════════════════════════════════════

function _loadScript(url) {
    return new Promise((resolve, reject) => {
        if (document.querySelector(`script[src="${url}"]`)) { resolve(); return; }
        const s = document.createElement('script');
        s.src = url;
        s.onload = resolve;
        s.onerror = () => reject(new Error('Failed to load ' + url));
        document.head.appendChild(s);
    });
}

// ═══════════════════════════════════════════════════════════════════════
// WebAudioFont drum kit synthesizer (module-level — one audio context per tab)
// ═══════════════════════════════════════════════════════════════════════

const WAF_BASE = 'https://surikov.github.io/webaudiofontdata/sound/';
const WAF_PLAYER_URL = 'https://surikov.github.io/webaudiofont/npm/dist/WebAudioFontPlayer.js';
const WAF_SF = 'JCLive_sf2_file';

// MIDI notes that the WebAudioFont synth preloads samples for. Includes
// all notes that appear in any LANE_PRESETS midiNotes array so that
// hits on cross-stick (37), china/splash cymbals (52/55), ride bell (53),
// and alternate tom3 (58) produce audio rather than scoring silently.
const DRUM_MIDI_NOTES = [35, 36, 37, 38, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51, 52, 53, 55, 57, 58, 59];

function _drumWafVar(note)  { return '_drum_' + note + '_0_' + WAF_SF; }
function _drumWafUrl(note)  { return WAF_BASE + '128' + note + '_0_' + WAF_SF + '.js'; }

async function _synthInit() {
    if (_synthPlayer) return;
    try {
        if (!_playerScriptLoaded) {
            await _loadScript(WAF_PLAYER_URL);
            _playerScriptLoaded = true;
        }
        if (typeof WebAudioFontPlayer === 'undefined') return;

        _audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        _synthGain = _audioCtx.createGain();
        _synthGain.gain.value = _cfg.synthVolume;
        _synthGain.connect(_audioCtx.destination);
        _synthPlayer = new WebAudioFontPlayer();

        await _synthLoadDrumKit();
    } catch (e) {
        console.warn('[Drums] Synth init failed:', e);
    }
}

async function _synthLoadDrumKit() {
    if (!_synthPlayer || !_audioCtx) return;
    _synthLoading = true;

    const promises = DRUM_MIDI_NOTES.map(async (note) => {
        const varName = _drumWafVar(note);
        try {
            if (!window[varName]) {
                await _loadScript(_drumWafUrl(note));
            }
            const preset = window[varName];
            if (preset) {
                _synthPlayer.adjustPreset(_audioCtx, preset);
                _drumPresets[note] = preset;
            }
        } catch (e) {
            console.warn('[Drums] Failed to load drum note ' + note + ':', e);
        }
    });

    await Promise.all(promises);
    _synthLoading = false;
}

function _synthEnsureCtx() {
    if (_audioCtx && _audioCtx.state === 'suspended') {
        _audioCtx.resume();
    }
}

function _synthDrumHit(midiNote, velocity) {
    if (!_synthPlayer || !_audioCtx || !_synthGain) return;
    const preset = _drumPresets[midiNote];
    if (!preset) return;
    _synthEnsureCtx();

    const vol = (velocity / 127) * _cfg.synthVolume;
    _synthPlayer.queueWaveTable(
        _audioCtx, _synthGain, preset, 0, midiNote, 0.5, vol
    );
}

function _synthSetVolume(vol) {
    _setSharedSetting({ synthVolume: vol });
}

// ═══════════════════════════════════════════════════════════════════════
// Web MIDI input (module-level — one MIDI access per tab)
// ═══════════════════════════════════════════════════════════════════════

// The core midi-input domain, if present (it ships with core).
function _mi() {
    const h = _host();
    const m = h && h.midiInput;
    return (m && m.version === 1) ? m : null;
}

function _ensureMidiStateSub() {
    const h = _host();
    if (_midiStateSub || !h || typeof h.on !== 'function') return;
    _midiStateHandler = () => _midiReconcileSources();
    try { h.on('midi-input:sources-changed', _midiStateHandler); _midiStateSub = true; } catch (_) { _midiStateHandler = null; }
}

function _releaseMidiStateSub() {
    const h = _host();
    if (_midiStateSub && h && typeof h.off === 'function' && _midiStateHandler) {
        try { h.off('midi-input:sources-changed', _midiStateHandler); } catch (_) { /* best-effort */ }
    }
    _midiStateSub = false;
    _midiStateHandler = null;
}

// Domain sources shaped like the old MIDIInput list: { id, name, key }.
// sourceId == the old MIDIInput.id, so stored `midiInputId` stays compatible.
function _midiSources() {
    const mi = _mi();
    if (!mi) return [];
    return mi.listSources().map(s => ({ id: s.sourceId, name: s.label, key: s.logicalSourceKey }));
}

// In-flight guard around discover(): Wave C calls _midiInit() once per init();
// N concurrent splitscreen instances would otherwise issue N discover() calls
// (each a requestMIDIAccess via the provider) before the first resolves.
let _midiInitPromise = null;

async function _midiInit() {
    const mi = _mi();
    if (!mi) return;
    // Already discovered: re-run auto-connect so a re-mount after a full release
    // (or a settings re-open) reconnects from the saved pick instead of no-opping.
    // Already discovered: only (re)connect when there's no live session. A
    // repeated _midiInit (settings panel open, extra splitscreen instance) must
    // NOT re-enter _midiConnect on an active handle — that tears down the live
    // session and releases held pads for no reason. After a full release the
    // handle is null, so reconnect happens then.
    if (_midiReady) {
        _ensureMidiStateSub();
        if (!_midiHandle) _midiAutoConnect();
        return;
    }
    if (_midiInitPromise) return _midiInitPromise;
    _midiInitPromise = (async () => {
        try {
            const r = await mi.discover();  // permission boundary (requestMIDIAccess)
            // Only latch ready on a successful discovery — a denied/unavailable
            // outcome must NOT latch, or reopening the panel never retries.
            if (!r || r.outcome !== 'handled') return;
            _midiReady = true;
            _ensureMidiStateSub();
            _midiAutoConnect();
            // Populate whatever settings panels are open.
            _midiUpdateAllDeviceLists();
        } catch (e) {
            console.warn('[Drums] MIDI access denied:', e);
        } finally {
            // On success future calls short-circuit on `_midiReady`; on
            // rejection, releasing the slot lets a later init() retry.
            _midiInitPromise = null;
        }
    })();
    return _midiInitPromise;
}

// Plug/unplug reconciliation (midi-input:sources-changed). The domain closes +
// deletes a session when its device is unplugged, so refreshing the dropdown
// isn't enough: if OUR selected device vanished, drop the now-stale
// handle/selection (keeping _midiActive) and re-auto-connect — that reattaches
// the saved device when it's replugged, or falls back to another input. Then
// refresh the dropdowns. If the selected device is unaffected, just refresh.
function _midiReconcileSources() {
    if (_midiInput && !_midiSources().some(s => s.key === _midiInput.key)) {
        if (_midiHandle && _midiListener) { try { _midiHandle.removeListener(_midiListener); } catch (_) { /* best-effort */ } }
        _midiHandle = null;
        _midiListener = null;
        _midiInput = null;
        // No note-off can arrive for pads that were down at unplug — clear any
        // sounding/lit state so a lane isn't stuck until the next hit.
        for (const inst of _instances) {
            if (inst && typeof inst._releaseAllSounding === 'function') inst._releaseAllSounding();
        }
    }
    // Reconnect ONLY to the saved device when it's (re)present. Don't fall back to
    // another input here: _midiConnect persists its id, so a fallback during a
    // transient unplug would overwrite the user's saved kit (the original returns
    // on replug and reconnects then). A deliberate device switch goes through the UI.
    if (!_midiInput) {
        const sources = _midiSources();
        const raw = _readStore(STORE_KEYS.midiInputId);
        if (raw === '') {
            // explicit None — stay disconnected.
        } else {
            const key = _midiResolveSaved(raw, sources);
            if (key) _midiConnect(key);                              // saved device present → reconnect
            else if (raw == null && sources.length) _midiConnect(sources[0].key);  // never picked → first-hotplug
            // else: a saved pick exists but is absent → preserve (reconnect on replug)
        }
    }
    _midiUpdateAllDeviceLists();
}

// Resolve a persisted selection to a current source's logicalSourceKey. Handles
// both the new logicalSourceKey storage AND legacy bare web-midi sourceId saves
// (pre-domain), returning the canonical key, or null when the device is absent.
function _midiResolveSaved(saved, sources) {
    if (!saved) return null;
    let m = sources.find(s => s.key === saved);    // new: stored logicalSourceKey
    if (!m) m = sources.find(s => s.id === saved);  // legacy: bare web-midi sourceId
    return m ? m.key : null;
}

function _midiAutoConnect() {
    const inputs = _midiSources();
    if (!inputs.length) return;

    // Distinguish "never picked a device" from "explicitly picked None".
    // _readStore returns null for the never-set case and '' for an explicit-None
    // save via _midiConnect. Only respect the explicit-None sentinel; otherwise
    // resolve the saved selection (logicalSourceKey, or a legacy sourceId) and
    // fall back to the first input when it's absent.
    const raw = _readStore(STORE_KEYS.midiInputId);
    if (raw === '') return;

    _midiConnect(_midiResolveSaved(raw, inputs) || inputs[0].key);
}

async function _midiConnect(key) {
    const myGen = ++_midiConnectSeq;
    const mi = _mi();
    // Tear down any existing live session.
    if (_midiHandle && _midiListener) { try { _midiHandle.removeListener(_midiListener); } catch (_) { /* best-effort */ } }
    if (mi && _midiInput) { try { mi.close({ requester: 'drums', logicalSourceKey: _midiInput.key }); } catch (_) { /* best-effort */ } }
    _midiHandle = null;
    _midiListener = null;
    _midiInput = null;

    // Release anything currently sounding / held on the OLD device
    // before we swap. Drum notes are short (queueWaveTable duration
    // 0.5s) so hung tones are less likely than for piano, but
    // _heldPads drives on-screen lane pressed state and would
    // otherwise keep the prior hit animating after a device swap.
    // Iterate ALL live instances — _activeInstance can be null
    // (no panel focused yet) or stale (focus swapped between
    // device events). Iterating _instances guarantees no panel
    // shows "stuck" pressed lanes when it later becomes focused.
    for (const inst of _instances) {
        if (inst && typeof inst._releaseAllSounding === 'function') {
            inst._releaseAllSounding();
        }
    }
    // Learn-mode is a module-scope sentinel, so clear once and
    // refresh every panel's Learn UI to keep buttons in sync.
    _cfg.learnLane = null;
    _cfg.learnPiece = null;
    _updateLearnUI();

    // Persist regardless of match. Empty key is the explicit "None" option and
    // must be saved so _midiAutoConnect respects the opt-out on next init instead
    // of auto-picking inputs[0] again. We store the globally-unique
    // logicalSourceKey (not the provider-local sourceId).
    _saveCfg('midiInputId', key || '');

    if (!key || !mi) {
        _midiUpdateAllDeviceLists();
        return;
    }
    const src = _midiSources().find(s => s.key === key);
    if (!src) { _midiUpdateAllDeviceLists(); return; }
    _midiInput = { id: src.id, name: src.name, key: src.key };   // selection descriptor for the UI
    // No live renderer to consume OR release a session — don't hold one open
    // (settings-only init, or the last instance was torn down during async
    // discovery). The pick is saved; a later renderer mount re-runs auto-connect
    // and opens for real, and its destroy() releases it.
    if (_instances.size === 0) { _midiUpdateAllDeviceLists(); return; }
    try {
        await mi.select(src.key);
        const res = await mi.open({ requester: 'drums', logicalSourceKey: src.key });
        // A newer _midiConnect (rapid device switch / None) superseded us while
        // we awaited — discard this open so we don't install a stale handle.
        if (myGen !== _midiConnectSeq) {
            if (!_midiInput || _midiInput.key !== src.key) { try { mi.close({ requester: 'drums', logicalSourceKey: src.key }); } catch (_) { /* best-effort */ } }
            return;
        }
        if (res && res.handle) {
            _midiHandle = res.handle;
            // Domain handle delivers bytes (and sometimes an event-shaped
            // object). Adapt so _midiOnMessage receives data plus timeStamp.
            _midiListener = (payload) => {
                // Domain currently delivers raw bytes (e.data). Accept either
                // a MIDIMessageEvent-shaped object or a Uint8Array, and thread
                // timeStamp (or 0) so later scoring can consume it.
                if (payload && typeof payload === 'object' && payload.data != null
                    && !ArrayBuffer.isView(payload)) {
                    _midiOnMessage({ data: payload.data, timeStamp: payload.timeStamp });
                } else {
                    _midiOnMessage({ data: payload, timeStamp: 0 });
                }
            };
            // Wire the listener only when at least one renderer is active. A
            // late open() from an async _midiInit that resolved post-destroy
            // would otherwise re-enable scoring/synth in the background.
            if (_midiActive) _midiHandle.addListener(_midiListener);
        } else {
            // Open yielded no live handle (device vanished post-discovery, or the
            // provider reported denied/unavailable). Clear the selection so the UI
            // doesn't show a phantom connected device and miss-counting stays off.
            _midiInput = null;
        }
    } catch (e) {
        console.warn('[Drums] MIDI open failed:', e);
        // Only clear if we're still the current connect — a stale older open's
        // rejection (rapid switch / autoconnect racing a manual pick) must not
        // wipe a newer connect's already-installed _midiInput/_midiHandle (which
        // would also leak the live handle, since closes are gated on _midiInput).
        if (myGen === _midiConnectSeq) _midiInput = null;
    }
    _midiUpdateAllDeviceLists();
    _maybeShowKitSuggestion();
}

function _midiPauseHandler() {
    // Called from destroy() when the LAST instance goes away —
    // detach the message handler so the connected kit stops firing
    // hits into a plugin no longer visible. Flipping _midiActive
    // BEFORE the detach also prevents a late-resolving _midiConnect
    // (from an in-flight _midiInit started in the most recent init())
    // from re-wiring the handler on an already-destroyed renderer.
    // Keep _midiInput so a future init() can reattach without the
    // user re-picking.
    _midiActive = false;
    if (_midiHandle && _midiListener) { try { _midiHandle.removeListener(_midiListener); } catch (_) { /* best-effort */ } }
    // Clear pending Learn-mode sentinel — leaving it set would
    // consume the first drum hit on the NEXT renderer lifetime
    // (user clicks Learn, closes the last drums panel before
    // tapping a pad, reopens drums later, hits a pad → silent
    // remap with no UI explaining why). _updateLearnUI() refreshes
    // any reopened settings panel; if no panel is open right now
    // the call is a cheap no-op.
    _cfg.learnLane = null;
    _cfg.learnPiece = null;
    _updateLearnUI();
}

// Called when the LAST live instance is torn down. Builds on _midiPauseHandler
// (listener detach + Learn-sentinel clear) by also fully releasing the shared
// midi-input domain session, so the e-kit/provider session isn't held open after
// the visualization is gone and the core domain can close the device once other
// consumers release it too. Reset readiness so a later re-mount re-discovers and
// auto-connects from the saved pick.
function _midiReleaseSession() {
    _midiConnectSeq += 1;   // invalidate any in-flight _midiConnect open
    _midiPauseHandler();
    const mi = _mi();
    if (mi && _midiInput) { try { mi.close({ requester: 'drums', logicalSourceKey: _midiInput.key || ('web-midi::' + _midiInput.id) }); } catch (_) { /* best-effort */ } }
    _midiHandle = null;
    _midiListener = null;
    _midiInput = null;
    // Intentionally leave _midiReady latched and _midiInitPromise alone: _midiInit
    // re-runs _midiAutoConnect on a ready re-mount (no re-discover needed), and
    // clearing the in-flight promise here would let a quick remount during a
    // pending discover() start a SECOND requestMIDIAccess, defeating the guard.
    // The in-flight init clears its own promise in its finally.
}

function _midiResumeHandler() {
    // Idempotent: a second instance init (splitscreen / re-init) calls this while
    // already active. The domain handle's addListener is Set-backed, but don't
    // rely on the provider de-duping — re-adding could double-deliver each MIDI
    // event to the focused instance, doubling note-ons/hits.
    if (_midiActive) return;
    // Called from init() — flip the gate first so an in-flight
    // _midiConnect that lands shortly after this returns wires the
    // handler too. If _midiInput is already populated from a prior
    // lifetime, restore the handler immediately.
    _midiActive = true;
    if (_midiHandle && _midiListener) { try { _midiHandle.addListener(_midiListener); } catch (_) { /* best-effort */ } }
}

function _midiOnMessage(e) {
    // Only the focused instance receives MIDI. Module-level
    // _activeInstance is the routing slot; it points at null when
    // no instance is focused (splitscreen toggled off mid-session
    // between teardowns, or no instance initialised yet).
    if (!_activeInstance) return;

    const data = e && e.data;
    if (!data || data.length < 3) return;
    const status = data[0];
    const note = data[1];
    const velocity = data[2];
    const ch = status & 0x0F;
    if (_cfg.midiChannel >= 0 && ch !== _cfg.midiChannel) return;

    const cmd = status & 0xF0;
    if (cmd === 0x90 && velocity > 0) {
        // INIT-001/SPEC-005: thread DOM timeStamp (or 0) into the hit path.
        _activeInstance._handleDrumHit(note, velocity, _eventTimeStamp(e));
    }
    // Drums don't need note-off handling (one-shot hits)
}

function _midiUpdateAllDeviceLists() {
    const inputs = _midiSources();

    // Every instance's settings panel (if open) has a
    // `.drums-midi-select` node. Iterate all of them so a
    // device plug/unplug reflects everywhere simultaneously.
    const selects = document.querySelectorAll('.drums-midi-select');
    for (const sel of selects) {
        // Build <option> elements via the DOM API rather than
        // concatenating an HTML string. MIDI device names come from
        // attached hardware and can contain characters that would
        // otherwise inject markup ("<" in a vendor string or a
        // maliciously-named device) directly into the settings panel.
        // .value / .textContent escape both fields safely.
        sel.textContent = '';
        const noneOpt = document.createElement('option');
        noneOpt.value = '';
        noneOpt.textContent = 'None';
        sel.appendChild(noneOpt);
        for (const inp of inputs) {
            const opt = document.createElement('option');
            opt.value = inp.key;
            // inp.name can be null / empty across browsers and devices
            // (Firefox historically, some class-compliant kits); fall
            // back through manufacturer → id so the dropdown never
            // literally says "null".
            opt.textContent = inp.name || inp.manufacturer || inp.id || 'Unknown device';
            if (_midiInput && _midiInput.key === inp.key) opt.selected = true;
            sel.appendChild(opt);
        }
    }
}

// Refresh every Learn button across every open settings panel so the
// "..." pending indicator and the active-lane highlight reflect the
// shared _cfg.learnLane sentinel.
function _updateLearnUI() {
    if (typeof document === 'undefined' || typeof document.querySelectorAll !== 'function') return;
    const learnBtns = document.querySelectorAll('.drums-learn-btn');
    learnBtns.forEach(btn => {
        const piece = btn.dataset.piece;
        const pending = piece
            ? _cfg.learnPiece === piece
            : _cfg.learnLane === parseInt(btn.dataset.lane, 10);
        btn.textContent = pending ? '...' : 'Learn';
        btn.style.color = pending ? '#ff0' : '#aaa';
        btn.setAttribute('aria-pressed', pending ? 'true' : 'false');
    });
}

function _learnButtonHtml(attrs, pending) {
    const enabled = _mappingMutationsEnabled();
    const disabled = enabled ? '' : ' disabled aria-disabled="true"';
    return `<button type="button" class="drums-learn-btn" ${attrs} aria-label="Learn MIDI mapping"
        aria-pressed="${pending ? 'true' : 'false'}"${disabled}
        style="background:#1a1a2e;border:1px solid #333;border-radius:4px;padding:1px 6px;
        font-size:10px;color:${pending ? '#ff0' : '#aaa'};cursor:${enabled ? 'pointer' : 'not-allowed'};opacity:${enabled ? '1' : '0.5'};">${pending ? '...' : 'Learn'}</button>`;
}

function _buildNoteChipsHtml(pieceId) {
    if (!_isPieceId(pieceId)) return '';
    const enabled = _mappingMutationsEnabled();
    const custom = new Set(_customMidiNotesForPiece(pieceId));
    const gm = _gmMidiNotesForPiece(pieceId);
    const chips = [];
    const name = _pieceDisplayName(pieceId);
    const safeName = _escapeHtml(name);
    const safePiece = _escapeHtml(pieceId);
    for (let i = 0; i < gm.length; i++) {
        const n = gm[i];
        if (custom.has(n)) continue;
        chips.push(
            `<span class="drums-note-chip drums-note-chip--gm" title="GM default"` +
            ` aria-label="GM default MIDI note ${n} for ${safeName}"` +
            ` style="display:inline-flex;align-items:center;padding:2px 6px;border-radius:4px;` +
            `background:#111827;border:1px dashed #555;color:#888;font-size:10px;">${n}</span>`
        );
    }
    for (const n of custom) {
        const removeLabel = 'Remove MIDI note ' + n + ' from ' + name;
        const disabled = enabled ? '' : ' disabled aria-disabled="true"';
        chips.push(
            `<span class="drums-note-chip drums-note-chip--custom" style="display:inline-flex;align-items:center;gap:2px;` +
            `padding:1px 4px 1px 6px;border-radius:4px;background:#1e293b;border:1px solid #64748b;color:#e2e8f0;font-size:10px;">` +
            `<span>${n}</span>` +
            `<button type="button" class="drums-note-remove" data-midi="${n}" data-piece="${safePiece}"` +
            ` aria-label="${_escapeHtml(removeLabel)}"${disabled}` +
            ` style="min-width:24px;min-height:24px;padding:0;line-height:24px;text-align:center;` +
            `background:#7f1d1d;color:#fecaca;border:1px solid #ef4444;border-radius:4px;` +
            `cursor:${enabled ? 'pointer' : 'not-allowed'};font-size:14px;opacity:${enabled ? '1' : '0.5'};">×</button></span>`
        );
    }
    if (!chips.length) return '<span style="color:#666;">Unmapped</span>';
    return `<span class="drums-note-chips" style="display:inline-flex;flex-wrap:wrap;gap:4px;align-items:center;">${chips.join('')}</span>`;
}

function _piecesForLane(laneId) {
    const table = _pieceToLaneByPreset[_cfg.lanePreset] || _pieceToLaneByPreset.phase_shift_8;
    const out = [];
    for (const pid of _knownPieceIds) {
        if (table[pid] === laneId) out.push(pid);
    }
    return out;
}

// Build the mapping table rows from the active drum map. Module-scope
// because customMapping is module-shared state — every open settings
// panel (across N splitscreen drum instances) should render the same
// rows. Piece-ids interpolated here are regex-validated first.
function _buildMappingRows() {
    const map = _getActiveDrumMap();
    return DRUM_LANES.map((lane, idx) => {
        const pieces = _piecesForLane(lane.id);
        if (pieces.length) {
            return pieces.map((pid, pIdx) => {
                if (!_isPieceId(pid)) return '';
                const pending = _cfg.learnPiece === pid;
                const notes = _buildNoteChipsHtml(pid);
                const label = _escapeHtml(_pieceDisplayName(pid));
                const laneCell = pIdx === 0
                    ? `<td style="color:${_rgbStr(lane.color[0], lane.color[1], lane.color[2])};font-weight:bold;padding:2px 6px;" rowspan="${pieces.length}">${lane.label}</td>`
                    : '';
                return `<tr>
                    ${laneCell}
                    <td style="color:#ccc;padding:2px 6px;font-size:10px;">${label}</td>
                    <td style="color:#888;padding:2px 6px;font-size:10px;">${notes}</td>
                    <td style="padding:2px 4px;">${_learnButtonHtml('data-piece="' + pid + '"', pending)}</td>
                </tr>`;
            }).join('');
        }
        const assigned = Object.entries(map).filter(([_, v]) => v === lane.id).map(([k]) => k).join(', ');
        const pending = _cfg.learnLane === idx;
        return `<tr>
            <td style="color:${_rgbStr(lane.color[0], lane.color[1], lane.color[2])};font-weight:bold;padding:2px 6px;">${lane.label}</td>
            <td style="color:#888;padding:2px 6px;font-size:10px;">${_escapeHtml(assigned || 'none')}</td>
            <td style="padding:2px 4px;">${_learnButtonHtml('data-lane="' + idx + '"', pending)}</td>
        </tr>`;
    }).join('');
}

function _wireLearnButtons(scope) {
    if (!scope || typeof scope.querySelectorAll !== 'function') return;
    scope.querySelectorAll('.drums-learn-btn').forEach(btn => {
        btn.onclick = function () {
            if (!_mappingMutationsEnabled()) return;
            const piece = this.dataset.piece;
            if (piece && _isPieceId(piece)) {
                _cfg.learnPiece = _cfg.learnPiece === piece ? null : piece;
                _cfg.learnLane = null;
            } else {
                const idx = parseInt(this.dataset.lane, 10);
                _cfg.learnLane = _cfg.learnLane === idx ? null : idx;
                _cfg.learnPiece = null;
            }
            _updateLearnUI();
        };
    });
}

function _wireMappingControls(scope) {
    if (!scope || typeof scope.querySelectorAll !== 'function') return;
    _wireLearnButtons(scope);
    scope.querySelectorAll('.drums-note-remove').forEach(btn => {
        btn.onclick = function () {
            const midi = _parseMidiNote(this.dataset.midi);
            const piece = this.dataset.piece;
            if (midi === null || !_isPieceId(piece)) return;
            _removeCustomNote(midi, piece);
        };
    });
}

function _refreshMapStatus() {
    if (typeof document === 'undefined' || typeof document.querySelectorAll !== 'function') return;
    document.querySelectorAll('.drums-map-status').forEach(el => {
        el.textContent = '';
        if (!_mapStatusText) return;
        const span = document.createElement('span');
        span.textContent = _mapStatusText;
        el.appendChild(span);
        if (_mapStatusAllowUndo && _lastRemoval) {
            el.appendChild(document.createTextNode(' '));
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'drums-map-undo';
            btn.textContent = 'Undo';
            btn.setAttribute('aria-label', 'Undo remove MIDI note ' + _lastRemoval.midiNote);
            btn.style.cssText = 'background:#1a1a2e;border:1px solid #555;border-radius:4px;padding:2px 8px;font-size:10px;color:#ddd;cursor:pointer;margin-left:6px;';
            btn.onclick = function () { _undoLastRemoval(); };
            el.appendChild(btn);
        }
    });
}

// Rebuild EVERY open mapping table after a customMapping change
// (Learn-mode assignment, Reset Map button). Iterating the DOM
// rather than _instances means we rebuild only the tables that
// actually exist in the document — instances whose settings panel
// was never opened simply don't have a `.drums-map-table` node yet,
// and they pick up the current state when the panel opens later.
function _refreshAllMappingTables() {
    if (typeof document === 'undefined' || typeof document.querySelectorAll !== 'function') return;
    const tables = document.querySelectorAll('.drums-map-table');
    if (!tables.length) return;
    const html = _buildMappingRows();
    tables.forEach(tbl => {
        tbl.innerHTML = html;
        _wireMappingControls(tbl);
    });
    _refreshMapStatus();
}

async function _fetchJsonResult(url, opts) {
    if (typeof fetch !== 'function') return { ok: false, status: 0, data: null, detail: '' };
    try {
        const res = await fetch(url, opts);
        const status = res && typeof res.status === 'number' ? res.status : 0;
        let data = null;
        try { data = res ? await res.json() : null; } catch (_) { data = null; }
        const detail = data && typeof data.detail === 'string' ? data.detail : '';
        return { ok: Boolean(res && res.ok), status: status, data: data, detail: detail };
    } catch (_) {
        return { ok: false, status: 0, data: null, detail: '' };
    }
}

async function _fetchJson(url, opts) {
    const result = await _fetchJsonResult(url, opts);
    return result.ok ? result.data : null;
}

function _learnLockMessage() {
    const ed = _getDrumEditor();
    if (ed && typeof ed.learnLockMessage === 'function') return ed.learnLockMessage();
    return 'Learn is locked while a song is playing or paused. Mapping was not changed.';
}

function _isLearnLockedStatus(status) {
    const ed = _getDrumEditor();
    if (ed && typeof ed.isLearnLockedStatus === 'function') return ed.isLearnLockedStatus(status);
    return status === 409;
}

async function _refetchActiveKit() {
    const kitId = _activeKitId;
    if (!kitId || !_KIT_ID_RE.test(kitId)) return null;
    const myGen = ++_kitRefetchSeq;
    const kit = await _fetchJson('/api/drums/kits/' + encodeURIComponent(kitId));
    if (myGen !== _kitRefetchSeq) return null;
    if (_activeKitId !== kitId) return null;
    if (kit) {
        _applyActiveKitNotes(kit);
        _pendingPieceNotes = _kitNotes;
        const listed = _kitList.find(k => k.id === kitId);
        if (listed) listed.notes = kit.notes;
    }
    _refreshAllMappingTables();
    return kit;
}

function _applySuccessfulNoteMutation(data, midiNote, pieceId, operation) {
    const n = _parseMidiNote(midiNote);
    if (data && data.kit) _applyActiveKitNotes(data.kit);
    else if (operation === 'set' && n !== null && _isPieceId(pieceId)) {
        const next = Object.assign(Object.create(null), _kitNotes || {});
        next[n] = pieceId;
        _kitNotes = _validatePieceMapping(next, _knownPieceIds) || next;
    } else if (operation === 'delete' && n !== null && _kitNotes) {
        const next = Object.assign(Object.create(null), _kitNotes);
        delete next[n];
        _kitNotes = _validatePieceMapping(next, _knownPieceIds);
    }
    _pendingPieceNotes = _kitNotes;
    const laneId = _isPieceId(pieceId) ? _pieceToLaneId(pieceId) : null;
    if (operation === 'set' && n !== null && laneId) {
        _saveCfg('customMapping', _mergeLaneMapAdditive(_cfg.customMapping, n, laneId));
    } else if (operation === 'delete' && n !== null) {
        _dropLegacyNote(n);
    }
    return { laneId, resolution: data && data.resolution ? data.resolution : null };
}

async function _commitLearnAssignment(midiNote, pieceId) {
    const n = _parseMidiNote(midiNote);
    if (n === null || !_isPieceId(pieceId)) return null;
    if (!_mappingMutationsEnabled()) {
        _announceMapStatus('Confirm a kit with Use this kit before mapping.', false);
        return null;
    }
    const kitId = _activeKitId;
    const prevMap = _cfg.customMapping;
    const prevNotes = _kitNotes;
    const result = await _fetchJsonResult(_noteEndpoint(kitId, n), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ piece_id: pieceId }),
    });
    if (!result.ok) {
        _cfg.customMapping = prevMap;
        _kitNotes = prevNotes;
        _announceMapStatus(
            _isLearnLockedStatus(result.status)
                ? _learnLockMessage()
                : 'Could not save mapping. Kit and local map unchanged.',
            false,
        );
        return null;
    }
    const data = result.data;
    const applied = _applySuccessfulNoteMutation(data, n, pieceId, 'set');
    _notifyMappingChange({ kitId, mutation: 'set', midiNote: n });
    const name = _pieceDisplayName(pieceId);
    _announceMapStatus('Mapped MIDI note ' + n + ' to ' + name + '.', false);
    _refreshAllMappingTables();
    return { kitId, laneId: applied.laneId, pieceId, resolution: applied.resolution };
}

async function _removeCustomNote(midiNote, pieceId) {
    const n = _parseMidiNote(midiNote);
    if (n === null || !_isPieceId(pieceId)) return { ok: false };
    if (!_mappingMutationsEnabled()) {
        _announceMapStatus('Confirm a kit with Use this kit before mapping.', false);
        return { ok: false };
    }
    if (!_kitNotes || _kitNotes[n] !== pieceId) {
        _announceMapStatus('That note is a GM default and cannot be removed.', false);
        return { ok: false };
    }
    const kitId = _activeKitId;
    const prevMap = _cfg.customMapping;
    const prevNotes = _kitNotes;
    const result = await _fetchJsonResult(_noteEndpoint(kitId, n), { method: 'DELETE' });
    if (!result.ok) {
        _cfg.customMapping = prevMap;
        _kitNotes = prevNotes;
        _announceMapStatus(
            _isLearnLockedStatus(result.status)
                ? _learnLockMessage()
                : 'Could not remove MIDI note ' + n + '. Mapping unchanged.',
            false,
        );
        return { ok: false };
    }
    const data = result.data;
    const laneId = _pieceToLaneId(pieceId);
    _applySuccessfulNoteMutation(data, n, pieceId, 'delete');
    _lastRemoval = { kitId, midiNote: n, pieceId, laneId };
    _notifyMappingChange({ kitId, mutation: 'delete', midiNote: n });
    const resolution = data.resolution || {};
    const fallback = resolution.source === 'gm' && resolution.piece_id
        ? ('Now GM default (' + _pieceDisplayName(resolution.piece_id) + ').')
        : 'Now unmapped.';
    _announceMapStatus('Removed MIDI note ' + n + ' from ' + _pieceDisplayName(pieceId) + '. ' + fallback, true);
    _refreshAllMappingTables();
    return { ok: true, resolution };
}

async function _undoLastRemoval() {
    const last = _lastRemoval;
    if (!last || !_mappingMutationsEnabled()) return { ok: false };
    if (last.kitId !== _activeKitId) return { ok: false };
    const prevMap = _cfg.customMapping;
    const prevNotes = _kitNotes;
    const result = await _fetchJsonResult(_noteEndpoint(last.kitId, last.midiNote), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ piece_id: last.pieceId }),
    });
    if (!result.ok) {
        _cfg.customMapping = prevMap;
        _kitNotes = prevNotes;
        _announceMapStatus(
            _isLearnLockedStatus(result.status) ? _learnLockMessage() : 'Could not undo. Mapping unchanged.',
            true,
        );
        return { ok: false };
    }
    const data = result.data;
    _applySuccessfulNoteMutation(data, last.midiNote, last.pieceId, 'set');
    const restored = last;
    _lastRemoval = null;
    _notifyMappingChange({ kitId: restored.kitId, mutation: 'set', midiNote: restored.midiNote });
    _announceMapStatus('Restored MIDI note ' + restored.midiNote + ' to ' + _pieceDisplayName(restored.pieceId) + '.', false);
    _refreshAllMappingTables();
    return { ok: true };
}

async function _confirmActiveKit(kitId) {
    if (typeof kitId !== 'string' || !_KIT_ID_RE.test(kitId)) return false;
    const myGen = ++_kitConfirmSeq;
    const listed = _kitList.find(k => k.id === kitId);
    let kit = listed;
    const fetched = await _fetchJson('/api/drums/kits/' + encodeURIComponent(kitId));
    if (myGen !== _kitConfirmSeq) return false;
    if (_pendingKitId && _pendingKitId !== kitId) return false;
    if (fetched) kit = fetched;
    if (!kit) return false;
    await _fetchJson('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ active_kit: kitId }),
    });
    if (myGen !== _kitConfirmSeq) return false;
    if (_pendingKitId && _pendingKitId !== kitId) return false;
    _activeKitId = kitId;
    _pendingKitId = kitId;
    _applyActiveKitNotes(kit);
    _pendingPieceNotes = _kitNotes;
    _kitSuggestId = null;
    _refreshKitSelects();
    _refreshAllMappingTables();
    _refreshKitSuggestBanners();
    _persistEditorPatch();
    return true;
}

function _refreshKitSelects() {
    if (typeof document === 'undefined' || typeof document.querySelectorAll !== 'function') return;
    const selects = document.querySelectorAll('.drums-kit-select');
    for (const sel of selects) {
        const current = sel.value;
        sel.textContent = '';
        const noneOpt = document.createElement('option');
        noneOpt.value = '';
        noneOpt.textContent = 'None (GM / Learn map)';
        sel.appendChild(noneOpt);
        for (const kit of _kitList) {
            const opt = document.createElement('option');
            opt.value = kit.id;
            opt.textContent = kit.name || kit.id;
            sel.appendChild(opt);
        }
        const pick = _pendingKitId || _activeKitId || current || '';
        if (pick && [...sel.options].some(o => o.value === pick)) sel.value = pick;
        else sel.value = '';
    }
    document.querySelectorAll('.drums-kit-confirm').forEach(btn => {
        const panel = btn.closest('.drums-editor') || btn.closest('.drums-settings-panel');
        const sel = panel && panel.querySelector('.drums-kit-select');
        const chosen = sel ? sel.value : '';
        btn.disabled = !chosen || chosen === _activeKitId;
    });
}

function _refreshKitSuggestBanners() {
    if (typeof document === 'undefined' || typeof document.querySelectorAll !== 'function') return;
    const banners = document.querySelectorAll('.drums-kit-suggest');
    banners.forEach(el => {
        el.textContent = '';
        if (!_kitSuggestId) {
            el.hidden = true;
            return;
        }
        const kit = _kitList.find(k => k.id === _kitSuggestId);
        const name = kit && kit.name ? kit.name : _kitSuggestId;
        el.hidden = false;
        const text = document.createElement('span');
        text.textContent = 'Suggested kit: ' + name + '. ';
        const confirm = document.createElement('button');
        confirm.type = 'button';
        confirm.className = 'drums-kit-suggest-confirm';
        confirm.textContent = 'Use this kit';
        confirm.setAttribute('aria-label', 'Confirm suggested kit ' + name);
        confirm.onclick = function () { _confirmActiveKit(_kitSuggestId); };
        const dismiss = document.createElement('button');
        dismiss.type = 'button';
        dismiss.textContent = 'Dismiss';
        dismiss.setAttribute('aria-label', 'Dismiss kit suggestion');
        dismiss.onclick = function () {
            _kitSuggestId = null;
            _refreshKitSuggestBanners();
        };
        el.appendChild(text);
        el.appendChild(confirm);
        el.appendChild(dismiss);
    });
}

function _maybeShowKitSuggestion() {
    if (_activeKitId) {
        _kitSuggestId = null;
        _refreshKitSuggestBanners();
        return;
    }
    const key = _midiInput && _midiInput.key;
    const hits = _suggestKitsForSource(key, _kitList);
    _kitSuggestId = hits.length ? hits[0] : null;
    _refreshKitSuggestBanners();
}

async function _consumeCoreKits() {
    const confirmGen = _kitConfirmSeq;
    const vocab = await _fetchJson('/api/drums/vocabulary');
    if (vocab) _applyVocabulary(vocab);
    const listed = await _fetchJson('/api/drums/kits');
    if (listed) _kitList = _sanitizeKitList(listed);
    const settings = await _fetchJson('/api/settings');
    if (confirmGen !== _kitConfirmSeq) {
        _refreshKitSelects();
        _refreshAllMappingTables();
        return;
    }
    const kitId = settings && typeof settings.active_kit === 'string' ? settings.active_kit : null;
    if (_pendingKitId && kitId && _pendingKitId !== kitId) {
        _refreshKitSelects();
        _refreshAllMappingTables();
        _maybeShowKitSuggestion();
        return;
    }
    if (kitId && _KIT_ID_RE.test(kitId)) {
        const kit = await _fetchJson('/api/drums/kits/' + encodeURIComponent(kitId));
        if (confirmGen !== _kitConfirmSeq) return;
        if (_pendingKitId && _pendingKitId !== kitId) return;
        if (kit) {
            _activeKitId = kitId;
            _applyActiveKitNotes(kit);
        } else {
            _activeKitId = null;
            _applyActiveKitNotes(null);
        }
    } else {
        _activeKitId = null;
        _applyActiveKitNotes(null);
    }
    _refreshKitSelects();
    _refreshAllMappingTables();
    _maybeShowKitSuggestion();
}

function _wireKitControls(scope) {
    const sel = scope.querySelector('.drums-kit-select');
    const confirm = scope.querySelector('.drums-kit-confirm');
    if (sel) {
        sel.onchange = function () {
            _pendingKitId = this.value || '';
            _kitConfirmSeq += 1;
            _cfg.learnLane = null;
            _cfg.learnPiece = null;
            _refreshKitSelects();
            _refreshAllMappingTables();
        };
    }
    if (confirm) {
        confirm.onclick = function () {
            const chosen = sel ? sel.value : '';
            if (chosen) _confirmActiveKit(chosen);
        };
    }
    _refreshKitSelects();
    _refreshKitSuggestBanners();
}

function _collectProfilePatch() {
    return {
        highway: {
            '2d': {
                lane_preset: _cfg.lanePreset,
                show_lane_labels: _cfg.showLaneLabels,
            },
        },
    };
}

function _persistEditorPatch() {
    const editor = _getDrumEditor();
    if (!editor || typeof editor.persistActivePatch !== 'function') return;
    editor.persistActivePatch(_collectProfilePatch());
}

function _syncEditorControlsFromCfg() {
    if (typeof document === 'undefined' || typeof document.querySelectorAll !== 'function') return;
    document.querySelectorAll('.drums-vol-slider').forEach(el => {
        el.value = String(Math.round(_cfg.synthVolume * 100));
    });
    document.querySelectorAll('.drums-channel-select').forEach(el => {
        el.value = String(_cfg.midiChannel);
    });
    document.querySelectorAll('.drums-chk-hits').forEach(el => {
        el.checked = Boolean(_cfg.hitDetection);
    });
    document.querySelectorAll('.drums-chk-labels').forEach(el => {
        el.checked = Boolean(_cfg.showLaneLabels);
    });
    document.querySelectorAll('.drums-lane-preset').forEach(el => {
        el.value = _cfg.lanePreset;
    });
}

function _applyDrumProfile(profile) {
    if (!profile || typeof profile !== 'object') return;
    const apply = function () {
        const hw2d = profile.highway && profile.highway['2d'] ? profile.highway['2d'] : {};
        if (hw2d.lane_preset && _VALID_LANE_PRESETS.has(hw2d.lane_preset)) {
            _saveCfg('lanePreset', hw2d.lane_preset);
            _applyLanePreset(_cfg.lanePreset);
            _cfg.learnLane = null;
            _cfg.learnPiece = null;
        }
        if (typeof hw2d.show_lane_labels === 'boolean') _saveCfg('showLaneLabels', hw2d.show_lane_labels);
        const deviceId = _normalizeAttachedDeviceId(profile.device_id);
        if (deviceId) _refetchAttachedDevice(deviceId);
        else _clearAttachedDevice();
        _syncEditorControlsFromCfg();
    };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(apply);
    else apply();
}

function _hydrateDrumEditor(root) {
    if (!root || typeof root.querySelector !== 'function') return;
    const preset = root.querySelector('.drums-lane-preset');
    if (preset) {
        preset.onchange = function () {
            _saveCfg('lanePreset', this.value);
            _applyLanePreset(_cfg.lanePreset);
            _cfg.learnLane = null;
            _cfg.learnPiece = null;
            if (typeof document !== 'undefined' && document.querySelectorAll) {
                document.querySelectorAll('.drums-lane-preset').forEach(sel => {
                    sel.value = _cfg.lanePreset;
                });
            }
            _persistEditorPatch();
        };
    }
    const labels = root.querySelector('.drums-chk-labels');
    if (labels) {
        labels.onchange = function () {
            _saveCfg('showLaneLabels', this.checked);
            _persistEditorPatch();
        };
    }
    _bindDrumInputContract();
    _bindMidiDeviceScoring();
    _syncEditorControlsFromCfg();
    const editor = _getDrumEditor();
    if (editor && typeof editor.refreshProfiles === 'function') {
        editor.refreshProfiles().then(function (cache) {
            const id = cache && cache.active && cache.active.device_id;
            if (id) _refetchAttachedDevice(id);
            else _clearAttachedDevice();
        });
    }
}

function _onDrumProfileChange(ev) {
    const detail = (ev && ev.detail) || ev || {};
    const editor = _getDrumEditor();
    const apply = function (profile) {
        if (profile) _applyDrumProfile(profile);
    };
    // Do not refreshProfiles() here: that rebuilds the Attach select and
    // races the in-flight save (flash back to None). Scoring overlay only.
    if (editor && typeof editor.listProfiles === 'function' && detail.profile_id) {
        editor.listProfiles().then(function (list) {
            const hit = (list || []).find(function (p) { return p.id === detail.profile_id; });
            apply(hit);
        });
        return;
    }
}

function _bootSettingsEditor() {
    _ensureDrumEditor(function (editor) {
        if (!editor || typeof document === 'undefined' || typeof document.querySelector !== 'function') return;
        const host = document.querySelector('[data-drums-editor-host="settings"]');
        if (!host) return;
        editor.mountDrumEditor(host, {
            context: 'settings',
            onMounted: _hydrateDrumEditor,
            synthVolume: _cfg.synthVolume,
            midiChannel: _cfg.midiChannel,
            hitDetection: _cfg.hitDetection,
            showLaneLabels: _cfg.showLaneLabels,
            lanePreset: _cfg.lanePreset,
        });
    });
    if (typeof document !== 'undefined' && document.addEventListener && !window.__feedBackDrumsProfileHook) {
        window.__feedBackDrumsProfileHook = true;
        document.addEventListener('feedback:drum-profile-change', _onDrumProfileChange);
        const fb = window.feedBack;
        if (fb && typeof fb.on === 'function') fb.on('feedback:drum-profile-change', _onDrumProfileChange);
    }
    _bindMidiDeviceScoring();
}

function _bootDrumTiming() {
    _publishDrumTimingFacade();
    _ensureDrumTiming(function (api) {
        _publishDrumTimingFacade();
        if (!api || typeof document === 'undefined' || typeof document.getElementById !== 'function') return;
        const panel = document.getElementById('midi-calibration-panel');
        if (panel && typeof api.mount === 'function') api.mount(panel);
    });
}

if (typeof document !== 'undefined') _bootSettingsEditor();
if (typeof document !== 'undefined') _bootDrumTiming();

// ═══════════════════════════════════════════════════════════════════════
// Splitscreen helper wrappers
// ═══════════════════════════════════════════════════════════════════════
//
// Centralise the "am I in splitscreen?" / "which panel are my chrome
// anchors?" queries so instance code can read the runtime environment
// cheaply. Absence of window.slopsmithSplitscreen OR isActive()===false
// means "main-player, always focused" from the plugin's POV.

function _ssActive() {
    const ss = window.slopsmithSplitscreen;
    if (!ss || typeof ss.isActive !== 'function' || !ss.isActive()) return false;
    // Validate the FULL surface this plugin consumes, not just
    // isActive(). If a future splitscreen build ships partial
    // helpers (or an older bundled splitscreen lacks one of the
    // newer methods), report "not active" so the wrappers fall
    // back to the main-player single-instance fast path rather
    // than reaching a half-broken splitscreen state where focus
    // never lands on any instance and MIDI routing dies.
    return typeof ss.isCanvasFocused === 'function'
        && typeof ss.panelChromeFor === 'function'
        && typeof ss.settingsAnchorFor === 'function'
        && typeof ss.onFocusChange === 'function'
        && typeof ss.offFocusChange === 'function';
}

function _ssPanelChrome(highwayCanvas) {
    const ss = window.slopsmithSplitscreen;
    if (!_ssActive()) return null;
    return (ss && typeof ss.panelChromeFor === 'function')
        ? ss.panelChromeFor(highwayCanvas) : null;
}

function _ssSettingsAnchor(highwayCanvas) {
    const ss = window.slopsmithSplitscreen;
    if (!_ssActive()) return null;
    return (ss && typeof ss.settingsAnchorFor === 'function')
        ? ss.settingsAnchorFor(highwayCanvas) : null;
}

function _ssIsCanvasFocused(highwayCanvas) {
    const ss = window.slopsmithSplitscreen;
    if (!_ssActive()) return true;  // main-player fast path
    return !!(ss && typeof ss.isCanvasFocused === 'function' &&
              ss.isCanvasFocused(highwayCanvas));
}

// ═══════════════════════════════════════════════════════════════════════
// Round rect helper (stateless)
// ═══════════════════════════════════════════════════════════════════════

function _roundRect(ctx, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
}

// ═══════════════════════════════════════════════════════════════════════
// Lane geometry (vertical — lanes are columns, notes scroll top → bottom)
// ═══════════════════════════════════════════════════════════════════════

function _computeLaneLayout(W /* , H */) {
    const numLanes = DRUM_LANES.length;
    const padL = 10;
    const padR = 10;
    const availW = W - padL - padR;

    const kickIdx = DRUM_LANES.findIndex(l => l.id === 'kick');
    const regularW = (availW - KICK_LANE_EXTRA) / numLanes;
    const kickW = regularW + KICK_LANE_EXTRA;

    const lanes = [];
    let x = padL;
    for (let i = 0; i < numLanes; i++) {
        const w = i === kickIdx ? kickW : regularW;
        lanes.push({
            idx: i,
            lane: DRUM_LANES[i],
            x: x,
            w: w,
            centerX: x + w / 2,
        });
        x += w + LANE_PAD;
    }
    return lanes;
}

function _timeToY(dt, nowLineY, topY) {
    if (dt <= 0) return nowLineY + (-dt / 0.3) * 20;
    const frac = dt / VISIBLE_SECONDS;
    return nowLineY - frac * (nowLineY - topY);
}

// ═══════════════════════════════════════════════════════════════════════
// Factory — slopsmith#36 setRenderer contract (multi-instance)
// ═══════════════════════════════════════════════════════════════════════

function createFactory() {
    const _instanceId = ++_nextInstanceId;

    // Lifecycle
    let _isReady = false;

    // Rendering state — _drumCanvas / _drumCtx point at the highway's own
    // canvas (passed to init by highway.js). We render directly onto it
    // instead of overlaying a separate canvas, matching the 3D Highway
    // plugin's pattern. The player-controls strip stays at the bottom
    // naturally because highway.js sizes the canvas to exclude it.
    let _drumCanvas = null;
    let _drumCtx = null;
    let _highwayCanvas = null;

    // Settings UI — gear opens the shared editor (INIT-003/SPEC-005).
    let _settingsGear = null;

    // Held / flash state — per-instance so each panel only shows the
    // pads ITS focused user is hitting.
    const _heldPads = new Map();          // midi note -> {velocity, wall}
    const _wrongFlashes = [];             // [{lane, wall}]
    const _laneFlashes = [];              // [{laneIdx, wall, color}]

    // Scoring
    let _hits = 0, _misses = 0, _streak = 0, _bestStreak = 0;
    const _hitNoteKeys = new Set();
    const _missedNoteKeys = new Set();

    // Latest bundle snapshot — cached each frame so MIDI handler
    // (async wrt draw) can score against the filter-aware chart
    // the user sees.
    let _latestNotes = null, _latestChords = null, _latestTime = 0;

    // Cached drum_tab → legacy-shape notes from the last frame. Memoised
    // on the drum_tab object identity so the conversion (kit walk + sort)
    // runs once per chart load, not per frame. Cleared on chart reset.
    let _drumTabCacheKey = null;
    let _drumTabCacheNotes = null;

    // Wave C: replace the module-level `song:ready` subscription
    // with a bundle.isReady edge-detect per-instance. The global
    // event fires N times under splitscreen (once per panel's
    // highway); edge-detecting locally scopes the reset correctly.
    let _lastBundleIsReady = false;

    // Wave C focus state
    let _isFocused = false;
    // Tracks whether we successfully subscribed to splitscreen
    // focus-change events. Necessary because subscribe is gated on
    // _ssActive() (full helper surface + isActive()===true) but
    // destroy() must still unsubscribe what was actually attached
    // — we can't re-derive "did we subscribe?" from a fresh
    // _ssActive() check at destroy time, since isActive() might
    // have flipped false (splitscreen toggled off) between init
    // and destroy. Without this flag a defensive offFocusChange
    // call against a subscription that never happened would be a
    // no-op for EventTarget but obscures intent; a missed
    // unsubscribe of one we DID register would leak the listener
    // closure across the destroy.
    let _focusSubscribed = false;

    // ── Listener refs (per-instance so destroy() detach matches) ──
    const _onWinResize = () => _applyCanvasDims();
    const _onFocusChange = () => _updateFocusState();

    // ── Focus management ──
    //
    // _instanceDestroyed is a belt-and-suspenders gate: even if the
    // splitscreen helper ever ships without an unsubscribe (or a
    // future version renames offFocusChange), the focus-change
    // handler will no-op against a destroyed instance rather than
    // mutating torn-down state. Defensive because the helper's
    // unsubscribe pathway is the only thing standing between a
    // lingering listener and a stale closure.
    let _instanceDestroyed = false;

    function _updateFocusState() {
        if (_instanceDestroyed) return;
        // _highwayCanvas is nulled by _teardown; a focus-change
        // callback fired between destroy() and the handler
        // detaching would otherwise call isCanvasFocused(null).
        if (!_highwayCanvas) return;
        const shouldFocus = _ssIsCanvasFocused(_highwayCanvas);
        if (shouldFocus && !_isFocused) {
            _isFocused = true;
            _activeInstance = instance;
        } else if (!shouldFocus && _isFocused) {
            _isFocused = false;
            // Outgoing panel: stop showing pressed lanes / flashes
            // that originated from MIDI hits the panel was the
            // recipient of while focused.
            _releaseAllSounding();
            if (_activeInstance === instance) _activeInstance = null;
        }
    }

    // Per-instance cleanup: clear visual hit state. Module-level
    // `_cfg.learnLane` is NOT touched here — it's a shared sentinel,
    // and it gets cleared by _midiConnect on device swap (which
    // already iterates every live instance to call this).
    function _releaseAllSounding() {
        _heldPads.clear();
        _wrongFlashes.length = 0;
        _laneFlashes.length = 0;
    }

    // ── MIDI event handler (called by _midiOnMessage via _activeInstance) ──

    function _handleDrumHit(midiNote, velocity, timeStamp) {
        if (midiNote < 0 || midiNote > 127) return;
        const ts = _eventTimeStamp({ timeStamp });

        // INIT-001/SPEC-005: Learn-on-pieces first (wizard), then legacy
        // lane Learn. Both writer paths PUT a piece-id kit and merge a
        // derived lane id into drums_custom_map additively.
        if (_cfg.learnPiece) {
            const pieceId = _cfg.learnPiece;
            _cfg.learnPiece = null;
            _cfg.learnLane = null;
            if (_mappingMutationsEnabled()) {
                _commitLearnAssignment(midiNote, pieceId).then(() => {
                    _updateLearnUI();
                    _refreshAllMappingTables();
                });
            } else {
                _announceMapStatus('Confirm a kit with Use this kit before mapping.', false);
            }
            _updateLearnUI();
            return;
        }
        if (_cfg.learnLane !== null) {
            const lane = DRUM_LANES[_cfg.learnLane];
            const laneId = lane && lane.id;
            const pieceId = laneId ? _primaryPieceForLane(laneId) : null;
            _cfg.learnLane = null;
            _cfg.learnPiece = null;
            if (pieceId && _mappingMutationsEnabled()) {
                _commitLearnAssignment(midiNote, pieceId).then(() => {
                    _updateLearnUI();
                    _refreshAllMappingTables();
                });
            } else if (pieceId) {
                _announceMapStatus('Confirm a kit with Use this kit before mapping.', false);
            }
            _updateLearnUI();
            _refreshAllMappingTables();
            return;
        }

        _heldPads.set(midiNote, { velocity, wall: performance.now() });
        _synthDrumHit(midiNote, velocity);
        _synthEnsureCtx();

        const laneIdx = _midiToLaneIdx(midiNote);
        if (laneIdx >= 0) {
            const lane = DRUM_LANES[laneIdx];
            _laneFlashes.push({
                laneIdx,
                wall: performance.now(),
                color: _rgbStr(lane.color[0], lane.color[1], lane.color[2], 0.6),
            });
        }

        if (_cfg.hitDetection) {
            _checkHit(midiNote, ts);
        }
    }

    // ── Hit detection / accuracy scoring (against cached filter-aware arrays) ──

    function _checkHit(playedMidi, timeStamp) {
        void timeStamp;
        const t = _latestTime;
        const notes = _latestNotes;
        const chords = _latestChords;

        // No chart cached yet (song-change reconnect window, or the
        // very first frame after init before draw has caught up). Skip
        // scoring entirely — counting a hit as a miss here would inflate
        // the miss counter every time the user noodles on the pad during
        // a song switch, with no matching notes to score against.
        const notesEmpty = !notes || notes.length === 0;
        const chordsEmpty = !chords || chords.length === 0;
        if (notesEmpty && chordsEmpty) return;

        const playedLane = _midiToLaneIdx(playedMidi);
        if (playedLane < 0) return;

        let foundHit = false;

        if (notes) {
            for (const n of notes) {
                if (n.t > t + HIT_TOLERANCE + 0.5) break;
                if (n.t < t - HIT_TOLERANCE - 0.5) continue;
                // Skip visual-only flam ghost notes — they must not consume the hit
                // window and prevent the main strike from registering.
                if (n._noScore) continue;
                const songMidi = noteToMidi(n.s, n.f);
                const songLane = _songNoteToLaneIdx(songMidi);
                const key = _noteKey(n.t, songMidi);
                if (songLane === playedLane && Math.abs(n.t - t) <= HIT_TOLERANCE && !_hitNoteKeys.has(key)) {
                    _hitNoteKeys.add(key);
                    foundHit = true;
                    break;
                }
            }
        }

        if (!foundHit && chords) {
            for (const c of chords) {
                if (c.t > t + HIT_TOLERANCE + 0.5) break;
                if (c.t < t - HIT_TOLERANCE - 0.5) continue;
                for (const cn of (c.notes || [])) {
                    const songMidi = noteToMidi(cn.s, cn.f);
                    const songLane = _songNoteToLaneIdx(songMidi);
                    const key = _noteKey(c.t, songMidi);
                    if (songLane === playedLane && Math.abs(c.t - t) <= HIT_TOLERANCE && !_hitNoteKeys.has(key)) {
                        _hitNoteKeys.add(key);
                        foundHit = true;
                        break;
                    }
                }
                if (foundHit) break;
            }
        }

        if (foundHit) {
            _hits++;
            _streak++;
            if (_streak > _bestStreak) _bestStreak = _streak;
        } else {
            _misses++;
            _streak = 0;
            _wrongFlashes.push({ lane: playedLane, wall: performance.now() });
        }
    }

    function _updateMissedNotes(t, notes, chords) {
        if (!_cfg.hitDetection) return;
        const cutoff = t - HIT_TOLERANCE - 0.05;

        if (notes) {
            for (const n of notes) {
                if (n.t > cutoff) break;
                if (n.t < cutoff - 2) continue;
                // Skip visual-only notes (e.g. flam leading ghost glyph) — the
                // user is expected to hit the main note, not the grace ornament.
                if (n._noScore) continue;
                const songMidi = noteToMidi(n.s, n.f);
                const key = _noteKey(n.t, songMidi);
                if (!_hitNoteKeys.has(key) && !_missedNoteKeys.has(key) && n.t < cutoff) {
                    _missedNoteKeys.add(key);
                }
            }
        }
        if (chords) {
            for (const c of chords) {
                if (c.t > cutoff) break;
                if (c.t < cutoff - 2) continue;
                for (const cn of (c.notes || [])) {
                    const songMidi = noteToMidi(cn.s, cn.f);
                    const key = _noteKey(c.t, songMidi);
                    if (!_hitNoteKeys.has(key) && !_missedNoteKeys.has(key) && c.t < cutoff) {
                        _missedNoteKeys.add(key);
                    }
                }
            }
        }

        const now = performance.now();
        while (_wrongFlashes.length && now - _wrongFlashes[0].wall > 400) {
            _wrongFlashes.shift();
        }
        while (_laneFlashes.length && now - _laneFlashes[0].wall > 300) {
            _laneFlashes.shift();
        }
        for (const [midi, info] of _heldPads) {
            if (now - info.wall > 200) _heldPads.delete(midi);
        }
    }

    function _resetScoring() {
        _hits = 0; _misses = 0; _streak = 0; _bestStreak = 0;
        _hitNoteKeys.clear();
        _missedNoteKeys.clear();
        _wrongFlashes.length = 0;
        _laneFlashes.length = 0;
    }

    function _resetForNewChart() {
        _resetScoring();
        _heldPads.clear();
        // Drop the drum_tab → notes memo so a song-change replay
        // doesn't keep showing the previous chart's drum hits while
        // the new bundle is still loading.
        _drumTabCacheKey = null;
        _drumTabCacheNotes = null;
        // Wave C: no _primeLatestSnapshot — we don't consult the
        // bare `window.highway` global anymore (it's the main-
        // player's highway, not ours under splitscreen). First
        // MIDI hits before the first draw() just don't score.
    }

    // ── Settings panel + gear button (per-instance) ──

    function _injectSettingsGear() {
        if (_settingsGear) return;
        const anchor = _ssSettingsAnchor(_highwayCanvas) ||
                       document.getElementById('player-controls');
        if (!anchor) return;

        const gear = document.createElement('button');
        gear.className = 'btn-drums-settings px-2 py-1.5 bg-dark-600 hover:bg-dark-500 rounded-lg text-xs text-gray-400 transition';
        gear.dataset.drumsInstance = String(_instanceId);
        gear.type = 'button';
        gear.title = 'Open drum settings';
        // Accessible name for screen readers — title alone is announced
        // inconsistently, and the glyph itself would otherwise surface
        // as "black gear" or similar ambiguous text.
        gear.setAttribute('aria-label', 'Open drum settings');
        const glyph = document.createElement('span');
        glyph.setAttribute('aria-hidden', 'true');
        glyph.textContent = '⚙';
        gear.appendChild(glyph);
        gear.onclick = _openPauseDrumSettings;

        if (_ssActive()) {
            // Splitscreen: append to the panel bar.
            anchor.appendChild(gear);
        } else {
            // Main-player: insert before the close button. Scope the
            // selector to direct children — `button:last-child` alone
            // matches any descendant button that's its own parent's
            // last child, and #player-controls contains nested wrappers
            // (e.g. #mixer-anchor > #btn-mixer) whose lone button
            // qualifies and appears earlier in document order than the
            // real close button. insertBefore on a node that isn't a
            // direct child of `anchor` throws NotFoundError DOMException.
            const closeBtn = anchor.querySelector(':scope > button:last-of-type');
            if (closeBtn && closeBtn.parentNode === anchor) anchor.insertBefore(gear, closeBtn);
            else anchor.appendChild(gear);
        }
        _settingsGear = gear;
    }

    function _removeSettingsGear() {
        if (_settingsGear) {
            _settingsGear.remove();
            _settingsGear = null;
        }
    }

    function _openPauseDrumSettings() {
        _ensureDrumEditor(function (editor) {
            if (!editor || typeof editor.openPauseDrumEditor !== 'function') return;
            _midiInit();
            _synthInit();
            editor.openPauseDrumEditor({
                onMounted: _hydrateDrumEditor,
                trapFocus: typeof window !== 'undefined' ? window._trapFocusInModal : null,
                synthVolume: _cfg.synthVolume,
                midiChannel: _cfg.midiChannel,
                hitDetection: _cfg.hitDetection,
                showLaneLabels: _cfg.showLaneLabels,
                lanePreset: _cfg.lanePreset,
            });
        });
    }

    function _removeSettingsPanel() {
        const editor = _getDrumEditor();
        const mounted = editor && editor.getMountedEditor && editor.getMountedEditor();
        if (mounted && mounted.context === 'pause' && editor.unmountDrumEditor) {
            editor.unmountDrumEditor();
        }
    }

    // ── Canvas sizing ──
    //
    // Highway.js owns the canvas element and its CSS dimensions. It already
    // sizes the canvas to the highway area (viewport minus player-controls
    // height — see static/highway.js `resize()`), so we just need to scale
    // the backing store to DPR so 2D drawing stays crisp at HiDPI. Highway
    // calls our `resize(w, h)` callback after its own resize, which we use
    // to re-apply this — see the renderer contract below.

    function _applyCanvasDims() {
        if (!_drumCanvas || !_drumCtx) return;
        const rect = _drumCanvas.getBoundingClientRect();
        const w = rect.width;
        const h = rect.height;
        if (!w || !h) return;
        const dpr = window.devicePixelRatio || 1;
        _drumCanvas.width = Math.round(w * dpr);
        _drumCanvas.height = Math.round(h * dpr);
        _drumCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    // ── Drawing ──

    function _draw(notes, chords, t, beats) {
        if (!_drumCanvas || !_drumCtx) return;

        // Update the MIDI-scoring snapshots FIRST — before the
        // no-chart-yet early return below. During a song change where
        // bundle.currentTime advances but notes/chords are still empty
        // (WS reconnect window), a drum hit between frames would
        // otherwise score against the PREVIOUS song's cached chart and
        // its stale t.
        _latestNotes = notes;
        _latestChords = chords;
        _latestTime = t;

        const W = _drumCanvas.width / (window.devicePixelRatio || 1);
        const H = _drumCanvas.height / (window.devicePixelRatio || 1);
        const ctx = _drumCtx;

        // Empty-but-loaded chart (e.g. arrangement filtered to nothing
        // by the difficulty slider, or a long rest). bundle.isReady is
        // already verified upstream in draw(); blank the overlay so
        // a previous chart's notes don't sit frozen on screen, but
        // the Wave B "treat empty as no chart and bail" early-return
        // is GONE — empty arrays during ready playback are still a
        // valid render path (paint backgrounds + lane labels even
        // without scrolling notes) so the kit lanes stay visible.
        _updateMissedNotes(t, notes, chords);

        const nowLineY = H * NOW_LINE_Y_FRAC;
        const topY = 0;
        const laneLayout = _computeLaneLayout(W, H);
        const kickIdx = DRUM_LANES.findIndex(l => l.id === 'kick');

        // ── Background ──────────────────────────────────────────────────
        ctx.fillStyle = '#040408';
        ctx.fillRect(0, 0, W, H);

        // ── Lane backgrounds (vertical columns) ─────────────────────────
        for (let i = 0; i < laneLayout.length; i++) {
            const ll = laneLayout[i];
            const [r, g, b] = ll.lane.color;

            ctx.fillStyle = _rgbStr(r * 0.06, g * 0.06, b * 0.06, 0.5);
            ctx.fillRect(ll.x, topY, ll.w, nowLineY + 20);

            ctx.strokeStyle = _rgbStr(r * 0.15, g * 0.15, b * 0.15, 0.3);
            ctx.lineWidth = 0.5;
            ctx.beginPath();
            ctx.moveTo(ll.x + ll.w, topY);
            ctx.lineTo(ll.x + ll.w, nowLineY + 20);
            ctx.stroke();

            for (const flash of _laneFlashes) {
                if (flash.laneIdx === i) {
                    const age = (performance.now() - flash.wall) / 300;
                    if (age < 1) {
                        ctx.fillStyle = _rgbStr(r, g, b, 0.25 * (1 - age));
                        ctx.fillRect(ll.x, topY, ll.w, nowLineY + 20);
                    }
                }
            }
        }

        // ── Kick lane separator ─────────────────────────────────────────
        if (kickIdx >= 0) {
            const kickLL = laneLayout[kickIdx];
            ctx.strokeStyle = 'rgba(255,80,80,0.3)';
            ctx.lineWidth = 2;
            ctx.setLineDash([4, 4]);
            ctx.beginPath();
            ctx.moveTo(kickLL.x - 2, topY);
            ctx.lineTo(kickLL.x - 2, nowLineY + 20);
            ctx.stroke();
            ctx.setLineDash([]);
        }

        // ── Beat / measure lines ────────────────────────────────────────
        if (beats) {
            for (const b of beats) {
                const dt = b.time - t;
                if (dt < -0.1 || dt > VISIBLE_SECONDS) continue;
                const y = _timeToY(dt, nowLineY, topY);
                ctx.strokeStyle = b.measure > 0 ? 'rgba(255,255,255,0.1)' : 'rgba(255,255,255,0.03)';
                ctx.lineWidth = b.measure > 0 ? 1 : 0.5;
                ctx.beginPath();
                ctx.moveTo(laneLayout[0].x, y);
                ctx.lineTo(laneLayout[laneLayout.length - 1].x + laneLayout[laneLayout.length - 1].w, y);
                ctx.stroke();
            }
        }

        // ── Now line ────────────────────────────────────────────────────
        ctx.strokeStyle = 'rgba(255,255,255,0.5)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(laneLayout[0].x, nowLineY);
        ctx.lineTo(laneLayout[laneLayout.length - 1].x + laneLayout[laneLayout.length - 1].w, nowLineY);
        ctx.stroke();

        _drawScrollingNotes(ctx, notes, chords, t, laneLayout, nowLineY, topY, W, H);

        if (_cfg.showLaneLabels) {
            _drawLaneLabels(ctx, laneLayout, nowLineY, H);
        }

        if (_cfg.hitDetection && (_hits + _misses) > 0) {
            _drawAccuracyHUD(ctx, W, H);
        }

        // MIDI indicator — show on the focused panel only; non-focused
        // panels don't receive input so the dot would be misleading.
        if (_midiInput && _isFocused) {
            ctx.fillStyle = '#22cc66';
            ctx.beginPath();
            ctx.arc(W - 20, 16, 4, 0, Math.PI * 2);
            ctx.fill();
            ctx.fillStyle = '#22cc6688';
            ctx.font = '9px sans-serif';
            ctx.textAlign = 'right';
            ctx.textBaseline = 'middle';
            ctx.fillText('MIDI', W - 28, 16);
        }
    }

    function _drawScrollingNotes(ctx, notes, chords, t, laneLayout, nowLineY, topY /* , W, H */) {
        const allNotes = [];

        if (notes) {
            for (const n of notes) {
                const dt = n.t - t;
                if (dt > VISIBLE_SECONDS + 1) break;
                if (dt < -1) continue;
                allNotes.push({ midi: noteToMidi(n.s, n.f), t: n.t, ac: n.ac });
            }
        }
        if (chords) {
            for (const c of chords) {
                const dt = c.t - t;
                if (dt > VISIBLE_SECONDS + 1) break;
                if (dt < -1) continue;
                for (const cn of (c.notes || [])) {
                    allNotes.push({ midi: noteToMidi(cn.s, cn.f), t: c.t, ac: cn.ac });
                }
            }
        }

        for (const n of allNotes) {
            const laneIdx = _songNoteToLaneIdx(n.midi);
            if (laneIdx < 0 || laneIdx >= laneLayout.length) continue;

            const ll = laneLayout[laneIdx];
            const lane = ll.lane;
            const dt = n.t - t;
            const y = _timeToY(dt, nowLineY, topY);

            if (y < -20 || y > nowLineY + 30) continue;

            const isActive = Math.abs(dt) < 0.03;

            const nk = _noteKey(n.t, n.midi);
            let useHitColor = false, useMissColor = false;
            if (_cfg.hitDetection) {
                if (_hitNoteKeys.has(nk)) useHitColor = true;
                else if (_missedNoteKeys.has(nk)) useMissColor = true;
            }

            let [cr, cg, cb] = lane.color;
            if (useHitColor) { cr = 0; cg = 1; cb = 0.27; }
            else if (useMissColor) { cr = 0.33; cg = 0.33; cb = 0.4; }

            const velFactor = n.ac ? 1.3 : 1.0;
            const cx = ll.centerX;

            if (lane.id === 'kick') {
                // Thin bar so 16th-note double-bass at 88 ms spacing
                // (≈ 26 px apart at default zoom) renders as distinct
                // bars instead of one merged strip. Previously barH=10
                // plus a 4-6 px glow on each side merged adjacent
                // kicks into a continuous block.
                const barH = Math.max(3, 4 * velFactor);
                const firstLane = laneLayout[0];
                const lastLane = laneLayout[laneLayout.length - 1];
                const fullLeft = firstLane.x;
                const fullRight = lastLane.x + lastLane.w;

                // Dim full-width underbar (replaces old wide glow — avoids
                // visibility clutter at fast rolls), then bright bar at the
                // kick lane only.
                ctx.fillStyle = _rgbStr(cr, cg, cb, useMissColor ? 0.18 : 0.4);
                ctx.fillRect(fullLeft, y - barH / 2, fullRight - fullLeft, barH);

                ctx.fillStyle = _rgbStr(cr, cg, cb, useMissColor ? 0.3 : 1);
                ctx.fillRect(ll.x + 2, y - barH / 2, ll.w - 4, barH);

                if (isActive && !useMissColor) {
                    ctx.fillStyle = _rgbStr(cr, cg, cb, 0.12);
                    ctx.fillRect(fullLeft, nowLineY - 5, fullRight - fullLeft, 10);
                }
            } else if (lane.symbol === 'square' || lane.symbol === 'square_dot') {
                const size = (ll.w * 0.32) * velFactor;
                const half = size / 2;
                ctx.fillStyle = _rgbStr(cr, cg, cb, useMissColor ? 0.3 : 1);
                ctx.fillRect(cx - half, y - half, size, size);
                if (!useMissColor) {
                    ctx.strokeStyle = 'rgba(0,0,0,0.85)';
                    ctx.lineWidth = 1;
                    ctx.strokeRect(cx - half, y - half, size, size);
                }
                if (lane.symbol === 'square_dot' && !useMissColor && half > 3) {
                    ctx.fillStyle = 'rgba(0,0,0,0.7)';
                    ctx.fillRect(cx - half * 0.28, y - half * 0.28, half * 0.56, half * 0.56);
                }
            } else if (lane.symbol === 'circle_dot') {
                const radius = (ll.w * 0.18) * velFactor;
                ctx.fillStyle = _rgbStr(cr, cg, cb, useMissColor ? 0.3 : 1);
                ctx.beginPath();
                ctx.arc(cx, y, radius, 0, Math.PI * 2);
                ctx.fill();
                if (!useMissColor) {
                    ctx.strokeStyle = 'rgba(0,0,0,0.85)';
                    ctx.lineWidth = 1;
                    ctx.beginPath();
                    ctx.arc(cx, y, radius, 0, Math.PI * 2);
                    ctx.stroke();
                    ctx.fillStyle = 'rgba(0,0,0,0.75)';
                    ctx.beginPath();
                    ctx.arc(cx, y, Math.max(1.5, radius * 0.28), 0, Math.PI * 2);
                    ctx.fill();
                }
            } else if (lane.symbol === 'hexagon') {
                const size = (ll.w * 0.22) * velFactor;
                ctx.fillStyle = _rgbStr(cr, cg, cb, useMissColor ? 0.3 : 1);
                ctx.beginPath();
                for (let i = 0; i < 6; i++) {
                    const a = (Math.PI / 3) * i - Math.PI / 6;
                    const px = cx + size * Math.cos(a);
                    const py = y + size * Math.sin(a);
                    if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
                }
                ctx.closePath();
                ctx.fill();
                if (!useMissColor) {
                    ctx.strokeStyle = 'rgba(0,0,0,0.85)';
                    ctx.lineWidth = 1;
                    ctx.stroke();
                }
            } else if (lane.symbol === 'diamond') {
                const size = (ll.w * 0.25) * velFactor;

                if (!useMissColor) {
                    const glowAlpha = isActive ? 0.5 : 0.2;
                    for (let i = 1; i >= 0; i--) {
                        const spread = (i + 1) * 2;
                        const a = glowAlpha * (0.15 + (1 - i) * 0.15);
                        ctx.strokeStyle = _rgbStr(cr, cg, cb, a);
                        ctx.lineWidth = spread;
                        ctx.beginPath();
                        ctx.moveTo(cx, y - size - spread);
                        ctx.lineTo(cx + size + spread, y);
                        ctx.lineTo(cx, y + size + spread);
                        ctx.lineTo(cx - size - spread, y);
                        ctx.closePath();
                        ctx.stroke();
                    }
                }

                ctx.fillStyle = _rgbStr(cr, cg, cb, useMissColor ? 0.3 : 1);
                ctx.beginPath();
                ctx.moveTo(cx, y - size);
                ctx.lineTo(cx + size, y);
                ctx.lineTo(cx, y + size);
                ctx.lineTo(cx - size, y);
                ctx.closePath();
                ctx.fill();
            } else if (lane.id === 'hihat') {
                const size = (ll.w * 0.22) * velFactor;
                const isOpen = n.midi === 46;
                const isPedal = n.midi === 44;
                const s = isPedal ? size * 0.6 : size;

                if (!useMissColor) {
                    const glowAlpha = isActive ? 0.5 : 0.2;
                    ctx.strokeStyle = _rgbStr(cr, cg, cb, glowAlpha * 0.3);
                    ctx.lineWidth = 4;
                    ctx.beginPath();
                    ctx.moveTo(cx - s, y - s);
                    ctx.lineTo(cx + s, y + s);
                    ctx.moveTo(cx + s, y - s);
                    ctx.lineTo(cx - s, y + s);
                    ctx.stroke();
                }

                if (isOpen) {
                    ctx.strokeStyle = _rgbStr(cr, cg, cb, useMissColor ? 0.3 : 1);
                    ctx.lineWidth = 2.5;
                    ctx.beginPath();
                    ctx.arc(cx, y, s, 0, Math.PI * 2);
                    ctx.stroke();
                    ctx.font = `bold ${Math.max(8, s * 0.7)}px sans-serif`;
                    ctx.fillStyle = _rgbStr(cr, cg, cb, useMissColor ? 0.3 : 0.8);
                    ctx.textAlign = 'center';
                    ctx.textBaseline = 'middle';
                    ctx.fillText('o', cx, y);
                } else {
                    ctx.strokeStyle = _rgbStr(cr, cg, cb, useMissColor ? 0.3 : 1);
                    ctx.lineWidth = isPedal ? 1.5 : 2.5;
                    ctx.beginPath();
                    ctx.moveTo(cx - s, y - s);
                    ctx.lineTo(cx + s, y + s);
                    ctx.moveTo(cx + s, y - s);
                    ctx.lineTo(cx - s, y + s);
                    ctx.stroke();
                }
            } else {
                // Smaller radius (0.18 of lane vs 0.25) so 16th-note tom
                // rolls / fast snares render as distinct circles instead
                // of merging into one blob. Drop the wide glow rings for
                // the same reason — they add 4-6 px of visual bleed that
                // erases the gaps between fast hits.
                const radius = (ll.w * 0.18) * velFactor;

                ctx.fillStyle = _rgbStr(cr, cg, cb, useMissColor ? 0.3 : 1);
                ctx.beginPath();
                ctx.arc(cx, y, radius, 0, Math.PI * 2);
                ctx.fill();

                // Hard outline so adjacent circles are still individually
                // readable even when they're touching at very dense rolls.
                if (!useMissColor) {
                    ctx.strokeStyle = 'rgba(0,0,0,0.85)';
                    ctx.lineWidth = 1;
                    ctx.beginPath();
                    ctx.arc(cx, y, radius, 0, Math.PI * 2);
                    ctx.stroke();
                }

                if (!useMissColor && radius > 4) {
                    const grad = ctx.createRadialGradient(cx - radius * 0.3, y - radius * 0.3, 0, cx, y, radius);
                    grad.addColorStop(0, _rgbStr(Math.min(cr + 0.3, 1), Math.min(cg + 0.3, 1), Math.min(cb + 0.3, 1), 0.4));
                    grad.addColorStop(1, 'rgba(0,0,0,0)');
                    ctx.fillStyle = grad;
                    ctx.beginPath();
                    ctx.arc(cx, y, radius, 0, Math.PI * 2);
                    ctx.fill();
                }
            }
        }
    }

    function _drawLaneLabels(ctx, laneLayout, nowLineY, H) {
        const labelY = nowLineY + 8;
        const labelH = H - labelY;

        ctx.fillStyle = 'rgba(8,8,20,0.85)';
        ctx.fillRect(0, labelY, laneLayout[laneLayout.length - 1].x + laneLayout[laneLayout.length - 1].w + 10, labelH);

        ctx.strokeStyle = 'rgba(255,255,255,0.1)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(0, labelY);
        ctx.lineTo(laneLayout[laneLayout.length - 1].x + laneLayout[laneLayout.length - 1].w + 10, labelY);
        ctx.stroke();

        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';

        for (const ll of laneLayout) {
            const [r, g, b] = ll.lane.color;
            ctx.font = 'bold 11px sans-serif';
            ctx.fillStyle = _rgbStr(r, g, b, 0.9);
            ctx.fillText(ll.lane.label, ll.centerX, labelY + labelH / 2);
        }
    }

    function _drawAccuracyHUD(ctx, W /* , H */) {
        const total = _hits + _misses;
        if (total === 0) return;

        const pct = Math.round((_hits / total) * 100);
        const text = `Accuracy: ${pct}%   Streak: ${_streak}   Best: ${_bestStreak}   ${_hits}/${total}`;

        ctx.font = 'bold 12px sans-serif';
        const tw = ctx.measureText(text).width;
        const hudW = tw + 24;
        const hudH = 24;
        const hudX = (W - hudW) / 2;
        const hudY = 6;

        ctx.fillStyle = 'rgba(8,8,20,0.75)';
        _roundRect(ctx, hudX, hudY, hudW, hudH, 6);
        ctx.fill();

        ctx.fillStyle = pct >= 80 ? '#22cc66' : pct >= 50 ? '#ffcc33' : '#ff6644';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(text, W / 2, hudY + hudH / 2);
    }

    // ── Teardown ──

    function _teardown() {
        // We render directly onto the canvas highway.js gives us — don't
        // remove or hide it (the next renderer needs the same element).
        // Clear our paint so a quick re-init doesn't show stale drums.
        if (_drumCanvas && _drumCtx) {
            try {
                _drumCtx.save();
                _drumCtx.setTransform(1, 0, 0, 1, 0, 0);
                _drumCtx.clearRect(0, 0, _drumCanvas.width, _drumCanvas.height);
                _drumCtx.restore();
            } catch (_) {}
        }
        _drumCanvas = null;
        _drumCtx = null;
        _highwayCanvas = null;

        _removeSettingsPanel();
        _removeSettingsGear();

        _releaseAllSounding();

        _latestNotes = null;
        _latestChords = null;
        _latestTime = 0;
    }

    // ── Factory return: setRenderer contract ──

    const instance = {
        init(canvas /* , bundle */) {
            // Defensive teardown if a prior init wasn't paired with
            // destroy. Remove listeners, restore canvas, release
            // held state — mirrors destroy() exactly, INCLUDING
            // removing from _instances and pausing MIDI if we're
            // the last live instance. Without the _instances
            // cleanup, a re-init that subsequently fails early
            // (no mount / null ctx) would leave the instance
            // orphaned in the set, making _instances.size checks
            // inaccurate and preventing _midiPauseHandler from
            // ever running.
            if (_drumCanvas || _isReady) {
                window.removeEventListener('resize', _onWinResize);
                if (_focusSubscribed) {
                    const ss = window.slopsmithSplitscreen;
                    if (ss && typeof ss.offFocusChange === 'function') {
                        ss.offFocusChange(_onFocusChange);
                    }
                    _focusSubscribed = false;
                }
                _instances.delete(instance);
                if (_activeInstance === instance) _activeInstance = null;
                _teardown();
                _isReady = false;
                _isFocused = false;
                if (_instances.size === 0) {
                    _midiReleaseSession();
                    _releaseMidiStateSub();
                    _unbindDrumInputContract();
                }
            }

            // Clear the destroyed sentinel so an init() following a
            // destroy() on the same factory object (e.g. highway
            // re-using a renderer across songs) re-enables focus
            // updates. Set to true in destroy() above — without this
            // reset, _updateFocusState would permanently no-op.
            _instanceDestroyed = false;

            // Use the canvas highway.js gives us directly — same pattern
            // as the 3D Highway plugin. Highway's CSS sizing already
            // excludes the player-controls strip, so the controls stay
            // visible at the bottom without us touching the layout. No
            // overlay, no display:none on the highway canvas, no
            // visibility-override workaround.
            _highwayCanvas = canvas;
            _drumCanvas = canvas;
            _drumCtx = canvas ? canvas.getContext('2d') : null;
            if (!_drumCanvas || !_drumCtx) {
                console.warn('[Drums] init: 2D context unavailable on highway canvas; aborting');
                _drumCanvas = null;
                _drumCtx = null;
                _highwayCanvas = null;
                return;
            }

            _injectSettingsGear();
            _applyCanvasDims();
            window.addEventListener('resize', _onWinResize);

            const ss = window.slopsmithSplitscreen;
            // Subscribe only when splitscreen is FULLY supported and
            // active (matches the rest of the plugin's helper gating
            // through _ssActive). A partial helper that exposes
            // on/offFocusChange but lacks isCanvasFocused / panelChrome
            // / settingsAnchor would otherwise let us subscribe while
            // _ssIsCanvasFocused falls back to "always focused"
            // (main-player path), so every instance would race to
            // claim _activeInstance on every focus event and break
            // MIDI routing under the partial helper.
            if (_ssActive()) {
                ss.onFocusChange(_onFocusChange);
                _focusSubscribed = true;
            }

            _resetForNewChart();

            _instances.add(instance);

            // Kick off MIDI + synth. One-time init — subsequent
            // instances no-op out because the module singletons are
            // already populated.
            _midiInit();
            _synthInit();
            _bindDrumInputContract();
            _bindMidiDeviceScoring();
            _consumeCoreKits();

            _isReady = true;

            // Determine focus BEFORE resuming the MIDI handler so
            // _activeInstance is populated when onmidimessage gets
            // wired. Otherwise a MIDI message arriving in the
            // window between _midiResumeHandler and the first
            // focus-change event would route through _midiOnMessage
            // → null _activeInstance → silently dropped. Main-player
            // fast path takes effect synchronously here too.
            _updateFocusState();
            _midiResumeHandler();
        },
        draw(bundle) {
            if (!_isReady || !bundle) return;

            // Wave C: bundle.isReady edge detect in place of the
            // global song:ready subscription. Each panel's highway
            // emits song:ready independently; subscribing at module
            // scope would fire N×. Edge-detecting per-instance
            // correctly scopes the reset.
            const isReady = !!bundle.isReady;
            if (isReady && !_lastBundleIsReady) {
                _resetForNewChart();
            }
            _lastBundleIsReady = isReady;

            // Refresh the MIDI-scoring snapshot from the LATEST bundle
            // even on unready frames. Otherwise a pad hit during the
            // loading / reconnect window scores against the PREVIOUS
            // chart's _latestNotes (which still hold last song's data
            // until _draw refreshes them). After bundle.isReady falls
            // false the new song's notes/chords typically arrive as
            // [] until the chart loads — that's exactly what we want
            // here: _checkHit's `notesEmpty && chordsEmpty` guard
            // bails so unready hits neither score nor mis-score, and
            // the scoring resumes naturally on the first ready frame.
            //
            // drum_tab takes precedence over the standard notes stream.
            // When the active sloppak ships a `drum_tab:` manifest key,
            // the server suppresses irrelevant chord/handshape streams
            // for the drum view and the plugin renders + scores against
            // the canonical drum_tab hits via _drumTabHitsToNotes.
            let drumNotes = null;
            let drumChords = null;
            const dt = bundle.drumTab;
            if (dt && Array.isArray(dt.hits)) {
                if (_drumTabCacheKey !== dt) {
                    _drumTabCacheKey = dt;
                    _drumTabCacheNotes = _drumTabHitsToNotes(dt.hits);
                }
                drumNotes = _drumTabCacheNotes;
                drumChords = [];  // drum_tab carries no chord templates
            } else {
                // Legacy path: drums encoded as guitar notes
                // (`midi = string * 24 + fret`). The renderer's existing
                // _songNoteToLaneIdx already decodes them.
                drumNotes = bundle.notes;
                drumChords = bundle.chords;
            }
            _latestNotes = drumNotes;
            _latestChords = drumChords;
            _latestTime = bundle.currentTime;

            // Loading / reconnect window — chart isn't confirmed
            // yet. Paint the plugin's base background so the
            // previous chart's notes + HUD don't sit frozen on
            // screen. Once bundle.isReady flips true we hand off to
            // _draw which paints lanes + scrolling notes.
            if (!isReady) {
                if (_drumCanvas && _drumCtx) {
                    const W = _drumCanvas.width / (window.devicePixelRatio || 1);
                    const H = _drumCanvas.height / (window.devicePixelRatio || 1);
                    _drumCtx.fillStyle = '#040408';
                    _drumCtx.fillRect(0, 0, W, H);
                }
                return;
            }

            _draw(drumNotes, drumChords, bundle.currentTime, bundle.beats);
        },
        resize(/* w, h */) {
            if (!_isReady) return;
            _applyCanvasDims();
        },
        destroy() {
            _isReady = false;
            // Set BEFORE attempting the (best-effort) unsubscribe so
            // the focus-change handler's _instanceDestroyed guard
            // catches any event that sneaks through a failed /
            // missing offFocusChange call.
            _instanceDestroyed = true;
            window.removeEventListener('resize', _onWinResize);
            if (_focusSubscribed) {
                const ss = window.slopsmithSplitscreen;
                if (ss && typeof ss.offFocusChange === 'function') {
                    ss.offFocusChange(_onFocusChange);
                }
                _focusSubscribed = false;
            }
            _instances.delete(instance);
            if (_activeInstance === instance) _activeInstance = null;
            _isFocused = false;
            // Pause the MIDI handler only if we're the last instance
            // standing. Otherwise other instances still need MIDI
            // events flowing into _midiOnMessage (which routes to the
            // currently-focused instance).
            if (_instances.size === 0) {
                _midiReleaseSession();
                _releaseMidiStateSub();
                _unbindDrumInputContract();
            }
            _teardown();
        },
        // Internal hooks used by module-level MIDI router + device-swap.
        _handleDrumHit,
        _releaseAllSounding,
        _resetScoring,
    };

    return instance;
}

createFactory.matchesArrangement = function (songInfo) {
    if (!songInfo) return false;
    // First-class signal: sloppaks with a top-level `drum_tab:` manifest
    // key ship a `has_drum_tab` flag on song_info regardless of which
    // guitar arrangement the user picked. The drum tab lives off to the
    // side of the arrangements list, so name-pattern matching alone
    // would miss it (a sloppak with a `Lead` arrangement + a drum_tab
    // is still drummable).
    if (songInfo.has_drum_tab) return true;
    if (songInfo.arrangement && DRUMS_PATTERNS.test(songInfo.arrangement)) return true;
    if (Array.isArray(songInfo.arrangements)) {
        const idx = songInfo.arrangement_index;
        const arr = songInfo.arrangements.find(a => a.index === idx);
        if (arr && DRUMS_PATTERNS.test(arr.name)) return true;
    }
    return false;
};

window.slopsmithViz_drums = createFactory;
// slopsmith→feedBack rename: host viz picker looks up `window.feedBackViz_<id>`.
window.feedBackViz_drums = window.slopsmithViz_drums;

// Node-only export hook for tests; browsers keep the window.*Viz_drums wiring.
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        noteToMidi, _rgbStr, _validateCustomMapping, _drumTabHitsToNotes,
        _applyLanePreset, _getActiveDrumMap, _midiToLaneIdx, _songNoteToLaneIdx,
        _midiResolveSaved, DRUM_LANES, PIECE_DEFAULT_MIDI, LANE_PRESETS,
        matchesArrangement: createFactory.matchesArrangement,
        // INIT-001/SPEC-005
        _validatePieceMapping, _parseKitNotes, _applyVocabulary, _applyActiveKitNotes,
        _pieceToLaneId, _deriveLaneMapFromPieces, _mergeLaneMapAdditive,
        _suggestKitsForSource, _eventTimeStamp, _midiOnMessage, _escapeHtml,
        _commitLearnAssignment, _confirmActiveKit, _primaryPieceForLane,
        _sanitizeKitList,
        // INIT-002/SPEC-003
        _mappingMutationsEnabled, _buildMappingRows, _buildNoteChipsHtml,
        _pieceDisplayName, _gmMidiNotesForPiece, _customMidiNotesForPiece,
        _removeCustomNote, _undoLastRemoval, _refetchActiveKit,
        _onDrumInputChange, _bindDrumInputContract, _unbindDrumInputContract,
        _drumInputSubscriberCount, _applySharedSettings, _setSharedSetting,
        _noteEndpoint, _announceMapStatus,
        _setActiveInstance(inst) { _activeInstance = inst; },
        _getKitNotes() { return _kitNotes; },
        _getActiveKitId() { return _activeKitId; },
        _getPendingKitId() { return _pendingKitId; },
        _setPendingKitId(id) {
            _pendingKitId = typeof id === 'string' ? id : '';
            _kitConfirmSeq += 1;
        },
        _setConfirmedKit(kitId, kit) {
            _activeKitId = (typeof kitId === 'string' && _KIT_ID_RE.test(kitId)) ? kitId : null;
            _pendingKitId = _activeKitId || '';
            _applyActiveKitNotes(kit || null);
        },
        _getMapStatus() { return { text: _mapStatusText, allowUndo: _mapStatusAllowUndo, lastRemoval: _lastRemoval }; },
        _getLifecycleCounts() {
            return {
                drumInputSubs: _drumInputUnsub ? 1 : 0,
                midiHandle: _midiHandle ? 1 : 0,
                midiListener: _midiListener ? 1 : 0,
                midiStateSub: _midiStateSub ? 1 : 0,
            };
        },
        _setKitList(list) { _kitList = Array.isArray(list) ? list : []; },
        _saveCfg,
        _cfg,
        _knownPieces,
        // INIT-003/SPEC-005
        mountDrumEditor: function (host, opts) {
            const editor = _getDrumEditor();
            return editor ? editor.mountDrumEditor(host, Object.assign({ onMounted: _hydrateDrumEditor }, opts || {})) : null;
        },
        unmountDrumEditor: function () {
            const editor = _getDrumEditor();
            if (editor) editor.unmountDrumEditor();
        },
        _getDrumEditor, _hydrateDrumEditor, _collectProfilePatch, _applyDrumProfile,
        _bootSettingsEditor, _learnLockMessage, _isLearnLockedStatus, _fetchJsonResult,
        _persistEditorPatch, _onDrumProfileChange,
        _refetchAttachedDevice, _applyDeviceNotes, _clearAttachedDevice, _onMidiDeviceChange,
        _bindMidiDeviceScoring, _normalizeAttachedDeviceId,
        _getAttachedDeviceId() { return _attachedDeviceId; },
        _getDeviceNotes() { return _deviceNotes; },
        _setAttachedDevice(id, device) {
            _attachedDeviceId = _normalizeAttachedDeviceId(id);
            if (!_attachedDeviceId) {
                _deviceNotes = null;
                return;
            }
            _applyDeviceNotes(device || null);
        },
    };
}

})();
