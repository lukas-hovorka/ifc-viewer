// IFC Viewer – sloučení více souborů IFC (STEP, ISO 10303-21) do jednoho, přímo nad textem souborů.
// Nic se nepřepočítává (geometrie, GUID, vlastnosti zůstanou beze změny):
//   – čísla entit (#n) druhého a dalších souborů se posunou za nejvyšší číslo předchozích,
//   – IfcProject smí být jen jeden: projekty dalších souborů se vypustí a odkazy na ně (IfcRelAggregates,
//     IfcRelDeclares…) se přesměrují na projekt prvního souboru; jejich geometrické kontexty se připojí
//     do RepresentationContexts prvního projektu.
// Bajty mimo ASCII (nesprávně kódované exporty) se zachovají: čte se jako x-user-defined (bajt ↔ znak 1:1).
// Bez DOM → běží v merge-worker.js, jde použít i mimo prohlížeč.

const DEC = new TextDecoder('x-user-defined');
// řetězec (s '' uvnitř) | komentář | odkaz #n – řetězce a komentáře se nechají být
const TOKENS = /'[^']*(?:''[^']*)*'|\/\*[\s\S]*?\*\/|#(\d+)/g;

export function bytesToText(buf) { return DEC.decode(buf); }

export function textToBytes(s) {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); out[i] = c >= 0xf780 ? c - 0xf700 : c; }
  return out;
}

// rozdělení souboru: hlavička (text mezi HEADER; a ENDSEC;) a datová část (mezi DATA; a ENDSEC;)
export function splitStep(text, name = '') {
  const h = /HEADER\s*;/i.exec(text);
  if (!/^\s*ISO-10303-21\s*;/i.test(text) || !h) throw new MergeError('notstep', name);
  const he = indexOfOutside(text, /ENDSEC\s*;/iy, h.index + h[0].length);
  const d = he < 0 ? null : /DATA\s*;/i.exec(text.slice(he, he + 4096));
  if (!d) throw new MergeError('notstep', name);
  const ds = he + d.index + d[0].length;
  const de = text.search(/ENDSEC\s*;\s*END-ISO-10303-21\s*;/i);
  if (de < ds) throw new MergeError('notstep', name);
  const header = text.slice(h.index + h[0].length, he);
  const sm = /FILE_SCHEMA\s*\(\s*\(\s*'([^']*)'/i.exec(header);
  return { header, data: text.slice(ds, de), schema: (sm ? sm[1] : '').trim().toUpperCase() };
}

export class MergeError extends Error {
  constructor(code, detail) { super(`${code}: ${detail}`); this.code = code; this.detail = detail; }
}

// první výskyt vzoru (sticky regex) mimo řetězce a komentáře od pozice from; -1 = nenalezeno
function indexOfOutside(s, re, from) {
  for (let i = from; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 39) { i = skipString(s, i); continue; } // '
    if (c === 47 && s.charCodeAt(i + 1) === 42) { const e = s.indexOf('*/', i + 2); i = e < 0 ? s.length : e + 1; continue; }
    re.lastIndex = i;
    if (re.test(s)) return i;
  }
  return -1;
}

function skipString(s, i) {
  for (let j = i + 1; j < s.length; j++) {
    if (s.charCodeAt(j) !== 39) continue;
    if (s.charCodeAt(j + 1) === 39) { j++; continue; }
    return j;
  }
  return s.length;
}

// entita IfcProject: {id, start, end (za středníkem), args: [text argumentů]}
function findProject(data, name) {
  const re = /#(\d+)\s*=\s*IFCPROJECT\s*\(/gi;
  let m, found = null;
  while ((m = re.exec(data))) {
    if (found) throw new MergeError('projects', name);
    found = m;
  }
  if (!found) throw new MergeError('noproject', name);
  const open = found.index + found[0].length - 1;
  const { args, end } = splitArgs(data, open);
  const semi = indexOfOutside(data, /\s*;/y, end + 1);
  return { id: +found[1], start: found.index, end: data.indexOf(';', semi) + 1, args, argsStart: open + 1, argsEnd: end };
}

// argumenty v závorce na pozici open (nejvyšší úroveň, oddělené čárkou) → {args, end = pozice ')'}
function splitArgs(s, open) {
  const args = [];
  let depth = 0, from = open + 1;
  for (let i = open; i < s.length; i++) {
    const c = s[i];
    if (c === "'") { i = skipString(s, i); continue; }
    if (c === '(') depth++;
    else if (c === ')') { if (--depth === 0) { args.push(s.slice(from, i)); return { args, end: i }; } }
    else if (c === ',' && depth === 1) { args.push(s.slice(from, i)); from = i + 1; }
  }
  throw new MergeError('syntax', 'IFCPROJECT');
}

function refsIn(arg) { return [...arg.matchAll(/#(\d+)/g)].map((m) => +m[1]); }

function maxRef(data) {
  let max = 0;
  TOKENS.lastIndex = 0;
  let m;
  while ((m = TOKENS.exec(data))) if (m[1] && +m[1] > max) max = +m[1];
  return max;
}

const stepStr = (s) => `'${s.replace(/'/g, "''").replace(/[^\x20-\x7e]/g, '_')}'`;

// files: [{name, buffer}] → {bytes: Uint8Array, schema, count}
export function mergeIfc(files, { name = 'merged.ifc', app = 'IFC Viewer', onProgress } = {}) {
  if (files.length < 2) throw new MergeError('few', files.length);
  const parts = files.map((f) => ({ name: f.name, ...splitStep(bytesToText(f.buffer), f.name) }));
  const schema = parts[0].schema;
  for (const p of parts) if (p.schema !== schema) throw new MergeError('schema', `${parts[0].name} ${schema} × ${p.name} ${p.schema || '?'}`);

  // první soubor beze změny čísel; jeho projekt dostane kontexty ostatních
  const first = parts[0];
  const p0 = findProject(first.data, first.name);
  let offset = maxRef(first.data);
  const extraContexts = [];
  const chunks = [];

  for (let i = 1; i < parts.length; i++) {
    onProgress?.(i, parts.length);
    const p = parts[i];
    const pr = findProject(p.data, p.name);
    const off = offset;
    for (const c of refsIn(pr.args[7] || '')) extraContexts.push(c + off);
    // projekt vypustit, zbytek přečíslovat; odkazy na vypuštěný projekt → projekt prvního souboru
    const body = p.data.slice(0, pr.start) + p.data.slice(pr.end);
    let max = 0;
    const out = body.replace(TOKENS, (m, n) => {
      if (!n) return m;
      const v = +n;
      if (v > max) max = v;
      return v === pr.id ? `#${p0.id}` : `#${v + off}`;
    });
    offset = off + Math.max(max, pr.id);
    chunks.push(`\n/* ${p.name.replace(/\*\//g, '').replace(/[^\x20-\x7e]/g, '_')} */\n`, out.trim(), '\n');
    parts[i] = null; // uvolnit paměť
  }

  // RepresentationContexts prvního projektu (8. atribut) + kontexty ostatních
  let data0 = first.data;
  if (extraContexts.length) {
    const a = p0.args.slice();
    const own = refsIn(a[7] || '');
    a[7] = `(${[...own, ...extraContexts].map((n) => `#${n}`).join(',')})`;
    data0 = data0.slice(0, p0.argsStart) + a.join(',') + data0.slice(p0.argsEnd);
  }

  // hlavička: popis (MVD) a schéma z prvního souboru, nový FILE_NAME
  const desc = /FILE_DESCRIPTION\s*\([\s\S]*?\)\s*;/i.exec(first.header);
  const now = new Date().toISOString().slice(0, 19);
  const header = [
    'ISO-10303-21;', 'HEADER;',
    desc ? desc[0].replace(/\s*\n\s*/g, ' ') : "FILE_DESCRIPTION(('ViewDefinition [CoordinationView]'),'2;1');",
    `FILE_NAME(${stepStr(name)},'${now}',(''),(''),${stepStr(app)},${stepStr(app)},'');`,
    `FILE_SCHEMA(('${schema}'));`, 'ENDSEC;', '', 'DATA;',
  ].join('\n');
  const text = [header, '\n', data0.trim(), '\n', ...chunks, 'ENDSEC;\nEND-ISO-10303-21;\n'].join('');
  return { bytes: textToBytes(text), schema, count: files.length };
}
