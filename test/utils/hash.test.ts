import { describe, it, expect } from "vitest";
import { hashGenerator } from "@/utils/hash";

describe("hashGenerator", () => {
  it("should generate SHA256 hash with prefix and parts", () => {
    const result = hashGenerator("file", "/path/to/file", "1024", "1234567890");
    expect(result).toMatch(/^[a-f0-9]{64}$/);
  });

  it("should generate consistent hash for same inputs", () => {
    const result1 = hashGenerator("skill", "test-skill");
    const result2 = hashGenerator("skill", "test-skill");
    expect(result1).toBe(result2);
  });

  it("should generate different hash for different prefix", () => {
    const result1 = hashGenerator("prefix1", "data");
    const result2 = hashGenerator("prefix2", "data");
    expect(result1).not.toBe(result2);
  });

  it("should generate different hash for different parts", () => {
    const result1 = hashGenerator("file", "path1", "size1");
    const result2 = hashGenerator("file", "path2", "size1");
    expect(result1).not.toBe(result2);
  });

  it("should handle single prefix without parts", () => {
    const result = hashGenerator("only-prefix");
    expect(result).toMatch(/^[a-f0-9]{64}$/);
  });

  it("should handle empty string parts", () => {
    const result = hashGenerator("prefix", "", "data");
    expect(result).toMatch(/^[a-f0-9]{64}$/);
  });

  it("should handle special characters in parts", () => {
    const result = hashGenerator("file", "/path/with spaces/file.txt", "size");
    expect(result).toMatch(/^[a-f0-9]{64}$/);
  });

  it("should handle unicode characters", () => {
    const result = hashGenerator("prefix", "中文", "日本語");
    expect(result).toMatch(/^[a-f0-9]{64}$/);
  });

  it("should generate 64 character hex string", () => {
    const result = hashGenerator("test");
    expect(result.length).toBe(64);
    expect(result).toMatch(/^[a-f0-9]+$/);
  });

  it("should join multiple parts with colon", () => {
    const result1 = hashGenerator("prefix", "a", "b", "c");
    const result2 = hashGenerator("prefix", "a:b:c");
    expect(result1).toBe(result2); // Both generate "prefix::a:b:c"
  });
});