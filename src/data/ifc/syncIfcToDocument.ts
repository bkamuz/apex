import type { Document, ElementRecord } from '../../core/document';

/** IFC entity types shown in the spatial tree (same filter as legacy SpatialTree). */
const SPATIAL_TREE_IFC_TYPES = new Set([
  'IFCPROJECT',
  'IFCSITE',
  'IFCBUILDING',
  'IFCBUILDINGSTOREY',
  'IFCWALLSTANDARDCASE',
  'IFCWALL',
  'IFCSLAB',
  'IFCCOLUMN',
  'IFCBEAM',
  'IFCWINDOW',
  'IFCDOOR',
]);

function shallowParameters(props: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(props)) {
    if (k === 'type') continue;
    if (v && typeof v === 'object' && 'value' in (v as object)) {
      out[k] = (v as { value: unknown }).value;
    } else {
      out[k] = v;
    }
  }
  return out;
}

export function extractIfcElementRecords(
  properties: Record<string, Record<string, unknown>> | undefined
): ElementRecord[] {
  if (!properties) return [];

  const records: ElementRecord[] = [];

  for (const [idStr, props] of Object.entries(properties)) {
    const expressId = parseInt(idStr, 10);
    if (Number.isNaN(expressId)) continue;

    const type =
      props.type !== undefined && typeof props.type === 'string'
        ? props.type
        : 'Unknown';

    if (!SPATIAL_TREE_IFC_TYPES.has(type)) continue;

    const nameRaw = props.Name;
    const name =
      nameRaw &&
      typeof nameRaw === 'object' &&
      nameRaw !== null &&
      'value' in nameRaw &&
      typeof (nameRaw as { value: unknown }).value === 'string'
        ? ((nameRaw as { value: string }).value as string)
        : `${type} ${expressId}`;

    let levelId: string | null = null;
    const storey = props.ObjectPlacement ?? props.ContainedInStructure;
    if (storey && typeof storey === 'object' && storey !== null && 'value' in storey) {
      const v = (storey as { value: unknown }).value;
      if (typeof v === 'number') {
        const storeyProps = properties[String(v)];
        if (storeyProps?.type === 'IFCBUILDINGSTOREY') {
          levelId = `ifc-storey-${v}`;
        }
      }
    }

    const id = `ifc-${expressId}`;

    records.push({
      id,
      kind: 'ifc',
      category: type,
      name,
      levelId,
      expressId,
      parameters: shallowParameters(props),
      geometry: { kind: 'ifc', expressId },
    });
  }

  return records;
}

/** Replace all IFC-backed elements; keeps native elements in the document. */
export function replaceIfcElementsInDocument(
  document: Document,
  properties: Record<string, Record<string, unknown>> | undefined
): void {
  document.removeByKind('ifc');
  const records = extractIfcElementRecords(properties);
  for (const r of records) {
    document.upsert(r);
  }
}
