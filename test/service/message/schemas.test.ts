import { describe, expect, it } from "vitest";
import { requestSchemas } from "@/service/message/schemas.js";
import { Method } from "@/service/message/types.js";

describe("service/message/requestSchemas", () => {
  it("covers every RPC method", () => {
    expect(Object.keys(requestSchemas).sort()).toEqual(Object.values(Method).sort());
  });

  it("requires strict empty params for utils.openConfigDir", () => {
    const schema = requestSchemas[Method.UTILS_OPEN_CONFIG_DIR];
    expect(schema.safeParse({}).success).toBe(true);
    expect(schema.safeParse({ path: ".chery" }).success).toBe(false);
  });
});
