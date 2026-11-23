import AppKit
import QuackProtocol
import QuackStores
import SwiftUI

// The menu bar: a footprint-and-count label and the 372 pt dropdown panel.

public struct MenuBarLabel: View {
    var model: AppModel
    var showCount: Bool

    public init(model: AppModel, showCount: Bool) {
        self.model = model
        self.showCount = showCount
    }

    public var body: some View {
        HStack(spacing: 3) {
            Image(nsImage: MenuBarImage.template)
            switch model.badge {
            case .none:
                EmptyView()
            case let .count(text):
                if showCount { Text(text).font(.system(size: 13, weight: .semibold)).monospacedDigit() }
            case .warning:
                Image(systemName: "exclamationmark.triangle")
            case .pending:
                Text("–").foregroundStyle(.secondary)
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(accessibilityText)
        .accessibilityHint("Shows review requests")
    }

    private var accessibilityText: String {
        switch model.badge {
        case .warning: "Quacksteps, server unreachable"
        case .pending: "Quacksteps, checking GitHub"
        default: "Quacksteps, \(model.waitingCount) waiting on you"
        }
    }
}

public struct MenuPanel: View {
    var model: AppModel
    var openPR: (PrKey) -> Void
    var openInbox: () -> Void
    var openSettings: () -> Void

    public init(model: AppModel, openPR: @escaping (PrKey) -> Void, openInbox: @escaping () -> Void, openSettings: @escaping () -> Void) {
        self.model = model
        self.openPR = openPR
        self.openInbox = openInbox
        self.openSettings = openSettings
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            if !model.isConnected, !model.isConnecting {
                unreachable
            } else if !model.hasPolled {
                Text("Asking GitHub nicely…")
                    .font(QuackFont.headline(14))
                    .padding(.horizontal, 14)
                    .padding(.vertical, 12)
            } else {
                reviewSection
                waitingSection
            }
            Divider().padding(.vertical, 6)
            footer
        }
        .padding(.vertical, 8)
        .frame(width: 372)
    }

    // MARK: Header

    private var header: some View {
        HStack(spacing: 8) {
            QuackLogo(height: 16).accessibilityHidden(true)
            Text("Quacksteps").font(.system(size: 13, weight: .semibold))
            Spacer()
            TimelineView(.periodic(from: .now, by: 15)) { context in
                if let text = quackCheckedAgo(fetchedAt: model.inbox?.fetchedAt, now: context.date) {
                    Text(text).font(.system(size: 11)).foregroundStyle(.secondary)
                }
            }
            Button {
                Task { await model.refresh() }
            } label: {
                Image(systemName: "arrow.clockwise").font(.system(size: 12, weight: .medium))
            }
            .buttonStyle(.plain)
            .foregroundStyle(.secondary)
            .disabled(model.refreshing || !model.isConnected)
            .help("Refresh")
            .accessibilityLabel("Refresh")
        }
        .padding(.horizontal, 14)
        .padding(.bottom, 8)
    }

    // MARK: Sections

    private func sectionHeader(_ title: String, count: Int, note: String?) -> some View {
        HStack(spacing: 6) {
            Text(title).font(.system(size: 11, weight: .semibold)).foregroundStyle(.secondary)
            Text("\(count)").font(.system(size: 11)).monospacedDigit().foregroundStyle(.secondary)
            Spacer()
            if let note { Text(note).font(.system(size: 11)).foregroundStyle(.secondary) }
        }
        .padding(.horizontal, 14)
        .padding(.top, 6)
        .padding(.bottom, 2)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isHeader)
    }

    @ViewBuilder private var reviewSection: some View {
        let requests = model.reviewRequests
        sectionHeader("Review requests", count: requests.count, note: "longest wait first")
        if requests.isEmpty {
            Text("Nothing waiting on you.")
                .font(.system(size: 12)).foregroundStyle(.secondary)
                .padding(.horizontal, 14).padding(.vertical, 6)
        }
        ForEach(requests.prefix(4)) { item in
            PanelRow(action: { openPR(item.pr) }) {
                HStack(spacing: 10) {
                    Avatar(item.authorLogin, size: 20)
                    // As on the canvas: title, then "web #4131" under it. Verbatim, so the number never gets a thousands separator.
                    VStack(alignment: .leading, spacing: 0) {
                        Text(item.title).font(.system(size: 13)).lineLimit(1)
                        Text(verbatim: "\(item.pr.repo) #\(item.pr.number)")
                            .font(.system(size: 11)).foregroundStyle(.secondary).lineLimit(1)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    if let date = item.reviewer.flatMap({ ISODate.parse($0.requestedAt) }) {
                        WaitTimer(since: date, size: 12)
                    }
                }
            }
            .accessibilityLabel("\(item.title), by \(item.authorLogin), \(item.pr.repo) \(item.pr.number)")
            .accessibilityValue(item.reviewer.flatMap { ISODate.parse($0.requestedAt) }.map { "Waiting \(WaitFormat.spoken(Date().timeIntervalSince($0)))." } ?? "")
        }
        if requests.count > 4 {
            Text("and \(requests.count - 4) more")
                .font(.system(size: 11)).foregroundStyle(.secondary)
                .padding(.horizontal, 14).padding(.vertical, 4)
        }
    }

    @ViewBuilder private var waitingSection: some View {
        let waiting = model.waitingOnMe
        if !waiting.isEmpty {
            sectionHeader("Your PRs that need you", count: waiting.count, note: nil).padding(.top, 8)
            ForEach(waiting) { item in
                PanelRow(action: { openPR(item.pr) }) {
                    HStack(spacing: 10) {
                        StatusTile(item.author?.state, size: 20)
                        VStack(alignment: .leading, spacing: 1) {
                            Text(item.title).font(.system(size: 13)).lineLimit(1)
                            Text(caption(item)).font(.system(size: 11)).foregroundStyle(.secondary).lineLimit(1)
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        if let date = item.author.flatMap({ ISODate.parse($0.since) }) {
                            TimelineView(.periodic(from: .now, by: 60)) { context in
                                Text(WaitFormat.short(context.date.timeIntervalSince(date)))
                                    .font(.system(size: 12)).monospacedDigit().foregroundStyle(.secondary)
                            }
                        }
                    }
                }
                .accessibilityLabel("\(item.title), \(item.pr.repo) \(item.pr.number), waiting on you")
                .accessibilityValue(waitingValue(item))
            }
        }
    }

    private func waitingValue(_ item: InboxItem) -> String {
        var parts: [String] = []
        if let date = item.author.flatMap({ ISODate.parse($0.since) }) {
            parts.append("Waiting on you for \(WaitFormat.spoken(Date().timeIntervalSince(date))).")
        }
        if let reasons = item.author?.reasons, !reasons.isEmpty { parts.append(reasons.joined(separator: ", ") + ".") }
        return parts.joined(separator: " ")
    }

    private func caption(_ item: InboxItem) -> String {
        let base = "\(item.pr.repo) #\(item.pr.number)"
        let reasons = item.author?.reasons ?? []
        return reasons.isEmpty ? base : "\(base) · \(reasons.joined(separator: " · "))"
    }

    private var unreachable: some View {
        HStack(spacing: 10) {
            Image(systemName: "exclamationmark.triangle").foregroundStyle(Tokens.warning).accessibilityHidden(true)
            Text("The server went quiet.").font(.system(size: 13, weight: .medium))
            Spacer()
            Button("Restart server") { Task { await model.restartServer() } }.controlSize(.small)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 8)
    }

    // MARK: Footer

    private var footer: some View {
        VStack(alignment: .leading, spacing: 0) {
            PanelRow(action: openInbox) { footerRow("Open Inbox", shortcut: "⌘1") }
                .keyboardShortcut("1", modifiers: .command)
            PanelRow(action: openSettings) { footerRow("Settings…", shortcut: "⌘,") }
                .keyboardShortcut(",", modifiers: .command)
            PanelRow(action: { NSApp.terminate(nil) }) { footerRow("Quit Quacksteps", shortcut: "⌘Q") }
                .keyboardShortcut("q", modifiers: .command)
            Text("Quitting keeps the server, worktrees and labels warm. Notifications stop.")
                .font(.system(size: 11)).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.horizontal, 14).padding(.top, 6).padding(.bottom, 2)
        }
    }

    private func footerRow(_ title: String, shortcut: String) -> some View {
        HStack {
            Text(title).font(.system(size: 13))
            Spacer()
            Text(shortcut).font(.system(size: 12)).foregroundStyle(.secondary)
        }
    }
}

private extension AppModel {
    var isConnecting: Bool { if case .connecting = connection { true } else { false } }
}

/// A plain full-width button with a hover highlight.
private struct PanelRow<Content: View>: View {
    var action: () -> Void
    @ViewBuilder var content: Content
    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            content
                .padding(.horizontal, 10)
                .padding(.vertical, 5)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(hovering ? Color.primary.opacity(0.09) : .clear, in: RoundedRectangle(cornerRadius: 7))
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .padding(.horizontal, 4)
        .onHover { hovering = $0 }
    }
}

#Preview("Menu panel") {
    MenuPanel(model: AppModel(preview: QuackPreviewData.message(), connection: QuackPreviewData.connected), openPR: { _ in }, openInbox: {}, openSettings: {})
}

#Preview("Menu panel, unreachable") {
    MenuPanel(model: AppModel(preview: nil, connection: .disconnected(reason: "No socket")), openPR: { _ in }, openInbox: {}, openSettings: {})
}

#Preview("Menu bar label") {
    MenuBarLabel(model: AppModel(preview: QuackPreviewData.message(), connection: QuackPreviewData.connected), showCount: true)
        .padding()
}
