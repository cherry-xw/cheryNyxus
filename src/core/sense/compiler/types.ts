export interface TestCase {
  input: Record<string, unknown>;
  output: { content: string; hash: string };
}

export interface CompiledSenseInfo {
  compiledPath: string;
  sourcePath: string;
  testCases: TestCase[];
}

export interface SenseCompileFailure {
  sourcePath: string;
  fileName: string;
  type: "syntax" | "runtime-test";
  message: string;
}

export interface SenseCompileSummary {
  succeeded: CompiledSenseInfo[];
  failed: SenseCompileFailure[];
}

