#!/usr/bin/env bash
# usage: scripts/stills.sh <lang HE|EN> <scene> <frame...>   -> out/stills/<lang>-<scene>-<frame>.png
set -e
cd "$(dirname "$0")/.."
L=$1; S=$2; shift 2
for f in "$@"; do
  npx remotion still src/index.ts "$L-$S" "out/stills/$L-$S-$f.png" --frame=$f 2>&1 | grep -iE "error|fail" || true
done
