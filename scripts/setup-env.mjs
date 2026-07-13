import { existsSync, copyFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = resolve(__dirname, '..')

const envFile = resolve(root, '.env')
const example = resolve(root, '.env.example')

if (!existsSync(envFile) && existsSync(example)) {
  copyFileSync(example, envFile)
  console.log('✓ .env created from .env.example')
} else {
  console.log(existsSync(envFile) ? '.env already exists, skipped' : '.env.example not found, skipped')
}
