import QuackStores
import SwiftUI

/// The sidebar's "Show PRs from" control: a field-style button that opens a menu of accounts.
struct AccountPicker: View {
    var model: AppModel
    var openAccounts: () -> Void = {}

    private var accounts: [AppModel.Account] { model.accounts }
    private var scope: String? { model.accountScope }
    private var current: AppModel.Account? { scope.flatMap { id in accounts.first { $0.id == id } } }
    private var currentName: String { model.accountScopeName ?? "All accounts" }
    private var currentSymbol: String {
        guard scope != nil else { return "tray" }
        return (current?.isOrganization ?? false) ? "building.2" : "person"
    }

    var body: some View {
        Menu {
            Toggle(isOn: binding(nil)) {
                Label {
                    Text(verbatim: "All accounts  \(model.count(for: .everything))")
                } icon: { Image(systemName: "tray") }
            }
            let orgs = accounts.filter(\.isOrganization)
            let people = accounts.filter { !$0.isOrganization }
            if !orgs.isEmpty {
                Section("Organizations") { ForEach(orgs) { row($0) } }
            }
            if !people.isEmpty {
                Section("Personal") { ForEach(people) { row($0) } }
            }
            Divider()
            Button("Manage accounts…", action: openAccounts)
        } label: {
            HStack(spacing: 7) {
                Image(systemName: currentSymbol)
                    .font(.system(size: 12))
                    .foregroundStyle(.secondary)
                    .frame(width: 16)
                Text(verbatim: currentName)
                    .font(.system(size: 13, weight: .medium))
                    .lineLimit(1)
                Spacer(minLength: 4)
                Image(systemName: "chevron.down")
                    .font(.system(size: 9, weight: .semibold))
                    .foregroundStyle(.tertiary)
            }
            .padding(.horizontal, 9)
            .frame(height: 28)
            .frame(maxWidth: .infinity)
            .background(Tokens.fill, in: RoundedRectangle(cornerRadius: 8))
            .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Color.primary.opacity(0.1), lineWidth: 0.5))
            .contentShape(RoundedRectangle(cornerRadius: 8))
        }
        .menuStyle(.button)
        .buttonStyle(.plain)
        .menuIndicator(.hidden)
        .fixedSize(horizontal: false, vertical: true)
        .accessibilityLabel(Text(verbatim: "Account: \(currentName)"))
        .help("Show PRs from")
    }

    private func row(_ account: AppModel.Account) -> some View {
        Toggle(isOn: binding(account.name)) {
            Label {
                Text(verbatim: "\(account.name)\(account.isViewer ? " · you" : "")  \(account.count)")
            } icon: { Image(systemName: account.isOrganization ? "building.2" : "person") }
        }
    }

    private func binding(_ owner: String?) -> Binding<Bool> {
        Binding(
            get: { scope == owner?.lowercased() },
            set: { _ in model.setAccountScope(owner) }
        )
    }
}

/// The small centred empty state for a section that is empty because of the account scope.
struct ScopedEmpty: View {
    var symbol: String
    var title: String
    var message: String

    var body: some View {
        VStack(spacing: 6) {
            Image(systemName: symbol)
                .font(.system(size: 18))
                .foregroundStyle(.secondary)
                .frame(width: 44, height: 44)
                .background(Tokens.fill, in: Circle())
                .accessibilityHidden(true)
            Text(verbatim: title).font(.system(size: 13, weight: .semibold))
            Text(verbatim: message).font(.system(size: 12)).foregroundStyle(.secondary)
        }
        .multilineTextAlignment(.center)
        .frame(maxWidth: .infinity)
        .padding(.vertical, 18)
        .listRowSeparator(.hidden)
        .selectionDisabled()
        .accessibilityElement(children: .combine)
    }
}
