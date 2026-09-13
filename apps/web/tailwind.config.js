export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Ein Zustand, eine Farbe, ueberall dieselbe. An der Rezeption wird
        // der Zimmerplan aus drei Metern Entfernung gelesen.
        status: {
          optional:  '#a78bfa',
          confirmed: '#60a5fa',
          inhouse:   '#34d399',
          departure: '#fbbf24',
          blocked:   '#9ca3af'
        }
      }
    }
  }
}
