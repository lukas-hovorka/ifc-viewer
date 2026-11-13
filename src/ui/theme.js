// Motiv a barvy z EBC_UI_vibe (dist/json/ebc-tokens.*.json, zkopírováno do src/ebc – needitovat).
// 3D scéna nemůže použít CSS proměnné, proto bere hodnoty tokenů odsud. Motiv = <html data-theme="dark|light">.
import dark from '../ebc/ebc-tokens.dark.json';
import light from '../ebc/ebc-tokens.light.json';

const TOKENS = { dark, light };
const KEY = 'ifcviewer.theme';

export const EBC_VERSION = (dark.$description.match(/\d+\.\d+\.\d+/) || ['?'])[0];

/** Aktuální motiv stránky. Výchozí je tmavý. */
export function theme() { return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark'; }

/** Hodnota tokenu v aktuálním motivu, např. t('color.accent.default'). */
export function t(key, th = theme()) {
  const v = TOKENS[th][key];
  if (v === undefined) throw new Error(`Chybí token ${key}`);
  return v;
}

/** Barvy 3D scény. Pozadí = technická plocha (log.bg), výběr = akcent, řez = první kategorie dat (neplete se s výběrem). */
export function scene(th = theme()) {
  const c = (k) => t(`color.${k}`, th);
  return {
    pozadi: c('log.bg'), mrizka: c('border.default'), mrizkaHlavni: c('bg.muted'),
    vyber: c('accent.default'), rez: c('data.category-1'),
    urovne: [1, 2, 3, 4, 5, 6].map((i) => c(`data.category-${i}`)), urovenJina: c('data.muted'),
  };
}

/** Nastaví motiv, zapamatuje ho v prohlížeči (jen pohodlí) a oznámí změnu posluchačům onTheme. */
export function setTheme(th, save = true) {
  document.documentElement.dataset.theme = th === 'light' ? 'light' : 'dark';
  if (save) try { localStorage.setItem(KEY, theme()); } catch { /* bez úložiště */ }
}

/** Sledovat změnu motivu. */
export function onTheme(cb) {
  let last = theme();
  new MutationObserver(() => { const now = theme(); if (now !== last) { last = now; cb(now); } })
    .observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
}

/** Přepínač motivu (.ebc-theme-toggle input): zaškrtnuto = tmavý. */
export function initThemeToggle(input) {
  try { const s = localStorage.getItem(KEY); if (s) setTheme(s, false); } catch { /* bez úložiště */ }
  input.checked = theme() === 'dark';
  input.addEventListener('change', () => setTheme(input.checked ? 'dark' : 'light'));
}
