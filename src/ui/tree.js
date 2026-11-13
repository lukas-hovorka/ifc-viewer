// IFC Viewer – strom prvků: prostorová struktura (model → projekt → stavba → podlaží → prvky → části)
// popsaná názvy nebo GlobalId (strom GUID), nebo plochý seznam podle GlobalId; hledání v názvu / GUID / třídě. Virtualizovaný (vykreslí jen viditelné řádky).
const ROW = 28;
// úroveň prostorové struktury podle třídy: 1 projekt, 2 pozemek, 3 stavba / zařízení, 4 podlaží / část, 5 ostatní
export function rank(n) {
  const c = n.cls || '';
  if (n.orphans) return 5;
  if (/Project$/.test(c)) return 1;
  if (/Site$/.test(c)) return 2;
  if (/(Storey|FacilityPart\w*)$/.test(c)) return 4;
  if (/(Building|Facility|Bridge|Road|Railway|MarineFacility|Tunnel)$/.test(c)) return 3;
  return 5;
}
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export class Tree {
  // host: element se scrollem; cb: {select(node, additive), zoom(node), toggle(node, show), state(node) → 'on'|'off'|'mixed', context(node, x, y)}
  constructor(host, cb, T) {
    this.host = host;
    this.cb = cb;
    this.T = T;
    this.showFiles = false; // false = strom začíná projektem (IfcProject), soubory jsou v záložce Soubory
    this.combine = false; // true = stejně pojmenované prostorové uzly všech modelů v jednom (croots)
    this.croots = [];
    this.mode = 'tree'; // 'tree' | 'guidtree' (strom popsaný GUID) | 'guid' (plochý seznam podle GUID)
    this.query = '';
    this.roots = []; // uzly modelů
    this.rows = [];
    this.selected = new Set(); // klíče uzlů "model:id"
    this.focusIdx = -1;
    host.classList.add('ifc-tree');
    host.setAttribute('role', 'tree');
    host.tabIndex = 0;
    this.spacer = document.createElement('div');
    this.spacer.className = 'ifc-tree__spacer';
    this.list = document.createElement('div');
    this.list.className = 'ifc-tree__rows';
    host.append(this.spacer, this.list);
    host.addEventListener('scroll', () => this.paint());
    new ResizeObserver(() => this.paint()).observe(host);
    host.addEventListener('click', (e) => this.#click(e));
    host.addEventListener('dblclick', (e) => { const n = this.#nodeAt(e); if (n) this.cb.zoom(n); });
    host.addEventListener('keydown', (e) => this.#key(e));
    host.addEventListener('contextmenu', (e) => {
      const r = e.target.closest('.ifc-tree__row');
      if (!r || !this.cb.context) return;
      e.preventDefault();
      this.focusIdx = +r.dataset.i;
      this.cb.context(this.rows[+r.dataset.i], e.clientX, e.clientY);
    });
  }

  // uzel: {key, model, id, c, name, cls, kids[], parent, depth, open, ids (prvky s geometrií pod uzlem – líně)}
  setModels(models) {
    const open = new Set(this.#all().filter((n) => n.open).map((n) => n.key));
    this.roots = models.filter((m) => m.meta).map((m) => {
      const root = { key: `${m.key}:model`, model: m, id: null, isModel: true, name: m.name, cls: m.schema, depth: 0, open: true, parent: null };
      const mk = (t, parent, depth) => {
        const n = {
          key: `${m.key}:${t.id || 'x'}`, model: m, id: t.id || null, c: t.c, depth, parent,
          name: t.orphans ? this.T('Nezařazené prvky', 'Unassigned elements') : t.n,
          cls: t.c >= 0 ? m.meta.classes[t.c] : '', open: false, orphans: !!t.orphans,
        };
        n.kids = t.k ? t.k.map((k) => mk(k, n, depth + 1)) : null;
        // výchozí: rozbaleno do úrovně podlaží (projekt → pozemek → stavba), prvky ne
        n.open = open.has(n.key) || (!!n.kids && rank(n) < 4);
        return n;
      };
      root.kids = m.meta.tree.map((t) => mk(t, root, 1));
      return root;
    });
    this.croots = this.combine ? this.#combine(open) : [];
    this.byKey = new Map(this.#all().map((n) => [n.key, n]));
    this.refresh();
  }

  // společný strom: projekt / pozemek / stavba / podlaží (a nezařazené prvky) se slučují podle úrovně a názvu
  // napříč modely (cesta od kořene), prvky pod nimi jsou kopie uzlů modelu se stejným klíčem "model:id"
  // → výběr ze scény, vlastnosti i hledání fungují beze změny. Sloučený uzel: {merged, members[], model: null}.
  #combine(open) {
    const tops = [], idx = new Map();
    const clone = (s, parent, depth) => {
      const n = { ...s, parent, depth };
      n.kids = s.kids ? s.kids.map((k) => clone(k, n, depth + 1)) : null;
      return n;
    };
    const into = (list, parent, depth, src, path) => {
      for (const s of src) {
        const r = rank(s);
        if (!s.orphans && r > 4) { list.push(clone(s, parent, depth)); continue; }
        const k = `${path}/${s.orphans ? '~' : `${r}|${(s.name || s.cls || '').trim().toLowerCase()}`}`;
        let m = idx.get(k);
        if (!m) {
          m = { key: `*${k}`, merged: true, members: [], model: null, id: null, name: s.name, cls: s.cls, orphans: s.orphans, depth, parent, kids: [], open: false };
          // známý uzel: jak byl; nový (první zapnutí, další model): výchozí rozbalení do podlaží
          m.open = this.mkeys?.has(m.key) ? open.has(m.key) : (!s.orphans && r < 4);
          idx.set(k, m);
          list.push(m);
        }
        m.members.push(s);
        if (s.kids) into(m.kids, m, depth + 1, s.kids, k);
      }
    };
    for (const r of this.roots) into(tops, null, 1, r.kids, '');
    for (const m of idx.values()) if (!m.kids.length) m.kids = null;
    this.mkeys = new Set([...idx.values()].map((m) => m.key));
    return tops;
  }

  #all() {
    const out = [];
    const walk = (n) => { out.push(n); n.kids?.forEach(walk); };
    (this.combine ? this.croots : this.roots)?.forEach(walk);
    return out;
  }

  setMode(mode) { this.mode = mode; this.refresh(); }
  setShowFiles(v) { this.showFiles = v; this.refresh(); }
  setCombine(v) {
    this.combine = v;
    this.mkeys = null;
    const models = this.roots.map((r) => r.model);
    this.roots = [];
    this.setModels(models);
  }

  // rozbalit do úrovně (1 projekt … 4 podlaží, 99 vše) – uzly nižší úrovně jsou vidět, ale sbalené
  expandTo(level) {
    for (const n of this.#all()) if (n.kids) n.open = n.isModel || rank(n) < level;
    this.refresh();
  }

  // rozbalit / sbalit celou větev pod uzlem
  setOpenDeep(node, open) {
    const walk = (n) => { if (n.kids) { n.open = open; n.kids.forEach(walk); } };
    walk(node);
    if (!open && node.isModel) node.open = true;
    this.refresh();
  }
  setQuery(q) { this.query = q.trim().toLowerCase(); this.refresh(); }

  // řádky k zobrazení podle režimu, rozbalení a hledání
  refresh() {
    const q = this.query;
    if (this.mode === 'guid' || q) {
      const rows = [];
      for (const m of this.roots) {
        const e = m.model.meta.elements;
        for (let i = 0; i < e.ids.length; i++) {
          if (this.mode === 'guid' && !e.geo[i] && !q) continue;
          const name = e.names[i], guid = e.guids[i], cls = e.cls[i] >= 0 ? m.model.meta.classes[e.cls[i]] : '';
          if (q && !(name.toLowerCase().includes(q) || guid.toLowerCase().includes(q) || cls.toLowerCase().includes(q) || String(e.ids[i]) === q)) continue;
          rows.push(this.byKey.get(`${m.model.key}:${e.ids[i]}`) || { key: `${m.model.key}:${e.ids[i]}`, model: m.model, id: e.ids[i], name, cls, depth: 0 });
        }
      }
      if (this.mode === 'guid') rows.sort((a, b) => (this.#guid(a) < this.#guid(b) ? -1 : this.#guid(a) > this.#guid(b) ? 1 : 0));
      this.rows = rows;
      this.flat = true;
    } else {
      const rows = [];
      const walk = (n) => { rows.push(n); if (n.open && n.kids) n.kids.forEach(walk); };
      if (this.combine) this.croots.forEach(walk);
      else this.roots.forEach((r) => (this.showFiles ? walk(r) : r.kids.forEach(walk)));
      this.rows = rows;
      this.flat = false;
    }
    this.spacer.style.height = `${this.rows.length * ROW}px`;
    this.paint();
  }

  #guid(n) { const x = n.merged ? n.members[0] : n; return x.model.info.get(x.id)?.guid || ''; }

  // počet zobrazených řádků (pro souhrn)
  get count() { return this.rows.length; }

  paint() {
    const h = this.host.clientHeight || 400;
    const first = Math.max(0, Math.floor(this.host.scrollTop / ROW) - 5);
    const last = Math.min(this.rows.length, Math.ceil((this.host.scrollTop + h) / ROW) + 5);
    let html = '';
    for (let i = first; i < last; i++) {
      const n = this.rows[i];
      const sel = this.selected.has(n.key) || (n.merged && n.members.some((x) => this.selected.has(x.key)));
      const st = this.cb.state(n);
      const pad = this.flat ? 8 : 4 + (n.depth - (this.showFiles && !this.combine ? 0 : 1)) * 14;
      const twisty = !this.flat && n.kids
        ? `<span class="ifc-tree__twisty" data-act="twisty" aria-hidden="true">${n.open ? '▾' : '▸'}</span>`
        : '<span class="ifc-tree__twisty"></span>';
      const name = n.isModel ? n.name : (n.name || n.cls || `#${n.id}`);
      const guid = !n.isModel && this.#guid(n);
      let label = esc(name), sub;
      if (this.mode === 'guidtree' && guid) {
        // strom GUID: GUID jako popisek, název (nebo třída) vpravo
        label = `<span class="ifc-tree__guid-main">${esc(guid)}</span>`;
        sub = `<span class="ifc-tree__cls">${esc(n.name || n.cls)}</span>`;
      } else if (this.mode === 'guid' && !n.isModel) sub = `<span class="ifc-tree__guid">${esc(guid)}</span>`;
      else sub = (n.isModel || (n.name && n.cls)) ? `<span class="ifc-tree__cls">${esc(n.cls)}</span>` : '';
      html += `<div class="ifc-tree__row${sel ? ' is-sel' : ''}${i === this.focusIdx ? ' is-focus' : ''}" role="treeitem" aria-level="${n.depth + 1}"${n.kids && !this.flat ? ` aria-expanded="${n.open}"` : ''} aria-selected="${sel}" data-i="${i}" style="top:${i * ROW}px;padding-left:${pad}px">`
        + twisty
        + `<label class="ebc-choice ifc-tree__vis" data-act="vis"><input type="checkbox" tabindex="-1"${st !== 'off' ? ' checked' : ''}${st === 'mixed' ? ' data-mixed' : ''} aria-label="${this.T('Zobrazit', 'Show')}"></label>`
        + `<span class="ifc-tree__label"${this.mode === 'guidtree' && guid ? ` title="${esc(name)}"` : ''}>${label}</span>${sub}</div>`;
    }
    this.list.innerHTML = html;
    this.list.querySelectorAll('input[data-mixed]').forEach((i) => { i.indeterminate = true; });
  }

  #nodeAt(e) {
    const r = e.target.closest('.ifc-tree__row');
    return r ? this.rows[+r.dataset.i] : null;
  }

  #click(e) {
    const r = e.target.closest('.ifc-tree__row');
    if (!r) return;
    const i = +r.dataset.i, n = this.rows[i];
    const act = e.target.closest('[data-act]')?.dataset.act;
    this.focusIdx = i;
    // Shift / Alt = celá větev najednou
    if (act === 'twisty') { if (e.shiftKey || e.altKey) this.setOpenDeep(n, !n.open); else { n.open = !n.open; this.refresh(); } return; }
    if (act === 'vis') { e.preventDefault(); this.cb.toggle(n, this.cb.state(n) !== 'on'); this.paint(); return; }
    this.cb.select(n, e.ctrlKey || e.metaKey);
  }

  #key(e) {
    if (!this.rows.length) return;
    let i = this.focusIdx < 0 ? 0 : this.focusIdx;
    const n = this.rows[i];
    if (e.key === 'ArrowDown') i = Math.min(this.rows.length - 1, i + 1);
    else if (e.key === 'ArrowUp') i = Math.max(0, i - 1);
    else if (e.key === 'ArrowRight' && n.kids && !this.flat) { if (!n.open) { n.open = true; this.refresh(); } else i++; }
    else if (e.key === 'ArrowLeft' && !this.flat) {
      if (n.open && n.kids) { n.open = false; this.refresh(); } else if (n.parent && this.rows.includes(n.parent)) i = this.rows.indexOf(n.parent);
    } else if (e.key === 'Enter') { this.cb.select(n, e.ctrlKey || e.metaKey); }
    else if (e.key === ' ') { this.cb.toggle(n, this.cb.state(n) !== 'on'); }
    else return;
    e.preventDefault();
    this.focusIdx = i;
    this.#scrollTo(i);
    this.paint();
  }

  #scrollTo(i) {
    const top = i * ROW, h = this.host.clientHeight;
    if (top < this.host.scrollTop) this.host.scrollTop = top;
    else if (top + ROW > this.host.scrollTop + h) this.host.scrollTop = top + ROW - h;
  }

  // výběr ze scény: označit, rozbalit předky a posunout na řádek
  reveal(keys) {
    this.selected = new Set(keys);
    const first = keys[0] && this.byKey?.get(keys[0]);
    if (first && !this.flat) {
      for (let p = first.parent; p; p = p.parent) p.open = true;
      this.refresh();
    }
    const i = this.rows.findIndex((n) => n.key === keys[0]);
    if (i >= 0) { this.focusIdx = i; this.#scrollTo(i); }
    this.paint();
  }
}

// sloučený uzel (společný strom) → [{model, id}] prvků s geometrií ze všech modelů
export function nodeItems(n) {
  if (!n.members) return nodeIds(n).map((id) => ({ model: n.model, id }));
  return n.members.flatMap((m) => nodeIds(m).map((id) => ({ model: m.model, id })));
}

// prvky s geometrií pod uzlem (vč. uzlu) – pro výběr / skrytí celé větve
export function nodeIds(n) {
  if (n._ids) return n._ids;
  const out = [];
  const walk = (x) => {
    if (x.id && x.model.ranges.has(x.id)) out.push(x.id);
    x.kids?.forEach(walk);
  };
  if (n.isModel) for (const id of n.model.ranges.keys()) out.push(id);
  else walk(n);
  n._ids = out;
  return out;
}
