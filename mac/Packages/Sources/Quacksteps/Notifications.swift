import AppKit
import QuackProtocol
import QuackStores
import UserNotifications

/// Turns the server's inbox events into notifications, with the design spec's copy and actions.
/// The server already de-duplicates events (across restarts), so every event posted here is new.
@MainActor
final class Notifications: NSObject, UNUserNotificationCenterDelegate {
    private enum Category: String {
        case reviewRequested = "review_requested"
        case prNeedsYou = "pr_needs_you"
        case ciFailed = "ci_failed"
        case readyToMerge = "ready_to_merge"
        case newCommits = "new_commits"
    }

    private enum Action: String {
        case startReviewing = "start_reviewing"
        case open
        case openOnGitHub = "open_on_github"
        case update
    }

    private let model: AppModel
    private let prefs: NotificationPrefs
    private let openPR: (PrKey) -> Void
    private let center = UNUserNotificationCenter.current()

    init(model: AppModel, prefs: NotificationPrefs, openPR: @escaping (PrKey) -> Void) {
        self.model = model
        self.prefs = prefs
        self.openPR = openPR
        super.init()
        center.delegate = self
        let start = UNNotificationAction(identifier: Action.startReviewing.rawValue, title: "Start reviewing")
        let open = UNNotificationAction(identifier: Action.open.rawValue, title: "Open", options: [.foreground])
        let github = UNNotificationAction(identifier: Action.openOnGitHub.rawValue, title: "Open on GitHub", options: [.foreground])
        let update = UNNotificationAction(identifier: Action.update.rawValue, title: "Update")
        center.setNotificationCategories([
            UNNotificationCategory(identifier: Category.reviewRequested.rawValue, actions: [start, open], intentIdentifiers: []),
            UNNotificationCategory(identifier: Category.prNeedsYou.rawValue, actions: [open], intentIdentifiers: []),
            UNNotificationCategory(identifier: Category.ciFailed.rawValue, actions: [open], intentIdentifiers: []),
            UNNotificationCategory(identifier: Category.readyToMerge.rawValue, actions: [github], intentIdentifiers: []),
            UNNotificationCategory(identifier: Category.newCommits.rawValue, actions: [update, open], intentIdentifiers: []),
        ])
        center.requestAuthorization(options: [.alert, .sound, .badge]) { _, error in
            if let error { NSLog("Quacksteps: notifications not allowed: \(error)") }
        }
    }

    func post(_ events: [InboxEvent], items: [InboxItem]) {
        for event in events {
            guard let kind = NotificationPrefs.kind(of: event), prefs.isOn(kind),
                  let item = items.first(where: { $0.pr.id == event.pr.id })
            else { continue }
            let content = UNMutableNotificationContent()
            let ref = "\(item.pr.repo) #\(item.pr.number)"
            switch event {
            case .reviewRequested:
                content.title = "\(item.authorLogin) wants your eyes"
                content.body = "\(ref) · \(item.title)"
                content.categoryIdentifier = Category.reviewRequested.rawValue
            case let .stateChanged(_, _, to) where to == .readyToMerge:
                content.title = "\(ref) is ready to merge"
                content.body = (item.author?.reasons ?? []).joined(separator: " · ")
                content.categoryIdentifier = Category.readyToMerge.rawValue
            case .stateChanged:
                content.title = "Your move on \(ref)"
                content.body = (item.author?.reasons ?? [item.title]).joined(separator: " · ")
                content.categoryIdentifier = Category.prNeedsYou.rawValue
            case let .ciFailed(_, sha):
                content.title = "\(ref) is red"
                content.body = "Checks failed on \(sha.prefix(7))"
                content.categoryIdentifier = Category.ciFailed.rawValue
            case .newCommits:
                content.title = "New commits on \(ref)"
                let reviewed = item.review?.headSha.prefix(7) ?? ""
                content.body = reviewed.isEmpty ? item.title : "Labels and chat are for \(reviewed) until you update."
                content.categoryIdentifier = Category.newCommits.rawValue
            }
            content.userInfo = ["owner": item.pr.owner, "repo": item.pr.repo, "number": item.pr.number, "url": item.url]
            content.threadIdentifier = item.pr.id
            center.add(UNNotificationRequest(identifier: "\(content.categoryIdentifier):\(item.pr.id):\(item.headSha)", content: content, trigger: nil))
        }
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        let info = response.notification.request.content.userInfo
        guard let owner = info["owner"] as? String, let repo = info["repo"] as? String, let number = info["number"] as? Int else { return }
        let pr = PrKey(owner: owner, repo: repo, number: number)
        let url = (info["url"] as? String).flatMap(URL.init(string:))
        let action = response.actionIdentifier
        await MainActor.run {
            switch Action(rawValue: action) {
            case .startReviewing: Task { await model.startReview(pr) }
            case .update: Task { await model.updateReview(pr) }
            case .openOnGitHub: if let url { NSWorkspace.shared.open(url) }
            case .open, .none: openPR(pr)
            }
        }
    }

    /// Show banners even while the app is frontmost.
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        [.banner, .sound]
    }
}
