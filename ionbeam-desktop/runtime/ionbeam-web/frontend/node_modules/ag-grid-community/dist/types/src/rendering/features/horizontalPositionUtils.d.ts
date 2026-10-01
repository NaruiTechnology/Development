import type { VisibleColsService } from '../../columns/visibleColsService';
import type { ColumnPinnedType } from '../../interfaces/iColumn';
interface HorizontalOffsetParams {
    left: number | null;
    pinned: ColumnPinnedType;
    width: number;
    isPrintLayout: boolean;
    isRtl: boolean;
    visibleCols: VisibleColsService;
}
interface ApplyHorizontalPositionParams {
    offset: number;
    pinned: ColumnPinnedType;
    width: number;
    isPrintLayout: boolean;
    isRtl: boolean;
    visibleCols: VisibleColsService;
}
export declare function getResolvedHorizontalOffset(params: HorizontalOffsetParams): number | null;
export declare function applyHorizontalPosition(eElement: HTMLElement, params: ApplyHorizontalPositionParams): void;
export {};
