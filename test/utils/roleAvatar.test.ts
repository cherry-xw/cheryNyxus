import { describe, expect, it } from "vitest";
import { defaultRoleAvatar, resolveRoleAvatar, validateRoleAvatar } from "@/utils/roleAvatar.js";

describe("roleAvatar", () => {
  it("maps a role name to a stable built-in avatar", () => {
    expect(defaultRoleAvatar("reviewer")).toBe(defaultRoleAvatar("reviewer"));
    expect(defaultRoleAvatar("reviewer")).not.toBe("");
  });

  it("prefers an explicit avatar", () => {
    expect(resolveRoleAvatar("reviewer", "🧪")).toBe("🧪");
  });

  it("rejects blank, control and oversized values", () => {
    expect(validateRoleAvatar(" ")).toBeTruthy();
    expect(validateRoleAvatar("a\nb")).toBeTruthy();
    expect(validateRoleAvatar("x".repeat(25))).toBeTruthy();
    expect(validateRoleAvatar("🧙‍♀️")).toBeNull();
  });
});
