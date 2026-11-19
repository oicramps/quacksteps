import AppKit
import QuackProtocol
import QuackStores
import SwiftUI

// Shared components from the canvas's Foundations board. Screens build from these; keep styling here.

/// Initials in a coloured circle. No photos in v1.
public struct Avatar: View {
    var login: String
    var size: CGFloat
    public init(_ login: String, size: CGFloat = 24) {
        self.login = login
        self.size = size
    }

    public var body: some View {
        Text(initials(login))
            .font(.system(size: size * 0.4, weight: .semibold))
            .foregroundStyle(.white)
            .frame(width: size, height: size)
            .background(Tokens.avatars[avatarColorIndex(login, count: Tokens.avatars.count)], in: Circle())
            .accessibilityHidden(true)
    }
}

/// Clock-to-hourglass timer that counts up from `since`, once a minute. Colour only adds urgency.
public struct WaitTimer: View {
    var since: Date
    var size: CGFloat
    public init(since: Date, size: CGFloat = 13) {
        self.since = since
        self.size = size
    }

    public var body: some View {
        TimelineView(.periodic(from: .now, by: 60)) { context in
            let waited = context.date.timeIntervalSince(since)
            let level = WaitLevel(waited: waited)
            HStack(spacing: 4) {
                Image(systemName: level.usesHourglass ? "hourglass" : "clock").imageScale(.small)
                Text(WaitFormat.short(waited)).monospacedDigit()
            }
            // Never wraps: a long wait grows into the space on its left instead of breaking the line.
            .lineLimit(1)
            .fixedSize()
            .font(.system(size: size, weight: level.usesHourglass ? .semibold : .medium))
            .foregroundStyle(Self.color(level))
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("Waiting \(WaitFormat.spoken(waited))")
        }
    }

    public static func color(_ level: WaitLevel) -> Color {
        switch level {
        case .fresh: .secondary
        case .hours: .primary
        case .days: Tokens.warning
        case .old: Tokens.danger
        }
    }
}

/// The current wait level for a date, for quips (call inside a TimelineView to stay fresh).
public func waitLevel(since: Date, now: Date = .now) -> WaitLevel { WaitLevel(waited: now.timeIntervalSince(since)) }

/// How each author state looks: chip, 24 pt status tile, colours.
public struct StateStyle {
    public var label: String
    public var symbol: String
    public var foreground: Color
    public var background: Color
    public var outlined: Bool

    /// nil state = Draft.
    public static func of(_ state: AuthorState?) -> StateStyle {
        switch state {
        case .waitingOnReviewers: StateStyle(label: "Waiting on reviewers", symbol: "clock", foreground: .secondary, background: Tokens.fill2, outlined: false)
        case .waitingOnMe: StateStyle(label: "Waiting on me", symbol: "person", foreground: Tokens.warning, background: Tokens.medBg, outlined: false)
        case .blockedByCI: StateStyle(label: "Blocked by CI", symbol: "xmark.octagon", foreground: Tokens.danger, background: Tokens.highBg, outlined: false)
        case .readyToMerge: StateStyle(label: "Ready to merge", symbol: "arrow.triangle.merge", foreground: Tokens.success, background: Tokens.greenBg, outlined: false)
        case nil: StateStyle(label: "Draft", symbol: "doc", foreground: .secondary, background: .clear, outlined: true)
        }
    }
}

/// Capsule chip: SF Symbol + label, 20 pt.
public struct Chip: View {
    var label: String
    var symbol: String?
    var foreground: Color
    var background: Color
    var outlined: Bool

    public init(_ label: String, symbol: String? = nil, foreground: Color = .secondary, background: Color = Tokens.fill, outlined: Bool = false) {
        self.label = label
        self.symbol = symbol
        self.foreground = foreground
        self.background = background
        self.outlined = outlined
    }

    public init(state: AuthorState?) {
        let s = StateStyle.of(state)
        self.init(s.label, symbol: s.symbol, foreground: s.foreground, background: s.background, outlined: s.outlined)
    }

    public var body: some View {
        HStack(spacing: 4) {
            if let symbol { Image(systemName: symbol).imageScale(.small) }
            Text(label)
        }
        .font(.system(size: 11, weight: .medium))
        .foregroundStyle(foreground)
        .padding(.horizontal, 7)
        .frame(height: 20)
        .background(background, in: Capsule())
        .overlay { if outlined { Capsule().strokeBorder(Color(nsColor: .separatorColor)) } }
        .fixedSize()
        .accessibilityElement(children: .combine)
    }
}

/// The 24 pt rounded status tile that leads each "My PRs" row.
public struct StatusTile: View {
    var state: AuthorState?
    var size: CGFloat
    public init(_ state: AuthorState?, size: CGFloat = 24) {
        self.state = state
        self.size = size
    }

    public var body: some View {
        let s = StateStyle.of(state)
        Image(systemName: s.symbol)
            .font(.system(size: size * 0.5, weight: .semibold))
            .foregroundStyle(s.foreground)
            .frame(width: size, height: size)
            .background(s.background, in: RoundedRectangle(cornerRadius: size * 0.29))
            .overlay { if s.outlined { RoundedRectangle(cornerRadius: size * 0.29).strokeBorder(Color(nsColor: .separatorColor)) } }
            .accessibilityHidden(true)
    }
}

/// CI as distinct SF Symbols, never colour alone.
public struct CIGlyph: View {
    var ci: CIState
    public init(_ ci: CIState) { self.ci = ci }

    public var body: some View {
        Group {
            switch ci {
            case .passing: Image(systemName: "checkmark.circle").foregroundStyle(Tokens.success)
            case .failing: Image(systemName: "xmark.octagon").foregroundStyle(Tokens.danger)
            case .pending: Image(systemName: "circle.dashed").foregroundStyle(.secondary)
            case .none: Image(systemName: "circle").foregroundStyle(.clear)
            }
        }
        .font(.system(size: 13))
        .accessibilityLabel(ci == .none ? "" : "Checks \(ci.rawValue)")
        .accessibilityHidden(ci == .none)
    }
}

/// "+412 −88" in diff colours.
public struct LineCounts: View {
    var additions: Int
    var deletions: Int
    public init(_ additions: Int, _ deletions: Int) {
        self.additions = additions
        self.deletions = deletions
    }

    public var body: some View {
        // As on the canvas: a new file reads "+52", a deletion-only file "−30"; zero sides are left out.
        Group {
            if deletions == 0 {
                Text("+\(additions)").foregroundStyle(Tokens.addText)
            } else if additions == 0 {
                Text("−\(deletions)").foregroundStyle(Tokens.delText)
            } else {
                Text("\(Text("+\(additions)").foregroundStyle(Tokens.addText)) \(Text("−\(deletions)").foregroundStyle(Tokens.delText))")
            }
        }
        .monospacedDigit()
            .accessibilityLabel("\(additions) added, \(deletions) removed")
    }
}

/// One banner per pane: tinted warn or error, icon, one bold sentence, plain text, then buttons.
public struct Banner<Actions: View>: View {
    public enum Kind { case warning, error }
    var kind: Kind
    var title: String
    var message: String?
    var actions: Actions

    public init(_ kind: Kind, title: String, message: String? = nil, @ViewBuilder actions: () -> Actions) {
        self.kind = kind
        self.title = title
        self.message = message
        self.actions = actions()
    }

    public var body: some View {
        HStack(alignment: .center, spacing: 10) {
            Image(systemName: kind == .warning ? "exclamationmark.triangle" : "xmark.octagon")
                .foregroundStyle(kind == .warning ? Tokens.warning : Tokens.danger)
                .accessibilityLabel(kind == .warning ? "Warning" : "Error")
            Text("\(Text(title).bold())\(message.map { " \($0)" } ?? "")")
                .font(.system(size: 12))
                .frame(maxWidth: .infinity, alignment: .leading)
            actions.controlSize(.small)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(kind == .warning ? Tokens.bannerWarn : Tokens.bannerErr, in: RoundedRectangle(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(kind == .warning ? Tokens.bannerWarnLine : Tokens.bannerErrLine))
    }
}

extension Banner where Actions == EmptyView {
    public init(_ kind: Kind, title: String, message: String? = nil) {
        self.init(kind, title: title, message: message) { EmptyView() }
    }
}

/// A monospaced command with a Copy button (fix steps, first run).
public struct CommandBox: View {
    var command: String
    @State private var copied = false
    public init(_ command: String) { self.command = command }

    public var body: some View {
        HStack(spacing: 8) {
            Text(command)
                .font(.system(size: 12, design: .monospaced))
                .lineLimit(1)
                .truncationMode(.middle)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
            Button {
                copyToPasteboard(command)
                copied = true
            } label: {
                Label(copied ? "Copied" : "Copy", systemImage: copied ? "checkmark" : "doc.on.doc")
            }
            .controlSize(.small)
        }
        .padding(.vertical, 7)
        .padding(.leading, 10)
        .padding(.trailing, 8)
        .background(Color(nsColor: .textBackgroundColor), in: RoundedRectangle(cornerRadius: 8))
    }
}

/// Numbered fix steps with any commands, in a soft box.
public struct FixStepsView: View {
    var steps: [FixStep]
    public init(_ steps: [FixStep]) { self.steps = steps }

    public var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(Array(steps.enumerated()), id: \.offset) { index, step in
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text("\(index + 1)").bold().monospacedDigit().frame(minWidth: 12, alignment: .leading)
                    Text(step.text).frame(maxWidth: .infinity, alignment: .leading)
                }
                .accessibilityElement(children: .combine)
                .font(.system(size: 11))
                if let command = step.command { CommandBox(command) }
            }
        }
        .padding(.vertical, 10)
        .padding(.horizontal, 12)
        .background(Tokens.fill, in: RoundedRectangle(cornerRadius: 10))
    }
}

public func copyToPasteboard(_ text: String) {
    NSPasteboard.general.clearContents()
    NSPasteboard.general.setString(text, forType: .string)
}

/// Start reviewing and Update: duck yellow, ink label. One per window at most.
public struct QuackPrimaryStyle: ButtonStyle {
    var soft: Bool
    /// `soft`: the Ask variant in soft yellow.
    public init(soft: Bool = false) { self.soft = soft }

    public func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 13, weight: .semibold))
            .foregroundStyle(Tokens.ink)
            .padding(.horizontal, 13)
            .frame(height: 30)
            .background(soft ? Tokens.quackSoft : Tokens.quackYellow, in: Capsule())
            .overlay(Capsule().strokeBorder(soft ? Tokens.quackSoftEdge : Tokens.quackYellowEdge, lineWidth: 0.5))
            .opacity(configuration.isPressed ? 0.85 : 1)
    }
}

/// Skeleton bar for loading states (never a centred spinner).
public struct SkeletonBar: View {
    var width: CGFloat?
    public init(width: CGFloat? = nil) { self.width = width }
    public var body: some View {
        RoundedRectangle(cornerRadius: 4).fill(Color.primary.opacity(0.07)).frame(width: width, height: 9)
            .accessibilityHidden(true)
    }
}

/// A Space Grotesk headline with a plain line under it: empty and error states.
public struct EmptyState<Actions: View>: View {
    var symbol: String
    var headline: String
    var message: String
    var actions: Actions

    public init(symbol: String, headline: String, message: String, @ViewBuilder actions: () -> Actions) {
        self.symbol = symbol
        self.headline = headline
        self.message = message
        self.actions = actions()
    }

    public var body: some View {
        ContentUnavailableView {
            Label {
                Text(headline).font(QuackFont.headline(18))
            } icon: {
                Image(systemName: symbol)
                    .font(.system(size: 22))
                    .frame(width: 52, height: 52)
                    .background(Tokens.fill, in: Circle())
                    .accessibilityHidden(true)
            }
        } description: {
            Text(message)
        } actions: {
            actions
        }
    }
}

extension EmptyState where Actions == EmptyView {
    public init(symbol: String, headline: String, message: String) {
        self.init(symbol: symbol, headline: headline, message: message) { EmptyView() }
    }
}

/// Short display path: "/Users/me/code" → "~/code".
public func displayPath(_ path: String) -> String {
    let home = NSHomeDirectory()
    return path.hasPrefix(home) ? "~" + path.dropFirst(home.count) : path
}

public func expandPath(_ path: String) -> String {
    path.hasPrefix("~") ? NSHomeDirectory() + path.dropFirst() : path
}

/// "6.2 GB".
public func byteString(_ bytes: Int) -> String {
    ByteCountFormatter.string(fromByteCount: Int64(bytes), countStyle: .file)
}

/// "3 new commits", "1 new commit", or "New commits" until GitHub has said how many.
public func newCommitsText(_ review: ReviewState?) -> String {
    guard let n = review?.newCommits, n > 0 else { return "New commits" }
    return n == 1 ? "1 new commit" : "\(n) new commits"
}
