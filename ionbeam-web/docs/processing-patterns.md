# Processing tab (web app)

A **Processing** tab sits next to Scan. It draws pattern ROIs on the ROI canvas; running patterns on the beam is not part of iteration 1.

**Config.** `GlasgowDataIO/Json/processingPatterns.json` (shared with the native app; override with `PROCESSING_PATTERNS_CONFIG`). The backend serves it, validated, at `GET /api/processing/patterns` (`backend/src/processingPatternsConfig.ts`). `Patterns` is a list of one-key objects like the deploy workflow's `Actions`: the key is the pattern name, the value has `skip`, `model`, `roi` (`rect` / `ring` / `polygon`), `caption`, `icon` and a `parameters` schema. `skip: true` entries are never sent to the browser. A bad entry is reported in the Patterns card and does not hide the others.

**Models.** `frontend/src/lib/processingPatterns.ts` has `MODEL_REGISTRY` (SolidBoxModel, OpenBoxModel, StairCutModel, CleaningLineModel, RingModel, FreeHandModel): ROI validation, area, containment, preview geometry. The processing slice (`store/processingSlice.ts`) holds one instance (parameters + ROI) per catalogue entry; the catalogue is fetched at app launch.

**UI.** `ProcessingPatternsPanel` renders the non-collapsible *Patterns* card (icon strip) and one card per pattern, collapsed by default. Picking an icon (or a card's chevron) expands that card, collapses the siblings and arms drawing; picking it again disarms. `PatternOverlay` is mounted inside the ROI canvas through `ROIEditor`'s `renderCanvasOverlay`: rect = drag; ring = drag centre to outer circle, then click for the inner circle (same centre), Esc / right-click cancels; free hand = press-drag-release.

**New pattern:** add a model to `MODEL_REGISTRY` and an entry to the JSON; the card form is generated from `parameters`.
