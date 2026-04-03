import { useEffect, useState, useMemo } from 'react'
import './SparkleField.css'

interface SparkleFieldProps {
  count?: number
  color?: string
  area?: 'full' | 'bottom' | 'top'
}

interface Particle {
  id: number
  x: number
  y: number
  size: number
  delay: number
  duration: number
  brightness: number
}

export function SparkleField({ count = 16, color = 'rgba(240, 200, 80, 0.7)', area = 'full' }: SparkleFieldProps) {
  const particles = useMemo(() => {
    const p: Particle[] = []
    for (let i = 0; i < count; i++) {
      let y = Math.random() * 100
      if (area === 'bottom') y = 60 + Math.random() * 40
      if (area === 'top') y = Math.random() * 40

      p.push({
        id: i,
        x: Math.random() * 100,
        y,
        size: 1.5 + Math.random() * 3.5,
        delay: Math.random() * 6,
        duration: 3 + Math.random() * 4,
        brightness: 0.4 + Math.random() * 0.6
      })
    }
    return p
  }, [count, area])

  return (
    <div className="sparkle-field" aria-hidden="true">
      {particles.map((p) => (
        <div
          key={p.id}
          className="sparkle-dot"
          style={{
            left: `${p.x}%`,
            top: `${p.y}%`,
            width: p.size,
            height: p.size,
            animationDelay: `${p.delay}s`,
            animationDuration: `${p.duration}s`,
            '--sparkle-color': color,
            opacity: p.brightness
          } as React.CSSProperties}
        />
      ))}
    </div>
  )
}
