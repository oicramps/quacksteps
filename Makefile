# Quacksteps (macOS) build helpers. The extension and companion use yarn directly.
DEVELOPER_DIR ?= /Applications/Xcode.app/Contents/Developer
export DEVELOPER_DIR

LABEL := com.polarsteps.quacksteps.server
PLIST := $(HOME)/Library/LaunchAgents/$(LABEL).plist

.PHONY: mac mac-debug mac-test mac-run mac-uninstall-server clean-mac

# Release build into mac/build/Quacksteps.app
mac:
	yarn install --frozen-lockfile
	mac/scripts/build-app.sh

# Debug build (faster to compile)
mac-debug:
	yarn install --frozen-lockfile
	mac/scripts/build-app.sh --debug

# Swift package tests plus the yarn workspace tests
mac-test:
	cd mac/Packages && swift test
	yarn test

# Build, then open the app
mac-run: mac
	open mac/build/Quacksteps.app

# Stop and remove the server's launchd agent (quit the app first)
mac-uninstall-server:
	-launchctl bootout gui/$$(id -u)/$(LABEL)
	rm -f "$(PLIST)"

# Remove build output
clean-mac:
	rm -rf mac/build mac/renderer/dist
	cd mac/Packages && swift package clean
