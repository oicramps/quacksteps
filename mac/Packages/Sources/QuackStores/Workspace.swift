import Foundation
import Observation
import QuackProtocol

/// The single main window's state, IDE style: the Inbox tab is always first, PRs open as tabs after it.
/// Open tabs and first-run completion survive relaunches (UserDefaults; UI state only).
@MainActor @Observable
public final class Workspace {
    public enum Tab: Hashable, Sendable {
        case inbox
        case pr(PrKey)
    }

    public private(set) var tabs: [PrKey]
    public var selected: Tab {
        didSet { save() }
    }

    /// First run done: the main window shows the workspace instead of the checks.
    public var onboarded: Bool {
        didSet { defaults.set(onboarded, forKey: "onboarded") }
    }

    @ObservationIgnored private let defaults: UserDefaults

    public init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        let saved = (defaults.data(forKey: "workspace.tabs")).flatMap { try? JSONDecoder().decode([PrKey].self, from: $0) } ?? []
        tabs = saved
        let selectedPR = (defaults.data(forKey: "workspace.selected")).flatMap { try? JSONDecoder().decode(PrKey.self, from: $0) }
        selected = selectedPR.flatMap { pr in saved.contains(where: { $0.id == pr.id }) ? .pr(pr) : nil } ?? .inbox
        onboarded = defaults.bool(forKey: "onboarded")
    }

    /// Opens (or focuses) the PR's tab.
    public func open(_ pr: PrKey) {
        if let existing = tabs.first(where: { $0.id == pr.id }) {
            selected = .pr(existing)
        } else {
            tabs.append(pr)
            selected = .pr(pr)
        }
    }

    /// Called when a PR tab closes (the app ends that PR's agent sessions).
    @ObservationIgnored public var onClose: ((PrKey) -> Void)?

    /// Closes the PR's tab; the selection moves to its neighbour, else the Inbox.
    public func close(_ pr: PrKey) {
        guard let index = tabs.firstIndex(where: { $0.id == pr.id }) else { return }
        tabs.remove(at: index)
        onClose?(pr)
        if case let .pr(current) = selected, current.id == pr.id {
            selected = tabs.isEmpty ? .inbox : .pr(tabs[min(index, tabs.count - 1)])
        } else {
            save()
        }
    }

    public func closeSelected() {
        if case let .pr(pr) = selected { close(pr) }
    }

    /// ⌘⇧] / ⌘⇧[: cycles Inbox → PR tabs → Inbox.
    public func selectNext(_ step: Int) {
        let all: [Tab] = [.inbox] + tabs.map { .pr($0) }
        let index = all.firstIndex(of: selected) ?? 0
        selected = all[(index + step + all.count) % all.count]
    }

    public func isSelected(_ pr: PrKey) -> Bool {
        if case let .pr(current) = selected { current.id == pr.id } else { false }
    }

    private func save() {
        defaults.set(try? JSONEncoder().encode(tabs), forKey: "workspace.tabs")
        if case let .pr(pr) = selected {
            defaults.set(try? JSONEncoder().encode(pr), forKey: "workspace.selected")
        } else {
            defaults.removeObject(forKey: "workspace.selected")
        }
    }
}
