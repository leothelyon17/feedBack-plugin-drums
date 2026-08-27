'use strict';
// INIT-003/SPEC-012: profile + attach MIDI device + lanes; no Map/Learn here.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function freshEditor(opts) {
    const store = {};
    global.window = (opts && opts.window) || {};
    global.localStorage = {
        getItem: (k) => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null),
        setItem: (k, v) => { store[k] = String(v); },
    };
    global.document = makeDocument();
    global.CustomEvent = function (name, init) {
        this.type = name;
        this.detail = init && init.detail;
    };
    const calls = [];
    global.fetch = opts && opts.fetch
        ? opts.fetch
        : async (url, init) => {
            calls.push({ url: String(url), method: (init && init.method) || 'GET', body: init && init.body });
            if (String(url).includes('/api/drums/profiles') && (!init || !init.method || init.method === 'GET')) {
                return { ok: true, status: 200, json: async () => ({ profiles: [] }) };
            }
            if (String(url).includes('/api/settings') && (!init || !init.method || init.method === 'GET')) {
                return { ok: true, status: 200, json: async () => ({}) };
            }
            return { ok: true, status: 200, json: async () => ({ id: 'living-room', name: 'Living room', kit_id: 'kit-a' }) };
        };
    const file = path.join(__dirname, '..', 'assets', 'drum-editor.js');
    delete require.cache[require.resolve(file)];
    const mod = require(file);
    mod._fetchCalls = calls;
    return mod;
}

function makeDocument() {
    function el(tag) {
        const node = {
            tagName: String(tag).toUpperCase(),
            className: '',
            id: '',
            style: { cssText: '' },
            dataset: {},
            children: [],
            attributes: {},
            parentNode: null,
            hidden: false,
            disabled: false,
            value: '',
            textContent: '',
            tabIndex: 0,
            _html: '',
            setAttribute(k, v) {
                this.attributes[k] = String(v);
                if (k === 'class') this.className = v;
            },
            getAttribute(k) { return this.attributes[k] || null; },
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
            querySelector(sel) { return queryAll(this, sel)[0] || null; },
            querySelectorAll(sel) { return queryAll(this, sel); },
            focus() {},
        };
        Object.defineProperty(node, 'innerHTML', {
            get() { return this._html; },
            set(html) {
                this._html = String(html);
                this.children = virtualFromHtml(this._html, this);
            },
        });
        return node;
    }
    const body = el('body');
    return {
        createElement: el,
        body,
        documentElement: body,
        addEventListener() {},
        removeEventListener() {},
        querySelector() { return null; },
        querySelectorAll() { return []; },
        dispatchEvent() { return true; },
    };
}

function virtualFromHtml(html, parent) {
    const classes = new Set();
    const re = /class="([^"]+)"/g;
    let m;
    while ((m = re.exec(html))) {
        String(m[1]).split(/\s+/).forEach((c) => { if (c) classes.add(c); });
    }
    return [...classes].map((cls) => {
        const node = {
            className: cls,
            hidden: html.includes('class="' + cls + '"') && /hidden/.test(html.split(cls)[0].slice(-40)),
            dataset: {},
            value: '',
            _text: '',
            disabled: false,
            children: [],
            parentNode: parent,
            onchange: null,
            onclick: null,
            onsubmit: null,
            oninput: null,
            attributes: {},
            setAttribute(k, v) { this.attributes[k] = String(v); },
            getAttribute(k) { return this.attributes[k] || null; },
            removeAttribute(k) { delete this.attributes[k]; },
            focus() {},
            appendChild(child) {
                if (!child) return child;
                child.parentNode = this;
                this.children.push(child);
                return child;
            },
            querySelector(sel) {
                const clsName = sel.startsWith('.') ? sel.slice(1) : '';
                if (clsName && html.includes(clsName)) {
                    return virtualFromHtml(html, parent).find((n) => n.className === clsName) || null;
                }
                return null;
            },
            querySelectorAll(sel) {
                const one = this.querySelector(sel);
                return one ? [one] : [];
            },
        };
        Object.defineProperty(node, 'textContent', {
            get() { return node._text; },
            set(v) {
                node._text = String(v);
                node.children = [];
            },
            configurable: true,
            enumerable: true,
        });
        if (cls === 'drums-editor-name-form') node.hidden = true;
        return node;
    });
}

function queryAll(root, sel) {
    const out = [];
    const cls = sel.startsWith('.') ? sel.slice(1).split(/[\s\[]/)[0] : '';
    const walk = (n) => {
        if (!n) return;
        if (cls && String(n.className || '').split(/\s+/).includes(cls)) out.push(n);
        if (n.innerHTML && cls && String(n.innerHTML).includes(cls) && !out.includes(n)) {
            const kids = n.children || [];
            const hit = kids.find((c) => String(c.className || '').split(/\s+/).includes(cls));
            if (hit && !out.includes(hit)) out.push(hit);
        }
        (n.children || []).forEach(walk);
    };
    walk(root);
    return out;
}

function freshPlugin(opts) {
    const store = {};
    global.window = (opts && opts.window) || {};
    global.localStorage = {
        getItem: (k) => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null),
        setItem: (k, v) => { store[k] = String(v); },
    };
    global.document = {
        addEventListener() {},
        querySelectorAll: () => [],
    };
    const calls = [];
    global.fetch = opts && opts.fetch
        ? opts.fetch
        : async (url, init) => {
            calls.push({ url: String(url), method: (init && init.method) || 'GET', body: init && init.body });
            return { ok: true, status: 200, json: async () => ({}) };
        };
    const editorFile = path.join(__dirname, '..', 'assets', 'drum-editor.js');
    const screenFile = path.join(__dirname, '..', 'screen.js');
    delete require.cache[require.resolve(editorFile)];
    delete require.cache[require.resolve(screenFile)];
    const mod = require(screenFile);
    mod._fetchCalls = calls;
    return mod;
}

test('ac-1: editor has profile switcher and attach device_id control', () => {
    const mod = freshEditor();
    const host = global.document.createElement('div');
    const mounted = mod.mountDrumEditor(host, { context: 'settings' });
    assert.equal(mounted.ok, true);
    const html = mounted.root.innerHTML;
    assert.match(html, /drums-profile-create/);
    assert.match(html, /drums-profile-rename/);
    assert.match(html, /drums-profile-duplicate/);
    assert.match(html, /drums-profile-delete/);
    assert.match(html, /drums-profile-select/);
    assert.match(html, /drums-profile-activate/);
    assert.match(html, /Make active/);
    assert.match(html, /drums-attach-select/);
    assert.match(html, /Attach MIDI device/);
    assert.match(html, /drums-lane-list/);
    assert.match(html, /drums-lane-add/);
    assert.match(html, /2D Drum Highway/);
    mod.resetForTests();
});

test('ac-2: mountDrumEditor HTML has no Device picker, knobs, or Map/Learn', () => {
    const mod = freshEditor();
    const host = global.document.createElement('div');
    const mounted = mod.mountDrumEditor(host, { context: 'settings' });
    const html = mounted.root.innerHTML;
    assert.doesNotMatch(html, /drums-midi-select/);
    assert.doesNotMatch(html, /drums-vol-slider/);
    assert.doesNotMatch(html, /drums-channel-select/);
    assert.doesNotMatch(html, /drums-chk-hits/);
    assert.doesNotMatch(html, /drums-map-table/);
    assert.doesNotMatch(html, /drums-learn-btn/);
    assert.doesNotMatch(html, />Map</);
    assert.doesNotMatch(html, />Learn</);
    assert.doesNotMatch(html, /Learn MIDI mapping/);
    assert.doesNotMatch(html, /drums-kit-select/);
    assert.doesNotMatch(html, /drums-reset-map/);
    mod.resetForTests();
});

test('ac-3: save sends device_id and never notes or source_id identity', async () => {
    const saved = [];
    const win = {
        feedBack: {
            drumProfiles: {
                list: async () => [{ id: 'living-room', name: 'Living room', device_id: '' }],
                save: async (p) => { saved.push(p); return p; },
                activate: async (id) => ({ id: id }),
                get: async (id) => ({ id: id, name: 'Living room', device_id: '' }),
                getActive: async () => ({ id: 'living-room', name: 'Living room', device_id: '' }),
            },
            midiDevices: {
                list: async () => [{ id: 'pad-1', name: 'Pad One', notes: {} }],
                get: async (id) => ({ id, name: 'Pad One', notes: { '38': 'snare' } }),
            },
        },
    };
    const fetchCalls = [];
    const mod = freshEditor({
        window: win,
        fetch: async (url) => {
            fetchCalls.push(String(url));
            return { ok: true, status: 200, json: async () => ({}) };
        },
    });
    const host = global.document.createElement('div');
    mod.mountDrumEditor(host, { context: 'settings' });
    await new Promise((r) => setTimeout(r, 0));
    const res = await mod.persistActivePatch({ device_id: 'pad-1' });
    assert.equal(res.ok, true);
    assert.equal(saved.length, 1);
    assert.equal(saved[0].device_id, 'pad-1');
    assert.equal('notes' in saved[0], false);
    assert.equal(saved[0].device.source_id, '');
    assert.equal(fetchCalls.length, 0);
    mod.resetForTests();
});

test('attach keeps device_id on the next save even if the accessor omits it on return', async () => {
    const saved = [];
    const win = {
        feedBack: {
            drumProfiles: {
                list: async () => [{ id: 'living-room', name: 'Living room', device_id: '' }],
                save: async (p) => {
                    saved.push(JSON.parse(JSON.stringify(p)));
                    return { id: p.id, name: p.name };
                },
                activate: async (id) => ({ id: id }),
                get: async (id) => ({ id: id, name: 'Living room', device_id: '' }),
                getActive: async () => ({ id: 'living-room', name: 'Living room', device_id: '' }),
                activeId: async () => 'living-room',
            },
            midiDevices: {
                list: async () => [{
                    id: 'pad-1',
                    name: 'Pad One',
                    triggers: [{ id: 'snare', name: 'Snare' }, { id: 'kick', name: 'Kick' }],
                    notes: {},
                }],
                get: async (id) => ({
                    id,
                    name: 'Pad One',
                    triggers: [{ id: 'snare', name: 'Snare' }, { id: 'kick', name: 'Kick' }],
                    notes: {},
                }),
            },
        },
    };
    const mod = freshEditor({ window: win });
    const host = global.document.createElement('div');
    mod.mountDrumEditor(host, { context: 'settings' });
    await new Promise((r) => setTimeout(r, 0));
    const attached = await mod.persistActivePatch({ device_id: 'pad-1' });
    assert.equal(attached.ok, true);
    const highway = await mod.persistActivePatch({
        highway: { '2d': { lane_preset: 'rb4', show_lane_labels: true } },
    });
    assert.equal(highway.ok, true);
    assert.equal(saved[saved.length - 1].device_id, 'pad-1');
    mod.resetForTests();
});

test('ac-3: REST fallback PUT has device_id and not notes', async () => {
    const calls = [];
    const mod = freshEditor({
        fetch: async (url, init) => {
            calls.push({ url: String(url), method: (init && init.method) || 'GET', body: init && init.body });
            if (String(url).endsWith('/api/drums/profiles') && (!init || init.method === 'GET')) {
                return { ok: true, status: 200, json: async () => ({ profiles: [{ id: 'living-room', name: 'Living room' }] }) };
            }
            if (String(url).includes('/api/settings') && (!init || init.method === 'GET')) {
                return { ok: true, status: 200, json: async () => ({ active_drum_profile: 'living-room' }) };
            }
            return { ok: true, status: 200, json: async () => ({ id: 'living-room', name: 'Living room', device_id: 'pad-1' }) };
        },
    });
    const host = global.document.createElement('div');
    mod.mountDrumEditor(host, { context: 'settings' });
    await new Promise((r) => setTimeout(r, 0));
    const res = await mod.persistActivePatch({ device_id: 'pad-1' });
    assert.equal(res.ok, true);
    const put = calls.find((c) => c.method === 'PUT' && c.url.includes('/api/drums/profiles/'));
    assert.ok(put, 'expected PUT /api/drums/profiles/{id}');
    const body = JSON.parse(put.body);
    assert.equal(body.device_id, 'pad-1');
    assert.equal('notes' in body, false);
    assert.equal(body.device.source_id, '');
    mod.resetForTests();
});

test('ac-4: scoring overlay refetches device notes after attach and midi-device-change', async () => {
    const gets = [];
    const win = {
        feedBack: {
            midiDevices: {
                list: async () => [{ id: 'pad-1', name: 'Pad One', notes: {} }],
                get: async (id) => {
                    gets.push(id);
                    return { id, name: 'Pad One', notes: { '38': 'snare' } };
                },
                subscribe(fn) {
                    win._sub = fn;
                    return function () { win._sub = null; };
                },
            },
            on() {},
            off() {},
        },
    };
    const plugin = freshPlugin({ window: win });
    assert.equal(plugin._midiToLaneIdx(38), -1);
    await plugin._refetchAttachedDevice('pad-1');
    assert.equal(plugin._getAttachedDeviceId(), 'pad-1');
    const snare = plugin.DRUM_LANES.findIndex((l) => l.id === 'snare');
    assert.equal(plugin._midiToLaneIdx(38), snare);
    assert.equal(gets.length, 1);
    plugin._onMidiDeviceChange({ device_id: 'pad-1' });
    await new Promise((r) => setTimeout(r, 0));
    assert.ok(gets.length >= 2, 'expected a second get after midi-device-change');
});

test('ac-4: empty device_id leaves hits unmapped; highway helpers still resolve song notes', () => {
    const plugin = freshPlugin();
    plugin._clearAttachedDevice();
    assert.equal(plugin._getAttachedDeviceId(), '');
    assert.equal(plugin._midiToLaneIdx(38), -1);
    assert.equal(plugin._midiToLaneIdx(36), -1);
    const snare = plugin.DRUM_LANES.findIndex((l) => l.id === 'snare');
    assert.equal(plugin._songNoteToLaneIdx(38), snare);
});

test('ac-4: missing midiDevices does not PUT kit notes as a default map', async () => {
    const calls = [];
    const plugin = freshPlugin({
        fetch: async (url, init) => {
            calls.push({ url: String(url), method: (init && init.method) || 'GET', body: init && init.body });
            return { ok: true, status: 200, json: async () => ({}) };
        },
    });
    await plugin._refetchAttachedDevice('pad-1');
    assert.equal(plugin._midiToLaneIdx(38), -1);
    assert.equal(calls.some((c) => c.method === 'PUT' && String(c.url).includes('/notes/')), false);
    assert.equal(calls.some((c) => String(c.url).includes('/api/drums/kits')), false);
});

test('ac-5: lane/highway controls render and persist on profile.highway', async () => {
    const saved = [];
    const win = {
        feedBack: {
            drumProfiles: {
                list: async () => [{ id: 'living-room', name: 'Living room' }],
                save: async (p) => { saved.push(p); return p; },
                activate: async (id) => ({ id: id }),
                get: async (id) => ({ id: id, name: 'Living room' }),
                getActive: async () => ({ id: 'living-room', name: 'Living room' }),
            },
        },
    };
    const mod = freshEditor({ window: win });
    const host = global.document.createElement('div');
    const mounted = mod.mountDrumEditor(host, { context: 'settings' });
    const html = mounted.root.innerHTML;
    assert.match(html, /drums-lane-preset/);
    assert.match(html, /drums-chk-labels/);
    assert.match(html, /2D Drum Highway/);
    await new Promise((r) => setTimeout(r, 0));
    const res = await mod.persistActivePatch({
        highway: { '2d': { lane_preset: 'rb4', show_lane_labels: false } },
    });
    assert.equal(res.ok, true);
    assert.equal(saved[0].highway['2d'].lane_preset, 'rb4');
    assert.equal(saved[0].highway['2d'].show_lane_labels, false);
    assert.equal('notes' in saved[0], false);
    mod.resetForTests();
});

test('ac-6: pause unmounts settings; second settings mount is refused', () => {
    const mod = freshEditor();
    const host = global.document.createElement('div');
    assert.equal(mod.mountDrumEditor(host, { context: 'settings' }).ok, true);
    const second = mod.mountDrumEditor(host, { context: 'settings' });
    assert.equal(second.ok, false);
    assert.equal(second.reason, 'already-mounted');
    const pause = mod.openPauseDrumEditor();
    assert.equal(pause.ok, true);
    assert.equal(mod.getMountedEditor().context, 'pause');
    const again = mod.openPauseDrumEditor();
    assert.equal(again.reused, true);
    mod.resetForTests();
});

test('overlay form stays gone; gear still opens pause editor', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'screen.js'), 'utf8');
    assert.doesNotMatch(src, /<details style="margin-top:2px;">/);
    assert.doesNotMatch(src, /<summary style="font-size:10px;color:#666;cursor:pointer;">MIDI Mapping<\/summary>/);
    assert.match(src, /Open drum settings/);
    assert.match(src, /openPauseDrumEditor/);
});

test('editor HTML has no bloom, camera, or theme controls', () => {
    const mod = freshEditor();
    const host = global.document.createElement('div');
    const mounted = mod.mountDrumEditor(host, { context: 'settings' });
    const html = mounted.root.innerHTML.toLowerCase();
    assert.equal(html.includes('bloom'), false);
    assert.equal(html.includes('camera'), false);
    assert.equal(html.includes('theme'), false);
    mod.resetForTests();
});

test('midiDevices missing disables attach and does not write a default map', async () => {
    const saved = [];
    const win = {
        feedBack: {
            drumProfiles: {
                list: async () => [{ id: 'living-room', name: 'Living room' }],
                save: async (p) => { saved.push(JSON.parse(JSON.stringify(p))); return p; },
                getActive: async () => ({ id: 'living-room', name: 'Living room' }),
            },
        },
    };
    const mod = freshEditor({ window: win });
    const host = global.document.createElement('div');
    const mounted = mod.mountDrumEditor(host, { context: 'settings' });
    await new Promise((r) => setTimeout(r, 0));
    const sel = mounted.root.querySelector('.drums-attach-select');
    assert.ok(sel);
    assert.equal(sel.disabled, true);
    await listAndAssertUnavailable(mod);
    assert.equal(saved.some((p) => p.notes), false);
    mod.resetForTests();
});

async function listAndAssertUnavailable(mod) {
    const devices = await mod.listMidiDevices();
    assert.deepEqual(devices, []);
}

test('attach option labels use textContent, not innerHTML', async () => {
    const win = {
        feedBack: {
            drumProfiles: {
                list: async () => [{ id: 'living-room', name: 'Living room' }],
                save: async (p) => p,
                getActive: async () => ({ id: 'living-room', name: 'Living room' }),
            },
            midiDevices: {
                list: async () => [{ id: 'pad-1', name: '<img src=x onerror=alert(1)>', notes: {} }],
                get: async (id) => ({ id, notes: {} }),
            },
        },
    };
    const mod = freshEditor({ window: win });
    const host = global.document.createElement('div');
    const mounted = mod.mountDrumEditor(host, { context: 'settings' });
    await new Promise((r) => setTimeout(r, 0));
    await mod.listMidiDevices();
    const sel = mounted.root.querySelector('.drums-attach-select');
    assert.ok(sel);
    assert.equal(typeof sel.appendChild, 'function');
    assert.match(mounted.root.innerHTML, /drums-attach-select/);
    assert.doesNotMatch(mounted.root.innerHTML, /<img src=x/);
    mod.resetForTests();
});

test('slugify and unique ids stay on the SPEC-002 profile id regex', () => {
    const mod = freshEditor();
    assert.equal(mod.slugifyName('Living Room'), 'living-room');
    assert.ok(mod.PROFILE_ID_RE.test(mod.slugifyName('Living Room')));
    assert.equal(mod.uniqueProfileId('living-room', [{ id: 'living-room' }]), 'living-room-2');
    assert.equal(mod.normalizeDeviceId('Pad One'), '');
    assert.equal(mod.normalizeDeviceId('pad-1'), 'pad-1');
    mod.resetForTests();
});

test('ac-1: manifest still declares settings.html, category drums, id drums', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'plugin.json'), 'utf8'));
    assert.equal(manifest.id, 'drums');
    assert.equal(manifest.id, manifest.id.toLowerCase());
    assert.equal(manifest.settings.html, 'settings.html');
    assert.equal(manifest.settings.category, 'drums');
    assert.equal(manifest.styles, 'assets/drums-editor.css');
    const html = fs.readFileSync(path.join(__dirname, '..', 'settings.html'), 'utf8');
    assert.match(html, /data-drums-editor-host="settings"/);
});

test('selecting a profile does not activate it', async () => {
    const activated = [];
    const win = {
        feedBack: {
            drumProfiles: {
                list: async () => [
                    { id: 'living-room', name: 'Living room' },
                    { id: 'studio', name: 'Studio' },
                ],
                save: async (p) => p,
                activate: async (id) => { activated.push(id); return { id: id }; },
                get: async (id) => ({ id: id, name: id === 'studio' ? 'Studio' : 'Living room' }),
                getActive: async () => ({ id: 'living-room', name: 'Living room' }),
                activeId: async () => 'living-room',
            },
        },
    };
    const mod = freshEditor({ window: win });
    const host = global.document.createElement('div');
    const mounted = mod.mountDrumEditor(host, { context: 'settings' });
    await new Promise((r) => setTimeout(r, 0));
    activated.length = 0;
    await mod.refreshProfiles();
    mounted.root.querySelector('.drums-profile-select').onchange.call({ value: 'studio' });
    await new Promise((r) => setTimeout(r, 0));
    assert.deepEqual(activated, []);
    mod.resetForTests();
});

test('trigger pool is the attached device triggers, not 1-1 required', () => {
    const mod = freshEditor();
    const pool = mod.triggerPool({
        triggers: [
            { id: 'snare', name: 'Snare' },
            { id: 'snare_rim', name: 'Snare rim' },
            { id: 'kick', name: 'Kick' },
        ],
    });
    assert.deepEqual(pool.map((t) => t.id), ['snare', 'snare_rim', 'kick']);
    assert.deepEqual(mod.triggerPool(null), []);
    assert.deepEqual(mod.lanesFromProfile({
        highway: { '3d': { lanes: [{ piece: 'snare' }, { piece: 'kick' }] } },
    }), [{ piece: 'snare' }, { piece: 'kick' }]);
    mod.resetForTests();
});

test('addLane persists highway.3d.lanes from the device pool', async () => {
    const saved = [];
    const device = {
        id: 'pad-1',
        name: 'Pad One',
        triggers: [
            { id: 'hh_closed', name: 'Hi-hat (closed)' },
            { id: 'snare', name: 'Snare' },
            { id: 'kick', name: 'Kick' },
        ],
        notes: {},
    };
    const win = {
        feedBack: {
            drumProfiles: {
                list: async () => [{
                    id: 'living-room',
                    name: 'Living room',
                    device_id: 'pad-1',
                    highway: { '2d': { lane_preset: 'phase_shift_8', show_lane_labels: true }, '3d': { lanes: [] } },
                }],
                save: async (p) => { saved.push(JSON.parse(JSON.stringify(p))); return p; },
                activate: async (id) => ({ id: id }),
                get: async () => ({
                    id: 'living-room',
                    name: 'Living room',
                    device_id: 'pad-1',
                    highway: { '3d': { lanes: [] } },
                }),
                getActive: async () => ({ id: 'living-room', name: 'Living room', device_id: 'pad-1' }),
                activeId: async () => 'living-room',
            },
            midiDevices: {
                list: async () => [device],
                get: async () => device,
            },
        },
    };
    const mod = freshEditor({ window: win });
    const host = global.document.createElement('div');
    mod.mountDrumEditor(host, { context: 'settings' });
    await new Promise((r) => setTimeout(r, 0));
    await mod.refreshProfiles();
    const miss = await mod.addLane('tom_hi');
    assert.equal(miss.ok, false);
    const hit = await mod.addLane('snare');
    assert.equal(hit.ok, true);
    assert.equal(saved.length >= 1, true);
    const last = saved[saved.length - 1];
    assert.deepEqual(last.highway['3d'].lanes, [{ piece: 'snare' }]);
    assert.equal('notes' in last, false);
    mod.resetForTests();
});

const NO_DEVICE_LANES_MSG = 'Attach a MIDI device to add lanes from its pads.';

function ticks(n) {
    let p = Promise.resolve();
    for (let i = 0; i < n; i += 1) p = p.then(() => new Promise((r) => setTimeout(r, 0)));
    return p;
}

function optionValues(sel) {
    return (sel && sel.children ? sel.children : [])
        .map((c) => c.value)
        .filter((v) => v);
}

function attachTestWin(midiDevices, extras) {
    extras = extras || {};
    const activated = [];
    const saved = [];
    const win = {
        activated,
        saved,
        feedBack: {
            drumProfiles: {
                list: async () => [{
                    id: 'living-room',
                    name: 'Living room',
                    device_id: extras.deviceId || '',
                    highway: { '2d': { lane_preset: 'phase_shift_8', show_lane_labels: true }, '3d': { lanes: [] } },
                }],
                save: async (p) => {
                    saved.push(JSON.parse(JSON.stringify(p)));
                    return extras.omitDeviceIdOnSave
                        ? { id: p.id, name: p.name }
                        : p;
                },
                activate: async (id) => { activated.push(id); return { id: id }; },
                get: async (id) => ({
                    id: id,
                    name: 'Living room',
                    device_id: extras.deviceId || '',
                }),
                getActive: async () => ({
                    id: 'living-room',
                    name: 'Living room',
                    device_id: extras.deviceId || '',
                }),
                activeId: async () => 'living-room',
            },
            midiDevices: midiDevices,
            on() {},
            off() {},
        },
    };
    return win;
}

async function mountAndAttach(mod, deviceId) {
    const host = global.document.createElement('div');
    const mounted = mod.mountDrumEditor(host, { context: 'settings' });
    await ticks(3);
    await mod.refreshProfiles();
    const attach = mounted.root.querySelector('.drums-attach-select');
    attach.value = deviceId;
    const maybe = attach.onchange && attach.onchange.call(attach);
    if (maybe && typeof maybe.then === 'function') await maybe;
    await ticks(5);
    return mounted;
}

test('attach fills add-pool from midiDevices.get triggers', async () => {
    const win = attachTestWin({
        list: async () => [{ id: 'pad-1', name: 'Test 2', notes: {} }],
        get: async (id) => ({
            id,
            name: 'Test 2',
            triggers: [
                { id: 'snare', name: 'Snare' },
                { id: 'kick', name: 'Kick' },
            ],
        }),
    });
    const mod = freshEditor({ window: win });
    const mounted = await mountAndAttach(mod, 'pad-1');
    const add = mounted.root.querySelector('.drums-lane-add');
    const hint = mounted.root.querySelector('.drums-lane-hint');
    assert.deepEqual(optionValues(add).sort(), ['kick', 'snare']);
    assert.equal(add.disabled, false);
    assert.equal(hint.textContent, '');
    assert.match(add.children[0].textContent, /pick a piece to add/);
    assert.deepEqual(win.activated, []);
    mod.resetForTests();
});

test('list row missing triggers uses GET pads for the add-pool', async () => {
    const gets = [];
    const win = attachTestWin({
        list: async () => [{ id: 'pad-1', name: 'Test 2' }],
        get: async (id) => {
            gets.push(id);
            return {
                id,
                name: 'Test 2',
                triggers: [
                    { id: 'tom_hi', name: 'Tom 1' },
                    { id: 'hh_closed', name: 'Hi-hat (closed)' },
                ],
            };
        },
    });
    const mod = freshEditor({ window: win });
    const mounted = await mountAndAttach(mod, 'pad-1');
    assert.ok(gets.includes('pad-1'));
    const add = mounted.root.querySelector('.drums-lane-add');
    assert.deepEqual(optionValues(add).sort(), ['hh_closed', 'tom_hi']);
    assert.equal(add.disabled, false);
    mod.resetForTests();
});

test('list row with unusable triggers still GETs pads for the add-pool', async () => {
    const gets = [];
    const win = attachTestWin({
        list: async () => [{
            id: 'pad-1',
            name: 'Test 2',
            triggers: [{ id: 'Pad 1', name: 'Pad 1' }, { id: 'Kick Drum', name: 'Kick' }],
        }],
        get: async (id) => {
            gets.push(id);
            return {
                id,
                name: 'Test 2',
                triggers: [{ id: 'snare', name: 'Snare' }, { id: 'kick', name: 'Kick' }],
            };
        },
    });
    const mod = freshEditor({ window: win });
    const mounted = await mountAndAttach(mod, 'pad-1');
    assert.ok(gets.includes('pad-1'), 'GET must run when list triggers are unusable');
    const add = mounted.root.querySelector('.drums-lane-add');
    assert.deepEqual(optionValues(add).sort(), ['kick', 'snare']);
    mod.resetForTests();
});

test('attached device with empty triggers shows a distinct hint and disables add', async () => {
    const win = attachTestWin({
        list: async () => [{ id: 'pad-1', name: 'Test 2', triggers: [] }],
        get: async (id) => ({ id, name: 'Test 2', triggers: [] }),
    });
    const mod = freshEditor({ window: win });
    const mounted = await mountAndAttach(mod, 'pad-1');
    const add = mounted.root.querySelector('.drums-lane-add');
    const hint = mounted.root.querySelector('.drums-lane-hint');
    assert.equal(optionValues(add).length, 0);
    assert.equal(add.disabled, true);
    assert.notEqual(hint.textContent, NO_DEVICE_LANES_MSG);
    assert.match(hint.textContent, /no pads/i);
    assert.doesNotMatch(add.children[0].textContent, /attach a device first/);
    assert.deepEqual(win.activated, []);
    mod.resetForTests();
});

test('GET throw after attach shows a distinct hint, not attach-a-device', async () => {
    const win = attachTestWin({
        list: async () => [{ id: 'pad-1', name: 'Test 2' }],
        get: async () => { throw new Error('network'); },
    });
    const mod = freshEditor({ window: win });
    const mounted = await mountAndAttach(mod, 'pad-1');
    const add = mounted.root.querySelector('.drums-lane-add');
    const hint = mounted.root.querySelector('.drums-lane-hint');
    assert.equal(add.disabled, true);
    assert.notEqual(hint.textContent, NO_DEVICE_LANES_MSG);
    assert.match(hint.textContent, /could not load pads/i);
    assert.doesNotMatch(add.children[0].textContent, /attach a device first/);
    assert.deepEqual(win.activated, []);
    mod.resetForTests();
});

const PRIME_TYPE = {
    id: 'alesis-strata-prime',
    name: 'Alesis Strata Prime',
    family: 'drums',
    triggers: [
        { id: 'kick', name: 'Kick' },
        { id: 'snare', name: 'Snare' },
        { id: 'snare_rim', name: 'Snare Rim' },
        { id: 'tom_hi', name: 'Tom 1' },
    ],
};

test('add-pool uses type catalog when GET omits triggers (Test 2)', async () => {
    const win = attachTestWin({
        list: async () => [{
            id: 'test-2',
            name: 'Test 2',
            device_type_id: 'alesis-strata-prime',
            notes: { 26: 'snare' },
        }],
        get: async (id) => ({
            id,
            name: 'Test 2',
            device_type_id: 'alesis-strata-prime',
            notes: { 26: 'snare' },
        }),
        listTypes: async () => [PRIME_TYPE],
    });
    const mod = freshEditor({ window: win });
    const mounted = await mountAndAttach(mod, 'test-2');
    const add = mounted.root.querySelector('.drums-lane-add');
    const hint = mounted.root.querySelector('.drums-lane-hint');
    const vals = optionValues(add);
    assert.ok(vals.includes('kick'), 'unmapped Kick must still be in the pool');
    assert.ok(vals.includes('snare'), 'mapped Snare must be in the pool');
    assert.equal(add.disabled, false);
    assert.equal(hint.textContent, '');
    assert.match(add.children[0].textContent, /pick a piece to add/);
    assert.doesNotMatch(hint.textContent, /no pads/i);
    mod.resetForTests();
});

test('usable device.triggers are preferred over the type catalog', async () => {
    const win = attachTestWin({
        list: async () => [{
            id: 'pad-1',
            name: 'Trimmed kit',
            device_type_id: 'alesis-strata-prime',
            triggers: [{ id: 'snare', name: 'Snare' }],
        }],
        get: async (id) => ({
            id,
            name: 'Trimmed kit',
            device_type_id: 'alesis-strata-prime',
            triggers: [{ id: 'snare', name: 'Snare' }],
        }),
        listTypes: async () => [PRIME_TYPE],
    });
    const mod = freshEditor({ window: win });
    const mounted = await mountAndAttach(mod, 'pad-1');
    const add = mounted.root.querySelector('.drums-lane-add');
    assert.deepEqual(optionValues(add), ['snare']);
    assert.equal(optionValues(add).includes('kick'), false);
    assert.equal(optionValues(add).includes('tom_hi'), false);
    mod.resetForTests();
});

test('type catalog load failure with no device triggers shows could-not-load, not attach-first', async () => {
    const win = attachTestWin({
        list: async () => [{
            id: 'test-2',
            name: 'Test 2',
            device_type_id: 'alesis-strata-prime',
        }],
        get: async (id) => ({
            id,
            device_type_id: 'alesis-strata-prime',
            notes: { 26: 'snare' },
        }),
        listTypes: async () => { throw new Error('network'); },
    });
    const mod = freshEditor({ window: win });
    const mounted = await mountAndAttach(mod, 'test-2');
    const add = mounted.root.querySelector('.drums-lane-add');
    const hint = mounted.root.querySelector('.drums-lane-hint');
    assert.equal(optionValues(add).length, 0);
    assert.equal(add.disabled, true);
    assert.notEqual(hint.textContent, NO_DEVICE_LANES_MSG);
    assert.match(hint.textContent, /could not load pads/i);
    assert.doesNotMatch(add.children[0].textContent, /attach a device first/);
    assert.deepEqual(win.activated, []);
    mod.resetForTests();
});

test('midi-device-change list refresh does not wipe GET pads', async () => {
    let getCount = 0;
    const win = attachTestWin({
        list: async () => [{ id: 'pad-1', name: 'Test 2' }],
        get: async (id) => {
            getCount += 1;
            if (getCount === 1) {
                return {
                    id,
                    name: 'Test 2',
                    triggers: [{ id: 'snare', name: 'Snare' }, { id: 'kick', name: 'Kick' }],
                };
            }
            throw new Error('GET failed');
        },
        subscribe(fn) {
            win._midiSub = fn;
            return function () { win._midiSub = null; };
        },
    });
    const mod = freshEditor({ window: win });
    const mounted = await mountAndAttach(mod, 'pad-1');
    const addBefore = optionValues(mounted.root.querySelector('.drums-lane-add'));
    assert.ok(addBefore.includes('snare'));
    assert.ok(typeof win._midiSub === 'function');
    win._midiSub({ device_id: 'pad-1' });
    await ticks(5);
    const add = mounted.root.querySelector('.drums-lane-add');
    const hint = mounted.root.querySelector('.drums-lane-hint');
    assert.ok(optionValues(add).includes('snare'), 'add-pool must keep GET pads after list refresh');
    assert.equal(add.disabled, false);
    assert.notEqual(hint.textContent, NO_DEVICE_LANES_MSG);
    assert.deepEqual(win.activated, []);
    mod.resetForTests();
});

test('INIT-007/SPEC-004: Profiles HTML has Precision checkbox and helper', () => {
    const mod = freshEditor();
    const host = global.document.createElement('div');
    const mounted = mod.mountDrumEditor(host, { context: 'settings' });
    const html = mounted.root.innerHTML;
    assert.match(html, /drums-chk-precision/);
    assert.match(html, />Precision</);
    assert.match(html, /aria-label="Precision mode"/);
    assert.match(html, /Tighter fixed ±50 ms window/);
    assert.match(html, /Not YARG density-scaled Precision/);
    mod.resetForTests();
});

test('INIT-007/SPEC-004: persist scoring.precision_mode via existing profile PUT', async () => {
    const saved = [];
    const win = {
        feedBack: {
            drumProfiles: {
                list: async () => [{
                    id: 'living-room',
                    name: 'Living room',
                    device_id: '',
                    scoring: { precision_mode: false },
                }],
                save: async (p) => { saved.push(JSON.parse(JSON.stringify(p))); return p; },
                activate: async (id) => ({ id: id }),
                get: async (id) => ({
                    id: id,
                    name: 'Living room',
                    device_id: '',
                    scoring: { precision_mode: false },
                }),
                getActive: async () => ({
                    id: 'living-room',
                    name: 'Living room',
                    scoring: { precision_mode: false },
                }),
            },
        },
    };
    const mod = freshEditor({ window: win });
    const host = global.document.createElement('div');
    mod.mountDrumEditor(host, { context: 'settings' });
    await new Promise((r) => setTimeout(r, 0));
    const withFlag = await mod.persistActivePatch({ scoring: { precision_mode: true } });
    assert.equal(withFlag.ok, true);
    assert.equal(saved.length, 1);
    assert.equal(saved[0].scoring.precision_mode, true);
    saved.length = 0;
    const highwayOnly = await mod.persistActivePatch({
        highway: { '2d': { lane_preset: 'rb4', show_lane_labels: true } },
    });
    assert.equal(highwayOnly.ok, true);
    assert.equal(saved.length, 1);
    assert.equal('scoring' in saved[0], false);
    mod.resetForTests();
});

