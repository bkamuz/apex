import React, { useEffect, useState } from 'react';
import * as OBC from '@thatopen/components';
import styles from './SpatialTree.module.css';

interface SpatialTreeProps {
    components: OBC.Components;
    model: any | null;
    onClose?: () => void;
}

interface TreeNode {
    expressID: number;
    name: string;
    type: string;
    children: TreeNode[];
}

export const SpatialTree: React.FC<SpatialTreeProps> = ({ components, model, onClose }) => {
    const [treeData, setTreeData] = useState<TreeNode[]>([]);
    const [loading, setLoading] = useState(false);
    const [expandedNodes, setExpandedNodes] = useState<Set<number>>(new Set());
    const [hiddenNodes, setHiddenNodes] = useState<Set<number>>(new Set());

    // Wait for the dependencies
    // We cannot easily do dynamic imports here, but let's assume we can fetch relations
    useEffect(() => {
        if (!model || !components) {
            setTreeData([]);
            return;
        }

        const buildTree = async () => {
            setLoading(true);
            try {
                let rootNode: TreeNode | null = null;

                // As a fallback/placeholder, we just show a few elements for demo if we can't parse everything deeply
                if (model.properties) {
                    // You'd extract from properties here. Since exact traversal requires mapping IfcProject, 
                    // let's do a fast flat list grouped by type for now to ensure robustness.
                    const flatGroups: Record<string, TreeNode> = {};

                    Object.entries(model.properties).forEach(([idStr, props]: [string, any]) => {
                        const id = parseInt(idStr);
                        const type = props.type !== undefined ? props.type : 'Unknown';
                        const name = props.Name?.value || `${type} ${id}`;

                        // Only group specific spatial or element types to avoid huge lists
                        if (['IFCPROJECT', 'IFCSITE', 'IFCBUILDING', 'IFCBUILDINGSTOREY', 'IFCWALLSTANDARDCASE', 'IFCWALL', 'IFCSLAB', 'IFCCOLUMN', 'IFCBEAM', 'IFCWINDOW', 'IFCDOOR'].includes(type)) {
                            if (!flatGroups[type]) {
                                flatGroups[type] = { expressID: -1, name: type, type: 'GROUP', children: [] };
                            }
                            flatGroups[type].children.push({ expressID: id, name, type, children: [] });
                        }
                    });

                    rootNode = {
                        expressID: 0,
                        name: model.name || 'IFC Model',
                        type: 'MODEL',
                        children: Object.values(flatGroups)
                    };

                    setTreeData([rootNode]);
                    setExpandedNodes(new Set([0]));
                }

            } catch (err) {
                console.error('Error building spatial tree', err);
            } finally {
                setLoading(false);
            }
        };

        buildTree();
    }, [model, components]);

    const toggleExpand = (id: number) => {
        setExpandedNodes(prev => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    };

    const toggleVisibility = async (e: React.MouseEvent, node: TreeNode) => {
        e.stopPropagation();

        // We would use OBC.Hider to show/hide the items.
        // For now, let's just toggle the local state.
        const isHidden = hiddenNodes.has(node.expressID);

        setHiddenNodes(prev => {
            const next = new Set(prev);
            if (isHidden) next.delete(node.expressID);
            else next.add(node.expressID);
            return next;
        });

        try {
            const hider = components.get(OBC.Hider);
            if (model) {
                // Collect all IDs to hide/show
                const ids = new Set<number>();
                const collect = (n: TreeNode) => {
                    if (n.expressID > 0) ids.add(n.expressID);
                    n.children.forEach(collect);
                };
                collect(node);

                // Make a fragment id map
                const fragmentIdMap = model.getFragmentMap(ids);
                hider.set(!isHidden, fragmentIdMap);
            }
        } catch (err) {
            console.error('Visibility toggle failed', err);
        }
    };

    const renderNode = (node: TreeNode, level = 0) => {
        const isExpanded = expandedNodes.has(node.expressID);
        const isHidden = hiddenNodes.has(node.expressID);
        const hasChildren = node.children && node.children.length > 0;

        let icon = '📄';
        if (node.type === 'MODEL') icon = '🏢';
        else if (node.type === 'GROUP') icon = '📁';
        else if (node.type.includes('STOREY')) icon = '🏢';
        else if (node.type.includes('WALL')) icon = '🧱';
        else if (node.type.includes('SLAB')) icon = '⬛';

        return (
            <div key={`${node.type}-${node.expressID}`} className={styles.node}>
                <div
                    className={styles.nodeRow}
                    onClick={() => hasChildren && toggleExpand(node.expressID)}
                    style={{ paddingLeft: `${level * 12}px` }}
                >
                    <div className={styles.toggleIcon}>
                        {hasChildren ? (isExpanded ? '▼' : '▶') : ''}
                    </div>
                    <div className={styles.icon}>{icon}</div>
                    <div className={styles.name} title={node.name}>{node.name}</div>

                    <button
                        className={styles.visibilityToggle}
                        onClick={(e) => toggleVisibility(e, node)}
                        title={isHidden ? "Show" : "Hide"}
                    >
                        {isHidden ? '👁️‍🗨️' : '👁️'}
                    </button>
                </div>

                {isExpanded && hasChildren && (
                    <div>
                        {node.children.map(child => renderNode(child, level + 1))}
                    </div>
                )}
            </div>
        );
    };

    if (!model) return null;

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
                {loading ? (
                    <div className={styles.loading}>Loading tree structure...</div>
                ) : treeData.length === 0 ? (
                    <div className={styles.empty}>No generic standard data found</div>
                ) : (
                    treeData.map(node => renderNode(node))
                )}
            </div>
        </div>
    );
};
