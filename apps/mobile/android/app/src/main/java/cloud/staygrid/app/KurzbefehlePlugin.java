package cloud.staygrid.app;

import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import androidx.core.content.pm.ShortcutInfoCompat;
import androidx.core.content.pm.ShortcutManagerCompat;
import androidx.core.graphics.drawable.IconCompat;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.util.ArrayList;
import java.util.List;
import org.json.JSONObject;

/**
 * Schnellaktionen am App-Symbol (Plan app/plan.md, „Schnellaktionen“; Sven,
 * 20.10.2026).
 *
 * Welche es gibt, entscheidet die Oberflaeche nach den Rechten der Person
 * und setzt sie nach dem Anmelden; nach dem Abmelden ist die Liste leer.
 * Hier steht nur, wie Android sie zeigt und wie ein Tippen zurueck in die
 * Seite kommt. Eine Aktion traegt einen Pfad dieser App und sonst nichts:
 * eine Adresse von aussen wird daraus nie, auch nicht ueber eine Liste, die
 * eine fremde Seite setzen wollte.
 *
 * Eine eigene Erweiterung neben `StaygridHuelle`, damit eine Huelle ohne sie
 * die Pakete weiter annimmt (keine neue Fassung): die Bruecke fragt, ob es
 * sie gibt.
 */
@CapacitorPlugin(name = "StaygridKurzbefehle")
public class KurzbefehlePlugin extends Plugin {
    static final String PFAD = "cloud.staygrid.app.KURZBEFEHL";

    private static KurzbefehlePlugin aktiv;
    private static String wartend;

    /** Aus MainActivity: ein Start oder ein Wechsel ueber eine Schnellaktion. */
    static void ausIntent(Intent intent) {
        if (intent == null) return;
        String pfad = intent.getStringExtra(PFAD);
        if (!erlaubt(pfad)) return;
        // Nur einmal: dreht man das Telefon, kaeme dieselbe Absicht wieder.
        intent.removeExtra(PFAD);
        if (aktiv != null) aktiv.melden(pfad);
        else wartend = pfad;
    }

    static boolean erlaubt(String pfad) {
        return pfad != null && pfad.length() <= 200 && pfad.startsWith("/") && !pfad.startsWith("//");
    }

    @Override
    public void load() {
        aktiv = this;
        if (wartend != null) {
            melden(wartend);
            wartend = null;
        }
    }

    private void melden(String pfad) {
        JSObject daten = new JSObject();
        daten.put("pfad", pfad);
        // Bis die Bruecke zuhoert: beim Kaltstart kommt das Tippen vor ihr.
        notifyListeners("gewaehlt", daten, true);
    }

    @PluginMethod
    public void setzen(PluginCall call) {
        JSArray liste = call.getArray("liste", new JSArray());
        Context k = getContext();
        List<ShortcutInfoCompat> aktionen = new ArrayList<>();
        try {
            int grenze = Math.min(liste.length(), ShortcutManagerCompat.getMaxShortcutCountPerActivity(k));
            for (int i = 0; i < grenze; i++) {
                JSONObject a = liste.getJSONObject(i);
                String id = a.getString("id");
                String titel = a.getString("titel");
                String pfad = a.getString("pfad");
                if (!erlaubt(pfad) || titel.isEmpty()) continue;
                Intent absicht = new Intent(Intent.ACTION_VIEW, Uri.parse("staygrid://kurzbefehl/" + id),
                    k, MainActivity.class);
                absicht.putExtra(PFAD, pfad);
                absicht.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP);
                aktionen.add(new ShortcutInfoCompat.Builder(k, id)
                    .setShortLabel(titel)
                    .setIcon(IconCompat.createWithResource(k, symbol(a.optString("symbol"))))
                    .setIntent(absicht)
                    .setRank(i)
                    .build());
            }
        } catch (Exception e) {
            call.reject("Liste unlesbar", e);
            return;
        }
        ShortcutManagerCompat.removeAllDynamicShortcuts(k);
        if (!aktionen.isEmpty()) ShortcutManagerCompat.setDynamicShortcuts(k, aktionen);
        call.resolve();
    }

    /** Symbole aus Android selbst: einfarbig, wie der Starter sie erwartet. */
    private static int symbol(String name) {
        switch (name) {
            case "kalender": return android.R.drawable.ic_menu_month;
            case "heute": return android.R.drawable.ic_menu_today;
            case "kasse": return android.R.drawable.ic_menu_agenda;
            case "kamera": return android.R.drawable.ic_menu_camera;
            case "pruefen": return android.R.drawable.ic_menu_view;
            case "plan": return android.R.drawable.ic_menu_sort_by_size;
            case "zimmer": return android.R.drawable.ic_menu_mylocation;
            case "eintragen": return android.R.drawable.ic_menu_edit;
            case "kueche": return android.R.drawable.ic_menu_recent_history;
            default: return android.R.drawable.ic_menu_recent_history;
        }
    }
}
