/** @type {import('tailwindcss').Config} */
const defaultTheme = require('tailwindcss/defaultTheme');

module.exports = {
  darkMode: ["class"],
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        primary: {
          DEFAULT: "hsl(var(--primary))",
          foreground: "hsl(var(--primary-foreground))",
        },
        secondary: {
          DEFAULT: "hsl(var(--secondary))",
          foreground: "hsl(var(--secondary-foreground))",
        },
        destructive: {
          DEFAULT: "hsl(var(--destructive) / <alpha-value>)",
          foreground: "hsl(var(--destructive-foreground) / <alpha-value>)",
        },
        muted: {
          DEFAULT: "hsl(var(--muted))",
          foreground: "hsl(var(--muted-foreground))",
        },
        accent: {
          DEFAULT: "hsl(var(--accent))",
          foreground: "hsl(var(--accent-foreground))",
        },
        popover: {
          DEFAULT: "hsl(var(--popover))",
          foreground: "hsl(var(--popover-foreground))",
        },
        card: {
          DEFAULT: "hsl(var(--card))",
          foreground: "hsl(var(--card-foreground))",
        },
        sidebar: {
          DEFAULT: "hsl(var(--sidebar-background))",
          foreground: "hsl(var(--sidebar-foreground))",
          primary: "hsl(var(--sidebar-primary))",
          "primary-foreground": "hsl(var(--sidebar-primary-foreground))",
          accent: "hsl(var(--sidebar-accent))",
          "accent-foreground": "hsl(var(--sidebar-accent-foreground))",
          border: "hsl(var(--sidebar-border))",
          ring: "hsl(var(--sidebar-ring))",
        },
        // V3-W12-010: per-role colour tokens. Resolves through CSS vars set
        // per-theme in src/index.css. Use as bg-role-coordinator,
        // text-role-builder, border-role-scout, etc.
        role: {
          coordinator: "hsl(var(--role-coordinator))",
          builder: "hsl(var(--role-builder))",
          scout: "hsl(var(--role-scout))",
          reviewer: "hsl(var(--role-reviewer))",
        },
      },
      borderRadius: {
        xl: "calc(var(--radius) + 4px)",
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
        xs: "calc(var(--radius) - 6px)",
      },
      fontFamily: {
        sans: ['var(--font-sans)', ...defaultTheme.fontFamily.sans],
      },
      boxShadow: {
        xs: "0 1px 2px 0 rgb(0 0 0 / 0.05)",
      },
      keyframes: {
        "accordion-down": {
          from: { height: "0" },
          to: { height: "var(--radix-accordion-content-height)" },
        },
        "accordion-up": {
          from: { height: "var(--radix-accordion-content-height)" },
          to: { height: "0" },
        },
        "caret-blink": {
          "0%,70%,100%": { opacity: "1" },
          "20%,50%": { opacity: "0" },
        },

        // MOT-1 — Apple-grade overlay motion. ONE vocabulary for every
        // Radix `data-[state=open/closed]` surface, consumed via the
        // className constants in src/renderer/lib/motion.ts. Fade + scale
        // for centred surfaces (dialog/popover/menu/tooltip); directional
        // slide variants for edge surfaces (sheet/drawer). Only
        // transform + opacity animate (GPU-composited). The spring feel
        // lives in the animation-timing-function bound below.
        "sl-overlay-in": {
          from: { opacity: "0", transform: "scale(0.96)" },
          to: { opacity: "1", transform: "scale(1)" },
        },
        "sl-overlay-out": {
          from: { opacity: "1", transform: "scale(1)" },
          to: { opacity: "0", transform: "scale(0.96)" },
        },
        "sl-fade-in": {
          from: { opacity: "0" },
          to: { opacity: "1" },
        },
        "sl-fade-out": {
          from: { opacity: "1" },
          to: { opacity: "0" },
        },
        // Popover/menu nudge from the trigger side (8px), fading in.
        "sl-pop-in": {
          from: { opacity: "0", transform: "scale(0.96) translateY(-4px)" },
          to: { opacity: "1", transform: "scale(1) translateY(0)" },
        },
        "sl-pop-out": {
          from: { opacity: "1", transform: "scale(1) translateY(0)" },
          to: { opacity: "0", transform: "scale(0.96) translateY(-4px)" },
        },
        // Edge sheets / drawers — slide the full surface in/out per side.
        "sl-slide-in-right": {
          from: { transform: "translateX(100%)" },
          to: { transform: "translateX(0)" },
        },
        "sl-slide-out-right": {
          from: { transform: "translateX(0)" },
          to: { transform: "translateX(100%)" },
        },
        "sl-slide-in-left": {
          from: { transform: "translateX(-100%)" },
          to: { transform: "translateX(0)" },
        },
        "sl-slide-out-left": {
          from: { transform: "translateX(0)" },
          to: { transform: "translateX(-100%)" },
        },
        "sl-slide-in-top": {
          from: { transform: "translateY(-100%)" },
          to: { transform: "translateY(0)" },
        },
        "sl-slide-out-top": {
          from: { transform: "translateY(0)" },
          to: { transform: "translateY(-100%)" },
        },
        "sl-slide-in-bottom": {
          from: { transform: "translateY(100%)" },
          to: { transform: "translateY(0)" },
        },
        "sl-slide-out-bottom": {
          from: { transform: "translateY(0)" },
          to: { transform: "translateY(100%)" },
        },
      },
      animation: {
        "accordion-down": "accordion-down 0.2s ease-out",
        "accordion-up": "accordion-up 0.2s ease-out",
        "caret-blink": "caret-blink 1.25s ease-out infinite",

        // MOT-1 overlay animations — `<keyframe> <duration> <spring-easing>`.
        // Enter rides the snappy spring; exit rides the gentle smooth curve
        // at the fast budget so dismissal reads quick + calm (Apple HIG:
        // exits are faster + less playful than entrances). The global
        // prefers-reduced-motion reset in index.css collapses the duration
        // to 0.01ms, neutralizing all of these (animationend still fires).
        "sl-overlay-in": "sl-overlay-in var(--motion) var(--ease-snappy)",
        "sl-overlay-out": "sl-overlay-out var(--motion-fast) var(--ease-smooth)",
        "sl-fade-in": "sl-fade-in var(--motion) var(--ease-smooth)",
        "sl-fade-out": "sl-fade-out var(--motion-fast) var(--ease-smooth)",
        "sl-pop-in": "sl-pop-in var(--motion-fast) var(--ease-snappy)",
        "sl-pop-out": "sl-pop-out var(--motion-fast) var(--ease-smooth)",
        "sl-slide-in-right": "sl-slide-in-right var(--motion-slow) var(--ease-snappy)",
        "sl-slide-out-right": "sl-slide-out-right var(--motion) var(--ease-smooth)",
        "sl-slide-in-left": "sl-slide-in-left var(--motion-slow) var(--ease-snappy)",
        "sl-slide-out-left": "sl-slide-out-left var(--motion) var(--ease-smooth)",
        "sl-slide-in-top": "sl-slide-in-top var(--motion-slow) var(--ease-snappy)",
        "sl-slide-out-top": "sl-slide-out-top var(--motion) var(--ease-smooth)",
        "sl-slide-in-bottom": "sl-slide-in-bottom var(--motion-slow) var(--ease-snappy)",
        "sl-slide-out-bottom": "sl-slide-out-bottom var(--motion) var(--ease-smooth)",
      },
    },
  },
  plugins: [require("tailwindcss-animate")],
}