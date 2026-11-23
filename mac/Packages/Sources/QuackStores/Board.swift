import Foundation
import QuackProtocol

// The inbox as a departures board: fixed columns (CI, Size, Wait, Status) on every row, the wait on
// split-flap tiles, one status word. Pure logic here; the views live in QuackUI's InboxBoard.

public enum BoardFormat {
    /// Three flap characters: "25M" under an hour, "06H" under two days, "04D" under 100 days, then
    /// weeks ("32W", at most "99W"). The exact wait is in the accessibility label and the tooltip.
    public static func flaps(_ seconds: TimeInterval) -> String {
        let minutes = max(0, Int(seconds / 60))
        func two(_ n: Int) -> String { n < 10 ? "0\(n)" : "\(min(n, 99))" }
        if minutes < 60 { return two(minutes) + "M" }
        let hours = minutes / 60
        if hours < 48 { return two(hours) + "H" }
        let days = hours / 24
        if days < 100 { return two(days) + "D" }
        return two(days / 7) + "W"
    }

    /// The tiles of a draft, which has no timer.
    public static let noTimer = "–––"
}

/// T-shirt size from changed lines: XS under 50, S under 200, M under 500, L under 1,000, XL beyond.
public enum PRSize: String, Sendable, CaseIterable {
    case xs = "XS", s = "S", m = "M", l = "L", xl = "XL"

    public init(lines: Int) {
        switch lines {
        case ..<50: self = .xs
        case ..<200: self = .s
        case ..<500: self = .m
        case ..<1000: self = .l
        default: self = .xl
        }
    }

    /// Only L and XL get colour, so small PRs stay quiet.
    public var isBig: Bool { self == .l || self == .xl }
}

/// The one-word status at the end of each row, in mono caps.
public struct BoardStatus: Equatable, Sendable {
    public enum Tone: Int, Sendable, Comparable {
        case dim, ok, green, orange, red
        public static func < (a: Tone, b: Tone) -> Bool { a.rawValue < b.rawValue }
    }

    public var word: String
    public var tone: Tone
    /// Higher is more urgent; a collapsed stack shows its most urgent member's status.
    public var urgency: Int

    public init(word: String, tone: Tone, urgency: Int) {
        self.word = word
        self.tone = tone
        self.urgency = urgency
    }

    private static func delayedTone(_ waited: TimeInterval) -> Tone {
        WaitLevel(waited: waited) >= .old ? .red : .orange
    }

    /// A review request: on time for the first day, delayed after (orange, then red from 3 days).
    /// Already approved by someone else: not waiting on me.
    public static func review(waited: TimeInterval, approvedByOthers: Bool) -> BoardStatus {
        if approvedByOthers { return BoardStatus(word: "APPROVED", tone: .dim, urgency: 0) }
        if waited < 24 * 3600 { return BoardStatus(word: "ON TIME", tone: .ok, urgency: 1) }
        let tone = delayedTone(waited)
        return BoardStatus(word: "DELAYED", tone: tone, urgency: tone == .red ? 5 : 4)
    }

    /// One of my PRs, by its state and how long it has been in it. nil state = draft.
    public static func author(_ state: AuthorState?, waited: TimeInterval) -> BoardStatus {
        switch state {
        case nil: return BoardStatus(word: "DRAFT", tone: .dim, urgency: 0)
        case .waitingOnMe: return BoardStatus(word: "YOUR TURN", tone: .orange, urgency: 6)
        case .blockedByCI: return BoardStatus(word: "CI FAILED", tone: .red, urgency: 7)
        case .readyToMerge: return BoardStatus(word: "READY", tone: .green, urgency: 3)
        case .waitingOnReviewers:
            if waited < 24 * 3600 { return BoardStatus(word: "ON TIME", tone: .ok, urgency: 1) }
            let tone = delayedTone(waited)
            return BoardStatus(word: "DELAYED", tone: tone, urgency: tone == .red ? 5 : 4)
        }
    }
}

extension InboxItem {
    /// Changed lines: what the Size column counts.
    public var changedLines: Int { additions + deletions }

    /// When the current wait started: the review request, or entering the current author state.
    public var waitingSince: Date? {
        switch role {
        case .reviewer: reviewer.flatMap { ISODate.parse($0.requestedAt) }
        case .author: author?.state == nil ? nil : author.flatMap { ISODate.parse($0.since) }
        }
    }

    public func boardStatus(now: Date = .now) -> BoardStatus {
        let waited = waitingSince.map { now.timeIntervalSince($0) } ?? 0
        switch role {
        case .reviewer: return .review(waited: waited, approvedByOthers: reviewer?.isApprovedByOthers == true)
        case .author: return .author(author?.state, waited: waited)
        }
    }
}

extension CIState {
    /// Worst first: a stack header shows its worst member's CI.
    public var severity: Int {
        switch self {
        case .failing: 3
        case .pending: 2
        case .passing: 1
        case .none: 0
        }
    }
}

/// PRs of one stack that are in the same list, bottom (merges first) to top.
public struct StackGroup: Identifiable, Hashable, Sendable {
    public var id: String
    public var items: [InboxItem]

    public init(id: String, items: [InboxItem]) {
        self.id = id
        self.items = items
    }

    /// The bottom PR's title prefix ("Trip map: cluster pins" → "Trip map"), else its whole title.
    public var name: String {
        let title = items.first?.title ?? ""
        if let colon = title.firstIndex(of: ":") {
            let prefix = title[..<colon].trimmingCharacters(in: .whitespaces)
            if !prefix.isEmpty { return prefix }
        }
        return title
    }

    public var totalLines: Int { items.reduce(0) { $0 + $1.changedLines } }
    public var worstCI: CIState { items.map(\.ci).max { $0.severity < $1.severity } ?? .none }
    /// The oldest wait in the stack; nil when every member is a draft.
    public var oldestWait: Date? { items.compactMap(\.waitingSince).min() }

    public func mostUrgentStatus(now: Date = .now) -> BoardStatus {
        items.map { $0.boardStatus(now: now) }.max { $0.urgency < $1.urgency } ?? .author(nil, waited: 0)
    }
}

/// One line of an inbox section: a PR on its own, or a stack of PRs from the same list.
public enum InboxEntry: Identifiable, Hashable, Sendable {
    case item(InboxItem)
    case stack(StackGroup)

    public var id: String {
        switch self {
        case let .item(item): item.id
        case let .stack(group): group.id
        }
    }

    /// Groups the PRs of a stack that appear together in `items` (linked by their parent PR, same repo).
    /// A group takes the place of its first member, so the list keeps its order; a stack with only one
    /// member in the list stays a plain row.
    public static func group(_ items: [InboxItem]) -> [InboxEntry] {
        // Union the items with their parent, by "owner/repo#number".
        let key = { (pr: PrKey, number: Int) in "\(pr.owner)/\(pr.repo)#\(number)" }
        var index: [String: Int] = [:]
        for (i, item) in items.enumerated() where item.stack != nil { index[key(item.pr, item.pr.number)] = i }
        var root = Array(items.indices)
        func find(_ i: Int) -> Int {
            var i = i
            while root[i] != i { root[i] = root[root[i]]; i = root[i] }
            return i
        }
        for (i, item) in items.enumerated() {
            guard let parent = item.stack?.parent, let j = index[key(item.pr, parent.number)] else { continue }
            let a = find(i), b = find(j)
            if a != b { root[max(a, b)] = min(a, b) }
        }
        var members: [Int: [Int]] = [:]
        for i in items.indices where items[i].stack != nil { members[find(i), default: []].append(i) }

        var out: [InboxEntry] = []
        var placed = Set<Int>()
        for (i, item) in items.enumerated() {
            let group = item.stack != nil ? members[find(i)] ?? [i] : [i]
            if group.count < 2 {
                out.append(.item(item))
                continue
            }
            let r = find(i)
            if placed.contains(r) { continue }
            placed.insert(r)
            let sorted = group.map { items[$0] }.sorted { ($0.stack?.position ?? 0, $0.pr.number) < ($1.stack?.position ?? 0, $1.pr.number) }
            let bottom = sorted[0]
            out.append(.stack(StackGroup(id: "stack:\(bottom.role.rawValue):\(key(bottom.pr, bottom.pr.number))", items: sorted)))
        }
        return out
    }
}
