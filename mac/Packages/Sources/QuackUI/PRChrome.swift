import AppKit
import QuackProtocol
import QuackStores
import SwiftUI

private func shortSha(_ sha: String) -> String { String(sha.prefix(7)) }

// MARK: - Review control

/// The toolbar control that follows the review phase.
public struct ReviewControl: View {
    var store: PRStore
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    public init(store: PRStore) { self.store = store }

    public var body: some View {
        if let review = store.review {
            switch review.phase {
            case .preparing:
                HStack(spacing: 6) {
                    if reduceMotion { Text("…") } else { ProgressView().controlSize(.small) }
                    Text("Preparing worktree…").font(.system(size: 13))
                }
                .accessibilityElement(children: .combine)
            case .ready:
                Menu("Reviewing") {
                    Button("Stop reviewing") { Task { await store.stopReview() } }
                    Button("Stop and remove worktree") { Task { await store.stopReview(removeWorktree: true) } }
                    Divider()
                    Button("Re-run labels") { Task { await store.rerunLabels() } }
                }
                .fixedSize()
                .accessibilityLabel("Reviewing, menu")
            case .stale:
                HStack(spacing: 10) {
                    Text(newCommitsText(review)).font(.system(size: 13)).foregroundStyle(.secondary)
                    Button {
                        Task { await store.updateReview() }
                    } label: {
                        Label("Update", systemImage: "arrow.up")
                    }
                    .buttonStyle(QuackPrimaryStyle())
                }
                .accessibilityElement(children: .combine)
                .accessibilityLabel("\(newCommitsText(review)), update")
            case .failed:
                HStack(spacing: 10) {
                    Text("Couldn’t prepare").font(.system(size: 13)).foregroundStyle(.secondary)
                    Button("Retry") { Task { await store.startReview() } }
                }
            }
        } else {
            Button {
                Task { await store.startReview() }
            } label: {
                Label("Start reviewing", systemImage: "eyeglasses")
            }
            .buttonStyle(QuackPrimaryStyle())
            .accessibilityLabel("Start reviewing")
        }
    }
}

// MARK: - Banner

/// The single banner slot at the top of the diff.
public struct PRBanner: View {
    var store: PRStore
    var model: AppModel
    public init(store: PRStore, model: AppModel) {
        self.store = store
        self.model = model
    }

    public var body: some View {
        if let review = store.review, let closed = review.closed {
            // Merged or closed while you're reviewing: the review and worktree end a day after closing.
            TimelineView(.periodic(from: .now, by: 60)) { context in
                Banner(.warning, title: closedTitle(closed, now: context.date), message: "Chat stays for 30 days. The worktree goes tomorrow.") {
                    Button("Stop reviewing") { Task { await store.stopReview() } }
                }
            }
        } else if let review = store.review {
            switch review.phase {
            case .stale:
                Banner(.warning, title: "\(newCommitsText(review)).", message: "Labels and chat are for \(shortSha(review.headSha)) until you update.") {
                    Button("Update") { Task { await store.updateReview() } }
                }
            case .failed:
                VStack(alignment: .leading, spacing: 10) {
                    Banner(.error, title: "Couldn’t prepare", message: review.error) {
                        Button("Retry") { Task { await store.startReview() } }
                    }
                    if let steps = review.fixSteps, !steps.isEmpty { FixStepsView(steps) }
                }
            case .preparing, .ready:
                EmptyView()
            }
        }
    }
}

/// "Merged by Noor 10 min ago." / "Closed 2 h ago."
private func closedTitle(_ closed: ClosedInfo, now: Date) -> String {
    let ago = ISODate.parse(closed.at).map { WaitFormat.ago(now.timeIntervalSince($0)) } ?? ""
    switch closed.state {
    case .merged: return closed.by.map { "Merged by \($0) \(ago)." } ?? "Merged \(ago)."
    case .closed: return "Closed \(ago)."
    }
}

// MARK: - Open in Cursor and Terminal

/// Cursor | Terminal: opens the review worktree, preparing it first when needed.
public struct OpenInControl: View {
    var store: PRStore
    @State private var busy = false
    @State private var note: Note?
    @State private var showNote = false

    public init(store: PRStore) { self.store = store }

    private struct Note: Equatable {
        var text: String
        var canHide: Bool
    }

    private enum Target: String {
        case cursor = "Cursor", terminal = "Terminal"

        var bundleID: String { self == .cursor ? "com.todesktop.230313mzl4w4u92" : "com.apple.Terminal" }

        @MainActor var appURL: URL? {
            if let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundleID) { return url }
            let candidates = ["/Applications/\(rawValue).app", NSHomeDirectory() + "/Applications/\(rawValue).app", "/System/Applications/Utilities/\(rawValue).app"]
            return candidates.first { FileManager.default.fileExists(atPath: $0) }.map { URL(fileURLWithPath: $0) }
        }
    }

    @MainActor private enum Session {
        static var shown: Set<String> = []
        static let hiddenKey = "worktreeNote.hidden"
    }

    public var body: some View {
        ControlGroup {
            Button { open(.cursor) } label: {
                Label("Cursor", systemImage: "arrow.up.forward.app")
            }
            .accessibilityLabel("Open in Cursor")
            .help("Open the worktree in Cursor")
            Button { open(.terminal) } label: {
                Label("Terminal", systemImage: "terminal")
            }
            .accessibilityLabel("Open in Terminal")
            .help("Open the worktree in Terminal")
        }
        .labelStyle(.titleAndIcon)
        .disabled(busy)
        .popover(isPresented: $showNote, arrowEdge: .bottom) {
            if let note {
                VStack(alignment: .leading, spacing: 10) {
                    Text(note.text)
                        .font(.system(size: 12))
                        .fixedSize(horizontal: false, vertical: true)
                    HStack {
                        if note.canHide {
                            Button("Don’t show again") {
                                UserDefaults.standard.set(true, forKey: "worktreeNote.hidden")
                                showNote = false
                            }
                        }
                        Spacer(minLength: 0)
                        Button("OK") { showNote = false }.keyboardShortcut(.defaultAction)
                    }
                    .controlSize(.small)
                }
                .padding(14)
                .frame(width: 280)
            }
        }
    }

    private func open(_ target: Target) {
        busy = true
        Task {
            defer { busy = false }
            if store.review == nil || store.review?.phase == .failed { await store.startReview() }
            // Wait (briefly) for the worktree.
            var waited = 0
            while waited < 240, store.review == nil || store.review?.phase == .preparing {
                try? await Task.sleep(for: .milliseconds(500))
                waited += 1
            }
            guard let review = store.review, review.phase == .ready || review.phase == .stale, !review.worktreePath.isEmpty else {
                present(Note(text: "The worktree isn’t ready yet. Try again once it’s prepared.", canHide: false))
                return
            }
            guard let appURL = target.appURL else {
                present(Note(text: "\(target.rawValue) isn’t installed.", canHide: false))
                return
            }
            do {
                try await NSWorkspace.shared.open([URL(fileURLWithPath: review.worktreePath)], withApplicationAt: appURL, configuration: NSWorkspace.OpenConfiguration())
            } catch {
                present(Note(text: "Couldn’t open \(target.rawValue). \(error.localizedDescription)", canHide: false))
                return
            }
            guard !UserDefaults.standard.bool(forKey: Session.hiddenKey), Session.shown.insert(target.rawValue).inserted else { return }
            present(Note(text: "Opened the worktree in \(target.rawValue). It’s a scratch copy at \(shortSha(review.headSha)). Edits there are discarded on the next update.", canHide: true))
        }
    }

    private func present(_ note: Note) {
        self.note = note
        showNote = true
    }
}

// MARK: - Status bar

/// 28 pt: agent and model, SHA, freshness, CI, review phase, read-only note.
public struct PRStatusBar: View {
    var store: PRStore
    var model: AppModel
    public init(store: PRStore, model: AppModel) {
        self.store = store
        self.model = model
    }

    private var item: InboxItem? { model.item(for: store.pr) }
    private var review: ReviewState? { store.review }

    private var agentText: String? {
        if let labels = store.labels {
            return agentLine(labels.agent, labels.model)
        }
        if let agent = store.effectiveAgent { return agentLine(agent, store.askModel) }
        return nil
    }

    private func agentLine(_ agent: AgentId, _ modelName: String) -> String {
        let label = model.agents.first { $0.id == agent }?.label ?? (agent == .cursor ? "Cursor" : "Claude Code")
        return "\(label) · \(modelName.isEmpty ? "Default" : modelName)"
    }

    private var sha: String? {
        let value = review?.headSha ?? store.diff?.headSha ?? item?.headSha ?? ""
        return value.isEmpty ? nil : value
    }

    public var body: some View {
        VStack(spacing: 0) {
            Divider()
            HStack(spacing: 14) {
                if let agentText { Text(agentText) }
                if let sha {
                    Button { copyToPasteboard(sha) } label: {
                        Text(verbatim: shortSha(sha)).font(.system(size: 11, design: .monospaced))
                    }
                    .buttonStyle(.plain)
                    .help("Copy full SHA")
                    .accessibilityLabel("Commit \(shortSha(sha)), copy")
                }
                freshness
                ci
                phase
                Spacer(minLength: 0)
                Label("Worktree is read-only", systemImage: "lock")
            }
            .font(.caption)
            .foregroundStyle(.secondary)
            .lineLimit(1)
            .padding(.horizontal, 12)
            .frame(height: 28)
        }
        .background(.bar)
    }

    @ViewBuilder private var freshness: some View {
        if let review, review.phase == .stale {
            HStack(spacing: 4) {
                Image(systemName: "arrow.triangle.2.circlepath").foregroundStyle(Tokens.warning)
                Text("\(newCommitsText(review)) · \(Text(verbatim: shortSha(review.latestHeadSha)))")
            }
            .accessibilityElement(children: .combine)
        } else {
            Text("Up to date")
        }
    }

    @ViewBuilder private var ci: some View {
        if let ci = item?.ci, ci != .none {
            Button {
                NSWorkspace.shared.open(store.pr.githubURL.appendingPathComponent("checks"))
            } label: {
                HStack(spacing: 4) {
                    CIGlyph(ci).font(.system(size: 11))
                    Text("Checks \(ci.rawValue)")
                }
            }
            .buttonStyle(.plain)
            .help("Open checks on GitHub")
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("Checks \(ci.rawValue), open on GitHub")
        }
    }

    @ViewBuilder private var phase: some View {
        if let review {
            let (color, name): (Color, String) = switch review.phase {
            case .preparing: (.orange, "Preparing")
            case .ready: (Tokens.success, "Ready")
            case .stale: (Tokens.warning, "Stale")
            case .failed: (Tokens.danger, "Failed")
            }
            HStack(spacing: 5) {
                Circle().fill(color).frame(width: 7, height: 7)
                Text(name)
            }
            .accessibilityElement(children: .combine)
        } else {
            Text("Not started")
        }
    }
}

// MARK: - Previews

@MainActor private func previewStore(_ review: ReviewState?) -> PRStore {
    PRStore(preview: PRPartsSamples.pr, model: PRPartsSamples.model, review: review, labels: PRPartsSamples.labels(), diff: PRPartsSamples.diff)
}

#Preview("Review control") {
    VStack(alignment: .leading, spacing: 14) {
        ReviewControl(store: previewStore(nil))
        ReviewControl(store: previewStore(PRPartsSamples.review("preparing", step: "fetching", labels: "none")))
        ReviewControl(store: previewStore(PRPartsSamples.review("ready")))
        ReviewControl(store: previewStore(PRPartsSamples.review("stale")))
        ReviewControl(store: previewStore(PRPartsSamples.review("failed", labels: "none", error: "No clone found.")))
        OpenInControl(store: previewStore(PRPartsSamples.review("ready")))
    }
    .padding(20)
}

#Preview("Banners") {
    VStack(spacing: 12) {
        PRBanner(store: previewStore(PRPartsSamples.review("stale")), model: PRPartsSamples.model)
        PRBanner(store: previewStore(PRPartsSamples.review("failed", labels: "none", error: "No clone of acme/trailmap was found.")), model: PRPartsSamples.model)
    }
    .padding(20)
    .frame(width: 640)
}

#Preview("Status bar") {
    VStack(spacing: 0) {
        PRStatusBar(store: previewStore(PRPartsSamples.review("ready")), model: PRPartsSamples.model)
        PRStatusBar(store: previewStore(PRPartsSamples.review("stale")), model: PRPartsSamples.model)
        PRStatusBar(store: previewStore(nil), model: PRPartsSamples.model)
    }
    .frame(width: 820)
}
