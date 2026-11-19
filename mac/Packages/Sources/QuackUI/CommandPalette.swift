import QuackProtocol
import QuackStores
import SwiftUI

// The ⌘K palette: one field over a light dim, then Files in this PR, Commands and Other PRs.
// No animation in or out; the host shows it in a ZStack over the window.

public struct PaletteCommand: Identifiable {
    public var id: String
    public var title: String
    public var symbol: String
    /// Display text such as "⌘⇧C".
    public var shortcut: String?
    public var action: () -> Void

    public init(id: String, title: String, symbol: String, shortcut: String? = nil, action: @escaping () -> Void) {
        self.id = id
        self.title = title
        self.symbol = symbol
        self.shortcut = shortcut
        self.action = action
    }
}

// MARK: - Fuzzy matching

enum Fuzzy {
    /// Subsequence match, case-insensitive. Higher is better; nil when `query` isn't a subsequence of `text`.
    static func score(_ query: String, in text: String) -> Int? {
        let q = Array(query.lowercased().filter { !$0.isWhitespace })
        if q.isEmpty { return 0 }
        let t = Array(text.lowercased())
        var score = 0
        var qi = 0
        var previous = -2
        for (ti, ch) in t.enumerated() where qi < q.count && ch == q[qi] {
            score += 1
            if ti == previous + 1 { score += 5 }
            if ti == 0 || "/._- ".contains(t[ti - 1]) { score += 4 }
            previous = ti
            qi += 1
        }
        guard qi == q.count else { return nil }
        // Shorter texts and earlier matches win ties.
        return score * 10 - min(t.count, 90) / 3
    }

    /// The better of the file name and the full path (a name hit counts extra).
    static func fileScore(_ query: String, name: String, path: String) -> Int? {
        let byName = score(query, in: name).map { $0 + 40 }
        let byPath = score(query, in: path)
        switch (byName, byPath) {
        case let (a?, b?): return max(a, b)
        case let (a?, nil): return a
        case let (nil, b?): return b
        default: return nil
        }
    }
}

// MARK: - Items

private struct PalettePR: Identifiable {
    var key: PrKey
    var title: String
    var since: Date?
    var id: String { key.id }
}

private enum PaletteItem: Identifiable {
    case file(RankedFile)
    case command(PaletteCommand)
    case pr(PalettePR)

    var id: String {
        switch self {
        case let .file(f): "file:\(f.path)"
        case let .command(c): "command:\(c.id)"
        case let .pr(p): "pr:\(p.id)"
        }
    }
}

private struct PaletteGroup: Identifiable {
    var title: String
    var items: [PaletteItem]
    var id: String { title }
}

// MARK: - View

public struct CommandPalette: View {
    var model: AppModel
    var workspace: Workspace
    var store: PRStore?
    var commands: [PaletteCommand]
    @Binding var isPresented: Bool
    var askAbout: (String) -> Void

    @State private var query = ""
    @State private var selection = 0
    @FocusState private var focused: Bool
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency

    public init(model: AppModel, workspace: Workspace, store: PRStore?, commands: [PaletteCommand], isPresented: Binding<Bool>, askAbout: @escaping (String) -> Void) {
        self.model = model
        self.workspace = workspace
        self.store = store
        self.commands = commands
        _isPresented = isPresented
        self.askAbout = askAbout
    }

    // MARK: Data

    private var groups: [PaletteGroup] {
        let limit = query.isEmpty ? 6 : 8
        var result: [PaletteGroup] = []

        if let store {
            let files = store.rankedFiles
                .compactMap { file in Fuzzy.fileScore(query, name: file.name, path: file.path).map { (file, $0) } }
                .sorted { $0.1 > $1.1 }
                .prefix(limit)
                .map { PaletteItem.file($0.0) }
            if !files.isEmpty { result.append(PaletteGroup(title: "Files in this PR", items: Array(files))) }
        }

        let matchedCommands = commands
            .compactMap { c in Fuzzy.score(query, in: c.title).map { (c, $0) } }
            .sorted { $0.1 > $1.1 }
            .map { PaletteItem.command($0.0) }
        if !matchedCommands.isEmpty { result.append(PaletteGroup(title: "Commands", items: matchedCommands)) }

        let prs = otherPRs
            .compactMap { pr in
                Fuzzy.score(query, in: "\(pr.key.repo) #\(pr.key.number) \(pr.title)").map { (pr, $0) }
            }
            .sorted { $0.1 > $1.1 }
            .prefix(limit)
            .map { PaletteItem.pr($0.0) }
        if !prs.isEmpty { result.append(PaletteGroup(title: "Other PRs", items: Array(prs))) }
        return result
    }

    private var flat: [PaletteItem] { groups.flatMap(\.items) }

    /// Open tabs, then review requests, minus the PR on screen.
    private var otherPRs: [PalettePR] {
        var seen: Set<String> = []
        var list: [PalettePR] = []
        func add(_ key: PrKey) {
            guard key.id != store?.pr.id, seen.insert(key.id).inserted else { return }
            let item = model.item(for: key)
            let since = item?.reviewer.flatMap { $0.isRequested ? Self.date($0.requestedAt) : nil }
            list.append(PalettePR(key: key, title: item?.title ?? "", since: since))
        }
        workspace.tabs.forEach(add)
        model.reviewRequests.map(\.pr).forEach(add)
        return list
    }

    private static func date(_ iso: String) -> Date? {
        let plain = ISO8601DateFormatter()
        if let d = plain.date(from: iso) { return d }
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return fractional.date(from: iso)
    }

    // MARK: Actions

    private func run(_ item: PaletteItem) {
        isPresented = false
        switch item {
        case let .file(file): store?.selectedFile = file.path
        case let .command(command): command.action()
        case let .pr(pr): workspace.open(pr.key)
        }
    }

    private func ask(_ item: PaletteItem) {
        switch item {
        case let .file(file):
            isPresented = false
            askAbout("What does \(file.path) change, and what could break?")
        case let .pr(pr):
            isPresented = false
            askAbout("What does \(pr.key.repo) #\(pr.key.number) change, and what could break?")
        case .command: break
        }
    }

    private func move(_ step: Int) {
        let count = flat.count
        guard count > 0 else { return }
        selection = (selection + step + count) % count
        announceHighlighted()
    }

    /// Tells VoiceOver which row the arrow keys landed on; focus stays in the search field.
    private func announceHighlighted() {
        var index = selection
        for group in groups {
            if index < group.items.count {
                var text = AttributedString("\(title(of: group.items[index])), \(group.title)")
                text.accessibilitySpeechAnnouncementPriority = .low
                AccessibilityNotification.Announcement(text).post()
                return
            }
            index -= group.items.count
        }
    }

    private func title(of item: PaletteItem) -> String {
        switch item {
        case let .file(file): file.path
        case let .command(command): command.title
        case let .pr(pr): pr.title.isEmpty ? "\(pr.key.repo) #\(pr.key.number)" : "\(pr.key.repo) #\(pr.key.number), \(pr.title)"
        }
    }

    private var highlighted: PaletteItem? {
        let items = flat
        return items.indices.contains(selection) ? items[selection] : nil
    }

    // MARK: Body

    public var body: some View {
        ZStack(alignment: .top) {
            Color.black.opacity(0.14)
                .ignoresSafeArea()
                .onTapGesture { isPresented = false }
                .accessibilityHidden(true)
            panel
                .frame(width: 640)
                .padding(.top, 72)
        }
        .onExitCommand { isPresented = false }
        .onAppear { focused = true }
    }

    private var panel: some View {
        VStack(spacing: 0) {
            searchField
            Divider()
            results
            Divider()
            footer
        }
        .background(reduceTransparency ? AnyShapeStyle(Color(nsColor: .windowBackgroundColor)) : AnyShapeStyle(.regularMaterial), in: RoundedRectangle(cornerRadius: 16))
        .overlay(RoundedRectangle(cornerRadius: 16).strokeBorder(Color.primary.opacity(reduceTransparency ? 0.25 : 0.1)))
        .shadow(color: .black.opacity(0.28), radius: 28, y: 12)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Command palette")
    }

    private var searchField: some View {
        HStack(spacing: 10) {
            Image(systemName: "magnifyingglass").foregroundStyle(.secondary).accessibilityHidden(true)
            TextField("Search files, commands and PRs", text: $query)
                .textFieldStyle(.plain)
                .accessibilityLabel("Search files, commands and PRs")
                .font(.system(size: 17))
                .focused($focused)
                .onKeyPress(.upArrow) { move(-1); return .handled }
                .onKeyPress(.downArrow) { move(1); return .handled }
                .onKeyPress(.escape) { isPresented = false; return .handled }
                .onKeyPress(.return, phases: .down) { press in
                    guard let item = highlighted else { return .handled }
                    if press.modifiers.contains(.command) { ask(item) } else { run(item) }
                    return .handled
                }
                .onChange(of: query) { selection = 0 }
            Text("esc")
                .font(.system(size: 11))
                .foregroundStyle(.secondary)
                .padding(.horizontal, 6)
                .padding(.vertical, 2)
                .background(Tokens.fill, in: RoundedRectangle(cornerRadius: 5))
                .accessibilityHidden(true)
        }
        .padding(.horizontal, 16)
        .frame(height: 52)
    }

    private var results: some View {
        ScrollViewReader { proxy in
            ScrollView {
                let current = groups
                let selectedID = highlighted?.id
                if current.isEmpty {
                    Text(verbatim: "No matches for “\(query)”")
                        .font(.system(size: 13))
                        .foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 28)
                } else {
                    LazyVStack(alignment: .leading, spacing: 0) {
                        ForEach(current) { group in
                            Text(group.title)
                                .font(.system(size: 11, weight: .semibold))
                                .foregroundStyle(.secondary)
                                .padding(.horizontal, 16)
                                .padding(.top, 10)
                                .padding(.bottom, 4)
                                .accessibilityAddTraits(.isHeader)
                            ForEach(group.items) { item in
                                row(item, selected: item.id == selectedID)
                                    .id(item.id)
                                    .onTapGesture { run(item) }
                            }
                        }
                    }
                    .padding(.bottom, 8)
                }
            }
            .frame(maxHeight: 420)
            .onChange(of: selection) {
                if let id = highlighted?.id { proxy.scrollTo(id) }
            }
        }
    }

    private func row(_ item: PaletteItem, selected: Bool) -> some View {
        HStack(spacing: 10) {
            switch item {
            case let .file(file):
                Image(systemName: "doc.text").foregroundStyle(.secondary).frame(width: 18)
                RiskTag(risk: file.risk?.risk)
                Text(verbatim: file.path).font(.system(size: 13)).lineLimit(1).truncationMode(.head)
                if let reason = file.risk?.reason, !reason.isEmpty {
                    Text(reason).font(.system(size: 12)).foregroundStyle(.secondary).lineLimit(1)
                }
                Spacer(minLength: 8)
                if selected { Text("↩").font(.system(size: 12)).foregroundStyle(.secondary) }
            case let .command(command):
                Image(systemName: command.symbol).foregroundStyle(.secondary).frame(width: 18)
                Text(command.title).font(.system(size: 13)).lineLimit(1)
                Spacer(minLength: 8)
                if let shortcut = command.shortcut {
                    Text(verbatim: shortcut).font(.system(size: 12)).foregroundStyle(.secondary)
                }
            case let .pr(pr):
                Image(systemName: "arrow.triangle.pull").foregroundStyle(.secondary).frame(width: 18)
                Text(verbatim: "\(pr.key.repo) #\(pr.key.number)").font(.system(size: 13, weight: .medium)).lineLimit(1)
                if !pr.title.isEmpty {
                    Text(pr.title).font(.system(size: 13)).foregroundStyle(.secondary).lineLimit(1)
                }
                Spacer(minLength: 8)
                if let since = pr.since { WaitTimer(since: since, size: 12) }
            }
        }
        .padding(.horizontal, 10)
        .frame(height: 32)
        .background(selected ? Color.accentColor.opacity(0.16) : .clear, in: RoundedRectangle(cornerRadius: 8))
        .padding(.horizontal, 6)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(selected ? [.isButton, .isSelected] : .isButton)
        .accessibilityAction { run(item) }
    }

    private var footer: some View {
        HStack(spacing: 16) {
            Text("↑ ↓ move")
            Text("↩ open")
            Text("⌘↩ ask about it")
            Spacer()
        }
        .font(.system(size: 11))
        .foregroundStyle(.secondary)
        .padding(.horizontal, 16)
        .frame(height: 32)
        .accessibilityHidden(true)
    }
}

/// A small coloured capsule with the risk level. Unlabeled files get an empty spacer so rows stay aligned.
private struct RiskTag: View {
    var risk: FileRisk.Risk?

    var body: some View {
        let style = Self.style(risk)
        Text(style.label)
            .font(.system(size: 10, weight: .semibold))
            .foregroundStyle(style.foreground)
            .frame(width: 34)
            .padding(.vertical, 1)
            .background(style.background, in: Capsule())
            .overlay(Capsule().strokeBorder(style.line))
            .opacity(style.label.isEmpty ? 0 : 1)
            .accessibilityLabel(style.label.isEmpty ? "" : "\(style.label) risk")
    }

    static func style(_ risk: FileRisk.Risk?) -> (label: String, foreground: Color, background: Color, line: Color) {
        switch risk {
        case .high: ("High", Tokens.danger, Tokens.highBg, Tokens.highLine)
        case .medium: ("Med", Tokens.warning, Tokens.medBg, Tokens.medLine)
        case .low: ("Low", Tokens.lowText, Tokens.lowBg, Color.primary.opacity(0.1))
        default: ("", .clear, .clear, .clear)
        }
    }
}

// MARK: - Previews

#Preview("Palette") {
    @Previewable @State var shown = true
    let model = AppModel(preview: QuackPreviewData.message(), connection: QuackPreviewData.connected, agents: ChatPreviewData.agents())
    let workspace = Workspace(defaults: UserDefaults(suiteName: "palette-preview") ?? .standard)
    let commands = [
        PaletteCommand(id: "update", title: "Update to latest commits", symbol: "arrow.clockwise", shortcut: "⌘⇧U") {},
        PaletteCommand(id: "cursor", title: "Open worktree in Cursor", symbol: "arrow.up.forward.app", shortcut: "⌘⇧O") {},
        PaletteCommand(id: "chat", title: "Hide chat", symbol: "sidebar.right", shortcut: "⌥⌘I") {},
    ]
    CommandPalette(model: model, workspace: workspace, store: ChatPreviewData.store(model: model), commands: commands, isPresented: $shown, askAbout: { _ in })
        .frame(width: 900, height: 600)
}
