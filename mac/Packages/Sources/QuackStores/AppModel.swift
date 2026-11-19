import Foundation
import Observation
import QuackClient
import QuackProtocol

/// Inbox sidebar filters. Repos are filters too, keyed by "owner/repo".
public enum InboxFilter: Hashable, Sendable {
    case everything, reviewRequests, myPRs, reviewing
    case repo(String)
}

/// The app's single source of truth: everything comes from the server, the app keeps only UI state.
@MainActor @Observable
public final class AppModel {
    public private(set) var connection: ConnectionStatus = .connecting
    public private(set) var inbox: InboxMessage?
    public private(set) var agents: [AgentStatus] = []
    public private(set) var settings: SettingsMessage?
    public private(set) var checks: [SetupCheck]?
    public private(set) var checking = false
    public private(set) var refreshing = false
    /// The last action that failed, shown in a banner until the next success.
    public var actionError: String?

    /// Called with each poll's events (notifications).
    @ObservationIgnored public var onEvents: (([InboxEvent], [InboxItem]) -> Void)?
    /// Called once when the server answers hello (upgrade check).
    @ObservationIgnored public var onHello: ((HelloResponse) -> Void)?

    @ObservationIgnored public let server: ServerConnection
    /// PR tab state, kept per PR (see `store(for:)`).
    @ObservationIgnored var prStores: [String: PRStore] = [:]
    @ObservationIgnored private var tasks: [Task<Void, Never>] = []
    @ObservationIgnored private let clientVersion: String

    public init(socketPath: String, clientVersion: String) {
        self.clientVersion = clientVersion
        let box = WeakBox()
        server = ServerConnection(socketPath: socketPath, clientVersion: clientVersion) { status in
            Task { @MainActor in box.model?.connectionChanged(status) }
        }
        box.model = self
        useVisibilityDefaults(.standard)
    }

    /// For previews and tests: a model with fixed data and no server.
    public init(preview inbox: InboxMessage?, connection: ConnectionStatus, checks: [SetupCheck]? = nil, settings: SettingsMessage? = nil, agents: [AgentStatus] = []) {
        clientVersion = "preview"
        server = ServerConnection(socketPath: "/nonexistent", clientVersion: "preview") { _ in }
        self.inbox = inbox
        self.connection = connection
        self.checks = checks
        self.settings = settings
        self.agents = agents
    }

    public func start() {
        server.start()
        tasks.append(Task { [weak self] in await self?.follow(.subscribe(.inbox)) })
        tasks.append(Task { [weak self] in await self?.follow(.subscribe(.agents)) })
    }

    private func follow(_ request: AppRequest) async {
        do {
            for try await message in server.stream(request) {
                switch message {
                case let .inbox(m):
                    inbox = m
                    if !m.events.isEmpty { onEvents?(m.events, m.items) }
                case let .agents(m): agents = m.agents
                default: break
                }
            }
        } catch {
            // Subscriptions only end when the app stops.
        }
    }

    private func connectionChanged(_ status: ConnectionStatus) {
        connection = status
        if case let .connected(hello) = status { onHello?(hello) }
    }

    // MARK: Derived

    public var isConnected: Bool { if case .connected = connection { true } else { false } }
    public var hello: HelloResponse? { if case let .connected(h) = connection { h } else { nil } }
    public var hasPolled: Bool { !(inbox?.fetchedAt.isEmpty ?? true) }
    public var items: [InboxItem] { inbox?.items ?? [] }

    // MARK: Repo visibility (kept on this Mac)

    /// "owner/repo" keys (lower-cased) the user unchecked in the sidebar. Their PRs leave the lists,
    /// the menu bar count and notifications; the server keeps polling them.
    public private(set) var hiddenRepos: Set<String> = []
    @ObservationIgnored private var visibilityDefaults: UserDefaults = .standard

    public func isRepoHidden(_ name: String) -> Bool { hiddenRepos.contains(name.lowercased()) }

    public func setRepo(_ name: String, hidden: Bool) {
        if hidden { hiddenRepos.insert(name.lowercased()) } else { hiddenRepos.remove(name.lowercased()) }
        visibilityDefaults.set(Array(hiddenRepos).sorted(), forKey: "inbox.hiddenRepos")
    }

    /// Where hidden repos are remembered (tests pass their own defaults).
    public func useVisibilityDefaults(_ defaults: UserDefaults) {
        visibilityDefaults = defaults
        hiddenRepos = Set((defaults.stringArray(forKey: "inbox.hiddenRepos") ?? []).map { $0.lowercased() })
        accountScope = defaults.string(forKey: "inbox.accountScope")
    }

    // MARK: Account scope ("Show PRs from")

    /// One account in the picker: an organization or a person, with its PR count (hidden repos included).
    public struct Account: Identifiable, Hashable, Sendable {
        public var name: String
        public var isOrganization: Bool
        /// The signed-in GitHub user's own account ("· you").
        public var isViewer: Bool
        public var count: Int
        public var id: String { name.lowercased() }
    }

    /// The owner whose PRs the inbox shows; nil = all accounts. A view, not a preference: the menu bar
    /// count and notifications ignore it. Remembered on this Mac.
    public private(set) var accountScope: String?

    public func setAccountScope(_ owner: String?) {
        accountScope = owner?.lowercased()
        if let owner { visibilityDefaults.set(owner.lowercased(), forKey: "inbox.accountScope") } else { visibilityDefaults.removeObject(forKey: "inbox.accountScope") }
    }

    /// Accounts with PRs in the inbox: organizations first, then people (you first), each by name.
    public var accounts: [Account] {
        var byOwner: [String: Account] = [:]
        let viewer = hello?.viewer?.lowercased()
        for i in items {
            let key = i.pr.owner.lowercased()
            var a = byOwner[key] ?? Account(name: i.pr.owner, isOrganization: i.ownerType == .org, isViewer: key == viewer, count: 0)
            a.count += 1
            if i.ownerType == .org { a.isOrganization = true }
            byOwner[key] = a
        }
        return byOwner.values.sorted {
            ($0.isOrganization ? 0 : 1, $0.isViewer ? 0 : 1, $0.name.lowercased()) < ($1.isOrganization ? 0 : 1, $1.isViewer ? 0 : 1, $1.name.lowercased())
        }
    }

    /// The scope's display name ("polarsteps"), nil for all accounts.
    public var accountScopeName: String? {
        guard let scope = accountScope else { return nil }
        return accounts.first { $0.id == scope }?.name ?? scope
    }

    private func inScope(_ item: InboxItem) -> Bool { accountScope.map { item.pr.owner.lowercased() == $0 } ?? true }

    public func isHidden(_ item: InboxItem) -> Bool { isRepoHidden("\(item.pr.owner)/\(item.pr.repo)") }

    /// Items from repos the user hasn't hidden.
    public var visibleItems: [InboxItem] { hiddenRepos.isEmpty ? items : items.filter { !isHidden($0) } }

    /// Review requests waiting on me, longest wait first (the server's order). Hidden repos, and requests
    /// someone else already approved, are left out: this is what the menu bar counts.
    public var reviewRequests: [InboxItem] {
        visibleItems.filter { $0.role == .reviewer && $0.reviewer?.isRequested == true && $0.reviewer?.isApprovedByOthers != true }
    }

    /// Review requests another reviewer already approved: still shown, below the ones waiting on me.
    public var approvedElsewhere: [InboxItem] {
        visibleItems.filter { $0.role == .reviewer && $0.reviewer?.isRequested == true && $0.reviewer?.isApprovedByOthers == true }
    }
    public var myPRs: [InboxItem] { visibleItems.filter { $0.role == .author } }
    public var reviewingItems: [InboxItem] { visibleItems.filter { $0.review != nil } }
    public var waitingOnMe: [InboxItem] { myPRs.filter { $0.author?.state == .waitingOnMe } }

    /// Review requests plus my PRs waiting on me: the menu bar count.
    public var waitingCount: Int { reviewRequests.count + waitingOnMe.count }

    public var badge: MenuBarBadge { MenuBarBadge(connected: isConnected, polled: hasPolled, waiting: waitingCount) }

    /// Repos with their item counts, most items first (only the scoped account's, when one is picked).
    public var repos: [(name: String, count: Int)] {
        var counts: [String: Int] = [:]
        for i in items where inScope(i) { counts["\(i.pr.owner)/\(i.pr.repo)", default: 0] += 1 }
        return counts.sorted { $0.value > $1.value || ($0.value == $1.value && $0.key < $1.key) }.map { ($0.key, $0.value) }
    }

    /// The list for a sidebar filter. Hidden repos are left out, except when that repo itself is the filter.
    /// `includeHidden` gives the totals the sidebar badges and "5 of 6" headers use.
    public func items(for filter: InboxFilter, matching search: String = "", includeHidden: Bool = false, allAccounts: Bool = false) -> (reviews: [InboxItem], mine: [InboxItem]) {
        var source = includeHidden ? items : visibleItems
        if !allAccounts { source = source.filter(inScope) }
        if case .repo = filter { source = items }
        let q = search.trimmingCharacters(in: .whitespaces).lowercased()
        let match: (InboxItem) -> Bool = { item in
            q.isEmpty || item.title.lowercased().contains(q) || item.authorLogin.lowercased().contains(q)
                || "\(item.pr.repo) #\(item.pr.number)".lowercased().contains(q) || "\(item.pr.number)" == q
        }
        // Reviewer items I already reviewed show only under Reviewing (and their repo). Requests someone
        // else approved go after the ones waiting on me (a stable partition keeps the longest-wait order).
        let reviewerItems = source.filter { $0.role == .reviewer }
        let reviews = reviewerItems.filter { $0.reviewer?.isApprovedByOthers != true } + reviewerItems.filter { $0.reviewer?.isApprovedByOthers == true }
        let mine = source.filter { $0.role == .author }
        switch filter {
        case .everything: return (reviews.filter { $0.reviewer?.isRequested == true }.filter(match), mine.filter(match))
        case .reviewRequests: return (reviews.filter { $0.reviewer?.isRequested == true }.filter(match), [])
        case .myPRs: return ([], mine.filter(match))
        case .reviewing: return (reviews.filter { $0.review != nil }.filter(match), mine.filter { $0.review != nil }.filter(match))
        case let .repo(name):
            let inRepo: (InboxItem) -> Bool = { "\($0.pr.owner)/\($0.pr.repo)".lowercased() == name.lowercased() }
            return (reviews.filter(inRepo).filter(match), mine.filter(inRepo).filter(match))
        }
    }

    /// Sidebar badge: every PR for the filter, hidden repos included (as on the canvas).
    public func count(for filter: InboxFilter) -> Int {
        let r = items(for: filter, includeHidden: true, allAccounts: true)
        return r.reviews.count + r.mine.count
    }

    /// For section headers: how many of each section are shown, out of the total ("5 of 6").
    public func sectionCounts(for filter: InboxFilter, matching search: String = "") -> (reviews: (shown: Int, total: Int), mine: (shown: Int, total: Int)) {
        let shown = items(for: filter, matching: search)
        let all = items(for: filter, matching: search, includeHidden: true)
        return ((shown.reviews.count, all.reviews.count), (shown.mine.count, all.mine.count))
    }

    public func item(for pr: PrKey) -> InboxItem? { items.first { $0.pr.id == pr.id } }

    // MARK: Actions

    public func refresh() async {
        refreshing = true
        defer { refreshing = false }
        do {
            if case let .inbox(m) = try await server.request(.inbox(refresh: true), timeout: .seconds(90)) { inbox = m }
        } catch {
            actionError = "\(error)"
        }
    }

    public func startReview(_ pr: PrKey) async { await reviewAction(.startReview(pr, agent: nil, model: nil)) }
    public func stopReview(_ pr: PrKey, removeWorktree: Bool = false) async { await reviewAction(.stopReview(pr, removeWorktree: removeWorktree)) }
    public func updateReview(_ pr: PrKey) async { await reviewAction(.updateReview(pr)) }

    private func reviewAction(_ request: AppRequest) async {
        do {
            _ = try await server.request(request)
            actionError = nil
        } catch {
            actionError = "\(error)"
        }
    }

    public func runChecks() async {
        checking = true
        defer { checking = false }
        guard isConnected else {
            checks = nil
            return
        }
        do {
            if case let .setupChecks(m) = try await server.request(.setupChecks, timeout: .seconds(90)) { checks = m.checks }
        } catch {
            actionError = "\(error)"
        }
    }

    /// True when every first-run check passes (and the server answered).
    public var setupComplete: Bool { checks.map { $0.allSatisfy(\.ok) } ?? false }

    public func loadSettings() async { await settingsAction(.settings) }
    public func save(_ patch: SettingsPatch) async { await settingsAction(.saveSettings(patch)) }
    public func pruneWorktrees() async { await settingsAction(.pruneWorktrees, timeout: .seconds(300)) }

    private func settingsAction(_ request: AppRequest, timeout: Duration = .seconds(60)) async {
        do {
            if case let .settings(m) = try await server.request(request, timeout: timeout) {
                settings = m
                actionError = m.error
            }
        } catch {
            actionError = "\(error)"
        }
    }

    /// Adds a scan folder (or a single clone), then reloads settings. Returns the server's note or error.
    @discardableResult
    public func addScanFolder(_ path: String) async -> String? {
        await workspace(.addScanFolder(path))
    }

    public func setScanFolders(_ roots: [String]) async { await workspace(.setScanFolders(roots)) }

    @discardableResult
    public func linkClone(repo: String, path: String?) async -> String? { await workspace(.linkClone(repo: repo, path: path)) }

    @discardableResult
    private func workspace(_ request: AppRequest) async -> String? {
        do {
            let reply = try await server.request(request)
            await loadSettings()
            if case let .workspace(w) = reply {
                actionError = w.error
                return w.error ?? w.notice
            }
        } catch {
            actionError = "\(error)"
        }
        return actionError
    }

    /// Probes every agent again (Settings › Agents › Re-check). Updates `agents` as each answers.
    public func recheckAgents() async {
        do {
            for try await m in server.stream(.subscribe(.agents), keepAlive: false) {
                if case let .agents(a) = m {
                    agents = a.agents
                    if a.pending.isEmpty { break }
                }
            }
        } catch {
            actionError = "\(error)"
        }
    }

    public func diagnostics() async -> String? {
        if case let .diagnostics(m) = try? await server.request(.diagnostics, timeout: .seconds(90)) { return m.text }
        return nil
    }

    /// Restarts the server: it drains and exits 1, launchd starts it again, and the connection follows.
    public func restartServer() async {
        _ = try? await server.request(.shutdown, timeout: .seconds(10))
        try? await Task.sleep(for: .milliseconds(500))
        server.reconnect()
    }
}

/// Lets the connection's status callback reach the model without retaining it.
private final class WeakBox: @unchecked Sendable {
    weak var model: AppModel?
}
