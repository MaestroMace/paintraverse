// Stub for Phase 3: Procedural Generation
//
// This will hold the registry of map generators (Town, Forest, Dungeon, etc.)
// Each generator implements IMapGenerator and is registered here.

import type { MapDocument, GenerationConfig } from '../core/types'

export interface IMapGenerator {
  readonly type: string
  readonly displayName: string
  readonly description: string
  generate(config: GenerationConfig): MapDocument
}

const generators = new Map<string, IMapGenerator>()

export function registerGenerator(generator: IMapGenerator): void {
  generators.set(generator.type, generator)
}

export function getGenerator(type: string): IMapGenerator | undefined {
  return generators.get(type)
}

export function getAllGenerators(): IMapGenerator[] {
  return Array.from(generators.values())
}
