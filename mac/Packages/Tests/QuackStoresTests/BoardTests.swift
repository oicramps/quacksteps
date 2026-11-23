import Foundation
import QuackProtocol
import Testing
@testable import QuackStores

@Test func flapsUseThreeCharacters() {
    #expect(BoardFormat.flaps(25 * 60) == "25M")
    #expect(BoardFormat.flaps(5 * 60) == "05M")
    #expect(BoardFormat.flaps(6 * 3600 + 12 * 60) == "06H")
    #expect(BoardFormat.flaps(30 * 3600) == "30H", "hours up to two days, as on the board")
    #expect(BoardFormat.flaps(53 * 3600) == "02D")
    #expect(BoardFormat.flaps(99 * 86400) == "99D")
    #expect(BoardFormat.flaps(226 * 86400) == "32W", "past 99 days, weeks")
    #expect(BoardFormat.flaps(2000 * 86400) == "99W")
}

@Test func sizeBuckets() {
    #expect(PRSize(lines: 49) == .xs)
    #expect(PRSize(lines: 50) == .s)
    #expect(PRSize(lines: 500) == .l, "500 is L: under 500 is M")
    #expect(PRSize(lines: 2400) == .xl)
    #expect(!PRSize.m.isBig && PRSize.l.isBig)
}

@Test func statusWords() {
    #expect(BoardStatus.review(waited: 3600, approvedByOthers: false).word == "ON TIME")
    #expect(BoardStatus.review(waited: 2 * 86400, approvedByOthers: false) == BoardStatus(word: "DELAYED", tone: .orange, urgency: 4))
    #expect(BoardStatus.review(waited: 4 * 86400, approvedByOthers: false).tone == .red)
    #expect(BoardStatus.review(waited: 9 * 86400, approvedByOthers: true).word == "APPROVED")
    #expect(BoardStatus.author(.waitingOnMe, waited: 60).word == "YOUR TURN")
    #expect(BoardStatus.author(.blockedByCI, waited: 60).word == "CI FAILED")
    #expect(BoardStatus.author(.readyToMerge, waited: 60).word == "READY")
    #expect(BoardStatus.author(.waitingOnReviewers, waited: 30 * 3600).word == "DELAYED")
    #expect(BoardStatus.author(nil, waited: 0).word == "DRAFT")
}

private func pr(_ n: Int, repo: String = "web", position: Int? = nil, size: Int = 3, parent: Int? = nil, ci: String = "passing", lines: Int = 10) -> InboxItem {
    var stack = ""
    if let position {
        let p = parent.map { #","parent":{"number":\#($0),"title":"P"}"# } ?? ""
        stack = #","stack":{"position":\#(position),"size":\#(size)\#(p)}"#
    }
    let json = #"{"pr":{"owner":"acme","repo":"\#(repo)","number":\#(n)},"title":"Trip map: part \#(n)","url":"u","authorLogin":"a","isDraft":false,"headSha":"h","baseRef":"main","updatedAt":"2026-11-18T08:00:00Z","additions":\#(lines),"deletions":0,"role":"reviewer","ci":"\#(ci)","reviewer":{"requestedAt":"2026-11-1\#(n % 10)T08:00:00Z","via":"user"}\#(stack)}"#
    return try! JSONDecoder().decode(InboxItem.self, from: Data(json.utf8))
}

@Test func stacksGroupInPlaceOfTheirFirstMember() {
    // 2 sits on 1, 3 on 2; 9 is alone; 5 claims a stack but its parent isn't in the list.
    let items = [pr(9), pr(3, position: 3, parent: 2, ci: "failing", lines: 5), pr(1, position: 1, lines: 100), pr(5, position: 2, parent: 4), pr(2, position: 2, parent: 1, ci: "pending")]
    let entries = InboxEntry.group(items)
    #expect(entries.count == 3)
    guard case .item(let first) = entries[0], case .stack(let group) = entries[1], case .item(let lone) = entries[2] else {
        Issue.record("unexpected shape: \(entries.map(\.id))")
        return
    }
    #expect(first.pr.number == 9)
    #expect(group.items.map(\.pr.number) == [1, 2, 3], "bottom first: the PR into main merges first")
    #expect(group.name == "Trip map")
    #expect(group.worstCI == .failing)
    #expect(group.totalLines == 115)
    #expect(lone.pr.number == 5, "a stack with one member in the list stays a plain row")
}

@Test func stacksDontCrossRepos() {
    let entries = InboxEntry.group([pr(1, position: 1), pr(2, repo: "api", position: 2, parent: 1)])
    #expect(entries.count == 2)
}
