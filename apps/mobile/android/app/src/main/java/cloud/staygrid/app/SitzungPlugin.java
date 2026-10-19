package cloud.staygrid.app;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;
import org.json.JSONObject;

/**
 * Das Token der Sitzung (Migration 0191), verschluesselt abgelegt.
 *
 * Der Schluessel liegt im Android Keystore und verlaesst ihn nie; in den
 * Einstellungen der App steht nur der verschluesselte Wert. Wer die Datei
 * kopiert -- aus einer Sicherung oder von einem gerooteten Telefon --, hat
 * damit kein Token. Laesst sich der Wert nicht mehr entschluesseln (der
 * Schluessel ist nach einer Ruecksetzung weg), gilt das wie keine Sitzung:
 * der Benutzer meldet sich neu an.
 */
@CapacitorPlugin(name = "StaygridSitzung")
public class SitzungPlugin extends Plugin {
    private static final String SCHLUESSEL = "staygrid-sitzung";
    private static final String DATEI = "staygrid_sitzung";
    private static final String FELD = "token";
    private static final int IV_LAENGE = 12;

    private SharedPreferences ablage() {
        return getContext().getSharedPreferences(DATEI, Context.MODE_PRIVATE);
    }

    private SecretKey schluessel() throws Exception {
        KeyStore speicher = KeyStore.getInstance("AndroidKeyStore");
        speicher.load(null);
        if (speicher.containsAlias(SCHLUESSEL)) {
            return ((KeyStore.SecretKeyEntry) speicher.getEntry(SCHLUESSEL, null)).getSecretKey();
        }
        KeyGenerator erzeuger = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        erzeuger.init(new KeyGenParameterSpec.Builder(SCHLUESSEL,
                KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256)
            .build());
        return erzeuger.generateKey();
    }

    @PluginMethod
    public void lesen(PluginCall call) {
        JSObject antwort = new JSObject();
        String roh = ablage().getString(FELD, null);
        if (roh == null) {
            antwort.put(FELD, JSONObject.NULL);
            call.resolve(antwort);
            return;
        }
        try {
            byte[] alles = Base64.decode(roh, Base64.NO_WRAP);
            Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
            c.init(Cipher.DECRYPT_MODE, schluessel(), new GCMParameterSpec(128, alles, 0, IV_LAENGE));
            byte[] klar = c.doFinal(alles, IV_LAENGE, alles.length - IV_LAENGE);
            antwort.put(FELD, new String(klar, StandardCharsets.UTF_8));
        } catch (Exception e) {
            ablage().edit().remove(FELD).apply();
            antwort.put(FELD, JSONObject.NULL);
        }
        call.resolve(antwort);
    }

    @PluginMethod
    public void speichern(PluginCall call) {
        String token = call.getString(FELD);
        if (token == null) {
            call.reject("token fehlt");
            return;
        }
        try {
            Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
            c.init(Cipher.ENCRYPT_MODE, schluessel());
            byte[] iv = c.getIV();
            byte[] geheim = c.doFinal(token.getBytes(StandardCharsets.UTF_8));
            byte[] alles = new byte[iv.length + geheim.length];
            System.arraycopy(iv, 0, alles, 0, iv.length);
            System.arraycopy(geheim, 0, alles, iv.length, geheim.length);
            ablage().edit().putString(FELD, Base64.encodeToString(alles, Base64.NO_WRAP)).commit();
            call.resolve();
        } catch (Exception e) {
            call.reject("Keystore: " + e.getMessage());
        }
    }

    @PluginMethod
    public void loeschen(PluginCall call) {
        ablage().edit().remove(FELD).commit();
        call.resolve();
    }
}
