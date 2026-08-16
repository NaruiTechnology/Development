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
}

export function HelpPopover({ title, ariaLabel, children, iconName = "help" }: HelpPopoverProps) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const scanPhase = useAppSelector((s) => s.scan.phase);
  const helpLocked = scanPhase === "running" || scanPhase === "stopping";

  function close() {
    setOpen(false);
    requestAnimationFrame(() => triggerRef.current?.focus());
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
        onClick={(e) => {
          if (helpLocked) return;
          e.stopPropagation();
          e.preventDefault();
          setOpen(true);
        }}
      >
        <Icon name={iconName} />
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

  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="modal modal--help"
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
