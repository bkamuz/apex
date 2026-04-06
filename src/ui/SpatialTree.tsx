import React, { useState, useSyncExternalStore } from 'react';
import * as OBC from '@thatopen/components';
import type { IfcFragmentModelHandle } from '../types/bim';
import { buildSpatialTreeFromDocument, type TreeNode } from '../data/ifc';
import { useBimFacade } from '../api/useBimFacade';
import styles from './SpatialTree.module.css';

interface SpatialTreeProps {
  components: OBC.Components;
  fragmentModel: IfcFragmentModelHandle;
  rootName: string;
  onClose?: () => void;
}

export const SpatialTree: React.FC<SpatialTreeProps> = ({
  components,
  fragmentModel,
  rootName,
  onClose,
}) => {
  const { document } = useBimFacade();
  const treeVersion = useSyncExternalStore(
    (onStoreChange) => document.subscribe(() => onStoreChange()),
    () => document.getVersion(),
    () => document.getVersion()
  );

  const treeData = buildSpatialTreeFromDocument(document, rootName);
  void treeVersion;

  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(
    () => new Set(['root-model'])
  );
  const [hiddenKeys, setHiddenKeys] = useState<Set<string>>(new Set());

  const toggleExpand = (rowKey: string) => {
    setExpandedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(rowKey)) next.delete(rowKey);
      else next.add(rowKey);
      return next;
    });
  };

  const toggleVisibility = async (e: React.MouseEvent, node: TreeNode) => {
    e.stopPropagation();

    const isHidden = hiddenKeys.has(node.rowKey);

    setHiddenKeys((prev) => {
      const next = new Set(prev);
      if (isHidden) next.delete(node.rowKey);
      else next.add(node.rowKey);
      return next;
    });

    try {
      const hider = components.get(OBC.Hider);
      const ids = new Set<number>();
      const collect = (n: TreeNode) => {
        if (n.expressID > 0) ids.add(n.expressID);
        n.children.forEach(collect);
      };
      collect(node);

      if (ids.size > 0) {
        const fragmentIdMap = fragmentModel.getFragmentMap(ids);
        hider.set(!isHidden, fragmentIdMap);
      }
    } catch (err) {
      console.error('Visibility toggle failed', err);
    }
  };

  const renderNode = (node: TreeNode, level = 0) => {
    const isExpanded = expandedKeys.has(node.rowKey);
    const isHidden = hiddenKeys.has(node.rowKey);
    const hasChildren = node.children && node.children.length > 0;

    let icon = '📄';
    if (node.type === 'MODEL') icon = '🏢';
    else if (node.type === 'GROUP') icon = '📁';
    else if (node.type.includes('STOREY')) icon = '🏢';
    else if (node.type.includes('WALL')) icon = '🧱';
    else if (node.type.includes('SLAB')) icon = '⬛';

    return (
      <div key={node.rowKey} className={styles.node}>
        <div
          className={styles.nodeRow}
          onClick={() => hasChildren && toggleExpand(node.rowKey)}
          style={{ paddingLeft: `${level * 12}px` }}
        >
          <div className={styles.toggleIcon}>
            {hasChildren ? (isExpanded ? '▼' : '▶') : ''}
          </div>
          <div className={styles.icon}>{icon}</div>
          <div className={styles.name} title={node.name}>
            {node.name}
          </div>

          <button
            className={styles.visibilityToggle}
            onClick={(e) => toggleVisibility(e, node)}
            title={isHidden ? 'Show' : 'Hide'}
          >
            {isHidden ? '👁️‍🗨️' : '👁️'}
          </button>
        </div>

        {isExpanded && hasChildren && (
          <div>{node.children.map((child) => renderNode(child, level + 1))}</div>
        )}
      </div>
    );
  };

  return (
    <div className={styles.treeContainer}>
      <div className={styles.header}>
        Spatial Tree
        {onClose && (
          <button className={styles.closeButton} onClick={onClose}>
            ✕
          </button>
        )}
      </div>
      <div className={styles.content}>
        {treeData.length === 0 ? (
          <div className={styles.empty}>No IFC elements in document index</div>
        ) : (
          treeData.map((node) => renderNode(node))
        )}
      </div>
    </div>
  );
};
