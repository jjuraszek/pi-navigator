import { Parser, Language } from "web-tree-sitter";
import type { Node } from "web-tree-sitter";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import type { Lang, SymbolRecord, ImportEdge } from "../types.ts";

// ---- Initialisation ----

let parserInitialized = false;
const parsers = new Map<Lang, Parser>();

const GRAMMAR_FILENAMES: Record<Lang, string> = {
  ruby: "tree-sitter-ruby.wasm",
  python: "tree-sitter-python.wasm",
  ts: "tree-sitter-typescript.wasm",
  js: "tree-sitter-javascript.wasm",
  // prose has no tree-sitter grammar; this entry satisfies the Record type.
  // prose files are excluded from initParsers/extractSymbols by the isSupported gate.
  prose: "",
};

function grammarPath(lang: Lang): string {
  const dir = fileURLToPath(new URL("../../grammars", import.meta.url));
  return join(dir, GRAMMAR_FILENAMES[lang]);
}

/**
 * Initialise web-tree-sitter (once) and load grammars for the given langs.
 * Idempotent: already-loaded langs are skipped.
 */
export async function initParsers(langs: Lang[]): Promise<void> {
  if (!parserInitialized) {
    await Parser.init();
    parserInitialized = true;
  }
  for (const lang of langs) {
    if (parsers.has(lang)) continue;
    const language = await Language.load(grammarPath(lang));
    const p = new Parser();
    p.setLanguage(language);
    parsers.set(lang, p);
  }
}

function getParser(lang: Lang): Parser {
  const p = parsers.get(lang);
  if (!p) throw new Error(`Parser not initialised for "${lang}". Call initParsers first.`);
  return p;
}

/** Filter nulls from namedChildren (web-tree-sitter types namedChildren as (Node|null)[]). */
function namedKids(node: Node): Node[] {
  return (node.namedChildren as (Node | null)[]).filter((c): c is Node => c !== null);
}

// ---- Symbol extraction ----

// Node type → symbol kind for all four languages.
// lexical_declaration (TS/JS const) is handled separately below.
const SYMBOL_KINDS: Record<string, SymbolRecord["kind"]> = {
  // Ruby
  class: "class",
  module: "module",
  method: "method",
  singleton_method: "method",
  // Python
  class_definition: "class",
  function_definition: "function",
  // TS / JS
  class_declaration: "class",
  function_declaration: "function",
  method_definition: "method",
};

function collectSymbols(node: Node, lang: Lang, out: SymbolRecord[]): void {
  // Handle const declarations in TS/JS (lexical_declaration where first token is "const")
  if (
    (lang === "ts" || lang === "js") &&
    node.type === "lexical_declaration" &&
    node.text.trimStart().startsWith("const ")
  ) {
    for (const child of namedKids(node)) {
      if (child.type !== "variable_declarator") continue;
      const name = child.childForFieldName("name")?.text;
      if (name) {
        out.push({
          name,
          kind: "const",
          start_line: child.startPosition.row,
          end_line: child.endPosition.row,
          start_byte: child.startIndex,
          end_byte: child.endIndex,
        });
      }
    }
    // Still recurse into children (fall through)
  }

  const kind = SYMBOL_KINDS[node.type];
  if (kind) {
    const name = node.childForFieldName("name")?.text;
    if (name) {
      out.push({
        name,
        kind,
        start_line: node.startPosition.row,
        end_line: node.endPosition.row,
        start_byte: node.startIndex,
        end_byte: node.endIndex,
      });
    }
  }

  for (const child of namedKids(node)) {
    collectSymbols(child, lang, out);
  }
}

export function extractSymbols(lang: Lang, source: string): SymbolRecord[] {
  const tree = getParser(lang).parse(source);
  if (!tree) return [];
  const out: SymbolRecord[] = [];
  collectSymbols(tree.rootNode, lang, out);
  return out;
}

// ---- Import extraction ----

/** Extract the bare string content from a string literal node. */
function stringText(node: Node, lang: Lang): string | null {
  const kids = namedKids(node);
  if (lang === "ruby") {
    // string → string_content child
    const sc = kids.find((c) => c.type === "string_content");
    if (sc) return sc.text;
  } else {
    // TS / JS: string → string_fragment child
    const sf = kids.find((c) => c.type === "string_fragment");
    if (sf) return sf.text;
  }
  // Fallback: strip surrounding quotes
  return node.text.replace(/^["'`]|["'`]$/g, "");
}

type RawImport = { toPathHint: string; kind: ImportEdge["kind"] };

function collectImports(node: Node, lang: Lang, out: RawImport[]): void {
  if (lang === "ruby") {
    if (node.type === "scope_resolution") {
      const full = node.text;
      if (/^[A-Z][A-Za-z0-9_:]*$/.test(full)) {
        out.push({ toPathHint: full, kind: "ruby_const" });
        return; // don't descend — children would double-emit
      }
    } else if (node.type === "constant") {
      out.push({ toPathHint: node.text, kind: "ruby_const" });
    } else if (node.type === "call") {
      const method = node.childForFieldName("method")?.text;
      if (method === "require" || method === "require_relative") {
        const argList = node.childForFieldName("arguments");
        if (argList) {
          for (const c of namedKids(argList)) {
            if (c.type === "string") {
              const hint = stringText(c, lang);
              if (hint) out.push({ toPathHint: hint, kind: method });
            }
          }
        }
      }
    }
  } else if (lang === "python") {
    if (node.type === "import_statement") {
      // import os / import os, sys → dotted_name children are the modules
      for (const c of namedKids(node)) {
        if (c.type === "dotted_name") {
          out.push({ toPathHint: c.text, kind: "import" });
        }
      }
    } else if (node.type === "import_from_statement") {
      // from .grid_sync import Sync → first named child is relative_import or dotted_name
      const kids = namedKids(node);
      const first = kids[0];
      if (!first) return;
      if (first.type === "relative_import") {
        // from .grid_sync → relative_import → dotted_name child
        const dn = namedKids(first).find((c) => c.type === "dotted_name");
        if (dn != null) {
          out.push({ toPathHint: dn.text, kind: "import" });
        } else {
          // "from . import x" — represent as "."
          out.push({ toPathHint: ".", kind: "import" });
        }
      } else if (first.type === "dotted_name") {
        out.push({ toPathHint: first.text, kind: "import" });
      }
    }
  } else if (lang === "ts" || lang === "js") {
    if (node.type === "import_statement") {
      // Find the string source node
      for (const c of namedKids(node)) {
        if (c.type === "string") {
          const hint = stringText(c, lang);
          if (hint) out.push({ toPathHint: hint, kind: "import" });
          break;
        }
      }
    } else if (node.type === "call_expression") {
      // require("./dep")
      const fn = node.childForFieldName("function");
      if (fn?.text === "require") {
        const args = node.childForFieldName("arguments");
        if (args) {
          for (const c of namedKids(args)) {
            if (c.type === "string") {
              const hint = stringText(c, lang);
              if (hint) out.push({ toPathHint: hint, kind: "require" });
            }
          }
        }
      }
    }
  }

  for (const child of namedKids(node)) {
    collectImports(child, lang, out);
  }
}

// ---- Comment + string-literal text extraction ----

/** String-literal node types per language (do not descend into these to avoid double-walking interpolation). */
const STRING_NODE_TYPES: Record<Lang, ReadonlySet<string>> = {
  ruby: new Set(["string"]),
  python: new Set(["string"]),
  ts: new Set(["string", "template_string"]),
  js: new Set(["string", "template_string"]),
  // prose has no tree-sitter grammar; never reached due to isSupported gate.
  prose: new Set(),
};

function collectText(node: Node, lang: Lang, out: string[]): void {
  if (node.type === "comment") {
    out.push(node.text);
    return; // comments have no meaningful named children
  }
  if (STRING_NODE_TYPES[lang].has(node.type)) {
    out.push(node.text);
    return; // do not descend — avoids double-walking interpolation fragments
  }
  for (const child of namedKids(node)) {
    collectText(child, lang, out);
  }
}

/**
 * Return raw text of all comment nodes and string-literal nodes in source.
 * Comment markers (#, //, /*) and quote characters act as natural delimiters
 * when the caller passes these strings through splitIdentifier/extractKeywords.
 * Never stores raw bytes in the DB — only the derived tokens matter.
 */
export function extractText(lang: Lang, source: string): string[] {
  const tree = getParser(lang).parse(source);
  if (!tree) return [];
  const out: string[] = [];
  collectText(tree.rootNode, lang, out);
  return out;
}

/**
 * Extract import edges from source.
 * Returns partial edges (toPathHint + kind); the caller (worker) attaches fromPath.
 */
export function extractImports(
  lang: Lang,
  source: string,
): { toPathHint: string; kind: ImportEdge["kind"] }[] {
  const tree = getParser(lang).parse(source);
  if (!tree) return [];
  const out: RawImport[] = [];
  collectImports(tree.rootNode, lang, out);
  return out;
}
