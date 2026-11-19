import AppKit
import QuackProtocol
import QuackStores
import SwiftUI

/// First run: five checks, fix steps for the ones that fail, then Continue.
public struct FirstRunView: View {
    var model: AppModel
    var onContinue: () -> Void

    public init(model: AppModel, onContinue: @escaping () -> Void) {
        self.model = model
        self.onContinue = onContinue
    }

    private enum RowState { case pass, fail, waiting }

    private struct Row: Identifiable {
        var id: SetupCheck.Kind
        var state: RowState
        var title: String
        var detail: String
        var fixSteps: [FixStep]
    }

    private static let offlineTitles: [(SetupCheck.Kind, String)] = [
        (.gh, "GitHub CLI can see polarsteps"),
        (.git, "git is available"),
        (.agent, "An agent is ready"),
        (.clone, "Found a clone"),
    ]

    private var unreachable: Bool { model.checks == nil && !model.isConnected }

    private var rows: [Row] {
        if let checks = model.checks {
            return checks.map { Row(id: $0.id, state: $0.ok ? .pass : .fail, title: $0.title, detail: $0.detail, fixSteps: $0.fixSteps) }
        }
        if unreachable {
            let server = Row(id: .server, state: .fail, title: "Quack server is running",
                             detail: "Quacksteps can’t reach its server at ~/.quack/run/quack.sock.", fixSteps: [])
            return [server] + Self.offlineTitles.map {
                Row(id: $0.0, state: .waiting, title: $0.1, detail: "Waiting for the server.", fixSteps: [])
            }
        }
        let titles: [(SetupCheck.Kind, String)] = [(.server, "Quack server is running")] + Self.offlineTitles
        return titles.map { Row(id: $0.0, state: .waiting, title: $0.1, detail: "Checking…", fixSteps: []) }
    }

    private static let numberWords = ["Zero", "One", "Two", "Three", "Four", "Five"]

    private var summary: String {
        let rows = rows
        if model.checks == nil, !unreachable { return "Checking…" }
        let passing = rows.filter { $0.state == .pass }.count
        let total = rows.count
        if passing == total { return total == 5 ? "All five pass." : "All pass." }
        let needYou = total - passing
        let word = { (n: Int) in n < Self.numberWords.count ? Self.numberWords[n] : String(n) }
        return "\(word(total)) checks before the first review. \(word(passing)) pass; \(word(needYou).lowercased()) need\(needYou == 1 ? "s" : "") you."
    }

    public var body: some View {
        VStack(spacing: 0) {
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    QuackLogo(height: 24).accessibilityHidden(true).padding(.bottom, 18)
                    Text("Let’s get your ducks in a row.")
                        .font(QuackFont.display)
                        .accessibilityAddTraits(.isHeader)
                    Text(summary)
                        .font(.system(size: 14))
                        .foregroundStyle(.secondary)
                        .padding(.top, 6)
                        .padding(.bottom, 20)
                    VStack(spacing: 0) {
                        let rows = rows
                        ForEach(Array(rows.enumerated()), id: \.element.id) { index, row in
                            if index > 0 { Divider() }
                            rowView(row)
                        }
                    }
                }
                .padding(.horizontal, 40)
                .padding(.vertical, 36)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            footer
        }
        .task(id: model.isConnected) {
            if model.isConnected { await model.runChecks() }
        }
    }

    private func rowView(_ row: Row) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .top, spacing: 12) {
                icon(row.state)
                    .font(.system(size: 18))
                    .frame(width: 22)
                VStack(alignment: .leading, spacing: 2) {
                    Text(row.title).font(.system(size: 14, weight: .medium))
                    Text(row.detail).font(.caption).foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 0)
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("\(row.title), \(row.state == .pass ? "passed" : row.state == .fail ? "needs you" : "waiting")")
            .accessibilityValue(row.detail)
            if row.state == .fail, !row.fixSteps.isEmpty {
                FixStepsView(row.fixSteps).padding(.leading, 34)
            }
        }
        .padding(.vertical, 12)
    }

    @ViewBuilder private func icon(_ state: RowState) -> some View {
        switch state {
        case .pass: Image(systemName: "checkmark.circle.fill").foregroundStyle(Tokens.success)
        case .fail: Image(systemName: "xmark.octagon.fill").foregroundStyle(Tokens.danger)
        case .waiting: Image(systemName: "circle.dashed").foregroundStyle(.secondary)
        }
    }

    private var footer: some View {
        VStack(spacing: 0) {
            Divider()
            HStack(spacing: 8) {
                Label("Read-only: Quack never posts to GitHub.", systemImage: "lock")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Spacer()
                Button("Choose folder…") { Task { await chooseFolder() } }
                Button("Re-check") { Task { await model.runChecks() } }
                    .disabled(model.checking)
                if model.setupComplete {
                    Button("Continue", action: onContinue).keyboardShortcut(.defaultAction)
                } else {
                    Button("Continue", action: onContinue).disabled(true)
                }
            }
            .padding(.horizontal, 20)
            .padding(.vertical, 12)
        }
    }

    @MainActor private func chooseFolder() async {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = false
        panel.prompt = "Choose"
        guard panel.runModal() == .OK, let url = panel.url else { return }
        _ = await model.addScanFolder(url.path)
        await model.runChecks()
    }
}

#Preview("Server unreachable") {
    FirstRunView(model: AppModel(preview: nil, connection: .disconnected(reason: "preview")), onContinue: {})
        .frame(width: 780, height: 760)
}
