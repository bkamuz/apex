interface Props {
  onDismiss: () => void;
  onLoadSample: () => void;
}

export function GettingStartedPanel({ onDismiss, onLoadSample }: Props) {
  return (
    <div className="getting-started" data-testid="getting-started">
      <div className="getting-started-kicker">Start here</div>
      <div className="getting-started-title">Empty project</div>
      <p>
        Place walls with <kbd>W</kbd>, switch to Plan <kbd>P</kbd>, frame with <kbd>F</kbd>.
        Move <kbd>M</kbd> · Copy <kbd>C</kbd> · Undo <kbd>Ctrl+Z</kbd>.
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
