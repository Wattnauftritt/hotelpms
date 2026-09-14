# Abfragen je Bereich

Neue Abfragen kommen hierher, eine Datei je Bereich (`booking.ts`, `rates.ts`,
`reports.ts`, …). **Nicht** in die bestehende `../queries.ts`.

Der Grund ist Arbeitsteilung, nicht Ordnungsliebe: an einer einzigen Datei
arbeiten drei Bearbeiter zwangsläufig an derselben Stelle, und jeder Merge
wird zur Handarbeit.

Zwei Regeln, die hier gelten:

**Ein Aufruf je Bildschirm, nicht je Zeile.** Die Endpunkte sind Aggregate.
Wer sie hier wieder auflöst und je Zeile nachlädt, macht aus einer Runde
vierhundert.

**Betriebslisten zusätzlich lokal halten.** `useCachedQuery` in `../queries.ts`
zeigt, wie: der letzte Stand ist sofort sichtbar und wird gleich nachgeladen.
Für alles, was die Rezeption auch bei Netzausfall sehen muss.
