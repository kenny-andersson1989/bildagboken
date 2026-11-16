import UIKit
import Capacitor
import WidgetKit
import Speech
import AVFoundation

// Tar emot det som widgeten ska visa från webbappen (WidgetData.set i app.js) och sparar det
// i den delade App Group-lagringen, där widgeten läser det.
@objc(WidgetDataPlugin)
public class WidgetDataPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "WidgetDataPlugin"
    public let jsName = "WidgetData"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "set", returnType: CAPPluginReturnPromise)
    ]

    @objc func set(_ call: CAPPluginCall) {
        let json = call.getString("json") ?? ""
        UserDefaults(suiteName: "group.se.bildagboken.app")?.set(json, forKey: "widget")
        WidgetCenter.shared.reloadAllTimelines()
        call.resolve()
    }
}

// Diktering till Glenn i Fråga om bilen: Apples taligenkänning, eftersom webbvyn i appen saknar den.
// Webbappen anropar SpeechInput.start({ lang }) och får texten löpande i händelsen "partial" ({ text, final }).
// SpeechInput.stop() avslutar, och det sista resultatet kommer då som final.
@objc(SpeechInputPlugin)
public class SpeechInputPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "SpeechInputPlugin"
    public let jsName = "SpeechInput"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "available", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "start", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stop", returnType: CAPPluginReturnPromise),
    ]
    // En ny ljudmotor för varje gång man pratar. Efter att Glenn har läst upp ett svar har ljudet bytt läge
    // (uppspelning), och en gammal motor kan då fortsätta med fel ljudformat utan att något når taligenkänningen.
    private var engine = AVAudioEngine()
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private var recognizer: SFSpeechRecognizer?

    @objc func available(_ call: CAPPluginCall) {
        let r = SFSpeechRecognizer(locale: Locale(identifier: call.getString("lang") ?? "sv-SE"))
        call.resolve(["available": r?.isAvailable ?? false])
    }

    @objc func start(_ call: CAPPluginCall) {
        let lang = call.getString("lang") ?? "sv-SE"
        SFSpeechRecognizer.requestAuthorization { status in
            guard status == .authorized else {
                DispatchQueue.main.async { call.reject("Taligenkänning är inte tillåten.", "denied") }
                return
            }
            AVAudioSession.sharedInstance().requestRecordPermission { granted in
                DispatchQueue.main.async {
                    guard granted else { call.reject("Mikrofonen är inte tillåten.", "denied"); return }
                    do {
                        try self.begin(lang)
                        call.resolve()
                    } catch {
                        self.finish()
                        call.reject("Mikrofonen gick inte att starta.", "failed")
                    }
                }
            }
        }
    }

    @objc func stop(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.stopEngine()
            self.request?.endAudio()
            call.resolve()
        }
    }

    private func begin(_ lang: String) throws {
        finish()
        guard let rec = SFSpeechRecognizer(locale: Locale(identifier: lang)), rec.isAvailable else {
            throw NSError(domain: "SpeechInput", code: 1)
        }
        recognizer = rec
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.playAndRecord, mode: .measurement, options: [.defaultToSpeaker, .mixWithOthers])
        try session.setActive(true, options: .notifyOthersOnDeactivation)
        let req = SFSpeechAudioBufferRecognitionRequest()
        req.shouldReportPartialResults = true
        request = req
        engine = AVAudioEngine()
        let input = engine.inputNode
        input.removeTap(onBus: 0)
        // Formatet läses efter att ljudet har ställts om till inspelning, så att det stämmer med mikrofonen just nu.
        let format = input.outputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0 else { throw NSError(domain: "SpeechInput", code: 2) }
        input.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self] buffer, _ in
            self?.request?.append(buffer)
        }
        engine.prepare()
        try engine.start()
        task = rec.recognitionTask(with: req) { [weak self] result, error in
            DispatchQueue.main.async {
                guard let self = self, self.request === req else { return }
                if let result = result {
                    self.notifyListeners("partial", data: ["text": result.bestTranscription.formattedString, "final": result.isFinal])
                    if result.isFinal { self.finish() }
                } else if error != nil {
                    self.notifyListeners("partial", data: ["text": "", "final": true, "error": true])
                    self.finish()
                }
            }
        }
    }

    private func stopEngine() {
        if engine.isRunning { engine.stop() }
        engine.inputNode.removeTap(onBus: 0)
    }

    private func finish() {
        stopEngine()
        request = nil
        task?.cancel()
        task = nil
        // Tillbaka till uppspelning, så att Glenns svar hörs även på ljudlöst.
        try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .spokenAudio, options: [.mixWithOthers])
    }
}

// Samma vy som Capacitor, med widgetens tillägg inlagt.
class BridgeViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(WidgetDataPlugin())
        bridge?.registerPluginInstance(TripTrackerPlugin())
        bridge?.registerPluginInstance(TripActivityPlugin())
        bridge?.registerPluginInstance(SpeechInputPlugin())
        // Knapparna Tjänst och Privat i notisen efter en automatisk resa.
        bridge?.notificationRouter.localNotificationHandler = TripTracker.shared
    }
}

class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }

        window = UIWindow(windowScene: windowScene)
        window?.rootViewController = BridgeViewController()
        window?.makeKeyAndVisible()

        SceneDelegateProxy.shared.scene(scene, willConnectTo: session, options: connectionOptions)
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        SceneDelegateProxy.shared.scene(scene, openURLContexts: URLContexts)
    }

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        SceneDelegateProxy.shared.scene(scene, continue: userActivity)
    }
}
