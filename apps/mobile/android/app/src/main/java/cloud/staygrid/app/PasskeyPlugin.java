package cloud.staygrid.app;

import android.os.CancellationSignal;
import androidx.annotation.NonNull;
import androidx.core.content.ContextCompat;
import androidx.credentials.CreateCredentialResponse;
import androidx.credentials.CreatePublicKeyCredentialRequest;
import androidx.credentials.CreatePublicKeyCredentialResponse;
import androidx.credentials.Credential;
import androidx.credentials.CredentialManager;
import androidx.credentials.CredentialManagerCallback;
import androidx.credentials.GetCredentialRequest;
import androidx.credentials.GetCredentialResponse;
import androidx.credentials.GetPublicKeyCredentialOption;
import androidx.credentials.PublicKeyCredential;
import androidx.credentials.exceptions.CreateCredentialCancellationException;
import androidx.credentials.exceptions.CreateCredentialException;
import androidx.credentials.exceptions.GetCredentialCancellationException;
import androidx.credentials.exceptions.GetCredentialException;
import androidx.credentials.exceptions.NoCredentialException;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Passkeys von app.staygrid.cloud in der App (Vertrag `NativePasskey` in
 * `@hotelpms/native`).
 *
 * Die WebView laeuft unter `https://localhost`, und dort bietet Android
 * keinen Passkey dieser Domain an. Credential Manager tut es fuer die App
 * selbst, aber nur, wenn app.staygrid.cloud sie in assetlinks.json mit dem
 * Fingerabdruck ihres Zertifikats nennt. In der Antwort steht dann als
 * Herkunft `android:apk-key-hash:…`, und genau die nimmt die Schnittstelle
 * an (APP_ANDROID_ZERTIFIKATE in @hotelpms/contracts).
 *
 * Optionen und Antwort sind WebAuthn als JSON-Text, in der Form, die
 * Schnittstelle und Credential Manager beide schreiben; hier wird nichts
 * umgebaut und nichts geprueft. Abbruch und „kein Passkey“ melden sich mit
 * demselben Code -- im Browser sind beide ein `NotAllowedError`, und die
 * Oberflaeche zeigt dann nur einen Hinweis.
 */
@CapacitorPlugin(name = "StaygridPasskey")
public class PasskeyPlugin extends Plugin {
    private static final String ABGEBROCHEN = "abgebrochen";

    @PluginMethod
    public void vorlegen(PluginCall call) {
        String optionen = call.getString("optionen");
        if (optionen == null) {
            call.reject("Optionen fehlen");
            return;
        }
        GetCredentialRequest anfrage = new GetCredentialRequest.Builder()
            .addCredentialOption(new GetPublicKeyCredentialOption(optionen))
            .build();
        CredentialManager.create(getContext()).getCredentialAsync(getActivity(), anfrage,
            new CancellationSignal(), ContextCompat.getMainExecutor(getContext()),
            new CredentialManagerCallback<GetCredentialResponse, GetCredentialException>() {
                @Override
                public void onResult(GetCredentialResponse r) {
                    Credential c = r.getCredential();
                    if (!(c instanceof PublicKeyCredential)) {
                        call.reject("Kein Passkey", ABGEBROCHEN);
                        return;
                    }
                    JSObject antwort = new JSObject();
                    antwort.put("antwort", ((PublicKeyCredential) c).getAuthenticationResponseJson());
                    call.resolve(antwort);
                }

                @Override
                public void onError(@NonNull GetCredentialException e) {
                    if (e instanceof GetCredentialCancellationException || e instanceof NoCredentialException) {
                        call.reject("Abgebrochen", ABGEBROCHEN);
                    } else {
                        // Typ und Meldung von Android, kein Bezug zu einer Person.
                        call.reject(e.getType() + ": " + e.getMessage());
                    }
                }
            });
    }

    @PluginMethod
    public void anlegen(PluginCall call) {
        String optionen = call.getString("optionen");
        if (optionen == null) {
            call.reject("Optionen fehlen");
            return;
        }
        CredentialManager.create(getContext()).createCredentialAsync(getActivity(),
            new CreatePublicKeyCredentialRequest(optionen),
            new CancellationSignal(), ContextCompat.getMainExecutor(getContext()),
            new CredentialManagerCallback<CreateCredentialResponse, CreateCredentialException>() {
                @Override
                public void onResult(CreateCredentialResponse r) {
                    if (!(r instanceof CreatePublicKeyCredentialResponse)) {
                        call.reject("Kein Passkey angelegt", ABGEBROCHEN);
                        return;
                    }
                    JSObject antwort = new JSObject();
                    antwort.put("antwort", ((CreatePublicKeyCredentialResponse) r).getRegistrationResponseJson());
                    call.resolve(antwort);
                }

                @Override
                public void onError(@NonNull CreateCredentialException e) {
                    if (e instanceof CreateCredentialCancellationException) {
                        call.reject("Abgebrochen", ABGEBROCHEN);
                    } else {
                        call.reject(e.getType() + ": " + e.getMessage());
                    }
                }
            });
    }
}
