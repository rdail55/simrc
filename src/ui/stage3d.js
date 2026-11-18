// 3D stage: the MVR set (room, truss, scenery) with fixtures placed as in the MVR, and beams that follow the
// live engine (colour, intensity, strobe, pan/tilt, zoom). Without an MVR, fixtures are hung on a virtual truss
// using their Lightkey stage positions. MVR space is millimetres with Z up; `world` converts to metres, Y up.
// Adapted from Custom DMX's web/stage3d.js.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { segmentLook } from '../engine.js';

const BEAM_LENGTH = 14000; // mm
const SET_COLOR = new THREE.Color('#8d9096');
const BODY = new THREE.BoxGeometry(220, 220, 320).translate(0, 0, 40);
const LENS = new THREE.CircleGeometry(95, 24).rotateX(Math.PI).translate(0, 0, -125); // faces −Z, the beam axis
const CONE = new THREE.ConeGeometry(1, 1, 40, 1, true).translate(0, -0.5, 0).rotateX(Math.PI / 2);

const beamVertex = /* glsl */ `
  varying float vAlong;
  varying vec3 vNormalV;
  varying vec3 vViewDir;
  void main() {
    vAlong = -position.z;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vNormalV = normalize(normalMatrix * normal);
    vViewDir = normalize(-mv.xyz);
    gl_Position = projectionMatrix * mv;
  }`;
const beamFragment = /* glsl */ `
  uniform vec3 uColor;
  uniform float uIntensity;
  varying float vAlong;
  varying vec3 vNormalV;
  varying vec3 vViewDir;
  void main() {
    float core = pow(abs(dot(normalize(vNormalV), normalize(vViewDir))), 1.6);
    float fall = pow(1.0 - clamp(vAlong, 0.0, 1.0), 1.4);
    float a = uIntensity * core * fall;
    gl_FragColor = vec4(uColor * a, a);
  }`;

const toThree = ([x, y, z]) => new THREE.Vector3(x / 1000, z / 1000, -y / 1000);
const matrixFrom = (m) => new THREE.Matrix4().fromArray([m[0], m[1], m[2], 0, m[3], m[4], m[5], 0, m[6], m[7], m[8], 0, m[9], m[10], m[11], 1]);

/** No MVR: hang every fixture from its Lightkey stage position (1 canvas unit ≈ 50 mm), beams pointing down. */
export function virtualScene(project) {
  const placed = project.fixtures.filter((f) => f.stage);
  const xs = placed.map((f) => f.stage.x), ys = placed.map((f) => f.stage.y);
  const cx = xs.length ? (Math.min(...xs) + Math.max(...xs)) / 2 : 0;
  const cy = ys.length ? (Math.min(...ys) + Math.max(...ys)) / 2 : 0;
  const fixtures = project.fixtures.map((f, i) => {
    const x = f.stage ? (f.stage.x - cx) * 50 : (i - project.fixtures.length / 2) * 600;
    const y = f.stage ? (f.stage.y - cy) * 50 : 0;
    const z = f.per?.hasPanTilt ? 5500 : 5000;
    return { name: f.name, universe: f.universe - 1, address: f.address, fixture: f, matrix: [1, 0, 0, 0, 1, 0, 0, 0, 1, x, y, z] };
  });
  // A floor and a simple stage deck so beams have something to land on.
  const quad = (w, d, h) => {
    const p = new Float32Array([-w, -d, h, w, -d, h, w, d, h, -w, d, h]);
    return { positions: p, indices: new Uint32Array([0, 1, 2, 0, 2, 3]), triangles: 2 };
  };
  const meshes = [{ file: 'floor', ...quad(15000, 15000, 0) }, { file: 'deck', ...quad(6000, 3000, 600) }];
  const I = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];
  const instances = [[0, ...I], [1, ...I.slice(0, 9), 0, 2000, 0]];
  return { generator: 'Lightkey stage layout', virtual: true, meshes, instances, fixtures, bounds: { min: [-8000, -8000, 0], max: [8000, 8000, 6000] }, stats: { triangles: 4 } };
}

export class Stage3D {
  constructor(container) {
    this.container = container;
    this.fixtures = [];
    this.haze = 0.6;
    this.active = false;
    this.states = null;

    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(1.5, window.devicePixelRatio || 1));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x07080a);
    this.camera = new THREE.PerspectiveCamera(50, 1, 0.1, 500);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;

    this.ambient = new THREE.AmbientLight(0xffffff, 0);
    this.hemi = new THREE.HemisphereLight(0xbfd4ff, 0x2a2622, 0);
    this.scene.add(this.ambient, this.hemi);
    this.setHouse(0.15);

    this.world = new THREE.Group();
    this.world.rotation.x = -Math.PI / 2;
    this.world.scale.setScalar(0.001);
    this.scene.add(this.world);

    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
    this.renderer.setAnimationLoop(() => this.render());
  }

  clear() {
    for (const child of [...this.world.children]) {
      this.world.remove(child);
      child.traverse?.((o) => { if (o.geometry && o.geometry !== BODY && o.geometry !== LENS && o.geometry !== CONE) o.geometry.dispose(); o.material?.dispose?.(); });
    }
    this.fixtures = [];
    this.bodyMat = null;
  }

  build(data) {
    this.clear();
    this.data = data;
    const perMesh = data.meshes.map(() => []);
    for (const inst of data.instances) perMesh[inst[0]].push(inst.slice(1));
    data.meshes.forEach((m, i) => {
      if (!perMesh[i].length) return;
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(m.positions, 3));
      g.setIndex(new THREE.BufferAttribute(m.indices, 1));
      g.computeVertexNormals();
      const mat = new THREE.MeshLambertMaterial({ color: data.virtual ? (i === 0 ? 0x2a2c30 : 0x3a3c42) : SET_COLOR, side: THREE.DoubleSide, flatShading: true });
      const mesh = new THREE.InstancedMesh(g, mat, perMesh[i].length);
      perMesh[i].forEach((mtx, j) => mesh.setMatrixAt(j, matrixFrom(mtx)));
      mesh.computeBoundingSphere();
      this.world.add(mesh);
    });

    for (const sf of data.fixtures) this.addFixture(sf);
    this.frame();
  }

  /** Add one fixture (an MVR-style record with `matrix`, and `fixture` for its live state). */
  addFixture(sf) {
    this.bodyMat ||= new THREE.MeshLambertMaterial({ color: 0x16181c });
    const bodyMat = this.bodyMat;
    const root = new THREE.Group();
    root.matrixAutoUpdate = false;
    root.matrix.copy(matrixFrom(sf.matrix));
    const head = new THREE.Group();
    head.rotation.order = 'ZXY';
    root.add(head);
    head.add(new THREE.Mesh(BODY, bodyMat));
    const lensMat = new THREE.MeshBasicMaterial({ color: 0x111111 });
    head.add(new THREE.Mesh(LENS, lensMat));
    const beamMat = new THREE.ShaderMaterial({
      uniforms: { uColor: { value: new THREE.Color() }, uIntensity: { value: 0 } },
      vertexShader: beamVertex, fragmentShader: beamFragment,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    });
    const beam = new THREE.Mesh(CONE, beamMat);
    beam.frustumCulled = false;
    head.add(beam);
    const spot = new THREE.SpotLight(0xffffff, 0, 0, 0.3, 0.5, 0);
    spot.position.set(0, 0, -130);
    const target = new THREE.Object3D();
    target.position.set(0, 0, -5000);
    head.add(spot, target);
    spot.target = target;
    this.world.add(root);
    const fx = { sf, root, head, lensMat, beamMat, beam, spot };
    this.fixtures.push(fx);
    return fx;
  }

  removeFixture(fx) {
    this.world.remove(fx.root);
    fx.lensMat.dispose(); fx.beamMat.dispose(); fx.spot.dispose?.();
    this.fixtures = this.fixtures.filter((f) => f !== fx);
  }

  /** Point the camera at the whole scene from front-of-house. */
  frame(view = 'foh') {
    // Frame the rig (fixtures), not the whole building: an MVR room can be far bigger than the stage.
    const pts = (this.data?.fixtures || []).map((f) => f.matrix.slice(9, 12));
    let { min, max } = this.data?.bounds || { min: [-5000, -5000, 0], max: [5000, 5000, 5000] };
    if (pts.length > 1) {
      min = [0, 1, 2].map((i) => Math.min(...pts.map((p) => p[i])));
      max = [0, 1, 2].map((i) => Math.max(...pts.map((p) => p[i])));
      min[2] = Math.min(min[2], 0);
    }
    const c = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
    const size = Math.max(4000, max[0] - min[0], max[1] - min[1]);
    const views = {
      foh: [[c[0], min[1] - size * 0.9, c[2] + size * 0.25], [c[0], c[1], c[2] * 0.6]],
      top: [[c[0], c[1] - 1, max[2] + size * 1.4], [c[0], c[1], 0]],
      side: [[max[0] + size * 0.8, c[1] - size * 0.3, c[2] + size * 0.2], [c[0], c[1], c[2] * 0.6]],
      stage: [[c[0], max[1] + size * 0.2, c[2] + 1500], [c[0], min[1] - size, c[2] * 0.4]],
    };
    const [pos, tgt] = views[view] || views.foh;
    this.camera.position.copy(toThree(pos));
    this.controls.target.copy(toThree(tgt));
    this.controls.update();
  }

  setHouse(v) {
    this.ambient.intensity = 0.05 + 1.2 * v;
    this.hemi.intensity = 0.05 + 1.0 * v;
  }

  resize() {
    const r = this.container.getBoundingClientRect();
    if (!r.width || !r.height) return;
    this.renderer.setSize(r.width, r.height);
    this.camera.aspect = r.width / r.height;
    this.camera.updateProjectionMatrix();
  }

  update() {
    const states = this.states;
    const now = performance.now();
    const deg = Math.PI / 180;
    for (const fx of this.fixtures) {
      const f = fx.sf.fixture;
      const st = f && states?.[f.index];
      let rgb = [0, 0, 0], b = 0, angle = fx.sf.beamAngle || 25;
      if (st) {
        // Average the segments (multi-cell fixtures) into one beam.
        let r = 0, g = 0, bl = 0, bb = 0;
        for (const s of st.seg) {
          const look = segmentLook(f, s, st, now);
          r += look.rgb[0] * look.b; g += look.rgb[1] * look.b; bl += look.rgb[2] * look.b; bb = Math.max(bb, look.b);
        }
        const n = st.seg.length;
        b = bb;
        rgb = bb > 0 ? [r / n / bb, g / n / bb, bl / n / bb] : [0, 0, 0];
        const mx = Math.max(...rgb, 1e-6);
        if (mx < 1) rgb = rgb.map((v) => v / mx);
        if (f.per?.hasPanTilt) {
          fx.head.rotation.z = (f.stage?.panInverted ? -1 : 1) * st.pan;
          fx.head.rotation.x = st.tilt;
        }
        angle = st.zoomAngle ?? (f.profile.beamSpread || fx.sf.beamAngle || (f.per?.hasPanTilt ? 12 : 30));
      }
      const radius = BEAM_LENGTH * Math.tan((Math.min(angle, 120) * deg) / 2);
      fx.beam.scale.set(radius, radius, BEAM_LENGTH);
      fx.beamMat.uniforms.uColor.value.setRGB(rgb[0], rgb[1], rgb[2]);
      fx.beamMat.uniforms.uIntensity.value = b * this.haze * (f?.per?.hasPanTilt ? 1.1 : 0.7);
      fx.beam.visible = b > 0.005 && this.haze > 0;
      fx.lensMat.color.setRGB(0.07 + rgb[0] * b, 0.07 + rgb[1] * b, 0.07 + rgb[2] * b, THREE.SRGBColorSpace);
      fx.spot.color.setRGB(rgb[0], rgb[1], rgb[2], THREE.SRGBColorSpace);
      fx.spot.intensity = b * (f?.per?.hasPanTilt ? 3.5 : 2.2);
      fx.spot.angle = Math.min(Math.PI / 2.2, (angle * deg) / 2);
    }
  }

  render() {
    if (!this.active) return;
    this.controls.update();
    this.update();
    this.renderer.render(this.scene, this.camera);
  }
}
