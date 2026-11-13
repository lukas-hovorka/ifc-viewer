// IFC Viewer – sloučení souborů IFC mimo hlavní vlákno (velké soubory by jinak zamrazily rozhraní).
import { mergeIfc, MergeError } from './ifc-merge.js';

self.onmessage = (e) => {
  const { files, name, app } = e.data;
  try {
    const r = mergeIfc(files, { name, app, onProgress: (done, total) => self.postMessage({ type: 'progress', done, total }) });
    self.postMessage({ type: 'done', bytes: r.bytes, schema: r.schema, count: r.count }, [r.bytes.buffer]);
  } catch (err) {
    self.postMessage({ type: 'error', code: err instanceof MergeError ? err.code : 'other', detail: err instanceof MergeError ? err.detail : String(err.message || err) });
  }
};
