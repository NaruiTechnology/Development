import type { BeanCollection } from '../context/context';
import { AgColumn } from '../entities/agColumn';
import type { ColDef } from '../entities/colDef';
/** Constructs + registers a primary ('user'-kind) column from a user colDef: merges defaults/types,
 *  stamps the build token, registers the bean. Sole birthplace for build/calc columns.
 *  @internal AG_GRID_INTERNAL - Not for public use. Can change / be removed at any time. */
export declare function _createUserColumn(beans: BeanCollection, userColDef: ColDef, colId: string, isPrimary: boolean, buildToken: number): AgColumn;
/** @internal AG_GRID_INTERNAL - Not for public use. Can change / be removed at any time. */
export declare function _addColumnDefaultAndTypes(beans: BeanCollection, colDef: ColDef, colId: string, isAutoCol?: boolean): ColDef;
