import type { Document } from '../../core/document';

export interface TreeNode {
  expressID: number;
  rowKey: string;
  name: string;
  type: string;
  children: TreeNode[];
}

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

/**
 * Builds the same grouped-by-type tree as the legacy SpatialTree, from Document IFC elements.
 */
export function buildSpatialTreeFromDocument(
  document: Document,
  rootName: string
): TreeNode[] {
  const ifcElements = document
    .getAll()
    .filter((e) => e.kind === 'ifc' && SPATIAL_TREE_IFC_TYPES.has(e.category));

  if (ifcElements.length === 0) return [];

  const flatGroups: Record<string, TreeNode> = {};

  for (const el of ifcElements) {
    const expressId = el.expressId ?? -1;
    const type = el.category;

    if (!flatGroups[type]) {
      flatGroups[type] = {
        expressID: -1,
        rowKey: `GROUP-${type}`,
        name: type,
        type: 'GROUP',
        children: [],
      };
    }
    flatGroups[type].children.push({
      expressID: expressId,
      rowKey: `e-${expressId}`,
      name: el.name,
      type,
      children: [],
    });
  }

  const rootNode: TreeNode = {
    expressID: 0,
    rowKey: 'root-model',
    name: rootName || 'IFC Model',
    type: 'MODEL',
    children: Object.values(flatGroups),
  };

  return [rootNode];
}
