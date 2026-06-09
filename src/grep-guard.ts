export type GrepPatternKind = "symbol" | "regex";

export interface GrepClassification {
  isRepoScan: boolean;
  patternKind: GrepPatternKind | null;
}

const GREP_HEAD_RE = /^(?:e|f)?grep$/;
const RECURSIVE_RE = /^(?:-[a-zA-Z]*[rR][a-zA-Z]*|--recursive)$/;
const SYMBOL_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function stripQuotes(token: string): string {
  if (token.length >= 2 && (token[0] === '"' || token[0] === "'") && token[token.length - 1] === token[0]) {
    return token.slice(1, -1);
  }
  return token;
}

export function classifyGrepCommand(command: string, probeDir: (p: string) => boolean): GrepClassification {
  const noScan: GrepClassification = { isRepoScan: false, patternKind: null };
  const firstSegment = command.split("|")[0]!.trim();
  const tokens = firstSegment.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return noScan;
  if (tokens[0] === "git") return noScan;
  if (!GREP_HEAD_RE.test(tokens[0]!)) return noScan;

  const rest = tokens.slice(1);
  if (rest.some((t) => t === "--help" || t === "--version" || t === "-V")) return noScan;

  let recursive = false;
  let pattern: string | null = null;
  const paths: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const tok = rest[i]!;
    if (tok === "-e" || tok === "--regexp") {
      const next = rest[++i];
      if (next !== undefined && pattern === null) pattern = stripQuotes(next);
      continue;
    }
    if (tok.startsWith("-")) {
      if (RECURSIVE_RE.test(tok)) recursive = true;
      continue;
    }
    if (pattern === null) { pattern = stripQuotes(tok); continue; }
    paths.push(stripQuotes(tok));
  }

  const scansDir = recursive || paths.some((p) => probeDir(p));
  if (!scansDir) return noScan;

  const patternKind: GrepPatternKind = pattern !== null && SYMBOL_RE.test(pattern) ? "symbol" : "regex";
  return { isRepoScan: true, patternKind };
}

export interface GrepActionInput {
  command: string;
  probeDir: (p: string) => boolean;
  rgAvailable: boolean;
  navigatorActive: boolean;
  /**
   * Optional pre-computed classification. When the caller has already run
   * `classifyGrepCommand` (e.g. to pre-filter before an rg probe), passing it
   * here avoids a second classify + duplicate `probeDir`/statSync calls.
   */
  classification?: GrepClassification;
}

export interface GrepAction {
  action: "allow" | "block";
  reason?: string;
  warn?: boolean;
}

export function decideGrepAction(input: GrepActionInput): GrepAction {
  const { isRepoScan, patternKind } =
    input.classification ?? classifyGrepCommand(input.command, input.probeDir);
  if (!isRepoScan) return { action: "allow" };
  if (!input.navigatorActive) return { action: "allow" };
  if (!input.rgAvailable) return { action: "allow", warn: true };

  const reason =
    patternKind === "symbol"
      ? "Slow repo-scanning grep is blocked. This looks like a symbol search — call `navigator_locate` for ranked entry points, or use `rg` for a raw scan."
      : "Slow repo-scanning grep is blocked. Use `rg` (ripgrep) — it is faster and gitignore-aware.";
  return { action: "block", reason };
}
