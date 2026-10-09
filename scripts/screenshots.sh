#!/usr/bin/env bash
# Regenerate docs/screenshot-*.png from a local demo (scripts/demo_local.sh) with headless Chrome.
set -euo pipefail
cd "$(dirname "$0")/.."
OUT=$(scripts/demo_local.sh); echo "$OUT"
eval "$(echo "$OUT" | grep -E '^(FACTORY|EN_OWNER|ZH_OWNER)=' | tr ' ' '\n')"
EN_JAR=$(echo "$OUT" | sed -n 's/.*EN_JAR=\(0x[0-9a-fA-F]*\).*/\1/p')
VITE_FACTORY_LOCAL=$FACTORY npx --prefix app vite build app --outDir /tmp/arcjars-shots --emptyOutDir >/dev/null
(cd /tmp/arcjars-shots && python3 -m http.server 5173 >/dev/null 2>&1 & echo $! > /tmp/arcjars-http.pid); sleep 1
B="http://localhost:5173/index.html?net=local"
CHROME=$(command -v google-chrome || command -v chromium)
shot() { "$CHROME" --headless=new --no-sandbox --disable-gpu --hide-scrollbars --force-device-scale-factor="$4" \
  --window-size="$2" --virtual-time-budget=8000 --screenshot="docs/$1.png" "$3" 2>/dev/null; }
shot screenshot-jars-en 1100,900 "$B&watch=$EN_OWNER&lang=en" 1
shot screenshot-jars-zh 1100,900 "$B&watch=$ZH_OWNER&lang=zh" 1
shot screenshot-create 1100,1080 "$B&lang=en#/create" 1
shot screenshot-pay 1100,800 "$B&lang=en&amount=250&memo=INV-2026-014#/pay/$EN_JAR" 1
shot screenshot-mobile 390,1000 "$B&lang=en&amount=250#/pay/$EN_JAR" 2
kill "$(cat /tmp/arcjars-http.pid)"
echo "screenshots written to docs/"
