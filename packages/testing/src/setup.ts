/**
 * Globale Testvorbereitung. Die Tests laufen gegen echtes PostgreSQL, nie
 * gegen Mocks: eine gemockte Datenbank testet die Zeilenrichtlinien, Trigger
 * und Sperren nicht, und genau dort liegt die Fachlichkeit.
 */
// .env laden, damit ein Lauf ohne vorbereitete Shell dasselbe tut wie einer
// mit. In CI stehen die Werte in der Umgebung, dort gibt es keine Datei.
try { process.loadEnvFile(new URL('../../../.env', import.meta.url).pathname) }
catch { /* keine .env: die Umgebung liefert die Werte */ }

/*
 * Die Tests bauen das Schema mit `DROP SCHEMA public CASCADE` neu auf und
 * leeren danach jede Fachtabelle. Gegen die Entwicklungsdatenbank heisst das:
 * Saatlauf und Testhotel sind weg, ohne Rueckfrage und ohne Fehlermeldung.
 *
 * Genau so ist es passiert. Hier stand einmal `if (testUrl)`: fehlte
 * TEST_DATABASE_URL, blieb DATABASE_URL aus der .env stehen, und die zeigte
 * auf hotelpms_dev, weil `.env.example` die Testvariablen nicht kannte. Ein
 * Rueckfall auf die Entwicklungsdatenbank ist deshalb kein Komfort, sondern
 * der Schaden selbst; ohne eigene Testdatenbank laeuft nichts.
 *
 * Verglichen wird nur der Datenbankname, nicht Rechner und Port.
 * `localhost` und `127.0.0.1` sind derselbe Server, ein Socketpfad auch, und
 * wer das alles gleichsetzen will, baut eine Pruefung, die an der naechsten
 * Schreibweise vorbeisieht. Zwei gleichnamige Datenbanken auf verschiedenen
 * Servern werden dafuer abgewiesen; das kostet eine umbenannte Variable,
 * die andere Richtung kostet die Daten.
 */
function databaseName(key: string, url: string): string {
  let name: string
  try {
    name = decodeURIComponent(new URL(url).pathname.replace(/^\//, ''))
  } catch {
    throw new Error(`${key} ist keine gueltige Verbindungsadresse.`)
  }
  // Ohne Namen waehlt PostgreSQL die Datenbank nach dem Benutzer -- welche
  // das ist, steht dann nirgends, und pruefen laesst es sich auch nicht.
  if (!name) throw new Error(`${key} nennt keine Datenbank.`)
  return name
}

const testUrl = process.env.TEST_DATABASE_URL
const ownerUrl = process.env.TEST_DATABASE_URL_OWNER
if (!testUrl || !ownerUrl) {
  throw new Error(
    'TEST_DATABASE_URL und TEST_DATABASE_URL_OWNER muessen gesetzt sein. Ohne sie liefen die '
    + 'Tests gegen DATABASE_URL, die Entwicklungsdatenbank, und leerten sie. Beide auf '
    + 'hotelpms_test setzen, wie in .env.example.')
}

const testDb = databaseName('TEST_DATABASE_URL', testUrl)
if (databaseName('TEST_DATABASE_URL_OWNER', ownerUrl) !== testDb) {
  // Sonst baut der Eigentuemer das Schema in der einen Datenbank auf, und
  // die Anwendungsrolle sucht es in der anderen.
  throw new Error('TEST_DATABASE_URL und TEST_DATABASE_URL_OWNER nennen verschiedene Datenbanken.')
}
for (const key of ['DATABASE_URL', 'DATABASE_URL_DIRECT', 'DATABASE_URL_OWNER']) {
  const url = process.env[key]
  if (url && databaseName(key, url) === testDb) {
    throw new Error(
      `Die Testdatenbank ${testDb} ist dieselbe wie in ${key}. Ein Testlauf loescht ihr Schema `
      + 'und alle Daten darin. TEST_DATABASE_URL auf eine eigene Datenbank setzen (hotelpms_test).')
  }
}

process.env.DATABASE_URL = testUrl
process.env.DATABASE_URL_DIRECT = testUrl
process.env.DATABASE_URL_OWNER = ownerUrl

process.env.NODE_ENV = 'test'
process.env.LOG_LEVEL ??= 'silent'
process.env.SESSION_SECRET ??= 'test-secret-mindestens-zweiunddreissig-zeichen'
process.env.ID_DOCUMENT_KEY ??= 'test-key-mindestens-zweiunddreissig-zeichen!!'
