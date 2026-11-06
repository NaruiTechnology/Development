# Processing tab: pattern configuration and drawing (iteration 1)

**Config:** `GlasgowDataIO/Json/processingPatterns.json` (shipped by `buildCompiledDist.py` with the other Json files; override with `IONBEAM_PROCESSING_PATTERNS=<file>`).
Layout follows the deploy workflow's `Actions` list: `Patterns` is a list of one-key objects. The key is the pattern name, the value holds:

| field | meaning |
|---|---|
| `skip` | `true` = no model, no icon, no card (used for the not-yet-built items 7-13 of the feature list) |
| `model` | data-model class registered in `ionbeam_native/processing/models.py` |
| `roi` | `rect`, `circle` (solid disk), `ring` (two concentric circles) or `polygon`; must match the model's `ROI_KIND` |
| `caption`, `icon` | English caption (translatable via `processing.pattern.<key>`) and SVG name in `resources/icons` |
| `parameters` | `name -> {label, type int/float/bool/choice, default, min, max, step, unit, choices}`; the card's form is generated from this |

A malformed entry is reported in the Patterns card and does not stop the others; an unreadable file shows an error and an empty tab.

**Code:** `processing/` (Qt-free models + loader), `ui/processing.py` (Patterns card, `PatternCard`), `ui/pattern_tool.py` (canvas drawing, hooked into `ROIEditorCanvas.pattern_tool`).

**Behaviour:** Processing tab sits next to Scan and uses the ROI canvas. Clicking a pattern icon expands its card, collapses the siblings and arms drawing (clicking it again disarms). Rect: drag. Circle: drag centre to radius and release to finish; shown as an open outline. Ring: drag centre to outer circle, then click for the inner circle (same centre); Esc / right-click cancels. Free hand: press-drag-release. ROIs are stored in world coordinates on the model. Executing patterns on the beam is not part of iteration 1.

**Adding a pattern:** add a model class (`@register_model`) and a JSON entry. A new ROI kind also needs canvas drawing, readout and validation support in both clients.
