import Foundation
import QuackClient
import QuackProtocol
import Testing
@testable import QuackStores

private func item(_ owner: String, _ repo: String, _ n: Int, org: Bool, role: String = "reviewer") -> String {
    let reviewer = role == "reviewer" ? #","reviewer":{"requestedAt":"2026-11-18T08:00:00Z","via":"user"}"# : ""
    let author = role == "author" ? #","author":{"state":null,"since":"2026-11-18T08:00:00Z","reasons":[]}"# : ""
    return #"{"pr":{"owner":"\#(owner)","repo":"\#(repo)","number":\#(n)},"title":"T\#(n)","url":"u","authorLogin":"a","isDraft":false,"headSha":"h","baseRef":"main","updatedAt":"2026-11-18T08:00:00Z","additions":1,"deletions":0,"role":"\#(role)","ci":"none","ownerType":"\#(org ? "org" : "user")"\#(reviewer)\#(author)}"#
}

@MainActor private func model() -> AppModel {
    let items = [item("acme", "web", 1, org: true), item("acme", "api", 2, org: true), item("geo", "sdk", 3, org: true), item("dev", "tool", 4, org: false, role: "author")]
    let inbox = try! JSONDecoder().decode(InboxMessage.self, from: Data(#"{"requestId":"s","fetchedAt":"2026-11-18T09:00:00Z","items":[\#(items.joined(separator: ","))],"events":[]}"#.utf8))
    let hello = try! JSONDecoder().decode(HelloResponse.self, from: Data(#"{"requestId":"h","version":"0","protocol":2,"viewer":"Dev","capabilities":{"workspace":true,"inbox":true,"labels":true,"review":true,"agents":["cursor"]}}"#.utf8))
    let m = AppModel(preview: inbox, connection: .connected(hello))
    m.useVisibilityDefaults(UserDefaults(suiteName: "quack-scope-\(UUID().uuidString)")!)
    return m
}

@MainActor @Test func accountsGroupOrganizationsFirstAndMarkYou() {
    let m = model()
    #expect(m.accounts.map(\.name) == ["acme", "geo", "dev"])
    #expect(m.accounts.map(\.count) == [2, 1, 1])
    #expect(m.accounts.last?.isViewer == true && m.accounts.last?.isOrganization == false)
}

@MainActor @Test func aScopeNarrowsListsAndReposButNotBadgesOrTheMenuBar() {
    let m = model()
    m.setAccountScope("ACME")
    #expect(m.accountScopeName == "acme")
    #expect(m.items(for: .everything).reviews.map(\.pr.number) == [1, 2])
    #expect(m.items(for: .myPRs).mine.isEmpty)
    #expect(m.repos.map(\.name).sorted() == ["acme/api", "acme/web"])
    #expect(m.count(for: .everything) == 4, "sidebar badges stay totals")
    #expect(m.waitingCount == 3, "the menu bar count ignores the scope")
    m.setAccountScope(nil)
    #expect(m.items(for: .everything).reviews.count == 3)
}

@MainActor @Test func theScopeIsRemembered() {
    let defaults = UserDefaults(suiteName: "quack-scope-\(UUID().uuidString)")!
    let a = model()
    a.useVisibilityDefaults(defaults)
    a.setAccountScope("geo")
    let b = model()
    b.useVisibilityDefaults(defaults)
    #expect(b.accountScope == "geo")
}
