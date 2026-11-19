import Foundation
import QuackProtocol
import Synchronization

/// Where the connection to quackd stands. The app shows "The server went quiet." while not connected.
public enum ConnectionStatus: Sendable, Equatable {
    case connecting
    case connected(HelloResponse)
    /// Not connected; `reason` says why. A retry is scheduled.
    case disconnected(reason: String)
}

public struct RequestError: Error, Sendable, CustomStringConvertible {
    public var code: ErrorCode
    public var message: String
    public var fixSteps: [FixStep]
    public var description: String { message }
}

/// Splits the socket stream into messages: a 32-bit little-endian length, then that many bytes of JSON.
public struct FrameDecoder: Sendable {
    public static let maxFrame = 64 * 1024 * 1024
    private var buffer = Data()

    public init() {}

    public mutating func push(_ data: Data) throws -> [Data] {
        buffer.append(data)
        var frames: [Data] = []
        while buffer.count >= 4 {
            let start = buffer.startIndex
            let length = Int(buffer[start]) | Int(buffer[start + 1]) << 8 | Int(buffer[start + 2]) << 16 | Int(buffer[start + 3]) << 24
            guard length <= Self.maxFrame else { throw RequestError(code: .badRequest, message: "frame of \(length) bytes is too large", fixSteps: []) }
            guard buffer.count >= 4 + length else { break }
            frames.append(buffer.subdata(in: start + 4 ..< start + 4 + length))
            buffer.removeSubrange(start ..< start + 4 + length)
        }
        return frames
    }

    public static func encode(_ json: Data) -> Data {
        var length = UInt32(json.count).littleEndian
        var out = Data(bytes: &length, count: 4)
        out.append(json)
        return out
    }
}

/// One long-lived connection to quackd's Unix socket, shared by the whole app.
///
/// - `request` sends and waits for the first reply.
/// - `stream` sends and yields every message with that request id (subscriptions, asks). Ending the
///   stream unsubscribes (or cancels the ask). Subscriptions are re-sent after a reconnect.
public final class ServerConnection: Sendable {
    public let socketPath: String
    private let clientVersion: String
    private let onStatus: @Sendable (ConnectionStatus) -> Void
    private let writeQueue = DispatchQueue(label: "quacksteps.socket.write")
    private let state = Mutex(Inner())

    private struct Inner {
        var fd: Int32 = -1
        var handle: FileHandle?
        var decoder = FrameDecoder()
        var status: ConnectionStatus = .connecting
        var handlers: [String: AsyncThrowingStream<ServerMessage, Error>.Continuation] = [:]
        /// Live subscriptions, re-sent after every reconnect.
        var subscriptions: [String: AppRequest] = [:]
        var nextId = 0
        var retryDelay: TimeInterval = 0.5
        var stopped = false
        var started = false
    }

    public init(socketPath: String, clientVersion: String, onStatus: @escaping @Sendable (ConnectionStatus) -> Void) {
        self.socketPath = socketPath
        self.clientVersion = clientVersion
        self.onStatus = onStatus
    }

    public var status: ConnectionStatus { state.withLock { $0.status } }

    /// Connects, and keeps reconnecting until `stop`.
    public func start() {
        let first = state.withLock { s -> Bool in
            defer { s.started = true }
            return !s.started
        }
        if first { connect() }
    }

    public func stop() {
        state.withLock { $0.stopped = true }
        disconnect(reason: "stopped", retry: false)
    }

    /// Drops the connection now and reconnects (Re-check, or after the server was restarted).
    public func reconnect() {
        disconnect(reason: "reconnecting", retry: false)
        state.withLock { $0.retryDelay = 0.5 }
        connect()
    }

    // MARK: Requests

    /// Sends and returns the first reply. An `event` error reply is thrown as `RequestError`.
    public func request(_ request: AppRequest, timeout: Duration = .seconds(60)) async throws -> ServerMessage {
        let messages = stream(request, keepAlive: false)
        return try await withThrowingTaskGroup(of: ServerMessage.self) { group in
            group.addTask {
                for try await m in messages {
                    if case let .event(e) = m, case let .error(err) = e.event {
                        throw RequestError(code: err.code, message: err.message, fixSteps: err.fixSteps ?? [])
                    }
                    return m
                }
                throw RequestError(code: .cancelled, message: "The server closed the connection.", fixSteps: [])
            }
            group.addTask {
                try await Task.sleep(for: timeout)
                throw RequestError(code: .timeout, message: "The server didn't answer.", fixSteps: [])
            }
            defer { group.cancelAll() }
            return try await group.next()!
        }
    }

    /// Sends and yields every message for this request. Subscriptions survive reconnects; asks end with
    /// an error when the connection drops (the server aborts them too).
    public func stream(_ request: AppRequest, keepAlive: Bool = true) -> AsyncThrowingStream<ServerMessage, Error> {
        let id = nextRequestId()
        let (stream, continuation) = AsyncThrowingStream.makeStream(of: ServerMessage.self, throwing: Error.self)
        let isSubscription = if case .subscribe = request { true } else { false }
        let connected = state.withLock { s -> Bool in
            s.handlers[id] = continuation
            if isSubscription && keepAlive { s.subscriptions[id] = request }
            if case .connected = s.status { return true }
            return false
        }
        continuation.onTermination = { [weak self] _ in
            guard let self else { return }
            let wasSubscribed = self.state.withLock { s -> Bool in
                s.handlers[id] = nil
                return s.subscriptions.removeValue(forKey: id) != nil
            }
            // One-shot subscriptions (keepAlive: false) are unsubscribed too, so the server stops pushing.
            if wasSubscribed || isSubscription { self.send(.unsubscribe, id: id) }
            if case .ask = request { self.send(.cancel, id: id) }
        }
        if connected {
            send(request, id: id)
        } else if !isSubscription {
            // Subscriptions wait for the connection; one-off requests fail fast so the UI can say why.
            continuation.finish(throwing: RequestError(code: .cancelled, message: "Quacksteps can't reach its server.", fixSteps: []))
        }
        return stream
    }

    private func nextRequestId() -> String {
        state.withLock { s in
            s.nextId += 1
            return "app-\(s.nextId)"
        }
    }

    private func send(_ request: AppRequest, id: String) {
        guard let json = try? JSONSerialization.data(withJSONObject: request.json(requestId: id)) else { return }
        let frame = FrameDecoder.encode(json)
        let fd = state.withLock { $0.fd }
        guard fd >= 0 else { return }
        writeQueue.async {
            frame.withUnsafeBytes { raw in
                var offset = 0
                while offset < raw.count {
                    let n = Darwin.write(fd, raw.baseAddress! + offset, raw.count - offset)
                    if n <= 0 {
                        if errno == EINTR { continue }
                        return
                    }
                    offset += n
                }
            }
        }
    }

    // MARK: Connection

    private func setStatus(_ status: ConnectionStatus) {
        let changed = state.withLock { s -> Bool in
            defer { s.status = status }
            return s.status != status
        }
        if changed { onStatus(status) }
    }

    private func connect() {
        if state.withLock({ $0.stopped || $0.fd >= 0 }) { return }
        setStatus(.connecting)
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { return scheduleRetry(reason: "socket() failed") }
        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX)
        let path = Array(socketPath.utf8)
        guard path.count < MemoryLayout.size(ofValue: addr.sun_path) else {
            close(fd)
            return scheduleRetry(reason: "socket path too long")
        }
        withUnsafeMutableBytes(of: &addr.sun_path) { buf in
            buf.copyBytes(from: path)
            buf[path.count] = 0
        }
        let ok = withUnsafePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
        }
        guard ok == 0 else {
            let reason = errno == ENOENT ? "no socket at \(socketPath)" : String(cString: strerror(errno))
            close(fd)
            return scheduleRetry(reason: reason)
        }
        var noSigPipe: Int32 = 1
        setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &noSigPipe, socklen_t(MemoryLayout<Int32>.size))

        let handle = FileHandle(fileDescriptor: fd, closeOnDealloc: false)
        state.withLock { s in
            s.fd = fd
            s.handle = handle
            s.decoder = FrameDecoder()
        }
        handle.readabilityHandler = { [weak self] h in
            let data = h.availableData
            guard let self else { return }
            if data.isEmpty { return self.disconnect(reason: "the server closed the connection", retry: true) }
            self.received(data)
        }
        // hello first; everything else waits for its reply.
        send(.hello(clientVersion: clientVersion), id: "hello")
    }

    private func received(_ data: Data) {
        let frames: [Data]
        do {
            frames = try state.withLock { try $0.decoder.push(data) }
        } catch {
            return disconnect(reason: "\(error)", retry: true)
        }
        for frame in frames {
            guard let message = try? JSONDecoder().decode(ServerMessage.self, from: frame) else { continue }
            if case let .hello(hello) = message, message.requestId == "hello" {
                let resubscribe = state.withLock { s -> [(String, AppRequest)] in
                    s.retryDelay = 0.5
                    return Array(s.subscriptions)
                }
                setStatus(.connected(hello))
                for (id, request) in resubscribe { send(request, id: id) }
                continue
            }
            guard let id = message.requestId else { continue }
            let handler = state.withLock { $0.handlers[id] }
            handler?.yield(message)
        }
    }

    private func disconnect(reason: String, retry: Bool) {
        let (handle, fd, orphans) = state.withLock { s -> (FileHandle?, Int32, [AsyncThrowingStream<ServerMessage, Error>.Continuation]) in
            let out = (s.handle, s.fd, s.handlers.filter { s.subscriptions[$0.key] == nil }.map(\.value))
            for id in s.handlers.keys where s.subscriptions[id] == nil { s.handlers[id] = nil }
            s.handle = nil
            s.fd = -1
            return out
        }
        handle?.readabilityHandler = nil
        if fd >= 0 { close(fd) }
        // In-flight one-off requests and asks can't survive a reconnect.
        for c in orphans { c.finish(throwing: RequestError(code: .cancelled, message: "Lost the connection to the server.", fixSteps: [])) }
        if retry { scheduleRetry(reason: reason) } else { setStatus(.disconnected(reason: reason)) }
    }

    private func scheduleRetry(reason: String) {
        let delay = state.withLock { s -> TimeInterval? in
            if s.stopped { return nil }
            defer { s.retryDelay = min(s.retryDelay * 2, 10) }
            return s.retryDelay
        }
        setStatus(.disconnected(reason: reason))
        guard let delay else { return }
        DispatchQueue.global().asyncAfter(deadline: .now() + delay) { [weak self] in self?.connect() }
    }
}
