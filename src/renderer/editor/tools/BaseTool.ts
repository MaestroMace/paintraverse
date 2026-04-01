import type { FederatedPointerEvent } from 'pixi.js'
import type { EditorViewport } from '../EditorViewport'

export interface ITool {
  name: string
  cursor: string
  onTileClick?(tileX: number, tileY: number, event: FederatedPointerEvent): void
  onTileDrag?(tileX: number, tileY: number, event: FederatedPointerEvent): void
  onTileUp?(tileX: number, tileY: number, event: FederatedPointerEvent): void
  onActivate?(viewport: EditorViewport): void
  onDeactivate?(): void
}
