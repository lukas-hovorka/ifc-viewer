// IFC Viewer – 3D scéna: renderer, kamera, ovládání (orbit), světla, barvy z EBC_UI_vibe, vykreslování na vyžádání.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { scene as sceneColors, onTheme } from '../ui/theme.js';

const _v = new THREE.Vector3(), _v2 = new THREE.Vector3();

export class Viewer {
  constructor(container) {
    this.container = container;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.localClippingEnabled = true;
    container.appendChild(this.renderer.domElement);
    this.canvas = this.renderer.domElement;
    this.canvas.classList.add('ifc-canvas');

    this.scene = new THREE.Scene();
    this.persp = new THREE.PerspectiveCamera(45, 1, 0.05, 5000);
    this.persp.position.set(20, 15, 20);
    // ortogonální: polovina výšky výřezu při zoom = 1 (orthoHalf), poměr stran podle plátna
    this.ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.05, 5000);
    this.orthoHalf = 10;
    this.camera = this.persp;
    this.controls = new OrbitControls(this.camera, this.canvas);
    this.controls.screenSpacePanning = true;
    this.controls.zoomToCursor = true;
    // myš jako v Revitu: stisknuté kolečko = posun, Shift + kolečko = otáčení, otáčení kolečkem = přiblížení ke kurzoru
    // (dvojklik kolečkem = celý model – main.js). Levé tlačítko = výběr (klepnutí, rámeček – main.js), pravé posouvá.
    this.controls.mouseButtons = { LEFT: -1, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.PAN };
    this.controls.addEventListener('change', () => this.requestRender());

    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x6b6b6b, 2.0));
    const sun = new THREE.DirectionalLight(0xffffff, 1.6);
    sun.position.set(0.5, 1, 0.35);
    this.scene.add(sun);
    const fill = new THREE.DirectionalLight(0xffffff, 0.6);
    fill.position.set(-0.6, 0.4, -0.8);
    this.scene.add(fill);

    this.models = new THREE.Group();
    this.overlay = new THREE.Group(); // pomůcky (řez, měření) – nad modelem, neořezávají se
    this.scene.add(this.models, this.overlay);
    this.grid = null;

    this.highlightMat = new THREE.MeshBasicMaterial({
      color: 0xffcc00, transparent: true, opacity: 0.85, side: THREE.DoubleSide, depthTest: true,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    });
    this.applyTheme();
    onTheme(() => { this.applyTheme(); this.requestRender(); });

    this.onRender = []; // háčky po vykreslení (štítky měření)
    this.beforeRender = []; // háčky před vykreslením (velikost šipek řezu podle kamery)
    this._pending = false;
    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
  }

  applyTheme() {
    const s = sceneColors();
    this.colors = s;
    this.renderer.setClearColor(s.pozadi);
    this.highlightMat.color.set(s.vyber);
    if (this.grid) this.#makeGrid(this.gridBox);
    this.dispatch('theme', s);
  }

  // mřížka pod modely (podle obálky)
  setGround(box) {
    this.gridBox = box;
    this.#makeGrid(box);
  }

  #makeGrid(box) {
    if (this.grid) { this.scene.remove(this.grid); this.grid.geometry.dispose(); this.grid.material.dispose(); this.grid = null; }
    if (!box || box.isEmpty()) return;
    const size = box.getSize(new THREE.Vector3());
    const span = Math.max(size.x, size.z) * 1.6;
    let step = span > 400 ? 10 : span > 60 ? 5 : 1;
    while (span / step > 200) step *= 10; // velmi rozlehlá obálka (např. špatné jednotky) – omezit počet čar
    const n = Math.max(4, Math.ceil(span / step));
    const g = new THREE.GridHelper(n * step, n, this.colors.mrizkaHlavni, this.colors.mrizka);
    g.material.transparent = true;
    g.material.opacity = 0.55;
    const c = box.getCenter(new THREE.Vector3());
    g.position.set(c.x, box.min.y - 0.01, c.z);
    this.grid = g;
    this.scene.add(g);
  }

  resize() {
    const w = this.container.clientWidth || 1, h = this.container.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    this.persp.aspect = w / h;
    this.persp.updateProjectionMatrix();
    this.#orthoFrustum();
    this.requestRender();
  }

  #orthoFrustum() {
    const o = this.ortho, a = this.persp.aspect, hh = this.orthoHalf;
    o.left = -hh * a; o.right = hh * a; o.top = hh; o.bottom = -hh;
    o.updateProjectionMatrix();
  }

  get isOrtho() { return this.camera === this.ortho; }

  // přepnutí projekce se stejným výřezem: v rovině cíle (controls.target) zůstane vidět totéž
  setOrtho(on) {
    if (on === this.isOrtho) return;
    const from = this.camera, to = on ? this.ortho : this.persp, t = this.controls.target;
    const tanH = Math.tan(THREE.MathUtils.degToRad(this.persp.fov / 2));
    const dist = from.position.distanceTo(t);
    if (on) {
      this.orthoHalf = dist * tanH;
      this.ortho.zoom = 1;
      this.#orthoFrustum();
      // ortogonální kamera nepřibližuje posunem → postavit ji mimo scénu (jinak by blízká rovina ořízla prvky za ní)
      const b = this.gridBox, back = b && !b.isEmpty() ? b.getSize(_v).length() + b.getCenter(_v2).distanceTo(t) : 0;
      to.position.copy(t).addScaledVector(from.position.clone().sub(t).normalize(), Math.max(dist, back));
    } else {
      // výška výřezu ortho / tan(fov/2) = vzdálenost kamery od cíle
      const d = Math.max(this.orthoHalf / this.ortho.zoom / tanH, 0.1);
      const dir = from.position.clone().sub(t).normalize();
      to.position.copy(t).addScaledVector(dir, d);
    }
    to.quaternion.copy(from.quaternion);
    to.up.copy(from.up);
    this.camera = to;
    this.controls.object = to;
    this.controls.update();
    this.dispatch('camera', to);
    this.requestRender();
  }

  requestRender() {
    if (this._pending) return;
    this._pending = true;
    requestAnimationFrame(() => {
      this._pending = false;
      this.#updateClip();
      for (const f of this.beforeRender) f();
      this.renderer.render(this.scene, this.camera);
      for (const f of this.onRender) f();
    });
  }

  // blízká / vzdálená rovina kamery podle celé scény (ne podle přiblíženého prvku) – jinak se při oddálení
  // po „přiblížit na výběr“ ořezávala vzdálená část modelu
  #updateClip() {
    const b = this.gridBox, cam = this.camera;
    if (!b || b.isEmpty()) return;
    const c = b.getCenter(_v), r = Math.max(b.getSize(_v2).length() / 2, 0.5) * 1.6; // 1.6 = i mřížka
    const d = cam.position.distanceTo(c);
    const far = d + r * 1.2;
    const toTarget = cam.position.distanceTo(this.controls.target);
    // mimo obálku nic blíž než její okraj → větší near = přesnější hloubka; uvnitř podle vzdálenosti k cíli
    const near = Math.max(far / 50000, 0.005, d > r ? (d - r) * 0.9 : Math.min(toTarget / 50, 0.1));
    if (Math.abs(cam.near - near) > near * 1e-3 || Math.abs(cam.far - far) > far * 1e-3) {
      cam.near = near; cam.far = far; cam.updateProjectionMatrix();
    }
  }

  // kamera na obálku (izometrický pohled shora)
  fit(box, { dir = new THREE.Vector3(1, 0.8, 1) } = {}) {
    if (!box || box.isEmpty()) return;
    const c = box.getCenter(new THREE.Vector3());
    const r = Math.max(box.getSize(new THREE.Vector3()).length() / 2, 0.5);
    const dist = r / Math.sin(THREE.MathUtils.degToRad(this.persp.fov / 2)) * 1.15;
    const d = dir.clone().normalize();
    this.camera.position.copy(c).addScaledVector(d, dist);
    if (this.isOrtho) { // stejný výřez jako perspektiva ze stejné vzdálenosti
      this.orthoHalf = dist * Math.tan(THREE.MathUtils.degToRad(this.persp.fov / 2));
      this.ortho.zoom = 1;
      this.#orthoFrustum();
    }
    this.controls.target.copy(c);
    this.controls.update();
    this.requestRender();
  }

  // pohled ve směru (pohledy shora, zepředu…) – zachová cíl a vzdálenost
  view(dir) {
    const dist = this.camera.position.distanceTo(this.controls.target);
    this.camera.position.copy(this.controls.target).addScaledVector(dir.clone().normalize(), dist);
    if (Math.abs(dir.y) > 0.99) this.camera.up.set(0, 0, -1); else this.camera.up.set(0, 1, 0);
    this.controls.update();
    this.camera.up.set(0, 1, 0);
    this.requestRender();
  }

  // paprsek z bodu na plátně (clientX/Y) → normalizované souřadnice
  ndc(x, y) {
    const r = this.canvas.getBoundingClientRect();
    return new THREE.Vector2(((x - r.left) / r.width) * 2 - 1, -((y - r.top) / r.height) * 2 + 1);
  }

  toScreen(p) {
    const v = p.clone().project(this.camera);
    const r = this.canvas.getBoundingClientRect();
    return { x: (v.x + 1) / 2 * r.width, y: (1 - v.y) / 2 * r.height, behind: v.z > 1 };
  }

  // jednoduché události (theme)
  #ev = new EventTarget();
  on(t, f) { this.#ev.addEventListener(t, (e) => f(e.detail)); }
  dispatch(t, d) { this.#ev?.dispatchEvent(new CustomEvent(t, { detail: d })); }
}
