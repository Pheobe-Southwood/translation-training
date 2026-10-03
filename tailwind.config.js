/** @type {import('tailwindcss').Config} */
export default {
  darkMode: 'class',
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
          'paper-dark': '#0c0d0e',
          border: '#E4E4E7',
          'border-dark': '#27272a',
          subtle: '#71717A',
          'subtle-dark': '#a1a1aa',
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
