import Foundation
import QuackClient
import QuackProtocol
import Testing
@testable import QuackStores

private func item(_ n: Int, approvedBy: [String]? = nil) -> String {
    let approved = approvedBy.map { #","approvedBy":[\#($0.map { "\"\($0)\"" }.joined(separator: ","))]"# } ?? ""
    return #"{"pr":{"owner":"acme","repo":"web","number":\#(n)},"title":"T\#(n)","url":"u","authorLogin":"a","isDraft":false,"headSha":"h","baseRef":"main","updatedAt":"2026-11-18T08:00:00Z","additions":1,"deletions":0,"role":"reviewer","ci":"none","reviewer":{"requestedAt":"2026-11-1\#(n)T08:00:00Z","via":"team"\#(approved)}}"#
}

@MainActor @Test func requestsSomeoneElseApprovedGoLastAndDontCount() {
    let json = #"{"requestId":"s","fetchedAt":"2026-11-18T09:00:00Z","items":[\#([item(1, approvedBy: ["noor"]), item(2), item(3), item(4, approvedBy: ["sven"])].joined(separator: ","))],"events":[]}"#
    let m = AppModel(preview: try! JSONDecoder().decode(InboxMessage.self, from: Data(json.utf8)), connection: .connecting)
    m.useVisibilityDefaults(UserDefaults(suiteName: "quack-approved-\(UUID().uuidString)")!)
    #expect(m.reviewRequests.map(\.pr.number) == [2, 3], "only requests waiting on me")
    #expect(m.approvedElsewhere.map(\.pr.number) == [1, 4])
    #expect(m.waitingCount == 2, "the menu bar counts only requests waiting on me")
    #expect(m.items(for: .everything).reviews.map(\.pr.number) == [2, 3, 1, 4], "approved ones listed after, each in wait order")
}
