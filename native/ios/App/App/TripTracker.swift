// Automatisk körjournal: känner av när bilen körs och mäter vägen med GPS, även när appen är stängd.
//
// Så fungerar det:
// 1. När funktionen är påslagen bevakar iOS "betydande platsändringar" (ungefär 500 meter). Det drar nästan
//    inget batteri, och iOS väcker appen i bakgrunden när telefonen har flyttat sig.
//    Där bilen parkerades bevakas också ett område på 150 meter, så att appen väcks direkt när bilen kör iväg.
// 2. Då slås noggrann GPS på en stund. Går det fortare än 18 km/h räknas det som en resa, och vägen mäts.
//    iOS meddelar också när man lämnar ett ställe man har varit på en stund (besök), och en genväg
//    ("När bilen ansluts" i appen Genvägar) kan starta mätningen direkt när telefonen kopplas till bilen.
//    Resan räknas från där bilen stod parkerad, inte från där GPS:en hann vakna, så att början inte försvinner.
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
import AVFoundation
import AppIntents

final class TripTracker: NSObject, CLLocationManagerDelegate, UNUserNotificationCenterDelegate, NotificationHandlerProtocol {
    static let shared = TripTracker()

    let manager = CLLocationManager()
    private let defaults = UserDefaults.standard
    private let enabledKey = "autoTrips.enabled"
    private let tripsKey = "autoTrips.list"
    private let kindsKey = "autoTrips.kinds"    // resans id → "tjanst" eller "privat", valt i notisen
    private let placesKey = "autoTrips.places"  // sparade platser från webbappen: name, lat, lon
    private let langKey = "autoTrips.lang"
    private let parkedKey = "autoTrips.parked"  // där senaste resan slutade: lat, lon, time
    private let parkedRegion = "bildagboken.parked"
    private let logKey = "autoTrips.log"        // senaste händelserna, för felsökning i appen
    private var path: [CLLocationCoordinate2D] = []  // vägen under resan, en punkt ungefär var 75:e meter
    private var carName: String?                // bilens Bluetooth eller CarPlay under resan
    private var carConnected = false            // genvägen "Bilen är ansluten" har körts
    private var lastRouteCheck = Date.distantPast
    static let category = "AUTO_TRIP_DONE"
    static let manualKey = "autoTrips.manualSince"  // starttid (ms) för en resa man har startat själv i appen
    static let manualEndKey = "autoTrips.manualEnded"  // när den resan avslutades (ms)

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

    // Kort logg över vad som har hänt (väckt, resa startad, avbrutet), som visas under Felsökning i appen.
    func log(_ text: String) {
        var list = defaults.array(forKey: logKey) as? [[String: Any]] ?? []
        list.append(["t": Date().timeIntervalSince1970 * 1000, "m": text])
        if list.count > 40 { list.removeFirst(list.count - 40) }
        defaults.set(list, forKey: logKey)
    }

    // Anropas när appen startar, även när iOS startar den i bakgrunden för en platsändring.
    func resumeIfEnabled(background: Bool = false) {
        if enabled {
            if background { log("Appen startades i bakgrunden av iOS") }
            startMonitoring()
        }
    }

    // Genvägen "Bilen är ansluten" (Bluetooth eller CarPlay): titta noga direkt, och längre än vanligt.
    func carDidConnect() {
        guard enabled else { return }
        carConnected = true
        log("Bilen ansluten (genväg)")
        if watching { watchStarted = Date() } else { startWatching() }
    }
    // Genvägen "Bilen är frånkopplad": resan avslutas efter en kort stund stilla i stället för fyra minuter.
    func carDidDisconnect() {
        guard enabled else { return }
        carConnected = false
        log("Bilen frånkopplad (genväg)")
        if driving { quickStop = true }
    }
    private var quickStop = false

    // MARK: - Egen resa (Starta resa i appen): GPS mäter sträckan medan resan pågår, även i bakgrunden.
    private let manualMetersKey = "autoTrips.manualMeters"
    private(set) var manualId: String?
    private var manualPaused = false
    private var manualLast: CLLocation?
    private var lastActivityPush = Date.distantPast
    var manualMeters: Double {
        get { defaults.double(forKey: manualMetersKey) }
        set { defaults.set(newValue, forKey: manualMetersKey) }
    }
    func manualStart(id: String, paused: Bool) {
        if manualId != id {
            if defaults.string(forKey: "autoTrips.manualId") != id { manualMeters = 0 }
            defaults.set(id, forKey: "autoTrips.manualId")
            manualId = id
            manualLast = nil
            log("Egen resa: GPS mäter sträckan")
        }
        manualPaused = paused
        if paused { manualLast = nil }
        manager.startUpdatingLocation()
    }
    func manualStop() {
        guard manualId != nil else { return }
        manualId = nil
        manualLast = nil
        defaults.removeObject(forKey: "autoTrips.manualId")
        if !watching { manager.stopUpdatingLocation() }
    }
    private func manualHandle(_ loc: CLLocation) {
        guard !manualPaused, loc.horizontalAccuracy >= 0, loc.horizontalAccuracy <= 50 else { return }
        if let prev = manualLast {
            let d = loc.distance(from: prev)
            // Små hopp när bilen står still är GPS-brus.
            if d >= 15 || loc.speed > 1.5 { manualMeters += d; manualLast = loc }
        } else { manualLast = loc }
        pushActivityKm(manualMeters, auto: false)
    }

    // Sträckan i rutan på låsskärmen och i Dynamic Island, högst var 15:e sekund.
    private func pushActivityKm(_ meters: Double, auto: Bool) {
        guard #available(iOS 16.2, *), Date().timeIntervalSince(lastActivityPush) > 15 else { return }
        lastActivityPush = Date()
        let km = (meters / 100).rounded() / 10
        Task { @MainActor in
            for a in Activity<TripActivityAttributes>.activities where (a.attributes.tripId == "auto") == auto {
                var st = a.content.state
                guard st.km != km else { continue }
                st.km = km
                await a.update(ActivityContent(state: st, staleDate: nil))
            }
        }
    }
    // Automatisk resa: en ruta på låsskärmen medan den pågår (om iOS tillåter det just då), borta när den är klar.
    private func startAutoActivity() {
        guard #available(iOS 16.2, *), manualId == nil, ActivityAuthorizationInfo().areActivitiesEnabled else { return }
        guard Activity<TripActivityAttributes>.activities.isEmpty else { return }
        let attrs = TripActivityAttributes(tripId: "auto", start: startTime ?? Date(), car: carName ?? "", lang: en ? "en" : "sv")
        let st = TripActivityAttributes.ContentState(from: "", to: "", kind: "", km: (meters / 100).rounded() / 10, paused: false, since: nil, elapsed: 0)
        _ = try? Activity.request(attributes: attrs, content: ActivityContent(state: st, staleDate: nil), pushType: nil)
    }
    private func endAutoActivity() {
        guard #available(iOS 16.2, *) else { return }
        Task { @MainActor in
            for a in Activity<TripActivityAttributes>.activities where a.attributes.tripId == "auto" { await a.end(nil, dismissalPolicy: .immediate) }
        }
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
        manager.stopMonitoringVisits()
        for r in manager.monitoredRegions where r.identifier == parkedRegion { manager.stopMonitoring(for: r) }
        stopWatching()
        resetTrip()
    }

    private func startMonitoring() {
        guard CLLocationManager.significantLocationChangeMonitoringAvailable() else { return }
        manager.startMonitoringSignificantLocationChanges()
        manager.startMonitoringVisits()
        if let p = parked { watchParked(p) } else if let here = manager.location { watchParked(here) }
    }

    // Där bilen står parkerad. Används som resans start, och ett område runt den väcker appen när bilen kör iväg.
    private var parked: CLLocation? {
        guard let d = defaults.dictionary(forKey: parkedKey), let lat = d["lat"] as? Double, let lon = d["lon"] as? Double,
              let t = d["time"] as? Double else { return nil }
        return CLLocation(coordinate: CLLocationCoordinate2D(latitude: lat, longitude: lon), altitude: 0,
                          horizontalAccuracy: (d["acc"] as? Double) ?? 20, verticalAccuracy: -1, timestamp: Date(timeIntervalSince1970: t))
    }
    private func setParked(_ loc: CLLocation) {
        defaults.set(["lat": loc.coordinate.latitude, "lon": loc.coordinate.longitude, "acc": loc.horizontalAccuracy,
                      "time": loc.timestamp.timeIntervalSince1970], forKey: parkedKey)
        watchParked(loc)
    }
    private func watchParked(_ loc: CLLocation) {
        guard CLLocationManager.isMonitoringAvailable(for: CLCircularRegion.self) else { return }
        let region = CLCircularRegion(center: loc.coordinate, radius: 150, identifier: parkedRegion)
        region.notifyOnExit = true
        region.notifyOnEntry = false
        manager.startMonitoring(for: region)
    }

    private func startWatching() {
        guard !watching else { return }
        log("GPS på, letar efter en bilresa")
        watching = true
        watchStarted = Date()
        manager.startUpdatingLocation()
    }

    private func stopWatching() {
        guard watching else { return }
        watching = false
        // Pågår en egen resa fortsätter GPS:en, den behövs för sträckan.
        if manualId == nil { manager.stopUpdatingLocation() }
    }

    private func resetTrip() {
        driving = false
        quickStop = false
        path = []
        carName = nil
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
        for loc in locations {
            if manualId != nil { manualHandle(loc) }
            if enabled { handle(loc) }
        }
    }

    // Telefonen har lämnat parkeringen: titta noga direkt, i stället för att vänta på nästa platsändring.
    func locationManager(_ m: CLLocationManager, didExitRegion region: CLRegion) {
        guard enabled, region.identifier == parkedRegion else { return }
        log("Lämnade parkeringen")
        startWatching()
    }

    // Ett besök är slut (man har lämnat ett ställe där man har varit en stund): kanske på väg att köra.
    func locationManager(_ m: CLLocationManager, didVisit visit: CLVisit) {
        guard enabled, visit.departureDate != .distantFuture else { return }
        log("Lämnade ett besök")
        startWatching()
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
                // GPS:en vaknar oftast en bit in i resan. Står bilen parkerad i närheten (inom 3 km) och har
                // den stått där sedan förra resan, räknas resan därifrån och sträckan dit läggs till.
                if let p = parked, let first = startLoc, p.timestamp < now {
                    let gap = first.distance(from: p)
                    if gap > 40, gap < 3000 {
                        meters += gap * 1.15 // vägen är sällan rak; ungefär 15 % längre än fågelvägen
                        startLoc = p
                        startTime = min(watchStarted, now)
                    } else if gap <= 40 {
                        startLoc = p
                    }
                }
                lastMove = now
                path = [startLoc?.coordinate ?? loc.coordinate, loc.coordinate]
                checkCar(force: true)
                log("Resa startad")
                startAutoActivity()
            } else if now.timeIntervalSince(watchStarted) > (carConnected ? 900 : giveUpAfter) {
                log("Ingen bilresa, GPS av")
                stopWatching()
                // Ett nytt område där telefonen är nu, så att appen väcks igen så fort den flyttar sig.
                watchParked(loc)
            }
            lastLoc = loc
            return
        }

        if let prev = lastLoc {
            let d = loc.distance(from: prev)
            // Små hopp när bilen står still är GPS-brus och räknas inte.
            if d >= 10 || speed > 1.5 { meters += d; lastLoc = loc }
            if let last = path.last, CLLocation(latitude: last.latitude, longitude: last.longitude).distance(from: loc) >= 75, path.count < 3000 {
                path.append(loc.coordinate)
            }
        } else {
            lastLoc = loc
        }
        if speed > 1.5 { lastMove = now }
        checkCar(force: false)
        if manualId == nil { pushActivityKm(meters, auto: true) }
        if now.timeIntervalSince(lastMove) > (quickStop ? 45 : stopAfter) { finishTrip(end: lastLoc ?? loc) }
    }

    // Bilens Bluetooth eller CarPlay, om telefonen är kopplad till den. Kollas högst var 30:e sekund.
    private func checkCar(force: Bool) {
        guard force || Date().timeIntervalSince(lastRouteCheck) > 30 else { return }
        lastRouteCheck = Date()
        let kinds: [AVAudioSession.Port] = [.carAudio, .bluetoothA2DP, .bluetoothHFP, .bluetoothLE]
        if let out = AVAudioSession.sharedInstance().currentRoute.outputs.first(where: { kinds.contains($0.portType) }) {
            carName = out.portType == .carAudio ? "CarPlay: \(out.portName)" : out.portName
        }
    }

    // Vägen som en kort textsträng (samma format som Google använder för linjer på kartor).
    private func encodePath(_ pts: [CLLocationCoordinate2D]) -> String {
        var out = "", pLat = 0, pLon = 0
        func enc(_ v: Int) {
            var x = v < 0 ? ~(v << 1) : (v << 1)
            while x >= 0x20 { out.append(Character(UnicodeScalar(UInt8((0x20 | (x & 0x1f)) + 63)))); x >>= 5 }
            out.append(Character(UnicodeScalar(UInt8(x + 63))))
        }
        for c in pts {
            let lat = Int((c.latitude * 1e5).rounded()), lon = Int((c.longitude * 1e5).rounded())
            enc(lat - pLat); enc(lon - pLon); pLat = lat; pLon = lon
        }
        return out
    }

    private func finishTrip(end: CLLocation) {
        defer { resetTrip(); stopWatching(); setParked(end); endAutoActivity() }
        guard let start = startTime, let from = startLoc, meters >= minMeters else {
            log("Kort förflyttning, sparas inte (\(Int(meters)) m)")
            return
        }
        log("Resa klar, \(Int(meters / 100) / 10) km")
        var trip: [String: Any] = [
            "id": UUID().uuidString,
            "start": start.timeIntervalSince1970 * 1000,
            "end": lastMove.timeIntervalSince1970 * 1000,
            "startLat": from.coordinate.latitude, "startLon": from.coordinate.longitude,
            "endLat": end.coordinate.latitude, "endLon": end.coordinate.longitude,
            "meters": meters.rounded(),
        ]
        var pts = path
        if let lastPt = pts.last, CLLocation(latitude: lastPt.latitude, longitude: lastPt.longitude).distance(from: end) > 5 { pts.append(end.coordinate) }
        if pts.count >= 2 { trip["path"] = encodePath(pts) }
        if let car = carName { trip["car"] = car }
        var list = defaults.array(forKey: tripsKey) as? [[String: Any]] ?? []
        list.append(trip)
        if list.count > 300 { list.removeFirst(list.count - 300) }
        defaults.set(list, forKey: tripsKey)
        // Pågår en resa som man har startat själv sparas GPS-punkterna till den, men ingen notis skickas.
        // Även om den nyss avslutades: bilen står ofta still några minuter innan GPS-resan räknas som slut.
        if let since = defaults.object(forKey: TripTracker.manualKey) as? Double, since <= lastMove.timeIntervalSince1970 * 1000,
           lastMove.timeIntervalSince1970 * 1000 - since < 12 * 3600 * 1000 { return }
        if let ended = defaults.object(forKey: TripTracker.manualEndKey) as? Double, ended >= start.timeIntervalSince1970 * 1000 { return }
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
        nf.minimumFractionDigits = 0
        nf.maximumFractionDigits = 0
        let km = nf.string(from: NSNumber(value: (meters / 1000).rounded())) ?? ""
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
        parts.append("\(km) km")
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

    // Bilens Bluetooth eller CarPlay just nu, så att appen kan erbjuda att koppla den till en bil.
    func currentCarRoute() -> String? {
        let kinds: [AVAudioSession.Port] = [.carAudio, .bluetoothA2DP, .bluetoothHFP, .bluetoothLE]
        guard let out = AVAudioSession.sharedInstance().currentRoute.outputs.first(where: { kinds.contains($0.portType) }) else { return nil }
        return out.portType == .carAudio ? "CarPlay: \(out.portName)" : out.portName
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
        r["watching"] = watching
        if let id = manualId ?? defaults.string(forKey: "autoTrips.manualId") { r["manualId"] = id; r["manualMeters"] = manualMeters.rounded() }
        r["log"] = defaults.array(forKey: logKey) as? [[String: Any]] ?? []
        if let name = currentCarRoute() { r["carNow"] = name }
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
        let t = call.getObject("trip")
        let id = t?["id"] as? String
        let startMs = (t?["start"] as? Double) ?? (t?["start"] as? NSNumber)?.doubleValue
        // En resa man har startat själv: den automatiska körjournalen skickar då ingen notis om samma resa.
        if id != nil, let ms = startMs { UserDefaults.standard.set(ms, forKey: TripTracker.manualKey) }
        else if UserDefaults.standard.object(forKey: TripTracker.manualKey) != nil {
            UserDefaults.standard.removeObject(forKey: TripTracker.manualKey)
            UserDefaults.standard.set(Date().timeIntervalSince1970 * 1000, forKey: TripTracker.manualEndKey)
        }
        let paused = (t?["paused"] as? Bool) ?? false
        let sinceMs = (t?["since"] as? Double) ?? (t?["since"] as? NSNumber)?.doubleValue
        let elapsed = (t?["elapsed"] as? Double) ?? (t?["elapsed"] as? NSNumber)?.doubleValue ?? 0
        // Egen resa: GPS mäter sträckan medan den pågår (pausad: ingen mätning).
        DispatchQueue.main.async {
            if let id = id { TripTracker.shared.manualStart(id: id, paused: paused) } else { TripTracker.shared.manualStop() }
        }
        guard #available(iOS 16.2, *) else { call.resolve(["supported": false]); return }
        let state = TripActivityAttributes.ContentState(
            from: t?["from"] as? String ?? "", to: t?["to"] as? String ?? "", kind: t?["kind"] as? String ?? "tjanst",
            km: (TripTracker.shared.manualMeters / 100).rounded() / 10, paused: paused,
            since: sinceMs.map { Date(timeIntervalSince1970: $0 / 1000) }, elapsed: elapsed)
        let car = t?["car"] as? String ?? ""
        let lang = t?["lang"] as? String ?? "sv"
        Task { @MainActor in
            var kept = false
            for a in Activity<TripActivityAttributes>.activities {
                // Den automatiska resans ruta sköts av TripTracker, så länge ingen egen resa pågår.
                if a.attributes.tripId == "auto" && id == nil { continue }
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


// MARK: - Genvägar: "Bilen är ansluten" och "Bilen är frånkopplad"
// Syns i appen Genvägar. Med en automation (När Bluetooth/CarPlay ansluts → Bilen är ansluten) startar
// mätningen direkt när man sätter sig i bilen, och resan sparas med bilens namn.

@available(iOS 16.0, *)
struct CarConnectedIntent: AppIntent {
    static var title: LocalizedStringResource = "Bilen är ansluten"
    static var description = IntentDescription("Startar den automatiska körjournalen direkt. Använd i en automation när telefonen ansluts till bilens Bluetooth eller CarPlay.")
    static var openAppWhenRun: Bool = false
    @MainActor
    func perform() async throws -> some IntentResult {
        TripTracker.shared.carDidConnect()
        return .result()
    }
}

@available(iOS 16.0, *)
struct CarDisconnectedIntent: AppIntent {
    static var title: LocalizedStringResource = "Bilen är frånkopplad"
    static var description = IntentDescription("Avslutar en pågående automatisk resa snabbare. Använd i en automation när telefonen kopplas från bilen.")
    static var openAppWhenRun: Bool = false
    @MainActor
    func perform() async throws -> some IntentResult {
        TripTracker.shared.carDidDisconnect()
        return .result()
    }
}
