import { useI18n } from '../i18n';
import type { ProjectionMode, ViewNavigationMode } from '../viewport/ViewportRenderer';

type Props = {
  viewNavigation: ViewNavigationMode;
  projection: ProjectionMode;
  onSetViewNavigation: (mode: ViewNavigationMode) => void;
  onSetProjection: (mode: ProjectionMode) => void;
  onFitView: () => void;
};

/** Floating view pill over the viewport: 3D / Plan · Fit · (3D only) Axon / Persp. */
export function ViewPill(p: Props) {
  const { t } = useI18n();
  const is3d = p.viewNavigation === '3d';
  return (
    <div className="view-pill" role="toolbar" aria-label={t('toolbar.view')} data-testid="view-controls">
      <button
        type="button"
        className={is3d ? 'active' : ''}
        onClick={() => p.onSetViewNavigation('3d')}
        title={t('toolbar.view3dTitle')}
        data-testid="view-3d"
      >
        {t('toolbar.view3d')}
      </button>
      <button
        type="button"
        className={p.viewNavigation === 'plan' ? 'active' : ''}
        onClick={() => p.onSetViewNavigation('plan')}
        title={t('toolbar.planTitle')}
        data-testid="view-plan"
      >
        {t('toolbar.plan')}
      </button>
      <span className="view-pill-sep" aria-hidden="true" />
      <button type="button" onClick={p.onFitView} title={t('toolbar.fitTitle')} data-testid="fit-view">
        {t('toolbar.fit')}
      </button>
      {is3d ? (
        <>
          <span className="view-pill-sep" aria-hidden="true" />
          <button
            type="button"
            className={p.projection === 'orthographic' ? 'active' : ''}
            onClick={() => p.onSetProjection('orthographic')}
            title={t('toolbar.axonTitle')}
            data-testid="view-axon"
          >
            {t('toolbar.axon')}
          </button>
          <button
            type="button"
            className={p.projection === 'perspective' ? 'active' : ''}
            onClick={() => p.onSetProjection('perspective')}
            title={t('toolbar.perspTitle')}
            data-testid="view-persp"
          >
            {t('toolbar.persp')}
          </button>
        </>
      ) : null}
    </div>
  );
}
