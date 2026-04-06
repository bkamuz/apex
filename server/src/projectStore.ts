import type { ElementDto, ElementsSnapshotDto } from '../../shared/dto.ts';

export class ProjectStore {
  private readonly projects = new Map<string, ElementsSnapshotDto>();

  putSnapshot(snapshot: ElementsSnapshotDto): void {
    this.projects.set(snapshot.projectId, snapshot);
  }

  getSnapshot(projectId: string): ElementsSnapshotDto | undefined {
    return this.projects.get(projectId);
  }

  getElement(projectId: string, elementId: string): ElementDto | undefined {
    return this.projects.get(projectId)?.elements.find((e) => e.id === elementId);
  }
}
