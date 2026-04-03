import { useState, useRef, useCallback, useEffect } from 'react'
import { useAppStore } from '../../app/store'
import type { SearchResult, GeneratedAsset } from '../../core/types'
import { v4 as uuid } from 'uuid'
import './AssetCreatorMode.css'

// Simulated search - in production this would hit a real API
function simulateSearch(query: string): Promise<SearchResult[]> {
  return new Promise((resolve) => {
    setTimeout(() => {
      const results: SearchResult[] = Array.from({ length: 12 }, (_, i) => ({
        id: uuid(),
        url: '',
        thumbnailUrl: '',
        title: `${query} reference ${i + 1}`,
        source: ['Pixabay', 'Unsplash', 'OpenGameArt'][i % 3],
        width: 256,
        height: 256
      }))
      resolve(results)
    }, 800 + Math.random() * 600)
  })
}

// Simulated 3D generation pipeline
function simulateGenerate(prompt: string, onProgress: (status: string) => void): Promise<string> {
  return new Promise((resolve) => {
    const steps = [
      'Analyzing prompt...',
      'Generating base mesh...',
      'Applying textures...',
      'Optimizing geometry...',
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
    }, 700)
  })
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

  const [activeTab, setActiveTab] = useState<'search' | 'generate' | 'library'>('search')
  const [generatePrompt, setGeneratePrompt] = useState('')
  const [generateStatus, setGenerateStatus] = useState('')
  const [isGenerating, setIsGenerating] = useState(false)
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
      const results = await simulateSearch(searchQuery)
      setSearchResults(results)
    } finally {
      setSearchLoading(false)
    }
  }, [searchQuery, searchLoading])

  const handleGenerate = useCallback(async () => {
    if (!generatePrompt.trim() || isGenerating) return
    setIsGenerating(true)

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
                  {searchLoading ? 'Searching...' : 'SCAN'}
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
                  <p className="ac-empty-hint">Try: "medieval sword", "crystal potion", "sci-fi helmet"</p>
                </div>
              )}
              <div className="search-grid">
                {searchResults.map((r) => (
                  <div
                    key={r.id}
                    className={`search-result-card ${selectedResult?.id === r.id ? 'selected' : ''}`}
                    onClick={() => setSelectedSearchResult(r)}
                  >
                    <div className="search-result-placeholder">
                      <span>{r.title.charAt(0).toUpperCase()}</span>
                    </div>
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
                <div className="ac-detail-header">
                  <span className="ac-detail-title">{selectedResult.title}</span>
                  <span className="ac-detail-source">{selectedResult.source}</span>
                </div>
                <div className="ac-detail-actions">
                  <button
                    className="kh-btn primary"
                    onClick={() => {
                      setGeneratePrompt(`3D game asset based on: ${selectedResult.title}`)
                      setActiveTab('generate')
                    }}
                  >
                    Use as Reference {'\u2192'}
                  </button>
                  <button className="kh-btn">Save to Library</button>
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
                    <select>
                      <option>Low Poly</option>
                      <option>Pixel Art 3D</option>
                      <option>Stylized</option>
                      <option>Realistic</option>
                    </select>
                  </label>
                  <label className="ac-gen-option">
                    <span>Poly Count:</span>
                    <select>
                      <option>Low (&lt;500)</option>
                      <option>Medium (&lt;2000)</option>
                      <option>High (&lt;5000)</option>
                    </select>
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
                    <span>Asset ready! Add to your project.</span>
                    <button className="kh-btn primary">Add to Library</button>
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
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Bottom asset drawer */}
      <div className="asset-drawer">
        <div className="asset-drawer-item" title="Add new">
          <span style={{ fontSize: 20, color: 'var(--text-dim)' }}>+</span>
        </div>
        {generatedAssets.filter(a => a.status === 'complete').map((asset) => (
          <div key={asset.id} className="asset-drawer-item" title={asset.name}>
            <span style={{ fontSize: 16 }}>{'\u{1F4A0}'}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
