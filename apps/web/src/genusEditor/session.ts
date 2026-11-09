/**
 * Whether the genus editor mode is showing. The project's global keyboard
 * handlers check this so project shortcuts (Delete, Ctrl+Z, tools…) do not
 * act on the hidden project while the editor is open.
 */
let open = false;

export function isGenusEditorOpen(): boolean {
  return open;
}

export function setGenusEditorOpen(value: boolean): void {
  open = value;
}
