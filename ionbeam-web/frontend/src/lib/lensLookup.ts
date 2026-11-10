/** Original values live in processingPatterns.json; voltages and current bounds are never silently combined. */
export interface LensRow {
  sourceRow: number;
  stepsBetweenApertures: number | null;
  beamVoltageKV: number;
  apertureDiameterUM: number | string;
  beamCurrentPA: number | string;
  lens1KV: number | string;
  spotSizeAngstrom: number;
}
export interface LensLookup {
  schemaVersion: 1;
  name: string;
  source: {file: string; sheet: string; range: string; sha256: string};
  sourceHeaders: string[];
  rows: LensRow[];
  notes: {sourceRow: number; text: string}[];
  interpolation: string;
}
export interface SpotSizeResult {
  beamVoltageKV: number; beamCurrentPA: number;
  status: "exact" | "interpolated" | "unavailable";
  spotSizeNM: number | null; spotSizeUM: number | null;
  sourceRows: number[]; requiresSLF: boolean; reason?: string;
}
const object = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
function positive(v: unknown, name: string, zero = false): asserts v is number {
  if (typeof v !== "number" || !Number.isFinite(v) || (zero ? v < 0 : v <= 0)) throw new Error(`${name} must be a finite ${zero ? "nonnegative" : "positive"} number`);
}
function reference(v: unknown, name: string, bound = false, star = false) {
  if (typeof v === "string") {
    const pattern = new RegExp(`^${bound ? "<?" : ""}(?:[0-9]+(?:\\.[0-9]*)?|\\.[0-9]+)${star ? "\\*?" : ""}$`);
    if (!pattern.test(v)) throw new Error(`Invalid ${name} qualifier`);
    positive(Number(v.replace(/^</, "").replace(/\*$/, "")), name);
  } else positive(v, name);
}
export function parseLensLookup(raw: unknown): LensLookup {
  if (!object(raw) || raw.schemaVersion !== 1 || !Array.isArray(raw.rows) || !raw.rows.length) throw new Error("LensLookup needs schemaVersion 1 and nonempty rows");
  const source=raw.source;
  if (!object(source) || !["file","sheet","range","sha256"].every(k => typeof source[k] === "string" && source[k])) throw new Error("LensLookup needs source provenance");
  if (typeof raw.name !== "string" || typeof raw.interpolation !== "string" || !Array.isArray(raw.sourceHeaders) || raw.sourceHeaders.length !== 6 || raw.sourceHeaders.some(h=>typeof h !== "string")) throw new Error("Invalid lens table metadata");
  if (!/^[0-9a-f]{64}$/.test(String(source.sha256))) throw new Error("Invalid lens source SHA256");
  const ids = new Set<number>(), anchors = new Set<string>();
  for (const row of raw.rows) {
    if (!object(row) || typeof row.sourceRow !== "number" || !Number.isInteger(row.sourceRow) || row.sourceRow <= 0 || ids.has(row.sourceRow)) throw new Error("Lens source rows must be unique positive integers");
    ids.add(row.sourceRow);
    positive(row.beamVoltageKV, "beamVoltageKV");
    reference(row.beamCurrentPA, "beamCurrentPA", true);
    const key = JSON.stringify([row.beamVoltageKV, row.beamCurrentPA]);
    if (anchors.has(key)) throw new Error("Duplicate voltage/current lens reference");
    anchors.add(key);
    reference(row.apertureDiameterUM, "apertureDiameterUM", true);
    reference(row.lens1KV, "lens1KV", false, true);
    positive(row.spotSizeAngstrom, "spotSizeAngstrom");
    if (row.stepsBetweenApertures !== null) positive(row.stepsBetweenApertures, "stepsBetweenApertures");
  }
  if (!Array.isArray(raw.notes) || raw.notes.some(n => !object(n) || typeof n.text !== "string" || !Number.isInteger(n.sourceRow))) throw new Error("Invalid lens notes");
  return raw as unknown as LensLookup;
}
export function lookupSpotSize(table: LensLookup, voltageKV: number, currentPA: number, interpolate = false): SpotSizeResult {
  positive(voltageKV,"beam voltage"); positive(currentPA,"beam current");
  const rows = table.rows.filter(r => r.beamVoltageKV === voltageKV && typeof r.beamCurrentPA === "number").sort((a,b) => Number(a.beamCurrentPA)-Number(b.beamCurrentPA));
  const result: SpotSizeResult = {beamVoltageKV:voltageKV,beamCurrentPA:currentPA,status:"unavailable",spotSizeNM:null,spotSizeUM:null,sourceRows:[],requiresSLF:false};
  const exact = rows.find(r => r.beamCurrentPA === currentPA);
  let selected: LensRow[] = exact ? [exact] : [], angstrom = exact?.spotSizeAngstrom;
  if (exact) result.status = "exact";
  if (angstrom === undefined && interpolate) for (let i=1; i<rows.length; i++) {
    const lo=rows[i-1], hi=rows[i];
    if (Number(lo.beamCurrentPA) < currentPA && currentPA < Number(hi.beamCurrentPA)) {
      const ratio=(currentPA-Number(lo.beamCurrentPA))/(Number(hi.beamCurrentPA)-Number(lo.beamCurrentPA));
      angstrom=lo.spotSizeAngstrom+ratio*(hi.spotSizeAngstrom-lo.spotSizeAngstrom);
      selected=[lo,hi];result.status="interpolated";break;
    }
  }
  if (angstrom === undefined) result.reason="No supported current reference at this voltage. Bounded rows are reference only; extrapolation and interpolation between voltages are disabled.";
  else { result.spotSizeNM=angstrom/10;result.spotSizeUM=angstrom/10000;result.sourceRows=selected.map(r=>r.sourceRow);result.requiresSLF=selected.some(r=>typeof r.lens1KV === "string" && r.lens1KV.endsWith("*")); }
  return result;
}
export function estimateMillingDepth(currentPA: number, exposureTimeS: number, areaUM2: number, removalRateUM3PerNC: number) {
  positive(currentPA,"beam current",true);positive(exposureTimeS,"beam-on exposure time",true);positive(areaUM2,"area");positive(removalRateUM3PerNC,"calibrated removal rate");
  const chargeNC=currentPA*exposureTimeS/1000,volumeUM3=chargeNC*removalRateUM3PerNC,depthUM=volumeUM3/areaUM2;
  if (!Number.isFinite(volumeUM3) || !Number.isFinite(depthUM)) throw new Error("Milling estimate overflow");
  return {chargeNC,volumeUM3,depthUM};
}
