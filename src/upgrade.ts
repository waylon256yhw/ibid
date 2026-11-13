import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { chmod, rename, rm, writeFile } from "node:fs/promises"
import { Effect } from "effect"
import { unzip } from "./docx.ts"
import { VERSION } from "./resolve.ts"
import { UpgradeError, UpstreamError } from "./schema.ts"

const releases = () => `${process.env.GITHUB || "https://github.com"}/waylon256yhw/ibid/releases`

const message = (e: unknown) => e instanceof Error ? e.message : String(e)

// ponytail: same rules as resolveTarget in scripts/postinstall.mjs, which must stay a dependency-free Node script.
/** The release archive name for this machine, e.g. `ibid-darwin-aarch64`; a Rosetta 2 process gets the native arm64 build. */
export const releaseTarget = (platform: string = process.platform, arch: string = process.arch) => {
  const rosetta = platform === "darwin" && arch === "x64" &&
    spawnSync("sysctl", ["-n", "sysctl.proc_translated"], { encoding: "utf8" }).stdout?.trim() === "1"
  const cpu = arch === "arm64" || rosetta ? "aarch64" : arch === "x64" ? "x64" : undefined
  if (!cpu) return undefined
  if (platform === "darwin") return `ibid-darwin-${cpu}`
  if (platform === "win32") return `ibid-windows-${cpu}`
  if (platform !== "linux") return undefined
  const report = process.report?.getReport() as { header?: { glibcVersionRuntime?: string } } | undefined
  const musl = existsSync("/etc/alpine-release") || (report?.header !== undefined && !report.header.glibcVersionRuntime)
  return `ibid-linux-${cpu}${musl ? "-musl" : ""}`
}

const get = (url: string, init?: RequestInit) =>
  Effect.tryPromise({
    try: () => fetch(url, { ...init, headers: { "User-Agent": `ibid/${VERSION}` } }),
    catch: (e) => new UpstreamError({ url, message: `${url}: ${message(e)}` })
  })

const body = <A>(url: string, res: Response, read: (r: Response) => Promise<A>) =>
  Effect.tryPromise({ try: () => read(res), catch: (e) => new UpstreamError({ url, message: `${url}: ${message(e)}` }) })

/** The latest release version, read from the redirect of `/releases/latest` so the GitHub API rate limit is not spent. */
export const latestVersion = Effect.gen(function*() {
  const url = `${releases()}/latest`
  const res = yield* get(url, { redirect: "manual" })
  const tag = /\/releases\/tag\/v?([^/?#]+)$/.exec(res.headers.get("location") ?? "")?.[1]
  if (!tag) return yield* new UpstreamError({ url, message: `no latest release found at ${url} (HTTP ${res.status})` })
  return decodeURIComponent(tag)
})

/** Download, check and smoke-test the release binary, then swap it in for `exe` without ever writing over the running file. */
const install = async (binary: Uint8Array, exe: string, version: string) => {
  const tmp = `${exe}.${process.pid}.tmp`
  const old = `${exe}.old`
  try {
    if (process.platform === "win32") await rm(old, { force: true }).catch(() => {})
    await writeFile(tmp, binary)
    if (process.platform !== "win32") await chmod(tmp, 0o755)
    const smoke = spawnSync(tmp, ["--version"], { encoding: "utf8", timeout: 30_000 })
    const reported = smoke.stdout?.trim().split(/\s+/).pop()
    if (reported !== `v${version}`) {
      throw new Error(`the downloaded binary did not report v${version} (${smoke.error?.message ?? (reported || `exit ${smoke.status}`)})`)
    }
    if (process.platform !== "win32") return await rename(tmp, exe)
    // Windows locks a running .exe against writing and deleting, but lets it be renamed.
    await rename(exe, old)
    await rename(tmp, exe).catch(async (e) => {
      await rename(old, exe)
      throw e
    })
  } finally {
    await rm(tmp, { force: true }).catch(() => {})
  }
}

/**
 * Replace the binary at `exe` with release `version` (the latest when omitted). Nothing changes when it is
 * already that version, unless `force`; a downgrade is allowed when a version is given.
 */
export const upgrade = Effect.fn("upgrade")(function*(opts: { version?: string; force: boolean; exe: string }) {
  const target = releaseTarget()
  if (!target) return yield* new UpgradeError({ message: `no release build for ${process.platform} ${process.arch}` })
  const to = opts.version ?? (yield* latestVersion)
  const result = { from: VERSION, to, path: opts.exe, target }
  if (to === VERSION && !opts.force) return { action: "up-to-date" as const, ...result }

  const base = `${releases()}/download/v${to}`
  const zipUrl = `${base}/${target}.zip`
  const zipRes = yield* get(zipUrl)
  if (!zipRes.ok) {
    return yield* new UpstreamError({ url: zipUrl, message: `no ${target}.zip in release v${to} (HTTP ${zipRes.status})` })
  }
  const zip = new Uint8Array(yield* body(zipUrl, zipRes, (r) => r.arrayBuffer()))

  const sumsUrl = `${base}/SHASUMS256.txt`
  const sumsRes = yield* get(sumsUrl)
  if (sumsRes.ok) {
    const sums = yield* body(sumsUrl, sumsRes, (r) => r.text())
    const expected = sums.split("\n").map((l) => l.trim().split(/\s+\*?/)).find(([, name]) => name === `${target}.zip`)?.[0]
    const actual = createHash("sha256").update(zip).digest("hex")
    if (expected?.toLowerCase() !== actual) {
      return yield* new UpgradeError({ message: expected ? `${target}.zip does not match SHASUMS256.txt` : `SHASUMS256.txt has no entry for ${target}.zip` })
    }
  }

  const entry = `${target}/${target.startsWith("ibid-windows") ? "ibid.exe" : "ibid"}`
  const binary = yield* Effect.try({
    try: () => unzip(zip).get(entry)?.(),
    catch: (e) => new UpgradeError({ message: `cannot read ${target}.zip: ${message(e)}` })
  })
  if (!binary) return yield* new UpgradeError({ message: `${target}.zip does not contain ${entry}` })

  yield* Effect.tryPromise({
    try: () => install(binary, opts.exe, to),
    catch: (e) => new UpgradeError({ message: `cannot install to ${opts.exe}: ${message(e)}` })
  })
  return { action: "upgraded" as const, ...result }
})
