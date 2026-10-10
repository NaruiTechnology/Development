import { BeanStub } from '../../context/beanStub';
import type { DragAndDropIcon, DropTarget, GridDraggingEvent } from '../../dragAndDrop/dragAndDropService';
import { DragSourceType } from '../../dragAndDrop/dragAndDropService';
export interface DropListener {
    getIconName(): DragAndDropIcon | null;
    onDragEnter(params: GridDraggingEvent): void;
    onDragLeave(params: GridDraggingEvent): void;
    onDragging(params: GridDraggingEvent): void;
    onDragStop(params: GridDraggingEvent): void;
    onDragCancel(): void;
}
export declare class BodyDropTarget extends BeanStub implements DropTarget {
    private readonly eContainer;
    private eSecondaryContainers;
    private eGridViewport;
    private currentDropListener;
    private lastDetectedSection;
    private moveColumnFeatures;
    private bodyDropPivotTargets;
    constructor(eContainer: HTMLElement);
    postConstruct(): void;
    isInterestedIn(type: DragSourceType): boolean;
    getSecondaryContainers(): HTMLElement[][];
    getContainer(): HTMLElement;
    getIconName(): DragAndDropIcon | null;
    private isDropColumnInPivotMode;
    onDragEnter(draggingEvent: GridDraggingEvent): void;
    onDragLeave(params: GridDraggingEvent): void;
    onDragging(params: GridDraggingEvent): void;
    onDragStop(params: GridDraggingEvent): void;
    onDragCancel(): void;
    private getSection;
    private getDropListener;
    private getPinnedSection;
}
