import type { Lang } from "../types.ts";

export const DEFAULT_STOPLISTS: Record<Lang, readonly string[]> = {
  ruby: [
    "def", "end", "class", "module", "if", "unless", "else", "elsif", "when", "case",
    "do", "yield", "self", "nil", "true", "false", "return", "require", "include",
    "extend", "attr_accessor", "attr_reader", "begin", "rescue", "ensure", "raise",
    "next", "break", "super", "freeze", "new",
  ],
  python: [
    "def", "class", "return", "if", "elif", "else", "for", "while", "in", "is",
    "not", "and", "or", "import", "from", "as", "with", "assert", "pass", "lambda",
    "yield", "self", "none", "true", "false", "raise", "try", "except", "finally",
    "del", "print", "len", "str", "int", "list", "dict",
  ],
  ts: [
    "function", "const", "let", "var", "return", "if", "else", "for", "while", "in",
    "of", "new", "this", "null", "undefined", "true", "false", "import", "export",
    "from", "as", "default", "class", "extends", "async", "await", "typeof", "instanceof",
  ],
  js: [
    "function", "const", "let", "var", "return", "if", "else", "for", "while", "in",
    "of", "new", "this", "null", "undefined", "true", "false", "import", "export",
    "from", "as", "default", "class", "extends", "async", "await", "typeof", "instanceof",
  ],
};

// Cross-language code-noise + English stopwords applied regardless of lang.
export const DEFAULT_CROSS_LANG_STOPLIST: readonly string[] = [
  "todo", "fixme", "xxx", "hack", "note", "deprecated", "tmp", "temp",
  "foo", "bar", "baz", "qux",
  "the", "a", "an", "and", "or", "of", "to", "in", "is", "it", "for",
  "on", "with", "as", "at", "by", "be", "this", "that", "not", "from",
];

export function buildStoplist(lang: Lang | null, extra: string[]): Set<string> {
  const set = new Set<string>();
  if (lang) for (const w of DEFAULT_STOPLISTS[lang]) set.add(w);
  for (const w of DEFAULT_CROSS_LANG_STOPLIST) set.add(w);
  for (const w of extra) set.add(w.toLowerCase());
  return set;
}

/** Split an identifier on camelCase / acronym / snake_case / kebab / dot boundaries; lowercased fragments. */
export function splitIdentifier(id: string): string[] {
  return id
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")      // camelCase boundary
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")   // acronym boundary: HTTPServer → HTTP Server
    .split(/[^A-Za-z0-9]+/)                        // snake/kebab/dot/space
    .map((s) => s.toLowerCase())
    .filter(Boolean);
}

const HEX_RE = /^[0-9a-f]{6,}$/i;
const NUM_RE = /^[0-9]+$/;
const URL_RE = /^[a-z]+:\/\//i;

function isJunk(tok: string, minLen: number): boolean {
  if (tok.length < minLen) return true;
  if (NUM_RE.test(tok)) return true;
  if (HEX_RE.test(tok)) return true;
  if (URL_RE.test(tok)) return true;
  return false;
}

/**
 * Given raw token strings (identifier names, comment words, selected literals),
 * split + filter + stoplist into the final deduped keyword list.
 */
export function extractKeywords(
  rawTokens: string[],
  stoplist: Set<string>,
  minLen: number,
): string[] {
  const out = new Set<string>();
  for (const raw of rawTokens) {
    // Check the raw token for URL scheme before splitting (splitting on :// would mangle it)
    if (URL_RE.test(raw)) continue;
    for (const frag of splitIdentifier(raw)) {
      if (isJunk(frag, minLen)) continue;
      if (stoplist.has(frag)) continue;
      out.add(frag);
    }
  }
  return Array.from(out);
}
