"use strict"

const http = require("node:http")
const { chromium } = require("playwright-core")
const fs = require("node:fs")
const path = require("node:path")

const pages = new Map()
let browser = null
let context = null

async function getBrowser() {
  if (!browser) {
    const executablePath = (() => {
      const explicit = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
      if (explicit && explicit.trim() !== "") return explicit
      const localAppData = process.env.LOCALAPPDATA
      if (!localAppData) return undefined
      const base = path.join(localAppData, "ms-playwright")
      try {
        for (const entry of fs.readdirSync(base)) {
          if (!String(entry).toLowerCase().startsWith("chromium")) continue
          const candidate = path.join(base, entry, "chrome-win64", "chrome.exe")
          if (fs.existsSync(candidate)) return candidate
        }
      } catch (error) {
        return undefined
      }
      return undefined
    })()

    browser = await chromium.launch({
      headless: true,
      executablePath,
      args: ["--no-sandbox", "--disable-gpu"],
    })
    context = await browser.newContext()
  }
  return { browser, context }
}

function asPageId(input) {
  return input && String(input).trim() !== "" ? String(input) : newId()
}

function newId() {
  return "page_" + String(Date.now()) + "_" + String(Math.random()).slice(2)
}

async function handle(cmd, args) {
  const payload = args || {}
  switch (cmd) {
    case "newPage": {
      const actualId = payload.id && String(payload.id).trim() !== "" ? String(payload.id).trim() : newId()
      const started = await getBrowser()
      if (pages.has(actualId)) {
        const page = pages.get(actualId)
        if (payload.url) await page.goto(payload.url, { timeout: 30000 })
        return actualId
      }
      const page = await started.context.newPage()
      pages.set(actualId, page)
      if (payload.url) await page.goto(payload.url, { timeout: 30000 })
      return actualId
    }
    case "navigate": {
      const page = pages.get(String(payload.id))
      if (!page) throw new Error("Unknown page: " + payload.id)
      await page.goto(payload.url, { timeout: 30000, waitUntil: "domcontentloaded" })
      return await page.title()
    }
    case "click": {
      const page = pages.get(String(payload.id))
      if (!page) throw new Error("Unknown page: " + payload.id)
      await page.click(payload.selector, { timeout: 15000 })
      return undefined
    }
    case "fill": {
      const page = pages.get(String(payload.id))
      if (!page) throw new Error("Unknown page: " + payload.id)
      await page.fill(payload.selector, payload.text, { timeout: 15000 })
      return undefined
    }
    case "text": {
      const page = pages.get(String(payload.id))
      if (!page) throw new Error("Unknown page: " + payload.id)
      if (payload.selector) {
        const value = await page.locator(payload.selector).textContent({ timeout: 15000 })
        return value == null ? "" : String(value)
      }
      return await page.content()
    }
    case "title": {
      const page = pages.get(String(payload.id))
      if (!page) throw new Error("Unknown page: " + payload.id)
      return await page.title()
    }
    case "evaluate": {
      const page = pages.get(String(payload.id))
      if (!page) throw new Error("Unknown page: " + payload.id)
      const result = await page.evaluate(payload.script)
      try {
        return JSON.stringify(result, null, 2)
      } catch (error) {
        return String(result)
      }
    }
    case "screenshot": {
      const page = pages.get(String(payload.id))
      if (!page) throw new Error("Unknown page: " + payload.id)
      const target = payload.filePath && String(payload.filePath).trim() !== "" ? String(payload.filePath) : path.join(process.cwd(), "browser-" + Date.now() + ".png")
      fs.mkdirSync(path.dirname(target), { recursive: true })
      await page.screenshot({ path: target, fullPage: true })
      return target
    }
    case "pages": {
      return Array.from(pages.keys())
    }
    case "closePage": {
      const page = pages.get(String(payload.id))
      if (page) {
        pages.delete(String(payload.id))
        await page.close().catch(() => undefined)
      }
      return undefined
    }
    case "closeAll": {
      for (const id of Array.from(pages.keys())) {
        const page = pages.get(id)
        pages.delete(id)
        await page.close().catch(() => undefined)
      }
      return undefined
    }
    default:
      throw new Error("Unsupported action: " + cmd)
  }
}

const server = http.createServer(async (req, res) => {
  let body = ""
  req.on("data", (chunk) => { body += chunk })
  req.on("end", async () => {
    let request = { cmd: "", args: {} }
    try {
      if (body && body.trim()) request = JSON.parse(body)
    } catch (error) {
      res.statusCode = 400
      res.setHeader("content-type", "application/json")
      res.end(JSON.stringify({ error: String(error) }))
      return
    }
    try {
      const result = await handle(request.cmd, request.args)
      res.statusCode = 200
      res.setHeader("content-type", "application/json")
      res.end(JSON.stringify({ result }))
    } catch (error) {
      res.statusCode = 500
      res.setHeader("content-type", "application/json")
      res.end(JSON.stringify({ error: error && error.message ? error.message : String(error) }))
    }
  })
})

server.listen(0, "127.0.0.1", () => {
  process.stdout.write("READY " + server.address().port + "\n")
  process.stdout.flush&&process.stdout.flush()
})

function shutdown() {
  try { for (const [id, page] of pages.entries()) page.close().catch(() => {}) } catch {}
  try { if (browser) browser.close().catch(() => {}) } catch {}
  process.exit(0)
}

process.on("SIGTERM", shutdown)
process.on("SIGINT", shutdown)

Promise.resolve().then(() => {}).catch((error) => process.stderr.write(String(error) + "\n"))
