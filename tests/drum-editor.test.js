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
            textContent: '',
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
            appendChild() {},
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
    assert.match(html, /drums-attach-select/);
    assert.match(html, /Attach MIDI device/);
    assert.match(html, />Highway</);
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
    assert.match(html, />Highway</);
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
