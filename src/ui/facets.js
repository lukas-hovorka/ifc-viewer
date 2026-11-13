// IFC Viewer – filtry podle hodnot (záložky Atributy, Vlastnosti, Materiály, Patří do, Klasifikace).
// FacetStore: hodnoty ze všech modelů sloučené podle textu (index z workeru: dimenze → hodnota → prvky),
//   vypnuté hodnoty (off) a z nich skryté prvky po modelech.
// FacetList: virtualizovaný seznam jedné záložky (skupina → [vlastnost →] hodnota), zaškrtnutí = viditelnost,
//   klepnutí na název = výběr prvků, hledání.
// Pravidlo skrytí v jedné dimenzi (atribut, vlastnost, materiály, druh skupiny, klasifikační systém): prvek je skrytý,
// když jsou vypnuté všechny jeho hodnoty v dimenzi (prvek bez hodnoty patří do „(neuvedeno)“). Dimenze se sčítají.
const ROW = 28;
const ATTR_ORDER = ['Type', 'ObjectType', 'Name', 'PredefinedType', 'Tag', 'Description']; // typ a ObjectType nahoře – nejčastější filtr
const SEP = '\u0002', MISSING = '\u0000';
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const cmp = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' }).compare;

export class FacetStore {
  constructor() {
    this.off = new Set(); // "dimKey␂hodnota" (␀ = neuvedeno)
    this.dims = new Map(); // dimKey → {key, tab, group, sub, multi, values: [{label, key, items: [[model, ids]], n}], missing: [[model, count]], nMissing}
    this.models = [];
  }

  // models: IfcModel s .facets (pole dimenzí z workeru) – ostatní se přeskočí
  setModels(models) {
    this.models = models.filter((m) => Array.isArray(m.facets));
    const dims = new Map();
    for (const m of this.models) {
      const geoN = m.ranges.size;
      for (const d of m.facets) {
        const key = `${d.tab}\u0001${d.group}\u0001${d.sub}`;
        let D = dims.get(key);
        if (!D) dims.set(key, D = { key, tab: d.tab, group: d.group, sub: d.sub, multi: d.multi, vmap: new Map(), missing: [], nMissing: 0 });
        let union = 0;
        if (d.multi) { const u = new Set(); for (const [, ids] of d.values) for (const id of ids) u.add(id); union = u.size; }
        else for (const [, ids] of d.values) union += ids.length;
        for (const [label, ids] of d.values) {
          let V = D.vmap.get(label);
          if (!V) D.vmap.set(label, V = { label, key: key + SEP + label, items: [], n: 0 });
          V.items.push([m, ids]);
          V.n += ids.length;
        }
        if (geoN > union) { D.missing.push([m, geoN - union]); D.nMissing += geoN - union; }
      }
      // modely bez této dimenze: všechny jejich prvky jsou „neuvedeno“ (doplní se níže)
    }
    for (const D of dims.values()) {
      for (const m of this.models) {
        if (!D.missing.some(([x]) => x === m) && !m.facets.some((d) => `${d.tab}\u0001${d.group}\u0001${d.sub}` === D.key)) {
          D.missing.push([m, m.ranges.size]); D.nMissing += m.ranges.size;
        }
      }
      D.values = [...D.vmap.values()].sort((a, b) => cmp(a.label, b.label));
      D.missingKey = D.key + SEP + MISSING;
      delete D.vmap;
    }
    this.dims = dims;
  }

  tabDims(tab) { return [...this.dims.values()].filter((d) => d.tab === tab); }
  isOn(key) { return !this.off.has(key); }

  // skryté prvky modelu podle vypnutých hodnot (null = nic)
  hiddenFor(m) {
    let hidden = null;
    for (const D of this.dims.values()) {
      const missOff = D.nMissing && this.off.has(D.missingKey);
      if (!missOff && !D.values.some((v) => this.off.has(v.key))) continue;
      const shown = new Set(), all = missOff ? new Set() : null;
      for (const v of D.values) {
        const on = !this.off.has(v.key);
        for (const [x, ids] of v.items) if (x === m) { for (const id of ids) { if (on) shown.add(id); all?.add(id); } }
      }
      hidden ||= new Set();
      for (const v of D.values) {
        if (!this.off.has(v.key)) continue;
        for (const [x, ids] of v.items) if (x === m) for (const id of ids) if (!shown.has(id)) hidden.add(id);
      }
      if (missOff) for (const id of m.ranges.keys()) if (!all.has(id)) hidden.add(id);
    }
    return hidden;
  }

  // prvky hodnoty / celé dimenze → [{model, id}]
  items(v) { return v.items.flatMap(([m, ids]) => Array.from(ids, (id) => ({ model: m, id }))); }
  missingItems(D) {
    const out = [];
    for (const [m] of D.missing) {
      const all = new Set();
      for (const v of D.values) for (const [x, ids] of v.items) if (x === m) for (const id of ids) all.add(id);
      for (const id of m.ranges.keys()) if (!all.has(id)) out.push({ model: m, id });
    }
    return out;
  }
}

export class FacetList {
  // cb: {changed() – změnila se viditelnost, select(items, additive)}; labels(tab, group) → popisek skupiny
  constructor(host, store, tab, cb, T, labels) {
    Object.assign(this, { host, store, tab, cb, T, labels });
    this.open = new Set();
    this.query = '';
    this.rows = [];
    host.classList.add('ifc-tree', 'ifc-facets');
    host.setAttribute('role', 'tree');
    host.tabIndex = 0;
    this.spacer = document.createElement('div');
    this.spacer.className = 'ifc-tree__spacer';
    this.list = document.createElement('div');
    this.list.className = 'ifc-tree__rows';
    this.msg = document.createElement('p');
    this.msg.className = 'ifc-muted ifc-facets__msg';
    host.append(this.spacer, this.list, this.msg);
    host.addEventListener('scroll', () => this.paint());
    new ResizeObserver(() => this.paint()).observe(host);
    host.addEventListener('click', (e) => this.#click(e));
    host.addEventListener('contextmenu', (e) => this.#context(e));
  }

  setMessage(t) { this.msg.textContent = t || ''; this.msg.hidden = !t; }
  setQuery(q) { this.query = q.trim().toLowerCase(); this.refresh(); }

  // strom záložky: skupina (atribut / sada vlastností / druh skupiny / systém) → [vlastnost →] hodnoty
  #nodes() {
    const dims = this.store.tabDims(this.tab);
    const groups = new Map();
    for (const D of dims) {
      if (!groups.has(D.group)) groups.set(D.group, []);
      groups.get(D.group).push(D);
    }
    const out = [];
    const valueNodes = (D, depth) => {
      const vs = D.values.map((v) => ({ kind: 'value', key: v.key, label: v.label, n: v.n, depth, v, D }));
      if (D.nMissing) vs.push({ kind: 'value', key: D.missingKey, label: this.T('(neuvedeno)', '(not set)'), n: D.nMissing, depth, missing: true, D });
      return vs;
    };
    const order = [...groups.keys()].sort((a, b) => (this.tab === 'attrs' ? ATTR_ORDER.indexOf(a) - ATTR_ORDER.indexOf(b) : cmp(a, b)));
    for (const g of order) {
      const ds = groups.get(g).sort((a, b) => cmp(a.sub, b.sub));
      if (this.tab === 'mats') { out.push(...valueNodes(ds[0], 0)); continue; }
      const gn = { kind: 'group', key: `g:${g}`, label: this.labels(this.tab, g), depth: 0, kids: [] };
      if (this.tab === 'psets') {
        for (const D of ds) gn.kids.push({ kind: 'dim', key: `d:${D.key}`, label: D.sub, depth: 1, D, kids: valueNodes(D, 2) });
      } else gn.D = ds[0], gn.kids = valueNodes(ds[0], 1);
      out.push(gn);
    }
    return out;
  }

  refresh() {
    const q = this.query, rows = [];
    const has = (n) => n.label.toLowerCase().includes(q);
    const walk = (n, inherited) => {
      const hit = inherited || !q || has(n);
      if (!n.kids) { if (hit) rows.push(n); return; }
      const at = rows.length;
      rows.push(n);
      if (q) { const b = rows.length; for (const k of n.kids) walk(k, hit); if (rows.length === b && !hit) rows.length = at; }
      else if (this.open.has(n.key)) for (const k of n.kids) walk(k, false);
    };
    this.tree = this.#nodes();
    for (const n of this.tree) walk(n, false);
    this.rows = rows;
    this.spacer.style.height = `${rows.length * ROW}px`;
    if (!this.store.models.length) this.setMessage(null);
    else if (!this.tree.length) this.setMessage(this.T('Načtené modely tu nemají žádné údaje.', 'The loaded models have no data here.'));
    else if (!rows.length) this.setMessage(this.T('Nic nevyhovuje hledání.', 'Nothing matches the search.'));
    else this.setMessage(null);
    this.paint();
  }

  #leaves(n) { return n.kids ? n.kids.flatMap((k) => this.#leaves(k)) : [n]; }
  #state(n) {
    const ls = this.#leaves(n);
    let off = 0;
    for (const l of ls) if (this.store.off.has(l.key)) off++;
    return off === 0 ? 'on' : off === ls.length ? 'off' : 'mixed';
  }

  paint() {
    const h = this.host.clientHeight || 400;
    const first = Math.max(0, Math.floor(this.host.scrollTop / ROW) - 5);
    const last = Math.min(this.rows.length, Math.ceil((this.host.scrollTop + h) / ROW) + 5);
    let html = '';
    for (let i = first; i < last; i++) {
      const n = this.rows[i], st = this.#state(n);
      const twisty = n.kids ? `<span class="ifc-tree__twisty" data-act="twisty" aria-hidden="true">${this.query || this.open.has(n.key) ? '▾' : '▸'}</span>` : '<span class="ifc-tree__twisty"></span>';
      const cnt = n.kids ? `<span class="ifc-tree__cls">${n.kids.length.toLocaleString()}</span>` : `<span class="ifc-class__n">${n.n.toLocaleString()}</span>`;
      html += `<div class="ifc-tree__row${n.kids ? ' ifc-facets__head' : ''}${n.missing ? ' ifc-facets__missing' : ''}" role="treeitem" aria-level="${n.depth + 1}"${n.kids ? ` aria-expanded="${this.open.has(n.key)}"` : ''} data-i="${i}" style="top:${i * ROW}px;padding-left:${4 + n.depth * 14}px">`
        + twisty
        + `<label class="ebc-choice ifc-tree__vis" data-act="vis"><input type="checkbox" tabindex="-1"${st !== 'off' ? ' checked' : ''}${st === 'mixed' ? ' data-mixed' : ''} aria-label="${this.T('Zobrazit', 'Show')}"></label>`
        + `<span class="ifc-tree__label" title="${esc(n.label)}">${esc(n.label)}</span>${cnt}</div>`;
    }
    this.list.innerHTML = html;
    this.list.querySelectorAll('input[data-mixed]').forEach((x) => { x.indeterminate = true; });
  }

  #click(e) {
    const r = e.target.closest('.ifc-tree__row');
    if (!r) return;
    const n = this.rows[+r.dataset.i];
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'twisty' || (n.kids && !act && !e.target.closest('.ifc-tree__label'))) {
      if (this.open.has(n.key)) this.open.delete(n.key); else this.open.add(n.key);
      this.refresh();
      return;
    }
    if (act === 'vis') {
      e.preventDefault();
      const on = this.#state(n) !== 'on';
      for (const l of this.#leaves(n)) { if (on) this.store.off.delete(l.key); else this.store.off.add(l.key); }
      this.paint();
      this.cb.changed();
      return;
    }
    // název = výběr prvků (hodnota, celá vlastnost / skupina = prvky se všemi jejími hodnotami)
    this.cb.select(this.#items(n), e.ctrlKey || e.metaKey);
  }

  #items(n) {
    const items = [];
    for (const l of this.#leaves(n)) items.push(...(l.missing ? this.store.missingItems(l.D) : this.store.items(l.v)));
    return items;
  }

  // pravé tlačítko na řádku = prvky řádku → kontextová nabídka (izolovat, skrýt, přiblížit…)
  #context(e) {
    const r = e.target.closest('.ifc-tree__row');
    if (!r || !this.cb.context) return;
    e.preventDefault();
    this.cb.context(this.#items(this.rows[+r.dataset.i]), e.clientX, e.clientY);
  }

  setAll(on) {
    for (const n of this.tree || []) for (const l of this.#leaves(n)) { if (on) this.store.off.delete(l.key); else this.store.off.add(l.key); }
    this.paint();
    this.cb.changed();
  }
}
