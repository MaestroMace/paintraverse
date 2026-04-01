import type { PlacedObject, Command } from './types'

export function createPlaceObjectCommand(
  layerId: string,
  object: PlacedObject,
  addFn: (layerId: string, obj: PlacedObject) => void,
  removeFn: (layerId: string, objectId: string) => void
): Command {
  return {
    type: 'place_object',
    description: `Place ${object.definitionId}`,
    execute: () => addFn(layerId, object),
    undo: () => removeFn(layerId, object.id)
  }
}

export function createDeleteObjectCommand(
  layerId: string,
  object: PlacedObject,
  addFn: (layerId: string, obj: PlacedObject) => void,
  removeFn: (layerId: string, objectId: string) => void
): Command {
  return {
    type: 'delete_object',
    description: `Delete ${object.definitionId}`,
    execute: () => removeFn(layerId, object.id),
    undo: () => addFn(layerId, object)
  }
}

export function createMoveObjectCommand(
  layerId: string,
  objectId: string,
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
  updateFn: (layerId: string, objectId: string, props: Partial<PlacedObject>) => void
): Command {
  return {
    type: 'move_object',
    description: `Move object`,
    execute: () => updateFn(layerId, objectId, { x: toX, y: toY }),
    undo: () => updateFn(layerId, objectId, { x: fromX, y: fromY })
  }
}

export function createPaintTerrainCommand(
  layerId: string,
  tileX: number,
  tileY: number,
  oldTileId: number,
  newTileId: number,
  paintFn: (layerId: string, x: number, y: number, tileId: number) => void
): Command {
  return {
    type: 'paint_terrain',
    description: `Paint terrain`,
    execute: () => paintFn(layerId, tileX, tileY, newTileId),
    undo: () => paintFn(layerId, tileX, tileY, oldTileId)
  }
}
