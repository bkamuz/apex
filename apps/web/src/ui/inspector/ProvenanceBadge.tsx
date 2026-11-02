import { useI18n } from '../../i18n';
import type { ProvenanceRow } from './model';

/** Small letter chip telling where a value comes from: genus, species, instance, formula, inherited. */
export function ProvenanceBadge({ row }: { row: ProvenanceRow }) {
  const { t } = useI18n();
  const title = t(`inspector.prov.${row.source}`, { from: row.from ?? '', formula: row.formula ?? '' });
  return (
    <span
      className={`prov-badge prov-${row.source}`}
      data-prov={row.source}
      title={title}
      aria-label={title}
    >
      {t(`inspector.provShort.${row.source}`)}
    </span>
  );
}
