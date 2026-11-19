import AppKit
import QuackClient
import QuackProtocol
import QuackStores
import QuackUI
import ServiceManagement
import SwiftUI

/// One main window, IDE style: the inbox sidebar on the left and tabs (Inbox, then one per PR) in the
/// main area. First run shows inside it too. Settings is the only other window.
@main
struct QuackstepsApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate

    var body: some Scene {
        Window("Quacksteps", id: "main") {
            MainWindow(model: delegate.model, workspace: delegate.workspace)
                .background(LaunchRouter(delegate: delegate))
        }
        .defaultSize(width: 1240, height: 820)
        .commands { AppCommands(model: delegate.model, workspace: delegate.workspace) }

        MenuBarExtra {
            MenuContent(delegate: delegate)
        } label: {
            MenuBarLabel(model: delegate.model, showCount: delegate.prefs.showCountInMenuBar)
        }
        .menuBarExtraStyle(.window)

        Settings {
            SettingsView(model: delegate.model, prefs: delegate.prefs)
        }
    }
}

private struct MainWindow: View {
    let model: AppModel
    let workspace: Workspace
    @Environment(\.openSettings) private var openSettings

    var body: some View {
        Group {
            if workspace.onboarded {
                // "Manage accounts…" opens Settings, whose first tab is Repos.
                InboxView(model: model, workspace: workspace, openPR: { workspace.open($0) }, openSetup: { workspace.onboarded = false }, openAccounts: { openSettings() })
            } else {
                FirstRunView(model: model) {
                    workspace.onboarded = true
                    // The spec: ask to open at login after first run, so the menu bar count and notifications
                    // start at login. An unsigned build may be refused; Settings › Server explains the fallback.
                    if SMAppService.mainApp.status != .enabled { try? SMAppService.mainApp.register() }
                }
                    .frame(maxWidth: 780)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .frame(minWidth: 860, minHeight: 520)
    }
}

private struct MenuContent: View {
    let delegate: AppDelegate
    @Environment(\.openSettings) private var openSettings

    var body: some View {
        MenuPanel(
            model: delegate.model,
            openPR: { delegate.show(pr: $0) },
            openInbox: { delegate.show(pr: nil) },
            openSettings: {
                openSettings()
                NSApp.activate()
            }
        )
    }
}

/// Hands the main window's opener to the app delegate, so menu bar rows and notification taps can
/// bring the window back after it was closed.
private struct LaunchRouter: View {
    let delegate: AppDelegate
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        Color.clear.onAppear {
            delegate.openMainWindow = { openWindow(id: "main") }
        }
    }
}

private struct AppCommands: Commands {
    let model: AppModel
    let workspace: Workspace
    @Environment(\.openWindow) private var openWindow

    var body: some Commands {
        CommandGroup(after: .toolbar) {
            Button("Refresh from GitHub") { Task { await model.refresh() } }
                .keyboardShortcut("r")
        }
        CommandGroup(before: .windowList) {
            Button("Inbox") {
                workspace.selected = .inbox
                openWindow(id: "main")
            }
            .keyboardShortcut("1")
            Button("Show next tab") { workspace.selectNext(1) }
                .keyboardShortcut("]", modifiers: [.command, .shift])
            Button("Show previous tab") { workspace.selectNext(-1) }
                .keyboardShortcut("[", modifiers: [.command, .shift])
            Button("Close tab") { workspace.closeSelected() }
                .keyboardShortcut("w", modifiers: [.command, .option])
            Divider()
        }
    }
}
