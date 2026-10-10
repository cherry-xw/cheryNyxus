export function fileType(name: string, kind: 'file' | 'directory' = 'file') {
  if (name === '.git' || name.startsWith('.git'))
    return { label: 'Git', glyph: 'git', language: 'ini' }
  if (kind === 'directory') return { label: '文件夹', glyph: 'folder', language: '' }
  if (name === '.env' || name.startsWith('.env.'))
    return { label: 'ENV', glyph: 'lock', language: 'ini' }
  const ext = name.split('.').pop()?.toLowerCase() ?? ''
  const types: Record<string, [string, string]> = {
    ts: ['TS', 'typescript'],
    tsx: ['TSX', 'typescript'],
    js: ['JS', 'javascript'],
    jsx: ['JSX', 'javascript'],
    json: ['{}', 'json'],
    md: ['MD', 'markdown'],
    markdown: ['MD', 'markdown'],
    txt: ['TXT', 'plaintext'],
    cshtml: ['C#', 'xml'],
    cs: ['C#', 'csharp'],
    vue: ['VUE', 'xml'],
    html: ['HTML', 'xml'],
    css: ['CSS', 'css'],
    less: ['LESS', 'less'],
    scss: ['SCSS', 'scss'],
    py: ['PY', 'python'],
    rs: ['RS', 'rust'],
    go: ['GO', 'go'],
    yaml: ['YML', 'yaml'],
    yml: ['YML', 'yaml'],
    sh: ['SH', 'bash'],
    ps1: ['PS', 'powershell'],
    sql: ['SQL', 'sql'],
    png: ['IMG', ''],
    jpg: ['IMG', ''],
    jpeg: ['IMG', ''],
    svg: ['SVG', 'xml'],
    webp: ['IMG', ''],
    gif: ['IMG', ''],
    zip: ['ZIP', ''],
    pdf: ['PDF', ''],
    xml: ['XML', 'xml'],
    toml: ['TOML', 'ini'],
  }
  const [label, language] = types[ext] ?? [ext.toUpperCase().slice(0, 4) || 'FILE', 'plaintext']
  return { label, glyph: 'file', language }
}
