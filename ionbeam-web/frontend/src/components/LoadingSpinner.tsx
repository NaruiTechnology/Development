/**
 * Animated spinner (assets/spinner.gif) with an optional label, used while CONFIGURATION > Admin loads data.
 *
 *   <LoadingSpinner label="Loading..." />            block, centred (replaces a "Loading..." paragraph)
 *   <LoadingSpinner size={16} inline />              small, in a toolbar / next to a button
 *
 * The label is announced to screen readers (role="status"); without a label, `ariaLabel` (or a generic
 * "Loading") is used. The GIF has a transparent background, so it works on every theme.
 */
import spinnerGif from "../assets/spinner.gif";

export function LoadingSpinner({
  label,
  size = 28,
  inline = false,
  className,
  ariaLabel,
}: {
  label?: string;
  size?: number;
  inline?: boolean;
  className?: string;
  ariaLabel?: string;
}) {
  const classes = ["loading-spinner", inline ? "loading-spinner--inline" : "loading-spinner--block", className]
    .filter(Boolean)
    .join(" ");
  return (
    <span className={classes} role="status" aria-live="polite" aria-label={label ? undefined : ariaLabel ?? "Loading"}>
      <img className="loading-spinner__gif" src={spinnerGif} width={size} height={size} alt="" aria-hidden draggable={false} />
      {label && <span className="loading-spinner__label">{label}</span>}
    </span>
  );
}
