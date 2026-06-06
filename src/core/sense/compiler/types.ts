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

export type SenseCompileEvent =
  | { type: "skipped"; fileName: string; sourcePath: string; compiledPath: string }
  | { type: "preprocessed"; fileName: string; sourcePath: string }
  | { type: "compiled"; fileName: string; sourcePath: string; compiledPath: string }
  | { type: "failed"; failure: SenseCompileFailure };

export interface SenseCompileOptions {
  onEvent?: (event: SenseCompileEvent) => void;
}