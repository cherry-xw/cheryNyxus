import { readFileSync, writeFileSync, copyFileSync, cpSync } from 'node:fs'
// Resource source remains singular; packaging never publishes it into global runtime Skills.
cpSync(new URL('../skills/qq-information', import.meta.url),
  new URL('../dist/skills/qq-information', import.meta.url), { recursive: true })
cpSync(new URL('../skills/douyin-download-send', import.meta.url),
  new URL('../dist/skills/douyin-download-send', import.meta.url), { recursive: true })
cpSync(new URL('../ui-built', import.meta.url), new URL('../dist/ui', import.meta.url), {
  recursive: true,
})
copyFileSync(
  new URL('../ui-built/index.html', import.meta.url),
  new URL('../dist/ui/index.html', import.meta.url),
)
copyFileSync(
  new URL('../config.yaml', import.meta.url),
  new URL('../dist/config.yaml', import.meta.url),
)
writeFileSync(
  new URL('../dist/package.json', import.meta.url),
  JSON.stringify({
    name: 'cherynyxus-qq-module',
    version: JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version,
    type: 'module',
    private: true,
  }),
)
