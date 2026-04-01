import { Container, Graphics } from 'pixi.js'

export class Grid {
  container: Container
  private graphics: Graphics
  private _gridWidth = 0
  private _gridHeight = 0
  tileSize = 32

  constructor() {
    this.container = new Container()
    this.graphics = new Graphics()
    this.container.addChild(this.graphics)
    this.container.alpha = 0.3
  }

  update(gridWidth: number, gridHeight: number, tileSize: number): void {
    if (
      gridWidth === this._gridWidth &&
      gridHeight === this._gridHeight &&
      tileSize === this.tileSize
    ) {
      return
    }

    this._gridWidth = gridWidth
    this._gridHeight = gridHeight
    this.tileSize = tileSize

    this.graphics.clear()

    const totalW = gridWidth * tileSize
    const totalH = gridHeight * tileSize

    // Draw grid lines
    this.graphics.setStrokeStyle({ width: 1, color: 0x444466 })

    for (let x = 0; x <= gridWidth; x++) {
      this.graphics.moveTo(x * tileSize, 0)
      this.graphics.lineTo(x * tileSize, totalH)
    }
    for (let y = 0; y <= gridHeight; y++) {
      this.graphics.moveTo(0, y * tileSize)
      this.graphics.lineTo(totalW, y * tileSize)
    }
    this.graphics.stroke()

    // Draw border
    this.graphics.setStrokeStyle({ width: 2, color: 0x6666aa })
    this.graphics.rect(0, 0, totalW, totalH)
    this.graphics.stroke()
  }
}
