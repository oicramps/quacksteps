import AppKit
import QuackClient
import QuackProtocol
import QuackStores
import SwiftUI

// The inbox window: a glass sidebar of filters and one list of review requests and my PRs.

/// "checked 40 s ago" for the inbox subtitle and the menu header. nil before the first poll.
func quackCheckedAgo(fetchedAt: String?, now: Date) -> String? {
    guard let fetchedAt, let date = ISODate.parse(fetchedAt) else { return nil }
    return "checked \(WaitFormat.ago(now.timeIntervalSince(date)))"
}

public struct InboxView: View {
    var model: AppModel
    var openPR: (PrKey) -> Void
    var openSetup: () -> Void
    /// The main window's tabs. With it, PRs open as tabs beside the Inbox in this same window.
    var workspace: Workspace?
    var openAccounts: () -> Void

    @State private var filter: InboxFilter? = .everything
    @State private var search = ""
    @State private var selection: String?
    @State private var now = Date()
    @State private var columnVisibility: NavigationSplitViewVisibility = .all
    @State private var paletteShown = false
    @FocusState private var inboxSearchFocused: Bool
    /// Bumped to focus the PR tab's ranked-files filter.
    @State private var filterFocusRequest = 0

    public init(model: AppModel, workspace: Workspace? = nil, openPR: @escaping (PrKey) -> Void, openSetup: @escaping () -> Void, openAccounts: @escaping () -> Void = {}) {
        self.model = model
        self.workspace = workspace
        self.openPR = openPR
        self.openSetup = openSetup
        self.openAccounts = openAccounts
    }

    private var activeFilter: InboxFilter { filter ?? .everything }

    public var body: some View {
        NavigationSplitView(columnVisibility: $columnVisibility) {
            // Xcode-style: the sidebar follows the tab. Inbox filters for the Inbox, ranked files for a PR.
            if let workspace, case let .pr(pr) = workspace.selected {
                RankedFilesSidebar(store: model.store(for: pr), model: model, focusRequest: filterFocusRequest)
                    .navigationSplitViewColumnWidth(min: 260, ideal: 300, max: 420)
                    .id(pr.id)
            } else {
                sidebar
                    .navigationSplitViewColumnWidth(224)
            }
        } detail: {
            if let workspace {
                // IDE style: tabs above the main area; the sidebar stays put.
                VStack(spacing: 0) {
                    WorkspaceTabBar(model: model, workspace: workspace)
                    switch workspace.selected {
                    case .inbox: detail
                    case let .pr(pr): PRTabView(model: model, workspace: workspace, store: model.store(for: pr), toggleSidebar: toggleSidebar, focusFilter: focusPRFilter).id(pr.id)
                    }
                }
            } else {
                detail
            }
        }
        .background(windowShortcuts)
        // Picking a filter or repo always shows the Inbox tab.
        .onChange(of: filter) { workspace?.selected = .inbox }
        .task {
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(15))
                now = Date()
            }
        }
    }

    // MARK: Shortcuts

    private var onPRTab: Bool {
        if let workspace, case .pr = workspace.selected { return true }
        return false
    }

    private func toggleSidebar() {
        columnVisibility = columnVisibility == .detailOnly ? .all : .detailOnly
    }

    private func focusPRFilter() {
        if columnVisibility == .detailOnly {
            // The sidebar view is rebuilt when it reappears; give it a beat before asking for focus.
            columnVisibility = .all
            Task {
                try? await Task.sleep(for: .milliseconds(250))
                filterFocusRequest += 1
            }
        } else {
            filterFocusRequest += 1
        }
    }

    /// Shortcuts for the whole window, as hidden buttons (menu commands can't see this view's state).
    /// ⌘F is for the PR tab's filter here; the inbox's own shortcuts live in `inboxShortcuts`.
    private var windowShortcuts: some View {
        Group {
            Button("") { toggleSidebar() }.keyboardShortcut("s", modifiers: [.command, .control])
            if onPRTab {
                Button("") { focusPRFilter() }.keyboardShortcut("f")
            }
        }
        .opacity(0)
        .frame(width: 0, height: 0)
        .accessibilityHidden(true)
    }

    private var selectedItem: InboxItem? {
        guard let selection else { return nil }
        return model.items.first { $0.id == selection }
    }

    private func toggleReview(_ item: InboxItem) {
        Task {
            if item.review == nil { await model.startReview(item.pr) } else { await model.stopReview(item.pr) }
        }
    }

    /// The Inbox tab's shortcuts. Only in the tree while the Inbox is showing, so ⌘K never double-fires with the PR tab's.
    private var inboxShortcuts: some View {
        Group {
            Button("") { paletteShown.toggle() }.keyboardShortcut("k")
            Button("") { inboxSearchFocused = true }.keyboardShortcut("f")
            Button("") { if let item = selectedItem { toggleReview(item) } }.keyboardShortcut("c", modifiers: [.command, .shift])
            Button("") { if let item = selectedItem { NSWorkspace.shared.open(item.pr.githubURL) } }.keyboardShortcut("g", modifiers: [.command, .shift])
        }
        .opacity(0)
        .frame(width: 0, height: 0)
        .accessibilityHidden(true)
    }

    private var inboxCommands: [PaletteCommand] {
        var list = [
            PaletteCommand(id: "refresh", title: "Refresh from GitHub", symbol: "arrow.clockwise", shortcut: "⌘R") { Task { await model.refresh() } },
            PaletteCommand(id: "sidebar", title: "Show or hide sidebar", symbol: "sidebar.left", shortcut: "⌃⌘S") { toggleSidebar() },
            PaletteCommand(id: "search", title: "Search PRs", symbol: "magnifyingglass", shortcut: "⌘F") { inboxSearchFocused = true },
        ]
        if let item = selectedItem {
            list.append(PaletteCommand(id: "github", title: "Open on GitHub", symbol: "globe", shortcut: "⌘⇧G") { NSWorkspace.shared.open(item.pr.githubURL) })
            list.append(PaletteCommand(id: "review", title: item.review == nil ? "Start reviewing" : "Stop reviewing", symbol: "eyeglasses", shortcut: "⌘⇧C") { toggleReview(item) })
        }
        return list
    }

    // MARK: Sidebar

    private var sidebar: some View {
        List(selection: $filter) {
            Label("Everything", systemImage: "tray").badge(model.count(for: .everything)).tag(InboxFilter.everything)
            Label("Review requests", systemImage: "person.2").badge(model.count(for: .reviewRequests)).tag(InboxFilter.reviewRequests)
            Label("My PRs", systemImage: "arrow.triangle.branch").badge(model.count(for: .myPRs)).tag(InboxFilter.myPRs)
            Label("Reviewing", systemImage: "eyeglasses").badge(model.count(for: .reviewing)).tag(InboxFilter.reviewing)
            Section("Show PRs from") {
                AccountPicker(model: model, openAccounts: openAccounts)
                    .listRowInsets(EdgeInsets(top: 2, leading: 8, bottom: 4, trailing: 8))
                    .listRowSeparator(.hidden)
                    .selectionDisabled()
            }
            if !model.repos.isEmpty {
                Section("Repos") {
                    ForEach(model.repos, id: \.name) { repo in
                        RepoRow(model: model, name: repo.name, count: repo.count)
                            .tag(InboxFilter.repo(repo.name))
                    }
                    if let note = hiddenReposNote {
                        Text(note)
                            .font(.system(size: 11))
                            .foregroundStyle(.tertiary)
                            .listRowSeparator(.hidden)
                            .selectionDisabled()
                    }
                }
            }
        }
        .listStyle(.sidebar)
        .safeAreaInset(edge: .bottom, spacing: 0) { serverStatus }
    }

    private var hiddenReposNote: String? {
        let hidden = model.repos.map(\.name).filter { model.isRepoHidden($0) }
        switch hidden.count {
        case 0: return nil
        case 1: return "\(hidden[0].split(separator: "/").last.map(String.init) ?? hidden[0]) hidden from the list"
        default: return "\(hidden.count) repos hidden from the list"
        }
    }

    private var serverStatus: some View {
        HStack(spacing: 6) {
            Circle()
                .fill(model.isConnected ? Tokens.success : Tokens.warning)
                .frame(width: 7, height: 7)
                .accessibilityHidden(true)
            Text(statusText)
                .font(.system(size: 11))
                .foregroundStyle(.secondary)
                .lineLimit(1)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .accessibilityElement(children: .combine)
    }

    private var statusText: String {
        guard model.isConnected else { return "Server unreachable" }
        if let viewer = model.hello?.viewer, !viewer.isEmpty { return "Server running · as \(viewer)" }
        return "Server running"
    }

    // MARK: Detail

    private var detail: some View {
        VStack(spacing: 0) {
            banners
            content
        }
        .navigationTitle(model.accountScopeName.map { "Inbox · \($0)" } ?? "Inbox")
        .navigationSubtitle(subtitle)
        .searchable(text: $search, prompt: "Search PRs")
        .searchFocused($inboxSearchFocused)
        .background(inboxShortcuts)
        .overlay {
            if paletteShown, let workspace {
                CommandPalette(model: model, workspace: workspace, store: nil, commands: inboxCommands, isPresented: $paletteShown) { _ in }
            }
        }
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button {
                    Task { await model.refresh() }
                } label: {
                    Label("Refresh", systemImage: "arrow.clockwise")
                }
                .keyboardShortcut("r", modifiers: .command)
                .help("Refresh")
                .disabled(model.refreshing)
            }
        }
    }

    private var subtitle: String {
        guard model.isConnected, model.hasPolled else { return "" }
        if model.accountScope != nil { return quackCheckedAgo(fetchedAt: model.inbox?.fetchedAt, now: now) ?? "" }
        let need = "\(model.waitingCount) need you"
        guard let ago = quackCheckedAgo(fetchedAt: model.inbox?.fetchedAt, now: now) else { return need }
        return "\(need) · \(ago)"
    }

    @ViewBuilder private var content: some View {
        if case .disconnected = model.connection {
            unreachable
        } else if !model.isConnected || !model.hasPolled {
            loading
        } else {
            let result = model.items(for: activeFilter, matching: search)
            let reviews = result.reviews
            let mine = result.mine.filter { $0.author?.state != nil } + result.mine.filter { $0.author?.state == nil }
            let counts = model.sectionCounts(for: activeFilter, matching: search)
            let more = model.inbox?.more
            let showMoreReviews = (activeFilter == .everything || activeFilter == .reviewRequests) && search.isEmpty && (more?.reviewer ?? 0) > 0
            let showMoreMine = (activeFilter == .everything || activeFilter == .myPRs) && search.isEmpty && (more?.author ?? 0) > 0
            let scoped = model.accountScopeName
            let searching = !search.trimmingCharacters(in: .whitespaces).isEmpty
            let emptyReviews = scoped != nil && !searching && reviews.isEmpty && !showMoreReviews && (activeFilter == .everything || activeFilter == .reviewRequests)
            let emptyMine = scoped != nil && !searching && mine.isEmpty && !showMoreMine && (activeFilter == .everything || activeFilter == .myPRs)
            if reviews.isEmpty, mine.isEmpty, !showMoreReviews, !showMoreMine, !emptyReviews, !emptyMine {
                emptyState
            } else {
                list(scope: scoped, emptyReviews: emptyReviews, emptyMine: emptyMine, reviews: reviews, mine: mine, counts: counts, moreReviews: showMoreReviews ? more?.reviewer ?? 0 : 0, moreMine: showMoreMine ? more?.author ?? 0 : 0)
            }
        }
    }

    private func list(scope: String?, emptyReviews: Bool, emptyMine: Bool, reviews: [InboxItem], mine: [InboxItem], counts: (reviews: (shown: Int, total: Int), mine: (shown: Int, total: Int)), moreReviews: Int, moreMine: Int) -> some View {
        List(selection: $selection) {
            if emptyReviews, let scope {
                Section {
                    ScopedEmpty(symbol: "tray", title: "No review requests from \(scope)", message: "Nobody has asked you to review anything there.")
                } header: {
                    sectionHeader("Review requests", count: (0, 0), note: nil)
                }
            }
            if !reviews.isEmpty || moreReviews > 0 {
                Section {
                    // Requests waiting on me first; those someone else already approved after, under their own heading.
                    let waiting = reviews.filter { $0.reviewer?.isApprovedByOthers != true }
                    let approved = reviews.filter { $0.reviewer?.isApprovedByOthers == true }
                    ForEach(waiting) { item in
                        ReviewRow(item: item).tag(item.id)
                    }
                    if !approved.isEmpty {
                        HStack(spacing: 6) {
                            Text("Approved by someone else").font(.system(size: 11, weight: .semibold))
                            Text(verbatim: "\(approved.count)").monospacedDigit()
                            Text("Not waiting on you").font(.system(size: 11))
                                .frame(maxWidth: .infinity, alignment: .trailing)
                        }
                        .font(.system(size: 11))
                        .foregroundStyle(.secondary)
                        .padding(.top, waiting.isEmpty ? 0 : 10)
                        .selectionDisabled()
                        .accessibilityAddTraits(.isHeader)
                        ForEach(approved) { item in
                            ReviewRow(item: item).tag(item.id)
                        }
                    }
                    if moreReviews > 0 { moreRow(moreReviews, url: "https://github.com/pulls/review-requested") }
                } header: {
                    sectionHeader("Review requests", count: counts.reviews, note: "Longest wait first")
                }
            }
            if emptyMine, let scope {
                Section {
                    ScopedEmpty(symbol: "arrow.triangle.branch", title: "None of your PRs are open in \(scope)", message: "Open PRs you author there show up here.")
                } header: {
                    sectionHeader("My PRs", count: (0, 0), note: nil)
                }
            }
            if !mine.isEmpty || moreMine > 0 {
                Section {
                    ForEach(mine) { item in
                        MyPRRow(item: item).tag(item.id)
                    }
                    if moreMine > 0 { moreRow(moreMine, url: "https://github.com/pulls") }
                } header: {
                    sectionHeader("My PRs", count: counts.mine, note: nil)
                }
            }
        }
        .contextMenu(forSelectionType: String.self) { ids in
            if ids.count == 1, let item = model.items.first(where: { $0.id == ids.first }) {
                if item.review == nil {
                    Button("Start reviewing") { Task { await model.startReview(item.pr) } }
                        .keyboardShortcut("c", modifiers: [.command, .shift])
                } else {
                    Button("Stop reviewing") { Task { await model.stopReview(item.pr) } }
                        .keyboardShortcut("c", modifiers: [.command, .shift])
                }
                Button("Open on GitHub") { NSWorkspace.shared.open(item.pr.githubURL) }
                    .keyboardShortcut("g", modifiers: [.command, .shift])
                Button("Copy link") { copyToPasteboard(item.pr.githubURL.absoluteString) }
            }
        } primaryAction: { ids in
            if ids.count == 1, let item = model.items.first(where: { $0.id == ids.first }) { openPR(item.pr) }
        }
    }

    private func sectionHeader(_ title: String, count: (shown: Int, total: Int), note: String?) -> some View {
        HStack(spacing: 6) {
            Text(title).font(.system(size: 13, weight: .semibold))
            Text(count.shown < count.total ? "\(count.shown) of \(count.total)" : "\(count.shown)").monospacedDigit().foregroundStyle(.secondary)
            Spacer()
            if let note { Text(note).font(.system(size: 11)).foregroundStyle(.secondary) }
        }
        .textCase(nil)
        .foregroundStyle(.primary)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isHeader)
    }

    @ViewBuilder private func moreRow(_ count: Int, url: String) -> some View {
        if let destination = URL(string: url) {
            Link(destination: destination) {
                Label("+\(count) more on GitHub", systemImage: "arrow.up.right")
                    .font(.system(size: 12))
            }
            .padding(.vertical, 4)
        }
    }

    // MARK: Banners

    @ViewBuilder private var banners: some View {
        if let message = model.actionError {
            Banner(.error, title: "That didn’t work.", message: message) {
                Button("Dismiss") { model.actionError = nil }
            }
            .padding([.horizontal, .top], 12)
            .padding(.bottom, 4)
        } else if let error = model.inbox?.error {
            VStack(spacing: 8) {
                inboxErrorBanner(error)
                if error.code != .rateLimited, error.code != .ghSsoRequired, let steps = error.fixSteps, !steps.isEmpty {
                    FixStepsView(steps)
                }
            }
            .padding([.horizontal, .top], 12)
            .padding(.bottom, 4)
        }
    }

    @ViewBuilder private func inboxErrorBanner(_ error: some InboxErrorLike) -> some View {
        if error.code == .rateLimited {
            Banner(.warning, title: "GitHub asked us to slow down.", message: fromTime.map { "The list below is from \($0)." })
        } else if error.code == .ghSsoRequired {
            Banner(.error, title: "Some polarsteps PRs may be missing.", message: "The GitHub CLI isn’t authorised for the org’s single sign-on.") {
                Button("Fix…") { openSetup() }
            }
        } else if let command = error.fixSteps?.compactMap(\.command).first {
            Banner(.error, title: error.message) {
                Button("Copy") { copyToPasteboard(command) }
            }
        } else {
            Banner(.error, title: error.message)
        }
    }

    private var fromTime: String? {
        guard let text = model.inbox?.fetchedAt, let date = ISODate.parse(text) else { return nil }
        return date.formatted(.dateTime.hour(.twoDigits(amPM: .omitted)).minute(.twoDigits))
    }

    // MARK: States

    private var unreachable: some View {
        EmptyState(
            symbol: "exclamationmark.triangle",
            headline: "The server went quiet.",
            message: "Quacksteps can’t reach its server at ~/.quack/run/quack.sock. Your reviews and labels are safe on disk."
        ) {
            Button("Restart server") { Task { await model.restartServer() } }
            Button("Copy diagnostics") {
                Task {
                    if let text = await model.diagnostics() {
                        copyToPasteboard(text)
                    } else {
                        var fallback = "Quacksteps can’t reach its server at ~/.quack/run/quack.sock."
                        if case let .disconnected(reason) = model.connection { fallback += "\n\(reason)" }
                        copyToPasteboard(fallback)
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var loading: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("Asking GitHub nicely…")
                .font(QuackFont.headline(14))
                .accessibilityAddTraits(.isHeader)
                .padding(.horizontal, 20)
                .padding(.top, 18)
                .padding(.bottom, 10)
            ForEach(0 ..< 4, id: \.self) { index in
                HStack(spacing: 12) {
                    Circle().fill(Color.primary.opacity(0.07)).frame(width: 24, height: 24)
                    VStack(alignment: .leading, spacing: 7) {
                        SkeletonBar(width: [260, 200, 300, 230][index])
                        SkeletonBar(width: [150, 190, 130, 170][index])
                    }
                    Spacer()
                    SkeletonBar(width: 40)
                }
                .padding(.horizontal, 20)
                .padding(.vertical, 10)
                .accessibilityHidden(true)
            }
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    @ViewBuilder private var emptyState: some View {
        if !search.trimmingCharacters(in: .whitespaces).isEmpty {
            ContentUnavailableView.search(text: search)
        } else if model.items.isEmpty, model.accountScope == nil {
            EmptyState(
                symbol: "tray",
                headline: "Inbox zero. Suspicious.",
                message: "No review requests and none of your PRs are open. Quack checks GitHub every minute."
            )
        } else {
            EmptyState(symbol: "tray", headline: "Nothing here.", message: "Nothing matches this view right now.")
        }
    }
}

/// Lets the banner builder take the protocol's error without naming `ServerError` (QuackClient has one too).
protocol InboxErrorLike {
    var code: ErrorCode { get }
    var message: String { get }
    var fixSteps: [FixStep]? { get }
}

extension QuackProtocol.ServerError: InboxErrorLike {}

// MARK: - Rows

private extension StackInfo {
    /// "Stacked on #4127, 2 of 2." for VoiceOver.
    var spoken: String {
        if let parent { return "Stacked on #\(parent.number), \(position) of \(size)." }
        return "Stack, \(position) of \(size)."
    }
}

/// A sidebar repo: a visibility checkbox, then the name (which selects the repo as a filter) and its total.
private struct RepoRow: View {
    var model: AppModel
    var name: String
    var count: Int

    private var shown: Bool { !model.isRepoHidden(name) }

    var body: some View {
        HStack(spacing: 8) {
            Toggle(isOn: Binding(get: { shown }, set: { model.setRepo(name, hidden: !$0) })) {
                Text(verbatim: "Show \(name)")
            }
            .toggleStyle(.checkbox)
            .labelsHidden()
            .controlSize(.small)
            .accessibilityLabel(Text(verbatim: "Show \(name)"))
            Text(verbatim: name).lineLimit(1)
            Spacer(minLength: 4)
            Text(verbatim: "\(count)").monospacedDigit().foregroundStyle(.secondary)
        }
        .opacity(shown ? 1 : 0.45)
    }
}

private struct Quip: View {
    var since: Date
    var text: (WaitLevel) -> String?

    var body: some View {
        TimelineView(.periodic(from: .now, by: 60)) { context in
            if let line = text(waitLevel(since: since, now: context.date)) {
                Text(line)
                    .font(.system(size: 11).italic())
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .frame(maxWidth: 190, alignment: .trailing)
                    .accessibilityHidden(true)
            }
        }
    }
}

private struct ReviewRow: View {
    var item: InboxItem

    private var requestedAt: Date { item.reviewer.flatMap { ISODate.parse($0.requestedAt) } ?? Date() }
    private var approvedBy: [String]? { item.reviewer?.isApprovedByOthers == true ? item.reviewer?.approvedBy : nil }

    /// "Approved by noor", "Approved by noor +1".
    private func approvedLabel(_ logins: [String]) -> String {
        logins.count > 1 ? "Approved by \(logins[0]) +\(logins.count - 1)" : "Approved by \(logins[0])"
    }

    var body: some View {
        HStack(spacing: 12) {
            Avatar(item.authorLogin, size: 24)
            VStack(alignment: .leading, spacing: 2) {
                Text(item.title).font(.system(size: 13, weight: .medium)).lineLimit(1)
                caption
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            if let stack = item.stack { StackChip(stack) }
            if let approvers = approvedBy { Chip(approvedLabel(approvers), symbol: "checkmark", foreground: Tokens.success, background: Tokens.greenBg) }
            if let review = item.review { ReviewChip(phase: review.phase, review: review) }
            CIGlyph(item.ci)
            // Someone else approved: the wait isn't owed by you, so no quip and no urgency colour.
            if approvedBy == nil { Quip(since: requestedAt) { Quips.reviewRequest($0) } }
            WaitTimer(since: requestedAt)
                .frame(width: 74, alignment: .trailing)
        }
        .opacity(approvedBy == nil ? 1 : 0.7)
        .padding(.vertical, 4)
        .contentShape(Rectangle())
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(item.title), by \(item.authorLogin), \(item.pr.repo) \(item.pr.number)")
        .accessibilityValue(value)
    }

    private var caption: some View {
        HStack(spacing: 0) {
            Text(captionText)
            LineCounts(item.additions, item.deletions)
        }
        .font(.system(size: 11))
        .foregroundStyle(.secondary)
        .lineLimit(1)
    }

    private var captionText: String {
        var text = "\(item.pr.repo) #\(item.pr.number) · \(item.authorLogin)"
        if item.reviewer?.via == .team, let team = item.reviewer?.team { text += " · via @\(team)" }
        if let parent = item.stack?.parent { text += " · on top of #\(parent.number)" }
        return text + " · "
    }

    private var value: String {
        var parts = ["Waiting \(WaitFormat.spoken(Date().timeIntervalSince(requestedAt)))."]
        if let approvers = approvedBy { parts.append("\(approvedLabel(approvers)), not waiting on you.") }
        if let spoken = item.stack?.spoken { parts.append(spoken) }
        switch item.review?.phase {
        case .preparing: parts.append("Preparing.")
        case .ready: parts.append("Reviewing.")
        case .stale: parts.append("\(newCommitsText(item.review)).")
        case .failed: parts.append("Couldn’t prepare.")
        case nil: break
        }
        if item.ci != .none { parts.append("Checks \(item.ci.rawValue).") }
        return parts.joined(separator: " ")
    }
}

private struct ReviewChip: View {
    var phase: ReviewState.Phase
    var review: ReviewState? = nil

    var body: some View {
        switch phase {
        case .preparing: Chip("Preparing", symbol: "circle.dotted")
        case .ready:
            if review?.labels == .running { Chip("Labeling", symbol: "list.number") } else { Chip("Reviewing", symbol: "eyeglasses") }
        case .stale: Chip(newCommitsText(review), symbol: "arrow.triangle.2.circlepath", foreground: Tokens.warning, background: Tokens.medBg)
        case .failed: Chip("Couldn’t prepare", symbol: "exclamationmark.triangle", foreground: Tokens.danger, background: Tokens.highBg)
        }
    }
}

private struct MyPRRow: View {
    var item: InboxItem

    private var state: AuthorState? { item.author?.state }
    private var since: Date { item.author.flatMap { ISODate.parse($0.since) } ?? Date() }
    private var isDraft: Bool { state == nil }

    var body: some View {
        HStack(spacing: 12) {
            StatusTile(state)
            VStack(alignment: .leading, spacing: 2) {
                Text(item.title).font(.system(size: 13, weight: .medium)).lineLimit(1)
                Text(caption).font(.system(size: 11)).foregroundStyle(.secondary).lineLimit(1)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            if let stack = item.stack { StackChip(stack) }
            Chip(state: state)
            CIGlyph(item.ci)
            if let state {
                Quip(since: since) { Quips.author(state, $0) }
                WaitTimer(since: since).frame(width: 74, alignment: .trailing)
            } else {
                Text("—").foregroundStyle(.secondary).frame(width: 74, alignment: .trailing).accessibilityHidden(true)
            }
        }
        .padding(.vertical, 4)
        .opacity(isDraft ? 0.7 : 1)
        .contentShape(Rectangle())
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(item.title)
        .accessibilityValue(value)
    }

    private var caption: String {
        var base = "\(item.pr.repo) #\(item.pr.number)"
        if let parent = item.stack?.parent { base += " · on top of #\(parent.number)" }
        if isDraft { return "\(base) · Draft" }
        let reasons = item.author?.reasons ?? []
        return reasons.isEmpty ? base : "\(base) · \(reasons.joined(separator: " · "))"
    }

    private var value: String {
        guard let state else { return ([item.stack?.spoken, "Draft."].compactMap { $0 }).joined(separator: " ") }
        let spoken = WaitFormat.spoken(Date().timeIntervalSince(since))
        var parts: [String] = []
        if let spoken = item.stack?.spoken { parts.append(spoken) }
        switch state {
        case .waitingOnMe: parts.append("Waiting on you for \(spoken).")
        case .waitingOnReviewers: parts.append("Waiting on reviewers for \(spoken).")
        case .blockedByCI: parts.append("Blocked by CI for \(spoken).")
        case .readyToMerge: parts.append("Ready to merge for \(spoken).")
        }
        if let reasons = item.author?.reasons, !reasons.isEmpty { parts.append(reasons.joined(separator: ", ") + ".") }
        if item.ci != .none { parts.append("Checks \(item.ci.rawValue).") }
        return parts.joined(separator: " ")
    }
}

// MARK: - Preview data (synthetic)

enum QuackPreviewData {
    static func iso(_ secondsAgo: TimeInterval) -> String {
        ISO8601DateFormatter().string(from: Date().addingTimeInterval(-secondsAgo))
    }

    private static func review(repo: String, number: Int, title: String, author: String, requestedAgo: TimeInterval, via: String = "user", team: String? = nil, ci: String, additions: Int, deletions: Int, phase: String? = nil) -> [String: Any] {
        var reviewer: [String: Any] = ["requestedAt": iso(requestedAgo), "via": via]
        if let team { reviewer["team"] = team }
        var d = base(repo: repo, number: number, title: title, author: author, ci: ci, additions: additions, deletions: deletions)
        d["role"] = "reviewer"
        d["reviewer"] = reviewer
        if let phase {
            d["review"] = ["startedAt": iso(600), "headSha": "a41c9e2", "latestHeadSha": phase == "stale" ? "b52d0f3" : "a41c9e2", "worktreePath": "/tmp/wt", "phase": phase, "labels": "none"]
        }
        return d
    }

    private static func mine(repo: String, number: Int, title: String, state: String?, since: TimeInterval, reasons: [String], ci: String) -> [String: Any] {
        var d = base(repo: repo, number: number, title: title, author: "me", ci: ci, additions: 40, deletions: 8)
        d["role"] = "author"
        var author: [String: Any] = ["since": iso(since), "reasons": reasons]
        if let state { author["state"] = state }
        d["author"] = author
        d["isDraft"] = state == nil
        return d
    }

    private static func base(repo: String, number: Int, title: String, author: String, ci: String, additions: Int, deletions: Int) -> [String: Any] {
        [
            "pr": ["owner": "acme", "repo": repo, "number": number], "title": title,
            "url": "https://github.com/acme/\(repo)/pull/\(number)", "authorLogin": author, "isDraft": false,
            "headSha": "a41c9e2", "baseRef": "main", "updatedAt": iso(60), "additions": additions, "deletions": deletions, "ci": ci,
        ]
    }

    static var connected: ConnectionStatus { connected(viewer: "me") }

    static func connected(viewer: String) -> ConnectionStatus {
        let json = #"{"requestId":"p","version":"preview","protocol":2,"viewer":"\#(viewer)","capabilities":{"workspace":true,"inbox":true,"labels":true,"review":true,"agents":[]}}"#
        guard let hello = try? JSONDecoder().decode(HelloResponse.self, from: Data(json.utf8)) else { return .connecting }
        return .connected(hello)
    }

    /// Two stacked PRs in web, and one PR in a repo the preview hides.
    static func stackedMessage() -> InboxMessage? {
        var low = review(repo: "web", number: 4127, title: "Trip map: extract pin clustering", author: "noor-test", requestedAgo: 2 * 86400, ci: "passing", additions: 220, deletions: 31, phase: "ready")
        low["stack"] = ["position": 1, "size": 2]
        var top = review(repo: "web", number: 4129, title: "Trip map: cluster pins at low zoom", author: "noor-test", requestedAgo: 5 * 3600, ci: "pending", additions: 64, deletions: 9)
        top["stack"] = ["position": 2, "size": 2, "parent": ["number": 4127, "title": "Trip map: extract pin clustering"]]
        var mineTop = mine(repo: "web", number: 4133, title: "Step editor: autosave every 10 seconds", state: "waiting_on_reviewers", since: 30 * 3600, reasons: ["Requested Noor Test"], ci: "passing")
        mineTop["stack"] = ["position": 2, "size": 2, "parent": ["number": 4131, "title": "Step editor: debounce helper"]]
        let hidden = review(repo: "android", number: 88, title: "Migrate settings to DataStore", author: "mila-sample", requestedAgo: 3600, ci: "passing", additions: 300, deletions: 120)
        let json: [String: Any] = ["requestId": "preview", "fetchedAt": iso(40), "items": [low, top, mineTop, hidden], "events": []]
        guard let data = try? JSONSerialization.data(withJSONObject: json) else { return nil }
        return try? JSONDecoder().decode(InboxMessage.self, from: data)
    }

    /// Items across two organizations and two people, for the account picker. `hello` is the viewer.
    static func accountsMessage() -> InboxMessage? {
        func owned(_ d: [String: Any], _ owner: String, _ type: String) -> [String: Any] {
            var d = d
            var pr = d["pr"] as? [String: Any] ?? [:]
            pr["owner"] = owner
            d["pr"] = pr
            d["ownerType"] = type
            if let repo = pr["repo"], let n = pr["number"] { d["url"] = "https://github.com/\(owner)/\(repo)/pull/\(n)" }
            return d
        }
        let items: [[String: Any]] = [
            owned(review(repo: "web", number: 101, title: "Bump bundler to 6.2", author: "robin-vale", requestedAgo: 4 * 86400, ci: "passing", additions: 12, deletions: 12), "polarsteps", "org"),
            owned(review(repo: "api", number: 52, title: "Rate-limit photo uploads", author: "joris-demo", requestedAgo: 6 * 3600, ci: "pending", additions: 156, deletions: 20), "polarsteps", "org"),
            owned(mine(repo: "web", number: 95, title: "Step editor: autosave", state: "waiting_on_reviewers", since: 30 * 3600, reasons: ["Requested Noor Test"], ci: "passing"), "polarsteps", "org"),
            owned(review(repo: "site", number: 12, title: "Update the pricing page", author: "mila-sample", requestedAgo: 7200, ci: "passing", additions: 30, deletions: 4), "acme-labs", "org"),
            owned(mine(repo: "dotfiles", number: 3, title: "Tidy the shell config", state: "waiting_on_me", since: 3600, reasons: ["Changes requested"], ci: "none"), "hello", "user"),
            owned(mine(repo: "notes", number: 7, title: "Weekly notes template", state: "waiting_on_reviewers", since: 5400, reasons: [], ci: "passing"), "hello", "user"),
            owned(review(repo: "zine", number: 2, title: "Fix the print stylesheet", author: "sam-sample", requestedAgo: 9000, ci: "passing", additions: 8, deletions: 2), "sam-sample", "user"),
        ]
        let json: [String: Any] = ["requestId": "preview", "fetchedAt": iso(40), "items": items, "events": []]
        guard let data = try? JSONSerialization.data(withJSONObject: json) else { return nil }
        return try? JSONDecoder().decode(InboxMessage.self, from: data)
    }

    @MainActor static func accountsModel(scope: String?, suite: String) -> AppModel {
        let model = AppModel(preview: accountsMessage(), connection: connected(viewer: "hello"))
        if let defaults = UserDefaults(suiteName: suite) {
            defaults.removePersistentDomain(forName: suite)
            model.useVisibilityDefaults(defaults)
        }
        model.setAccountScope(scope)
        return model
    }

    static func message(empty: Bool = false) -> InboxMessage? {
        let items: [[String: Any]] = empty ? [] : [
            review(repo: "web", number: 101, title: "Bump bundler to 6.2", author: "robin-vale", requestedAgo: 4 * 86400 + 7200, ci: "passing", additions: 12, deletions: 12, phase: "stale"),
            review(repo: "web", number: 97, title: "Trip map: cluster pins at low zoom", author: "noor-test", requestedAgo: 2 * 86400 + 5 * 3600, ci: "passing", additions: 412, deletions: 88, phase: "ready"),
            review(repo: "api", number: 52, title: "Rate-limit photo uploads per traveller", author: "joris-demo", requestedAgo: 6 * 3600 + 720, via: "team", team: "acme/backend", ci: "pending", additions: 156, deletions: 20),
            review(repo: "ios", number: 31, title: "Offline step drafts survive an app restart", author: "mila-sample", requestedAgo: 1500, ci: "failing", additions: 903, deletions: 340, phase: "preparing"),
            mine(repo: "api", number: 49, title: "Trip export: stream GPX instead of buffering", state: "waiting_on_me", since: 3 * 3600, reasons: ["Changes requested by Sven Example", "2 unresolved threads"], ci: "passing"),
            mine(repo: "web", number: 95, title: "Step editor: autosave every 10 seconds", state: "waiting_on_reviewers", since: 30 * 3600, reasons: ["Requested Noor Test, Priya Sample"], ci: "passing"),
            mine(repo: "ios", number: 30, title: "SwiftData migration spike", state: nil, since: 100, reasons: [], ci: "none"),
        ]
        let json: [String: Any] = [
            "requestId": "preview", "fetchedAt": empty ? iso(40) : iso(40), "items": items, "events": [],
            "more": ["reviewer": 2, "author": 0],
        ]
        guard let data = try? JSONSerialization.data(withJSONObject: json) else { return nil }
        return try? JSONDecoder().decode(InboxMessage.self, from: data)
    }
}

#Preview("Inbox") {
    InboxView(model: AppModel(preview: QuackPreviewData.message(), connection: QuackPreviewData.connected), openPR: { _ in }, openSetup: {})
        .frame(width: 1000, height: 640)
}

#Preview("Server unreachable") {
    InboxView(model: AppModel(preview: nil, connection: .disconnected(reason: "No socket")), openPR: { _ in }, openSetup: {})
        .frame(width: 1000, height: 640)
}

#Preview("Inbox zero") {
    InboxView(model: AppModel(preview: QuackPreviewData.message(empty: true), connection: QuackPreviewData.connected), openPR: { _ in }, openSetup: {})
        .frame(width: 1000, height: 640)
}

#Preview("Stacked PRs, one repo hidden") {
    let model = AppModel(preview: QuackPreviewData.stackedMessage(), connection: QuackPreviewData.connected)
    if let defaults = UserDefaults(suiteName: "quack.preview.stacks") {
        defaults.removePersistentDomain(forName: "quack.preview.stacks")
        model.useVisibilityDefaults(defaults)
    }
    model.setRepo("acme/android", hidden: true)
    return InboxView(model: model, openPR: { _ in }, openSetup: {})
        .frame(width: 1000, height: 640)
}

#Preview("Account menu") {
    InboxView(model: QuackPreviewData.accountsModel(scope: nil, suite: "quack.preview.accounts.all"), openPR: { _ in }, openSetup: {})
        .frame(width: 1000, height: 640)
}

#Preview("Personal scope, no review requests") {
    InboxView(model: QuackPreviewData.accountsModel(scope: "hello", suite: "quack.preview.accounts.personal"), openPR: { _ in }, openSetup: {})
        .frame(width: 1000, height: 640)
}

#Preview("Organization scope") {
    InboxView(model: QuackPreviewData.accountsModel(scope: "polarsteps", suite: "quack.preview.accounts.org"), openPR: { _ in }, openSetup: {})
        .frame(width: 1000, height: 640)
}
