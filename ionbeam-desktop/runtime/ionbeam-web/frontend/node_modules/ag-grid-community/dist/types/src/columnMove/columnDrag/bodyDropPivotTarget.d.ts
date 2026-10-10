import { BeanStub } from '../../context/beanStub';
import type { DragAndDropIcon, GridDraggingEvent } from '../../dragAndDrop/dragAndDropService';
import type { ColumnPinnedType } from '../../interfaces/iColumn';
import type { DropListener } from './bodyDropTarget';
export declare class BodyDropPivotTarget extends BeanStub implements DropListener {
    private readonly pinned;
    private readonly columnsToAggregate;
    private readonly columnsToGroup;
    private readonly columnsToPivot;
    constructor(pinned: ColumnPinnedType);
    /** Callback for when drag enters */
    onDragEnter(draggingEvent: GridDraggingEvent): void;
    getIconName(): DragAndDropIcon | null;
    /** Callback for when drag leaves */
    onDragLeave(_draggingEvent: GridDraggingEvent): void;
    private clearColumnsList;
    /** Callback for when dragging */
    onDragging(_draggingEvent: GridDraggingEvent): void;
    /** Callback for when drag stops */
    onDragStop(_draggingEvent: GridDraggingEvent): void;
    onDragCancel(): void;
}
