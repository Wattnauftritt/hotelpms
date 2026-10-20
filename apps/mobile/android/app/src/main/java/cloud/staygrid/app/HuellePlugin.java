package cloud.staygrid.app;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Die Fassung dieser Huelle, fuer die Aktualisierung ohne Store (Plan §4).
 *
 * Steht im nativen Code und nicht in der Bruecke, weil die Bruecke mit
 * jedem Paket vom Server mitwandert: sie wuesste nur, welche Huelle sie
 * braucht, nicht, welche sie hat. Steigt mit HUELLE in src/bruecke.ts; ein
 * Test in apps/web haelt beide Seiten und iOS aneinander.
 */
@CapacitorPlugin(name = "StaygridHuelle")
public class HuellePlugin extends Plugin {
    static final int HUELLE = 4;

    @PluginMethod
    public void stand(PluginCall call) {
        JSObject antwort = new JSObject();
        antwort.put("huelle", HUELLE);
        call.resolve(antwort);
    }
}
