import { build } from 'esbuild'
import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import { mkdir } from 'node:fs/promises'
import electron from 'electron'

await mkdir('tmp', { recursive: true })
const test = process.argv[2] ?? 'multi-account'
if (!['multi-account', 'erp-navigation', 'session-cache', 'purchase-queue'].includes(test)) throw new Error('Unknown Electron regression')
const output = `tmp/${test}.electron-test.mjs`
await build({ entryPoints: [`scripts/${test}.electron-test.ts`], outfile: output,
  bundle: true, packages: 'external', platform: 'node', format: 'esm', external: ['electron'],
  define: { __dirname: JSON.stringify(resolve('out/main')) }, logLevel: 'warning' })
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
delete env.ELECTRON_RENDERER_URL
const child = spawn(electron, [output], { env, stdio: 'inherit', windowsHide: true })
child.on('error', error => { console.error(error); process.exitCode = 1 })
child.on('exit', code => { process.exitCode = code ?? 1 })
