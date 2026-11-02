#!/usr/bin/env bash
set -Eeuo pipefail

proof_root="${1:?usage: linux-portability-proof-2026-08-02.sh PROOF_ROOT NODE_HOME}"
node_home="${2:?usage: linux-portability-proof-2026-08-02.sh PROOF_ROOT NODE_HOME}"
export PATH="$node_home/bin:$PATH"

echo '=== MARSHAL LINUX PORTABILITY PROOF ==='
date --iso-8601=seconds
uname -a
cat /etc/os-release
ldd --version
node --version
echo "proof_root=$proof_root"
echo "node_home=$node_home"

echo '=== FRESH-COPY ATTESTATION ==='
if find "$proof_root" -type d \( -name node_modules -o -name dist -o -name .git -o -name .gitnexus \) -print -quit | grep -q .; then
  echo 'Fresh copy contains forbidden build or repository state.' >&2
  exit 1
fi
du -sh "$proof_root/agent-runtime" "$proof_root/gitnexus-memory" "$proof_root/marshal-codex-gitnexus"

echo '=== EXACT PACKAGE MANAGER ==='
export COREPACK_HOME="$proof_root/.corepack"
mkdir -p "$proof_root/.bin" "$COREPACK_HOME"
corepack install --global pnpm@10.32.1
corepack enable --install-directory "$proof_root/.bin" pnpm
export PATH="$proof_root/.bin:$PATH"
corepack pnpm@10.32.1 --version
test "$(pnpm --version)" = '10.32.1'

echo '=== MAIN INSTALL + BUILD ==='
cd "$proof_root/agent-runtime"
corepack pnpm@10.32.1 install --frozen-lockfile
corepack pnpm@10.32.1 build

echo '=== GRAPH INSTALL + ROOT/FORK BUILD ==='
cd "$proof_root/gitnexus-memory"
corepack pnpm@10.32.1 install --frozen-lockfile
corepack pnpm@10.32.1 build
corepack pnpm@10.32.1 -C fork build

echo '=== LEAF DETACHED INSTALL + FULL VERIFY ==='
cd "$proof_root/marshal-codex-gitnexus"
corepack pnpm@10.32.1 install --frozen-lockfile
corepack pnpm@10.32.1 verify

echo '=== PERSISTENT CANDIDATE SELF-CONTAINMENT ==='
candidate="$proof_root/installed-candidate"
corepack pnpm@10.32.1 install:candidate "$candidate"
corepack pnpm@10.32.1 verify:candidate "$candidate"
cd "$candidate"
corepack pnpm@10.32.1 install --offline --frozen-lockfile

echo '=== FINAL RESULT: PASS ==='
