// IFC Viewer – šipky pro ovládání řezu přímo v modelu: dvojitá šipka na rovině řezu (posun podél normály), dva
// oblouky na rovině řezu (otáčení kolem dvou os v rovině; Shift = po 15°) a šipka na každé stěně řezového kvádru
// (posun stěny). Stálá velikost na obrazovce, kreslí se vždy navrch.
// Tažení má přednost před otáčením pohledu i výběrem (pointerdown v zachytávací fázi plátna).
import * as THREE from 'three';

const PX = 64; // délka šipky v px
const AXIS = ['x', 'x', 'y', 'y', 'z', 'z']; // stěny kvádru v pořadí Sections.box.planes: min x, max x, min y, max y, …
const UP = new THREE.Vector3(0, 1, 0), ZAX = new THREE.Vector3(0, 0, 1);
const SNAP = THREE.MathUtils.degToRad(15);

// kružnice v rovině XY (osa otáčení = Z) poloměru 1; neviditelný silnější prstenec = snazší trefa
function ring(material) {
  const g = new THREE.Group();
  g.add(new THREE.Mesh(new THREE.TorusGeometry(1, 0.025, 8, 96), material));
  g.add(new THREE.Mesh(new THREE.TorusGeometry(1, 0.1, 6, 48), new THREE.MeshBasicMaterial({ visible: false })));
  g.renderOrder = 10;
  g.traverse((o) => { o.renderOrder = 10; });
  return g;
}

// šipka v ose +Y délky 1 (double = hroty na obou koncích); neviditelný silnější válec = snazší trefa myší
function arrow(material, double) {
  const g = new THREE.Group();
  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, double ? 1.4 : 0.7, 10), material);
  shaft.position.y = double ? 0 : 0.35;
  const head = (y, down) => {
    const c = new THREE.Mesh(new THREE.ConeGeometry(0.11, 0.3, 16), material);
    c.position.y = y;
    if (down) c.rotation.x = Math.PI;
    return c;
  };
  g.add(shaft, head(double ? 0.85 : 0.85, false));
  if (double) g.add(head(-0.85, true));
  const hit = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.16, double ? 2 : 1, 8), new THREE.MeshBasicMaterial({ visible: false }));
  hit.position.y = double ? 0 : 0.5;
  g.add(hit);
  g.renderOrder = 10;
  g.traverse((o) => { o.renderOrder = 10; });
  return g;
}

export class SectionHandles {
  // onEdit(done) – volá se při tažení (done = false) a po puštění (true)
  constructor(viewer, sections, onEdit) {
    this.v = viewer;
    this.s = sections;
    this.onEdit = onEdit;
    this.group = new THREE.Group();
    viewer.overlay.add(this.group);
    const mat = () => new THREE.MeshBasicMaterial({ color: viewer.colors.rez, depthTest: false, depthWrite: false, transparent: true, opacity: 0.95 });
    this.handles = [{ kind: 'plane', obj: arrow(mat(), true) }];
    for (let i = 0; i < 6; i++) this.handles.push({ kind: 'box', face: i, obj: arrow(mat(), false) });
    for (let i = 0; i < 2; i++) this.handles.push({ kind: 'ring', axis: i, obj: ring(mat()) });
    this.axes = [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 0, 1)]; // osy otáčení v rovině řezu
    for (const h of this.handles) { h.mat = h.obj.children[0].material; h.origin = new THREE.Vector3(); h.dir = new THREE.Vector3(); this.group.add(h.obj); }
    this.hover = null;
    this.drag = null;
    this.ray = new THREE.Raycaster();
    viewer.beforeRender.push(() => this.#layout());
    const c = viewer.canvas;
    c.addEventListener('pointerdown', (e) => this.#down(e), { capture: true });
    c.addEventListener('pointermove', (e) => this.#move(e));
    c.addEventListener('pointerup', (e) => this.#up(e), { capture: true });
    c.addEventListener('pointercancel', (e) => this.#up(e), { capture: true });
    c.addEventListener('pointerleave', () => { if (!this.drag) this.#setHover(null); });
    this.sync();
  }

  get visible() { return this.group.visible; }
  set visible(v) { this.group.visible = v; this.v.requestRender(); }

  recolor() { for (const h of this.handles) h.mat.color.set(h === this.hover || h === this.drag?.h ? this.v.colors.vyber : this.v.colors.rez); this.v.requestRender(); }

  // poloha a směr šipek podle řezu a kvádru (volat po každé změně řezu)
  sync() {
    const { plane, box, bounds } = this.s;
    const ph = this.handles[0];
    ph.obj.visible = !!plane;
    if (plane) {
      // střed: průmět středu modelu (v kvádru, pokud je) na rovinu
      const b = box ? new THREE.Box3(box.min.clone(), box.max.clone()).intersect(bounds) : bounds;
      if (this.drag?.h.kind === 'ring') ph.origin.copy(this.drag.origin); // střed otáčení se během tažení nehýbe
      else plane.plane.projectPoint(b.isEmpty() ? bounds.getCenter(new THREE.Vector3()) : b.getCenter(new THREE.Vector3()), ph.origin);
      ph.dir.copy(plane.plane.normal).negate(); // k odebírané straně
      // osy otáčení: vodorovná osa v rovině (u) a kolmá na ni (v); během otáčení zůstávají
      if (!this.drag || this.drag.h.kind !== 'ring') {
        const n = plane.plane.normal, u = new THREE.Vector3().crossVectors(n, UP);
        if (u.lengthSq() < 1e-6) u.set(1, 0, 0); // vodorovný řez: osy X a Y
        u.normalize();
        this.axes[0].copy(u);
        this.axes[1].crossVectors(n, u).normalize();
      }
    }
    for (const h of this.handles) {
      if (h.kind !== 'ring') continue;
      h.obj.visible = !!plane;
      if (plane) { h.origin.copy(ph.origin); h.dir.copy(this.axes[h.axis]); }
    }
    for (let i = 0; i < 6; i++) {
      const h = this.handles[i + 1];
      h.obj.visible = !!box;
      if (!box) continue;
      const a = AXIS[i], isMin = i % 2 === 0;
      h.origin.copy(box.min).add(box.max).multiplyScalar(0.5);
      h.origin[a] = isMin ? box.min[a] : box.max[a];
      h.dir.set(0, 0, 0)[a] = isMin ? -1 : 1;
    }
    this.v.requestRender();
  }

  // světová délka 1 px v místě p
  #worldPerPx(p) {
    const cam = this.v.camera, hpx = this.v.canvas.clientHeight || 600;
    if (cam.isOrthographicCamera) return (cam.top - cam.bottom) / cam.zoom / hpx;
    const d = cam.position.distanceTo(p);
    return (2 * d * Math.tan(THREE.MathUtils.degToRad(cam.fov / 2))) / hpx;
  }

  #layout() {
    if (!this.group.visible) return;
    for (const h of this.handles) {
      if (!h.obj.visible) continue;
      const s = this.#worldPerPx(h.origin) * PX;
      h.obj.position.copy(h.origin);
      // šipky kvádru začínají kousek před stěnou
      if (h.kind === 'box') h.obj.position.addScaledVector(h.dir, s * 0.15);
      h.obj.quaternion.setFromUnitVectors(h.kind === 'ring' ? ZAX : UP, h.dir);
      h.obj.scale.setScalar(h.kind === 'ring' ? s * 0.8 : s);
      h.obj.updateMatrixWorld(true);
    }
  }

  #pickHandle(e) {
    if (!this.group.visible) return null;
    const r = this.v.canvas.getBoundingClientRect();
    this.ray.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), this.v.camera);
    this.#layout();
    let best = null, bd = Infinity;
    for (const h of this.handles) {
      if (!h.obj.visible) continue;
      const hit = this.ray.intersectObject(h.obj, true)[0];
      if (hit && hit.distance < bd) { bd = hit.distance; best = h; }
    }
    return best;
  }

  // vektor od středu otáčení k průsečíku paprsku myši s rovinou kolmou na osu (null = rovina z boku)
  #ringVec(e, center, axis) {
    const r = this.v.canvas.getBoundingClientRect();
    this.ray.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), this.v.camera);
    if (Math.abs(this.ray.ray.direction.dot(axis)) < 0.02) return null;
    const p = this.ray.ray.intersectPlane(new THREE.Plane().setFromNormalAndCoplanarPoint(axis, center), new THREE.Vector3());
    return p ? p.sub(center) : null;
  }

  // parametr bodu na ose šipky nejblíž paprsku myši (null = osa míří do obrazovky)
  #axisParam(e, origin, dir) {
    const r = this.v.canvas.getBoundingClientRect();
    this.ray.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), this.v.camera);
    const rd = this.ray.ray.direction, w0 = origin.clone().sub(this.ray.ray.origin);
    const b = dir.dot(rd), d = dir.dot(w0), ee = rd.dot(w0), den = 1 - b * b;
    if (den < 1e-4) return null;
    return (b * ee - d) / den;
  }

  #setHover(h) {
    if (h === this.hover) return;
    this.hover = h;
    this.v.canvas.style.cursor = h ? 'grab' : '';
    this.recolor();
  }

  #down(e) {
    if (e.button !== 0) return;
    const h = this.#pickHandle(e);
    if (!h) return;
    e.stopImmediatePropagation();
    e.preventDefault();
    const t0 = h.kind === 'ring' ? this.#ringVec(e, h.origin, h.dir) : this.#axisParam(e, h.origin, h.dir);
    if (t0 == null) return;
    this.v.canvas.setPointerCapture?.(e.pointerId);
    this.v.controls.enabled = false;
    const { plane, box } = this.s;
    this.drag = { h, t0, origin: h.origin.clone(), dir: h.dir.clone(), off: plane?.offset ?? 0, min: box?.min.clone(), max: box?.max.clone(), n0: plane?.plane.normal.clone() };
    this.v.canvas.style.cursor = 'grabbing';
    this.recolor();
  }

  #move(e) {
    if (!this.drag) { if (!e.buttons) this.#setHover(this.#pickHandle(e)); return; }
    const d = this.drag;
    if (d.h.kind === 'ring') {
      const w = this.#ringVec(e, d.origin, d.dir);
      if (!w || w.lengthSq() < 1e-12) return;
      let ang = Math.atan2(d.dir.dot(new THREE.Vector3().crossVectors(d.t0, w)), d.t0.dot(w));
      if (e.shiftKey) ang = Math.round(ang / SNAP) * SNAP;
      this.angle = ang;
      this.s.setPlaneNormal(d.origin, d.n0.clone().applyAxisAngle(d.dir, ang));
      this.sync();
      this.onEdit(false);
      return;
    }
    const t = this.#axisParam(e, d.origin, d.dir);
    if (t == null) return;
    const dt = t - d.t0;
    if (d.h.kind === 'plane') {
      const [lo, hi] = this.s.planeRange();
      this.s.setPlaneOffset(Math.min(hi, Math.max(lo, d.off + dt))); // směr šipky = −normála → offset roste
    } else {
      const i = d.h.face, a = AXIS[i], min = d.min.clone(), max = d.max.clone();
      const pad = this.s.bounds.getSize(new THREE.Vector3())[a] * 0.25 + 0.01; // kousek za obálku modelu
      if (i % 2 === 0) min[a] = Math.min(max[a] - 0.01, Math.max(this.s.bounds.min[a] - pad, d.min[a] - dt));
      else max[a] = Math.max(min[a] + 0.01, Math.min(this.s.bounds.max[a] + pad, d.max[a] + dt));
      this.s.setBox(min, max);
    }
    this.sync();
    this.onEdit(false);
  }

  #up(e) {
    if (!this.drag) return;
    e.stopImmediatePropagation();
    this.v.canvas.releasePointerCapture?.(e.pointerId);
    this.v.controls.enabled = true;
    this.drag = null;
    this.v.canvas.style.cursor = this.hover ? 'grab' : '';
    this.recolor();
    this.onEdit(true);
  }
}
