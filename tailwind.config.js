/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        // Paleta Vício (roxo)
        vicio: {
          50: '#f5f0fb',
          100: '#e9def5',
          200: '#d3bdec',
          300: '#b694de',
          400: '#9467c9',
          500: '#7c46b3',
          600: '#672f96',
          700: '#52267a',
          800: '#3d1c5c',
          900: '#2a1342',
          950: '#180b26',
        },
        accent: {
          lime: '#c9f53b',
          rose: '#ff5e8a',
          cyan: '#4ad6e0',
          amber: '#ffb84d',
        },
        ink: {
          50: '#f7f7fb',
          100: '#edecf5',
          200: '#d6d3e5',
          300: '#adabc4',
          400: '#827f9c',
          500: '#5c5973',
          600: '#434057',
          700: '#2f2d3f',
          800: '#1d1b2a',
          900: '#12101c',
          950: '#08060f',
        },
      },
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        display: ['"Plus Jakarta Sans"', 'Inter', 'sans-serif'],
      },
      boxShadow: {
        'glow-vicio': '0 10px 40px -12px rgba(124, 70, 179, 0.45)',
        'soft': '0 8px 24px -12px rgba(29, 27, 42, 0.18)',
        'card': '0 1px 2px rgba(29, 27, 42, 0.04), 0 4px 16px -8px rgba(29, 27, 42, 0.08)',
      },
      backgroundImage: {
        'gradient-vicio': 'linear-gradient(135deg, #52267a 0%, #7c46b3 45%, #9467c9 100%)',
        'gradient-vicio-dark': 'linear-gradient(135deg, #2a1342 0%, #52267a 60%, #7c46b3 100%)',
        'gradient-surface': 'linear-gradient(180deg, #ffffff 0%, #f7f5fc 100%)',
        'gradient-surface-dark': 'linear-gradient(180deg, #12101c 0%, #1d1b2a 100%)',
      },
      keyframes: {
        shimmer: {
          '0%': { backgroundPosition: '-200% 0' },
          '100%': { backgroundPosition: '200% 0' },
        },
        'fade-up': {
          '0%': { opacity: 0, transform: 'translateY(8px)' },
          '100%': { opacity: 1, transform: 'translateY(0)' },
        },
      },
      animation: {
        shimmer: 'shimmer 2.5s linear infinite',
        'fade-up': 'fade-up 0.4s ease-out both',
      },
    },
  },
  plugins: [],
}
