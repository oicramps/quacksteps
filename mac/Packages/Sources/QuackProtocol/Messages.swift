import Foundation

// Swift mirror of shared/src/protocol.ts (socket protocol v2). Hand-written, and kept honest by
// decoding shared/fixtures/messages.json in QuackProtocolTests: change both sides together.

public let socketProtocolVersion = 2

// MARK: - Basics

public struct PrKey: Codable, Hashable, Sendable, CustomStringConvertible {
    public var owner: String
    public var repo: String
    public var number: Int

    public init(owner: String, repo: String, number: Int) {
        self.owner = owner
        self.repo = repo
        self.number = number
    }

    /// Case-insensitive identity, as the server keys reviews.
    public var id: String { "\(owner)/\(repo)#\(number)".lowercased() }
    public var description: String { "\(owner)/\(repo)#\(number)" }
    public var githubURL: URL { URL(string: "https://github.com/\(owner)/\(repo)/pull/\(number)")! }
}

public enum AgentId: String, Codable, Sendable, CaseIterable, Hashable {
    case cursor
    case claudeCode = "claude-code"
}

public struct FixStep: Codable, Hashable, Sendable {
    public var text: String
    public var command: String?
    public init(text: String, command: String? = nil) {
        self.text = text
        self.command = command
    }
}

/// Server error codes. A struct, not an enum, so a newer server's code never breaks decoding.
public struct ErrorCode: RawRepresentable, Codable, Hashable, Sendable {
    public var rawValue: String
    public init(rawValue: String) { self.rawValue = rawValue }
    public init(from decoder: Decoder) throws { rawValue = try decoder.singleValueContainer().decode(String.self) }
    public func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        try c.encode(rawValue)
    }

    public static let badRequest = ErrorCode(rawValue: "bad_request")
    public static let repoNotFound = ErrorCode(rawValue: "repo_not_found")
    public static let fetchFailed = ErrorCode(rawValue: "fetch_failed")
    public static let agentNotInstalled = ErrorCode(rawValue: "agent_not_installed")
    public static let agentNotLoggedIn = ErrorCode(rawValue: "agent_not_logged_in")
    public static let timeout = ErrorCode(rawValue: "timeout")
    public static let cancelled = ErrorCode(rawValue: "cancelled")
    public static let agentFailed = ErrorCode(rawValue: "agent_failed")
    public static let versionMismatch = ErrorCode(rawValue: "version_mismatch")
    public static let ghUnavailable = ErrorCode(rawValue: "gh_unavailable")
    public static let ghNotLoggedIn = ErrorCode(rawValue: "gh_not_logged_in")
    public static let ghSsoRequired = ErrorCode(rawValue: "gh_sso_required")
    public static let rateLimited = ErrorCode(rawValue: "rate_limited")
    public static let serverBusy = ErrorCode(rawValue: "server_busy")
    public static let notImplemented = ErrorCode(rawValue: "not_implemented")
}

public struct ServerError: Codable, Hashable, Sendable {
    public var code: ErrorCode
    public var message: String
    public var fixSteps: [FixStep]?

    public init(code: ErrorCode, message: String, fixSteps: [FixStep]? = nil) {
        self.code = code
        self.message = message
        self.fixSteps = fixSteps
    }
}

public struct AgentStatus: Codable, Hashable, Sendable, Identifiable {
    public enum State: String, Codable, Sendable { case ready, notLoggedIn = "not_logged_in", notInstalled = "not_installed" }
    public var id: AgentId
    public var label: String
    public var state: State
    public var version: String?
    /// Where the CLI was found.
    public var path: String?
    /// "" means the tool's default model.
    public var models: [String]
    public var fixSteps: [FixStep]
}

public struct CodeSelection: Codable, Hashable, Sendable {
    public enum Side: String, Codable, Sendable { case old, new }
    public var path: String?
    public var fileAnchor: String?
    public var side: Side?
    public var startLine: Int?
    public var endLine: Int?
    public var text: String?

    public init(path: String? = nil, side: Side? = nil, startLine: Int? = nil, endLine: Int? = nil, text: String? = nil) {
        self.path = path
        self.side = side
        self.startLine = startLine
        self.endLine = endLine
        self.text = text
    }
}

// MARK: - Inbox

public enum AuthorState: String, Codable, Sendable, CaseIterable {
    case waitingOnReviewers = "waiting_on_reviewers"
    case waitingOnMe = "waiting_on_me"
    case blockedByCI = "blocked_by_ci"
    case readyToMerge = "ready_to_merge"
}

public enum ReviewStep: String, Codable, Sendable {
    case findingClone = "finding_clone", fetching, checkingOut = "checking_out", labeling
}

public struct ReviewState: Codable, Hashable, Sendable {
    public enum Phase: String, Codable, Sendable { case preparing, ready, stale, failed }
    public enum Labels: String, Codable, Sendable { case none, running, ready, failed }
    public var startedAt: String
    public var headSha: String
    public var latestHeadSha: String
    public var worktreePath: String
    public var phase: Phase
    public var step: ReviewStep?
    public var labels: Labels
    public var error: String?
    public var fixSteps: [FixStep]?
    /// Set when the PR was merged or closed; the review ends a day later.
    public var closed: ClosedInfo?
    /// While stale: how many commits the PR's latest head is ahead of the reviewed one.
    public var newCommits: Int?
}

public struct ClosedInfo: Codable, Hashable, Sendable {
    public enum State: String, Codable, Sendable { case merged, closed }
    public var state: State
    public var at: String
    /// Who merged it, when GitHub says.
    public var by: String?
}

public enum CIState: String, Codable, Sendable { case passing, failing, pending, none }

public struct InboxItem: Codable, Hashable, Sendable, Identifiable {
    public enum Role: String, Codable, Sendable { case reviewer, author }

    public struct Reviewer: Codable, Hashable, Sendable {
        public enum Via: String, Codable, Sendable { case user, team }
        public var requestedAt: String
        public var via: Via
        public var team: String?
        /// `false` when I already reviewed but am still reviewing here; absent means requested.
        public var requested: Bool?
        /// Other reviewers who already approved: the request isn't waiting on me.
        public var approvedBy: [String]?
        public var isRequested: Bool { requested != false }
        public var isApprovedByOthers: Bool { !(approvedBy ?? []).isEmpty }
    }

    public struct Author: Codable, Hashable, Sendable {
        /// nil for drafts.
        public var state: AuthorState?
        public var since: String
        public var reasons: [String]
    }

    public var pr: PrKey
    public var title: String
    public var url: String
    public var authorLogin: String
    public var isDraft: Bool
    public var headSha: String
    public var baseRef: String
    public var updatedAt: String
    public var additions: Int
    public var deletions: Int
    public var role: Role
    public var reviewer: Reviewer?
    public var author: Author?
    public var ci: CIState
    public var review: ReviewState?
    /// Set when the PR is part of a stack of PRs.
    public var stack: StackInfo?
    /// Whether the repo belongs to an organization or a person.
    public var ownerType: OwnerType?

    public enum OwnerType: String, Codable, Sendable { case org, user }

    public var id: String { "\(role.rawValue):\(pr.id)" }
}

/// A PR's place in a stack of PRs, bottom (1) to top (size).
public struct StackInfo: Codable, Hashable, Sendable {
    public struct Parent: Codable, Hashable, Sendable {
        public var number: Int
        public var title: String
    }
    public var position: Int
    public var size: Int
    /// The PR this one sits on top of, if any.
    public var parent: Parent?
}

public enum InboxEvent: Codable, Hashable, Sendable {
    case reviewRequested(pr: PrKey)
    case stateChanged(pr: PrKey, from: AuthorState?, to: AuthorState?)
    case ciFailed(pr: PrKey, headSha: String)
    case newCommits(pr: PrKey, headSha: String)

    private enum CodingKeys: String, CodingKey { case kind, pr, from, to, headSha }

    public var pr: PrKey {
        switch self {
        case let .reviewRequested(pr), let .stateChanged(pr, _, _), let .ciFailed(pr, _), let .newCommits(pr, _): pr
        }
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let pr = try c.decode(PrKey.self, forKey: .pr)
        switch try c.decode(String.self, forKey: .kind) {
        case "review_requested": self = .reviewRequested(pr: pr)
        case "state_changed": self = .stateChanged(pr: pr, from: try c.decodeIfPresent(AuthorState.self, forKey: .from), to: try c.decodeIfPresent(AuthorState.self, forKey: .to))
        case "ci_failed": self = .ciFailed(pr: pr, headSha: try c.decode(String.self, forKey: .headSha))
        case "new_commits": self = .newCommits(pr: pr, headSha: try c.decode(String.self, forKey: .headSha))
        case let kind: throw DecodingError.dataCorruptedError(forKey: .kind, in: c, debugDescription: "unknown inbox event \(kind)")
        }
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(pr, forKey: .pr)
        switch self {
        case .reviewRequested: try c.encode("review_requested", forKey: .kind)
        case let .stateChanged(_, from, to):
            try c.encode("state_changed", forKey: .kind)
            try c.encode(from, forKey: .from)
            try c.encode(to, forKey: .to)
        case let .ciFailed(_, sha):
            try c.encode("ci_failed", forKey: .kind)
            try c.encode(sha, forKey: .headSha)
        case let .newCommits(_, sha):
            try c.encode("new_commits", forKey: .kind)
            try c.encode(sha, forKey: .headSha)
        }
    }
}

public struct InboxMessage: Codable, Hashable, Sendable {
    public struct More: Codable, Hashable, Sendable {
        public var reviewer: Int
        public var author: Int
    }
    public var requestId: String
    /// "" until the first poll.
    public var fetchedAt: String
    public var items: [InboxItem]
    public var events: [InboxEvent]
    public var more: More?
    public var error: ServerError?
}

// MARK: - Labels, diffs, threads

public struct FileRisk: Codable, Hashable, Sendable, Identifiable {
    public enum Risk: String, Codable, Sendable, CaseIterable { case high, medium, low, unlabeled }
    public enum Source: String, Codable, Sendable { case agent, rule }
    public var path: String
    public var risk: Risk
    public var reason: String
    public var rank: Int
    public var source: Source
    public var id: String { path }
}

public struct RiskLabelsMessage: Codable, Hashable, Sendable {
    public enum Status: String, Codable, Sendable { case running, ready, failed }
    public var requestId: String
    public var pr: PrKey
    public var headSha: String
    public var status: Status
    public var agent: AgentId
    public var model: String
    public var generatedAt: String?
    public var files: [FileRisk]
    public var previousHeadSha: String?
    public var queued: Bool?
    /// While running: when the job started, how many files go to the agent, and what it did last.
    public var progress: Progress?
    public var error: String?

    public struct Progress: Codable, Hashable, Sendable {
        public var startedAt: String
        public var agentFiles: Int
        public var activity: [String]
    }
}

public struct PrDiffFile: Codable, Hashable, Sendable, Identifiable {
    public enum Status: String, Codable, Sendable { case added, modified, deleted, renamed }
    public var path: String
    public var oldPath: String?
    public var status: Status
    public var additions: Int
    public var deletions: Int
    public var binary: Bool
    public var patch: String?
    public var truncated: Bool
    public var id: String { path }
}

public struct PrDiffMessage: Codable, Hashable, Sendable {
    public var requestId: String
    public var pr: PrKey
    public var baseSha: String
    public var headSha: String
    public var files: [PrDiffFile]
}

public struct StoredTurn: Codable, Hashable, Sendable {
    public var question: String
    public var answer: String
    public var agent: AgentId
    public var model: String
    public var sessionId: String?
    public var headSha: String
    public var selections: [CodeSelection]
    public var askedAt: String
}

public struct ThreadsMessage: Codable, Hashable, Sendable {
    public var requestId: String
    public var pr: PrKey
    public var turns: [StoredTurn]
}

// MARK: - Other server messages

public struct HelloResponse: Codable, Hashable, Sendable {
    public struct Capabilities: Codable, Hashable, Sendable {
        public var workspace: Bool
        public var inbox: Bool
        public var labels: Bool
        public var review: Bool
        public var agents: [AgentId]
    }
    public var requestId: String
    public var version: String
    public var `protocol`: Int
    public var viewer: String?
    public var capabilities: Capabilities
}

public struct AgentsMessage: Codable, Hashable, Sendable {
    public var requestId: String
    public var agents: [AgentStatus]
    public var pending: [AgentId]
}

public struct ReviewMessage: Codable, Hashable, Sendable {
    public var requestId: String
    public var pr: PrKey
    public var review: ReviewState?
}

public enum ProgressStep: String, Codable, Sendable {
    case findingRepo = "finding_repo", fetchingPr = "fetching_pr", preparingWorktree = "preparing_worktree"
    case fetchingCi = "fetching_ci", startingAgent = "starting_agent", thinking, labeling
}

public struct ProgressMessage: Codable, Hashable, Sendable {
    public var requestId: String
    public var step: ProgressStep
    public var detail: String?
}

public enum AgentEvent: Codable, Hashable, Sendable {
    case text(delta: String)
    case tool(summary: String)
    case done(sessionId: String?, headSha: String, model: String)
    case error(ServerError)

    private enum CodingKeys: String, CodingKey { case type, delta, summary, sessionId, headSha, model }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        switch try c.decode(String.self, forKey: .type) {
        case "text": self = .text(delta: try c.decode(String.self, forKey: .delta))
        case "tool": self = .tool(summary: try c.decode(String.self, forKey: .summary))
        case "done": self = .done(sessionId: try c.decodeIfPresent(String.self, forKey: .sessionId), headSha: try c.decode(String.self, forKey: .headSha), model: try c.decode(String.self, forKey: .model))
        case "error": self = .error(try ServerError(from: decoder))
        case let type: throw DecodingError.dataCorruptedError(forKey: .type, in: c, debugDescription: "unknown agent event \(type)")
        }
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case let .text(delta):
            try c.encode("text", forKey: .type)
            try c.encode(delta, forKey: .delta)
        case let .tool(summary):
            try c.encode("tool", forKey: .type)
            try c.encode(summary, forKey: .summary)
        case let .done(sessionId, headSha, model):
            try c.encode("done", forKey: .type)
            try c.encode(sessionId, forKey: .sessionId)
            try c.encode(headSha, forKey: .headSha)
            try c.encode(model, forKey: .model)
        case let .error(e):
            try c.encode("error", forKey: .type)
            try e.encode(to: encoder)
        }
    }
}

public struct EventMessage: Codable, Hashable, Sendable {
    public var requestId: String
    public var event: AgentEvent
}

/// Everything the server sends. Unknown types decode as `.unknown` so a newer server never breaks the app.
public enum ServerMessage: Decodable, Sendable {
    case hello(HelloResponse)
    case ack(requestId: String)
    case agents(AgentsMessage)
    case inbox(InboxMessage)
    case review(ReviewMessage)
    case riskLabels(RiskLabelsMessage)
    case prDiff(PrDiffMessage)
    case threads(ThreadsMessage)
    case progress(ProgressMessage)
    case event(EventMessage)
    case setupChecks(SetupChecksMessage)
    case settings(SettingsMessage)
    case diagnostics(DiagnosticsMessage)
    case workspace(WorkspaceMessage)
    case unknown(type: String, requestId: String?)

    private enum CodingKeys: String, CodingKey { case type, requestId }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let type = try c.decode(String.self, forKey: .type)
        switch type {
        case "hello": self = .hello(try HelloResponse(from: decoder))
        case "ack": self = .ack(requestId: try c.decode(String.self, forKey: .requestId))
        case "agents": self = .agents(try AgentsMessage(from: decoder))
        case "inbox": self = .inbox(try InboxMessage(from: decoder))
        case "review": self = .review(try ReviewMessage(from: decoder))
        case "risk_labels": self = .riskLabels(try RiskLabelsMessage(from: decoder))
        case "pr_diff": self = .prDiff(try PrDiffMessage(from: decoder))
        case "threads": self = .threads(try ThreadsMessage(from: decoder))
        case "progress": self = .progress(try ProgressMessage(from: decoder))
        case "event": self = .event(try EventMessage(from: decoder))
        case "setup_checks": self = .setupChecks(try SetupChecksMessage(from: decoder))
        case "settings": self = .settings(try SettingsMessage(from: decoder))
        case "diagnostics": self = .diagnostics(try DiagnosticsMessage(from: decoder))
        case "workspace": self = .workspace(try WorkspaceMessage(from: decoder))
        default: self = .unknown(type: type, requestId: try c.decodeIfPresent(String.self, forKey: .requestId))
        }
    }

    public var requestId: String? {
        switch self {
        case let .hello(m): m.requestId
        case let .ack(id): id
        case let .agents(m): m.requestId
        case let .inbox(m): m.requestId
        case let .review(m): m.requestId
        case let .riskLabels(m): m.requestId
        case let .prDiff(m): m.requestId
        case let .threads(m): m.requestId
        case let .progress(m): m.requestId
        case let .event(m): m.requestId
        case let .setupChecks(m): m.requestId
        case let .settings(m): m.requestId
        case let .diagnostics(m): m.requestId
        case let .workspace(m): m.requestId
        case let .unknown(_, id): id
        }
    }
}

// MARK: - App → server

public enum SubscriptionTopic: Codable, Hashable, Sendable {
    case inbox, agents, pr(PrKey)

    private enum CodingKeys: String, CodingKey { case pr }

    public init(from decoder: Decoder) throws {
        if let s = try? decoder.singleValueContainer().decode(String.self) {
            switch s {
            case "inbox": self = .inbox
            case "agents": self = .agents
            default: throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "unknown topic \(s)"))
            }
        } else {
            self = .pr(try decoder.container(keyedBy: CodingKeys.self).decode(PrKey.self, forKey: .pr))
        }
    }

    public func encode(to encoder: Encoder) throws {
        switch self {
        case .inbox:
            var c = encoder.singleValueContainer()
            try c.encode("inbox")
        case .agents:
            var c = encoder.singleValueContainer()
            try c.encode("agents")
        case let .pr(pr):
            var c = encoder.container(keyedBy: CodingKeys.self)
            try c.encode(pr, forKey: .pr)
        }
    }
}

/// One earlier question and answer, for a thread that moves to a new agent session.
public struct HistoryTurn: Codable, Hashable, Sendable {
    public var question: String
    public var answer: String
    public init(question: String, answer: String) {
        self.question = question
        self.answer = answer
    }
}

/// An ask's PR: a PrKey plus the commit the reviewer is looking at.
public struct PrRef: Codable, Hashable, Sendable {
    public var owner: String
    public var repo: String
    public var number: Int
    public var headSha: String?
    public init(_ pr: PrKey, headSha: String? = nil) {
        owner = pr.owner
        repo = pr.repo
        number = pr.number
        self.headSha = headSha
    }
}

/// Everything the app sends. `requestId` is set by the connection.
public enum AppRequest: Sendable, Hashable {
    case hello(clientVersion: String)
    case subscribe(SubscriptionTopic)
    case unsubscribe
    case inbox(refresh: Bool)
    case startReview(PrKey, agent: AgentId?, model: String?)
    case stopReview(PrKey, removeWorktree: Bool)
    case updateReview(PrKey)
    case riskLabels(PrKey, headSha: String?, rerun: Bool)
    case prDiff(PrKey, headSha: String?)
    case threads(PrKey)
    /// `history`: earlier turns, sent when a thread continues on a new agent session (e.g. after switching agents).
    case ask(agent: AgentId, model: String, pr: PrRef, selections: [CodeSelection], question: String, sessionId: String?, history: [HistoryTurn] = [])
    case cancel
    /// The thread is over: the server can stop the agent process kept open for it. No reply.
    case closeSession(agent: AgentId, sessionId: String)
    case shutdown
    case setupChecks
    case settings
    case saveSettings(SettingsPatch)
    case pruneWorktrees
    case diagnostics
    /// Adds a folder of clones (or one clone) to the scan folders.
    case addScanFolder(String)
    /// Replaces the scan folders.
    case setScanFolders([String])
    /// Links (or with nil, unlinks) a clone for "owner/repo".
    case linkClone(repo: String, path: String?)

    /// The JSON object sent on the wire, with `requestId` filled in.
    public func json(requestId: String) -> [String: Any] {
        func key(_ pr: PrKey) -> [String: Any] { ["owner": pr.owner, "repo": pr.repo, "number": pr.number] }
        var m: [String: Any] = ["requestId": requestId]
        switch self {
        case let .hello(version):
            m["type"] = "hello"
            m["client"] = "mac-app"
            m["clientVersion"] = version
            m["protocol"] = socketProtocolVersion
        case let .subscribe(topic):
            m["type"] = "subscribe"
            switch topic {
            case .inbox: m["topic"] = "inbox"
            case .agents: m["topic"] = "agents"
            case let .pr(pr): m["topic"] = ["pr": key(pr)]
            }
        case .unsubscribe: m["type"] = "unsubscribe"
        case let .inbox(refresh):
            m["type"] = "inbox"
            if refresh { m["refresh"] = true }
        case let .startReview(pr, agent, model):
            m["type"] = "start_review"
            m["pr"] = key(pr)
            if let agent { m["agent"] = agent.rawValue }
            if let model { m["model"] = model }
        case let .stopReview(pr, remove):
            m["type"] = "stop_review"
            m["pr"] = key(pr)
            m["removeWorktree"] = remove
        case let .updateReview(pr):
            m["type"] = "update_review"
            m["pr"] = key(pr)
        case let .riskLabels(pr, headSha, rerun):
            m["type"] = "risk_labels"
            m["pr"] = key(pr)
            if let headSha { m["headSha"] = headSha }
            if rerun { m["rerun"] = true }
        case let .prDiff(pr, headSha):
            m["type"] = "pr_diff"
            m["pr"] = key(pr)
            if let headSha { m["headSha"] = headSha }
        case let .threads(pr):
            m["type"] = "threads"
            m["pr"] = key(pr)
        case let .ask(agent, model, pr, selections, question, sessionId, history):
            m["type"] = "ask"
            m["agent"] = agent.rawValue
            m["model"] = model
            var p: [String: Any] = ["owner": pr.owner, "repo": pr.repo, "number": pr.number]
            if let sha = pr.headSha { p["headSha"] = sha }
            m["pr"] = p
            m["selections"] = selections.map { s -> [String: Any] in
                var o: [String: Any] = [:]
                if let v = s.path { o["path"] = v }
                if let v = s.fileAnchor { o["fileAnchor"] = v }
                if let v = s.side { o["side"] = v.rawValue }
                if let v = s.startLine { o["startLine"] = v }
                if let v = s.endLine { o["endLine"] = v }
                if let v = s.text { o["text"] = v }
                return o
            }
            m["question"] = question
            m["sessionId"] = sessionId ?? NSNull()
            if !history.isEmpty { m["history"] = history.map { ["question": $0.question, "answer": $0.answer] } }
        case .cancel: m["type"] = "cancel"
        case let .closeSession(agent, sessionId):
            m["type"] = "close_session"
            m["agent"] = agent.rawValue
            m["sessionId"] = sessionId
        case .shutdown: m["type"] = "shutdown"
        case .setupChecks: m["type"] = "setup_checks"
        case .settings: m["type"] = "settings"
        case let .saveSettings(patch):
            m["type"] = "save_settings"
            m["patch"] = patch.json
        case .pruneWorktrees: m["type"] = "prune_worktrees"
        case .diagnostics: m["type"] = "diagnostics"
        case let .addScanFolder(path):
            m["type"] = "workspace_save"
            m["addPath"] = path
        case let .setScanFolders(roots):
            m["type"] = "workspace_save"
            m["scanRoots"] = roots
        case let .linkClone(repo, path):
            m["type"] = "workspace_save"
            m["repoPaths"] = [repo: path.map { $0 as Any } ?? NSNull()]
        }
        return m
    }
}

// MARK: - Dates

public enum ISODate {
    nonisolated(unsafe) private static let fractional: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()
    nonisolated(unsafe) private static let plain = ISO8601DateFormatter()

    /// Parses the server's timestamps, with or without fractional seconds.
    public static func parse(_ s: String) -> Date? { fractional.date(from: s) ?? plain.date(from: s) }
}
