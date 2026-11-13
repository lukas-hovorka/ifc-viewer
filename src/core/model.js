// IFC Viewer – model ve scéně: sloučené sítě podle barvy, viditelnost a zvýraznění po prvcích, výběr paprskem (BVH).
// Každá skupina barvy má:
//   render  – síť ve scéně; index = jen viditelné úseky (přepočítá se při skrytí / izolaci / filtru tříd)
//   pick    – neviditelná síť se stejnými vrcholy a plným indexem + BVH (three-mesh-bvh si index přeuspořádá,
//             proto prvek trojúhelníku určuje pole vertexIds podle vrcholu, ne podle pořadí v indexu)
import * as THREE from 'three';
import { MeshBVH, acceleratedRaycast } from 'three-mesh-bvh';

// vykreslovací geometrie (index = jen viditelné úseky, přepisuje se) + výběrová síť se sdílenými vrcholy a BVH
function buildMeshes(positions, normals, index) {
  const geom = new THREE.BufferGeometry();
  const pos = new THREE.BufferAttribute(positions, 3);
  geom.setAttribute('position', pos);
  geom.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  const idx = new THREE.BufferAttribute(new Uint32Array(index.length), 1);
  idx.array.set(index);
  geom.setIndex(idx);
  geom.computeBoundingBox();
  geom.computeBoundingSphere();
  // výběrová síť: sdílí vrcholy, vlastní kopie plného indexu → BVH
  const pg = new THREE.BufferGeometry();
  pg.setAttribute('position', pos);
  pg.setIndex(new THREE.BufferAttribute(index.slice(), 1)); // kopie – BVH ji přeuspořádá, index (úseky) musí zůstat
  pg.boundsTree = new MeshBVH(pg, { targetLeafSize: 16 });
  const pick = new THREE.Mesh(pg);
  pick.raycast = acceleratedRaycast;
  return { geom, pick };
}

export class IfcModel {
  constructor(key, name, geo, meta) {
    this.key = key;
    this.name = name;
    this.schema = geo.schema;
    this.object = new THREE.Group();
    this.object.name = name;
    this.highlight = new THREE.Group();
    this.object.add(this.highlight);
    this.groups = [];
    this.ranges = new Map(); // expressID → [[skupina, start, počet], …]
    this.hidden = new Set(); // skryté prvky (strom, „skrýt výběr“)
    this.isolated = null; // Set – zobrazit jen tyto (izolace)
    this.classOff = new Set(); // vypnuté třídy (index do meta.classes)
    this.facetOff = null; // Set – prvky skryté filtry podle hodnot (atributy, vlastnosti, materiály…)
    this.override = null; // barva celého modelu (THREE.Color) nebo null = původní z IFC
    this.setMeta(meta);

    geo.groups.forEach((g, gi) => {
      const { geom, pick } = buildMeshes(g.positions, g.normals, g.index);
      const [r, gr, b, a] = g.color;
      const color = new THREE.Color().setRGB(r, gr, b, THREE.SRGBColorSpace);
      const mat = new THREE.MeshLambertMaterial({
        color, transparent: a < 0.999, opacity: a, side: THREE.DoubleSide, depthWrite: a >= 0.999,
        polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1,
      });
      const render = new THREE.Mesh(geom, mat);
      render.renderOrder = a < 0.999 ? 1 : 0;
      render.userData.model = this;
      const grp = { render, pick, full: g.index, vertexIds: g.vertexIds, ranges: g.ranges, color, opacity: a };
      this.groups.push(grp);
      this.object.add(render);
    });
    this.#indexRanges();
    this.box = new THREE.Box3();
    for (const g of this.groups) this.box.union(g.render.geometry.boundingBox);
  }

  // expressID → úseky ve skupinách
  #indexRanges() {
    this.ranges = new Map();
    this.groups.forEach((g, gi) => {
      for (let i = 0; i < g.ranges.length; i += 3) {
        const id = g.ranges[i];
        if (!this.ranges.has(id)) this.ranges.set(id, []);
        this.ranges.get(id).push([gi, g.ranges[i + 1], g.ranges[i + 2]]);
      }
    });
  }

  // trojúhelníky prvků jako samostatná síť (souřadnice scény bez rozpadu podlaží) → {pos, index};
  // perItem = každý úsek (těleso) zvlášť → [{pos, index}, …]
  extract(ids, perItem = false) {
    if (perItem) return [...ids].flatMap((id) => (this.ranges.get(id) || []).map((r) => this.#extractRanges([r])));
    return this.#extractRanges([...ids].flatMap((id) => this.ranges.get(id) || []));
  }

  #extractRanges(list) {
    const pos = [], index = [];
    for (const [gi, s, c] of list) {
      const g = this.groups[gi], p = g.render.geometry.getAttribute('position').array, f = g.full;
      const map = new Map();
      for (let t = s; t < s + c; t++) {
        const v = f[t];
        let n = map.get(v);
        if (n == null) {
          n = pos.length / 3;
          map.set(v, n);
          pos.push(p[v * 3], g.baseY ? g.baseY[v] : p[v * 3 + 1], p[v * 3 + 2]);
        }
        index.push(n);
      }
    }
    return { pos: new Float32Array(pos), index: new Uint32Array(index) };
  }

  // náhrada geometrie prvků (vyříznuté otvory): rep = Map expressID → {pos, nrm, index} v souřadnicích scény bez
  // rozpadu. Dotčené skupiny barvy se sestaví znovu (staré vrcholy zůstanou, nové se připojí na konec), BVH znovu.
  // Rozpad podlaží se tím vynuluje – volající pak zavolá setLevels / explode (main.js relevel).
  replaceElements(rep) {
    this.setHighlight(null);
    const byGroup = new Map();
    for (const id of rep.keys()) {
      for (const [gi] of this.ranges.get(id) || []) {
        if (!byGroup.has(gi)) byGroup.set(gi, new Set());
        byGroup.get(gi).add(id);
      }
    }
    for (const [gi, ids] of byGroup) {
      const g = this.groups[gi];
      const old = g.render.geometry, oldPos = old.getAttribute('position').array, oldNrm = old.getAttribute('normal').array;
      const nvOld = oldPos.length / 3;
      let addV = 0, addI = 0, keepI = 0;
      for (const id of ids) { addV += rep.get(id).pos.length / 3; addI += rep.get(id).index.length; }
      const r = g.ranges;
      for (let i = 0; i < r.length; i += 3) if (!ids.has(r[i])) keepI += r[i + 2];
      const pos = new Float32Array((nvOld + addV) * 3), nrm = new Float32Array((nvOld + addV) * 3);
      pos.set(oldPos); nrm.set(oldNrm);
      if (g.baseY) for (let i = 0; i < nvOld; i++) pos[i * 3 + 1] = g.baseY[i]; // zpět bez rozpadu
      const vids = new Uint32Array(nvOld + addV);
      vids.set(g.vertexIds);
      const full = new Uint32Array(keepI + addI), ranges = [];
      let io = 0, vo = nvOld;
      for (let i = 0; i < r.length; i += 3) {
        if (ids.has(r[i])) continue;
        full.set(g.full.subarray(r[i + 1], r[i + 1] + r[i + 2]), io);
        ranges.push(r[i], io, r[i + 2]);
        io += r[i + 2];
      }
      for (const id of ids) {
        const d = rep.get(id), nv = d.pos.length / 3;
        pos.set(d.pos, vo * 3); nrm.set(d.nrm, vo * 3);
        vids.fill(id, vo, vo + nv);
        for (let k = 0; k < d.index.length; k++) full[io + k] = d.index[k] + vo;
        ranges.push(id, io, d.index.length);
        io += d.index.length; vo += nv;
      }
      old.dispose();
      g.pick.geometry.boundsTree = null;
      g.pick.geometry.dispose();
      const { geom, pick } = buildMeshes(pos, nrm, full);
      g.render.geometry = geom;
      g.pick = pick;
      g.full = full; g.vertexIds = vids; g.ranges = Uint32Array.from(ranges);
      g.baseY = null; g.levels = null; g.bvhDirty = false;
      if (this.levelColors) g.render.material.vertexColors = false; // barvy po podlažích nastaví volající znovu
    }
    this.#indexRanges();
    this.explodeDy = null;
    this.selBoxes = null;
    this.box.makeEmpty();
    for (const g of this.groups) this.box.union(g.render.geometry.boundingBox);
    if (this.levelOf) this.setLevels(this.levelOf);
    this.updateVisibility();
  }

  // meta z workeru: třídy, strom, plochý seznam prvků (přijde až po geometrii)
  setMeta(meta) {
    this.meta = meta || null;
    this.classOf = new Map();
    this.info = new Map(); // expressID → {c, name, guid}
    if (!meta) return;
    const e = meta.elements;
    for (let i = 0; i < e.ids.length; i++) {
      this.classOf.set(e.ids[i], e.cls[i]);
      this.info.set(e.ids[i], { c: e.cls[i], name: e.names[i], guid: e.guids[i], geo: !!e.geo[i] });
    }
  }

  get visible() { return this.object.visible; }
  set visible(v) { this.object.visible = v; }

  isShown(id) {
    if (this.hidden.has(id)) return false;
    if (this.isolated && !this.isolated.has(id)) return false;
    if (this.facetOff?.has(id)) return false;
    if (this.classOff.size) { const c = this.classOf.get(id); if (c != null && this.classOff.has(c)) return false; }
    return true;
  }

  // přepočet indexů podle viditelnosti (skrytí, izolace, třídy)
  updateVisibility() {
    const all = !this.hidden.size && !this.isolated && !this.classOff.size && !this.facetOff?.size;
    for (const g of this.groups) {
      const geom = g.render.geometry, arr = geom.index.array;
      if (all) { arr.set(g.full); geom.setDrawRange(0, g.full.length); geom.index.needsUpdate = true; continue; }
      let o = 0;
      const r = g.ranges;
      for (let i = 0; i < r.length; i += 3) {
        if (!this.isShown(r[i])) continue;
        arr.set(g.full.subarray(r[i + 1], r[i + 1] + r[i + 2]), o);
        o += r[i + 2];
      }
      geom.setDrawRange(0, o);
      geom.index.needsUpdate = true;
    }
  }

  // barva celého modelu (null = původní barvy z IFC)
  setColor(css) {
    this.override = css ? new THREE.Color(css) : null;
    for (const g of this.groups) {
      if (this.levelColors) continue; // barvy podle podlaží mají přednost, po vypnutí se použije override
      g.render.material.color.copy(this.override || g.color);
      g.render.material.needsUpdate = true;
    }
  }

  // zvýraznění vybraných prvků: další sítě se sdílenými vrcholy a indexem jen vybraných úseků
  setHighlight(ids, material) {
    // pozice a normály sdílí s modelem → před dispose() odpojit, jinak three.js smaže i jejich GPU buffer modelu
    // (model by se dál kreslil ze starého bufferu a posun při rozpadu podlaží by se u části prvků neprojevil)
    for (const m of this.highlight.children) {
      m.geometry.deleteAttribute('position');
      m.geometry.deleteAttribute('normal');
      m.geometry.dispose();
    }
    this.highlight.clear();
    if (!ids || !ids.size) return;
    const per = new Map();
    for (const id of ids) {
      for (const [gi, s, c] of this.ranges.get(id) || []) {
        if (!per.has(gi)) per.set(gi, []);
        per.get(gi).push([s, c]);
      }
    }
    for (const [gi, list] of per) {
      const g = this.groups[gi];
      const n = list.reduce((a, [, c]) => a + c, 0);
      const idx = new Uint32Array(n);
      let o = 0;
      for (const [s, c] of list) { idx.set(g.full.subarray(s, s + c), o); o += c; }
      const geom = new THREE.BufferGeometry();
      geom.setAttribute('position', g.render.geometry.getAttribute('position'));
      geom.setAttribute('normal', g.render.geometry.getAttribute('normal'));
      geom.setIndex(new THREE.BufferAttribute(idx, 1));
      const mesh = new THREE.Mesh(geom, material);
      mesh.renderOrder = 2;
      this.highlight.add(mesh);
    }
  }

  // ---------- rozpad po podlažích ----------
  // levelOf: Map expressID → pořadí podlaží (0 = nejnižší, prvky mimo podlaží 0). Vrcholy se posunou svisle
  // o level × dy přímo v poli pozic (sdílí ho vykreslení, výběr i zvýraznění) → výběr a měření sedí i rozložené.
  setLevels(levelOf) {
    this.levelOf = levelOf;
    for (const g of this.groups) {
      const n = g.vertexIds.length, lv = new Uint16Array(n);
      // uloženo jako pořadí + 1, 0 = prvek mimo podlaží (pozemek, terén) – kvůli barvení podle podlaží
      for (let i = 0; i < n; i++) { const l = levelOf.get(g.vertexIds[i]); lv[i] = l == null ? 0 : l + 1; }
      g.levels = lv;
    }
    this.explodeDy = null; // vynutí přepočet pozic z baseY při dalším explode() (změnily se úrovně)
  }

  explode(dy) {
    if (!this.levelOf || dy === this.explodeDy) return;
    this.explodeDy = dy;
    this.box.makeEmpty();
    for (const g of this.groups) {
      const pos = g.render.geometry.getAttribute('position'), a = pos.array;
      if (!g.baseY) { g.baseY = new Float32Array(a.length / 3); for (let i = 0; i < g.baseY.length; i++) g.baseY[i] = a[i * 3 + 1]; }
      const lv = g.levels, by = g.baseY;
      for (let i = 0; i < by.length; i++) a[i * 3 + 1] = by[i] + (lv[i] ? lv[i] - 1 : 0) * dy;
      pos.needsUpdate = true;
      g.render.geometry.computeBoundingBox();
      g.render.geometry.computeBoundingSphere();
      g.bvhDirty = true;
      this.box.union(g.render.geometry.boundingBox);
    }
    for (const m of this.highlight.children) { m.geometry.boundingSphere = null; m.geometry.boundingBox = null; }
  }

  // barvy podle podlaží (vizuální kontrola přiřazení): colors = pole CSS barev po podlažích (cyklicky),
  // other = barva prvků mimo podlaží; null = vypnout (zpět barvy z IFC / barva modelu)
  setLevelColors(colors, other) {
    this.levelColors = !!colors;
    const pal = colors ? colors.map((c) => new THREE.Color(c)) : null, oth = colors ? new THREE.Color(other) : null;
    for (const g of this.groups) {
      const geom = g.render.geometry, mat = g.render.material;
      if (pal && g.levels) {
        const lv = g.levels, col = new Float32Array(lv.length * 3);
        for (let i = 0; i < lv.length; i++) {
          const c = lv[i] ? pal[(lv[i] - 1) % pal.length] : oth;
          col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
        }
        geom.setAttribute('color', new THREE.BufferAttribute(col, 3));
        mat.vertexColors = true;
        mat.color.set(0xffffff);
      } else {
        geom.deleteAttribute('color');
        mat.vertexColors = false;
        mat.color.copy(this.override || g.color);
      }
      mat.needsUpdate = true;
    }
  }

  // přepočet BVH po rozpadu (volat po dokončení posunu – při tažení posuvníkem by to bylo zbytečně často)
  refitPick() {
    for (const g of this.groups) {
      if (!g.bvhDirty) continue;
      g.pick.geometry.boundsTree.refit();
      g.pick.geometry.computeBoundingSphere();
      g.bvhDirty = false;
    }
  }

  // obálka prvků (pro „přiblížit na výběr“)
  boxOf(ids) {
    const box = new THREE.Box3(), v = new THREE.Vector3();
    for (const id of ids) {
      for (const [gi, s, c] of this.ranges.get(id) || []) {
        const g = this.groups[gi], p = g.render.geometry.getAttribute('position');
        for (let i = s; i < s + c; i++) box.expandByPoint(v.fromBufferAttribute(p, g.full[i]));
      }
    }
    return box;
  }

  // všechny průsečíky paprsku s viditelnými prvky (seřazené podle vzdálenosti)
  raycast(raycaster, out) {
    if (!this.object.visible) return;
    this.refitPick();
    const hits = [];
    for (const g of this.groups) {
      g.pick.matrixWorld.copy(this.object.matrixWorld);
      g.pick.raycast(raycaster, hits);
      for (const h of hits) {
        const id = g.vertexIds[h.face.a];
        if (this.isShown(id)) out.push({ ...h, model: this, expressID: id });
      }
      hits.length = 0;
    }
  }

  dispose() {
    this.setHighlight(null);
    for (const g of this.groups) {
      g.render.geometry.dispose();
      g.render.material.dispose();
      g.pick.geometry.boundsTree = null;
      g.pick.geometry.dispose();
    }
  }
}
