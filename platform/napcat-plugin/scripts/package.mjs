import { readFile, writeFile, mkdir } from 'node:fs/promises'
import AdmZip from 'adm-zip'
const root = new URL('../', import.meta.url)
const { scripts, private: internal, ...metadata } = JSON.parse(await readFile(new URL('package.json', root), 'utf8'))
await writeFile(new URL('dist/package.json', root), JSON.stringify(metadata, null, 2) + '\n')
await mkdir(new URL('artifacts/', root), { recursive: true })
const zip = new AdmZip()
for (const name of ['index.mjs', 'package.json']) zip.addFile(name, await readFile(new URL(`dist/${name}`, root)))
const path = new URL(`artifacts/${metadata.name}-${metadata.version}.zip`, root)
zip.writeZip(path.pathname)
console.log(path.pathname)
