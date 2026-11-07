#!/usr/bin/env node
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { get as httpsGet } from "node:https"
import { dirname, join } from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { inflateRawSync } from "node:zlib"

const __dirname = dirname(fileURLToPath(import.meta.url))
const rootDir = join(__dirname, "..")
const binDir = join(rootDir, "bin")

export const binaryName = process.platform === "win32" ? "ibid-bin.exe" : "ibid-bin"
export const binaryPath = join(binDir, binaryName)

const isRosetta2 = () => {
  if (process.platform !== "darwin" || process.arch !== "x64") return false
  try {
    const out = spawnSync("sysctl", ["-n", "sysctl.proc_translated"], { encoding: "utf8" })
    return out.status === 0 && out.stdout.trim() === "1"
  } catch {
    return false
  }
}

const isLinuxMusl = () => {
  if (process.platform !== "linux") return false
  try {
    if (existsSync("/etc/alpine-release")) return true
    const report = process.report?.getReport?.()
    if (report && typeof report === "object" && "header" in report) {
      return !report.header?.glibcVersionRuntime
    }
  } catch {}
  return false
}

export const resolveTarget = (platform = process.platform, arch = process.arch) => {
  const effectiveArch = platform === "darwin" && arch === "x64" && isRosetta2() ? "arm64" : arch
  const cpu = effectiveArch === "arm64" ? "aarch64" : effectiveArch === "x64" ? "x64" : undefined
  if (!cpu) return undefined
  if (platform === "darwin") return `ibid-darwin-${cpu}`
  if (platform === "win32") return `ibid-windows-${cpu}`
  if (platform === "linux") return `ibid-linux-${cpu}${isLinuxMusl() ? "-musl" : ""}`
  return undefined
}

/** Extracts the first file matching `predicate` from a ZIP buffer using only `DataView` and `node:zlib`. */
export const extractZipEntry = (buf, predicate) => {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  let eocd = -1
  for (let i = buf.byteLength - 22; i >= Math.max(0, buf.byteLength - 65557); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error("Invalid ZIP archive: End of Central Directory not found")
  const total = view.getUint16(eocd + 10, true)
  let offset = view.getUint32(eocd + 16, true)
  const decoder = new TextDecoder()

  for (let i = 0; i < total; i++) {
    if (view.getUint32(offset, true) !== 0x02014b50) throw new Error("Corrupt ZIP central directory header")
    const method = view.getUint16(offset + 10, true)
    const compSize = view.getUint32(offset + 20, true)
    const nameLen = view.getUint16(offset + 28, true)
    const extraLen = view.getUint16(offset + 30, true)
    const commentLen = view.getUint16(offset + 32, true)
    const localOffset = view.getUint32(offset + 42, true)
    const name = decoder.decode(buf.subarray(offset + 46, offset + 46 + nameLen))
    offset += 46 + nameLen + extraLen + commentLen

    if (!predicate(name)) continue
    const localNameLen = view.getUint16(localOffset + 26, true)
    const localExtraLen = view.getUint16(localOffset + 28, true)
    const dataStart = localOffset + 30 + localNameLen + localExtraLen
    const slice = buf.subarray(dataStart, dataStart + compSize)
    if (method === 0) return slice
    if (method === 8) return new Uint8Array(inflateRawSync(slice))
    throw new Error(`Unsupported ZIP compression method: ${method}`)
  }
  throw new Error("Expected executable not found in ZIP archive")
}

const downloadBuffer = (url, redirects = 5) =>
  new Promise((resolve, reject) => {
    if (redirects < 0) return reject(new Error(`Too many redirects while fetching ${url}`))
    httpsGet(url, { headers: { "User-Agent": "ibid-installer" } }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume()
        const nextUrl = new URL(res.headers.location, url).toString()
        return resolve(downloadBuffer(nextUrl, redirects - 1))
      }
      if (res.statusCode !== 200) {
        res.resume()
        return reject(new Error(`HTTP ${res.statusCode} fetching ${url}`))
      }
      const chunks = []
      res.on("data", (c) => chunks.push(c))
      res.on("end", () => resolve(new Uint8Array(Buffer.concat(chunks))))
      res.on("error", reject)
    }).on("error", reject)
  })

export const ensureBinary = async ({ force = false } = {}) => {
  if (!force && existsSync(binaryPath)) return binaryPath

  const pkg = JSON.parse(readFileSync(join(rootDir, "package.json"), "utf8"))
  const version = pkg.version
  const target = resolveTarget()
  if (!target) throw new Error(`Unsupported platform/architecture: ${process.platform} ${process.arch}`)

  mkdirSync(binDir, { recursive: true })

  const github = process.env.GITHUB || "https://github.com"
  const urls = [
    `${github}/waylon256yhw/ibid/releases/download/v${version}/${target}.zip`,
    `${github}/waylon256yhw/ibid/releases/latest/download/${target}.zip`
  ]

  let lastError
  for (const url of urls) {
    try {
      const zipBuf = await downloadBuffer(url)
      const exeSuffix = process.platform === "win32" ? "ibid.exe" : "ibid"
      const binBytes = extractZipEntry(zipBuf, (name) => name === exeSuffix || name.endsWith(`/${exeSuffix}`))
      writeFileSync(binaryPath, binBytes)
      if (process.platform !== "win32") chmodSync(binaryPath, 0o755)
      return binaryPath
    } catch (e) {
      lastError = e
    }
  }

  // Fallback: if Bun is installed locally and source files are present, compile on the spot.
  const cliEntry = join(rootDir, "src", "cli.ts")
  if (existsSync(cliEntry)) {
    const build = spawnSync("bun", ["build", "--compile", cliEntry, "--outfile", binaryPath], {
      cwd: rootDir,
      stdio: "ignore"
    })
    if (build.status === 0 && existsSync(binaryPath)) {
      if (process.platform !== "win32") chmodSync(binaryPath, 0o755)
      return binaryPath
    }
  }

  throw lastError ?? new Error(`Failed to install ibid binary for ${target}`)
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
if (isMain) {
  // Skip postinstall inside a local git checkout so `bun install` during development stays instant and clean.
  if (existsSync(join(rootDir, ".git")) && !process.env.IBID_FORCE_POSTINSTALL) {
    process.exit(0)
  }
  ensureBinary().catch((err) => {
    console.warn(`[ibid] postinstall note: ${err.message || err}`)
    // Do not fail package installation if offline or if Bun will run src/cli.ts directly.
    process.exit(0)
  })
}
