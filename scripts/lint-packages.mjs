import { spawnSync } from 'node:child_process'
/**
 * 对 packages 下全部发布包运行 publint + @arethetypeswrong/cli (attw)。
 * 本地与 CI 共用：pnpm run lint:packages（须先 build 生成 dist/）。
 *
 * - 发现：packages/<name>/package.json
 * - publint：包形态 / exports 校验
 * - attw --pack：发布态类型入口校验，并清理产生的 .tgz
 * - 任一包任一工具失败 → 进程退出码 1（hard-fail，无 allowlist）
 */
import { existsSync, readdirSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PACKAGES_DIR = join(ROOT, 'packages')

/**
 * Discover publishable packages under packages/.
 * @returns {Array<{ name: string, dir: string }>} package descriptors with directory name and absolute path
 */
function discoverPackages() {
  if (!existsSync(PACKAGES_DIR)) {
    console.error(`[lint-packages] packages directory not found: ${PACKAGES_DIR}`)
    process.exit(1)
  }

  return readdirSync(PACKAGES_DIR, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map((entry) => {
      const dir = join(PACKAGES_DIR, entry.name)
      const pkgJsonPath = join(dir, 'package.json')
      if (!existsSync(pkgJsonPath))
        return null
      return { name: entry.name, dir }
    })
    .filter(Boolean)
}

/**
 * @param {string} command
 * @param {string[]} args
 * @param {string} cwd
 * @returns {number} exit code
 */
function runTool(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    stdio: 'inherit',
    shell: false,
    env: process.env,
  })
  if (result.error) {
    console.error(`[lint-packages] failed to spawn ${command}:`, result.error.message)
    return 1
  }
  return result.status ?? 1
}

/**
 * Remove leftover pack tarballs created by attw --pack.
 * @param {string} pkgDir
 */
function cleanPackArtifacts(pkgDir) {
  for (const entry of readdirSync(pkgDir)) {
    if (entry.endsWith('.tgz')) {
      const full = join(pkgDir, entry)
      try {
        rmSync(full, { force: true })
        console.log(`[lint-packages] cleaned ${full}`)
      }
      catch (err) {
        console.warn(`[lint-packages] could not remove ${full}:`, err.message)
      }
    }
  }
}

function main() {
  const packages = discoverPackages()
  if (packages.length === 0) {
    console.error('[lint-packages] no packages found under packages/')
    process.exit(1)
  }

  console.log(`[lint-packages] checking ${packages.length} package(s) with publint + attw`)

  let exitCode = 0

  for (const pkg of packages) {
    const distDir = join(pkg.dir, 'dist')
    if (!existsSync(distDir)) {
      console.error(
        `[lint-packages] missing dist/ for ${pkg.name} (${distDir}). Run \`pnpm run build\` first.`,
      )
      exitCode = 1
      continue
    }

    console.log(`\n========== ${pkg.name} / publint ==========`)
    const publintCode = runTool('pnpm', ['exec', 'publint', '.'], pkg.dir)
    if (publintCode !== 0) {
      console.error(`[lint-packages] publint failed for ${pkg.name} (exit ${publintCode})`)
      exitCode = 1
    }

    // node16 profile: monorepo engines require Node >=22; node10 classic resolution
    // cannot see package.exports subpaths and is not a supported consumer target.
    console.log(`\n========== ${pkg.name} / attw --pack --profile node16 ==========`)
    const attwCode = runTool(
      'pnpm',
      ['exec', 'attw', '--pack', '.', '--profile', 'node16'],
      pkg.dir,
    )
    if (attwCode !== 0) {
      console.error(`[lint-packages] attw failed for ${pkg.name} (exit ${attwCode})`)
      exitCode = 1
    }
    cleanPackArtifacts(pkg.dir)
  }

  if (exitCode !== 0) {
    console.error('\n[lint-packages] FAILED — fix package export/type issues above (hard-fail, no allowlist)')
    process.exit(1)
  }

  console.log('\n[lint-packages] OK — all packages passed publint + attw')
}

main()
