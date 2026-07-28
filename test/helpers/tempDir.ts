import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

export function createTempDir(): string {
  const tempDir = mkdtempSync(join(tmpdir(), "cheryNyxus-test-"));
  return tempDir;
}

export function cleanupTempDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

export function createTempFile(dir: string, filename: string, content: string): string {
  const filePath = join(dir, filename);
  writeFileSync(filePath, content);
  return filePath;
}