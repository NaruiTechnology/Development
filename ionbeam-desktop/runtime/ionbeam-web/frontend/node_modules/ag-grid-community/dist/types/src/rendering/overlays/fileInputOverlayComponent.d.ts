import type { IFileInputOverlayParams, IOverlay, IOverlayComp, IOverlayParams, OverlayComponentUserParams } from './overlayComponent';
import { OverlayComponent } from './overlayComponent';
export interface IFileInputOverlay<TData = any, TContext = any> extends IOverlay<TData, TContext, IFileInputOverlayParams<TData, TContext>> {
}
export interface IFileInputOverlayComp<TData = any, TContext = any> extends IOverlayComp<TData, TContext, IFileInputOverlayParams<TData, TContext>> {
}
export declare class FileInputOverlayComponent extends OverlayComponent<any, any, IOverlayParams & OverlayComponentUserParams> implements IFileInputOverlayComp<any, any> {
    private readonly eErrorBanner;
    private readonly eDropZone;
    private readonly eProcessingState;
    private state;
    private dragCounter;
    private processingToken;
    init(params: IFileInputOverlayParams & OverlayComponentUserParams): void;
    private buildDropZone;
    private updateProcessingState;
    private showError;
    private appendBrowseButton;
    private showState;
    private setupDragListeners;
    private isFileDrag;
    private onFileInputChange;
    private handleFileList;
    private handleFiles;
}
