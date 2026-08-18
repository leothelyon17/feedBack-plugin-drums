'use strict';
// INIT-001/SPEC-005: mapping validation, dual-read, timestamp plumbing,
// symbol uniqueness, kit confirm (never auto-bind).
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

function freshPlugin() {
    global.window = {};
    global.localStorage = { getItem: () => null, setItem: () => {} };
    global.document = {
        addEventListener: () => {},
        querySelectorAll: () => [],
    };
    global.fetch = async () => ({ ok: true, json: async () => ({}) });
    const file = path.join(__dirname, '..', 'screen.js');
    delete require.cache[require.resolve(file)];
    return require(file);
}

test('_validateCustomMapping still rejects piece-ids in the legacy store', () => {
    const mod = freshPlugin();
    assert.equal(mod._validateCustomMapping({ '38': 'tom_hi' }), null);
    assert.equal(mod._validateCustomMapping({ '38': 'snare_xstick' }), null);
    assert.deepEqual({ ...mod._validateCustomMapping({ '38': 'snare' }) }, { 38: 'snare' });
});

test('_validatePieceMapping accepts known piece-ids and strips prototype keys', () => {
    const mod = freshPlugin();
    const clean = mod._validatePieceMapping({
        '38': 'tom_hi',
        '200': 'kick',
        '__proto__': 'snare',
        constructor: 'kick',
        prototype: 'ride',
        '36': 'kick',
    });
    assert.equal(clean[38], 'tom_hi');
    assert.equal(clean[36], 'kick');
    assert.equal(clean[200], undefined);
    assert.equal(Object.getPrototypeOf(clean), null);
});

test('_validatePieceMapping skips unknown piece-ids (untrusted kit JSON)', () => {
    const mod = freshPlugin();
    const parsed = mod._parseKitNotes({ notes: { '38': 'not_a_piece', '36': 'kick' } });
    assert.equal(parsed[36], 'kick');
    assert.equal(parsed[38], undefined);
});

test('ac-1: unset active_kit + valid legacy map scores like pre-change Learn', () => {
    const mod = freshPlugin();
    mod._saveCfg('customMapping', { 38: 'kick', 36: 'snare' });
    const kick = mod.DRUM_LANES.findIndex(l => l.id === 'kick');
    const snare = mod.DRUM_LANES.findIndex(l => l.id === 'snare');
    assert.equal(mod._midiToLaneIdx(38), kick);
    assert.equal(mod._midiToLaneIdx(36), snare);
});

test('ac-2: active_kit piece-id map wins over GM collision', () => {
    const mod = freshPlugin();
    mod._applyLanePreset('phase_shift_8');
    const snare = mod.DRUM_LANES.findIndex(l => l.id === 'snare');
    const tom1 = mod.DRUM_LANES.findIndex(l => l.id === 'tom1');
    assert.equal(mod._midiToLaneIdx(38), snare);
    mod._applyActiveKitNotes({ notes: { '38': 'tom_hi' } });
    assert.equal(mod._midiToLaneIdx(38), tom1);
    assert.notEqual(mod._midiToLaneIdx(38), snare);
});

test('dual-read: active_kit wins over a legacy customMapping on the same note', () => {
    const mod = freshPlugin();
    mod._saveCfg('customMapping', { 38: 'kick' });
    const kick = mod.DRUM_LANES.findIndex(l => l.id === 'kick');
    const tom1 = mod.DRUM_LANES.findIndex(l => l.id === 'tom1');
    assert.equal(mod._midiToLaneIdx(38), kick);
    mod._applyActiveKitNotes({ notes: { '38': 'tom_hi' } });
    assert.equal(mod._midiToLaneIdx(38), tom1);
});

test('empty kit notes fall through to GM', () => {
    const mod = freshPlugin();
    mod._applyActiveKitNotes({ notes: {} });
    const snare = mod.DRUM_LANES.findIndex(l => l.id === 'snare');
    assert.equal(mod._midiToLaneIdx(38), snare);
});

test('rb4 piece map has no tom2 lane', () => {
    const mod = freshPlugin();
    mod._applyLanePreset('rb4');
    assert.equal(mod._pieceToLaneId('tom_mid', 'rb4'), 'tom1');
    assert.equal(mod.DRUM_LANES.findIndex(l => l.id === 'tom2'), -1);
});

test('ac-3: Learn PUT writes piece-ids and additive lane ids (not piece-ids in legacy store)', async () => {
    const puts = [];
    const mod = freshPlugin();
    global.fetch = async (url, init) => {
        puts.push({ url, init });
        return { ok: true, json: async () => ({ id: 'user-kit' }) };
    };
    const result = await mod._commitLearnAssignment(48, 'tom_hi');
    assert.equal(result.pieceId, 'tom_hi');
    assert.equal(result.laneId, 'tom1');
    const put = puts.find(p => p.init && p.init.method === 'PUT');
    assert.ok(put, 'expected PUT /api/drums/kits/{id}');
    const body = JSON.parse(put.init.body);
    assert.equal(body.notes['48'], 'tom_hi');
    assert.equal(mod._cfg.customMapping[48], 'tom1');
    assert.equal(mod._validateCustomMapping({ 48: 'tom_hi' }), null);
    assert.equal(mod._getActiveKitId(), null);
});

test('ac-4: _midiOnMessage forwards e.timeStamp or 0', () => {
    const mod = freshPlugin();
    const hits = [];
    mod._setActiveInstance({
        _handleDrumHit(note, velocity, timeStamp) {
            hits.push({ note, velocity, timeStamp });
        },
    });
    mod._midiOnMessage({ data: [0x99, 38, 100], timeStamp: 12.5 });
    mod._midiOnMessage({ data: [0x99, 40, 90] });
    assert.equal(hits.length, 2);
    assert.equal(hits[0].note, 38);
    assert.equal(hits[0].timeStamp, 12.5);
    assert.equal(hits[1].timeStamp, 0);
    assert.equal(mod._eventTimeStamp({}), 0);
    assert.equal(mod._eventTimeStamp({ timeStamp: Number.NaN }), 0);
});

test('ac-5: phase_shift_8 snare/toms use distinct non-hue symbols; crash vs ride differ', () => {
    const mod = freshPlugin();
    const preset = mod.LANE_PRESETS.phase_shift_8;
    const byId = Object.fromEntries(preset.map(l => [l.id, l.symbol]));
    const tomSymbols = [byId.snare, byId.tom1, byId.tom2, byId.tom3];
    assert.notEqual(new Set(tomSymbols).size, 1, 'snare/toms must not share one symbol');
    assert.ok(new Set(tomSymbols).size >= 3, 'at least two non-hue differentiators among snare/toms');
    assert.notEqual(byId.snare, byId.tom1);
    assert.notEqual(byId.snare, byId.tom2);
    assert.notEqual(byId.crash, byId.ride);
    assert.notEqual(byId.crash, 'circle');
});

test('ac-6: port-key matching suggests and never auto-applies', () => {
    const mod = freshPlugin();
    const kits = [
        { id: 'alesis-strata-prime', name: 'Alesis Strata Prime', manufacturer: 'Alesis' },
        { id: 'other-kit', name: 'Other', manufacturer: 'Roland' },
    ];
    const hits = mod._suggestKitsForSource('webmidi:alesis-strata-prime', kits);
    assert.deepEqual(hits, ['alesis-strata-prime']);
    assert.deepEqual(mod._suggestKitsForSource('webmidi:opaque-uuid', kits), []);
    assert.equal(mod._getActiveKitId(), null);
});

test('_escapeHtml prevents kit name XSS interpolation', () => {
    const mod = freshPlugin();
    assert.equal(mod._escapeHtml('<img src=x onerror=alert(1)>'),
        '&lt;img src=x onerror=alert(1)&gt;');
});

test('_deriveLaneMapFromPieces never emits piece-ids into the lane map', () => {
    const mod = freshPlugin();
    const lanes = mod._deriveLaneMapFromPieces({ 38: 'tom_hi', 24: 'kick' });
    assert.equal(lanes[38], 'tom1');
    assert.equal(lanes[24], 'kick');
    assert.equal(mod._validateCustomMapping(lanes)[38], 'tom1');
});

test('vocabulary apply includes stack/bell piece-ids', () => {
    const mod = freshPlugin();
    const ok = mod._applyVocabulary({
        pieces: {
            kick: { midi: [36] },
            snare: { midi: [38] },
            stack: { midi: [30] },
            bell: { midi: [80] },
        },
        presets: {
            phase_shift_8: [
                { pieces: ['snare'], label: 'Sn' },
                { pieces: ['kick'], label: 'Ki' },
                { pieces: ['stack'], label: 'Cr' },
                { pieces: ['bell'], label: 'Ri' },
            ],
        },
    });
    assert.equal(ok, true);
    assert.ok(mod._knownPieces().has('stack'));
    assert.ok(mod._knownPieces().has('bell'));
});
