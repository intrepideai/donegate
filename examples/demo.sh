#!/usr/bin/env bash
# donegate demo — watch the gate catch an agent cheating, in ~30 seconds.
#
#   curl -fsSL https://raw.githubusercontent.com/intrepideai/donegate/main/examples/demo.sh | bash
#
# Creates a sandbox repo in a temp dir with a real bug, then plays three acts:
#   1. tests fail honestly            → NOT DONE (exit 1)
#   2. the failing test gets .skip'd  → tests green, guards catch it (exit 3)
#   3. the bug gets actually fixed    → DONE (exit 0)
#
# Override the donegate command with DONEGATE=... (defaults to npx donegate).
set -euo pipefail

DONEGATE="${DONEGATE:-npx -y donegate}"
DIR="$(mktemp -d)/donegate-demo"
mkdir -p "$DIR"
cd "$DIR"
echo "→ sandbox: $DIR"

git init -q -b main
git config user.email demo@donegate.dev
git config user.name "donegate demo"

cat > package.json <<'EOF'
{
  "name": "donegate-demo",
  "private": true,
  "scripts": { "test": "node --test" }
}
EOF

mkdir -p src test
cat > src/discount.js <<'EOF'
function applyDiscount(total, pct) {
  return total - total * (pct / 100);
}
module.exports = { applyDiscount };
EOF

cat > test/discount.test.js <<'EOF'
const { test } = require('node:test');
const assert = require('node:assert');
const { applyDiscount } = require('../src/discount.js');

test('applies a 10% discount', () => {
  assert.strictEqual(applyDiscount(100, 10), 90);
});

test('rejects discounts over 100%', () => {
  assert.throws(() => applyDiscount(100, 150));
});
EOF

git add -A && git commit -qm "initial"

$DONEGATE init >/dev/null
git add -A && git commit -qm "add DONE.md"
$DONEGATE baseline >/dev/null 2>&1 || true

bold() { printf '\n\033[1m%s\033[0m\n' "$1"; }

bold "ACT 1 — the work isn't done (a test genuinely fails)"
$DONEGATE check || true

bold "ACT 2 — the 'agent' skips the failing test instead of fixing the bug…"
node -e "
const fs = require('fs');
const f = 'test/discount.test.js';
fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace(\"test('rejects\", \"test.skip('rejects\"));
"
$DONEGATE check || true

bold "ACT 3 — fix the actual bug"
git checkout -q test/discount.test.js
cat > src/discount.js <<'EOF'
function applyDiscount(total, pct) {
  if (pct < 0 || pct > 100) {
    throw new RangeError(`discount must be 0-100, got ${pct}`);
  }
  return total - total * (pct / 100);
}
module.exports = { applyDiscount };
EOF
$DONEGATE check

bold "That's donegate. Receipts in .donegate/receipts/, sandbox in $DIR"
