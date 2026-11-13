// IFC Viewer – klient workeru: načtení modelu (průběh, geometrie, struktura) a dotazy na vlastnosti.
export class IfcLoader {
  constructor() {
    this.worker = new Worker(new URL('./ifc-worker.js', import.meta.url), { type: 'module' });
    this.jobs = new Map(); // klíč modelu → {onProgress, onGeometry, resolve, reject}
    this.reqs = new Map(); // id požadavku → {resolve, reject}
    this.nextReq = 1;
    this.origin = null; // sdílený počátek souřadnic (určí první model)
    this.worker.onmessage = (e) => this.#msg(e.data);
    this.worker.onerror = (e) => {
      const err = new Error(e.message || 'worker');
      for (const j of this.jobs.values()) j.reject(err);
      this.jobs.clear();
    };
  }

  // {onProgress(done, total), onGeometry(msg)} → Promise<meta> (třídy, strom, prvky)
  open(key, buffer, { onProgress, onGeometry } = {}) {
    return new Promise((resolve, reject) => {
      this.jobs.set(key, { onProgress, onGeometry, resolve, reject });
      this.worker.postMessage({ type: 'open', key, buffer, origin: this.origin }, [buffer]);
    });
  }

  props(key, expressID, lang) {
    const req = this.nextReq++;
    return new Promise((resolve, reject) => {
      this.reqs.set(req, { resolve, reject });
      this.worker.postMessage({ type: 'props', key, expressID, req, lang });
    });
  }

  // index hodnot pro filtry → [{tab, group, sub, multi, values: [[popisek, Uint32Array]]}]
  facets(key, lang) {
    const req = this.nextReq++;
    return new Promise((resolve, reject) => {
      this.reqs.set(req, { resolve, reject });
      this.worker.postMessage({ type: 'facets', key, req, lang });
    });
  }

  close(key) { this.worker.postMessage({ type: 'close', key }); }

  #msg(m) {
    if (m.req) {
      const r = this.reqs.get(m.req);
      if (!r) return;
      this.reqs.delete(m.req);
      if (m.type === 'error') r.reject(new Error(m.message)); else r.resolve(m.data);
      return;
    }
    const j = this.jobs.get(m.key);
    if (!j) return;
    if (m.type === 'progress') j.onProgress?.(m.done, m.total);
    else if (m.type === 'geometry') {
      if (!this.origin && m.groups.length) this.origin = m.origin;
      j.onGeometry?.(m);
    } else if (m.type === 'meta') { this.jobs.delete(m.key); j.resolve(m); }
    else if (m.type === 'error') { this.jobs.delete(m.key); j.reject(new Error(m.message)); }
  }
}
