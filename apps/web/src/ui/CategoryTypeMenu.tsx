import { useEffect, useMemo, useRef, useState } from 'react';
import { componentDisplayName, speciesDisplayName, useI18n } from '../i18n';
import { genusTooltip } from '../tools/categorySlots';
import type { Tool } from '../tools/Tool';
import type { ComponentDto, SpeciesDto } from '../types';
import { apexRunQuery } from '../wasm/apex';

/**
 * Genus → species picker for the active category tool.
 * The context bar shows the current type; the ribbon caret opens the same list.
 */
export function CategoryTypeMenu({
  tool,
  species,
  variant,
  onActivate,
}: {
  tool: Tool;
  /** Known species. When omitted, the list is loaded when the menu opens. */
  species?: readonly SpeciesDto[];
  variant: 'bar' | 'caret';
  /** Ribbon caret: choosing a type also activates the category tool. */
  onActivate?: (toolId: string) => void;
}) {
  const { t, locale } = useI18n();
  const genera = tool.categoryGenera?.() ?? [];
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [rows, setRows] = useState<SpeciesDto[]>(() => (species ? [...species] : []));
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const anchorRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (species) setRows([...species]);
  }, [species]);

  useEffect(() => {
    if (!open) return;
    if (!species) {
      try {
        setRows(apexRunQuery({ op: 'list_genus_species' }) as SpeciesDto[]);
      } catch {
        setRows([]);
      }
    }
    const rect = anchorRef.current?.getBoundingClientRect();
    if (rect) {
      setPos({ top: rect.bottom + 4, left: Math.max(8, Math.min(rect.left, window.innerWidth - 280)) });
    }
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Node;
      if (anchorRef.current?.contains(target) || panelRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    window.addEventListener('pointerdown', onPointer, true);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onPointer, true);
      window.removeEventListener('keydown', onKey);
    };
  }, [open, species]);

  const total = useMemo(() => {
    let count = 0;
    for (const genus of genera) {
      count += 1;
      count += rows.filter((row) => row.genus === genus.id).length;
    }
    return count;
  }, [genera, rows]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const out: { key: string; genus: ComponentDto; species?: SpeciesDto; label: string; indent: boolean }[] = [];
    for (const genus of genera) {
      const name = componentDisplayName(genus.id, genus.display_name);
      const own = rows.filter((row) => row.genus === genus.id);
      const genusHit = !q || name.toLowerCase().includes(q) || genus.display_name.toLowerCase().includes(q);
      const speciesHits = own.filter((row) => {
        const label = speciesDisplayName(row);
        return label.toLowerCase().includes(q) || row.name.toLowerCase().includes(q);
      });
      if (q && !genusHit && speciesHits.length === 0) continue;
      if (own.length === 0) {
        out.push({ key: genus.id, genus, label: name, indent: false });
        continue;
      }
      out.push({ key: genus.id, genus, label: name, indent: false });
      const shown = !q || genusHit ? own : speciesHits;
      for (const row of shown) {
        out.push({
          key: row.id,
          genus,
          species: row,
          label: speciesDisplayName(row),
          indent: true,
        });
      }
    }
    return out;
  }, [genera, rows, query, locale]);

  const genusId = tool.componentId;
  const speciesId = tool.placementSpeciesId?.() ?? null;
  const currentGenus = genera.find((item) => item.id === genusId);
  const currentSpecies = rows.find((row) => row.id === speciesId);
  const currentName = currentGenus
    ? componentDisplayName(currentGenus.id, currentGenus.display_name)
    : '';
  const buttonText = currentSpecies
    ? `${currentName} › ${speciesDisplayName(currentSpecies)}`
    : currentName;

  const pick = (nextGenus: string, nextSpecies: string | null) => {
    tool.setPlacementTarget?.(nextGenus, nextSpecies);
    setOpen(false);
    setQuery('');
    if (variant === 'caret') onActivate?.(tool.id);
  };

  const toggle = () => setOpen((value) => !value);

  const panel =
    open && pos ? (
      <div
        ref={panelRef}
        className="category-type-panel"
        style={{ top: pos.top, left: pos.left }}
        role="listbox"
        aria-label={t('ctx.typeMenu')}
        data-testid="category-type-panel"
      >
        {total > 8 ? (
          <input
            className="category-type-search"
            data-testid="category-type-search"
            placeholder={t('ctx.typeSearch')}
            aria-label={t('ctx.typeSearch')}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            autoFocus
          />
        ) : null}
        {visible.length === 0 ? <div className="category-type-empty">{t('palette.empty')}</div> : null}
        {visible.map((row) => {
          const selected = row.species
            ? row.species.id === speciesId
            : !row.species && row.genus.id === genusId && !currentSpecies;
          return (
            <button
              key={row.key}
              type="button"
              role="option"
              aria-selected={selected}
              className={`category-type-option${row.indent ? ' is-species' : ' is-genus'}${selected ? ' active' : ''}`}
              data-testid={row.species ? `category-type-species-${row.species.id}` : `category-type-genus-${row.genus.id}`}
              title={genusTooltip(row.genus)}
              onClick={() => pick(row.genus.id, row.species?.id ?? null)}
            >
              {row.label}
            </button>
          );
        })}
      </div>
    ) : null;

  if (variant === 'caret') {
    return (
      <>
        <button
          ref={anchorRef}
          type="button"
          className="rb-split-caret"
          data-testid={`category-type-caret-${tool.id}`}
          aria-label={t('ctx.typeMenu')}
          aria-expanded={open}
          title={t('ctx.typeMenu')}
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            event.preventDefault();
            event.stopPropagation();
            toggle();
          }}
        >
          <span aria-hidden="true">▾</span>
        </button>
        {panel}
      </>
    );
  }

  return (
    <span className="ctx-item" data-testid="ctx-genus-species">
      <span className="ctx-k">{t('ctx.genusSpecies')}</span>
      <button
        ref={anchorRef}
        type="button"
        className="ctx-type-btn"
        data-testid="category-type-button"
        aria-expanded={open}
        aria-haspopup="listbox"
        title={currentGenus ? genusTooltip(currentGenus) : t('ctx.typeMenu')}
        onClick={toggle}
      >
        {buttonText}
      </button>
      {panel}
    </span>
  );
}
