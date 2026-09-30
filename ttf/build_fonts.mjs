// Builds converted TTF fonts into fonts/<id>/ and their fonts.json entries.
//   node build_fonts.mjs                 all fonts, with thumbnails
//   node build_fonts.mjs --only <id> --no-thumbnails
import { Canvas, FontLibrary } from "skia-canvas"
import { createRequire } from "node:module"
import path from "node:path"
import fs from "node:fs"
import { loadTexture, layoutText, render, trim } from "./render.mjs"

const require = createRequire(import.meta.url)
const TTFConverter = require("./ttf_converter.cjs")
const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"))
const repo = path.resolve(here, "..")

// The fonts to build: ttf/fonts.local.json (not tracked), a list of
//   { "id", "file" (relative to ttf/), "capPx", "name", "author", "description" }
const localList = path.join(here, "fonts.local.json")
export const FONTS = fs.existsSync(localList) ? JSON.parse(fs.readFileSync(localList, "utf8")) : []

// characters.json key -> file name in characters/ (the reverse of the compile script's charMap)
const FILE_NAMES = { "*": "asterisk", "\\": "backwardslash", ":": "colon", "😳": "creeper", "┣": "end", "/": "forwardslash", ">": "greaterthan", "<": "lessthan", "😩": "openquote", "?": "questionmark", "┫": "start" }

export function convert(def) {
  const buffer = fs.readFileSync(path.join(here, def.file))
  const info = TTFConverter.parseFontInfo(buffer)
  const alias = `TTF_${def.id}`
  FontLibrary.use(alias, [path.join(here, def.file)])
  const env = { createCanvas: (w, h) => new Canvas(w, h), family: alias, weight: info.weight, info }
  const result = TTFConverter.buildFont(env, { ...def, layout: "minecraft-ten" })
  return { ...result, info }
}

async function main() {
  const args = process.argv.slice(2)
  const only = args.includes("--only") ? args[args.indexOf("--only") + 1] : null
  const thumbnails = !args.includes("--no-thumbnails")
  const fontsJsonPath = path.join(repo, "fonts.json")
  let fontsText = fs.readFileSync(fontsJsonPath, "utf8")
  for (const def of FONTS) {
    if (only && def.id !== only) continue
    const { characters, entry, report, info, units } = convert(def)
    const dir = path.join(repo, "fonts", def.id)
    const source = path.join(repo, "fonts", entry.textureSource)
    fs.rmSync(path.join(dir, "characters"), { recursive: true, force: true })
    fs.mkdirSync(path.join(dir, "characters"), { recursive: true })

    // characters/<name>.json: Java block models, the sources the compile script reads
    for (const [key, elements] of Object.entries(characters)) {
      const model = {
        credit: `Converted from ${info.fullName} by ttf/build_fonts.mjs`,
        texture_size: [1000, 320],
        textures: { 1: "flat", particle: "flat" },
        elements: elements.map(e => ({
          from: e.from,
          to: e.to,
          faces: Object.fromEntries(Object.entries(e.faces).map(([d, uv]) => [d, { uv, texture: "#1" }]))
        }))
      }
      fs.writeFileSync(path.join(dir, "characters", `${FILE_NAMES[key] ?? key}.json`), JSON.stringify(model))
    }
    // characters.json: what the plugin loads (the compile script's output format)
    fs.writeFileSync(path.join(dir, "characters.json"), JSON.stringify(characters))
    // textures.json: the source font's list, so the compile script and the texture picker agree
    fs.copyFileSync(path.join(source, "textures.json"), path.join(dir, "textures.json"))

    fontsText = setFontEntry(fontsText, entry)
    const count = Object.values(characters).reduce((n, c) => n + c.length, 0)
    console.log(`${def.id}: ${Object.keys(characters).length} characters, ${count} elements, ${units.u} units/px, border ${units.borderPx} px, spacing ${entry.characterSpacing}, ${Object.keys(entry.shifts).length} shifts, space ${entry.spaceWidth}`)
    if (report.fallback.length) console.log(`  fallback glyphs: ${report.fallback.join(" ")}`)
    if (report.empty.length) console.log(`  empty glyphs (replaced by a block): ${report.empty.join(" ")}`)

    if (thumbnails) await makeThumbnails(entry, characters, dir, source)
  }
  fs.writeFileSync(fontsJsonPath, fontsText)
}

// Replaces or appends a font entry in fonts.json as text, so the upstream entries keep their exact
// formatting. Number arrays and the shifts go on one line.
function setFontEntry(text, entry) {
  const eol = text.includes("\r\n") ? "\r\n" : "\n"
  text = text.replace(/\r\n/g, "\n")
  const start = text.indexOf(`\n  {\n    "id": ${JSON.stringify(entry.id)},`)
  if (start >= 0) {
    const end = text.indexOf("\n  }", start + 1) + 4
    const before = text.slice(0, start).replace(/,$/, "")
    text = before + text.slice(end)
  }
  const lines = Object.entries(entry).map(([k, v]) => {
    let value
    if (k === "shifts") value = JSON.stringify(v).replace(/,"/g, ", \"").replace(/":/g, "\": ")
    else if (Array.isArray(v)) value = "[\n" + v.map(a => `      [${a.join(", ")}]`).join(",\n") + "\n    ]"
    else value = JSON.stringify(v)
    return `    ${JSON.stringify(k)}: ${value}`
  })
  const block = `  {\n${lines.join(",\n")}\n  }`
  const close = text.lastIndexOf("\n]")
  text = text.slice(0, close) + ",\n" + block + text.slice(close)
  return text.replace(/\n/g, eol)
}

// Thumbnails the way the compile script makes them: the preview text, orthographic from the
// front, 160x96 at the texture's scale, trimmed. Overlays are drawn over a 30% flat.
async function makeThumbnails(entry, characters, dir, source) {
  const out = path.join(dir, "thumbnails")
  fs.rmSync(out, { recursive: true, force: true })
  fs.mkdirSync(out, { recursive: true })
  const cubes = layoutText(entry, characters, entry.preview ?? "abc")
  const flat = await loadTexture(path.join(source, "textures", "flat.png"))
  const jobs = []
  for (const f of fs.readdirSync(path.join(source, "textures"))) if (f.endsWith(".png") && f !== "overlay.png") jobs.push(["textures", f])
  for (const f of fs.readdirSync(path.join(source, "overlays"))) if (f.endsWith(".png")) jobs.push(["overlays", f])
  jobs.push([null, "none.png"])
  for (const [folder, file] of jobs) {
    let tex
    if (folder === "textures") tex = await loadTexture(path.join(source, folder, file))
    else {
      const overlay = folder ? await loadTexture(path.join(source, folder, file)) : null
      const w = overlay?.w ?? flat.w, h = overlay?.h ?? flat.h
      const c = new Canvas(w, h)
      const ctx = c.getContext("2d")
      ctx.imageSmoothingEnabled = false
      ctx.drawImage(flat.canvas, 0, 0, w, h)
      ctx.fillStyle = "rgb(0,0,0,0.3)"
      ctx.globalCompositeOperation = "destination-in"
      ctx.fillRect(0, 0, w, h)
      ctx.globalCompositeOperation = "source-over"
      if (overlay) ctx.drawImage(overlay.canvas, 0, 0)
      tex = { w, h, data: ctx.getImageData(0, 0, w, h).data }
    }
    const scale = tex.w / 1000
    const img = render(cubes, tex, { position: [0, 22, -320], target: [0, 22, 0], ortho: [80, 48] }, 160 * scale, 96 * scale, { alphaTest: 0.01, keepAlpha: true })
    await trim(img).saveAs(path.join(out, file))
  }
  console.log(`  ${jobs.length} thumbnails`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(here, "build_fonts.mjs")) await main()
