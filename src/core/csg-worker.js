// IFC Viewer – vyříznutí otvorů z prvků (na tlačítko, u prvků s desítkami až stovkami otvorů, které web-ifc při
// načtení přeskočí – viz limitVoids v ifc-worker.js). three-bvh-csg: otvory prvku jedno těleso a jedno odečtení
// (deska s 766 otvory ~20 s místo minut ve web-ifc). Vstup i výstup v souřadnicích scény.
//   {job, host: {pos, index}, holes: [{pos, index}, …] (tělesa otvorů)} → {job, pos, nrm, index, ms, info} | {job, error}
// Úskalí CSG (uvnitř / vně podle průsečíků paprsku): plochy otvoru přesně v líci prvku (otvor na tloušťku stěny) a
// tělesa, která se dotýkají nebo překrývají (otvor = kvádr ve stěně + kvádr před ní). Proto: stejná tělesa jen
// jednou, každé se zvětší o INFLATE na každou stranu, tělesa s překrývajícími se obálkami se sjednotí (ADDITION) a
// až pak se vše odečte najednou.
import * as THREE from 'three';
import { mergeVertices, mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { Brush, Evaluator, SUBTRACTION, ADDITION } from 'three-bvh-csg';

const INFLATE = 0.002; // m
const ev = new Evaluator();
ev.attributes = ['position'];
ev.useGroups = false;

const geometry = (pos, index) => {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  if (index) g.setIndex(new THREE.BufferAttribute(index, 1));
  return mergeVertices(g, 1e-5); // web-ifc má vrcholy po plochách → spojit, ať je těleso souvislé
};
// jen poloha, s indexem (sloučení těles – mergeGeometries chce u všech stejné; síť bez indexu dělá v CSG potíže)
const positionOnly = (g) => { const r = g.index ? g.toNonIndexed() : g.clone(); for (const k of Object.keys(r.attributes)) if (k !== 'position') r.deleteAttribute(k); return mergeVertices(r, 1e-5); };

function box(p) {
  const b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (let i = 0; i < p.length; i += 3) for (let a = 0; a < 3; a++) { const x = p[i + a]; if (x < b[a]) b[a] = x; if (x > b[a + 3]) b[a + 3] = x; }
  return b;
}

// zvětšení tělesa o INFLATE na každou stranu (podle středu obálky, v každé ose zvlášť)
function inflate(pos, b) {
  const p = new Float32Array(pos);
  const ctr = [0, 1, 2].map((a) => (b[a] + b[a + 3]) / 2), half = [0, 1, 2].map((a) => (b[a + 3] - b[a]) / 2);
  const s = half.map((h) => (h > 1e-6 ? (h + INFLATE) / h : 1));
  for (let i = 0; i < p.length; i += 3) for (let a = 0; a < 3; a++) p[i + a] = ctr[a] + (p[i + a] - ctr[a]) * s[a];
  return { p, box: b.map((x, i) => (i < 3 ? x - INFLATE : x + INFLATE)) };
}

// skupiny těles s překrývajícími se obálkami – průchod podle min X
function clusters(parts) {
  const n = parts.length, parent = new Int32Array(n).map((_, i) => i);
  const find = (a) => { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; };
  const order = [...parts.keys()].sort((a, b) => parts[a].box[0] - parts[b].box[0]);
  for (let i = 0; i < n; i++) {
    const A = parts[order[i]].box;
    for (let j = i + 1; j < n; j++) {
      const B = parts[order[j]].box;
      if (B[0] > A[3]) break;
      if (B[1] <= A[4] && B[4] >= A[1] && B[2] <= A[5] && B[5] >= A[2]) {
        const a = find(order[i]), b = find(order[j]);
        if (a !== b) parent[a] = b;
      }
    }
  }
  const out = new Map();
  for (let i = 0; i < n; i++) { const r = find(i); if (!out.has(r)) out.set(r, []); out.get(r).push(parts[i]); }
  return [...out.values()];
}

self.onmessage = (e) => {
  const { job, host, holes } = e.data;
  try {
    const t0 = performance.now();
    const seen = new Set(), parts = [];
    for (const h of holes) {
      if (!h.index.length) continue;
      const b = box(h.pos);
      const key = b.map((x) => Math.round(x * 1e4)).join() + '/' + h.index.length;
      if (seen.has(key)) continue; // stejné těleso podruhé
      seen.add(key);
      const f = inflate(h.pos, b);
      parts.push({ geom: geometry(f.p, h.index), box: f.box });
    }
    if (!parts.length) throw new Error('bez těles otvorů');
    const cls = clusters(parts), solids = [];
    for (const cl of cls) {
      if (cl.length === 1) { solids.push(positionOnly(cl[0].geom)); continue; }
      let acc = new Brush(cl[0].geom);
      acc.updateMatrixWorld();
      for (let i = 1; i < cl.length; i++) {
        const b = new Brush(cl[i].geom);
        b.updateMatrixWorld();
        acc = ev.evaluate(acc, b, ADDITION);
        acc.updateMatrixWorld();
      }
      solids.push(positionOnly(acc.geometry));
    }
    const a = new Brush(geometry(host.pos, host.index));
    const b = new Brush(solids.length > 1 ? mergeGeometries(solids) : solids[0]);
    a.updateMatrixWorld(); b.updateMatrixWorld();
    let r = ev.evaluate(a, b, SUBTRACTION).geometry;
    if (r.index) r = r.toNonIndexed();
    r.computeVertexNormals(); // bez indexu = normály po trojúhelnících (ostré hrany)
    const pos = r.getAttribute('position').array, nrm = r.getAttribute('normal').array;
    const index = new Uint32Array(pos.length / 3);
    for (let i = 0; i < index.length; i++) index[i] = i;
    const info = { parts: parts.length, unions: cls.filter((c) => c.length > 1).length };
    self.postMessage({ job, pos, nrm, index, ms: Math.round(performance.now() - t0), info }, [pos.buffer, nrm.buffer, index.buffer]);
  } catch (err) {
    self.postMessage({ job, error: String(err?.message || err) });
  }
};
