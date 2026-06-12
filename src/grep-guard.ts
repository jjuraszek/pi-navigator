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

// Split on unquoted |, ;, &&, ||, \n, and lift $(...)/backtick bodies as sub-segments,
// so flags from a following statement (e.g. `ls -R`) never leak into the grep classification.
// Best-effort: tracks quote state but not backslash-escaped quotes; a \" inside a
// double-quoted region ends it early. Acceptable - the guard biases to allow and such
// patterns are rare. detect.ts splitSegments has the same limitation.
function splitCommandSegments(command: string): string[] {
  const segments: string[] = [];
  let seg = "";
  let inSingle = false;
  let inDouble = false;
  let i = 0;
  const push = () => { if (seg.trim().length > 0) segments.push(seg); seg = ""; };
  while (i < command.length) {
    const ch = command[i]!;
    if (inSingle) { seg += ch; if (ch === "'") inSingle = false; i++; continue; }
    if (inDouble) { seg += ch; if (ch === '"') inDouble = false; i++; continue; }
    if (ch === "'") { inSingle = true; seg += ch; i++; continue; }
    if (ch === '"') { inDouble = true; seg += ch; i++; continue; }
    if (ch === "$" && command[i + 1] === "(") {
      // recurse into $(...) body so inner grep commands are classified independently
      let depth = 1; let inner = ""; i += 2;
      while (i < command.length && depth > 0) {
        const c = command[i]!;
        if (c === "(") depth++;
        else if (c === ")") { depth--; if (depth === 0) { i++; break; } }
        inner += c; i++;
      }
      for (const s of splitCommandSegments(inner)) segments.push(s);
      continue;
    }
    if (ch === "`") {
      let inner = ""; i++;
      while (i < command.length && command[i] !== "`") { inner += command[i]!; i++; }
      i++;
      for (const s of splitCommandSegments(inner)) segments.push(s);
      continue;
    }
    if ((ch === "&" && command[i + 1] === "&") || (ch === "|" && command[i + 1] === "|")) { push(); i += 2; continue; }
    if (ch === ";" || ch === "|" || ch === "\n") { push(); i++; continue; }
    seg += ch; i++;
  }
  push();
  return segments;
}

function classifySingleGrep(segment: string, probeDir: (p: string) => boolean): GrepClassification {
  const noScan: GrepClassification = { isRepoScan: false, patternKind: null };
  const tokens = segment.trim().split(/\s+/).filter(Boolean);
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

  // -r/-R is a scan only when it targets a dir or has no path args (GNU grep then recurses cwd).
  const scansDir = paths.some((p) => probeDir(p)) || (recursive && paths.length === 0);
  if (!scansDir) return noScan;

  const patternKind: GrepPatternKind = pattern !== null && SYMBOL_RE.test(pattern) ? "symbol" : "regex";
  return { isRepoScan: true, patternKind };
}

export function classifyGrepCommand(command: string, probeDir: (p: string) => boolean): GrepClassification {
  const noScan: GrepClassification = { isRepoScan: false, patternKind: null };
  for (const segment of splitCommandSegments(command)) {
    const result = classifySingleGrep(segment, probeDir);
    if (result.isRepoScan) return result;
  }
  return noScan;
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
