import Capacitor
import Foundation
import Security

/// Die Huelle der StayGrid-App (Plan app/plan.md, Baustein 3): dieselbe
/// WebView wie Capacitor, dazu die eigenen Erweiterungen.
///
/// Eigene Erweiterungen werden hier angemeldet und nicht als Paket
/// eingebunden. Sie sind klein, und an der Stelle, die das Token der
/// Sitzung haelt, soll niemand anderes Code ausliefern als wir.
class MainViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(SitzungPlugin())
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

    private let vermerk = "staygrid.sitzung.angelegt"

    private func eintrag() -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: "cloud.staygrid.app.sitzung",
         kSecAttrAccount as String: "token"]
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
