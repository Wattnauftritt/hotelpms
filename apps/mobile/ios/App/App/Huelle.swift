import Capacitor
import FirebaseCore
import Foundation
import LocalAuthentication
import Security
import UIKit
import Vision

/// Die Huelle der StayGrid-App (Plan app/plan.md, Baustein 3): dieselbe
/// WebView wie Capacitor, dazu die eigenen Erweiterungen.
///
/// Eigene Erweiterungen werden hier angemeldet und nicht als Paket
/// eingebunden. Sie sind klein, und an der Stelle, die das Token der
/// Sitzung haelt, soll niemand anderes Code ausliefern als wir.
class MainViewController: CAPBridgeViewController {
    private var sperre: AppSperre?

    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(SitzungPlugin())
        bridge?.registerPluginInstance(TexterkennungPlugin())
        bridge?.registerPluginInstance(DateiPlugin())
        bridge?.registerPluginInstance(HuellePlugin())
        sperre = AppSperre(ansicht: view)
    }
}

/// Die Sperre ueber einer laufenden Sitzung (Plan app/plan.md, Abschnitt 5;
/// Sven, 20.10.2026: „eingeloggt bleiben … Biometrie … wie normale Apps“).
///
/// Die App bleibt angemeldet, oeffnet sich aber beim Start und nach fuenf
/// Minuten im Hintergrund nur mit Face ID, Touch ID oder dem Code des
/// Telefons. Eine Sperre, kein Anmeldeweg: das Token liegt weiter im
/// Schluesselbund, der Server erfaehrt von der Sperre nichts, und Kennwort
/// und Mailadresse aendern verlangen weiter das Kennwort.
///
/// Schon beim Wechsel in den Hintergrund liegt die Decke ueber der Seite:
/// das Bild, das iOS im App-Umschalter zeigt, entsteht in diesem Moment, und
/// es soll keine Gastliste zeigen.
///
/// Hat das Telefon selbst keine Sperre, gibt es nichts, womit sich die App
/// sperren liesse; dann oeffnet sie sich ohne Abfrage wie bisher.
final class AppSperre {
    private static let frist: TimeInterval = 5 * 60

    private weak var ansicht: UIView?
    private var deckel: UIView?
    private var gesperrt: Bool
    private var fragtGerade = false
    private var hintergrundSeit: Date?

    private static var deutsch: Bool {
        Locale.preferredLanguages.first?.hasPrefix("de") ?? false
    }

    init(ansicht: UIView) {
        self.ansicht = ansicht
        gesperrt = SitzungPlugin.vorhanden()
        if gesperrt { zudecken() }
        let zentrale = NotificationCenter.default
        zentrale.addObserver(forName: UIScene.willDeactivateNotification, object: nil, queue: .main) { [weak self] _ in
            guard let self, !self.fragtGerade, SitzungPlugin.vorhanden() else { return }
            self.zudecken()
        }
        zentrale.addObserver(forName: UIScene.didEnterBackgroundNotification, object: nil, queue: .main) { [weak self] _ in
            self?.hintergrundSeit = Date()
        }
        zentrale.addObserver(forName: UIScene.didActivateNotification, object: nil, queue: .main) { [weak self] _ in
            self?.aufgewacht()
        }
    }

    private func aufgewacht() {
        if fragtGerade { return }
        if let seit = hintergrundSeit, Date().timeIntervalSince(seit) > Self.frist,
           SitzungPlugin.vorhanden() {
            gesperrt = true
        }
        hintergrundSeit = nil
        if gesperrt { entsperren() } else { aufdecken() }
    }

    @objc private func entsperren() {
        let kontext = LAContext()
        var fehler: NSError?
        guard kontext.canEvaluatePolicy(.deviceOwnerAuthentication, error: &fehler) else {
            gesperrt = false
            aufdecken()
            return
        }
        fragtGerade = true
        kontext.evaluatePolicy(.deviceOwnerAuthentication,
                               localizedReason: Self.deutsch ? "StayGrid entsperren" : "Unlock StayGrid") { ok, _ in
            DispatchQueue.main.async {
                self.fragtGerade = false
                if ok {
                    self.gesperrt = false
                    self.aufdecken()
                }
            }
        }
    }

    private func zudecken() {
        guard deckel == nil, let ansicht else { return }
        let decke = UIView()
        decke.translatesAutoresizingMaskIntoConstraints = false
        decke.backgroundColor = .systemBackground
        let knopf = UIButton(type: .system)
        knopf.setImage(UIImage(systemName: "lock.fill"), for: .normal)
        knopf.setTitle(Self.deutsch ? "  Entsperren" : "  Unlock", for: .normal)
        knopf.titleLabel?.font = .preferredFont(forTextStyle: .headline)
        knopf.addTarget(self, action: #selector(entsperren), for: .touchUpInside)
        knopf.translatesAutoresizingMaskIntoConstraints = false
        decke.addSubview(knopf)
        NSLayoutConstraint.activate([
            knopf.centerXAnchor.constraint(equalTo: decke.centerXAnchor),
            knopf.centerYAnchor.constraint(equalTo: decke.centerYAnchor)
        ])
        // Ueber Kanten statt Rahmen: beim Start ist die Ansicht noch 0 x 0.
        ansicht.addSubview(decke)
        NSLayoutConstraint.activate([
            decke.topAnchor.constraint(equalTo: ansicht.topAnchor),
            decke.bottomAnchor.constraint(equalTo: ansicht.bottomAnchor),
            decke.leadingAnchor.constraint(equalTo: ansicht.leadingAnchor),
            decke.trailingAnchor.constraint(equalTo: ansicht.trailingAnchor)
        ])
        deckel = decke
    }

    private func aufdecken() {
        deckel?.removeFromSuperview()
        deckel = nil
    }
}

/// Visitenkarten im Geraet lesen, mit Vision (Plan app/plan.md, Abschnitt 7;
/// Vertrag `NativeTexterkennung` in `@hotelpms/native`).
///
/// Nur die Erkennung von iOS selbst, kein Dienst im Netz: der Scan sagt,
/// dass das Foto das Telefon nicht verlaesst. Zurueck gehen nur Zeilen mit
/// Lage, in Anteilen des aufrecht gedrehten Bildes; was davon Firma und
/// Anschrift ist, entscheidet die Oberflaeche (`visitenkarte.ts`), damit App
/// und Browser dasselbe vorschlagen.
@objc(TexterkennungPlugin)
public class TexterkennungPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "TexterkennungPlugin"
    public let jsName = "StaygridTexterkennung"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "erkennen", returnType: CAPPluginReturnPromise)
    ]

    @objc func erkennen(_ call: CAPPluginCall) {
        guard let roh = call.getString("bild"), let daten = Data(base64Encoded: roh),
              let bild = UIImage(data: daten), let cg = bild.cgImage else {
            call.reject("Bild nicht lesbar")
            return
        }
        let anfrage = VNRecognizeTextRequest { anfrage, fehler in
            if let fehler {
                call.reject(fehler.localizedDescription)
                return
            }
            let zeilen: [[String: Any]] = (anfrage.results as? [VNRecognizedTextObservation] ?? [])
                .compactMap { beobachtung in
                    guard let text = beobachtung.topCandidates(1).first?.string else { return nil }
                    // Vision zaehlt von unten links, die Oberflaeche von oben.
                    let r = beobachtung.boundingBox
                    return ["text": text, "oben": 1 - r.maxY, "unten": 1 - r.minY, "links": r.minX]
                }
            call.resolve(["zeilen": zeilen])
        }
        anfrage.recognitionLevel = .accurate
        anfrage.usesLanguageCorrection = true
        // Deutsch zuerst; was dieses iOS nicht kennt, faellt heraus, statt
        // die ganze Anfrage scheitern zu lassen (Deutsch erst ab iOS 16).
        let wunsch = ["de-DE", "en-US", "fr-FR", "it-IT", "es-ES", "nl-NL"]
        if let bekannt = try? anfrage.supportedRecognitionLanguages() {
            anfrage.recognitionLanguages = wunsch.filter { bekannt.contains($0) }
        }
        let auftrag = VNImageRequestHandler(cgImage: cg, orientation: CGImagePropertyOrientation(bild.imageOrientation))
        DispatchQueue.global(qos: .userInitiated).async {
            do {
                try auftrag.perform([anfrage])
            } catch {
                call.reject(error.localizedDescription)
            }
        }
    }
}

/// Eine Datei der Oberflaeche zeigen und weitergeben (Beleg, Export,
/// Meldedatei; Vertrag `NativeDatei` in `@hotelpms/native`).
///
/// Die WebView laedt nichts herunter. Die Datei kommt in einen eigenen
/// Ordner unter `tmp`, geschuetzt, solange das Telefon gesperrt ist, und
/// oeffnet sich in der Vorschau von iOS; deren Knopf zum Teilen druckt,
/// sichert in Dateien und schickt per Mail. Kann die Vorschau sie nicht
/// zeigen, kommt gleich das Teilen. Nach dem Schliessen der Vorschau, und
/// spaetestens beim naechsten Aufruf, ist die Datei wieder weg: in einer
/// Rechnung steht ein Gast.
@objc(DateiPlugin)
public class DateiPlugin: CAPPlugin, CAPBridgedPlugin, UIDocumentInteractionControllerDelegate {
    public let identifier = "DateiPlugin"
    public let jsName = "StaygridDatei"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "oeffnen", returnType: CAPPluginReturnPromise)
    ]

    private var vorschau: UIDocumentInteractionController?
    private var ordner: URL?

    @objc func oeffnen(_ call: CAPPluginCall) {
        guard let roh = call.getString("daten"), let daten = Data(base64Encoded: roh),
              let name = call.getString("name") else {
            call.reject("Datei fehlt")
            return
        }
        DispatchQueue.main.async {
            self.aufraeumen()
            let neu = FileManager.default.temporaryDirectory
                .appendingPathComponent(UUID().uuidString, isDirectory: true)
            do {
                try FileManager.default.createDirectory(at: neu, withIntermediateDirectories: true)
                let ziel = neu.appendingPathComponent(name.replacingOccurrences(of: "/", with: "_"))
                try daten.write(to: ziel, options: [.completeFileProtection])
                self.ordner = neu
                let v = UIDocumentInteractionController(url: ziel)
                v.delegate = self
                self.vorschau = v
                if !v.presentPreview(animated: true), let ansicht = self.bridge?.viewController?.view {
                    v.presentOptionsMenu(from: ansicht.bounds, in: ansicht, animated: true)
                }
                call.resolve()
            } catch {
                call.reject("Datei nicht ablegbar")
            }
        }
    }

    public func documentInteractionControllerViewControllerForPreview(
        _ controller: UIDocumentInteractionController) -> UIViewController {
        bridge?.viewController ?? UIViewController()
    }

    public func documentInteractionControllerDidEndPreview(_ controller: UIDocumentInteractionController) {
        aufraeumen()
    }

    private func aufraeumen() {
        if let alt = ordner { try? FileManager.default.removeItem(at: alt) }
        ordner = nil
        vorschau = nil
    }
}

extension CGImagePropertyOrientation {
    init(_ lage: UIImage.Orientation) {
        switch lage {
        case .up: self = .up
        case .upMirrored: self = .upMirrored
        case .down: self = .down
        case .downMirrored: self = .downMirrored
        case .left: self = .left
        case .leftMirrored: self = .leftMirrored
        case .right: self = .right
        case .rightMirrored: self = .rightMirrored
        @unknown default: self = .up
        }
    }
}

/// Das Token der Sitzung (Migration 0191) im Schluesselbund.
///
/// `AfterFirstUnlockThisDeviceOnly`: lesbar, sobald das Telefon nach dem
/// Einschalten einmal entsperrt war, und es wandert in keine Sicherung und
/// auf kein anderes Geraet. Wer das Telefon wechselt, meldet sich neu an.
///
/// Der Schluesselbund ueberlebt das Loeschen der App. Ohne den Vermerk in
/// den Einstellungen der App faende eine neu installierte App die Sitzung
/// von damals wieder -- auf einem Telefon, das inzwischen jemand anderes
/// haben kann. Fehlt der Vermerk, ist die App frisch, und ein altes Token
/// geht weg.
@objc(SitzungPlugin)
public class SitzungPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "SitzungPlugin"
    public let jsName = "StaygridSitzung"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "lesen", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "speichern", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "loeschen", returnType: CAPPluginReturnPromise)
    ]

    private static let vermerk = "staygrid.sitzung.angelegt"
    private var vermerk: String { Self.vermerk }

    private static func eintrag() -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: "cloud.staygrid.app.sitzung",
         kSecAttrAccount as String: "token"]
    }
    private func eintrag() -> [String: Any] { Self.eintrag() }

    /// Ob eine Sitzung abgelegt ist, ohne sie zu lesen: die Sperre braucht
    /// nur das. Ohne Sitzung steht die Anmeldung da, und vor der gibt es
    /// nichts zu sperren.
    static func vorhanden() -> Bool {
        guard UserDefaults.standard.bool(forKey: vermerk) else { return false }
        var abfrage = eintrag()
        abfrage[kSecReturnAttributes as String] = true
        return SecItemCopyMatching(abfrage as CFDictionary, nil) == errSecSuccess
    }

    @objc func lesen(_ call: CAPPluginCall) {
        if !UserDefaults.standard.bool(forKey: vermerk) {
            SecItemDelete(eintrag() as CFDictionary)
            call.resolve(["token": NSNull()])
            return
        }
        var abfrage = eintrag()
        abfrage[kSecReturnData as String] = true
        abfrage[kSecMatchLimit as String] = kSecMatchLimitOne
        var wert: AnyObject?
        let status = SecItemCopyMatching(abfrage as CFDictionary, &wert)
        if status == errSecSuccess, let daten = wert as? Data,
           let token = String(data: daten, encoding: .utf8) {
            call.resolve(["token": token])
        } else if status == errSecItemNotFound {
            call.resolve(["token": NSNull()])
        } else {
            call.reject("Schluesselbund: \(status)")
        }
    }

    @objc func speichern(_ call: CAPPluginCall) {
        guard let token = call.getString("token") else {
            call.reject("token fehlt")
            return
        }
        SecItemDelete(eintrag() as CFDictionary)
        var neu = eintrag()
        neu[kSecValueData as String] = Data(token.utf8)
        neu[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let status = SecItemAdd(neu as CFDictionary, nil)
        if status == errSecSuccess {
            UserDefaults.standard.set(true, forKey: vermerk)
            call.resolve()
        } else {
            call.reject("Schluesselbund: \(status)")
        }
    }

    @objc func loeschen(_ call: CAPPluginCall) {
        let status = SecItemDelete(eintrag() as CFDictionary)
        if status == errSecSuccess || status == errSecItemNotFound {
            call.resolve()
        } else {
            call.reject("Schluesselbund: \(status)")
        }
    }
}

/// Die Fassung dieser Huelle, fuer die Aktualisierung ohne Store (Plan §4).
///
/// Steht im nativen Code und nicht in der Bruecke, weil die Bruecke mit
/// jedem Paket vom Server mitwandert: sie wuesste nur, welche Huelle sie
/// braucht, nicht, welche sie hat. Steigt mit HUELLE in src/bruecke.ts; ein
/// Test in apps/web haelt beide Seiten und Android aneinander.
@objc(HuellePlugin)
public class HuellePlugin: CAPPlugin, CAPBridgedPlugin {
    static let huelle = 4
    public let identifier = "HuellePlugin"
    public let jsName = "StaygridHuelle"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "stand", returnType: CAPPluginReturnPromise)
    ]

    @objc func stand(_ call: CAPPluginCall) {
        // Benachrichtigungen nur mit Firebase: ohne GoogleService-Info.plist
        // (ein Bau ohne Secret) gaebe es keine Kennung, die der Server
        // erreichen koennte (AppDelegate).
        call.resolve(["huelle": HuellePlugin.huelle, "push": FirebaseApp.app() != nil])
    }
}
