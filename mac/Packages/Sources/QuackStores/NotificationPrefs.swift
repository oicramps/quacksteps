import Foundation
import Observation
import QuackProtocol

/// Which inbox events become notifications, and whether the menu bar shows a count.
/// Kept on this Mac (UserDefaults): it only changes what the app shows, not what the server does.
@MainActor @Observable
public final class NotificationPrefs {
    public enum Kind: String, CaseIterable, Sendable {
        case reviewRequested, prNeedsYou, readyToMerge, ciFailed, newCommits

        public var title: String {
            switch self {
            case .reviewRequested: "Review requested"
            case .prNeedsYou: "Your PR needs you"
            case .readyToMerge: "Your PR is ready to merge"
            case .ciFailed: "CI failed on your PR"
            case .newCommits: "New commits on a PR you’re reviewing"
            }
        }

        public var detail: String {
            switch self {
            case .reviewRequested: "With Start reviewing and Open buttons"
            case .prNeedsYou: "Changes requested, unresolved threads or conflicts"
            case .readyToMerge: ""
            case .ciFailed: "Once per new head commit"
            case .newCommits: ""
            }
        }
    }

    @ObservationIgnored private let defaults: UserDefaults
    public private(set) var enabled: Set<Kind>
    public var showCountInMenuBar: Bool {
        didSet { defaults.set(showCountInMenuBar, forKey: "menuBar.showCount") }
    }

    public init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        enabled = Set(Kind.allCases.filter { defaults.object(forKey: "notify.\($0.rawValue)") as? Bool ?? true })
        showCountInMenuBar = defaults.object(forKey: "menuBar.showCount") as? Bool ?? true
    }

    public func isOn(_ kind: Kind) -> Bool { enabled.contains(kind) }

    public func set(_ kind: Kind, _ on: Bool) {
        if on { enabled.insert(kind) } else { enabled.remove(kind) }
        defaults.set(on, forKey: "notify.\(kind.rawValue)")
    }

    /// The preference an event falls under; nil when it never notifies (e.g. a move into waiting on reviewers).
    public static func kind(of event: InboxEvent) -> Kind? {
        switch event {
        case .reviewRequested: .reviewRequested
        case let .stateChanged(_, _, to):
            switch to {
            case .waitingOnMe, .blockedByCI: .prNeedsYou
            case .readyToMerge: .readyToMerge
            default: nil
            }
        case .ciFailed: .ciFailed
        case .newCommits: .newCommits
        }
    }
}
