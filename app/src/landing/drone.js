import * as THREE from 'three'
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js'
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js'
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js'
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js'
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js'
import { Line2 } from 'three/examples/jsm/lines/Line2.js'
import { LineGeometry } from 'three/examples/jsm/lines/LineGeometry.js'
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js'

// Foldable camera drone, modelled from a visual reference (no brand marks). Nose = +Z.
const capture = new URLSearchParams(location.search).has('capture')
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: capture })
renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
renderer.toneMapping = THREE.ACESFilmicToneMapping
renderer.toneMappingExposure = 1.1
renderer.shadowMap.enabled = true
renderer.shadowMap.type = THREE.PCFSoftShadowMap
const hero = document.getElementById('hero')
hero.prepend(renderer.domElement)

const scene = new THREE.Scene()
scene.background = new THREE.Color(0x0e1013)
scene.environment = new THREE.PMREMGenerator(renderer).fromScene(new RoomEnvironment(), 0.04).texture
scene.environmentIntensity = 0.45

const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 100)
camera.position.set(0, 3.3, 8.4)
camera.lookAt(0, -0.75, 0)

const key = new THREE.DirectionalLight(0xffffff, 2.6); key.position.set(2.5, 9, 4); key.castShadow = true
key.shadow.mapSize.set(2048, 2048); Object.assign(key.shadow.camera, { left: -4, right: 4, top: 4, bottom: -4 }); key.shadow.radius = 5
scene.add(key)
const rim = new THREE.DirectionalLight(0xa9bfd8, 2.2); rim.position.set(-6, 4, -6); scene.add(rim)
const fill = new THREE.DirectionalLight(0xffe2cc, 0.6); fill.position.set(6, 2, 2); scene.add(fill)
const floor = new THREE.Mesh(new THREE.PlaneGeometry(40, 40), new THREE.ShadowMaterial({ opacity: 0.35 }))
floor.rotation.x = -Math.PI / 2; floor.position.y = -1.25; floor.receiveShadow = true; scene.add(floor)

// ---------- materials
const plastic = (color, rough = 0.48, coat = 0.3) => new THREE.MeshPhysicalMaterial({ color, roughness: rough, clearcoat: coat, clearcoatRoughness: 0.35 })
const M = {
  shell: plastic(0x5b6068, 0.42, 0.55),
  shellDark: plastic(0x2c3036, 0.5, 0.3),
  arm: plastic(0x3a3f46, 0.45, 0.35),
  pod: plastic(0x6a7078, 0.4, 0.5),
  rubber: new THREE.MeshStandardMaterial({ color: 0x16181b, roughness: 0.9 }),
  metal: new THREE.MeshStandardMaterial({ color: 0xc4c9cf, metalness: 1, roughness: 0.25 }),
  darkMetal: new THREE.MeshStandardMaterial({ color: 0x3a3f46, metalness: 0.95, roughness: 0.3 }),
  copper: new THREE.MeshStandardMaterial({ color: 0xb87440, metalness: 1, roughness: 0.35 }),
  brass: new THREE.MeshStandardMaterial({ color: 0xb59a3a, metalness: 1, roughness: 0.3 }),
  glass: new THREE.MeshPhysicalMaterial({ color: 0x030405, roughness: 0.03, metalness: 0.3, clearcoat: 1 }),
  pcb: new THREE.MeshStandardMaterial({ color: 0x18402f, roughness: 0.55 }),
  chip: new THREE.MeshStandardMaterial({ color: 0x0c0d0f, roughness: 0.4 }),
  gold: new THREE.MeshStandardMaterial({ color: 0xc9a24f, metalness: 1, roughness: 0.3 }),
  prop: plastic(0x141619, 0.38, 0.6),
  cell: new THREE.MeshStandardMaterial({ color: 0x23262b, roughness: 0.6 }),
  ledG: new THREE.MeshStandardMaterial({ color: 0x0c2416, emissive: 0x2fe07a, emissiveIntensity: 0 }),
  ledR: new THREE.MeshStandardMaterial({ color: 0x240c0c, emissive: 0xff3a3a, emissiveIntensity: 0 }),
  blur: new THREE.MeshBasicMaterial({ color: 0x9aa3ad, transparent: true, opacity: 0, depthWrite: false }),
}
const mesh = (g, m, shadow = true) => { const x = new THREE.Mesh(g, m); x.castShadow = shadow; x.receiveShadow = true; return x }

const rand = (() => { let s = 23; return () => (s = (s * 16807) % 2147483647) / 2147483647 })()
const drone = new THREE.Group(); drone.scale.setScalar(0.9); scene.add(drone)
const parts = []
const add = (obj, order, dock = 'above') => { drone.add(obj); parts.push({ obj, order, dock }); return obj }

// body outline seen from above (x = width, y = -z length), chamfered nose and tail
function outline(w, front, back, cf = 0.22, cb = 0.12) {
  const s = new THREE.Shape()
  const p = [[-w + cf, front], [w - cf, front], [w, front - cf * 1.3], [w, -back + cb], [w - cb, -back], [-w + cb, -back], [-w, -back + cb], [-w, front - cf * 1.3]]
  p.forEach(([x, z], i) => (i ? s.lineTo(x, -z) : s.moveTo(x, -z))); s.closePath(); return s
}
function slab(shape, depth, bevel) {
  const g = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: true, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 3 })
  g.rotateX(-Math.PI / 2); return g
}

// ---- 0: lower chassis + electronics
add(mesh(slab(outline(0.42, 1.05, 1.0), 0.16, 0.04), M.shellDark), 0, 'below').position.y = -0.2
const fc = new THREE.Group()
fc.add(mesh(new THREE.BoxGeometry(0.62, 0.025, 1.1), M.pcb))
for (const [x, z, w, d] of [[0, 0.15, 0.24, 0.24], [0.17, -0.25, 0.14, 0.12], [-0.17, -0.3, 0.12, 0.16], [0.16, 0.42, 0.1, 0.1], [-0.15, 0.45, 0.12, 0.08]]) {
  const c = mesh(new THREE.BoxGeometry(w, 0.04, d), M.chip); c.position.set(x, 0.032, z); fc.add(c)
}
for (let i = 0; i < 6; i++) { const g = mesh(new THREE.BoxGeometry(0.03, 0.01, 0.03), M.gold, false); g.position.set(-0.23 + i * 0.09, 0.018, -0.5); fc.add(g) }
fc.position.y = 0.0
add(fc, 0)

// ---- 1: hinge knuckles + folding arms (front arms high, rear arms low, like real foldables)
const MOTORS = []
const ARMS = [
  { hinge: [0.43, 0.06, 0.62], tip: [1.42, 0.06, 1.05] },
  { hinge: [-0.43, 0.06, 0.62], tip: [-1.42, 0.06, 1.05] },
  { hinge: [0.43, -0.12, -0.62], tip: [1.42, -0.12, -1.0] },
  { hinge: [-0.43, -0.12, -0.62], tip: [-1.42, -0.12, -1.0] },
]
for (const { hinge, tip } of ARMS) {
  const h = new THREE.Vector3(...hinge), t = new THREE.Vector3(...tip)
  const len = h.distanceTo(t)
  const arm = new THREE.Group()
  const bar = mesh(new RoundedBoxGeometry(len - 0.1, 0.1, 0.17, 4, 0.04), M.arm); bar.position.x = len / 2; arm.add(bar)
  const rib = mesh(new RoundedBoxGeometry(len - 0.35, 0.02, 0.08, 2, 0.01), M.shellDark); rib.position.set(len / 2, 0.055, 0); arm.add(rib)
  arm.position.copy(h); arm.rotation.y = -Math.atan2(t.z - h.z, t.x - h.x)
  add(arm, 1, 'swing')
  const knuckle = new THREE.Group()
  knuckle.add(mesh(new THREE.CylinderGeometry(0.11, 0.11, 0.16, 28), M.shellDark))
  const pin = mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.18, 12), M.metal); knuckle.add(pin)
  knuckle.position.copy(h)
  add(knuckle, 1)
  MOTORS.push(t)
}

// ---- 2: battery (slides in from the back) + camera
const battery = new THREE.Group()
battery.add(mesh(new RoundedBoxGeometry(0.66, 0.22, 0.9, 4, 0.05), M.cell))
for (let i = 0; i < 6; i++) { const g = mesh(new THREE.BoxGeometry(0.5, 0.012, 0.02), M.shellDark, false); g.position.set(0, 0.11, -0.4 + i * 0.03); battery.add(g) }
const contacts = mesh(new THREE.BoxGeometry(0.2, 0.06, 0.02), M.gold, false); contacts.position.set(0, -0.03, 0.455); battery.add(contacts)
battery.position.set(0, 0.06, -0.55)
add(battery, 2, 'back')
const cam = new THREE.Group()
const housing = mesh(new THREE.SphereGeometry(0.13, 32, 16), M.shellDark); housing.scale.set(1.25, 1, 1.1); cam.add(housing)
const lens = mesh(new THREE.CylinderGeometry(0.065, 0.07, 0.06, 32), M.glass); lens.rotation.x = Math.PI / 2; lens.position.z = 0.14; cam.add(lens)
const ring = mesh(new THREE.TorusGeometry(0.07, 0.01, 8, 32), M.metal, false); ring.position.z = 0.17; cam.add(ring)
cam.position.set(0, -0.18, 1.06)
add(cam, 2, 'front')

// ---- 3: motor pods (taper into legs) + motors + nav LEDs
MOTORS.forEach((t, i) => {
  const pod = new THREE.Group()
  const profile = [[0, -0.62], [0.05, -0.62], [0.07, -0.58], [0.1, -0.3], [0.15, -0.02], [0.175, 0.08], [0.175, 0.12], [0, 0.12]].map(([x, y]) => new THREE.Vector2(x, y))
  pod.add(mesh(new THREE.LatheGeometry(profile, 40), M.pod))
  const foot = mesh(new THREE.CylinderGeometry(0.055, 0.045, 0.05, 20), M.rubber); foot.position.y = -0.64; pod.add(foot)
  const front = t.z > 0
  const led = mesh(new THREE.SphereGeometry(0.03, 12, 8), front ? M.ledG : M.ledR, false); led.position.set(0, -0.2, front ? 0.115 : -0.115); pod.add(led)
  pod.position.copy(t)
  add(pod, 3, 'below')
  const motor = new THREE.Group()
  const stator = mesh(new THREE.CylinderGeometry(0.12, 0.12, 0.07, 24), M.copper); stator.position.y = 0.16; motor.add(stator)
  const bell = mesh(new THREE.CylinderGeometry(0.145, 0.145, 0.09, 36), M.darkMetal); bell.position.y = 0.24; motor.add(bell)
  const band = mesh(new THREE.TorusGeometry(0.146, 0.008, 8, 36), M.metal, false); band.rotation.x = Math.PI / 2; band.position.y = 0.21; motor.add(band)
  motor.position.copy(t)
  add(motor, 3)
})

// ---- 4: upper shell (closes over the electronics) + screws
const upper = new THREE.Group()
upper.add(mesh(slab(outline(0.4, 1.0, 0.95, 0.24, 0.12), 0.1, 0.05), M.shell))
const ridge = mesh(slab(outline(0.22, 0.62, 0.65, 0.12, 0.06), 0.06, 0.03), M.shell); ridge.position.y = 0.12; upper.add(ridge)
for (const s of [-1, 1]) { const vent = mesh(new THREE.BoxGeometry(0.02, 0.012, 0.36), M.shellDark, false); vent.position.set(s * 0.3, 0.155, -0.45); upper.add(vent) }
upper.position.y = 0.1
add(upper, 4)
for (const { hinge } of ARMS) {
  const screw = new THREE.Group()
  screw.add(mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.02, 14), M.metal, false))
  const shaft = mesh(new THREE.CylinderGeometry(0.014, 0.014, 0.1, 8), M.metal, false); shaft.position.y = -0.06; screw.add(shaft)
  screw.position.set(hinge[0], hinge[1] + 0.09, hinge[2])
  add(screw, 4, 'screw')
}

// ---- 5: propellers (two slim blades, brass cap)
const bs = new THREE.Shape()
bs.moveTo(0, -0.03); bs.bezierCurveTo(0.2, -0.085, 0.62, -0.075, 0.86, -0.02)
bs.quadraticCurveTo(0.9, 0, 0.86, 0.02); bs.bezierCurveTo(0.6, 0.04, 0.2, 0.06, 0, 0.03)
const bladeGeo = new THREE.ExtrudeGeometry(bs, { depth: 0.01, bevelEnabled: true, bevelThickness: 0.005, bevelSize: 0.005, bevelSegments: 2, curveSegments: 28 })
bladeGeo.rotateX(Math.PI / 2)
const props = []
MOTORS.forEach((t, i) => {
  const prop = new THREE.Group(), spinner = new THREE.Group()
  const dir = (t.x > 0) === (t.z > 0) ? -1 : 1
  for (const r of [0, Math.PI]) { const b = mesh(bladeGeo, M.prop); b.rotation.y = r; b.rotation.x = dir * 0.2; spinner.add(b) }
  const cap = mesh(new THREE.SphereGeometry(0.06, 20, 12, 0, Math.PI * 2, 0, Math.PI / 2), M.brass); cap.position.y = 0.02; spinner.add(cap)
  const disc = new THREE.Mesh(new THREE.CircleGeometry(0.9, 48), M.blur); disc.rotation.x = -Math.PI / 2
  prop.add(spinner, disc)
  prop.position.set(t.x, t.y + 0.31, t.z)
  prop.userData = { spinner, dir }
  props.push(prop)
  add(prop, 5, 'prop')
})

// ---------- subtle bloom: only the small LEDs pass the threshold
const composer = new EffectComposer(renderer)
composer.addPass(new RenderPass(scene, camera))
composer.addPass(new UnrealBloomPass(new THREE.Vector2(1, 1), 0.55, 0.35, 0.82))
composer.addPass(new OutputPass())

// ---------- edge glow (fresnel rim) per part, and whoosh streaks
const rimShader = {
  uniforms: { uColor: { value: new THREE.Color(0xd6e6ff) }, uI: { value: 0 } },
  vertexShader: `varying vec3 vN; varying vec3 vV;
    void main(){ vec4 mv = modelViewMatrix * vec4(position,1.0); vN = normalize(normalMatrix*normal); vV = normalize(-mv.xyz); gl_Position = projectionMatrix*mv; }`,
  fragmentShader: `uniform vec3 uColor; uniform float uI; varying vec3 vN; varying vec3 vV;
    void main(){ float r = pow(1.0 - max(dot(normalize(vN), normalize(vV)), 0.0), 2.2); gl_FragColor = vec4(uColor * r * uI, 1.0); }`,
}
const trailMats = []
function decorate(part) {
  const mat = new THREE.ShaderMaterial({ ...rimShader, uniforms: THREE.UniformsUtils.clone(rimShader.uniforms), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false })
  const meshes = []
  part.obj.traverse((m) => { if (m.isMesh && m.material !== M.blur) meshes.push(m) })
  for (const m of meshes) { const g = new THREE.Mesh(m.geometry, mat); g.renderOrder = 2; m.add(g) }
  part.rim = mat
  part.trails = []
  for (let j = 0; j < 3; j++) {
    const lm = new LineMaterial({ color: 0xffffff, linewidth: j === 0 ? 2.2 : 1.2, vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, worldUnits: false })
    trailMats.push(lm)
    const line = new Line2(new LineGeometry(), lm)
    line.frustumCulled = false
    line.userData.offset = new THREE.Vector3((rand() - 0.5) * 0.18, (rand() - 0.5) * 0.18, (rand() - 0.5) * 0.18).multiplyScalar(j === 0 ? 0 : 1)
    line.visible = false
    drone.add(line)
    part.trails.push(line)
  }
}

// ---------- fly-in from the screen edges
const STAGGER = 0.085, FLY = 1.05, HOLD = 0.08, DOCK = 0.32
const DUR = FLY + HOLD + DOCK
parts.sort((a, b) => a.order - b.order)
parts.forEach(decorate)
const UP = new THREE.Vector3(0, 1, 0)
const INSERT = { above: [0, 0.55, 0], below: [0, -0.55, 0], back: [0, 0, -0.8], front: [0, 0, 0.5], screw: [0, 0.35, 0], prop: [0, 0.45, 0], swing: [0, 0, 0] }

function setupFlights() {
  camera.updateMatrixWorld(); drone.updateMatrixWorld()
  const dir = new THREE.Vector3(); camera.getWorldDirection(dir)
  const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(dir.clone().negate(), new THREE.Vector3())
  const ray = new THREE.Raycaster()
  parts.forEach((p, i) => {
    const o = p.obj, u = o.userData
    u.endPos ??= o.position.clone(); u.endQuat ??= o.quaternion.clone()
    const edge = i % 4, along = rand() * 2 - 1
    ray.setFromCamera(new THREE.Vector2(edge === 0 ? -1.3 : edge === 1 ? 1.3 : along * 1.1, edge === 2 ? 1.35 : edge === 3 ? -1.35 : along * 1.1), camera)
    const hit = new THREE.Vector3(); ray.ray.intersectPlane(plane, hit)
    hit.addScaledVector(dir, -(rand() * 2))
    u.start = drone.worldToLocal(hit)
    u.startQuat = new THREE.Quaternion().setFromEuler(new THREE.Euler(rand() * 6.3, rand() * 6.3, rand() * 6.3))
    u.pre = u.endPos.clone().add(new THREE.Vector3(...INSERT[p.dock]))
    u.preQuat = u.endQuat.clone()
    if (p.dock === 'swing') { // arm arrives folded along the body, then swings out on its hinge
      const base = new THREE.Euler().setFromQuaternion(u.endQuat).y
      const tipX = (yaw) => Math.abs(Math.cos(yaw)) // folded = tip pointing along the body (small x)
      const fold = [1.75, -1.75].map((d) => base + d).sort((a, b2) => tipX(a) - tipX(b2) || Math.sign(u.endPos.z) * (a - b2))[0]
      u.preQuat = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, fold, 0))
    }
    // curved approach: swing around the drone before lining up with the slot
    const sideways = new THREE.Vector3().crossVectors(UP, u.start).normalize().multiplyScalar((rand() < 0.5 ? -1 : 1) * (1.6 + rand() * 1.4))
    u.c1 = u.start.clone().multiplyScalar(0.55).add(sideways).add(new THREE.Vector3(0, 0.6 + rand(), 0))
    const out = u.pre.clone().setY(0); if (out.lengthSq() < 0.01) out.set(rand() - 0.5, 0, rand() - 0.5)
    u.c2 = u.pre.clone().add(out.normalize().multiplyScalar(1.4)).add(new THREE.Vector3(0, 0.9, 0)).add(new THREE.Vector3(...INSERT[p.dock]).multiplyScalar(1.5))
    u.spins = (rand() < 0.5 ? -1 : 1) * (1 + Math.floor(rand() * 2))
    u.t0 = i * STAGGER
  })
}
const easeInOutCubic = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2)
const easeOutCubic = (t) => 1 - (1 - t) ** 3
const bez = (u, k, out) => {
  const m = 1 - k
  return out.copy(u.start).multiplyScalar(m * m * m)
    .addScaledVector(u.c1, 3 * m * m * k).addScaledVector(u.c2, 3 * m * k * k).addScaledVector(u.pre, k * k * k)
}
const qa = new THREE.Quaternion(), qb = new THREE.Quaternion()
// pose of a part at time t; returns phase: 0 hidden, 1 flying, 2 docking, 3 done
function pose(part, t, pos, quat) {
  const u = part.obj.userData, local = t - u.t0
  if (local <= 0) { pos.copy(u.start); quat.copy(u.startQuat); return 0 }
  if (local < FLY) {
    const k = easeInOutCubic(local / FLY)
    bez(u, k, pos)
    // tumble with extra spin that winds down as it lines up
    qa.setFromAxisAngle(UP, u.spins * Math.PI * 2 * (1 - k) ** 2)
    quat.slerpQuaternions(u.startQuat, u.preQuat, easeOutCubic(local / FLY)).premultiply(qa)
    return 1
  }
  const d = THREE.MathUtils.clamp((local - FLY - HOLD) / DOCK, 0, 1)
  const e = easeInOutCubic(d)
  pos.lerpVectors(u.pre, u.endPos, e)
  if (part.dock === 'swing') quat.slerpQuaternions(u.preQuat, u.endQuat, e)
  else if (part.dock === 'screw') quat.copy(u.endQuat).multiply(qb.setFromAxisAngle(UP, (1 - e) * Math.PI * 6))
  else if (part.dock === 'prop') quat.copy(u.endQuat).multiply(qb.setFromAxisAngle(UP, (1 - e) * Math.PI / 2))
  else quat.copy(u.endQuat)
  return local >= DUR ? 3 : 2
}
const ASSEMBLED = (parts.length - 1) * STAGGER + DUR
let readyShown = false
const pointer = { x: 0, y: 0 }

const TRAIL_PTS = 20, TRAIL_TIME = 0.22
const tp = new THREE.Vector3(), tq = new THREE.Quaternion()
function renderAt(t) {
  for (const part of parts) {
    const { obj } = part, u = obj.userData
    const phase = pose(part, t, obj.position, obj.quaternion)
    obj.visible = phase > 0
    const local = t - u.t0
    // glow: on while moving, flash when it locks in, then gone
    part.rim.uniforms.uI.value = phase === 0 ? 0 : phase < 3 ? 0.45 + 0.25 * Math.min(1, local / FLY) : Math.max(0, 1.4 * (1 - (local - DUR) / 0.45))
    // whoosh streaks follow the curved path just travelled
    const fade = phase === 1 ? Math.min(1, local * 6) * Math.min(1, (FLY - local) * 3) : 0
    for (const line of part.trails) {
      line.visible = fade > 0.01
      if (!line.visible) continue
      const pts = [], cols = []
      for (let i = 0; i < TRAIL_PTS; i++) {
        const back = (i / (TRAIL_PTS - 1)) * TRAIL_TIME
        pose(part, Math.max(u.t0 + 0.001, t - back), tp, tq)
        tp.add(line.userData.offset)
        pts.push(tp.x, tp.y, tp.z)
        const a = fade * Math.pow(1 - i / (TRAIL_PTS - 1), 1.5) * (line.userData.offset.lengthSq() ? 0.5 : 0.85)
        cols.push(0.85 * a, 0.9 * a, a)
      }
      line.geometry.setPositions(pts)
      line.geometry.setColors(cols)
      line.computeLineDistances()
    }
  }
  const after = Math.max(0, t - ASSEMBLED)
  const spin = THREE.MathUtils.clamp(after / 0.9, 0, 1)
  for (const p of props) p.userData.spinner.rotation.y = p.userData.dir * (after * after * 18 + after * 32 * spin)
  M.blur.opacity = spin * 0.05
  M.ledG.emissiveIntensity = M.ledR.emissiveIntensity = after > 0.1 ? 2.2 : 0
  // while it is being built: hover in place, nudged by each part that locks in
  const lift = easeOutCubic(THREE.MathUtils.clamp((after - 0.5) / 1.3, 0, 1))
  const build = easeOutCubic(Math.min(1, t / ASSEMBLED))
  let dipY = 0, kickX = 0, kickZ = 0
  for (const part of parts) {
    const x = t - (part.obj.userData.t0 + DUR)
    if (x < 0 || x > 0.8) continue
    const wobble = Math.exp(-6 * x) * Math.sin(17 * x)
    const e = part.obj.userData.endPos
    dipY -= 0.09 * wobble
    kickX += 0.07 * wobble * Math.sign(e.z || 0)
    kickZ -= 0.07 * wobble * Math.sign(e.x || 0)
  }
  const hoverX = 0.32 * Math.sin(t * 0.8), hoverZ = 0.18 * Math.sin(t * 1.6)
  const hoverY = 0.4 * lift + 0.2 * Math.sin(t * 1.4) + 0.08 * Math.sin(t * 2.5 + 1) + dipY
  const hoverYaw = -0.95 * (1 - build) + 0.3 * Math.sin(t * 0.5)
  const hoverRoll = -0.16 * Math.cos(t * 0.8) + 0.04 * Math.sin(t * 2.1) + kickZ
  const hoverPitch = -0.06 + 0.03 * Math.cos(t * 1.6) + kickX * 0.4

  // after take-off: fly a wide loop around the screen, facing where it goes and banking into turns
  const fly = easeInOutCubic(THREE.MathUtils.clamp((after - 2.2) / 2.5, 0, 1))
  const ft = Math.max(0, after - 2.2)
  const wide = camera.aspect < 0.8 ? 0.8 : 1.9
  const path = (u) => new THREE.Vector3(wide * Math.sin(u * 0.34), -0.4 + 0.12 * Math.sin(u * 0.52), -0.9 + 0.5 * Math.sin(u * 0.68))
  const p0 = path(ft), p1 = path(ft + 0.08), p2 = path(ft + 0.16)
  const v1 = p1.clone().sub(p0), v2 = p2.clone().sub(p1)
  const heading = Math.atan2(v1.x, v1.z)
  const turn = Math.atan2(v2.x, v2.z) - heading
  const speed = v1.length() / 0.08
  const bank = THREE.MathUtils.clamp(-Math.atan2(Math.sin(turn), Math.cos(turn)) * 6, -0.45, 0.45)
  const lerp = THREE.MathUtils.lerp
  // shortest way round from the hover yaw to the flight heading
  let dYaw = heading - hoverYaw; dYaw = Math.atan2(Math.sin(dYaw), Math.cos(dYaw))
  drone.position.set(lerp(hoverX, p0.x, fly), lerp(hoverY, p0.y + 0.06 * Math.sin(t * 2.3), fly), lerp(hoverZ, p0.z, fly))
  drone.rotation.y = hoverYaw + dYaw * fly
  drone.rotation.z = lerp(hoverRoll, bank, fly) + pointer.x * 0.06
  drone.rotation.x = lerp(hoverPitch, 0.05 + speed * 0.05, fly) - pointer.y * 0.03
  if (after > 0.25 && !readyShown) {
    readyShown = true
    document.body.classList.add('ready')
  }
  composer.render()
}

hero.addEventListener('pointermove', (e) => { pointer.x = e.clientX / innerWidth - 0.5; pointer.y = e.clientY / innerHeight - 0.5 })
function resize() {
  const w = hero.clientWidth, h = hero.clientHeight
  renderer.setSize(w, h, false); composer.setSize(w, h)
  for (const m of trailMats) m.resolution.set(w, h)
  camera.aspect = w / h
  const portrait = camera.aspect < 0.8 // phones: wider lens, drone framed in the top half above the text
  camera.fov = portrait ? 58 : 30
  camera.position.set(0, 3.3, portrait ? 9.2 : 8.4)
  camera.lookAt(0, portrait ? -2.6 : -0.75, 0)
  camera.updateProjectionMatrix()
}
addEventListener('resize', resize); resize(); setupFlights()

const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches
if (capture) { document.body.classList.add('capture'); window.renderAt = renderAt; window.ASSEMBLED = ASSEMBLED }
else {
  let start = performance.now() - (reduce ? ASSEMBLED * 1000 + 2000 : 0)
  const skip = (e) => {
    if (e.target.closest && e.target.closest('a')) return // let the buttons work
    const now = (performance.now() - start) / 1000
    if (now < ASSEMBLED) start = performance.now() - ASSEMBLED * 1000
  }
  hero.addEventListener('pointerdown', skip)
  addEventListener('keydown', skip)
  const loop = () => renderAt((performance.now() - start) / 1000)
  renderer.setAnimationLoop(loop)
  // stop drawing while the hero is scrolled out of view (saves battery)
  new IntersectionObserver(([e]) => renderer.setAnimationLoop(e.isIntersecting ? loop : null)).observe(hero)
}
