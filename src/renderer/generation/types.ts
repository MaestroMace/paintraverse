// Generation-specific types for Phase 3
//
// These will define the interfaces for generation passes,
// placement rules, noise functions, etc.

export interface GenerationPass {
  name: string
  execute(context: GenerationContext): void
}

export interface GenerationContext {
  width: number
  height: number
  seed: number
  terrain: number[][]
  objects: PlacedObjectData[]
  params: Record<string, number>
}

export interface PlacedObjectData {
  definitionId: string
  x: number
  y: number
  rotation: number
}
