import Foundation

// Writing reviews (socket protocol v3). Comments, replies and the summary stay on this Mac until
// `submitReview` posts them together; resolving, viewed ticks and "Assign me" are immediate.

extension ErrorCode {
    /// The gh login can read the repo but not write to it.
    public static let ghWriteDenied = ErrorCode(rawValue: "gh_write_denied")
    /// I have a pending review on github.com for this PR, started outside Quacksteps.
    public static let reviewPendingOnGitHub = ErrorCode(rawValue: "review_pending_on_github")
}

/// GitHub's diff sides: RIGHT is the new file (added and context lines), LEFT the old one.
public enum DiffSide: String, Codable, Hashable, Sendable {
    case left = "LEFT"
    case right = "RIGHT"
}

/// Where a review comment sits: one line, or `startLine…line`, on one side of a file.
public struct CommentAnchor: Codable, Hashable, Sendable {
    public var path: String
    public var side: DiffSide
    public var line: Int
    public var startLine: Int?

    public init(path: String, side: DiffSide, line: Int, startLine: Int? = nil) {
        self.path = path
        self.side = side
        self.line = line
        self.startLine = startLine
    }

    /// "47–49" or "85".
    public var range: String {
        if let startLine, startLine < line { "\(startLine)–\(line)" } else { "\(line)" }
    }
}

public enum DraftOrigin: String, Codable, Hashable, Sendable {
    case me
    case agent
    case gapCheck = "gap_check"
}

public enum ReviewEvent: String, Codable, Hashable, Sendable, CaseIterable {
    case comment = "COMMENT"
    case approve = "APPROVE"
    case requestChanges = "REQUEST_CHANGES"
}

/// A pending comment (with `anchor`) or reply to a thread (with `replyTo`).
public struct DraftComment: Codable, Hashable, Sendable, Identifiable {
    public var id: String
    public var headSha: String
    public var anchor: CommentAnchor?
    public var replyTo: String?
    public var body: String
    public var origin: DraftOrigin
    public var createdAt: String
    public var updatedAt: String
}

/// What the app sends to add (no `id`) or replace a draft.
public struct DraftInput: Hashable, Sendable {
    public var id: String?
    public var headSha: String
    public var anchor: CommentAnchor?
    public var replyTo: String?
    public var body: String
    public var origin: DraftOrigin

    public init(id: String? = nil, headSha: String, anchor: CommentAnchor? = nil, replyTo: String? = nil, body: String, origin: DraftOrigin = .me) {
        self.id = id
        self.headSha = headSha
        self.anchor = anchor
        self.replyTo = replyTo
        self.body = body
        self.origin = origin
    }

    var json: [String: Any] {
        var d: [String: Any] = ["headSha": headSha, "body": body, "origin": origin.rawValue]
        if let id { d["id"] = id }
        if let anchor {
            var a: [String: Any] = ["path": anchor.path, "side": anchor.side.rawValue, "line": anchor.line]
            if let s = anchor.startLine, s < anchor.line { a["startLine"] = s }
            d["anchor"] = a
        }
        if let replyTo { d["replyTo"] = replyTo }
        return d
    }
}

public struct ReviewDraftsMessage: Codable, Hashable, Sendable {
    public var requestId: String
    public var pr: PrKey
    public var comments: [DraftComment]
    public var summary: String
    public var event: ReviewEvent?
}

public struct ReviewThreadComment: Codable, Hashable, Sendable, Identifiable {
    public var id: String
    public var author: String
    public var body: String
    public var createdAt: String
    public var url: String
}

public struct ReviewThread: Codable, Hashable, Sendable, Identifiable {
    public var id: String
    public var path: String
    public var side: DiffSide
    public var line: Int?
    public var startLine: Int?
    public var originalLine: Int?
    public var isResolved: Bool
    public var isOutdated: Bool
    public var canResolve: Bool
    public var canReply: Bool
    public var comments: [ReviewThreadComment]
}

public enum ViewedState: String, Codable, Hashable, Sendable {
    case viewed = "VIEWED"
    case unviewed = "UNVIEWED"
    /// Viewed, then the file changed.
    case dismissed = "DISMISSED"
}

public struct LastReview: Codable, Hashable, Sendable {
    public var commit: String
    public var submittedAt: String
    public var state: String
}

public struct ReviewThreadsMessage: Codable, Hashable, Sendable {
    public var requestId: String
    public var pr: PrKey
    public var viewer: String
    public var headSha: String
    public var threads: [ReviewThread]
    public var viewed: [String: ViewedState]
    public var lastReview: LastReview?
    /// I'm an assignee (absent from older servers).
    public var assignedToMe: Bool?
}

public struct ReviewSubmittedMessage: Codable, Hashable, Sendable {
    public var requestId: String
    public var pr: PrKey
    public var event: ReviewEvent
    public var url: String
    public var comments: Int
    public var replies: Int
}

// Agent help (v3): "Turn into comment" and the gap check. Both only return text to edit.

public struct DraftCommentMessage: Codable, Hashable, Sendable {
    public var requestId: String
    public var pr: PrKey
    public var body: String
}

/// A comment the gap check drafted, on a new-side line in the diff.
public struct GapFinding: Codable, Hashable, Sendable, Identifiable {
    public var id: String
    public var path: String
    public var line: Int
    public var body: String
}

public struct GapCheckMessage: Codable, Hashable, Sendable {
    public struct Skipped: Codable, Hashable, Sendable {
        public var path: String
        public var reason: String
    }
    public var requestId: String
    public var pr: PrKey
    public var headSha: String
    public var agent: AgentId
    public var model: String
    public var ms: Int
    public var findings: [GapFinding]
    public var checkedFiles: Int
    public var skipped: [Skipped]
}
