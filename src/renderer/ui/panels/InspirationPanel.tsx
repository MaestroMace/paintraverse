import { useState, useCallback } from 'react'
import { useAppStore } from '../../app/store'
import { extractPalette } from '../../inspiration/PaletteExtractor'
import { mapStyle } from '../../inspiration/StyleMapper'
import { describeStyle, getApiKey, setApiKey, hasApiKey } from '../../inspiration/AIDescriber'
import { PALETTES, registerPalette } from '../../renderer3d/PaletteQuantizer'
import type { StyleDescription } from '../../inspiration/AIDescriber'

export function InspirationPanel() {
  const [collapsed, setCollapsed] = useState(false)
  const [extracting, setExtracting] = useState(false)
  const [aiLoading, setAiLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [aiDescription, setAiDescription] = useState<StyleDescription | null>(null)
  const [showAI, setShowAI] = useState(false)
  const [apiKeyInput, setApiKeyInput] = useState(getApiKey() || '')
  const [colorCount, setColorCount] = useState(20)

  const inspirationImage = useAppStore((s) => s.inspirationImage)
  const inspirationPalette = useAppStore((s) => s.inspirationPalette)
  const setInspirationImage = useAppStore((s) => s.setInspirationImage)
  const setInspirationPalette = useAppStore((s) => s.setInspirationPalette)
  const setBuildingPalettes = useAppStore((s) => s.setBuildingPalettes)
  const updateRenderCamera = useAppStore((s) => s.updateRenderCamera)
  const updateEnvironment = useAppStore((s) => s.updateEnvironment)

  // Load image via Electron file picker
  const handlePickImage = useCallback(async () => {
    if (!window.electronAPI) return
    const path = await window.electronAPI.openImageDialog()
    if (!path) return
    const dataURL = await window.electronAPI.readImageAsDataURL(path)
    setInspirationImage(dataURL)
    setError(null)
    setAiDescription(null)

    // Auto-extract
    setExtracting(true)
    try {
      const result = await extractPalette(dataURL, colorCount)
      setInspirationPalette(result)
    } catch (e) {
      setError(String(e))
    } finally {
      setExtracting(false)
    }
  }, [colorCount, setInspirationImage, setInspirationPalette])

  // Re-extract with different color count
  const handleReExtract = useCallback(async () => {
    if (!inspirationImage) return
    setExtracting(true)
    setError(null)
    try {
      const result = await extractPalette(inspirationImage, colorCount)
      setInspirationPalette(result)
    } catch (e) {
      setError(String(e))
    } finally {
      setExtracting(false)
    }
  }, [inspirationImage, colorCount, setInspirationPalette])

  // Apply extracted style to all systems
  const handleApplyAll = useCallback(() => {
    if (!inspirationPalette) return
    const style = mapStyle(inspirationPalette)

    // 1. Register render palette
    registerPalette('inspiration', style.renderPalette)
    updateRenderCamera({ paletteId: 'inspiration' })

    // 2. Apply building palettes
    setBuildingPalettes(style.buildingPalettes)

    // 3. Apply generation hints (frequency suggestions)
    // Store in the generation config hints - the GenerationPanel reads these
    // For now we just set the frequencies directly
    setError(null)
  }, [inspirationPalette, setBuildingPalettes, updateRenderCamera])

  const handleApplyPalette = useCallback(() => {
    if (!inspirationPalette) return
    const style = mapStyle(inspirationPalette)
    registerPalette('inspiration', style.renderPalette)
    updateRenderCamera({ paletteId: 'inspiration' })
  }, [inspirationPalette, updateRenderCamera])

  const handleApplyBuildings = useCallback(() => {
    if (!inspirationPalette) return
    const style = mapStyle(inspirationPalette)
    setBuildingPalettes(style.buildingPalettes)
  }, [inspirationPalette, setBuildingPalettes])

  // AI describe
  const handleAIDescribe = useCallback(async () => {
    if (!inspirationImage) return
    setAiLoading(true)
    setError(null)
    try {
      const desc = await describeStyle(inspirationImage)
      setAiDescription(desc)
    } catch (e) {
      setError(String(e))
    } finally {
      setAiLoading(false)
    }
  }, [inspirationImage])

  // Apply AI suggestions
  const handleApplyAI = useCallback(() => {
    if (!aiDescription) return

    if (aiDescription.suggestedTimeOfDay !== null) {
      updateEnvironment({ timeOfDay: aiDescription.suggestedTimeOfDay })
    }
    if (aiDescription.suggestedWeather) {
      updateEnvironment({ weather: aiDescription.suggestedWeather as 'clear' | 'rain' | 'fog' | 'snow' | 'storm' })
    }
  }, [aiDescription, updateEnvironment])

  const handleSaveApiKey = () => {
    setApiKey(apiKeyInput)
  }

  const style = inspirationPalette ? mapStyle(inspirationPalette) : null

  return (
    <div className="panel">
      <div className="panel-header" onClick={() => setCollapsed(!collapsed)}>
        <span>Inspiration</span>
        <span>{collapsed ? '+' : '-'}</span>
      </div>
      {!collapsed && (
        <div className="panel-content">
          {/* Image Drop Zone */}
          {!inspirationImage ? (
            <div
              onClick={handlePickImage}
              style={{
                border: '2px dashed var(--border)',
                borderRadius: 6,
                padding: '16px 12px',
                textAlign: 'center',
                cursor: 'pointer',
                marginBottom: 8,
                transition: 'border-color 0.2s'
              }}
              onMouseEnter={(e) => (e.currentTarget.style.borderColor = 'var(--accent)')}
              onMouseLeave={(e) => (e.currentTarget.style.borderColor = 'var(--border)')}
            >
              <div style={{ fontSize: 20, marginBottom: 4 }}>+</div>
              <div style={{ fontSize: 11, color: 'var(--text-dim)' }}>
                Click to load a reference image
              </div>
              <div style={{ fontSize: 10, color: 'var(--text-dim)', marginTop: 2 }}>
                PNG, JPG, or WebP
              </div>
            </div>
          ) : (
            <div style={{ marginBottom: 8 }}>
              <div style={{ position: 'relative' }}>
                <img
                  src={inspirationImage}
                  alt="Reference"
                  style={{
                    width: '100%',
                    borderRadius: 4,
                    border: '1px solid var(--border)'
                  }}
                />
                <button
                  onClick={() => {
                    setInspirationImage(null)
                    setInspirationPalette(null)
                    setAiDescription(null)
                  }}
                  style={{
                    position: 'absolute', top: 4, right: 4,
                    width: 20, height: 20, padding: 0, fontSize: 10,
                    borderRadius: '50%'
                  }}
                >x</button>
              </div>
              <button
                onClick={handlePickImage}
                style={{ width: '100%', marginTop: 4, fontSize: 11 }}
              >
                Change Image
              </button>
            </div>
          )}

          {/* Color Count Slider */}
          {inspirationImage && (
            <div style={{ marginBottom: 6 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11 }}>
                <span style={{ color: 'var(--text-dim)' }}>Colors to extract</span>
                <span>{colorCount}</span>
              </div>
              <div style={{ display: 'flex', gap: 4 }}>
                <input
                  type="range" min={8} max={32} value={colorCount}
                  onChange={(e) => setColorCount(Number(e.target.value))}
                  style={{ flex: 1 }}
                />
                <button onClick={handleReExtract} disabled={extracting} style={{ fontSize: 10, padding: '2px 6px' }}>
                  {extracting ? '...' : 'Re-extract'}
                </button>
              </div>
            </div>
          )}

          {/* Extracted Palette Display */}
          {inspirationPalette && (
            <div style={{ marginBottom: 8 }}>
              {/* Mood label */}
              {style && (
                <div style={{
                  textAlign: 'center', fontSize: 12, fontWeight: 600,
                  color: 'var(--accent)', marginBottom: 6
                }}>
                  {style.moodLabel}
                </div>
              )}

              {/* Color swatches */}
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 2, marginBottom: 6 }}>
                {inspirationPalette.palette.colors.map((c, i) => (
                  <div
                    key={i}
                    style={{
                      width: 18, height: 18,
                      backgroundColor: `rgb(${c[0]},${c[1]},${c[2]})`,
                      borderRadius: 2,
                      border: '1px solid rgba(255,255,255,0.1)'
                    }}
                    title={`RGB(${c[0]}, ${c[1]}, ${c[2]})`}
                  />
                ))}
              </div>

              {/* Analysis meters */}
              <div style={{ fontSize: 11, marginBottom: 6 }}>
                <MeterRow label="Warmth" value={inspirationPalette.warmth} colorA="#4466aa" colorB="#ffaa44" />
                <MeterRow label="Saturation" value={inspirationPalette.saturation} colorA="#666" colorB="#ff4488" />
                <MeterRow label="Brightness" value={inspirationPalette.brightness} colorA="#111" colorB="#eee" />
              </div>

              {/* Color categories */}
              <div style={{ display: 'flex', gap: 8, fontSize: 10, color: 'var(--text-dim)', marginBottom: 8 }}>
                <ColorGroup label="Darks" colors={inspirationPalette.darks} />
                <ColorGroup label="Mids" colors={inspirationPalette.midtones} />
                <ColorGroup label="Lights" colors={inspirationPalette.lights} />
                <ColorGroup label="Accents" colors={inspirationPalette.accents} />
              </div>

              {/* Apply buttons */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 3, marginBottom: 4 }}>
                <button onClick={handleApplyAll} className="active" style={{ padding: '6px 10px', fontWeight: 600 }}>
                  Apply All
                </button>
                <div style={{ display: 'flex', gap: 3 }}>
                  <button onClick={handleApplyPalette} style={{ flex: 1, fontSize: 10, padding: '3px 6px' }}>
                    Render Palette
                  </button>
                  <button onClick={handleApplyBuildings} style={{ flex: 1, fontSize: 10, padding: '3px 6px' }}>
                    Building Colors
                  </button>
                </div>
              </div>
            </div>
          )}

          {error && (
            <div style={{ color: '#d95763', fontSize: 11, marginBottom: 6, wordBreak: 'break-word' }}>
              {error}
            </div>
          )}

          {/* AI Section */}
          {inspirationImage && (
            <div style={{ borderTop: '1px solid var(--border)', paddingTop: 6 }}>
              <div
                onClick={() => setShowAI(!showAI)}
                style={{
                  fontSize: 10, color: 'var(--text-dim)', textTransform: 'uppercase',
                  letterSpacing: '0.5px', cursor: 'pointer', userSelect: 'none',
                  display: 'flex', justifyContent: 'space-between', marginBottom: 4
                }}
              >
                <span>AI Style Analysis</span>
                <span>{showAI ? '-' : '+'}</span>
              </div>

              {showAI && (
                <div>
                  {/* API Key */}
                  <div style={{ marginBottom: 6 }}>
                    <label style={{ fontSize: 10, color: 'var(--text-dim)', display: 'block', marginBottom: 2 }}>
                      Claude API Key {hasApiKey() ? '(saved)' : ''}
                    </label>
                    <div style={{ display: 'flex', gap: 4 }}>
                      <input
                        type="password"
                        value={apiKeyInput}
                        onChange={(e) => setApiKeyInput(e.target.value)}
                        placeholder="sk-ant-..."
                        style={{ flex: 1 }}
                      />
                      <button onClick={handleSaveApiKey} style={{ fontSize: 10, padding: '2px 6px' }}>
                        Save
                      </button>
                    </div>
                    <div style={{ fontSize: 9, color: 'var(--text-dim)', marginTop: 2 }}>
                      Stored locally only. Never saved in project files.
                    </div>
                  </div>

                  {/* Describe button */}
                  <button
                    onClick={handleAIDescribe}
                    disabled={aiLoading || !hasApiKey()}
                    style={{ width: '100%', marginBottom: 6, padding: '5px 10px' }}
                  >
                    {aiLoading ? 'Analyzing...' : 'Describe Style with AI'}
                  </button>

                  {/* AI Description card */}
                  {aiDescription && (
                    <div style={{
                      background: 'var(--bg-dark)', borderRadius: 4, padding: 8,
                      fontSize: 11, lineHeight: 1.5, marginBottom: 6
                    }}>
                      <div style={{ fontWeight: 600, color: 'var(--accent)', marginBottom: 4 }}>
                        {aiDescription.mood}
                      </div>
                      <div style={{ marginBottom: 4 }}>{aiDescription.description}</div>
                      <div style={{ color: 'var(--text-dim)', fontSize: 10 }}>
                        <div>Architecture: {aiDescription.architectureStyle}</div>
                        <div>Lighting: {aiDescription.lightingNotes}</div>
                        {aiDescription.materials.length > 0 && (
                          <div>Materials: {aiDescription.materials.join(', ')}</div>
                        )}
                      </div>

                      <button
                        onClick={handleApplyAI}
                        style={{ width: '100%', marginTop: 6, padding: '4px 8px', fontSize: 11 }}
                      >
                        Apply AI Suggestions (Time + Weather)
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function MeterRow({ label, value, colorA, colorB }: {
  label: string; value: number; colorA: string; colorB: string
}) {
  return (
    <div style={{ marginBottom: 3 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, marginBottom: 1 }}>
        <span style={{ color: 'var(--text-dim)' }}>{label}</span>
        <span>{(value * 100).toFixed(0)}%</span>
      </div>
      <div style={{ height: 6, borderRadius: 3, background: 'var(--bg-dark)', overflow: 'hidden' }}>
        <div style={{
          width: `${value * 100}%`, height: '100%', borderRadius: 3,
          background: `linear-gradient(to right, ${colorA}, ${colorB})`
        }} />
      </div>
    </div>
  )
}

function ColorGroup({ label, colors }: { label: string; colors: [number, number, number][] }) {
  return (
    <div style={{ flex: 1 }}>
      <div style={{ marginBottom: 2 }}>{label} ({colors.length})</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}>
        {colors.slice(0, 6).map((c, i) => (
          <div
            key={i}
            style={{
              width: 10, height: 10, borderRadius: 1,
              backgroundColor: `rgb(${c[0]},${c[1]},${c[2]})`
            }}
          />
        ))}
      </div>
    </div>
  )
}
