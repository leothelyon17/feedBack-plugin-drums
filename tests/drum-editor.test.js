'use strict';
// INIT-003/SPEC-005: mountDrumEditor singleton, profile persist, Learn lock.
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
            children: [],
            parentNode: parent,
            onchange: null,
            onclick: null,
            onsubmit: null,
            oninput: null,
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
            calls.push({ url: String(url), method: (init && init.method) || 'GET', status: 200 });
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

test('ac-1: manifest declares settings.html, category drums, id drums', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'plugin.json'), 'utf8'));
    assert.equal(manifest.id, 'drums');
    assert.equal(manifest.id, manifest.id.toLowerCase());
    assert.equal(manifest.settings.html, 'settings.html');
    assert.equal(manifest.settings.category, 'drums');
    assert.equal(manifest.styles, 'assets/drums-editor.css');
    const html = fs.readFileSync(path.join(__dirname, '..', 'settings.html'), 'utf8');
    assert.match(html, /data-drums-editor-host="settings"/);
});

test('ac-2: mountDrumEditor renders Device / Map / Highway and profile chrome', () => {
    const mod = freshEditor();
    const host = global.document.createElement('div');
    const mounted = mod.mountDrumEditor(host, { context: 'settings' });
    assert.equal(mounted.ok, true);
    const html = mounted.root.innerHTML;
    assert.match(html, />Device</);
    assert.match(html, />Map</);
    assert.match(html, />Highway</);
    assert.match(html, /drums-profile-create/);
    assert.match(html, /drums-profile-rename/);
    assert.match(html, /drums-profile-duplicate/);
    assert.match(html, /drums-profile-delete/);
    assert.match(html, /drums-profile-select/);
    mod.resetForTests();
});

test('ac-3: pause unmounts settings; second settings mount is refused', () => {
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

test('ac-4: overlay form is gone; gear label is Open drum settings', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'screen.js'), 'utf8');
    assert.doesNotMatch(src, /<details style="margin-top:2px;">/);
    assert.doesNotMatch(src, /<summary style="font-size:10px;color:#666;cursor:pointer;">MIDI Mapping<\/summary>/);
    assert.match(src, /Open drum settings/);
    assert.match(src, /openPauseDrumEditor/);
});

test('ac-5: persist prefers drumProfiles accessor over raw fetch', async () => {
    const saved = [];
    const win = {
        feedBack: {
            drumProfiles: {
                list: async () => [{ id: 'living-room', name: 'Living room', kit_id: 'kit-a' }],
                save: async (p) => { saved.push(p); return p; },
                activate: async (id) => ({ id: id }),
                get: async (id) => ({ id: id, name: 'Living room', kit_id: 'kit-a' }),
                getActive: async () => ({ id: 'living-room', name: 'Living room', kit_id: 'kit-a' }),
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
    const res = await mod.persistActivePatch({
        device: { source_id: 'web-midi::pad-1', enabled: true },
        input: { midi_channel: 9, hit_detection: true, synth_volume: 0.4 },
        highway: { '2d': { lane_preset: 'rb4', show_lane_labels: false } },
    });
    assert.equal(res.ok, true);
    assert.equal(saved.length, 1);
    assert.equal(saved[0].device.source_id, 'web-midi::pad-1');
    assert.equal('notes' in saved[0], false);
    assert.equal(fetchCalls.length, 0);
    mod.resetForTests();
});

test('ac-5: REST fallback writes /api/drums/profiles and not notes', async () => {
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
            return { ok: true, status: 200, json: async () => ({ id: 'living-room', name: 'Living room' }) };
        },
    });
    const host = global.document.createElement('div');
    mod.mountDrumEditor(host, { context: 'settings' });
    await new Promise((r) => setTimeout(r, 0));
    const res = await mod.persistActivePatch({ kit_id: 'kit-a' });
    assert.equal(res.ok, true);
    const put = calls.find((c) => c.method === 'PUT' && c.url.includes('/api/drums/profiles/'));
    assert.ok(put, 'expected PUT /api/drums/profiles/{id}');
    const body = JSON.parse(put.body);
    assert.equal('notes' in body, false);
    assert.equal(body.device.source_id.includes('('), false);
    mod.resetForTests();
});

test('ac-6: Learn 409 is not silent success and uses the lock live-region copy', async () => {
    const plugin = freshPlugin({
        fetch: async (url, init) => {
            if (init && init.method === 'PUT' && String(url).includes('/notes/')) {
                return {
                    ok: false,
                    status: 409,
                    json: async () => ({ detail: 'kit notes cannot be changed while a highway session is playing or paused' }),
                };
            }
            return { ok: true, status: 200, json: async () => ({}) };
        },
    });
    plugin._setConfirmedKit('kit-a', { id: 'kit-a', notes: {} });
    const before = plugin._getKitNotes();
    const result = await plugin._commitLearnAssignment(38, 'snare');
    assert.equal(result, null);
    assert.equal(plugin._getKitNotes(), before);
    const status = plugin._getMapStatus();
    assert.match(status.text, /locked while a song is playing or paused/);
    assert.equal(plugin._isLearnLockedStatus(409), true);
    assert.doesNotMatch(status.text, /Mapped MIDI note/);
});

test('ac-7: editor HTML has no bloom, camera, or theme controls', () => {
    const mod = freshEditor();
    const host = global.document.createElement('div');
    const mounted = mod.mountDrumEditor(host, { context: 'settings' });
    const html = mounted.root.innerHTML.toLowerCase();
    assert.equal(html.includes('bloom'), false);
    assert.equal(html.includes('camera'), false);
    assert.equal(html.includes('theme'), false);
    mod.resetForTests();
});

test('ac-8: Map table is not inside a closed details; Learn stays keyboard-reachable', () => {
    const mod = freshEditor();
    const host = global.document.createElement('div');
    const mounted = mod.mountDrumEditor(host, { context: 'settings' });
    const html = mounted.root.innerHTML;
    assert.equal(html.includes('<details'), false);
    assert.match(html, /drums-map-table/);
    assert.match(html, /drums-learn-btn|Learn MIDI mapping|drums-editor-map-wrap/);
    const plugin = freshPlugin();
    const rows = plugin._buildMappingRows();
    assert.match(rows, /drums-learn-btn/);
    assert.match(rows, /type="button"/);
    assert.doesNotMatch(rows, /tabindex="-1"/);
    mod.resetForTests();
});

test('slugify and unique ids stay on the SPEC-002 profile id regex', () => {
    const mod = freshEditor();
    assert.equal(mod.slugifyName('Living Room'), 'living-room');
    assert.ok(mod.PROFILE_ID_RE.test(mod.slugifyName('Living Room')));
    assert.equal(mod.uniqueProfileId('living-room', [{ id: 'living-room' }]), 'living-room-2');
    mod.resetForTests();
});
