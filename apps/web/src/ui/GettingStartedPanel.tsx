interface Props {
  onDismiss: () => void;
  onLoadSample: () => void;
}

export function GettingStartedPanel({ onDismiss, onLoadSample }: Props) {
  return (
    <div className="getting-started" data-testid="getting-started">
      <div className="getting-started-title">Getting started</div>
      <p>
        Draw walls <kbd>W</kbd>, switch to Plan <kbd>P</kbd>, frame the model <kbd>F</kbd>, then
        Move <kbd>M</kbd> or Copy <kbd>C</kbd>. Undo with <kbd>Ctrl+Z</kbd>. Or load the sample
        two-storey house with rooms and a pitched roof.
      </p>
      <div className="getting-started-actions">
        <button type="button" data-testid="load-sample-project" onClick={onLoadSample}>
          Load sample house
        </button>
        <button type="button" className="panel-action" onClick={onDismiss}>
          Dismiss
        </button>
      </div>
    </div>
  );
}
