import AppKit
import QuackProtocol
import QuackStores
import SwiftUI

extension ReviewEvent {
    /// The outcome card and button title.
    var outcomeTitle: String {
        switch self {
        case .comment: "Comment"
        case .approve: "Approve"
        case .requestChanges: "Request changes"
        }
    }

    var outcomeDetail: String {
        switch self {
        case .comment: "Feedback without approving."
        case .approve: "Ready to merge after your comments."
        case .requestChanges: "Must be addressed before merging."
        }
    }

    /// Past tense, for "Review sent · Changes requested".
    var sentLabel: String {
        switch self {
        case .comment: "Commented"
        case .approve: "Approved"
        case .requestChanges: "Changes requested"
        }
    }
}

private func plural(_ n: Int, _ one: String, _ many: String) -> String { "\(n) \(n == 1 ? one : many)" }

// MARK: - Sheet

/// Submit review: outcome, summary, the comments that go with it, the gap check, then send.
public struct SubmitReviewSheet: View {
    @Bindable var store: PRStore
    @State private var event: ReviewEvent
    @State private var summary: String
    @State private var loaded = false

    public init(store: PRStore) {
        self.store = store
        _event = State(initialValue: store.reviewEvent ?? .comment)
        _summary = State(initialValue: store.reviewSummary)
    }

    private struct SaveKey: Equatable {
        var summary: String
        var event: ReviewEvent
    }

    private var trimmed: String { summary.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var sending: Bool { store.submitState == .sending }

    /// Why the main button is off, if it is. Only the summary rules are worth saying out loud.
    private var hint: String? {
        event == .requestChanges && trimmed.isEmpty ? "Requesting changes needs a summary." : nil
    }

    private var canSubmit: Bool {
        if sending || !store.outdated.isEmpty || hint != nil { return false }
        if event == .comment, trimmed.isEmpty, store.pendingCount == 0 { return false }
        return true
    }

    public var body: some View {
        VStack(spacing: 0) {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    header
                    outcomes
                    summaryField
                    commentsSection
                    GapCheckView(store: store)
                    if case let .failed(error) = store.submitState, store.outdated.isEmpty {
                        SubmitFailedPanel(store: store, error: error, event: event, summary: summary, inSheet: true)
                    }
                }
                .padding(20)
            }
            Divider()
            footer
        }
        .frame(width: 640)
        .frame(minHeight: 420, maxHeight: 760)
        .task(id: SaveKey(summary: summary, event: event)) {
            // The first pass only reads what's already saved.
            guard loaded else { loaded = true; return }
            try? await Task.sleep(for: .milliseconds(600))
            guard !Task.isCancelled else { return }
            await store.saveSummary(summary, event: event)
        }
        .onDisappear {
            if store.reviewSummary != summary || store.reviewEvent != event, store.submitState != .idle || store.pendingCount > 0 {
                let (text, chosen) = (summary, event)
                Task { await store.saveSummary(text, event: chosen) }
            }
        }
    }

    // MARK: Parts

    private var header: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text("Submit review").font(.system(size: 17, weight: .bold)).accessibilityAddTraits(.isHeader)
            Text(verbatim: "\(store.pr.repo) #\(store.pr.number)").font(.system(size: 13)).foregroundStyle(.secondary)
            Spacer(minLength: 8)
            let progress = store.viewedProgress
            Text("Viewed \(progress.viewed) of \(progress.total) files").font(.system(size: 12)).foregroundStyle(.secondary)
        }
    }

    private var outcomes: some View {
        HStack(alignment: .top, spacing: 10) {
            ForEach(ReviewEvent.allCases, id: \.self) { option in
                outcomeCard(option)
            }
        }
        // All three cards as tall as the tallest.
        .fixedSize(horizontal: false, vertical: true)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Outcome")
    }

    private func outcomeCard(_ option: ReviewEvent) -> some View {
        let on = option == event
        let shape = RoundedRectangle(cornerRadius: 10)
        return Button { event = option } label: {
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 6) {
                    Image(systemName: on ? "largecircle.fill.circle" : "circle")
                        .foregroundStyle(on ? Color.accentColor : Color.secondary)
                        .accessibilityHidden(true)
                    Text(option.outcomeTitle).font(.system(size: 13, weight: .bold))
                }
                Text(option.outcomeDetail).font(.system(size: 12)).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .padding(12)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            .background(on ? Color.accentColor.opacity(0.1) : Color.clear, in: shape)
            .overlay(shape.strokeBorder(on ? Color.accentColor : Color(nsColor: .separatorColor), lineWidth: on ? 2 : 1))
            .contentShape(shape)
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(option.outcomeTitle). \(option.outcomeDetail)")
        .accessibilityAddTraits(on ? [.isButton, .isSelected] : .isButton)
    }

    private var summaryField: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Summary").font(.system(size: 13, weight: .bold)).accessibilityAddTraits(.isHeader)
            TextEditor(text: $summary)
                .font(.system(size: 13))
                .scrollContentBackground(.hidden)
                .padding(6)
                .frame(height: 90)
                .background(Color(nsColor: .textBackgroundColor), in: RoundedRectangle(cornerRadius: 8))
                .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Color(nsColor: .separatorColor)))
                .accessibilityLabel("Review summary")
        }
    }

    private var commentsSection: some View {
        let comments = store.pendingComments
        let replies = store.pendingReplies.filter { r in !comments.contains { $0.id == r.id } }
        return VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text("Comments").font(.system(size: 13, weight: .bold)).accessibilityAddTraits(.isHeader)
                Text("\(store.pendingCount) · sent together with this review").font(.system(size: 12)).foregroundStyle(.secondary)
            }
            if comments.isEmpty, replies.isEmpty {
                Text("No pending comments.").font(.system(size: 12)).foregroundStyle(.secondary)
            } else {
                VStack(spacing: 0) {
                    ForEach(Array((comments + replies).enumerated()), id: \.element.id) { index, draft in
                        if index > 0 { Divider() }
                        row(draft)
                    }
                }
                .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Color(nsColor: .separatorColor)))
                .clipShape(RoundedRectangle(cornerRadius: 10))
            }
            if !store.outdated.isEmpty {
                let n = store.outdated.count
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Image(systemName: "exclamationmark.triangle").foregroundStyle(Tokens.warning).accessibilityHidden(true)
                    Text("\(n) \(n == 1 ? "comment is" : "comments are") on lines that changed. Move or delete \(n == 1 ? "it" : "them") in the diff first.")
                        .font(.system(size: 12)).foregroundStyle(Tokens.warning)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .accessibilityElement(children: .combine)
            }
        }
    }

    private func row(_ d: DraftComment) -> some View {
        HStack(spacing: 10) {
            if let a = d.anchor {
                Text("\(a.path):\(a.range)")
                    .font(.system(size: 11, design: .monospaced)).foregroundStyle(.secondary)
                    .lineLimit(1).truncationMode(.middle)
                    .frame(maxWidth: 200, alignment: .leading)
            } else {
                Text("Reply").font(.system(size: 11, weight: .semibold)).foregroundStyle(.secondary)
            }
            Text(d.body.replacingOccurrences(of: "\n", with: " "))
                .font(.system(size: 12)).lineLimit(1).truncationMode(.tail)
                .frame(maxWidth: .infinity, alignment: .leading)
            if d.origin == .gapCheck {
                Text("From gap check")
                    .font(.system(size: 10, weight: .medium)).foregroundStyle(Tokens.warning)
                    .padding(.horizontal, 6).padding(.vertical, 2)
                    .background(Tokens.cream, in: Capsule())
            }
            Button { Task { await store.deleteDraft(d.id) } } label: {
                Image(systemName: "xmark").font(.system(size: 10, weight: .semibold)).foregroundStyle(.secondary)
            }
            .buttonStyle(.plain)
            .help("Remove from review")
            .accessibilityLabel("Remove comment\(d.anchor.map { " on \($0.path) line \($0.range)" } ?? "")")
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 7)
        .accessibilityElement(children: .contain)
    }

    private var footer: some View {
        HStack(spacing: 10) {
            Text("Posts to GitHub as you\(store.viewerLogin.map { " · \($0)" } ?? "")")
                .font(.system(size: 12)).foregroundStyle(.secondary)
            Spacer(minLength: 8)
            if let hint { Text(hint).font(.system(size: 12)).foregroundStyle(Tokens.warning) }
            Button("Keep reviewing") { store.showSubmitSheet = false }
                .keyboardShortcut(.cancelAction)
                .disabled(sending)
            Button {
                Task { await store.submit(event: event, summary: summary) }
            } label: {
                if sending {
                    HStack(spacing: 6) {
                        ProgressView().controlSize(.small)
                        Text("Sending…")
                    }
                } else {
                    HStack(spacing: 8) {
                        Text(event.outcomeTitle)
                        Text("⌘↩").font(.system(size: 11)).opacity(0.6)
                    }
                }
            }
            .buttonStyle(QuackPrimaryStyle())
            .keyboardShortcut(.return, modifiers: .command)
            .disabled(!canSubmit)
            .opacity(canSubmit || sending ? 1 : 0.5)
        }
        .padding(.horizontal, 20)
        .padding(.vertical, 12)
    }
}

// MARK: - Failed

/// "Your review wasn't sent": nothing was posted, the comments are safe, and what to do next.
public struct SubmitFailedPanel: View {
    var store: PRStore
    var error: ServerError
    var event: ReviewEvent
    var summary: String
    /// Inside the sheet: no Close (Keep reviewing does that).
    var inSheet: Bool

    public init(store: PRStore, error: ServerError, event: ReviewEvent, summary: String, inSheet: Bool = false) {
        self.store = store
        self.error = error
        self.event = event
        self.summary = summary
        self.inSheet = inSheet
    }

    public var body: some View {
        let command = error.fixSteps?.compactMap(\.command).first
        let n = store.pendingCount
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                Image(systemName: "xmark.octagon").foregroundStyle(Tokens.danger).accessibilityHidden(true)
                Text("Your review wasn’t sent").font(.system(size: 14, weight: .bold)).accessibilityAddTraits(.isHeader)
            }
            Text("GitHub said: \(error.message)").font(.system(size: 12)).fixedSize(horizontal: false, vertical: true)
            Text(n == 0 ? "Nothing was posted." : "Nothing was posted; your \(n) \(n == 1 ? "comment is" : "comments are") safe on this Mac.")
                .font(.system(size: 12)).foregroundStyle(.secondary)
            if let command { CommandBox(command) }
            HStack(spacing: 8) {
                Button("Copy review as Markdown") { copyToPasteboard(store.reviewMarkdown(event: event, summary: summary)) }
                if error.code == .ghWriteDenied { SettingsLink { Text("Open Settings") } }
                Spacer(minLength: 0)
                if !inSheet { Button("Close") { store.dismissSubmitResult() } }
                Button("Try again") { Task { await store.submit(event: event, summary: summary) } }
                    .buttonStyle(.borderedProminent)
            }
            .controlSize(.small)
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Tokens.bannerErr, in: RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Tokens.bannerErrLine))
        .accessibilityElement(children: .contain)
    }
}

// MARK: - Sent

/// Top of the PR tab after a send: what went out, a link, and it goes away by itself.
public struct SubmitSentToast: View {
    var store: PRStore
    var message: ReviewSubmittedMessage

    public init(store: PRStore, message: ReviewSubmittedMessage) {
        self.store = store
        self.message = message
    }

    private var detail: String {
        var parts: [String] = []
        if message.comments > 0 { parts.append(plural(message.comments, "comment", "comments")) }
        if message.replies > 0 { parts.append(plural(message.replies, "reply", "replies")) }
        let where_ = "\(store.pr.repo) #\(store.pr.number)"
        return parts.isEmpty ? "Posted to \(where_)." : "\(parts.joined(separator: " and ")) posted to \(where_)."
    }

    public var body: some View {
        HStack(spacing: 10) {
            Image(systemName: "checkmark.circle.fill").font(.system(size: 18)).foregroundStyle(Tokens.success).accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text("Review sent · \(message.event.sentLabel)").font(.system(size: 13, weight: .bold))
                Text(detail).font(.system(size: 12)).foregroundStyle(.secondary)
            }
            Spacer(minLength: 12)
            Button("View on GitHub") {
                if let url = URL(string: message.url) { NSWorkspace.shared.open(url) }
            }
            .controlSize(.small)
            Button { store.dismissSubmitResult() } label: {
                Image(systemName: "xmark").font(.system(size: 10, weight: .semibold)).foregroundStyle(.secondary)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Dismiss")
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .frame(maxWidth: 560)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Color(nsColor: .separatorColor)))
        .shadow(color: .black.opacity(0.12), radius: 10, y: 3)
        .accessibilityElement(children: .contain)
        .task(id: message) {
            AccessibilityNotification.Announcement("Review sent. \(message.event.sentLabel). \(detail)").post()
            try? await Task.sleep(for: .seconds(6))
            guard !Task.isCancelled else { return }
            store.dismissSubmitResult()
        }
    }
}

/// Whichever result card the PR tab should float: the sent toast, or the failed panel when the sheet is closed.
struct SubmitResultOverlay: View {
    var store: PRStore

    var body: some View {
        switch store.submitState {
        case let .sent(m):
            SubmitSentToast(store: store, message: m).padding(.top, 12).transition(.move(edge: .top).combined(with: .opacity))
        case let .failed(error) where !store.showSubmitSheet:
            SubmitFailedPanel(store: store, error: error, event: store.reviewEvent ?? .comment, summary: store.reviewSummary)
                .frame(maxWidth: 560).shadow(color: .black.opacity(0.12), radius: 10, y: 3).padding(.top, 12)
        default:
            EmptyView()
        }
    }
}

/// The toolbar's Submit review button, with a count of what's pending.
struct SubmitReviewButton: View {
    @Bindable var store: PRStore

    var body: some View {
        Button { store.showSubmitSheet = true } label: {
            HStack(spacing: 6) {
                Text("Submit review")
                if store.pendingCount > 0 {
                    Text("\(store.pendingCount)")
                        .font(.system(size: 11, weight: .bold)).monospacedDigit()
                        .padding(.horizontal, 6).frame(minWidth: 18, minHeight: 16)
                        .background(Tokens.ink.opacity(0.14), in: Capsule())
                }
            }
        }
        .buttonStyle(QuackPrimaryStyle())
        .keyboardShortcut(.return, modifiers: [.command, .shift])
        .help("Submit review (⌘⇧↩)")
        .accessibilityLabel(store.pendingCount > 0 ? "Submit review, \(plural(store.pendingCount, "pending comment", "pending comments"))" : "Submit review")
    }
}
