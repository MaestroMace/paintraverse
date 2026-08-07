import { useEffect, useRef, useState } from 'react'
import './TransitionOverlay.css'

interface TransitionOverlayProps {
  active: boolean
  onComplete?: () => void
}

export function TransitionOverlay({ active, onComplete }: TransitionOverlayProps) {
  const [phase, setPhase] = useState<'idle' | 'in' | 'hold' | 'out'>('idle')
  const timers = useRef<number[]>([])

  // Only cancel on unmount. The cleanup used to run whenever `active`
  // changed, which is the bug: App drops `active` back to false at 500ms,
  // that cancelled the 800ms timer that returns the overlay to 'idle', and
  // the overlay stayed pinned at 'hold' — opacity 1 over a near-opaque
  // gradient, i.e. a black screen over the whole app with a spinner on it,
  // permanently. The phase sequence has to be allowed to finish on its own.
  useEffect(() => () => { timers.current.forEach(clearTimeout) }, [])

  useEffect(() => {
    if (!active) return
    timers.current.forEach(clearTimeout)
    timers.current = [
      window.setTimeout(() => setPhase('hold'), 300),
      window.setTimeout(() => { setPhase('out'); onComplete?.() }, 500),
      window.setTimeout(() => setPhase('idle'), 800),
    ]
    setPhase('in')
    // onComplete deliberately omitted: an unstable callback identity would
    // restart the sequence mid-transition.
  }, [active])

  if (phase === 'idle') return null

  return (
    <div className={`transition-overlay ${phase}`}>
      <div className="transition-ring" />
    </div>
  )
}
