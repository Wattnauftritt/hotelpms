import tseslint from 'typescript-eslint'
import importX from 'eslint-plugin-import-x'

/**
 * Modulgrenzen nach Dokument 10, Abschnitt 3:
 *   api -> modules -> platform. Niemals rueckwaerts, niemals quer
 *   zwischen Modulen ohne oeffentliche Schnittstelle.
 * Durchgesetzt hier, nicht per Absprache.
 */
export default tseslint.config(
  { ignores: ['**/dist/**', '**/dist-app/**', '**/node_modules/**', '**/*.config.js',
               // Die App: zusammengesetzte Baue und die nativen Projekte,
               // in die Capacitor seine eigenen Skripte kopiert.
               'apps/mobile/www/**', 'apps/mobile/dist-bruecke/**',
               'apps/mobile/android/**', 'apps/mobile/ios/**'] },
  ...tseslint.configs.recommended,
  {
    plugins: { 'import-x': importX },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-floating-promises': 'off',
      'no-restricted-imports': ['error', {
        patterns: [
          {
            group: ['**/modules/*/[!i]*', '**/modules/*/internal/**'],
            message: 'Module nur ueber ihre index.ts ansprechen, nie ueber interne Pfade.'
          },
          {
            group: ['**/api/**'],
            message: 'platform und modules duerfen nicht auf api zugreifen.'
          }
        ]
      }]
    }
  },
  {
    files: ['packages/db/**/*.ts', 'apps/**/*.ts'],
    rules: { '@typescript-eslint/no-explicit-any': 'warn' }
  },
  {
    // Ein Kanaladapter geht nur ueber kanalAbruf() ins Netz: feste Ziele,
    // Zeitgrenze, Groessengrenze (Bedrohungsanalyse 23.10.2026, T10). Ein
    // eigenes fetch() mit der Adresse aus den Zugangsdaten waere ein Weg fuer
    // Anfragefaelschung vom Server aus.
    files: ['apps/worker/src/channel/**/*.ts'],
    ignores: ['apps/worker/src/channel/abruf.ts'],
    rules: {
      'no-restricted-globals': ['error', {
        name: 'fetch', message: 'Kanaladapter rufen ueber kanalAbruf() aus channel/abruf.ts ab.'
      }]
    }
  }
)
