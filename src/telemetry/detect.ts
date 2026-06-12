import type { QueryType, SearchTool } from "./types.ts";

const TOOL_PATTERNS: { tool: SearchTool; re: RegExp }[] = [
  { tool: "git-grep", re: /^\s*git\s+grep\s+(.+)$/ },
  { tool: "rg", re: /^\s*rg\s+(.+)$/ },
  { tool: "grep", re: /^\s*(?:e|f)?grep\s+(.+)$/ },
  { tool: "fd", re: /^\s*fd(?:find)?\s+(.+)$/ },
  { tool: "ag", re: /^\s*ag\s+(.+)$/ },
  { tool: "ack", re: /^\s*ack\s+(.+)$/ },
  { tool: "find", re: /^\s*find\s+(.+)$/ },
];

function unquote(t: string): string {
  return t.replace(/^['"]|['"]$/g, "");
}

function extractPattern(tool: SearchTool, rest: string): string | null {
  const toks = rest.match(/'[^']*'|"[^"]*"|\S+/g) ?? [];
  if (tool === "find") {
    for (let i = 0; i < toks.length - 1; i++) {
      if (/^-(i?name|path)$/.test(toks[i])) return unquote(toks[i + 1]);
    }
    return null;
  }
  for (const t of toks) {
    if (t.startsWith("-")) continue;
    return unquote(t);
  }
  return null;
}

interface Segment {
  text: string;
  // true when this segment was reached via a single `|` (pipe-downstream = filter, not a search)
  piped: boolean;
}

/**
 * Split a shell command string into segments on unquoted &&, ||, ;, |, newlines.
 * Quoted regions (single or double quotes) are treated as opaque.
 * Each segment carries a `piped` flag: true only when preceded by a single `|`.
 * Pipe-downstream segments are filters (e.g. `grep` in `ls | grep foo`);
 * they must not be classified as standalone searches.
 * Best-effort: tracks quote state but not backslash-escaped quotes; a \" inside a
 * double-quoted region ends it early. Acceptable - the detector biases to allow and
 * such patterns are rare. grep-guard.ts splitCommandSegments has the same limitation.
 */
function splitSegments(command: string): Segment[] {
  const segments: Segment[] = [];
  let seg = "";
  let pipedInto = false;
  let inSingle = false;
  let inDouble = false;
  let i = 0;

  const flush = (nextPiped: boolean) => {
    if (seg.trim().length > 0) segments.push({ text: seg, piped: pipedInto });
    seg = "";
    pipedInto = nextPiped;
  };

  while (i < command.length) {
    const ch = command[i];

    if (inSingle) {
      seg += ch;
      if (ch === "'") inSingle = false;
      i++;
      continue;
    }

    if (inDouble) {
      seg += ch;
      if (ch === '"') inDouble = false;
      i++;
      continue;
    }

    if (ch === "'") {
      inSingle = true;
      seg += ch;
      i++;
      continue;
    }

    if (ch === '"') {
      inDouble = true;
      seg += ch;
      i++;
      continue;
    }

    // && and || are control operators - next segment is not pipe-downstream
    if ((ch === "&" && command[i + 1] === "&") || (ch === "|" && command[i + 1] === "|")) {
      flush(false);
      i += 2;
      continue;
    }

    if (ch === ";" || ch === "\n") {
      flush(false);
      i++;
      continue;
    }

    // single `|` - next segment is pipe-downstream (a filter)
    if (ch === "|") {
      flush(true);
      i++;
      continue;
    }

    seg += ch;
    i++;
  }

  if (seg.trim().length > 0) segments.push({ text: seg, piped: pipedInto });
  return segments;
}

export function detectSearch(command: string): { tool: SearchTool; pattern: string } | null {
  for (const segment of splitSegments(command)) {
    // skip pipe-downstream segments - they are output filters, not searches
    if (segment.piped) continue;
    for (const { tool, re } of TOOL_PATTERNS) {
      const m = segment.text.match(re);
      if (m) {
        const pattern = extractPattern(tool, m[1]);
        if (pattern !== null) return { tool, pattern };
      }
    }
  }
  return null;
}

export function classifyQuery(query: string): { type: QueryType; tokenCount: number } {
  const tokens = query.trim().split(/\s+/).filter((t) => t.length > 0);
  const tokenCount = tokens.length;
  if (tokenCount === 0) return { type: "open-ended", tokenCount: 0 };
  if (tokenCount === 1) {
    const t = tokens[0];
    const identifierLike = /^[A-Za-z_][A-Za-z0-9_]*$/.test(t) || /[.:]/.test(t);
    return { type: identifierLike ? "identifier" : "open-ended", tokenCount };
  }
  if (tokenCount <= 3) return { type: "keyword", tokenCount };
  return { type: "open-ended", tokenCount };
}
