import { useI18n } from '../i18n';
import type { GenusTree, TestHost, TreeItem } from './model';

export interface GenusStructureTreeProps {
  tree: GenusTree;
  host: TestHost | null;
  selected: string | null;
  onSelect: (id: string | null) => void;
  nameOf: (id: string) => string;
  baseName: string | null;
}

function Row({
  item,
  selected,
  onSelect,
  nameOf,
}: {
  item: TreeItem;
  selected: boolean;
  onSelect: (id: string) => void;
  nameOf: (id: string) => string;
}) {
  const { t } = useI18n();
  let detail = '';
  if (item.kind === 'ref') detail = t(`genusEditor.refKind.${item.detail.split(' ')[0]}`, undefined, item.detail);
  else if (item.kind === 'nested') detail = `↳ ${nameOf(item.detail)}`;
  else if (item.kind === 'cut')
    detail = `${t('genusEditor.cutArrow')} ${(item.targets ?? []).map((x) => t(`genusEditor.target.${x}`)).join(', ') || t('genusEditor.target.none')}`;
  else detail = t(`genusEditor.shape.${item.detail}`, undefined, item.detail);
  if (item.visible) detail += ` · ${t('genusEditor.ifShort', { cond: item.visible })}`;
  const cls = [
    'genus-tree-row',
    `is-${item.kind}`,
    item.inherited ? 'is-inherited' : '',
    item.removed ? 'is-removed' : '',
    selected ? 'is-selected' : '',
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <li>
      <button
        type="button"
        className={cls}
        data-testid={`genus-tree-${item.id}`}
        data-kind={item.kind}
        aria-pressed={selected}
        onClick={() => onSelect(item.id)}
        title={item.removed ? t('genusEditor.removedTitle') : item.overrides ? t('genusEditor.overridesTitle') : undefined}
      >
        <span className="genus-tree-dot" aria-hidden="true" />
        <span className="genus-tree-name">{nameOf(item.id)}</span>
        <span className="genus-tree-detail">{item.removed ? t('genusEditor.removed') : detail}</span>
      </button>
    </li>
  );
}

/** Структура: references, body (colour-coded), inherited items and the test host. */
export function GenusStructureTree(props: GenusStructureTreeProps) {
  const { t } = useI18n();
  const { tree, selected, onSelect, nameOf } = props;
  const section = (key: string, title: string, items: TreeItem[], empty: string) => (
    <section className="genus-tree-section" data-section={key}>
      <h3 className="genus-tree-title">
        {title}
        <span className="genus-tree-count">{items.length}</span>
      </h3>
      {items.length === 0 ? (
        <div className="genus-tree-empty">{empty}</div>
      ) : (
        <ul>
          {items.map((item) => (
            <Row key={`${key}:${item.id}`} item={item} selected={selected === item.id} onSelect={onSelect} nameOf={nameOf} />
          ))}
        </ul>
      )}
    </section>
  );
  return (
    <div className="genus-tree" data-testid="genus-structure">
      {section('refs', t('genusEditor.tree.refs'), tree.refs, t('genusEditor.tree.noRefs'))}
      {section('body', t('genusEditor.tree.body'), tree.body, tree.inheritedFrom ? t('genusEditor.tree.bodyEmptyInherited') : t('genusEditor.tree.noBody'))}
      {tree.inheritedFrom
        ? section(
            'inherited',
            t('genusEditor.tree.inherited', { name: props.baseName ?? tree.inheritedFrom }),
            tree.inherited,
            t('genusEditor.tree.noInherited'),
          )
        : null}
      <section className="genus-tree-section" data-section="host">
        <h3 className="genus-tree-title">{t('genusEditor.tree.host')}</h3>
        {props.host ? (
          <ul>
            <li>
              <button
                type="button"
                className={`genus-tree-row is-host${selected === '#host' ? ' is-selected' : ''}`}
                data-testid="genus-tree-host"
                onClick={() => onSelect('#host')}
              >
                <span className="genus-tree-dot" aria-hidden="true" />
                <span className="genus-tree-name">
                  {t(`genusEditor.host.${props.host.category}`, { mm: Math.round(props.host.depth * 1000) }, t('genusEditor.host.generic', { category: props.host.category, mm: Math.round(props.host.depth * 1000) }))}
                </span>
                <span className="genus-tree-detail">{t('genusEditor.host.sample')}</span>
              </button>
            </li>
          </ul>
        ) : (
          <div className="genus-tree-empty">{t('genusEditor.tree.noHost')}</div>
        )}
      </section>
    </div>
  );
}
