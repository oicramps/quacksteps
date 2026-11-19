#!/bin/bash
# Builds Quacksteps.app: the SwiftUI app plus the Bun-compiled quackd, ad hoc signed.
#
#   mac/scripts/build-app.sh            # release build into mac/build/Quacksteps.app
#   mac/scripts/build-app.sh --debug    # debug build (faster)
#
# Needs Xcode (26 or later) and Bun. The version comes from shared/src/constants.ts (QUACK_VERSION),
# so the app and its server always match; the app restarts an older server on launch.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CONFIG=release
[[ "${1:-}" == "--debug" ]] && CONFIG=debug
export DEVELOPER_DIR="${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}"

VERSION="$(sed -n "s/^export const QUACK_VERSION = '\(.*\)';/\1/p" "$ROOT/shared/src/constants.ts")"
[[ -n "$VERSION" ]] || { echo "QUACK_VERSION not found" >&2; exit 1; }

echo "==> quackd $VERSION"
(cd "$ROOT/companion" && bun scripts/compile.ts >/dev/null)

echo "==> diff renderer"
(cd "$ROOT" && yarn -s workspace @quack/renderer build >/dev/null)

echo "==> Swift ($CONFIG)"
(cd "$ROOT/mac/Packages" && swift build -c "$CONFIG" --product Quacksteps 2>&1 | grep -E "error|warning: |Compiling|Build complete" | grep -v "^\s*$" | tail -5)
BIN="$(cd "$ROOT/mac/Packages" && swift build -c "$CONFIG" --show-bin-path)"

APP="$ROOT/mac/build/Quacksteps.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources/Fonts"
cp "$BIN/Quacksteps" "$APP/Contents/MacOS/Quacksteps"
cp "$ROOT/companion/dist/quackd" "$APP/Contents/MacOS/quackd"
cp "$ROOT"/extension/assets/fonts/space-grotesk-*.woff2 "$APP/Contents/Resources/Fonts/"
# The diff view loads its renderer from Contents/Resources/renderer (no network, file:// only).
cp -R "$ROOT/mac/renderer/dist" "$APP/Contents/Resources/renderer"

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleIdentifier</key><string>com.polarsteps.quacksteps</string>
	<key>CFBundleName</key><string>Quacksteps</string>
	<key>CFBundleDisplayName</key><string>Quacksteps</string>
	<key>CFBundleExecutable</key><string>Quacksteps</string>
	<key>CFBundlePackageType</key><string>APPL</string>
	<key>CFBundleShortVersionString</key><string>$VERSION</string>
	<key>CFBundleVersion</key><string>$VERSION</string>
	<key>LSMinimumSystemVersion</key><string>26.0</string>
	<key>LSApplicationCategoryType</key><string>public.app-category.developer-tools</string>
	<key>NSPrincipalClass</key><string>NSApplication</string>
	<key>NSHighResolutionCapable</key><true/>
	<key>NSHumanReadableCopyright</key><string>Read-only: Quack never posts to GitHub.</string>
</dict>
</plist>
PLIST

echo "==> Signing (ad hoc)"
# quackd first: it needs the JIT entitlements under the hardened runtime.
codesign --force --sign - --options runtime --entitlements "$ROOT/mac/quackd.entitlements" "$APP/Contents/MacOS/quackd"
codesign --force --sign - --options runtime "$APP"
codesign --verify --deep --strict "$APP"
echo "==> $APP"
