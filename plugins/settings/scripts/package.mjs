import { readFileSync, copyFileSync, cpSync, mkdirSync, writeFileSync } from 'node:fs'
const dist = new URL('../dist/', import.meta.url)
mkdirSync(dist, { recursive: true })
copyFileSync(new URL('../config.yaml', import.meta.url), new URL('config.yaml', dist))
cpSync(new URL('../ui-built/', import.meta.url), new URL('ui/', dist), { recursive: true })
copyFileSync(new URL('../ui-built/index.html', import.meta.url), new URL('ui/index.html', dist))
writeFileSync(
  new URL('package.json', dist),
  JSON.stringify(
    {
      name: 'cherynyxus-settings-module',
      version: JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version,
      type: 'module',
      private: true,
    },
    null,
    2,
  ) + '\n',
)
