import {
  CircleCheckIcon,
  InfoIcon,
  Loader2Icon,
  OctagonXIcon,
  TriangleAlertIcon,
} from "lucide-react"
import { Toaster as Sonner, type ToasterProps } from "sonner"

import { cn } from "@/lib/utils"
import { useTheme } from "@/renderer/app/ThemeProvider"
import { findTheme } from "@/renderer/lib/themes"

/**
 * App-themed toast surface.
 *
 * Sonner's built-in `theme` prop only knows `'light' | 'dark'`, but SigmaLink
 * ships five themes via its OWN {@link useTheme} (not next-themes). Mounting a
 * hardcoded `theme="dark"` Toaster painted every toast as a dark slab on the
 * light Parchment theme. Here we read the active app theme and collapse it to
 * sonner's light/dark axis using the canonical `appearance` field from the
 * theme catalog (parchment → light; obsidian / nord / synthwave / glass → dark)
 * so there is one source of truth and new themes map automatically.
 *
 * The toast surface colors are driven by the popover tokens (`hsl(var(--…))`),
 * so a toast always matches the active theme's menu/popover material rather
 * than sonner's generic palette. On the Glass theme each toast also picks up
 * the `.sl-glass` chrome material (translucent blur + specular highlight) so it
 * reads as the same glass as the rest of the chrome.
 *
 * `richColors` is intentionally dropped: it repaints the toast background per
 * severity, which would override the popover-token styling above. Severity is
 * still legible via the colored leading icons below.
 */
const Toaster = ({ toastOptions, ...props }: ToasterProps) => {
  const { theme } = useTheme()
  const appearance = findTheme(theme).appearance // 'light' | 'dark'
  const isGlass = theme === "glass"

  return (
    <Sonner
      theme={appearance}
      className="toaster group"
      icons={{
        success: <CircleCheckIcon className="size-4" />,
        info: <InfoIcon className="size-4" />,
        warning: <TriangleAlertIcon className="size-4" />,
        error: <OctagonXIcon className="size-4" />,
        loading: <Loader2Icon className="size-4 animate-spin" />,
      }}
      style={
        {
          // Tokens are raw HSL triples in index.css, so wrap them in hsl(...).
          "--normal-bg": "hsl(var(--popover))",
          "--normal-text": "hsl(var(--popover-foreground))",
          "--normal-border": "hsl(var(--border))",
          "--border-radius": "var(--radius)",
        } as React.CSSProperties
      }
      toastOptions={{
        ...toastOptions,
        // On the Glass theme give each toast the chrome glass material so it
        // matches the rest of the translucent chrome. `relative` is required
        // by the `.sl-glass::before` specular highlight (positioned `inset:0`).
        className: cn(isGlass && "sl-glass relative", toastOptions?.className),
      }}
      {...props}
    />
  )
}

export { Toaster }
