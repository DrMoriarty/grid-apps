#!/bin/bash
# =============================================================================
# bin/build-release.sh — build release artifacts for grid-apps
#
# Builds, for a chosen platform target:
#   - desktop (Electron) artifacts: dist/KiriMoto-<os>-<arch>.{exe,dmg,AppImage,zip}
#   - web bundle: web/boot/bundle-<version>.bin
# and collects everything into an output directory (default: dist/release).
#
# NOTE: the canonical electron build chain includes `npm run setup`, which runs
# `clean` and DELETES alt/ build/ dist/ src/pack/ tmp/ — don't keep uncommitted
# work in those directories when running without --no-setup.
#
# Usage:
#   ./bin/build-release.sh [options]
#
# Options:
#   -t, --target <auto|win|linux|mac|mac-intel|all>   build target(s)
#                                           (default: auto — detect host OS)
#   -w, --web-only                          build only the web bundle, skip Electron
#   -o, --out <dir>                         output directory (default: dist/release)
#       --no-setup                          skip `npm run setup` (faster, assumes
#                                           node_modules + src/ext are already in place)
#   -u, --upload <tag>                      after a successful build, upload collected
#                                           artifacts to GitHub release <tag> (gh CLI)
#   -n, --dry-run                           print planned commands, execute nothing
#   -h, --help                              show this help
#
# Examples:
#   ./bin/build-release.sh                       # current OS, full chain
#   ./bin/build-release.sh -t linux --no-setup   # linux only, skip setup
#   ./bin/build-release.sh -t all                # all desktop targets
#   ./bin/build-release.sh -w                    # web bundle only
#   ./bin/build-release.sh -t mac -u v4.7.0      # build + upload to release
#   ./bin/build-release.sh -t mac-intel          # intel (x86_64) mac build
# =============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

VERSION="$(node -p "require('./package.json').version")"

TARGET="auto"
WEB_ONLY=0
OUT_DIR="dist/release"
UPLOAD_TAG=""
SKIP_SETUP=0
DRY_RUN=0

log()  { printf '\033[1;34m[release]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[release]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m[release]\033[0m %s\n' "$*" >&2; exit 1; }

usage() {
    # print only the leading comment block (stops at first non-comment line)
    awk '/^#!/ { next } /^#/ { sub(/^# ?/, ""); print; next } { exit }' "${BASH_SOURCE[0]}"
    exit 0
}

# --- argument parsing ---------------------------------------------------------
while [ $# -gt 0 ]; do
    case "$1" in
        -t|--target)    TARGET="${2:?missing value for --target}"; shift 2 ;;
        -w|--web-only)  WEB_ONLY=1; shift ;;
        -o|--out)       OUT_DIR="${2:?missing value for --out}"; shift 2 ;;
        --no-setup)     SKIP_SETUP=1; shift ;;
        -u|--upload)    UPLOAD_TAG="${2:?missing value for --upload}"; shift 2 ;;
        -n|--dry-run)   DRY_RUN=1; shift ;;
        -h|--help)      usage ;;
        *)              die "unknown option: $1 (see --help)" ;;
    esac
done

# --- helpers -------------------------------------------------------------------
run() {
    if [ "$DRY_RUN" -eq 1 ]; then
        log "dry-run: $*"
    else
        log "$*"
        "$@"
    fi
}

detect_target() {
    case "$(uname -s)" in
        Darwin)
            case "$(uname -m)" in
                x86_64) echo "mac-intel" ;;
                *)      echo "mac" ;;
            esac
            ;;
        Linux)                  echo "linux" ;;
        MINGW*|MSYS*|CYGWIN*)   echo "win" ;;
        *) die "cannot detect host OS: $(uname -s); pass --target explicitly" ;;
    esac
}

validate_target() {
    case "$1" in
        win|linux|mac|mac-intel) return 0 ;;
        *) die "invalid target: $1 (expected win|linux|mac|mac-intel)" ;;
    esac
}

# electron-builder args per target (mirrors build-win / build-linux / build-mac / build-mac-intel)
eb_args() {
    case "$1" in
        win)        echo "--win --x64" ;;
        linux)      echo "--linux --x64" ;;
        mac)        echo "--mac --arm64" ;;
        mac-intel)  echo "--mac --x64" ;;
    esac
}

# artifact globs per target, relative to dist/
artifacts_for() {
    case "$1" in
        win)        echo "dist/*.exe dist/*.zip" ;;
        linux)      echo "dist/*.AppImage" ;;
        mac)        echo "dist/*.dmg" ;;
        mac-intel)  echo "dist/*.dmg" ;;
    esac
}

# --- preflight -----------------------------------------------------------------
command -v node >/dev/null 2>&1 || die "node not found in PATH"
command -v npm  >/dev/null 2>&1 || die "npm not found in PATH"

if [ "$TARGET" = "auto" ]; then
    TARGET="$(detect_target)"
fi
if [ "$WEB_ONLY" -eq 0 ] && [ "$TARGET" = "all" ]; then
    for t in win linux mac mac-intel; do validate_target "$t"; done
else
    validate_target "$TARGET"
fi

if [ -n "$UPLOAD_TAG" ]; then
    command -v gh >/dev/null 2>&1 || die "--upload requires the GitHub CLI (gh) in PATH"
fi

skip_label=""
[ "$SKIP_SETUP" -eq 1 ] && skip_label=" skip_setup=1"
log "version=$VERSION target=$TARGET web_only=$WEB_ONLY out=$OUT_DIR$skip_label"

# --- generated sources ------------------------------------------------------------
# src/ext/three.js, src/ext/jszip-esm.js, src/ext/quickjs.js and src/void/solver/
# are gitignored artifacts produced by `npm run setup` (via `npm run webpack-ext`).
# esbuild cannot resolve imports of them until they exist.
need_ext() {
    [ -f src/ext/three.js ] && [ -f src/ext/jszip-esm.js ] && [ -f src/void/solver/planegcs.js ]
}

ensure_generated() {
    need_ext && return 0
    warn "generated sources missing (src/ext/three.js, src/ext/jszip-esm.js, src/void/solver/planegcs.js)"
    if [ "$DRY_RUN" -eq 1 ]; then
        warn "dry-run: would run 'npm run webpack-ext' to generate them"
        return 0
    fi
    if [ ! -d node_modules ]; then
        die "node_modules missing; run 'npm run setup' first (it installs deps and generates src/ext + src/void/solver)"
    fi
    log "generating ext bundles: npm run webpack-ext"
    run npm run webpack-ext
    need_ext || die "generated sources still missing; run 'npm run setup' and retry"
}

# --- build: web bundle ----------------------------------------------------------
build_web() {
    log "building prod web bundle (version $VERSION)"
    if [ "$SKIP_SETUP" -eq 1 ]; then
        run npm run webpack-src prod
        run npm run dryrun
        run env COMPRESS=1 npm run bundle:prod
    else
        run npm run pack-prod
    fi
    [ -f "web/boot/bundle-${VERSION}.bin" ] || warn "expected web/boot/bundle-${VERSION}.bin not found"
}

# --- build: one desktop target ---------------------------------------------------
build_desktop() {
    local t="$1"
    log "building desktop artifacts for $t"
    if [ "$SKIP_SETUP" -eq 1 ]; then
        # replicate prebuild without `npm run setup`
        run npm run webpack-src
        run npm run dryrun
        run npm run bundle:dev
        run env ELECTRON_BUILD=1 node bin/electron-pre.js
        # shellcheck disable=SC2086
        run npx electron-builder --publish never $(eb_args "$t")
    else
        # shellcheck disable=SC2086
        run npm run build -- $(eb_args "$t")
    fi
}

# --- collect artifacts -----------------------------------------------------------
collect() {
    run mkdir -p "$OUT_DIR"
    local copied=0
    # web bundle
    if [ -f "web/boot/bundle-${VERSION}.bin" ]; then
        run cp "web/boot/bundle-${VERSION}.bin" "$OUT_DIR/"
        copied=1
    fi
    # desktop artifacts
    if [ "$WEB_ONLY" -eq 0 ]; then
        local targets
        if [ "$TARGET" = "all" ]; then targets="win linux mac mac-intel"; else targets="$TARGET"; fi
        local t glob f
        for t in $targets; do
            for glob in $(artifacts_for "$t"); do
                for f in $glob; do
                    [ -f "$f" ] || continue
                    run cp "$f" "$OUT_DIR/"
                    copied=1
                done
            done
        done
    fi
    [ "$copied" -eq 1 ] || warn "no artifacts found to collect"
}

# --- summary ---------------------------------------------------------------------
summary() {
    log "release artifacts (version $VERSION):"
    if [ -d "$OUT_DIR" ]; then
        local f
        find "$OUT_DIR" -maxdepth 1 -type f | sort | while read -r f; do
            printf '  %10s  %s\n' "$(du -h "$f" | cut -f1)" "$(basename "$f")"
        done
    fi
}

# --- upload ----------------------------------------------------------------------
upload() {
    local tag="$1"
    log "uploading artifacts to GitHub release $tag"
    local f
    find "$OUT_DIR" -maxdepth 1 -type f | sort | while read -r f; do
        run gh release upload "$tag" "$f" --clobber
    done
}

# --- main -------------------------------------------------------------------------
ensure_generated
build_web

if [ "$WEB_ONLY" -eq 0 ]; then
    if [ "$TARGET" = "all" ]; then
        for t in win linux mac mac-intel; do
            build_desktop "$t"
        done
    else
        build_desktop "$TARGET"
    fi
fi

collect
summary

if [ -n "$UPLOAD_TAG" ]; then
    upload "$UPLOAD_TAG"
fi

log "done"
