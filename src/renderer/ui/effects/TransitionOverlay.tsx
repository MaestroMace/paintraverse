import { useEffect, useState } from 'react'
import './TransitionOverlay.css'

interface TransitionOverlayProps {
  active: boolean
  onComplete?: () => void
}

export function TransitionOverlay({ active, onComplete }: TransitionOverlayProps) {
  const [phase, setPhase] = useState<'idle' | 'in' | 'hold' | 'out'>('idle')

  useEffect(() => {
    if (active) {
      setPhase('in')
      const holdTimer = setTimeout(() => setPhase('hold'), 300)
      const outTimer = setTimeout(() => {
        setPhase('out')
        onComplete?.()
      }, 500)
      const clearTimer = setTimeout(() => setPhase('idle'), 800)

      return () => {
        clearTimeout(holdTimer)
        clearTimeout(outTimer)
        clearTimeout(clearTimer)
      }
    }
  }, [active])

  if (phase === 'idle') return null

  return (
    <div className={`transition-overlay ${phase}`}>
      <div className="transition-ring" />
    </div>
  )
}
