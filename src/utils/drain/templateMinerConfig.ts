export interface TemplateMinerOptions {
  drainSimTh?: number;
  drainDepth?: number;
  drainMaxChildren?: number;
  drainMaxClusters?: number | null;
  drainExtraDelimiters?: string[];
  parametrizeNumericTokens?: boolean;
  snapshotIntervalMinutes?: number;
  snapshotCompressState?: boolean;
}

export class TemplateMinerConfig {
  drainSimTh: number;
  drainDepth: number;
  drainMaxChildren: number;
  drainMaxClusters: number | null;
  drainExtraDelimiters: string[];
  parametrizeNumericTokens: boolean;
  snapshotIntervalMinutes: number;
  snapshotCompressState: boolean;

  /**
   * Creates a template miner configuration with sane defaults.
   *
   * @param options Optional configuration overrides.
   */
  constructor(options: TemplateMinerOptions = {}) {
    this.drainSimTh = options.drainSimTh ?? 0.4;
    this.drainDepth = options.drainDepth ?? 4;
    this.drainMaxChildren = options.drainMaxChildren ?? 100;
    this.drainMaxClusters = options.drainMaxClusters ?? null;
    this.drainExtraDelimiters = options.drainExtraDelimiters ?? [];
    this.parametrizeNumericTokens = options.parametrizeNumericTokens ?? true;
    this.snapshotIntervalMinutes = options.snapshotIntervalMinutes ?? 1;
    this.snapshotCompressState = options.snapshotCompressState ?? true;
  }

  /**
   * Builds a configuration instance from a plain JavaScript object.
   *
   * Invalid or missing fields fall back to the class defaults.
   *
   * @param obj Source object containing raw configuration values.
   * @returns A validated configuration instance.
   */
  static fromObject(obj: Record<string, unknown>): TemplateMinerConfig {
    const asNumber = (value: unknown): number | undefined => {
      if (typeof value === "number" && Number.isFinite(value)) {
        return value;
      }
      return undefined;
    };

    const asBoolean = (value: unknown): boolean | undefined =>
      typeof value === "boolean" ? value : undefined;

    const asStringArray = (value: unknown): string[] | undefined => {
      if (!Array.isArray(value)) {
        return undefined;
      }

      return value.every((item) => typeof item === "string")
        ? (value as string[])
        : undefined;
    };

    return new TemplateMinerConfig({
      drainSimTh: asNumber(obj.drainSimTh),
      drainDepth: asNumber(obj.drainDepth),
      drainMaxChildren: asNumber(obj.drainMaxChildren),
      drainMaxClusters:
        obj.drainMaxClusters === null ? null : asNumber(obj.drainMaxClusters),
      drainExtraDelimiters: asStringArray(obj.drainExtraDelimiters),
      parametrizeNumericTokens: asBoolean(obj.parametrizeNumericTokens),
      snapshotIntervalMinutes: asNumber(obj.snapshotIntervalMinutes),
      snapshotCompressState: asBoolean(obj.snapshotCompressState),
    });
  }
}