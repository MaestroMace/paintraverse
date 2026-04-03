import { EditorCanvas } from '../../editor/EditorCanvas'
import { GenerationPanel } from '../panels/GenerationPanel'
import { InspirationPanel } from '../panels/InspirationPanel'
import { ObjectLibrary } from '../panels/ObjectLibrary'
import { ObjectCreator } from '../panels/ObjectCreator'
import { TextureBrowser } from '../panels/TextureBrowser'
import { StyleSetEditor } from '../panels/StyleSetEditor'
import { RenderPanel } from '../panels/RenderPanel'
import { EnvironmentPanel } from '../panels/EnvironmentPanel'
import { LayerPanel } from '../panels/LayerPanel'
import { PropertyInspector } from '../panels/PropertyInspector'
import { ManifestPanel } from '../panels/ManifestPanel'

export function LandscapeMode() {
  return (
    <div className="app-body">
      <div className="left-panel">
        <GenerationPanel />
        <InspirationPanel />
        <ObjectLibrary />
        <ObjectCreator />
        <TextureBrowser />
        <StyleSetEditor />
      </div>
      <EditorCanvas />
      <div className="right-panel">
        <RenderPanel />
        <EnvironmentPanel />
        <LayerPanel />
        <PropertyInspector />
        <ManifestPanel />
      </div>
    </div>
  )
}
