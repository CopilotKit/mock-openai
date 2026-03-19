/// <reference types="node" />

/**
 * Drift Report Collector
 *
 * Runs the drift test suite via subprocess with JSON reporter, parses the
 * structured output, and writes a drift-report.json file that downstream
 * scripts can use to construct auto-fix prompts.
 *
 * Exit codes:
 *   0 — no critical diffs found (or no drift at all)
 *   2 — at least one critical diff exists
 *   1 — script error (unhandled exception)
 *
 * Usage:
 *   npx tsx scripts/drift-report-collector.ts [--out drift-report.json]
 */

import { execSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

import type { DriftEntry, DriftReport, DriftSeverity, ParsedDiff } from "./drift-types.js";

// ---------------------------------------------------------------------------
// Vitest JSON reporter types (subset we care about)
// ---------------------------------------------------------------------------

interface VitestJsonResult {
  testResults: VitestTestFile[];
}

interface VitestTestFile {
  assertionResults: VitestAssertion[];
}

interface VitestAssertion {
  status: string;
  ancestorTitles: string[];
  title: string;
  failureMessages: string[];
}

// ---------------------------------------------------------------------------
// Provider → file mapping
// ---------------------------------------------------------------------------

interface ProviderMapping {
  builderFile: string;
  builderFunctions: string[];
  typesFile: string | null;
}

const OPENAI_CHAT_MAPPING: ProviderMapping = {
  builderFile: "src/helpers.ts",
  builderFunctions: [
    "buildTextCompletion",
    "buildToolCallCompletion",
    "buildTextChunks",
    "buildToolCallChunks",
  ],
  typesFile: "src/types.ts",
};

const OPENAI_RESPONSES_MAPPING: ProviderMapping = {
  builderFile: "src/responses.ts",
  builderFunctions: [
    "buildTextResponse",
    "buildToolCallResponse",
    "buildTextStreamEvents",
    "buildToolCallStreamEvents",
  ],
  typesFile: null,
};

const ANTHROPIC_MAPPING: ProviderMapping = {
  builderFile: "src/messages.ts",
  builderFunctions: [
    "buildClaudeTextResponse",
    "buildClaudeToolCallResponse",
    "buildClaudeTextStreamEvents",
    "buildClaudeToolCallStreamEvents",
  ],
  typesFile: null,
};

const GEMINI_MAPPING: ProviderMapping = {
  builderFile: "src/gemini.ts",
  builderFunctions: [
    "buildGeminiTextResponse",
    "buildGeminiToolCallResponse",
    "buildGeminiTextStreamChunks",
    "buildGeminiToolCallStreamChunks",
  ],
  typesFile: null,
};

/**
 * Maps provider names (from drift test describe blocks) to source files
 * and builder function names. The function names are builder functions for
 * each provider (internal or exported) — they are included so Claude Code
 * can locate them via Read/Grep.
 */
const PROVIDER_MAP: Record<string, ProviderMapping> = {
  "OpenAI Chat": OPENAI_CHAT_MAPPING,
  "OpenAI Responses": OPENAI_RESPONSES_MAPPING,
  Anthropic: ANTHROPIC_MAPPING,
  "Anthropic Claude": ANTHROPIC_MAPPING,
  "Google Gemini": GEMINI_MAPPING,
  Gemini: GEMINI_MAPPING,
  "OpenAI Realtime": {
    builderFile: "src/ws-realtime.ts",
    builderFunctions: ["handleWebSocketRealtime", "realtimeItemsToMessages"],
    typesFile: null,
  },
  "OpenAI Responses WS": {
    builderFile: "src/ws-responses.ts",
    builderFunctions: ["handleWebSocketResponses"],
    typesFile: null,
  },
  "Gemini Live": {
    builderFile: "src/ws-gemini-live.ts",
    builderFunctions: ["handleWebSocketGeminiLive"],
    typesFile: null,
  },
};

const SDK_SHAPES_FILE = "src/__tests__/drift/sdk-shapes.ts";

// ---------------------------------------------------------------------------
// Parse the formatted drift report text from a vitest failure message
// ---------------------------------------------------------------------------

/**
 * Parse a drift report block from raw vitest failure message content.
 *
 * The input is a raw vitest failureMessages string that may contain error boilerplate.
 * The function scans for the API DRIFT DETECTED header and numbered entries.
 *
 * Expected format within the message (produced by formatDriftReport):
 * ```
 * API DRIFT DETECTED: OpenAI Chat (non-streaming text)
 *
 *   1. [critical] LLMOCK DRIFT — field in SDK + real API but missing from mock
 *      Path:    choices[0].message.refusal
 *      SDK:     null
 *      Real:    null
 *      Mock:    <absent>
 * ```
 */
const VALID_SEVERITIES = new Set<DriftSeverity>(["critical", "warning", "info"]);

function parseDriftBlock(text: string): { context: string; diffs: ParsedDiff[] } | null {
  const headerMatch = text.match(/API DRIFT DETECTED:\s*(.+)/);
  if (!headerMatch) return null;

  const context = headerMatch[1].trim();
  const diffs: ParsedDiff[] = [];

  // Match numbered entries: "  1. [severity] issue text\n     Path:...\n     SDK:...\n     Real:...\n     Mock:..."
  const entryPattern =
    /\d+\.\s*\[(\w+)\]\s*(.+)\n\s*Path:\s*(.+)\n\s*SDK:\s*(.+)\n\s*Real:\s*(.+)\n\s*Mock:\s*(.+)/g;

  let match: RegExpExecArray | null;
  while ((match = entryPattern.exec(text)) !== null) {
    const severity = match[1].trim();
    if (!VALID_SEVERITIES.has(severity as DriftSeverity)) {
      console.warn(
        `parseDriftBlock: unknown severity "${severity}" — skipping entry. ` +
          `Known severities: ${[...VALID_SEVERITIES].join(", ")}`,
      );
      continue;
    }
    diffs.push({
      severity: severity as DriftSeverity,
      issue: match[2].trim(),
      path: match[3].trim(),
      expected: match[4].trim(),
      real: match[5].trim(),
      mock: match[6].trim(),
    });
  }

  const expectedCount = (text.match(/\d+\.\s*\[/g) ?? []).length;
  if (expectedCount > 0 && diffs.length < expectedCount) {
    console.warn(`parseDriftBlock: parsed ${diffs.length} of ${expectedCount} entries`);
  }

  return { context, diffs };
}

/**
 * Extract provider name from the describe block title or the drift report context.
 *
 * Examples:
 *   "OpenAI Chat Completions drift" → "OpenAI Chat"
 *   "OpenAI Chat (non-streaming text)" → "OpenAI Chat"
 *   "Anthropic Claude drift" → "Anthropic Claude"
 */
function extractProviderName(text: string): string | null {
  // Try matching against known provider keys (longest first to avoid partial matches)
  const sorted = Object.keys(PROVIDER_MAP).sort((a, b) => b.length - a.length);
  for (const key of sorted) {
    if (text.includes(key)) return key;
  }
  return null;
}

/**
 * Extract scenario from the context string.
 *
 * "OpenAI Chat (non-streaming text)" → "non-streaming text"
 * "Anthropic Claude (streaming tool call)" → "streaming tool call"
 */
function extractScenario(context: string): string {
  const parenMatch = context.match(/\(([^)]+)\)/);
  return parenMatch ? parenMatch[1] : context;
}

// ---------------------------------------------------------------------------
// Run drift tests and collect results
// ---------------------------------------------------------------------------

function extractJsonFromString(text: string): VitestJsonResult | null {
  const jsonStart = text.indexOf("{");
  const jsonEnd = text.lastIndexOf("}");
  if (jsonStart === -1 || jsonEnd === -1) return null;
  try {
    const parsed = JSON.parse(text.slice(jsonStart, jsonEnd + 1)) as unknown;
    if (
      !parsed ||
      typeof parsed !== "object" ||
      !Array.isArray((parsed as Record<string, unknown>).testResults)
    ) {
      console.error(
        "extractJsonFromString: parsed JSON does not have testResults array, likely wrong fragment",
      );
      return null;
    }
    return parsed as VitestJsonResult;
  } catch (err: unknown) {
    console.error(
      "extractJsonFromString: failed to parse.",
      `Range: [${jsonStart}..${jsonEnd}], length: ${text.length}`,
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}

function hasStdout(err: unknown): err is { stdout: string; stderr?: string } {
  return (
    typeof err === "object" &&
    err !== null &&
    "stdout" in err &&
    typeof (err as { stdout: unknown }).stdout === "string"
  );
}

function parseVitestOutput(stdout: string, context: string): VitestJsonResult | null {
  try {
    return JSON.parse(stdout) as VitestJsonResult;
  } catch (parseErr: unknown) {
    console.error(
      `${context}:`,
      parseErr instanceof Error ? parseErr.message : String(parseErr),
      `stdout length: ${stdout.length}`,
    );
    return extractJsonFromString(stdout);
  }
}

function runDriftTests(): VitestJsonResult {
  try {
    const stdout = execSync("pnpm test:drift --reporter=json", {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      maxBuffer: 50 * 1024 * 1024,
    });
    const result = parseVitestOutput(stdout, "JSON parse of successful vitest run failed");
    if (result) return result;
    throw new Error("Drift tests passed but produced unparseable output");
  } catch (err: unknown) {
    // execSync throws on non-zero exit — vitest exits 1 when tests fail
    if (hasStdout(err)) {
      const result = parseVitestOutput(err.stdout, "Primary JSON parse of vitest stdout failed");
      if (result) return result;
      console.error(
        "Failed to parse JSON from drift test stdout. Original error:",
        err instanceof Error ? err.message : String(err),
      );
      if (err.stderr) console.error("stderr:", err.stderr);
    }
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to run drift tests: ${msg}`);
  }
}

function collectDriftEntries(results: VitestJsonResult): DriftEntry[] {
  const entries: DriftEntry[] = [];
  const unmapped: string[] = [];
  let unparseable = 0;

  for (const file of results.testResults) {
    for (const assertion of file.assertionResults) {
      if (assertion.status !== "failed") continue;
      if (assertion.failureMessages.length === 0) continue;

      const fullMessage = assertion.failureMessages.join("\n");
      const parsed = parseDriftBlock(fullMessage);
      if (!parsed || parsed.diffs.length === 0) {
        unparseable++;
        continue;
      }

      // Determine provider from ancestor titles (describe block) or context
      const ancestorText = assertion.ancestorTitles.join(" ");
      const provider = extractProviderName(ancestorText) ?? extractProviderName(parsed.context);
      if (!provider) {
        unmapped.push(`${ancestorText} > ${assertion.title}`);
        continue;
      }

      const mapping = PROVIDER_MAP[provider];
      if (!mapping) {
        unmapped.push(`${ancestorText} > ${assertion.title} (provider: ${provider})`);
        continue;
      }

      entries.push({
        provider,
        scenario: extractScenario(parsed.context),
        builderFile: mapping.builderFile,
        builderFunctions: mapping.builderFunctions,
        typesFile: mapping.typesFile,
        sdkShapesFile: SDK_SHAPES_FILE,
        diffs: parsed.diffs,
      });
    }
  }

  if (unmapped.length > 0) {
    console.error(`ERROR: ${unmapped.length} drift failure(s) could not be mapped to a provider:`);
    for (const u of unmapped) console.error(`  - ${u}`);
    throw new Error(`${unmapped.length} unmapped drift entries — update PROVIDER_MAP`);
  }

  if (unparseable > 0 && entries.length === 0) {
    console.error(
      `ERROR: ${unparseable} test failure(s) could not be parsed as drift reports.`,
      "This may indicate broken test infrastructure or a changed report format.",
    );
    throw new Error(`${unparseable} unparseable test failures with 0 drift entries — investigate`);
  } else if (unparseable > 0) {
    console.warn(
      `WARNING: ${unparseable} test failure(s) did not contain parseable drift data (${entries.length} drift entries collected).`,
    );
  }

  return entries;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(): void {
  const args = process.argv.slice(2);
  const outIndex = args.indexOf("--out");
  const outPath = resolve(
    outIndex !== -1 && args[outIndex + 1] ? args[outIndex + 1] : "drift-report.json",
  );

  console.log("Running drift tests...");
  const results = runDriftTests();

  console.log("Collecting drift entries...");
  const entries = collectDriftEntries(results);

  const report: DriftReport = {
    timestamp: new Date().toISOString(),
    entries,
  };

  try {
    writeFileSync(outPath, JSON.stringify(report, null, 2) + "\n", "utf-8");
  } catch (err) {
    console.error(`Failed to write drift report to ${outPath}:`, err);
    console.log(JSON.stringify(report, null, 2));
    process.exit(1);
  }
  console.log(`Drift report written to ${outPath}`);
  console.log(`  Entries: ${entries.length}`);

  const criticalCount = entries.reduce(
    (sum, e) => sum + e.diffs.filter((d) => d.severity === "critical").length,
    0,
  );
  console.log(`  Critical diffs: ${criticalCount}`);

  if (criticalCount > 0) {
    console.log("Exiting with code 2 (critical diffs found).");
    process.exit(2);
  }

  console.log("No critical diffs found.");
}

try {
  main();
} catch (err: unknown) {
  console.error("Fatal error:", err);
  process.exit(1);
}
