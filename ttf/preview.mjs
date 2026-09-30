// Renders a text in the converted fonts with a few Minecraft Ten textures into out/.
//   node preview.mjs [text] [texture ...]
import path from "node:path"
import fs from "node:fs"
import { Canvas } from "skia-canvas"
import { convert, FONTS } from "./build_fonts.mjs"
import { loadTexture, layoutText, render, trim } from "./render.mjs"

const args = process.argv.slice(2)
const text = args[0] ?? "title"
const textures = args.length > 1 ? args.slice(1) : ["flat", "blueprint", "smooth"]
const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"))
fs.mkdirSync(path.join(here, "out"), { recursive: true })

for (const def of FONTS) {
  const { characters, entry } = convert(def)
  const cubes = layoutText(entry, characters, text)
  const rows = []
  for (const t of textures) {
    const tex = await loadTexture(path.join(here, "..", "fonts", "minecraft-ten", "textures", `${t}.png`))
    // front view, 4 px per unit, and the plugin preview camera (0, -170, -320)
    const front = trim(render(cubes, tex, { position: [0, 22, -320], target: [0, 22, 0], ortho: [300, 40] }, 2400, 320, {}))
    const persp = render(cubes, tex, { position: [0, -170, -320], target: [0, 20, 0], fov: 20 }, 1800, 600, { background: "#1d2533", supersample: 2 })
    rows.push(front, persp)
  }
  const w = Math.max(...rows.map(r => r.width)) + 40
  const h = rows.reduce((a, r) => a + r.height + 20, 20)
  const sheet = new Canvas(w, h)
  const ctx = sheet.getContext("2d")
  ctx.fillStyle = "#1d2533"
  ctx.fillRect(0, 0, w, h)
  let y = 20
  for (const r of rows) { ctx.drawImage(r, 20, y); y += r.height + 20 }
  const file = path.join(here, "out", `${def.id}_${text.replace(/\W/g, "_")}.png`)
  await sheet.saveAs(file)
  console.log(file)
}
