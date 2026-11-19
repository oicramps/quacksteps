import QuackProtocol
import QuackStores
import SwiftUI

/// IDE-style tabs above the main area: Inbox pinned first, then one closable tab per open PR.
struct WorkspaceTabBar: View {
    let model: AppModel
    let workspace: Workspace

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 2) {
                TabButton(selected: workspace.selected == .inbox, closable: false, help: "Inbox") {
                    workspace.selected = .inbox
                } close: {} label: {
                    Image(systemName: "tray").imageScale(.small)
                    Text("Inbox")
                    if model.waitingCount > 0 {
                        Text(verbatim: "\(model.waitingCount)").monospacedDigit().foregroundStyle(.secondary)
                    }
                }
                ForEach(workspace.tabs, id: \.id) { pr in
                    let item = model.item(for: pr)
                    TabButton(selected: workspace.isSelected(pr), closable: true, help: item?.title ?? pr.description, closeLabel: "Close \(pr.repo) #\(pr.number)") {
                        workspace.open(pr)
                    } close: {
                        workspace.close(pr)
                    } label: {
                        phaseDot(item?.review?.phase)
                        Text(verbatim: "\(pr.repo) #\(pr.number)").foregroundStyle(.secondary)
                        Text(item?.title ?? "").lineLimit(1)
                    }
                }
            }
            .padding(.horizontal, 8)
        }
        .frame(height: 34)
        .background(.bar)
        .overlay(alignment: .bottom) { Divider() }
    }

    @ViewBuilder private func phaseDot(_ phase: ReviewState.Phase?) -> some View {
        if let phase {
            Circle()
                .fill(phase == .ready ? Tokens.success : phase == .failed ? Tokens.danger : Tokens.warning)
                .frame(width: 6, height: 6)
                .accessibilityLabel(phase == .ready ? "Reviewing" : phase == .failed ? "Couldn’t prepare" : phase == .stale ? "New commits" : "Preparing")
        }
    }
}

private struct TabButton<Label: View>: View {
    let selected: Bool
    let closable: Bool
    let help: String
    var closeLabel: String = "Close tab"
    let select: () -> Void
    let close: () -> Void
    @ViewBuilder let label: Label
    @State private var hovering = false

    var body: some View {
        HStack(spacing: 6) {
            Button(action: select) {
                HStack(spacing: 5) { label }
                    .font(.system(size: 12, weight: selected ? .medium : .regular))
                    .frame(maxWidth: 240, alignment: .leading)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityElement(children: .combine)
            .accessibilityAddTraits(selected ? .isSelected : [])
            if closable {
                Button(action: close) {
                    Image(systemName: "xmark").font(.system(size: 8, weight: .bold))
                        .frame(width: 14, height: 14)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .foregroundStyle(.secondary)
                .opacity(selected || hovering ? 1 : 0)
                .accessibilityLabel(closeLabel)
            }
        }
        .padding(.leading, 10)
        .padding(.trailing, closable ? 6 : 10)
        .frame(height: 26)
        .background(selected ? Color.primary.opacity(0.08) : hovering ? Color.primary.opacity(0.04) : .clear, in: RoundedRectangle(cornerRadius: 7))
        .contentShape(RoundedRectangle(cornerRadius: 7))
        .onHover { hovering = $0 }
        .help(help)
    }
}
