/**
 * Shared types for the drift remediation pipeline.
 *
 * Used by both drift-report-collector.ts and fix-drift.ts.
 */

/**
 * NOTE: DriftSeverity is intentionally defined in multiple places:
 *   1. Here (drift-types.ts) — canonical source, used by the pipeline scripts
 *   2. src/__tests__/drift/schema.ts — used by the drift test framework (ShapeDiff)
 *   3. src/__tests__/drift-collector.test.ts — local copy for the test helper
 *
 * Deduplication would require importing across component boundaries.
 * If you add a new severity level, update all three locations.
 */
export type DriftSeverity = "critical" | "warning" | "info";

export interface ParsedDiff {
  path: string;
  severity: DriftSeverity;
  issue: string;
  expected: string;
  real: string;
  mock: string;
}

export interface DriftEntry {
  provider: string;
  scenario: string;
  builderFile: string;
  builderFunctions: string[];
  typesFile: string | null;
  sdkShapesFile: string;
  diffs: ParsedDiff[];
}

export interface DriftReport {
  timestamp: string;
  entries: DriftEntry[];
}
