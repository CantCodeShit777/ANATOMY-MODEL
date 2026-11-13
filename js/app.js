/* Anatomy Atlas — UI: wires the panel and stage controls to the 3D viewer (js/anatomy-viewer.js). */
(function () {
  'use strict';

  // ---------- Copy ----------
  var MODES = [['skin', 'Skin'], ['muscle', 'Muscles'], ['skeleton', 'Skeleton']];
  var VIEWS = [
    ['front', 'Front', 'Front view'],
    ['back', 'Back', 'Back view'],
    ['left', 'Left', 'View the model’s left side'],
    ['right', 'Right', 'View the model’s right side'],
    ['fit', 'Fit body', 'Frame the whole body'],
    ['reset', 'Reset', 'Reset the view']
  ];
  var HINTS = {
    skin: ['Start with the surface', 'This is the body as you see it. Switch to Muscles to remove the skin, then tap any muscle on the model or pick one from the groups below. The camera and your selection stay put when you switch.'],
    muscle: ['Tap a muscle', 'Tap a muscle or tendon on the model, or open a group below. Use Hide to peel away a surface muscle and study what lies beneath, and the Skin overlay slider to see where it sits under the surface.'],
    skeleton: ['Tap a bone', 'Tap any bone, down to single vertebrae, ribs and finger bones, or open a group below.']
  };
  var VER = {
    R: 'Origin, insertion, action and nerve were checked against this muscle’s entry in:',
    G: 'This part has no entry of its own in the reference; details were checked against the entry for its parent group in:',
    N: 'Not verified: this structure is not listed in the reference table, so the details here are from general anatomy knowledge. Reference used for the other muscles:'
  };
  var SYS_LABEL = { bone: 'Bone', muscle: 'Muscle', tendon: 'Tendon or ligament' };

  // ---------- State ----------
  var state = { mode: 'skin', sel: null, hover: '', query: '', ready: false, failed: false, overlay: 0, hidden: 0, open: {}, panelOpen: true };
  var viewer = null;
  var catCache = {};

  function setState(patch) {
    for (var k in patch) state[k] = patch[k];
    schedule();
  }
  var queued = false;
  function schedule() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(function () { queued = false; render(); });
  }

  // ---------- Helpers ----------
  var $ = function (id) { return document.getElementById(id); };
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function setHTML(el, html) { if (el.__html !== html) { el.__html = html; el.innerHTML = html; } }
  function setText(el, text) { if (el.textContent !== text) el.textContent = text; }
  function sideLower(side) { return side ? ' (' + side.toLowerCase() + ')' : ''; }
  function listMode() { return state.mode === 'skeleton' ? 'skeleton' : 'muscle'; }

  function catalog(mode) {
    if (!viewer) return [];
    if (catCache[mode]) return catCache[mode];
    var cur = viewer.getMode();
    if (cur !== mode) viewer.setMode(mode);
    var items = viewer.list();
    if (cur !== mode) viewer.setMode(cur);
    var byName = {}, out = [];
    items.forEach(function (it) {
      var e = byName[it.name];
      if (!e) { e = byName[it.name] = { name: it.name, g: it.g, layer: it.layer, ids: [] }; out.push(e); }
      e.ids.push({ id: it.id, side: it.side });
    });
    catCache[mode] = out;
    return out;
  }

  // ---------- Render ----------
  function renderModes() {
    setHTML($('modes'), MODES.map(function (m) {
      var on = state.mode === m[0];
      return '<button class="seg' + (on ? ' on' : '') + '" aria-pressed="' + on + '" data-act="mode" data-arg="' + m[0] + '">' + esc(m[1]) + '</button>';
    }).join(''));
  }

  function renderViews() {
    setHTML($('views'), VIEWS.map(function (v) {
      return '<button class="vbtn" aria-label="' + esc(v[2]) + '" title="' + esc(v[2]) + '" data-act="view" data-arg="' + v[0] + '">' + esc(v[1]) + '</button>';
    }).join(''));
  }

  function renderStage() {
    $('shell').classList.toggle('pc', !state.panelOpen);
    var loading = $('loading');
    loading.hidden = state.ready;
    setText(loading, state.failed ? 'The 3D model could not load. Try reopening the page.' : 'Loading the 3D model…');

    var hover = $('hover');
    hover.hidden = !state.hover;
    setText(hover, state.hover);

    $('overlayCtl').hidden = !(state.ready && state.mode !== 'skin');
    var ov = $('ov');
    if (document.activeElement !== ov && +ov.value !== state.overlay) ov.value = state.overlay;
  }

  function renderToggle() {
    var t = $('ptoggle');
    t.setAttribute('aria-expanded', String(state.panelOpen));
    setText($('ptoggleTitle'), state.sel ? state.sel.name : 'Information and structure list');
    setText($('ptoggleHint'), state.panelOpen ? 'Hide panel' : 'Show panel');
    var st = $('sideToggle');
    st.setAttribute('aria-expanded', String(state.panelOpen));
    st.title = state.panelOpen ? 'Hide the information panel' : 'Show the information panel';
    setText(st, state.panelOpen ? 'Hide panel' : 'Show panel');
  }

  function field(label, text, tight) {
    return '<div class="field' + (tight ? ' tight' : '') + '"><p class="lab">' + esc(label) + '</p><p class="txt">' + esc(text) + '</p></div>';
  }

  function renderInfo() {
    var s = state, i = s.sel, html;
    if (!i) {
      var h = HINTS[s.mode];
      html = '<h2 class="h-hint">' + esc(h[0]) + '</h2><p class="txt soft">' + esc(h[1]) + '</p>';
      setHTML($('info'), html);
      return;
    }
    var isM = i.sys !== 'bone';
    var by = i.by || [];
    var chips = [SYS_LABEL[i.sys], i.group, i.side ? i.side + ' side' : 'Midline', isM ? i.layer : (i.region || '')].filter(Boolean);

    var notes = [];
    if (i.hidden) notes.push('This structure is hidden. Use Show selected to bring it back.');
    if (s.mode === 'skin' || (s.mode === 'skeleton') === isM) notes.push('Switch to ' + (isM ? 'Muscles' : 'Skeleton') + ' to see it on the model.');

    html = '<div class="chips">' + chips.map(function (c) { return '<span class="chip">' + esc(c) + '</span>'; }).join('') + '</div>' +
      '<h2 class="h-sel">' + esc(i.name) + '</h2>' +
      '<p class="txt">' + esc(i.intro || '') + '</p>' +
      '<div class="actions">' +
        '<button class="act pri" data-act="focus">Focus</button>' +
        '<button class="act" data-act="isolate">Isolate selected</button>' +
        '<button class="act" data-act="hide">' + (i.hidden ? 'Show selected' : 'Hide selected') + '</button>' +
        '<button class="act" data-act="showAll"' + (s.hidden === 0 ? ' disabled' : '') + '>Show all</button>' +
      '</div>' +
      (notes.length ? '<p class="note">' + esc(notes.join(' ')) + '</p>' : '');

    if (isM) {
      var depth = i.layer === 'Superficial' ? 'Superficial. It lies directly under the skin.' :
        i.layer === 'Partly covered' ? 'Partly covered. About ' + i.covered + '% of its outer surface lies under other structures.' :
        'Deep. About ' + i.covered + '% of its outer surface lies under other structures.';
      var src = (viewer && viewer.source) || {};

      html += field('Where it is', i.loc) +
        field(i.sys === 'tendon' ? 'What it does' : 'Main actions', i.act) +
        (i.ex ? field('Everyday example', i.ex) : '') +
        '<div class="depth"><p class="lab">Depth in this model</p><p class="txt">' + esc(depth + (by.length ? ' Lies under:' : '')) + '</p>' +
          (by.length ?
            '<div class="by">' + by.map(function (b) {
              return '<button class="lnk" data-act="pickBy" data-arg="' + esc(b.id) + '">' + esc(b.name + sideLower(b.side)) + '</button>';
            }).join('') + '</div>' +
            '<button class="act" data-act="hideOver">Hide what lies over it</button>' : '') +
        '</div>' +
        (i.origin || i.insertion || i.nerve ?
          '<details><summary>Anatomy details</summary><div class="details-body">' +
            field('Origin', i.origin || 'Not applicable', true) +
            field('Insertion', i.insertion || 'Not applicable', true) +
            field('Nerve supply', i.nerve || 'Not applicable', true) +
          '</div></details>' : '') +
        (i.tip ? field('Memory tip', i.tip) : '') +
        '<p class="ver">' + esc(VER[i.ver] || VER.N) + ' <a href="' + esc(src.u || '#') + '" target="_blank" rel="noopener">' + esc(src.t || 'Reference') + '</a></p>';
    }
    setHTML($('info'), html);
  }

  function renderList() {
    var lm = listMode(), noun = lm === 'skeleton' ? 'bones' : 'muscles and tendons';
    var cat = catalog(lm);
    var q = state.query.trim().toLowerCase();
    var selId = state.sel ? state.sel.id : '';
    var G = (viewer && viewer.groups) || {};
    var shown = 0;

    var html = Object.keys(G).map(function (k) {
      var all = cat.filter(function (e) { return e.g === k; });
      var rows = q ? all.filter(function (e) { return e.name.toLowerCase().indexOf(q) !== -1; }) : all;
      if (q && rows.length === 0) return '';
      var open = q ? true : !!state.open[lm + k];
      if (q) shown += rows.length;
      var out = '<button class="ghead" aria-expanded="' + open + '" data-act="toggleGroup" data-arg="' + k + '"><span>' + esc(G[k]) + '</span><span class="ct">' + (q ? rows.length + ' of ' + all.length : all.length) + '</span></button>';
      if (open) {
        out += rows.map(function (e) {
          return '<div class="row"><span class="nm">' + esc(e.name) + '<span class="ly">' + esc(e.layer) + '</span></span>' +
            e.ids.map(function (x) {
              var on = x.id === selId, off = viewer && viewer.isHidden(x.id);
              var label = x.side === 'Left' ? 'L' : x.side === 'Right' ? 'R' : 'Select';
              return '<button class="sd' + (on ? ' on' : '') + (off ? ' off' : '') + '" aria-label="' + esc((x.side ? x.side + ' ' : '') + e.name) + '" aria-pressed="' + on + '" data-act="pickRow" data-arg="' + esc(x.id) + '">' + label + '</button>';
            }).join('') +
          '</div>';
        }).join('');
      }
      return out;
    }).join('');

    if (q && shown === 0) html += '<p class="empty">Nothing matches that search.</p>';
    setHTML($('groups'), html);

    setText($('browseLabel'), lm === 'skeleton' ? 'Browse bones' : 'Browse muscles');
    setText($('count'), q ? shown + ' matching ' + noun : cat.length + ' ' + noun + ' in six regions. L and R are the model’s left and right.');
  }

  function render() {
    renderModes();
    renderStage();
    renderToggle();
    renderInfo();
    renderList();
  }

  // ---------- Actions ----------
  var actions = {
    mode: function (id) { if (viewer) viewer.setMode(id); setState({ mode: id, hover: '' }); },
    view: function (id) { if (!viewer) return; if (id === 'reset') viewer.reset(); else if (id === 'fit') viewer.fit(); else viewer.view(id); },
    zoomIn: function () { if (viewer) viewer.zoom(0.8); },
    zoomOut: function () { if (viewer) viewer.zoom(1.25); },
    focus: function () { if (viewer && state.sel) viewer.focus(state.sel.id); },
    isolate: function () { if (viewer && state.sel) viewer.isolate(state.sel.id); },
    hide: function () {
      if (!viewer || !state.sel) return;
      if (state.sel.hidden) viewer.show(state.sel.id); else viewer.hide(state.sel.id);
    },
    showAll: function () { if (viewer) viewer.showAll(); },
    hideOver: function () { if (viewer && state.sel) viewer.hide((state.sel.by || []).map(function (b) { return b.id; })); },
    pickBy: function (id) { if (viewer) viewer.select(id); },
    toggleGroup: function (k) {
      var o = Object.assign({}, state.open), key = listMode() + k;
      o[key] = !o[key];
      setState({ open: o });
    },
    pickRow: function (id) {
      if (!viewer) return;
      var lm = listMode();
      if (state.mode !== lm) { viewer.setMode(lm); setState({ mode: lm }); }
      viewer.select(id);
      viewer.focus(id);
    }
  };

  document.addEventListener('click', function (e) {
    var btn = e.target.closest('[data-act]');
    if (!btn || btn.disabled) return;
    var fn = actions[btn.getAttribute('data-act')];
    if (fn) fn(btn.getAttribute('data-arg'));
  });

  $('ptoggle').addEventListener('click', function () { setState({ panelOpen: !state.panelOpen }); });
  $('sideToggle').addEventListener('click', function () { setState({ panelOpen: !state.panelOpen }); });
  $('q').addEventListener('input', function (e) { setState({ query: e.target.value }); });
  $('ov').addEventListener('input', function (e) {
    var a = parseFloat(e.target.value) || 0;
    if (viewer) viewer.setOverlay(a / 100);
    setState({ overlay: a });
  });

  // ---------- Boot ----------
  function boot() {
    if (!window.AnatViewer || !window.THREE || !window.ANAT_PACK || !window.ANAT_INFO) {
      setState({ failed: true });
      return;
    }
    // Let the loading message paint before the heavy mesh decode.
    setTimeout(function () {
      try {
        viewer = window.AnatViewer.create($('anat'), {
          onSelect: function (info) { setState({ sel: info }); },
          onHover: function (info) { setState({ hover: info ? info.name + sideLower(info.side) : '' }); },
          onState: function (st) { setState({ hidden: st.hidden }); }
        });
        viewer.setMode(state.mode);
        window.__anatViewer = viewer;
        setState({ ready: true });
      } catch (err) {
        console.error(err);
        setState({ failed: true });
      }
    }, 30);
  }

  renderViews();
  render();
  boot();
})();
