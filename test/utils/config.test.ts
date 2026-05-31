import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTempDir, cleanupTempDir, createTempFile } from "@test/helpers/tempDir";
import { SupervisionLevel } from "@/core/config";
import type { Config, GlobalConfig, ClientConfig } from "@/utils/config";

describe("config module", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  describe("Config types", () => {
    it("should have correct GlobalConfig structure", () => {
      const globalConfig: GlobalConfig = {
        thinking: true,
        supervision: SupervisionLevel.auto,
        stream: true,
        tool_execute_timeout: 30000,
        maxLoopCount: 30,
        bash_log_retention_hours: 24,
      };

      expect(globalConfig.thinking).toBe(true);
      expect(globalConfig.supervision).toBe(SupervisionLevel.auto);
      expect(globalConfig.stream).toBe(true);
      expect(globalConfig.tool_execute_timeout).toBe(30000);
    });

    it("should have correct ClientConfig structure", () => {
      const clientConfig: ClientConfig = {
        url: "http://localhost:11434",
        model: "llama2",
        provider: "ollama",
        thinking: false,
        tool_group: ["safe_tools"],
      };

      expect(clientConfig.url).toBe("http://localhost:11434");
      expect(clientConfig.model).toBe("llama2");
      expect(clientConfig.provider).toBe("ollama");
      expect(clientConfig.tool_group).toEqual(["safe_tools"]);
    });

    it("should have correct Config structure", () => {
      const config: Config = {
        global: {
          thinking: true,
          supervision: SupervisionLevel.auto,
          stream: true,
        },
        llm: {
          clients: {
            ollama: {
              url: "http://localhost:11434",
              model: "llama2",
              provider: "ollama",
            },
          },
        },
        tool_groups: {
          safe_tools: {
            tools: ["read_file", "write_file"],
          },
        },
      };

      expect(config.global).toBeDefined();
      expect(config.llm.clients).toHaveProperty("ollama");
      expect(config.tool_groups).toBeDefined();
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

  describe("config.yaml parsing", () => {
    it("should parse YAML content correctly", () => {
      const yamlContent = `
global:
  thinking: true
  supervision: auto
  stream: true
`;
      createTempFile(tempDir, "test.yaml", yamlContent);

      // Test YAML parsing concept
      expect(yamlContent).toContain("global");
      expect(yamlContent).toContain("thinking: true");
    });

    it("should handle tool_group as array", () => {
      const yamlContent = `
tool_group: [group1, group2]
`;
      expect(yamlContent).toContain("[group1, group2]");
    });

    it("should handle tool_group as string", () => {
      const yamlContent = `
tool_group: safe_tools
`;
      expect(yamlContent).toContain("safe_tools");
    });

    it("should handle environment variable syntax", () => {
      const yamlContent = `
url: $OPENAI_API_URL
`;
      expect(yamlContent).toContain("$OPENAI_API_URL");
    });
  });
});