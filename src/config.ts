import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import type { NavigatorConfig } from "./types.ts";

export const DEFAULT_CONFIG: NavigatorConfig = {
  enabled: true,
  injectPersona: true,
  indexDir: join(homedir(), ".pi", "pi-navigator-cache"),
  languages: ["ruby", "python", "ts", "js"],
  maxLocateResults: 10,
  indexBatchSize: 50,
  indexIdleMs: 25,
  cochangeWindowDays: 180,
  cochangeMaxCommits: 4000,
  cochangeMaxFilesPerCommit: 50,
  maxFileBytes: 1048576,
  keywordStoplist: [],
  keywordMinLength: 3,
};

export function mergeConfig(partial: Partial<NavigatorConfig>): NavigatorConfig {
  const merged = { ...DEFAULT_CONFIG, ...partial };
  merged.keywordStoplist = Array.isArray(partial.keywordStoplist)
    ? partial.keywordStoplist.map((s) => String(s).toLowerCase())
    : DEFAULT_CONFIG.keywordStoplist;
  merged.keywordMinLength =
    Number.isInteger(partial.keywordMinLength) && (partial.keywordMinLength as number) > 0
      ? (partial.keywordMinLength as number)
      : DEFAULT_CONFIG.keywordMinLength;
  return merged;
}

function agentDir(): string {
  return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

export function loadConfig(): NavigatorConfig {
  try {
    const raw = readFileSync(join(agentDir(), "settings.json"), "utf8");
    const settings = JSON.parse(raw) as { navigator?: Partial<NavigatorConfig> };
    return mergeConfig(settings.navigator ?? {});
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}
