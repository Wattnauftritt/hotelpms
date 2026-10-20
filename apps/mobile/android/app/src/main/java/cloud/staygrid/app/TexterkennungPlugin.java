package cloud.staygrid.app;

import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Rect;
import android.util.Base64;
import androidx.exifinterface.media.ExifInterface;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.mlkit.vision.common.InputImage;
import com.google.mlkit.vision.text.Text;
import com.google.mlkit.vision.text.TextRecognition;
import com.google.mlkit.vision.text.TextRecognizer;
import com.google.mlkit.vision.text.latin.TextRecognizerOptions;
import java.io.ByteArrayInputStream;

/**
 * Visitenkarten im Geraet lesen, mit ML Kit (Plan app/plan.md, Abschnitt 7;
 * Vertrag `NativeTexterkennung` in `@hotelpms/native`).
 *
 * Die **gebuendelte** Erkennung (`com.google.mlkit:text-recognition`), nicht
 * die ueber Google Play nachgeladene und nicht die Cloud-API: das Modell
 * liegt in der App, und der Scan sagt, dass das Foto das Telefon nicht
 * verlaesst. Zurueck gehen nur Zeilen mit Lage in Bildpunkten des aufrecht
 * gedrehten Bildes; was davon Firma und Anschrift ist, entscheidet die
 * Oberflaeche (`visitenkarte.ts`), damit App und Browser dasselbe
 * vorschlagen.
 */
@CapacitorPlugin(name = "StaygridTexterkennung")
public class TexterkennungPlugin extends Plugin {
    /** Mehr Bildpunkte lesen nicht besser, kosten aber Speicher. */
    private static final int KANTE = 2560;

    @PluginMethod
    public void erkennen(PluginCall call) {
        String roh = call.getString("bild");
        if (roh == null) {
            call.reject("Bild fehlt");
            return;
        }
        byte[] daten;
        Bitmap bild;
        int drehung;
        try {
            daten = Base64.decode(roh, Base64.DEFAULT);
            BitmapFactory.Options masse = new BitmapFactory.Options();
            masse.inJustDecodeBounds = true;
            BitmapFactory.decodeByteArray(daten, 0, daten.length, masse);
            BitmapFactory.Options laden = new BitmapFactory.Options();
            laden.inSampleSize = 1;
            while (Math.max(masse.outWidth, masse.outHeight) / laden.inSampleSize > KANTE) {
                laden.inSampleSize *= 2;
            }
            bild = BitmapFactory.decodeByteArray(daten, 0, daten.length, laden);
            // Ein Kamerafoto liegt oft quer und sagt nur in den EXIF-Daten,
            // wie herum es gehoert.
            drehung = new ExifInterface(new ByteArrayInputStream(daten)).getRotationDegrees();
        } catch (Exception e) {
            call.reject("Bild nicht lesbar");
            return;
        }
        if (bild == null) {
            call.reject("Bild nicht lesbar");
            return;
        }
        TextRecognizer leser = TextRecognition.getClient(TextRecognizerOptions.DEFAULT_OPTIONS);
        leser.process(InputImage.fromBitmap(bild, drehung))
            .addOnSuccessListener(text -> {
                JSArray zeilen = new JSArray();
                for (Text.TextBlock block : text.getTextBlocks()) {
                    for (Text.Line zeile : block.getLines()) {
                        Rect r = zeile.getBoundingBox();
                        if (r == null) continue;
                        JSObject z = new JSObject();
                        z.put("text", zeile.getText());
                        z.put("oben", r.top);
                        z.put("unten", r.bottom);
                        z.put("links", r.left);
                        zeilen.put(z);
                    }
                }
                JSObject antwort = new JSObject();
                antwort.put("zeilen", zeilen);
                call.resolve(antwort);
            })
            .addOnFailureListener(e -> call.reject(e.getMessage()))
            .addOnCompleteListener(t -> leser.close());
    }
}
