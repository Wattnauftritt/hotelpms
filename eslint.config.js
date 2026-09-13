import tseslint from 'typescript-eslint'
import importX from 'eslint-plugin-import-x'

/**
 * Modulgrenzen nach Dokument 10, Abschnitt 3:
 *   api -> modules -> platform. Niemals rueckwaerts, niemals quer
 *   zwischen Modulen ohne oeffentliche Schnittstelle.
 * Durchgesetzt hier, nicht per Absprache.
 */
export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', '**/*.config.js'] },
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
  }
)
