import type { HorizontalDirection } from 'ag-stack';
import type { ColumnModel } from '../columns/columnModel';
import type { VisibleColsService } from '../columns/visibleColsService';
import type { CtrlsService } from '../ctrlsService';
import type { AgColumn } from '../entities/agColumn';
import type { GridOptionsService } from '../gridOptionsService';
import type { ColumnPinnedType } from '../interfaces/iColumn';
import type { ColumnMoveService } from './columnMoveService';
export interface ColumnMoveParams {
    allMovingColumns: AgColumn[];
    isFromHeader: boolean;
    fromLeft: boolean;
    xPosition: number;
    fromEnter: boolean;
    fakeEvent: boolean;
    pinned: ColumnPinnedType;
    gos: GridOptionsService;
    colModel: ColumnModel;
    colMoves: ColumnMoveService;
    visibleCols: VisibleColsService;
}
export declare function getBestColumnMoveIndexFromXPosition(params: ColumnMoveParams): {
    columns: AgColumn[];
    toIndex: number;
} | undefined;
export declare function attemptMoveColumns(params: ColumnMoveParams & {
    finished: boolean;
}): {
    columns: AgColumn[];
    toIndex: number;
} | null | undefined;
export declare function clientXToSectionX(clientX: number, pinned: ColumnPinnedType, ctrlsSvc: CtrlsService): number;
export declare const normaliseDirection: (hDirection: HorizontalDirection, isRtl: boolean, pinned: ColumnPinnedType | null) => HorizontalDirection;
export declare function normaliseX(params: {
    x: number;
    pinned?: ColumnPinnedType;
    isRtl: boolean;
    ctrlsSvc: CtrlsService;
}): number;
export declare function setColumnsMoving(columns: AgColumn[], isMoving: boolean): void;
