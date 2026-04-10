/**
 * Terrain Mesh: entire tile grid as a single merged mesh with vertex colors.
 * ONE draw call for ALL terrain — GPU renders it in microseconds.
 */

import * as THREE from 'three'

const TERRAIN_COLORS: Record<number, number> = {
  0: 0x2d5a27, 1: 0x8b7355, 2: 0x708090, 3: 0x4682b4,
  4: 0xf4e9c8, 5: 0x556b2f, 6: 0x3a6a30, 7: 0x8a8a7a,
  8: 0x6a6a68, 9: 0x4a4a48, 10: 0x6a7a5a, 11: 0x6a5a45,
  12: 0x2a5522, 13: 0x9a8a6a,
}

export function buildTerrainMesh(
  tiles: number[][], gridWidth: number, gridHeight: number
): THREE.Group {
  const group = new THREE.Group()
  group.add(buildGroundMesh(tiles, gridWidth, gridHeight))
  group.add(buildWaterMesh(tiles, gridWidth, gridHeight))
  return group
}

function buildWaterMesh(
  tiles: number[][], gridWidth: number, gridHeight: number
): THREE.Mesh {
  // Collect water tile positions, create a single animated water plane
  const waterPositions: number[] = []
  for (let ty = 0; ty < gridHeight; ty++) {
    for (let tx = 0; tx < gridWidth; tx++) {
      if (tiles[ty]?.[tx] !== 3) continue
      const x = tx + 0.5, z = ty + 0.5
      waterPositions.push(x, z)
    }
  }

  if (waterPositions.length === 0) {
    // Empty invisible mesh
    const geo = new THREE.BufferGeometry()
    return new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ visible: false }))
  }

  // Create individual quads for each water tile
  const count = waterPositions.length / 2
  const positions = new Float32Array(count * 6 * 3)
  let vi = 0
  for (let i = 0; i < waterPositions.length; i += 2) {
    const cx = waterPositions[i], cz = waterPositions[i + 1]
    const x0 = cx - 0.5, x1 = cx + 0.5, z0 = cz - 0.5, z1 = cz + 0.5
    const y = -0.08

    positions[vi++] = x0; positions[vi++] = y; positions[vi++] = z0
    positions[vi++] = x1; positions[vi++] = y; positions[vi++] = z0
    positions[vi++] = x1; positions[vi++] = y; positions[vi++] = z1
    positions[vi++] = x0; positions[vi++] = y; positions[vi++] = z0
    positions[vi++] = x1; positions[vi++] = y; positions[vi++] = z1
    positions[vi++] = x0; positions[vi++] = y; positions[vi++] = z1
  }

  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  geo.computeVertexNormals()

  const mat = new THREE.MeshStandardMaterial({
    color: 0x3070a0,
    transparent: true,
    opacity: 0.75,
    roughness: 0.1,
    metalness: 0.3,
    flatShading: true,
  })

  return new THREE.Mesh(geo, mat)
}

function buildGroundMesh(
  tiles: number[][], gridWidth: number, gridHeight: number
): THREE.Mesh {
  // One quad (2 triangles) per tile. Total: gridW × gridH × 6 vertices
  const numTiles = gridWidth * gridHeight
  const positions = new Float32Array(numTiles * 6 * 3) // 6 verts × 3 components
  const colors = new Float32Array(numTiles * 6 * 3)

  let vi = 0 // vertex index

  for (let ty = 0; ty < gridHeight; ty++) {
    for (let tx = 0; tx < gridWidth; tx++) {
      const tileId = tiles[ty]?.[tx] ?? 0
      const color = new THREE.Color(TERRAIN_COLORS[tileId] ?? 0x808080)
      const r = color.r, g = color.g, b = color.b

      // Tile corners (Y=0 for flat ground, slight variation for water)
      const x0 = tx, z0 = ty
      const x1 = tx + 1, z1 = ty + 1
      const y = tileId === 3 ? -0.05 : 0 // water slightly below ground

      // Triangle 1: (x0,z0), (x1,z0), (x1,z1)
      positions[vi] = x0; positions[vi + 1] = y; positions[vi + 2] = z0
      colors[vi] = r; colors[vi + 1] = g; colors[vi + 2] = b; vi += 3
      positions[vi] = x1; positions[vi + 1] = y; positions[vi + 2] = z0
      colors[vi] = r; colors[vi + 1] = g; colors[vi + 2] = b; vi += 3
      positions[vi] = x1; positions[vi + 1] = y; positions[vi + 2] = z1
      colors[vi] = r; colors[vi + 1] = g; colors[vi + 2] = b; vi += 3

      // Triangle 2: (x0,z0), (x1,z1), (x0,z1)
      positions[vi] = x0; positions[vi + 1] = y; positions[vi + 2] = z0
      colors[vi] = r; colors[vi + 1] = g; colors[vi + 2] = b; vi += 3
      positions[vi] = x1; positions[vi + 1] = y; positions[vi + 2] = z1
      colors[vi] = r; colors[vi + 1] = g; colors[vi + 2] = b; vi += 3
      positions[vi] = x0; positions[vi + 1] = y; positions[vi + 2] = z1
      colors[vi] = r; colors[vi + 1] = g; colors[vi + 2] = b; vi += 3
    }
  }

  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3))
  geometry.computeVertexNormals()

  const material = new THREE.MeshStandardMaterial({
    vertexColors: true,
    flatShading: true,
    roughness: 0.9,
    metalness: 0,
  })

  return new THREE.Mesh(geometry, material)
}
