/**
 * FOLIAGE — the largest soft thing in the town, and it was the last rigid one.
 *
 * The wind now turns the vanes, flies the flags and swings the washing, and
 * every tree stood perfectly still through all of it. That is the same defect
 * as the unblinking cat and the welded vane one more time, at the biggest
 * scale available: a canopy is metres across and there are hundreds of them,
 * so a skyline where the cloth moves and the leaves do not reads as a
 * PHOTOGRAPH with two animated stickers on it.
 *
 * THE CANOPY MOVES AND THE TRUNK DOES NOT, which is both physically true and
 * the entire reason this is cheap. Trees share one batched mesh with every
 * barrel and crate in the town, so a shader on that material would sway the
 * whole street; splitting the CANOPY geometry into its own batch gives it its
 * own material and touches nothing else. No attribute, no gate, no name list —
 * the same argument that made the cat's eyes free, because they already had
 * their own bucket.
 *
 * DISPLACED ALONG THE WIND, NOT BY A PER-TREE ANGLE. `windBearing()` is the
 * direction the wind comes FROM, so the leaves go the way the flags go: the
 * crowns lean downwind together and gust together, because a wood in which
 * every tree bends its own way is not weather. The per-tree term is a PHASE,
 * so they do not move in lockstep — the metronome rule that applies to
 * everything except the direction itself.
 *
 * AND THE JOIN IS ALLOWED TO CHEAT. The crown moves a handful of centimetres
 * while the trunk stays put, so the two separate very slightly at the fork.
 * The canopy overlaps the trunk top by design, and this repo already paid this
 * exact price knowingly for the lantern ropes, whose endpoints detach from
 * their eaves by 7cm: the alternative is threading a weight attribute through
 * a shared batch builder, which is a great deal of machinery for a seam nobody
 * can see from the street.
 */
import * as THREE from 'three'
import { windBearing, windGust } from './Wind'

const _uniforms = {
  uFoliageTime: { value: 0 },
  /** Downwind direction in XZ. One vec2 rather than an angle, so the shader
   *  does no trigonometry per vertex. */
  uFoliageDir: { value: new THREE.Vector2(1, 0) },
  uFoliageAmp: { value: 0.18 },
}
let _pin: number | null = null

/**
 * Hold the foliage clock, for the reason `pinSwayTime` and `pinCatTime` exist:
 * a probe that has to CATCH a phase by waiting measures the sampling, not the
 * feature. Costs one branch and makes the system gradeable forever.
 */
export function pinFoliageTime(v: number | null): void { _pin = v }

/** Advance the leaves. Reads the shared wind, so a town whose flags stream one
 *  way and whose trees lean another is impossible by construction. */
export function tickFoliage(time: number): void {
  _uniforms.uFoliageTime.value = _pin ?? time
  // DOWNWIND, the same half-turn the banners take — `windBearing()` is where
  // the wind comes FROM.
  const b = windBearing() + Math.PI
  _uniforms.uFoliageDir.value.set(Math.cos(b), Math.sin(b))
  // A crown in a lull barely stirs and a crown in a gust heaves. The lean and
  // the sway both scale, so the trees breathe with everything else.
  _uniforms.uFoliageAmp.value = 0.10 + 0.22 * Math.max(0, windGust() - 0.5)
}

/** What the leaves are doing this frame, so a probe reads the town rather than
 *  restating the formula. */
export function foliageState(): { dir: [number, number]; amp: number } {
  const d = _uniforms.uFoliageDir.value
  return { dir: [d.x, d.y], amp: _uniforms.uFoliageAmp.value }
}

/**
 * Compile the sway into the canopy batch's material.
 *
 * Applied at build time, BEFORE `patchHeightFog` runs over the prop group —
 * that hook chains whatever it finds and keys the program cache on its source,
 * so a hook added first composes correctly and one added afterwards would be
 * thrown away by the cached program. The trap that cost this repo a session
 * when a constant cache key silently discarded the hanging sway.
 */
export function applyFoliageSway(mat: THREE.Material): void {
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uFoliageTime = _uniforms.uFoliageTime
    shader.uniforms.uFoliageDir = _uniforms.uFoliageDir
    shader.uniforms.uFoliageAmp = _uniforms.uFoliageAmp
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        uniform float uFoliageTime;
        uniform vec2 uFoliageDir;
        uniform float uFoliageAmp;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        {
          vec3 fwp = (modelMatrix * vec4(transformed, 1.0)).xyz;
          // A PHASE PER TREE, from world position — the sway's own trick, and
          // safe here for the reason it was wrong for the cat's eyes: a
          // canopy is SUPPOSED to vary smoothly across itself, so an
          // interpolated value is the right kind of quantity. Two adjacent
          // lobes of one crown differ by a few hundredths and two trees by
          // about a radian.
          float fph = fwp.x * 0.21 + fwp.z * 0.17;
          // Two incommensurate terms, slower than the window flicker and the
          // star twinkle and in the same band as the lantern sway, because a
          // crown and a hanging lantern are moving in the same air.
          float s = sin(uFoliageTime * 0.43 + fph) * 0.62
                  + sin(uFoliageTime * 0.67 + fph * 1.9) * 0.38;
          // The steady LEAN plus the sway about it: a crown in a wind does not
          // oscillate about upright, it sits pushed over and trembles there.
          float d = uFoliageAmp * (0.55 + 0.45 * s);
          transformed.x += uFoliageDir.x * d;
          transformed.z += uFoliageDir.y * d;
        }`)
  }
  mat.needsUpdate = true
}
