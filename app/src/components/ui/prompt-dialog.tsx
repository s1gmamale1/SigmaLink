// UX-3 — Themed replacement for the native `window.prompt`.
//
// `window.prompt` renders an un-themeable gray OS modal that breaks the
// Liquid-Glass aesthetic, can't be focus-trapped to our chrome, and isn't
// VoiceOver-labelled the way the rest of the app is. `PromptDialog` is a
// controlled dialog (built on `dialog.tsx` + `input.tsx` + `button.tsx`) that
// collects a single line of text.
//
// Because a React dialog can't block the call stack the way `window.prompt`
// does, call sites flip an `open` state, then run their action inside
// `onConfirm(value)`. Enter submits, Escape / Cancel dismisses, and the input
// is auto-focused (with its contents selected) on open so the default value
// can be replaced with a single keystroke.

import * as React from "react"

import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

export interface PromptDialogProps {
  /** Controlled open state. */
  open: boolean
  /** Fired with `false` whenever the dialog should close (Escape, overlay,
   *  Cancel, the close button, or after a confirm). */
  onOpenChange: (open: boolean) => void
  /** Dialog heading. */
  title: string
  /** Optional helper text under the title (also wired to aria-describedby). */
  description?: React.ReactNode
  /** Visible field label, associated with the input for screen readers. */
  label?: string
  /** Initial field value applied each time the dialog opens. */
  defaultValue?: string
  /** Placeholder shown when the field is empty. */
  placeholder?: string
  /** Confirm button text. */
  confirmLabel?: string
  /** Cancel button text. */
  cancelLabel?: string
  /** Called with the entered (untrimmed) string when the user confirms. The
   *  dialog closes itself afterward; the caller decides what to do with the
   *  value (mirrors `window.prompt`'s raw return). */
  onConfirm: (value: string) => void
  /** Optional hook fired when the dialog is dismissed without confirming. */
  onCancel?: () => void
  /** When true (default) an empty/whitespace-only value disables Confirm and
   *  blocks Enter — matching the `if (!name) return` guards at the call sites. */
  requireValue?: boolean
}

/**
 * A single-line text-prompt dialog. Drop-in async replacement for
 * `window.prompt`.
 *
 * @example
 * const [open, setOpen] = useState(false);
 * <Button onClick={() => setOpen(true)}>Rename…</Button>
 * <PromptDialog
 *   open={open}
 *   onOpenChange={setOpen}
 *   title="Rename note"
 *   label="Note name"
 *   defaultValue={current}
 *   onConfirm={(name) => rename(name)}
 * />
 */
export function PromptDialog({
  open,
  onOpenChange,
  title,
  description,
  label,
  defaultValue = "",
  placeholder,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  onConfirm,
  onCancel,
  requireValue = true,
}: PromptDialogProps) {
  const [value, setValue] = React.useState(defaultValue)
  const inputId = React.useId()

  // Re-seed the field with the default value whenever the dialog (re)opens so a
  // stale edit from a previous open never leaks into the next prompt. Uses the
  // React-recommended "adjust state during render on a prop change" pattern
  // (guarded by prevOpen) instead of a setState-in-effect (react-hooks/set-state-in-effect).
  const [prevOpen, setPrevOpen] = React.useState(open)
  if (open !== prevOpen) {
    setPrevOpen(open)
    if (open) setValue(defaultValue)
  }

  const canConfirm = !requireValue || value.trim().length > 0

  const confirm = React.useCallback(() => {
    if (!canConfirm) return
    onConfirm(value)
    onOpenChange(false)
  }, [canConfirm, onConfirm, onOpenChange, value])

  const handleOpenChange = React.useCallback(
    (next: boolean) => {
      if (!next) onCancel?.()
      onOpenChange(next)
    },
    [onCancel, onOpenChange],
  )

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        className="sm:max-w-md"
        // Focus + select the field on open so the default value can be
        // overwritten with a single keystroke (parity with window.prompt).
        onOpenAutoFocus={(e) => {
          e.preventDefault()
          const el = document.getElementById(inputId) as HTMLInputElement | null
          el?.focus()
          el?.select()
        }}
      >
        <form
          onSubmit={(e) => {
            e.preventDefault()
            confirm()
          }}
        >
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            {description ? (
              <DialogDescription>{description}</DialogDescription>
            ) : null}
          </DialogHeader>
          <div className={cn("grid gap-2 py-4")}>
            {label ? <Label htmlFor={inputId}>{label}</Label> : null}
            <Input
              id={inputId}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder={placeholder}
              aria-label={label ?? title}
              autoComplete="off"
            />
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => handleOpenChange(false)}
            >
              {cancelLabel}
            </Button>
            <Button type="submit" disabled={!canConfirm}>
              {confirmLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
