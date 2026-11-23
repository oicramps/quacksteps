import AppKit
import QuackProtocol
import QuackStores
import SwiftUI

/// One PR tab in the main window: banner and diff in the middle, chat in the inspector, a status bar
/// along the bottom. The window's sidebar shows this PR's ranked files while the tab is selected.
public struct PRTabView: View {
    let model: AppModel
    let workspace: Workspace
    @Bindable var store: PRStore
    /// Show or hide the window's sidebar (ranked files). Owned by the window.
    var toggleSidebar: () -> Void
    /// Focus the ranked-files filter field. Owned by the window.
    var focusFilter: () -> Void

    @AppStorage("diff.layout") private var layoutRaw = DiffLayout.unified.rawValue
    @AppStorage("chat.shown") private var showChat = true
    @State private var focusComposer = false
    @State private var controller = DiffController()
    @State private var paletteShown = false
    @State private var opener = WorktreeOpener()

    public init(model: AppModel, workspace: Workspace, store: PRStore, toggleSidebar: @escaping () -> Void = {}, focusFilter: @escaping () -> Void = {}) {
        self.model = model
        self.workspace = workspace
        self.store = store
        self.toggleSidebar = toggleSidebar
        self.focusFilter = focusFilter
    }

    private var layout: DiffLayout { DiffLayout(rawValue: layoutRaw) ?? .unified }
    private var item: InboxItem? { model.item(for: store.pr) }

    public var body: some View {
        VStack(spacing: 0) {
            PRBanner(store: store, model: model)
            SinceReviewBanner(store: store)
            WriteErrorBanner(store: store)
            DiffView(store: store, layout: layout, controller: controller) { showChat = true }
        }
        .safeAreaInset(edge: .bottom, spacing: 0) { PRStatusBar(store: store, model: model) }
        .inspector(isPresented: $showChat) {
            ChatInspector(store: store, model: model, focusComposer: $focusComposer)
                .inspectorColumnWidth(min: 300, ideal: 340, max: 480)
        }
        .navigationTitle(item?.title ?? store.pr.description)
        .navigationSubtitle(subtitle)
        .toolbar { toolbar }
        .overlay {
            if paletteShown {
                CommandPalette(model: model, workspace: workspace, store: store, commands: commands, isPresented: $paletteShown) { question in
                    store.ask(question)
                    showChat = true
                }
            }
        }
        .overlay(alignment: .top) { SubmitResultOverlay(store: store) }
        .animation(.default, value: store.submitState)
        .sheet(isPresented: $store.showSubmitSheet) { SubmitReviewSheet(store: store) }
        .background(shortcuts)
        .task { store.start() }
    }

    private var subtitle: String {
        guard let item else { return "" }
        return "\(store.pr.repo) #\(store.pr.number) · \(item.authorLogin) · \(item.baseRef)"
    }

    @ToolbarContentBuilder private var toolbar: some ToolbarContent {
        ToolbarItem(placement: .primaryAction) {
            Picker("Layout", selection: $layoutRaw) {
                Text("Unified").tag(DiffLayout.unified.rawValue)
                Text("Split").tag(DiffLayout.split.rawValue)
            }
            .pickerStyle(.segmented)
            .help("Unified or split diff (⌘⇧D)")
        }
        if store.canWrite, store.canShowSinceLastReview || store.sinceLastReview {
            ToolbarItem(placement: .primaryAction) {
                Toggle("Since my last review", isOn: Binding(
                    get: { store.sinceLastReview },
                    set: { on in Task { await store.setSinceLastReview(on) } }
                ))
                .toggleStyle(.switch)
                .controlSize(.small)
                .help("Show only what changed since your last review")
            }
        }
        if store.canWrite, store.review != nil {
            ToolbarItem(placement: .primaryAction) { SubmitReviewButton(store: store) }
        }
        ToolbarItem(placement: .primaryAction) { ReviewControl(store: store) }
        ToolbarItem(placement: .primaryAction) { OpenInControl(store: store, opener: opener) }
        ToolbarItem(placement: .primaryAction) {
            Button { NSWorkspace.shared.open(store.pr.githubURL) } label: { Label("Open on GitHub", systemImage: "globe") }
                .help("Open on GitHub (⌘⇧G)")
        }
        ToolbarItem(placement: .primaryAction) {
            Button { showChat.toggle() } label: { Label("Chat", systemImage: "sidebar.right") }
                .help("Show or hide chat (⌥⌘I)")
        }
    }

    /// The keyboard map's PR-window shortcuts, as invisible buttons (menu commands can't see the tab).
    private var shortcuts: some View {
        Group {
            Button("") { paletteShown.toggle() }.keyboardShortcut("k")
            Button("") { showChat.toggle() }.keyboardShortcut("i", modifiers: [.command, .option])
            Button("") {
                showChat = true
                focusComposer = true
            }.keyboardShortcut("l")
            Button("") { toggleReview() }.keyboardShortcut("c", modifiers: [.command, .shift])
            Button("") { opener.open(.cursor, store: store) }.keyboardShortcut("o", modifiers: [.command, .shift])
            Button("") { opener.open(.terminal, store: store) }.keyboardShortcut("t", modifiers: [.command, .shift])
            Button("") { Task { await store.updateReview() } }.keyboardShortcut("u", modifiers: [.command, .shift])
            Button("") { NSWorkspace.shared.open(store.pr.githubURL) }.keyboardShortcut("g", modifiers: [.command, .shift])
            Button("") { layoutRaw = layout == .unified ? DiffLayout.split.rawValue : DiffLayout.unified.rawValue }
                .keyboardShortcut("d", modifiers: [.command, .shift])
        }
        .opacity(0)
        .frame(width: 0, height: 0)
        .accessibilityHidden(true)
    }

    private func toggleReview() {
        Task {
            if store.review == nil { await store.startReview() } else { await store.stopReview() }
        }
    }

    private var commands: [PaletteCommand] {
        var list: [PaletteCommand] = []
        if store.review == nil {
            list.append(PaletteCommand(id: "start", title: "Start reviewing", symbol: "eyeglasses", shortcut: "⌘⇧C") { toggleReview() })
        } else {
            list.append(PaletteCommand(id: "stop", title: "Stop reviewing", symbol: "eyeglasses", shortcut: "⌘⇧C") { toggleReview() })
            list.append(PaletteCommand(id: "relabel", title: "Re-run labels", symbol: "arrow.clockwise", shortcut: nil) { Task { await store.rerunLabels() } })
        }
        if store.review?.phase == .stale {
            list.append(PaletteCommand(id: "update", title: "Update to latest commits", symbol: "arrow.up", shortcut: "⌘⇧U") { Task { await store.updateReview() } })
        }
        list += [
            PaletteCommand(id: "chat", title: "Show or hide chat", symbol: "sidebar.right", shortcut: "⌥⌘I") { showChat.toggle() },
            PaletteCommand(id: "focus", title: "Ask a question", symbol: "sparkles", shortcut: "⌘L") {
                showChat = true
                focusComposer = true
            },
            PaletteCommand(id: "layout", title: layout == .unified ? "Show split diff" : "Show unified diff", symbol: "rectangle.split.2x1", shortcut: "⌘⇧D") {
                layoutRaw = layout == .unified ? DiffLayout.split.rawValue : DiffLayout.unified.rawValue
            },
            PaletteCommand(id: "cursor", title: "Open worktree in Cursor", symbol: "arrow.up.forward.app", shortcut: "⌘⇧O") { opener.open(.cursor, store: store) },
            PaletteCommand(id: "terminal", title: "Open worktree in Terminal", symbol: "terminal", shortcut: "⌘⇧T") { opener.open(.terminal, store: store) },
            PaletteCommand(id: "sidebar", title: "Show or hide sidebar", symbol: "sidebar.left", shortcut: "⌃⌘S") { toggleSidebar() },
            PaletteCommand(id: "filter", title: "Filter files", symbol: "magnifyingglass", shortcut: "⌘F") { focusFilter() },
            PaletteCommand(id: "next-file", title: "Next file", symbol: "chevron.down", shortcut: "j") { controller.nextFile() },
            PaletteCommand(id: "prev-file", title: "Previous file", symbol: "chevron.up", shortcut: "k") { controller.previousFile() },
            PaletteCommand(id: "next-hunk", title: "Next hunk", symbol: "arrow.down.to.line", shortcut: "n") { controller.nextHunk() },
            PaletteCommand(id: "github", title: "Open on GitHub", symbol: "globe", shortcut: "⌘⇧G") { NSWorkspace.shared.open(store.pr.githubURL) },
            PaletteCommand(id: "inbox", title: "Go to Inbox", symbol: "tray", shortcut: "⌘1") { workspace.selected = .inbox },
            PaletteCommand(id: "close", title: "Close tab", symbol: "xmark", shortcut: "⌥⌘W") { workspace.close(store.pr) },
        ]
        return list
    }
}
