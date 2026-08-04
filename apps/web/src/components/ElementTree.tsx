import type { ElementListDto } from '../types';

interface Props {
  elements: ElementListDto[];
  selectedIds: string[];
  onSelect: (id: string, multi: boolean) => void;
}

export function ElementTree({ elements, selectedIds, onSelect }: Props) {
  if (elements.length === 0) {
    return <div className="empty">No elements yet. Use Wall to place the first one.</div>;
  }

  const selected = new Set(selectedIds);

  return (
    <ul className="element-list">
      {elements.map((el) => (
        <li
          key={el.id}
          className={selected.has(el.id) ? 'selected' : ''}
          onClick={(event) => onSelect(el.id, event.ctrlKey || event.metaKey)}
        >
          <span>{el.name}</span>
          <span className="cat">{el.category}</span>
        </li>
      ))}
    </ul>
  );
}
