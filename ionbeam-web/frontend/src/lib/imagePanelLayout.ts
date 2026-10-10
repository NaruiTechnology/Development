export type ImagePanelLayout = 1 | 2 | 3 | 4;

export interface CompletedScanPlacement {
  slots: Array<string | null>;
  layout: ImagePanelLayout;
  selectedPane: number;
}

export function clampImagePane(pane: number, layout: ImagePanelLayout): number {
  return Math.max(0, Math.min(layout - 1, Math.trunc(pane)));
}

export function placeCompletedScan({
  slots: currentSlots,
  layout,
  selectedPane,
  locked,
  imageUrl,
}: {
  slots: Array<string | null>;
  layout: ImagePanelLayout;
  selectedPane: number;
  locked: boolean;
  imageUrl: string;
}): CompletedScanPlacement {
  const slots = currentSlots.slice(0, layout);
  while (slots.length < layout) slots.push(null);

  if (locked) {
    const targetPane = clampImagePane(selectedPane, layout);
    slots[targetPane] = imageUrl;
    // A scan into the newest pane keeps the multi-scan sequence going: the
    // next empty pane opens automatically (pane 3, then pane 4), the same as
    // after the Split button. Re-scanning an older pane the operator selected
    // only replaces that pane.
    if (targetPane === layout - 1 && layout < 4) {
      const nextLayout = (layout + 1) as ImagePanelLayout;
      slots.push(null);
      return { slots, layout: nextLayout, selectedPane: nextLayout - 1 };
    }
    return { slots, layout, selectedPane: targetPane };
  }

  const targetPane = layout - 1;
  const priorTarget = slots[targetPane];
  if (priorTarget && priorTarget !== imageUrl) {
    const archivePane = slots.findIndex((item, index) => index < targetPane && item === null);
    slots[archivePane >= 0 ? archivePane : 0] = priorTarget;
  }
  slots[targetPane] = imageUrl;

  const nextLayout: ImagePanelLayout = layout === 2 ? 3 : layout === 3 ? 4 : layout;
  if (nextLayout !== layout) slots.push(null);
  return {
    slots: slots.slice(0, nextLayout),
    layout: nextLayout,
    selectedPane: nextLayout - 1,
  };
}

/** A repeated render belongs to its recorded pane, even if other images match. */
export function replaceCompletedScanPane(
  slots: Array<string | null>,
  pane: number,
  imageUrl: string,
): Array<string | null> {
  return slots.map((item, index) => index === pane ? imageUrl : item);
}
