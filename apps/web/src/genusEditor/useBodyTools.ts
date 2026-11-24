/**
 * Genus editor: placing a nested genus with a click in a view, and the
 * mirror tool (pick a plane ref → a mirrored copy of the selected item).
 */
import { useState } from 'react';
import type { GenusBodyItemDto, GenusDefDto } from '../types';
import type { ViewInteract } from './GenusOrthoView';
import type { GenusDraft } from './model';
import { mirrorBlock, mirrorItem, newNested, type MirrorBlock } from './nested';
import type { OrthoView } from './projection';
import { nextId, snap, takenIds, toGenus, type EvalRef } from './refs';

type Mode = { kind: 'nest'; genus: string } | { kind: 'mirror'; item: string } | null;

/** Why a click did nothing (catalog key genusEditor.mirror.no.<code>). */
export type BodyNote = MirrorBlock | 'pickPlane' | null;

interface Args {
  draft: GenusDraft | null;
  parent: GenusDefDto | null;
  refs: EvalRef[];
  patch: (fn: (d: GenusDraft) => GenusDraft) => void;
  setSelected: (id: string | null) => void;
  enabled: boolean;
}

export function useBodyTools(a: Args) {
  const { draft, parent, refs, patch, setSelected, enabled } = a;
  const [mode, setMode] = useState<Mode>(null);
  const [note, setNote] = useState<BodyNote>(null);

  const add = (item: GenusBodyItemDto) => {
    patch((d) => ({ ...d, body: [...d.body, item] }));
    setSelected(item.id);
    setMode(null);
    setNote(null);
  };

  const startNest = (genus: string) => {
    setNote(null);
    setMode((m) => (m?.kind === 'nest' ? null : { kind: 'nest', genus }));
  };
  const setNestGenus = (genus: string) => setMode((m) => (m?.kind === 'nest' ? { ...m, genus } : m));
  const startMirror = (item: string) => {
    setNote(null);
    setMode((m) => (m?.kind === 'mirror' ? null : { kind: 'mirror', item }));
  };
  const cancel = (): boolean => {
    if (!mode) return false;
    setMode(null);
    setNote(null);
    return true;
  };

  const place = (view: OrthoView, hitRef: string | null, u: number, v: number) => {
    if (!draft || !mode) return;
    const taken = takenIds(draft, parent);
    const ref = hitRef ? refs.find((r) => r.id === hitRef) : undefined;
    if (mode.kind === 'nest') {
      const at = ref?.kind === 'point' ? { ref: ref.id } : { point: toGenus(view, snap(u, 0.005), snap(v, 0.005)) };
      add(newNested(nextId('nested', taken), mode.genus, at));
      return;
    }
    if (!ref || ref.kind !== 'plane' || !ref.normal) {
      setNote('pickPlane');
      return;
    }
    const item = draft.body.find((b) => b.id === mode.item);
    if (!item) {
      cancel();
      return;
    }
    const block = mirrorBlock(item, ref.normal);
    const copy = block ? null : mirrorItem(item, nextId(`${item.id}_m`, taken), ref.id, ref.normal);
    if (!copy) {
      setNote(block ?? 'shape');
      return;
    }
    add(copy);
  };

  const interact = (view: OrthoView): ViewInteract | undefined => {
    if (!enabled || !mode) return undefined;
    return {
      placing: true,
      pending: [],
      picked: null,
      onPlace: (hit, p) => place(view, hit.kind === 'ref' ? hit.id : null, p[0], p[1]),
      onFinish: () => {},
      onDragStart: () => false,
      onDragMove: () => {},
      onDragEnd: () => {},
    };
  };

  return { mode, note, setNote, startNest, setNestGenus, startMirror, cancel, interact };
}
