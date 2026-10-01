/** @internal AG_GRID_INTERNAL - Not for public use. Can change / be removed at any time. */
export type Anchor = 'tl' | 'tc' | 'tr' | 'l' | 'c' | 'r' | 'bl' | 'bc' | 'br';
/** @internal AG_GRID_INTERNAL - Not for public use. Can change / be removed at any time. */
export type Alignment = `${Anchor}-${Anchor}`;
interface FindBestPlacementOptions {
    gap?: number;
    enableRtl?: boolean;
    mirrorPlacementsInRtl?: boolean;
}
interface Rect {
    top: number;
    left: number;
    right: number;
    bottom: number;
}
interface Size {
    width: number;
    height: number;
}
/** @internal AG_GRID_INTERNAL - Not for public use. Can change / be removed at any time. */
export declare function getRectSize(rect: Pick<Rect, 'top' | 'left' | 'right' | 'bottom'>): Size;
/** @internal AG_GRID_INTERNAL - Not for public use. Can change / be removed at any time. */
export declare function fitsWithinBounds(position: {
    x: number;
    y: number;
}, targetSize: Size, boundsSize: Size): boolean;
/** @internal AG_GRID_INTERNAL - Not for public use. Can change / be removed at any time. */
export declare function toRelativeRect(rect: {
    top: number;
    left: number;
    right: number;
    bottom: number;
}, parentRect: {
    top: number;
    left: number;
}): Rect;
/**
 * @internal AG_GRID_INTERNAL - Not for public use. Can change / be removed at any time.
 *
 * Compute the top-left position for a target element so that its anchor point
 * aligns with the reference element's anchor point.
 *
 * @param referenceRect  Bounding rect of the reference element (absolute coordinates)
 * @param targetSize     Width and height of the target element
 * @param alignment      `'{targetAnchor}-{referenceAnchor}'` e.g. `'tl-tr'`
 * @param gap            Pixel gap applied directionally away from the reference
 */
export declare function computeAlignedPosition(referenceRect: Rect, targetSize: Size, alignment: Alignment, gap?: number): {
    x: number;
    y: number;
};
/**
 * @internal AG_GRID_INTERNAL - Not for public use. Can change / be removed at any time.
 *
 * Try a list of alignments in order, returning the position of the first one
 * that doesn't overlap the reference rect after bounds clamping.
 *
 * @param referenceRect  Bounding rect of the reference element (relative to parent)
 * @param targetSize     Width and height of the target element
 * @param parentSize     Width and height of the bounding parent
 * @param placements     Alignments to try in preference order
 * @param gap            Pixel gap applied directionally away from the reference
 * @returns              The position of the best placement, or the first placement as fallback
 */
export declare function findBestPlacement(referenceRect: Rect, targetSize: Size, parentSize: Size, placements: Alignment[], gapOrOptions?: number | FindBestPlacementOptions): {
    x: number;
    y: number;
};
/** @internal AG_GRID_INTERNAL - Not for public use. Can change / be removed at any time. */
export declare function getEffectivePlacements(placements: Alignment[], enableRtl?: boolean, mirrorPlacementsInRtl?: boolean): Alignment[];
export {};
