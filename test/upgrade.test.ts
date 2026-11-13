import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { createSingleFileZip } from "../scripts/package-release.ts"
import { VERSION } from "../src/resolve.ts"
import { releaseTarget, upgrade } from "../src/upgrade.ts"

// A fake GitHub: /releases/latest redirects to v9.9.9, whose zip holds a shell script that prints its version.
const target = releaseTarget()!
const script = (v: string) => new TextEncoder().encode(`#!/bin/sh\necho "ibid v${v}"\n`)
const zip = createSingleFileZip(`${target}/ibid`, script("9.9.9"))
const badZip = createSingleFileZip(`${target}/ibid`, script("7.7.7"))
const sums = (z: Uint8Array) => `${createHash("sha256").update(z).digest("hex")}  ${target}.zip\n`
const files: Record<string, Uint8Array | string> = {
  [`/v9.9.9/${target}.zip`]: zip,
  "/v9.9.9/SHASUMS256.txt": sums(zip),
  [`/v8.0.0/${target}.zip`]: zip,
  "/v8.0.0/SHASUMS256.txt": sums(badZip),
  [`/v1.0.0/${target}.zip`]: badZip
}

let server: ReturnType<typeof Bun.serve>
beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch: (req) => {
      const path = new URL(req.url).pathname.replace("/waylon256yhw/ibid/releases", "")
      if (path === "/latest") return new Response(null, { status: 302, headers: { location: "/waylon256yhw/ibid/releases/tag/v9.9.9" } })
      const file = files[path.replace("/download", "")]
      return file ? new Response(file) : new Response("not found", { status: 404 })
    }
  })
  process.env.GITHUB = server.url.origin
})
afterAll(() => {
  server.stop()
  delete process.env.GITHUB
})

const exe = () => {
  const path = join(mkdtempSync(join(tmpdir(), "ibid-upgrade-")), "ibid")
  writeFileSync(path, script(VERSION))
  chmodSync(path, 0o755)
  return path
}

describe.skipIf(process.platform === "win32")("upgrade", () => {
  test("installs the latest release over the binary after checking it", async () => {
    const path = exe()
    const r = await Effect.runPromise(upgrade({ force: false, exe: path }))
    expect(r).toEqual({ action: "upgraded", from: VERSION, to: "9.9.9", path, target })
    expect(readFileSync(path, "utf8")).toContain("v9.9.9")
    expect(statSync(path).mode & 0o777).toBe(0o755)
  })

  test("does nothing when already at the version, unless forced", async () => {
    const path = exe()
    expect((await Effect.runPromise(upgrade({ version: VERSION, force: false, exe: path }))).action).toBe("up-to-date")
    const forced = await Effect.runPromise(Effect.flip(upgrade({ version: VERSION, force: true, exe: path })))
    expect(forced._tag).toBe("UpstreamError") // no such release on the fake server, so it did try
  })

  test.each([
    ["8.0.0", "does not match SHASUMS256.txt"],
    ["1.0.0", "did not report v1.0.0"]
  ])("leaves the binary alone when release %s fails a check", async (version, why) => {
    const path = exe()
    const e = await Effect.runPromise(Effect.flip(upgrade({ version, force: false, exe: path })))
    expect(e._tag).toBe("UpgradeError")
    expect(e.message).toContain(why)
    expect(readFileSync(path, "utf8")).toContain(`v${VERSION}`)
  })
})
