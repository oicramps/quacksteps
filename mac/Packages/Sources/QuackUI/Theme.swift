import QuackStores
import AppKit
import CoreText
import SwiftUI

// Design tokens from the screens canvas (Foundations). Brand colours are used sparingly; everything
// else uses system styles so dark mode, Increase Contrast and the user's accent just work.

extension Color {
    /// A colour with separate light and dark values, resolved by AppKit per appearance.
    static func dynamic(light: NSColor, dark: NSColor) -> Color {
        Color(nsColor: NSColor(name: nil) { appearance in
            appearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua ? dark : light
        })
    }

    init(hex: UInt32, alpha: CGFloat = 1) {
        self.init(nsColor: NSColor(hex: hex, alpha: alpha))
    }
}

extension NSColor {
    convenience init(hex: UInt32, alpha: CGFloat = 1) {
        self.init(srgbRed: CGFloat((hex >> 16) & 0xff) / 255, green: CGFloat((hex >> 8) & 0xff) / 255, blue: CGFloat(hex & 0xff) / 255, alpha: alpha)
    }
}

public enum Tokens {
    // Brand
    public static let quackYellow = Color(hex: 0xffcc33)
    public static let quackYellowEdge = Color(hex: 0xe0a800)
    public static let quackSoft = Color(hex: 0xf2c94c)
    public static let quackSoftEdge = Color(hex: 0xd4a72c)
    public static let beak = Color(hex: 0xff980f)
    public static let ink = Color(hex: 0x1c222e)
    public static let logoInk = Color.dynamic(light: NSColor(hex: 0x1c222e), dark: NSColor(hex: 0xf3f5f7))
    public static let cream = Color.dynamic(light: NSColor(hex: 0xfff4e6), dark: NSColor(hex: 0xffcc33, alpha: 0.1))

    // Semantic text
    public static let danger = Color.dynamic(light: NSColor(hex: 0xb33928), dark: NSColor(hex: 0xff806c))
    public static let warning = Color.dynamic(light: NSColor(hex: 0x915300), dark: NSColor(hex: 0xffc67a))
    public static let success = Color.dynamic(light: NSColor(hex: 0x127f34), dark: NSColor(hex: 0x5cd685))
    public static let addText = Color.dynamic(light: NSColor(hex: 0x1f7a37), dark: NSColor(hex: 0x5ad37a))
    public static let delText = Color.dynamic(light: NSColor(hex: 0xb0281e), dark: NSColor(hex: 0xff7b70))

    // Risk and state fills (High/Med also tint the "Waiting on me" and "Blocked by CI" chips)
    public static let highBg = Color.dynamic(light: NSColor(hex: 0xfff1ec), dark: NSColor(hex: 0xfc583f, alpha: 0.16))
    public static let highLine = Color.dynamic(light: NSColor(hex: 0xffcbb9), dark: NSColor(hex: 0xfc583f, alpha: 0.45))
    public static let medBg = Color.dynamic(light: NSColor(hex: 0xfff4e6), dark: NSColor(hex: 0xff980f, alpha: 0.16))
    public static let medLine = Color.dynamic(light: NSColor(hex: 0xffddb0), dark: NSColor(hex: 0xff980f, alpha: 0.45))
    public static let lowBg = Color.dynamic(light: NSColor(hex: 0xf3f5f7), dark: NSColor(white: 1, alpha: 0.08))
    public static let lowText = Color.dynamic(light: NSColor(hex: 0x4d5a6e), dark: NSColor(hex: 0xb8c1cc))
    public static let greenBg = Color.dynamic(light: NSColor(hex: 0x34c759, alpha: 0.13), dark: NSColor(hex: 0x30d158, alpha: 0.16))

    // Banners
    public static let bannerWarn = Color.dynamic(light: NSColor(hex: 0xfff6e0), dark: NSColor(hex: 0xffcc33, alpha: 0.1))
    public static let bannerWarnLine = Color.dynamic(light: NSColor(hex: 0xf3dca4), dark: NSColor(hex: 0xffcc33, alpha: 0.3))
    public static let bannerErr = Color.dynamic(light: NSColor(hex: 0xfff1ec), dark: NSColor(hex: 0xfc583f, alpha: 0.12))
    public static let bannerErrLine = Color.dynamic(light: NSColor(hex: 0xffcbb9), dark: NSColor(hex: 0xfc583f, alpha: 0.4))

    public static let fill = Color.primary.opacity(0.05)
    public static let fill2 = Color.primary.opacity(0.085)

    /// Avatar colours from the canvas.
    public static let avatarHex: [UInt32] = [0x2563eb, 0x7a5af8, 0x0e8a7e, 0xbe185d, 0xc2410c, 0x0369a1, 0x4d7c0f, 0x9333ea]
    public static let avatars: [Color] = avatarHex.map { Color(hex: $0) }

    /// "#2563eb": a login's avatar colour for the diff web view.
    public static func avatarCSS(_ login: String) -> String {
        String(format: "#%06x", avatarHex[avatarColorIndex(login, count: avatarHex.count)])
    }
}

// MARK: - Type

public enum QuackFont {
    nonisolated(unsafe) private static var registered = false

    /// Registers the bundled Space Grotesk (the only custom font) for this process. Safe to call twice.
    @MainActor public static func register(from directory: URL?) {
        guard !registered, let directory else { return }
        registered = true
        let urls = (try? FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)) ?? []
        for url in urls where ["ttf", "otf", "woff2", "woff"].contains(url.pathExtension) {
            CTFontManagerRegisterFontsForURL(url as CFURL, .process, nil)
        }
    }

    static var hasSpaceGrotesk: Bool { NSFont(name: "SpaceGrotesk-SemiBold", size: 12) != nil || NSFontManager.shared.availableFontFamilies.contains("Space Grotesk") }

    /// Display: Space Grotesk 700, 30/36. First run headline only.
    public static var display: Font { hasSpaceGrotesk ? .custom("Space Grotesk", size: 30).weight(.bold) : .system(size: 30, weight: .bold, design: .rounded) }

    /// Headline: Space Grotesk 600, 14–20. Empty and error headlines, quips, thinking lines.
    public static func headline(_ size: CGFloat = 18) -> Font {
        hasSpaceGrotesk ? .custom("Space Grotesk", size: size).weight(.semibold) : .system(size: size, weight: .semibold, design: .rounded)
    }
}

// MARK: - Logo

/// The logo's parts in the canvas's 36 × 24 viewBox: braces in ink, a webbed footprint tilted 12°.
enum LogoPaths {
    static let viewBox = CGSize(width: 36, height: 24)

    static func leftBrace() -> Path {
        var p = Path()
        p.move(to: .init(x: 7, y: 3))
        p.addCurve(to: .init(x: 4.4, y: 7), control1: .init(x: 4.6, y: 3), control2: .init(x: 4.4, y: 4.8))
        p.addLine(to: .init(x: 4.4, y: 9.6))
        p.addCurve(to: .init(x: 2, y: 12), control1: .init(x: 4.4, y: 11), control2: .init(x: 3.6, y: 12))
        p.addCurve(to: .init(x: 4.4, y: 14.4), control1: .init(x: 3.6, y: 12), control2: .init(x: 4.4, y: 13))
        p.addLine(to: .init(x: 4.4, y: 17))
        p.addCurve(to: .init(x: 7, y: 21), control1: .init(x: 4.4, y: 19.2), control2: .init(x: 4.6, y: 21))
        return p
    }

    static func rightBrace() -> Path {
        leftBrace().applying(CGAffineTransform(a: -1, b: 0, c: 0, d: 1, tx: 36, ty: 0))
    }

    private static let tilt = CGAffineTransform(translationX: 18, y: 12).rotated(by: -12 * .pi / 180).translatedBy(x: -18, y: -12)

    static func footprint() -> Path {
        var p = Path()
        p.move(to: .init(x: 18, y: 21.4))
        p.addQuadCurve(to: .init(x: 16, y: 20), control: .init(x: 16.6, y: 21.4))
        p.addLine(to: .init(x: 10.6, y: 8.8))
        p.addQuadCurve(to: .init(x: 12, y: 6.8), control: .init(x: 9.9, y: 6.6))
        p.addQuadCurve(to: .init(x: 16.8, y: 4.2), control: .init(x: 15.3, y: 10.6))
        p.addQuadCurve(to: .init(x: 19.2, y: 4.2), control: .init(x: 18, y: 1.8))
        p.addQuadCurve(to: .init(x: 24, y: 6.8), control: .init(x: 20.7, y: 10.6))
        p.addQuadCurve(to: .init(x: 25.4, y: 8.8), control: .init(x: 26.1, y: 6.6))
        p.addLine(to: .init(x: 20, y: 20))
        p.addQuadCurve(to: .init(x: 18, y: 21.4), control: .init(x: 19.4, y: 21.4))
        p.closeSubpath()
        return p.applying(tilt)
    }

    static func toes() -> Path {
        var p = Path()
        p.move(to: .init(x: 18, y: 17.2)); p.addLine(to: .init(x: 12.2, y: 8.2))
        p.move(to: .init(x: 18, y: 17.2)); p.addLine(to: .init(x: 18, y: 4.8))
        p.move(to: .init(x: 18, y: 17.2)); p.addLine(to: .init(x: 23.8, y: 8.2))
        return p.applying(tilt)
    }
}

/// The full-colour logo: ink braces, a beak-orange footprint with yellow webbing.
public struct QuackLogo: View {
    var height: CGFloat
    public init(height: CGFloat = 16) { self.height = height }

    public var body: some View {
        Canvas { ctx, size in
            let s = size.height / LogoPaths.viewBox.height
            ctx.scaleBy(x: s, y: s)
            let brace = StrokeStyle(lineWidth: 2.2, lineCap: .round, lineJoin: .round)
            ctx.stroke(LogoPaths.leftBrace(), with: .color(Tokens.logoInk), style: brace)
            ctx.stroke(LogoPaths.rightBrace(), with: .color(Tokens.logoInk), style: brace)
            ctx.fill(LogoPaths.footprint(), with: .color(Tokens.beak))
            ctx.stroke(LogoPaths.toes(), with: .color(Tokens.quackYellow), style: StrokeStyle(lineWidth: 1.2, lineCap: .round))
        }
        .frame(width: height * 1.5, height: height)
        .accessibilityLabel("Quacksteps")
    }
}

public enum MenuBarImage {
    /// The monochrome template version for the menu bar (solid footprint, no webbing). macOS tints it.
    @MainActor public static let template: NSImage = {
        let size = NSSize(width: 22.5, height: 15)
        let image = NSImage(size: size, flipped: true) { rect in
            guard let ctx = NSGraphicsContext.current?.cgContext else { return false }
            let s = rect.height / LogoPaths.viewBox.height
            ctx.scaleBy(x: s, y: s)
            ctx.setStrokeColor(NSColor.black.cgColor)
            ctx.setFillColor(NSColor.black.cgColor)
            ctx.setLineWidth(2.4)
            ctx.setLineCap(.round)
            ctx.addPath(LogoPaths.leftBrace().cgPath)
            ctx.addPath(LogoPaths.rightBrace().cgPath)
            ctx.strokePath()
            ctx.addPath(LogoPaths.footprint().cgPath)
            ctx.fillPath()
            return true
        }
        image.isTemplate = true
        image.accessibilityDescription = "Quacksteps"
        return image
    }()
}
