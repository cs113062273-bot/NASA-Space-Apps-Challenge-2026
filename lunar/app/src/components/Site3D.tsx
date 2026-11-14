import { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import { Ephemeris, R0_KM, earthAt, earthPhase, earthShadowFactor, siteFrame, sunAt, sunRadiusDeg, visibleSunFraction } from '../lib/astro'
import { SiteRecord } from '../lib/data'
import { requestPatch } from './CustomSite'
import { drawDisk, usePhotos } from '../lib/ui'

// First-person view from the lander. Local frame: x = east, y = up, z = south (three.js -z = north).
// Near terrain: the 40 m patch (with lunar curvature drop). Far terrain: a ring whose top edge is
// the computed skyline, so what hides the Sun here is exactly what hides it in the numbers.

interface Props {
  eph: Ephemeris
  site: SiteRecord
  cursor: number
  observerM: number
  /** fixed view height (px), to line up with a neighbouring view */
  height?: number
}

interface PatchMeta { n: number; step_m: number; ground_m: number; frame?: 'polar' | 'enu' }

const R = R0_KM * 1000
const RING_R = 6_600
const SKY_R = 40_000
const D2R = Math.PI / 180

const patchCache = new Map<string, Promise<{ meta: PatchMeta; rel: Int16Array } | null>>()
let patchIndex: Promise<Record<string, PatchMeta>> | null = null
function loadPatch(id: string) {
  if (!patchIndex) patchIndex = fetch('./data/patch/patches.json').then((r) => (r.ok ? r.json() : {})).catch(() => ({}))
  let p = patchCache.get(id)
  if (!p) {
    p = patchIndex.then(async (idx) => {
      const meta = idx[id]
      if (!meta) return null
      const buf = await (await fetch(`./data/patch/${id}.i16`)).arrayBuffer()
      return { meta, rel: new Int16Array(buf) }
    })
    patchCache.set(id, p)
  }
  return p
}

const dirFrom = (azDeg: number, elDeg: number) =>
  new THREE.Vector3(Math.cos(elDeg * D2R) * Math.sin(azDeg * D2R), Math.sin(elDeg * D2R), -Math.cos(elDeg * D2R) * Math.cos(azDeg * D2R))

function buildTerrain(meta: PatchMeta, rel: Int16Array, lonDeg: number) {
  const n = meta.n
  const half = ((n - 1) / 2) * meta.step_m
  // polar patches are on the stereographic plane, rotated by longitude; 'enu' patches are already east/north
  const lo = meta.frame === 'enu' ? 0 : lonDeg * D2R
  const pos = new Float32Array(n * n * 3)
  const uv = new Float32Array(n * n * 2)
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      const dx = -half + c * meta.step_m // stereographic X (or east) offset
      const dy = half - r * meta.step_m // stereographic Y (or north) offset
      const e = dx * Math.cos(lo) - dy * Math.sin(lo)
      const no = dx * Math.sin(lo) + dy * Math.cos(lo)
      const drop = (e * e + no * no) / (2 * R)
      const k = (r * n + c) * 3
      pos[k] = e
      pos[k + 1] = rel[r * n + c] / 10 - drop
      pos[k + 2] = -no
      uv[(r * n + c) * 2] = (c / (n - 1)) * 48
      uv[(r * n + c) * 2 + 1] = (r / (n - 1)) * 48
    }
  }
  const idx: number[] = []
  for (let r = 0; r < n - 1; r++) {
    for (let c = 0; c < n - 1; c++) {
      const a = r * n + c
      idx.push(a, a + n, a + 1, a + 1, a + n, a + n + 1)
    }
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2))
  g.setIndex(idx)
  g.computeVertexNormals()
  return g
}

/** Procedural regolith albedo texture (value noise, several octaves) for a sense of scale. */
let regolith: THREE.CanvasTexture | null = null
function regolithTexture() {
  if (regolith) return regolith
  const S = 256
  const c = document.createElement('canvas')
  c.width = c.height = S
  const g = c.getContext('2d')!
  const img = g.createImageData(S, S)
  const rand = (x: number, y: number) => {
    const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453
    return s - Math.floor(s)
  }
  const noise = (x: number, y: number, p: number) => {
    const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi
    const w = (t: number) => t * t * (3 - 2 * t)
    const v = (a: number, b: number) => rand(((a % p) + p) % p, ((b % p) + p) % p)
    const top = v(xi, yi) * (1 - w(xf)) + v(xi + 1, yi) * w(xf)
    const bot = v(xi, yi + 1) * (1 - w(xf)) + v(xi + 1, yi + 1) * w(xf)
    return top * (1 - w(yf)) + bot * w(yf)
  }
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      let v = 0
      let amp = 0.5
      for (let o = 0, f = 4; o < 5; o++, f *= 2, amp *= 0.5) v += amp * noise((x / S) * f, (y / S) * f, f)
      const k = Math.round(150 + (v - 0.5) * 70)
      const i = (y * S + x) * 4
      img.data.set([k, k - 2, k - 5, 255], i)
    }
  }
  g.putImageData(img, 0, 0)
  regolith = new THREE.CanvasTexture(c)
  regolith.wrapS = regolith.wrapT = THREE.RepeatWrapping
  regolith.colorSpace = THREE.SRGBColorSpace
  regolith.anisotropy = 8
  return regolith
}

function buildRing(horizonCentideg: number[], eyeY: number) {
  const n = horizonCentideg.length
  const pos = new Float32Array((n + 1) * 2 * 3)
  for (let j = 0; j <= n; j++) {
    const az = ((j % n) + 0.5) * (360 / n) * D2R
    const el = horizonCentideg[j % n] / 100
    const x = RING_R * Math.sin(az)
    const z = -RING_R * Math.cos(az)
    const top = eyeY + RING_R * Math.tan(Math.max(-30, el) * D2R)
    pos.set([x, top, z, x, top - 3000, z], j * 6)
  }
  const idx: number[] = []
  for (let j = 0; j < n; j++) {
    const a = j * 2
    idx.push(a, a + 1, a + 2, a + 2, a + 1, a + 3)
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  g.setIndex(idx)
  g.computeVertexNormals()
  return g
}

export function Site3D({ eph, site, cursor, observerM, height }: Props) {
  const heightRef = useRef(height)
  heightRef.current = height
  const resizeRef = useRef<(() => void) | null>(null)
  useEffect(() => { resizeRef.current?.() }, [height])
  const host = useRef<HTMLDivElement>(null)
  const ctx = useRef<{
    renderer: THREE.WebGLRenderer; scene: THREE.Scene; camera: THREE.PerspectiveCamera
    sun: THREE.DirectionalLight; sunDisk: THREE.Sprite; sunGlow: THREE.Sprite; earth: THREE.Sprite; earthCanvas: HTMLCanvasElement; earthTex: THREE.CanvasTexture; ambient: THREE.AmbientLight
    world: THREE.Group; yaw: number; pitch: number; fov: number
  } | null>(null)
  const [status, setStatus] = useState('Loading terrain…')
  const [look, setLook] = useState<{ yaw: number; pitch: number } | null>(null)
  const aimed = useRef<string>('')
  const photo = usePhotos()
  const [labels, setLabels] = useState<{ sunDot: { x: number; y: number; d: number } | null; sun: { x: number; y: number } | null; earth: { x: number; y: number } | null; sunVis: boolean; sunEclipsed: boolean; earthVis: boolean; heading: number } | null>(null)

  // one-time renderer setup
  useEffect(() => {
    const el = host.current!
    const renderer = new THREE.WebGLRenderer({ antialias: true, logarithmicDepthBuffer: true })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    renderer.shadowMap.enabled = true
    renderer.shadowMap.type = THREE.PCFSoftShadowMap
    renderer.toneMapping = THREE.ACESFilmicToneMapping
    renderer.toneMappingExposure = 1.5
    renderer.outputColorSpace = THREE.SRGBColorSpace
    el.appendChild(renderer.domElement)
    const scene = new THREE.Scene()
    scene.background = new THREE.Color('#020306')
    const camera = new THREE.PerspectiveCamera(60, 2, 0.3, 200_000)
    const ambient = new THREE.AmbientLight('#8fa4c8', 0.1)
    scene.add(ambient)
    const sun = new THREE.DirectionalLight('#fff4e2', 3.2)
    sun.castShadow = true
    sun.shadow.mapSize.set(4096, 4096)
    const sc = sun.shadow.camera as THREE.OrthographicCamera
    sc.left = -7000; sc.right = 7000; sc.top = 7000; sc.bottom = -7000; sc.near = 100; sc.far = 60_000
    sun.shadow.bias = -0.0004
    sun.shadow.normalBias = 6
    scene.add(sun, sun.target)
    // stars
    const starPos = new Float32Array(2400 * 3)
    for (let i = 0; i < 2400; i++) {
      const u = Math.random() * 2 - 1
      const t = Math.random() * Math.PI * 2
      const s = Math.sqrt(1 - u * u)
      starPos.set([SKY_R * 1.5 * s * Math.cos(t), SKY_R * 1.5 * u, SKY_R * 1.5 * s * Math.sin(t)], i * 3)
    }
    const stars = new THREE.Points(new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(starPos, 3)), new THREE.PointsMaterial({ color: '#c8d4ff', size: 1.2, sizeAttenuation: false, transparent: true, opacity: 0.7 }))
    scene.add(stars)
    // the Sun and Earth are NASA photos on camera-facing sprites; Earth's night side is painted per hour (drawDisk)
    const sunTex = new THREE.TextureLoader().load(new URL('./img/sun.png', document.baseURI).href)
    sunTex.colorSpace = THREE.SRGBColorSpace
    const sunDisk = new THREE.Sprite(new THREE.SpriteMaterial({ map: sunTex, transparent: true, toneMapped: false }))
    const glowTex = (() => {
      const c = document.createElement('canvas')
      c.width = c.height = 128
      const g = c.getContext('2d')!
      const grd = g.createRadialGradient(64, 64, 0, 64, 64, 64)
      grd.addColorStop(0, 'rgba(255,250,235,1)')
      grd.addColorStop(0.08, 'rgba(255,244,215,1)')
      grd.addColorStop(0.25, 'rgba(255,214,140,0.55)')
      grd.addColorStop(0.55, 'rgba(255,190,90,0.16)')
      grd.addColorStop(1, 'rgba(255,170,60,0)')
      g.fillStyle = grd
      g.fillRect(0, 0, 128, 128)
      return new THREE.CanvasTexture(c)
    })()
    const sunGlow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }))
    const earthCanvas = document.createElement('canvas')
    earthCanvas.width = earthCanvas.height = 256
    const earthTex = new THREE.CanvasTexture(earthCanvas)
    earthTex.colorSpace = THREE.SRGBColorSpace
    const earth = new THREE.Sprite(new THREE.SpriteMaterial({ map: earthTex, transparent: true, depthWrite: false, toneMapped: false }))
    sunDisk.renderOrder = 1
    sunGlow.renderOrder = 2
    earth.renderOrder = 3 // paint Earth's circular alpha over the Sun, rather than occluding with a transparent square
    scene.add(sunDisk, sunGlow, earth)
    const world = new THREE.Group()
    scene.add(world)
    ctx.current = { renderer, scene, camera, sun, sunDisk, sunGlow, earth, earthCanvas, earthTex, ambient, world, yaw: 0, pitch: 2, fov: 60 }
    aimed.current = '' // a fresh scene (also after StrictMode's remount) aims again

    const resize = () => {
      const w = el.clientWidth
      if (!w) return
      const h = heightRef.current ?? Math.round(Math.min(520, Math.max(300, w * 0.5)))
      renderer.setSize(w, h)
      camera.aspect = w / h
      camera.updateProjectionMatrix()
      renderer.render(scene, camera)
    }
    const ro = new ResizeObserver(resize)
    ro.observe(el)
    resizeRef.current = resize
    // look around: drag = yaw/pitch, wheel = zoom
    let drag: { x: number; y: number; yaw: number; pitch: number } | null = null
    const dom = renderer.domElement
    const down = (e: PointerEvent) => {
      dom.setPointerCapture(e.pointerId)
      drag = { x: e.clientX, y: e.clientY, yaw: ctx.current!.yaw, pitch: ctx.current!.pitch }
    }
    const move = (e: PointerEvent) => {
      if (!drag || !ctx.current) return
      const k = ctx.current.fov / dom.clientHeight
      ctx.current.yaw = drag.yaw - (e.clientX - drag.x) * k
      ctx.current.pitch = Math.max(-60, Math.min(85, drag.pitch + (e.clientY - drag.y) * k))
      setLook({ yaw: ctx.current.yaw, pitch: ctx.current.pitch })
    }
    const up = () => (drag = null)
    const wheel = (e: WheelEvent) => {
      e.preventDefault()
      if (!ctx.current) return
      ctx.current.fov = Math.max(4, Math.min(90, ctx.current.fov * (e.deltaY > 0 ? 1.15 : 0.87)))
      setLook({ yaw: ctx.current.yaw, pitch: ctx.current.pitch })
    }
    dom.addEventListener('pointerdown', down)
    dom.addEventListener('pointermove', move)
    dom.addEventListener('pointerup', up)
    dom.addEventListener('wheel', wheel, { passive: false })
    return () => {
      ro.disconnect()
      renderer.dispose()
      el.removeChild(dom)
      ctx.current = null
    }
  }, [])

  // terrain for this site
  useEffect(() => {
    const c = ctx.current
    if (!c) return
    let live = true
    setStatus('Loading terrain…')
    const browserPatch = site.custom && site.lat <= -80
    ;(site.custom ? (browserPatch ? requestPatch(site) : Promise.resolve(null)) : loadPatch(site.id)).then((patch) => {
      if (!live || !ctx.current) return
      c.world.clear()
      const eyeY = observerM
      const ground = new THREE.MeshStandardMaterial({ color: '#a19e98', map: regolithTexture(), roughness: 1, metalness: 0 })
      if (patch) {
        const mesh = new THREE.Mesh(buildTerrain(patch.meta, patch.rel, site.lon), ground)
        mesh.receiveShadow = true
        mesh.castShadow = true
        c.world.add(mesh)
      } else {
        const disk = new THREE.Mesh(new THREE.CircleGeometry(RING_R, 96).rotateX(-Math.PI / 2), ground)
        disk.receiveShadow = true
        c.world.add(disk)
      }
      const ring = new THREE.Mesh(buildRing(site.horizons[String(observerM)] ?? site.horizons['2'], eyeY), new THREE.MeshStandardMaterial({ color: '#5d5b57', roughness: 1, side: THREE.DoubleSide }))
      ring.castShadow = true
      c.world.add(ring)
      setStatus(
        patch
          ? browserPatch
            ? 'Terrain within 6 km from LOLA 80 m, built in your browser; the distant skyline is the computed horizon.'
            : `Terrain within 6 km from ${site.dem.includes('NAC') ? 'LROC NAC + ' : ''}LOLA; the distant skyline is the computed horizon.`
          : 'No terrain patch here: flat ground plus the computed skyline.',
      )
    })
    return () => {
      live = false
    }
  }, [site, observerM])

  // per-frame state: Sun, Earth, camera
  useEffect(() => {
    const c = ctx.current
    if (!c) return
    const f = siteFrame(site.lat, site.lon, R0_KM + (site.ground_m + observerM) / 1000)
    const s = sunAt(eph, f, cursor)
    const e = earthAt(eph, f, cursor)
    const hz = site.horizons[String(observerM)] ?? site.horizons['2']
    const hAt = (az: number) => {
      const n = hz.length
      const p = (((az % 360) + 360) % 360) * (n / 360) - 0.5
      const k = Math.floor(p)
      const t = p - k
      return (hz[(k + n) % n] * (1 - t) + hz[(k + 1) % n] * t) / 100
    }
    const frac = visibleSunFraction(s, hAt(s.az), e) // same light as every other view, eclipses included
    const sd = dirFrom(s.az, s.el)
    c.sun.position.copy(sd.clone().multiplyScalar(30_000))
    c.sun.intensity = 3.2 * frac
    const sunDist = SKY_R
    c.sunDisk.position.copy(sd.clone().multiplyScalar(sunDist)).add(new THREE.Vector3(0, observerM, 0))
    c.sunDisk.scale.setScalar(2 * sunDist * Math.tan(sunRadiusDeg(s.dist) * D2R)) // sprite scale is the diameter
    c.sunGlow.position.copy(c.sunDisk.position)
    c.sunGlow.scale.setScalar(2 * sunDist * Math.tan(Math.max(2.2, c.fov * 0.07) * D2R)) // glare sized to stay findable at any zoom; the disk itself is true size
    const eclipseShare = earthShadowFactor(s, e)
    const glowMaterial = c.sunGlow.material as THREE.SpriteMaterial
    glowMaterial.opacity = eclipseShare
    const ed = dirFrom(e.az, e.el)
    c.earth.position.copy(ed.clone().multiplyScalar(SKY_R * 0.9)).add(new THREE.Vector3(0, observerM, 0))
    c.earth.scale.setScalar(2 * SKY_R * 0.9 * Math.tan(Math.asin(6371 / e.dist)))
    const g = c.earthCanvas.getContext('2d')!
    g.clearRect(0, 0, 256, 256)
    if (photo.earth) drawDisk(g, photo.earth, 128, 128, 128, earthPhase(s.az, s.el, e.az, e.el))
    c.earthTex.needsUpdate = true
    // in shadow there is no light at all on an airless Moon; a faint fill keeps the terrain shape readable
    c.ambient.intensity = 0.1 + 0.9 * (1 - frac)
    // aim once per site at the Sun so the first view shows what matters
    const earthVisible = e.el >= hAt(e.az)
    if (aimed.current !== site.id) {
      aimed.current = site.id
      const t = frac > 0 || !earthVisible ? s : e
      c.yaw = t.az
      c.pitch = Math.max(1, Math.min(20, t.el + 1))
      c.fov = 60
    }
    c.camera.fov = c.fov
    c.camera.updateProjectionMatrix()
    c.camera.position.set(0, observerM, 0)
    c.camera.lookAt(dirFrom(c.yaw, c.pitch).multiplyScalar(1000).add(new THREE.Vector3(0, observerM, 0)))
    c.renderer.render(c.scene, c.camera)
    // screen-space labels for the two bodies
    // labels sit just above each disk, however far the view is zoomed
    const label = (p: THREE.Vector3, radiusDeg: number) => {
      const v = p.clone().project(c.camera)
      const inFront = v.z < 1 && Math.abs(v.x) <= 1.1 && Math.abs(v.y) <= 1.1
      return inFront ? { x: ((v.x + 1) / 2) * 100, y: ((1 - v.y) / 2) * 100 - (100 * radiusDeg) / c.fov } : null
    }
    // the Sun as drawn on screen: its true-size disc can be only a few pixels wide, so mark it with a bright dot and glare
    const sv = c.sunDisk.position.clone().project(c.camera)
    const sunDot = sv.z < 1 && Math.abs(sv.x) <= 1.05 && Math.abs(sv.y) <= 1.05
      ? { x: ((sv.x + 1) / 2) * 100, y: ((1 - sv.y) / 2) * 100, d: (c.renderer.domElement.clientHeight * 2 * sunRadiusDeg(s.dist)) / c.fov } : null
    setLabels({ sunDot, sun: label(c.sunDisk.position, sunRadiusDeg(s.dist)), earth: label(c.earth.position, Math.asin(6371 / e.dist) / D2R), sunVis: frac > 0, sunEclipsed: eclipseShare < 1, earthVis: earthVisible, heading: ((c.yaw % 360) + 360) % 360 })
  }, [eph, site, cursor, observerM, look, status, photo.earth])

  const aim = (target: 'sun' | 'earth') => {
    const c = ctx.current
    if (!c) return
    const f = siteFrame(site.lat, site.lon, R0_KM + (site.ground_m + observerM) / 1000)
    const p = target === 'sun' ? sunAt(eph, f, cursor) : earthAt(eph, f, cursor)
    c.yaw = p.az
    c.pitch = Math.max(-5, Math.min(60, p.el + 1))
    setLook({ yaw: c.yaw, pitch: c.pitch })
  }
  const heading = labels?.heading ?? 0

  return (
    <div className="site3d">
      <div className="site3d-stage">
      <div ref={host} className="site3d-canvas" role="img" aria-label="First-person 3D view from the landing site with the Sun and Earth at their computed positions" />
      {labels?.sunDot && !labels.sunVis && <span className="sun-hidden" aria-hidden="true" style={{ left: `${labels.sunDot.x}%`, top: `${labels.sunDot.y}%` }} />}
      {labels && !labels.sunVis && <p className="site3d-shadow" role="status">{labels.sunEclipsed ? 'No sunlight at this moment: Earth is eclipsing the Sun or terrain hides it.' : 'In shadow: the Sun is behind the terrain at this moment.'} Drag the timeline to see when sunlight returns.</p>}
      {labels?.sunDot && labels.sunVis && <span className="sun-dot" aria-hidden="true" style={{ left: `${labels.sunDot.x}%`, top: `${labels.sunDot.y}%`, width: Math.max(12, labels.sunDot.d), height: Math.max(12, labels.sunDot.d) }} />}
      {labels?.sun && <span className="body-label sun" style={{ left: `${labels.sun.x}%`, top: `${labels.sun.y}%` }}>{labels.sunVis ? 'Sun' : labels.sunEclipsed ? 'Sun · eclipsed / terrain' : 'Sun · behind terrain'}</span>}
      {labels?.earth && <span className="body-label earth" style={{ left: `${labels.earth.x}%`, top: `${labels.earth.y}%` }}>{labels.earthVis ? 'Earth' : 'Earth · behind terrain'}</span>}
      <div className="site3d-hud">
        <span className="mono">heading {heading.toFixed(0)}°</span>
        <button className="btn sm" onClick={() => aim('sun')}>Look at Sun</button>
        <button className="btn sm" onClick={() => aim('earth')}>Look at Earth</button>
      </div>
      </div>
      <p className="faint" style={{ fontSize: 12, margin: '8px 0 0' }}>Drag to look around, scroll to zoom. {status} Sun and Earth discs are true angular size; the Sun’s glare is enlarged so it can be found.</p>
    </div>
  )
}
