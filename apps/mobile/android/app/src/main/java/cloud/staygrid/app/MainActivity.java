package cloud.staygrid.app;

import android.os.Bundle;
import android.os.SystemClock;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.FrameLayout;
import androidx.annotation.NonNull;
import androidx.biometric.BiometricManager;
import androidx.biometric.BiometricPrompt;
import androidx.core.content.ContextCompat;
import com.getcapacitor.BridgeActivity;
import java.util.Locale;

/**
 * Die Huelle der StayGrid-App (Plan app/plan.md, Baustein 3).
 *
 * Eigene Erweiterungen werden hier angemeldet, vor dem Start der Bruecke,
 * und nicht als Paket eingebunden: sie sind klein, und an der Stelle, die
 * das Token der Sitzung haelt, soll niemand anderes Code ausliefern als wir.
 *
 * **Die Sperre** (Plan Abschnitt 5; Sven, 20.10.2026: „eingeloggt bleiben …
 * Biometrie … wie normale Apps“). Die App bleibt angemeldet, oeffnet sich
 * aber beim Start und nach fuenf Minuten im Hintergrund nur mit
 * Fingerabdruck, Gesicht oder der Sperre des Telefons. Eine Sperre, kein
 * Anmeldeweg: das Token bleibt im Keystore, der Server erfaehrt von ihr
 * nichts, und Kennwort und Mailadresse aendern verlangen weiter das
 * Kennwort. Hat das Telefon selbst keine Sperre, gibt es nichts, womit sich
 * die App sperren liesse; dann oeffnet sie sich wie bisher.
 *
 * `BIOMETRIC_WEAK | DEVICE_CREDENTIAL` statt `STRONG`: die Kombination mit
 * `STRONG` kennt Android 9 und 10 nicht, und ohne Rueckfall auf den Code
 * stuende jemand mit nassen Haenden an der Rezeption vor einer App, die
 * nicht aufgeht.
 */
public class MainActivity extends BridgeActivity {
    private static final long FRIST_MS = 5 * 60 * 1000;
    private static final int ERLAUBT =
        BiometricManager.Authenticators.BIOMETRIC_WEAK | BiometricManager.Authenticators.DEVICE_CREDENTIAL;

    private FrameLayout deckel;
    private boolean gesperrt;
    private boolean fragtGerade;
    private long hintergrundSeit = -1;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(SitzungPlugin.class);
        registerPlugin(TexterkennungPlugin.class);
        registerPlugin(DateiPlugin.class);
        registerPlugin(HuellePlugin.class);
        super.onCreate(savedInstanceState);
        // Zugedeckt wird erst in onResume: die Bruecke setzt ihre Ansicht
        // selbst, und eine Decke von vorher laege darunter oder waere weg.
        gesperrt = SitzungPlugin.vorhanden(this);
    }

    /**
     * Die Decke liegt schon beim Verlassen ueber der Seite: das Bild in der
     * Liste der offenen Apps entsteht in diesem Moment und soll keine
     * Gastliste zeigen.
     */
    @Override
    public void onPause() {
        super.onPause();
        if (!fragtGerade && SitzungPlugin.vorhanden(this)) zudecken();
    }

    @Override
    public void onStop() {
        super.onStop();
        if (!fragtGerade) hintergrundSeit = SystemClock.elapsedRealtime();
    }

    @Override
    public void onResume() {
        super.onResume();
        if (fragtGerade) return;
        if (hintergrundSeit >= 0 && SystemClock.elapsedRealtime() - hintergrundSeit > FRIST_MS
                && SitzungPlugin.vorhanden(this)) {
            gesperrt = true;
        }
        hintergrundSeit = -1;
        if (gesperrt) {
            zudecken();
            entsperren();
        } else {
            aufdecken();
        }
    }

    private static boolean deutsch() {
        return Locale.getDefault().getLanguage().equals("de");
    }

    private void entsperren() {
        if (BiometricManager.from(this).canAuthenticate(ERLAUBT) != BiometricManager.BIOMETRIC_SUCCESS) {
            gesperrt = false;
            aufdecken();
            return;
        }
        fragtGerade = true;
        BiometricPrompt abfrage = new BiometricPrompt(this, ContextCompat.getMainExecutor(this),
            new BiometricPrompt.AuthenticationCallback() {
                @Override
                public void onAuthenticationSucceeded(@NonNull BiometricPrompt.AuthenticationResult r) {
                    fragtGerade = false;
                    gesperrt = false;
                    aufdecken();
                }

                @Override
                public void onAuthenticationError(int code, @NonNull CharSequence text) {
                    // Abgebrochen: die Decke bleibt, ihr Knopf fragt erneut.
                    fragtGerade = false;
                }
            });
        abfrage.authenticate(new BiometricPrompt.PromptInfo.Builder()
            .setTitle(deutsch() ? "StayGrid entsperren" : "Unlock StayGrid")
            .setAllowedAuthenticators(ERLAUBT)
            .build());
    }

    private void zudecken() {
        if (deckel != null && deckel.getParent() != null) return;
        deckel = new FrameLayout(this);
        TypedValue farbe = new TypedValue();
        getTheme().resolveAttribute(android.R.attr.colorBackground, farbe, true);
        deckel.setBackgroundColor(farbe.data);
        // Nimmt jede Beruehrung, damit nichts zur Seite darunter durchgeht.
        deckel.setClickable(true);
        Button knopf = new Button(this);
        knopf.setText(deutsch() ? "Entsperren" : "Unlock");
        knopf.setOnClickListener(v -> entsperren());
        deckel.addView(knopf, new FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.CENTER));
        addContentView(deckel, new ViewGroup.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
    }

    private void aufdecken() {
        if (deckel == null) return;
        ViewGroup ueber = (ViewGroup) deckel.getParent();
        if (ueber != null) ueber.removeView(deckel);
        deckel = null;
    }
}
