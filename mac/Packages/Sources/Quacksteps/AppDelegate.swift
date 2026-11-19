import AppKit
import QuackClient
import QuackProtocol
import QuackStores
import QuackUI
import UserNotifications

/// Owns the model, registers quackd with launchd, upgrades a stale server, and turns inbox events into notifications.
@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    static let socketPath = FileManager.default.homeDirectoryForCurrentUser.appending(path: ".quack/run/quack.sock").path

    /// The app's version; the bundled quackd carries the same one.
    static let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "dev"

    let model = AppModel(socketPath: AppDelegate.socketPath, clientVersion: AppDelegate.version)
    let prefs = NotificationPrefs()
    let workspace = Workspace()
    /// Set by the main window; reopens it after it was closed.
    var openMainWindow: (() -> Void)?
    private var notifications: Notifications?
    private var askedServerToUpgrade = false

    /// quackd inside the app bundle. Absent when running from `swift run` (then a dev server is used).
    private var bundledServer: URL? {
        let url = Bundle.main.bundleURL.appending(path: "Contents/MacOS/quackd")
        return FileManager.default.isExecutableFile(atPath: url.path) ? url : nil
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        QuackFont.register(from: Bundle.main.resourceURL?.appending(path: "Fonts"))
        installServer()

        model.onHello = { [weak self] hello in self?.checkServerVersion(hello) }
        if Bundle.main.bundleIdentifier != nil {
            let n = Notifications(model: model, prefs: prefs) { [weak self] pr in self?.show(pr: pr) }
            notifications = n
            // Hidden repos don't notify either.
            model.onEvents = { [weak self] events, items in
                guard let model = self?.model else { return }
                n.post(events.filter { e in !model.isRepoHidden("\(e.pr.owner)/\(e.pr.repo)") }, items: items)
            }
        }
        model.start()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

    /// Brings the main window forward, on the PR's tab (opened if needed) or on the Inbox.
    func show(pr: PrKey?) {
        if let pr { workspace.open(pr) } else { workspace.selected = .inbox }
        if let window = NSApp.windows.first(where: { $0.identifier?.rawValue.hasPrefix("main") == true && $0.isVisible }) {
            window.makeKeyAndOrderFront(nil)
        } else {
            openMainWindow?()
        }
        NSApp.activate()
    }

    /// Clicking the Dock icon with no window open brings the main window back.
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if !flag { show(pr: nil) }
        return true
    }

    /// Writes (or rewrites, after a move) the launchd plist pointing at the bundled quackd.
    private func installServer() {
        guard let server = bundledServer else { return }
        do {
            let outcome = try LaunchAgentInstaller(program: server).ensureInstalled()
            NSLog("Quacksteps: server launch agent \(outcome)")
        } catch {
            NSLog("Quacksteps: could not register the server: \(error)")
            model.actionError = "Couldn't register the Quack server with launchd: \(error)"
        }
    }

    /// An older server from a previous version: ask it to drain and exit 1, so launchd starts the new binary.
    private func checkServerVersion(_ hello: HelloResponse) {
        guard bundledServer != nil, hello.version != Self.version, !askedServerToUpgrade else { return }
        askedServerToUpgrade = true
        NSLog("Quacksteps: server is \(hello.version), app is \(Self.version); restarting the server")
        Task { await model.restartServer() }
    }
}
