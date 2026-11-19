import Foundation
import QuackProtocol
import Synchronization
import Testing
@testable import QuackClient

@Test func framesSplitAndJoinAcrossReads() throws {
    var decoder = FrameDecoder()
    let a = FrameDecoder.encode(Data(#"{"type":"ack","requestId":"1"}"#.utf8))
    let b = FrameDecoder.encode(Data(#"{"type":"ack","requestId":"2"}"#.utf8))
    let all = a + b
    #expect(try decoder.push(all.prefix(3)).isEmpty)
    let first = try decoder.push(all.dropFirst(3).prefix(a.count))
    #expect(first.count == 1)
    let rest = try decoder.push(all.dropFirst(3 + a.count))
    #expect(rest.count == 1)
    #expect(String(decoding: rest[0], as: UTF8.self).contains("\"2\""))
}

@Test func oversizedFramesAreRefused() {
    var decoder = FrameDecoder()
    #expect(throws: RequestError.self) { try decoder.push(Data([0xff, 0xff, 0xff, 0x7f])) }
}

@Test func requestsFailFastWhileDisconnected() async {
    let conn = ServerConnection(socketPath: "/nonexistent/q.sock", clientVersion: "0.0.1") { _ in }
    await #expect(throws: RequestError.self) { _ = try await conn.request(.settings) }
}

// MARK: - Against a real quackd

private let repoRoot = URL(filePath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    .deletingLastPathComponent().deletingLastPathComponent()

private func bunPath() -> String? {
    for p in ["\(NSHomeDirectory())/.bun/bin/bun", "/opt/homebrew/bin/bun", "/usr/local/bin/bun"] where FileManager.default.isExecutableFile(atPath: p) { return p }
    let which = Process()
    which.executableURL = URL(filePath: "/usr/bin/which")
    which.arguments = ["bun"]
    let out = Pipe()
    which.standardOutput = out
    try? which.run()
    which.waitUntilExit()
    let path = String(decoding: out.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
    return path.isEmpty ? nil : path
}

private final class Statuses: Sendable {
    let all = Mutex<[ConnectionStatus]>([])
    func add(_ s: ConnectionStatus) { all.withLock { $0.append(s) } }
    var connected: Bool { all.withLock { $0.contains { if case .connected = $0 { true } else { false } } } }
}

@Test(.timeLimit(.minutes(1))) func talksToARealServer() async throws {
    guard let bun = bunPath() else { return }
    // A short temporary HOME keeps the socket path under macOS's 104-byte limit and the real ~/.quack untouched.
    let home = URL(filePath: "/tmp").appending(path: "qs-\(UUID().uuidString.prefix(8))")
    try FileManager.default.createDirectory(at: home, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: home) }

    let server = Process()
    server.executableURL = URL(filePath: bun)
    server.arguments = [repoRoot.appending(path: "companion/src/main.ts").path, "serve"]
    server.environment = ["HOME": home.path, "PATH": "/usr/bin:/bin:/opt/homebrew/bin"]
    try server.run()
    defer { if server.isRunning { server.terminate() } }

    let socket = home.appending(path: ".quack/run/quack.sock").path
    let statuses = Statuses()
    let conn = ServerConnection(socketPath: socket, clientVersion: "0.2.6") { statuses.add($0) }
    conn.start()
    for _ in 0 ..< 100 where !statuses.connected { try await Task.sleep(for: .milliseconds(100)) }
    #expect(statuses.connected)
    guard case let .connected(hello) = conn.status else { return }
    #expect(hello.protocol == socketProtocolVersion)
    #expect(hello.capabilities.review)

    guard case let .settings(settings) = try await conn.request(.settings) else { Issue.record("expected settings"); return }
    #expect(settings.settings.retentionDays == 7)
    #expect(settings.server.socketPath == socket)

    // A subscription yields until it is cancelled.
    var agents: AgentsMessage?
    for try await m in conn.stream(.subscribe(.agents)) {
        if case let .agents(a) = m, a.pending.isEmpty { agents = a; break }
    }
    #expect(agents?.agents.count == AgentId.allCases.count)

    // Errors come back as thrown ServerErrors with the server's code.
    await #expect(throws: RequestError.self) { _ = try await conn.request(.saveSettings(SettingsPatch(retentionDays: 0))) }

    guard case .ack = try await conn.request(.shutdown) else { Issue.record("expected ack"); return }
    conn.stop()
}
