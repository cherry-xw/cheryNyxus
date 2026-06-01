export interface TestCase {
  input: Record<string, unknown>;
  output: { content: string; hash: string };
}

export interface CompiledToolInfo {
  compiledPath: string;
  sourcePath: string;
  testCases: TestCase[];
}

export interface ToolCompileFailure {
  sourcePath: string;
  fileName: string;
  type: "syntax" | "runtime-test";
  message: string;
}

export interface ToolCompileSummary {
  succeeded: CompiledToolInfo[];
  failed: ToolCompileFailure[];
}

export type ToolCompileEvent =
  | { type: "skipped"; fileName: string; sourcePath: string; compiledPath: string }
  | { type: "preprocessed"; fileName: string; sourcePath: string }
  | { type: "compiled"; fileName: string; sourcePath: string; compiledPath: string }
  | { type: "failed"; failure: ToolCompileFailure };

export interface ToolCompileOptions {
  onEvent?: (event: ToolCompileEvent) => void;
}
