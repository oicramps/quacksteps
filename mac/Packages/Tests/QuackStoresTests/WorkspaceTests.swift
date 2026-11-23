import Foundation
import QuackProtocol
import Testing
@testable import QuackStores

@MainActor private func fresh() -> (Workspace, UserDefaults) {
    let suite = "quack-ws-\(UUID().uuidString)"
    let d = UserDefaults(suiteName: suite)!
    return (Workspace(defaults: d), d)
}

private let a = PrKey(owner: "acme", repo: "web", number: 1)
private let b = PrKey(owner: "acme", repo: "web", number: 2)
private let c = PrKey(owner: "acme", repo: "api", number: 3)

@MainActor @Test func openingFocusesAnExistingTabInsteadOfAddingOne() {
    let (ws, _) = fresh()
    ws.open(a)
    ws.open(b)
    ws.open(PrKey(owner: "ACME", repo: "Web", number: 1))
    #expect(ws.tabs.count == 2)
    #expect(ws.isSelected(a))
}

@MainActor @Test func closingTheSelectedTabMovesToItsNeighbourThenTheInbox() {
    let (ws, _) = fresh()
    ws.open(a); ws.open(b); ws.open(c)
    ws.open(b)
    ws.close(b)
    #expect(ws.isSelected(c))
    ws.close(c)
    #expect(ws.isSelected(a))
    ws.close(a)
    #expect(ws.selected == .inbox)
}

@MainActor @Test func nextAndPreviousCycleThroughTheInbox() {
    let (ws, _) = fresh()
    ws.open(a); ws.open(b)
    ws.selected = .inbox
    ws.selectNext(1)
    #expect(ws.isSelected(a))
    ws.selectNext(-1)
    ws.selectNext(-1)
    #expect(ws.isSelected(b))
}

@MainActor @Test func tabsAndSelectionSurviveARelaunch() {
    let (ws, defaults) = fresh()
    ws.open(a); ws.open(b)
    ws.open(a)
    ws.onboarded = true
    let again = Workspace(defaults: defaults)
    #expect(again.tabs == [a, b])
    #expect(again.isSelected(a))
    #expect(again.onboarded)
}
