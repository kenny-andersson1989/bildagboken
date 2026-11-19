// Widget på hemskärmen: det som är på gång med bilen, och hur mycket som finns i tanken.
// Appen skriver datan (WidgetDataPlugin i SceneDelegate.swift) till den delade App Group-lagringen.
// Här finns också rutan för en pågående resa i Dynamic Island och på låsskärmen (TripLiveActivity).
import WidgetKit
import SwiftUI
import ActivityKit

private let appGroup = "group.se.bildagboken.app"
private let orange = Color(red: 0.93, green: 0.42, blue: 0.07)

struct WidgetItem: Decodable, Hashable {
    let t: String   // rubrik, till exempel "Besiktning"
    let d: String   // datum, ÅÅÅÅ-MM-DD
}

struct WidgetPayload: Decodable {
    let lang: String?
    let car: String?
    let fuel: Double?
    let items: [WidgetItem]?
}

struct CarEntry: TimelineEntry {
    let date: Date
    let data: WidgetPayload?
}

private func loadPayload() -> WidgetPayload? {
    guard let s = UserDefaults(suiteName: appGroup)?.string(forKey: "widget"),
          let d = s.data(using: .utf8) else { return nil }
    return try? JSONDecoder().decode(WidgetPayload.self, from: d)
}

private let sample = WidgetPayload(lang: "sv", car: "Volvo XC60", fuel: 64,
                                   items: [WidgetItem(t: "Service kl 08:30", d: "2026-11-20"),
                                           WidgetItem(t: "Besiktning", d: "2026-12-25")])

struct Provider: TimelineProvider {
    func placeholder(in context: Context) -> CarEntry { CarEntry(date: Date(), data: sample) }

    func getSnapshot(in context: Context, completion: @escaping (CarEntry) -> Void) {
        let data: WidgetPayload? = context.isPreview ? (loadPayload() ?? sample) : loadPayload()
        completion(CarEntry(date: Date(), data: data))
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<CarEntry>) -> Void) {
        // Dagarna kvar räknas om vid midnatt, även om appen inte öppnas.
        let cal = Calendar.current
        let midnight = cal.startOfDay(for: cal.date(byAdding: .day, value: 1, to: Date()) ?? Date())
        completion(Timeline(entries: [CarEntry(date: Date(), data: loadPayload())], policy: .after(midnight)))
    }
}

private let dayFormat: DateFormatter = {
    let f = DateFormatter()
    f.calendar = Calendar(identifier: .gregorian)
    f.locale = Locale(identifier: "en_US_POSIX")
    f.dateFormat = "yyyy-MM-dd"
    return f
}()

private func daysLeft(_ s: String, from now: Date) -> Int? {
    guard let d = dayFormat.date(from: s) else { return nil }
    let cal = Calendar.current
    return cal.dateComponents([.day], from: cal.startOfDay(for: now), to: cal.startOfDay(for: d)).day
}

private func whenText(_ days: Int, en: Bool) -> String {
    switch days {
    case 0: return en ? "Today" : "I dag"
    case 1: return en ? "Tomorrow" : "I morgon"
    default: return en ? "In \(days) days" : "Om \(days) dagar"
    }
}

struct Upcoming: Hashable {
    let title: String
    let days: Int
}

private func upcoming(_ p: WidgetPayload?, now: Date) -> [Upcoming] {
    (p?.items ?? []).compactMap { i in
        guard let n = daysLeft(i.d, from: now), n >= 0 else { return nil }
        return Upcoming(title: i.t, days: n)
    }.sorted { $0.days < $1.days }
}

struct FuelBar: View {
    let pct: Double
    var body: some View {
        let p = max(0, min(100, pct)) / 100
        // Röd när tanken är tom, gul vid halv tank och grön när den är full (samma som i appen).
        let color = p < 0.5
            ? Color(hue: (9 + (38 - 9) * p * 2) / 360, saturation: 0.68, brightness: 0.85)
            : Color(hue: (38 + (138 - 38) * (p - 0.5) * 2) / 360, saturation: 0.6, brightness: 0.62)
        GeometryReader { g in
            ZStack(alignment: .leading) {
                Capsule().fill(Color.primary.opacity(0.1))
                Capsule().fill(color).frame(width: max(8, g.size.width * p))
            }
        }
        .frame(height: 8)
    }
}

struct WidgetBody: View {
    @Environment(\.widgetFamily) var family
    let entry: CarEntry

    var body: some View {
        let p = entry.data
        let en = p?.lang == "en"
        let list = upcoming(p, now: entry.date)
        if p == nil {
            VStack(alignment: .leading, spacing: 6) {
                Text("Bildagboken").font(.headline).foregroundColor(orange)
                Text(en ? "Open the app to see what is coming up." : "Öppna appen för att se vad som är på gång.")
                    .font(.footnote).foregroundColor(.secondary)
                Spacer(minLength: 0)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        } else if family == .systemSmall {
            VStack(alignment: .leading, spacing: 4) {
                Text(p?.car ?? "").font(.caption).foregroundColor(.secondary).lineLimit(1)
                if let first = list.first {
                    Text(whenText(first.days, en: en)).font(.title3.weight(.bold)).foregroundColor(orange).lineLimit(1)
                    Text(first.title).font(.subheadline.weight(.semibold)).lineLimit(2)
                } else {
                    Text(en ? "Nothing coming up" : "Inget på gång").font(.subheadline.weight(.semibold))
                }
                Spacer(minLength: 0)
                if let f = p?.fuel {
                    HStack(spacing: 6) {
                        Image(systemName: "fuelpump.fill").font(.caption2).foregroundColor(.secondary)
                        FuelBar(pct: f)
                    }
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        } else {
            HStack(alignment: .top, spacing: 14) {
                VStack(alignment: .leading, spacing: 6) {
                    Text(p?.car ?? "").font(.subheadline.weight(.semibold)).lineLimit(2)
                    Spacer(minLength: 0)
                    if let f = p?.fuel {
                        Text(en ? "Fuel" : "Bränsle").font(.caption2).foregroundColor(.secondary)
                        Text("\(Int(f.rounded())) %").font(.title3.weight(.bold))
                        FuelBar(pct: f)
                    }
                }
                .frame(width: 104, alignment: .leading)
                VStack(alignment: .leading, spacing: 8) {
                    Text(en ? "Coming up" : "På gång").font(.caption.weight(.semibold)).foregroundColor(orange)
                    if list.isEmpty {
                        Text(en ? "Nothing coming up" : "Inget på gång").font(.footnote).foregroundColor(.secondary)
                    }
                    ForEach(Array(list.prefix(3)), id: \.self) { u in
                        VStack(alignment: .leading, spacing: 1) {
                            Text(u.title).font(.footnote.weight(.semibold)).lineLimit(1)
                            Text(whenText(u.days, en: en)).font(.caption2).foregroundColor(.secondary)
                        }
                    }
                    Spacer(minLength: 0)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
    }
}

struct BildagbokenWidgetView: View {
    let entry: CarEntry
    var body: some View {
        if #available(iOS 17.0, *) {
            WidgetBody(entry: entry).containerBackground(for: .widget) { Color(.systemBackground) }
        } else {
            WidgetBody(entry: entry).padding().background(Color(.systemBackground))
        }
    }
}

struct BildagbokenHomeWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "BildagbokenWidget", provider: Provider()) { entry in
            BildagbokenWidgetView(entry: entry)
        }
        .configurationDisplayName("Bildagboken")
        .description("Det som är på gång med bilen, och hur mycket som finns i tanken.")
        .supportedFamilies([.systemSmall, .systemMedium])
    }
}

// MARK: - Pågående resa (Live Activity)

// Samma struktur finns i TripTracker.swift i appen. iOS kopplar ihop dem via namnet, så de måste vara lika.
struct TripActivityAttributes: ActivityAttributes {
    struct ContentState: Codable, Hashable {
        var from: String
        var to: String
        var kind: String   // "tjanst", "privat" eller "" för en automatisk resa
        var km: Double     // körd sträcka enligt GPS
        var paused: Bool
        var since: Date?   // klockan räknar härifrån (starttiden plus pauserna)
        var elapsed: Double // sekunder, visas när resan är pausad
    }
    var tripId: String
    var start: Date
    var car: String
    var lang: String
}

// Klockan räknar uppåt från starttiden. iOS uppdaterar den själv varje sekund, även när appen är stängd.
// Pausad resa: klockan står still på tiden hittills.
@ViewBuilder
private func tripClock(_ c: ActivityViewContext<TripActivityAttributes>) -> some View {
    if c.state.paused {
        Text(elapsedText(c.state.elapsed)).monospacedDigit()
    } else {
        Text(timerInterval: (c.state.since ?? c.attributes.start)...Date.distantFuture, countsDown: false)
            .monospacedDigit()
    }
}

private func elapsedText(_ secs: Double) -> String {
    let t = max(0, Int(secs)), h = t / 3600, m = (t % 3600) / 60, s = t % 60
    return h > 0 ? String(format: "%d:%02d:%02d", h, m, s) : String(format: "%d:%02d", m, s)
}

// Sträckan: "12,4 km" (en decimal under 100 km).
private func kmText(_ km: Double, en: Bool) -> String {
    guard km >= 0.1 else { return "" }
    let nf = NumberFormatter()
    nf.locale = Locale(identifier: en ? "en_US" : "sv_SE")
    nf.minimumFractionDigits = 0
    nf.maximumFractionDigits = km < 100 ? 1 : 0
    return (nf.string(from: NSNumber(value: km)) ?? "") + " km"
}

private func kindText(_ kind: String, en: Bool) -> String {
    if kind.isEmpty { return en ? "Automatic trip" : "Automatisk resa" }
    return kind == "privat" ? (en ? "Private" : "Privat") : (en ? "Business" : "Tjänsteresa")
}

private func subText(_ c: ActivityViewContext<TripActivityAttributes>, en: Bool) -> String {
    [c.attributes.car, kindText(c.state.kind, en: en)].filter { !$0.isEmpty }.joined(separator: " · ")
}

private func routeText(_ s: TripActivityAttributes.ContentState, en: Bool) -> String {
    if !s.to.isEmpty { return (en ? "To " : "Mot ") + s.to }
    if !s.from.isEmpty { return (en ? "From " : "Från ") + s.from }
    return en ? "Trip in progress" : "Resa pågår"
}

// Avsluta öppnar appen direkt på formuläret Avsluta resan, där man fyller i mätarställningen.
private let endTripURL = URL(string: "https://bildagboken.com/?ny=avsluta-resa")!

private func endButton(en: Bool) -> some View {
    Link(destination: endTripURL) {
        HStack(spacing: 6) {
            RoundedRectangle(cornerRadius: 2).fill(Color.white).frame(width: 10, height: 10)
            Text(en ? "End trip" : "Avsluta").font(.subheadline.weight(.semibold)).foregroundColor(.white)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 8)
        .background(Capsule().fill(orange))
    }
}

struct TripLockScreenView: View {
    let context: ActivityViewContext<TripActivityAttributes>
    var body: some View {
        let en = context.attributes.lang == "en"
        HStack(spacing: 12) {
            ZStack {
                Circle().fill(orange)
                Image(systemName: "car.fill").font(.system(size: 18, weight: .semibold)).foregroundColor(.white)
            }
            .frame(width: 42, height: 42)
            VStack(alignment: .leading, spacing: 2) {
                Text(context.state.paused ? (en ? "Paused" : "Pausad") : (en ? "Trip in progress" : "Resa pågår")).font(.caption.weight(.semibold)).foregroundColor(orange)
                Text(routeText(context.state, en: en)).font(.subheadline.weight(.semibold)).lineLimit(1)
                Text(subText(context, en: en))
                    .font(.caption).foregroundColor(.secondary).lineLimit(1)
            }
            Spacer(minLength: 8)
            VStack(alignment: .trailing, spacing: 6) {
                tripClock(context)
                    .font(.title2.weight(.bold))
                    .multilineTextAlignment(.trailing)
                    .frame(width: 96, alignment: .trailing)
                if !kmText(context.state.km, en: en).isEmpty {
                    Text(kmText(context.state.km, en: en)).font(.subheadline.weight(.semibold)).monospacedDigit()
                }
                if context.attributes.tripId != "auto" { endButton(en: en) }
            }
        }
        .padding(16)
    }
}

struct TripLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: TripActivityAttributes.self) { context in
            TripLockScreenView(context: context)
                .activityBackgroundTint(Color(.systemBackground))
                .activitySystemActionForegroundColor(orange)
        } dynamicIsland: { context in
            let en = context.attributes.lang == "en"
            return DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    Label(en ? "Trip" : "Resa", systemImage: "car.fill")
                        .font(.subheadline.weight(.semibold)).foregroundColor(orange)
                }
                DynamicIslandExpandedRegion(.trailing) {
                    tripClock(context)
                        .font(.title3.weight(.bold))
                        .multilineTextAlignment(.trailing)
                        .frame(width: 90, alignment: .trailing)
                }
                DynamicIslandExpandedRegion(.bottom) {
                    HStack(spacing: 10) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(routeText(context.state, en: en)).font(.subheadline.weight(.semibold)).lineLimit(1)
                            Text([subText(context, en: en), kmText(context.state.km, en: en)].filter { !$0.isEmpty }.joined(separator: " · "))
                                .font(.caption).foregroundColor(.secondary).lineLimit(1)
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        if context.attributes.tripId != "auto" { endButton(en: en) }
                    }
                }
            } compactLeading: {
                Image(systemName: "car.fill").foregroundColor(orange)
            } compactTrailing: {
                tripClock(context)
                    .font(.caption.weight(.semibold))
                    .multilineTextAlignment(.trailing)
                    .frame(maxWidth: 52)
            } minimal: {
                Image(systemName: "car.fill").foregroundColor(orange)
            }
            .keylineTint(orange)
        }
    }
}

@main
struct BildagbokenWidgets: WidgetBundle {
    var body: some Widget {
        BildagbokenHomeWidget()
        TripLiveActivity()
    }
}
