#!/usr/bin/env bash
#
# Makes sure the Electron distribution is present under the desktop shell's
# node_modules.
#
# The Windows packaging script runs that distribution's electron.exe as a Node
# runtime (ELECTRON_RUN_AS_NODE=1) to verify the packaged native modules load
# against the right ABI, so packaging fails without it. Downloading it is the
# job of the electron package's install script — which npm 12 skips by default
# unless the package is approved, leaving the package directory in place with no
# dist/ at all: `Missing required packaged runtime file: .../electron/dist/
# electron.exe`. Running that script here is idempotent and self-healing, and
# it honours ELECTRON_MIRROR when the caller has one set.

if [ "${MEMMY_ENSURE_ELECTRON_DIST_SH_LOADED:-}" = "1" ]; then
  return 0
fi
MEMMY_ENSURE_ELECTRON_DIST_SH_LOADED=1

# ensure_electron_dist <desktop_dir>
#
# Downloads the Electron distribution when node_modules has the electron package
# but no dist/ inside it. Does nothing when dist/ is already there, and leaves
# the failure to the caller's own file check when the package is absent
# entirely.
ensure_electron_dist() {
  local desktop_dir="$1"
  local dist_dir="$desktop_dir/node_modules/electron/dist"
  local installer="$desktop_dir/node_modules/electron/install.js"

  if [ -d "$dist_dir" ]; then
    return 0
  fi

  if [ ! -f "$installer" ]; then
    return 0
  fi

  echo "Electron dist is missing at $dist_dir; running the electron install script" >&2
  ( cd "$desktop_dir" && node "$installer" )
}
