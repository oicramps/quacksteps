import QuackProtocol
import QuackStores
import SwiftUI

/// `PrKey` isn't `Identifiable`; the sheet needs an item.
struct AssignPromptItem: Identifiable {
    var pr: PrKey
    var id: String { pr.id }
}

extension View {
    /// Presents the "Assign this PR to you?" sheet while `model.assignPrompt` is set.
    func assignPromptSheet(model: AppModel) -> some View {
        sheet(item: Binding(
            get: { model.assignPrompt.map(AssignPromptItem.init) },
            set: { if $0 == nil, model.assignPrompt != nil { model.assignPrompt = nil } }
        )) { item in
            AssignPrompt(model: model, pr: item.pr)
        }
    }
}

/// Shown after Start reviewing: offers to make you the assignee and a reviewer.
struct AssignPrompt: View {
    var model: AppModel
    var pr: PrKey
    @State private var dontAsk = false
    @State private var assigning = false
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        AssignPromptContent(
            repo: "\(pr.owner)/\(pr.repo)",
            number: pr.number,
            dontAsk: $dontAsk,
            assigning: assigning,
            cancel: { Task { _ = await model.answerAssignPrompt(assign: false, dontAskAgain: dontAsk) } },
            assign: {
                assigning = true
                Task {
                    _ = await model.answerAssignPrompt(assign: true, dontAskAgain: dontAsk)
                    assigning = false
                }
            }
        )
    }
}

/// The sheet's look, free of the model so snapshots can render it.
struct AssignPromptContent: View {
    var repo: String
    var number: Int
    @Binding var dontAsk: Bool
    var assigning = false
    var cancel: () -> Void
    var assign: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            VStack(alignment: .leading, spacing: 4) {
                Text("Assign this PR to you?").font(.headline)
                Text(verbatim: "You’ll be the assignee and a reviewer on \(repo) #\(number).")
                    .font(.callout).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Toggle("Don’t ask again", isOn: $dontAsk)
                .toggleStyle(.checkbox)
                .disabled(assigning)
            HStack(spacing: 10) {
                Spacer()
                if assigning {
                    ProgressView().controlSize(.small).accessibilityLabel("Assigning")
                }
                Button("Not now", action: cancel)
                    .keyboardShortcut(.cancelAction)
                    .disabled(assigning)
                    .accessibilityHint("Keeps the review without assigning you")
                Button("Assign me", action: assign)
                    .buttonStyle(QuackPrimaryStyle())
                    .keyboardShortcut(.defaultAction)
                    .disabled(assigning)
                    .accessibilityHint("Makes you the assignee and a requested reviewer on GitHub")
            }
        }
        .padding(20)
        .frame(width: 420)
    }
}

/// Static prompt with synthetic data, for snapshot boards.
public struct AssignPromptPreview: View {
    @State private var dontAsk = false
    public init() {}
    public var body: some View {
        AssignPromptContent(repo: "acme/web", number: 4127, dontAsk: $dontAsk, cancel: {}, assign: {})
            .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 14))
    }
}
