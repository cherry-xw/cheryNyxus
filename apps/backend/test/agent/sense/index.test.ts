/**
 * agent/sense/index 测试：reloadSenses + runSenseTests。
 *
 * 覆盖：
 * - reloadSenses 注册 4 内置 senses（read_file/write_file/execute_command/skill）
 * - reset 后 reload 恢复
 * - runSenseTests：全过 / 部分失败 / execute 抛错
 */
import { afterEach, describe, it, expect } from "vitest";
import { prepareSenseSourceReload, reloadSenses, runSenseTests } from "@/agent/sense/index.js";
import { getSense, registerSenses, replaceLocalSenses, resetSenses } from "@/core/sense/index.js";
import { createTestSense } from "../helpers/fakeContext.js";
import type { TestCase } from "@/core/sense/compiler/types.js";
import config from '@/utils/config.js'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

describe("reloadSenses", () => {
  it("注册 4 个内置 senses", async () => {
    await reloadSenses();
    expect(getSense("read_file")).toBeDefined();
    expect(getSense("write_file")).toBeDefined();
    expect(getSense("execute_command")).toBeDefined();
    expect(getSense("skill")).toBeDefined();
  });

  it("reset 后重新 reload 恢复", async () => {
    await reloadSenses();
    expect(getSense("read_file")).toBeDefined();
    resetSenses();
    expect(getSense("read_file")).toBeUndefined();
    await reloadSenses();
    expect(getSense("read_file")).toBeDefined();
  });

  it("重复 reloadSenses 安全（幂等）", async () => {
    await reloadSenses();
    await reloadSenses();
    expect(getSense("read_file")).toBeDefined();
  });
});

describe('prepareSenseSourceReload', () => {
  const originalSensesDir = config.global.senses_dir
  const temporaryDirectories: string[] = []

  function createWorkspace() {
    const root = mkdtempSync(join(tmpdir(), 'chery-sense-hot-'))
    const sourceDir = join(root, 'source')
    const distDir = join(root, 'dist')
    mkdirSync(sourceDir, { recursive: true })
    mkdirSync(join(distDir, 'senses'), { recursive: true })
    temporaryDirectories.push(root)
    config.global.senses_dir = sourceDir
    return { sourceDir, distDir }
  }

  function registerExistingSenses() {
    const local = createTestSense('local_old')
    const mcp = createTestSense('mcp__server__tool')
    replaceLocalSenses([local])
    registerSenses([mcp])
    return { local, mcp }
  }

  afterEach(() => {
    config.global.senses_dir = originalSensesDir
    resetSenses()
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('keeps artifacts and local/MCP registrations when compilation fails', async () => {
    const { sourceDir, distDir } = createWorkspace()
    const { local, mcp } = registerExistingSenses()
    const oldArtifact = join(distDir, 'senses', 'old.js')
    writeFileSync(oldArtifact, 'old artifact', 'utf-8')
    writeFileSync(join(sourceDir, 'broken.ts'), 'const value = ;', 'utf-8')

    await expect(prepareSenseSourceReload({ distDir })).rejects.toThrow()

    expect(getSense('local_old')).toBe(local)
    expect(getSense('mcp__server__tool')).toBe(mcp)
    expect(readFileSync(oldArtifact, 'utf-8')).toBe('old artifact')
    expect(readdirSync(distDir).some((name) => name.startsWith('.sense-candidate-'))).toBe(false)
  })

  it('publishes staged artifacts and local registrations only on apply', async () => {
    const { sourceDir, distDir } = createWorkspace()
    const { local, mcp } = registerExistingSenses()
    const oldArtifact = join(distDir, 'senses', 'old.js')
    writeFileSync(oldArtifact, 'old artifact', 'utf-8')
    writeFileSync(
      join(sourceDir, 'hot_custom.ts'),
      `const Schema = z.object({});
export default sense("hot_custom", "hot custom", Schema, async () => ({ content: "ok", hash: "" }));`,
      'utf-8',
    )

    const candidate = await prepareSenseSourceReload({ distDir })

    expect(getSense('local_old')).toBe(local)
    expect(getSense('hot_custom')).toBeUndefined()
    expect(getSense('mcp__server__tool')).toBe(mcp)
    expect(readFileSync(oldArtifact, 'utf-8')).toBe('old artifact')
    expect(existsSync(join(distDir, 'senses', 'hot_custom.js'))).toBe(false)

    candidate.apply()

    expect(getSense('local_old')).toBeUndefined()
    expect(getSense('hot_custom')).toBeDefined()
    expect(getSense('mcp__server__tool')).toBe(mcp)
    expect(existsSync(oldArtifact)).toBe(false)
    expect(existsSync(join(distDir, 'senses', 'hot_custom.js'))).toBe(true)
    candidate.rollback()
    expect(getSense('local_old')).toBe(local)
    expect(getSense('hot_custom')).toBeUndefined()
    expect(getSense('mcp__server__tool')).toBe(mcp)
    expect(readFileSync(oldArtifact, 'utf-8')).toBe('old artifact')
    candidate.dispose()
    expect(readdirSync(distDir).some((name) => name.startsWith('.sense-'))).toBe(false)
  })
})

describe("runSenseTests", () => {
  it("全过 → passed true", async () => {
    const s = createTestSense("calc", async (input) => ({ content: String(Number(input.x) * 2), hash: "" }));
    const tcs: TestCase[] = [{ input: { x: 2 }, output: { content: "4", hash: "" } }];
    const r = await runSenseTests(s, tcs);
    expect(r.passed).toBe(true);
    expect(r.passedCount).toBe(1);
    expect(r.totalCount).toBe(1);
  });

  it("部分失败 → failures 非空", async () => {
    const s = createTestSense("calc", async (input) => ({ content: String(Number(input.x) * 2), hash: "" }));
    const tcs: TestCase[] = [
      { input: { x: 2 }, output: { content: "4", hash: "" } },
      { input: { x: 3 }, output: { content: "99", hash: "" } },
    ];
    const r = await runSenseTests(s, tcs);
    expect(r.passed).toBe(false);
    expect(r.passedCount).toBe(1);
    expect(r.failures.length).toBe(1);
    expect(r.failures[0]!.expected).toEqual({ content: "99", hash: "" });
  });

  it("execute 抛错 → error 填充", async () => {
    const s = createTestSense("boom", async () => {
      throw new Error("exec boom");
    });
    const r = await runSenseTests(s, [{ input: {}, output: { content: "", hash: "" } }]);
    expect(r.passed).toBe(false);
    expect(r.error).toContain("exec boom");
  });
});
