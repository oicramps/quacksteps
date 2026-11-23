import Foundation

// First run and Settings messages (see SetupChecksMessage and SettingsMessage in protocol.ts).

public struct SetupCheck: Codable, Hashable, Sendable, Identifiable {
    public enum Kind: String, Codable, Sendable { case server, gh, git, agent, clone }
    public var id: Kind
    public var ok: Bool
    public var title: String
    public var detail: String
    public var fixSteps: [FixStep]
}

public struct SetupChecksMessage: Codable, Hashable, Sendable {
    public var requestId: String
    public var checks: [SetupCheck]
}

public struct ServerSettings: Codable, Hashable, Sendable {
    public var scanRoots: [String]
    public var repoPaths: [String: String]
    public var worktreeRoot: String
    public var retentionDays: Int
    public var maxWorktrees: Int
    public var chatAgent: AgentId?
    public var chatModel: String
    /// nil: same as chat.
    public var labelsAgent: AgentId?
    public var labelsModel: String
    public var extraPath: [String]
    public var pollActiveSeconds: Int
    public var pollIdleSeconds: Int
}

public struct SettingsMessage: Codable, Hashable, Sendable {
    public struct Server: Codable, Hashable, Sendable {
        public var version: String
        public var pid: Int
        public var startedAt: String
        public var socketPath: String
        public var logPath: String
    }
    public struct RateLimit: Codable, Hashable, Sendable {
        public var limit: Int
        public var remaining: Int
        public var resetAt: String
    }
    public struct GitHub: Codable, Hashable, Sendable {
        public var viewer: String?
        public var rateLimit: RateLimit?
    }
    public struct Worktrees: Codable, Hashable, Sendable {
        public var root: String
        public var count: Int
        public var bytes: Int
    }
    public struct Clone: Codable, Hashable, Sendable, Identifiable {
        public var repo: String
        public var path: String?
        public var id: String { repo }
    }
    public var requestId: String
    public var settings: ServerSettings
    public var server: Server
    public var github: GitHub
    public var worktrees: Worktrees
    public var clones: [Clone]
    public var removed: [String]?
    public var error: String?
}

public struct DiagnosticsMessage: Codable, Hashable, Sendable {
    public var requestId: String
    public var text: String
}

/// The v1 workspace reply, used by Settings › Repos and First run's Choose folder.
public struct WorkspaceMessage: Codable, Hashable, Sendable {
    public struct Root: Codable, Hashable, Sendable {
        public enum State: String, Codable, Sendable { case ok, empty, missing, blocked }
        public var path: String
        public var state: State
        public var repoCount: Int
    }
    public struct Status: Codable, Hashable, Sendable {
        public var configured: Bool
        public var gitAvailable: Bool
        public var roots: [Root]
        public var totalRepos: Int
    }
    public var requestId: String
    public var workspace: Status
    public var error: String?
    public var notice: String?
}

/// A change to the server's settings. A double optional distinguishes "leave as is" (nil) from "clear" (.some(nil)).
public struct SettingsPatch: Hashable, Sendable {
    public var retentionDays: Int?
    public var maxWorktrees: Int?
    public var chatAgent: AgentId??
    public var chatModel: String?
    public var labelsAgent: AgentId??
    public var labelsModel: String?
    public var extraPath: [String]?
    public var pollActiveSeconds: Int?
    public var pollIdleSeconds: Int?

    public init(retentionDays: Int? = nil, maxWorktrees: Int? = nil, chatAgent: AgentId?? = nil, chatModel: String? = nil, labelsAgent: AgentId?? = nil,
                labelsModel: String? = nil, extraPath: [String]? = nil, pollActiveSeconds: Int? = nil, pollIdleSeconds: Int? = nil) {
        self.retentionDays = retentionDays
        self.maxWorktrees = maxWorktrees
        self.chatAgent = chatAgent
        self.chatModel = chatModel
        self.labelsAgent = labelsAgent
        self.labelsModel = labelsModel
        self.extraPath = extraPath
        self.pollActiveSeconds = pollActiveSeconds
        self.pollIdleSeconds = pollIdleSeconds
    }

    var json: [String: Any] {
        var o: [String: Any] = [:]
        if let v = retentionDays { o["retentionDays"] = v }
        if let v = maxWorktrees { o["maxWorktrees"] = v }
        if let v = chatAgent { o["chatAgent"] = v.map { $0.rawValue as Any } ?? NSNull() }
        if let v = chatModel { o["chatModel"] = v }
        if let v = labelsAgent { o["labelsAgent"] = v.map { $0.rawValue as Any } ?? NSNull() }
        if let v = labelsModel { o["labelsModel"] = v }
        if let v = extraPath { o["extraPath"] = v }
        if let v = pollActiveSeconds { o["pollActiveSeconds"] = v }
        if let v = pollIdleSeconds { o["pollIdleSeconds"] = v }
        return o
    }
}
