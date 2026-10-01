import type { AgColumn } from '../entities/agColumn';
import type { AgProvidedColumnGroup } from '../entities/agProvidedColumnGroup';
import type { GridOptionsService } from '../gridOptionsService';
export declare function placeLockedColumns(cols: AgColumn[], gos: GridOptionsService): AgColumn[];
/** Callers gate on `colModel.hasMarryChildren`, so a married group always exists here — the
 *  position-index Map is always needed, hence built eagerly. */
export declare function doesMovePassMarryChildren(allColumnsCopy: AgColumn[], gridBalancedTree: (AgColumn | AgProvidedColumnGroup)[]): boolean;
