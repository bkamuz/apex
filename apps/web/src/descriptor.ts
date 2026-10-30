/**
 * Machine-readable description every tool, plugin, annotation kind and element
 * type must carry. Humans read it in tooltips; agents (the MCP server) read it
 * to know what a thing does. See docs/descriptors.md.
 */
export interface DescriptorExample {
  readonly description: string;
  /** Command / params JSON an agent could send. */
  readonly input?: unknown;
}

export interface Descriptor {
  /** One or two sentences: what it is for. Required, non-empty. */
  readonly purpose: string;
  /** JSON Schema of parameters, when the thing takes any. */
  readonly params?: Record<string, unknown>;
  readonly examples?: readonly DescriptorExample[];
  /** Plain text, e.g. "lengths in metres, angles in radians". Same as core. */
  readonly units?: string;
  /** For element types: what `points` mean. */
  readonly points?: string;
  /** Plain-language rules: "needs a host wall", "points are on the active level". */
  readonly constraints?: readonly string[];
}

export class MissingDescriptorError extends Error {
  constructor(kind: string, id: string) {
    super(
      `${kind} '${id}' has no descriptor: set \`descriptor: { purpose: '…' }\` (see docs/descriptors.md)`,
    );
    this.name = 'MissingDescriptorError';
  }
}

/** Throw unless `value` carries a descriptor with a non-empty purpose. */
export function assertDescribed(
  kind:
    | 'tool'
    | 'plugin'
    | 'annotation kind'
    | 'exporter'
    | 'importer'
    | 'opening generator',
  id: string,
  value: { descriptor?: Descriptor } | undefined,
): void {
  const purpose = value?.descriptor?.purpose;
  if (typeof purpose !== 'string' || purpose.trim() === '') {
    throw new MissingDescriptorError(kind, id);
  }
}

/** Descriptor for a placement tool, derived from its component's own descriptor. */
export function describeFromComponent(
  component: { id: string; display_name?: string; descriptor?: Partial<Descriptor> },
): Descriptor {
  const d = component.descriptor;
  const purpose =
    d?.purpose && d.purpose.trim() !== ''
      ? `Place ${component.display_name ?? component.id}: ${d.purpose}`
      : `Place a ${component.display_name ?? component.id} (${component.id}).`;
  return { ...(d ?? {}), purpose };
}
