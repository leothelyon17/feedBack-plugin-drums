// INIT-003/SPEC-012: shared Drum editor factory.
// Settings and pause call the same mount; only one instance is live.
// Drums tab = Profiles (name, attach device, lane map, make active)
// plus 2D-only highway options. Mapping/knobs/Learn live on MIDI.
// Profile writes prefer window.feedBack.drumProfiles (SPEC-004) and
// fall back to SPEC-002 HTTP so switching later is a one-function change.
(function (root) {
'use strict';

var PROFILE_ID_RE = /^[a-z0-9-]+$/;
var DEVICE_ID_RE = /^[a-z0-9-]+$/;
var TRIGGER_ID_RE = /^[a-z0-9_]+$/;
var CONTEXTS = { settings: true, pause: true };
var LEARN_LOCK_MSG = 'Learn is locked while a song is playing or paused. Mapping was not changed.';
var MIDI_UNAVAILABLE_MSG = 'MIDI devices are unavailable. Highway still plays.';
var NO_DEVICE_LANES_MSG = 'Attach a MIDI device to add lanes from its pads.';
var NO_PADS_LANES_MSG = 'This device has no pads. Add triggers on Settings → MIDI.';
var GET_FAILED_LANES_MSG = 'Could not load pads for this device.';
var _DEFAULT_3D = {
    palette: 'default',
    camera_angle: 0.35,
    theme: 'default',
    fx: {},
    lanes: [],
    fallbacks: {},
};

var _mount = null;
var _cache = {
    profiles: [],
    activeId: '',
    active: null,
    selectedId: '',
    selected: null,
    devices: [],
    midiAvailable: false,
    attachedDevice: null,
    attachedLoadError: '',
};
var _persistSeq = 0;
var _attachLoadSeq = 0;
var _midiListUnsub = null;

function _fb() {
    if (typeof window === 'undefined') return null;
    return window.feedBack || window.feedback || window.slopsmith || null;
}

function _accessor() {
    var fb = _fb();
    var api = fb && fb.drumProfiles;
    if (!api || typeof api !== 'object') return null;
    var list = api.list || api.listProfiles;
    if (typeof list !== 'function') return null;
    return api;
}

function _midiDevices() {
    var fb = _fb();
    var api = fb && fb.midiDevices;
    if (!api || typeof api !== 'object') return null;
    if (typeof api.list !== 'function' && typeof api.get !== 'function') return null;
    return api;
}

function normalizeDeviceId(raw) {
    if (typeof raw !== 'string' || !raw) return '';
    return DEVICE_ID_RE.test(raw) ? raw : '';
}

function _doc() {
    return typeof document !== 'undefined' ? document : null;
}

function _esc(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function slugifyName(name) {
    var s = String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    return s || ('profile-' + Date.now().toString(36));
}

function uniqueProfileId(base, existing) {
    var id = PROFILE_ID_RE.test(base) ? base : slugifyName(base);
    if (!PROFILE_ID_RE.test(id)) id = 'profile-' + Date.now().toString(36);
    var taken = Object.create(null);
    (existing || []).forEach(function (p) {
        if (p && typeof p.id === 'string') taken[p.id] = true;
    });
    if (!taken[id]) return id;
    var n = 2;
    while (taken[id + '-' + n]) n += 1;
    return id + '-' + n;
}

function learnLockMessage() {
    return LEARN_LOCK_MSG;
}

function isLearnLockedStatus(status) {
    return status === 409;
}

async function _rest(method, url, body) {
    if (typeof fetch !== 'function') return { ok: false, status: 0, data: null, detail: '' };
    try {
        var opts = { method: method, headers: {} };
        if (body !== undefined) {
            opts.headers['Content-Type'] = 'application/json';
            opts.body = JSON.stringify(body);
        }
        var res = await fetch(url, opts);
        var status = res && typeof res.status === 'number' ? res.status : 0;
        var data = null;
        try { data = res ? await res.json() : null; } catch (_) { data = null; }
        var detail = '';
        if (data && typeof data.detail === 'string') detail = data.detail;
        return { ok: Boolean(res && res.ok), status: status, data: data, detail: detail };
    } catch (_) {
        return { ok: false, status: 0, data: null, detail: '' };
    }
}

function _emitProfileChange(profile) {
    var detail = {
        profile_id: profile && profile.id ? profile.id : '',
        kit_id: profile && profile.kit_id ? profile.kit_id : '',
    };
    if (profile && profile.scoring && typeof profile.scoring === 'object') {
        detail.scoring = { precision_mode: profile.scoring.precision_mode === true };
    }
    var d = _doc();
    if (d && typeof d.dispatchEvent === 'function' && typeof CustomEvent === 'function') {
        d.dispatchEvent(new CustomEvent('feedback:drum-profile-change', { detail: detail }));
    }
    var fb = _fb();
    if (fb && typeof fb.emit === 'function') fb.emit('feedback:drum-profile-change', detail);
}

async function listProfiles() {
    var api = _accessor();
    if (api) {
        var fn = api.list || api.listProfiles;
        var raw = await fn.call(api);
        if (Array.isArray(raw)) return raw;
        if (raw && Array.isArray(raw.profiles)) return raw.profiles;
        return [];
    }
    var res = await _rest('GET', '/api/drums/profiles');
    return (res.data && Array.isArray(res.data.profiles)) ? res.data.profiles : [];
}

async function getProfile(id) {
    if (typeof id !== 'string' || !PROFILE_ID_RE.test(id)) return null;
    var api = _accessor();
    if (api && typeof api.get === 'function') return await api.get.call(api, id);
    var res = await _rest('GET', '/api/drums/profiles/' + encodeURIComponent(id));
    return res.ok ? res.data : null;
}

async function saveProfile(profile) {
    if (!profile || typeof profile !== 'object') return { ok: false, status: 0, data: null };
    var deviceId = normalizeDeviceId(profile.device_id);
    var body = {
        id: profile.id,
        name: profile.name,
        kit_id: profile.kit_id || '',
        device_id: deviceId,
        device: {
            source_id: '',
            enabled: Boolean(deviceId),
        },
        input: profile.input || { midi_channel: -1, hit_detection: false, synth_volume: 0.7 },
        highway: profile.highway || { '2d': { lane_preset: 'phase_shift_8', show_lane_labels: true } },
    };
    if (profile.scoring && typeof profile.scoring === 'object') {
        body.scoring = { precision_mode: profile.scoring.precision_mode === true };
    }
    if ('notes' in body) delete body.notes;
    var api = _accessor();
    if (api && typeof api.save === 'function') {
        var saved = await api.save.call(api, body);
        if (saved) _emitProfileChange(saved);
        return { ok: Boolean(saved), status: saved ? 200 : 400, data: saved || null };
    }
    var id = typeof body.id === 'string' ? body.id : '';
    var res = await _rest('PUT', '/api/drums/profiles/' + encodeURIComponent(id), body);
    if (res.ok) _emitProfileChange(res.data);
    return res;
}

async function activateProfile(id) {
    if (typeof id !== 'string' || !PROFILE_ID_RE.test(id)) {
        return { ok: false, status: 400, data: null };
    }
    var api = _accessor();
    if (api && typeof api.activate === 'function') {
        var out = await api.activate.call(api, id);
        return { ok: out !== false, status: 200, data: out };
    }
    var res = await _rest('POST', '/api/settings', { active_drum_profile: id });
    if (res.ok) {
        var prof = _cache.profiles.find(function (p) { return p.id === id; }) || { id: id };
        _emitProfileChange(prof);
    }
    return res;
}

async function deleteProfile(id) {
    if (typeof id !== 'string' || !PROFILE_ID_RE.test(id)) {
        return { ok: false, status: 400, detail: 'invalid id' };
    }
    var api = _accessor();
    var fn = api && (api.remove || api.delete || api.del);
    if (api && typeof fn === 'function') {
        var out = await fn.call(api, id);
        return { ok: out !== false, status: 200, data: out };
    }
    return _rest('DELETE', '/api/drums/profiles/' + encodeURIComponent(id));
}

async function readActiveProfileId() {
    var api = _accessor();
    if (api) {
        if (typeof api.activeId === 'function') {
            var aid = await api.activeId.call(api);
            return typeof aid === 'string' ? aid : '';
        }
        if (typeof api.getActive === 'function') {
            var active = await api.getActive.call(api);
            if (active && typeof active.id === 'string') return active.id;
        }
        return '';
    }
    var res = await _rest('GET', '/api/settings');
    var raw = res.data && res.data.active_drum_profile;
    return (typeof raw === 'string' && PROFILE_ID_RE.test(raw)) ? raw : '';
}

function getMountedEditor() {
    return _mount ? { context: _mount.context, host: _mount.host, root: _mount.root } : null;
}

function unmountDrumEditor() {
    if (!_mount) return;
    var onUnmounted = _mount.onUnmounted;
    _unbindMidiDeviceList();
    if (_mount.root && _mount.root.parentNode) _mount.root.parentNode.removeChild(_mount.root);
    if (_mount.dialog && _mount.dialog.parentNode) _mount.dialog.parentNode.removeChild(_mount.dialog);
    if (_mount.hostRestore) _mount.hostRestore();
    _mount = null;
    if (typeof onUnmounted === 'function') onUnmounted();
}

function _live(root, msg) {
    if (!root) return;
    var el = root.querySelector('.drums-editor-live');
    if (el) el.textContent = msg || '';
}

function _mergeHighway(existing, patch) {
    var hw = existing && typeof existing === 'object' ? existing : {};
    var patchHw = (patch && typeof patch === 'object') ? patch : {};
    return {
        '2d': Object.assign(
            { lane_preset: 'phase_shift_8', show_lane_labels: true },
            hw['2d'] || {},
            patchHw['2d'] || {}
        ),
        '3d': Object.assign({}, _DEFAULT_3D, hw['3d'] || {}, patchHw['3d'] || {}),
    };
}

function pieceIdOk(raw) {
    return typeof raw === 'string' && TRIGGER_ID_RE.test(raw)
        && raw !== '__proto__' && raw !== 'constructor' && raw !== 'prototype';
}

function lanesFromProfile(profile) {
    var three = profile && profile.highway && profile.highway['3d'];
    var raw = three && Array.isArray(three.lanes) ? three.lanes : [];
    var out = [];
    var seen = Object.create(null);
    raw.forEach(function (ln) {
        var piece = ln && typeof ln.piece === 'string' ? ln.piece : '';
        if (!pieceIdOk(piece) || seen[piece]) return;
        seen[piece] = true;
        out.push({ piece: piece });
    });
    return out;
}

function triggerPool(device) {
    var list = device && Array.isArray(device.triggers) ? device.triggers : [];
    var out = [];
    var seen = Object.create(null);
    list.forEach(function (t) {
        var id = t && typeof t.id === 'string' ? t.id : '';
        if (!pieceIdOk(id) || seen[id]) return;
        seen[id] = true;
        var name = (t && typeof t.name === 'string' && t.name.trim()) ? t.name.trim() : id;
        out.push({ id: id, name: name });
    });
    return out;
}

function _usableTriggerCount(device) {
    return triggerPool(device).length;
}

function _deviceTypeId(device) {
    var raw = device && device.device_type_id != null ? String(device.device_type_id) : '';
    return DEVICE_ID_RE.test(raw) ? raw : '';
}

function _typesList(raw) {
    if (Array.isArray(raw)) return raw;
    if (raw && Array.isArray(raw.device_types)) return raw.device_types;
    return [];
}

// Settings → MIDI draws Kick/Snare from the type catalog when device.triggers
// is missing. Live GET/list omit that key, so the attach pool must do the same.
async function _loadTypeTriggers(typeId) {
    if (!typeId) return { ok: false, triggers: [] };
    var api = _midiDevices();
    if (api && typeof api.listTypes === 'function') {
        try {
            var types = _typesList(await api.listTypes.call(api));
            var found = null;
            for (var i = 0; i < types.length; i += 1) {
                if (types[i] && types[i].id === typeId) {
                    found = types[i];
                    break;
                }
            }
            var fromList = found && Array.isArray(found.triggers) ? found.triggers : [];
            return { ok: true, triggers: fromList };
        } catch (_) {
            return { ok: false, triggers: [] };
        }
    }
    if (typeof fetch === 'function') {
        try {
            var res = await fetch('/api/midi/device-types/' + encodeURIComponent(typeId));
            if (!res || !res.ok) return { ok: false, triggers: [] };
            var body = await res.json();
            if (!body || body.id !== typeId) return { ok: false, triggers: [] };
            var fromGet = Array.isArray(body.triggers) ? body.triggers : [];
            return { ok: true, triggers: fromGet };
        } catch (_) {
            return { ok: false, triggers: [] };
        }
    }
    return { ok: false, triggers: [] };
}

function _wantedDeviceId() {
    var fromSel = '';
    if (_mount && _mount.root) {
        var sel = _mount.root.querySelector('.drums-attach-select');
        if (sel && typeof sel.value === 'string') fromSel = normalizeDeviceId(sel.value);
    }
    if (fromSel) return fromSel;
    return _cache.selected ? normalizeDeviceId(_cache.selected.device_id) : '';
}

function _unwrapMidiDevice(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    if (raw.device && typeof raw.device === 'object' && !Array.isArray(raw.device)
        && Array.isArray(raw.device.triggers) && !Array.isArray(raw.triggers)) {
        return raw.device;
    }
    return raw;
}

function _triggerName(pool, piece) {
    var i;
    for (i = 0; i < pool.length; i++) {
        if (pool[i].id === piece) return pool[i].name;
    }
    return piece;
}

function _editingProfile() {
    return _cache.selected || _cache.active;
}

function _editingProfileId() {
    return _cache.selectedId || _cache.activeId || '';
}

function _profileFromForm(name, id, patch) {
    var base = _editingProfile() || {};
    var deviceId = Object.prototype.hasOwnProperty.call(patch || {}, 'device_id')
        ? normalizeDeviceId(patch.device_id)
        : normalizeDeviceId(base.device_id);
    var out = {
        id: id,
        name: name,
        kit_id: patch.kit_id != null ? patch.kit_id : (base.kit_id || ''),
        device_id: deviceId,
        device: {
            source_id: '',
            enabled: Boolean(deviceId),
        },
        input: Object.assign(
            { midi_channel: -1, hit_detection: false, synth_volume: 0.7 },
            base.input || {}
        ),
        highway: _mergeHighway(base.highway, patch.highway),
    };
    if (patch && Object.prototype.hasOwnProperty.call(patch, 'scoring')) {
        out.scoring = {
            precision_mode: !!(patch.scoring && patch.scoring.precision_mode === true),
        };
    }
    return out;
}

async function refreshProfiles() {
    _cache.profiles = await listProfiles();
    _cache.activeId = await readActiveProfileId();
    _cache.active = _cache.profiles.find(function (p) { return p.id === _cache.activeId; }) || null;
    if (!_cache.active && _cache.activeId) {
        _cache.active = await getProfile(_cache.activeId);
    }
    if (!_cache.selectedId || !_cache.profiles.some(function (p) { return p.id === _cache.selectedId; })) {
        _cache.selectedId = _cache.activeId;
    }
    _cache.selected = _cache.profiles.find(function (p) { return p.id === _cache.selectedId; }) || null;
    if (!_cache.selected && _cache.selectedId) {
        _cache.selected = await getProfile(_cache.selectedId);
    }
    _fillProfileSelect();
    _fillAttachSelect();
    _fill2dControls();
    _fillScoringControls();
    _updateActivateButton();
    await _loadAttachedDevice(_wantedDeviceId());
    _fillLaneGrid();
    await _maybeSeedLanesFrom3dKit();
    return _cache;
}

function _fillProfileSelect() {
    if (!_mount || !_mount.root) return;
    var sel = _mount.root.querySelector('.drums-profile-select');
    if (!sel) return;
    var keep = _cache.selectedId || _cache.activeId;
    sel.textContent = '';
    var empty = _doc().createElement('option');
    empty.value = '';
    empty.textContent = _cache.profiles.length ? 'Select a profile' : 'No profiles yet';
    sel.appendChild(empty);
    _cache.profiles.forEach(function (p) {
        var opt = _doc().createElement('option');
        opt.value = p.id;
        var label = p.name || p.id;
        if (p.id === _cache.activeId) label += ' (active)';
        opt.textContent = label;
        if (p.id === keep) opt.selected = true;
        sel.appendChild(opt);
    });
    if (keep) sel.value = keep;
}

async function listMidiDevices() {
    var api = _midiDevices();
    if (!api || typeof api.list !== 'function') {
        _cache.midiAvailable = false;
        _cache.devices = [];
        return [];
    }
    _cache.midiAvailable = true;
    try {
        var raw = await api.list.call(api);
        var list = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.devices) ? raw.devices : []);
        _cache.devices = list.filter(function (d) {
            return d && typeof d.id === 'string' && DEVICE_ID_RE.test(d.id);
        });
    } catch (_) {
        _cache.devices = [];
    }
    return _cache.devices;
}

function _fillAttachSelect() {
    if (!_mount || !_mount.root) return;
    var sel = _mount.root.querySelector('.drums-attach-select');
    if (!sel) return;
    var keep = _cache.selected ? normalizeDeviceId(_cache.selected.device_id) : '';
    var d = _doc();
    sel.textContent = '';
    var empty = d.createElement('option');
    empty.value = '';
    empty.textContent = _cache.midiAvailable ? 'None' : 'MIDI unavailable';
    sel.appendChild(empty);
    _cache.devices.forEach(function (dev) {
        var opt = d.createElement('option');
        opt.value = dev.id;
        opt.textContent = (typeof dev.name === 'string' && dev.name) ? dev.name : dev.id;
        if (dev.id === keep) opt.selected = true;
        sel.appendChild(opt);
    });
    if (keep) sel.value = keep;
    sel.disabled = !_cache.midiAvailable;
    if (_cache.midiAvailable) {
        sel.removeAttribute('aria-disabled');
    } else {
        sel.setAttribute('aria-disabled', 'true');
        _live(_mount.root, MIDI_UNAVAILABLE_MSG);
    }
}

function _bindMidiDeviceList() {
    _unbindMidiDeviceList();
    var api = _midiDevices();
    var handler = function () {
        listMidiDevices().then(function () {
            _fillAttachSelect();
            return _loadAttachedDevice(_wantedDeviceId());
        }).then(function (dev) {
            _fillLaneGrid(dev);
        });
    };
    var fb = _fb();
    var unsubs = [];
    if (api && typeof api.subscribe === 'function') {
        unsubs.push(api.subscribe(handler));
    } else if (fb && typeof fb.on === 'function') {
        fb.on('feedback:midi-device-change', handler);
        unsubs.push(function () {
            if (fb && typeof fb.off === 'function') fb.off('feedback:midi-device-change', handler);
        });
    }
    var doc = _doc();
    if (doc && typeof doc.addEventListener === 'function') {
        doc.addEventListener('feedback:midi-device-change', handler);
        unsubs.push(function () {
            if (doc && typeof doc.removeEventListener === 'function') {
                doc.removeEventListener('feedback:midi-device-change', handler);
            }
        });
    }
    _midiListUnsub = function () {
        unsubs.forEach(function (fn) {
            if (typeof fn === 'function') {
                try { fn(); } catch (_) { /* best-effort */ }
            }
        });
        _midiListUnsub = null;
    };
}

function _unbindMidiDeviceList() {
    if (typeof _midiListUnsub === 'function') {
        try { _midiListUnsub(); } catch (_) { /* best-effort */ }
        _midiListUnsub = null;
    }
}

async function persistActivePatch(patch) {
    var id = _editingProfileId();
    if (!id || !PROFILE_ID_RE.test(id)) {
        return { ok: false, skipped: true };
    }
    var seq = ++_persistSeq;
    var current = _editingProfile() || await getProfile(id) || { id: id, name: id };
    var next = _profileFromForm(current.name || current.id, id, patch || {});
    var res = await saveProfile(next);
    if (seq !== _persistSeq) return { ok: false, stale: true };
    if (res.ok) {
        var stored = res.data || next;
        if (stored && typeof stored === 'object') {
            stored.device_id = next.device_id;
            if (next.highway) stored.highway = next.highway;
            if (next.scoring) stored.scoring = next.scoring;
        }
        _cache.selected = stored;
        _cache.selectedId = id;
        if (id === _cache.activeId) _cache.active = _cache.selected;
        var idx = _cache.profiles.findIndex(function (p) { return p.id === id; });
        if (idx >= 0) _cache.profiles[idx] = _cache.selected;
        _live(_mount && _mount.root, 'Saved ' + (_cache.selected.name || _cache.selected.id) + '.');
    } else {
        _live(_mount && _mount.root, 'Could not save profile.');
    }
    return res;
}

function _showNameForm(mode, preset) {
    if (!_mount) return;
    var form = _mount.root.querySelector('.drums-editor-name-form');
    var input = _mount.root.querySelector('.drums-editor-name-input');
    if (!form || !input) return;
    form.hidden = false;
    form.dataset.mode = mode;
    input.value = preset || '';
    input.focus();
}

function _hideNameForm() {
    if (!_mount) return;
    var form = _mount.root.querySelector('.drums-editor-name-form');
    if (form) {
        form.hidden = true;
        form.dataset.mode = '';
    }
}

async function _submitNameForm() {
    if (!_mount) return;
    var form = _mount.root.querySelector('.drums-editor-name-form');
    var input = _mount.root.querySelector('.drums-editor-name-input');
    if (!form || !input) return;
    var mode = form.dataset.mode;
    var name = String(input.value || '').trim();
    if (!name) {
        _live(_mount.root, 'Enter a profile name.');
        return;
    }
    if (mode === 'rename') {
        var renameId = _editingProfileId();
        if (!renameId) {
            _live(_mount.root, 'Select a profile to rename.');
            return;
        }
        var renamed = _profileFromForm(name, renameId, {});
        var saved = await saveProfile(renamed);
        if (!saved.ok) {
            _live(_mount.root, 'Could not rename profile.');
            return;
        }
        _cache.selected = saved.data || renamed;
        _cache.selectedId = renameId;
        if (renameId === _cache.activeId) _cache.active = _cache.selected;
        await refreshProfiles();
        _hideNameForm();
        _live(_mount.root, 'Renamed to ' + name + '.');
        return;
    }
    var id = uniqueProfileId(slugifyName(name), _cache.profiles);
    var src = mode === 'duplicate' && _editingProfile() ? _editingProfile() : {};
    var created = {
        id: id,
        name: name,
        kit_id: src.kit_id || '',
        device_id: normalizeDeviceId(src.device_id),
        device: {
            source_id: '',
            enabled: Boolean(normalizeDeviceId(src.device_id)),
        },
        input: src.input || { midi_channel: -1, hit_detection: false, synth_volume: 0.7 },
        highway: _mergeHighway(src.highway, {}),
    };
    if (src.scoring && typeof src.scoring === 'object') {
        created.scoring = { precision_mode: src.scoring.precision_mode === true };
    }
    var put = await saveProfile(created);
    if (!put.ok) {
        _live(_mount.root, 'Could not create profile.');
        return;
    }
    _cache.profiles.push(put.data || created);
    _cache.selectedId = id;
    _cache.selected = put.data || created;
    if (!_cache.activeId) {
        var act = await activateProfile(id);
        if (act.ok) {
            _cache.activeId = id;
            _cache.active = _cache.selected;
        }
    }
    await refreshProfiles();
    _hideNameForm();
    var verb = mode === 'duplicate' ? 'Duplicated as ' : 'Created ';
    if (_cache.activeId === id) {
        _live(_mount.root, verb + name + '.');
    } else {
        _live(_mount.root, verb + name + '. Make active to use it for play.');
    }
}

async function _onSelectProfile(id) {
    if (!id) return;
    _cache.selectedId = id;
    _cache.selected = _cache.profiles.find(function (p) { return p.id === id; }) || await getProfile(id);
    _fillProfileSelect();
    _fillAttachSelect();
    _fill2dControls();
    _fillScoringControls();
    _updateActivateButton();
    await _loadAttachedDevice(_wantedDeviceId());
    _fillLaneGrid();
    var name = (_cache.selected && _cache.selected.name) || id;
    if (id === _cache.activeId) {
        _live(_mount && _mount.root, 'Editing active profile ' + name + '.');
    } else {
        _live(_mount && _mount.root, 'Editing ' + name + '. Make active to use it for play.');
    }
}

async function _onMakeActive() {
    var id = _editingProfileId();
    if (!id) {
        _live(_mount && _mount.root, 'Select a profile to make active.');
        return;
    }
    var act = await activateProfile(id);
    if (!act.ok) {
        _live(_mount && _mount.root, 'Could not activate profile.');
        return;
    }
    _cache.activeId = id;
    _cache.active = _cache.selected || _cache.profiles.find(function (p) { return p.id === id; }) || await getProfile(id);
    _fillProfileSelect();
    _updateActivateButton();
    _live(_mount && _mount.root, 'Active profile: ' + ((_cache.active && _cache.active.name) || id) + '.');
}

async function _onAttachDevice(id) {
    if (!_cache.midiAvailable) {
        _live(_mount && _mount.root, MIDI_UNAVAILABLE_MSG);
        return;
    }
    var deviceId = normalizeDeviceId(id);
    var res = await persistActivePatch({ device_id: deviceId });
    if (res && res.ok) {
        _fillAttachSelect();
        var attached = await _loadAttachedDevice(deviceId);
        _fillLaneGrid(attached);
        _live(_mount && _mount.root, deviceId
            ? 'Attached MIDI device.'
            : 'No MIDI device attached. Hits stay unmapped.');
    }
}

async function _onDeleteProfile() {
    var doomed = _editingProfileId();
    if (!doomed) {
        _live(_mount && _mount.root, 'Select a profile to delete.');
        return;
    }
    if (_cache.profiles.length < 2) {
        _live(_mount && _mount.root, 'Create another profile before deleting this one.');
        return;
    }
    var other = _cache.profiles.find(function (p) { return p.id !== doomed; });
    if (!other) {
        _live(_mount && _mount.root, 'Create another profile before deleting this one.');
        return;
    }
    if (doomed === _cache.activeId) {
        var act = await activateProfile(other.id);
        if (!act.ok) {
            _live(_mount && _mount.root, 'Activate another profile before deleting.');
            return;
        }
        _cache.activeId = other.id;
    }
    var del = await deleteProfile(doomed);
    if (!del.ok) {
        _live(_mount && _mount.root, del.detail || 'Could not delete profile.');
        return;
    }
    _cache.selectedId = other.id;
    await refreshProfiles();
    _live(_mount && _mount.root, 'Deleted profile.');
}

async function _loadAttachedDevice(deviceId) {
    var id = normalizeDeviceId(deviceId);
    if (!id) id = _wantedDeviceId();
    var seq = ++_attachLoadSeq;
    if (!id) {
        _cache.attachedDevice = null;
        _cache.attachedLoadError = '';
        return null;
    }
    var fromList = _cache.devices.find(function (d) { return d.id === id; }) || null;
    var api = _midiDevices();
    var got = null;
    var getFailed = false;
    var needGet = !_usableTriggerCount(fromList);
    if (needGet && api && typeof api.get === 'function') {
        try {
            got = _unwrapMidiDevice(await api.get.call(api, id));
        } catch (_) {
            getFailed = true;
        }
    }
    if (seq !== _attachLoadSeq) return _cache.attachedDevice;

    var prev = _cache.attachedDevice;
    var prevOk = prev && prev.id === id && _usableTriggerCount(prev);
    var candidate = null;
    if (_usableTriggerCount(got)) candidate = got;
    else if (_usableTriggerCount(fromList)) candidate = fromList;
    else if (prevOk) {
        _cache.attachedLoadError = '';
        return prev;
    } else {
        candidate = got || fromList || { id: id, triggers: [] };
    }

    var typeFailed = false;
    if (!_usableTriggerCount(candidate)) {
        var typeId = _deviceTypeId(candidate) || _deviceTypeId(got) || _deviceTypeId(fromList);
        if (typeId) {
            var cat = await _loadTypeTriggers(typeId);
            if (seq !== _attachLoadSeq) return _cache.attachedDevice;
            if (!cat.ok) typeFailed = true;
            else if (_usableTriggerCount({ triggers: cat.triggers })) {
                candidate = Object.assign({}, candidate, { triggers: cat.triggers });
            }
        }
    }

    _cache.attachedDevice = candidate;
    if (_usableTriggerCount(candidate)) {
        _cache.attachedLoadError = '';
    } else if (getFailed || typeFailed) {
        _cache.attachedLoadError = 'get-failed';
    } else {
        _cache.attachedLoadError = 'empty-triggers';
    }
    return _cache.attachedDevice;
}

function _fill2dControls() {
    if (!_mount || !_mount.root) return;
    var profile = _editingProfile();
    var two = profile && profile.highway && profile.highway['2d'] ? profile.highway['2d'] : {};
    var preset = two.lane_preset === 'rb4' ? 'rb4' : 'phase_shift_8';
    var sel = _mount.root.querySelector('.drums-lane-preset');
    if (sel) sel.value = preset;
    var chk = _mount.root.querySelector('.drums-chk-labels');
    if (chk) chk.checked = two.show_lane_labels !== false;
}

function _fillScoringControls() {
    if (!_mount || !_mount.root) return;
    var profile = _editingProfile();
    var chk = _mount.root.querySelector('.drums-chk-precision');
    if (chk) chk.checked = !!(profile && profile.scoring && profile.scoring.precision_mode === true);
}

function _updateActivateButton() {
    if (!_mount || !_mount.root) return;
    var btn = _mount.root.querySelector('.drums-profile-activate');
    var status = _mount.root.querySelector('.drums-profile-active-status');
    var selectedId = _editingProfileId();
    var canActivate = !!(selectedId && selectedId !== _cache.activeId);
    if (btn) {
        btn.disabled = !canActivate;
        if (canActivate) btn.removeAttribute('aria-disabled');
        else btn.setAttribute('aria-disabled', 'true');
    }
    if (status) {
        status.textContent = _cache.activeId
            ? ('Active profile: ' + ((_cache.active && _cache.active.name) || _cache.activeId)
                + (selectedId && selectedId !== _cache.activeId
                    ? ' · editing ' + ((_cache.selected && _cache.selected.name) || selectedId)
                    : ''))
            : 'No profile active.';
    }
}

function _fillLaneGrid(device) {
    if (!_mount || !_mount.root) return;
    var list = _mount.root.querySelector('.drums-lane-list');
    var addSel = _mount.root.querySelector('.drums-lane-add');
    var hint = _mount.root.querySelector('.drums-lane-hint');
    if (!list) return;
    var d = _doc();
    list.textContent = '';
    var wanted = _wantedDeviceId();
    var src = (device && typeof device === 'object' && !Array.isArray(device)
        && (device.id || Array.isArray(device.triggers)))
        ? device
        : _cache.attachedDevice;
    if (wanted && (!src || (src.id && src.id !== wanted))
        && _cache.attachedDevice && _cache.attachedDevice.id === wanted) {
        src = _cache.attachedDevice;
    }
    if (!wanted) src = null;
    var pool = triggerPool(src);
    var lanes = lanesFromProfile(_editingProfile());
    var taken = Object.create(null);
    var unused = 0;
    lanes.forEach(function (ln, i) {
        taken[ln.piece] = true;
        var row = d.createElement('div');
        row.className = 'drums-lane-row';
        var idx = d.createElement('span');
        idx.className = 'drums-lane-idx';
        idx.textContent = String(i);
        var name = d.createElement('span');
        name.className = 'drums-lane-name';
        name.textContent = _triggerName(pool, ln.piece);
        var up = d.createElement('button');
        up.type = 'button';
        up.className = 'drums-lane-up';
        up.dataset.act = 'up';
        up.dataset.i = String(i);
        up.textContent = '▲';
        up.disabled = i === 0;
        up.setAttribute('aria-label', 'Move ' + name.textContent + ' up');
        var down = d.createElement('button');
        down.type = 'button';
        down.className = 'drums-lane-down';
        down.dataset.act = 'down';
        down.dataset.i = String(i);
        down.textContent = '▼';
        down.disabled = i === lanes.length - 1;
        down.setAttribute('aria-label', 'Move ' + name.textContent + ' down');
        var rm = d.createElement('button');
        rm.type = 'button';
        rm.className = 'drums-lane-rm';
        rm.dataset.act = 'rm';
        rm.dataset.i = String(i);
        rm.textContent = '✗';
        rm.setAttribute('aria-label', 'Remove ' + name.textContent);
        row.appendChild(idx);
        row.appendChild(name);
        row.appendChild(up);
        row.appendChild(down);
        row.appendChild(rm);
        list.appendChild(row);
    });
    pool.forEach(function (t) {
        if (!taken[t.id]) unused += 1;
    });
    if (addSel) {
        addSel.textContent = '';
        var empty = d.createElement('option');
        empty.value = '';
        if (!wanted) empty.textContent = '— attach a device first —';
        else if (!pool.length && _cache.attachedLoadError === 'get-failed') {
            empty.textContent = '— could not load pads —';
        } else if (!pool.length) {
            empty.textContent = '— no pads on this device —';
        } else {
            empty.textContent = '— pick a piece to add —';
        }
        addSel.appendChild(empty);
        pool.forEach(function (t) {
            if (taken[t.id]) return;
            var opt = d.createElement('option');
            opt.value = t.id;
            opt.textContent = t.name;
            addSel.appendChild(opt);
        });
        addSel.disabled = unused === 0;
    }
    if (hint) {
        if (pool.length) hint.textContent = '';
        else if (!wanted) hint.textContent = NO_DEVICE_LANES_MSG;
        else if (_cache.attachedLoadError === 'get-failed') hint.textContent = GET_FAILED_LANES_MSG;
        else hint.textContent = NO_PADS_LANES_MSG;
    }
}

async function _maybeSeedLanesFrom3dKit() {
    var profile = _editingProfile();
    if (!profile || lanesFromProfile(profile).length) return;
    var pool = triggerPool(_cache.attachedDevice);
    if (!pool.length) return;
    var allowed = Object.create(null);
    pool.forEach(function (t) { allowed[t.id] = true; });
    var kit = (typeof window !== 'undefined' && window.drumH3dGetKit)
        ? window.drumH3dGetKit()
        : null;
    if (!kit || !Array.isArray(kit.lanes) || !kit.lanes.length) return;
    var seed = [];
    kit.lanes.forEach(function (ln) {
        var piece = ln && ln.piece;
        if (!allowed[piece]) return;
        if (seed.some(function (s) { return s.piece === piece; })) return;
        seed.push({ piece: piece });
    });
    if (!seed.length) return;
    await _persistLanes(seed);
}

async function _persistLanes(nextLanes) {
    var current = lanesFromProfile(_editingProfile());
    var three = ((_editingProfile() || {}).highway || {})['3d'] || {};
    var res = await persistActivePatch({
        highway: {
            '3d': Object.assign({}, three, { lanes: nextLanes || current }),
        },
    });
    if (res && res.ok) _fillLaneGrid();
    return res;
}

async function addLane(pieceId) {
    if (!pieceIdOk(pieceId)) return { ok: false };
    var pool = triggerPool(_cache.attachedDevice);
    var allowed = pool.some(function (t) { return t.id === pieceId; });
    if (!allowed) return { ok: false, reason: 'not-in-pool' };
    var lanes = lanesFromProfile(_editingProfile());
    if (lanes.some(function (ln) { return ln.piece === pieceId; })) {
        return { ok: false, reason: 'duplicate' };
    }
    lanes.push({ piece: pieceId });
    return _persistLanes(lanes);
}

async function moveLane(index, dir) {
    var lanes = lanesFromProfile(_editingProfile());
    var i = Number(index);
    var j = dir === 'up' ? i - 1 : i + 1;
    if (i < 0 || i >= lanes.length || j < 0 || j >= lanes.length) {
        return { ok: false, reason: 'bounds' };
    }
    var tmp = lanes[i];
    lanes[i] = lanes[j];
    lanes[j] = tmp;
    return _persistLanes(lanes);
}

async function removeLane(index) {
    var lanes = lanesFromProfile(_editingProfile());
    var i = Number(index);
    if (i < 0 || i >= lanes.length) return { ok: false, reason: 'bounds' };
    lanes.splice(i, 1);
    return _persistLanes(lanes);
}

function _editorHtml(opts) {
    var labels = opts.showLaneLabels !== false ? ' checked' : '';
    var preset = opts.lanePreset === 'rb4' ? 'rb4' : 'phase_shift_8';
    return (
        '<div class="drums-editor-chrome">' +
            '<p class="drums-profile-active-status">No profile active.</p>' +
            '<div class="drums-editor-chrome-row">' +
                '<label class="drums-editor-field">' +
                    '<span>Profile</span>' +
                    '<select class="drums-profile-select" aria-label="Drum profile"></select>' +
                '</label>' +
                '<div class="drums-editor-chrome-actions">' +
                    '<button type="button" class="drums-profile-create">Create</button>' +
                    '<button type="button" class="drums-profile-rename">Rename</button>' +
                    '<button type="button" class="drums-profile-duplicate">Duplicate</button>' +
                    '<button type="button" class="drums-profile-delete">Delete</button>' +
                    '<button type="button" class="drums-profile-activate" disabled aria-disabled="true">Make active</button>' +
                '</div>' +
            '</div>' +
            '<form class="drums-editor-name-form" hidden>' +
                '<label class="drums-editor-field drums-editor-field--grow">' +
                    '<span>Name</span>' +
                    '<input type="text" class="drums-editor-name-input" maxlength="80" autocomplete="off">' +
                '</label>' +
                '<button type="submit" class="drums-profile-name-save">Save</button>' +
                '<button type="button" class="drums-profile-name-cancel">Cancel</button>' +
            '</form>' +
            '<p class="drums-editor-live" role="status" aria-live="polite"></p>' +
            '<div class="drums-editor-row drums-precision-row">' +
                '<label class="drums-editor-check">' +
                    '<input type="checkbox" class="drums-chk-precision"' +
                        ' aria-label="Precision mode"' +
                        ' aria-describedby="drums-precision-hint">' +
                    '<span>Precision</span>' +
                '</label>' +
                '<p class="drums-precision-hint" id="drums-precision-hint">' +
                    'Tighter fixed ±50 ms window. Not YARG density-scaled Precision.' +
                '</p>' +
            '</div>' +
        '</div>' +
        '<section class="drums-editor-section" data-drums-section="attach" aria-labelledby="drums-editor-attach-h">' +
            '<h3 id="drums-editor-attach-h">MIDI device</h3>' +
            '<div class="drums-editor-row">' +
                '<label class="drums-editor-field">' +
                    '<span>Attach</span>' +
                    '<select class="drums-attach-select" aria-label="Attach MIDI device" disabled></select>' +
                '</label>' +
            '</div>' +
        '</section>' +
        '<section class="drums-editor-section" data-drums-section="lanes" aria-labelledby="drums-editor-lanes-h">' +
            '<h3 id="drums-editor-lanes-h">Lanes</h3>' +
            '<p class="drums-lane-copy">Left → right on the highway. The add list is the attached device\'s pads; you do not have to use every pad. Kick is a full-width bar on 3D.</p>' +
            '<p class="drums-lane-hint" role="status"></p>' +
            '<div class="drums-lane-list"></div>' +
            '<label class="drums-editor-field drums-editor-field--grow">' +
                '<span>Add a piece</span>' +
                '<select class="drums-lane-add" aria-label="Add a piece"></select>' +
            '</label>' +
        '</section>' +
        '<details class="drums-2d-highway" data-drums-section="highway">' +
            '<summary class="drums-2d-highway-summary">2D Drum Highway</summary>' +
            '<p class="drums-lane-copy">Visual preset for the 2D highway only. Independent of the profile piece list above.</p>' +
            '<div class="drums-editor-row">' +
                '<label class="drums-editor-field">' +
                    '<span>Lanes</span>' +
                    '<select class="drums-lane-preset" aria-label="2D lane preset">' +
                        '<option value="phase_shift_8"' + (preset === 'phase_shift_8' ? ' selected' : '') + '>Phase Shift 8</option>' +
                        '<option value="rb4"' + (preset === 'rb4' ? ' selected' : '') + '>Rock Band</option>' +
                    '</select>' +
                '</label>' +
                '<label class="drums-editor-check">' +
                    '<input type="checkbox" class="drums-chk-labels"' + labels + '>' +
                    '<span>Labels</span>' +
                '</label>' +
            '</div>' +
        '</details>'
    );
}

function _wireChrome(root) {
    root.querySelector('.drums-profile-select').onchange = function () {
        _onSelectProfile(this.value);
    };
    root.querySelector('.drums-profile-create').onclick = function () {
        _showNameForm('create', '');
    };
    root.querySelector('.drums-profile-rename').onclick = function () {
        var editing = _editingProfile();
        var preset = (editing && editing.name) || '';
        _showNameForm('rename', preset);
    };
    root.querySelector('.drums-profile-duplicate').onclick = function () {
        var editing = _editingProfile();
        var base = (editing && editing.name) ? (editing.name + ' copy') : '';
        _showNameForm('duplicate', base);
    };
    root.querySelector('.drums-profile-delete').onclick = function () {
        _onDeleteProfile();
    };
    var activate = root.querySelector('.drums-profile-activate');
    if (activate) {
        activate.onclick = function () { _onMakeActive(); };
    };
    var form = root.querySelector('.drums-editor-name-form');
    form.onsubmit = function (ev) {
        if (ev && ev.preventDefault) ev.preventDefault();
        _submitNameForm();
    };
    root.querySelector('.drums-profile-name-cancel').onclick = function () {
        _hideNameForm();
    };
    var precision = root.querySelector('.drums-chk-precision');
    if (precision) {
        precision.onchange = function () {
            persistActivePatch({ scoring: { precision_mode: !!this.checked } });
        };
    }
    var attach = root.querySelector('.drums-attach-select');
    if (attach) {
        attach.onchange = function () {
            _onAttachDevice(this.value);
        };
    }
    var addSel = root.querySelector('.drums-lane-add');
    if (addSel) {
        addSel.onchange = function () {
            var piece = this.value;
            this.value = '';
            if (piece) addLane(piece);
        };
    }
    var list = root.querySelector('.drums-lane-list');
    if (list) {
        list.onclick = function (ev) {
            var t = ev && ev.target;
            while (t && t !== list && !(t.dataset && t.dataset.act)) t = t.parentNode;
            if (!t || t === list) return;
            var i = t.dataset.i;
            var act = t.dataset.act;
            if (act === 'up') moveLane(i, 'up');
            else if (act === 'down') moveLane(i, 'down');
            else if (act === 'rm') removeLane(i);
        };
    }
}

function mountDrumEditor(host, opts) {
    opts = opts || {};
    var context = opts.context === 'pause' ? 'pause' : 'settings';
    if (!CONTEXTS[context]) context = 'settings';
    if (!host) return { ok: false, reason: 'no-host' };
    var d = _doc();
    if (!d || typeof d.createElement !== 'function') return { ok: false, reason: 'no-dom' };

    if (_mount) {
        if (context === 'pause') {
            unmountDrumEditor();
        } else {
            return { ok: false, reason: 'already-mounted', context: _mount.context };
        }
    }

    var root = d.createElement('div');
    root.className = 'drums-editor drums-settings-panel';
    root.dataset.drumsEditorContext = context;
    root.innerHTML = _editorHtml(opts);
    host.appendChild(root);
    _wireChrome(root);

    _mount = {
        host: host,
        root: root,
        context: context,
        dialog: opts.dialog || null,
        onUnmounted: opts.onUnmounted || null,
        hostRestore: null,
    };

    refreshProfiles();
    listMidiDevices().then(function () {
        _fillAttachSelect();
        return _loadAttachedDevice(_wantedDeviceId());
    }).then(function (dev) { _fillLaneGrid(dev); });
    _bindMidiDeviceList();
    if (typeof opts.onMounted === 'function') opts.onMounted(root, { context: context });
    return { ok: true, context: context, root: root };
}

function openPauseDrumEditor(opts) {
    opts = opts || {};
    var d = _doc();
    if (!d || typeof d.createElement !== 'function') return { ok: false, reason: 'no-dom' };

    if (_mount && _mount.context === 'pause') {
        if (_mount.dialog && typeof _mount.dialog.focus === 'function') _mount.dialog.focus();
        return { ok: true, reused: true, context: 'pause', root: _mount.root };
    }

    var dialog = d.createElement('div');
    dialog.className = 'drums-editor-dialog';
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-label', 'Drum settings');
    dialog.tabIndex = -1;
    dialog.style.cssText = 'position:fixed;inset:0;z-index:50;pointer-events:auto;';

    var backdrop = d.createElement('div');
    backdrop.className = 'drums-editor-dialog-backdrop';
    dialog.appendChild(backdrop);

    var sheet = d.createElement('div');
    sheet.className = 'drums-editor-dialog-sheet';
    var header = d.createElement('div');
    header.className = 'drums-editor-dialog-header';
    var title = d.createElement('h2');
    title.className = 'drums-editor-dialog-title';
    title.textContent = 'Drum settings';
    var close = d.createElement('button');
    close.type = 'button';
    close.className = 'drums-editor-dialog-close';
    close.setAttribute('aria-label', 'Close drum settings');
    close.textContent = 'Close';
    close.onclick = function () { unmountDrumEditor(); };
    header.appendChild(title);
    header.appendChild(close);
    sheet.appendChild(header);
    var body = d.createElement('div');
    body.className = 'drums-editor-dialog-body';
    sheet.appendChild(body);
    dialog.appendChild(sheet);
    (d.body || d.documentElement).appendChild(dialog);

    var mounted = mountDrumEditor(body, {
        context: 'pause',
        dialog: dialog,
        onMounted: opts.onMounted,
        onUnmounted: opts.onUnmounted,
        synthVolume: opts.synthVolume,
        midiChannel: opts.midiChannel,
        hitDetection: opts.hitDetection,
        showLaneLabels: opts.showLaneLabels,
        lanePreset: opts.lanePreset,
    });
    if (!mounted.ok) {
        if (dialog.parentNode) dialog.parentNode.removeChild(dialog);
        return mounted;
    }
    if (typeof opts.trapFocus === 'function') {
        try { opts.trapFocus(dialog); } catch (_) { /* host helper is optional */ }
    }
    if (typeof dialog.focus === 'function') dialog.focus();
    return mounted;
}

function resetForTests() {
    unmountDrumEditor();
    _cache = {
        profiles: [],
        activeId: '',
        active: null,
        selectedId: '',
        selected: null,
        devices: [],
        midiAvailable: false,
        attachedDevice: null,
        attachedLoadError: '',
    };
    _persistSeq = 0;
    _attachLoadSeq = 0;
}

var api = {
    mountDrumEditor: mountDrumEditor,
    unmountDrumEditor: unmountDrumEditor,
    openPauseDrumEditor: openPauseDrumEditor,
    getMountedEditor: getMountedEditor,
    persistActivePatch: persistActivePatch,
    refreshProfiles: refreshProfiles,
    listProfiles: listProfiles,
    listMidiDevices: listMidiDevices,
    saveProfile: saveProfile,
    activateProfile: activateProfile,
    deleteProfile: deleteProfile,
    slugifyName: slugifyName,
    uniqueProfileId: uniqueProfileId,
    normalizeDeviceId: normalizeDeviceId,
    pieceIdOk: pieceIdOk,
    lanesFromProfile: lanesFromProfile,
    triggerPool: triggerPool,
    addLane: addLane,
    moveLane: moveLane,
    removeLane: removeLane,
    learnLockMessage: learnLockMessage,
    isLearnLockedStatus: isLearnLockedStatus,
    resetForTests: resetForTests,
    PROFILE_ID_RE: PROFILE_ID_RE,
    DEVICE_ID_RE: DEVICE_ID_RE,
};

if (typeof window !== 'undefined') {
    window.feedBackDrumsEditor = api;
    window.feedBackMountDrumEditor = mountDrumEditor;
}
if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
}

})(typeof window !== 'undefined' ? window : this);
