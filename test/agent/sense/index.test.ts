import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SupervisionLevel } from "@/core/config";
import { registerSenseAdapter, senseAdapterRegistry } from "@/core/sense/adapter";
import { SenseManager } from "@/core/sense/senseManager";
import { sense } from "@/core/sense/senseCreator";
import { z } from "zod";
import { runSenseTests, registerSenses, getSenses, ensureCustomSensesLoaded } from "@/agent/sense/index.js";
import type { Sense } from "@/core/sense";
import type { ZodType } from "zod";
import type { TestCase } from "@/core/sense/compiler/types.js";
import { existsSync, mkdirSync, rmSync, writeFileSync, readdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

// Mock SenseAdapter
const mockSenseAdapter = {
  buildSenses: vi.fn((senses: unknown[]) => senses.map((t: unknown) => (t as { definition: unknown }).definition)),
  buildSenseCallMessage: vi.fn((content: string, senseCalls: unknown[]) => ({ role: "assistant", content, senseCalls })),
  buildSenseResponseMessage: vi.fn((id: string, result: string) => ({ role: "tool", toolCallId: id, content: result })),
  senseCalls: vi.fn(() => []),
  extractSenseCallDeltas: vi.fn(() => []),
};

describe("Sense Index", () => {
  beforeEach(() => {
    senseAdapterRegistry.clear();
    registerSenseAdapter("test-provider", mockSenseAdapter as unknown as ReturnType<typeof registerSenseAdapter>);
  });

  describe("SenseManager integration", () => {
    it("should create SenseManager instance", () => {
      const manager = new SenseManager("test-provider");
      expect(manager).toBeDefined();
    });

    it("should add senses", () => {
      const manager = new SenseManager("test-provider");
      const testSense = sense(
        "test_sense_add",
        "Test sense add",
        z.object({}),
        async () => ({ content: "result", hash: "" }),
        SupervisionLevel.auto,
      );

      manager.add([testSense]);
      expect(manager.getAll().length).toBe(1);
    });

    it("should get sense by name", () => {
      const manager = new SenseManager("test-provider");
      const testSense = sense(
        "get_test_sense",
        "Get test",
        z.object({}),
        async () => ({ content: "", hash: "" }),
        SupervisionLevel.auto,
      );

      manager.add([testSense]);
      const result = manager.get("get_test_sense");
      expect(result).toBe(testSense);
    });

    it("should return undefined for nonexistent sense", () => {
      const manager = new SenseManager("test-provider");
      const result = manager.get("nonexistent_sense_xyz");
      expect(result).toBeUndefined();
    });

    it("should execute sense", async () => {
      const manager = new SenseManager("test-provider");
      const testSense = sense(
        "exec_test_sense",
        "Exec test",
        z.object({}),
        async () => ({ content: "execution result", hash: "test-hash" }),
        SupervisionLevel.auto,
      );

      manager.add([testSense]);
      const result = await manager.execute("exec_test_sense", {}, new Map());
      expect(result.content).toBe("execution result");
      expect(result.hash).toBe("test-hash");
    });
  });

  describe("SupervisionLevel enum", () => {
    it("auto should be 0", () => {
      expect(SupervisionLevel.auto).toBe(0);
    });

    it("confirm should be 1", () => {
      expect(SupervisionLevel.confirm).toBe(1);
    });

    it("manual should be 2", () => {
      expect(SupervisionLevel.manual).toBe(2);
    });
  });

  describe("runSenseTests", () => {
    it("should pass all tests when results match", async () => {
      const testSense = sense(
        "pass_all_test",
        "Pass test",
        z.object({ value: z.number() }),
        async (input) => ({ content: `result: ${input.value}`, hash: "" }),
        SupervisionLevel.auto,
      );

      const testCases: TestCase[] = [
        { input: { value: 1 }, output: { content: "result: 1", hash: "" } },
        { input: { value: 2 }, output: { content: "result: 2", hash: "" } },
      ];

      const result = await runSenseTests(testSense as Sense<ZodType>, testCases);

      expect(result.passed).toBe(true);
      expect(result.passedCount).toBe(2);
      expect(result.totalCount).toBe(2);
      expect(result.failures).toHaveLength(0);
    });

    it("should detect content mismatch", async () => {
      const testSense = sense(
        "content_fail_test",
        "Content fail test",
        z.object({ value: z.number() }),
        async () => ({ content: "actual", hash: "" }),
        SupervisionLevel.auto,
      );

      const testCases: TestCase[] = [
        { input: { value: 1 }, output: { content: "expected", hash: "" } },
      ];

      const result = await runSenseTests(testSense as Sense<ZodType>, testCases);

      expect(result.passed).toBe(false);
      expect(result.passedCount).toBe(0);
      expect(result.totalCount).toBe(1);
      expect(result.failures).toHaveLength(1);
      expect(result.failures[0].input).toEqual({ value: 1 });
      expect(result.failures[0].expected).toEqual({ content: "expected", hash: "" });
      expect(result.failures[0].actual).toEqual({ content: "actual", hash: "" });
    });

    it("should detect hash mismatch", async () => {
      const testSense = sense(
        "hash_fail_test",
        "Hash fail test",
        z.object({}),
        async () => ({ content: "same", hash: "actual-hash" }),
        SupervisionLevel.auto,
      );

      const testCases: TestCase[] = [
        { input: {}, output: { content: "same", hash: "expected-hash" } },
      ];

      const result = await runSenseTests(testSense as Sense<ZodType>, testCases);

      expect(result.passed).toBe(false);
      expect(result.failures).toHaveLength(1);
      expect(result.failures[0].actual.hash).toBe("actual-hash");
    });

    it("should handle schema validation error", async () => {
      const testSense = sense(
        "schema_test",
        "Schema test",
        z.object({ required: z.string() }),
        async (input) => ({ content: `got: ${input.required}`, hash: "" }),
        SupervisionLevel.auto,
      );

      const testCases: TestCase[] = [
        // @ts-expect-error - intentionally passing invalid input
        { input: { wrong: "field" }, output: { content: "anything", hash: "" } },
      ];

      const result = await runSenseTests(testSense as Sense<ZodType>, testCases);

      expect(result.passed).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.passedCount).toBe(0);
      expect(result.totalCount).toBe(1);
    });

    it("should handle execution error", async () => {
      const testSense = sense(
        "error_test",
        "Error test",
        z.object({}),
        async () => {
          throw new Error("Execution failed");
        },
        SupervisionLevel.auto,
      );

      const testCases: TestCase[] = [
        { input: {}, output: { content: "anything", hash: "" } },
      ];

      const result = await runSenseTests(testSense as Sense<ZodType>, testCases);

      expect(result.passed).toBe(false);
      expect(result.error).toBe("Execution failed");
    });

    it("should handle empty test cases", async () => {
      const testSense = sense(
        "empty_test",
        "Empty test",
        z.object({}),
        async () => ({ content: "result", hash: "" }),
        SupervisionLevel.auto,
      );

      const testCases: TestCase[] = [];

      const result = await runSenseTests(testSense as Sense<ZodType>, testCases);

      expect(result.passed).toBe(true);
      expect(result.passedCount).toBe(0);
      expect(result.totalCount).toBe(0);
    });

    it("should handle partial pass", async () => {
      let callCount = 0;
      const testSense = sense(
        "partial_test",
        "Partial test",
        z.object({ value: z.number() }),
        async (input) => {
          callCount++;
          if (input.value === 2) {
            return { content: "wrong", hash: "" };
          }
          return { content: `result: ${input.value}`, hash: "" };
        },
        SupervisionLevel.auto,
      );

      const testCases: TestCase[] = [
        { input: { value: 1 }, output: { content: "result: 1", hash: "" } },
        { input: { value: 2 }, output: { content: "result: 2", hash: "" } },
        { input: { value: 3 }, output: { content: "result: 3", hash: "" } },
      ];

      const result = await runSenseTests(testSense as Sense<ZodType>, testCases);

      expect(result.passed).toBe(false);
      expect(result.passedCount).toBe(2);
      expect(result.totalCount).toBe(3);
      expect(result.failures).toHaveLength(1);
      expect(result.failures[0].input).toEqual({ value: 2 });
    });
  });

  describe("registerSenses and getSenses", () => {
    it("should register and retrieve senses", () => {
      const testSense1 = sense(
        "register_test_1",
        "Register test 1",
        z.object({}),
        async () => ({ content: "test1", hash: "" }),
        SupervisionLevel.auto,
      );

      const testSense2 = sense(
        "register_test_2",
        "Register test 2",
        z.object({}),
        async () => ({ content: "test2", hash: "" }),
        SupervisionLevel.auto,
      );

      registerSenses([testSense1, testSense2]);

      const retrieved = getSenses(["register_test_1", "register_test_2"]);
      expect(retrieved.length).toBe(2);
      expect(retrieved[0]).toBe(testSense1);
      expect(retrieved[1]).toBe(testSense2);
    });

    it("should filter nonexistent senses", () => {
      const testSense = sense(
        "filter_test",
        "Filter test",
        z.object({}),
        async () => ({ content: "test", hash: "" }),
        SupervisionLevel.auto,
      );

      registerSenses([testSense]);

      const retrieved = getSenses(["filter_test", "nonexistent_xyz"]);
      expect(retrieved.length).toBe(1);
      expect(retrieved[0]).toBe(testSense);
    });

    it("should handle empty names array", () => {
      const retrieved = getSenses([]);
      expect(retrieved.length).toBe(0);
    });
  });

  describe("Static senses registration", () => {
    it("should have built-in senses registered after import", async () => {
      // Check that bash sense is registered
      const bashSense = getSenses(["execute_command"]);
      expect(bashSense.length).toBe(1);
      expect(bashSense[0]?.definition.function.name).toBe("execute_command");
    });

    it("should have read_file sense registered", async () => {
      const readSense = getSenses(["read_file"]);
      expect(readSense.length).toBe(1);
    });

    it("should have write_file sense registered", async () => {
      const writeSense = getSenses(["write_file"]);
      expect(writeSense.length).toBe(1);
    });

    it("should have skill sense registered", async () => {
      const skillSense = getSenses(["skill"]);
      expect(skillSense.length).toBe(1);
    });
  });
});

// Test loadCustomSenses by creating actual directory
describe("loadCustomSenses with real fs", () => {
  // The senses directory is relative to the source file location (src/agent/sense/senses)
  // not relative to the test file location
  const sensesDir = "/home/chc/self/cheryClaw/src/agent/sense/senses";

  beforeEach(() => {
    // Clean up senses directory before each test
    if (existsSync(sensesDir)) {
      rmSync(sensesDir, { recursive: true, force: true });
    }
  });

  afterEach(() => {
    // Clean up after each test
    if (existsSync(sensesDir)) {
      rmSync(sensesDir, { recursive: true, force: true });
    }
  });

  it("should handle missing senses directory", async () => {
    // Directory doesn't exist
    await ensureCustomSensesLoaded();
    // Should not throw
    expect(true).toBe(true);
  });

  it("should handle empty senses directory", async () => {
    mkdirSync(sensesDir, { recursive: true });
    await ensureCustomSensesLoaded();
    // Should not throw
    expect(true).toBe(true);
  });

  it("should ignore non-JS files", async () => {
    mkdirSync(sensesDir, { recursive: true });
    writeFileSync(join(sensesDir, "readme.txt"), "hello");
    writeFileSync(join(sensesDir, "data.json"), "{}");

    await ensureCustomSensesLoaded();

    // Should not throw and should not try to read non-JS files
    const files = readdirSync(sensesDir);
    expect(files.length).toBe(2);
  });

  it("should load custom sense from JS file", async () => {
    mkdirSync(sensesDir, { recursive: true });

    // Create a valid custom sense file - use named parameters (z, sense, SupervisionLevel, registerSenses)
    const senseCode = `
const customSense = sense(
  "fs_test_custom_sense",
  "A custom test sense from fs test",
  z.object({ input: z.string() }),
  async function(args) { return { content: "Custom: " + args.input, hash: "" }; },
  SupervisionLevel.auto
);

registerSenses([customSense]);
customSense;
`;
    writeFileSync(join(sensesDir, "custom.js"), senseCode);

    await ensureCustomSensesLoaded();

    const customSense = getSenses(["fs_test_custom_sense"]);
    expect(customSense.length).toBe(1);
    expect(customSense[0]?.definition.function.name).toBe("fs_test_custom_sense");
  });

  it("should handle malformed JS file gracefully", async () => {
    mkdirSync(sensesDir, { recursive: true });
    writeFileSync(join(sensesDir, "malformed.js"), "this is not valid javascript {{{");

    await ensureCustomSensesLoaded();

    // Should not throw
    expect(true).toBe(true);
  });

  it("should skip files that dont return valid sense", async () => {
    mkdirSync(sensesDir, { recursive: true });
    writeFileSync(join(sensesDir, "invalid.js"), "{ not: 'a sense' };");

    await ensureCustomSensesLoaded();

    const invalidSense = getSenses(["not"]);
    expect(invalidSense.length).toBe(0);
  });

  it("should strip hash comment from compiled code", async () => {
    mkdirSync(sensesDir, { recursive: true });

    const senseCode = `// hash:abc123def456
const hashSense = sense(
  "fs_hashed_sense",
  "A sense with hash comment",
  z.object({}),
  async function() { return { content: "hashed", hash: "" }; },
  SupervisionLevel.auto
);

registerSenses([hashSense]);
hashSense;
`;
    writeFileSync(join(sensesDir, "hashed.js"), senseCode);

    await ensureCustomSensesLoaded();

    const hashedSense = getSenses(["fs_hashed_sense"]);
    expect(hashedSense.length).toBe(1);
  });

  it("should handle multiple JS files", async () => {
    mkdirSync(sensesDir, { recursive: true });

    const sense1Code = `
const s1 = sense("fs_multi_sense_1", "Sense 1", z.object({}), async function() { return { content: "1", hash: "" }; }, SupervisionLevel.auto);
registerSenses([s1]);
s1;
`;
    writeFileSync(join(sensesDir, "sense1.js"), sense1Code);

    const sense2Code = `
const s2 = sense("fs_multi_sense_2", "Sense 2", z.object({}), async function() { return { content: "2", hash: "" }; }, SupervisionLevel.auto);
registerSenses([s2]);
s2;
`;
    writeFileSync(join(sensesDir, "sense2.js"), sense2Code);

    await ensureCustomSensesLoaded();

    const sense1 = getSenses(["fs_multi_sense_1"]);
    const sense2 = getSenses(["fs_multi_sense_2"]);
    expect(sense1.length).toBe(1);
    expect(sense2.length).toBe(1);
  });
});