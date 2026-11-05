#!/usr/bin/env bash
# Copies the refine engine and the built-in prompts from a checkout of
# Lumiverse Auto Refine into engine/. Text is copied as it is. Nothing is run.
#
# Usage: bash tools/vendor.sh /path/to/Lumiverse-Auto-Refine
set -euo pipefail
src="${1:?give the path to a Lumiverse-Auto-Refine checkout}"
here="$(cd "$(dirname "$0")/.." && pwd)"
back="$src/dist/backend.js"
front="$src/dist/frontend.js"
ver="$(grep -m1 -oE '"version": *"[^"]+"' "$src/spindle.json" | grep -oE '[0-9][^"]*')"
commit="$(git -C "$src" rev-parse --short HEAD 2>/dev/null || echo unknown)"

line_of() { grep -nE "$1" "$front" | head -1 | cut -d: -f1; }

{
  echo "// Copied from Lumiverse Auto Refine $ver ($commit), dist/backend.js, by tools/vendor.sh."
  echo "// Do not edit by hand. The only change is the wrapper function, which hands the"
  echo "// engine the SillyTavern adapter in place of Lumiverse's spindle object."
  echo "// Licensed under the GNU General Public License v3.0."
  echo "export const ENGINE_VERSION = '$ver';"
  echo "export function startEngine(spindle) {"
  cat "$back"
  echo "}"
} > "$here/engine/backend.js"

a="$(line_of '^const JUDGE_CHECKS = \[')"
b="$(line_of '^const CARET_OPEN = ')"
c="$(line_of '^const MACROS = \[')"
d="$(line_of '^const TURN_MACRO = ')"
e="$(line_of '^const SCENE_BLOCKS = \[')"
f="$(line_of '^const BUILT_IN_PROMPTS = \[')"
g="$(awk -v s="$f" 'NR>s && /^\];/ {print NR; exit}' "$front")"
for n in "$a" "$b" "$c" "$d" "$e" "$f" "$g"; do [ -n "$n" ] || { echo "a section was not found in $front" >&2; exit 1; }; done

{
  echo "// Copied from Lumiverse Auto Refine $ver ($commit), dist/frontend.js, by tools/vendor.sh."
  echo "// The built-in prompts, checks and notes, as text. Do not edit by hand."
  echo "// Licensed under the GNU General Public License v3.0."
  sed -n "${a},$((b-1))p" "$front"
  sed -n "${c},$((d-1))p" "$front"
  sed -n "${e},${g}p" "$front"
  echo "export {"
  echo "  JUDGE_CHECKS, MORE_CHECKS, BEFORE_CHECKS, WORN_CHECK, FOUND_LEAD, PROTECT_NOTE,"
  echo "  ASK_NOTE_REFUSED, ASK_NOTE_SOFTENED, ASK_NOTE_EMPTY, ASK_NOTE_BROKEN,"
  echo "  MACROS, DEFAULT_BLOCKS, YOURS_DEFAULT, BUILT_IN_PROMPTS,"
  echo "};"
} > "$here/engine/prompts.js"
echo "engine/ written from Lumiverse Auto Refine $ver ($commit)"
