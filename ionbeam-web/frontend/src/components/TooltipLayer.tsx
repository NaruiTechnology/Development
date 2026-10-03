import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

type TooltipState = { text: string; left: number; top: number; side: "above" | "below" } | null;

/** Applies one themed tooltip to native title hints throughout the app. */
export function TooltipLayer() {
  const [tooltip, setTooltip] = useState<TooltipState>(null);

  useEffect(() => {
    let active: HTMLElement | null = null;
    let timer: number | undefined;

    const normalize = (root: ParentNode) => {
      const nodes = root instanceof HTMLElement && root.hasAttribute("title")
        ? [root, ...root.querySelectorAll<HTMLElement>("[title]")]
        : [...root.querySelectorAll<HTMLElement>("[title]")];
      for (const node of nodes) {
        if (node.title) node.dataset.tooltip = node.title;
        node.removeAttribute("title");
      }
    };

    const position = (node: HTMLElement, delay: number) => {
      const text = node.dataset.tooltip;
      if (!text) return;
      active = node;
      window.clearTimeout(timer);
      const rect = node.getBoundingClientRect();
      const left = Math.max(8, Math.min(rect.left + rect.width / 2, window.innerWidth - 8));
      const top = rect.top > 54 ? rect.top - 10 : rect.bottom + 10;
      timer = window.setTimeout(() => {
        if (active === node) setTooltip({ text, left, top, side: rect.top > 54 ? "above" : "below" });
      }, delay);
    };

    const dismiss = (node?: HTMLElement) => {
      if (node && active !== node) return;
      active = null;
      window.clearTimeout(timer);
      setTooltip(null);
    };

    normalize(document);
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        if (record.type === "childList") record.addedNodes.forEach((node) => {
          if (node instanceof HTMLElement) normalize(node);
        });
        else if (record.target instanceof HTMLElement && record.target.hasAttribute("title")) normalize(record.target);
      }
    });
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["title"] });

    const onPointerOver = (event: PointerEvent) => {
      const target = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-tooltip]") : null;
      if (target && target !== active) position(target, 350);
    };
    const onPointerOut = (event: PointerEvent) => {
      const target = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-tooltip]") : null;
      if (target && !target.contains(event.relatedTarget as Node | null)) dismiss(target);
    };
    const onFocus = (event: FocusEvent) => {
      const target = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-tooltip]") : null;
      if (target) position(target, 0);
    };
    const onBlur = (event: FocusEvent) => {
      const target = event.target instanceof HTMLElement ? event.target : undefined;
      dismiss(target);
    };
    const onViewportChange = () => {
      if (active) position(active, 0);
    };

    document.addEventListener("pointerover", onPointerOver);
    document.addEventListener("pointerout", onPointerOut);
    document.addEventListener("focusin", onFocus);
    document.addEventListener("focusout", onBlur);
    window.addEventListener("resize", onViewportChange);
    window.addEventListener("scroll", onViewportChange, true);
    return () => {
      observer.disconnect();
      document.removeEventListener("pointerover", onPointerOver);
      document.removeEventListener("pointerout", onPointerOut);
      document.removeEventListener("focusin", onFocus);
      document.removeEventListener("focusout", onBlur);
      window.removeEventListener("resize", onViewportChange);
      window.removeEventListener("scroll", onViewportChange, true);
      window.clearTimeout(timer);
    };
  }, []);

  if (!tooltip) return null;
  return createPortal(
    <div className={`app-tooltip app-tooltip--${tooltip.side}`} role="tooltip" style={{ left: tooltip.left, top: tooltip.top }}>
      {tooltip.text}
    </div>,
    document.body,
  );
}
