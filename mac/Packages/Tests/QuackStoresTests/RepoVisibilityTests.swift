import Foundation
import QuackClient
import QuackProtocol
import Testing
@testable import QuackStores

private func item(_ repo: String, _ n: Int, role: String = "reviewer", state: String? = nil) -> String {
    let reviewer = role == "reviewer" ? #","reviewer":{"requestedAt":"2026-11-18T08:00:00Z","via":"user"}"# : ""
    let author = role == "author" ? #","author":{"state":\#(state.map { "\"\($0)\"" } ?? "null"),"since":"2026-11-18T08:00:00Z","reasons":[]}"# : ""
    return #"{"pr":{"owner":"acme","repo":"\#(repo)","number":\#(n)},"title":"T\#(n)","url":"u","authorLogin":"a","isDraft":false,"headSha":"h","baseRef":"main","updatedAt":"2026-11-18T08:00:00Z","additions":1,"deletions":0,"role":"\#(role)","ci":"none"\#(reviewer)\#(author)}"#
}

@MainActor private func model() -> AppModel {
    let json = #"{"requestId":"s","fetchedAt":"2026-11-18T09:00:00Z","items":[\#([item("web", 1), item("android", 2), item("api", 3), item("android", 4, role: "author", state: "waiting_on_me")].joined(separator: ","))],"events":[]}"#
    let inbox = try! JSONDecoder().decode(InboxMessage.self, from: Data(json.utf8))
    let m = AppModel(preview: inbox, connection: .connecting)
    m.useVisibilityDefaults(UserDefaults(suiteName: "quack-vis-\(UUID().uuidString)")!)
    return m
}

@MainActor @Test func hiddenReposLeaveTheListsAndTheMenuBarCountButNotTheBadges() {
    let m = model()
    #expect(m.waitingCount == 4)
    m.setRepo("acme/Android", hidden: true)
    #expect(m.isRepoHidden("acme/android"))
    #expect(m.reviewRequests.map(\.pr.number) == [1, 3])
    #expect(m.waitingCount == 2, "hidden repos don't count in the menu bar")
    #expect(m.items(for: .everything).reviews.count == 2)
    #expect(m.count(for: .everything) == 4, "sidebar badges stay totals")
    let counts = m.sectionCounts(for: .everything)
    #expect(counts.reviews.shown == 2 && counts.reviews.total == 3)
    #expect(counts.mine.shown == 0 && counts.mine.total == 1)
    #expect(m.items(for: .repo("acme/android")).reviews.count == 1, "picking the hidden repo itself still shows it")
}

@MainActor @Test func hiddenReposAreRemembered() {
    let defaults = UserDefaults(suiteName: "quack-vis-\(UUID().uuidString)")!
    let a = model()
    a.useVisibilityDefaults(defaults)
    a.setRepo("acme/web", hidden: true)
    let b = model()
    b.useVisibilityDefaults(defaults)
    #expect(b.isRepoHidden("acme/web"))
    b.setRepo("acme/web", hidden: false)
    #expect(!b.isRepoHidden("acme/web"))
}
