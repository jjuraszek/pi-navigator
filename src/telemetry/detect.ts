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

/**
 * Split a shell command string into segments on unquoted &&, ||, ;, |, newlines.
 * Quoted regions (single or double quotes) are treated as opaque.
 * $(...) and heredocs are best-effort/opaque.
 */
function splitSegments(command: string): string[] {
  const segments: string[] = [];
  let seg = "";
  let inSingle = false;
  let inDouble = false;
  let i = 0;

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

    // Check two-char operators before single-char |
    if ((ch === "&" && command[i + 1] === "&") || (ch === "|" && command[i + 1] === "|")) {
      segments.push(seg);
      seg = "";
      i += 2;
      continue;
    }

    if (ch === ";" || ch === "|" || ch === "\n") {
      segments.push(seg);
      seg = "";
      i++;
      continue;
    }

    seg += ch;
    i++;
  }

  if (seg.length > 0) segments.push(seg);
  return segments;
}

export function detectSearch(command: string): { tool: SearchTool; pattern: string } | null {
  for (const segment of splitSegments(command)) {
    for (const { tool, re } of TOOL_PATTERNS) {
      const m = segment.match(re);
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
