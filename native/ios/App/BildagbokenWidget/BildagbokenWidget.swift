// Widget på hemskärmen: det som är på gång med bilen, och hur mycket som finns i tanken.
// Appen skriver datan (WidgetDataPlugin i SceneDelegate.swift) till den delade App Group-lagringen.
import WidgetKit
import SwiftUI

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

@main
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
