import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import type { NavigatorConfig } from "./types.ts";

interface NavigatorConfigInput extends Partial<NavigatorConfig> {
  injectPersona?: unknown;
  [key: string]: unknown;
}

export const DEFAULT_CONFIG: NavigatorConfig = {
  enabled: true,
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
  telemetry: false,
  telemetryStoreQueries: true,
  telemetryTurnCap: 10,
  telemetryRetentionDays: 30,
  persona: true,
  promptNudge: true,
  strongHitDirective: true,
  grepBlock: true,
};

export function mergeConfig(partial: NavigatorConfigInput): NavigatorConfig {
  return {
    enabled:
      typeof partial.enabled === "boolean"
        ? partial.enabled
        : DEFAULT_CONFIG.enabled,
    indexDir:
      typeof partial.indexDir === "string"
        ? partial.indexDir
        : DEFAULT_CONFIG.indexDir,
    languages:
      Array.isArray(partial.languages)
        ? partial.languages.filter(
          (lang): lang is NavigatorConfig["languages"][number] =>
            lang === "ruby" || lang === "python" || lang === "ts" || lang === "js" || lang === "prose",
        )
        : DEFAULT_CONFIG.languages,
    maxLocateResults:
      Number.isInteger(partial.maxLocateResults) && (partial.maxLocateResults as number) > 0
        ? (partial.maxLocateResults as number)
        : DEFAULT_CONFIG.maxLocateResults,
    indexBatchSize:
      Number.isInteger(partial.indexBatchSize) && (partial.indexBatchSize as number) > 0
        ? (partial.indexBatchSize as number)
        : DEFAULT_CONFIG.indexBatchSize,
    indexIdleMs:
      Number.isInteger(partial.indexIdleMs) && (partial.indexIdleMs as number) >= 0
        ? (partial.indexIdleMs as number)
        : DEFAULT_CONFIG.indexIdleMs,
    cochangeWindowDays:
      Number.isInteger(partial.cochangeWindowDays) && (partial.cochangeWindowDays as number) > 0
        ? (partial.cochangeWindowDays as number)
        : DEFAULT_CONFIG.cochangeWindowDays,
    cochangeMaxCommits:
      Number.isInteger(partial.cochangeMaxCommits) && (partial.cochangeMaxCommits as number) > 0
        ? (partial.cochangeMaxCommits as number)
        : DEFAULT_CONFIG.cochangeMaxCommits,
    cochangeMaxFilesPerCommit:
      Number.isInteger(partial.cochangeMaxFilesPerCommit) && (partial.cochangeMaxFilesPerCommit as number) > 0
        ? (partial.cochangeMaxFilesPerCommit as number)
        : DEFAULT_CONFIG.cochangeMaxFilesPerCommit,
    maxFileBytes:
      Number.isInteger(partial.maxFileBytes) && (partial.maxFileBytes as number) > 0
        ? (partial.maxFileBytes as number)
        : DEFAULT_CONFIG.maxFileBytes,
    keywordStoplist: Array.isArray(partial.keywordStoplist)
      ? partial.keywordStoplist.map((s) => String(s).toLowerCase())
      : DEFAULT_CONFIG.keywordStoplist,
    keywordMinLength:
      Number.isInteger(partial.keywordMinLength) && (partial.keywordMinLength as number) > 0
        ? (partial.keywordMinLength as number)
        : DEFAULT_CONFIG.keywordMinLength,
    telemetry:
      typeof partial.telemetry === "boolean"
        ? partial.telemetry
        : DEFAULT_CONFIG.telemetry,
    telemetryStoreQueries:
      typeof partial.telemetryStoreQueries === "boolean"
        ? partial.telemetryStoreQueries
        : DEFAULT_CONFIG.telemetryStoreQueries,
    telemetryTurnCap:
      Number.isInteger(partial.telemetryTurnCap) && (partial.telemetryTurnCap as number) > 0
        ? (partial.telemetryTurnCap as number)
        : DEFAULT_CONFIG.telemetryTurnCap,
    telemetryRetentionDays:
      Number.isInteger(partial.telemetryRetentionDays) && (partial.telemetryRetentionDays as number) > 0
        ? (partial.telemetryRetentionDays as number)
        : DEFAULT_CONFIG.telemetryRetentionDays,
    persona:
      typeof partial.persona === "boolean" ? partial.persona : DEFAULT_CONFIG.persona,
    promptNudge:
      typeof partial.promptNudge === "boolean" ? partial.promptNudge : DEFAULT_CONFIG.promptNudge,
    strongHitDirective:
      typeof partial.strongHitDirective === "boolean" ? partial.strongHitDirective : DEFAULT_CONFIG.strongHitDirective,
    grepBlock:
      typeof partial.grepBlock === "boolean" ? partial.grepBlock : DEFAULT_CONFIG.grepBlock,
  };
}

function agentDir(): string {
  return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

export function loadConfig(): NavigatorConfig {
  try {
    const raw = readFileSync(join(agentDir(), "settings.json"), "utf8");
    const settings = JSON.parse(raw) as { navigator?: NavigatorConfigInput };
    return mergeConfig(settings.navigator ?? {});
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}
