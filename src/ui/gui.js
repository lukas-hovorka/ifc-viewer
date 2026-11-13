// IFC Viewer – chování rozhraní nad komponentami EBC_UI_vibe (třídy .ebc-* z src/ebc, needitovat):
// ikony, nabídky (popover), záložky, drop zóna, seznam modelů, nabídka barev, panel, oznámení a potvrzovací dialog.
// Události (bublají, údaje v e.detail):
//   gui-files  na drop zóně        { files: File[], rejected: File[] }
//   gui-file   na seznamu modelů   { id, action: 'visible' | 'select' | 'remove' | 'color', value }
import { T, LANG, esc } from './i18n.js';

const SPRITE = `${import.meta.env.BASE_URL}ebc/ebc-icons.svg`;

// ikony, které sada EBC_UI_vibe nemá (nástroje prohlížeče) – mřížka 24 × 24, tah 2 px, barva textu
const ICO = {
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="m16 16 4.5 4.5"/>',
  home: '<path d="M4 11 12 4l8 7"/><path d="M6 10v10h12V10"/>',
  eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.8"/>',
  layers: '<path d="M12 3 21 8l-9 5-9-5z"/><path d="m3 13 9 5 9-5"/>',
  cut: '<path d="M3 12h18"/><path d="M6 8V5h12v3M6 16v3h12v-3"/>',
  box: '<path d="M12 3 20 7.5v9L12 21l-8-4.5v-9z"/><path d="M4 7.5 12 12l8-4.5M12 12v9"/>',
  ruler: '<path d="M3 16.5 16.5 3 21 7.5 7.5 21z"/><path d="m7 13 2 2M10 10l2 2M13 7l2 2"/>',
  target: '<circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="2.5"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/>',
  explode: '<path d="M4 5.5 12 2l8 3.5-8 3.5z"/><path d="M4 12.5 12 9l8 3.5-8 3.5z" opacity=".75"/><path d="M4 19 12 15.5l8 3.5-8 3.5z" opacity=".5"/>',
  top: '<path d="M12 3 21 8l-9 5-9-5z"/><path d="M12 13v8M8 17l4 4 4-4"/>',
};

/** Ikona: název ze sady EBC (ebc-icons.svg) nebo z vlastních ikon nástrojů. */
export function icon(name) {
  if (ICO[name]) return `<svg class="ifc-ico" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${ICO[name]}</svg>`;
  return `<svg class="ebc-icon" aria-hidden="true" focusable="false"><use href="${SPRITE}#ebc-icon-${name}"/></svg>`;
}
/** Doplní ikony do prvků s data-ico="název". */
export function icons(root = document) {
  root.querySelectorAll('[data-ico]').forEach((el) => { el.innerHTML = icon(el.dataset.ico); });
}

const send = (el, type, detail) => el.dispatchEvent(new CustomEvent(type, { bubbles: true, detail }));

export function fileSize(b) {
  if (b == null || Number.isNaN(b)) return '';
  const u = ['B', 'kB', 'MB', 'GB'];
  let i = 0, v = Number(b);
  while (v >= 1000 && i < u.length - 1) { v /= 1000; i++; }
  return `${v.toLocaleString(LANG, { maximumFractionDigits: i && v < 100 ? 1 : 0 })} ${u[i]}`;
}

// ---------------- oznámení (stavový text nad plátnem, reakci nevyžaduje) ----------------
const MSG = { info: 'info', success: 'success', warning: 'warning', danger: 'error', error: 'error' };
export function toast(text, { type = 'info', duration } = {}) {
  const kind = MSG[type] || 'info';
  let region = document.querySelector('.ifc-toasts');
  if (!region) { region = document.createElement('div'); region.className = 'ifc-toasts'; region.setAttribute('aria-live', 'polite'); document.body.append(region); }
  const el = document.createElement('div');
  el.className = 'ifc-toast';
  el.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  el.innerHTML = `<span class="ebc-msg-icon ebc-msg-icon--${kind} ifc-toast__icon">${icon(`msg-${kind}`)}</span><p>${esc(text)}</p>
    <button class="ebc-icon-btn" type="button" aria-label="${T('Zavřít', 'Close')}">${icon('window-close')}</button>`;
  const close = () => el.remove();
  el.querySelector('button').addEventListener('click', close);
  region.append(el);
  const ms = duration ?? (kind === 'error' ? 0 : 5000); // chyby nezmizí samy
  if (ms > 0) {
    let timer = setTimeout(close, ms);
    el.addEventListener('pointerenter', () => clearTimeout(timer));
    el.addEventListener('pointerleave', () => { timer = setTimeout(close, 2000); });
  }
}

// ---------------- potvrzení (hláška EBC: varování, tlačítka se slovesem akce, primární vpravo) ----------------
export function confirmDialog(message, { title = T('Potvrzení', 'Confirm'), ok = 'OK', cancel = T('Zrušit', 'Cancel') } = {}) {
  return new Promise((resolve) => {
    const d = document.createElement('dialog');
    d.className = 'ebc-dialog ifc-dialog';
    d.innerHTML = `<div class="ebc-dialog__caption">${esc(title)}</div>
      <div class="ebc-dialog__body">
        <span class="ebc-msg-icon ebc-msg-icon--warning"><svg class="ebc-msg-icon__backdrop"><use href="${SPRITE}#ebc-icon-backdrop-triangle"/></svg><svg class="ebc-msg-icon__glyph"><use href="${SPRITE}#ebc-icon-msg-warning"/></svg></span>
        <p class="ebc-dialog__message">${esc(message)}</p>
      </div>
      <form method="dialog" class="ebc-dialog__actions">
        <button class="ebc-btn" value="cancel">${esc(cancel)}</button>
        <button class="ebc-btn ebc-btn--primary" value="ok" autofocus>${esc(ok)}</button>
      </form>`;
    d.addEventListener('close', () => { d.remove(); resolve(d.returnValue === 'ok'); });
    document.body.append(d);
    d.showModal();
  });
}

// ---------------- řádek modelu v seznamu ----------------
// o = { id, name, size (B), meta (text pod názvem), color ('#hex' | ''), visible, state: '' | 'loading' | 'error', percent, error }
export function fileRow(o) {
  const li = document.createElement('li');
  li.className = 'ifc-file';
  li.dataset.id = o.id;
  if (o.state) li.dataset.state = o.state;
  const n = esc(o.name), c = o.color || '';
  const pct = o.percent == null ? null : Math.round(o.percent);
  li.innerHTML = `
    <label class="ebc-choice ifc-file__vis"><input type="checkbox"${o.visible === false ? '' : ' checked'} aria-label="${T('Zobrazit', 'Show')} ${n}"></label>
    <button class="ifc-swatch${c ? '' : ' is-original'}" type="button" popovertarget="colors" data-color="${esc(c)}"${c ? ` style="--swatch: ${esc(c)}"` : ''} aria-label="${T('Barva', 'Colour')} ${n}: ${c ? esc(c) : T('původní', 'original')}"></button>
    <button class="ifc-file__name" type="button" title="${n}"><span class="ebc-filelist__name">${n}</span>${o.meta ? `<span class="ifc-file__meta">${esc(o.meta)}</span>` : ''}</button>
    <span class="ifc-file__size">${esc(o.state === 'loading' && pct != null ? `${pct} %` : fileSize(o.size))}</span>
    <button class="ebc-icon-btn ifc-file__remove" type="button" aria-label="${o.state === 'loading' ? T('Zrušit načítání', 'Cancel loading') : T('Odebrat', 'Remove')} ${n}">${icon('window-close')}</button>
    ${o.state === 'loading' ? `<div class="ebc-progress ifc-file__status${pct == null ? ' ifc-progress--indeterminate' : ''}" role="progressbar" aria-valuemin="0" aria-valuemax="100"${pct == null ? '' : ` aria-valuenow="${pct}"`} aria-label="${T('Načítání', 'Loading')} ${n}"><div class="ebc-progress__bar"${pct == null ? '' : ` style="width: ${pct}%"`}></div></div>` : ''}
    ${o.state === 'error' ? `<p class="ifc-file__status ebc-small ebc-text--error">${esc(o.error || T('Soubor se nepodařilo načíst.', 'The file could not be loaded.'))}</p>` : ''}`;
  return li;
}

/** Umístí nabídku k prvku (pod něj, při nedostatku místa nad něj), v mezích okna. */
function place(menu, trigger) {
  const r = trigger.getBoundingClientRect(), m = menu.getBoundingClientRect(), gap = 4;
  let top = r.bottom + gap;
  if (top + m.height > innerHeight - 8) top = Math.max(8, r.top - m.height - gap);
  menu.style.top = `${top}px`;
  menu.style.left = `${Math.min(Math.max(8, r.left), innerWidth - m.width - 8)}px`;
}

export function init() {
  icons(document);

  // ---- nabídky: .ebc-menu[popover] otevírané tlačítkem s popovertarget ----
  document.addEventListener('click', (e) => {
    const b = e.target.closest('[popovertarget]');
    const m = b && document.getElementById(b.getAttribute('popovertarget'));
    if (m) m._trigger = b;
  }, true);
  document.querySelectorAll('.ebc-menu[popover]').forEach((menu) => {
    const items = () => [...menu.querySelectorAll('.ebc-menu__item:not(:disabled):not([hidden])')];
    menu.addEventListener('toggle', (e) => {
      const t = menu._trigger;
      if (!t?.isConnected) return;
      t.setAttribute('aria-expanded', String(e.newState === 'open'));
      if (e.newState === 'open') place(menu, t);
    });
    menu.addEventListener('keydown', (e) => {
      const p = items(), i = p.indexOf(document.activeElement);
      const k = { ArrowDown: (i + 1) % p.length, ArrowUp: (i - 1 + p.length) % p.length, Home: 0, End: p.length - 1 }[e.key];
      if (k !== undefined && p.length) { e.preventDefault(); p[k].focus(); }
    });
    menu.addEventListener('click', (e) => { if (e.target.closest('.ebc-menu__item')) menu.hidePopover(); });
  });

  // ---- záložky: role="tablist" > role="tab" [aria-controls] ----
  document.querySelectorAll('[role="tablist"]').forEach((tl) => {
    const tabs = () => [...tl.querySelectorAll('[role="tab"]')];
    const select = (t, focus) => {
      for (const x of tabs()) {
        const on = x === t;
        x.setAttribute('aria-selected', String(on));
        x.tabIndex = on ? 0 : -1;
        const p = document.getElementById(x.getAttribute('aria-controls'));
        if (p) p.hidden = !on;
      }
      if (focus) t.focus();
    };
    tl.addEventListener('click', (e) => { const t = e.target.closest('[role="tab"]'); if (t && !t.disabled) select(t); });
    tl.addEventListener('keydown', (e) => {
      const t = tabs().filter((x) => !x.disabled), i = t.indexOf(document.activeElement);
      if (i < 0) return;
      const k = { ArrowRight: (i + 1) % t.length, ArrowLeft: (i - 1 + t.length) % t.length, Home: 0, End: t.length - 1 }[e.key];
      if (k !== undefined) { e.preventDefault(); select(t[k], true); t[k].click(); }
    });
    select(tabs().find((x) => x.getAttribute('aria-selected') === 'true') || tabs()[0]);
  });

  // ---- drop zóna: výběr kliknutím (label + input) i přetažení kamkoli do okna ----
  const drop = document.querySelector('.ebc-dropzone');
  if (drop) {
    const input = drop.querySelector('input[type="file"]');
    const title = drop.querySelector('.ebc-dropzone__title'), text = title.textContent;
    const use = drop.querySelector('.ebc-dropzone__icon use'), href = use.getAttribute('href');
    input.addEventListener('change', () => { if (input.files.length) send(drop, 'gui-files', { files: [...input.files], rejected: [] }); input.value = ''; });
    const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
    const over = (on) => {
      drop.classList.toggle('is-dragover', on);
      title.textContent = on ? T('Vložte soubory', 'Drop the files') : text;
      use.setAttribute('href', on ? `${SPRITE}#ebc-icon-drop-download` : href);
    };
    let n = 0;
    addEventListener('dragenter', (e) => { if (!hasFiles(e)) return; e.preventDefault(); n++; over(true); });
    addEventListener('dragover', (e) => { if (!hasFiles(e)) return; e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
    addEventListener('dragleave', (e) => { if (!hasFiles(e)) return; if (--n <= 0) { n = 0; over(false); } });
    addEventListener('drop', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault(); n = 0; over(false);
      if (e.dataTransfer.files.length) send(drop, 'gui-files', { files: [...e.dataTransfer.files], rejected: [] });
    });
  }

  // ---- seznam modelů ----
  const colors = document.getElementById('colors');
  document.querySelectorAll('.ifc-files').forEach((ul) => {
    const act = (li, action, value) => send(ul, 'gui-file', { id: li.dataset.id, action, value });
    ul.addEventListener('change', (e) => {
      const li = e.target.closest('.ifc-file');
      if (li && e.target.closest('.ifc-file__vis')) act(li, 'visible', e.target.checked);
    });
    ul.addEventListener('click', (e) => {
      const li = e.target.closest('.ifc-file');
      if (!li) return;
      if (e.target.closest('.ifc-file__remove')) act(li, 'remove');
      else if (e.target.closest('.ifc-file__name')) act(li, 'select');
      else if (e.target.closest('.ifc-swatch') && colors) { colors.dataset.id = li.dataset.id; colors.dataset.color = e.target.closest('.ifc-swatch').dataset.color; }
    });

    // ---- nabídka barvy modelu (paleta, vlastní barva, původní barvy z IFC) ----
    if (!colors) return;
    const picker = document.getElementById('color-input');
    const choose = (value) => send(ul, 'gui-file', { id: colors.dataset.id, action: 'color', value });
    colors.addEventListener('toggle', (e) => {
      if (e.newState !== 'open') return;
      const cur = colors.dataset.color || '';
      const pal = [...colors.querySelectorAll('[data-color]')];
      for (const b of pal) b.setAttribute('aria-checked', String(b.dataset.color === cur));
      const own = cur && !pal.some((b) => b.dataset.color === cur) ? cur : '';
      const custom = colors.querySelector('[data-act="custom"]');
      custom.setAttribute('aria-checked', String(!!own));
      custom.querySelector('.ifc-swatch').style.setProperty('--swatch', own || 'transparent');
      colors.querySelector('[data-act="orig"]').setAttribute('aria-checked', String(!cur));
      if (own) picker.value = own;
    });
    colors.addEventListener('click', (e) => {
      const b = e.target.closest('[data-color], [data-act]');
      if (!b) return;
      if (b.dataset.act === 'custom') picker.click();
      else choose(b.dataset.act === 'orig' ? '' : b.dataset.color);
      colors.hidePopover();
    });
    picker.addEventListener('change', () => choose(picker.value));
  });

  // ---- panel: sbalení (pamatuje se v prohlížeči) a výsuvný panel na úzkém displeji ----
  document.querySelectorAll('[data-panel-collapse]').forEach((b) => {
    const p = b.closest('.ifc-panel'), key = `ifcviewer.collapsed.${p.id}`;
    const set = (on) => {
      p.toggleAttribute('data-collapsed', on);
      b.setAttribute('aria-expanded', String(!on));
      b.setAttribute('aria-label', on ? T('Rozbalit panel', 'Expand panel') : T('Sbalit panel', 'Collapse panel'));
      try { localStorage.setItem(key, on ? '1' : ''); } catch { /* bez úložiště */ }
    };
    let saved = false;
    try { saved = localStorage.getItem(key) === '1'; } catch { /* bez úložiště */ }
    set(saved);
    b.addEventListener('click', () => set(!p.hasAttribute('data-collapsed')));
  });
  const app = document.body, toggles = document.querySelectorAll('[data-panel-toggle]');
  const open = (on) => { app.toggleAttribute('data-panel-open', on); toggles.forEach((b) => b.setAttribute('aria-expanded', String(on))); };
  toggles.forEach((b) => b.addEventListener('click', () => open(!app.hasAttribute('data-panel-open'))));
  document.querySelector('.ifc-scrim')?.addEventListener('click', () => open(false));
  matchMedia('(max-width: 760px)').addEventListener('change', () => open(false));
}
