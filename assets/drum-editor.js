// INIT-003/SPEC-005: shared Drum editor factory.
// Settings and pause call the same mount; only one instance is live.
// Profile writes prefer window.feedBack.drumProfiles (SPEC-004) and
// fall back to SPEC-002 HTTP so switching later is a one-function change.
(function (root) {
'use strict';

var PROFILE_ID_RE = /^[a-z0-9-]+$/;
var CONTEXTS = { settings: true, pause: true };
var LEARN_LOCK_MSG = 'Learn is locked while a song is playing or paused. Mapping was not changed.';

var _mount = null;
var _cache = { profiles: [], activeId: '', active: null };
var _persistSeq = 0;

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
    var body = {
        id: profile.id,
        name: profile.name,
        kit_id: profile.kit_id || '',
        device: {
            source_id: profile.device && typeof profile.device.source_id === 'string'
                ? profile.device.source_id : '',
            enabled: Boolean(profile.device && profile.device.enabled),
        },
        input: profile.input || { midi_channel: -1, hit_detection: false, synth_volume: 0.7 },
        highway: profile.highway || { '2d': { lane_preset: 'phase_shift_8', show_lane_labels: true } },
    };
    if ('notes' in body) delete body.notes;
    var api = _accessor();
    if (api && typeof api.save === 'function') {
        var saved = await api.save.call(api, body);
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
    var next = {
        '2d': Object.assign(
            { lane_preset: 'phase_shift_8', show_lane_labels: true },
            hw['2d'] || {},
            (patch && patch['2d']) || {}
        ),
    };
    if (hw['3d']) next['3d'] = hw['3d'];
    if (patch && patch['3d']) next['3d'] = patch['3d'];
    return next;
}

function _profileFromForm(name, id, patch) {
    var base = _cache.active || {};
    return {
        id: id,
        name: name,
        kit_id: patch.kit_id != null ? patch.kit_id : (base.kit_id || ''),
        device: {
            source_id: (patch.device && patch.device.source_id) ||
                (base.device && base.device.source_id) || '',
            enabled: patch.device && patch.device.enabled != null
                ? Boolean(patch.device.enabled)
                : Boolean(base.device && base.device.enabled),
        },
        input: Object.assign(
            { midi_channel: -1, hit_detection: false, synth_volume: 0.7 },
            base.input || {},
            patch.input || {}
        ),
        highway: _mergeHighway(base.highway, patch.highway),
    };
}

async function refreshProfiles() {
    _cache.profiles = await listProfiles();
    _cache.activeId = await readActiveProfileId();
    _cache.active = _cache.profiles.find(function (p) { return p.id === _cache.activeId; }) || null;
    if (!_cache.active && _cache.activeId) {
        _cache.active = await getProfile(_cache.activeId);
    }
    _fillProfileSelect();
    return _cache;
}

function _fillProfileSelect() {
    if (!_mount || !_mount.root) return;
    var sel = _mount.root.querySelector('.drums-profile-select');
    if (!sel) return;
    var keep = _cache.activeId;
    sel.textContent = '';
    var empty = _doc().createElement('option');
    empty.value = '';
    empty.textContent = _cache.profiles.length ? 'Select a profile' : 'No profiles yet';
    sel.appendChild(empty);
    _cache.profiles.forEach(function (p) {
        var opt = _doc().createElement('option');
        opt.value = p.id;
        opt.textContent = p.name || p.id;
        if (p.id === keep) opt.selected = true;
        sel.appendChild(opt);
    });
    if (keep) sel.value = keep;
}

async function persistActivePatch(patch) {
    if (!_cache.activeId || !PROFILE_ID_RE.test(_cache.activeId)) {
        return { ok: false, skipped: true };
    }
    var seq = ++_persistSeq;
    var current = _cache.active || await getProfile(_cache.activeId) || { id: _cache.activeId, name: _cache.activeId };
    var next = _profileFromForm(current.name || current.id, _cache.activeId, patch || {});
    var res = await saveProfile(next);
    if (seq !== _persistSeq) return { ok: false, stale: true };
    if (res.ok) {
        _cache.active = res.data || next;
        _live(_mount && _mount.root, 'Saved ' + (_cache.active.name || _cache.active.id) + '.');
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
        if (!_cache.activeId) {
            _live(_mount.root, 'Select a profile to rename.');
            return;
        }
        var renamed = _profileFromForm(name, _cache.activeId, {});
        var saved = await saveProfile(renamed);
        if (!saved.ok) {
            _live(_mount.root, 'Could not rename profile.');
            return;
        }
        _cache.active = saved.data || renamed;
        await refreshProfiles();
        _hideNameForm();
        _live(_mount.root, 'Renamed to ' + name + '.');
        return;
    }
    var id = uniqueProfileId(slugifyName(name), _cache.profiles);
    var src = mode === 'duplicate' && _cache.active ? _cache.active : {};
    var created = {
        id: id,
        name: name,
        kit_id: src.kit_id || '',
        device: {
            source_id: (src.device && src.device.source_id) || '',
            enabled: Boolean(src.device && src.device.enabled),
        },
        input: src.input || { midi_channel: -1, hit_detection: false, synth_volume: 0.7 },
        highway: _mergeHighway(src.highway, {}),
    };
    var put = await saveProfile(created);
    if (!put.ok) {
        _live(_mount.root, 'Could not create profile.');
        return;
    }
    _cache.profiles.push(put.data || created);
    var act = await activateProfile(id);
    if (!act.ok) {
        _live(_mount.root, 'Created, but could not activate.');
        await refreshProfiles();
        _hideNameForm();
        return;
    }
    _cache.activeId = id;
    _cache.active = put.data || created;
    await refreshProfiles();
    _hideNameForm();
    _live(_mount.root, (mode === 'duplicate' ? 'Duplicated as ' : 'Created ') + name + '.');
}

async function _onSelectProfile(id) {
    if (!id) return;
    var act = await activateProfile(id);
    if (!act.ok) {
        _live(_mount && _mount.root, 'Could not activate profile.');
        return;
    }
    _cache.activeId = id;
    _cache.active = _cache.profiles.find(function (p) { return p.id === id; }) || await getProfile(id);
    _fillProfileSelect();
    _live(_mount && _mount.root, 'Activated ' + ((_cache.active && _cache.active.name) || id) + '.');
}

async function _onDeleteProfile() {
    if (!_cache.activeId) {
        _live(_mount && _mount.root, 'Select a profile to delete.');
        return;
    }
    if (_cache.profiles.length < 2) {
        _live(_mount && _mount.root, 'Create another profile before deleting this one.');
        return;
    }
    var doomed = _cache.activeId;
    var other = _cache.profiles.find(function (p) { return p.id !== doomed; });
    if (!other) {
        _live(_mount && _mount.root, 'Create another profile before deleting this one.');
        return;
    }
    var act = await activateProfile(other.id);
    if (!act.ok) {
        _live(_mount && _mount.root, 'Activate another profile before deleting.');
        return;
    }
    var del = await deleteProfile(doomed);
    if (!del.ok) {
        _live(_mount && _mount.root, del.detail || 'Could not delete profile.');
        return;
    }
    _cache.activeId = other.id;
    await refreshProfiles();
    _live(_mount && _mount.root, 'Deleted profile.');
}

function _channelOptions(selected) {
    var sel = selected == null ? -1 : selected;
    var html = '<option value="-1"' + (sel === -1 ? ' selected' : '') + '>All</option>' +
        '<option value="9"' + (sel === 9 ? ' selected' : '') + '>10 (Drums)</option>';
    for (var i = 0; i < 16; i++) {
        if (i === 9) continue;
        html += '<option value="' + i + '"' + (sel === i ? ' selected' : '') + '>' + (i + 1) + '</option>';
    }
    return html;
}

function _editorHtml(opts) {
    var vol = opts.synthVolume != null ? Math.round(opts.synthVolume * 100) : 70;
    var ch = opts.midiChannel != null ? opts.midiChannel : -1;
    var hits = opts.hitDetection ? ' checked' : '';
    var labels = opts.showLaneLabels !== false ? ' checked' : '';
    var preset = opts.lanePreset === 'rb4' ? 'rb4' : 'phase_shift_8';
    return (
        '<div class="drums-editor-chrome">' +
            '<div class="drums-editor-chrome-row">' +
                '<label class="drums-editor-field">' +
                    '<span>Profile</span>' +
                    '<select class="drums-profile-select" aria-label="Active drum profile"></select>' +
                '</label>' +
                '<div class="drums-editor-chrome-actions">' +
                    '<button type="button" class="drums-profile-create">Create</button>' +
                    '<button type="button" class="drums-profile-rename">Rename</button>' +
                    '<button type="button" class="drums-profile-duplicate">Duplicate</button>' +
                    '<button type="button" class="drums-profile-delete">Delete</button>' +
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
        '</div>' +
        '<section class="drums-editor-section" data-drums-section="device" aria-labelledby="drums-editor-device-h">' +
            '<h3 id="drums-editor-device-h">Device</h3>' +
            '<div class="drums-editor-row">' +
                '<label class="drums-editor-field">' +
                    '<span>MIDI</span>' +
                    '<select class="drums-midi-select" aria-label="MIDI device"><option value="">None</option></select>' +
                '</label>' +
                '<label class="drums-editor-field">' +
                    '<span>Vol</span>' +
                    '<input type="range" class="drums-vol-slider" min="0" max="100" value="' + vol + '" aria-label="Drum synth volume">' +
                '</label>' +
                '<label class="drums-editor-field">' +
                    '<span>Ch</span>' +
                    '<select class="drums-channel-select" aria-label="MIDI channel">' + _channelOptions(ch) + '</select>' +
                '</label>' +
                '<label class="drums-editor-check">' +
                    '<input type="checkbox" class="drums-chk-hits"' + hits + '>' +
                    '<span>Hits</span>' +
                '</label>' +
            '</div>' +
        '</section>' +
        '<section class="drums-editor-section" data-drums-section="map" aria-labelledby="drums-editor-map-h">' +
            '<h3 id="drums-editor-map-h">Map</h3>' +
            '<div class="drums-editor-row">' +
                '<label class="drums-editor-field">' +
                    '<span>Kit</span>' +
                    '<select class="drums-kit-select" aria-label="Drum kit"></select>' +
                '</label>' +
                '<button type="button" class="drums-kit-confirm" aria-label="Use this kit">Use this kit</button>' +
                '<button type="button" class="drums-reset-map">Reset Map</button>' +
            '</div>' +
            '<div class="drums-kit-suggest" role="status" hidden></div>' +
            '<div class="drums-map-status" role="status" aria-live="polite"></div>' +
            '<div class="drums-editor-map-wrap">' +
                '<table class="drums-map-table"></table>' +
            '</div>' +
        '</section>' +
        '<section class="drums-editor-section" data-drums-section="highway" aria-labelledby="drums-editor-highway-h">' +
            '<h3 id="drums-editor-highway-h">Highway</h3>' +
            '<div class="drums-editor-row">' +
                '<label class="drums-editor-field">' +
                    '<span>Lanes</span>' +
                    '<select class="drums-lane-preset" aria-label="Lane preset">' +
                        '<option value="phase_shift_8"' + (preset === 'phase_shift_8' ? ' selected' : '') + '>Phase Shift 8</option>' +
                        '<option value="rb4"' + (preset === 'rb4' ? ' selected' : '') + '>Rock Band</option>' +
                    '</select>' +
                '</label>' +
                '<label class="drums-editor-check">' +
                    '<input type="checkbox" class="drums-chk-labels"' + labels + '>' +
                    '<span>Labels</span>' +
                '</label>' +
            '</div>' +
        '</section>'
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
        var preset = (_cache.active && _cache.active.name) || '';
        _showNameForm('rename', preset);
    };
    root.querySelector('.drums-profile-duplicate').onclick = function () {
        var base = (_cache.active && _cache.active.name) ? (_cache.active.name + ' copy') : '';
        _showNameForm('duplicate', base);
    };
    root.querySelector('.drums-profile-delete').onclick = function () {
        _onDeleteProfile();
    };
    var form = root.querySelector('.drums-editor-name-form');
    form.onsubmit = function (ev) {
        if (ev && ev.preventDefault) ev.preventDefault();
        _submitNameForm();
    };
    root.querySelector('.drums-profile-name-cancel').onclick = function () {
        _hideNameForm();
    };
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
    _cache = { profiles: [], activeId: '', active: null };
    _persistSeq = 0;
}

var api = {
    mountDrumEditor: mountDrumEditor,
    unmountDrumEditor: unmountDrumEditor,
    openPauseDrumEditor: openPauseDrumEditor,
    getMountedEditor: getMountedEditor,
    persistActivePatch: persistActivePatch,
    refreshProfiles: refreshProfiles,
    listProfiles: listProfiles,
    saveProfile: saveProfile,
    activateProfile: activateProfile,
    deleteProfile: deleteProfile,
    slugifyName: slugifyName,
    uniqueProfileId: uniqueProfileId,
    learnLockMessage: learnLockMessage,
    isLearnLockedStatus: isLearnLockedStatus,
    resetForTests: resetForTests,
    PROFILE_ID_RE: PROFILE_ID_RE,
};

if (typeof window !== 'undefined') {
    window.feedBackDrumsEditor = api;
    window.feedBackMountDrumEditor = mountDrumEditor;
}
if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
}

})(typeof window !== 'undefined' ? window : this);
