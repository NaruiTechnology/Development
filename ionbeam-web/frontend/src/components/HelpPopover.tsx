/**
 * Reusable inline-help popover. Same focus / scroll-lock / Escape
 * behavior as before; only the close-button aria-label / title are
 * localised (the title and body are passed in from the caller, which
 * already resolves them through t() / useHelpBody()).
 */
import { useEffect, useRef, useState, type ReactNode } from "react";

import { useTranslation } from "../i18n";
import { useAppSelector } from "../store";
import { Icon } from "./Icon";

interface HelpPopoverProps {
  /** Heading shown in the modal header — short, descriptive. */
  title: string;
  /** aria-label / title for the question-mark trigger button. */
  ariaLabel: string;
  /** Body content for the modal. */
  children: ReactNode;
  /** Optional trigger icon; defaults to the question mark. */
  iconName?: "help" | "alertTriangle";
  /** Also open when the pointer rests on the trigger (after a short delay, so passing over it does nothing). */
  openOnHover?: boolean;
  /** "wide" for content such as full-width screenshots. */
  size?: "default" | "wide";
  /**
   * Close as soon as the left mouse button is pressed anywhere, or the pointer leaves the dialog (or the browser
   * window) - for quick-look help such as a screenshot. × and Escape still work.
   */
  dismissOnPointer?: boolean;
}

const HOVER_OPEN_DELAY_MS = 350;

export function HelpPopover({ title, ariaLabel, children, iconName = "help", openOnHover = false, size = "default", dismissOnPointer = false }: HelpPopoverProps) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const hoverTimer = useRef<number | null>(null);
  /** false right after a pointer dismissal while the pointer may still rest on the trigger: prevents an instant reopen */
  const hoverArmed = useRef(true);
  const scanPhase = useAppSelector((s) => s.scan.phase);
  const helpLocked = scanPhase === "running" || scanPhase === "stopping";

  function cancelHover() {
    if (hoverTimer.current !== null) {
      window.clearTimeout(hoverTimer.current);
      hoverTimer.current = null;
    }
  }

  useEffect(() => cancelHover, []);

  function close() {
    cancelHover();
    setOpen(false);
    requestAnimationFrame(() => triggerRef.current?.focus());
  }

  function dismissByPointer() {
    cancelHover();
    setOpen(false);
    // Re-arm hover-open only once the pointer is known to be off the trigger (the trigger's mouseleave, or the next
    // pointer move landing elsewhere). Focus stays put: moving it would scroll / flash for a mouse user.
    hoverArmed.current = false;
    const onMove = (e: PointerEvent) => {
      if (!triggerRef.current?.contains(e.target as Node)) {
        hoverArmed.current = true;
        document.removeEventListener("pointermove", onMove, true);
      }
    };
    document.addEventListener("pointermove", onMove, true);
    window.setTimeout(() => document.removeEventListener("pointermove", onMove, true), 60_000);
  }

  useEffect(() => {
    if (helpLocked && open) {
      close();
    }
  }, [helpLocked, open]);

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
        disabled={helpLocked}
        aria-disabled={helpLocked}
        onMouseEnter={
          openOnHover
            ? () => {
                if (helpLocked || open || !hoverArmed.current) return;
                cancelHover();
                hoverTimer.current = window.setTimeout(() => {
                  hoverTimer.current = null;
                  setOpen(true);
                }, HOVER_OPEN_DELAY_MS);
              }
            : undefined
        }
        onMouseLeave={
          openOnHover
            ? () => {
                cancelHover();
                hoverArmed.current = true;
              }
            : undefined
        }
        onClick={(e) => {
          if (helpLocked) return;
          e.stopPropagation();
          e.preventDefault();
          cancelHover();
          setOpen(true);
        }}
      >
        <Icon name={iconName} />
      </button>
      {open && (
        <HelpModal title={title} size={size} onClose={close} onPointerDismiss={dismissOnPointer ? dismissByPointer : undefined}>
          {children}
        </HelpModal>
      )}
    </>
  );
}

function HelpModal({
  title,
  size = "default",
  onClose,
  onPointerDismiss,
  children,
}: {
  title: string;
  size?: "default" | "wide";
  onClose: () => void;
  onPointerDismiss?: () => void;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const closeBtnRef = useRef<HTMLButtonElement | null>(null);
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

    const focusTimer = window.setTimeout(() => closeBtnRef.current?.focus(), 0);

    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
      window.clearTimeout(focusTimer);
    };
  }, [onClose]);

  // Pointer dismissal: any left-button press, or the pointer leaving the browser window (leaving the dialog itself is
  // handled on the dialog element below). The ref keeps one subscription for the life of the dialog.
  const dismissRef = useRef(onPointerDismiss);
  dismissRef.current = onPointerDismiss;
  const dismissable = onPointerDismiss !== undefined;
  useEffect(() => {
    if (!dismissable) return;
    const onDown = (e: MouseEvent) => {
      if (e.button === 0) dismissRef.current?.();
    };
    const onWindowLeave = () => dismissRef.current?.();
    document.addEventListener("mousedown", onDown, true);
    document.documentElement.addEventListener("mouseleave", onWindowLeave);
    return () => {
      document.removeEventListener("mousedown", onDown, true);
      document.documentElement.removeEventListener("mouseleave", onWindowLeave);
    };
  }, [dismissable]);

  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onMouseDown={(e) => {
        // with pointer dismissal the document listener already closes on any press
        if (!dismissable && e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className={size === "wide" ? "modal modal--help modal--help-wide" : "modal modal--help"}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleIdRef.current}
        onMouseLeave={dismissable ? () => dismissRef.current?.() : undefined}
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
            aria-label={t("help.close")}
            title={t("help.close")}
          >
            <Icon name="x" />
          </button>
        </div>

        <div className="modal__body dwell-help">{children}</div>
      </div>
    </div>
  );
}
