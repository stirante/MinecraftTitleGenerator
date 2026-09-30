// A small software renderer for Minecraft Title Generator fonts, used for font thumbnails and
// preview renders without Blockbench or a GPU. It rebuilds the text the way the plugin's preview
// does (THREE.BoxGeometry per cube, negative sizes for inverted cubes, the same uv slots, front
// faces only, nearest texel, alpha test) and rasterises the triangles with a z-buffer.
import { Canvas, loadImage, ImageData } from "skia-canvas"

export async function loadTexture(path, width = 1000, height = 320) {
  const img = await loadImage(path)
  const c = new Canvas(img.width, img.height)
  const ctx = c.getContext("2d")
  ctx.drawImage(img, 0, 0)
  return { w: img.width, h: img.height, data: ctx.getImageData(0, 0, img.width, img.height).data, canvas: c }
}

// Plugin preview text layout (makePreview > addText): returns cubes in world space.
export function layoutText(font, characters, text) {
  let width = 0
  const placed = []
  let last
  for (const [i, ch] of Array.from(text).entries()) {
    if (ch === " " && !characters[" "]) {
      width += font.spaceWidth ?? 8
      continue
    }
    if (last && font.shifts?.[last + ch]) width -= font.shifts[last + ch]
    const model = characters[ch]
    if (!model) throw new Error(`No character ${JSON.stringify(ch)}`)
    let min = Infinity, max = -Infinity
    for (const c of model) {
      min = Math.min(min, c.from[0], c.to[0])
      max = Math.max(max, c.from[0], c.to[0])
    }
    if (i) max += font.characterSpacing ?? 0
    for (const c of model) placed.push({ ...c, dx: -(width + max) })
    width += max - min
    last = ch
  }
  return placed.map(c => ({ from: c.from, to: c.to, faces: c.faces, offset: [c.dx + width / 2, 0, 0] }))
}

// THREE.BoxGeometry planes in group order px, nx, py, ny, pz, nz and the plugin's uv slot of each.
const PLANES = [
  ["east", "z", "y", "x", -1, -1, "d", "h", "w"],
  ["west", "z", "y", "x", 1, -1, "d", "h", "-w"],
  ["up", "x", "z", "y", 1, 1, "w", "d", "h"],
  ["down", "x", "z", "y", 1, -1, "w", "d", "-h"],
  ["south", "x", "y", "z", 1, -1, "w", "h", "d"],
  ["north", "x", "y", "z", -1, -1, "w", "h", "-d"]
]
const AX = { x: 0, y: 1, z: 2 }

function cubeQuads(cube) {
  const size = { w: cube.to[0] - cube.from[0], h: cube.to[1] - cube.from[1], d: cube.to[2] - cube.from[2] }
  const val = s => s[0] === "-" ? -size[s.slice(1)] : size[s]
  const center = [0, 1, 2].map(i => (cube.from[i] + cube.to[i]) / 2 + (cube.offset?.[i] ?? 0))
  const quads = []
  for (const [name, u, v, w, udir, vdir, width, height, depth] of PLANES) {
    const f = cube.faces[name]
    if (!f) continue
    const uvs = f.uv ?? f
    const W = val(width), H = val(height), D = val(depth)
    const verts = []
    for (let iy = 0; iy < 2; iy++) for (let ix = 0; ix < 2; ix++) {
      const p = [0, 0, 0]
      p[AX[u]] = (ix * W - W / 2) * udir
      p[AX[v]] = (iy * H - H / 2) * vdir
      p[AX[w]] = D / 2
      // uv slot i -> texture point (image coordinates, 16ths of the texture)
      const t = [ix ? uvs[2] : uvs[0], iy ? uvs[3] : uvs[1]]
      verts.push({ p: [p[0] + center[0], p[1] + center[1], p[2] + center[2]], t })
    }
    // three's triangles: (a, b, d), (b, c, d) with a=0, b=2, c=3, d=1
    quads.push([[verts[0], verts[2], verts[1]], [verts[2], verts[3], verts[1]]])
  }
  return quads
}

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const norm = a => { const l = Math.hypot(...a); return a.map(x => x / l) }

// camera: { position, target, fov (vertical degrees) } or { position, target, ortho: [halfW, halfH] }
export function render(cubes, texture, camera, width, height, opts = {}) {
  const ss = opts.supersample ?? 1
  const W = width * ss, H = height * ss
  const color = new Uint8ClampedArray(W * H * 4)
  const depth = new Float32Array(W * H).fill(Infinity)
  const f = norm(sub(camera.target, camera.position))
  const r = norm(cross(f, [0, 1, 0]))
  const up = cross(r, f)
  const aspect = W / H
  const tanY = camera.fov ? Math.tan(camera.fov * Math.PI / 360) : 0
  const project = p => {
    const d = sub(p, camera.position)
    const x = dot(d, r), y = dot(d, up), z = dot(d, f)
    let nx, ny
    if (camera.ortho) { nx = x / camera.ortho[0]; ny = y / camera.ortho[1] }
    else { nx = x / (z * tanY * aspect); ny = y / (z * tanY) }
    return { sx: (nx + 1) / 2 * W, sy: (1 - ny) / 2 * H, z, w: camera.ortho ? 1 : 1 / z }
  }
  const tex = texture
  const tw = tex.w, th = tex.h
  const alphaTest = (opts.alphaTest ?? 0.5) * 255
  for (const cube of cubes) {
    for (const quad of cubeQuads(cube)) for (const tri of quad) {
      const P = tri.map(v => ({ ...project(v.p), t: v.t }))
      if (P.some(q => q.z <= 0.01)) continue
      const area = (P[1].sx - P[0].sx) * (P[2].sy - P[0].sy) - (P[2].sx - P[0].sx) * (P[1].sy - P[0].sy)
      // screen y points down, so a counter-clockwise (front) triangle has negative area here
      if (area >= 0) continue
      const minX = Math.max(0, Math.floor(Math.min(P[0].sx, P[1].sx, P[2].sx)))
      const maxX = Math.min(W - 1, Math.ceil(Math.max(P[0].sx, P[1].sx, P[2].sx)))
      const minY = Math.max(0, Math.floor(Math.min(P[0].sy, P[1].sy, P[2].sy)))
      const maxY = Math.min(H - 1, Math.ceil(Math.max(P[0].sy, P[1].sy, P[2].sy)))
      for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) {
        const px = x + 0.5, py = y + 0.5
        const w0 = ((P[1].sx - px) * (P[2].sy - py) - (P[2].sx - px) * (P[1].sy - py)) / area
        const w1 = ((P[2].sx - px) * (P[0].sy - py) - (P[0].sx - px) * (P[2].sy - py)) / area
        const w2 = 1 - w0 - w1
        if (w0 < -1e-9 || w1 < -1e-9 || w2 < -1e-9) continue
        const iw = w0 * P[0].w + w1 * P[1].w + w2 * P[2].w
        const z = 1 / iw
        const i = y * W + x
        if (z >= depth[i] - 1e-6) continue
        const tu = (w0 * P[0].t[0] * P[0].w + w1 * P[1].t[0] * P[1].w + w2 * P[2].t[0] * P[2].w) / iw
        const tv = (w0 * P[0].t[1] * P[0].w + w1 * P[1].t[1] * P[1].w + w2 * P[2].t[1] * P[2].w) / iw
        const tx = Math.min(tw - 1, Math.max(0, Math.floor(tu / 16 * tw)))
        const ty = Math.min(th - 1, Math.max(0, Math.floor(tv / 16 * th)))
        const o = (ty * tw + tx) * 4
        if (tex.data[o + 3] < alphaTest) continue
        depth[i] = z
        color[i * 4] = tex.data[o]
        color[i * 4 + 1] = tex.data[o + 1]
        color[i * 4 + 2] = tex.data[o + 2]
        color[i * 4 + 3] = opts.keepAlpha ? tex.data[o + 3] : 255
      }
    }
  }
  const out = new Canvas(width, height)
  const octx = out.getContext("2d")
  if (opts.background) { octx.fillStyle = opts.background; octx.fillRect(0, 0, width, height) }
  const big = new Canvas(W, H)
  big.getContext("2d").putImageData(new ImageData(color, W, H), 0, 0)
  octx.imageSmoothingEnabled = ss > 1
  octx.drawImage(big, 0, 0, width, height)
  return out
}

// Trims transparent borders (like the compile script's thumbnails).
export function trim(canvas) {
  const ctx = canvas.getContext("2d")
  const { data, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height)
  let x0 = width, x1 = -1, y0 = height, y1 = -1
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) if (data[(y * width + x) * 4 + 3] > 10) {
    if (x < x0) x0 = x
    if (x > x1) x1 = x
    if (y < y0) y0 = y
    if (y > y1) y1 = y
  }
  if (x1 < 0) return canvas
  const out = new Canvas(x1 - x0 + 1, y1 - y0 + 1)
  out.getContext("2d").drawImage(canvas, -x0, -y0)
  return out
}
