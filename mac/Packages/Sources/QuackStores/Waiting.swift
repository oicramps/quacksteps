import Foundation
import QuackProtocol

/// The design spec's waiting indicator: four ranges shared by every row.
public enum WaitLevel: Int, Sendable, Comparable {
    /// Under 4 h: clock, secondary colour, no quip.
    case fresh
    /// 4 h to 1 day: clock, primary colour, no quip.
    case hours
    /// 1 to 3 days: hourglass, orange semibold, quip.
    case days
    /// Over 3 days: hourglass, red semibold, quip.
    case old

    public init(waited: TimeInterval) {
        switch waited {
        case ..<(4 * 3600): self = .fresh
        case ..<(24 * 3600): self = .hours
        case ..<(3 * 24 * 3600): self = .days
        default: self = .old
        }
    }

    public static func < (a: WaitLevel, b: WaitLevel) -> Bool { a.rawValue < b.rawValue }

    public var usesHourglass: Bool { self >= .days }
    public var showsQuip: Bool { self >= .days }
}

public enum WaitFormat {
    /// Short, tabular durations: "25m", "6h 12m", "3h", "2d 5h". From a week on, whole days ("13d", "226d"):
    /// hours are noise there, and the column stays one line. VoiceOver gets the exact `spoken` form.
    public static func short(_ seconds: TimeInterval) -> String {
        let minutes = max(0, Int(seconds / 60))
        if minutes < 60 { return "\(minutes)m" }
        let hours = minutes / 60
        if hours < 24 { return minutes % 60 == 0 ? "\(hours)h" : "\(hours)h \(minutes % 60)m" }
        let days = hours / 24
        if days >= 7 { return "\(days)d" }
        return hours % 24 == 0 ? "\(days)d" : "\(days)d \(hours % 24)h"
    }

    /// For VoiceOver: "2 days 5 hours".
    public static func spoken(_ seconds: TimeInterval) -> String {
        let minutes = max(0, Int(seconds / 60))
        func unit(_ n: Int, _ word: String) -> String { "\(n) \(word)\(n == 1 ? "" : "s")" }
        if minutes < 60 { return unit(minutes, "minute") }
        let hours = minutes / 60
        if hours < 24 { return [unit(hours, "hour"), minutes % 60 > 0 ? unit(minutes % 60, "minute") : nil].compactMap { $0 }.joined(separator: " ") }
        let days = hours / 24
        return [unit(days, "day"), hours % 24 > 0 ? unit(hours % 24, "hour") : nil].compactMap { $0 }.joined(separator: " ")
    }

    /// "40 s ago", "3 min ago", "2 h ago".
    public static func ago(_ seconds: TimeInterval) -> String {
        let s = max(0, Int(seconds))
        if s < 60 { return "\(s) s ago" }
        if s < 3600 { return "\(s / 60) min ago" }
        return "\(s / 3600) h ago"
    }
}

/// One-line quips, shown only from one day of waiting, never read by VoiceOver.
public enum Quips {
    public static func reviewRequest(_ level: WaitLevel) -> String? {
        switch level {
        case .days: "Someone’s refreshing GitHub."
        case .old: "Approaching archaeology."
        default: nil
        }
    }

    public static func author(_ state: AuthorState, _ level: WaitLevel) -> String? {
        guard level.showsQuip else { return nil }
        let old = level == .old
        switch state {
        case .waitingOnReviewers: return old ? "Carbon-dating this one." : "Maybe nudge someone?"
        case .waitingOnMe: return old ? "Reviewers have moved on." : "They’re waiting on you."
        case .blockedByCI: return old ? "Red since last week." : "Red for days."
        case .readyToMerge: return old ? "Approved in another era." : "Approval is going stale."
        }
    }
}

/// The menu bar label: footprint plus count, a warning glyph, or a dimmed dash.
public enum MenuBarBadge: Equatable, Sendable {
    /// Nothing waiting: the footprint alone.
    case none
    case count(String)
    /// The server is unreachable.
    case warning
    /// Before the first poll lands.
    case pending

    public init(connected: Bool, polled: Bool, waiting: Int) {
        if !connected { self = .warning }
        else if !polled { self = .pending }
        else if waiting == 0 { self = .none }
        else { self = .count(waiting > 99 ? "99+" : "\(waiting)") }
    }
}

/// Initials for the avatar circle: "noor-haddad" → "NH", "skeller" → "SK".
public func initials(_ login: String) -> String {
    let parts = login.split(whereSeparator: { $0 == "-" || $0 == "_" || $0 == "." || $0 == " " }).filter { !$0.isEmpty }
    if parts.count >= 2 { return (String(parts[0].prefix(1)) + String(parts[1].prefix(1))).uppercased() }
    return String(login.prefix(2)).uppercased()
}

/// A stable avatar colour per login, from the canvas's palette.
public func avatarColorIndex(_ login: String, count: Int) -> Int {
    var hash: UInt32 = 2166136261
    for b in login.lowercased().utf8 { hash = (hash ^ UInt32(b)) &* 16777619 }
    return Int(hash % UInt32(count))
}
