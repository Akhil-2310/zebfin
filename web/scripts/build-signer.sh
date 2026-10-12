#!/usr/bin/env bash
# Builds zebfin-signer-wasm and writes browser bindings to web/src/wasm/signer
# and the .wasm binary to web/public/signer/. Needs: rustup target
# wasm32-unknown-unknown, Homebrew llvm (C for secp256k1), wasm-bindgen-cli
# matching Cargo.lock.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
LLVM="${LLVM_PREFIX:-/opt/homebrew/opt/llvm}"

export CC_wasm32_unknown_unknown="$LLVM/bin/clang"
export AR_wasm32_unknown_unknown="$LLVM/bin/llvm-ar"
export RUSTFLAGS='--cfg getrandom_backend="wasm_js"'

cd "$ROOT/backend"
cargo build -p zebfin-signer-wasm --target wasm32-unknown-unknown --profile wasm-release
WASM="$ROOT/backend/target/wasm32-unknown-unknown/wasm-release/zebfin_signer_wasm.wasm"

# Generate into a temp dir and swap it in at the end, so a running dev server
# never sees a half-written module.
FINAL="$ROOT/web/src/wasm/signer"
OUT="$(mktemp -d)"
mkdir -p "$ROOT/web/public/signer" "$(dirname "$FINAL")"
wasm-bindgen "$WASM" --target web --out-dir "$OUT" --out-name zebfin_signer
mv "$OUT/zebfin_signer_bg.wasm" "$ROOT/web/public/signer/zebfin_signer_bg.wasm"
# We always pass the .wasm URL to init(); drop the bundler-resolved default so
# Turbopack doesn't look for the binary next to the glue code.
sed -i.bak "/new URL('zebfin_signer_bg.wasm', import.meta.url)/d" "$OUT/zebfin_signer.js" && rm "$OUT/zebfin_signer.js.bak"
rm -rf "$FINAL" && mv "$OUT" "$FINAL"

# Node build, for scripts/signer-check.ts
wasm-bindgen "$WASM" --target nodejs --out-dir "$ROOT/web/scripts/.signer-node" --out-name zebfin_signer

ls -la "$ROOT/web/public/signer/zebfin_signer_bg.wasm"
