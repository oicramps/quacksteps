// M0 spike: proves the app can register quackd with launchd from an ad hoc signed build, and re-register after a move.
//
//   swift run quack-launchd-spike install <path-to-quackd> [args...]
//   swift run quack-launchd-spike status
//   swift run quack-launchd-spike uninstall
//
// Uses the label `com.polarsteps.quacksteps.server.spike` so it never collides with a real install.
import Foundation
import QuackClient

let label = "com.polarsteps.quacksteps.server.spike"
let logPath = FileManager.default.homeDirectoryForCurrentUser.appending(path: ".quack/logs/launchd-spike.log").path
var argv = CommandLine.arguments.dropFirst()
let verb = argv.popFirst() ?? "status"

func installer(program: String = "/usr/bin/true", arguments: [String] = []) -> LaunchAgentInstaller {
    LaunchAgentInstaller(
        label: label,
        program: URL(fileURLWithPath: program),
        arguments: arguments,
        extraKeys: ["StandardOutPath": logPath, "StandardErrorPath": logPath]
    )
}

do {
    switch verb {
    case "install":
        guard let program = argv.popFirst() else {
            print("usage: quack-launchd-spike install <path-to-quackd> [args...]")
            exit(2)
        }
        try FileManager.default.createDirectory(
            atPath: (logPath as NSString).deletingLastPathComponent, withIntermediateDirectories: true)
        let subject = installer(program: program, arguments: Array(argv))
        let outcome = try subject.ensureInstalled()
        print("\(outcome) -> \(subject.plistURL.path)")
    case "status":
        let subject = installer()
        print("plist:", subject.installedCommand().map { "\($0.program) \($0.arguments.joined(separator: " "))" } ?? "none")
        print("loaded:", subject.isLoaded())
        print("log:", logPath)
    case "uninstall":
        try installer().uninstall()
        print("uninstalled \(label)")
    default:
        print("unknown verb \(verb)")
        exit(2)
    }
} catch {
    print("error:", error)
    exit(1)
}
