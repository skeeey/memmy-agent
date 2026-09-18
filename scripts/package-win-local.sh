#!/usr/bin/env bash
#
# One-shot Windows packaging for a developer machine.
#
# `package-win.sh` is the real entry point and deliberately carries no
# machine-local setup. That is the right split for CI, but a first build on a
# fresh Windows clone failed four separate times, each failure only surfacing
# after several minutes of work:
#
#   1. vite.config.ts and the edition-manifest writer both read three MEMMY_*
#      values from the repo-root .env. That file is gitignored, so a clone
#      never has it, and the build dies at whichever of the two reads it
#      reaches first (`MEMMY_LEGAL_CN_BASE_URL ... must be an HTTPS origin`,
#      then `MEMMY_CLOUD_SERVICE must be a non-empty HTTPS origin`).
#   2. Electron, electron-builder's toolchain and better-sqlite3's prebuilt
#      binding all download from GitHub. On a network that resets those
#      connections the build dies during dependency installation
#      (`prebuild-install warn install read ECONNRESET`).
#   3. electron-builder cannot clear release/win-unpacked while an app built
#      from that very directory is still running: EBUSY on
#      v8_context_snapshot.bin.
#
# So this wrapper fills in the environment, points the downloads at a mirror,
# closes the app, clears the stale output, and only then hands over to
# package-win.sh untouched.
#
# Usage:
#   bash scripts/package-win-local.sh                 # intl, unsigned, version from package.json
#   bash scripts/package-win-local.sh --edition cn    # any package-win.sh flag is forwarded
#   bash scripts/package-win-local.sh --prepare-only  # do the local setup, stop before packaging
#
# Environment:
#   MEMMY_PACKAGE_MIRROR=off   download from GitHub instead of the cn mirror
#
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# The three values the packaging chain refuses to run without. They are read
# from the root .env by vite and by the edition-manifest writer.
REQUIRED_ENV_KEYS=(MEMMY_LEGAL_CN_BASE_URL MEMMY_LEGAL_INTL_BASE_URL MEMMY_CLOUD_SERVICE)

# The desktop builds in this repository have all been the international
# edition; package-win.sh itself defaults to cn, which is easy to miss and
# only shows up twenty minutes later in the artifact name.
DEFAULT_EDITION="intl"

PREPARE_ONLY=0
PACKAGE_ARGS=()
for arg in "$@"; do
  case "$arg" in
    --prepare-only)
      PREPARE_ONLY=1
      ;;
    *)
      PACKAGE_ARGS+=("$arg")
      ;;
  esac
done

# True when any forwarded argument already sets the flag (--flag or --flag=...).
has_package_arg() {
  local needle="$1"
  if [ "${#PACKAGE_ARGS[@]}" -eq 0 ]; then
    return 1
  fi
  local candidate
  for candidate in "${PACKAGE_ARGS[@]}"; do
    case "$candidate" in
      "$needle"|"$needle"=*)
        return 0
        ;;
    esac
  done
  return 1
}

# Reads the desktop version, which the packaging guard requires to match the
# root and shell manifests.
desktop_version() {
  ( cd "$ROOT_DIR/App/shell/desktop" && node -p "require('./package.json').version" )
}

# Appends any required key the local .env is missing, taking the value from the
# committed .env.example so this script never carries a second copy of it.
ensure_env_file() {
  local env_file="$ROOT_DIR/.env"
  local example_file="$ROOT_DIR/.env.example"
  local key value
  local added=0

  if [ ! -f "$example_file" ]; then
    echo "Missing $example_file; cannot derive the build defaults." >&2
    exit 1
  fi

  for key in "${REQUIRED_ENV_KEYS[@]}"; do
    if [ -f "$env_file" ] && grep -qE "^${key}=" "$env_file"; then
      continue
    fi

    value="$(sed -nE "s/^${key}=(.*)$/\1/p" "$example_file" | head -n 1)"
    if [ -z "$value" ]; then
      echo "$example_file does not define $key." >&2
      exit 1
    fi

    if [ "$added" -eq 0 ]; then
      if [ ! -f "$env_file" ]; then
        printf '# Local build configuration (gitignored). Created by scripts/package-win-local.sh.\n' > "$env_file"
      elif [ -n "$(tail -c 1 "$env_file")" ]; then
        # Keep the appended key on its own line when the file has no trailing newline.
        printf '\n' >> "$env_file"
      fi
      echo "Filling in the build variables the packaging scripts read from .env:" >&2
    fi

    printf '%s=%s\n' "$key" "$value" >> "$env_file"
    echo "  $key=$value" >&2
    added=1
  done

  if [ "$added" -eq 1 ]; then
    echo "  written to $env_file" >&2
  fi
}

# electron-builder clears release/win-unpacked before copying the Electron
# distribution into it, and fails with EBUSY when the app built there still
# holds its own files open. Testing the build means running it, so this is the
# normal case rather than an accident.
close_running_app() {
  if ! command -v powershell.exe >/dev/null 2>&1; then
    return 0
  fi

  local closed
  closed="$(powershell.exe -NoProfile -Command \
    "(Get-Process Memmy -ErrorAction SilentlyContinue | Stop-Process -Force -PassThru | Measure-Object).Count" \
    2>/dev/null | tr -d '\r\n' || true)"

  if [ -n "${closed:-}" ] && [ "$closed" != "0" ]; then
    echo "Closed $closed running Memmy process(es) holding the output directory." >&2
  fi
}

clean_stale_output() {
  local unpacked="$ROOT_DIR/App/shell/desktop/release/win-unpacked"

  if [ ! -d "$unpacked" ]; then
    return 0
  fi

  echo "Removing the previous unpacked build at $unpacked" >&2
  if ! rm -rf "$unpacked"; then
    echo "Could not remove it: something still holds those files." >&2
    echo "Close Memmy (including any tray process) and run this again." >&2
    exit 1
  fi
}

if ! has_package_arg --version; then
  PACKAGE_ARGS+=(--version "$(desktop_version)")
fi
if ! has_package_arg --edition; then
  PACKAGE_ARGS+=(--edition "$DEFAULT_EDITION")
fi

# Opt-in for package-mirrors.sh; anything but "cn" leaves the downloads alone.
export MEMMY_PACKAGE_MIRROR="${MEMMY_PACKAGE_MIRROR:-cn}"

ensure_env_file
close_running_app
clean_stale_output

if [ "${MEMMY_PACKAGE_MIRROR}" = "cn" ]; then
  echo "Downloads will use the cn mirror (MEMMY_PACKAGE_MIRROR=off to disable)." >&2
fi

if [ "$PREPARE_ONLY" = "1" ]; then
  echo "Prepared. Packaging would run: bash scripts/package-win.sh ${PACKAGE_ARGS[*]}" >&2
  exit 0
fi

exec bash "$ROOT_DIR/scripts/package-win.sh" "${PACKAGE_ARGS[@]}"
