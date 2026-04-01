// Optional Claude API integration for AI-powered style analysis
// Uses fetch() directly - no SDK dependency needed
// API key stored in localStorage, never in project files

export interface StyleDescription {
  mood: string
  description: string
  architectureStyle: string
  lightingNotes: string
  materials: string[]
  suggestedTimeOfDay: number | null  // 0-24 or null
  suggestedWeather: string | null
  suggestedAssetEmphasis: Record<string, number>
}

const API_URL = 'https://api.anthropic.com/v1/messages'
const MODEL = 'claude-sonnet-4-6'

const SYSTEM_PROMPT = `You are an art director for a pixel art game. Analyze the provided reference image and describe its visual style for use in a procedural town generator.

Respond ONLY with a JSON object (no markdown, no code fences) matching this schema:
{
  "mood": "1-3 word mood (e.g. 'Warm Evening', 'Misty Dawn', 'Cozy Nighttime')",
  "description": "2-3 sentence description of the overall visual style, atmosphere, and feeling",
  "architectureStyle": "1-2 word style (e.g. 'Medieval European', 'Japanese Village', 'Fantasy Gothic')",
  "lightingNotes": "Brief description of the lighting (e.g. 'Warm amber streetlights with deep blue shadows')",
  "materials": ["list", "of", "prominent", "materials"],
  "suggestedTimeOfDay": 20.5,
  "suggestedWeather": "clear",
  "suggestedAssetEmphasis": {
    "lamppost": 0.7,
    "tavern": 0.5,
    "shop": 0.6,
    "barrel": 0.3,
    "potted_plant": 0.4,
    "bench": 0.3,
    "fountain": 0.2,
    "cafe_table": 0.3,
    "stone_wall": 0.2,
    "fence": 0.1,
    "market_stall": 0.2,
    "hanging_sign": 0.4
  }
}

For suggestedTimeOfDay: 0-6 = night, 6-8 = dawn, 8-17 = day, 17-19 = dusk, 19-24 = night.
For suggestedWeather: one of "clear", "rain", "fog", "snow", "storm".
For suggestedAssetEmphasis: values 0-1 indicating how much to emphasize each asset type.
Only include asset types that are relevant. Values above 0.5 mean "use prominently".\n`

export function getApiKey(): string | null {
  try {
    return localStorage.getItem('paintraverse_claude_api_key')
  } catch {
    return null
  }
}

export function setApiKey(key: string): void {
  try {
    localStorage.setItem('paintraverse_claude_api_key', key)
  } catch {
    // localStorage not available
  }
}

export function hasApiKey(): boolean {
  const key = getApiKey()
  return !!key && key.length > 10
}

export async function describeStyle(imageDataURL: string): Promise<StyleDescription> {
  const apiKey = getApiKey()
  if (!apiKey) {
    throw new Error('No Claude API key configured. Add one in the Inspiration panel.')
  }

  // Extract base64 and media type from data URL
  const match = imageDataURL.match(/^data:(image\/\w+);base64,(.+)$/)
  if (!match) {
    throw new Error('Invalid image data URL')
  }

  const mediaType = match[1]
  const base64Data = match[2]

  const response = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true'
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1024,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: mediaType,
                data: base64Data
              }
            },
            {
              type: 'text',
              text: 'Analyze this reference image for a pixel art town generator. Respond with the JSON object only.'
            }
          ]
        }
      ],
      system: SYSTEM_PROMPT
    })
  })

  if (!response.ok) {
    const errorBody = await response.text()
    if (response.status === 401) {
      throw new Error('Invalid API key. Check your Claude API key in the Inspiration panel.')
    }
    throw new Error(`Claude API error (${response.status}): ${errorBody.slice(0, 200)}`)
  }

  const result = await response.json()
  const text = result.content?.[0]?.text
  if (!text) {
    throw new Error('No response from Claude API')
  }

  // Parse JSON from response (handle potential markdown wrapping)
  let jsonStr = text.trim()
  if (jsonStr.startsWith('```')) {
    jsonStr = jsonStr.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '')
  }

  try {
    const parsed = JSON.parse(jsonStr)
    return {
      mood: parsed.mood || 'Unknown',
      description: parsed.description || '',
      architectureStyle: parsed.architectureStyle || '',
      lightingNotes: parsed.lightingNotes || '',
      materials: parsed.materials || [],
      suggestedTimeOfDay: parsed.suggestedTimeOfDay ?? null,
      suggestedWeather: parsed.suggestedWeather ?? null,
      suggestedAssetEmphasis: parsed.suggestedAssetEmphasis || {}
    }
  } catch {
    throw new Error(`Failed to parse Claude response as JSON: ${jsonStr.slice(0, 100)}...`)
  }
}
