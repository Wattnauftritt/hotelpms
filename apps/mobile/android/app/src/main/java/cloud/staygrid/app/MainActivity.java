package cloud.staygrid.app;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

/**
 * Die Huelle der StayGrid-App (Plan app/plan.md, Baustein 3).
 *
 * Eigene Erweiterungen werden hier angemeldet, vor dem Start der Bruecke,
 * und nicht als Paket eingebunden: sie sind klein, und an der Stelle, die
 * das Token der Sitzung haelt, soll niemand anderes Code ausliefern als wir.
 */
public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(SitzungPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
