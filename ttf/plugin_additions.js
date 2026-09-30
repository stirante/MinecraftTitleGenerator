  // ================================================================================================
  // TTF fork: everything between here and "TTF fork end" is not in the upstream plugin.
  // - A font source setting: a local folder (a clone of the fork repo) or a URL, tried before the
  //   upstream repo. Local folders are read through Blockbench's scoped file system.
  // - Fonts with "textureSource" in fonts.json use another font's textures (converted TTF fonts
  //   use the Minecraft Ten textures).
  // - "Import TTF Font": converts a TTF/OTF file in the plugin and keeps it in local storage.
  // ================================================================================================
  const ttfStoreKey = "minecraft_title_ttf_imported_fonts"
  let ttfSetting, ttfImportAction, ttfRemoveAction, ttfFs, ttfFsScope
  let ttfRestored = Promise.resolve()

  const ttfIsLocal = r => typeof r === "string" && r.startsWith("file:///")
  const ttfLocalDir = r => decodeURI(r.slice(8))

  function ttfToRoot(src) {
    src = (src ?? "").trim().replace(/[\\/]+$/, "")
    if (!src) return null
    if (/^https?:\/\//.test(src) || src.startsWith("file:///")) return src
    return "file:///" + src.replace(/\\/g, "/").replace(/^\/+/, "")
  }

  function ttfGetFs(dir) {
    if (ttfFs && ttfFsScope === dir) return ttfFs
    ttfFsScope = dir
    if (typeof requireNativeModule === "function") {
      ttfFs = requireNativeModule("fs", { scope: dir, message: "Reads the fonts and textures of the Minecraft Title Generator fork in this folder." })
    } else if (typeof require === "function") {
      ttfFs = require("fs")
    }
    return ttfFs
  }

  // fetchData for a local root: parsed JSON for .json files, a Response for everything else.
  async function ttfFetchLocal(r, path) {
    const dir = ttfLocalDir(r)
    const file = `${dir}/${path.replace(/^\/+/, "")}`
    const fs = ttfGetFs(dir)
    if (!fs || !fs.existsSync(file)) throw new Error(`Not found: ${file}`)
    const data = fs.readFileSync(file)
    if (file.endsWith(".json")) return JSON.parse(new TextDecoder().decode(data))
    return new Response(data)
  }

  function ttfBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer)
    let s = ""
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000))
    return btoa(s)
  }

  function ttfBase64ToBuffer(b64) {
    const s = atob(b64)
    const bytes = new Uint8Array(s.length)
    for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i)
    return bytes.buffer
  }

  const ttfSlug = s => (s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "font"

  function ttfLoadStore() {
    try {
      return JSON.parse(localStorage.getItem(ttfStoreKey) ?? "[]")
    } catch {
      return []
    }
  }

  function ttfSaveStore(records) {
    try {
      localStorage.setItem(ttfStoreKey, JSON.stringify(records))
      return true
    } catch (err) {
      console.error(err)
      return false
    }
  }

  function ttfCreateCanvas(w, h) {
    const canvas = document.createElement("canvas")
    canvas.width = Math.max(1, w)
    canvas.height = Math.max(1, h)
    return canvas
  }

  // Converts a stored record ({ id, name, capPx, tracking, data }) and adds it to the font list.
  async function ttfRegister(record) {
    const buffer = ttfBase64ToBuffer(record.data)
    const info = TTFConverter.parseFontInfo(buffer)
    const family = `MinecraftTitleTTF_${record.id}`
    const face = new FontFace(family, buffer)
    await face.load()
    document.fonts.add(face)
    const env = { createCanvas: ttfCreateCanvas, family, weight: "normal", fallbackFamily: "sans-serif", info }
    const { characters, entry, report } = TTFConverter.buildFont(env, {
      layout: "minecraft-ten",
      capPx: record.capPx,
      tracking: record.tracking,
      id: record.id,
      name: record.name,
      author: info.designer || info.copyright || "Unknown"
    })
    const font = Object.assign(entry, {
      id: record.id,
      name: `${record.name} (TTF)`,
      description: `Imported from ${record.fileName ?? info.fullName} at ${record.capPx} px cap height. ${info.copyright}`.trim(),
      type: "font",
      characters,
      textures: `fonts/${entry.textureSource}/textures.json`,
      textureWidth: 1000,
      textureHeight: 320,
      thumbnail: TTFConverter.thumbnail({ createCanvas: ttfCreateCanvas }, entry, characters).toDataURL(),
      thumbnailFont: entry.textureSource,
      ttfImported: true
    })
    fonts[record.id] = font
    // If the text dialog is already built, its font list has to learn about the font too.
    if (dialog?.content_vue?.fontList?.length) {
      font.parsed = true
      const i = fontData.findIndex(e => e.id === record.id)
      if (i >= 0) fontData[i] = font
      else fontData.push(font)
      const list = dialog.content_vue.fontList
      const j = list.findIndex(e => e[0] === record.id)
      if (j >= 0) list.splice(j, 1, [record.id, font])
      else list.push([record.id, font])
    }
    return { font, report }
  }

  function ttfImport() {
    Blockbench.import({
      resource_id: "minecraft_title_ttf_font",
      extensions: ["ttf", "otf"],
      type: "TrueType or OpenType font",
      readtype: "binary"
    }, files => {
      const file = files[0]
      if (!file) return
      const buffer = file.content instanceof ArrayBuffer ? file.content : file.content?.buffer
      let info
      try {
        info = TTFConverter.parseFontInfo(buffer)
      } catch (err) {
        console.error(err)
        Blockbench.showMessageBox({ title: "Import TTF Font", message: "This file could not be read as a TTF or OTF font." })
        return
      }
      new Dialog({
        id: "minecraft_title_ttf_import",
        title: "Import TTF Font",
        width: 560,
        form: {
          about: { type: "info", text: `**${info.fullName}**\n\n${info.copyright || ""}\n\nCheck that the font's licence allows your use (for example the SIL Open Font License).` },
          name: { label: "Name", type: "text", value: info.fullName },
          capPx: { label: "Cap height (pixels)", type: "number", value: 20, min: 6, max: 80, step: 1, description: "Height of a capital letter in voxels. 20 gives 2 units per pixel, 40 gives 1 unit. Stencil and thin fonts need 30 to 40." },
          tracking: { label: "Extra letter spacing", type: "number", value: 0, min: -10, max: 20, step: 1, description: "Added to the font's own spacing, in model units." }
        },
        async onConfirm(result) {
          const record = {
            id: `ttf-${ttfSlug(result.name)}`,
            name: result.name || info.fullName,
            capPx: Math.round(result.capPx),
            tracking: result.tracking,
            fileName: file.name,
            data: ttfBufferToBase64(buffer)
          }
          let report
          try {
            ({ report } = await ttfRegister(record))
          } catch (err) {
            console.error(err)
            Blockbench.showMessageBox({ title: "Import TTF Font", message: `The font could not be converted: ${err}` })
            return
          }
          const records = ttfLoadStore().filter(e => e.id !== record.id)
          records.push(record)
          const saved = ttfSaveStore(records)
          const notes = []
          if (report.fallback.length) notes.push(`Missing in the font, drawn with a fallback font: ${report.fallback.join(" ")}`)
          if (report.empty.length) notes.push(`Empty after conversion, replaced by a block: ${report.empty.join(" ")}`)
          if (!saved) notes.push("The font could not be saved (local storage is full), so it is gone after a restart.")
          Blockbench.showMessageBox({
            title: "Import TTF Font",
            message: `Added "${record.name} (TTF)". Pick it in Add Minecraft Title Text.${notes.length ? "\n\n" + notes.join("\n\n") : ""}`
          })
        }
      }).show()
    })
  }

  function ttfRemove() {
    const records = ttfLoadStore()
    if (!records.length) {
      Blockbench.showQuickMessage("No imported TTF fonts")
      return
    }
    new Dialog({
      id: "minecraft_title_ttf_remove",
      title: "Remove Imported TTF Font",
      form: {
        font: { label: "Font", type: "select", options: Object.fromEntries(records.map(e => [e.id, `${e.name} (${e.capPx} px)`])) }
      },
      onConfirm(result) {
        ttfSaveStore(ttfLoadStore().filter(e => e.id !== result.font))
        delete fonts[result.font]
        const i = fontData.findIndex(e => e.id === result.font)
        if (i >= 0) fontData.splice(i, 1)
        const list = dialog?.content_vue?.fontList
        const j = list?.findIndex(e => e[0] === result.font) ?? -1
        if (j >= 0) list.splice(j, 1)
        if (dialog?.content_vue?.font === result.font) {
          dialog.content_vue.font = "minecraft-ten"
          dialog.content_vue.baseFont = "minecraft-ten"
        }
        Blockbench.showQuickMessage("Font removed")
      }
    }).show()
  }

  // Puts the font source in front of the upstream roots. The value is also kept under its own
  // local storage key, because a plugin setting created again on a plugin reload starts from the
  // values Blockbench read at launch.
  let ttfCustomRoot = null
  function ttfApplySource(value) {
    try {
      localStorage.setItem("minecraft_title_ttf_source", value ?? "")
    } catch {}
    if (ttfCustomRoot) {
      const i = connection.roots.indexOf(ttfCustomRoot)
      if (i >= 0) connection.roots.splice(i, 1)
      ttfCustomRoot = null
    }
    const r = ttfToRoot(value)
    if (r && !connection.roots.includes(r)) {
      connection.roots.unshift(r)
      ttfCustomRoot = r
    }
    connection.rootIndex = 0
    root = connection.roots[0]
  }

  function ttfOnLoad() {
    ttfSetting = new Setting("minecraft_title_ttf_source", {
      name: "Minecraft Title Generator (TTF fork): font source",
      description: "A local folder with a clone of the fork repo (for example D:/GitHub/minecraft-title-generator-ttf) or a URL root. Tried before the upstream repo. Restart Blockbench after changing it.",
      category: "general",
      type: "text",
      value: "",
      onChange: value => ttfApplySource(value)
    })
    let source = ttfSetting.value
    if (!source) {
      try {
        source = localStorage.getItem("minecraft_title_ttf_source") ?? ""
      } catch {}
      if (source) ttfSetting.set(source)
    }
    ttfApplySource(source)
    ttfImportAction = new Action("minecraft_title_ttf_import_font", {
      name: "Import TTF Font",
      description: "Convert a TTF or OTF font into a Minecraft title font",
      icon: "font_download",
      condition: () => Project.format === format,
      click: ttfImport
    })
    ttfRemoveAction = new Action("minecraft_title_ttf_remove_font", {
      name: "Remove Imported TTF Font",
      icon: "delete",
      condition: () => Project.format === format,
      click: ttfRemove
    })
    MenuBar.menus.edit.addAction(ttfRemoveAction, 5)
    MenuBar.menus.edit.addAction(ttfImportAction, 5)
    Interface.Panels.outliner.menu.addAction(ttfImportAction, 2)
    ttfRestored = (async () => {
      for (const record of ttfLoadStore()) {
        try {
          await ttfRegister(record)
        } catch (err) {
          console.error(`Minecraft Title Generator (TTF fork): could not restore ${record.id}`, err)
        }
      }
    })()
  }

  function ttfOnUnload() {
    ttfSetting?.delete()
    ttfImportAction?.delete()
    ttfRemoveAction?.delete()
  }
  // TTF fork end
  // ================================================================================================
