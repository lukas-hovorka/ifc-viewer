// IFC Viewer – aplikace: načítání modelů, panely (soubory, struktura, třídy, vlastnosti), výběr, řezy, měření.
// Jádro (src/core) nemá závislost na DOM rozhraní → jde použít i v samostatné aplikaci nebo s jiným rozhraním.
import * as THREE from 'three';
import { IfcLoader } from './core/ifc-loader.js';
import { IfcModel } from './core/model.js';
import { Viewer } from './core/viewer.js';
import { Sections, Measure, deltaIfc } from './core/tools.js';
import { SectionHandles } from './core/section-handles.js';
import { Tree, nodeIds, nodeItems, rank } from './ui/tree.js';
import { FacetStore, FacetList } from './ui/facets.js';
import { T, LANG, esc } from './ui/i18n.js';
import * as gui from './ui/gui.js';
import { scene as sceneColors, initThemeToggle } from './ui/theme.js';

const $ = (id) => document.getElementById(id);
const ui = {
  viewport: $('viewport'), overlay: $('overlay'), panel: $('panel'), drop: $('drop'), loaded: $('loaded'), count: $('loaded-count'),
  tabs: { files: $('tab-files'), tree: $('tab-tree'), classes: $('tab-classes') },
  treeMode: $('tree-mode'), treeQ: $('tree-q'), tree: $('tree'), treeFoot: $('tree-foot'),
  treeLevels: $('tree-levels'), treeFiles: $('tree-files'), treeCombine: $('tree-combine'), ctx: $('ctx'), ctxTitle: $('ctx-title'), ctxSub: $('ctx-sub'),
  isolate: $('btn-isolate'), hide: $('btn-hide'), showAll: $('btn-showall'),
  classes: $('classes'), clsAll: $('cls-all'), clsNone: $('cls-none'), clsSum: $('cls-sum'),
  props: $('props'), propsBody: $('props-body'), propsClose: $('props-close'), propsZoom: $('props-zoom'), selCount: $('sel-count'),
  fit: $('btn-fit'), top: $('btn-top'), proj: $('btn-proj'), section: $('btn-section'), box: $('btn-box'), measure: $('btn-measure'), explode: $('btn-explode'),
  toolcard: $('toolcard'), merge: $('btn-merge'), mergeRow: $('merge-row'), cut: $('btn-cut'), cutRow: $('cut-row'), cutInfo: $('cut-info'), hint: $('hint'),
};
initThemeToggle($('theme')); // motiv před založením scény (scéna si bere barvy podle něj)
gui.init();

const viewer = new Viewer(ui.viewport);
const loader = new IfcLoader();
const models = new Map(); // klíč → {model: IfcModel|null, file, state, progress, error, color, custom}
let nextKey = 1;
let selection = []; // [{model, id}]

const fmtLen = (m) => `${m.toLocaleString(LANG, { minimumFractionDigits: 3, maximumFractionDigits: 3 })} m`;
let sectionHandles = null;
const sections = new Sections(viewer, () => { applyClipping(); sectionHandles?.sync(); });
// šipky řezu v modelu: při tažení se posuvníky v kartě jen posunou, po puštění se karta překreslí
sectionHandles = new SectionHandles(viewer, sections, (done) => { if (done) renderToolcard(); else syncSectionSliders(); });
function syncSectionSliders() {
  const r = ui.toolcard.querySelector('[data-act="sec-off-set"]');
  if (r && sections.plane) r.value = sections.plane.offset;
  if (sections.box) for (const i of ui.toolcard.querySelectorAll('[data-box]')) i.value = sections.box[i.dataset.end][i.dataset.box];
}
const measure = new Measure(viewer, ui.overlay, fmtLen, {
  vertex: T('vrchol', 'vertex'), mid: T('střed hrany', 'edge midpoint'), edge: T('hrana', 'edge'), face: T('plocha', 'face'),
});
viewer.on('theme', () => { sections.recolor(); sectionHandles.recolor(); if (levelColorsOn) { setLevelColors(true); renderToolcard(); } });

// ---------------- načítání ----------------
const queue = [];
let busy = false;

// mobil (Android / iOS): výběr souborů nezná příponu .ifc (nemá MIME typ) → s accept=".ifc" jsou soubory zašedlé
// nebo výběr z OneDrive / Disku selže; na dotykových zařízeních bez filtru, přípona se kontroluje tady
if (matchMedia('(pointer: coarse)').matches) $('file')?.removeAttribute('accept');
ui.drop.addEventListener('gui-files', (e) => {
  const ifc = (f) => /\.ifc$/i.test(f.name);
  const soubory = e.detail.files.filter(ifc), odmitnute = [...e.detail.rejected, ...e.detail.files.filter((f) => !ifc(f))];
  if (odmitnute.length) gui.toast(T(`Nejde o soubor IFC: ${odmitnute.map((f) => f.name).join(', ')}`, `Not an IFC file: ${odmitnute.map((f) => f.name).join(', ')}`), { type: 'warning' });
  for (const f of soubory) {
    const key = String(nextKey++);
    models.set(key, { key, file: f, model: null, state: 'nacitani', progress: null, color: null });
    queue.push(key);
  }
  renderFiles();
  pump();
});

async function pump() {
  if (busy) return;
  const key = queue.shift();
  if (!key) return;
  busy = true;
  const entry = models.get(key);
  try {
    // OneDrive / síťový disk: soubor „jen online“ může přijít prázdný nebo nečitelný (NotReadableError)
    if (!entry.file.size) throw Object.assign(new Error('empty'), { name: 'NotReadableError' });
    const buf = await entry.file.arrayBuffer();
    if (!models.has(key)) return; // zrušeno během čtení
    const t0 = performance.now();
    const meta = await loader.open(key, buf, {
      onProgress: (done, total) => { entry.progress = (done / total) * 100; renderFiles(); },
      onGeometry: (geo) => {
        if (!models.has(key)) return;
        entry.model = new IfcModel(key, entry.file.name, geo, null);
        entry.model.setColor(entry.color);
        entry.model.uncut = geo.uncut || [];
        // otvory skryté hned (třídy přijdou až se strukturou) – dočasná třída -2
        if (geo.openings?.length && classOff.has(OPENING)) {
          for (const id of geo.openings) entry.model.classOf.set(id, -2);
          entry.model.classOff = new Set([-2]);
          entry.model.updateVisibility();
        }
        if (entry.model.uncut.length) {
          const k = entry.model.uncut.length, most = Math.max(...entry.model.uncut.map((u) => u[1]));
          gui.toast(T(`${entry.file.name}: ${k} ${k === 1 ? 'prvek má' : k < 5 ? 'prvky mají' : 'prvků má'} desítky až stovky otvorů (nejvíc ${most}) – ${k === 1 ? 'zobrazuje' : 'zobrazují'} se bez vyříznutých otvorů, jinak by načítání trvalo i desítky minut. Vyříznout je jde tlačítkem v panelu Modely.`,
            `${entry.file.name}: ${k} element${k === 1 ? ' has' : 's have'} dozens to hundreds of openings (up to ${most}) – shown without cut openings, otherwise loading could take tens of minutes. They can be cut with the button in the Models panel.`), { type: 'info', duration: 12000 });
        }
        viewer.models.add(entry.model.object);
        entry.progress = null;
        renderFiles();
        onModelsChanged(models.size === 1 || [...models.values()].filter((m) => m.model).length === 1);
      },
    });
    if (!models.has(key)) { loader.close(key); return; }
    entry.model.setMeta(meta);
    classFilter(entry.model); // vypnuté třídy platí i pro nově načtený model
    entry.model.updateVisibility();
    storeyInfo(entry.model);
    relevel();
    entry.state = null;
    entry.time = performance.now() - t0;
    renderFiles();
    onModelsChanged(false);
  } catch (err) {
    console.error(err);
    entry.state = 'chyba';
    entry.error = err?.name === 'NotReadableError'
      ? T('Soubor nejde přečíst – je nejspíš jen online (OneDrive, síťový disk). Ve složce na něj klepněte pravým tlačítkem → „Vždy zachovat na tomto zařízení“, počkejte na stažení a otevřete ho znovu.',
        'The file cannot be read – it is probably online-only (OneDrive, network drive). Right-click it in the folder → “Always keep on this device”, wait for the download and open it again.')
      : T('Soubor se nepodařilo načíst: ', 'The file could not be loaded: ') + err.message;
    renderFiles();
  } finally {
    busy = false;
    pump();
  }
}

function removeModel(key) {
  const e = models.get(key);
  if (!e) return;
  models.delete(key);
  const qi = queue.indexOf(key);
  if (qi >= 0) queue.splice(qi, 1);
  if (e.model) {
    viewer.models.remove(e.model.object);
    e.model.dispose();
    loader.close(key);
  }
  selection = selection.filter((s) => s.model.key !== key);
  relevel();
  if (explodeOn) renderToolcard();
  renderFiles();
  onModelsChanged(false);
  applySelection();
}

// počet prvků s geometrií (bez otvorů)
function countElements(meta) {
  const e = meta.elements, op = meta.classes.indexOf(OPENING);
  let n = 0;
  for (let i = 0; i < e.ids.length; i++) if (e.geo[i] && e.cls[i] !== op) n++;
  return n;
}
function renderFiles() {
  ui.loaded.replaceChildren(...[...models.values()].map((e) => {
    const m = e.model;
    const n = m?.meta ? countElements(m.meta) : null;
    return gui.fileRow({
      id: e.key, name: e.file.name, size: e.file.size,
      meta: m ? [m.schema, n != null ? T(`${n.toLocaleString(LANG)} prvků`, `${n.toLocaleString(LANG)} elements`) : T('načítá se struktura…', 'loading structure…'),
        m.uncut?.length ? T(`${m.uncut.length} bez otvorů`, `${m.uncut.length} without openings`) : ''].filter(Boolean).join(' · ') : '',
      color: e.color || '', visible: m ? m.visible : true,
      state: e.state === 'chyba' ? 'error' : e.state === 'nacitani' && !m ? 'loading' : null,
      percent: e.progress, error: e.error,
    });
  }));
  const ok = [...models.values()].filter((e) => e.model).length;
  ui.count.hidden = !ok;
  ui.count.textContent = ok;
  ui.mergeRow.hidden = [...models.values()].filter((e) => e.model?.meta).length < 2;
  renderCutRow();
}

// ---------------- vyříznutí otvorů na tlačítko ----------------
// Prvky s desítkami až stovkami otvorů se při načtení zobrazí bez nich (limitVoids ve workeru). Na tlačítko se otvory
// vyříznou v samostatném workeru (three-bvh-csg) a geometrie prvků v modelu se vymění. Trvá desítky sekund až minuty
// a přidá trojúhelníky (u desky se 766 otvory z ~0,1 na ~1,4 mil.) – proto jen na vyžádání.
let csgWorker = null, cutting = null; // cutting = {done, total}
function cutCandidates() { return loadedModels().filter((m) => m.meta && m.uncut?.length); }
function renderCutRow() {
  const list = cutCandidates();
  ui.cutRow.hidden = !list.length && !cutting;
  ui.cut.disabled = !!cutting;
  ui.cut.setAttribute('aria-busy', String(!!cutting));
  if (cutting) { ui.cutInfo.textContent = T(`Vyřezávám otvory… ${cutting.done} / ${cutting.total} prvků`, `Cutting openings… ${cutting.done} / ${cutting.total} elements`); return; }
  const n = list.reduce((a, m) => a + m.uncut.length, 0), o = list.reduce((a, m) => a + m.uncut.reduce((b, u) => b + u[1], 0), 0);
  ui.cutInfo.textContent = T(`${n} ${n === 1 ? 'prvek je' : n < 5 ? 'prvky jsou' : 'prvků je'} zobrazeno bez vyříznutých otvorů (${o.toLocaleString(LANG)} otvorů). Vyříznutí trvá sekundy až minuty a přidá trojúhelníky. U prvků zadaných jen plochami (ne uzavřeným tělesem) může být výsledek nepřesný.`,
    `${n} element${n === 1 ? ' is' : 's are'} shown without cut openings (${o.toLocaleString(LANG)} openings). Cutting takes seconds to minutes and adds triangles. For elements defined only by surfaces (not a closed solid) the result may be inaccurate.`);
}
ui.cut.addEventListener('click', async () => {
  const list = cutCandidates();
  if (!list.length || cutting) return;
  csgWorker ||= new Worker(new URL('./core/csg-worker.js', import.meta.url), { type: 'module' });
  const run = (msg) => new Promise((resolve) => {
    csgWorker.onmessage = (e) => resolve(e.data);
    csgWorker.onerror = (e) => resolve({ error: e.message || 'worker' });
    csgWorker.postMessage(msg, [msg.host.pos.buffer, msg.host.index.buffer, ...msg.holes.flatMap((h) => [h.pos.buffer, h.index.buffer])]);
  });
  cutting = { done: 0, total: list.reduce((a, m) => a + m.uncut.length, 0) };
  renderCutRow();
  const t0 = performance.now();
  let failed = 0;
  for (const m of list) {
    // otvory hostitele = potomci ve stromu se třídou IfcOpeningElement
    const op = m.meta.classes.indexOf(OPENING), hosts = new Map(m.uncut.map(([h]) => [h, []]));
    const walk = (n) => { if (hosts.has(n.id)) for (const k of n.k || []) if (k.c === op) hosts.get(n.id).push(k.id); n.k?.forEach(walk); };
    m.meta.tree.forEach(walk);
    const rep = new Map(), left = [];
    for (const [h, holes] of hosts) {
      const r = holes.length && m.ranges.has(h) ? await run({ job: h, host: m.extract([h]), holes: m.extract(holes, true) }) : { error: 'bez otvorů' };
      if (r.error) { failed++; left.push(m.uncut.find((u) => u[0] === h)); console.warn('vyříznutí otvorů', h, r.error); } else rep.set(h, r);
      cutting.done++;
      renderCutRow();
    }
    if (!models.has(m.key) || !rep.size) { m.uncut = left; continue; }
    m.replaceElements(rep);
    m.uncut = left;
  }
  cutting = null;
  relevel();
  applySelection(false);
  viewer.requestRender();
  renderFiles();
  const s = Math.round((performance.now() - t0) / 1000);
  gui.toast(failed
    ? T(`Otvory vyříznuty za ${s} s, u ${failed} prvků se to nepodařilo (zůstávají bez otvorů).`, `Openings cut in ${s} s, ${failed} elements failed (left without openings).`)
    : T(`Otvory vyříznuty za ${s} s.`, `Openings cut in ${s} s.`), { type: failed ? 'warning' : 'success' });
});

// ---------------- sloučení do jednoho IFC (zobrazené modely, v pořadí seznamu) ----------------
let mergeWorker = null;
const MERGE_CONFIRM = { title: T('Uložit sloučené IFC?', 'Save merged IFC?'), ok: T('Uložit', 'Save') };
ui.merge.addEventListener('click', async () => {
  const list = [...models.values()].filter((e) => e.model?.meta && e.model.visible);
  const toast = (t, type = 'warning', duration) => gui.toast(t, { type, duration });
  if (list.length < 2) return toast(T('Ke sloučení jsou potřeba aspoň dva zobrazené modely.', 'At least two shown models are needed to merge.'));
  const scales = new Set(list.map((e) => e.model.meta.lengthScale));
  // stejné GUID ve více modelech (např. stejný soubor dvakrát) – výsledek by nebyl platný; projekt se slučuje, ten nevadí
  const seen = new Set();
  let dup = 0;
  for (const e of list) {
    const { meta } = e.model, el = meta.elements;
    for (let i = 0; i < el.guids.length; i++) {
      const g = el.guids[i];
      if (!g || meta.classes[el.cls[i]] === 'IfcProject') continue;
      if (seen.has(g)) dup++; else seen.add(g);
    }
  }
  if (dup && !(await gui.confirmDialog(T(`${dup.toLocaleString(LANG)} prvků má stejné GUID ve více modelech (není některý model načtený dvakrát?). Sloučený soubor pak nebude platný. Přesto uložit?`,
    `${dup.toLocaleString(LANG)} elements share a GUID across models (is a model loaded twice?). The merged file will not be valid. Save anyway?`), MERGE_CONFIRM))) return;
  if (scales.size > 1 && !(await gui.confirmDialog(T('Modely mají různé délkové jednotky (např. mm a m). Sloučený soubor převezme jednotky prvního modelu, takže ostatní budou v jiných aplikacích ve špatném měřítku. Přesto uložit?',
    'The models use different length units (e.g. mm and m). The merged file takes the units of the first model, so the others will be at the wrong scale in other applications. Save anyway?'), MERGE_CONFIRM))) return;
  const base = list[0].file.name.replace(/\.ifc$/i, '');
  const name = `${base}${T('_slouceno', '_merged')}.ifc`;
  ui.merge.disabled = true;
  ui.merge.setAttribute('aria-busy', 'true');
  try {
    const files = await Promise.all(list.map(async (e) => ({ name: e.file.name, buffer: await e.file.arrayBuffer() })));
    mergeWorker ||= new Worker(new URL('./core/merge-worker.js', import.meta.url), { type: 'module' });
    const res = await new Promise((resolve) => {
      mergeWorker.onmessage = (ev) => { if (ev.data.type !== 'progress') resolve(ev.data); };
      mergeWorker.onerror = (ev) => resolve({ type: 'error', code: 'other', detail: ev.message });
      mergeWorker.postMessage({ files, name, app: 'IFC Viewer' }, files.map((f) => f.buffer));
    });
    if (res.type === 'error') {
      const msg = {
        schema: T('Modely mají různé schéma IFC – sloučit jde jen stejné schéma: ', 'The models use different IFC schemas – only the same schema can be merged: '),
        noproject: T('Soubor nemá IfcProject: ', 'The file has no IfcProject: '),
        projects: T('Soubor má víc než jeden IfcProject: ', 'The file has more than one IfcProject: '),
        notstep: T('Soubor není platný zápis STEP: ', 'The file is not valid STEP: '),
      }[res.code] || T('Sloučení se nepodařilo: ', 'Merging failed: ');
      return toast(msg + res.detail, 'danger', 0);
    }
    const url = URL.createObjectURL(new Blob([res.bytes], { type: 'application/x-step' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: name });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    toast(T(`Uloženo: ${name} (${res.count} ${res.count < 5 ? 'modely' : 'modelů'}, ${res.schema})`, `Saved: ${name} (${res.count} models, ${res.schema})`), 'success');
  } catch (err) {
    console.error(err);
    toast(T('Sloučení se nepodařilo: ', 'Merging failed: ') + err.message, 'danger', 0);
  } finally {
    ui.merge.disabled = false;
    ui.merge.removeAttribute('aria-busy');
  }
});

ui.loaded.addEventListener('gui-file', (e) => {
  const { id, action, value } = e.detail;
  const entry = models.get(id);
  if (!entry) return;
  if (action === 'remove') return removeModel(id);
  if (!entry.model) return;
  if (action === 'visible') { entry.model.visible = value; tree.paint(); viewer.requestRender(); }
  else if (action === 'color') { entry.color = value || null; entry.model.setColor(entry.color); renderFiles(); viewer.requestRender(); }
  else if (action === 'select') zoomTo(entry.model.box);
});

function loadedModels() { return [...models.values()].map((e) => e.model).filter(Boolean); }

function visibleBox() {
  const box = new THREE.Box3();
  for (const m of loadedModels()) if (m.visible) box.union(m.box);
  return box;
}

function onModelsChanged(first) {
  const list = loadedModels();
  const any = list.length > 0;
  const withMeta = list.some((m) => m.meta);
  for (const b of [ui.fit, ui.top, ui.proj, ui.section, ui.box, ui.measure]) b.disabled = !any;
  ui.explode.disabled = !withMeta;
  ui.tabs.tree.disabled = ui.tabs.classes.disabled = !withMeta;
  document.querySelectorAll('[data-facet-tab]').forEach((t) => { t.disabled = !withMeta; });
  refreshFacets();
  ui.panel.toggleAttribute('data-has-models', any);
  const all = new THREE.Box3();
  for (const m of list) all.union(m.box);
  sections.bounds.copy(all);
  viewer.setGround(any ? all : null);
  if (first && any) viewer.fit(all);
  tree.setModels(list);
  renderClasses();
  updateFoot();
  applyClipping();
  viewer.requestRender();
}

// ---------------- šířka levého panelu (tažení pravého okraje, šipky, dvojklik = výchozí; pamatuje se v prohlížeči) ----------------
{
  const grip = $('panel-resize'), KEY = 'ifcviewer.panelW';
  const clampW = (w) => Math.round(Math.min(Math.max(w, 280), Math.max(320, Math.min(900, innerWidth * 0.7))));
  const setW = (w, save = true) => {
    if (w == null) ui.panel.style.removeProperty('width'); else ui.panel.style.width = `${clampW(w)}px`;
    sync();
    if (save) try { if (w == null) localStorage.removeItem(KEY); else localStorage.setItem(KEY, String(clampW(w))); } catch { /* bez úložiště */ }
  };
  try { const w = +localStorage.getItem(KEY); if (w) setW(w, false); } catch { /* bez úložiště */ }
  // úchop je vedle panelu (panel ořezává přesah) → poloha podle panelu
  function sync() {
    const p = ui.panel;
    Object.assign(grip.style, { left: `${p.offsetLeft + p.offsetWidth - 4}px`, top: `${p.offsetTop}px`, height: `${p.offsetHeight}px` });
  }
  new ResizeObserver(sync).observe(ui.panel);
  new MutationObserver(sync).observe(ui.panel, { attributes: true, attributeFilter: ['data-collapsed', 'data-has-models', 'hidden'] });
  sync();
  grip.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    grip.setPointerCapture(e.pointerId);
    grip.classList.add('is-drag');
    const x0 = e.clientX, w0 = ui.panel.getBoundingClientRect().width;
    const move = (ev) => setW(w0 + ev.clientX - x0, false);
    const up = () => {
      grip.removeEventListener('pointermove', move);
      grip.classList.remove('is-drag');
      setW(ui.panel.getBoundingClientRect().width);
    };
    grip.addEventListener('pointermove', move);
    grip.addEventListener('pointerup', up, { once: true });
    grip.addEventListener('pointercancel', up, { once: true });
  });
  grip.addEventListener('dblclick', () => setW(null));
  grip.addEventListener('keydown', (e) => {
    const d = e.key === 'ArrowRight' ? 20 : e.key === 'ArrowLeft' ? -20 : 0;
    if (!d) return;
    e.preventDefault();
    setW(ui.panel.getBoundingClientRect().width + d);
  });
  addEventListener('resize', () => { if (ui.panel.style.width) setW(parseFloat(ui.panel.style.width), false); else sync(); });
}

// ---------------- záložky panelu ----------------
ui.panel.querySelector('[role="tablist"]').addEventListener('click', (e) => {
  const tab = e.target.closest('[role="tab"]');
  if (!tab || tab.disabled) return;
  setTimeout(() => { if (tab === ui.tabs.tree) tree.paint(); }, 0);
});

// ---------------- strom ----------------
function selectNode(n, additive) {
  if (n.merged) { // společný strom: prvky ze všech modelů, vlastnosti prvního
    const f = n.members[0];
    selectItems(nodeItems(n), additive, f.id && !f.model.ranges.has(f.id) ? { model: f.model, id: f.id } : null, false);
    return;
  }
  const ids = n.isModel ? [] : (n.id && n.model.ranges.has(n.id) ? [n.id] : nodeIds(n));
  const items = ids.map((id) => ({ model: n.model, id }));
  // uzel bez geometrie (podlaží, stavba) → vybere prvky pod ním, vlastnosti ukáže pro uzel sám
  selectItems(items, additive, n.id && !n.model.ranges.has(n.id) ? { model: n.model, id: n.id } : null, false);
}
const tree = new Tree(ui.tree, {
  select: selectNode,
  context(n, x, y) {
    // pravé tlačítko na nevybraném řádku = nejdřív ho vybrat (jako v průzkumníku souborů)
    if (!tree.selected.has(n.key)) selectNode(n, false);
    openContext({ node: n, x, y });
  },
  zoom(n) {
    if (n.merged) { const b = new THREE.Box3(); for (const x of n.members) b.union(x.model.boxOf(nodeIds(x))); return zoomTo(b); }
    zoomTo(n.isModel ? n.model.box : n.model.boxOf(nodeIds(n)));
  },
  toggle(n, show) {
    if (n.merged) { for (const x of n.members) this.toggle(x, show); return; }
    const m = n.model;
    if (n.isModel) { m.visible = show; renderFiles(); }
    else {
      for (const id of nodeIds(n)) { if (show) m.hidden.delete(id); else m.hidden.add(id); }
      m.updateVisibility();
    }
    updateFoot();
    viewer.requestRender();
  },
  state(n) {
    if (n.merged) { const st = new Set(n.members.map((x) => this.state(x))); return st.size === 1 ? [...st][0] : 'mixed'; }
    const m = n.model;
    if (n.isModel) return m.visible ? (m.hidden.size ? 'mixed' : 'on') : 'off';
    if (!m.visible) return 'off';
    const ids = nodeIds(n);
    if (!ids.length) return 'on';
    let h = 0;
    for (const id of ids) if (m.hidden.has(id)) h++;
    return h === 0 ? 'on' : h === ids.length ? 'off' : 'mixed';
  },
}, T);

ui.treeMode.addEventListener('click', (e) => {
  const b = e.target.closest('button[data-value]');
  if (!b) return;
  ui.treeMode.querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
  tree.setMode(b.dataset.value);
  updateFoot();
});
ui.treeLevels.addEventListener('click', (e) => {
  const b = e.target.closest('[data-level]');
  if (b) tree.expandTo(+b.dataset.level);
});
ui.treeFiles.addEventListener('change', () => tree.setShowFiles(ui.treeFiles.checked));
ui.treeCombine.addEventListener('change', () => {
  tree.setCombine(ui.treeCombine.checked);
  ui.treeFiles.disabled = ui.treeCombine.checked; // ve společném stromu soubory nejsou
  tree.reveal(selection.map((s) => `${s.model.key}:${s.id}`));
});
let qTimer;
ui.treeQ.addEventListener('input', () => { clearTimeout(qTimer); qTimer = setTimeout(() => { tree.setQuery(ui.treeQ.value); updateFoot(); }, 150); });

function updateFoot() {
  const list = loadedModels();
  const hidden = list.reduce((a, m) => a + m.hidden.size, 0);
  const iso = list.some((m) => m.isolated);
  const parts = [];
  if (tree.query || tree.mode === 'guid') parts.push(T(`${tree.count.toLocaleString(LANG)} položek`, `${tree.count.toLocaleString(LANG)} items`));
  if (hidden) parts.push(T(`skryto ${hidden.toLocaleString(LANG)}`, `${hidden.toLocaleString(LANG)} hidden`));
  if (iso) parts.push(T('izolováno', 'isolated'));
  ui.treeFoot.textContent = parts.join(' · ');
  ui.treeFoot.hidden = !parts.length;
}

ui.isolate.addEventListener('click', () => {
  const by = groupSel();
  for (const m of loadedModels()) { m.isolated = by.has(m) ? new Set(by.get(m)) : new Set(); m.updateVisibility(); }
  updateFoot(); tree.paint(); viewer.requestRender();
});
ui.hide.addEventListener('click', () => {
  for (const [m, ids] of groupSel()) { ids.forEach((id) => m.hidden.add(id)); m.updateVisibility(); }
  selectItems([], false);
  updateFoot(); tree.paint(); viewer.requestRender();
});
ui.showAll.addEventListener('click', showAll);
function showAll() {
  for (const m of loadedModels()) { m.hidden.clear(); m.isolated = null; m.visible = true; m.updateVisibility(); }
  renderFiles(); updateFoot(); tree.paint(); viewer.requestRender();
}

function hideAll() {
  for (const m of loadedModels()) { m.isolated = null; m.hidden = new Set(m.ranges.keys()); m.updateVisibility(); }
  selectItems([], false);
  updateFoot(); tree.paint(); viewer.requestRender();
}
// obrátit viditelnost prvků (skryté ↔ zobrazené; izolace se převede na skrytí)
function invertVisibility() {
  for (const m of loadedModels()) {
    const shown = [...m.ranges.keys()].filter((id) => !m.hidden.has(id) && (!m.isolated || m.isolated.has(id)));
    m.isolated = null; m.hidden = new Set(shown); m.updateVisibility();
  }
  selectItems([], false);
  updateFoot(); tree.paint(); viewer.requestRender();
}
function showItems(items) {
  for (const { model: m, id } of items) { m.hidden.delete(id); m.isolated?.add(id); }
  for (const m of loadedModels()) m.updateVisibility();
  updateFoot(); tree.paint(); viewer.requestRender();
}

// ---------------- kontextová nabídka (pravé tlačítko ve stromu i ve scéně) ----------------
let ctxFor = null; // {node?, items, cls}
function openContext({ node = null, x, y }) {
  const items = selection.slice();
  const one = propsFor || items[items.length - 1];
  const inf = one ? one.model.info.get(one.id) : null;
  // izolovat třídu jen u prvku s geometrií (místnosti apod. ve filtru tříd nejsou → skrylo by se vše)
  const cls = inf && inf.geo && inf.c >= 0 && one.model.meta ? one.model.meta.classes[inf.c] : '';
  ctxFor = { node, items, cls };
  const has = items.length > 0;
  // bez uzlu stromu: podle skrytých prvků výběru (skrýt / zobrazit)
  const hid = items.filter((s) => s.model.hidden.has(s.id)).length;
  const vis = node ? tree.cb.state(node) : hid === 0 ? 'on' : hid === items.length ? 'off' : 'mixed';
  const show = (k, v) => { ui.ctx.querySelector(k.endsWith('-more') ? `[data-ctx-more="${k.slice(0, -5)}"]` : `[data-ctx="${k}"]`).hidden = !v; };
  show('zoom', has); show('isolate', has); show('hide', has && vis !== 'off'); show('show', has && vis !== 'on');
  show('isolate-more', has); show('hide-more', has);
  closeSub();
  show('expand', !!node?.kids); show('collapse', !!node?.kids);
  ui.ctx.querySelectorAll('.ebc-menu__sep').forEach((s) => { s.hidden = false; });
  ui.ctx.querySelector('.ebc-menu__sep').hidden = !node?.kids;
  ui.ctx.querySelector('[data-ctx-tree]').hidden = !has;
  ui.ctxTitle.textContent = items.length > 1 ? T(`Vybráno ${items.length} prvků`, `${items.length} elements selected`)
    : (node ? (node.name || node.cls) : (inf?.name || cls || T('Model', 'Model')));
  ui.ctx.style.left = '0px'; ui.ctx.style.top = '0px';
  ui.ctx.showPopover();
  const r = ui.ctx.getBoundingClientRect();
  ui.ctx.style.left = `${Math.min(x, innerWidth - r.width - 8)}px`;
  ui.ctx.style.top = `${y + r.height > innerHeight - 8 ? Math.max(8, y - r.height) : y}px`;
}
// ---- Izolovat více / Skrýt více: podnabídka hodnot vybraných prvků ----
// Položky: třída a hodnoty z indexu filtrů (atributy, materiály, patří do, klasifikace, vlastnosti), které mají
// vybrané prvky. Volba = všechny prvky (ve všech modelech) se stejnou hodnotou – víc hodnot ve výběru = kterákoli.
// Index hodnot se počítá ve workeru až na vyžádání (u velkých modelů sekundy) – mezitím jen třída a „načítá se“.
let subMode = null; // 'isolate' | 'hide'
function closeSub() {
  subMode = null;
  ui.ctxSub.classList.remove('is-open');
  ui.ctx.querySelectorAll('[data-ctx-more]').forEach((b) => b.setAttribute('aria-expanded', 'false'));
}
function subEntries(items) {
  const sel = new Map(); // model → Set id
  for (const { model: m, id } of items) { if (!sel.has(m)) sel.set(m, new Set()); sel.get(m).add(id); }
  const out = [];
  // třída
  const cls = new Set();
  for (const [m, ids] of sel) for (const id of ids) { const c = m.info.get(id)?.c; if (c != null && c >= 0) cls.add(m.meta.classes[c]); }
  if (cls.size) {
    const list = [...cls];
    out.push({ sec: T('Třída', 'Class'), label: list.length === 1 ? list[0] : T(`${list.length} ${list.length < 5 ? 'třídy' : 'tříd'}`, `${list.length} classes`), title: list.join(', '),
      items: () => loadedModels().filter((m) => m.meta).flatMap((m) => {
        const ci = new Set(list.map((c) => m.meta.classes.indexOf(c)).filter((i) => i >= 0)), el = m.meta.elements, r = [];
        for (let i = 0; i < el.ids.length; i++) if (ci.has(el.cls[i]) && m.ranges.has(el.ids[i])) r.push({ model: m, id: el.ids[i] });
        return r;
      }) });
  }
  // hodnoty z indexu filtrů
  const SEC = { attrs: T('Atributy', 'Attributes'), mats: T('Materiály', 'Materials'), groups: T('Patří do', 'Part of'), classif: T('Klasifikace', 'Classification'), psets: T('Vlastnosti', 'Properties') };
  const order = ['attrs', 'mats', 'groups', 'classif', 'psets'];
  const dims = [...facetStore.dims.values()].sort((a, b) => order.indexOf(a.tab) - order.indexOf(b.tab)
    || (a.tab === 'attrs' ? ATTR_RANK(a.group) - ATTR_RANK(b.group) : 0) || String(a.group).localeCompare(b.group) || String(a.sub).localeCompare(b.sub));
  for (const D of dims) {
    const vals = D.values.filter((v) => v.items.some(([m, ids]) => { const s = sel.get(m); if (!s) return false; for (const id of ids) if (s.has(id)) return true; return false; }));
    if (!vals.length) continue;
    const name = D.tab === 'attrs' ? (FACET_LABELS.attrs[D.group] || D.group) : D.tab === 'psets' ? `${D.group} · ${D.sub}` : D.tab === 'mats' ? '' : D.group;
    const val = vals.length === 1 ? vals[0].label : T(`${vals.length} ${vals.length < 5 ? 'hodnoty' : 'hodnot'}`, `${vals.length} values`);
    out.push({ sec: SEC[D.tab], key: name, label: val, title: vals.map((v) => v.label).join(', '), items: () => vals.flatMap((v) => facetStore.items(v)) });
  }
  return out;
}
const ATTR_RANK = (g) => { const i = ['Type', 'ObjectType', 'PredefinedType', 'Name', 'Tag', 'Description'].indexOf(g); return i < 0 ? 99 : i; };
let subList = [];
function renderSub() {
  if (!subMode || !ctxFor) return;
  const items = ctxFor.items;
  const loading = loadedModels().some((m) => m.meta && !m.facets);
  subList = subEntries(items);
  let html = '', sec = null;
  subList.forEach((e, i) => {
    if (e.sec !== sec) { sec = e.sec; html += `<div class="ebc-group-label ifc-menu__label">${esc(sec)}</div>`; }
    const lbl = e.key ? `<span class="ifc-ctx-sub__k">${esc(e.key)}:</span> ${esc(e.label)}` : esc(e.label);
    html += `<button class="ebc-menu__item" role="menuitem" type="button" data-sub="${i}" title="${esc((e.key ? e.key + ': ' : '') + e.title)}"><span>${lbl}</span></button>`;
  });
  if (loading) html += `<p class="ifc-muted">${T('Načítají se údaje modelů…', 'Reading model data…')}</p>`;
  ui.ctxSub.innerHTML = html;
  // pozice vedle položky, která podnabídku otevřela (vpravo, když se nevejde, vlevo)
  const btn = ui.ctx.querySelector(`[data-ctx-more="${subMode}"]`), br = btn.getBoundingClientRect(), mr = ui.ctx.getBoundingClientRect();
  ui.ctxSub.classList.add('is-open');
  const sr = ui.ctxSub.getBoundingClientRect();
  const left = mr.right + 4 + sr.width <= innerWidth - 8 ? mr.right + 4 : Math.max(8, mr.left - 4 - sr.width);
  ui.ctxSub.style.left = `${left}px`;
  ui.ctxSub.style.top = `${Math.max(8, Math.min(br.top - 5, innerHeight - sr.height - 8))}px`;
}
function openSub(mode) {
  if (subMode === mode) return;
  subMode = mode;
  ui.ctx.querySelectorAll('[data-ctx-more]').forEach((b) => b.setAttribute('aria-expanded', String(b.dataset.ctxMore === mode)));
  if (loadedModels().some((m) => m.meta && !m.facets)) { facetsWanted = true; refreshFacets(); } // index hodnot na pozadí
  renderSub();
}
ui.ctx.addEventListener('pointerover', (e) => {
  const b = e.target.closest('[data-ctx-more]');
  if (b) openSub(b.dataset.ctxMore);
  else if (e.target.closest('.ebc-menu__item') && !e.target.closest('#ctx-sub')) closeSub();
});
ui.ctx.addEventListener('click', (e) => {
  const b = e.target.closest('[data-ctx-more]');
  if (b) { e.stopPropagation(); openSub(b.dataset.ctxMore); return; }
  const s = e.target.closest('[data-sub]');
  if (!s) return;
  e.stopPropagation();
  const entry = subList[+s.dataset.sub], mode = subMode, items = entry.items();
  ui.ctx.hidePopover();
  if (mode === 'isolate') isolateItems(items); else hideItems(items);
}, true);
ui.ctx.addEventListener('toggle', (e) => { if (e.newState === 'closed') closeSub(); });
function isolateItems(items) {
  const by = new Map();
  for (const { model: m, id } of items) { if (!by.has(m)) by.set(m, new Set()); by.get(m).add(id); }
  for (const m of loadedModels()) { m.isolated = by.get(m) || new Set(); m.updateVisibility(); }
  updateFoot(); tree.paint(); viewer.requestRender();
}
function hideItems(items) {
  const touched = new Set();
  for (const { model: m, id } of items) { m.hidden.add(id); touched.add(m); }
  for (const m of touched) m.updateVisibility();
  selectItems(selection.filter((s) => !s.model.hidden.has(s.id)), false);
  updateFoot(); tree.paint(); viewer.requestRender();
}

// kontextová nabídka nad skupinou prvků (záložky Třídy, Atributy, Vlastnosti, Materiály, Patří do, Klasifikace):
// pravé tlačítko = vybrat prvky řádku (pokud už nejsou přesně vybrané) a otevřít nabídku
function contextFor(items, x, y) {
  const key = (s) => `${s.model.key}:${s.id}`;
  const cur = new Set(selection.map(key));
  if (items.length !== cur.size || items.some((s) => !cur.has(key(s)))) selectItems(items, false, null, false);
  openContext({ x, y });
}
ui.classes.addEventListener('contextmenu', (e) => {
  const inp = e.target.closest('li')?.querySelector('input');
  if (!inp) return;
  e.preventDefault();
  const items = [];
  for (const m of loadedModels()) {
    if (!m.meta) continue;
    const ci = m.meta.classes.indexOf(inp.value), el = m.meta.elements;
    if (ci < 0) continue;
    for (let i = 0; i < el.ids.length; i++) if (el.cls[i] === ci && el.geo[i] && m.ranges.has(el.ids[i])) items.push({ model: m, id: el.ids[i] });
  }
  contextFor(items, e.clientX, e.clientY);
});
ui.ctx.addEventListener('click', (e) => {
  const b = e.target.closest('[data-ctx]');
  if (!b || !ctxFor) return;
  const { node, items, cls } = ctxFor;
  const a = b.dataset.ctx;
  if (a === 'zoom') zoomToSelection();
  else if (a === 'isolate') ui.isolate.click();
  else if (a === 'hide') ui.hide.click();
  else if (a === 'show') showItems(items);
  else if (a === 'expand') tree.setOpenDeep(node, true);
  else if (a === 'collapse') tree.setOpenDeep(node, false);
  else if (a === 'hideall') hideAll();
  else if (a === 'showall') { showAll(); if ([...classOff].some((c) => c !== OPENING)) { const op = classOff.has(OPENING); classOff.clear(); if (op) classOff.add(OPENING); applyClasses(); } if (facetStore.off.size) { facetStore.off.clear(); applyFacets(); } }
  else if (a === 'invert') invertVisibility();
});

function groupSel() {
  const by = new Map();
  for (const s of selection) { if (!by.has(s.model)) by.set(s.model, []); by.get(s.model).push(s.id); }
  return by;
}

// ---------------- třídy ----------------
// otvory (IfcOpeningElement) jsou ve výchozím stavu vypnuté – zapnou se ve Třídách (průhledná oranžová tělesa)
const OPENING = 'IfcOpeningElement';
const classOff = new Set([OPENING]); // vypnuté názvy tříd (napříč modely)
function classFilter(m) { m.classOff = new Set(m.meta.classes.map((c, i) => (classOff.has(c) ? i : -1)).filter((i) => i >= 0)); }
function renderClasses() {
  const counts = new Map();
  for (const m of loadedModels()) {
    if (!m.meta) continue;
    const e = m.meta.elements;
    for (let i = 0; i < e.ids.length; i++) {
      if (!e.geo[i] || e.cls[i] < 0) continue;
      const c = m.meta.classes[e.cls[i]];
      counts.set(c, (counts.get(c) || 0) + 1);
    }
  }
  const rows = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  ui.classes.innerHTML = rows.map(([c, n]) => `<li><label class="ebc-choice ifc-class"><input type="checkbox" value="${esc(c)}"${classOff.has(c) ? '' : ' checked'}><span class="ifc-class__name">${esc(c)}</span><span class="ifc-class__n">${n.toLocaleString(LANG)}</span></label></li>`).join('');
  const on = rows.filter(([c]) => !classOff.has(c)).length;
  ui.clsSum.textContent = T(`${on} z ${rows.length} tříd`, `${on} of ${rows.length} classes`);
}
function applyClasses() {
  for (const m of loadedModels()) {
    if (!m.meta) continue;
    classFilter(m);
    m.updateVisibility();
  }
  renderClasses(); tree.paint(); viewer.requestRender();
}
ui.classes.addEventListener('change', (e) => {
  const c = e.target.value;
  if (e.target.checked) classOff.delete(c); else classOff.add(c);
  applyClasses();
});
ui.clsAll.addEventListener('click', () => { classOff.clear(); applyClasses(); });
ui.clsNone.addEventListener('click', () => { ui.classes.querySelectorAll('input').forEach((i) => classOff.add(i.value)); applyClasses(); });

// ---------------- filtry podle hodnot (Atributy, Vlastnosti, Materiály, Patří do, Klasifikace) ----------------
// Index se počítá ve workeru až při prvním otevření některé z těchto záložek (velké modely = sekundy), pak i pro
// každý další načtený model. Vypnuté hodnoty platí napříč modely (sloučené podle textu).
const facetStore = new FacetStore();
let facetsWanted = false;
const FACET_LABELS = {
  attrs: { Name: T('Název (Name)', 'Name'), ObjectType: T('Typ objektu (ObjectType)', 'Object type (ObjectType)'), Type: T('Typ', 'Type'),
    PredefinedType: T('Předdefinovaný typ (PredefinedType)', 'Predefined type (PredefinedType)'), Tag: T('Značka (Tag)', 'Tag'), Description: T('Popis (Description)', 'Description') },
};
const facetLists = [...document.querySelectorAll('[data-facet-pane]')].map((pane) => {
  const tab = pane.dataset.facetPane;
  const list = new FacetList(pane.querySelector('[data-facet-host]'), facetStore, tab, {
    changed: applyFacets,
    select: (items, additive) => selectItems(items, additive, null, false),
    context: (items, x, y) => contextFor(items, x, y),
  }, T, (t, g) => (t === 'attrs' ? FACET_LABELS.attrs[g] || g : g || '—'));
  list.pane = pane;
  list.sum = pane.querySelector('[data-facet-sum]');
  pane.querySelector('[data-facet-all]').addEventListener('click', () => list.setAll(true));
  pane.querySelector('[data-facet-none]').addEventListener('click', () => list.setAll(false));
  let t;
  pane.querySelector('[data-facet-q]').addEventListener('input', (e) => { clearTimeout(t); t = setTimeout(() => list.setQuery(e.target.value), 150); });
  return list;
});
document.querySelectorAll('[data-facet-tab]').forEach((t) => t.addEventListener('click', () => {
  if (t.disabled) return;
  facetsWanted = true;
  refreshFacets();
  setTimeout(() => facetLists.forEach((l) => l.paint()), 0);
}));

function refreshFacets() {
  const list = loadedModels().filter((m) => m.meta);
  if (facetsWanted) {
    for (const m of list) {
      if (m.facets || m.facetsLoading) continue;
      m.facetsLoading = true;
      loader.facets(m.key, LANG).then((d) => { m.facets = d; }, (err) => { console.error(err); m.facets = []; m.facetsError = err.message; })
        .finally(() => { m.facetsLoading = false; if (models.has(m.key)) refreshFacets(); });
    }
  }
  facetStore.setModels(list);
  const loading = list.some((m) => m.facetsLoading);
  for (const l of facetLists) {
    l.refresh();
    if (loading) l.setMessage(T('Načítají se údaje modelů…', 'Reading model data…'));
  }
  applyFacets(false);
  if (subMode) renderSub();
}

function applyFacets(changed = true) {
  for (const m of loadedModels()) {
    const h = facetStore.hiddenFor(m);
    const prev = m.facetOff;
    m.facetOff = h && h.size ? h : null;
    if (changed || prev?.size || m.facetOff) m.updateVisibility();
  }
  const hidden = loadedModels().reduce((a, m) => a + (m.facetOff?.size || 0), 0);
  for (const l of facetLists) {
    l.sum.textContent = hidden ? T(`skryto ${hidden.toLocaleString(LANG)} prvků`, `${hidden.toLocaleString(LANG)} elements hidden`) : '';
    if (changed) l.paint();
  }
  if (changed) { tree.paint(); updateFoot(); viewer.requestRender(); }
}

// ---------------- výběr a vlastnosti ----------------
function pick(clientX, clientY) {
  const rc = new THREE.Raycaster();
  rc.setFromCamera(viewer.ndc(clientX, clientY), viewer.camera);
  rc.firstHitOnly = false;
  const hits = [];
  for (const m of loadedModels()) m.raycast(rc, hits);
  hits.sort((a, b) => a.distance - b.distance);
  return hits.find((h) => sections.keeps(h.point)) || null;
}

let propsFor = null; // {model, id} – čí vlastnosti jsou v panelu
// additive: false = nahradit, true = přepnout, 'add' = přidat (Ctrl), 'remove' = odebrat (Shift) – jako v Revitu
function selectItems(items, additive, propsTarget = null, fromScene = true) {
  if (additive === 'add' || additive === 'remove') {
    const ks = new Set(items.map((it) => `${it.model.key}:${it.id}`));
    selection = selection.filter((s) => !ks.has(`${s.model.key}:${s.id}`));
    if (additive === 'add') selection.push(...items);
  } else if (additive) {
    const keys = new Set(selection.map((s) => `${s.model.key}:${s.id}`));
    for (const it of items) {
      const k = `${it.model.key}:${it.id}`;
      if (keys.has(k)) { selection = selection.filter((s) => `${s.model.key}:${s.id}` !== k); keys.delete(k); }
      else { selection.push(it); keys.add(k); }
    }
  } else selection = items;
  propsFor = propsTarget || (selection.length ? selection[selection.length - 1] : null);
  applySelection(fromScene);
}

function applySelection(reveal = true) {
  const by = groupSel();
  for (const m of loadedModels()) m.setHighlight(by.get(m) ? new Set(by.get(m)) : null, viewer.highlightMat);
  const keys = selection.map((s) => `${s.model.key}:${s.id}`);
  if (propsFor && !selection.some((s) => s === propsFor)) keys.unshift(`${propsFor.model.key}:${propsFor.id}`);
  if (reveal) tree.reveal(keys); else { tree.selected = new Set(keys); tree.paint(); }
  ui.isolate.disabled = ui.hide.disabled = !selection.length;
  renderProps();
  viewer.requestRender();
}

let propsReq = 0;
async function renderProps() {
  const target = propsFor;
  ui.props.hidden = !target;
  if (!target) return;
  ui.selCount.hidden = selection.length < 2;
  ui.selCount.textContent = selection.length;
  const { model, id } = target;
  const inf = model.info.get(id) || {};
  const node = tree.byKey?.get(`${model.key}:${id}`);
  const path = [];
  for (let p = node?.parent; p && !p.isModel; p = p.parent) if (p.name || p.cls) path.unshift(p.name || p.cls);
  const cls = inf.c >= 0 && model.meta ? model.meta.classes[inf.c] : '';
  const head = `<div class="ifc-props-head">
      <p class="ifc-props-head__name">${esc(inf.name || cls || `#${id}`)}</p>
      <p class="ifc-props-head__cls">${esc(cls)}${path.length ? ` · ${esc(path.join(' › '))}` : ''}</p>
      ${inf.guid ? `<p class="ifc-props-head__guid"><code>${esc(inf.guid)}</code><button class="ebc-btn ifc-btn" type="button" data-copy="${esc(inf.guid)}">${T('Kopírovat', 'Copy')}</button></p>` : ''}
      ${selection.length > 1 ? `<p class="ifc-muted">${T(`Vybráno ${selection.length} prvků`, `${selection.length} elements selected`)} · ${esc(model.name)}</p>` : `<p class="ifc-muted">${esc(model.name)}</p>`}
    </div>`;
  ui.propsBody.innerHTML = head + `<div class="ifc-pad"><div class="ebc-progress ifc-progress--indeterminate" role="progressbar" aria-label="${T('Načítání vlastností', 'Loading properties')}"><div class="ebc-progress__bar"></div></div></div>`;
  const req = ++propsReq;
  let groups;
  try { groups = await loader.props(model.key, id, LANG); } catch (err) { groups = [{ title: T('Chyba', 'Error'), rows: [['', err.message]] }]; }
  if (req !== propsReq) return;
  const open = new Set([...ui.propsBody.querySelectorAll('details[open]')].map((d) => d.dataset.t));
  const count = (n) => T(`${n} ${n === 1 ? 'hodnota' : n < 5 ? 'hodnoty' : 'hodnot'}`, `${n} value${n === 1 ? '' : 's'}`);
  ui.propsBody.innerHTML = head + `<div class="ifc-groups">${groups.map((g, i) => `
    <details class="ebc-expander" data-t="${esc(g.title)}"${i < 2 || open.has(g.title) ? ' open' : ''}>
      <summary class="ebc-expander__header"><span>${esc(g.title)}</span><span class="ebc-expander__summary">${count(g.rows.length)}</span></summary>
      <div class="ebc-expander__body ifc-kv">
        <table class="ebc-table"><tbody>${g.rows.map(([k, v]) => `<tr><td class="ifc-kv__k">${esc(k)}</td><td>${v === '' || v == null ? '—' : esc(v)}</td></tr>`).join('')}</tbody></table>
      </div>
    </details>`).join('')}</div>`;
}
ui.propsBody.addEventListener('click', (e) => {
  const b = e.target.closest('[data-copy]');
  if (!b) return;
  navigator.clipboard?.writeText(b.dataset.copy).then(() => gui.toast(T('GUID zkopírováno', 'GUID copied'), { type: 'success' }));
});
ui.propsClose.addEventListener('click', () => selectItems([], false));
ui.propsZoom.addEventListener('click', () => zoomToSelection());

function zoomToSelection() {
  const box = new THREE.Box3();
  for (const [m, ids] of groupSel()) box.union(m.boxOf(ids));
  if (!box.isEmpty()) zoomTo(box);
}
function zoomTo(box) {
  if (!box || box.isEmpty()) return;
  const dir = viewer.camera.position.clone().sub(viewer.controls.target);
  viewer.fit(box, { dir: dir.lengthSq() ? dir : undefined });
}

// ---------------- plátno: klepnutí, měření ----------------
let down = null;
// výběr rámečkem (levé tlačítko, myš): zleva doprava = prvky celé uvnitř (plný rámeček), zprava doleva = i protnuté
// (čárkovaný); Ctrl přidá, Shift odebere – jako v Revitu
let marquee = null;
const marqueeEl = document.createElement('div');
marqueeEl.className = 'ifc-marquee';
marqueeEl.hidden = true;
viewer.container.appendChild(marqueeEl);
const selMode = (e) => (e.ctrlKey || e.metaKey ? 'add' : e.shiftKey ? 'remove' : false);
viewer.canvas.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY, b: e.button, mouse: e.pointerType === 'mouse' }; });
viewer.canvas.addEventListener('pointermove', (e) => {
  if (!down || down.b !== 0 || !down.mouse || tool === 'measure' || faceSection || !(e.buttons & 1)) return;
  if (!marquee) {
    if (Math.hypot(e.clientX - down.x, e.clientY - down.y) <= 4) return;
    marquee = true;
    viewer.canvas.setPointerCapture?.(e.pointerId);
    marqueeEl.hidden = false;
  }
  const cr = viewer.container.getBoundingClientRect();
  marqueeEl.classList.toggle('is-crossing', e.clientX < down.x);
  Object.assign(marqueeEl.style, {
    left: `${Math.min(e.clientX, down.x) - cr.left}px`, top: `${Math.min(e.clientY, down.y) - cr.top}px`,
    width: `${Math.abs(e.clientX - down.x)}px`, height: `${Math.abs(e.clientY - down.y)}px`,
  });
});
viewer.canvas.addEventListener('contextmenu', (e) => e.preventDefault());
viewer.canvas.addEventListener('pointerup', (e) => {
  const still = down && Math.hypot(e.clientX - down.x, e.clientY - down.y) <= 4;
  // pravé tlačítko bez posunu = nabídka (s posunem = posun pohledu)
  if (still && down.b === 2 && tool !== 'measure' && !faceSection) {
    down = null;
    const hit = pick(e.clientX, e.clientY);
    if (hit && !selection.some((s) => s.model === hit.model && s.id === hit.expressID)) selectItems([{ model: hit.model, id: hit.expressID }], false);
    if (!hit) selectItems([], false);
    openContext({ x: e.clientX, y: e.clientY });
    return;
  }
  if (marquee) {
    marquee = null;
    marqueeEl.hidden = true;
    const cr = viewer.canvas.getBoundingClientRect();
    const items = boxSelect({
      x0: Math.min(e.clientX, down.x) - cr.left, x1: Math.max(e.clientX, down.x) - cr.left,
      y0: Math.min(e.clientY, down.y) - cr.top, y1: Math.max(e.clientY, down.y) - cr.top,
    }, e.clientX < down.x);
    down = null;
    const mode = selMode(e);
    if (items.length || !mode) selectItems(items, mode);
    return;
  }
  if (!still || down.b !== 0) { down = null; return; }
  down = null;
  const hit = pick(e.clientX, e.clientY);
  if (tool === 'measure') {
    const it = measure.click(measure.snap(hit), e.shiftKey);
    if (it) renderToolcard();
    return;
  }
  if (faceSection) {
    setFaceSection(false);
    if (hit) {
      const n = hit.face.normal.clone().transformDirection(hit.object.matrixWorld);
      // normála k pozorovateli: řez odebere část mezi kamerou a plochou
      if (n.dot(viewer.camera.position.clone().sub(hit.point)) < 0) n.negate();
      sections.setPlane('face', hit.point, n);
    }
    renderToolcard();
    return;
  }
  if (hit) selectItems([{ model: hit.model, id: hit.expressID }], selMode(e));
  else if (!selMode(e)) selectItems([], false);
});
addEventListener('blur', () => { if (marquee) { marquee = null; marqueeEl.hidden = true; down = null; } });

// prvky v obdélníku na plátně (px od levého horního rohu): crossing = stačí protnout, jinak celé uvnitř.
// Promítají se vrcholy trojúhelníků zobrazených prvků (řezy se neberou v úvahu).
function boxSelect(r, crossing) {
  const cam = viewer.camera;
  cam.updateMatrixWorld();
  const cr = viewer.canvas.getBoundingClientRect();
  // obdélník v NDC
  const X0 = (r.x0 / cr.width) * 2 - 1, X1 = (r.x1 / cr.width) * 2 - 1;
  const Y0 = 1 - (r.y1 / cr.height) * 2, Y1 = 1 - (r.y0 / cr.height) * 2;
  const M = new THREE.Matrix4(), out = [];
  const P = new Float64Array(6); // tři promítnuté vrcholy (x, y)
  const inside = (x, y) => x >= X0 && x <= X1 && y >= Y0 && y <= Y1;
  // úsečka × obdélník (Liang–Barsky)
  const segHits = (ax, ay, bx, by) => {
    let t0 = 0, t1 = 1;
    const dx = bx - ax, dy = by - ay;
    const pq = [-dx, ax - X0, dx, X1 - ax, -dy, ay - Y0, dy, Y1 - ay];
    for (let i = 0; i < 8; i += 2) {
      const p = pq[i], q = pq[i + 1];
      if (p === 0) { if (q < 0) return false; continue; }
      const t = q / p;
      if (p < 0) { if (t > t1) return false; if (t > t0) t0 = t; } else { if (t < t0) return false; if (t < t1) t1 = t; }
    }
    return true;
  };
  // roh obdélníku uvnitř trojúhelníku (obdélník celý uvnitř velké plochy)
  const inTri = (x, y) => {
    const s = (i, j) => (P[i * 2] - x) * (P[j * 2 + 1] - y) - (P[j * 2] - x) * (P[i * 2 + 1] - y);
    const a = s(0, 1), b = s(1, 2), c = s(2, 0);
    return (a >= 0 && b >= 0 && c >= 0) || (a <= 0 && b <= 0 && c <= 0);
  };
  // obálky prvků (souřadnice scény) – v mezipaměti modelu, po rozpadu podlaží se přepočítají
  const boxes = (m) => {
    if (m.selBoxes && m.selBoxesDy === m.explodeDy) return m.selBoxes;
    const map = new Map();
    for (const [id, list] of m.ranges) {
      const b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
      for (const [gi, s0, c] of list) {
        const g = m.groups[gi], pos = g.render.geometry.getAttribute('position').array, f = g.full;
        for (let t = s0; t < s0 + c; t++) {
          const v = f[t] * 3;
          for (let k = 0; k < 3; k++) { const x = pos[v + k]; if (x < b[k]) b[k] = x; if (x > b[k + 3]) b[k + 3] = x; }
        }
      }
      map.set(id, b);
    }
    m.selBoxes = map; m.selBoxesDy = m.explodeDy;
    return map;
  };
  for (const m of loadedModels()) {
    if (!m.visible) continue;
    M.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse).multiply(m.object.matrixWorld);
    const e = M.elements;
    const bx = boxes(m);
    for (const [id, list] of m.ranges) {
      if (!m.isShown(id)) continue;
      // předběžně podle promítnuté obálky: mimo obdélník = nic; celá uvnitř = vybráno v obou režimech
      const b = bx.get(id);
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, front = true;
      for (let k = 0; k < 8 && front; k++) {
        const x = b[k & 1 ? 3 : 0], y = b[k & 2 ? 4 : 1], z = b[k & 4 ? 5 : 2];
        const w = e[3] * x + e[7] * y + e[11] * z + e[15];
        if (w <= 1e-9) { front = false; break; }
        const px = (e[0] * x + e[4] * y + e[8] * z + e[12]) / w, py = (e[1] * x + e[5] * y + e[9] * z + e[13]) / w;
        if (px < minX) minX = px; if (px > maxX) maxX = px; if (py < minY) minY = py; if (py > maxY) maxY = py;
      }
      if (front) {
        if (maxX < X0 || minX > X1 || maxY < Y0 || minY > Y1) continue;
        if (minX >= X0 && maxX <= X1 && minY >= Y0 && maxY <= Y1) { out.push({ model: m, id }); continue; }
      }
      let hit = !crossing, done = false;
      for (const [gi, s0, c] of list) {
        const g = m.groups[gi], pos = g.render.geometry.getAttribute('position').array, f = g.full;
        for (let t = s0; t < s0 + c && !done; t += 3) {
          let anyIn = false, front = true;
          for (let k = 0; k < 3; k++) {
            const v = f[t + k] * 3, x = pos[v], y = pos[v + 1], z = pos[v + 2];
            const w = e[3] * x + e[7] * y + e[11] * z + e[15];
            if (w <= 1e-9) { front = false; break; }
            const px = (e[0] * x + e[4] * y + e[8] * z + e[12]) / w, py = (e[1] * x + e[5] * y + e[9] * z + e[13]) / w;
            P[k * 2] = px; P[k * 2 + 1] = py;
            if (inside(px, py)) anyIn = true;
            else if (!crossing) { hit = false; done = true; break; }
          }
          if (!crossing) { if (!front) { hit = false; done = true; } continue; }
          if (!front) continue; // trojúhelník za kamerou – pro protnutí se nepočítá
          if (anyIn || segHits(P[0], P[1], P[2], P[3]) || segHits(P[2], P[3], P[4], P[5]) || segHits(P[4], P[5], P[0], P[1]) || inTri(X0, Y0)) { hit = true; done = true; }
        }
        if (done) break;
      }
      if (hit) out.push({ model: m, id });
    }
  }
  return out;
}
// dvojklik kolečkem = celý model (Revit „Přizpůsobit oknu“); kolečko nespustí automatické posouvání stránky
{
  // počítá se jen klepnutí bez tažení (dvě rychlá posunutí za sebou nejsou dvojklik)
  let press = null, click = null;
  const near = (a, e) => Math.hypot(e.clientX - a.x, e.clientY - a.y) < 6;
  viewer.canvas.addEventListener('mousedown', (e) => { if (e.button === 1) e.preventDefault(); });
  viewer.canvas.addEventListener('pointerdown', (e) => { if (e.button === 1) press = { t: performance.now(), x: e.clientX, y: e.clientY }; });
  viewer.canvas.addEventListener('pointerup', (e) => {
    if (e.button !== 1 || !press) return;
    const now = performance.now();
    if (!near(press, e) || now - press.t > 400) { press = null; click = null; return; }
    if (click && now - click.t < 500 && near(click, e)) { click = null; zoomTo(visibleBox()); } // směr pohledu zůstane
    else click = { t: now, x: e.clientX, y: e.clientY };
    press = null;
  });
}
viewer.canvas.addEventListener('dblclick', (e) => {
  const hit = pick(e.clientX, e.clientY);
  if (hit) { viewer.controls.target.copy(hit.point); viewer.controls.update(); }
});
let hoverRaf = 0;
viewer.canvas.addEventListener('pointermove', (e) => {
  if (tool !== 'measure' || e.buttons) return;
  cancelAnimationFrame(hoverRaf);
  const sh = e.shiftKey;
  hoverRaf = requestAnimationFrame(() => measure.hover(measure.snap(pick(e.clientX, e.clientY)), sh));
});
viewer.canvas.addEventListener('pointerleave', () => { if (tool === 'measure') measure.hover(null); });
// Shift během měření: zamknutí směru hned (bez pohybu myši)
addEventListener('keydown', (e) => { if (e.key === 'Shift' && tool === 'measure') measure.setShift(true); });
addEventListener('keyup', (e) => { if (e.key === 'Shift' && tool === 'measure') measure.setShift(false); });
addEventListener('blur', () => measure.setShift(false));
addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || e.target.closest?.('input, [popover]')) return;
  if (tool === 'measure' && measure.start) measure.cancel();
  else if (faceSection) { setFaceSection(false); renderToolcard(); }
  else if (selection.length || propsFor) selectItems([], false);
});

// ---------------- pohled ----------------
// otáčení kolem středu výběru: OrbitControls otáčí kolem svého cíle; po každé změně se otočení (rozdíl orientace
// kamery) přenese na otáčení kolem středu obálky výběru – kamera i cíl se otočí kolem něj, pohled neposkočí.
// Posun a přiblížení orientaci nemění → beze změny.
{
  const ctl = viewer.controls;
  let cam = viewer.camera; // kamera se mění (perspektivní / ortogonální) → vzít aktuální při každé akci
  const p0 = new THREE.Vector3(), t0 = new THREE.Vector3(), q0 = new THREE.Quaternion(), R = new THREE.Quaternion();
  let pivot = null;
  const keep = () => { cam = viewer.camera; p0.copy(cam.position); t0.copy(ctl.target); q0.copy(cam.quaternion); };
  ctl.addEventListener('start', () => {
    pivot = null;
    if (selection.length) {
      const box = new THREE.Box3();
      for (const [m, ids] of groupSel()) if (m.visible) box.union(m.boxOf(ids));
      if (!box.isEmpty()) pivot = box.getCenter(new THREE.Vector3());
    }
    keep();
  });
  ctl.addEventListener('change', () => {
    if (pivot) {
      R.copy(q0).invert().premultiply(cam.quaternion); // R · q0 = q1
      if (1 - Math.abs(R.w) > 1e-8) {
        cam.position.copy(p0).sub(pivot).applyQuaternion(R).add(pivot);
        ctl.target.copy(t0).sub(pivot).applyQuaternion(R).add(pivot);
      }
    }
    keep();
  });
  ctl.addEventListener('end', () => { pivot = null; });
}
ui.fit.addEventListener('click', () => viewer.fit(visibleBox()));
// směry pohledu ve scéně (osa Y nahoru; IFC +Y = three −Z → „zepředu“ = od jihu, kamera na +Z)
const VIEWS = {
  top: [0, 1, 0.0001], bottom: [0, -1, 0.0001], front: [0, 0, 1], back: [0, 0, -1],
  left: [-1, 0, 0], right: [1, 0, 0], iso: [1, 0.8, 1],
};
// perspektivní / ortogonální projekce (stejný výřez; pamatuje se v prohlížeči)
function setProjection(ortho) {
  viewer.setOrtho(ortho);
  ui.proj.checked = ortho;
  try { localStorage.setItem('ifcviewer.ortho', ortho ? '1' : '0'); } catch { /* bez úložiště */ }
}
ui.proj.addEventListener('change', () => setProjection(ui.proj.checked));
try { if (localStorage.getItem('ifcviewer.ortho') === '1') setProjection(true); } catch { /* bez úložiště */ }
$('views').addEventListener('click', (e) => {
  const v = VIEWS[e.target.closest('[data-view]')?.dataset.view];
  if (v) viewer.fit(visibleBox(), { dir: new THREE.Vector3(...v) });
});

// ---------------- rozpad po podlažích (posuvník osy Z) ----------------
// Jedno společné pořadí vrstev napříč stavbami i modely: výška podlaží = IfcBuildingStorey.Elevation (převedená na m);
// chybí-li, medián spodních hran prvků podlaží. Elevation má přednost – prvky bývají přiřazené k podlaží podle
// referenčního podlaží (Revit: VZT, ZTI…), ne podle skutečné polohy, a výška z geometrie pak nesedí. Podlaží ve stejné
// výšce (do LEVEL_TOL) = jedna vrstva → v rozpadu se vrstvy různých staveb neproplétají a každá vrstva má svou barvu.
// Nejnižší vrstva zůstává na místě, prvky mimo podlaží (pozemek, terén, nezařazené) také.
let explodeT = 0; // 0–1
let explodeOn = false;
let levelColorsOn = false;
const EXPLODE_MAX = 3.5; // největší mezera mezi vrstvami = 3,5 × typická výška podlaží (medián rozestupu)
let levelMode = 'storey'; // vrstvy rozpadu: 'storey' = podle přiřazení k podlaží v IFC, 'height' = podle výšky prvků (celistvé)
const LEVEL_TOL = 0.6; // m
let levels = { n: 0, H: 3, names: [] }; // společné vrstvy: počet, typická výška podlaží, názvy podlaží po vrstvách
// barvy vrstev: nejdřív kategorie dat z EBC_UI_vibe (podle motivu), u vyšších budov dopočítané odstíny (zlatý úhel)
// → každá vrstva jiná; prvky mimo podlaží potlačenou šedou
const levelOther = () => sceneColors().urovenJina;
function levelColor(i) {
  const pal = sceneColors().urovne;
  if (i < pal.length) return pal[i];
  const h = (i * 137.508) % 360, l = i % 2 ? 42 : 58;
  return `#${new THREE.Color().setHSL(h / 360, 0.65, l / 100).getHexString()}`;
}
const levelColors = () => Array.from({ length: Math.max(levels.n, 1) }, (_, i) => levelColor(i));
function setLevelColors(on) {
  levelColorsOn = on;
  for (const m of loadedModels()) if (m.levelOf) m.setLevelColors(on ? levelColors() : null, levelOther());
  viewer.requestRender();
}
// legenda barev: shora dolů jako v budově; v jedné vrstvě názvy podlaží všech staveb / modelů
function levelLegend() {
  const rows = [];
  for (let i = levels.n - 1; i >= 0; i--) {
    rows.push(`<li><span class="ifc-legend__sw" style="background:${levelColor(i)}"></span><span class="ifc-legend__n">${i + 1}</span><span class="ifc-legend__t">${esc(levels.names[i].join(' / ') || '—')}</span></li>`);
  }
  rows.push(`<li><span class="ifc-legend__sw" style="background:${levelOther()}"></span><span class="ifc-legend__n"></span><span class="ifc-legend__t ifc-muted">${T('mimo podlaží (pozemek, terén, nezařazené)', 'outside storeys (site, terrain, unassigned)')}</span></li>`);
  return `<ul class="ifc-legend">${rows.join('')}</ul>`;
}
// podlaží modelu s výškou (jednou po načtení, v nerozložené poloze)
function storeyInfo(m) {
  const cls = m.meta.classes, storeys = [];
  const walk = (t, storey) => {
    if (rank({ cls: t.c >= 0 ? cls[t.c] : '', orphans: t.orphans }) === 4) { storey = { ids: [], name: t.n || '', elev: m.meta.elev?.[t.id] }; storeys.push(storey); }
    if (storey && t.id) storey.ids.push(t.id);
    t.k?.forEach((k) => walk(k, storey));
  };
  m.meta.tree.forEach((t) => walk(t, null));
  m.storeys = [];
  const med = (a) => { const b = a.slice().sort((x, y) => x - y); return b[b.length >> 1]; };
  // spodní hrana každého prvku (souřadnice scény, nerozloženo) – pro vrstvy podle výšky a náhradní výšku podlaží
  m.bottoms = new Map();
  for (const id of m.ranges.keys()) m.bottoms.set(id, m.boxOf([id]).min.y);
  // prázdné podlaží nemá vrstvu
  const used = storeys.map((s) => ({ ...s, geoIds: s.ids.filter((id) => m.ranges.has(id)) })).filter((s) => s.geoIds.length);
  // výška z workeru = absolutní umístění podlaží (IFC Z, m) → do scény odečtením společného počátku (stejně jako geometrie).
  // Nepoužije se, když chybí nebo je zdegenerovaná (všem podlažím stejná) – pak medián spodních hran prvků podlaží.
  const el = used.map((s) => s.elev);
  const useElev = used.length > 0 && el.every((e) => e != null) && (used.length < 2 || Math.max(...el) - Math.min(...el) > LEVEL_TOL);
  const off = loader.origin ? loader.origin[1] : 0;
  for (const s of used) m.storeys.push({ ids: s.ids, name: s.name, z: useElev ? s.elev - off : med(s.geoIds.map((id) => m.bottoms.get(id))) });
}
// společné vrstvy pro všechny načtené modely → úrovně prvků v každém modelu
function relevel() {
  const all = loadedModels().filter((m) => m.storeys).flatMap((m) => m.storeys.map((s) => ({ ...s, m }))).sort((a, b) => a.z - b.z);
  const groups = [];
  for (const s of all) {
    const g = groups[groups.length - 1];
    if (g && s.z - g.z0 <= LEVEL_TOL) g.list.push(s); else groups.push({ z0: s.z, list: [s] });
  }
  const per = new Map();
  if (levelMode === 'height') {
    // celistvé vrstvy: každý prvek každého modelu do vrstvy podle své spodní hrany (s tolerancí – deska pod úrovní
    // podlaží patří k podlaží nad ní), nezávisle na přiřazení v IFC; pod nejnižší vrstvou (piloty) = nejnižší vrstva
    const z0 = groups.map((g) => g.z0);
    for (const m of loadedModels()) {
      if (!m.bottoms) continue;
      const mp = new Map();
      for (const [id, b] of m.bottoms) {
        let lo = 0, hi = z0.length; // první vrstva s z0 > b + tolerance
        while (lo < hi) { const mid = (lo + hi) >> 1; if (z0[mid] <= b + LEVEL_TOL) lo = mid + 1; else hi = mid; }
        mp.set(id, Math.max(0, lo - 1));
      }
      per.set(m, mp);
    }
  } else groups.forEach((g, i) => g.list.forEach((s) => {
    if (!per.has(s.m)) per.set(s.m, new Map());
    for (const id of s.ids) per.get(s.m).set(id, i);
  }));
  const steps = groups.slice(1).map((g, i) => g.z0 - groups[i].z0).sort((a, b) => a - b);
  levels = {
    n: groups.length,
    H: Math.max(steps.length ? steps[steps.length >> 1] : 3, 1), // typická výška podlaží (medián)
    names: groups.map((g) => [...new Set(g.list.map((s) => s.name).filter(Boolean))]),
  };
  for (const m of loadedModels()) if (m.storeys) m.setLevels(per.get(m) || new Map());
  if (levelColorsOn) setLevelColors(true);
  applyExplode();
}
let refitTimer;
function applyExplode() {
  const all = new THREE.Box3();
  for (const m of loadedModels()) {
    if (m.levelOf) m.explode(explodeT * EXPLODE_MAX * levels.H);
    all.union(m.box);
  }
  if (!all.isEmpty()) { sections.bounds.copy(all); viewer.gridBox = all; }
  clearTimeout(refitTimer);
  refitTimer = setTimeout(() => loadedModels().forEach((m) => m.refitPick()), 200);
  viewer.requestRender();
}
ui.explode.addEventListener('click', () => {
  explodeOn = !explodeOn;
  if (!explodeOn && explodeT) { explodeT = 0; applyExplode(); }
  if (!explodeOn && levelColorsOn) setLevelColors(false);
  renderToolcard();
});

// ---------------- řezy ----------------
let tool = null; // 'measure' | null
let faceSection = false;
// ---- řez plochou: náhled plochy pod kurzorem ----
// Zvýrazní celou rovinnou plochu prvku pod kurzorem (souvislé trojúhelníky prvku ve stejné rovině, sousedící
// vrcholem) a šipkou ukáže stranu, která se řezem odebere (k pozorovateli).
const facePreview = new THREE.Group();
facePreview.renderOrder = 3;
viewer.overlay.add(facePreview);
const accentColor = () => new THREE.Color(sceneColors().vyber);
function clearFacePreview() {
  for (const o of facePreview.children) { o.geometry?.dispose(); o.material?.dispose?.(); o.traverse?.((x) => { if (x !== o) { x.geometry?.dispose(); x.material?.dispose(); } }); }
  facePreview.clear();
  viewer.requestRender();
}
function planarFace(hit) {
  const m = hit.model, gi = m.groups.findIndex((g) => g.pick === hit.object);
  if (gi < 0) return null;
  const g = m.groups[gi], pos = g.render.geometry.getAttribute('position').array, f = g.full;
  const tris = [];
  for (const [rgi, s, c] of m.ranges.get(hit.expressID) || []) if (rgi === gi) for (let t = s; t < s + c; t += 3) tris.push(t);
  const P = (i) => new THREE.Vector3(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]);
  const hitSet = [hit.face.a, hit.face.b, hit.face.c].sort((x, y) => x - y).join();
  const start = tris.find((t) => [f[t], f[t + 1], f[t + 2]].sort((x, y) => x - y).join() === hitSet);
  if (start == null) return null;
  const n0 = new THREE.Vector3().crossVectors(P(f[start + 1]).sub(P(f[start])), P(f[start + 2]).sub(P(f[start]))).normalize();
  const p0 = P(f[start]), tri = new THREE.Triangle(), nn = new THREE.Vector3();
  // trojúhelníky ve stejné rovině → souvislá oblast od zasaženého (sdílené vrcholy)
  const same = tris.filter((t) => {
    tri.set(P(f[t]), P(f[t + 1]), P(f[t + 2]));
    tri.getNormal(nn);
    return Math.abs(nn.dot(n0)) > 0.999 && Math.abs(tri.a.clone().sub(p0).dot(n0)) < 1e-3;
  });
  // sousedství podle polohy vrcholu (indexy vrcholů nemusí být sdílené)
  const vk = (v) => `${Math.round(pos[v * 3] * 1e4)},${Math.round(pos[v * 3 + 1] * 1e4)},${Math.round(pos[v * 3 + 2] * 1e4)}`;
  const byVert = new Map();
  for (const t of same) for (let k = 0; k < 3; k++) { const v = vk(f[t + k]); if (!byVert.has(v)) byVert.set(v, []); byVert.get(v).push(t); }
  const seen = new Set([start]), stack = [start];
  while (stack.length) {
    const t = stack.pop();
    for (let k = 0; k < 3; k++) for (const u of byVert.get(vk(f[t + k])) || []) if (!seen.has(u)) { seen.add(u); stack.push(u); }
  }
  const out = new Float32Array(seen.size * 9);
  let o = 0;
  for (const t of seen) for (let k = 0; k < 3; k++) { const v = f[t + k]; out[o++] = pos[v * 3]; out[o++] = pos[v * 3 + 1]; out[o++] = pos[v * 3 + 2]; }
  return out;
}
let faceRaf = 0, faceKey = '';
function showFacePreview(hit) {
  const key = hit ? `${hit.model.key}:${hit.expressID}:${hit.face.a},${hit.face.b},${hit.face.c}` : '';
  if (key === faceKey && hit) { // stejná plocha – jen posunout šipku
    const arrow = facePreview.children[2];
    if (arrow) { arrow.position.copy(hit.point); viewer.requestRender(); }
    return;
  }
  faceKey = key;
  clearFacePreview();
  if (!hit) return;
  const tris = planarFace(hit);
  if (!tris) return;
  const col = accentColor();
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(tris, 3));
  const mesh = new THREE.Mesh(geom, new THREE.MeshBasicMaterial({
    color: col, transparent: true, opacity: 0.4, side: THREE.DoubleSide, depthWrite: false, depthTest: false,
  }));
  mesh.renderOrder = 3;
  mesh.applyMatrix4(hit.model.object.matrixWorld);
  // obrys plochy (hrany použité jen jedním trojúhelníkem) – plocha je vidět i v ostrém úhlu
  const key3 = (i) => `${tris[i].toFixed(4)},${tris[i + 1].toFixed(4)},${tris[i + 2].toFixed(4)}`;
  const edges = new Map();
  for (let t = 0; t < tris.length; t += 9) {
    for (let k = 0; k < 3; k++) {
      const a = t + k * 3, b = t + ((k + 1) % 3) * 3, ka = key3(a), kb = key3(b);
      const ek = ka < kb ? ka + '|' + kb : kb + '|' + ka;
      const e = edges.get(ek);
      if (e) e.n++; else edges.set(ek, { n: 1, a, b });
    }
  }
  const lp = [];
  for (const e of edges.values()) if (e.n === 1) lp.push(tris[e.a], tris[e.a + 1], tris[e.a + 2], tris[e.b], tris[e.b + 1], tris[e.b + 2]);
  const lg = new THREE.BufferGeometry();
  lg.setAttribute('position', new THREE.Float32BufferAttribute(lp, 3));
  const outline = new THREE.LineSegments(lg, new THREE.LineBasicMaterial({ color: col, depthTest: false, transparent: true }));
  outline.applyMatrix4(hit.model.object.matrixWorld);
  outline.renderOrder = 4;
  facePreview.add(mesh, outline);
  // šipka: normála k pozorovateli = strana, která se odebere
  const n = hit.face.normal.clone().transformDirection(hit.object.matrixWorld);
  if (n.dot(viewer.camera.position.clone().sub(hit.point)) < 0) n.negate();
  const len = Math.max(0.3, Math.min(3, viewer.camera.position.distanceTo(hit.point) * 0.08));
  const arrow = new THREE.ArrowHelper(n, hit.point, len, col, len * 0.3, len * 0.18);
  arrow.traverse((x) => { if (x.material) { x.material.depthTest = false; x.material.transparent = true; } x.renderOrder = 4; });
  facePreview.add(arrow);
  viewer.requestRender();
}
viewer.canvas.addEventListener('pointermove', (e) => {
  if (!faceSection || e.buttons) return;
  cancelAnimationFrame(faceRaf);
  faceRaf = requestAnimationFrame(() => showFacePreview(pick(e.clientX, e.clientY)));
});
viewer.canvas.addEventListener('pointerleave', () => { if (faceSection) { faceKey = ''; clearFacePreview(); } });
function setFaceSection(on) {
  faceSection = on;
  ui.viewport.classList.toggle('is-pick', on);
  if (!on) { faceKey = ''; clearFacePreview(); }
}
function applyClipping() {
  const planes = sections.planes;
  const mats = [viewer.highlightMat];
  for (const m of loadedModels()) for (const g of m.groups) mats.push(g.render.material);
  for (const mat of mats) {
    const changed = (mat.clippingPlanes?.length || 0) !== planes.length;
    mat.clippingPlanes = planes.length ? planes : null;
    if (changed) mat.needsUpdate = true;
  }
  ui.section.setAttribute('aria-pressed', String(!!sections.plane || faceSection));
  ui.box.setAttribute('aria-pressed', String(!!sections.box));
  ui.explode.setAttribute('aria-pressed', String(explodeOn));
  viewer.requestRender();
}

ui.section.addEventListener('click', () => {
  if (sections.plane || faceSection) { setFaceSection(false); sections.clearPlane(); }
  else sections.setPlane('y');
  renderToolcard();
});
ui.box.addEventListener('click', () => { sections.enableBox(!sections.box); renderToolcard(); });
ui.measure.addEventListener('click', () => {
  tool = tool === 'measure' ? null : 'measure';
  if (!tool) measure.cancel();
  ui.measure.setAttribute('aria-pressed', String(tool === 'measure'));
  ui.viewport.classList.toggle('is-measure', tool === 'measure');
  renderToolcard();
});

const AX = [['x', 'X'], ['z', 'Y'], ['y', 'Z']]; // osa three → popisek v osách IFC
function renderToolcard() {
  const parts = [];
  if (sections.plane || faceSection) {
    const ax = sections.plane?.axis;
    const [lo, hi] = sections.planeRange();
    const off = sections.plane?.offset ?? 0;
    parts.push(`<section class="ifc-tc" aria-labelledby="tc-sec">
      <div class="ifc-tc__head"><h3 id="tc-sec">${T('Řez', 'Section')}</h3>
        <button class="ebc-icon-btn" type="button" data-act="sec-off" aria-label="${T('Zrušit řez', 'Remove section')}">${gui.icon('window-close')}</button></div>
      <div class="ifc-seg ifc-tc__seg" role="group" aria-label="${T('Rovina řezu', 'Section plane')}">
        <button class="ebc-filter" type="button" data-act="sec-y" aria-pressed="${ax === 'y'}">${T('Vodorovný', 'Horizontal')}</button>
        <button class="ebc-filter" type="button" data-act="sec-x" aria-pressed="${ax === 'x'}">${T('Svislý X', 'Vertical X')}</button>
        <button class="ebc-filter" type="button" data-act="sec-z" aria-pressed="${ax === 'z'}">${T('Svislý Y', 'Vertical Y')}</button>
        <button class="ebc-filter" type="button" data-act="sec-face" aria-pressed="${faceSection || ax === 'face'}">${T('Plocha', 'Face')}</button>
      </div>
      ${faceSection ? `<p class="ifc-muted">${T('Najeďte na plochu modelu (zvýrazní se, šipka ukazuje odebíranou stranu) a klepněte – řez povede její rovinou.', 'Hover a face of the model (it is highlighted, the arrow shows the side to be removed) and click – the section follows its plane.')}</p>`
        : `<div class="ifc-tc__row"><input class="ifc-range" type="range" data-act="sec-off-set" min="${lo}" max="${hi}" step="${(hi - lo) / 500 || 0.01}" value="${off}" aria-label="${T('Poloha řezu', 'Section position')}">
           <button class="ebc-btn ifc-btn" type="button" data-act="sec-flip">${T('Převrátit', 'Flip')}</button></div>`}
    </section>`);
  }
  if (sections.box) {
    const b = sections.bounds.clone().expandByScalar(0.01), bx = sections.box;
    parts.push(`<section class="ifc-tc" aria-labelledby="tc-box">
      <div class="ifc-tc__head"><h3 id="tc-box">${T('Řezový kvádr', 'Section box')}</h3>
        <button class="ebc-btn ifc-btn" type="button" data-act="box-reset">${T('Obnovit', 'Reset')}</button>
        <button class="ebc-icon-btn" type="button" data-act="box-off" aria-label="${T('Vypnout kvádr', 'Turn off box')}">${gui.icon('window-close')}</button></div>
      ${AX.map(([a, lab]) => {
        const step = (b.max[a] - b.min[a]) / 400 || 0.01;
        return `<div class="ifc-tc__axis"><span>${lab}</span>
          <input class="ifc-range" type="range" data-box="${a}" data-end="min" min="${b.min[a]}" max="${b.max[a]}" step="${step}" value="${bx.min[a]}" aria-label="${lab} min">
          <input class="ifc-range" type="range" data-box="${a}" data-end="max" min="${b.min[a]}" max="${b.max[a]}" step="${step}" value="${bx.max[a]}" aria-label="${lab} max"></div>`;
      }).join('')}
    </section>`);
  }
  if (explodeOn) {
    const n = levels.n;
    const gap = explodeT * EXPLODE_MAX * levels.H;
    parts.push(`<section class="ifc-tc" aria-labelledby="tc-ex">
      <div class="ifc-tc__head"><h3 id="tc-ex">${T('Rozpad podlaží', 'Explode storeys')}</h3>
        <button class="ebc-btn ifc-btn" type="button" data-act="ex-reset"${explodeT ? '' : ' disabled'}>${T('Složit', 'Collapse')}</button>
        <button class="ebc-icon-btn" type="button" data-act="ex-off" aria-label="${T('Ukončit rozpad', 'Close explode')}">${gui.icon('window-close')}</button></div>
      ${n > 1 ? `<div class="ifc-tc__row"><span class="ifc-tc__z">Z</span><input class="ifc-range" type="range" data-act="ex-set" min="0" max="1" step="0.005" value="${explodeT}" aria-label="${T('Rozestup podlaží', 'Storey spacing')}">
        <output class="ifc-tc__val" id="ex-val">+${fmtLen(gap)}</output></div>
        <p class="ifc-muted">${T(`${n} podlaží · posun mezi sousedními podlažími`, `${n} storeys · offset between adjacent storeys`)}</p>
        <div class="ifc-tc__row"><span class="ifc-muted">${T('Vrstvy', 'Layers')}</span>
          <div class="ifc-seg ifc-tc__seg" role="group" aria-label="${T('Vrstvy rozpadu', 'Explode layers')}">
            <button class="ebc-filter" type="button" data-act="ex-mode" data-mode="storey" aria-pressed="${levelMode === 'storey'}">${T('Podle podlaží', 'By storey')}</button>
            <button class="ebc-filter" type="button" data-act="ex-mode" data-mode="height" aria-pressed="${levelMode === 'height'}">${T('Podle výšky prvků', 'By element height')}</button>
          </div></div>
        <p class="ifc-muted">${levelMode === 'height'
          ? T('Každý prvek všech modelů patří do vrstvy podle své výšky – celistvé vrstvy přes všechny modely.', 'Every element of all models goes to a layer by its height – whole layers across all models.')
          : T('Prvky podle přiřazení k podlaží v IFC (prvky mimo podlaží zůstávají na místě).', 'Elements by their storey assignment in IFC (elements outside storeys stay in place).')}</p>
        <label class="ebc-choice"><input type="checkbox" data-act="ex-colors"${levelColorsOn ? ' checked' : ''}>${T('Barvit podle podlaží (kontrola přiřazení)', 'Colour by storey (check assignment)')}</label>
        ${levelColorsOn ? levelLegend() : ''}`
        : `<p class="ifc-muted">${T('Model nemá víc podlaží (IfcBuildingStorey) s geometrií.', 'The model has no more than one storey (IfcBuildingStorey) with geometry.')}</p>`}
    </section>`);
  }
  if (tool === 'measure') {
    parts.push(`<section class="ifc-tc" aria-labelledby="tc-m">
      <div class="ifc-tc__head"><h3 id="tc-m">${T('Měření', 'Measure')}</h3>
        ${measure.items.length ? `<button class="ebc-btn ifc-btn" type="button" data-act="m-clear">${T('Smazat vše', 'Clear all')}</button>` : ''}
        <button class="ebc-icon-btn" type="button" data-act="m-off" aria-label="${T('Ukončit měření', 'Stop measuring')}">${gui.icon('window-close')}</button></div>
      <p class="ifc-muted">${T('Klepněte na dva body – u kurzoru je vidět přichycení (□ vrchol, △ střed hrany, ◇ hrana, ○ plocha). Shift po prvním bodu zamkne směr na osu X / Y / Z nebo kolmo na plochu. Esc zruší rozpracované.', 'Click two points – the cursor shows the snap (□ vertex, △ edge midpoint, ◇ edge, ○ face). Shift after the first point locks the direction to the X / Y / Z axis or perpendicular to the face. Esc cancels.')}</p>
      ${measure.items.length ? `<ol class="ifc-mlist">${measure.items.map((it, i) => {
        const d = deltaIfc(it.a, it.b);
        return `<li><strong>${it.axis ? `${it.axis === 'n' ? '⊥' : `Δ${it.axis}`} ` : ''}${fmtLen(it.a.distanceTo(it.b))}</strong><span class="ifc-muted">ΔX ${fmtLen(Math.abs(d.x))} · ΔY ${fmtLen(Math.abs(d.y))} · ΔZ ${fmtLen(Math.abs(d.z))}</span>
          <button class="ebc-icon-btn" type="button" data-act="m-del" data-i="${i}" aria-label="${T('Smazat', 'Delete')}">${gui.icon('delete')}</button></li>`;
      }).join('')}</ol>` : ''}
    </section>`);
  }
  ui.toolcard.innerHTML = parts.join('');
  ui.toolcard.hidden = !parts.length;
  applyClipping();
}

ui.toolcard.addEventListener('click', (e) => {
  const b = e.target.closest('[data-act]');
  if (!b || b.tagName === 'INPUT') return; // posuvníky a zaškrtávátka obsluhuje 'input' (překreslení při klepnutí by změnu zahodilo)
  const a = b.dataset.act;
  if (a === 'sec-off') { setFaceSection(false); sections.clearPlane(); }
  else if (a === 'sec-y' || a === 'sec-x' || a === 'sec-z') { setFaceSection(false); sections.setPlane(a.slice(4)); }
  else if (a === 'sec-face') { setFaceSection(true); }
  else if (a === 'sec-flip') sections.flipPlane();
  else if (a === 'box-off') sections.enableBox(false);
  else if (a === 'box-reset') sections.enableBox(true);
  else if (a === 'm-clear') measure.clear();
  else if (a === 'ex-reset') { explodeT = 0; applyExplode(); }
  else if (a === 'ex-mode') { levelMode = b.dataset.mode; relevel(); }
  else if (a === 'ex-off') { ui.explode.click(); return; }
  else if (a === 'm-del') measure.remove(+b.dataset.i);
  else if (a === 'm-off') { ui.measure.click(); return; }
  renderToolcard();
});
ui.toolcard.addEventListener('input', (e) => {
  const r = e.target;
  if (r.dataset.act === 'sec-off-set') sections.setPlaneOffset(+r.value);
  else if (r.dataset.act === 'ex-colors') { setLevelColors(r.checked); renderToolcard(); }
  else if (r.dataset.act === 'ex-set') {
    explodeT = +r.value;
    applyExplode();
    const out = ui.toolcard.querySelector('#ex-val');
    if (out) out.textContent = `+${fmtLen(explodeT * EXPLODE_MAX * levels.H)}`;
    ui.toolcard.querySelector('[data-act="ex-reset"]').disabled = !explodeT;
  }
  else if (r.dataset.box) {
    const a = r.dataset.box, bx = sections.box;
    const min = bx.min.clone(), max = bx.max.clone();
    if (r.dataset.end === 'min') min[a] = Math.min(+r.value, max[a] - 0.01); else max[a] = Math.max(+r.value, min[a] + 0.01);
    sections.setBox(min, max);
  }
});

// ---------------- vývoj / testy ----------------
// ?model=<adresa> načte model z adresy (stejný původ nebo CORS) – pro rychlé zkoušení
const qs = new URLSearchParams(location.search);
for (const url of qs.getAll('model')) {
  fetch(url).then((r) => { if (!r.ok) throw new Error(r.status); return r.blob(); })
    .then((b) => ui.drop.dispatchEvent(new CustomEvent('gui-files', { detail: { files: [new File([b], decodeURIComponent(url.split('/').pop().split('?')[0]) || 'model.ifc')], rejected: [] } })))
    .catch((err) => gui.toast(T(`Model se nepodařilo stáhnout (${err.message})`, `Could not download the model (${err.message})`), { type: 'error' }));
}
window.__ifcviewer = { viewer, models, sections, measure, tree, get explodeT() { return explodeT; }, get selection() { return selection; } };
