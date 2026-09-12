#!/usr/bin/env bash
#
# Build pi binaries for all platforms locally.
# Mirrors .github/workflows/build-binaries.yml
#
# Usage:
#   ./scripts/build-binaries.sh [--skip-install] [--skip-build] [--offline-model-data] [--platform <platform>] [--out <dir>]
#
# Options:
#   --skip-install       Skip npm ci
#   --skip-build         Skip the package build
#   --offline-model-data Build with bundled model data instead of refreshing it
#   --platform <name>    Build only for specified platform (darwin-arm64, darwin-x64, linux-x64, linux-arm64, windows-x64, windows-arm64)
#   --out <dir>          Output directory (default: packages/coding-agent/binaries)
#
# Output:
#   packages/coding-agent/binaries/
#     pi-darwin-arm64.tar.gz
#     pi-darwin-x64.tar.gz
#     pi-linux-x64.tar.gz
#     pi-linux-arm64.tar.gz
#     pi-windows-x64.zip
#     pi-windows-arm64.zip

set -euo pipefail

cd "$(dirname "$0")/.."
REPO_ROOT=$PWD

SKIP_INSTALL=false
SKIP_BUILD=false
OFFLINE_MODEL_DATA=false
PLATFORM=""
OUTPUT_DIR=""

while [[ $# -gt 0 ]]; do
    case $1 in
        --skip-install)
            SKIP_INSTALL=true
            shift
            ;;
        --skip-build)
            SKIP_BUILD=true
            shift
            ;;
        --offline-model-data)
            OFFLINE_MODEL_DATA=true
            shift
            ;;
        --platform)
            PLATFORM="$2"
            shift 2
            ;;
        --out)
            OUTPUT_DIR="$2"
            shift 2
            ;;
        *)
            echo "Unknown option: $1"
            exit 1
            ;;
    esac
done

# Validate platform if specified
if [[ -n "$PLATFORM" ]]; then
    case "$PLATFORM" in
        darwin-arm64|darwin-x64|linux-x64|linux-arm64|windows-x64|windows-arm64)
            ;;
        *)
            echo "Invalid platform: $PLATFORM"
            echo "Valid platforms: darwin-arm64, darwin-x64, linux-x64, linux-arm64, windows-x64, windows-arm64"
            exit 1
            ;;
    esac
fi

if [[ -z "$OUTPUT_DIR" ]]; then
    OUTPUT_DIR="packages/coding-agent/binaries"
fi
if [[ "$OUTPUT_DIR" != /* ]]; then
    OUTPUT_DIR="$(pwd)/$OUTPUT_DIR"
fi

if [[ "$SKIP_INSTALL" == "false" ]]; then
    echo "==> Installing dependencies..."
    npm ci --ignore-scripts
else
    echo "==> Skipping npm ci (--skip-install)"
fi

if [[ "$SKIP_BUILD" == "false" ]]; then
    if [[ "$OFFLINE_MODEL_DATA" == "true" ]]; then
        echo "==> Building all packages with bundled model data..."
        npm run build:offline
    else
        echo "==> Building all packages..."
        npm run build
    fi
else
    echo "==> Skipping package build (--skip-build)"
fi

echo "==> Building trusted native dependencies..."
npm rebuild canvas --foreground-scripts

node scripts/prepare-bun-compile-assets.mjs

echo "==> Building binaries..."
cd packages/coding-agent

# Clean previous builds
rm -rf "$OUTPUT_DIR"
mkdir -p "$OUTPUT_DIR"/{darwin-arm64,darwin-x64,linux-x64,linux-arm64,windows-x64,windows-arm64}

# Determine which platforms to build
if [[ -n "$PLATFORM" ]]; then
    PLATFORMS=("$PLATFORM")
else
    PLATFORMS=(darwin-arm64 darwin-x64 linux-x64 linux-arm64 windows-x64 windows-arm64)
fi

for platform in "${PLATFORMS[@]}"; do
    echo "Building for $platform..."
    bun_target="bun-$platform"
    if [[ "$platform" == *-x64 ]]; then
        bun_target="${bun_target}-baseline"
    fi

    # Bun compiled executables only embed worker scripts when they are passed as
    # explicit build entrypoints. The runtime can still use new URL(...), but the
    # worker must be present in the compiled executable.
    #
    # Disable cwd bunfig.toml autoload so project preload scripts cannot crash the
    # standalone binary before pi starts (see #7684).
    if [[ "$platform" == windows-* ]]; then
        bun build --compile --no-compile-autoload-dotenv --no-compile-autoload-bunfig --minify --keep-names --target="$bun_target" ./dist/bun/cli.js ./src/modes/rpc/session-worker.ts ./src/utils/image-resize-worker.ts ../../node_modules/jsdom/lib/jsdom/living/xhr/xhr-sync-worker.js --outfile "$OUTPUT_DIR/$platform/pi.exe"
    else
        bun build --compile --no-compile-autoload-dotenv --no-compile-autoload-bunfig --minify --keep-names --target="$bun_target" ./dist/bun/cli.js ./src/modes/rpc/session-worker.ts ./src/utils/image-resize-worker.ts ../../node_modules/jsdom/lib/jsdom/living/xhr/xhr-sync-worker.js --outfile "$OUTPUT_DIR/$platform/pi"
        if [[ "$platform" == darwin-* ]] && command -v codesign >/dev/null 2>&1; then
            codesign --remove-signature "$OUTPUT_DIR/$platform/pi" 2>/dev/null || true
            codesign --force --sign - "$OUTPUT_DIR/$platform/pi"
        fi
    fi
done

echo "==> Creating release archives..."

# Copy shared files to each platform directory
for platform in "${PLATFORMS[@]}"; do
    cp package.json "$OUTPUT_DIR/$platform/"
    cp README.md "$OUTPUT_DIR/$platform/"
    cp CHANGELOG.md "$OUTPUT_DIR/$platform/"
    cp ../../node_modules/@silvia-odwyer/photon-node/photon_rs_bg.wasm "$OUTPUT_DIR/$platform/"
    mkdir -p "$OUTPUT_DIR/$platform/theme"
    cp dist/modes/interactive/theme/*.json "$OUTPUT_DIR/$platform/theme/"
    mkdir -p "$OUTPUT_DIR/$platform/assets"
    cp dist/modes/interactive/assets/* "$OUTPUT_DIR/$platform/assets/"
    cp -r dist/core/export-html "$OUTPUT_DIR/$platform/"
    cp -r docs "$OUTPUT_DIR/$platform/"
    cp -r examples "$OUTPUT_DIR/$platform/"
    node "../../scripts/copy-codemode-sidecar.mjs" "$OUTPUT_DIR/$platform"

    # Copy the persistent-terminal PTY native prebuild next to the compiled binary at the
    # sidecar path its loader probes: native/prebuilds/<platform>-<arch>/senpi_pty.<host>.node.
    # (bun --compile does not embed .node files.) When the prebuild is absent the runtime
    # uses the child_process pipe fallback, so a missing prebuild must not fail the build.
    case "$platform" in
        windows-x64) pty_host="win32-x64" ;;
        windows-arm64) pty_host="win32-arm64" ;;
        *) pty_host="$platform" ;;
    esac
    pty_native_src="../pty/native/prebuilds/$pty_host/senpi_pty.$pty_host.node"
    if [[ -f "$pty_native_src" ]]; then
        mkdir -p "$OUTPUT_DIR/$platform/native/prebuilds/$pty_host"
        cp "$pty_native_src" "$OUTPUT_DIR/$platform/native/prebuilds/$pty_host/"
    else
        echo "  (no pi-pty prebuild for $pty_host — archive uses pipe fallback)"
    fi

    # Copy the selected architecture's native platform helpers next to the executable.
    native_platform="${platform/windows-/win32-}"
    native_path="native/${native_platform%-*}/prebuilds"
    mkdir -p "$OUTPUT_DIR/$platform/$native_path"
    cp -R "../tui/$native_path/$native_platform" "$OUTPUT_DIR/$platform/$native_path/"
done

# Create archives
cd "$OUTPUT_DIR"

for platform in "${PLATFORMS[@]}"; do
    if [[ "$platform" == windows-* ]]; then
        # Windows (zip)
        echo "Creating pi-$platform.zip..."
        (cd "$platform" && zip -r ../pi-$platform.zip .)
    else
        # Unix platforms (tar.gz) - use wrapper directory for mise compatibility
        echo "Creating pi-$platform.tar.gz..."
        mv "$platform" pi && tar -czf pi-$platform.tar.gz pi && mv pi "$platform"
    fi
done

# Extract archives for easy local testing
echo "==> Extracting archives for testing..."
for platform in "${PLATFORMS[@]}"; do
    rm -rf "$platform"
    if [[ "$platform" == windows-* ]]; then
        mkdir -p "$platform" && (cd "$platform" && unzip -q ../pi-$platform.zip)
    else
        tar -xzf pi-$platform.tar.gz && mv pi "$platform"
    fi
done

# Host-platform runtime smoke test
host_os=$(uname -s)
host_arch=$(uname -m)
host_target=""
case "$host_os:$host_arch" in
    Darwin:arm64) host_target="darwin-arm64" ;;
    Darwin:x86_64) host_target="darwin-x64" ;;
    Linux:x86_64) host_target="linux-x64" ;;
    Linux:aarch64) host_target="linux-arm64" ;;
    MINGW*:x86_64 | MSYS*:x86_64 | CYGWIN*:x86_64 | Windows_NT:x86_64) host_target="windows-x64" ;;
    MINGW*:arm64 | MSYS*:arm64 | CYGWIN*:arm64 | Windows_NT:arm64) host_target="windows-arm64" ;;
esac

if [[ -n "$host_target" ]]; then
    host_built=false
    for platform in "${PLATFORMS[@]}"; do
        if [[ "$platform" == "$host_target" ]]; then
            host_built=true
            break
        fi
    done

    if [[ "$host_built" == true ]]; then
        echo "==> Running binary smoke test for $host_target..."
        if [[ "$host_target" == windows-* ]]; then
            host_binary="$OUTPUT_DIR/$host_target/pi.exe"
        else
            host_binary="$OUTPUT_DIR/$host_target/pi"
        fi
        if [[ ! -x "$host_binary" ]]; then
            echo "ERROR: host binary missing: $host_binary" >&2
            exit 1
        fi
        node "$REPO_ROOT/scripts/smoke-standalone-binary.mjs" \
            "$host_binary" \
            "$REPO_ROOT/node_modules/jsdom/lib/jsdom/living/xhr/xhr-sync-worker.js"
        echo "binary smoke OK"
    else
        echo "binary smoke skipped (host $host_target not built)"
    fi
fi

echo ""
echo "==> Build complete!"
echo "Archives available in $OUTPUT_DIR/"
ls -lh *.tar.gz *.zip 2>/dev/null || true
echo ""
echo "Extracted directories for testing:"
for platform in "${PLATFORMS[@]}"; do
    if [[ "$platform" == windows-* ]]; then
        echo "  $OUTPUT_DIR/$platform/pi.exe"
    else
        echo "  $OUTPUT_DIR/$platform/pi"
    fi
done
