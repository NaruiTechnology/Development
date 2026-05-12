/**
 * Inline help button + modal for the Dwell field in RasterParameters.
 *
 * The button renders as a small question-mark icon next to the field
 * label. Clicking it opens a modal that explains how the gateware
 * supersampler interprets the dwell value, including a power-of-two
 * pitfall and a sample-rate / SNR table.
 *
 * The modal closes on:
 *   - the explicit "X" button in the header,
 *   - clicking the dimmed backdrop,
 *   - pressing the Escape key.
 * Focus is moved into the close button on open, and restored to the
 * trigger button on close.
 */
import { useEffect, useRef, useState } from "react";

import { Icon } from "./Icon";

export function DwellHelp() {
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
        aria-label="What does the dwell field do?"
        aria-haspopup="dialog"
        aria-expanded={open}
        title="What does the dwell field do?"
        onClick={() => setOpen(true)}
      >
        <Icon name="help" />
      </button>
      {open && <DwellHelpModal onClose={close} />}
    </>
  );
}

function DwellHelpModal({ onClose }: { onClose: () => void }) {
  const closeBtnRef = useRef<HTMLButtonElement | null>(null);

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
        aria-labelledby="dwell-help-title"
      >
        <div className="modal__header">
          <div id="dwell-help-title" className="modal__title">
            Dwell — supersampler control
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

        <div className="modal__body dwell-help">
          <div className="dwell-help__rule">
            <strong>Pick powers of two.</strong> If your effective sample
            count per pixel isn&apos;t a power of two, the gateware only
            averages the last power of two samples and the remaining ones
            are thrown away. A pixel with 7 samples averages 4 of them;
            with 9 samples, 8 of them. So always pick{" "}
            <code>dwell_time</code> so the resulting sample count per
            pixel is 2, 4, 8, 16, 32, 64, ….
          </div>

          <p>
            The <code>dwell</code> field is the supersampler control.
            Change it:
          </p>

          <ul className="dwell-help__list">
            <li>
              <code>"dwell": 1</code> → supersampler does nothing,
              fastest scan, full 8 MSPS pixel rate
            </li>
            <li>
              <code>"dwell": 2</code> → 2× averaging, half the pixel
              rate (4 Mpix/s), √2 SNR gain
            </li>
            <li>
              <code>"dwell": 4</code> → 4× averaging (2 Mpix/s),
              2× SNR gain
            </li>
            <li>
              <code>"dwell": 8</code> → 8× averaging (1 Mpix/s),
              ~2.8× SNR gain
            </li>
            <li>
              <code>"dwell": 16</code> → 16× averaging (500 kpix/s),
              4× SNR gain
            </li>
            <li>
              … up to <code>dwell = 65535</code> (≈ 8.19 ms per pixel)
            </li>
          </ul>

          <div className="dwell-help__table-wrap">
            <table className="dwell-help__table">
              <thead>
                <tr>
                  <th>dwell</th>
                  <th>Samples / pixel</th>
                  <th>Pixel rate</th>
                  <th>SNR gain<br /><span className="muted">(vs dwell=1)</span></th>
                  <th>1024² frame time</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>1</td><td>1</td><td>8.0 MPix/s</td>
                  <td>1.00×</td><td>131 ms</td>
                </tr>
                <tr>
                  <td>2</td><td>2</td><td>4.0 MPix/s</td>
                  <td>1.41×</td><td>262 ms</td>
                </tr>
                <tr>
                  <td>4</td><td>4</td><td>2.0 MPix/s</td>
                  <td>2.00×</td><td>524 ms</td>
                </tr>
                <tr>
                  <td>8</td><td>8</td><td>1.0 MPix/s</td>
                  <td>2.83×</td><td>1.05 s</td>
                </tr>
                <tr>
                  <td>16</td><td>16</td><td>500 kPix/s</td>
                  <td>4.00×</td><td>2.10 s</td>
                </tr>
                <tr>
                  <td>32</td><td>32</td><td>250 kPix/s</td>
                  <td>5.66×</td><td>4.19 s</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}
