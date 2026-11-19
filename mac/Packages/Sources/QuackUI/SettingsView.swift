import AppKit
import QuackProtocol
import QuackStores
import ServiceManagement
import SwiftUI

/// The Settings window: Repos, Agents, Notifications, Server.
public struct SettingsView: View {
    var model: AppModel
    var prefs: NotificationPrefs

    public init(model: AppModel, prefs: NotificationPrefs) {
        self.model = model
        self.prefs = prefs
    }

    public var body: some View {
        TabView {
            SettingsPane(model: model) { ReposTab(model: model) }
                .tabItem { Label("Repos", systemImage: "folder") }
            SettingsPane(model: model) { AgentsTab(model: model) }
                .tabItem { Label("Agents", systemImage: "sparkles") }
            SettingsPane(model: model, needsServer: false) { NotificationsTab(prefs: prefs) }
                .tabItem { Label("Notifications", systemImage: "bell") }
            SettingsPane(model: model) { ServerTab(model: model) }
                .tabItem { Label("Server", systemImage: "server.rack") }
        }
        .frame(width: 600)
        .frame(minHeight: 440)
        .task { await model.loadSettings() }
        .onChange(of: model.isConnected) { _, connected in
            if connected { Task { await model.loadSettings() } }
        }
    }
}

// MARK: - Shell

/// Banner on top, then the tab's form, or a quiet note when the server is away.
private struct SettingsPane<Content: View>: View {
    var model: AppModel
    var needsServer = true
    @ViewBuilder var content: Content

    var body: some View {
        VStack(spacing: 0) {
            if let error = model.actionError {
                Banner(.error, title: "That didn’t work.", message: error) {
                    Button("Dismiss") { model.actionError = nil }
                }
                .padding([.horizontal, .top], 16)
            }
            if needsServer && !model.isConnected {
                Form {
                    Section {
                        Label("The server went quiet.", systemImage: "moon.zzz")
                            .foregroundStyle(.secondary)
                    }
                }
                .formStyle(.grouped)
            } else {
                content
            }
        }
    }
}

@MainActor
private func chooseFolder(message: String, prompt: String = "Choose") -> String? {
    let panel = NSOpenPanel()
    panel.canChooseDirectories = true
    panel.canChooseFiles = false
    panel.allowsMultipleSelection = false
    panel.message = message
    panel.prompt = prompt
    return panel.runModal() == .OK ? panel.url?.path : nil
}

private func caption(_ text: String) -> some View {
    Text(text).font(.caption).foregroundStyle(.secondary)
}

private struct StatusDot: View {
    var color: Color
    var body: some View {
        Circle().fill(color).frame(width: 8, height: 8).accessibilityHidden(true)
    }
}

// MARK: - Repos

private struct ReposTab: View {
    var model: AppModel
    @State private var selected: String?
    @State private var note: String?
    @State private var pruning = false
    @State private var pruneNote: String?

    private var settings: SettingsMessage? { model.settings }

    var body: some View {
        Form {
            Section {
                if let roots = settings?.settings.scanRoots, !roots.isEmpty {
                    List(roots, id: \.self, selection: $selected) { root in
                        HStack {
                            Text(displayPath(root)).lineLimit(1).truncationMode(.middle)
                            Spacer()
                            if let n = cloneCount(in: root) {
                                Text(n == 1 ? "1 clone" : "\(n) clones").foregroundStyle(.secondary)
                            }
                        }
                        .tag(root)
                    }
                    .frame(minHeight: 70, maxHeight: 120)
                } else {
                    Text("No folders yet").foregroundStyle(.secondary)
                }
                HStack {
                    Button { addFolder() } label: { Image(systemName: "plus") }
                        .accessibilityLabel("Add scan folder")
                    Button { removeSelected() } label: { Image(systemName: "minus") }
                        .accessibilityLabel("Remove selected scan folder")
                        .disabled(selected == nil)
                    if let note { Text(note).font(.caption).foregroundStyle(.secondary) }
                    Spacer()
                }
                .controlSize(.small)
            } header: {
                Text("Scan folders")
            } footer: {
                caption("Quack looks one level deep for git clones whose remote is on github.com.")
            }

            Section {
                if let clones = settings?.clones, !clones.isEmpty {
                    ForEach(clones) { clone in
                        LabeledContent {
                            HStack {
                                if let path = clone.path {
                                    Text(displayPath(path)).foregroundStyle(.secondary).lineLimit(1).truncationMode(.middle)
                                } else {
                                    Text("Not found").foregroundStyle(.secondary)
                                }
                                Button("Link…") { link(clone.repo) }.controlSize(.small)
                            }
                        } label: {
                            Text(clone.repo)
                        }
                    }
                } else {
                    Text("No clones found yet").foregroundStyle(.secondary)
                }
            } header: {
                Text("Clones found")
            } footer: {
                caption("PRs from a repo without a clone can be read, but not prepared or asked about.")
            }

            Section {
                if let w = settings?.worktrees {
                    LabeledContent {
                        Button(pruning ? "Pruning…" : "Prune now") { prune() }
                            .controlSize(.small)
                            .disabled(pruning)
                    } label: {
                        VStack(alignment: .leading, spacing: 2) {
                            Text("\(w.count) \(w.count == 1 ? "worktree" : "worktrees") · \(byteString(w.bytes))")
                            Text(displayPath(w.root)).font(.caption).foregroundStyle(.secondary)
                            Text("PRs you’re reviewing are never pruned").font(.caption).foregroundStyle(.secondary)
                            if let pruneNote { Text(pruneNote).font(.caption).foregroundStyle(.secondary) }
                        }
                    }
                }
                Stepper(value: retention, in: 1...365) {
                    Text("Keep other worktrees for \(settings?.settings.retentionDays ?? 0) days")
                }
                Stepper(value: maxCount, in: 1...500) {
                    Text("Keep at most \(settings?.settings.maxWorktrees ?? 0) worktrees")
                }
            } header: {
                Text("Worktrees")
            }
        }
        .formStyle(.grouped)
    }

    private var retention: Binding<Int> {
        Binding(get: { settings?.settings.retentionDays ?? 1 }, set: { v in Task { await model.save(SettingsPatch(retentionDays: v)) } })
    }

    private var maxCount: Binding<Int> {
        Binding(get: { settings?.settings.maxWorktrees ?? 1 }, set: { v in Task { await model.save(SettingsPatch(maxWorktrees: v)) } })
    }

    private func cloneCount(in root: String) -> Int? {
        guard let clones = settings?.clones else { return nil }
        let prefix = root.hasSuffix("/") ? root : root + "/"
        return clones.filter { $0.path?.hasPrefix(prefix) == true }.count
    }

    private func addFolder() {
        guard let path = chooseFolder(message: "Choose a folder that holds your git clones.", prompt: "Add") else { return }
        Task { note = await model.addScanFolder(path) }
    }

    private func removeSelected() {
        guard let selected, let roots = settings?.settings.scanRoots else { return }
        self.selected = nil
        Task { await model.setScanFolders(roots.filter { $0 != selected }) }
    }

    private func link(_ repo: String) {
        guard let path = chooseFolder(message: "Choose your clone of \(repo).", prompt: "Link") else { return }
        Task { note = await model.linkClone(repo: repo, path: path) }
    }

    private func prune() {
        pruning = true
        pruneNote = nil
        Task {
            await model.pruneWorktrees()
            let n = model.settings?.removed?.count ?? 0
            pruneNote = n == 0 ? "Nothing to remove" : "Removed \(n) \(n == 1 ? "worktree" : "worktrees")"
            pruning = false
        }
    }
}

// MARK: - Agents

private struct AgentsTab: View {
    var model: AppModel
    @State private var rechecking = false
    @State private var fixing: AgentId?
    @State private var editingPath = false

    private var s: ServerSettings? { model.settings?.settings }

    private func label(_ id: AgentId) -> String { model.agents.first { $0.id == id }?.label ?? id.rawValue }
    private var firstReady: AgentStatus? { model.agents.first { $0.state == .ready } }
    private var effectiveChat: AgentId? { s?.chatAgent ?? firstReady?.id ?? model.agents.first?.id }
    private var effectiveLabels: AgentId? { s?.labelsAgent ?? effectiveChat }

    var body: some View {
        Form {
            Section {
                ForEach(model.agents) { agent in
                    LabeledContent {
                        if agent.state == .ready {
                            Button("Re-check") { recheck() }.controlSize(.small).disabled(rechecking)
                        } else {
                            Button("Fix…") { fixing = agent.id }
                                .controlSize(.small)
                                .popover(isPresented: Binding(get: { fixing == agent.id }, set: { if !$0 { fixing = nil } })) {
                                    FixStepsView(agent.fixSteps).frame(width: 340).padding(12)
                                }
                        }
                    } label: {
                        HStack(spacing: 8) {
                            StatusDot(color: dotColor(agent.state))
                            VStack(alignment: .leading, spacing: 1) {
                                Text(agent.label)
                                Text(statusText(agent)).font(.caption).foregroundStyle(.secondary)
                            }
                        }
                    }
                }
                if model.agents.isEmpty { Text("Checking agents…").foregroundStyle(.secondary) }
            } header: {
                Text("Agents on this Mac")
            } footer: {
                caption("Quack runs each CLI read-only and never reads its login. Sign in with the CLI itself.")
            }

            Section("Chat") {
                Picker("Default agent", selection: chatAgent) {
                    ForEach(model.agents) { Text($0.label).tag(AgentId?.some($0.id)) }
                }
                Picker("Model", selection: chatModel) {
                    ForEach(modelOptions(for: effectiveChat, current: s?.chatModel ?? ""), id: \.self) { Text($0.isEmpty ? "Default" : $0).tag($0) }
                }
            }

            Section {
                Picker("Agent", selection: labelsAgent) {
                    Text("Same as chat").tag(AgentId?.none)
                    ForEach(model.agents) { Text($0.label).tag(AgentId?.some($0.id)) }
                }
                Picker("Model", selection: labelsModel) {
                    ForEach(modelOptions(for: effectiveLabels, current: s?.labelsModel ?? ""), id: \.self) { Text($0.isEmpty ? "Default" : $0).tag($0) }
                }
            } header: {
                Text("Risk labels")
            } footer: {
                caption("A faster model is fine here. Labels run once when you start reviewing, and again for new commits.")
            }

            Section("Extra PATH") {
                LabeledContent {
                    Button("Edit…") { editingPath = true }.controlSize(.small)
                } label: {
                    let paths = s?.extraPath ?? []
                    Text(paths.isEmpty ? "None" : paths.map(displayPath).joined(separator: " · "))
                        .foregroundStyle(paths.isEmpty ? .secondary : .primary)
                        .lineLimit(2)
                }
            }
        }
        .formStyle(.grouped)
        .sheet(isPresented: $editingPath) {
            ExtraPathSheet(initial: s?.extraPath ?? []) { paths in
                Task { await model.save(SettingsPatch(extraPath: paths)) }
            }
        }
    }

    private func modelOptions(for id: AgentId?, current: String) -> [String] {
        var models = model.agents.first { $0.id == id }?.models ?? []
        if !models.contains(current) { models.insert(current, at: 0) }
        return models
    }

    private var chatAgent: Binding<AgentId?> {
        Binding(get: { effectiveChat }, set: { v in Task { await model.save(SettingsPatch(chatAgent: .some(v), chatModel: "")) } })
    }

    private var chatModel: Binding<String> {
        Binding(get: { s?.chatModel ?? "" }, set: { v in Task { await model.save(SettingsPatch(chatModel: v)) } })
    }

    private var labelsAgent: Binding<AgentId?> {
        Binding(get: { s?.labelsAgent }, set: { v in Task { await model.save(SettingsPatch(labelsAgent: .some(v), labelsModel: "")) } })
    }

    private var labelsModel: Binding<String> {
        Binding(get: { s?.labelsModel ?? "" }, set: { v in Task { await model.save(SettingsPatch(labelsModel: v)) } })
    }

    private func recheck() {
        rechecking = true
        Task {
            await model.recheckAgents()
            rechecking = false
        }
    }

    private func dotColor(_ state: AgentStatus.State) -> Color {
        switch state {
        case .ready: Tokens.success
        case .notLoggedIn: Tokens.warning
        case .notInstalled: .secondary
        }
    }

    private func statusText(_ agent: AgentStatus) -> String {
        switch agent.state {
        case .ready: agent.version.map { "Ready · \($0)" } ?? "Ready"
        case .notLoggedIn: "Not logged in"
        case .notInstalled: "Not installed"
        }
    }
}

private struct ExtraPathSheet: View {
    var initial: [String]
    var onSave: ([String]) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var paths: [String] = []
    @State private var selected: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Extra PATH").font(.headline)
            Text("Folders added to PATH when Quack runs an agent, for tools installed outside the usual places.")
                .font(.caption).foregroundStyle(.secondary)
            List(paths, id: \.self, selection: $selected) { Text(displayPath($0)).tag($0) }
                .frame(height: 140)
                .overlay { if paths.isEmpty { Text("No folders").foregroundStyle(.secondary) } }
            HStack {
                Button { if let p = chooseFolder(message: "Choose a folder to add to PATH.", prompt: "Add"), !paths.contains(p) { paths.append(p) } } label: { Image(systemName: "plus") }
                    .accessibilityLabel("Add folder")
                Button { paths.removeAll { $0 == selected }; selected = nil } label: { Image(systemName: "minus") }
                    .accessibilityLabel("Remove selected folder")
                    .disabled(selected == nil)
                Spacer()
                Button("Cancel") { dismiss() }.keyboardShortcut(.cancelAction)
                Button("Save") { onSave(paths); dismiss() }.keyboardShortcut(.defaultAction)
            }
            .controlSize(.small)
        }
        .padding(20)
        .frame(width: 420)
        .onAppear { paths = initial }
    }
}

// MARK: - Notifications

private struct NotificationsTab: View {
    var prefs: NotificationPrefs

    var body: some View {
        Form {
            Section("Notify me when") {
                ForEach(NotificationPrefs.Kind.allCases, id: \.self) { kind in
                    Toggle(isOn: Binding(get: { prefs.isOn(kind) }, set: { prefs.set(kind, $0) })) {
                        Text(kind.title)
                        if !kind.detail.isEmpty { Text(kind.detail) }
                    }
                }
            }

            Section {
                @Bindable var prefs = prefs
                Toggle(isOn: $prefs.showCountInMenuBar) {
                    Text("Show count in the menu bar")
                    Text("Review requests plus your PRs waiting on you")
                }
            } header: {
                Text("Menu bar")
            }

            Section {
                LabeledContent {
                    Button("Open…") {
                        if let url = URL(string: "x-apple.systempreferences:com.apple.Notifications-Settings.extension") { NSWorkspace.shared.open(url) }
                    }
                    .controlSize(.small)
                } label: {
                    Text("Banners, sounds and Focus are managed by macOS.").foregroundStyle(.secondary)
                }
            } header: {
                Text("macOS notification settings")
            }
        }
        .formStyle(.grouped)
    }
}

// MARK: - Server

private struct ServerTab: View {
    var model: AppModel
    @State private var copied = false
    @State private var copying = false
    @State private var restarting = false
    @State private var loginEnabled = SMAppService.mainApp.status == .enabled
    @State private var loginError: String?

    private var info: SettingsMessage? { model.settings }

    var body: some View {
        Form {
            Section {
                LabeledContent {
                    HStack(spacing: 6) {
                        StatusDot(color: model.isConnected ? Tokens.success : Tokens.danger)
                        Text(model.isConnected ? "Running" : "Unreachable")
                    }
                } label: {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Status")
                        caption("Started at login by launchd. Keeps running when the app quits.")
                    }
                }
                if let server = info?.server {
                    LabeledContent("Version", value: "quackd \(server.version) · pid \(server.pid)")
                    LabeledContent("Socket", value: displayPath(server.socketPath))
                }
                if let github = info?.github {
                    LabeledContent("GitHub", value: githubText(github))
                }
                Picker(selection: pollActive) {
                    ForEach(pollOptions, id: \.self) { Text(pollLabel($0)).tag($0) }
                } label: {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Check GitHub every")
                        caption("Every 5 minutes while no window is open.")
                    }
                }
            } header: {
                Text("Quack server")
            }

            Section {
                LabeledContent {
                    Button(restarting ? "Restarting…" : "Restart server") { restart() }
                        .controlSize(.small).disabled(restarting)
                } label: {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Restart server")
                        caption("Running asks are cancelled. Reviews and labels resume.")
                    }
                }
                LabeledContent {
                    Button(copied ? "Copied" : (copying ? "Collecting…" : "Copy diagnostics")) { copyDiagnostics() }
                        .controlSize(.small).disabled(copying)
                } label: {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Copy diagnostics")
                        caption("Doctor output and the last 500 log lines, secrets removed.")
                    }
                }
                if let log = info?.server.logPath {
                    LabeledContent {
                        Button("Show in Finder") {
                            NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: log)])
                        }
                        .controlSize(.small)
                    } label: {
                        VStack(alignment: .leading, spacing: 2) {
                            Text("Server log")
                            Text(displayPath(log)).font(.caption).foregroundStyle(.secondary).lineLimit(1).truncationMode(.middle)
                        }
                    }
                }
            } header: {
                Text("Troubleshooting")
            }

            Section {
                Toggle("Open Quacksteps at login", isOn: Binding(get: { loginEnabled }, set: { setLogin($0) }))
                if let loginError {
                    Text(loginError).font(.caption).foregroundStyle(Tokens.danger)
                }
            } footer: {
                caption("If macOS refuses, add it in System Settings › General › Login Items.")
            }
        }
        .formStyle(.grouped)
        .onAppear { loginEnabled = SMAppService.mainApp.status == .enabled }
    }

    private var pollOptions: [Int] {
        var o = [30, 60, 120, 300]
        if let c = info?.settings.pollActiveSeconds, !o.contains(c) { o.append(c); o.sort() }
        return o
    }

    private func pollLabel(_ seconds: Int) -> String {
        seconds < 120 ? "\(seconds) s" : (seconds % 60 == 0 ? "\(seconds / 60) min" : "\(seconds) s")
    }

    private var pollActive: Binding<Int> {
        Binding(get: { info?.settings.pollActiveSeconds ?? 60 }, set: { v in Task { await model.save(SettingsPatch(pollActiveSeconds: v)) } })
    }

    private func githubText(_ github: SettingsMessage.GitHub) -> String {
        let who = github.viewer ?? "Not signed in"
        guard let r = github.rateLimit else { return who }
        return "\(who) · \(r.remaining.formatted()) of \(r.limit.formatted()) calls left"
    }

    private func restart() {
        restarting = true
        Task {
            await model.restartServer()
            restarting = false
        }
    }

    private func copyDiagnostics() {
        copying = true
        copied = false
        Task {
            if let text = await model.diagnostics() {
                copyToPasteboard(text)
                copied = true
                try? await Task.sleep(for: .seconds(3))
                copied = false
            } else {
                model.actionError = "Couldn’t collect diagnostics."
            }
            copying = false
        }
    }

    private func setLogin(_ on: Bool) {
        loginError = nil
        do {
            if on { try SMAppService.mainApp.register() } else { try SMAppService.mainApp.unregister() }
        } catch {
            loginError = error.localizedDescription
        }
        loginEnabled = SMAppService.mainApp.status == .enabled
    }
}

#Preview {
    SettingsView(
        model: AppModel(preview: nil, connection: .disconnected(reason: "preview")),
        prefs: NotificationPrefs(defaults: UserDefaults(suiteName: "preview")!)
    )
}
