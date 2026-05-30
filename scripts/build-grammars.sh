#!/usr/bin/env bash
# Copies pre-built .wasm grammars shipped by each tree-sitter-<lang> package.
# To recompile from source instead: replace the cp with:
#   npx tree-sitter build --wasm "node_modules/$pkg" -o "$out/$pkg.wasm"
set -euo pipefail
out="grammars"
mkdir -p "$out"
for lang in ruby python typescript javascript; do
  pkg="tree-sitter-$lang"
  src="node_modules/$pkg/tree-sitter-$lang.wasm"
  echo "copying $src → $out/$pkg.wasm"
  cp "$src" "$out/$pkg.wasm"
done
echo "done: $(ls -1 $out/*.wasm)"
