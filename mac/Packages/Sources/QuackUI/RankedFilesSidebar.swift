import QuackProtocol
import QuackStores
import SwiftUI

/// The PR tab's sidebar: files ranked by risk, with the review phase's states inline.
public struct RankedFilesSidebar: View {
    @Bindable var store: PRStore
    var model: AppModel
    /// Bumped by the window (⌘F) to focus the filter field.
    var focusRequest: Int
    @State private var filter = ""
    @FocusState private var filterFocused: Bool

    public init(store: PRStore, model: AppModel, focusRequest: Int = 0) {
        self.store = store
        self.model = model
        self.focusRequest = focusRequest
    }

    // MARK: Rows

    struct Row: Identifiable, Hashable {
        var file: PrDiffFile
        var risk: FileRisk?
        var id: String { file.path }
        var name: String { (file.path as NSString).lastPathComponent }
        var folder: String {
            let dir = (file.path as NSString).deletingLastPathComponent
            return dir.isEmpty ? "/" : dir + "/"
        }
    }

    struct Group: Identifiable {
        var risk: FileRisk.Risk?
        var rows: [Row]
        var id: String { risk?.rawValue ?? "flat" }
    }

    private enum Mode { case ranked, flat }

    private var labels: RiskLabelsMessage? { store.labels }
    private var review: ReviewState? { store.review }

    private var labellerText: String {
        guard let labels else { return labelsAgentLabel }
        return labels.model.isEmpty ? labelsAgentLabel : "\(labelsAgentLabel) · \(labels.model)"
    }

    private var labelsAgentLabel: String {
        let id = labels?.agent ?? store.effectiveAgent
        return model.agents.first { $0.id == id }?.label ?? (id == .claudeCode ? "Claude Code" : "Cursor")
    }

    private var labelsRunning: Bool {
        labels?.status == .running || (labels == nil && review?.labels == .running && review?.phase != .failed)
    }
    private var labelsFailed: Bool { labels?.status == .failed || (labels == nil && review?.labels == .failed) }
    /// Same rule as the diff (PRStore.visibleLabels): labels show while reviewing, or when cached for this exact commit.
    private var hasRanking: Bool { store.visibleLabels != nil && review?.phase != .failed }
    private var mode: Mode { hasRanking && !labelsFailed ? .ranked : .flat }
    private var dimmed: Bool { mode == .ranked && !store.labelsAreCurrent && (labels?.previousHeadSha != nil || review?.phase == .stale) }

    private var groups: [Group] {
        let query = filter.trimmingCharacters(in: .whitespaces)
        func keep(_ row: Row) -> Bool { query.isEmpty || row.file.path.localizedCaseInsensitiveContains(query) }
        switch mode {
        case .ranked:
            return store.sections.compactMap { section in
                let rows = section.files.map { Row(file: $0.file, risk: $0.risk) }.filter(keep)
                return rows.isEmpty ? nil : Group(risk: section.risk, rows: rows)
            }
        case .flat:
            let rows = (store.diff?.files ?? []).map { Row(file: $0, risk: nil) }.filter(keep)
            return rows.isEmpty ? [] : [Group(risk: nil, rows: rows)]
        }
    }

    private var visibleIDs: [String] { groups.flatMap { $0.rows.map(\.id) } }

    // MARK: Body

    public var body: some View {
        VStack(spacing: 0) {
            header
            stateArea
            if groups.isEmpty {
                emptyList
            } else {
                list
            }
        }
        .searchable(text: $filter, placement: .sidebar, prompt: "Filter files")
        .searchFocused($filterFocused)
        .onChange(of: focusRequest) { filterFocused = true }
        .frame(minWidth: 240)
        .onChange(of: labelsRunning) { _, running in
            // Polite, factual announcement; the thinking line itself stays hidden from VoiceOver.
            AccessibilityNotification.Announcement(running ? "Ranking files by risk" : "Files ranked").post()
        }
    }

    private var list: some View {
        List(selection: $store.selectedFile) {
            ForEach(groups) { group in
                if let risk = group.risk {
                    Section {
                        rows(group)
                    } header: {
                        HStack(spacing: 5) {
                            Text(Self.title(risk))
                            Text("\(group.rows.count)").monospacedDigit().foregroundStyle(.secondary)
                        }
                        .accessibilityElement(children: .combine)
                    }
                } else {
                    rows(group)
                }
            }
        }
        .listStyle(.sidebar)
        .onKeyPress("j") { move(1) }
        .onKeyPress("k") { move(-1) }
    }

    private func rows(_ group: Group) -> some View {
        ForEach(group.rows) { row in
            FileRow(row: row, loading: labelsRunning && mode == .flat, labeller: labellerText)
                .opacity(dimmed ? 0.55 : 1)
                .tag(row.id)
        }
    }

    private var emptyList: some View {
        VStack {
            if store.diff == nil {
                VStack(alignment: .leading, spacing: 8) {
                    ForEach(0..<5, id: \.self) { _ in SkeletonBar() }
                }
                .padding(16)
                .frame(maxWidth: .infinity, alignment: .leading)
            } else {
                Text(filter.isEmpty ? "No files changed." : "No files match.")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .padding(16)
            }
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func move(_ delta: Int) -> KeyPress.Result {
        let ids = visibleIDs
        guard !ids.isEmpty else { return .ignored }
        if let current = store.selectedFile, let index = ids.firstIndex(of: current) {
            store.selectedFile = ids[min(max(index + delta, 0), ids.count - 1)]
        } else {
            store.selectedFile = delta > 0 ? ids.first : ids.last
        }
        return .handled
    }

    static func title(_ risk: FileRisk.Risk) -> String {
        switch risk {
        case .high: "High"
        case .medium: "Medium"
        case .low: "Low"
        case .unlabeled: "Unlabeled"
        }
    }

    // MARK: Header

    private var header: some View {
        let totals = store.totals
        return VStack(alignment: .leading, spacing: 3) {
            HStack(alignment: .firstTextBaseline) {
                HStack(spacing: 5) {
                    Text("Files").font(.headline)
                    Text("\(totals.files)").font(.headline).monospacedDigit().foregroundStyle(.secondary)
                }
                Spacer(minLength: 8)
                LineCounts(totals.additions, totals.deletions)
                    .font(.system(size: 11, design: .monospaced))
            }
            if let line = rankedByLine {
                Text(line)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.tail)
            }
        }
        .padding(.horizontal, 14)
        .padding(.top, 8)
        .padding(.bottom, 8)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var rankedByLine: String? {
        // Only for labels the list actually shows (the same rule as the diff).
        guard let labels = store.visibleLabels else { return nil }
        let agent = model.agents.first { $0.id == labels.agent }?.label ?? (labels.agent == .cursor ? "Cursor" : "Claude Code")
        let modelName = labels.model.isEmpty ? "Default" : labels.model
        let sha = String(labels.headSha.prefix(7))
        return "Ranked by \(agent) · \(modelName) at \(sha)"
    }

    // MARK: States

    @ViewBuilder private var stateArea: some View {
        VStack(alignment: .leading, spacing: 10) {
            if review == nil {
                startCard
            } else if let review {
                switch review.phase {
                case .preparing:
                    PreparingChecklist(step: review.step)
                case .failed:
                    note("No labels without a worktree", symbol: "info.circle")
                case .ready, .stale:
                    labelStates(review)
                }
            }
        }
        .padding(.horizontal, 12)
        .padding(.bottom, stateAreaIsEmpty ? 0 : 8)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var stateAreaIsEmpty: Bool {
        guard let review else { return false }
        switch review.phase {
        case .preparing, .failed: return false
        case .ready, .stale: return !(labelsRunning || labelsFailed || dimmed)
        }
    }

    @ViewBuilder private func labelStates(_ review: ReviewState) -> some View {
        if labelsFailed {
            Banner(.error, title: "Couldn’t rank these files.", message: labels?.error ?? review.error) {
                Button("Retry labels") { Task { await store.rerunLabels() } }
            }
        } else if labelsRunning {
            LabelingProgress(labels: labels, agentLabel: labelsAgentLabel, fileCount: store.totals.files)
            if dimmed { staleNote }
        } else if dimmed {
            staleNote
        }
    }

    @ViewBuilder private var staleNote: some View {
        let sha = String((labels?.previousHeadSha ?? labels?.headSha ?? "").prefix(7))
        note("Labels are for \(sha)", symbol: "clock.arrow.circlepath")
    }

    private func note(_ text: String, symbol: String) -> some View {
        Label {
            Text(text)
        } icon: {
            Image(systemName: symbol)
        }
        .font(.caption)
        .foregroundStyle(.secondary)
    }

    private var startCard: some View {
        VStack(alignment: .leading, spacing: 8) {
            // Labels cached from an earlier review of this commit already rank the list below.
            Text(hasRanking ? "Ranked in an earlier review" : "Rank these files by risk").font(QuackFont.headline(14))
            Text(hasRanking
                ? "These labels are for this commit. Start reviewing to ask about it and re-rank when new commits land."
                : "Quack prepares a scratch copy of this PR and asks an agent which files need your eyes first.")
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            Button("Start reviewing") { Task { await store.startReview() } }
                .buttonStyle(QuackPrimaryStyle())
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Tokens.cream, in: RoundedRectangle(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Tokens.beak.opacity(0.35)))
    }
}

// MARK: - Pieces

/// While labels run: what's happening, for how long, and what the agent last did. The headline rotates
/// (design spec, "Labeling risk"); VoiceOver hears only the factual lines.
private struct LabelingProgress: View {
    var labels: RiskLabelsMessage?
    var agentLabel: String
    var fileCount: Int
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private static let headlines = ["Sorting the ducks by danger…", "Lockfiles get a pass. Migrations do not.", "Reading callers before judging."]

    private var title: String {
        if labels?.queued == true { return "Two label jobs are running. Yours is next." }
        let n = labels?.progress?.agentFiles ?? 0
        if n > 0 { return "Ranking \(n) of \(fileCount) files with \(agentLabel)" }
        return "Ranking \(fileCount) files with \(agentLabel)"
    }

    var body: some View {
        TimelineView(.periodic(from: .now, by: 1)) { context in
            let started = labels?.progress.flatMap { ISODate.parse($0.startedAt) }
            let elapsed = started.map { max(0, context.date.timeIntervalSince($0)) }
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 6) {
                    if reduceMotion { Text("…") } else { ProgressView().controlSize(.small) }
                    Text(title).font(.system(size: 12, weight: .medium)).lineLimit(2)
                    Spacer(minLength: 4)
                    if let elapsed, labels?.queued != true {
                        Text(verbatim: String(format: "%d:%02d", Int(elapsed) / 60, Int(elapsed) % 60))
                            .font(.system(size: 11)).monospacedDigit().foregroundStyle(.secondary)
                    }
                }
                .accessibilityElement(children: .combine)
                if labels?.queued != true {
                    let index = Int((elapsed ?? 0) / 3.5) % Self.headlines.count
                    Text(Self.headlines[index])
                        .font(QuackFont.headline(13))
                        .foregroundStyle(.secondary)
                        .accessibilityHidden(true)
                    ForEach(Array((labels?.progress?.activity ?? []).enumerated()), id: \.offset) { _, line in
                        Text(line).font(.system(size: 11)).foregroundStyle(.secondary).lineLimit(1).truncationMode(.middle)
                    }
                }
            }
            .padding(10)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Tokens.fill, in: RoundedRectangle(cornerRadius: 10))
        }
        .onChange(of: labels?.progress?.activity.last) { _, line in
            if let line { AccessibilityNotification.Announcement(line).post() }
        }
    }
}

private struct ThinkingLine: View {
    var text: String
    var body: some View {
        Text(text)
            .font(QuackFont.headline(14))
            .foregroundStyle(.secondary)
            .accessibilityHidden(true)
    }
}

private struct PreparingChecklist: View {
    var step: ReviewStep?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    private static let steps: [(ReviewStep, String)] = [
        (.findingClone, "Clone found"),
        (.fetching, "Fetched"),
        (.checkingOut, "Checking out"),
        (.labeling, "Labelling"),
    ]

    var body: some View {
        let index = Self.steps.firstIndex { $0.0 == step } ?? 0
        VStack(alignment: .leading, spacing: 8) {
            Text("Getting it ready…").font(QuackFont.headline(14))
            VStack(alignment: .leading, spacing: 5) {
                ForEach(Array(Self.steps.enumerated()), id: \.offset) { i, item in
                    HStack(spacing: 8) {
                        if i < index {
                            Image(systemName: "checkmark.circle.fill").foregroundStyle(Tokens.success)
                        } else if i == index {
                            if reduceMotion {
                                Text("…").frame(minWidth: 12)
                            } else {
                                ProgressView().controlSize(.mini)
                            }
                        } else {
                            Image(systemName: "circle.dashed").foregroundStyle(.secondary)
                        }
                        Text(item.1).foregroundStyle(i > index ? .secondary : .primary)
                    }
                    .font(.system(size: 12))
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel(item.1)
                    .accessibilityValue(i < index ? "Done" : i == index ? "In progress" : "Waiting")
                }
            }
        }
    }
}

private struct FileRow: View {
    var row: RankedFilesSidebar.Row
    var loading: Bool
    /// "Cursor · auto": who ranked the list, for the tooltip.
    var labeller: String = "the agent"

    private var displayName: String {
        if let old = row.file.oldPath, old != row.file.path {
            let oldName = (old as NSString).lastPathComponent
            return "{\(oldName) → \(row.name)}"
        }
        return row.name
    }

    private var isRule: Bool { row.risk?.source == .rule }

    private var spokenValue: String {
        var parts: [String] = []
        if let reason = row.risk?.reason, !reason.isEmpty {
            parts.append(reason.last.map { ".!?".contains($0) } == true ? reason : reason + ".")
        }
        parts.append("\(row.file.additions) added, \(row.file.deletions) removed.")
        if isRule { parts.append("Labelled by rule.") }
        return parts.joined(separator: " ")
    }

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            RiskBars(row.risk?.risk).padding(.top, 3)
            VStack(alignment: .leading, spacing: 3) {
                // Name and folder share a line when they fit: the folder drops whole folders from the front
                // ("src/travel-book/map/" → "…/travel-book/map/" → "…/map/"). When even the shortest form doesn't
                // fit beside the name, the folder gets its own small line, so same-named files stay apart.
                ViewThatFits(in: .horizontal) {
                    ForEach(folderForms, id: \.self) { form in
                        HStack(alignment: .firstTextBaseline, spacing: 6) {
                            nameText.fixedSize()
                            folderText(form)
                            Spacer(minLength: 4)
                            counts
                        }
                    }
                    VStack(alignment: .leading, spacing: 1) {
                        HStack(alignment: .firstTextBaseline, spacing: 6) {
                            nameText
                            Spacer(minLength: 4)
                            counts
                        }
                        if let full = folderForms.first {
                            folderText(full).truncationMode(.head)
                        }
                    }
                }
                // The reason is the point of the ranking: its own line, readable, set apart from the path.
                if let reason = row.risk?.reason, !reason.isEmpty {
                    HStack(alignment: .firstTextBaseline, spacing: 5) {
                        Text(reason)
                            .font(.system(size: 12))
                            .foregroundStyle(.secondary)
                            .lineLimit(2)
                            .fixedSize(horizontal: false, vertical: true)
                        if isRule { RuleTag() }
                    }
                    .padding(.top, 1)
                }
            }
        }
        .padding(.vertical, 3)
        .help(tooltip)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(row.name), \(riskWord)")
        .accessibilityValue(spokenValue)
    }

    private var nameText: some View {
        Text(displayName)
            .fontWeight(.medium)
            .lineLimit(1)
            .truncationMode(.middle)
    }

    private var counts: some View {
        LineCounts(row.file.additions, row.file.deletions)
            .font(.system(size: 11, design: .monospaced))
            .fixedSize()
    }

    private func folderText(_ text: String) -> some View {
        Text(text)
            .font(.system(size: 10.5, design: .monospaced))
            .foregroundStyle(.tertiary)
            .lineLimit(1)
    }

    /// "src/travel-book/map/", "…/travel-book/map/", "…/map/": each a little shorter, whole folders only.
    private var folderForms: [String] {
        let parts = row.folder.split(separator: "/").map(String.init)
        guard !parts.isEmpty else { return [] }
        return (0..<parts.count).map { drop in
            let kept = parts[drop...].joined(separator: "/") + "/"
            return drop == 0 ? kept : "…/" + kept
        }
    }

    /// Hover: the full path, the whole reason, and who labelled it.
    private var tooltip: String {
        var lines = [row.file.oldPath.map { "\($0) → \(row.file.path)" } ?? row.file.path]
        if let reason = row.risk?.reason, !reason.isEmpty { lines.append(reason) }
        if row.risk != nil { lines.append(isRule ? "Labelled by a rule" : "Labelled by \(labeller)") }
        return lines.joined(separator: "\n")
    }

    private var riskWord: String {
        switch row.risk?.risk {
        case .high: "high risk"
        case .medium: "medium risk"
        case .low: "low risk"
        case .unlabeled, nil: "not ranked"
        }
    }
}

// MARK: - Preview data

enum PRPartsSamples {
    static func decode<T: Decodable>(_ json: String) -> T {
        try! JSONDecoder().decode(T.self, from: Data(json.utf8))
    }

    static let pr = PrKey(owner: "acme", repo: "trailmap", number: 4127)
    static let sha = "a41c9e2d7f0b3c8e5a6d1f2b4c9e7a0d3b5f8c21"
    static let newSha = "9c41f07be2a4d6c8f0a1b3d5e7f9a2c4b6d8e0f1"
    @MainActor static var model: AppModel { AppModel(preview: nil, connection: .disconnected(reason: "preview")) }

    static func review(_ phase: String, step: String? = nil, labels: String = "ready", error: String? = nil) -> ReviewState {
        let stepJSON = step.map { #","step":"\#($0)""# } ?? ""
        let errorJSON = error.map { #","error":"\#($0)","fixSteps":[{"text":"Link the clone in Settings.","command":"quacksteps link acme/trailmap"}]"# } ?? ""
        return decode(#"{"startedAt":"2026-11-18T09:00:00Z","headSha":"\#(sha)","latestHeadSha":"\#(phase == "stale" ? newSha : sha)","worktreePath":"/tmp/quack/trailmap-4127","phase":"\#(phase)","labels":"\#(labels)"\#(stepJSON)\#(errorJSON)}"#)
    }

    static let diff: PrDiffMessage = decode(#"""
    {"requestId":"d1","pr":{"owner":"acme","repo":"trailmap","number":4127},"baseSha":"1111111","headSha":"\#(sha)","files":[
    {"path":"src/map/clusterPins.ts","status":"modified","additions":188,"deletions":12,"binary":false,"truncated":false},
    {"path":"src/map/tiles/cache.ts","oldPath":"src/map/tileCache.ts","status":"renamed","additions":40,"deletions":9,"binary":false,"truncated":false},
    {"path":"src/export/gpx.ts","status":"modified","additions":64,"deletions":31,"binary":false,"truncated":false},
    {"path":"package-lock.json","status":"modified","additions":412,"deletions":388,"binary":false,"truncated":false},
    {"path":"README.md","status":"modified","additions":3,"deletions":1,"binary":false,"truncated":false}]}
    """#)

    static func labels(status: String = "ready", previous: String? = nil, queued: Bool = false, error: String? = nil, withFiles: Bool = true) -> RiskLabelsMessage {
        let files = withFiles ? #"""
        [{"path":"src/map/clusterPins.ts","risk":"high","reason":"Clustering now runs on every pan.","rank":1,"source":"agent"},
        {"path":"src/export/gpx.ts","risk":"medium","reason":"Streams instead of buffering, so a failure leaves a half-written file.","rank":2,"source":"agent"},
        {"path":"src/map/tiles/cache.ts","risk":"low","reason":"Moved only.","rank":3,"source":"agent"},
        {"path":"package-lock.json","risk":"low","reason":"Lockfile, generated.","rank":4,"source":"rule"}]
        """# : "[]"
        let previousJSON = previous.map { #","previousHeadSha":"\#($0)""# } ?? ""
        let errorJSON = error.map { #","error":"\#($0)""# } ?? ""
        return decode(#"{"requestId":"l1","pr":{"owner":"acme","repo":"trailmap","number":4127},"headSha":"\#(previous == nil ? sha : newSha)","status":"\#(status)","agent":"claude-code","model":"Sonnet 4.5","files":\#(files),"queued":\#(queued)\#(previousJSON)\#(errorJSON)}"#)
    }
}

@MainActor private func previewSidebar(review: ReviewState?, labels: RiskLabelsMessage?) -> some View {
    let model = PRPartsSamples.model
    let store = PRStore(preview: PRPartsSamples.pr, model: model, review: review, labels: labels, diff: PRPartsSamples.diff)
    return RankedFilesSidebar(store: store, model: model).frame(width: 300, height: 560)
}

#Preview("Ready, ranked") { previewSidebar(review: PRPartsSamples.review("ready"), labels: PRPartsSamples.labels()) }
#Preview("Not started") { previewSidebar(review: nil, labels: nil) }
#Preview("Preparing") { previewSidebar(review: PRPartsSamples.review("preparing", step: "fetching", labels: "none"), labels: nil) }
#Preview("Labels running") { previewSidebar(review: PRPartsSamples.review("ready", labels: "running"), labels: PRPartsSamples.labels(status: "running", withFiles: false)) }
#Preview("Labels queued") { previewSidebar(review: PRPartsSamples.review("ready", labels: "running"), labels: PRPartsSamples.labels(status: "running", queued: true, withFiles: false)) }
#Preview("Labels stale") { previewSidebar(review: PRPartsSamples.review("stale"), labels: PRPartsSamples.labels(previous: PRPartsSamples.sha)) }
#Preview("Labels failed") { previewSidebar(review: PRPartsSamples.review("ready", labels: "failed"), labels: PRPartsSamples.labels(status: "failed", error: "The agent returned something that wasn’t JSON, twice.", withFiles: false)) }
#Preview("Review failed") { previewSidebar(review: PRPartsSamples.review("failed", labels: "none", error: "No clone found."), labels: nil) }
