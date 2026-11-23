import Foundation
import Observation
import QuackClient
import QuackProtocol

/// One file in the PR tab's sidebar: the diff file plus its risk label, if any.
public struct RankedFile: Identifiable, Hashable, Sendable {
    public var file: PrDiffFile
    /// nil until labels are ready (or for files the labels don't cover).
    public var risk: FileRisk?
    public init(file: PrDiffFile, risk: FileRisk?) {
        self.file = file
        self.risk = risk
    }

    public var id: String { file.path }
    public var path: String { file.path }
    public var name: String { (file.path as NSString).lastPathComponent }
    /// "src/map/" ("/" for the repo root).
    public var folder: String {
        let dir = (file.path as NSString).deletingLastPathComponent
        return dir.isEmpty ? "/" : dir + "/"
    }
}

/// One chat turn in the inspector: a stored turn from the server, or one streaming now.
public struct ChatTurn: Identifiable, Hashable, Sendable {
    public enum Status: Hashable, Sendable {
        case streaming
        case done
        case failed(code: ErrorCode, message: String, fixSteps: [FixStep])
    }
    public let id: String
    public var question: String
    public var selections: [CodeSelection]
    public var answer: String
    public var agent: AgentId
    public var model: String
    public var headSha: String
    public var status: Status
    /// Factual activity lines while streaming ("Read File"), newest last.
    public var activity: [String]
    /// The latest progress step while streaming.
    public var step: ProgressStep?
    public var sessionId: String?

    public init(id: String = UUID().uuidString, question: String, selections: [CodeSelection] = [], answer: String = "", agent: AgentId, model: String = "",
                headSha: String = "", status: Status = .done, activity: [String] = [], step: ProgressStep? = nil, sessionId: String? = nil) {
        self.id = id
        self.question = question
        self.selections = selections
        self.answer = answer
        self.agent = agent
        self.model = model
        self.headSha = headSha
        self.status = status
        self.activity = activity
        self.step = step
        self.sessionId = sessionId
    }
}

/// Everything a PR tab shows, owned by AppModel so a tab keeps its state while you switch away.
/// Follows the server's `{ pr }` subscription (review + labels), loads the diff and stored chat, and runs asks.
@MainActor @Observable
public final class PRStore {
    public let pr: PrKey
    public private(set) var review: ReviewState?
    public private(set) var labels: RiskLabelsMessage?
    public private(set) var diff: PrDiffMessage?
    public private(set) var diffError: ServerError?
    public private(set) var loadingDiff = false
    public private(set) var turns: [ChatTurn] = []
    /// The file selected in the sidebar (and scrolled to in the diff).
    public var selectedFile: String?
    /// Where the diff was scrolled to (pixels from the top), so a tab comes back exactly where you left it.
    /// Kept per commit: a different head starts at the top. Not observed: only the diff view reads it.
    @ObservationIgnored public var diffScroll: (headSha: String, top: Double)?
    /// The chat agent and model for the next question; nil agent = the first ready one.
    public var askAgent: AgentId?
    public var askModel: String = ""

    // Writing reviews (v3); see PRStore+Review.swift.
    /// Pending comments and replies, on this Mac until submitted.
    public internal(set) var drafts: [DraftComment] = []
    public internal(set) var reviewSummary = ""
    public internal(set) var reviewEvent: ReviewEvent?
    /// GitHub's review threads on this PR.
    public internal(set) var ghThreads: [ReviewThread] = []
    /// GitHub's viewed state per path.
    public internal(set) var viewed: [String: ViewedState] = [:]
    /// My last submitted review: what "Since my last review" compares with.
    public internal(set) var lastReview: LastReview?
    public internal(set) var reviewViewer: String?
    /// The last review write that failed (shown as a banner until dismissed or retried).
    public var writeError: ServerError?
    /// "Since my last review" is on: the diff shows only what changed after `lastReview.commit`.
    public internal(set) var sinceLastReview = false
    /// "Turn into comment": the chat turn being drafted from, while the agent works.
    public internal(set) var draftingTurn: String?
    /// Turns already turned into a comment: turn id -> "lines 79–81".
    public internal(set) var placedDrafts: [String: String] = [:]
    /// A drafted comment for the diff to open in its editor. The diff opens each request once (by id).
    public internal(set) var editorRequest: EditorRequest?
    /// The gap check in the submit sheet.
    public internal(set) var gapCheck: GapCheckState = .idle
    /// Gap findings kept in the review: finding id -> draft id (for Undo).
    public internal(set) var gapKept: [String: String] = [:]
    public internal(set) var gapDismissed: Set<String> = []
    @ObservationIgnored var gapTask: Task<Void, Never>?
    /// Submitting the review: the sheet, then the toast or the failure panel.
    public internal(set) var submitState: SubmitState = .idle
    /// The Submit review sheet is open.
    public var showSubmitSheet = false
    /// I'm an assignee on GitHub (from the threads reply).
    public internal(set) var assignedToMe: Bool?
    /// Pending comments whose lines changed in a newer commit: draft id -> what changed.
    public internal(set) var outdated: [String: OutdatedDraft] = [:]
    @ObservationIgnored var reconciling = false

    @ObservationIgnored unowned let model: AppModel
    @ObservationIgnored private var subscription: Task<Void, Never>?
    @ObservationIgnored private var asking: Task<Void, Never>?

    init(model: AppModel, pr: PrKey) {
        self.model = model
        self.pr = pr
        review = model.item(for: pr)?.review
    }

    /// For previews and snapshots: fixed data, no server.
    public init(preview pr: PrKey, model: AppModel, review: ReviewState?, labels: RiskLabelsMessage?, diff: PrDiffMessage?, turns: [ChatTurn] = []) {
        self.model = model
        self.pr = pr
        self.review = review
        self.labels = labels
        self.diff = diff
        self.turns = turns
    }

    // MARK: Lifecycle

    /// Starts following the PR. Safe to call again (a tab shown twice).
    public func start() {
        guard subscription == nil else { return }
        subscription = Task { [weak self] in await self?.follow() }
        Task { await loadThreads() }
        Task { await loadReviewWrite() }
    }

    private func follow() async {
        do {
            for try await message in model.server.stream(.subscribe(.pr(pr))) {
                switch message {
                case let .review(m):
                    let previousHead = review?.headSha
                    review = m.review
                    // The diff follows the reviewed commit: reload after Start reviewing or Update moved it.
                    if let head = m.review?.headSha, !head.isEmpty, head != diff?.headSha, head != previousHead || diff == nil {
                        await loadDiff()
                    } else if diff == nil, !loadingDiff {
                        await loadDiff()
                    }
                case let .riskLabels(m): labels = m
                default: break
                }
            }
        } catch {}
    }

    // MARK: Diff

    /// Loads the diff at the reviewed commit, or the PR's latest head when not reviewing.
    public func loadDiff() async {
        loadingDiff = true
        defer { loadingDiff = false }
        let head = review.flatMap { $0.headSha.isEmpty ? nil : $0.headSha }
        let since = sinceLastReview ? lastReview?.commit : nil
        do {
            if case let .prDiff(m) = try await model.server.request(.prDiff(pr, headSha: head, since: since), timeout: .seconds(120)) {
                diff = m
                diffError = nil
                if selectedFile == nil { selectedFile = rankedFiles.first?.path }
                Task { await reconcileDrafts() }
            }
        } catch let error as RequestError {
            diffError = ServerError(code: error.code, message: error.message, fixSteps: error.fixSteps)
        } catch {
            diffError = ServerError(code: .fetchFailed, message: "\(error)", fixSteps: [])
        }
    }

    /// Labels that belong to the commit on screen (older labels show dimmed while new ones run).
    public var labelsAreCurrent: Bool {
        guard let labels, let head = diff?.headSha else { return false }
        return labels.headSha == head && labels.previousHeadSha == nil
    }

    /// The labels the sidebar and the diff show. While reviewing: whatever the server has (older labels
    /// show dimmed until a new run finishes). Not reviewing: only labels for exactly the commit on screen,
    /// e.g. cached from an earlier review, never a stale ranking for another commit.
    public var visibleLabels: RiskLabelsMessage? {
        guard let labels, !labels.files.isEmpty else { return nil }
        if review != nil { return labels }
        return labelsAreCurrent ? labels : nil
    }

    /// Sidebar order: ranked by risk once labels exist, else diff order.
    public var rankedFiles: [RankedFile] {
        let files = diff?.files ?? []
        guard let labels = visibleLabels else { return files.map { RankedFile(file: $0, risk: nil) } }
        let byPath = Dictionary(labels.files.map { ($0.path, $0) }, uniquingKeysWith: { a, _ in a })
        return files
            .map { RankedFile(file: $0, risk: byPath[$0.path]) }
            .sorted { ($0.risk?.rank ?? Int.max, $0.path) < ($1.risk?.rank ?? Int.max, $1.path) }
    }

    /// Ranked files grouped High, Medium, Low, Unlabeled (empty groups dropped).
    public var sections: [(risk: FileRisk.Risk, files: [RankedFile])] {
        let ranked = rankedFiles
        return FileRisk.Risk.allCases.compactMap { risk in
            let files = ranked.filter { ($0.risk?.risk ?? .unlabeled) == risk }
            return files.isEmpty ? nil : (risk, files)
        }
    }

    public var totals: (files: Int, additions: Int, deletions: Int) {
        let files = diff?.files ?? []
        return (files.count, files.reduce(0) { $0 + $1.additions }, files.reduce(0) { $0 + $1.deletions })
    }

    public func rerunLabels() async {
        _ = try? await model.server.request(.riskLabels(pr, headSha: review?.headSha, rerun: true))
    }

    // MARK: Chat

    public func loadThreads() async {
        guard case let .threads(m) = try? await model.server.request(.threads(pr)) else { return }
        let live = turns.filter { $0.status == .streaming }
        turns = m.turns.enumerated().map { index, t in
            ChatTurn(id: "stored-\(index)", question: t.question, selections: t.selections, answer: t.answer, agent: t.agent, model: t.model,
                     headSha: t.headSha, status: .done, activity: [], sessionId: t.sessionId)
        } + live
    }

    public var isAsking: Bool { turns.last?.status == .streaming }

    /// The agent the next question goes to.
    public var effectiveAgent: AgentId? {
        askAgent ?? model.agents.first { $0.state == .ready }?.id
    }

    /// Asks about the PR (optionally about selected lines). The answer streams into `turns`.
    public func ask(_ question: String, selections: [CodeSelection] = []) {
        guard let agent = effectiveAgent, !isAsking else { return }
        let head = diff?.headSha ?? review?.headSha
        // Follow-ups reuse the agent session when the agent is the same and the commit hasn't moved.
        let previous = turns.last { $0.status == .done && $0.agent == agent && $0.headSha == (head ?? "") }
        var turn = ChatTurn(id: UUID().uuidString, question: question, selections: selections, answer: "", agent: agent, model: askModel,
                            headSha: head ?? "", status: .streaming, activity: [], sessionId: nil)
        turns.append(turn)
        // A new agent session (another agent, or the commit moved) gets the thread so far, so the answer has context.
        let history = previous?.sessionId == nil ? Self.history(from: turns.dropLast()) : []
        let request = AppRequest.ask(agent: agent, model: askModel, pr: PrRef(pr, headSha: head), selections: selections, question: question,
                                     sessionId: previous?.sessionId, history: history)
        asking = Task { [weak self] in
            guard let self else { return }
            do {
                for try await message in model.server.stream(request) {
                    switch message {
                    case let .progress(p):
                        turn.step = p.step
                    case let .event(e):
                        switch e.event {
                        case let .text(delta): turn.answer += delta
                        case let .tool(summary): turn.activity.append(summary)
                        case let .done(sessionId, headSha, model):
                            turn.sessionId = sessionId
                            turn.headSha = headSha
                            if !model.isEmpty { turn.model = model }
                            turn.status = .done
                        case let .error(err):
                            turn.status = .failed(code: err.code, message: err.message, fixSteps: err.fixSteps ?? [])
                        }
                    default: break
                    }
                    update(turn)
                    if turn.status != .streaming { break }
                }
                if turn.status == .streaming {
                    turn.status = .failed(code: .cancelled, message: "Stopped.", fixSteps: [])
                    update(turn)
                }
            } catch {
                turn.status = .failed(code: .cancelled, message: "\(error)", fixSteps: [])
                update(turn)
            }
        }
    }

    /// The last finished turns as history: at most 8, answers trimmed so the prompt stays small.
    nonisolated static func history(from turns: some Collection<ChatTurn>) -> [HistoryTurn] {
        turns.filter { $0.status == .done && !$0.answer.isEmpty }.suffix(8).map {
            HistoryTurn(question: $0.question, answer: $0.answer.count > 4000 ? String($0.answer.prefix(4000)) + "…" : $0.answer)
        }
    }

    /// The tab closed: stop the agent processes kept open for this thread (the chat itself stays stored).
    public func endSessions() {
        stopAsking()
        var seen = Set<String>()
        for turn in turns {
            guard let id = turn.sessionId, seen.insert("\(turn.agent.rawValue):\(id)").inserted else { continue }
            model.server.post(.closeSession(agent: turn.agent, sessionId: id))
        }
    }

    /// Esc: stops the running answer (the server aborts the agent).
    public func stopAsking() {
        asking?.cancel()
        asking = nil
    }

    private func update(_ turn: ChatTurn) {
        if let i = turns.firstIndex(where: { $0.id == turn.id }) { turns[i] = turn }
    }

    // MARK: Review shortcuts

    public func startReview() async { await model.startReview(pr) }
    public func updateReview() async { await model.updateReview(pr) }
    public func stopReview(removeWorktree: Bool = false) async { await model.stopReview(pr, removeWorktree: removeWorktree) }
}

extension AppModel {
    /// The PR's store, created on first use and kept while the app runs.
    public func store(for pr: PrKey) -> PRStore {
        if let existing = prStores[pr.id] { return existing }
        let store = PRStore(model: self, pr: pr)
        prStores[pr.id] = store
        return store
    }
}
