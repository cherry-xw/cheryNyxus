import { runMigrations } from './db.mjs'

const applied = runMigrations()
console.log('[db:migrate] applied migrations:', applied)
