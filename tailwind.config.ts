import type { Config } from 'tailwindcss'

/**
 * The design tokens from docs/DESIGN.md, and nothing else.
 *
 * Every colour a screen or a component may use is named here, so no file
 * downstream ever writes a hex. That is the whole point: three agents are
 * restyling this app in sequence, and the only way the third one's arrears
 * table matches the first one's nav bar is if both wrote `bg-navy-900`.
 *
 * `status` is nested one level deeper than the rest because each state is a
 * *triple* — background, border and text are chosen together and are wrong
 * apart. `bg-status-overdue-bg border-status-overdue-border
 * text-status-overdue-text` is verbose on purpose; in practice only StatusPill
 * writes it, and everything else asks StatusPill.
 */
export default {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // No built-in `navy`, so this scale stands alone.
        navy: {
          900: '#0E2A47',
          800: '#12324F',
          100: '#E8F1FA'
        },
        // Tailwind ships a `teal` scale; these two shades override its 500 and
        // 100 and the rest are left alone (nothing uses them).
        teal: {
          500: '#21A0A0',
          100: '#DCF2F1'
        },
        ink: '#0F172A',
        muted: '#64748B',
        line: '#E7ECF1',
        page: '#F6F8FA',
        surface: '#FFFFFF',
        status: {
          // Available / Paid
          paid: { bg: '#DCFCE7', border: '#86EFAC', text: '#15803D' },
          // Reserved / Partial
          partial: { bg: '#FEF3C7', border: '#FCD34D', text: '#B45309' },
          // Sold — a fact about a unit.
          sold: { bg: '#FFE4E6', border: '#FDA4AF', text: '#BE123C' },
          // Overdue — money owed today. Deliberately a different red from Sold.
          overdue: { bg: '#FEE2E2', border: '#FCA5A5', text: '#B91C1C' },
          // Pending / Unavailable
          pending: { bg: '#F1F5F9', border: '#E2E8F0', text: '#64748B' }
        }
      },
      fontFamily: {
        // Spelled out rather than inherited from Tailwind's default so the
        // stack in DESIGN.md is the stack that ships. No webfont: buyers are on
        // weak connections and a font file is the first thing to cut.
        sans: ['ui-sans-serif', 'system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'sans-serif']
      },
      borderRadius: {
        // Card 12px, button 10px — see DESIGN.md "Shape and spacing".
        card: '12px',
        btn: '10px'
      },
      boxShadow: {
        card: '0 1px 2px rgb(15 23 42 / 0.04)'
      },
      spacing: {
        // The bottom tab bar's own height, so page padding and the bar itself
        // are the same number in one place. 56px of bar plus the safe-area
        // inset; `pb-tabbar` on a scroll container keeps the last list row
        // clear of it.
        tabbar: '3.5rem'
      }
    }
  },
  plugins: []
} satisfies Config
