// IFC Viewer – řezy (rovina, kvádr) a měření vzdálenosti.
import * as THREE from 'three';

// ---------- Řezy ----------
// Rovina: THREE.Plane, ořízne se vše, kde vzdálenost < 0 (normála míří do ponechané části).
// Kvádr: 6 rovin dovnitř. Řez i kvádr mohou být zároveň.
export class Sections {
  constructor(viewer, onChange) {
    this.viewer = viewer;
    this.onChange = onChange;
    this.plane = null; // {plane, axis: 'y'|'x'|'z'|'face', helper}
    this.box = null; // {min: Vector3, max: Vector3, planes[6], helper}
    this.bounds = new THREE.Box3();
  }

  get planes() {
    const p = [];
    if (this.plane) p.push(this.plane.plane);
    if (this.box) p.push(...this.box.planes);
    return p;
  }

  // bod je vidět (není odříznutý)
  keeps(point) {
    for (const pl of this.planes) if (pl.distanceToPoint(point) < -1e-6) return false;
    return true;
  }

  // rovina kolmá na osu (y = vodorovný řez) uprostřed modelu, nebo podle plochy (bod + normála)
  setPlane(axis, point, normal) {
    this.clearPlane(false);
    const b = this.bounds, c = b.getCenter(new THREE.Vector3());
    let n, p;
    if (axis === 'face') { n = normal.clone().negate().normalize(); p = point.clone(); }
    else if (axis === 'y') { n = new THREE.Vector3(0, -1, 0); p = c.clone(); p.y = b.min.y + (b.max.y - b.min.y) * 0.5; }
    else if (axis === 'x') { n = new THREE.Vector3(-1, 0, 0); p = c.clone(); }
    else { n = new THREE.Vector3(0, 0, -1); p = c.clone(); }
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(n, p);
    this.plane = { plane, axis, base: p.clone(), offset: 0 };
    this.#planeHelper();
    this.onChange();
  }

  // obecná rovina bodem a normálou (normála = zachovaná strana) – otáčení řezu šipkami v modelu
  setPlaneNormal(point, normal) {
    this.clearPlane(false);
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal.clone().normalize(), point);
    this.plane = { plane, axis: 'free', base: point.clone(), offset: 0 };
    this.#planeHelper();
    this.onChange();
  }
  // posun roviny (m) podél normály, rozsah = obálka modelu ve směru normály
  planeRange() {
    if (!this.plane) return [0, 0];
    const n = this.plane.plane.normal, b = this.bounds;
    const corners = [];
    for (const x of [b.min.x, b.max.x]) for (const y of [b.min.y, b.max.y]) for (const z of [b.min.z, b.max.z]) corners.push(new THREE.Vector3(x, y, z));
    const d = corners.map((v) => -n.dot(v.clone().sub(this.plane.base)));
    return [Math.min(...d), Math.max(...d)];
  }

  setPlaneOffset(off) {
    if (!this.plane) return;
    const { plane, base } = this.plane;
    this.plane.offset = off;
    plane.setFromNormalAndCoplanarPoint(plane.normal, base.clone().addScaledVector(plane.normal, -off));
    this.#planeHelper();
    this.onChange();
  }

  flipPlane() {
    if (!this.plane) return;
    const { plane } = this.plane;
    plane.negate();
    this.plane.offset = -this.plane.offset;
    this.onChange();
    this.#planeHelper();
  }

  clearPlane(notify = true) {
    if (this.plane?.helper) { this.viewer.overlay.remove(this.plane.helper); this.plane.helper.geometry.dispose(); }
    this.plane = null;
    if (notify) this.onChange();
  }

  #planeHelper() {
    if (this.plane.helper) { this.viewer.overlay.remove(this.plane.helper); this.plane.helper.geometry.dispose(); }
    const size = this.bounds.getSize(new THREE.Vector3()).length() * 0.75 || 10;
    const geom = new THREE.PlaneGeometry(size, size);
    const edges = new THREE.EdgesGeometry(geom);
    geom.dispose();
    const line = new THREE.LineSegments(edges, new THREE.LineBasicMaterial({ color: this.viewer.colors.rez, transparent: true, opacity: 0.9 }));
    const pl = this.plane.plane;
    const c = pl.projectPoint(this.bounds.getCenter(new THREE.Vector3()), new THREE.Vector3());
    line.position.copy(c);
    line.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), pl.normal);
    this.plane.helper = line;
    this.viewer.overlay.add(line);
  }

  // kvádr – výchozí = obálka modelu (mírně zvětšená), hodnoty min / max po osách
  enableBox(on) {
    // vždy nejdřív odebrat rámeček stávajícího kvádru (i při „Výchozí“ – jinak ve scéně zůstal starý)
    if (this.box?.helper) { this.viewer.overlay.remove(this.box.helper); this.box.helper.dispose(); }
    this.box = null;
    if (!on) { this.onChange(); return; }
    const b = this.bounds.clone().expandByScalar(0.01);
    this.box = { min: b.min.clone(), max: b.max.clone(), planes: Array.from({ length: 6 }, () => new THREE.Plane()), helper: null };
    this.setBox(this.box.min, this.box.max);
  }

  setBox(min, max) {
    const bx = this.box;
    bx.min.copy(min); bx.max.copy(max);
    const P = bx.planes;
    P[0].set(new THREE.Vector3(1, 0, 0), -min.x); P[1].set(new THREE.Vector3(-1, 0, 0), max.x);
    P[2].set(new THREE.Vector3(0, 1, 0), -min.y); P[3].set(new THREE.Vector3(0, -1, 0), max.y);
    P[4].set(new THREE.Vector3(0, 0, 1), -min.z); P[5].set(new THREE.Vector3(0, 0, -1), max.z);
    if (bx.helper) { this.viewer.overlay.remove(bx.helper); bx.helper.dispose(); }
    bx.helper = new THREE.Box3Helper(new THREE.Box3(min.clone(), max.clone()), this.viewer.colors.rez);
    this.viewer.overlay.add(bx.helper);
    this.onChange();
  }

  setHelpersVisible(v) {
    if (this.plane?.helper) this.plane.helper.visible = v;
    if (this.box?.helper) this.box.helper.visible = v;
  }

  recolor() {
    const c = this.viewer.colors.rez;
    if (this.plane?.helper) this.plane.helper.material.color.set(c);
    if (this.box?.helper) this.box.helper.material.color.set(c);
  }
}

// ---------- Měření ----------
// Dva body → úsečka + štítek. Kreslí se do SVG nad plátnem (ostré, v barvách GUI).
// Přichycení (v pixelech): vrchol (12 px) → střed hrany (10 px) → hrana (8 px) → plocha. Hrana = jen skutečná hrana
// tělesa: web-ifc sdílí vrcholy v rámci rovinné plochy, takže úhlopříčka triangulace má souseda se stejnými dvěma
// vrcholy, kdežto hrana mezi plochami ne.
// Shift po prvním bodu: směr se zamkne na nejbližší osu (X, Y, Z v IFC) nebo kolmici na plochu prvního bodu;
// měří se vzdálenost v tomto směru (průmět bodu pod kurzorem na přímku).
const AXES = [['X', new THREE.Vector3(1, 0, 0)], ['Y', new THREE.Vector3(0, 0, -1)], ['Z', new THREE.Vector3(0, 1, 0)]];
export class Measure {
  // labels: {vertex, mid, edge, face} – popisky u kurzoru (jazyk GUI)
  constructor(viewer, svg, fmt, labels = {}) {
    this.viewer = viewer;
    this.svg = svg;
    this.fmt = fmt;
    this.labels = labels;
    this.items = []; // {a, b, axis?}
    this.start = null; // první bod rozpracovaného měření
    this.startN = null; // normála plochy prvního bodu (pro kolmici)
    this.cursor = null; // {p, kind, edge?, normal?, raw?, axis?}
    this.raw = null; // poslední bod pod kurzorem bez zamknutí směru
    this.shift = false;
    viewer.onRender.push(() => this.draw());
  }

  #isFeatureEdge(hit, ia, ib) {
    const m = hit.model, g = m?.groups.find((x) => x.pick === hit.object);
    if (!g) return true;
    const gi = m.groups.indexOf(g);
    let shared = 0;
    for (const [rgi, s, c] of m.ranges.get(hit.expressID) || []) {
      if (rgi !== gi) continue;
      const f = g.full;
      for (let t = s; t < s + c; t += 3) {
        const a = f[t], b = f[t + 1], cc = f[t + 2];
        if ((a === ia || b === ia || cc === ia) && (a === ib || b === ib || cc === ib) && ++shared > 1) return false;
      }
    }
    return true;
  }

  // bod pod kurzorem z průsečíku → {p, kind: 'vertex'|'mid'|'edge'|'face', edge?: [A, B], normal}
  snap(hit) {
    if (!hit) return null;
    const g = hit.object.geometry, pos = g.getAttribute('position'), mw = hit.object.matrixWorld;
    const normal = hit.face.normal.clone().transformDirection(mw);
    const sp = this.viewer.toScreen(hit.point);
    const dist = (p) => { const s = this.viewer.toScreen(p); return Math.hypot(s.x - sp.x, s.y - sp.y); };
    const idx = [hit.face.a, hit.face.b, hit.face.c];
    const V = idx.map((i) => new THREE.Vector3().fromBufferAttribute(pos, i).applyMatrix4(mw));
    let best = null, bestD = 12;
    for (const v of V) { const d = dist(v); if (d < bestD) { bestD = d; best = v; } }
    if (best) return { p: best.clone(), kind: 'vertex', normal };
    const line = new THREE.Line3(), q = new THREE.Vector3();
    let edge = null, eD = 8, mid = null, mD = 10;
    for (let k = 0; k < 3; k++) {
      const ia = idx[k], ib = idx[(k + 1) % 3], A = V[k], B = V[(k + 1) % 3];
      line.set(A, B);
      line.closestPointToPoint(hit.point, true, q);
      const d = dist(q);
      if (d > Math.max(eD, mD) || !this.#isFeatureEdge(hit, ia, ib)) continue;
      const M = A.clone().add(B).multiplyScalar(0.5), dm = dist(M);
      if (dm < mD) { mD = dm; mid = { p: M, kind: 'mid', edge: [A.clone(), B.clone()], normal }; }
      if (d < eD) { eD = d; edge = { p: q.clone(), kind: 'edge', edge: [A.clone(), B.clone()], normal }; }
    }
    return mid || edge || { p: hit.point.clone(), kind: 'face', normal };
  }

  // zamknutí směru (Shift): nejbližší osa nebo kolmice na plochu prvního bodu
  #constrain(pt) {
    if (!pt || !this.start || !this.shift) return pt;
    const d = pt.p.clone().sub(this.start);
    if (d.lengthSq() < 1e-12) return pt;
    const cands = AXES.slice();
    if (this.startN && !AXES.some(([, a]) => Math.abs(a.dot(this.startN)) > 0.999)) cands.push(['n', this.startN]);
    const dn = d.clone().normalize();
    let ax = cands[0];
    for (const c of cands) if (Math.abs(c[1].dot(dn)) > Math.abs(ax[1].dot(dn))) ax = c;
    const p = this.start.clone().addScaledVector(ax[1], d.dot(ax[1]));
    return { ...pt, p, raw: pt.p, axis: ax[0] };
  }

  hover(pt, shift = this.shift) {
    this.raw = pt;
    this.shift = shift;
    this.cursor = this.#constrain(pt);
    this.viewer.requestRender();
  }

  setShift(on) { if (on !== this.shift) this.hover(this.raw, on); }

  click(pt, shift = this.shift) {
    this.shift = shift;
    pt = this.#constrain(pt);
    if (!pt) return null;
    if (!this.start) { this.start = pt.p.clone(); this.startN = pt.normal?.clone() || null; this.viewer.requestRender(); return null; }
    const item = { a: this.start, b: pt.p.clone(), axis: pt.axis };
    this.items.push(item);
    this.start = null; this.startN = null;
    this.cursor = null;
    this.viewer.requestRender();
    return item;
  }

  cancel() { this.start = null; this.startN = null; this.cursor = null; this.viewer.requestRender(); }
  clear() { this.items = []; this.cancel(); }
  remove(i) { this.items.splice(i, 1); this.viewer.requestRender(); }

  draw() {
    const v = this.viewer, svg = this.svg;
    const parts = [];
    const L = this.labels;
    const label = (x, y, text, cls = '') => {
      const w = text.length * 7.4 + 14;
      parts.push(`<g class="ifc-m-label${cls}" transform="translate(${x},${y})"><rect x="${-w / 2}" y="-11" width="${w}" height="22" rx="4"/><text text-anchor="middle" dy="4">${text}</text></g>`);
    };
    const seg = (a, b, cls, text) => {
      const A = v.toScreen(a), B = v.toScreen(b);
      if (A.behind || B.behind) return;
      parts.push(`<line class="${cls}" x1="${A.x}" y1="${A.y}" x2="${B.x}" y2="${B.y}"/>`);
      parts.push(`<circle class="ifc-m-pt" cx="${A.x}" cy="${A.y}" r="4"/><circle class="ifc-m-pt" cx="${B.x}" cy="${B.y}" r="4"/>`);
      if (text) label((A.x + B.x) / 2, (A.y + B.y) / 2, text);
    };
    const axCls = (a) => (a ? ` ifc-m-ax--${a.toLowerCase()}` : '');
    const axTxt = (a, d) => (a ? `${a === 'n' ? '⊥' : `Δ${a}`} ${d}` : d);
    for (const it of this.items) seg(it.a, it.b, `ifc-m-line${axCls(it.axis)}`, axTxt(it.axis, this.fmt(it.a.distanceTo(it.b))));
    const c = this.cursor;
    // zvýrazněná hrana, ke které se přichytilo
    if (c?.edge) {
      const A = v.toScreen(c.edge[0]), B = v.toScreen(c.edge[1]);
      if (!A.behind && !B.behind) parts.push(`<line class="ifc-m-edge" x1="${A.x}" y1="${A.y}" x2="${B.x}" y2="${B.y}"/>`);
    }
    if (this.start && c) {
      if (c.raw) { // průmět: od skutečného bodu pod kurzorem ke změřenému
        const R = v.toScreen(c.raw), P = v.toScreen(c.p);
        if (!R.behind && !P.behind) parts.push(`<line class="ifc-m-guide" x1="${R.x}" y1="${R.y}" x2="${P.x}" y2="${P.y}"/>`);
      }
      seg(this.start, c.p, `ifc-m-line ifc-m-line--live${axCls(c.axis)}`, axTxt(c.axis, this.fmt(this.start.distanceTo(c.p))));
    } else if (this.start) { const S = v.toScreen(this.start); parts.push(`<circle class="ifc-m-pt" cx="${S.x}" cy="${S.y}" r="4"/>`); }
    if (c) {
      const C = v.toScreen(c.raw || c.p); // značka přichycení na skutečném bodu pod kurzorem
      const k = c.kind;
      parts.push(k === 'vertex' ? `<rect class="ifc-m-cursor is-snap" x="${C.x - 6}" y="${C.y - 6}" width="12" height="12"/>`
        : k === 'mid' ? `<path class="ifc-m-cursor is-snap" d="M${C.x} ${C.y - 7}L${C.x + 7} ${C.y + 5}H${C.x - 7}Z"/>`
          : k === 'edge' ? `<path class="ifc-m-cursor is-snap" d="M${C.x} ${C.y - 7}L${C.x + 7} ${C.y}L${C.x} ${C.y + 7}L${C.x - 7} ${C.y}Z"/>`
            : `<circle class="ifc-m-cursor" cx="${C.x}" cy="${C.y}" r="6"/>`);
      const t = L[k];
      if (t) label(C.x + 14 + (t.length * 7.4 + 14) / 2, C.y + 18, t, ' ifc-m-label--hint');
    }
    svg.innerHTML = parts.join('');
  }
}

// Rozdíly souřadnic v osách IFC (three: x, y nahoru, z = −IFC y)
export function deltaIfc(a, b) {
  return { x: b.x - a.x, y: -(b.z - a.z), z: b.y - a.y };
}
