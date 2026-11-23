import QuackProtocol
import QuackStores
import SwiftUI

/// The "Check for gaps" section of the Submit review sheet: idle, running, findings to keep or dismiss, failed.
public struct GapCheckView: View {
    var store: PRStore
    var previewState: GapCheckState?
    var previewKept: [String: String]

    @State private var editing: String?
    @State private var editText = ""

    public init(store: PRStore) {
        self.store = store
        self.previewState = nil
        self.previewKept = [:]
    }

    /// Renders from a fixed state (snapshots); the buttons still call the store.
    public init(store: PRStore, previewState: GapCheckState?, previewKept: [String: String] = [:]) {
        self.store = store
        self.previewState = previewState
        self.previewKept = previewKept
    }

    private var state: GapCheckState { previewState ?? store.gapCheck }
    private var kept: [String: String] { previewState != nil ? previewKept : store.gapKept }
    private var dismissed: Set<String> { previewState != nil ? [] : store.gapDismissed }

    public var body: some View {
        switch state {
        case .idle: idle
        case let .running(started, activity): running(started: started, activity: activity)
        case let .done(message): done(message)
        case let .failed(error): failed(error)
        }
    }

    private var box: RoundedRectangle { RoundedRectangle(cornerRadius: 10) }

    // MARK: Idle

    private var idle: some View {
        HStack(alignment: .center, spacing: 12) {
            VStack(alignment: .leading, spacing: 3) {
                Text("Check for gaps").font(.system(size: 13, weight: .bold)).accessibilityAddTraits(.isHeader)
                Text("Optional. Quack reads the diff and your comments and looks for bugs, missing tests or edge cases you didn’t mention. About a minute.")
                    .font(.system(size: 12)).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            Button("Check") { store.runGapCheck() }.controlSize(.small)
        }
        .padding(12)
        .overlay(box.strokeBorder(Color(nsColor: .separatorColor), lineWidth: 1))
    }

    // MARK: Running

    private func running(started: Date, activity: [String]) -> some View {
        HStack(alignment: .center, spacing: 10) {
            ProgressView().controlSize(.small)
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    Text("Checking for gaps…").font(.system(size: 13, weight: .bold)).accessibilityAddTraits(.isHeader)
                    TimelineView(.periodic(from: started, by: 1)) { context in
                        Text(Self.elapsed(context.date.timeIntervalSince(started)))
                            .font(.system(size: 12).monospacedDigit()).foregroundStyle(.secondary)
                    }
                }
                if let last = activity.last {
                    Text(last).font(.system(size: 11)).foregroundStyle(.secondary).lineLimit(1).truncationMode(.tail)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            Button("Stop") { store.cancelGapCheck() }.controlSize(.small)
        }
        .padding(12)
        .overlay(box.strokeBorder(Color(nsColor: .separatorColor), lineWidth: 1))
        .accessibilityElement(children: .contain)
    }

    static func elapsed(_ seconds: TimeInterval) -> String {
        let s = max(0, Int(seconds))
        return "\(s / 60):" + String(format: "%02d", s % 60)
    }

    static func duration(ms: Int) -> String {
        let s = Int((Double(ms) / 1000).rounded())
        return s >= 60 ? "\(s / 60) min \(s % 60) s" : "\(s) s"
    }

    static func agentLabel(_ id: AgentId) -> String {
        switch id {
        case .cursor: "Cursor"
        case .claudeCode: "Claude Code"
        }
    }

    // MARK: Done

    private func done(_ m: GapCheckMessage) -> some View {
        let shown = m.findings.filter { !dismissed.contains($0.id) }
        let meta = ([Self.agentLabel(m.agent)] + (m.model.isEmpty ? [] : [m.model]) + [Self.duration(ms: m.ms)]).joined(separator: " · ")
        return VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text("From gap check").font(.system(size: 13, weight: .bold)).accessibilityAddTraits(.isHeader)
                Text(m.findings.isEmpty ? "Nothing stood out" : "Quack found \(m.findings.count) \(m.findings.count == 1 ? "thing" : "things") your comments don’t cover")
                    .font(.system(size: 12)).foregroundStyle(.secondary)
                Spacer(minLength: 8)
                Text(meta).font(.system(size: 11)).foregroundStyle(.secondary)
            }
            ForEach(shown) { finding in card(finding) }
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(footer(m, findings: m.findings.count))
                    .font(.system(size: 11)).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
                Button("Check again") { store.runGapCheck() }.controlSize(.small)
            }
        }
    }

    private func footer(_ m: GapCheckMessage, findings: Int) -> String {
        var text = findings == 0
            ? "Quack checked \(m.checkedFiles) \(m.checkedFiles == 1 ? "file" : "files")."
            : "Nothing else stood out in the \(m.checkedFiles) \(m.checkedFiles == 1 ? "file" : "files") checked."
        if !m.skipped.isEmpty {
            let n = m.skipped.count
            text += " \(n) \(n == 1 ? "file wasn’t" : "files weren’t") checked: generated and lock files."
        }
        return text
    }

    private func card(_ f: GapFinding) -> some View {
        let isKept = kept[f.id] != nil
        let isEditing = editing == f.id
        return VStack(alignment: .leading, spacing: 8) {
            Text("\(f.path):\(f.line)")
                .font(.system(size: 11, design: .monospaced)).foregroundStyle(.secondary)
                .lineLimit(1).truncationMode(.middle)
            if isEditing {
                TextEditor(text: $editText)
                    .font(.system(size: 13))
                    .scrollContentBackground(.hidden)
                    .padding(4)
                    .frame(minHeight: 60)
                    .background(Color(nsColor: .textBackgroundColor), in: RoundedRectangle(cornerRadius: 6))
                    .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(Color(nsColor: .separatorColor)))
                    .accessibilityLabel("Comment text")
            } else {
                Text(f.body).font(.system(size: 13)).textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            HStack(spacing: 8) {
                if isKept {
                    Text("Kept · in your review").font(.system(size: 12)).foregroundStyle(.secondary)
                    Spacer(minLength: 0)
                    Button("Undo") { Task { await store.undoKeep(f) } }.controlSize(.small)
                } else if isEditing {
                    Spacer(minLength: 0)
                    Button("Cancel") { editing = nil }.controlSize(.small)
                    Button("Keep") {
                        let text = editText.trimmingCharacters(in: .whitespacesAndNewlines)
                        editing = nil
                        Task { await store.keepFinding(f, body: text.isEmpty ? nil : text) }
                    }
                    .buttonStyle(.borderedProminent).controlSize(.small)
                } else {
                    Button("Keep") { Task { await store.keepFinding(f, body: nil) } }
                        .buttonStyle(.borderedProminent).controlSize(.small)
                    Button("Edit") { editText = f.body; editing = f.id }.controlSize(.small)
                    Button("Dismiss") { store.dismissFinding(f) }.controlSize(.small)
                    Spacer(minLength: 0)
                }
            }
        }
        .padding(12)
        .background(isKept ? Tokens.cream : Color.clear, in: box)
        .overlay(box.strokeBorder(isKept ? Tokens.medLine : Color(nsColor: .separatorColor), lineWidth: isKept ? 1 : 1))
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Finding in \(f.path) line \(f.line): \(f.body)")
    }

    // MARK: Failed

    private func failed(_ error: ServerError) -> some View {
        Banner(.error, title: "The gap check didn’t finish.", message: error.message) {
            Button("Try again") { store.runGapCheck() }
        }
    }
}
