// Automatisk körjournal: känner av när bilen körs och mäter vägen med GPS, även när appen är stängd.
//
// Så fungerar det:
// 1. När funktionen är påslagen bevakar iOS "betydande platsändringar" (ungefär 500 meter). Det drar nästan
//    inget batteri, och iOS väcker appen i bakgrunden när telefonen har flyttat sig.
// 2. Då slås noggrann GPS på en stund. Går det fortare än 18 km/h räknas det som en resa, och vägen mäts.
// 3. När bilen har stått still i fyra minuter är resan slut. Den sparas i telefonen och GPS:en stängs av.
// 4. Webbappen hämtar de sparade resorna (TripTracker.trips) och lägger in dem i körjournalen.
// 5. När en resa är klar kommer en notis med knapparna Tjänst och Privat. Det man trycker på sparas här och
//    följer med till körjournalen nästa gång appen öppnas. Sparade platser (Hem, Kontoret) ger namnen i notisen.
import Foundation
import UserNotifications
import CoreLocation
import Capacitor
import ActivityKit
import UIKit

final class TripTracker: NSObject, CLLocationManagerDelegate, UNUserNotificationCenterDelegate, NotificationHandlerProtocol {
    static let shared = TripTracker()

    let manager = CLLocationManager()
    private let defaults = UserDefaults.standard
    private let enabledKey = "autoTrips.enabled"
    private let tripsKey = "autoTrips.list"
    private let kindsKey = "autoTrips.kinds"    // resans id → "tjanst" eller "privat", valt i notisen
    private let placesKey = "autoTrips.places"  // sparade platser från webbappen: name, lat, lon
    private let langKey = "autoTrips.lang"
    static let category = "AUTO_TRIP_DONE"

    private let driveSpeed: CLLocationSpeed = 5      // m/s, ungefär 18 km/h
    private let stopAfter: TimeInterval = 240         // stilla så här länge = resan är slut
    private let giveUpAfter: TimeInterval = 180       // ingen körning inom så här lång tid = GPS av igen
    private let minMeters: CLLocationDistance = 500   // kortare än så sparas inte

    private var watching = false
    private var watchStarted = Date()
    private var driving = false
    private var startTime: Date?
    private var startLoc: CLLocation?
    private var lastLoc: CLLocation?
    private var lastMove = Date()
    private var meters: CLLocationDistance = 0

    var enabled: Bool { defaults.bool(forKey: enabledKey) }

    private override init() {
        super.init()
        manager.delegate = self
        manager.activityType = .automotiveNavigation
        manager.desiredAccuracy = kCLLocationAccuracyBest
        manager.distanceFilter = kCLDistanceFilterNone
        manager.pausesLocationUpdatesAutomatically = false
        manager.allowsBackgroundLocationUpdates = true
        manager.showsBackgroundLocationIndicator = false
        registerCategory()
    }

    private var en: Bool { defaults.string(forKey: langKey) == "en" }

    // Knapparna i notisen. Ingen av dem öppnar appen: valet sparas i bakgrunden.
    private func registerCategory() {
        let work = UNNotificationAction(identifier: "kind.tjanst", title: en ? "Business" : "Tjänst", options: [])
        let priv = UNNotificationAction(identifier: "kind.privat", title: en ? "Private" : "Privat", options: [])
        let cat = UNNotificationCategory(identifier: TripTracker.category, actions: [work, priv], intentIdentifiers: [], options: [])
        let center = UNUserNotificationCenter.current()
        center.getNotificationCategories { cats in
            var all = cats.filter { $0.identifier != TripTracker.category }
            all.insert(cat)
            center.setNotificationCategories(all)
        }
    }

    // Anropas när appen startar, även när iOS startar den i bakgrunden för en platsändring.
    func resumeIfEnabled() {
        if enabled { startMonitoring() }
    }

    func enable() {
        defaults.set(true, forKey: enabledKey)
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { _, _ in }
        switch manager.authorizationStatus {
        case .notDetermined: manager.requestWhenInUseAuthorization()
        case .authorizedWhenInUse: manager.requestAlwaysAuthorization()
        default: break
        }
        startMonitoring()
    }

    func disable() {
        defaults.set(false, forKey: enabledKey)
        manager.stopMonitoringSignificantLocationChanges()
        stopWatching()
        resetTrip()
    }

    private func startMonitoring() {
        guard CLLocationManager.significantLocationChangeMonitoringAvailable() else { return }
        manager.startMonitoringSignificantLocationChanges()
    }

    private func startWatching() {
        guard !watching else { return }
        watching = true
        watchStarted = Date()
        manager.startUpdatingLocation()
    }

    private func stopWatching() {
        guard watching else { return }
        watching = false
        manager.stopUpdatingLocation()
    }

    private func resetTrip() {
        driving = false
        startTime = nil
        startLoc = nil
        lastLoc = nil
        meters = 0
    }

    // MARK: - CLLocationManagerDelegate

    func locationManagerDidChangeAuthorization(_ m: CLLocationManager) {
        guard enabled else { return }
        // Först "När appen används", sedan frågar iOS om "Alltid", som behövs för att mäta i bakgrunden.
        if m.authorizationStatus == .authorizedWhenInUse { m.requestAlwaysAuthorization() }
        if m.authorizationStatus == .authorizedAlways || m.authorizationStatus == .authorizedWhenInUse { startMonitoring() }
    }

    func locationManager(_ m: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard enabled else { return }
        for loc in locations { handle(loc) }
    }

    func locationManager(_ m: CLLocationManager, didFailWithError error: Error) {
        // Tillfälliga fel (ingen GPS-signal) ignoreras. Nästa position kommer när det går.
    }

    private func handle(_ loc: CLLocation) {
        // En platsändring väcker appen: titta noga en stund för att se om det är en bilresa.
        if !watching { startWatching() }
        // Osäkra positioner (inomhus, i tunnlar) används inte.
        guard loc.horizontalAccuracy >= 0, loc.horizontalAccuracy <= 65 else { return }
        let now = loc.timestamp
        let speed = max(loc.speed, 0)

        if !driving {
            if speed >= driveSpeed {
                driving = true
                startTime = now
                startLoc = lastLoc ?? loc
                meters = lastLoc.map { loc.distance(from: $0) } ?? 0
                lastMove = now
            } else if now.timeIntervalSince(watchStarted) > giveUpAfter {
                stopWatching()
            }
            lastLoc = loc
            return
        }

        if let prev = lastLoc {
            let d = loc.distance(from: prev)
            // Små hopp när bilen står still är GPS-brus och räknas inte.
            if d >= 10 || speed > 1.5 { meters += d; lastLoc = loc }
        } else {
            lastLoc = loc
        }
        if speed > 1.5 { lastMove = now }
        if now.timeIntervalSince(lastMove) > stopAfter { finishTrip(end: lastLoc ?? loc) }
    }

    private func finishTrip(end: CLLocation) {
        defer { resetTrip(); stopWatching() }
        guard let start = startTime, let from = startLoc, meters >= minMeters else { return }
        let trip: [String: Any] = [
            "id": UUID().uuidString,
            "start": start.timeIntervalSince1970 * 1000,
            "end": lastMove.timeIntervalSince1970 * 1000,
            "startLat": from.coordinate.latitude, "startLon": from.coordinate.longitude,
            "endLat": end.coordinate.latitude, "endLon": end.coordinate.longitude,
            "meters": meters.rounded(),
        ]
        var list = defaults.array(forKey: tripsKey) as? [[String: Any]] ?? []
        list.append(trip)
        if list.count > 300 { list.removeFirst(list.count - 300) }
        defaults.set(list, forKey: tripsKey)
        notify(trip)
    }

    // MARK: - Notisen när en resa är klar

    private func placeName(_ lat: Double, _ lon: Double) -> String? {
        let here = CLLocation(latitude: lat, longitude: lon)
        var best: (String, CLLocationDistance)?
        for p in defaults.array(forKey: placesKey) as? [[String: Any]] ?? [] {
            guard let name = p["name"] as? String, let plat = p["lat"] as? Double, let plon = p["lon"] as? Double else { continue }
            let d = here.distance(from: CLLocation(latitude: plat, longitude: plon))
            if d <= 250, d < (best?.1 ?? .infinity) { best = (name, d) }
        }
        return best?.0
    }

    private func notify(_ trip: [String: Any]) {
        guard let id = trip["id"] as? String, let meters = trip["meters"] as? Double,
              let sLat = trip["startLat"] as? Double, let sLon = trip["startLon"] as? Double,
              let eLat = trip["endLat"] as? Double, let eLon = trip["endLon"] as? Double,
              let start = trip["start"] as? Double, let end = trip["end"] as? Double else { return }
        let nf = NumberFormatter()
        nf.locale = Locale(identifier: en ? "en_US" : "sv_SE")
        nf.minimumFractionDigits = 1
        nf.maximumFractionDigits = 1
        let mil = nf.string(from: NSNumber(value: (meters / 1000).rounded() / 10)) ?? ""
        let tf = DateFormatter()
        tf.dateFormat = "HH:mm"
        let times = "\(tf.string(from: Date(timeIntervalSince1970: start / 1000)))–\(tf.string(from: Date(timeIntervalSince1970: end / 1000)))"
        let route = [placeName(sLat, sLon), placeName(eLat, eLon)]
        let c = UNMutableNotificationContent()
        c.title = en ? "Trip finished. Business or private?" : "Resa klar. Tjänst eller privat?"
        var parts: [String] = []
        if route[0] != nil || route[1] != nil {
            parts.append("\(route[0] ?? (en ? "Start" : "Start")) → \(route[1] ?? (en ? "Destination" : "Mål"))")
        }
        parts.append("\(mil) mil")
        parts.append(times)
        c.body = parts.joined(separator: " · ")
        c.sound = .default
        c.categoryIdentifier = TripTracker.category
        c.userInfo = ["autoTripId": id]
        UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: "autotrip-\(id)", content: c, trigger: nil))
    }

    // Tjänst eller Privat i notisen: sparas med resan, och i en lista för resor som redan har hämtats till appen.
    private func setKind(_ id: String, _ kind: String) {
        var list = savedTrips()
        if let i = list.firstIndex(where: { ($0["id"] as? String) == id }) {
            list[i]["kind"] = kind
            defaults.set(list, forKey: tripsKey)
        }
        var kinds = defaults.dictionary(forKey: kindsKey) as? [String: String] ?? [:]
        kinds[id] = kind
        defaults.set(kinds, forKey: kindsKey)
    }

    private func handleResponse(_ response: UNNotificationResponse) -> Bool {
        let info = response.notification.request.content.userInfo
        guard response.notification.request.content.categoryIdentifier == TripTracker.category,
              let id = info["autoTripId"] as? String else { return false }
        if response.actionIdentifier == "kind.tjanst" { setKind(id, "tjanst") }
        if response.actionIdentifier == "kind.privat" { setKind(id, "privat") }
        return true
    }

    // Via Capacitor när appen är igång (SceneDelegate kopplar in den).
    func willPresent(notification: UNNotification) -> UNNotificationPresentationOptions {
        notification.request.content.categoryIdentifier == TripTracker.category ? [.banner, .list, .sound] : []
    }

    func didReceive(response: UNNotificationResponse) {
        _ = handleResponse(response)
    }

    // Direkt från iOS när appen startas i bakgrunden bara för knappen i notisen (AppDelegate).
    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
                                withCompletionHandler completionHandler: @escaping () -> Void) {
        _ = handleResponse(response)
        completionHandler()
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
                                withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler(willPresent(notification: notification))
    }

    // MARK: - För webbappen

    func setPlaces(_ places: [[String: Any]], lang: String) {
        let clean: [[String: Any]] = places.compactMap { p in
            guard let name = p["name"] as? String,
                  let lat = (p["lat"] as? Double) ?? (p["lat"] as? NSNumber)?.doubleValue,
                  let lon = (p["lon"] as? Double) ?? (p["lon"] as? NSNumber)?.doubleValue else { return nil }
            return ["name": name, "lat": lat, "lon": lon]
        }
        defaults.set(clean, forKey: placesKey)
        if lang != defaults.string(forKey: langKey) {
            defaults.set(lang, forKey: langKey)
            registerCategory()
        }
    }

    func savedKinds() -> [String: String] {
        defaults.dictionary(forKey: kindsKey) as? [String: String] ?? [:]
    }

    func savedTrips() -> [[String: Any]] {
        defaults.array(forKey: tripsKey) as? [[String: Any]] ?? []
    }

    func clear(_ ids: [String]) {
        let keep = savedTrips().filter { !ids.contains(($0["id"] as? String) ?? "") }
        defaults.set(keep, forKey: tripsKey)
        let kinds = savedKinds().filter { !ids.contains($0.key) }
        defaults.set(kinds, forKey: kindsKey)
    }

    func status() -> [String: Any] {
        let auth: String
        switch manager.authorizationStatus {
        case .authorizedAlways: auth = "always"
        case .authorizedWhenInUse: auth = "whenInUse"
        case .denied, .restricted: auth = "denied"
        default: auth = "notDetermined"
        }
        var r: [String: Any] = ["enabled": enabled, "auth": auth, "driving": driving, "pending": savedTrips().count,
                                "precise": manager.accuracyAuthorization == .fullAccuracy, "canAskAlways": true]
        if driving, let s = startTime {
            r["since"] = s.timeIntervalSince1970 * 1000
            r["meters"] = meters.rounded()
        }
        return r
    }
}

// Webbappen når den automatiska körjournalen via Capacitor: TripTracker.status/enable/disable/trips/clear.
@objc(TripTrackerPlugin)
public class TripTrackerPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "TripTrackerPlugin"
    public let jsName = "TripTracker"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "status", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "enable", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "disable", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "trips", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "clear", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setPlaces", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "askAlways", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "openSettings", returnType: CAPPluginReturnPromise),
    ]

    // Appens egen sida i telefonens Inställningar (Plats, Notiser och så vidare).
    static func openAppSettings() {
        if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
    }

    // "Tillåt Alltid": iOS visar rutan "Ändra till Alltid tillåt?" bara en gång. Visas den inte (appen blir inte
    // inaktiv inom en sekund) öppnas appens sida i Inställningar i stället, där man väljer Plats → Alltid.
    @objc func askAlways(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            let m = TripTracker.shared.manager
            switch m.authorizationStatus {
            case .notDetermined:
                m.requestWhenInUseAuthorization()
                call.resolve(["result": "prompted"])
            case .authorizedWhenInUse:
                var shown = false
                let obs = NotificationCenter.default.addObserver(forName: UIApplication.willResignActiveNotification, object: nil, queue: .main) { _ in shown = true }
                m.requestAlwaysAuthorization()
                DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) {
                    NotificationCenter.default.removeObserver(obs)
                    if shown { call.resolve(["result": "prompted"]) }
                    else { TripTrackerPlugin.openAppSettings(); call.resolve(["result": "settings"]) }
                }
            default:
                TripTrackerPlugin.openAppSettings()
                call.resolve(["result": "settings"])
            }
        }
    }

    @objc func openSettings(_ call: CAPPluginCall) {
        DispatchQueue.main.async { TripTrackerPlugin.openAppSettings(); call.resolve() }
    }

    @objc func status(_ call: CAPPluginCall) {
        DispatchQueue.main.async { call.resolve(TripTracker.shared.status()) }
    }

    @objc func enable(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            TripTracker.shared.enable()
            call.resolve(TripTracker.shared.status())
        }
    }

    @objc func disable(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            TripTracker.shared.disable()
            call.resolve(TripTracker.shared.status())
        }
    }

    @objc func trips(_ call: CAPPluginCall) {
        DispatchQueue.main.async { call.resolve(["trips": TripTracker.shared.savedTrips(), "kinds": TripTracker.shared.savedKinds()]) }
    }

    @objc func setPlaces(_ call: CAPPluginCall) {
        let places = (call.getArray("places") ?? []).compactMap { $0 as? [String: Any] }
        let lang = call.getString("lang") ?? "sv"
        DispatchQueue.main.async {
            TripTracker.shared.setPlaces(places, lang: lang)
            call.resolve()
        }
    }

    @objc func clear(_ call: CAPPluginCall) {
        let ids = (call.getArray("ids") ?? []).compactMap { $0 as? String }
        DispatchQueue.main.async {
            TripTracker.shared.clear(ids)
            call.resolve()
        }
    }
}

// MARK: - Pågående resa i Dynamic Island och på låsskärmen (Live Activity)


// Samma struktur finns i BildagbokenWidget.swift. iOS kopplar ihop dem via namnet, så de måste vara lika.
@available(iOS 16.1, *)
struct TripActivityAttributes: ActivityAttributes {
    struct ContentState: Codable, Hashable {
        var from: String
        var to: String
        var kind: String   // "tjanst" eller "privat"
    }
    var tripId: String
    var start: Date
    var car: String
    var lang: String
}

// Webbappen skickar den pågående resan (eller ingen) med TripActivity.sync. Klockan i Dynamic Island räknar
// själv utifrån starttiden, så den går även när appen är stängd. När resan avslutas försvinner rutan.
@objc(TripActivityPlugin)
public class TripActivityPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "TripActivityPlugin"
    public let jsName = "TripActivity"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "sync", returnType: CAPPluginReturnPromise),
    ]

    @objc func sync(_ call: CAPPluginCall) {
        guard #available(iOS 16.2, *) else { call.resolve(["supported": false]); return }
        let t = call.getObject("trip")
        let id = t?["id"] as? String
        let startMs = (t?["start"] as? Double) ?? (t?["start"] as? NSNumber)?.doubleValue
        let state = TripActivityAttributes.ContentState(
            from: t?["from"] as? String ?? "", to: t?["to"] as? String ?? "", kind: t?["kind"] as? String ?? "tjanst")
        let car = t?["car"] as? String ?? ""
        let lang = t?["lang"] as? String ?? "sv"
        Task { @MainActor in
            var kept = false
            for a in Activity<TripActivityAttributes>.activities {
                if let id = id, a.attributes.tripId == id, !kept {
                    kept = true
                    await a.update(ActivityContent(state: state, staleDate: nil))
                } else {
                    await a.end(nil, dismissalPolicy: .immediate)
                }
            }
            if !kept, let id = id, let ms = startMs, ActivityAuthorizationInfo().areActivitiesEnabled {
                let attrs = TripActivityAttributes(tripId: id, start: Date(timeIntervalSince1970: ms / 1000), car: car, lang: lang)
                _ = try? Activity.request(attributes: attrs, content: ActivityContent(state: state, staleDate: nil), pushType: nil)
            }
            call.resolve(["supported": true])
        }
    }
}
