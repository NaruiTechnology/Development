import type { DatumKey, ResolvedDatumKey } from './types';
type Expect<T extends true> = T;
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
export type _DatumKeyChecks = [
    Expect<Equal<DatumKey<{
        x: {
            date: string;
        };
    }>, 'x' | 'x.date'>>,
    Expect<Equal<DatumKey<{
        a: {
            b: {
                c: {
                    d: string;
                };
            };
        };
    }>, 'a' | 'a.b' | 'a.b.c' | 'a.b.c.d'>>,
    Expect<Equal<DatumKey<{
        a?: {
            b: string;
        };
    }>, 'a' | 'a.b'>>,
    Expect<Equal<DatumKey<{
        items: Array<{
            name: string;
        }>;
    }>, 'items'>>,
    Expect<Equal<DatumKey<{
        d: Date;
        label: string;
    }>, 'd' | 'label'>>,
    Expect<Equal<DatumKey<Record<string, number>>, string>>,
    Expect<Equal<DatumKey<any>, string>>,
    Expect<Equal<DatumKey<number>, string>>
];
export type _ResolvedDatumKeyChecks = [
    Expect<Equal<ResolvedDatumKey<{
        x: {
            date: string;
        };
    }>, 'x'>>,
    Expect<Equal<ResolvedDatumKey<{
        a: {
            b: {
                c: string;
            };
        };
        label: string;
    }>, 'a' | 'label'>>,
    Expect<Equal<ResolvedDatumKey<Record<string, number>>, string>>,
    Expect<Equal<ResolvedDatumKey<any>, string>>,
    Expect<Equal<ResolvedDatumKey<number>, string>>
];
export {};
