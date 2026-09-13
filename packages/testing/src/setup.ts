/**
 * Globale Testvorbereitung. Die Tests laufen gegen echtes PostgreSQL, nie
 * gegen Mocks: eine gemockte Datenbank testet die Zeilenrichtlinien, Trigger
 * und Sperren nicht, und genau dort liegt die Fachlichkeit.
 */
const testUrl = process.env.TEST_DATABASE_URL
if (testUrl) {
  process.env.DATABASE_URL = testUrl
  process.env.DATABASE_URL_DIRECT = testUrl
}
const ownerUrl = process.env.TEST_DATABASE_URL_OWNER
if (ownerUrl) process.env.DATABASE_URL_OWNER = ownerUrl

process.env.NODE_ENV = 'test'
process.env.LOG_LEVEL ??= 'silent'
process.env.SESSION_SECRET ??= 'test-secret-mindestens-zweiunddreissig-zeichen'
process.env.ID_DOCUMENT_KEY ??= 'test-key-mindestens-zweiunddreissig-zeichen!!'
