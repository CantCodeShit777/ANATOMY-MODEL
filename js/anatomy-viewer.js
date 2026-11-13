/* Anatomy viewer: decodes the packed BodyParts3D meshes (ANAT_PACK), reads study data (ANAT_INFO),
   and handles orbit / zoom / pan, picking, hide / isolate, preset views and the skin overlay. */
window.AnatViewer = (function () {
  var T = window.THREE;
  var GROUPS = { H: 'Head and neck', T: 'Torso', S: 'Shoulder and arm', F: 'Forearm and hand', P: 'Hip and thigh', L: 'Lower leg and foot' };

  function decode(pack) {
    var bin = atob(pack.b64), n = bin.length, u8 = new Uint8Array(n);
    for (var i = 0; i < n; i++) u8[i] = bin.charCodeAt(i);
    return u8.buffer;
  }
  function pad4(n) { return n + (4 - n % 4) % 4; }
  /* Smooth proportion warp applied to EVERY mesh (skin, cloth, muscles, bones), so the
     layers stay aligned: broader shoulders and chest, narrower waist. */
  function warp(pos, n) {
    function g(y, c, w) { var t = (y - c) / w; return Math.exp(-t * t); }
    for (var i = 0; i < n; i++) {
      var y = pos[i * 3 + 1];
      var sx = 1 + 0.055 * g(y, 1.33, 0.11) - 0.05 * g(y, 1.03, 0.10);
      var sz = 1 + 0.028 * g(y, 1.30, 0.10) - 0.045 * g(y, 1.03, 0.10);
      pos[i * 3] *= sx;
      pos[i * 3 + 2] *= sz;
    }
  }
  function geoFor(m, buf) {
    var q = new Uint16Array(buf, m.o, m.nv * 3), pos = new Float32Array(m.nv * 3), i;
    for (i = 0; i < m.nv; i++) {
      pos[i * 3] = m.mn[0] + q[i * 3] / 65535 * m.ex[0];
      pos[i * 3 + 1] = m.mn[1] + q[i * 3 + 1] / 65535 * m.ex[1];
      pos[i * 3 + 2] = m.mn[2] + q[i * 3 + 2] / 65535 * m.ex[2];
    }
    warp(pos, m.nv);
    var o = m.o + pad4(m.nv * 6);
    var idx = m.i32 ? new Uint32Array(buf, o, m.nf * 3) : new Uint16Array(buf, o, m.nf * 3);
    o += pad4(m.nf * 3 * (m.i32 ? 4 : 2));
    var g = new T.BufferGeometry();
    g.setAttribute('position', new T.BufferAttribute(pos, 3));
    g.setIndex(new T.BufferAttribute(idx, 1));
    if (m.c) { g.setAttribute('color', new T.BufferAttribute(new Uint8Array(buf, o, m.nv * 3), 3, true)); o += pad4(m.nv * 3); }
    if (m.nm) {
      var n8 = new Int8Array(buf, o, m.nv * 3), nr = new Float32Array(m.nv * 3);
      for (i = 0; i < m.nv * 3; i++) nr[i] = n8[i] / 127;
      g.setAttribute('normal', new T.BufferAttribute(nr, 3));
    } else g.computeVertexNormals();
    g.computeBoundingSphere(); g.computeBoundingBox();
    return g;
  }
  /* fine procedural skin grain: a tiny bump on the shading normal, faded out with distance */
  function skinGrain(mat) {
    mat.onBeforeCompile = function (sh) {
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vObjP;').replace('#include <begin_vertex>', '#include <begin_vertex>\nvObjP = position;');
      sh.fragmentShader = sh.fragmentShader.replace('#include <common>', [
        '#include <common>', 'varying vec3 vObjP;',
        'float aHash(vec3 p){ p = fract(p * 0.3183099 + vec3(0.71, 0.113, 0.419)); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }',
        'float aNoise(vec3 x){ vec3 i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f);',
        '  return mix(mix(mix(aHash(i), aHash(i + vec3(1,0,0)), f.x), mix(aHash(i + vec3(0,1,0)), aHash(i + vec3(1,1,0)), f.x), f.y),',
        '             mix(mix(aHash(i + vec3(0,0,1)), aHash(i + vec3(1,0,1)), f.x), mix(aHash(i + vec3(0,1,1)), aHash(i + vec3(1,1,1)), f.x), f.y), f.z); }'
      ].join('\n')).replace('#include <normal_fragment_maps>', [
        '#include <normal_fragment_maps>',
        '{ vec3 gq = vObjP * 900.0;',
        '  float gh = aNoise(gq) * 0.65 + aNoise(gq * 2.7) * 0.35;',
        '  float gfw = max(length(dFdx(vObjP)), length(dFdy(vObjP))) * 900.0;',
        '  float gfade = 1.0 - smoothstep(0.2, 0.75, gfw);',
        '  vec2 gd = vec2(dFdx(gh), dFdy(gh)) * gfade * 0.00022;',
        '  vec3 gsx = dFdx(-vViewPosition), gsy = dFdy(-vViewPosition);',
        '  vec3 gr1 = cross(gsy, normal), gr2 = cross(normal, gsx);',
        '  float gdet = dot(gsx, gr1);',
        '  normal = normalize(abs(gdet) * normal - sign(gdet) * (gd.x * gr1 + gd.y * gr2)); }'
      ].join('\n'));
    };
  }
  /* Repair a crumpled patch of a mesh: weld clone vertices by position, then run a
     weighted Laplacian smooth inside a sphere and push the patch slightly outward (+z). */
  function smoothPatch(g, c, R, iters, push) {
    var pa = g.getAttribute('position'), p = pa.array, nv = pa.count, idx = g.getIndex().array;
    var w = new Float32Array(nv), any = false, i, j;
    for (i = 0; i < nv; i++) {
      var dx = p[i * 3] - c.x, dy = p[i * 3 + 1] - c.y, dz = p[i * 3 + 2] - c.z;
      var d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (d < R) { w[i] = 0.5 * (1 + Math.cos(Math.PI * d / R)); any = true; }
    }
    if (!any) return;
    var rep = new Int32Array(nv), byKey = {};
    for (i = 0; i < nv; i++) {
      var k = Math.round(p[i * 3] * 2e4) + ',' + Math.round(p[i * 3 + 1] * 2e4) + ',' + Math.round(p[i * 3 + 2] * 2e4);
      rep[i] = (k in byKey) ? byKey[k] : (byKey[k] = i);
    }
    var adj = {};
    for (var f = 0; f < idx.length; f += 3) {
      var a = rep[idx[f]], b = rep[idx[f + 1]], cc = rep[idx[f + 2]];
      if (w[a] || w[b] || w[cc]) {
        (adj[a] = adj[a] || []).push(b, cc);
        (adj[b] = adj[b] || []).push(a, cc);
        (adj[cc] = adj[cc] || []).push(a, b);
      }
    }
    var tmp = new Float32Array(p.length);
    for (var it = 0; it < iters; it++) {
      tmp.set(p);
      for (var rs in adj) {
        i = +rs;
        if (!w[i]) continue;
        var ax = 0, ay = 0, az = 0, ns = adj[i], nn = ns.length;
        for (j = 0; j < nn; j++) { var v = ns[j]; ax += tmp[v * 3]; ay += tmp[v * 3 + 1]; az += tmp[v * 3 + 2]; }
        var kk = 0.6 * w[i];
        p[i * 3] += (ax / nn - p[i * 3]) * kk;
        p[i * 3 + 1] += (ay / nn - p[i * 3 + 1]) * kk;
        p[i * 3 + 2] += (az / nn - p[i * 3 + 2]) * kk;
      }
    }
    for (i = 0; i < nv; i++) {
      var r = rep[i];
      if (r !== i) { p[i * 3] = p[r * 3]; p[i * 3 + 1] = p[r * 3 + 1]; p[i * 3 + 2] = p[r * 3 + 2]; }
      if (push && w[r]) p[i * 3 + 2] += push * w[r];
    }
    g.computeVertexNormals(); g.computeBoundingSphere(); g.computeBoundingBox();
  }
  /* Soften a vertex-color attribute: pull toward luminance (less orange) and cool slightly. */
  function gradeSkinColors(g) {
    var a = g.getAttribute('color'); if (!a) return;
    var src = a.array, out = new Uint8Array(src.length);
    for (var i = 0; i < src.length; i += 3) {
      var r = src[i], gr = src[i + 1], b = src[i + 2];
      var l = 0.299 * r + 0.587 * gr + 0.114 * b;
      out[i] = Math.min(255, (r + (l - r) * 0.10) * 1.0);
      out[i + 1] = Math.min(255, (gr + (l - gr) * 0.10) * 1.005);
      out[i + 2] = Math.min(255, (b + (l - b) * 0.10) * 1.05);
    }
    g.setAttribute('color', new T.BufferAttribute(out, 3, true));
  }
  function floorLetter(ch) {
    var c = document.createElement('canvas'); c.width = c.height = 128;
    var x = c.getContext('2d'); x.fillStyle = 'rgba(208,216,226,0.45)'; x.font = '600 92px system-ui, sans-serif'; x.textAlign = 'center'; x.textBaseline = 'middle'; x.fillText(ch, 64, 70);
    var m = new T.Mesh(new T.PlaneGeometry(0.13, 0.13), new T.MeshBasicMaterial({ map: new T.CanvasTexture(c), transparent: true, depthWrite: false }));
    m.rotation.x = -Math.PI / 2; return m;
  }

  function create(canvas, cb) {
    cb = cb || {};
    var pack = window.ANAT_PACK, INFO = window.ANAT_INFO || { cards: {}, bones: {}, st: {}, src: {} }, buf = decode(pack);
    var renderer = new T.WebGLRenderer({ canvas: canvas, antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    var scene = new T.Scene();
    var camera = new T.PerspectiveCamera(30, 1, 0.02, 40);
    /* Studio lighting for the dark backdrop: soft warm key, cool fill, gentle edge light. */
    scene.add(new T.HemisphereLight(0xf3f0ea, 0x3d3c3b, 0.7));
    var key = new T.DirectionalLight(0xffe9d2, 0.6); scene.add(key); scene.add(key.target);
    var rim = new T.DirectionalLight(0xcfdff2, 0.5); scene.add(rim); scene.add(rim.target);
    var fill = new T.DirectionalLight(0xf3f5f8, 0.24); scene.add(fill); scene.add(fill.target);

    var root = new T.Group(); scene.add(root);
    /* Grounding shadow: a radial fade, not a hard-edged disc. */
    var shC = document.createElement('canvas'); shC.width = shC.height = 256;
    var shX = shC.getContext('2d');
    var shG = shX.createRadialGradient(128, 128, 10, 128, 128, 128);
    shG.addColorStop(0, 'rgba(0,0,0,0.5)'); shG.addColorStop(0.55, 'rgba(0,0,0,0.26)'); shG.addColorStop(1, 'rgba(0,0,0,0)');
    shX.fillStyle = shG; shX.fillRect(0, 0, 256, 256);
    var floor = new T.Mesh(new T.PlaneGeometry(1.3, 1.3), new T.MeshBasicMaterial({ map: new T.CanvasTexture(shC), transparent: true, depthWrite: false }));
    floor.rotation.x = -Math.PI / 2; floor.position.y = -0.012; scene.add(floor);
    var fl = floorLetter('L'), fr = floorLetter('R'); fl.position.set(0.4, -0.01, 0.2); fr.position.set(-0.4, -0.01, 0.2); scene.add(fl); scene.add(fr);

    var skinGroup = new T.Group(), boneGroup = new T.Group(), muscGroup = new T.Group(), ghostGroup = new T.Group();
    root.add(boneGroup); root.add(muscGroup); root.add(skinGroup); root.add(ghostGroup);
    var skinMat = new T.MeshStandardMaterial({ color: 0xffffff, roughness: 0.8, metalness: 0, vertexColors: true }); skinGrain(skinMat);
    var ghostMat = new T.MeshStandardMaterial({ color: 0xffffff, roughness: 0.8, metalness: 0, vertexColors: true, transparent: true, opacity: 0.35, depthWrite: false, depthFunc: T.LessEqualDepth });
    var depthMat = new T.MeshBasicMaterial({ colorWrite: false, transparent: true });
    var structs = {}, order = [];
    var BONE = 0xdfd0a6, CART = 0xb9c6c9, TOOTH = 0xf1ece0, TEND = 0xe4d9c6;
    var GOLD = new T.Color(0xf6b63a), WARM = new T.Color(0xffd7a8);
    pack.meta.forEach(function (m) {
      var g = geoFor(m, buf), mat, mesh;
      if (m.k === 'bone' || m.k === 'muscle' || m.k === 'tendon') {
        var col;
        if (m.k === 'bone') col = /cartilage|discs/i.test(m.n) ? CART : /teeth/i.test(m.n) ? TOOTH : BONE;
        else if (m.k === 'tendon') col = TEND;
        else { var c = new T.Color(0xa63a2e), h = 0; for (var i = 0; i < m.n.length; i++) h = (h * 31 + m.n.charCodeAt(i)) % 97; c.offsetHSL((h - 48) / 3200, 0, (h % 9 - 4) / 150); col = c.getHex(); }
        mat = new T.MeshStandardMaterial({ color: col, roughness: m.k === 'muscle' ? 0.5 : 0.62, metalness: 0 });
        mesh = new T.Mesh(g, mat); mesh.userData.sid = m.id;
        (m.k === 'bone' ? boneGroup : muscGroup).add(mesh);
        var st = INFO.st[m.id] || [0, [], null], card = INFO.cards[m.n], bn = INFO.bones[m.n];
        structs[m.id] = { id: m.id, name: m.n, side: m.s, sys: m.k, mesh: mesh, mat: mat, base: new T.Color(col), cv: st[0], by: st[1],
          g: m.k === 'bone' ? (bn ? bn[0] : 'T') : (card ? card[0] : 'T') };
        order.push(m.id);
      } else if (m.k === 'skin' || m.k === 'ear') {
        gradeSkinColors(g);
        skinGroup.add(new T.Mesh(g, skinMat));
        var d = new T.Mesh(g, depthMat); d.renderOrder = 1; ghostGroup.add(d);
        var gh = new T.Mesh(g, ghostMat); gh.renderOrder = 2; ghostGroup.add(gh);
      } else {
        if (m.id === 'locks') {
          /* Tame the sculpted hair: trim only the outer puff (radius beyond the scalp)
             and lift the lowest neck locks, keeping the fringe on the hairline. */
          var hp = g.getAttribute('position').array, hcx = 0, hcz = -0.01, r0 = 0.08, sk = 0.72;
          for (var hi = 0; hi < m.nv; hi++) {
            var hx = hp[hi * 3] - hcx, hz = hp[hi * 3 + 2] - hcz;
            var hr = Math.sqrt(hx * hx + hz * hz);
            if (hr > r0) {
              var nr = r0 + (hr - r0) * sk;
              hp[hi * 3] = hcx + hx / hr * nr;
              hp[hi * 3 + 2] = hcz + hz / hr * nr;
            }
            var hy = hp[hi * 3 + 1];
            if (hy < 1.46) hp[hi * 3 + 1] = 1.46 + (hy - 1.46) * 0.9;
          }
          g.computeVertexNormals(); g.computeBoundingSphere(); g.computeBoundingBox();
        }
        if (m.id === 'shorts') smoothPatch(g, { x: 0, y: 0.715, z: 0.04 }, 0.09, 22, 0.007);
        mat = new T.MeshStandardMaterial({
          color: m.c ? 0xffffff : (m.k === 'brow' ? 0x33261e : m.k === 'hair' ? 0x1b1512 : 0x141112),
          roughness: m.k === 'eye' ? 0.22 : m.k === 'hair' ? 0.74 : m.k === 'cloth' ? 0.94 : 0.9,
          metalness: 0, vertexColors: !!m.c,
          side: m.k === 'cloth' ? T.DoubleSide : T.FrontSide
        });
        skinGroup.add(new T.Mesh(g, mat));
      }
    });
    order.sort(function (a, b) { var A = structs[a], B = structs[b]; return A.name === B.name ? (A.side < B.side ? -1 : 1) : A.name.localeCompare(B.name, 'en', { numeric: true }); });

    var mode = 'skin', selected = null, hovered = null, dirty = true, hidden = {}, isolated = null, overlay = 0;
    var HOME = { az: 0.3, pol: 1.48, dist: 3.55, y: 0.83 };
    var az = HOME.az, pol = HOME.pol, dist = HOME.dist, target = new T.Vector3(0, HOME.y, 0);
    var goal = null, azGoal = null, polGoal = null;
    var RM = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    /* With reduced motion on, preset camera moves land instantly instead of animating. */
    function snapIfRM() {
      if (!RM) return;
      if (goal) { target.copy(goal.target); dist = goal.dist; goal = null; }
      if (azGoal !== null) { az = azGoal; azGoal = null; }
      if (polGoal !== null) { pol = polGoal; polGoal = null; }
      dirty = true;
    }
    /* Distance at which the whole body fits the current viewport, with headroom. */
    function fitDist() {
      var asp = camera.aspect || 1, t = Math.tan(camera.fov * Math.PI / 360);
      return Math.min(6, Math.max(0.92 / t, 0.60 / (t * asp)) + 0.22);
    }

    function inMode(s) { return mode === 'skeleton' ? s.sys === 'bone' : mode === 'muscle' ? s.sys !== 'bone' : false; }
    function pickable(s) { return inMode(s) && !hidden[s.id]; }
    function layerOf(s) { return s.sys === 'bone' ? '' : s.cv < 0.3 ? 'Superficial' : s.cv < 0.7 ? 'Partly covered' : 'Deep'; }
    function refresh() {
      order.forEach(function (id) {
        var s = structs[id], on = id === selected, hv = id === hovered && !on;
        s.mat.color.copy(s.base);
        if (on) s.mat.color.lerp(GOLD, 0.82); else if (hv) s.mat.color.lerp(WARM, 0.45);
        s.mat.emissive.setHex(on ? 0x2e1c00 : hv ? 0x1a1108 : 0x000000);
        s.mesh.visible = !hidden[id];
      });
      dirty = true;
    }
    function state() { if (cb.onState) cb.onState({ hidden: Object.keys(hidden).length, isolated: isolated, selected: selected, selectedHidden: !!(selected && hidden[selected]) }); }
    function applyMode() {
      skinGroup.visible = mode === 'skin';
      muscGroup.visible = mode === 'muscle';
      boneGroup.visible = mode !== 'skin';
      ghostGroup.visible = mode !== 'skin' && overlay > 0.01;
      hovered = null; refresh();
    }
    function ref(id) { var s = structs[id]; return s ? { id: id, name: s.name, side: s.side, sys: s.sys } : null; }
    function info(id) {
      var s = structs[id]; if (!s) return null;
      var o = { id: id, name: s.name, side: s.side, sys: s.sys, group: GROUPS[s.g] || '', layer: layerOf(s), hidden: !!hidden[id] };
      if (s.sys === 'bone') { var b = INFO.bones[s.name] || ['', '', '']; o.region = b[1]; o.intro = b[2]; return o; }
      var c = INFO.cards[s.name] || [];
      o.intro = c[1] || ''; o.loc = c[2] || ''; o.act = c[3] || ''; o.ex = c[4] || ''; o.origin = c[5] || ''; o.insertion = c[6] || ''; o.nerve = c[7] || ''; o.tip = c[8] || ''; o.ver = c[9] || 'N';
      o.covered = Math.round(s.cv * 100);
      o.by = (s.by || []).map(ref).filter(Boolean);
      return o;
    }
    function emitSelect() { if (cb.onSelect) cb.onSelect(selected ? info(selected) : null); state(); }
    function select(id) {
      if (id && !structs[id]) id = null;
      selected = id; refresh(); emitSelect();
    }
    function focus(id) {
      id = id || selected; var s = structs[id]; if (!s) return;
      var b = s.mesh.geometry.boundingBox, c = b.getCenter(new T.Vector3()), sz = b.getSize(new T.Vector3());
      goal = { target: c, dist: Math.max(0.42, Math.min(2.4, sz.length() * 2.3 + 0.28)) };
      var st = (window.ANAT_INFO && window.ANAT_INFO.st[id]) || [], want = st[2];
      if (want === null || want === undefined) want = Math.abs(c.x) > 0.03 || Math.abs(c.z) > 0.03 ? Math.atan2(c.x, c.z) : az;
      azGoal = az + Math.atan2(Math.sin(want - az), Math.cos(want - az)); polGoal = 1.45; dirty = true;
      snapIfRM();
    }
    function hide(ids) {
      (Array.isArray(ids) ? ids : [ids]).forEach(function (id) { if (structs[id]) hidden[id] = 1; });
      isolated = null; if (hovered && hidden[hovered]) hovered = null; refresh(); emitSelect();
    }
    function isolate(id) {
      id = id || selected; var s = structs[id]; if (!s) return;
      var bone = s.sys === 'bone';
      order.forEach(function (o) { var t = structs[o]; if ((t.sys === 'bone') === bone) { if (o === id) delete hidden[o]; else hidden[o] = 1; } });
      isolated = id; refresh(); emitSelect();
    }
    function show(ids) { (Array.isArray(ids) ? ids : [ids]).forEach(function (id) { delete hidden[id]; }); isolated = null; refresh(); emitSelect(); }
    function showAll() { hidden = {}; isolated = null; refresh(); emitSelect(); }
    function list() {
      return order.filter(function (id) { return inMode(structs[id]); }).map(function (id) { var s = structs[id]; return { id: id, name: s.name, side: s.side, g: s.g, layer: layerOf(s), hidden: !!hidden[id] }; });
    }
    function zoom(f) { dist = Math.min(6, Math.max(0.25, dist * f)); goal = null; dirty = true; }
    function turnTo(a, p) { azGoal = az + Math.atan2(Math.sin(a - az), Math.cos(a - az)); polGoal = p; dirty = true; }
    function view(name) {
      var a = { front: 0, back: Math.PI, left: Math.PI / 2, right: -Math.PI / 2 }[name];
      if (a === undefined) return;
      turnTo(a, 1.5); goal = { target: new T.Vector3(0, target.y, 0), dist: dist };
      snapIfRM();
    }
    function fit() { goal = { target: new T.Vector3(0, 0.82, 0), dist: fitDist() }; dirty = true; snapIfRM(); }
    function reset() { goal = { target: new T.Vector3(0, HOME.y, 0), dist: fitDist() }; turnTo(HOME.az, HOME.pol); snapIfRM(); }
    function setOverlay(a) { overlay = Math.max(0, Math.min(0.9, a)); ghostMat.opacity = overlay; ghostGroup.visible = mode !== 'skin' && overlay > 0.01; dirty = true; }

    function updateCam() {
      camera.position.set(target.x + dist * Math.sin(pol) * Math.sin(az), target.y + dist * Math.cos(pol), target.z + dist * Math.sin(pol) * Math.cos(az));
      camera.lookAt(target); camera.updateMatrixWorld();
      key.position.set(0.9, 1.5, 1.7).applyQuaternion(camera.quaternion).add(target);
      fill.position.set(-1.7, 0.3, 1.2).applyQuaternion(camera.quaternion).add(target);
      rim.position.set(-1.2, 1.0, -2.0).applyQuaternion(camera.quaternion).add(target);
      key.target.position.copy(target); fill.target.position.copy(target); rim.target.position.copy(target);
    }
    function resize() {
      var w = canvas.clientWidth || 600, h = canvas.clientHeight || 600;
      renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix(); dirty = true;
    }

    var ptrs = {}, downAt = null, moved = 0, panning = false, hoverEv = null;
    var ray = new T.Raycaster(), mouse = new T.Vector2();
    function pickAt(ev) {
      if (mode === 'skin') return null;
      var r = canvas.getBoundingClientRect();
      mouse.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
      ray.setFromCamera(mouse, camera);
      var objs = (mode === 'skeleton' ? boneGroup.children : boneGroup.children.concat(muscGroup.children)).filter(function (o) { return o.visible; });
      var hits = ray.intersectObjects(objs, false);
      if (!hits.length) return null;
      var id = hits[0].object.userData.sid;
      return pickable(structs[id]) ? id : null;
    }
    function panBy(dx, dy) {
      var k = dist * 0.0013, right = new T.Vector3(), up = new T.Vector3();
      camera.matrixWorld.extractBasis(right, up, new T.Vector3());
      target.addScaledVector(right, -dx * k).addScaledVector(up, dy * k);
      target.y = Math.min(1.75, Math.max(0, target.y)); target.x = Math.max(-0.6, Math.min(0.6, target.x)); target.z = Math.max(-0.6, Math.min(0.6, target.z));
    }
    function onDown(e) {
      if (canvas.setPointerCapture) { try { canvas.setPointerCapture(e.pointerId); } catch (err) {} }
      ptrs[e.pointerId] = { x: e.clientX, y: e.clientY };
      if (Object.keys(ptrs).length === 1) { downAt = { x: e.clientX, y: e.clientY }; moved = 0; panning = e.button === 2 || e.shiftKey; }
      goal = null; azGoal = null; polGoal = null; dirty = true;
    }
    function onMove(e) {
      var p = ptrs[e.pointerId];
      if (!p) { if (e.pointerType !== 'touch') hoverEv = { clientX: e.clientX, clientY: e.clientY }; return; }
      var dx = e.clientX - p.x, dy = e.clientY - p.y, keys = Object.keys(ptrs);
      if (keys.length === 2) {
        var o = ptrs[keys[0] == e.pointerId ? keys[1] : keys[0]];
        var d0 = Math.hypot(p.x - o.x, p.y - o.y), d1 = Math.hypot(e.clientX - o.x, e.clientY - o.y);
        if (d0 > 0 && d1 > 0) dist = Math.min(6, Math.max(0.25, dist * d0 / d1));
        panBy(dx / 2, dy / 2);
      } else if (panning) panBy(dx, dy);
      else { az -= dx * 0.008; pol = Math.min(Math.PI - 0.12, Math.max(0.12, pol - dy * 0.006)); }
      moved += Math.abs(dx) + Math.abs(dy);
      p.x = e.clientX; p.y = e.clientY; dirty = true;
    }
    function onUp(e) {
      var had = ptrs[e.pointerId]; delete ptrs[e.pointerId];
      if (had && Object.keys(ptrs).length === 0 && downAt && moved < 6 && mode !== 'skin') { var id = pickAt(e); select(id === selected ? null : id); }
    }
    function onLeave() { hoverEv = null; if (hovered) { hovered = null; refresh(); if (cb.onHover) cb.onHover(null); } }
    function onWheel(e) { e.preventDefault(); zoom(Math.exp(e.deltaY * 0.0012)); }
    function noMenu(e) { e.preventDefault(); }
    canvas.addEventListener('pointerdown', onDown); canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerup', onUp); canvas.addEventListener('pointercancel', onUp); canvas.addEventListener('pointerleave', onLeave);
    canvas.addEventListener('wheel', onWheel, { passive: false }); canvas.addEventListener('contextmenu', noMenu);
    canvas.style.cursor = 'grab'; canvas.style.touchAction = 'none';
    var ro = window.ResizeObserver ? new ResizeObserver(resize) : null; if (ro) ro.observe(canvas);
    window.addEventListener('resize', resize);

    var raf = 0, alive = true, last = performance.now();
    function loop() {
      if (!alive) return;
      raf = requestAnimationFrame(loop);
      var now = performance.now(), k = 1 - Math.exp(-Math.min(0.1, (now - last) / 1000) * 7); last = now;
      if (goal) {
        target.lerp(goal.target, k); dist += (goal.dist - dist) * k;
        if (target.distanceTo(goal.target) < 0.002 && Math.abs(goal.dist - dist) < 0.002) goal = null;
        dirty = true;
      }
      if (azGoal !== null) { az += (azGoal - az) * k; if (Math.abs(azGoal - az) < 0.003) { az = azGoal; azGoal = null; } dirty = true; }
      if (polGoal !== null) { pol += (polGoal - pol) * k; if (Math.abs(polGoal - pol) < 0.003) { pol = polGoal; polGoal = null; } dirty = true; }
      if (hoverEv) {
        var id = pickAt(hoverEv); hoverEv = null;
        if (id !== hovered) { hovered = id; canvas.style.cursor = id ? 'pointer' : 'grab'; refresh(); if (cb.onHover) cb.onHover(id ? info(id) : null); }
      }
      if (dirty) { dirty = false; updateCam(); renderer.render(scene, camera); }
    }
    resize(); dist = fitDist(); applyMode(); loop();

    return {
      groups: GROUPS, source: INFO.src,
      setMode: function (m) { mode = m; applyMode(); state(); }, getMode: function () { return mode; },
      select: select, focus: focus, info: info, list: list, getSelected: function () { return selected; },
      hide: hide, show: show, isolate: isolate, showAll: showAll, isHidden: function (id) { return !!hidden[id]; },
      view: view, zoom: zoom, fit: fit, reset: reset, resize: resize, setOverlay: setOverlay,
      camera: function () { return { az: az, pol: pol, dist: dist, y: target.y }; },
      setView: function (a, p, d, y) { az = a; pol = p; dist = d; if (y !== undefined) target.set(0, y, 0); goal = null; azGoal = null; polGoal = null; dirty = true; },
      screenOf: function (id) { var s = structs[id]; if (!s) return null; var c = s.mesh.geometry.boundingBox.getCenter(new T.Vector3()).project(camera), r = canvas.getBoundingClientRect(); return { x: r.left + (c.x + 1) / 2 * r.width, y: r.top + (1 - c.y) / 2 * r.height }; },
      pickAtClient: function (x, y) { return pickAt({ clientX: x, clientY: y }); },
      dispose: function () { alive = false; cancelAnimationFrame(raf); if (ro) ro.disconnect(); window.removeEventListener('resize', resize); renderer.dispose(); }
    };
  }
  return { create: create };
})();
