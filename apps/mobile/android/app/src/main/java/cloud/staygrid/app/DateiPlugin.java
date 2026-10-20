package cloud.staygrid.app;

import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.net.Uri;
import android.util.Base64;
import androidx.core.content.FileProvider;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileOutputStream;

/**
 * Eine Datei der Oberflaeche zeigen und weitergeben (Beleg, Export,
 * Meldedatei; Vertrag `NativeDatei` in `@hotelpms/native`).
 *
 * Die WebView laedt nichts herunter und zeigt kein PDF. Die Datei kommt
 * deshalb in den Cache der App und geht an die App des Telefons, die sie
 * anzeigen kann; von dort wird gedruckt und geteilt. Kann keine sie
 * anzeigen (eine CSV ohne Tabellenprogramm), bietet das Telefon das Teilen
 * an. Im Cache liegt immer nur die letzte Datei: in einer Rechnung steht
 * ein Gast, und sie soll nicht liegen bleiben, bis Android aufraeumt.
 */
@CapacitorPlugin(name = "StaygridDatei")
public class DateiPlugin extends Plugin {
    @PluginMethod
    public void oeffnen(PluginCall call) {
        String daten = call.getString("daten");
        String name = call.getString("name");
        String typ = call.getString("typ", "application/octet-stream");
        if (daten == null || name == null) {
            call.reject("Datei fehlt");
            return;
        }
        Uri adresse;
        try {
            File ordner = new File(getContext().getCacheDir(), "dateien");
            leeren(ordner);
            if (!ordner.isDirectory() && !ordner.mkdirs()) throw new IllegalStateException("Cache");
            File ziel = new File(ordner, name.replaceAll("[/\\\\]", "_"));
            try (FileOutputStream aus = new FileOutputStream(ziel)) {
                aus.write(Base64.decode(daten, Base64.DEFAULT));
            }
            adresse = FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", ziel);
        } catch (Exception e) {
            call.reject("Datei nicht ablegbar");
            return;
        }
        Intent zeigen = new Intent(Intent.ACTION_VIEW)
            .setDataAndType(adresse, typ)
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        try {
            getActivity().startActivity(zeigen);
        } catch (ActivityNotFoundException keine) {
            Intent teilen = new Intent(Intent.ACTION_SEND)
                .setType(typ)
                .putExtra(Intent.EXTRA_STREAM, adresse)
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            getActivity().startActivity(Intent.createChooser(teilen, name));
        }
        call.resolve();
    }

    private static void leeren(File ordner) {
        File[] alte = ordner.listFiles();
        if (alte == null) return;
        for (File f : alte) {
            //noinspection ResultOfMethodCallIgnored
            f.delete();
        }
    }
}
