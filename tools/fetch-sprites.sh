#!/bin/bash
# Re-download the Pokemon overworld sprites. They are NOT in git: the art is
# Pokemon-derived, PokeClaude is localhost-only, and 18MB of third-party PNGs has no
# business in a repo. This restores them in one step.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p art-src && cd art-src
if [ ! -d pokemon/overworld ]; then
  echo "downloading veekun overworld pack…"
  curl -fsSL -o overworld.tar.gz https://veekun.com/static/pokedex/downloads/overworld.tar.gz
  tar xzf overworld.tar.gz
fi
cd ..
mkdir -p public/art/pokemon
for d in down up left right; do
  rm -rf "public/art/pokemon/$d"
  cp -R "art-src/pokemon/overworld/$d" "public/art/pokemon/$d"
done
echo "installed $(find public/art/pokemon -name '*.png' | wc -l | tr -d ' ') sprite files"
