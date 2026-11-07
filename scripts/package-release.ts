import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { crc32, deflateRawSync } from "node:zlib"
import pkg from "../package.json" with { type: "json" }

export type Target = {
  readonly archive: string
  readonly bunTarget: string
  readonly exe: string
}

export const TARGETS: ReadonlyArray<Target> = [
  { archive: "ibid-darwin-aarch64", bunTarget: "bun-darwin-arm64", exe: "ibid" },
  { archive: "ibid-darwin-x64", bunTarget: "bun-darwin-x64", exe: "ibid" },
  { archive: "ibid-linux-aarch64", bunTarget: "bun-linux-arm64", exe: "ibid" },
  { archive: "ibid-linux-x64", bunTarget: "bun-linux-x64", exe: "ibid" },
  { archive: "ibid-linux-aarch64-musl", bunTarget: "bun-linux-arm64-musl", exe: "ibid" },
  { archive: "ibid-linux-x64-musl", bunTarget: "bun-linux-x64-musl", exe: "ibid" },
  { archive: "ibid-windows-x64", bunTarget: "bun-windows-x64", exe: "ibid.exe" },
  { archive: "ibid-windows-aarch64", bunTarget: "bun-windows-arm64", exe: "ibid.exe" }
]

/** Builds a single-entry PKZIP archive in memory with executable permissions (0755) preserved in external attributes. */
export const createSingleFileZip = (entryPath: string, data: Uint8Array): Uint8Array => {
  const nameBytes = new TextEncoder().encode(entryPath)
  const compressed = deflateRawSync(data, { level: 6 })
  const checksum = crc32(data) >>> 0
  const localHeaderSize = 30 + nameBytes.length
  const centralHeaderSize = 46 + nameBytes.length
  const centralOffset = localHeaderSize + compressed.byteLength
  const totalSize = centralOffset + centralHeaderSize + 22
  const out = new Uint8Array(totalSize)
  const view = new DataView(out.buffer)

  // Local file header
  view.setUint32(0, 0x04034b50, true)
  view.setUint16(4, 20, true) // version needed (2.0)
  view.setUint16(6, 0, true) // flags
  view.setUint16(8, 8, true) // compression: deflate
  view.setUint16(10, 0, true) // mod time
  view.setUint16(12, 0x5821, true) // mod date
  view.setUint32(14, checksum, true)
  view.setUint32(18, compressed.byteLength, true)
  view.setUint32(22, data.byteLength, true)
  view.setUint16(26, nameBytes.length, true)
  view.setUint16(28, 0, true)
  out.set(nameBytes, 30)
  out.set(compressed, localHeaderSize)

  // Central directory file header
  view.setUint32(centralOffset, 0x02014b50, true)
  view.setUint16(centralOffset + 4, 0x031e, true) // version made by: Unix (3), 3.0
  view.setUint16(centralOffset + 6, 20, true) // version needed
  view.setUint16(centralOffset + 8, 0, true)
  view.setUint16(centralOffset + 10, 8, true) // deflate
  view.setUint16(centralOffset + 12, 0, true)
  view.setUint16(centralOffset + 14, 0x5821, true)
  view.setUint32(centralOffset + 16, checksum, true)
  view.setUint32(centralOffset + 20, compressed.byteLength, true)
  view.setUint32(centralOffset + 24, data.byteLength, true)
  view.setUint16(centralOffset + 28, nameBytes.length, true)
  view.setUint16(centralOffset + 30, 0, true)
  view.setUint16(centralOffset + 32, 0, true)
  view.setUint16(centralOffset + 34, 0, true)
  view.setUint16(centralOffset + 36, 0, true)
  view.setUint32(centralOffset + 38, (0o100755 << 16) >>> 0, true) // Unix mode 0100755
  view.setUint32(centralOffset + 42, 0, true) // local header offset
  out.set(nameBytes, centralOffset + 46)

  // End of central directory record
  const eocdOffset = centralOffset + centralHeaderSize
  view.setUint32(eocdOffset, 0x06054b50, true)
  view.setUint16(eocdOffset + 4, 0, true)
  view.setUint16(eocdOffset + 6, 0, true)
  view.setUint16(eocdOffset + 8, 1, true)
  view.setUint16(eocdOffset + 10, 1, true)
  view.setUint32(eocdOffset + 12, centralHeaderSize, true)
  view.setUint32(eocdOffset + 16, centralOffset, true)
  view.setUint16(eocdOffset + 20, 0, true)

  return out
}

if (import.meta.main) {
  const root = join(import.meta.dir, "..")
  const outDir = join(root, "dist", "release")
  const filterArg = process.argv.find((a) => a.startsWith("--target="))?.slice("--target=".length)
  const selected = filterArg
    ? TARGETS.filter((t) => t.archive === filterArg || t.bunTarget === filterArg)
    : TARGETS

  if (selected.length === 0) {
    console.error(`Unknown target "${filterArg}". Available targets: ${TARGETS.map((t) => t.archive).join(", ")}`)
    process.exit(1)
  }

  mkdirSync(outDir, { recursive: true })
  const shasums: Array<string> = []

  console.log(`Packaging ibid v${pkg.version} (${selected.length} target${selected.length === 1 ? "" : "s"})...`)

  for (const target of selected) {
    const stageDir = join(outDir, target.archive)
    const binPath = join(stageDir, target.exe)
    const zipName = `${target.archive}.zip`
    const zipPath = join(outDir, zipName)

    rmSync(stageDir, { recursive: true, force: true })
    mkdirSync(stageDir, { recursive: true })

    console.log(`  -> compiling ${target.archive} (${target.bunTarget})...`)
    const proc = Bun.spawnSync(
      ["bun", "build", "--compile", `--target=${target.bunTarget}`, join(root, "src", "cli.ts"), "--outfile", binPath],
      { cwd: root, stdio: ["ignore", "pipe", "pipe"] }
    )
    if (proc.exitCode !== 0) {
      console.error(proc.stderr.toString())
      process.exit(proc.exitCode)
    }

    const binBytes = new Uint8Array(readFileSync(binPath))
    const zipBytes = createSingleFileZip(`${target.archive}/${target.exe}`, binBytes)
    writeFileSync(zipPath, zipBytes)
    rmSync(stageDir, { recursive: true, force: true })

    const sha256 = new Bun.CryptoHasher("sha256").update(zipBytes).digest("hex")
    shasums.push(`${sha256}  ${zipName}`)
    const mb = (statSync(zipPath).size / (1024 * 1024)).toFixed(1)
    console.log(`     wrote ${zipName} (${mb} MB, sha256: ${sha256.slice(0, 12)}...)`)
  }

  writeFileSync(join(outDir, "SHASUMS256.txt"), `${shasums.join("\n")}\n`)
  console.log(`Done. Artifacts and SHASUMS256.txt written to dist/release/`)
}
