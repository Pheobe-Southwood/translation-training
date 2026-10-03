/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/client/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        swiss: {
          red: '#E11D48',
          'red-dark': '#BE123C',
          'red-light': '#FFE4E6',
          black: '#09090B',
          charcoal: '#18181B',
          paper: '#F8F9FA',
          border: '#E4E4E7',
          subtle: '#71717A',
        }
      },
      fontFamily: {
        sans: [
          'Inter',
          '-apple-system',
          'BlinkMacSystemFont',
          '"Segoe UI"',
          'Roboto',
          'Helvetica',
          'Arial',
          'sans-serif'
        ],
        mono: [
          '"JetBrains Mono"',
          'ui-monospace',
          'SFMono-Regular',
          'Menlo',
          'Monaco',
          'Consolas',
          'monospace'
        ]
      }
    },
  },
  plugins: [],
}
