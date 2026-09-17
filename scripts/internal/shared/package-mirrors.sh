#!/usr/bin/env bash
#
# Optional binary-download mirrors for packaging.
#
# Packaging fetches large binaries that are not on the npm registry — Electron
# (~150MB), electron-builder's toolchain, and better-sqlite3's prebuilt binding
# — all of them from GitHub, which is slow or unreachable from some networks.
#
# Opt in with MEMMY_PACKAGE_MIRROR=cn to route those downloads through
# npmmirror.com. It is opt-in rather than a default on purpose: the mirror is a
# third party, it is slower for anyone outside mainland China, and a mirror that
# is down or missing a version would break packaging for people who never asked
# for it. Everything already present in the environment wins, so a caller with
# its own mirror or a proxy is never overridden.
#
# Usage:
#   MEMMY_PACKAGE_MIRROR=cn bash scripts/package-win.sh --version 1.1.5 ...

if [ "${MEMMY_PACKAGE_MIRRORS_SH_LOADED:-}" = "1" ]; then
  return 0
fi
MEMMY_PACKAGE_MIRRORS_SH_LOADED=1

NPMMIRROR_ORIGIN="https://npmmirror.com/mirrors"

apply_package_mirrors() {
  if [ "${MEMMY_PACKAGE_MIRROR:-}" != "cn" ]; then
    return 0
  fi

  export ELECTRON_MIRROR="${ELECTRON_MIRROR:-$NPMMIRROR_ORIGIN/electron/}"
  export ELECTRON_BUILDER_BINARIES_MIRROR="${ELECTRON_BUILDER_BINARIES_MIRROR:-$NPMMIRROR_ORIGIN/electron-builder-binaries/}"
  export npm_config_better_sqlite3_binary_host_mirror="${npm_config_better_sqlite3_binary_host_mirror:-$NPMMIRROR_ORIGIN/better-sqlite3}"

  echo "Using the cn package mirror for Electron and native binary downloads" >&2
}
