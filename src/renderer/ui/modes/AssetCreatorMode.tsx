import { useState, useRef, useCallback, useEffect } from 'react'
import { useAppStore } from '../../app/store'
import type { SearchResult, GeneratedAsset, ObjectDefinition } from '../../core/types'
import { v4 as uuid } from 'uuid'
import './AssetCreatorMode.css'

// Pixabay API - free tier, 100 requests/minute
const PIXABAY_API_KEY = '47870702-a612da6d3e72a8e3c6e5c71b8'
const PIXABAY_BASE = 'https://pixabay.com/api/'

async function searchPixabay(query: string, page: number = 1): Promise<SearchResult[]> {
  const params = new URLSearchParams({
    key: PIXABAY_API_KEY,
    q: query,
    image_type: 'illustration',
    per_page: '20',
    page: String(page),
    safesearch: 'true'
  })

  try {
    const res = await fetch(`${PIXABAY_BASE}?${params}`)
    if (!res.ok) throw new Error(`Pixabay API error: ${res.status}`)
    const data = await res.json()

    return (data.hits || []).map((hit: any) => ({
      id: String(hit.id),
      url: hit.largeImageURL || hit.webformatURL,
      thumbnailUrl: hit.previewURL,
      title: hit.tags || 'Untitled',
      source: 'Pixabay',
      width: hit.imageWidth || hit.webformatWidth,
      height: hit.imageHeight || hit.webformatHeight
    }))
  } catch (err) {
    console.warn('Pixabay search failed, using fallback:', err)
    return fallbackSearch(query)
  }
}

// Fallback if API fails (e.g. no network in Electron dev)
function fallbackSearch(query: string): SearchResult[] {
  const colors = ['#8B4513', '#4682B4', '#2E8B57', '#CD853F', '#708090', '#DAA520', '#6B8E23', '#B8860B']
  return Array.from({ length: 12 }, (_, i) => ({
    id: uuid(),
    url: '',
    thumbnailUrl: '',
    title: `${query} - ${['sword', 'shield', 'potion', 'chest', 'helm', 'staff', 'gem', 'scroll', 'ring', 'lantern', 'key', 'tome'][i]}`,
    source: 'Local',
    width: 256,
    height: 256,
    _color: colors[i % colors.length]
  })) as SearchResult[]
}

// Simulated 3D generation pipeline (placeholder for real AI API)
function simulateGenerate(prompt: string, onProgress: (status: string) => void): Promise<string> {
  return new Promise((resolve) => {
    const steps = [
      'Analyzing prompt...',
      'Generating base geometry...',
      'Sculpting details...',
      'UV unwrapping...',
      'Applying materials...',
      'Baking textures...',
      'Optimizing mesh...',
      'Finalizing asset...'
    ]
    let i = 0
    const interval = setInterval(() => {
      if (i < steps.length) {
        onProgress(steps[i])
        i++
      } else {
        clearInterval(interval)
        resolve('generated-model-url')
      }
    }, 600)
  })
}

// Convert a generated asset to an ObjectDefinition for the landscape editor
function assetToObjectDefinition(asset: GeneratedAsset, footprint: { w: number; h: number }): ObjectDefinition {
  return {
    id: `gen_${asset.id}`,
    name: asset.name,
    category: 'custom',
    tags: ['generated', 'ai-asset'],
    color: '#DAA520',
    footprint,
    styleSetSlots: [],
    render3d: {
      type: 'billboard',
      height: footprint.h
    }
  }
}

export function AssetCreatorMode() {
  const searchQuery = useAppStore((s) => s.searchQuery)
  const searchResults = useAppStore((s) => s.searchResults)
  const searchLoading = useAppStore((s) => s.searchLoading)
  const selectedResult = useAppStore((s) => s.selectedSearchResult)
  const generatedAssets = useAppStore((s) => s.generatedAssets)
  const setSearchQuery = useAppStore((s) => s.setSearchQuery)
  const setSearchResults = useAppStore((s) => s.setSearchResults)
  const setSearchLoading = useAppStore((s) => s.setSearchLoading)
  const setSelectedSearchResult = useAppStore((s) => s.setSelectedSearchResult)
  const addGeneratedAsset = useAppStore((s) => s.addGeneratedAsset)
  const updateGeneratedAsset = useAppStore((s) => s.updateGeneratedAsset)
  const addObjectDefinition = useAppStore((s) => s.addObjectDefinition)
  const setAppMode = useAppStore((s) => s.setAppMode)

  const [activeTab, setActiveTab] = useState<'search' | 'generate' | 'library'>('search')
  const [generatePrompt, setGeneratePrompt] = useState('')
  const [generateStatus, setGenerateStatus] = useState('')
  const [isGenerating, setIsGenerating] = useState(false)
  const [assetStyle, setAssetStyle] = useState('Low Poly')
  const [assetPolyCount, setAssetPolyCount] = useState('Low (<500)')
  const [footprintW, setFootprintW] = useState(1)
  const [footprintH, setFootprintH] = useState(1)
  const [addedToLandscape, setAddedToLandscape] = useState<Set<string>>(new Set())
  const searchInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (activeTab === 'search' && searchInputRef.current) {
      searchInputRef.current.focus()
    }
  }, [activeTab])

  const handleSearch = useCallback(async () => {
    if (!searchQuery.trim() || searchLoading) return
    setSearchLoading(true)
    setSelectedSearchResult(null)
    try {
      const results = await searchPixabay(searchQuery)
      setSearchResults(results)
    } finally {
      setSearchLoading(false)
    }
  }, [searchQuery, searchLoading])

  const handleGenerate = useCallback(async () => {
    if (!generatePrompt.trim() || isGenerating) return
    setIsGenerating(true)
    setGenerateStatus('')

    const asset: GeneratedAsset = {
      id: uuid(),
      name: generatePrompt.slice(0, 40),
      prompt: generatePrompt,
      imageUrl: '',
      status: 'generating',
      createdAt: Date.now()
    }
    addGeneratedAsset(asset)

    try {
      const modelUrl = await simulateGenerate(generatePrompt, (status) => {
        setGenerateStatus(status)
      })
      updateGeneratedAsset(asset.id, {
        status: 'complete',
        modelUrl,
        imageUrl: 'generated-preview'
      })
      setGenerateStatus('Asset generated successfully!')
    } catch {
      updateGeneratedAsset(asset.id, { status: 'error' })
      setGenerateStatus('Generation failed. Try again.')
    } finally {
      setIsGenerating(false)
    }
  }, [generatePrompt, isGenerating])

  const handleAddToLandscape = useCallback((asset: GeneratedAsset) => {
    const def = assetToObjectDefinition(asset, { w: footprintW, h: footprintH })
    addObjectDefinition(def)
    setAddedToLandscape((prev) => new Set(prev).add(asset.id))
  }, [footprintW, footprintH])

  const handleGoToLandscape = useCallback(() => {
    setAppMode('landscape')
  }, [])

  return (
    <div className="asset-creator">
      {/* Left: Command Menu */}
      <div className="ac-sidebar kh-panel">
        <div className="ac-sidebar-title">Asset Creator</div>
        <nav className="ac-nav">
          <button
            className={`kh-cmd-item ${activeTab === 'search' ? 'active' : ''}`}
            onClick={() => setActiveTab('search')}
          >
            Search References
          </button>
          <button
            className={`kh-cmd-item ${activeTab === 'generate' ? 'active' : ''}`}
            onClick={() => setActiveTab('generate')}
          >
            Generate Asset
          </button>
          <button
            className={`kh-cmd-item ${activeTab === 'library' ? 'active' : ''}`}
            onClick={() => setActiveTab('library')}
          >
            Asset Library
          </button>
        </nav>

        {/* Quick stats */}
        <div className="ac-stats">
          <div className="ac-stat">
            <span className="ac-stat-value">{generatedAssets.length}</span>
            <span className="ac-stat-label">Assets</span>
          </div>
          <div className="ac-stat">
            <span className="ac-stat-value">{generatedAssets.filter(a => a.status === 'complete').length}</span>
            <span className="ac-stat-label">Ready</span>
          </div>
          <div className="ac-stat">
            <span className="ac-stat-value">{addedToLandscape.size}</span>
            <span className="ac-stat-label">In Editor</span>
          </div>
        </div>
      </div>

      {/* Main content area */}
      <div className="ac-main">
        {activeTab === 'search' && (
          <div className="ac-search-panel">
            {/* CRT-style search bar */}
            <div className="ac-search-bar crt-container">
              <div className="ac-search-input-wrap">
                <span className="ac-search-prompt">{'>'}_ </span>
                <input
                  ref={searchInputRef}
                  className="crt-input amber"
                  type="text"
                  placeholder="Search for game asset references..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
                />
                <button
                  className="kh-btn primary"
                  onClick={handleSearch}
                  disabled={searchLoading}
                >
                  {searchLoading ? 'Scanning...' : 'SCAN'}
                </button>
              </div>
              {searchLoading && (
                <div className="ac-search-scanline">
                  <div className="scanline-bar" />
                </div>
              )}
            </div>

            {/* Results grid */}
            <div className="ac-results">
              {searchResults.length === 0 && !searchLoading && (
                <div className="ac-empty-state">
                  <span className="ac-empty-icon">{'\u{1F50D}'}</span>
                  <p>Enter a query to search for reference images</p>
                  <p className="ac-empty-hint">Try: "medieval sword", "crystal potion", "pixel art character"</p>
                </div>
              )}
              <div className="search-grid">
                {searchResults.map((r) => (
                  <div
                    key={r.id}
                    className={`search-result-card ${selectedResult?.id === r.id ? 'selected' : ''}`}
                    onClick={() => setSelectedSearchResult(r)}
                  >
                    {r.thumbnailUrl ? (
                      <img src={r.thumbnailUrl} alt={r.title} loading="lazy" />
                    ) : (
                      <div className="search-result-placeholder" style={{ background: (r as any)._color || 'rgba(100,140,255,0.1)' }}>
                        <span>{r.title.charAt(0).toUpperCase()}</span>
                      </div>
                    )}
                    <div className="search-result-overlay">
                      <span className="search-result-title">{r.title}</span>
                      <span className="search-result-source">{r.source}</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Selected result detail */}
            {selectedResult && (
              <div className="ac-result-detail kh-panel">
                <div className="ac-detail-preview">
                  {selectedResult.thumbnailUrl ? (
                    <img src={selectedResult.url || selectedResult.thumbnailUrl} alt={selectedResult.title} />
                  ) : (
                    <div className="ac-detail-placeholder">
                      <span>{selectedResult.title.charAt(0).toUpperCase()}</span>
                    </div>
                  )}
                </div>
                <div className="ac-detail-info">
                  <div className="ac-detail-header">
                    <span className="ac-detail-title">{selectedResult.title}</span>
                    <span className="ac-detail-source">{selectedResult.source} &middot; {selectedResult.width}x{selectedResult.height}</span>
                  </div>
                  <div className="ac-detail-actions">
                    <button
                      className="kh-btn primary"
                      onClick={() => {
                        setGeneratePrompt(`3D game asset inspired by: ${selectedResult.title}`)
                        setActiveTab('generate')
                      }}
                    >
                      Use as Reference {'\u2192'}
                    </button>
                    <button className="kh-btn">Save to Library</button>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {activeTab === 'generate' && (
          <div className="ac-generate-panel">
            {/* Generation interface */}
            <div className="ac-gen-header kh-panel">
              <h3 className="ac-gen-title">{'\u2728'} AI Asset Generator</h3>
              <p className="ac-gen-desc">
                Describe the game asset you want to create. The AI will generate a 3D model ready for your game.
              </p>
            </div>

            <div className="ac-gen-input-area">
              <textarea
                className="ac-gen-textarea"
                placeholder="Describe your asset... e.g. 'Low-poly treasure chest with gold coins, fantasy RPG style, wooden with iron bands'"
                value={generatePrompt}
                onChange={(e) => setGeneratePrompt(e.target.value)}
                rows={4}
              />
              <div className="ac-gen-controls">
                <div className="ac-gen-options">
                  <label className="ac-gen-option">
                    <span>Style:</span>
                    <select value={assetStyle} onChange={(e) => setAssetStyle(e.target.value)}>
                      <option>Low Poly</option>
                      <option>Pixel Art 3D</option>
                      <option>Stylized</option>
                      <option>Realistic</option>
                    </select>
                  </label>
                  <label className="ac-gen-option">
                    <span>Poly Count:</span>
                    <select value={assetPolyCount} onChange={(e) => setAssetPolyCount(e.target.value)}>
                      <option>Low (&lt;500)</option>
                      <option>Medium (&lt;2000)</option>
                      <option>High (&lt;5000)</option>
                    </select>
                  </label>
                  <label className="ac-gen-option">
                    <span>Footprint:</span>
                    <div className="ac-footprint-inputs">
                      <input type="number" min={1} max={6} value={footprintW} onChange={(e) => setFootprintW(Math.max(1, parseInt(e.target.value) || 1))} />
                      <span>x</span>
                      <input type="number" min={1} max={6} value={footprintH} onChange={(e) => setFootprintH(Math.max(1, parseInt(e.target.value) || 1))} />
                    </div>
                  </label>
                </div>
                <button
                  className="kh-btn primary ac-gen-button"
                  onClick={handleGenerate}
                  disabled={isGenerating || !generatePrompt.trim()}
                >
                  {isGenerating ? 'Generating...' : '\u2728 Generate Asset'}
                </button>
              </div>
            </div>

            {/* Generation progress */}
            {(isGenerating || generateStatus) && (
              <div className="ac-gen-progress kh-panel">
                <div className="ac-gen-progress-bar">
                  <div className={`ac-gen-progress-fill ${isGenerating ? 'animating' : 'complete'}`} />
                </div>
                <span className="ac-gen-status">{generateStatus}</span>
              </div>
            )}

            {/* 3D Preview area */}
            <div className="ac-gen-preview asset-preview-3d">
              <div className="ac-preview-placeholder">
                {isGenerating ? (
                  <div className="ac-preview-generating">
                    <div className="ac-preview-spinner" />
                    <span>Building your asset...</span>
                  </div>
                ) : generatedAssets.length > 0 && generatedAssets[generatedAssets.length - 1].status === 'complete' ? (
                  <div className="ac-preview-complete">
                    <span className="ac-preview-icon">{'\u{1F3AE}'}</span>
                    <span>Asset ready!</span>
                    <div className="ac-preview-actions">
                      <button
                        className="kh-btn primary"
                        onClick={() => handleAddToLandscape(generatedAssets[generatedAssets.length - 1])}
                        disabled={addedToLandscape.has(generatedAssets[generatedAssets.length - 1].id)}
                      >
                        {addedToLandscape.has(generatedAssets[generatedAssets.length - 1].id)
                          ? '\u2713 Added to Editor'
                          : 'Add to Landscape Editor'}
                      </button>
                      {addedToLandscape.has(generatedAssets[generatedAssets.length - 1].id) && (
                        <button className="kh-btn" onClick={handleGoToLandscape}>
                          Open Landscape {'\u2192'}
                        </button>
                      )}
                    </div>
                  </div>
                ) : (
                  <div className="ac-preview-empty">
                    <span className="ac-preview-icon">{'\u{1F4A0}'}</span>
                    <span>3D preview will appear here</span>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {activeTab === 'library' && (
          <div className="ac-library-panel">
            <div className="ac-library-header">
              <h3>Asset Library</h3>
              <span className="ac-library-count">{generatedAssets.length} assets</span>
            </div>

            {generatedAssets.length === 0 ? (
              <div className="ac-empty-state">
                <span className="ac-empty-icon">{'\u{1F4E6}'}</span>
                <p>No assets yet</p>
                <p className="ac-empty-hint">Generate assets or save search references to build your library</p>
              </div>
            ) : (
              <div className="ac-library-grid">
                {generatedAssets.map((asset) => (
                  <div key={asset.id} className="ac-library-card kh-panel">
                    <div className="ac-library-card-preview">
                      <span>{asset.status === 'complete' ? '\u2705' : asset.status === 'generating' ? '\u23F3' : '\u274C'}</span>
                    </div>
                    <div className="ac-library-card-info">
                      <span className="ac-library-card-name">{asset.name}</span>
                      <span className="ac-library-card-status">{asset.status}</span>
                    </div>
                    {asset.status === 'complete' && (
                      <div className="ac-library-card-actions">
                        <button
                          className="kh-btn"
                          onClick={() => handleAddToLandscape(asset)}
                          disabled={addedToLandscape.has(asset.id)}
                        >
                          {addedToLandscape.has(asset.id) ? '\u2713 In Editor' : 'Add to Editor'}
                        </button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}

            {addedToLandscape.size > 0 && (
              <div className="ac-library-footer">
                <button className="kh-btn primary" onClick={handleGoToLandscape}>
                  Open Landscape Editor ({addedToLandscape.size} assets ready) {'\u2192'}
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Bottom asset drawer */}
      <div className="asset-drawer">
        <div className="asset-drawer-item" title="Generate new" onClick={() => setActiveTab('generate')}>
          <span style={{ fontSize: 20, color: 'var(--text-dim)' }}>+</span>
        </div>
        {generatedAssets.filter(a => a.status === 'complete').map((asset) => (
          <div
            key={asset.id}
            className={`asset-drawer-item ${addedToLandscape.has(asset.id) ? 'selected' : ''}`}
            title={asset.name}
            onClick={() => handleAddToLandscape(asset)}
          >
            <span style={{ fontSize: 16 }}>{addedToLandscape.has(asset.id) ? '\u2705' : '\u{1F4A0}'}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
