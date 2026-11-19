import AppKit
import Observation
import QuackProtocol
import QuackStores
import SwiftUI

// The chat inspector: agent picker, the thread, a composer pinned to the bottom.
// Content for `.inspector` (300–480 pt, ideal 340).

public struct ChatInspector: View {
    var store: PRStore
    var model: AppModel
    @Binding var focusComposer: Bool

    @State private var draft = ""
    @FocusState private var composerFocused: Bool

    public init(store: PRStore, model: AppModel, focusComposer: Binding<Bool>) {
        self.store = store
        self.model = model
        _focusComposer = focusComposer
    }

    public var body: some View {
        VStack(spacing: 0) {
            header
            Divider()
            thread
        }
        .safeAreaInset(edge: .bottom, spacing: 0) { composer }
        .onKeyPress(.escape) {
            guard store.isAsking else { return .ignored }
            store.stopAsking()
            return .handled
        }
        .onChange(of: focusComposer) { _, wanted in
            if wanted {
                composerFocused = true
                focusComposer = false
            }
        }
        .environment(\.openURL, OpenURLAction { url in
            if let path = ChatLinks.path(from: url) {
                store.selectedFile = path
                return .handled
            }
            // Answers can carry prompt-injected links (from PR content), so only web links open, in the
            // browser. file://, app schemes (vscode://, x-apple…) and anything else are dropped.
            guard let scheme = url.scheme?.lowercased(), scheme == "https" || scheme == "http" else { return .discarded }
            return .systemAction
        })
    }

    // MARK: Header

    private var effectiveStatus: AgentStatus? {
        model.agents.first { $0.id == store.effectiveAgent }
    }

    private var header: some View {
        HStack(spacing: 8) {
            Text("Ask Quack").font(.system(size: 13, weight: .semibold)).accessibilityAddTraits(.isHeader)
            Spacer(minLength: 4)
            agentMenu
        }
        .padding(.horizontal, 14)
        .frame(height: 44)
    }

    private var agentMenu: some View {
        Menu {
            Section("Agent") {
                ForEach(model.agents) { agent in
                    Button {
                        if store.askAgent != agent.id { store.askModel = "" }
                        store.askAgent = agent.id
                    } label: {
                        if agent.id == store.effectiveAgent {
                            Label(ChatText.agentTitle(agent), systemImage: "checkmark")
                        } else {
                            Text(ChatText.agentTitle(agent))
                        }
                    }
                    .disabled(agent.state != .ready)
                }
            }
            if let models = effectiveStatus?.models, !models.isEmpty {
                Section("Model") {
                    ForEach(models, id: \.self) { name in
                        Button {
                            store.askModel = name
                        } label: {
                            if name == store.askModel {
                                Label(ChatText.modelName(name), systemImage: "checkmark")
                            } else {
                                Text(ChatText.modelName(name))
                            }
                        }
                    }
                }
            }
        } label: {
            Text(pickerLabel)
        }
        .menuStyle(.button)
        .buttonStyle(.bordered)
        .controlSize(.small)
        .fixedSize()
        .disabled(model.agents.isEmpty)
        .accessibilityLabel("Agent and model")
        .accessibilityValue(pickerLabel)
    }

    private var pickerLabel: String {
        guard let status = effectiveStatus else { return "No agent" }
        return "\(status.label) · \(ChatText.modelName(store.askModel))"
    }

    // MARK: Thread

    private var scrollKey: String {
        let last = store.turns.last
        return "\(store.turns.count)|\(last?.answer.count ?? 0)|\(last?.activity.count ?? 0)|\(last.map { "\($0.status)" } ?? "")"
    }

    private var thread: some View {
        ScrollViewReader { proxy in
            ScrollView {
                if store.turns.isEmpty {
                    emptyThread
                } else {
                    LazyVStack(alignment: .leading, spacing: 18) {
                        ForEach(store.turns) { turn in
                            TurnView(turn: turn, store: store, model: model, focusComposer: { composerFocused = true })
                        }
                        Color.clear.frame(height: 1).id("end")
                    }
                    .padding(14)
                }
            }
            .onChange(of: scrollKey) {
                proxy.scrollTo("end", anchor: .bottom)
            }
            .onAppear { proxy.scrollTo("end", anchor: .bottom) }
        }
    }

    private var shortSha: String {
        String((store.diff?.headSha ?? store.review?.headSha ?? "").prefix(7))
    }

    private var emptyThread: some View {
        VStack(spacing: 10) {
            QuackLogo(height: 22).accessibilityHidden(true).padding(.bottom, 4)
            Text("Ask the duck.").font(QuackFont.headline(18))
            Text(verbatim: shortSha.isEmpty
                 ? "It reads this PR’s worktree and can open any file in the repo. It can’t change anything."
                 : "It reads this PR’s worktree at \(shortSha) and can open any file in the repo. It can’t change anything.")
                .font(.system(size: 12))
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
            VStack(spacing: 6) {
                ForEach(ChatText.starters, id: \.self) { starter in
                    Button(starter) { store.ask(starter) }
                        .buttonStyle(.bordered)
                        .controlSize(.regular)
                        .disabled(store.effectiveAgent == nil)
                }
            }
            .padding(.top, 8)
        }
        .frame(maxWidth: .infinity)
        .padding(.horizontal, 24)
        .padding(.top, 56)
        .padding(.bottom, 24)
    }

    // MARK: Composer

    private var canSend: Bool {
        !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !store.isAsking && store.effectiveAgent != nil
    }

    private func send() {
        guard canSend else { return }
        store.ask(draft.trimmingCharacters(in: .whitespacesAndNewlines))
        draft = ""
    }

    private var composer: some View {
        VStack(spacing: 6) {
            HStack(alignment: .bottom, spacing: 8) {
                TextField("Ask about this PR…", text: $draft, axis: .vertical)
                    .textFieldStyle(.plain)
                    .font(.system(size: 13))
                    .lineLimit(1...6)
                    .focused($composerFocused)
                    .accessibilityLabel("Ask about this PR")
                    .padding(.vertical, 4)
                if store.isAsking {
                    Button { store.stopAsking() } label: { sendGlyph("stop.fill") }
                        .buttonStyle(.plain)
                        .accessibilityLabel("Stop")
                        .help("Stop (Esc)")
                } else {
                    Button { send() } label: { sendGlyph("arrow.up") }
                        .buttonStyle(.plain)
                        .keyboardShortcut(.return, modifiers: .command)
                        .disabled(!canSend)
                        .accessibilityLabel("Send")
                        .help("Send (⌘↩)")
                }
            }
            .padding(.leading, 12)
            .padding(.trailing, 6)
            .padding(.vertical, 4)
            .background(Color(nsColor: .textBackgroundColor), in: RoundedRectangle(cornerRadius: 14))
            .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(Color.primary.opacity(0.12)))
            HStack {
                Text("⌘K for commands")
                Spacer()
                Text("⌘↩")
            }
            .font(.system(size: 11))
            .foregroundStyle(.secondary)
            .padding(.horizontal, 4)
            .accessibilityHidden(true)
        }
        .padding(.horizontal, 12)
        .padding(.top, 10)
        .padding(.bottom, 8)
        .background(.bar)
    }

    private func sendGlyph(_ symbol: String) -> some View {
        Image(systemName: symbol)
            .font(.system(size: 12, weight: .bold))
            .foregroundStyle(Tokens.ink)
            .frame(width: 26, height: 26)
            .background(Tokens.quackSoft, in: Circle())
            .overlay(Circle().strokeBorder(Tokens.quackSoftEdge, lineWidth: 0.5))
            .opacity(symbol == "arrow.up" && !canSend ? 0.45 : 1)
    }
}

// MARK: - Copy helpers

enum ChatText {
    static let starters = ["What could break?", "Summarise this PR in five lines", "Where are the tests for this?"]

    static func modelName(_ model: String) -> String { model.isEmpty ? "Default" : model }

    static func agentTitle(_ agent: AgentStatus) -> String {
        switch agent.state {
        case .ready: agent.label
        case .notLoggedIn: "\(agent.label) (not logged in)"
        case .notInstalled: "\(agent.label) (not installed)"
        }
    }

    /// "47–51", "47", or nil.
    static func lines(_ s: CodeSelection) -> String? {
        switch (s.startLine, s.endLine) {
        case let (start?, end?) where end != start: "\(start)–\(end)"
        case let (start?, _): "\(start)"
        case let (nil, end?): "\(end)"
        default: nil
        }
    }

    static func selectionLabel(_ s: CodeSelection) -> String {
        let path = s.path ?? "selection"
        guard let lines = lines(s) else { return path }
        return "\(path):\(lines)"
    }
}

// MARK: - File links

enum ChatLinks {
    static func url(for path: String) -> URL? {
        var c = URLComponents()
        c.scheme = "quack-file"
        c.host = "open"
        c.queryItems = [URLQueryItem(name: "path", value: path)]
        return c.url
    }

    static func path(from url: URL) -> String? {
        guard url.scheme == "quack-file", let c = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return nil }
        return c.queryItems?.first { $0.name == "path" }?.value
    }

    /// Matches by suffix against the PR's files: "clusterPins.ts" finds "src/map/clusterPins.ts".
    static func resolve(_ token: String, in paths: [String]) -> String? {
        let name = token.hasPrefix("./") ? String(token.dropFirst(2)) : token
        if let exact = paths.first(where: { $0 == name }) { return exact }
        return paths.first { $0.hasSuffix("/" + name) }
    }
}

// MARK: - Markdown

enum ProseBlock: Hashable {
    case text(String)
    case code(language: String?, code: String)
}

enum ProseParser {
    /// Splits an answer into paragraphs and fenced code. An unclosed fence (still streaming) is code so far.
    static func blocks(_ source: String) -> [ProseBlock] {
        var blocks: [ProseBlock] = []
        var paragraph: [String] = []
        var code: [String] = []
        var language: String?
        var inFence = false

        func flushParagraph() {
            let text = paragraph.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
            if !text.isEmpty { blocks.append(.text(text)) }
            paragraph = []
        }

        for line in source.split(separator: "\n", omittingEmptySubsequences: false).map(String.init) {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed.hasPrefix("```") {
                if inFence {
                    blocks.append(.code(language: language, code: code.joined(separator: "\n")))
                    code = []
                    inFence = false
                } else {
                    flushParagraph()
                    let lang = trimmed.dropFirst(3).trimmingCharacters(in: .whitespaces)
                    language = lang.isEmpty ? nil : lang
                    inFence = true
                }
            } else if inFence {
                code.append(line)
            } else if trimmed.isEmpty {
                flushParagraph()
            } else {
                paragraph.append(line)
            }
        }
        if inFence { blocks.append(.code(language: language, code: code.joined(separator: "\n"))) }
        flushParagraph()
        return blocks
    }

    /// Bullets and headings are line-level markdown; inline-only parsing leaves them, so tidy them first.
    static func prepare(_ paragraph: String) -> String {
        paragraph.split(separator: "\n", omittingEmptySubsequences: false).map { raw -> String in
            let line = String(raw)
            let indent = line.prefix { $0 == " " }
            let body = line.dropFirst(indent.count)
            if body.hasPrefix("- ") || body.hasPrefix("* ") { return indent + "•  " + body.dropFirst(2) }
            if body.hasPrefix("#") {
                let text = body.drop { $0 == "#" }.trimmingCharacters(in: .whitespaces)
                if !text.isEmpty, body.count - body.drop(while: { $0 == "#" }).count <= 6 { return "**\(text)**" }
            }
            return line
        }.joined(separator: "\n")
    }

    static func attributed(_ paragraph: String, paths: [String]) -> AttributedString {
        let prepared = prepare(paragraph)
        var text = (try? AttributedString(markdown: prepared, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)))
            ?? AttributedString(prepared)
        guard !paths.isEmpty, let regex = try? Regex(#"[A-Za-z0-9_@\[\]./-]+\.[A-Za-z0-9]+(?::\d+(?:[-–]\d+)?)?"#) else { return text }
        let plain = String(text.characters)
        for match in plain.matches(of: regex).reversed() {
            let token = String(plain[match.range])
            let file = token.split(separator: ":", maxSplits: 1).first.map(String.init) ?? token
            guard let path = ChatLinks.resolve(file, in: paths), let url = ChatLinks.url(for: path) else { continue }
            let from = plain.distance(from: plain.startIndex, to: match.range.lowerBound)
            let to = plain.distance(from: plain.startIndex, to: match.range.upperBound)
            let lower = text.characters.index(text.characters.startIndex, offsetBy: from)
            let upper = text.characters.index(text.characters.startIndex, offsetBy: to)
            text[lower..<upper].link = url
        }
        return text
    }
}

struct ProseView: View {
    var markdown: String
    var paths: [String]

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(Array(ProseParser.blocks(markdown).enumerated()), id: \.offset) { _, block in
                switch block {
                case let .text(paragraph):
                    Text(ProseParser.attributed(paragraph, paths: paths))
                        .font(.system(size: 13))
                        .lineSpacing(2)
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                case let .code(language, code):
                    CodeBlockView(code: code, language: language)
                }
            }
        }
    }
}

struct CodeBlockView: View {
    var code: String
    var language: String?
    @State private var copied = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text(language ?? "code").font(.system(size: 11)).foregroundStyle(.secondary)
                Spacer()
                Button {
                    copyToPasteboard(code)
                    copied = true
                } label: {
                    Label(copied ? "Copied" : "Copy", systemImage: copied ? "checkmark" : "doc.on.doc")
                }
                .buttonStyle(.borderless)
                .controlSize(.small)
            }
            .padding(.horizontal, 10)
            .padding(.top, 6)
            ScrollView(.horizontal) {
                Text(verbatim: code)
                    .font(.system(size: 12, design: .monospaced))
                    .textSelection(.enabled)
                    .fixedSize()
                    .padding(.horizontal, 10)
                    .padding(.vertical, 8)
            }
            .scrollIndicators(.automatic)
        }
        .background(Tokens.fill, in: RoundedRectangle(cornerRadius: 8))
    }
}

// MARK: - One turn

private struct TurnView: View {
    var turn: ChatTurn
    var store: PRStore
    var model: AppModel
    var focusComposer: () -> Void

    private var paths: [String] { store.rankedFiles.map(\.path) }

    private var agentLabel: String {
        model.agents.first { $0.id == turn.agent }?.label ?? turn.agent.rawValue
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            question
            answer
        }
    }

    private var question: some View {
        VStack(alignment: .leading, spacing: 8) {
            if !turn.selections.isEmpty {
                FlowPills(labels: turn.selections.map(ChatText.selectionLabel))
            }
            Text(turn.question)
                .font(.system(size: 13))
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 9)
        .background(Tokens.fill, in: RoundedRectangle(cornerRadius: 12))
        .accessibilityElement(children: .combine)
        .accessibilityLabel("You asked: \(turn.question)" + (turn.selections.isEmpty ? "" : ". About \(turn.selections.map(ChatText.selectionLabel).joined(separator: ", "))"))
    }

    private var label: String {
        var parts = ["Quack", agentLabel]
        if !turn.model.isEmpty { parts.append(turn.model) }
        var text = parts.joined(separator: " · ")
        let sha = String(turn.headSha.prefix(7))
        if !sha.isEmpty { text += " · at \(sha)" }
        return text
    }

    @ViewBuilder private var answer: some View {
        HStack(spacing: 6) {
            QuackLogo(height: 11).accessibilityHidden(true)
            Text(verbatim: label).font(.system(size: 11)).foregroundStyle(.secondary)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(label)

        switch turn.status {
        case .streaming:
            if !turn.answer.isEmpty { ProseView(markdown: turn.answer, paths: paths) }
            ThinkingView(turn: turn, agentLabel: agentLabel)
        case .done:
            if !turn.answer.isEmpty { ProseView(markdown: turn.answer, paths: paths) }
            HStack(spacing: 8) {
                Button("Copy as comment") { copyToPasteboard(turn.answer) }
                Button("Ask a follow-up", action: focusComposer)
            }
            .buttonStyle(.bordered)
            .controlSize(.small)
        case let .failed(code, message, fixSteps):
            if !turn.answer.isEmpty { ProseView(markdown: turn.answer, paths: paths) }
            failure(code: code, message: message, fixSteps: fixSteps)
        }
    }

    @ViewBuilder
    private func failure(code: ErrorCode, message: String, fixSteps: [FixStep]) -> some View {
        if code == .cancelled {
            Text("Stopped.").font(.system(size: 12)).foregroundStyle(.secondary)
        } else if code == .agentNotLoggedIn || code == .agentNotInstalled {
            let notInstalled = code == .agentNotInstalled
            let steps = fixSteps.isEmpty ? (model.agents.first { $0.id == turn.agent }?.fixSteps ?? []) : fixSteps
            let command = steps.compactMap(\.command).first
            let other = model.agents.first { $0.state == .ready && $0.id != turn.agent }
            VStack(alignment: .leading, spacing: 8) {
                Text(notInstalled ? "\(agentLabel) isn’t installed." : "\(agentLabel) isn’t logged in.")
                    .font(QuackFont.headline(14))
                Text("Run this in Terminal, then ask again. Quack never handles your login.")
                    .font(.system(size: 12))
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                if let command { CommandBox(command) } else if !steps.isEmpty { FixStepsView(steps) }
                if let other {
                    Button("Switch to \(other.label)") {
                        store.askAgent = other.id
                        store.askModel = ""
                    }
                    .buttonStyle(.bordered)
                    .controlSize(.small)
                }
            }
        } else if code == .serverBusy {
            Banner(.warning, title: "Two label jobs are running.", message: "Yours is next.")
        } else {
            VStack(alignment: .leading, spacing: 8) {
                Banner(.error, title: "Quack couldn’t answer.", message: message)
                if !fixSteps.isEmpty { FixStepsView(fixSteps) }
            }
        }
    }
}

/// Selection pills on a question: cream, beak outline at 35%, mono "path:start–end".
private struct FlowPills: View {
    var labels: [String]
    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            ForEach(Array(labels.enumerated()), id: \.offset) { _, label in
                Text(verbatim: label)
                    .font(.system(size: 11, design: .monospaced))
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 2)
                    .background(Tokens.cream, in: Capsule())
                    .overlay(Capsule().strokeBorder(Tokens.beak.opacity(0.35)))
            }
        }
    }
}

// MARK: - Thinking

enum ThinkingPhase: Hashable {
    case preparing, searching, reading, thinking, writing, slow
}

struct ThinkingInput: Hashable {
    var phase: ThinkingPhase = .thinking
    var agent = ""
    var activity: [String] = []
    var selectionLines: String?
}

enum ThinkingCopy {
    static let table: [ThinkingPhase: [String]] = [
        .preparing: [
            "Filling the pond…", "Checking out the branch. Quietly.", "Lining up the ducks…", "Starting {agent}. The duck supervises.",
            "Fetching commits. Ducks don’t fetch, but okay.", "Laying out the worktree. Like an egg, but useful.", "Getting its ducks in a row. Literally.",
        ],
        .searching: [
            "Rummaging through the reeds…", "Dabbling through {n} matches…", "Following a paper trail of imports…",
            "Looking for something that already does this.", "Grepping. Ducks call it foraging.", "Bottoms up. Searching the deep end.",
            "Checking if someone wrote this in 2019.", "Hunting for the other caller.",
        ],
        .reading: [
            "Reading {file}. Judgmentally.", "Paddling through {n} files…", "Skimming. Ducks are good at skimming.", "Reading the tests. Someone has to.",
            "Reading {file}. Raising one eyebrow.", "Reading the comments. Trusting none of them.", "Following the types upstream…",
            "Reading git blame. No names, just vibes.",
        ],
        .thinking: [
            "Thinking it over, mostly in quacks.", "Rubber-ducking your code back at you…", "Connecting dots. And dots to dots.", "Mulling. Ducks mull.",
            "Staring at the code until it confesses.", "Weighing edge cases. They’re heavier than they look.",
            "Considering nulls. Someone always forgets the nulls.", "Calm on the surface, paddling hard below.",
        ],
        .writing: [
            "Drafting an answer. Feathers may ruffle.", "Putting it in words a reviewer would sign.", "Citing line numbers, like a pro.",
            "Almost there. Smoothing the feathers.", "Cutting the fluff. Ducks know fluff.", "Fewer words, more line numbers.",
            "Writing it down before it waddles off.",
        ],
        .slow: [
            "Still paddling. Big diff, small duck.", "This one has depth. The duck dove in.", "Worth the wait, probably. Esc to stop.",
            "Still here. Still quacking.", "Long PR. The duck packed a snack.", "Taking the scenic route through the pond.",
            "Not stuck. Thorough. Esc if you disagree.",
        ],
    ]

    static func pool(_ input: ThinkingInput) -> [String] {
        let reads = input.activity.filter { $0.hasPrefix("Read") }
        let last = input.activity.last ?? ""
        let matches = last.firstMatch(of: /(\d+) match/).flatMap { Int($0.1) }
        let file = last.firstMatch(of: /^Read\s+(\S+)/).map { String($0.1).split(separator: "/").last.map(String.init) ?? String($0.1) }
        var lines = (table[input.phase] ?? []).compactMap { line -> String? in
            var line = line
            if line.contains("{n}") {
                let n = input.phase == .searching ? matches : reads.count
                guard let n, n >= 2 else { return nil }
                line = line.replacingOccurrences(of: "{n}", with: String(n))
            }
            if line.contains("{file}") {
                guard let file else { return nil }
                line = line.replacingOccurrences(of: "{file}", with: file)
            }
            return line.replacingOccurrences(of: "{agent}", with: input.agent)
        }
        if input.phase == .thinking, let range = input.selectionLines { lines.append("Staring at lines \(range).") }
        return lines
    }
}

@MainActor @Observable
final class ThinkingTicker {
    private(set) var headline = ""
    private var last = ""
    private var input = ThinkingInput()
    let started = Date()

    /// Called when the facts change; swaps at once only if the phase moved.
    func apply(_ new: ThinkingInput) {
        let phaseChanged = new.phase != input.phase || headline.isEmpty
        input = new
        if phaseChanged { advance() }
    }

    /// Picks the next headline, never the one on screen.
    func advance() {
        if Date().timeIntervalSince(started) >= 30, input.phase != .slow { input.phase = .slow }
        let pool = ThinkingCopy.pool(input)
        let options = pool.count > 1 ? pool.filter { $0 != last } : pool
        guard let next = options.randomElement() else { return }
        last = next
        headline = next
    }
}

private struct ThinkingView: View {
    var turn: ChatTurn
    var agentLabel: String
    @State private var ticker = ThinkingTicker()
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var input: ThinkingInput {
        let preparingSteps: [ProgressStep] = [.findingRepo, .fetchingPr, .preparingWorktree, .fetchingCi, .startingAgent]
        let last = turn.activity.last ?? ""
        let phase: ThinkingPhase
        if let step = turn.step, preparingSteps.contains(step), turn.activity.isEmpty, turn.answer.isEmpty {
            phase = .preparing
        } else if !turn.answer.isEmpty {
            phase = .writing
        } else if last.hasPrefix("Search") {
            phase = .searching
        } else if last.hasPrefix("Read") {
            phase = .reading
        } else {
            phase = .thinking
        }
        let lines = turn.selections.compactMap(ChatText.lines).first
        return ThinkingInput(phase: phase, agent: agentLabel, activity: turn.activity, selectionLines: lines)
    }

    private var stepLabel: String? {
        guard let step = turn.step, turn.activity.isEmpty, turn.answer.isEmpty else { return nil }
        switch step {
        case .findingRepo: return "Finding the repo"
        case .fetchingPr: return "Fetching the PR"
        case .preparingWorktree: return "Preparing the worktree"
        case .fetchingCi: return "Fetching CI results"
        case .startingAgent: return "Starting \(agentLabel)"
        case .thinking: return nil
        case .labeling: return "Ranking files"
        }
    }

    private var lines: [String] {
        Array(([stepLabel].compactMap { $0 } + turn.activity).suffix(4))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(ticker.headline)
                .id(ticker.headline)
                .font(QuackFont.headline(14))
                .transition(.opacity)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                ForEach(Array(lines.enumerated()), id: \.offset) { _, line in
                    Label {
                        Text(line)
                    } icon: {
                        Image(systemName: "circle.fill").font(.system(size: 3))
                    }
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                }
            }
            .accessibilityElement(children: .combine)
            .accessibilityLabel(lines.last ?? "Working")
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .onAppear { ticker.apply(input) }
        .onChange(of: input) { _, new in withAnimation(reduceMotion ? nil : .easeInOut(duration: 0.25)) { ticker.apply(new) } }
        .onChange(of: lines.last) { _, new in
            // A polite live region: each new factual line is announced without interrupting.
            if let new { AccessibilityNotification.Announcement(new).post() }
        }
        .task {
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(Double.random(in: 3...4)))
                if Task.isCancelled { break }
                withAnimation(reduceMotion ? nil : .easeInOut(duration: 0.25)) { ticker.advance() }
            }
        }
    }
}

// MARK: - Previews

enum ChatPreviewData {
    static let pr = PrKey(owner: "acme", repo: "web", number: 97)

    static func agents() -> [AgentStatus] {
        let json = #"[{"id":"claude-code","label":"Claude Code","state":"ready","models":["","Sonnet 4.5"],"fixSteps":[]},{"id":"cursor","label":"Cursor","state":"not_logged_in","models":[""],"fixSteps":[{"text":"Log in","command":"cursor-agent login"}]}]"#
        return (try? JSONDecoder().decode([AgentStatus].self, from: Data(json.utf8))) ?? []
    }

    static func diff() -> PrDiffMessage? {
        let file = { (path: String) in
            #"{"path":"\#(path)","status":"modified","additions":10,"deletions":2,"binary":false,"truncated":false}"#
        }
        let json = #"{"requestId":"p","pr":{"owner":"acme","repo":"web","number":97},"baseSha":"b0b0b0b","headSha":"a41c9e2","files":[\#(file("src/map/clusterPins.ts")),\#(file("src/map/clusterPins.test.ts"))]}"#
        return try? JSONDecoder().decode(PrDiffMessage.self, from: Data(json.utf8))
    }

    @MainActor static func store(model: AppModel) -> PRStore {
        PRStore(preview: pr, model: model, review: nil, labels: nil, diff: diff())
    }
}

#Preview("Chat, empty") {
    @Previewable @State var focus = false
    let model = AppModel(preview: QuackPreviewData.message(), connection: QuackPreviewData.connected, agents: ChatPreviewData.agents())
    ChatInspector(store: ChatPreviewData.store(model: model), model: model, focusComposer: $focus)
        .frame(width: 340, height: 640)
}
