/**
 * Reusable inline-help popover. Extracted from DwellHelp so every
 * parameter on the scan forms can have a "?" button with a modal
 * explanation, without each component re-implementing the
 * focus/keyboard/scroll-lock machinery.
 *
 * Usage:
 *
 *   <HelpPopover
 *     title="Cookie — synchronization tag"
 *     ariaLabel="What does cookie do?"
 *   >
 *     <p>...help body content...</p>
 *   </HelpPopover>
 *
 * The body content should be styled with the existing `dwell-help`
 * CSS class (set on the modal body wrapper here) so all help dialogs
 * share the same paragraph / code / list / table styling. The class
 * name is historical — it's about content typography, not the dwell
 * parameter specifically.
 *
 * Modal closes on:
 *   - the explicit "X" button,
 *   - clicking the dimmed backdrop (but not on a click that started
 *     inside the dialog and bubbled up),
 *   - pressing Escape.
 * Focus is moved into the close button on open, and restored to the
 * trigger button on close.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";

import { Icon } from "./Icon";

interface HelpPopoverProps {
  /** Heading shown in the modal header — short, descriptive. */
  title: string;
  /** aria-label / title for the question-mark trigger button. */
  ariaLabel: string;
  /** Body content for the modal. Use <p>, <ul>, tables etc. as needed. */
  children: ReactNode;
}

export function HelpPopover({ title, ariaLabel, children }: HelpPopoverProps) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  function close() {
    setOpen(false);
    // Restore focus to the trigger on the next frame so the modal has
    // fully unmounted first; otherwise the focus call races with React.
    requestAnimationFrame(() => triggerRef.current?.focus());
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="help-btn"
        aria-label={ariaLabel}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={ariaLabel}
        onClick={(e) => {
          // Stop bubbling: when the help button is nested inside a
          // <label className="checkbox">, the click would otherwise
          // bubble up and toggle the checkbox. preventDefault for
          // the same reason (the implicit `for` on the parent label
          // triggers on click events that reach it).
          e.stopPropagation();
          e.preventDefault();
          setOpen(true);
        }}
      >
        <Icon name="help" />
      </button>
      {open && <HelpModal title={title} onClose={close}>{children}</HelpModal>}
    </>
  );
}

function HelpModal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const closeBtnRef = useRef<HTMLButtonElement | null>(null);
  // Deterministic id for aria-labelledby so multiple popovers on the
  // same page don't collide. Stable per modal instance.
  const titleIdRef = useRef(
    `help-modal-title-${Math.random().toString(36).slice(2, 9)}`,
  );

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    }
    document.addEventListener("keydown", onKey);

    // Move focus into the dialog so keyboard users can dismiss it
    // immediately. Defer one frame so the element is mounted.
    const focusTimer = window.setTimeout(() => closeBtnRef.current?.focus(), 0);

    // Lock background scroll while the modal is open. Save the prior
    // value so we don't clobber a custom value set elsewhere.
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
      window.clearTimeout(focusTimer);
    };
  }, [onClose]);

  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onMouseDown={(e) => {
        // Only close on backdrop clicks, not on clicks that originated
        // inside the dialog and bubbled up.
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleIdRef.current}
      >
        <div className="modal__header">
          <div id={titleIdRef.current} className="modal__title">
            {title}
          </div>
          <button
            ref={closeBtnRef}
            type="button"
            className="modal__close"
            onClick={onClose}
            aria-label="Close"
            title="Close"
          >
            <Icon name="x" />
          </button>
        </div>

        <div className="modal__body dwell-help">{children}</div>
      </div>
    </div>
  );
}
