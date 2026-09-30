/*
  TTF/OTF to Minecraft Title Generator font converter.

  One source for both users:
  - ttf/build_fonts.mjs (node, skia-canvas) builds converted fonts into fonts/.
  - The TTF fork of the plugin (plugin/minecraft_title_generator_ttf.js) carries a copy of this
    file between its "TTF converter" markers (ttf/build_plugin.mjs splices it in), and runs it
    on a browser canvas.

  How a character is built (see ttf/README.md for the long version):
  - The glyph is drawn on a canvas at a font size that makes the cap height (the height of "H")
    exactly `capPx` pixels, 4x supersampled, and thresholded at 50% coverage into a 1-bit bitmap.
  - One pixel is `capUnits / capPx` model units, so the cap height is always 40 units, like
    Minecraft Ten.
  - The letter body is the bitmap merged into rectangles (greedy meshing), each a cube 22 units
    deep. The texture is not shaped like the letter: every face samples one opaque column of the
    Minecraft Ten texture layout. The front face samples the face row at the pixel's height, so
    horizontal bands and gradients line up across all letters; top and bottom faces sample the
    "ends" rows like the reference fonts.
  - The border follows the reference fonts: the glyph grown by 2 units is the outline. Its back
    wall is a set of inverted cubes (only their far face shows), and its edges are walls facing
    into the outline, all with the font's single border pixel.
*/
const TTFConverter = (() => {
  const LAYOUTS = {
    "minecraft-ten": {
      source: "minecraft-ten",
      textureWidth: 1000,
      textureHeight: 320,
      height: 44,
      border: 266,
      faces: [[22, 62], [108, 148], [194, 194, 234, 242]],
      ends: [[0, 22, 62, 84], [86, 108, 148, 170], [172, 194, 242, 264]],
      // The face row the converted characters sample, and the texture column inside it. Column 188
      // is opaque from ends[0][0] to ends[0][3] in flat.png (so in every texture of the layout) and
      // is the column whose texels most often match the row's common colour across all Ten
      // textures, so it carries the row's colour and not a letter-specific detail.
      row: 0,
      column: 188,
      capUnits: 40,
      baseline: 2,
      bodyZ: [-3, 19],
      borderZ: [-5, 21],
      borderUnits: 2,
      terminatorSpace: true
    }
  }

  // Plugin character key -> what to draw. Letters are drawn as capitals: the plugin lower-cases
  // the text, and title fonts are all caps.
  const CHARACTERS = []
  for (const c of "abcdefghijklmnopqrstuvwxyz") CHARACTERS.push({ key: c, text: c.toUpperCase(), snap: true })
  for (const c of "0123456789") CHARACTERS.push({ key: c, text: c, snap: true })
  for (const c of "£€&#()[]{}/\\?!.:-+=<>%^*~,;_$@") CHARACTERS.push({ key: c, text: c })
  CHARACTERS.push({ key: "'", text: "’", fallback: "'" })
  CHARACTERS.push({ key: "😩", text: "‘", fallback: "'" })
  CHARACTERS.push({ key: "😳", special: "creeper" })
  CHARACTERS.push({ key: "┫", special: "terminator" })
  CHARACTERS.push({ key: "┣", special: "terminator" })

  // Pairs that get kerning shifts: the characters that commonly meet in a title.
  const KERN_SET = "abcdefghijklmnopqrstuvwxyz0123456789.,-'!?&:;"

  const CREEPER = [
    "########",
    "#  ##  #",
    "#  ##  #",
    "###  ###",
    "##    ##",
    "##    ##",
    "## ## ##",
    "########"
  ]

  const r4 = n => Math.round(n * 10000) / 10000

  // ---------------------------------------------------------------- font file info

  // Reads the cmap (to know which characters the font really has; a canvas silently falls back to
  // another font otherwise) and the names from a TTF/OTF file.
  function parseFontInfo(buffer) {
    const view = new DataView(buffer instanceof ArrayBuffer ? buffer : buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength))
    const tag = (o) => String.fromCharCode(view.getUint8(o), view.getUint8(o + 1), view.getUint8(o + 2), view.getUint8(o + 3))
    let base = 0
    if (tag(0) === "ttcf") base = view.getUint32(12)
    const numTables = view.getUint16(base + 4)
    const tables = {}
    for (let i = 0; i < numTables; i++) {
      const o = base + 12 + i * 16
      tables[tag(o)] = { offset: view.getUint32(o + 8), length: view.getUint32(o + 12) }
    }
    const codepoints = new Set()
    if (tables.cmap) {
      const c = tables.cmap.offset
      const n = view.getUint16(c + 2)
      let best = null
      for (let i = 0; i < n; i++) {
        const platform = view.getUint16(c + 4 + i * 8)
        const encoding = view.getUint16(c + 6 + i * 8)
        const offset = view.getUint32(c + 8 + i * 8)
        const format = view.getUint16(c + offset)
        const score = (format === 12 ? 2 : format === 4 ? 1 : 0) * ((platform === 3 && (encoding === 1 || encoding === 10)) || platform === 0 ? 1 : 0)
        if (score && (!best || score > best.score)) best = { score, offset: c + offset, format }
      }
      if (best?.format === 4) {
        const o = best.offset
        const segX2 = view.getUint16(o + 6)
        const ends = o + 14, starts = ends + segX2 + 2, deltas = starts + segX2, ranges = deltas + segX2
        for (let s = 0; s < segX2 / 2; s++) {
          const end = view.getUint16(ends + s * 2), start = view.getUint16(starts + s * 2)
          const delta = view.getInt16(deltas + s * 2), rangeOffset = view.getUint16(ranges + s * 2)
          for (let cp = start; cp <= end && cp !== 0xFFFF; cp++) {
            let glyph
            if (rangeOffset === 0) glyph = (cp + delta) & 0xFFFF
            else {
              const g = view.getUint16(ranges + s * 2 + rangeOffset + (cp - start) * 2)
              glyph = g ? (g + delta) & 0xFFFF : 0
            }
            if (glyph) codepoints.add(cp)
          }
        }
      } else if (best?.format === 12) {
        const o = best.offset
        const groups = view.getUint32(o + 12)
        for (let g = 0; g < groups; g++) {
          const start = view.getUint32(o + 16 + g * 12), end = view.getUint32(o + 20 + g * 12), glyph = view.getUint32(o + 24 + g * 12)
          for (let cp = start; cp <= end; cp++) if (glyph + cp - start) codepoints.add(cp)
        }
      }
    }
    const names = {}
    if (tables.name) {
      const n0 = tables.name.offset
      const count = view.getUint16(n0 + 2), strings = n0 + view.getUint16(n0 + 4)
      for (let i = 0; i < count; i++) {
        const r = n0 + 6 + i * 12
        const platform = view.getUint16(r), id = view.getUint16(r + 6), length = view.getUint16(r + 8), offset = view.getUint16(r + 10)
        if (names[id] && platform !== 3) continue
        let s = ""
        if (platform === 3 || platform === 0) for (let j = 0; j < length; j += 2) s += String.fromCharCode(view.getUint16(strings + offset + j))
        else for (let j = 0; j < length; j++) s += String.fromCharCode(view.getUint8(strings + offset + j))
        names[id] = s
      }
    }
    let weight = 400
    if (tables["OS/2"]) weight = view.getUint16(tables["OS/2"].offset + 4)
    return {
      codepoints,
      family: names[16] ?? names[1] ?? "Imported",
      subfamily: names[17] ?? names[2] ?? "",
      fullName: names[4] ?? names[1] ?? "Imported",
      copyright: names[0] ?? "",
      designer: names[9] ?? "",
      license: names[13] ?? "",
      weight
    }
  }

  const hasText = (info, text) => Array.from(text).every(ch => info.codepoints.has(ch.codePointAt(0)))

  // ---------------------------------------------------------------- rasterising

  // env: { createCanvas(w, h), family, weight, fallbackFamily, info }
  function fontString(env, size, family) {
    const f = family ?? env.family
    return `${env.weight ?? "normal"} ${size}px ${/^(serif|sans-serif|monospace)$/.test(f) ? f : `"${f}"`}`
  }

  function capRatio(env) {
    const ctx = env.createCanvas(8, 8).getContext("2d")
    ctx.font = fontString(env, 1000)
    return ctx.measureText("H").actualBoundingBoxAscent / 1000
  }

  // Draws `text` so that the cap height is capPx pixels. Returns a 1-bit bitmap cropped to the ink
  // plus the metrics needed for spacing.
  function rasterize(env, text, capPx, opts = {}) {
    const SS = 4
    const family = opts.family ?? env.family
    const size = capPx / (opts.capRatio ?? env.capRatio)
    const probe = env.createCanvas(8, 8).getContext("2d")
    probe.font = fontString(env, size * SS, family)
    const m = probe.measureText(text)
    const left = Math.max(0, m.actualBoundingBoxLeft), right = Math.max(0, m.actualBoundingBoxRight)
    const asc = m.actualBoundingBoxAscent, desc = m.actualBoundingBoxDescent
    const pad = 2
    const originCol = pad + Math.ceil(left / SS)
    const w = originCol + Math.ceil(right / SS) + pad
    const above = Math.max(0, Math.ceil(asc / SS)) + pad
    const below = Math.max(0, Math.ceil(desc / SS)) + pad
    const h = above + below
    const canvas = env.createCanvas(w * SS, h * SS)
    const ctx = canvas.getContext("2d")
    ctx.font = fontString(env, size * SS, family)
    ctx.fillStyle = "#000"
    ctx.textBaseline = "alphabetic"
    // Snap small overshoots of round letters (O, S, C) to the cap line and baseline, so a voxel
    // font does not get letters one pixel taller than H.
    const capT = capPx * SS
    let top = asc, bottom = -desc
    if (opts.snap) {
      if (asc > capT && asc <= capT * 1.05) top = capT
      if (desc > 0 && desc <= capT * 0.05) bottom = 0
    }
    const sy = asc + desc > 0 ? (top - bottom) / (asc + desc) : 1
    const baseY = above * SS
    ctx.setTransform(1, 0, 0, sy, 0, baseY - bottom - desc * sy)
    ctx.fillText(text, originCol * SS, 0)
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    const data = ctx.getImageData(0, 0, w * SS, h * SS).data
    const alpha = new Uint8Array(w * SS * h * SS)
    for (let i = 0; i < alpha.length; i++) alpha[i] = data[i * 4 + 3]
    widenHairlines(alpha, w * SS, h * SS, SS)
    const bits = new Uint8Array(w * h)
    for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) {
      let sum = 0
      for (let y = 0; y < SS; y++) for (let x = 0; x < SS; x++) sum += alpha[(r * SS + y) * w * SS + c * SS + x]
      bits[r * w + c] = sum >= 255 * SS * SS / 2 ? 1 : 0
    }
    cleanup(bits, w, h)
    return crop({ bits, w, h, baseRow: above, originCol, advance: m.width / SS })
  }

  // Drops pixels with no edge neighbour and fills one-pixel pinholes.
  function cleanup(bits, w, h) {
    const at = (c, r) => c >= 0 && r >= 0 && c < w && r < h ? bits[r * w + c] : 0
    const drop = [], fill = []
    for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) {
      const n = at(c - 1, r) + at(c + 1, r) + at(c, r - 1) + at(c, r + 1)
      if (at(c, r) && n === 0) drop.push(r * w + c)
      if (!at(c, r) && n === 4) fill.push(r * w + c)
    }
    for (const i of drop) bits[i] = 0
    for (const i of fill) bits[i] = 1
  }

  // Hairline gaps (stencil cuts, narrow counters) thinner than a pixel vanish or turn into dotted
  // lines at the 50% threshold. On the supersampled alpha: the gaps a closing of the ink fills
  // (closed minus ink), kept when they are long (a concave corner's fillet is short), are widened
  // to at least a pixel and cut out of the alpha, so they survive the downsampling as clean lines.
  function widenHairlines(alpha, W, H, SS) {
    const ink = new Uint8Array(W * H)
    for (let i = 0; i < ink.length; i++) ink[i] = alpha[i] >= 128 ? 1 : 0
    // square max / min filters, separable
    const filter = (src, r, max) => {
      const tmp = new Uint8Array(W * H), out = new Uint8Array(W * H)
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        let v = max ? 0 : 1
        for (let k = -r; k <= r; k++) {
          const xx = x + k
          const s = xx < 0 || xx >= W ? 0 : src[y * W + xx]
          v = max ? v | s : v & s
        }
        tmp[y * W + x] = v
      }
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        let v = max ? 0 : 1
        for (let k = -r; k <= r; k++) {
          const yy = y + k
          const s = yy < 0 || yy >= H ? 0 : tmp[yy * W + x]
          v = max ? v | s : v & s
        }
        out[y * W + x] = v
      }
      return out
    }
    const R = SS - 1
    const closed = filter(filter(ink, R, true), R, false)
    const gap = new Uint8Array(W * H)
    for (let i = 0; i < gap.length; i++) gap[i] = closed[i] && !ink[i] ? 1 : 0
    // connected gap pieces (8-neighbour); only long ones are hairlines
    const seen = new Uint8Array(W * H), keep = new Uint8Array(W * H)
    const minLen = SS * 1.5
    for (let s = 0; s < gap.length; s++) {
      if (!gap[s] || seen[s]) continue
      const stack = [s], piece = []
      seen[s] = 1
      let x0 = W, x1 = 0, y0 = H, y1 = 0
      while (stack.length) {
        const i = stack.pop()
        piece.push(i)
        const x = i % W, y = (i - x) / W
        if (x < x0) x0 = x
        if (x > x1) x1 = x
        if (y < y0) y0 = y
        if (y > y1) y1 = y
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx, yy = y + dy
          if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue
          const j = yy * W + xx
          if (gap[j] && !seen[j]) {
            seen[j] = 1
            stack.push(j)
          }
        }
      }
      if (Math.max(x1 - x0, y1 - y0) + 1 >= minLen) for (const i of piece) keep[i] = 1
    }
    const wide = filter(keep, SS >> 1, true)
    for (let i = 0; i < wide.length; i++) if (wide[i]) alpha[i] = 0
  }

  // Crops to the ink. `topK` is the height of the top row above the baseline in pixels (the row
  // just above the baseline is 1), `inkLeft` / `inkRight` are ink edges relative to the pen origin.
  function crop(g) {
    let c0 = g.w, c1 = -1, r0 = g.h, r1 = -1
    for (let r = 0; r < g.h; r++) for (let c = 0; c < g.w; c++) if (g.bits[r * g.w + c]) {
      if (c < c0) c0 = c
      if (c > c1) c1 = c
      if (r < r0) r0 = r
      if (r > r1) r1 = r
    }
    if (c1 < 0) return { bits: new Uint8Array(0), w: 0, h: 0, topK: 0, inkLeft: 0, inkRight: 0, advance: g.advance }
    const w = c1 - c0 + 1, h = r1 - r0 + 1
    const bits = new Uint8Array(w * h)
    for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) bits[r * w + c] = g.bits[(r + r0) * g.w + c + c0]
    return { bits, w, h, topK: g.baseRow - r0, inkLeft: c0 - g.originCol, inkRight: c1 + 1 - g.originCol, advance: g.advance }
  }

  function patternGlyph(pattern, capPx, widthPx, bottomK = 1) {
    const ph = pattern.length, pw = pattern[0].length
    const h = Math.round(capPx * ph / Math.max(ph, 1) * (pattern.heightScale ?? 1))
    const bits = new Uint8Array(widthPx * h)
    for (let r = 0; r < h; r++) for (let c = 0; c < widthPx; c++) {
      bits[r * widthPx + c] = pattern[Math.floor(r * ph / h)][Math.floor(c * pw / widthPx)] === "#" ? 1 : 0
    }
    return { bits, w: widthPx, h, topK: bottomK + h - 1, inkLeft: 0, inkRight: widthPx, advance: widthPx }
  }

  function specialGlyph(kind, capPx) {
    if (kind === "creeper") return patternGlyph(CREEPER, capPx, capPx)
    // Terminator: a block 0.4 cap wide and 0.6 cap tall, centred on the cap height.
    const w = Math.max(2, Math.round(capPx * 0.4)), h = Math.max(2, Math.round(capPx * 0.6))
    const bottomK = Math.round((capPx - h) / 2) + 1
    const bits = new Uint8Array(w * h).fill(1)
    return { bits, w, h, topK: bottomK + h - 1, inkLeft: 0, inkRight: w, advance: w }
  }

  // ---------------------------------------------------------------- meshing

  // Greedy meshing: a run along the row, then grown down while the rows below have the same run.
  // `same(ra, rb)` keeps rows of different bands (above cap / cap / below baseline) apart.
  function greedy(bits, w, h, same = () => true) {
    const used = new Uint8Array(w * h)
    const rects = []
    for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) {
      const i = r * w + c
      if (!bits[i] || used[i]) continue
      let c1 = c
      while (c1 < w && bits[r * w + c1] && !used[r * w + c1]) c1++
      let r1 = r + 1
      grow: while (r1 < h && same(r, r1)) {
        for (let x = c; x < c1; x++) if (!bits[r1 * w + x] || used[r1 * w + x]) break grow
        r1++
      }
      for (let y = r; y < r1; y++) for (let x = c; x < c1; x++) used[y * w + x] = 1
      rects.push([c, r, c1, r1])
    }
    return rects
  }

  function dilate(bits, w, h, b) {
    const W = w + 2 * b, H = h + 2 * b
    const out = new Uint8Array(W * H)
    for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) if (bits[r * w + c]) {
      for (let y = r; y <= r + 2 * b; y++) for (let x = c; x <= c + 2 * b; x++) out[y * W + x] = 1
    }
    return out
  }

  // Builds the character's elements (Java block model elements with plain uv arrays in 16ths, the
  // format of characters.json).
  function glyphToElements(glyph, layout, capPx) {
    const L = layout
    const u = L.capUnits / capPx
    const b = Math.max(1, Math.round(L.borderUnits / u))
    const { w, h, topK } = glyph
    const W = w + 2 * b, H = h + 2 * b
    const px = x => r4(x * 16 / L.textureWidth)
    const py = y => r4(y * 16 / L.textureHeight)
    const uv = (x0, y0, x1, y1) => [px(x0), py(y0), px(x1), py(y1)]
    const X = c => r4(8 + W * u / 2 - c * u)         // grid column edge -> model x (+x is screen left)
    const kOf = r => topK + b - r                     // grid row -> pixel height above baseline
    const yTop = r => r4(L.baseline + kOf(r) * u)     // top edge of grid row r
    const face = L.faces[L.row], end = L.ends[L.row]
    const faceTop = face.length === 4 ? face[1] : face[0]
    const faceBot = face.length === 4 ? face[2] : face[1]
    const vOf = y => faceTop + (L.baseline + L.capUnits - y) * (faceBot - faceTop) / L.capUnits
    const col = L.column
    const B = uv(0, L.border, 1, L.border + 1)
    const band = r => { const k = kOf(r); return k > capPx ? 2 : k >= 1 ? 1 : 0 }
    const elements = []

    // Body, on the grid of the dilated outline.
    const body = new Uint8Array(W * H)
    for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) body[(r + b) * W + c + b] = glyph.bits[r * w + c]
    const at = (grid, c, r) => c >= 0 && r >= 0 && c < W && r < H ? grid[r * W + c] : 0
    for (const [c0, r0, c1, r1] of greedy(body, W, H, (ra, rb) => band(ra) === band(rb))) {
      const top = yTop(r0), bottom = yTop(r1)
      let v0, v1
      if (band(r0) === 2) [v0, v1] = [faceTop, faceTop + 1]
      else if (band(r0) === 0) [v0, v1] = [faceBot - 1, faceBot]
      else [v0, v1] = [vOf(top), vOf(bottom)]
      const faces = {
        north: uv(col, v0, col + 1, v1),
        south: uv(col + 1, v0, col, v1)
      }
      let up = false, down = false, east = false, west = false
      for (let c = c0; c < c1; c++) {
        if (!at(body, c, r0 - 1)) up = true
        if (!at(body, c, r1)) down = true
      }
      for (let r = r0; r < r1; r++) {
        if (!at(body, c0 - 1, r)) east = true
        if (!at(body, c1, r)) west = true
      }
      const side = uv(col, end[1] - 1, col + 1, end[1])
      if (east) faces.east = side
      if (west) faces.west = side
      if (up) faces.up = uv(col + 1, end[1], col, end[0])
      if (down) faces.down = uv(col + 1, end[3], col, end[2])
      elements.push({ from: [X(c1), bottom, L.bodyZ[0]], to: [X(c0), top, L.bodyZ[1]], faces })
    }

    // Border: the glyph grown by b pixels.
    const D = dilate(glyph.bits, w, h, b)
    const [z0, z1] = L.borderZ
    // Walls along every edge of the outline, facing into it.
    for (let r = 0; r <= H; r++) {
      for (const [kind, test] of [["down", c => at(D, c, r) && !at(D, c, r - 1)], ["up", c => at(D, c, r - 1) && !at(D, c, r)]]) {
        for (let c = 0; c < W; c++) {
          if (!test(c)) continue
          let c1 = c
          while (c1 < W && test(c1)) c1++
          const y = yTop(r)
          elements.push({ from: [X(c1), y, z0], to: [X(c), y, z1], faces: { [kind]: B } })
          c = c1
        }
      }
    }
    for (let c = 0; c <= W; c++) {
      for (const [kind, test] of [["west", r => at(D, c, r) && !at(D, c - 1, r)], ["east", r => at(D, c - 1, r) && !at(D, c, r)]]) {
        for (let r = 0; r < H; r++) {
          if (!test(r)) continue
          let r1 = r
          while (r1 < H && test(r1)) r1++
          const x = X(c)
          elements.push({ from: [x, yTop(r1), z0], to: [x, yTop(r), z1], faces: { [kind]: B } })
          r = r1
        }
      }
    }
    // Back wall: inverted cubes like the reference fonts' border box; only their far (north) face
    // shows, facing the camera.
    for (const [c0, r0, c1, r1] of greedy(D, W, H)) {
      elements.push({ from: [X(c0), yTop(r0), z1], to: [X(c1), yTop(r1), z0], faces: { north: B } })
    }
    return elements
  }

  // ---------------------------------------------------------------- whole font

  // opts: { capPx, layout: "minecraft-ten", id, name, author, description }
  // How many pixels two glyphs placed bounding box to bounding box can still move together before
  // their ink meets: the smallest (right margin of a + left margin of c) over the rows (and the
  // rows next to them) both have ink in, measured from the baseline.
  function rowSlack(a, c) {
    if (!a.w || !c.w) return 0
    const right = new Map(), left = new Map()
    for (let r = 0; r < a.h; r++) {
      let x = -1
      for (let col = a.w - 1; col >= 0; col--) if (a.bits[r * a.w + col]) { x = col; break }
      if (x >= 0) right.set(a.topK - r, a.w - 1 - x)
    }
    for (let r = 0; r < c.h; r++) {
      let x = -1
      for (let col = 0; col < c.w; col++) if (c.bits[r * c.w + col]) { x = col; break }
      if (x >= 0) left.set(c.topK - r, x)
    }
    let best = Infinity
    for (const [k, ra] of right) for (const d of [-1, 0, 1]) {
      const lc = left.get(k + d)
      if (lc !== undefined) best = Math.min(best, ra + lc)
    }
    return best === Infinity ? Math.max(a.w, c.w) : best
  }

  function buildFont(env, opts) {
    const L = LAYOUTS[opts.layout ?? "minecraft-ten"]
    const capPx = opts.capPx
    const u = L.capUnits / capPx
    const b = Math.max(1, Math.round(L.borderUnits / u))
    env.capRatio ??= capRatio(env)
    const fallbackEnv = env.fallbackFamily ? { ...env, family: env.fallbackFamily, weight: "bold", capRatio: undefined } : null
    if (fallbackEnv) fallbackEnv.capRatio = capRatio(fallbackEnv)
    const characters = {}
    const glyphs = {}
    const report = { fallback: [], empty: [] }
    for (const ch of CHARACTERS) {
      let glyph
      if (ch.special) glyph = specialGlyph(ch.special, capPx)
      else {
        let text = ch.text
        if (env.info && !hasText(env.info, text) && ch.fallback && hasText(env.info, ch.fallback)) text = ch.fallback
        if (!env.info || hasText(env.info, text)) glyph = rasterize(env, text, capPx, { snap: ch.snap })
        else if (fallbackEnv) {
          glyph = rasterize(fallbackEnv, text, capPx, { snap: ch.snap, family: fallbackEnv.family, capRatio: fallbackEnv.capRatio })
          report.fallback.push(ch.key)
        }
      }
      if (!glyph || !glyph.w) {
        report.empty.push(ch.key)
        glyph = specialGlyph("terminator", capPx)
      }
      glyphs[ch.key] = { ...glyph, text: ch.text }
      characters[ch.key] = glyphToElements(glyph, L, capPx)
    }

    // Spacing. The plugin puts characters so that their outlines touch, plus characterSpacing,
    // minus shifts[pair]. The font's own spacing (side bearings + kerning) sets the ink gap we want.
    const ctx = env.createCanvas(8, 8).getContext("2d")
    ctx.font = fontString(env, capPx / env.capRatio)
    const widths = {}
    const measure = t => widths[t] ??= ctx.measureText(t).width
    const outlineGap = 2 * b * u
    const gaps = {}, slack = {}
    const keys = Array.from(KERN_SET)
    for (const a of keys) for (const c of keys) {
      const ga = glyphs[a], gc = glyphs[c]
      const ta = ga.text, tc = gc.text
      const kern = env.info && (!hasText(env.info, ta) || !hasText(env.info, tc)) ? 0 : measure(ta + tc) - measure(ta) - measure(tc)
      const gapPx = (ga.advance - ga.inkRight) + gc.inkLeft + kern
      gaps[a + c] = gapPx * u
      slack[a + c] = rowSlack(ga, gc)
    }
    const letterGaps = Object.entries(gaps).filter(([k]) => /^[a-z]{2}$/.test(k)).map(e => e[1]).sort((x, y) => x - y)
    const median = letterGaps[Math.floor(letterGaps.length / 2)]
    const tracking = opts.tracking ?? 0
    const characterSpacing = Math.max(0, Math.round(median + tracking - outlineGap))
    const shifts = {}
    for (const [pair, gap] of Object.entries(gaps)) {
      // Kerning never pulls two letters closer than one border between their bodies, so the outline
      // always separates them (tight condensed fonts otherwise fuse into one block).
      const shift = Math.min(characterSpacing + Math.floor((b + slack[pair]) * u), Math.round(outlineGap + characterSpacing - gap - tracking))
      // differences under 2 units (half a pixel to a pixel) are not worth a shift entry
      if (Math.abs(shift) >= (opts.minShift ?? 2)) shifts[pair] = shift
    }
    const spaceWidth = Math.max(4, Math.round(measure(" ") * u))

    const entry = {
      id: opts.id,
      name: opts.name,
      description: opts.description,
      author: opts.author,
      height: L.height,
      border: L.border,
      faces: L.faces,
      ends: L.ends,
      terminatorSpace: L.terminatorSpace,
      textureSource: L.source,
      characterSpacing,
      spaceWidth,
      preview: opts.preview ?? "abc",
      // the text dialog's preview; upstream's default has the creeper face
      example: ["example", "text"],
      shifts
    }
    for (const k of Object.keys(entry)) if (entry[k] === undefined) delete entry[k]
    return { characters, entry, glyphs, report, units: { u, borderPx: b } }
  }

  // A flat front view for the font list: the back walls black, the letter bodies white, like the
  // flat thumbnails. 2 px per unit.
  function thumbnail(env, entry, characters, text = "abc") {
    const placed = []
    let width = 0, last
    for (const [i, ch] of Array.from(text).entries()) {
      if (last && entry.shifts?.[last + ch]) width -= entry.shifts[last + ch]
      const model = characters[ch]
      if (!model) continue
      let min = Infinity, max = -Infinity
      for (const e of model) { min = Math.min(min, e.from[0], e.to[0]); max = Math.max(max, e.from[0], e.to[0]) }
      if (i) max += entry.characterSpacing ?? 0
      for (const e of model) placed.push([e, -(width + max)])
      width += max - min
      last = ch
    }
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity
    for (const [e, dx] of placed) {
      x0 = Math.min(x0, e.from[0] + dx, e.to[0] + dx); x1 = Math.max(x1, e.from[0] + dx, e.to[0] + dx)
      y0 = Math.min(y0, e.from[1], e.to[1]); y1 = Math.max(y1, e.from[1], e.to[1])
    }
    const s = 2
    const canvas = env.createCanvas(Math.ceil((x1 - x0) * s), Math.ceil((y1 - y0) * s))
    const ctx = canvas.getContext("2d")
    for (const pass of ["back", "body"]) for (const [e, dx] of placed) {
      if (!e.faces.north) continue
      const back = e.from[2] > e.to[2]
      if ((pass === "back") !== back) continue
      if (!back && e.from[2] === e.to[2]) continue
      ctx.fillStyle = back ? "#000" : "#fff"
      const ex0 = Math.min(e.from[0], e.to[0]) + dx, ex1 = Math.max(e.from[0], e.to[0]) + dx
      const ey0 = Math.min(e.from[1], e.to[1]), ey1 = Math.max(e.from[1], e.to[1])
      // +x is screen left
      ctx.fillRect(Math.round((x1 - ex1) * s), Math.round((y1 - ey1) * s), Math.round((ex1 - ex0) * s), Math.round((ey1 - ey0) * s))
    }
    return canvas
  }

  return { LAYOUTS, CHARACTERS, parseFontInfo, capRatio, rasterize, glyphToElements, buildFont, greedy, thumbnail }
})()
if (typeof module !== "undefined") module.exports = TTFConverter
