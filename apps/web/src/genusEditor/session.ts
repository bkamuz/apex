/**
 * Whether the genus editor mode is showing. The project's global keyboard
 * handlers check this so project shortcuts (Delete, Ctrl+Z, tools…) do not
 * act on the hidden project while the editor is open.
 */
let open = false;
/** Project is showing a genus preview (Apply / Discard). Undo is held. */
let testing = false;

export function isGenusEditorOpen(): boolean {
  return open;
}

export function setGenusEditorOpen(value: boolean): void {
  open = value;
}

export function isGenusTestActive(): boolean {
  return testing;
}

export function setGenusTestActive(value: boolean): void {
  testing = value;
}
