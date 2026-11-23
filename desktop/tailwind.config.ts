import type { Config } from 'tailwindcss'

/**
 * AirBridge Pro design tokens.
 *
 * Every colour is a CSS variable (RGB triplet) defined in
 * src/renderer/styles.css, so the whole palette flips between the dark default
 * and the light scheme via `prefers-color-scheme` without `dark:` variants.
 * Spacing stays on Tailwind's 4px scale; layouts use multiples of 8.
 */
const v = (name: string) => `rgb(var(--${name}) / <alpha-value>)`

const config: Config = {
  content: {
    relative: true,
    files: ['./src/renderer/index.html', './src/renderer/**/*.{ts,tsx}']
  },
  theme: {
    extend: {
      colors: {
        canvas: v('canvas'),
        surface: { 1: v('surface-1'), 2: v('surface-2'), 3: v('surface-3') },
        line: v('line'),
        ink: { DEFAULT: v('ink'), muted: v('ink-muted'), faint: v('ink-faint') },
        accent: {
          DEFAULT: v('accent'),
          hover: v('accent-hover'),
          ink: v('accent-ink'),
          fg: v('accent-fg')
        },
        ok: { DEFAULT: v('ok'), dot: v('ok-dot') },
        warn: v('warn'),
        danger: v('danger')
      },
      fontFamily: {
        sans: [
          '-apple-system',
          'BlinkMacSystemFont',
          '"SF Pro Text"',
          '"SF Pro Display"',
          '"Segoe UI Variable Text"',
          '"Segoe UI Variable"',
          '"Segoe UI"',
          'system-ui',
          'Roboto',
          '"Helvetica Neue"',
          'Arial',
          'sans-serif'
        ],
        mono: [
          '"SF Mono"',
          'ui-monospace',
          'Menlo',
          '"Cascadia Code"',
          'Consolas',
          '"Liberation Mono"',
          'monospace'
        ]
      },
      fontSize: {
        '2xs': ['0.6875rem', { lineHeight: '1rem' }]
      },
      letterSpacing: {
        tightish: '-0.011em',
        display: '-0.022em'
      },
      boxShadow: {
        soft: '0 1px 2px rgb(0 0 0 / 0.18), 0 8px 24px -12px rgb(0 0 0 / 0.35)',
        lift: '0 2px 4px rgb(0 0 0 / 0.2), 0 24px 48px -16px rgb(0 0 0 / 0.5)',
        glow: '0 0 0 1px rgb(var(--accent) / 0.35), 0 12px 40px -8px rgb(var(--accent) / 0.45)',
        'inset-line': 'inset 0 1px 0 rgb(255 255 255 / 0.04)'
      },
      transitionTimingFunction: {
        calm: 'cubic-bezier(0.2, 0.8, 0.2, 1)'
      },
      keyframes: {
        'pulse-ring': {
          '0%': { transform: 'scale(1)', opacity: '0.55' },
          '80%, 100%': { transform: 'scale(2.6)', opacity: '0' }
        },
        enter: {
          from: { opacity: '0', transform: 'translateY(6px)' },
          to: { opacity: '1', transform: 'translateY(0)' }
        },
        'fade-in': { from: { opacity: '0' }, to: { opacity: '1' } },
        'sheet-in': {
          from: { opacity: '0', transform: 'translateX(24px)' },
          to: { opacity: '1', transform: 'translateX(0)' }
        },
        flow: { to: { strokeDashoffset: '-24' } },
        packet: { from: { strokeDashoffset: '100' }, to: { strokeDashoffset: '0' } },
        shimmer: { '100%': { transform: 'translateX(100%)' } },
        breathe: {
          '0%, 100%': { transform: 'scale(1)', opacity: '0.9' },
          '50%': { transform: 'scale(1.06)', opacity: '1' }
        },
        spin: { to: { transform: 'rotate(360deg)' } }
      },
      animation: {
        'pulse-ring': 'pulse-ring 2s cubic-bezier(0.2, 0.8, 0.2, 1) infinite',
        enter: 'enter 320ms cubic-bezier(0.2, 0.8, 0.2, 1) both',
        'fade-in': 'fade-in 240ms ease-out both',
        'sheet-in': 'sheet-in 280ms cubic-bezier(0.2, 0.8, 0.2, 1) both',
        flow: 'flow 1.2s linear infinite',
        packet: 'packet 2.8s cubic-bezier(0.45, 0, 0.55, 1) infinite',
        shimmer: 'shimmer 1.6s infinite',
        breathe: 'breathe 2.4s ease-in-out infinite',
        'spin-slow': 'spin 1.1s linear infinite'
      }
    }
  },
  plugins: []
}

export default config
