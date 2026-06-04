import type { QueryType, SearchTool } from "./types.ts";

const TOOL_PATTERNS: { tool: SearchTool; re: RegExp }[] = [
  { tool: "git-grep", re: /(?:^|\|)\s*git\s+grep\s+(.+)$/ },
  { tool: "rg", re: /(?:^|\|)\s*rg\s+(.+)$/ },
  { tool: "grep", re: /(?:^|\|)\s*(?:e|f)?grep\s+(.+)$/ },
  { tool: "fd", re: /(?:^|\|)\s*fd(?:find)?\s+(.+)$/ },
  { tool: "ag", re: /(?:^|\|)\s*ag\s+(.+)$/ },
  { tool: "ack", re: /(?:^|\|)\s*ack\s+(.+)$/ },
  { tool: "find", re: /(?:^|\|)\s*find\s+(.+)$/ },
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

export function detectSearch(command: string): { tool: SearchTool; pattern: string } | null {
  for (const { tool, re } of TOOL_PATTERNS) {
    const m = command.match(re);
    if (m) {
      const pattern = extractPattern(tool, m[1]);
      if (pattern !== null) return { tool, pattern };
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
