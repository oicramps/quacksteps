import Foundation
import QuackClient
import QuackProtocol

// Writing reviews (v3): drafts, GitHub threads, viewed ticks and "Since my last review".
// Drafts live on the server (state.db) so they survive restarts; this mirrors them for the UI.

extension PRStore {
    /// The server can write reviews to GitHub.
    public var canWrite: Bool { model.hello?.capabilities.write == true }

    /// Pending comments and replies: the Submit button's count.
    public var pendingCount: Int { drafts.count }

    /// Paths carrying one of my pending comments (the orange gutter dot).
    public var draftPaths: Set<String> { Set(drafts.compactMap { $0.anchor?.path }) }

    /// "Viewed 3 of 12": files on screen ticked viewed on GitHub.
    public var viewedProgress: (viewed: Int, total: Int) {
        let paths = diff?.files.map(\.path) ?? []
        return (paths.filter { viewed[$0] == .viewed }.count, paths.count)
    }

    /// "Since my last review" is possible: I reviewed this PR before, at a commit older than the one on screen.
    public var canShowSinceLastReview: Bool {
        guard let last = lastReview?.commit else { return false }
        let head = review?.headSha.isEmpty == false ? review?.headSha : diff?.headSha
        return head != nil && last != head
    }

    /// Drafts and GitHub's side (threads, viewed, last review). Quietly does nothing on an older server.
    public func loadReviewWrite() async {
        guard canWrite else { return }
        if case let .reviewDrafts(m)? = try? await model.server.request(.reviewDrafts(pr)) {
            apply(m)
            await reconcileDrafts()
        }
        await loadGitHubThreads()
    }

    public func loadGitHubThreads() async {
        guard canWrite else { return }
        do {
            if case let .reviewThreads(m) = try await model.server.request(.reviewThreads(pr), timeout: .seconds(60)) { apply(m) }
        } catch {
            // Reading threads is best effort: the diff works without them.
        }
    }

    /// Adds or replaces a draft. Returns false (with `writeError` set) when the server refused it.
    @discardableResult
    public func saveDraft(_ draft: DraftInput) async -> Bool {
        await write(.saveDraft(pr, draft))
    }

    @discardableResult
    public func deleteDraft(_ id: String) async -> Bool {
        await write(.deleteDraft(pr, id: id))
    }

    /// Resolves or unresolves a thread on GitHub right away.
    public func resolveThread(_ id: String, resolved: Bool) async {
        if let i = ghThreads.firstIndex(where: { $0.id == id }) { ghThreads[i].isResolved = resolved }
        if !(await write(.resolveThread(pr, threadId: id, resolved: resolved))), let i = ghThreads.firstIndex(where: { $0.id == id }) {
            ghThreads[i].isResolved = !resolved
        }
    }

    /// Ticks a file viewed on GitHub. Shown at once; put back if GitHub refuses.
    public func setViewed(_ path: String, _ isViewed: Bool) async {
        let before = viewed[path]
        viewed[path] = isViewed ? .viewed : .unviewed
        if !(await write(.markViewed(pr, path: path, viewed: isViewed))) { viewed[path] = before }
    }

    /// Turns "Since my last review" on or off, and reloads the diff.
    public func setSinceLastReview(_ on: Bool) async {
        guard on != sinceLastReview, !on || canShowSinceLastReview else { return }
        sinceLastReview = on
        await loadDiff()
    }

    private func write(_ request: AppRequest) async -> Bool {
        do {
            switch try await model.server.request(request, timeout: .seconds(60)) {
            case let .reviewDrafts(m): apply(m)
            case let .reviewThreads(m): apply(m)
            default: break
            }
            writeError = nil
            return true
        } catch let error as RequestError {
            writeError = ServerError(code: error.code, message: error.message, fixSteps: error.fixSteps)
        } catch {
            writeError = ServerError(code: .badRequest, message: "\(error)")
        }
        return false
    }

    func apply(_ m: ReviewDraftsMessage) {
        drafts = m.comments
        reviewSummary = m.summary
        reviewEvent = m.event
    }

    func apply(_ m: ReviewThreadsMessage) {
        assignedToMe = m.assignedToMe ?? assignedToMe
        ghThreads = m.threads
        viewed = m.viewed
        lastReview = m.lastReview
        reviewViewer = m.viewer
    }

    /// For previews and snapshots.
    public func previewReview(drafts: [DraftComment] = [], threads: [ReviewThread] = [], viewed: [String: ViewedState] = [:], lastReview: LastReview? = nil, viewer: String? = nil) {
        self.drafts = drafts
        ghThreads = threads
        self.viewed = viewed
        self.lastReview = lastReview
        reviewViewer = viewer
    }
}

// MARK: - Agent help (R3): "Turn into comment" and the gap check

/// A comment the agent drafted, for the diff's editor. Nothing is in the review until "Add to review".
public struct EditorRequest: Hashable, Sendable {
    public var id = UUID().uuidString
    public var anchor: CommentAnchor
    public var body: String
    /// The chat turn it came from, for Redraft.
    public var turnId: String
    public var redrafting = false
}

public enum GapCheckState: Equatable, Sendable {
    case idle
    case running(started: Date, activity: [String])
    case done(GapCheckMessage)
    case failed(ServerError)
}

extension PRStore {
    /// The anchor a chat turn's selection maps to, if it was about lines.
    public static func anchor(for turn: ChatTurn) -> CommentAnchor? {
        guard let s = turn.selections.first, let path = s.path, let start = s.startLine else { return nil }
        let end = max(s.endLine ?? start, start)
        return CommentAnchor(path: path, side: s.side == .old ? .left : .right, line: end, startLine: start < end ? start : nil)
    }

    /// "Turn into comment" can run: writes are on, the turn was about lines and has an answer.
    public func canTurnIntoComment(_ turn: ChatTurn) -> Bool {
        canWrite && turn.status == .done && !turn.answer.isEmpty && Self.anchor(for: turn) != nil
    }

    /// Asks the chat's agent to rewrite the answer as my review comment, then opens it in the diff's editor.
    public func turnIntoComment(_ turn: ChatTurn) async {
        guard let anchor = Self.anchor(for: turn), draftingTurn == nil else { return }
        draftingTurn = turn.id
        defer { draftingTurn = nil }
        guard let body = await draft(turn, anchor: anchor) else { return }
        editorRequest = EditorRequest(anchor: anchor, body: body, turnId: turn.id)
        placedDrafts[turn.id] = anchor.startLine.map { "lines \($0)–\(anchor.line)" } ?? "line \(anchor.line)"
    }

    /// The editor's Redraft: the same answer, drafted again.
    public func redraft() async {
        guard var request = editorRequest, let turn = turns.first(where: { $0.id == request.turnId }) else { return }
        request.redrafting = true
        request.id = UUID().uuidString
        editorRequest = request
        let body = await draft(turn, anchor: request.anchor)
        request.redrafting = false
        request.id = UUID().uuidString
        if let body { request.body = body }
        editorRequest = request
    }

    private func draft(_ turn: ChatTurn, anchor: CommentAnchor) async -> String? {
        let head = review.flatMap { $0.headSha.isEmpty ? nil : $0.headSha } ?? turn.headSha
        let agent = effectiveAgent ?? turn.agent
        let modelName = askAgent == nil || askAgent == agent ? askModel : ""
        do {
            let lines = turn.selections.first?.text
            if case let .draftComment(m) = try await model_server.request(
                .draftComment(pr, agent: agent, model: modelName, headSha: head, anchor: anchor, lines: lines, question: turn.question, answer: turn.answer),
                timeout: .seconds(150)
            ) {
                writeError = nil
                return m.body
            }
        } catch let error as RequestError {
            writeError = ServerError(code: error.code, message: error.message, fixSteps: error.fixSteps)
        } catch {
            writeError = ServerError(code: .agentFailed, message: "\(error)")
        }
        return nil
    }

    private var model_server: ServerConnection { model.server }

    // Gap check

    public var gapCheckRunning: Bool { if case .running = gapCheck { true } else { false } }

    /// Reads the diff and my pending comments; drafts comments for what they miss.
    public func runGapCheck() {
        guard !gapCheckRunning, let head = review.flatMap({ $0.headSha.isEmpty ? nil : $0.headSha }), let agent = effectiveAgent else { return }
        let modelName = askModel
        gapKept = [:]
        gapDismissed = []
        gapCheck = .running(started: .now, activity: [])
        gapTask = Task { [weak self] in
            guard let self else { return }
            do {
                for try await message in model_server.stream(.gapCheck(pr, agent: agent, model: modelName, headSha: head), keepAlive: false) {
                    switch message {
                    case let .event(e):
                        switch e.event {
                        case let .tool(summary):
                            if case let .running(started, activity) = gapCheck { gapCheck = .running(started: started, activity: Array((activity + [summary]).suffix(3))) }
                        case let .error(err):
                            if err.code != .cancelled { gapCheck = .failed(ServerError(code: err.code, message: err.message, fixSteps: err.fixSteps)) }
                            return
                        default: break
                        }
                    case let .gapCheck(m):
                        gapCheck = .done(m)
                        return
                    default: break
                    }
                }
            } catch {
                if !Task.isCancelled { gapCheck = .failed(ServerError(code: .agentFailed, message: "\(error)")) }
            }
        }
    }

    public func cancelGapCheck() {
        gapTask?.cancel()
        gapTask = nil
        gapCheck = .idle
    }

    /// Keep: the finding joins the review as a pending comment (tagged "From gap check").
    public func keepFinding(_ f: GapFinding, body: String? = nil) async {
        guard let head = diff?.headSha else { return }
        let text = body ?? f.body
        let before = Set(drafts.map(\.id))
        guard await saveDraft(DraftInput(headSha: head, anchor: CommentAnchor(path: f.path, side: .right, line: f.line), body: text, origin: .gapCheck)) else { return }
        if let id = drafts.first(where: { !before.contains($0.id) })?.id { gapKept[f.id] = id }
    }

    public func undoKeep(_ f: GapFinding) async {
        guard let id = gapKept[f.id] else { return }
        if await deleteDraft(id) { gapKept[f.id] = nil }
    }

    public func dismissFinding(_ f: GapFinding) { gapDismissed.insert(f.id) }
}

// MARK: - Submitting (R4)

public enum SubmitState: Equatable, Sendable {
    case idle
    case sending
    case sent(ReviewSubmittedMessage)
    case failed(ServerError)
}

/// A pending comment whose lines changed after new commits.
public struct OutdatedDraft: Equatable, Sendable {
    /// The lines it was written on, and what the same line numbers hold now.
    public var old: [String]
    public var now: [String]
    /// The commit the lines changed in (short).
    public var changedIn: String
}

extension PRStore {
    func markAssigned() { assignedToMe = true }

    /// The commit the review goes out on: the diff on screen (the reviewed commit).
    public var reviewHeadSha: String? { diff?.headSha }

    /// Me on GitHub: "Posts to GitHub as you · sam".
    public var viewerLogin: String? { reviewViewer ?? model.hello?.viewer }

    /// Pending comments on lines (not replies), in order, for the submit sheet's list.
    public var pendingComments: [DraftComment] { drafts.filter { $0.anchor != nil } }
    public var pendingReplies: [DraftComment] { drafts.filter { $0.replyTo != nil } }

    /// Keeps the sheet's summary and outcome on this Mac while it's written.
    public func saveSummary(_ text: String, event: ReviewEvent?) async {
        reviewSummary = text
        reviewEvent = event
        _ = try? await model.server.request(.saveReviewSummary(pr, summary: text, event: event))
    }

    /// Posts every pending comment and reply, with the summary, as one review.
    public func submit(event: ReviewEvent, summary: String) async {
        guard let head = reviewHeadSha, submitState != .sending else { return }
        if !outdated.isEmpty {
            submitState = .failed(ServerError(code: .badRequest, message: "\(outdated.count) pending comment\(outdated.count == 1 ? " is" : "s are") on lines that changed. Move or delete \(outdated.count == 1 ? "it" : "them") first."))
            return
        }
        submitState = .sending
        do {
            if case let .reviewSubmitted(m) = try await model.server.request(.submitReview(pr, headSha: head, event: event, summary: summary), timeout: .seconds(180)) {
                submitState = .sent(m)
                showSubmitSheet = false
                drafts = []
                reviewSummary = ""
                reviewEvent = nil
                gapCheck = .idle
                gapKept = [:]
                Task { await loadGitHubThreads() }
            }
        } catch let error as RequestError {
            submitState = .failed(ServerError(code: error.code, message: error.message, fixSteps: error.fixSteps))
        } catch {
            submitState = .failed(ServerError(code: .badRequest, message: "\(error)"))
        }
    }

    public func dismissSubmitResult() { submitState = .idle }

    /// The review as Markdown, for "Copy review as Markdown" when sending failed.
    public func reviewMarkdown(event: ReviewEvent?, summary: String) -> String {
        var out: [String] = []
        if let event { out.append("**\(event == .approve ? "Approve" : event == .requestChanges ? "Request changes" : "Comment")**") }
        if !summary.isEmpty { out.append(summary) }
        for d in pendingComments {
            guard let a = d.anchor else { continue }
            out.append("**\(a.path):\(a.range)**\n\(d.body)")
        }
        for d in pendingReplies { out.append("**Reply**\n\(d.body)") }
        return out.joined(separator: "\n\n")
    }

    // Outdated comments

    /// After new commits: comments whose lines are unchanged follow them; the rest are flagged outdated.
    func reconcileDrafts() async {
        guard canWrite, !reconciling, let diff, diff.since == nil else { return }
        let stale = drafts.filter { $0.anchor != nil && $0.headSha != diff.headSha }
        guard !stale.isEmpty else {
            outdated = [:]
            return
        }
        reconciling = true
        defer { reconciling = false }
        var flagged: [String: OutdatedDraft] = [:]
        for (sha, group) in Dictionary(grouping: stale, by: \.headSha) {
            var oldFiles: [String: String] = [:]
            if case let .prDiff(old)? = try? await model.server.request(.prDiff(pr, headSha: sha), timeout: .seconds(120)) {
                for f in old.files { oldFiles[f.path] = f.patch ?? "" }
            }
            for d in group {
                guard let anchor = d.anchor else { continue }
                let newPatch = diff.files.first { $0.path == anchor.path }?.patch
                switch DraftRemap.remap(anchor, oldPatch: oldFiles[anchor.path] ?? "", newPatch: newPatch) {
                case let .moved(to):
                    await saveDraft(DraftInput(id: d.id, headSha: diff.headSha, anchor: to, body: d.body, origin: d.origin))
                case let .outdated(old, now):
                    flagged[d.id] = OutdatedDraft(old: old, now: now, changedIn: String(diff.headSha.prefix(7)))
                }
            }
        }
        outdated = flagged
    }

    /// "Move to new line": the comment stays on the same line numbers, now on the new commit.
    public func moveOutdated(_ id: String) async {
        guard let d = drafts.first(where: { $0.id == id }), let anchor = d.anchor, let head = diff?.headSha else { return }
        if await saveDraft(DraftInput(id: id, headSha: head, anchor: anchor, body: d.body, origin: d.origin)) { outdated[id] = nil }
    }

    public func deleteOutdated(_ id: String) async {
        if await deleteDraft(id) { outdated[id] = nil }
    }

    /// For previews and snapshots.
    public func previewSubmit(_ state: SubmitState, outdated: [String: OutdatedDraft] = [:], summary: String = "", event: ReviewEvent? = nil) {
        submitState = state
        self.outdated = outdated
        reviewSummary = summary
        reviewEvent = event
    }
}
