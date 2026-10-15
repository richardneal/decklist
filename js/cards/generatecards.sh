#!/bin/sh
set -eu

# Build in a temporary directory so a failed download cannot remove live data.
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
build_dir=$(mktemp -d)
trap 'rm -rf "$build_dir"' EXIT HUP INT TERM
cd "$build_dir"
curl -fL --retry 3 https://mtgjson.com/api/v5/AtomicCards.json.zip -o AtomicCards.json.zip
curl -fL --retry 3 https://mtgjson.com/api/v5/SetList.json -o SetList.json
unzip -q AtomicCards.json.zip
python3 "$script_dir/parsecards.py"
terser decklist-cards.js --source-map "url='decklist-cards-min.js.map'" -o decklist-cards-min.js
cp decklist-cards-min.js decklist-cards-min.js.map "$script_dir/"
