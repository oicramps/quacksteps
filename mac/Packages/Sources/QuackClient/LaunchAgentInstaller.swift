import Foundation

/// Runs `launchctl` and reports its exit status and output. Injected so tests never touch the real launchd.
public protocol LaunchctlRunning: Sendable {
    func run(_ arguments: [String]) throws -> (status: Int32, output: String)
}

public struct SystemLaunchctl: LaunchctlRunning {
    public init() {}

    public func run(_ arguments: [String]) throws -> (status: Int32, output: String) {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/launchctl")
        process.arguments = arguments
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = pipe
        try process.run()
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        return (process.terminationStatus, String(decoding: data, as: UTF8.self))
    }
}

/// Writes and registers the per-user launch agent that keeps `quackd serve` running.
///
/// The app writes the plist itself instead of using `SMAppService.agent`, because that API needs
/// the app and helper signed with the same Apple-issued identity, and pilot builds are ad hoc signed.
/// The plist contents stay the same when builds move to Developer ID.
public struct LaunchAgentInstaller: Sendable {
    public enum Outcome: Equatable, Sendable {
        /// The plist already pointed at this program; nothing was touched.
        case upToDate
        /// No plist existed; it was written and bootstrapped.
        case installed
        /// The plist pointed elsewhere (the app moved, or arguments changed); it was rewritten and re-bootstrapped.
        case updated(previousProgram: String?)
    }

    public struct InstallError: Error, CustomStringConvertible {
        public let description: String
    }

    public static let defaultLabel = "com.polarsteps.quacksteps.server"

    public let label: String
    public let program: URL
    public let arguments: [String]
    public let launchAgentsDirectory: URL
    public let userID: uid_t
    /// Extra keys for spikes and diagnostics, such as `StandardOutPath`. Not part of the up-to-date comparison.
    public let extraKeys: [String: String]
    let launchctl: any LaunchctlRunning

    public init(
        label: String = LaunchAgentInstaller.defaultLabel,
        program: URL,
        arguments: [String] = ["serve"],
        launchAgentsDirectory: URL = FileManager.default.homeDirectoryForCurrentUser
            .appending(path: "Library/LaunchAgents", directoryHint: .isDirectory),
        userID: uid_t = getuid(),
        extraKeys: [String: String] = [:],
        launchctl: any LaunchctlRunning = SystemLaunchctl()
    ) {
        self.label = label
        self.program = program
        self.arguments = arguments
        self.launchAgentsDirectory = launchAgentsDirectory
        self.userID = userID
        self.extraKeys = extraKeys
        self.launchctl = launchctl
    }

    public var plistURL: URL { launchAgentsDirectory.appending(path: "\(label).plist") }
    var domain: String { "gui/\(userID)" }
    var serviceTarget: String { "\(domain)/\(label)" }

    /// The plist launchd reads. `ProgramArguments[0]` repeats the program, as launchd expects argv[0].
    public func plist() -> [String: Any] {
        var dict: [String: Any] = [
            "Label": label,
            "Program": program.path,
            "ProgramArguments": [program.path] + arguments,
            "RunAtLoad": true,
            // Restart after crashes and after the exit-1 drain used for upgrades; a clean exit 0 (second instance) stays down.
            "KeepAlive": ["SuccessfulExit": false],
            "ThrottleInterval": 10,
            "ProcessType": "Background",
        ]
        for (key, value) in extraKeys { dict[key] = value }
        return dict
    }

    /// The program and arguments in the plist on disk, or nil when there is none or it can't be read.
    public func installedCommand() -> (program: String, arguments: [String])? {
        guard let data = try? Data(contentsOf: plistURL),
              let dict = try? PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any],
              let installed = dict["Program"] as? String
        else { return nil }
        let argv = dict["ProgramArguments"] as? [String] ?? []
        return (installed, Array(argv.dropFirst()))
    }

    /// Makes the plist match this program and makes sure launchd has it loaded.
    @discardableResult
    public func ensureInstalled() throws -> Outcome {
        let current = installedCommand()
        let matches = current?.program == program.path && current?.arguments == arguments
        if matches, isLoaded() { return .upToDate }

        try writePlist()
        if current != nil || isLoaded() {
            // Unload whatever launchd holds for this label first; bootstrap refuses a loaded service.
            _ = try? launchctl.run(["bootout", serviceTarget])
        }
        let result = try launchctl.run(["bootstrap", domain, plistURL.path])
        // 37 / "service already loaded" can race with KeepAlive; anything else is a real failure.
        guard result.status == 0 || result.output.contains("already") else {
            throw InstallError(description: "launchctl bootstrap failed (\(result.status)): \(result.output)")
        }
        if current == nil { return .installed }
        return matches ? .installed : .updated(previousProgram: current?.program)
    }

    /// Unloads the service and deletes the plist. Used by the spike and by a future "Uninstall" action.
    public func uninstall() throws {
        _ = try? launchctl.run(["bootout", serviceTarget])
        if FileManager.default.fileExists(atPath: plistURL.path) {
            try FileManager.default.removeItem(at: plistURL)
        }
    }

    public func isLoaded() -> Bool {
        (try? launchctl.run(["print", serviceTarget]).status) == 0
    }

    func writePlist() throws {
        try FileManager.default.createDirectory(at: launchAgentsDirectory, withIntermediateDirectories: true)
        let data = try PropertyListSerialization.data(fromPropertyList: plist(), format: .xml, options: 0)
        try data.write(to: plistURL, options: .atomic)
    }
}
