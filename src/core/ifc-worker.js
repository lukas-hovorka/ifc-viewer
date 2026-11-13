// IFC Viewer – zpracování IFC ve Web Workeru (web-ifc). Na hlavní vlákno posílá:
//   geometrie sloučená podle barvy (každý prvek má souvislý úsek indexů → skrývání, výběr, zvýraznění),
//   prvky (expressID, třída, název, GlobalId), prostorový strom, vlastnosti vybraného prvku.
// Souřadnice: web-ifc vrací metry a osu Y nahoru (IFC Z → three Y). Velké souřadnice se posunou o „počátek“
// (první model určí počátek, další modely ho sdílejí, aby na sebe seděly) – v doublech, až pak Float32.
import * as WebIFC from 'web-ifc';
import wasmUrl from 'web-ifc/web-ifc.wasm?url';

const api = new WebIFC.IfcAPI();
const ready = api.Init(() => new URL(wasmUrl, self.location.href).href, true);
const models = new Map(); // klíč modelu (z hlavního vlákna) → modelID web-ifc
const geoSets = new Map(); // klíč modelu → Set expressID prvků s geometrií (pro index hodnot)

// názvy tříd ve tvaru IfcWallStandardCase (web-ifc vrací kód typu, GetNameFromTypeCode velkými písmeny)
const CAMEL = new Map();
for (const schema of [WebIFC.IFC2X3, WebIFC.IFC4, WebIFC.IFC4X3]) {
  for (const k of Object.keys(schema || {})) if (k.startsWith('Ifc')) CAMEL.set(k.toUpperCase(), k);
}
const className = (code) => {
  const up = api.GetNameFromTypeCode(code) || String(code);
  return CAMEL.get(up) || up;
};

// IFC řetězce: \X2\00E1\X0\ (UTF-16), \X\E1 (ISO 8859-1), \S\a (+128) – web-ifc je nechává zakódované
function decodeIfc(s) {
  if (typeof s !== 'string' || s.indexOf('\\') < 0) return s;
  return s
    .replace(/\\X2\\((?:[0-9A-F]{4})+)\\X0\\/gi, (_, hex) => String.fromCharCode(...hex.match(/.{4}/g).map((h) => parseInt(h, 16))))
    .replace(/\\X4\\((?:[0-9A-F]{8})+)\\X0\\/gi, (_, hex) => String.fromCodePoint(...hex.match(/.{8}/g).map((h) => parseInt(h, 16))))
    .replace(/\\X\\([0-9A-F]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\S\\(.)/g, (_, c) => String.fromCharCode(c.charCodeAt(0) + 128));
}

// texty ve vlastnostech (jazyk posílá hlavní vlákno s požadavkem)
const CS = { cls: 'Třída', attrs: 'Atributy', type: 'Typ', name: 'Název', desc: 'Popis', mats: 'Materiály', ofType: 'typ', yes: 'ano', no: 'ne' };
const EN = { cls: 'Class', attrs: 'Attributes', type: 'Type', name: 'Name', desc: 'Description', mats: 'Materials', ofType: 'type', yes: 'yes', no: 'no' };
let L = CS;

const val = (a) => (a && typeof a === 'object' && 'value' in a ? a.value : a);
const text = (a) => { const v = val(a); return v == null ? '' : decodeIfc(String(v)); };

self.onmessage = async (e) => {
  const m = e.data;
  try {
    await ready;
    if (m.type === 'open') await open(m);
    else if (m.type === 'props') { L = m.lang === 'en' ? EN : CS; self.postMessage({ type: 'props', req: m.req, data: props(models.get(m.key), m.expressID) }); }
    else if (m.type === 'facets') {
      L = m.lang === 'en' ? EN : CS;
      const dims = facets(models.get(m.key), geoSets.get(m.key) || new Set());
      self.postMessage({ type: 'facets', req: m.req, data: dims }, dims.flatMap((d) => d.values.map((v) => v[1].buffer)));
    }
    else if (m.type === 'close') { const id = models.get(m.key); if (id != null) api.CloseModel(id); models.delete(m.key); geoSets.delete(m.key); }
  } catch (err) {
    self.postMessage({ type: 'error', key: m.key, req: m.req, message: String(err?.message || err) });
  }
};

async function open({ key, buffer, origin }) {
  const bytes = new Uint8Array(buffer);
  const uncut = limitVoids(bytes);
  const id = api.OpenModel(bytes, { COORDINATE_TO_ORIGIN: false, CIRCLE_SEGMENTS: 12 });
  if (id < 0) throw new Error('OpenModel');
  models.set(key, id);
  const schema = api.GetModelSchema(id);

  // ---- geometrie ----
  const groups = new Map(); // barva → {color, parts: [{id, pos: Float64Array, nrm: Float32Array, idx: Uint32Array}], nv, ni}
  let org = origin, lastReport = 0, meshCount = 0;
  const withGeometry = new Set();
  // color: pevná barva (otvory), jinak barva z IFC
  const addMesh = (mesh, color) => {
    const n = mesh.geometries.size();
    for (let g = 0; g < n; g++) {
      const pg = mesh.geometries.get(g);
      const geom = api.GetGeometry(id, pg.geometryExpressID);
      const v = api.GetVertexArray(geom.GetVertexData(), geom.GetVertexDataSize());
      const ix = api.GetIndexArray(geom.GetIndexData(), geom.GetIndexDataSize());
      const t = pg.flatTransformation;
      if (!org) {
        // počátek = poloha prvního prvku; malé souřadnice (do 1 km) se neposouvají
        const far = Math.abs(t[12]) > 1000 || Math.abs(t[13]) > 1000 || Math.abs(t[14]) > 1000;
        org = far ? [t[12], t[13], t[14]] : [0, 0, 0];
      }
      const nv = v.length / 6;
      const pos = new Float32Array(nv * 3), nrm = new Float32Array(nv * 3);
      for (let k = 0; k < nv; k++) {
        const x = v[k * 6], y = v[k * 6 + 1], z = v[k * 6 + 2];
        const nx = v[k * 6 + 3], ny = v[k * 6 + 4], nz = v[k * 6 + 5];
        pos[k * 3] = t[0] * x + t[4] * y + t[8] * z + t[12] - org[0];
        pos[k * 3 + 1] = t[1] * x + t[5] * y + t[9] * z + t[13] - org[1];
        pos[k * 3 + 2] = t[2] * x + t[6] * y + t[10] * z + t[14] - org[2];
        nrm[k * 3] = t[0] * nx + t[4] * ny + t[8] * nz;
        nrm[k * 3 + 1] = t[1] * nx + t[5] * ny + t[9] * nz;
        nrm[k * 3 + 2] = t[2] * nx + t[6] * ny + t[10] * nz;
      }
      const c = color || pg.color;
      const ck = `${Math.round(c.x * 255)},${Math.round(c.y * 255)},${Math.round(c.z * 255)},${Math.round(c.w * 100)}`;
      let grp = groups.get(ck);
      if (!grp) groups.set(ck, (grp = { color: [c.x, c.y, c.z, c.w], parts: [], nv: 0, ni: 0 }));
      grp.parts.push({ id: mesh.expressID, pos, nrm, idx: ix.slice() });
      grp.nv += nv; grp.ni += ix.length;
      geom.delete?.();
    }
    withGeometry.add(mesh.expressID);
  };
  api.StreamAllMeshes(id, (mesh, i, total) => {
    addMesh(mesh);
    meshCount++;
    const now = performance.now();
    if (now - lastReport > 150) { lastReport = now; self.postMessage({ type: 'progress', key, done: i + 1, total }); }
    mesh.delete?.(); // ve streamu spravuje paměť web-ifc (funkce nemusí existovat)
  });
  // otvory (IfcOpeningElement – StreamAllMeshes je vynechává): průhledná tělesa, ve výchozím stavu skrytá filtrem tříd
  const openings = (() => { const v = api.GetLineIDsWithType(id, WebIFC.IFCOPENINGELEMENT), a = []; for (let i = 0; i < v.size(); i++) a.push(v.get(i)); return a; })();
  if (openings.length) {
    // po jednom (StreamMeshes ve verzi pro prohlížeč neodpovídá wasm – „called with 4 arguments, expected 3“)
    for (const oid of openings) {
      try { const mesh = api.GetFlatMesh(id, oid); addMesh(mesh, OPENING_COLOR); mesh.delete?.(); } catch { /* otvor bez geometrie */ }
    }
  }
  if (!org) org = origin || [0, 0, 0];

  // sloučení: prvky jednoho prvku za sebou (seřazeno podle expressID) → úseky [expressID, start, počet] v indexech
  const out = [], transfer = [];
  for (const grp of groups.values()) {
    grp.parts.sort((a, b) => a.id - b.id);
    const positions = new Float32Array(grp.nv * 3), normals = new Float32Array(grp.nv * 3);
    const index = new Uint32Array(grp.ni), vertexIds = new Uint32Array(grp.nv);
    const ranges = [];
    let vo = 0, io = 0;
    for (const p of grp.parts) {
      positions.set(p.pos, vo * 3); normals.set(p.nrm, vo * 3);
      const nv = p.pos.length / 3;
      vertexIds.fill(p.id, vo, vo + nv);
      for (let k = 0; k < p.idx.length; k++) index[io + k] = p.idx[k] + vo;
      ranges.push(p.id, io, p.idx.length); // úsek = jedno těleso (položka reprezentace) – vyřezávání otvorů je potřebuje zvlášť
      vo += nv; io += p.idx.length;
    }
    const r = new Uint32Array(ranges);
    out.push({ color: grp.color, positions, normals, index, vertexIds, ranges: r });
    transfer.push(positions.buffer, normals.buffer, index.buffer, vertexIds.buffer, r.buffer);
  }
  self.postMessage({ type: 'geometry', key, schema, origin: org, groups: out, meshes: meshCount, uncut: uncut.slice(), openings }, transfer);

  // ---- prvky a prostorový strom ----
  geoSets.set(key, withGeometry);
  self.postMessage({ type: 'meta', key, ...structure(id, withGeometry, uncut.dropped) });
}

// Prvky s mnoha otvory: web-ifc odečítá otvory jeden po druhém a čas roste zhruba s druhou mocninou počtu
// (strop se 73 otvory ~5 s, se 135 ~15 s, se 766 by to byly minuty). Vazby IfcRelVoidsElement u prvků s více než
// MAX_VOIDS otvory se proto před otevřením přepíšou mezerami → prvek se vykreslí bez vyříznutých otvorů.
// Hledá se přímo v bajtech (soubor může mít stovky MB – jako řetězec by se do paměti nevešel).
const MAX_VOIDS = 30;
const OPENING_COLOR = { x: 1, y: 0.55, z: 0.1, w: 0.35 }; // otvory: oranžové, průhledné
function limitVoids(b) {
  const PAT = [...'IFCRELVOIDSELEMENT('].map((c) => c.charCodeAt(0));
  const rels = []; // [začátek '#', konec ';', hostitel]
  const n = b.length, PL = PAT.length, V = 6; // 'V' je v datech IFC vzácné → hledá se nativním indexOf
  for (let v = b.indexOf(0x56, V); v >= 0; v = b.indexOf(0x56, v + 1)) {
    const i = v - V;
    let k = 0;
    while (k < PL && b[i + k] === PAT[k]) k++;
    if (k < PL) continue;
    // začátek entity: zpět přes '=' a mezery k '#'
    let s = i - 1;
    while (s > 0 && b[s] !== 0x23 && b[s] !== 0x3b) s--;
    if (b[s] !== 0x23) continue;
    let e = i + PL, q = false;
    for (; e < n; e++) { const c = b[e]; if (c === 0x27) q = !q; else if (c === 0x3b && !q) break; }
    // argumenty (GlobalId, OwnerHistory, Name, Description, RelatingBuildingElement, RelatedOpeningElement)
    let txt = '';
    for (let j = Math.max(i + PL, e - 200); j < e; j++) txt += String.fromCharCode(b[j]); // konec řádku – název může být dlouhý
    const m = /#(\d+)\s*,\s*#(\d+)\s*\)\s*$/.exec(txt);
    if (m) rels.push([s, e, +m[1], +m[2]]);
    v = e;
  }
  const count = new Map();
  for (const r of rels) count.set(r[2], (count.get(r[2]) || 0) + 1);
  const uncut = [];
  for (const [h, c] of count) if (c > MAX_VOIDS) uncut.push([h, c]);
  uncut.dropped = []; // [hostitel, otvor] – pro strom
  if (!uncut.length) return uncut;
  const drop = new Set(uncut.map((u) => u[0]));
  for (const [s, e, h, o] of rels) if (drop.has(h)) { b.fill(0x20, s, e + 1); uncut.dropped.push([h, o]); }
  return uncut;
}

// Strom: IfcProject → (IfcRelAggregates) Site / Building / Storey / Space … → (IfcRelContainedInSpatialStructure) prvky
// → (IfcRelAggregates) části prvků. Prvky s geometrií mimo strom → uzel „nezařazené“ (expressID 0).
function structure(id, withGeometry, dropped = []) {
  const children = new Map();
  const add = (parent, kids) => {
    if (!children.has(parent)) children.set(parent, []);
    const arr = children.get(parent);
    for (const k of kids) arr.push(k);
  };
  const ids = (vec) => { const a = []; for (let i = 0; i < vec.size(); i++) a.push(vec.get(i)); return a; };

  for (const rid of ids(api.GetLineIDsWithType(id, WebIFC.IFCRELAGGREGATES))) {
    const r = api.GetLine(id, rid, false);
    add(val(r.RelatingObject), refs(r.RelatedObjects));
  }
  for (const rid of ids(api.GetLineIDsWithType(id, WebIFC.IFCRELCONTAINEDINSPATIALSTRUCTURE))) {
    const r = api.GetLine(id, rid, false);
    add(val(r.RelatingStructure), refs(r.RelatedElements));
  }
  // otvory pod prvkem, do kterého jsou vyříznuté (i vazby odstraněné kvůli rychlosti – limitVoids)
  for (const rid of ids(api.GetLineIDsWithType(id, WebIFC.IFCRELVOIDSELEMENT))) {
    const r = api.GetLine(id, rid, false);
    add(val(r.RelatingBuildingElement), [val(r.RelatedOpeningElement)]);
  }
  for (const [h, o] of dropped) add(h, [o]);

  const classes = [], classIdx = new Map();
  const info = new Map(); // expressID → [classIndex, název, GlobalId]
  const describe = (eid) => {
    if (info.has(eid)) return info.get(eid);
    let d;
    try {
      const l = api.GetLine(id, eid, false);
      const cn = className(l.type);
      if (!classIdx.has(cn)) { classIdx.set(cn, classes.length); classes.push(cn); }
      d = [classIdx.get(cn), text(l.Name) || text(l.LongName), text(l.GlobalId)];
    } catch { d = [-1, '', '']; }
    info.set(eid, d);
    return d;
  };

  const projects = ids(api.GetLineIDsWithType(id, WebIFC.IFCPROJECT));
  const seen = new Set();
  const build = (eid) => {
    if (seen.has(eid)) return null; // ochrana proti cyklům
    seen.add(eid);
    const [c, name] = describe(eid);
    const kids = (children.get(eid) || []).map(build).filter(Boolean);
    return { id: eid, c, n: name, k: kids.length ? kids : undefined };
  };
  const roots = projects.map(build).filter(Boolean);
  const orphans = [...withGeometry].filter((eid) => !seen.has(eid)).map(build).filter(Boolean);
  if (orphans.length) roots.push({ id: 0, c: -1, n: '', k: orphans, orphans: true });

  // všechny prvky s geometrií + uzly stromu: plochý seznam (GUID, třídy, hledání)
  for (const eid of withGeometry) describe(eid);
  const n = info.size;
  const elIds = new Uint32Array(n), elClass = new Int32Array(n), names = new Array(n), guids = new Array(n);
  const geo = new Uint8Array(n);
  let i = 0;
  for (const [eid, d] of info) {
    elIds[i] = eid; elClass[i] = d[0]; names[i] = d[1]; guids[i] = d[2]; geo[i] = withGeometry.has(eid) ? 1 : 0; i++;
  }
  // výška podlaží v metrech ve světových souřadnicích (IFC Z) – pro rozpad po podlažích: absolutní umístění podlaží
  // (řetěz IfcLocalPlacement, stejný zdroj jako geometrie → sedí napříč modely); bez něj Elevation (bez posunu stavby)
  const elev = {}, elevSrc = {};
  const scale = lengthScale(id);
  for (const sid of ids(api.GetLineIDsWithType(id, WebIFC.IFCBUILDINGSTOREY))) {
    let z = null;
    try { z = placementZ(id, val(api.GetLine(id, sid, false).ObjectPlacement)); } catch { z = null; }
    if (z != null && isFinite(z)) { elev[sid] = z * scale; elevSrc[sid] = 'placement'; continue; }
    try { const e = val(api.GetLine(id, sid, false).Elevation); if (typeof e === 'number' && isFinite(e)) { elev[sid] = e * scale; elevSrc[sid] = 'elevation'; } } catch { /* bez výšky */ }
  }
  return { classes, tree: roots, elements: { ids: elIds, cls: elClass, names, guids, geo }, elev, elevSrc, lengthScale: scale };
}

// Absolutní Z počátku umístění (IfcLocalPlacement → PlacementRelTo …) v jednotkách projektu; null = jiné umístění.
// Matice 3×4 (sloupce X, Y, Z, posun) – skládá se od kořene, rotace os se respektují.
function placementZ(id, pid, depth = 0) {
  if (pid == null || depth > 32) return depth ? [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0] : null;
  const p = api.GetLine(id, pid, false);
  if (!p.RelativePlacement) return null;
  const parent = p.PlacementRelTo ? placementZ(id, val(p.PlacementRelTo), depth + 1) : [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];
  if (!parent) return null;
  const a = api.GetLine(id, val(p.RelativePlacement), false);
  const nums = (ref, def) => { if (!ref) return def; const l = api.GetLine(id, val(ref), false); const c = l.Coordinates || l.DirectionRatios; return (Array.isArray(c) ? c : [c]).map(val).concat([0, 0, 0]).slice(0, 3); };
  const loc = nums(a.Location, [0, 0, 0]);
  const unit = (v) => { const n = Math.hypot(...v) || 1; return v.map((x) => x / n); };
  const z = unit(nums(a.Axis, [0, 0, 1]));
  let x = nums(a.RefDirection, [1, 0, 0]);
  const d = x[0] * z[0] + x[1] * z[1] + x[2] * z[2];
  x = unit([x[0] - d * z[0], x[1] - d * z[1], x[2] - d * z[2]]);
  const y = [z[1] * x[2] - z[2] * x[1], z[2] * x[0] - z[0] * x[2], z[0] * x[1] - z[1] * x[0]];
  // parent · [x y z loc]
  const P = parent, mul = (v) => [P[0] * v[0] + P[3] * v[1] + P[6] * v[2], P[1] * v[0] + P[4] * v[1] + P[7] * v[2], P[2] * v[0] + P[5] * v[1] + P[8] * v[2]];
  const t = mul(loc);
  const m = [...mul(x), ...mul(y), ...mul(z), t[0] + P[9], t[1] + P[10], t[2] + P[11]];
  return depth ? m : m[11];
}

// Délková jednotka projektu → metry (Elevation apod. jsou v jednotkách projektu; geometrii web-ifc převádí sám)
const SI_PREFIX = { EXA: 1e18, PETA: 1e15, TERA: 1e12, GIGA: 1e9, MEGA: 1e6, KILO: 1e3, HECTO: 1e2, DECA: 1e1, DECI: 1e-1, CENTI: 1e-2, MILLI: 1e-3, MICRO: 1e-6, NANO: 1e-9 };
function lengthScale(id) {
  const ids = (vec) => { const a = []; for (let i = 0; i < vec.size(); i++) a.push(vec.get(i)); return a; };
  try {
    for (const uid of ids(api.GetLineIDsWithType(id, WebIFC.IFCSIUNIT))) {
      const u = api.GetLine(id, uid, false);
      if (val(u.UnitType) !== 'LENGTHUNIT') continue;
      const pre = val(u.Prefix);
      return pre ? SI_PREFIX[pre] ?? 1 : 1;
    }
    for (const uid of ids(api.GetLineIDsWithType(id, WebIFC.IFCCONVERSIONBASEDUNIT))) {
      const u = api.GetLine(id, uid, false);
      if (val(u.UnitType) !== 'LENGTHUNIT') continue;
      const n = text(u.Name).toUpperCase();
      if (n.includes('INCH')) return 0.0254;
      if (n.includes('FOOT') || n.includes('FEET')) return 0.3048;
    }
  } catch { /* bez jednotek → metry */ }
  return 1;
}

// Vlastnosti prvku: atributy, typ, materiály, sady vlastností a množství → skupiny řádků [klíč, hodnota]
function props(id, eid) {
  if (id == null) throw new Error('model není otevřený');
  const line = api.GetLine(id, eid, false);
  const groups = [];
  const attrs = [[L.cls, className(line.type)], ['expressID', `#${eid}`]];
  for (const [k, v] of Object.entries(line)) {
    if (k === 'type' || k === 'expressID' || v == null) continue;
    if (Array.isArray(v)) continue; // seznamy odkazů (geometrie apod.) – nezajímavé
    const x = val(v);
    if (typeof x === 'number' && v?.type === 5) continue; // odkaz na jinou entitu (umístění, reprezentace)
    attrs.push([k, fmt(v)]);
  }
  groups.push({ title: L.attrs, rows: attrs });

  // typ (IfcRelDefinesByType) a sady vlastností / množství (IfcRelDefinesByProperties) přes inverzní atributy
  const inv = api.GetLine(id, eid, false, true);
  const defs = refs(inv.IsDefinedBy);
  const typeRels = refs(inv.IsTypedBy);
  const psets = [];
  const typeIds = [];
  for (const rid of [...defs, ...typeRels]) {
    const r = api.GetLine(id, rid, false);
    if (r.RelatingPropertyDefinition) psets.push(val(r.RelatingPropertyDefinition));
    if (r.RelatingType) typeIds.push(val(r.RelatingType));
  }
  for (const tid of typeIds) {
    const t = api.GetLine(id, tid, false);
    groups.push({ title: `${L.type} – ${className(t.type)}`, rows: [[L.name, text(t.Name)], ['GlobalId', text(t.GlobalId)], [L.desc, text(t.Description)]].filter((r) => r[1]) });
    for (const p of refs(t.HasPropertySets)) psets.push({ fromType: true, id: p });
  }
  for (const p of psets) {
    const pid = typeof p === 'number' ? p : p.id;
    const g = propertySet(id, pid, typeof p === 'object');
    if (g) groups.push(g);
  }

  // materiály (IfcRelAssociatesMaterial)
  const mats = [];
  for (const rid of refs(inv.HasAssociations)) {
    const r = api.GetLine(id, rid, false);
    if (r.RelatingMaterial) material(id, val(r.RelatingMaterial), mats, 0);
  }
  if (mats.length) groups.push({ title: L.mats, rows: mats });
  return groups;
}

const refs = (list) => (Array.isArray(list) ? list : list ? [list] : []).map(val).filter((x) => typeof x === 'number');

function propertySet(id, pid, fromType) {
  const s = api.GetLine(id, pid, false);
  const rows = [];
  for (const prid of refs(s.HasProperties)) {
    const p = api.GetLine(id, prid, false);
    let v = '';
    if (p.NominalValue) v = fmt(p.NominalValue);
    else if (p.EnumerationValues) v = (Array.isArray(p.EnumerationValues) ? p.EnumerationValues : [p.EnumerationValues]).map(fmt).join(', ');
    else if (p.ListValues) v = (Array.isArray(p.ListValues) ? p.ListValues : [p.ListValues]).map(fmt).join(', ');
    else if (p.UpperBoundValue || p.LowerBoundValue) v = `${fmt(p.LowerBoundValue) || '…'} – ${fmt(p.UpperBoundValue) || '…'}`;
    rows.push([text(p.Name), v]);
  }
  for (const qid of refs(s.Quantities)) {
    const q = api.GetLine(id, qid, false);
    const key = Object.keys(q).find((k) => /Value$/.test(k) && q[k] != null && k !== 'Formula');
    rows.push([text(q.Name), key ? fmt(q[key]) : '']);
  }
  if (!rows.length && !s.HasProperties && !s.Quantities) {
    // jiné definice vlastností (IfcDoorLiningProperties apod.) – přímé jednoduché atributy
    for (const [k, v] of Object.entries(s)) {
      if (['type', 'expressID', 'GlobalId', 'OwnerHistory', 'Name', 'Description'].includes(k) || v == null || Array.isArray(v) || v?.type === 5) continue;
      rows.push([k, fmt(v)]);
    }
  }
  const title = text(s.Name) || className(s.type);
  return { title: fromType ? `${title} (${L.ofType})` : title, rows, pset: true };
}

function material(id, mid, out, depth) {
  if (depth > 4) return;
  const m = api.GetLine(id, mid, false);
  const cn = className(m.type);
  if (cn === 'IfcMaterial') { out.push([text(m.Name), text(m.Category) || '']); return; }
  if (cn === 'IfcMaterialLayerSetUsage') return material(id, val(m.ForLayerSet), out, depth + 1);
  if (cn === 'IfcMaterialLayerSet') {
    for (const l of refs(m.MaterialLayers)) {
      const layer = api.GetLine(id, l, false);
      const name = layer.Material ? text(api.GetLine(id, val(layer.Material), false).Name) : '—';
      out.push([name, layer.LayerThickness != null ? `${fmtNum(val(layer.LayerThickness))}` : '']);
    }
    return;
  }
  if (cn === 'IfcMaterialList') { for (const x of refs(m.Materials)) material(id, x, out, depth + 1); return; }
  if (cn === 'IfcMaterialConstituentSet') { for (const x of refs(m.MaterialConstituents)) material(id, x, out, depth + 1); return; }
  if (cn === 'IfcMaterialConstituent' || cn === 'IfcMaterialProfile') { if (m.Material) material(id, val(m.Material), out, depth + 1); return; }
  if (cn === 'IfcMaterialProfileSetUsage') return material(id, val(m.ForProfileSet), out, depth + 1);
  if (cn === 'IfcMaterialProfileSet') { for (const x of refs(m.MaterialProfiles)) material(id, x, out, depth + 1); return; }
  out.push([text(m.Name) || cn, '']);
}

function fmtNum(x) {
  if (typeof x !== 'number' || !isFinite(x)) return String(x);
  return Math.abs(x) >= 1e6 || (x !== 0 && Math.abs(x) < 1e-4) ? x.toExponential(4) : String(+x.toFixed(6));
}

function fmt(a) {
  if (a == null) return '';
  if (Array.isArray(a)) return a.map(fmt).join(', ');
  const v = val(a);
  if (typeof v === 'number') return fmtNum(v);
  if (typeof v === 'boolean') return v ? L.yes : L.no;
  let s = decodeIfc(String(v));
  if (a?.type === 3) { // výčet / logická hodnota
    if (s === 'T' || s === 'TRUE') return L.yes;
    if (s === 'F' || s === 'FALSE') return L.no;
    if (s === 'U' || s === 'UNKNOWN') return '?';
  }
  return s;
}

// ---- index hodnot pro filtry (záložky Atributy, Vlastnosti, Materiály, Patří do, Klasifikace) ----
// Jen prvky s geometrií. Výsledek: dimenze {tab, group, sub, multi, values: [[popisek, Uint32Array expressID]]};
// dimenze = jedna filtrovací osa (atribut, vlastnost v sadě, materiály, druh skupiny, klasifikační systém).
// multi = prvek může mít v dimenzi víc hodnot (materiály, skupiny, klasifikace).
const SPATIAL = /^Ifc(Project|Site|Building|BuildingStorey|Space|Facility\w*|Bridge\w*|Road\w*|Railway\w*|MarineFacility|Tunnel\w*|SpatialZone|ExternalSpatialElement)$/;
function facets(id, geo) {
  if (id == null) throw new Error('model není otevřený');
  const list = (vec) => { const a = []; for (let i = 0; i < vec.size(); i++) a.push(vec.get(i)); return a; };
  const lines = (T) => (T == null ? [] : list(api.GetLineIDsWithType(id, T)));
  const dims = new Map(); // klíč → {tab, group, sub, multi, map: Map hodnota → Set}
  const dim = (tab, group, sub, multi) => {
    const k = `${tab}\u0001${group}\u0001${sub}`;
    let d = dims.get(k);
    if (!d) dims.set(k, d = { tab, group, sub, multi, map: new Map() });
    return d;
  };
  const add = (d, v, eid) => { if (v === '' || v == null) return; let a = d.map.get(v); if (!a) d.map.set(v, a = new Set()); a.add(eid); };
  const safe = (eid) => { try { return api.GetLine(id, eid, false); } catch { return null; } };

  // typy: IfcRelDefinesByType → výskyty (atribut „Typ“, vlastnosti typu, materiály / klasifikace přiřazené typu)
  const occOfType = new Map();
  for (const rid of lines(WebIFC.IFCRELDEFINESBYTYPE)) {
    const r = safe(rid); if (!r) continue;
    const t = val(r.RelatingType);
    if (!occOfType.has(t)) occOfType.set(t, []);
    occOfType.get(t).push(...refs(r.RelatedObjects).filter((e) => geo.has(e)));
  }
  const expand = (objs) => objs.flatMap((o) => (geo.has(o) ? [o] : occOfType.get(o) || []));

  // atributy
  const ATTRS = ['Name', 'ObjectType', 'PredefinedType', 'Tag', 'Description'];
  for (const eid of geo) {
    const l = safe(eid); if (!l) continue;
    for (const k of ATTRS) if (l[k] != null) add(dim('attrs', k, '', false), fmt(l[k]), eid);
  }
  const typeLines = new Map();
  for (const [t, occ] of occOfType) {
    const tl = safe(t); if (!tl) continue;
    typeLines.set(t, tl);
    const label = text(tl.Name) || className(tl.type);
    for (const e of occ) add(dim('attrs', 'Type', '', false), label, e);
  }

  // sady vlastností: nejdřív z typů, pak z výskytů (přepíší stejnou vlastnost) – po prvcích, pak obráceně na hodnoty
  const per = new Map(); // "pset\u0001prop" → Map eid → hodnota
  const psetCache = new Map();
  const readPset = (pid) => {
    if (psetCache.has(pid)) return psetCache.get(pid);
    let res = null;
    const s = safe(pid);
    if (s && s.HasProperties) {
      const props = [];
      for (const prid of refs(s.HasProperties)) {
        const p = safe(prid); if (!p) continue;
        let v;
        if (p.NominalValue) v = fmt(p.NominalValue);
        else if (p.EnumerationValues) v = (Array.isArray(p.EnumerationValues) ? p.EnumerationValues : [p.EnumerationValues]).map(fmt).join(', ');
        else if (p.ListValues) v = (Array.isArray(p.ListValues) ? p.ListValues : [p.ListValues]).map(fmt).join(', ');
        else continue; // složené / odkazové vlastnosti – do filtru ne
        props.push([text(p.Name), v]);
      }
      res = [text(s.Name) || className(s.type), props];
    }
    psetCache.set(pid, res);
    return res;
  };
  const apply = (pid, objs) => {
    const ps = readPset(pid); if (!ps) return;
    for (const [pn, v] of ps[1]) {
      const k = `${ps[0]}\u0001${pn}`;
      let m = per.get(k); if (!m) per.set(k, m = new Map());
      for (const e of objs) m.set(e, v);
    }
  };
  for (const [t, tl] of typeLines) for (const pid of refs(tl.HasPropertySets)) apply(pid, occOfType.get(t));
  for (const rid of lines(WebIFC.IFCRELDEFINESBYPROPERTIES)) {
    const r = safe(rid); if (!r) continue;
    const objs = expand(refs(r.RelatedObjects));
    if (objs.length) for (const pid of refs(r.RelatingPropertyDefinition)) apply(pid, objs);
  }
  for (const [k, m] of per) {
    const [pset, prop] = k.split('\u0001');
    const d = dim('psets', pset, prop, false);
    for (const [e, v] of m) add(d, v, e);
  }

  // materiály
  for (const rid of lines(WebIFC.IFCRELASSOCIATESMATERIAL)) {
    const r = safe(rid); if (!r || !r.RelatingMaterial) continue;
    const out = [];
    try { material(id, val(r.RelatingMaterial), out, 0); } catch { continue; }
    const names = [...new Set(out.map((x) => x[0]).filter(Boolean))];
    const d = dim('mats', '', '', true);
    for (const e of expand(refs(r.RelatedObjects))) for (const n of names) add(d, n, e);
  }

  // patří do: skupiny (systémy, zóny… – IfcRelAssignsToGroup) a sestavy (IfcRelAggregates s nadřazeným prvkem, ne prostorem)
  for (const rid of lines(WebIFC.IFCRELASSIGNSTOGROUP)) {
    const r = safe(rid); if (!r) continue;
    const g = safe(val(r.RelatingGroup)); if (!g) continue;
    const d = dim('groups', className(g.type), '', true);
    for (const e of expand(refs(r.RelatedObjects))) add(d, text(g.Name) || `#${val(r.RelatingGroup)}`, e);
  }
  for (const rid of lines(WebIFC.IFCRELAGGREGATES)) {
    const r = safe(rid); if (!r) continue;
    const pid = val(r.RelatingObject), pl = safe(pid); if (!pl) continue;
    const cn = className(pl.type);
    if (SPATIAL.test(cn)) continue;
    const d = dim('groups', cn, '', true);
    for (const e of refs(r.RelatedObjects).filter((x) => geo.has(x))) add(d, text(pl.Name) || `#${pid}`, e);
  }

  // klasifikace: systém (IfcClassification.Name přes ReferencedSource) → položka (kód + název)
  const refInfo = (cid) => {
    const c = safe(cid); if (!c) return null;
    const cn = className(c.type);
    if (cn === 'IfcClassification') { const n = text(c.Name); return { sys: n, label: n }; }
    let sys = '', src = c.ReferencedSource ? val(c.ReferencedSource) : null, guard = 0;
    while (src != null && guard++ < 8) {
      const s = safe(src); if (!s) break;
      if (className(s.type) === 'IfcClassification') { sys = text(s.Name); break; }
      src = s.ReferencedSource ? val(s.ReferencedSource) : null;
    }
    if (cn === 'IfcClassificationNotation') {
      return { sys: sys || '—', label: refs(c.NotationFacets).map((f) => text(safe(f)?.NotationValue)).filter(Boolean).join(' ') || `#${cid}` };
    }
    const code = text(c.Identification) || text(c.ItemReference);
    const name = text(c.Name);
    return { sys: sys || '—', label: [code, name && name !== code ? name : ''].filter(Boolean).join(' ') || text(c.Location) || `#${cid}` };
  };
  for (const rid of lines(WebIFC.IFCRELASSOCIATESCLASSIFICATION)) {
    const r = safe(rid); if (!r) continue;
    const ci = refInfo(val(r.RelatingClassification)); if (!ci) continue;
    const d = dim('classif', ci.sys, '', true);
    for (const e of expand(refs(r.RelatedObjects))) add(d, ci.label, e);
  }

  return [...dims.values()].filter((d) => d.map.size).map((d) => ({
    tab: d.tab, group: d.group, sub: d.sub, multi: d.multi,
    values: [...d.map].map(([v, set]) => [v, Uint32Array.from(set)]),
  }));
}
