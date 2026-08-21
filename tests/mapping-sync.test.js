'use strict';
// INIT-002/SPEC-003: atomic 2D mapping removal, shared-contract sync,
// accessible chips, confirmed-kit gating, and lifecycle cleanup.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

function freshPlugin(opts) {
    const store = Object.assign({}, (opts && opts.store) || {});
    global.window = (opts && opts.window) || {};
    global.localStorage = {
        getItem: (k) => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null),
        setItem: (k, v) => { store[k] = String(v); },
        _store: store,
    };
    global.document = {
        addEventListener: () => {},
        querySelectorAll: () => [],
    };
    global.fetch = opts && opts.fetch
        ? opts.fetch
        : async () => ({ ok: true, json: async () => ({}) });
    const file = path.join(__dirname, '..', 'screen.js');
    delete require.cache[require.resolve(file)];
    const mod = require(file);
    mod._store = store;
    return mod;
}

function kitResponse(notes, extra) {
    return Object.assign({
        kit: { id: 'user-kit', notes: notes || {} },
        mutation: { midi_note: 24, operation: 'set', piece_id: 'kick' },
        resolution: { piece_id: 'kick', source: 'kit' },
    }, extra || {});
}

function installDrumInputFake(windowObj) {
    const listeners = [];
    let notifyCount = 0;
    const state = {
        version: 1,
        revision: { clock: 1, origin: 'test', sequence: 1 },
        deviceEnabled: false,
        midiChannel: 9,
        hitDetection: true,
        synthVolume: 0.4,
    };
    const di = {
        version: 1,
        EVENT: 'feedback:drum-input-change',
        get() { return Object.assign({}, state, { revision: Object.assign({}, state.revision) }); },
        update(partial) {
            Object.assign(state, partial);
            return di.get();
        },
        subscribe(fn) {
            listeners.push(fn);
            return function unsubscribe() {
                const i = listeners.indexOf(fn);
                if (i >= 0) listeners.splice(i, 1);
            };
        },
        unsubscribe(fn) {
            const i = listeners.indexOf(fn);
            if (i >= 0) listeners.splice(i, 1);
        },
        notifyMappingChange() {
            notifyCount += 1;
            return { version: 1, mutation: 'set' };
        },
        _listeners: listeners,
        _notifyCount() { return notifyCount; },
    };
    windowObj.feedBack = {
        drumInput: di,
        on() {},
        off() {},
        emit() {},
    };
    return di;
}

test('REQ-007: no active kit leaves Learn/remove disabled', () => {
    const mod = freshPlugin();
    assert.equal(mod._getActiveKitId(), null);
    assert.equal(mod._mappingMutationsEnabled(), false);
    const rows = mod._buildMappingRows();
    assert.match(rows, /aria-disabled="true"/);
    assert.match(rows, /disabled/);
    assert.doesNotMatch(mod._buildNoteChipsHtml('kick'), /drums-note-remove/);
});

test('REQ-007: selecting a kit without Use this kit keeps mutations disabled', async () => {
    const mod = freshPlugin();
    mod._setKitList([{ id: 'user-kit', name: 'User', notes: {} }]);
    mod._setPendingKitId('user-kit');
    assert.equal(mod._mappingMutationsEnabled(), false);
    assert.equal(mod._getActiveKitId(), null);
});

test('REQ-007: confirmed kit matching the selection enables mutations', async () => {
    const mod = freshPlugin();
    mod._setConfirmedKit('user-kit', { notes: { '24': 'kick' } });
    assert.equal(mod._mappingMutationsEnabled(), true);
    const html = mod._buildNoteChipsHtml('kick');
    assert.match(html, /aria-label="Remove MIDI note 24 from Kick"/);
    assert.doesNotMatch(html, /disabled/);
});

test('REQ-007: a stale confirm cannot enable controls for a newer selection', async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const mod = freshPlugin();
    global.fetch = async (url) => {
        if (String(url).includes('/api/drums/kits/kit-a')) {
            await gate;
            return { ok: true, json: async () => ({ id: 'kit-a', notes: { '24': 'kick' } }) };
        }
        if (String(url).includes('/api/settings')) {
            return { ok: true, json: async () => ({}) };
        }
        return { ok: true, json: async () => ({ id: 'kit-b', notes: {} }) };
    };
    mod._setKitList([
        { id: 'kit-a', name: 'A', notes: {} },
        { id: 'kit-b', name: 'B', notes: {} },
    ]);
    mod._setPendingKitId('kit-a');
    const pending = mod._confirmActiveKit('kit-a');
    mod._setPendingKitId('kit-b');
    release();
    const ok = await pending;
    assert.equal(ok, false);
    assert.equal(mod._getActiveKitId(), null);
    assert.equal(mod._mappingMutationsEnabled(), false);
});

test('REQ-007: Learn does not write active_kit', async () => {
    const calls = [];
    const mod = freshPlugin();
    global.fetch = async (url, init) => {
        calls.push({ url: String(url), method: (init && init.method) || 'GET', body: init && init.body });
        if (String(url).includes('/notes/')) {
            return { ok: true, json: async () => kitResponse({ '48': 'tom_hi' }, {
                mutation: { midi_note: 48, operation: 'set', piece_id: 'tom_hi' },
                resolution: { piece_id: 'tom_hi', source: 'kit' },
            }) };
        }
        return { ok: true, json: async () => ({}) };
    };
    mod._setConfirmedKit('user-kit', { notes: {} });
    await mod._commitLearnAssignment(48, 'tom_hi');
    assert.equal(calls.some(c => c.url.includes('/api/settings')), false);
});

test('REQ-001: Learn PUT happens before the legacy map changes', async () => {
    const order = [];
    const mod = freshPlugin();
    global.fetch = async (url, init) => {
        if (init && init.method === 'PUT' && String(url).includes('/notes/')) {
            order.push('api');
            assert.equal(mod._cfg.customMapping, null);
            return { ok: true, json: async () => kitResponse({ '48': 'tom_hi' }, {
                mutation: { midi_note: 48, operation: 'set', piece_id: 'tom_hi' },
            }) };
        }
        return { ok: true, json: async () => ({}) };
    };
    mod._setConfirmedKit('user-kit', { notes: {} });
    await mod._commitLearnAssignment(48, 'tom_hi');
    order.push('legacy');
    assert.deepEqual(order, ['api', 'legacy']);
    assert.equal(mod._cfg.customMapping[48], 'tom1');
});

test('REQ-001: API failure leaves legacy map and kit notes unchanged', async () => {
    const mod = freshPlugin();
    global.fetch = async () => ({ ok: false, json: async () => ({}) });
    mod._setConfirmedKit('user-kit', { notes: { '24': 'kick' } });
    mod._saveCfg('customMapping', { 24: 'kick' });
    const result = await mod._commitLearnAssignment(48, 'tom_hi');
    assert.equal(result, null);
    assert.equal(mod._cfg.customMapping[24], 'kick');
    assert.equal(mod._cfg.customMapping[48], undefined);
    assert.equal(mod._getKitNotes()[24], 'kick');
    assert.equal(mod._getKitNotes()[48], undefined);
    assert.match(mod._getMapStatus().text, /unchanged/i);
});

test('REQ-001: Learn without a confirmed kit does not call the API', async () => {
    const calls = [];
    const mod = freshPlugin();
    global.fetch = async (url, init) => {
        calls.push({ url, init });
        return { ok: true, json: async () => kitResponse({}) };
    };
    const result = await mod._commitLearnAssignment(48, 'tom_hi');
    assert.equal(result, null);
    assert.equal(calls.length, 0);
    assert.equal(mod._cfg.customMapping, null);
});

test('REQ-002: a 3D-origin mapping event refetches once and does not reemit', async () => {
    const win = {};
    const di = installDrumInputFake(win);
    let fetches = 0;
    const mod = freshPlugin({
        window: win,
        fetch: async (url) => {
            if (String(url).includes('/api/drums/kits/')) {
                fetches += 1;
                return { ok: true, json: async () => ({ id: 'user-kit', notes: { '24': 'kick' } }) };
            }
            return { ok: true, json: async () => ({}) };
        },
    });
    mod._setConfirmedKit('user-kit', { notes: {} });
    const before = di._notifyCount();
    await mod._onDrumInputChange({
        version: 1,
        mutation: 'delete',
        midiNote: 24,
        kitId: 'user-kit',
        changedKeys: [],
        origin: '3d-highway',
    });
    assert.equal(fetches, 1);
    assert.equal(di._notifyCount(), before);
    assert.equal(mod._getKitNotes()[24], 'kick');
});

test('REQ-002: a second mapping event refetches again without echoing notify', async () => {
    const win = {};
    const di = installDrumInputFake(win);
    let fetches = 0;
    const mod = freshPlugin({
        window: win,
        fetch: async () => {
            fetches += 1;
            return { ok: true, json: async () => ({ id: 'user-kit', notes: { '38': 'snare' } }) };
        },
    });
    mod._setConfirmedKit('user-kit', { notes: {} });
    await mod._onDrumInputChange({ version: 1, mutation: 'set', midiNote: 38, kitId: 'user-kit', changedKeys: [] });
    await mod._onDrumInputChange({ version: 1, mutation: 'set', midiNote: 38, kitId: 'user-kit', changedKeys: [] });
    assert.equal(fetches, 2);
    assert.equal(di._notifyCount(), 0);
});

test('REQ-004/008: custom chips are labeled, keyboard-operable, GM chips are not removable', () => {
    const mod = freshPlugin();
    mod._setConfirmedKit('user-kit', { notes: { '24': 'kick' } });
    const html = mod._buildNoteChipsHtml('kick');
    assert.match(html, /drums-note-chip--custom/);
    assert.match(html, /drums-note-chip--gm/);
    assert.match(html, /type="button"/);
    assert.match(html, /aria-label="Remove MIDI note 24 from Kick"/);
    assert.match(html, />×</);
    assert.match(html, /min-width:24px/);
    assert.match(html, /GM default MIDI note 36 for Kick/);
    assert.doesNotMatch(html, /Remove MIDI note 36/);
    const gmOnly = mod._buildNoteChipsHtml('snare');
    assert.match(gmOnly, /drums-note-chip--gm/);
    assert.doesNotMatch(gmOnly, /drums-note-remove/);
});

test('REQ-004: remove click deletes via API then drops the legacy note', async () => {
    const calls = [];
    const mod = freshPlugin();
    global.fetch = async (url, init) => {
        calls.push({ url: String(url), method: (init && init.method) || 'GET' });
        if (init && init.method === 'DELETE') {
            assert.equal(mod._cfg.customMapping[24], 'kick');
            return {
                ok: true,
                json: async () => ({
                    kit: { id: 'user-kit', notes: {} },
                    mutation: { midi_note: 24, operation: 'delete', piece_id: null },
                    resolution: { piece_id: 'kick', source: 'gm' },
                }),
            };
        }
        return { ok: true, json: async () => ({}) };
    };
    mod._setConfirmedKit('user-kit', { notes: { '24': 'kick' } });
    mod._saveCfg('customMapping', { 24: 'kick' });
    const result = await mod._removeCustomNote(24, 'kick');
    assert.equal(result.ok, true);
    assert.equal(result.resolution.source, 'gm');
    assert.equal(mod._getKitNotes()[24], undefined);
    assert.equal(mod._cfg.customMapping, null);
    assert.ok(calls.some(c => c.method === 'DELETE' && c.url.includes('/notes/24')));
    assert.match(mod._getMapStatus().text, /Removed MIDI note 24 from Kick/);
    assert.match(mod._getMapStatus().text, /GM default/);
    assert.equal(mod._getMapStatus().allowUndo, true);
});

test('REQ-004: remove failure preserves kit and legacy map', async () => {
    const mod = freshPlugin();
    global.fetch = async () => ({ ok: false, status: 500, json: async () => ({}) });
    mod._setConfirmedKit('user-kit', { notes: { '24': 'kick' } });
    mod._saveCfg('customMapping', { 24: 'kick' });
    const result = await mod._removeCustomNote(24, 'kick');
    assert.equal(result.ok, false);
    assert.equal(mod._getKitNotes()[24], 'kick');
    assert.equal(mod._cfg.customMapping[24], 'kick');
    assert.match(mod._getMapStatus().text, /unchanged/i);
});

test('REQ-004: GM defaults cannot invoke DELETE', async () => {
    const calls = [];
    const mod = freshPlugin();
    global.fetch = async (url, init) => {
        calls.push({ url, init });
        return { ok: true, json: async () => ({}) };
    };
    mod._setConfirmedKit('user-kit', { notes: {} });
    const result = await mod._removeCustomNote(36, 'kick');
    assert.equal(result.ok, false);
    assert.equal(calls.length, 0);
});

test('REQ-008: Undo restores the removed piece only after PUT succeeds', async () => {
    const order = [];
    const mod = freshPlugin();
    global.fetch = async (url, init) => {
        if (init && init.method === 'DELETE') {
            return {
                ok: true,
                json: async () => ({
                    kit: { id: 'user-kit', notes: {} },
                    mutation: { midi_note: 24, operation: 'delete', piece_id: null },
                    resolution: { piece_id: null, source: 'unmapped' },
                }),
            };
        }
        if (init && init.method === 'PUT') {
            order.push('api');
            assert.equal(mod._getKitNotes()[24], undefined);
            return { ok: true, json: async () => kitResponse({ '24': 'kick' }) };
        }
        return { ok: true, json: async () => ({}) };
    };
    mod._setConfirmedKit('user-kit', { notes: { '24': 'kick' } });
    mod._saveCfg('customMapping', { 24: 'kick' });
    await mod._removeCustomNote(24, 'kick');
    assert.match(mod._getMapStatus().text, /unmapped/i);
    const undone = await mod._undoLastRemoval();
    order.push('legacy');
    assert.equal(undone.ok, true);
    assert.deepEqual(order, ['api', 'legacy']);
    assert.equal(mod._getKitNotes()[24], 'kick');
    assert.equal(mod._cfg.customMapping[24], 'kick');
    assert.equal(mod._getMapStatus().allowUndo, false);
});

test('REQ-008: failed Undo leaves state unchanged', async () => {
    const mod = freshPlugin();
    let deletes = 0;
    global.fetch = async (url, init) => {
        if (init && init.method === 'DELETE') {
            deletes += 1;
            return {
                ok: true,
                json: async () => ({
                    kit: { id: 'user-kit', notes: {} },
                    mutation: { midi_note: 24, operation: 'delete', piece_id: null },
                    resolution: { piece_id: null, source: 'unmapped' },
                }),
            };
        }
        if (init && init.method === 'PUT') {
            return { ok: false, json: async () => ({}) };
        }
        return { ok: true, json: async () => ({}) };
    };
    mod._setConfirmedKit('user-kit', { notes: { '24': 'kick' } });
    await mod._removeCustomNote(24, 'kick');
    const undone = await mod._undoLastRemoval();
    assert.equal(undone.ok, false);
    assert.equal(mod._getKitNotes()[24], undefined);
    assert.equal(deletes, 1);
});

test('REQ-005: Device None, channel, hits, and volume follow the core contract', () => {
    const win = {};
    const di = installDrumInputFake(win);
    const mod = freshPlugin({
        window: win,
        store: { drums_midi_ch: '-1', drums_hit_detect: 'false', drums_synth_vol: '0.7' },
    });
    mod._bindDrumInputContract();
    assert.equal(mod._cfg.midiChannel, 9);
    assert.equal(mod._cfg.hitDetection, true);
    assert.equal(mod._cfg.synthVolume, 0.4);
    mod._setSharedSetting({ midiChannel: 0, hitDetection: false, synthVolume: 0.2 });
    assert.equal(di.get().midiChannel, 0);
    assert.equal(di.get().hitDetection, false);
    assert.equal(di.get().synthVolume, 0.2);
    assert.equal(mod._cfg.midiChannel, 0);
});

test('REQ-005: legacy 2D settings still load when the contract is absent', () => {
    const mod = freshPlugin({
        store: { drums_midi_ch: '9', drums_hit_detect: 'true', drums_synth_vol: '0.55' },
    });
    assert.equal(mod._cfg.midiChannel, 9);
    assert.equal(mod._cfg.hitDetection, true);
    assert.equal(mod._cfg.synthVolume, 0.55);
    assert.equal(mod._drumInputSubscriberCount(), 0);
});

test('REQ-005: incoming contract settings do not echo notifyMappingChange', () => {
    const win = {};
    const di = installDrumInputFake(win);
    const mod = freshPlugin({ window: win });
    mod._bindDrumInputContract();
    mod._onDrumInputChange({
        version: 1,
        changedKeys: ['midiChannel'],
        mutation: null,
        midiChannel: 4,
    });
    assert.equal(di._notifyCount(), 0);
});

test('REQ-009: repeated bind/unbind returns subscriber counts to baseline', () => {
    const win = {};
    const di = installDrumInputFake(win);
    const mod = freshPlugin({ window: win });
    assert.equal(mod._drumInputSubscriberCount(), 0);
    mod._bindDrumInputContract();
    mod._bindDrumInputContract();
    assert.equal(mod._drumInputSubscriberCount(), 1);
    assert.equal(di._listeners.length, 1);
    mod._unbindDrumInputContract();
    assert.equal(mod._drumInputSubscriberCount(), 0);
    assert.equal(di._listeners.length, 0);
    mod._bindDrumInputContract();
    assert.equal(mod._drumInputSubscriberCount(), 1);
    mod._unbindDrumInputContract();
    assert.deepEqual(mod._getLifecycleCounts(), {
        drumInputSubs: 0,
        midiHandle: 0,
        midiListener: 0,
        midiStateSub: 0,
    });
});

test('REQ-004: chip labels escape untrusted piece ids (defense in depth)', () => {
    const mod = freshPlugin();
    assert.equal(mod._pieceDisplayName('kick'), 'Kick');
    assert.equal(mod._escapeHtml('<img src=x onerror=alert(1)>'),
        '&lt;img src=x onerror=alert(1)&gt;');
    assert.equal(mod._buildNoteChipsHtml('<img>'), '');
});

test('GR-008: settings panel keeps z-index 50 and pointer-events auto', () => {
    const src = require('node:fs').readFileSync(
        path.join(__dirname, '..', 'screen.js'),
        'utf8',
    );
    assert.match(src, /z-index:50/);
    assert.match(src, /pointer-events:auto/);
});
