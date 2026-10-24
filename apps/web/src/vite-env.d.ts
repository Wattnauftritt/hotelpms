/// <reference types="vite/client" />

/** Die Lader der Sprachpakete, je Sprache ein `import()` (`lib/sprachpaketBau.ts`). */
declare module 'virtual:sprachpaket/*' {
  const lader: Record<string, () => Promise<{ default: Readonly<Record<string, string>> }>>
  export default lader
}
