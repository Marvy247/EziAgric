#!/usr/bin/env bash
# deploy-contract-testnet.sh — Deploy (or upgrade) the escrow contract against
# Stellar testnet using an ISOLATED per-preview testnet account (issue #264).
#
# The admin key used here must never be a production/mainnet key — preview
# contract deploys get their own throwaway testnet account, funded from a
# testnet friendbot, rotated per docs/secrets-policy.md.
#
# Usage:
#   TESTNET_ADMIN_SECRET=S... ./scripts/deploy-contract-testnet.sh [--upgrade]
#   TESTNET_ADMIN_SECRET=S... ./scripts/deploy-contract-testnet.sh \
#       --token-contract <id> --treasury <pubkey>
#
# Required env:
#   TESTNET_ADMIN_SECRET   — isolated testnet admin secret key (S...)
# Optional env:
#   TESTNET_NETWORK        — soroban/stellar CLI network name (default: testnet)
#   TESTNET_TREASURY       — treasury pubkey (default: admin pubkey)
#   TESTNET_TOKEN_CONTRACT — cNGN token contract id on testnet
#
# Exit codes:
#   0 — deployed, contract id printed
#   1 — preflight/deploy failure
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

NETWORK="${TESTNET_NETWORK:-testnet}"
UPGRADE=false
TOKEN_CONTRACT="${TESTNET_TOKEN_CONTRACT:-}"
TREASURY="${TESTNET_TREASURY:-}"
FEE_BPS="${TESTNET_FEE_BPS:-100}"

for arg in "$@"; do
  case "$arg" in
    --upgrade)                  UPGRADE=true ;;
    --token-contract=*)         TOKEN_CONTRACT="${arg#*=}" ;;
    --treasury=*)               TREASURY="${arg#*=}" ;;
    --fee-bps=*)                FEE_BPS="${arg#*=}" ;;
    --network=*)                NETWORK="${arg#*=}" ;;
    *)
      echo "Unknown argument: $arg" >&2
      exit 1
      ;;
  esac
done

: "${TESTNET_ADMIN_SECRET:?TESTNET_ADMIN_SECRET is required (isolated testnet account)}"

if [[ "$NETWORK" == "standalone" ]]; then
  echo "❌ Use scripts/deploy-contract-local.sh for the local network." >&2
  exit 1
fi

if [[ "$TESTNET_ADMIN_SECRET" == S* && ${#TESTNET_ADMIN_SECRET} -eq 56 ]]; then
  echo "✓ Admin key looks like a Stellar secret key (length check only)."
else
  echo "❌ TESTNET_ADMIN_SECRET does not look like a Stellar secret key." >&2
  exit 1
fi

echo "[1/3] Running contract deployment safety gate..."
"$ROOT_DIR/scripts/check-contract-deployment-safety.sh"

CLI=""
if command -v stellar >/dev/null 2>&1; then
  CLI="stellar"
elif command -v soroban >/dev/null 2>&1; then
  CLI="soroban"
else
  echo "❌ Neither 'stellar' nor 'soroban' CLI found on PATH." >&2
  exit 1
fi

ADMIN_PUBKEY=$("$CLI" keys address --network "$NETWORK" 2>/dev/null || true)
if [[ -z "$ADMIN_PUBKEY" ]]; then
  # Derive from the secret without persisting it as a named key.
  ADMIN_PUBKEY=$("$CLI" keys derive "$TESTNET_ADMIN_SECRET" --network "$NETWORK" --public \
    2>/dev/null || "$CLI" keys address "$TESTNET_ADMIN_SECRET" 2>/dev/null || true)
fi
if [[ -z "$ADMIN_PUBKEY" ]]; then
  echo "❌ Could not derive the admin pubkey for the isolated testnet account." >&2
  exit 1
fi
TREASURY="${TREASURY:-$ADMIN_PUBKEY}"
echo "  Admin   : $ADMIN_PUBKEY"
echo "  Treasury: $TREASURY"

WASM_PATH="$ROOT_DIR/contracts/amana_escrow/target/wasm32-unknown-unknown/release/amana_escrow.wasm"
if [[ ! -f "$WASM_PATH" ]]; then
  echo "[2/3] Building contract wasm..."
  (cd "$ROOT_DIR/contracts/amana_escrow" && cargo build --target wasm32-unknown-unknown --features wasm --release)
else
  echo "[2/3] Using existing wasm build."
fi

echo "[3/3] Deploying to network '$NETWORK'..."
if [[ "$UPGRADE" == "true" ]]; then
  : "${CONTRACT_ID:?CONTRACT_ID is required with --upgrade}"
  HASH=$("$CLI" contract upload --network "$NETWORK" --source "$TESTNET_ADMIN_SECRET" --wasm "$WASM_PATH")
  "$CLI" contract invoke --network "$NETWORK" --source "$TESTNET_ADMIN_SECRET" \
    -- "$CONTRACT_ID" upgrade --new_wasm_hash "$HASH"
  echo "✓ Upgraded contract $CONTRACT_ID"
  echo "NEXT: point the preview backend at CONTRACT_ID=$CONTRACT_ID"
else
  if [[ -n "$TOKEN_CONTRACT" ]]; then
    CONTRACT_ID=$("$CLI" contract deploy --network "$NETWORK" \
      --source "$TESTNET_ADMIN_SECRET" --wasm "$WASM_PATH")
    "$CLI" contract invoke --network "$NETWORK" --source "$TESTNET_ADMIN_SECRET" \
      -- "$CONTRACT_ID" initialize \
      --admin "$ADMIN_PUBKEY" --cngn_contract "$TOKEN_CONTRACT" \
      --treasury "$TREASURY" --fee_bps "$FEE_BPS" || {
        echo "⚠  initialize failed — deploy succeeded ($CONTRACT_ID) but the contract is not initialized." >&2
      }
    echo "✓ Deployed contract $CONTRACT_ID"
    echo "NEXT: set PREVIEW_CONTRACT_ID=$CONTRACT_ID when starting the preview stack."
  else
    CONTRACT_ID=$("$CLI" contract deploy --network "$NETWORK" \
      --source "$TESTNET_ADMIN_SECRET" --wasm "$WASM_PATH")
    echo "✓ Deployed contract $CONTRACT_ID (not initialized — pass --token-contract to initialize)."
    echo "NEXT: set PREVIEW_CONTRACT_ID=$CONTRACT_ID when starting the preview stack."
  fi
fi
