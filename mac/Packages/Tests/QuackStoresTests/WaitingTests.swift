import Foundation
import Testing
@testable import QuackStores

@Test func waitLevelsFollowTheSpecRanges() {
    #expect(WaitLevel(waited: 3 * 3600) == .fresh)
    #expect(WaitLevel(waited: 4 * 3600) == .hours)
    #expect(WaitLevel(waited: 23 * 3600) == .hours)
    #expect(WaitLevel(waited: 24 * 3600) == .days)
    #expect(WaitLevel(waited: 3 * 24 * 3600 + 1) == .old)
    #expect(!WaitLevel.hours.showsQuip && WaitLevel.days.showsQuip)
}

@Test func durationsAreExactAndShort() {
    #expect(WaitFormat.short(25 * 60) == "25m")
    #expect(WaitFormat.short(6 * 3600 + 12 * 60) == "6h 12m")
    #expect(WaitFormat.short(3 * 3600) == "3h")
    #expect(WaitFormat.short(2 * 86400 + 5 * 3600) == "2d 5h")
    #expect(WaitFormat.short(5 * 86400) == "5d")
    #expect(WaitFormat.short(6 * 86400 + 23 * 3600) == "6d 23h", "under a week stays exact")
    #expect(WaitFormat.short(7 * 86400 + 21 * 3600) == "7d", "from a week, whole days")
    #expect(WaitFormat.short(226 * 86400 + 5 * 3600) == "226d")
    #expect(WaitFormat.spoken(226 * 86400 + 5 * 3600) == "226 days 5 hours", "VoiceOver keeps the exact time")
    #expect(WaitFormat.spoken(86400 + 6 * 3600) == "1 day 6 hours")
}

@Test func quipsOnlyFromADay() {
    #expect(Quips.reviewRequest(.hours) == nil)
    #expect(Quips.reviewRequest(.days) == "Someone’s refreshing GitHub.")
    #expect(Quips.author(.waitingOnReviewers, .old) == "Carbon-dating this one.")
    #expect(Quips.author(.readyToMerge, .fresh) == nil)
}

@Test func menuBarBadgeStates() {
    #expect(MenuBarBadge(connected: false, polled: true, waiting: 3) == .warning)
    #expect(MenuBarBadge(connected: true, polled: false, waiting: 3) == .pending)
    #expect(MenuBarBadge(connected: true, polled: true, waiting: 0) == .none)
    #expect(MenuBarBadge(connected: true, polled: true, waiting: 6) == .count("6"))
    #expect(MenuBarBadge(connected: true, polled: true, waiting: 140) == .count("99+"))
}

@Test func initialsFromLogins() {
    #expect(initials("noor-haddad") == "NH")
    #expect(initials("skeller") == "SK")
}
