import QuackProtocol
import QuackStores
import SwiftUI

/// "Viewed 3 of 12": a thin bar under the Files header.
struct ViewedProgressBar: View {
    var fraction: Double
    var body: some View {
        GeometryReader { geo in
            ZStack(alignment: .leading) {
                Capsule().fill(Tokens.fill2)
                Capsule().fill(Color.accentColor).frame(width: geo.size.width * min(max(fraction, 0), 1))
            }
        }
        .frame(height: 4)
    }
}

/// A 14 pt rounded tick: outlined when unchecked, accent-filled with a white check when checked.
struct ViewedTickStyle: ToggleStyle {
    func makeBody(configuration: Configuration) -> some View {
        Button { configuration.isOn.toggle() } label: {
            ZStack {
                if configuration.isOn {
                    RoundedRectangle(cornerRadius: 4).fill(Color.accentColor)
                    Image(systemName: "checkmark").font(.system(size: 8, weight: .bold)).foregroundStyle(.white)
                } else {
                    RoundedRectangle(cornerRadius: 4).strokeBorder(.tertiary, lineWidth: 1.2)
                }
            }
            .frame(width: 14, height: 14)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(.isToggle)
        .accessibilityValue(configuration.isOn ? "On" : "Off")
    }
}

/// Above the diff while it shows only what changed since my last review.
struct SinceReviewBanner: View {
    var store: PRStore

    private var relative: String? {
        guard let text = store.lastReview?.submittedAt, let date = ISODate.parse(text) else { return nil }
        let f = RelativeDateTimeFormatter()
        f.unitsStyle = .full
        return f.localizedString(for: date, relativeTo: Date())
    }

    var body: some View {
        if let since = store.diff?.since {
            let files = store.diff?.files.count ?? 0
            HStack(spacing: 10) {
                Image(systemName: "clock.arrow.circlepath").foregroundStyle(Color.accentColor).accessibilityHidden(true)
                Text(summary(since, files: files))
                    .font(.system(size: 12))
                    .frame(maxWidth: .infinity, alignment: .leading)
                Button("Show everything") { Task { await store.setSinceLastReview(false) } }
                    .controlSize(.small)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .background(Color.accentColor.opacity(0.12), in: RoundedRectangle(cornerRadius: 10))
            .padding(.horizontal, 12)
            .padding(.top, 8)
            .accessibilityElement(children: .contain)
        }
    }

    private func summary(_ since: PrDiffMessage.Since, files: Int) -> AttributedString {
        var sha = AttributedString(String(since.sha.prefix(7)))
        sha.font = .system(size: 12, design: .monospaced)
        var out = AttributedString("Showing what changed since your last review on ")
        out += sha
        if let relative { out += AttributedString(" (\(relative))") }
        out += AttributedString(": \(since.commits) \(since.commits == 1 ? "commit" : "commits"), \(files) \(files == 1 ? "file" : "files").")
        return out
    }
}

/// A write to GitHub failed: say so, show the fix if the server gave one, and let me dismiss it.
struct WriteErrorBanner: View {
    @Bindable var store: PRStore

    var body: some View {
        if let error = store.writeError {
            VStack(alignment: .leading, spacing: 8) {
                Banner(.error, title: "Couldn’t save to GitHub.", message: error.message) {
                    Button("Dismiss") { store.writeError = nil }
                }
                if let command = error.fixSteps?.compactMap(\.command).first {
                    CommandBox(command)
                }
            }
            .padding(.horizontal, 12)
            .padding(.top, 8)
            .accessibilityElement(children: .contain)
        }
    }
}
