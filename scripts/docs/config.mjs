/*
 * Machine-readable projection of docs/standards/global/project-documentation.md.
 * Keep policy prose in the project documentation config; this file only gives
 * checks stable paths and explicit exceptions.
 */

export const docsConfig = Object.freeze({
  managedRoots: [
    { path: 'docs', entry: 'docs/README.md', navigation: 'indexed' },
    {
      path: '.chery/docs',
      entry: '.chery/docs/README.md',
      navigation: 'indexed',
      linkCheck: false,
      note: '运行时模板文档的相对路径在模板安装后解析，不按仓库相对路径检查',
    },
    {
      path: '.chery.template/docs',
      entry: '.chery.template/docs/README.md',
      navigation: 'indexed',
      linkCheck: false,
      note: '模板文档的相对路径由模板同步和安装环境解析，不按仓库相对路径检查',
    },
    { path: 'tools/plan-viewer', entry: 'tools/plan-viewer/README.md', navigation: 'standalone' },
    { path: 'firmware', entry: 'firmware/README.md', navigation: 'standalone' },
  ],
  rootEntries: ['AGENTS.md', 'README.md'],
  orphanExclusions: [
    'docs/**/archive',
    'docs/quality/verification',
    'docs/plan/**/verify/out',
  ],
  readmeExclusions: [
    'docs/**/archive',
    'docs/plan',
    'docs/quality/verification',
  ],
  sourcePolicy: {
    generated: [],
    externalMirrors: [],
    metadata: {
      enabled: false,
      fields: ['title', 'summary', 'read_when', 'source', 'generated'],
    },
  },
});

export function normalizeRepoPath(value) {
  return value.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/$/, '');
}

export function isUnder(relativePath, prefix) {
  const file = normalizeRepoPath(relativePath);
  const root = normalizeRepoPath(prefix);
  return file === root || file.startsWith(`${root}/`);
}

export function isExcluded(relativePath, exclusions) {
  const normalized = normalizeRepoPath(relativePath);
  return exclusions.some((entry) => {
    const pattern = normalizeRepoPath(entry);
    if (pattern.includes('**')) {
      const [before, after] = pattern.split('**');
      return normalized.startsWith(before) && normalized.includes(after.replace(/^\//, ''));
    }
    return isUnder(normalized, pattern);
  });
}
