// IFC Viewer – jazyk podle <html lang> a escapování. Texty v kódu jsou zapsané dvojicí T('česky', 'anglicky').
export const LANG = (document.documentElement.lang || 'cs').toLowerCase().startsWith('en') ? 'en' : 'cs';
export const T = (cs, en) => (LANG === 'en' ? en : cs);
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
