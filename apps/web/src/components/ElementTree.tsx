import type { ElementListDto } from '../types';

interface Props {
  elements: ElementListDto[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}

export function ElementTree({ elements, selectedId, onSelect }: Props) {
  if (elements.length === 0) {
    return <div className="empty">No elements yet. Use Wall to place the first one.</div>;
  }

  return (
    <ul className="element-list">
      {elements.map((el) => (
        <li
          key={el.id}
          className={el.id === selectedId ? 'selected' : ''}
          onClick={() => onSelect(el.id)}
        >
          <span>{el.name}</span>
          <span className="cat">{el.category}</span>
        </li>
      ))}
    </ul>
  );
}
