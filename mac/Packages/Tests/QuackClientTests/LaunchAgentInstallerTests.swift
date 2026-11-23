import Foundation
import Testing
@testable import QuackClient

/// Records launchctl calls and simulates whether the service is loaded.
final class FakeLaunchctl: LaunchctlRunning, @unchecked Sendable {
    private let lock = NSLock()
    private var _calls: [[String]] = []
    private var _loaded = false

    var calls: [[String]] { lock.withLock { _calls } }
    var loaded: Bool {
        get { lock.withLock { _loaded } }
        set { lock.withLock { _loaded = newValue } }
    }

    func run(_ arguments: [String]) throws -> (status: Int32, output: String) {
        lock.withLock {
            _calls.append(arguments)
            switch arguments.first {
            case "print": return (_loaded ? 0 : 113, "")
            case "bootstrap": _loaded = true; return (0, "")
            case "bootout": _loaded = false; return (0, "")
            default: return (0, "")
            }
        }
    }
}

@Suite struct LaunchAgentInstallerTests {
    let dir = FileManager.default.temporaryDirectory.appending(path: "quack-launchd-\(UUID().uuidString)")

    func installer(_ program: String, _ launchctl: FakeLaunchctl) -> LaunchAgentInstaller {
        LaunchAgentInstaller(
            program: URL(fileURLWithPath: program),
            launchAgentsDirectory: dir,
            userID: 501,
            launchctl: launchctl
        )
    }

    @Test func firstRunWritesThePlistAndBootstraps() throws {
        let launchctl = FakeLaunchctl()
        let outcome = try installer("/Applications/Quacksteps.app/Contents/MacOS/quackd", launchctl).ensureInstalled()
        #expect(outcome == .installed)

        let data = try Data(contentsOf: dir.appending(path: "com.polarsteps.quacksteps.server.plist"))
        let plist = try #require(try PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any])
        #expect(plist["Program"] as? String == "/Applications/Quacksteps.app/Contents/MacOS/quackd")
        #expect(plist["ProgramArguments"] as? [String] == ["/Applications/Quacksteps.app/Contents/MacOS/quackd", "serve"])
        #expect(plist["RunAtLoad"] as? Bool == true)
        #expect((plist["KeepAlive"] as? [String: Bool])?["SuccessfulExit"] == false)
        #expect(plist["ThrottleInterval"] as? Int == 10)
        #expect(launchctl.calls.contains(["bootstrap", "gui/501", dir.appending(path: "com.polarsteps.quacksteps.server.plist").path]))
    }

    @Test func aSecondLaunchFromTheSamePlaceChangesNothing() throws {
        let launchctl = FakeLaunchctl()
        let program = "/Applications/Quacksteps.app/Contents/MacOS/quackd"
        try installer(program, launchctl).ensureInstalled()
        let before = launchctl.calls.count
        #expect(try installer(program, launchctl).ensureInstalled() == .upToDate)
        #expect(launchctl.calls.dropFirst(before).allSatisfy { $0.first == "print" })
    }

    @Test func movingTheAppRewritesTheplistAndReloads() throws {
        let launchctl = FakeLaunchctl()
        try installer("/Users/me/Downloads/Quacksteps.app/Contents/MacOS/quackd", launchctl).ensureInstalled()
        let moved = installer("/Applications/Quacksteps.app/Contents/MacOS/quackd", launchctl)
        let outcome = try moved.ensureInstalled()
        #expect(outcome == .updated(previousProgram: "/Users/me/Downloads/Quacksteps.app/Contents/MacOS/quackd"))
        #expect(moved.installedCommand()?.program == "/Applications/Quacksteps.app/Contents/MacOS/quackd")
        let verbs = launchctl.calls.map(\.[0])
        #expect(verbs.suffix(2) == ["bootout", "bootstrap"])
    }

    @Test func aPlistLaunchdHasUnloadedIsBootstrappedAgain() throws {
        let launchctl = FakeLaunchctl()
        let program = "/Applications/Quacksteps.app/Contents/MacOS/quackd"
        try installer(program, launchctl).ensureInstalled()
        launchctl.loaded = false
        #expect(try installer(program, launchctl).ensureInstalled() == .installed)
        #expect(launchctl.loaded)
    }

    @Test func uninstallRemovesThePlist() throws {
        let launchctl = FakeLaunchctl()
        let subject = installer("/Applications/Quacksteps.app/Contents/MacOS/quackd", launchctl)
        try subject.ensureInstalled()
        try subject.uninstall()
        #expect(!FileManager.default.fileExists(atPath: subject.plistURL.path))
        #expect(!launchctl.loaded)
    }
}
