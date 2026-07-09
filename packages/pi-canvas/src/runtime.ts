import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createCanvasStore, type CanvasStore } from "./store.js";
import type { CanvasExportResult, CanvasReadback, CreateCanvasRequest, UpdateCanvasRequest } from "./types.js";

export class PiCanvasRuntime {
  readonly store: CanvasStore;

  constructor(store: CanvasStore) {
    this.store = store;
  }

  create(request: CreateCanvasRequest): Promise<CanvasReadback> {
    return this.store.create(request);
  }

  update(request: UpdateCanvasRequest): Promise<CanvasReadback> {
    return this.store.update(request);
  }

  read(artifactId: string): Promise<CanvasReadback | undefined> {
    return this.store.read(artifactId);
  }

  export(artifactId: string, targetDir?: string): Promise<CanvasExportResult | undefined> {
    return this.store.export(artifactId, targetDir);
  }

  listArtifactIds(): Promise<string[]> {
    return this.store.listArtifactIds();
  }
}

export function createRuntimeForContext(ctx: ExtensionContext): PiCanvasRuntime {
  return new PiCanvasRuntime(createCanvasStore(ctx.cwd));
}
